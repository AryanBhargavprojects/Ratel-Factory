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
import type { EventLogger } from "./observability/event-logger.js";
import { observeAgentSession } from "./observability/session-events.js";
import { writeFeatureFile } from "./artifacts.js";
import type { MissionScope } from "./mission/scope.js";
import type { MissionExecutionContext } from "./mission/execution-context.js";
import { runSessionWithFailover, collectResponse, createAgentSessionForModel } from "./models/session-runner.js";
import type { AgentRole } from "./models/model-router.js";

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
function buildContractAgentCustomTools(scope: MissionScope, logger: EventLogger | undefined) {
  return [
    {
      name: "write_mission_artifact",
      label: "Write Mission Artifact",
      description:
        "Write or append a canonical mission artifact under .ratel/missions/<missionId>/. " +
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
        await writeArtifact(scope, params.artifact as any, params.content, mode, logger);
        logger?.artifactWrite(params.artifact, mode, Buffer.byteLength(params.content, "utf-8"));
        return { content: [{ type: "text" as const, text: `Wrote ${params.artifact} (${mode}).` }], details: {} };
      },
    },
    {
      name: "write_feature_file",
      label: "Write Feature File",
      description:
        "Write a Gherkin .feature file under .ratel/missions/<missionId>/features/. " +
        "Used by the Contract Agent to write validation contract scenarios. " +
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
        await writeFeatureFile(scope, params.filename, params.content);
        logger?.artifactWrite(`features/${params.filename}`, "overwrite", Buffer.byteLength(params.content, "utf-8"));
        return { content: [{ type: "text" as const, text: `Wrote .ratel/missions/${scope.missionId}/features/${params.filename} (${Buffer.byteLength(params.content, "utf-8")} bytes).` }], details: {} };
      },
    },
  ];
}

/**
 * Spawn a fresh read-only Research Agent.
 * Routes through runSessionWithFailover for automatic model failover.
 */
export async function spawnResearchAgent(
  query: string,
  searchScope: string,
  context: MissionExecutionContext,
): Promise<string> {
  const projectRoot = context.scope.projectRoot;
  const startTime = Date.now();

  const allSkills = await loadSkillsFromDir(projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const researchSkillNames = new Set([
    "parallel-web-search",
    "parallel-deep-research",
    "find-docs",
  ]);
  const researchSkills = isolateSkills(allSkills, researchSkillNames);

  const prompt = `Research query: ${query}\nScope: ${searchScope}\nWorking directory: ${projectRoot}\n\nReturn structured findings in the exact format specified in your system prompt. Use /skill:parallel-web-search for web research when relevant.`;

  return runSessionWithFailover({
    context,
    role: "orchestrator",
    attempt: async (model) => {
      const { session, dispose } = await createAgentSessionForModel({
        cwd: projectRoot,
        modelString: model.modelString,
        systemPrompt: RESEARCH_AGENT_PROMPT,
        tools: ["read", "grep", "find", "ls", "bash"],
        skills: researchSkills,
      });

      const agentSpanId = context.logger.agentSpanStart("research", {
        agentType: "research",
        model: model.modelString,
        skills: researchSkills.map((s) => s.name),
        tools: ["read", "grep", "find", "ls", "bash"],
      });

      const unobserve = observeAgentSession(session, {
        logger: context.logger,
        agentLevel: "research",
        parentSpanId: agentSpanId,
      });

      try {
        const response = await collectResponse(session, prompt);
        const durationMs = Date.now() - startTime;
        if (agentSpanId) context.logger.agentSpanEnd("research", agentSpanId, { durationMs });
        return response;
      } finally {
        unobserve();
        dispose();
      }
    },
  });
}

/**
 * Spawn a skeptical Smart Friend agent.
 * Routes through runSessionWithFailover for automatic model failover.
 */
export async function spawnSmartFriendAgent(
  missionStateSummary: string,
  question: string,
  context: MissionExecutionContext,
): Promise<string> {
  const projectRoot = context.scope.projectRoot;
  const startTime = Date.now();

  const allSkills = await loadSkillsFromDir(projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
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

  const prompt = `## Full Mission State\n${missionStateSummary}\n\n---\n\n## Specific Question from Orchestrator\n${question}\n\n---\n\n## Working Directory\nYou are operating in: ${projectRoot}\n\nRemember: you are an OVER-SCOPED reviewer. Look at the ENTIRE trajectory and mission state above. Do not just answer the question — critique what the orchestrator may have missed, overlooked, or failed to investigate. If you need to explore the codebase to verify an assumption, use read, grep, find, or ls.\n\nReturn structured critique in the exact format specified in your system prompt.`;

  return runSessionWithFailover({
    context,
    role: "orchestrator",
    attempt: async (model) => {
      const { session, dispose } = await createAgentSessionForModel({
        cwd: projectRoot,
        modelString: model.modelString,
        systemPrompt: SMART_FRIEND_PROMPT,
        tools: ["read", "grep", "find", "ls"],
        skills: smartFriendSkills,
      });

      const agentSpanId = context.logger.agentSpanStart("smart_friend", {
        agentType: "smart_friend",
        model: model.modelString,
        skills: smartFriendSkills.map((s) => s.name),
        tools: ["read", "grep", "find", "ls"],
      });

      const unobserve = observeAgentSession(session, {
        logger: context.logger,
        agentLevel: "smart_friend",
        parentSpanId: agentSpanId,
      });

      try {
        const response = await collectResponse(session, prompt);
        const durationMs = Date.now() - startTime;
        if (agentSpanId) context.logger.agentSpanEnd("smart_friend", agentSpanId, { durationMs });
        return response;
      } finally {
        unobserve();
        dispose();
      }
    },
  });
}

/**
 * Spawn a Validation Contract Writer agent.
 * Routes through runSessionWithFailover for automatic model failover.
 */
export async function spawnContractAgent(
  requirements: string,
  constraints: string,
  researchNotes: string,
  decisionLog: string,
  context: MissionExecutionContext,
): Promise<string> {
  const scope = context.scope;
  const startTime = Date.now();

  const allSkills = await loadSkillsFromDir(scope.projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
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

  const prompt = `## Requirements\n${requirements}\n\n---\n\n## Constraints\n${constraints}\n\n---\n\n## Research Notes\n${researchNotes}\n\n---\n\n## Decision Log\n${decisionLog || "(No decisions recorded yet.)"}\n\n---\n\n## Working Directory\nYou are operating in: ${scope.projectRoot}\n\nWrite a validation contract in the exact format specified in your system prompt.\n\nBEFORE writing:\n1. Explore the codebase (read, grep, find, ls) to understand existing test patterns and conventions.\n2. Use /skill:parallel-web-search to research domain-specific validation patterns if needed.\n3. Ensure every requirement has at least one assertion. Flag any gaps explicitly.\n\nWHEN writing the contract artifacts, use these tools:\n- Use \x60write_feature_file\x60 for each .feature file (e.g., write_feature_file({filename: 'auth.feature', content: '...'})). The filename MUST end with .feature.\n- Use \x60write_mission_artifact\x60 for the validation-contract.md summary (artifact: 'validation-contract.md').\n\nWrite ALL feature files and the validation-contract.md summary before finishing. The verification tool checks for their existence, so partial output will be rejected.\n\nRemember: you do NOT know the feature plan. Write assertions based purely on requirements, constraints, research, and decisions.`;

  return runSessionWithFailover({
    context,
    role: "orchestrator",
    attempt: async (model) => {
      const { session, dispose } = await createAgentSessionForModel({
        cwd: scope.projectRoot,
        modelString: model.modelString,
        systemPrompt: CONTRACT_AGENT_PROMPT,
        tools: ["read", "grep", "find", "ls", "bash"],
        customTools: buildContractAgentCustomTools(scope, context.logger),
        skills: contractSkills,
      });

      const agentSpanId = context.logger.agentSpanStart("contract_writer", {
        agentType: "contract_writer",
        model: model.modelString,
        skills: contractSkills.map((s) => s.name),
        tools: ["read", "grep", "find", "ls", "bash", "write_mission_artifact", "write_feature_file"],
      });

      const unobserve = observeAgentSession(session, {
        logger: context.logger,
        agentLevel: "contract_writer",
        parentSpanId: agentSpanId,
      });

      try {
        const response = await collectResponse(session, prompt);
        const durationMs = Date.now() - startTime;
        if (agentSpanId) context.logger.agentSpanEnd("contract_writer", agentSpanId, { durationMs });
        return response;
      } finally {
        unobserve();
        dispose();
      }
    },
  });
}
