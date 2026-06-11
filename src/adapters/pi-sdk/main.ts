/**
 * Ratel entry point — launches Pi's InteractiveMode TUI configured as the
 * Ratel Orchestrator session.
 *
 * Architecture:
 *   User types in Pi's InteractiveMode TUI
 *     -> Pi's agent uses Ratel's createRuntime factory
 *        -> System prompt: ORCHESTRATOR_PROMPT
 *        -> Skills: orchestrator skill set (14 skills, isolated)
 *        -> Tools: read, grep, find, ls, bash + ORCHESTRATOR_TOOLS (13 custom)
 *        -> Model: from ratel.json (or SDK default if null)
 *     -> When agent calls run_worker (or other subagent tool):
 *        -> spawnWorkerAgent() / spawn*Validator() use createAgentSession()
 *           internally inside tool execute() handlers (correct and unchanged)
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
import { ORCHESTRATOR_PROMPT } from "../../core/prompts.js";
import { ORCHESTRATOR_TOOLS, setToolCwd } from "../../core/tools.js";
import { ensureMissionInitialized } from "../../core/artifacts.js";
import { startObservatory, type ObservatoryHandle } from "../../observatory/service.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "../../core/utils/skills.js";
import { getModelConfig, getObservabilityConfig, resolveModel } from "../../core/config.js";
import {
  EventLogger,
  setGlobalLogger,
  clearGlobalLogger,
} from "../../core/observability/event-logger.js";

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
 * Built-in tool allowlist + the 13 custom Ratel orchestrator tools.
 * Mirrors the toolNames array used in src/orchestrator.ts.
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
  "load_mission_state",
  "halt_mission",
  "log_decision",
  "run_validation",
  "run_worker",
  "run_user_testing",
  "set_model",
  "list_models",
  "ping_agents",
  "ensure_skills_installed",
];

/**
 * Factory that builds each Ratel session.
 *
 * Ensures the returned `services` and the created session share the same
 * authStorage, settingsManager, modelRegistry, and resourceLoader (with our
 * custom skill isolation + system prompt override). This is the same pattern
 * as Pi's SDK example 13 (13-session-runtime.ts).
 */
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  // 1. Initialize mission state under .missions/current/ before anything else
  await ensureMissionInitialized(cwd);

  // 2. Make cwd available to custom tools (run_worker, run_research, etc.)
  setToolCwd(cwd);

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
  //    The SDK will construct a DefaultResourceLoader from these options
  //    and call reload() internally.
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
    customTools: ORCHESTRATOR_TOOLS,
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
  await ensureMissionInitialized(cwd);

  // Initialize the global event logger before any agent work happens.
  // The logger reads/writes traceId to state.json so events across runs
  // of the same mission are stitched together.
  const logger = await EventLogger.forMission(cwd);
  setGlobalLogger(logger);

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
  // SIGINT (Ctrl+C), SIGTERM, normal exit, and uncaught exceptions all flush.
  const shutdown = async (): Promise<void> => {
    try {
      await observatory.shutdown();
    } catch (err) {
      console.error("Error shutting down Observatory:", err);
    }

    try {
      await logger.shutdown();
    } catch (err) {
      console.error("Error flushing event log:", err);
    } finally {
      clearGlobalLogger();
    }
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(143)));
  process.on("beforeExit", () => void shutdown());
  // Uncaught exceptions: log and attempt graceful shutdown, but do NOT
  // unconditionally exit. The EventLogger is fail-soft by design (see
  // src/core/observability/event-logger.ts), so most logging-related errors
  // are already swallowed. Any exception that reaches here is likely a
  // real bug — log it loudly so the user can see, but keep the TUI
  // running so they can recover state and decide what to do.
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] uncaughtException:", err);
    // Attempt graceful shutdown of the logger, but do not force-exit.
    // The Pi runtime may still be usable for the next turn.
    void shutdown();
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] unhandledRejection:", reason);
    // Same logic: log, but do not kill the process.
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
