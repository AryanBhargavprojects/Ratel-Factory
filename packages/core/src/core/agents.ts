/**
 * Helper agent spawners.
 * Each helper is a fresh Pi AgentSession with a narrow toolset and role-specific prompt.
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  RESEARCH_AGENT_PROMPT,
  SMART_FRIEND_PROMPT,
  CONTRACT_AGENT_PROMPT,
} from "./prompts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "./utils/skills.js";
import { resolveModel } from "./config.js";
import { getGlobalLogger } from "./observability/event-logger.js";
import { observeAgentSession } from "./observability/session-events.js";
import { writeFeatureFile } from "./artifacts.js";

/** Common skill filter: replace auto-discovered skills with only the role-specific set. */
function isolateSkills(
  allSkills: Awaited<ReturnType<typeof loadSkillsFromDir>>,
  names: Set<string>,
) {
  return allSkills.filter((s) => names.has(s.name));
}

/**
 * Inline custom tools for the contract agent. Defined here (not in tools.ts)
 * to avoid a circular import: tools.ts depends on agents.ts for spawnContractAgent,
 * and agents.ts would otherwise depend on tools.ts for writeMissionArtifactTool.
 * Both tools wrap the underlying writeArtifact / writeFeatureFile functions and
 * give the contract agent a way to persist its output.
 */
function buildContractAgentCustomTools(cwd: string) {
  return [
    {
      name: "write_mission_artifact",
      label: "Write Mission Artifact",
      description:
        "Write or append a canonical mission artifact under .missions/current/. " +
        "Use this to write 'validation-contract.md' as the contract summary. " +
        "Mode is 'overwrite' (default) or 'append'.",
      parameters: {
        type: "object" as const,
        properties: {
          artifact: { type: "string" as const, description: "Artifact name, e.g. 'validation-contract.md'" },
          content: { type: "string" as const, description: "Full content to write" },
          mode: { type: "string" as const, enum: ["overwrite", "append"], default: "overwrite" },
        },
        required: ["artifact", "content"],
      },
      execute: async (_id: string, params: { artifact: string; content: string; mode?: string }) => {
        const { writeArtifact } = await import("./artifacts.js");
        const mode = params.mode === "append" ? "append" : "overwrite";
        await writeArtifact(cwd, params.artifact as any, params.content, mode);
        getGlobalLogger()?.artifactWrite(params.artifact, mode, Buffer.byteLength(params.content, "utf-8"));
        return { content: [{ type: "text" as const, text: `Wrote ${params.artifact} (${mode}).` }], details: {} };
      },
    },
    {
      name: "write_feature_file",
      label: "Write Feature File",
      description:
        "Write a Gherkin .feature file under .missions/current/features/. " +
        "Use this to write each feature file in the validation contract. " +
        "The filename MUST end with .feature.",
      parameters: {
        type: "object" as const,
        properties: {
          filename: { type: "string" as const, description: "Feature file name, e.g. 'auth.feature'" },
          content: { type: "string" as const, description: "Full Gherkin content" },
        },
        required: ["filename", "content"],
      },
      execute: async (_id: string, params: { filename: string; content: string }) => {
        if (!params.filename.endsWith(".feature")) {
          return { content: [{ type: "text" as const, text: `ERROR: filename must end with .feature` }], details: { error: "invalid_filename" as string | undefined } };
        }
        if (!params.content || params.content.trim().length === 0) {
          return { content: [{ type: "text" as const, text: `ERROR: content is empty` }], details: { error: "empty_content" as string | undefined } };
        }
        await writeFeatureFile(cwd, params.filename, params.content);
        getGlobalLogger()?.artifactWrite(`features/${params.filename}`, "overwrite", Buffer.byteLength(params.content, "utf-8"));
        return { content: [{ type: "text" as const, text: `Wrote .missions/current/features/${params.filename} (${Buffer.byteLength(params.content, "utf-8")} bytes).` }], details: {} };
      },
    },
  ];
}

/**
 * Collect the full text response from a session after prompting.
 */
/**
 * Collect the full text response from a session after prompting.
 *
 * Logs a warning when the response is empty AND the session ended very quickly
 * (< 1 second) — this is a strong signal that the model never actually ran.
 * Common causes:
 *   - Model resolution failure (resolveModel returned undefined)
 *   - Provider not configured (e.g., Azure fallback when no Azure creds)
 *   - API error before any tokens were generated
 * Without this warning, the empty response is silently propagated to the
 * tool layer, which then reports "contract writer produced no artifacts"
 * without indicating the real cause.
 */
async function collectResponse(session: AgentSession, prompt: string): Promise<string> {
  let response = "";
  const startTime = Date.now();
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      response += event.assistantMessageEvent.delta;
    }
  });

  try {
    // AgentSession.prompt() waits for the full run to finish. Subscribe BEFORE
    // calling it or we miss every text_delta and falsely report an empty response.
    await session.prompt(prompt);
  } finally {
    unsubscribe();
  }

  const durationMs = Date.now() - startTime;

  if (response.length === 0 && durationMs < 1000) {
    console.warn(
      `[collectResponse] Agent produced no output in ${durationMs}ms — ` +
        `possible model resolution failure, missing API credentials, upstream API error, or non-text output. ` +
        `Empty response will propagate to the calling tool.`,
    );
  } else if (response.length === 0) {
    console.warn(
      `[collectResponse] Agent produced no output in ${durationMs}ms. ` +
        `Empty response will propagate to the calling tool.`,
    );
  }

  return response;
}

/**
 * Spawn a fresh read-only Research Agent.
 * Returns structured findings, evidence, risks, unknowns, recommendations.
 */
export async function spawnResearchAgent(
  query: string,
  scope: string,
  cwd: string = process.cwd(),
  model?: string,
): Promise<string> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  const allSkills = await loadSkillsFromDir(cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const researchSkillNames = new Set([
    "parallel-web-search",
    "parallel-deep-research",
    "find-docs",
  ]);
  const researchSkills = isolateSkills(allSkills, researchSkillNames);

  // Observability: research span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("research", {
    agentType: "research",
    model: model ?? "sdk-default",
    skills: researchSkills.map((s) => s.name),
    tools: ["read", "grep", "find", "ls", "bash"],
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => RESEARCH_AGENT_PROMPT,
    skillsOverride: () => ({ skills: researchSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls", "bash"], // bash for parallel-cli web search
    model: resolvedModel,
  });

  const prompt = `Research query: ${query}\nScope: ${scope}\nWorking directory: ${cwd}\n\nReturn structured findings in the exact format specified in your system prompt. Use /skill:parallel-web-search for web research when relevant.`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "research",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) logger?.agentSpanEnd("research", agentSpanId, { durationMs });
    session.dispose();
  }

  return response;
}

/**
 * Spawn a skeptical Smart Friend agent.
 * The Smart Friend receives the FULL mission state, not a curated summary.
 * It critiques the orchestrator's trajectory, not just the specific question.
 * It can explore the codebase independently using read, grep, find, ls.
 */
export async function spawnSmartFriendAgent(
  missionStateSummary: string,
  question: string,
  cwd: string = process.cwd(),
  model?: string,
): Promise<string> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  // Skills are auto-discovered from .pi/skills/ (project-local) and ~/.pi/agent/skills/ (global)
  // The Smart Friend has access to: software-design-philosophy, grill-with-docs, parallel-web-search,
  // find-docs, architecture-blueprint-generator, web-design-guidelines, deep-research, ui-ux-pro-max
  const allSkills = await loadSkillsFromDir(cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const smartFriendSkillNames = new Set([
    "software-design-philosophy",
    "architecture-blueprint-generator",
    "grill-with-docs",
    "parallel-web-search",
    "find-docs",
    "deep-research",
    "web-design-guidelines",
    "ui-ux-pro-max",
  ]);
  const smartFriendSkills = isolateSkills(allSkills, smartFriendSkillNames);

  // Observability: smart friend span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("smart_friend", {
    agentType: "smart_friend",
    model: model ?? "sdk-default",
    skills: smartFriendSkills.map((s) => s.name),
    tools: ["read", "grep", "find", "ls"],
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => SMART_FRIEND_PROMPT,
    skillsOverride: () => ({ skills: smartFriendSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls"], // can explore codebase independently
    model: resolvedModel,
  });

  const prompt = `## Full Mission State\n${missionStateSummary}\n\n---\n\n## Specific Question from Orchestrator\n${question}\n\n---\n\n## Working Directory\nYou are operating in: ${cwd}\n\nRemember: you are an OVER-SCOPED reviewer. Look at the ENTIRE trajectory and mission state above. Do not just answer the question — critique what the orchestrator may have missed, overlooked, or failed to investigate. If you need to explore the codebase to verify an assumption, use read, grep, find, or ls.\n\nReturn structured critique in the exact format specified in your system prompt.`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "smart_friend",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) logger?.agentSpanEnd("smart_friend", agentSpanId, { durationMs });
    session.dispose();
  }

  return response;
}

/**
 * Spawn a Validation Contract Writer agent.
 * Receives requirements + constraints + research notes + decision log.
 * Does NOT receive the feature plan.
 * Returns testable assertions with IDs, evidence type, preconditions, success criteria.
 * Can explore codebase and research domain patterns independently.
 */
export async function spawnContractAgent(
  requirements: string,
  constraints: string,
  researchNotes: string,
  decisionLog: string,
  cwd: string = process.cwd(),
  model?: string,
): Promise<string> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  const allSkills = await loadSkillsFromDir(cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const contractSkillNames = new Set([
    "parallel-web-search",
    "find-docs",
    "software-design-philosophy",
    "ui-ux-pro-max",
    "slc-product-thinking",
    "html-as-output",
    "gherkin-contract",
    "cucumber-gherkin",
  ]);
  const contractSkills = isolateSkills(allSkills, contractSkillNames);

  // Observability: contract writer span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("contract_writer", {
    agentType: "contract_writer",
    model: model ?? "sdk-default",
    skills: contractSkills.map((s) => s.name),
    tools: ["read", "grep", "find", "ls", "bash", "write_mission_artifact", "write_feature_file"],
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => CONTRACT_AGENT_PROMPT,
    skillsOverride: () => ({ skills: contractSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls", "bash"], // explore codebase + web research
    customTools: buildContractAgentCustomTools(cwd), // write contract artifacts
    model: resolvedModel,
  });

  const prompt = `## Requirements\n${requirements}\n\n---\n\n## Constraints\n${constraints}\n\n---\n\n## Research Notes\n${researchNotes}\n\n---\n\n## Decision Log\n${decisionLog || "(No decisions recorded yet.)"}\n\n---\n\n## Working Directory\nYou are operating in: ${cwd}\n\nWrite a validation contract in the exact format specified in your system prompt.\n\nBEFORE writing:\n1. Explore the codebase (read, grep, find, ls) to understand existing test patterns and conventions.\n2. Use /skill:parallel-web-search to research domain-specific validation patterns if needed.\n3. Ensure every requirement has at least one assertion. Flag any gaps explicitly.\n\nWHEN writing the contract artifacts, use these tools:\n- Use \x60write_feature_file\x60 for each .feature file (e.g., write_feature_file({filename: 'auth.feature', content: '...'})). The filename MUST end with .feature.\n- Use \x60write_mission_artifact\x60 for the validation-contract.md summary (artifact: 'validation-contract.md').\n\nWrite ALL feature files and the validation-contract.md summary before finishing. The verification tool checks for their existence, so partial output will be rejected.\n\nRemember: you do NOT know the feature plan. Write assertions based purely on requirements, constraints, research, and decisions.`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "contract_writer",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) logger?.agentSpanEnd("contract_writer", agentSpanId, { durationMs });
    session.dispose();
  }

  return response;
}
