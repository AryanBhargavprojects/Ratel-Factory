import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  getAgentDir,
  type AgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../config.js";
import { Type } from "@sinclair/typebox";
import { SCRUTINY_VALIDATOR_PROMPT, CODE_REVIEW_PROMPT, USER_TESTING_VALIDATOR_PROMPT, USER_TESTING_SHARD_PROMPT } from "../prompts.js";
import type { UserTestingShard } from "../types.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "../utils/skills.js";
import { getGlobalLogger } from "../observability/event-logger.js";
import { observeAgentSession } from "../observability/session-events.js";
import { createReportReceiver, persistSubmittedReport } from "../report-submission.js";
import type { ScrutinyReport, UserTestingShardReport } from "../types.js";

// resolveModel moved to src/config.ts

/**
 * Collect the full text response from a session after prompting.
 */
async function collectResponse(session: AgentSession, prompt: string): Promise<string> {
  let response = "";
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

  return response;
}

/**
 * Spawn a Code Review Subagent for a single feature.
 * Fresh context, read-only, adversarial by design.
 */
export async function spawnCodeReviewSubagent(
  featureId: string,
  featureSpec: string,
  gherkinScenarios: string,
  filePaths: string[],
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
  const reviewSkillNames = new Set([
    "test-driven-development",
    "software-design-philosophy",
    "diagnose",
    "systematic-debugging",
    "find-docs",
  ]);
  const reviewSkills = allSkills.filter((s) => reviewSkillNames.has(s.name));

  // Observability: code review span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("code_review", {
    agentType: "code_review",
    model: model ?? "sdk-default",
    featureId,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => CODE_REVIEW_PROMPT,
    skillsOverride: () => ({ skills: reviewSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls"],
    model: resolvedModel,
  });

  const prompt = `## Feature to Review
**ID:** ${featureId}

**Spec:**
${featureSpec}

**Gherkin Scenarios:**
${gherkinScenarios}

**Files to Review:**
${filePaths.map((p) => `- ${p}`).join("\n")}

## Instructions
Read the files above. Review them with fresh, adversarial eyes. Return ONLY the JSON review object specified in your system prompt.`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "code_review",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) {
      logger?.agentSpanEnd("code_review", agentSpanId, {
        durationMs,
        featureId,
      });
    }
    session.dispose();
  }

  return response;
}

/**
 * Factory that creates a review_feature tool bound to a specific cwd.
 * The scrutiny validator uses this tool to spawn parallel code-review subagents.
 */
export function createReviewFeatureTool(cwd: string, model?: string) {
  return defineTool({
    name: "review_feature",
    label: "Review Feature",
    description:
      "Spawn a fresh code-review subagent for a single feature. Read-only parallel operation.",
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to review" }),
      featureSpec: Type.String({
        description: "Feature title and description",
      }),
      gherkinScenarios: Type.String({
        description: "Gherkin scenarios this feature claims to satisfy",
      }),
      filePaths: Type.Array(Type.String(), {
        description: "Files to review for this feature",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const review = await spawnCodeReviewSubagent(
        params.featureId,
        params.featureSpec,
        params.gherkinScenarios,
        params.filePaths,
        cwd,
        model,
      );
      return {
        content: [{ type: "text", text: review }],
        details: {},
      };
    },
  });
}

/**
 * Factory that creates a submit_scrutiny_report tool bound to a milestone.
 */
export function createSubmitScrutinyReportTool(milestoneId: string) {
  const receiver = createReportReceiver<ScrutinyReport>({
    role: "scrutiny",
    assignment: { milestoneId },
    artifactPath: `validation-reports/scrutiny-${milestoneId}-${Date.now()}.json`,
  });

  const tool = defineTool({
    name: "submit_scrutiny_report",
    label: "Submit Scrutiny Report",
    description:
      "Submit your structured scrutiny report. Call this tool BEFORE finishing your session. " +
      "If this tool succeeds, your final text can be a short summary — do NOT repeat the full JSON.",
    parameters: Type.Object({
      report: Type.Any({ description: "The structured ScrutinyReport object" }),
    }),
    execute: async (_toolCallId, params) => {
      const result = receiver.submit(params.report);
      if (result.accepted) {
        await persistSubmittedReport(process.cwd(), `validation-reports/scrutiny-${milestoneId}-${Date.now()}.json`, params.report);
        return {
          content: [{ type: "text", text: "Scrutiny report accepted." }],
          details: { accepted: true, error: undefined as string | undefined },
        };
      }
      return {
        content: [{ type: "text", text: `Scrutiny report rejected: ${result.error}` }],
        details: { accepted: false, error: result.error },
      };
    },
  });

  return { tool, receiver };
}

/**
 * Spawn the Scrutiny Validator for a completed milestone.
 * Runs automated checks + parallel code review subagents.
 */
export async function spawnScrutinyValidator(
  milestoneId: string,
  featureIds: string[],
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
  const scrutinySkillNames = new Set([
    "test-driven-development",
    "software-design-philosophy",
    "diagnose",
    "systematic-debugging",
    "find-docs",
    "dispatching-parallel-agents",
    "requesting-code-review",
  ]);
  const scrutinySkills = allSkills.filter((s) => scrutinySkillNames.has(s.name));

  // Observability: scrutiny validator span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("scrutiny_validator", {
    agentType: "scrutiny_validator",
    model: model ?? "sdk-default",
    skills: scrutinySkills.map((s) => s.name),
    tools: ["read", "grep", "find", "ls", "bash", "review_feature"],
    milestoneId,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => SCRUTINY_VALIDATOR_PROMPT,
    skillsOverride: () => ({ skills: scrutinySkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  // Create report receiver and submission tool for this scrutiny session
  const { tool: submitScrutinyTool, receiver: scrutinyReceiver } = createSubmitScrutinyReportTool(milestoneId);

  // Note: review_feature tool is passed as a custom tool so the scrutiny validator can spawn parallel code-review subagents.
  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls", "bash"],
    customTools: [createReviewFeatureTool(cwd, model), submitScrutinyTool],
    model: resolvedModel,
  });

  const prompt = `## Milestone to Validate
**Milestone ID:** ${milestoneId}
**Completed Features:** ${featureIds.join(", ")}

## Instructions
1. Discover the codebase fresh. Read package.json / pyproject.toml / Cargo.toml to find test/typecheck/lint commands.
2. Run automated checks (tests, typecheck, lint). Record exit codes and output.
3. For each completed feature, use the review_feature tool to spawn a parallel code-review subagent.
4. Collect all reviews and synthesize the final scrutiny report.
5. Write the report JSON in the exact format from your system prompt.`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "scrutiny_validator",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) {
      logger?.agentSpanEnd("scrutiny_validator", agentSpanId, {
        durationMs,
        milestoneId,
      });
    }
    session.dispose();
  }

  return response;
}

/**
 * Spawn the User-Testing Validator for a completed milestone.
 * Reads .feature files, starts the app, drives agent-browser through each scenario,
 * captures screenshots, and writes a structured report.
 */
export async function spawnUserTestingValidator(
  milestoneId: string,
  featureIds: string[],
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
  const userTestingSkillNames = new Set([
    "agent-browser",
    "find-docs",
  ]);
  const userTestingSkills = allSkills.filter((s) => userTestingSkillNames.has(s.name));

  // Observability: user testing validator span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("user_testing_validator", {
    agentType: "user_testing_validator",
    model: model ?? "sdk-default",
    skills: userTestingSkills.map((s) => s.name),
    tools: ["read", "grep", "find", "ls", "bash"],
    milestoneId,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => USER_TESTING_VALIDATOR_PROMPT,
    skillsOverride: () => ({ skills: userTestingSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls", "bash"],
    model: resolvedModel,
  });

  const prompt = `## Milestone to Validate
**Milestone ID:** ${milestoneId}
**Completed Features:** ${featureIds.join(", ")}

## Instructions
1. Create the screenshots directory: mkdir -p .missions/current/validation-reports/screenshots
2. Read all .feature files from .missions/current/features/
3. Discover and start the app dev server (track the PID)
4. Wait for the server to be ready (poll with curl, timeout 60s)
5. Open the app with agent-browser
6. Execute every Gherkin scenario step-by-step, taking screenshots at each step
7. Capture console errors after each scenario
8. Stop the dev server (kill the PID)
9. Write the UserTestingReport JSON in the exact format from your system prompt`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "user_testing_validator",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) {
      logger?.agentSpanEnd("user_testing_validator", agentSpanId, {
        durationMs,
        milestoneId,
      });
    }
    session.dispose();
  }

  return response;
}

/**
 * Factory that creates a submit_user_testing_shard_report tool bound to a shard.
 */
export function createSubmitUserTestingShardReportTool(milestoneId: string, shardId: string) {
  const receiver = createReportReceiver<UserTestingShardReport>({
    role: "user-testing-shard",
    assignment: { milestoneId, shardId },
    artifactPath: `validation-reports/user-testing-shards/${milestoneId}/${shardId}.json`,
  });

  const tool = defineTool({
    name: "submit_user_testing_shard_report",
    label: "Submit User Testing Shard Report",
    description:
      "Submit your structured shard report. Call this tool BEFORE finishing your session. " +
      "If this tool succeeds, your final text can be a short summary — do NOT repeat the full JSON.",
    parameters: Type.Object({
      report: Type.Any({ description: "The structured UserTestingShardReport object" }),
    }),
    execute: async (_toolCallId, params) => {
      const result = receiver.submit(params.report);
      if (result.accepted) {
        await persistSubmittedReport(process.cwd(), `validation-reports/user-testing-shards/${milestoneId}/${shardId}.json`, params.report);
        return {
          content: [{ type: "text", text: "Shard report accepted." }],
          details: { accepted: true, error: undefined as string | undefined },
        };
      }
      return {
        content: [{ type: "text", text: `Shard report rejected: ${result.error}` }],
        details: { accepted: false, error: result.error },
      };
    },
  });

  return { tool, receiver };
}

/**
 * Spawn a User-Testing Shard Agent for a single feature file.
 * Fresh context, narrow scope, adversarial by design.
 */
export async function spawnUserTestingShardAgent(
  shard: UserTestingShard,
  cwd: string = process.cwd(),
  model?: string,
  parentSpanId?: string | undefined,
): Promise<{ response: string; receiver: ReturnType<typeof createSubmitUserTestingShardReportTool>["receiver"] }> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  const allSkills = await loadSkillsFromDir(cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const userTestingSkillNames = new Set([
    "agent-browser",
    "find-docs",
  ]);
  const userTestingSkills = allSkills.filter((s) => userTestingSkillNames.has(s.name));

  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const logger = getGlobalLogger();
  const agentSpanId = logger?.agentSpanStart("user_testing_shard", {
    agentType: "user_testing_shard",
    model: model ?? "sdk-default",
    skills: userTestingSkills.map((s) => s.name),
    tools: ["read", "grep", "find", "ls", "bash"],
    milestoneId: shard.milestoneId,
    shardId: shard.shardId,
  }, parentSpanId);

  // Create report receiver and submission tool for this shard session
  const { tool: submitShardTool, receiver: shardReceiver } = createSubmitUserTestingShardReportTool(shard.milestoneId, shard.shardId);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => USER_TESTING_SHARD_PROMPT,
    skillsOverride: () => ({ skills: userTestingSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "grep", "find", "ls", "bash"],
    customTools: [submitShardTool],
    model: resolvedModel,
  });

  const prompt = `## Shard Assignment
**Milestone ID:** ${shard.milestoneId}
**Shard ID:** ${shard.shardId}
**Assigned Feature File:** ${shard.featureFile}
**Scenario Selectors:** ${shard.scenarioSelectors.join(", ") || "(all scenarios in file)"}
**Assigned Port:** ${shard.assignedPort}
**Screenshot Directory:** ${shard.screenshotDir}
**Timeout:** ${shard.timeoutMs}ms

## Instructions
1. Create the screenshots directory: mkdir -p ${shard.screenshotDir}
2. Read ONLY your assigned .feature file: .missions/current/features/${shard.featureFile}
3. Start the app dev server on port ${shard.assignedPort} (use PORT=${shard.assignedPort})
4. Wait for the server to be ready (poll with curl, timeout 60s)
5. Open the app with agent-browser at http://localhost:${shard.assignedPort}
6. Execute ONLY your assigned scenarios step-by-step, taking screenshots at each step
7. Capture console errors after each scenario
8. Stop the dev server
9. Submit your UserTestingShardReport using the submit_user_testing_shard_report tool`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "user_testing_shard",
    parentSpanId: agentSpanId,
  });

  let response = "";
  try {
    response = await collectResponse(session, prompt);
  } finally {
    unobserve();
    const durationMs = Date.now() - startTime;
    if (agentSpanId) {
      logger?.agentSpanEnd("user_testing_shard", agentSpanId, {
        durationMs,
        milestoneId: shard.milestoneId,
        shardId: shard.shardId,
      });
    }
    session.dispose();
  }

  return { response, receiver: shardReceiver };
}
