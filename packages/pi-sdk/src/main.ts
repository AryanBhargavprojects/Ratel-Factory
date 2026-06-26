#!/usr/bin/env node
/**
 * Ratel entry point — launches Pi's InteractiveMode TUI configured as the
 * Ratel Orchestrator session.
 *
 * Architecture:
 *   User types in Pi's InteractiveMode TUI
 *     -> Pi's agent uses Ratel's createRuntime factory
 *        -> System prompt: ORCHESTRATOR_PROMPT
 *        -> Skills: orchestrator skill set (14 skills, isolated)
 *        -> Tools: read, grep, find, ls, bash + custom tools from createOrchestratorTools
 *        -> Model: from ratel.json (or SDK default if null)
 */

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  InteractiveMode,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  ORCHESTRATOR_PROMPT,
  createOrchestratorTools,
  ensureMissionInitialized,
  startObservatory,
  type ObservatoryHandle,
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
  getModelConfig,
  getObservabilityConfig,
  resolveModel,
  EventLogger,
  createMissionScope,
  getRatelDir,
  readJsonFile,
  atomicWriteJson,
  InProcessActionBridge,
  type InProcessBridgeCallbacks,
} from "@ratel-factory/core";

/**
 * Names of the 14 orchestrator skills that get loaded into the main session.
 * Other skills in .pi/skills/ are filtered out.
 */
const ORCHESTRATOR_SKILL_NAMES = new Set([
  "grill-me",
  "grill-with-docs",
  "find-skills",
  "ui-ux-pro-max",
  "parallel-web-search",
  "agent-browser",
  "html-visual",
  "html-as-output",
  "skill-creator",
  "slc-product-thinking",
  "software-design-philosophy",
  "architecture-blueprint-generator",
  "brainstorming",
  "bdd-discovery",
  "subagent-driven-development",
]);

/**
 * Built-in tool allowlist + the custom Ratel orchestrator tools.
 * Mirrors the toolNames array used in the orchestrator.
 */
const ORCHESTRATOR_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "ask_user",
  "run_research",
  "ask_smart_friend",
  "draft_validation_contract",
  "write_mission_artifact",
  "mark_feature_integrated",
  "mark_milestone_validated",
  "mark_mission_completed",
  "load_mission_state",
  "halt_mission",
  "log_decision",
  "run_validation",
  "run_worker",
  "run_user_testing",
  "set_model",
  "list_models",
  "ping_agents",
  "get_budget_status",
  "reload_budget",
  "ensure_skills_installed",
  "get_feature_complexity",
  "wait_for_user_approval",
];

// ---------------------------------------------------------------------------
// Session holder — bridges the Observatory dashboard to the live Pi session.
// Populated inside createRuntime once the session is created. The actionBridge
// callbacks close over this holder so dashboard approve/reply actions can
// programmatically prompt the running InteractiveMode session.
// ---------------------------------------------------------------------------

const sessionHolder: {
  session: { prompt(text: string, opts?: unknown): Promise<void> } | undefined;
  lock: Promise<void>;
} = { session: undefined, lock: Promise.resolve() };

/**
 * Serialize a prompt call through the session holder with a mutex chain so
 * concurrent approve + reply actions cannot interleave. Retries for up to 5 s
 * if the session has not been created yet (e.g. dashboard action arrives
 * before InteractiveMode finishes its first turn).
 */
async function promptSession(text: string): Promise<void> {
  const next = sessionHolder.lock.then(async () => {
    // Wait up to 5 s for the session to appear.
    const deadline = Date.now() + 5_000;
    while (!sessionHolder.session && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const session = sessionHolder.session;
    if (!session) throw new Error("Orchestrator session not ready yet");
    await session.prompt(text);
  });
  sessionHolder.lock = next.catch(() => {});
  await next;
}

/**
 * InProcessBridgeCallbacks that drive the live Pi session from the
 * Observatory dashboard. Mirrors the RatelRuntime pattern in the Pi extension.
 */
const devCallbacks: InProcessBridgeCallbacks = {
  async approve(missionId, approved, feedback) {
    const verdict = approved ? "APPROVED" : "REJECTED";
    const fb = feedback ? `\nFeedback: ${feedback}` : "";
    await promptSession(
      `User decision via Observatory dashboard: ${verdict}.${fb} Continue the mission accordingly.`,
    );
  },
  async replyToFactory(missionId, message, questionId) {
    const q = questionId ? ` (answering question ${questionId})` : "";
    await promptSession(`User reply via Observatory dashboard${q}: ${message}`);
  },
};

async function getCurrentMissionId(cwd: string): Promise<string | undefined> {
  try {
    const currentMissionPath = `${getRatelDir(cwd)}/current-mission.json`;
    const record = await readJsonFile<{ missionId: string }>(currentMissionPath);
    if (!record?.missionId) return undefined;
    // Only resume if the mission is still active. A completed or halted
    // mission should not be reused — a new session should start fresh.
    const statePath = `${getRatelDir(cwd)}/missions/${record.missionId}/state.json`;
    const state = await readJsonFile<{ phase?: string }>(statePath);
    if (state?.phase === "completed" || state?.phase === "halted") {
      return undefined;
    }
    return record.missionId;
  } catch {
    return undefined;
  }
}

/**
 * Factory that builds each Ratel session.
 */
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  // Resolve current mission from `.ratel/current-mission.json`, or fall back
  // to creating a fresh one. Never hard-code `mis_00000001`.
  let missionId = await getCurrentMissionId(cwd);
  if (!missionId) {
    missionId = `mis_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
  // Persist so the Observatory dashboard can discover the active mission.
  await atomicWriteJson(`${getRatelDir(cwd)}/current-mission.json`, { missionId });

  const scope = createMissionScope(cwd, missionId);
  const logger = await EventLogger.forMission(scope);
  await ensureMissionInitialized(scope, logger);

  // Build context with budget and model router for failover support
  const { BudgetManager } = await import("@ratel-factory/core");
  const { getBudgetConfig } = await import("@ratel-factory/core");
  const { ModelRouter } = await import("@ratel-factory/core");
  const { getFallbackModelConfig } = await import("@ratel-factory/core");

  const budgetLimits = await getBudgetConfig(cwd);
  const budget = new BudgetManager(scope);
  await budget.initialize(budgetLimits);

  const fallbackConfig = await getFallbackModelConfig(cwd);
  const missionModelConfig = {
    orchestrator: {
      model: fallbackConfig.orchestrator.model,
      fallbackModels: fallbackConfig.orchestrator.fallbackModels ?? [],
    },
    worker: {
      model: fallbackConfig.worker.model,
      fallbackModels: fallbackConfig.worker.fallbackModels ?? [],
    },
    validator: {
      model: fallbackConfig.validator.model,
      fallbackModels: fallbackConfig.validator.fallbackModels ?? [],
    },
  };
  const models = new ModelRouter({
    projectRoot: cwd,
    orchestrator: missionModelConfig.orchestrator,
    worker: missionModelConfig.worker,
    validator: missionModelConfig.validator,
    modelRouting: fallbackConfig.modelRouting,
  });
  await models.init();

  const executionContext = {
    scope,
    logger,
    budget,
    models,
    modelConfig: missionModelConfig,
  };

  // 3. Build the cwd-independent parts: auth, model registry, settings
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });

  // 4. Load skills from .pi/skills/ and filter down to the 14 orchestrator skills
  const allOrchestratorSkills = await loadSkillsFromDir(
    cwd,
    DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  );
  const orchestratorSkills = allOrchestratorSkills.filter((s) =>
    ORCHESTRATOR_SKILL_NAMES.has(s.name),
  );

  // 5. Resolve orchestrator model from ratel.json
  const modelConfig = await getModelConfig(cwd);
  const orchestratorModel = resolveModel(modelConfig.orchestrator);

  // 6. Create cwd-bound services with our custom config.
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    authStorage,
    settingsManager,
    modelRegistry,
    resourceLoaderOptions: {
      systemPromptOverride: () => ORCHESTRATOR_PROMPT,
      skillsOverride: () => ({
        skills: orchestratorSkills,
        diagnostics: [],
      }),
    },
  });

  // 7. Create the session from the SAME services (guarantees consistency)
  const sessionResult = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    model: orchestratorModel,
    thinkingLevel: "medium",
    tools: ORCHESTRATOR_TOOL_NAMES,
    customTools: createOrchestratorTools(executionContext),
  });

  // Capture the live session so the Observatory dashboard can prompt it.
  sessionHolder.session = sessionResult.session;

  return {
    ...sessionResult,
    services,
    diagnostics: services.diagnostics,
  };
};

async function main(): Promise<void> {
  const cwd = process.cwd();
  const agentDir = getAgentDir();

  // Always start a fresh mission for a new `npm run dev` session. The
  // standalone dev entry point is NOT a resume path — the Pi extension handles
  // resume via session_start. Reusing a stale current-mission.json (e.g. left
  // behind by a previous run or a seed script) would make the Observatory
  // dashboard show old data instead of this session's live activity.
  const missionId = `mis_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await atomicWriteJson(`${getRatelDir(cwd)}/current-mission.json`, { missionId });
  const mainScope = createMissionScope(cwd, missionId);
  const mainLogger = await EventLogger.forMission(mainScope);
  await ensureMissionInitialized(mainScope, mainLogger);

  // Start Observatory deterministically before InteractiveMode accepts the
  // first prompt. Startup is fail-soft: the factory continues if the dashboard
  // cannot bind a port.
  let observatory: ObservatoryHandle = {
    enabled: false,
    shutdown: async () => undefined,
  };
  const actionBridge = new InProcessActionBridge(devCallbacks);
  observatory = await startObservatory({
    cwd,
    config: await getObservabilityConfig(cwd),
    actionBridge,
  });

  // Ensure unflushed events are persisted before process exit.
  const shutdown = async (): Promise<void> => {
    try {
      await observatory.shutdown();
    } catch (err) {
      console.error("Error shutting down Observatory:", err);
    }

    try {
      await mainLogger.shutdown();
    } catch (err) {
      console.error("Error flushing event log:", err);
    }
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(143)));
  process.on("beforeExit", () => void shutdown());
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] uncaughtException:", err);
    void shutdown();
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] unhandledRejection:", reason);
    void shutdown();
  });

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd),
  });

  const mode = new InteractiveMode(runtime);

  try {
    await mode.run();
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
