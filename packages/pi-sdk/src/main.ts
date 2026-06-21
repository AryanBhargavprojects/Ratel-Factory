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
  "ensure_skills_installed",
  "get_feature_complexity",
  "wait_for_user_approval",
];

async function getCurrentMissionId(cwd: string): Promise<string | undefined> {
  try {
    const currentMissionPath = `${getRatelDir(cwd)}/current-mission.json`;
    const record = await readJsonFile<{ missionId: string }>(currentMissionPath);
    return record?.missionId;
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

  return {
    ...sessionResult,
    services,
    diagnostics: services.diagnostics,
  };
};

async function main(): Promise<void> {
  const cwd = process.cwd();
  const agentDir = getAgentDir();

  // Initialize mission artifacts first so the logger can attach a traceId
  // without creating a partial state.json.
  let missionId = await getCurrentMissionId(cwd);
  if (!missionId) {
    missionId = `mis_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
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
  observatory = await startObservatory({
    cwd,
    config: await getObservabilityConfig(cwd),
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
