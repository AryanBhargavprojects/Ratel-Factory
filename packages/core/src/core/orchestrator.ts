import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { ORCHESTRATOR_PROMPT } from "./prompts.js";
import { ORCHESTRATOR_TOOLS, setToolCwd } from "./tools.js";
import { loadMissionState, summarizeMissionState, ensureMissionInitialized } from "./artifacts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "./utils/skills.js";
import { getModelConfig, resolveModel } from "./config.js";

/**
 * OrchestratorAgent — Mission-State Governor
 *
 * The orchestrator talks to the user, reasons about scope, calls helper
 * agents (research, smart-friend, contract-writer), and decides phase
 * transitions.  Canonical truth lives in structured mission artifacts.
 *
 * Phases: Intake → Discovery → Clarification → Constraint Analysis →
 *         Validation Contract → Feature Decomposition → User Approval
 */

export interface OrchestratorOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** In-memory sessions only (default: true) */
  inMemory?: boolean;
  /** Override the default orchestrator system prompt */
  systemPrompt?: string;
  /** Thinking level (default: medium) */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Model pattern (e.g. "claude-sonnet-4", "openai/gpt-4o") — uses first available if omitted */
  model?: string;
}

export class OrchestratorAgent {
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private cwd: string = process.cwd();

  /**
   * Initialise the orchestrator agent session with its custom tool suite.
   */
  async init(options: OrchestratorOptions = {}): Promise<void> {
    this.cwd = options.cwd ?? process.cwd();

    // Initialize mission state before anything else
    await ensureMissionInitialized(this.cwd);

    const inMemory = options.inMemory ?? true;

    // Make cwd available to custom tools
    setToolCwd(this.cwd);

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const allOrchestratorSkills = await loadSkillsFromDir(
      this.cwd,
      DEFAULT_ORCHESTRATOR_SKILLS_DIR,
    );
    const orchestratorSkillNames = new Set([
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
    const defaultOrchestratorSkills = allOrchestratorSkills.filter(
      (s) => orchestratorSkillNames.has(s.name),
    );

    // Build a dynamic system prompt that injects current mission state
    const buildSystemPrompt = (): string => {
      const base = options.systemPrompt ?? ORCHESTRATOR_PROMPT;
      // We cannot await here synchronously, so state injection happens
      // via the load_mission_state tool instead.
      return base;
    };

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      systemPromptOverride: buildSystemPrompt,
      skillsOverride: () => {
        return {
          skills: defaultOrchestratorSkills,
          diagnostics: [],
        };
      },
    });
    await resourceLoader.reload();

    const sessionManager = inMemory
      ? SessionManager.inMemory(this.cwd)
      : SessionManager.create(this.cwd);

    // Orchestrator tool set: built-ins + custom mission tools
    const toolNames = [
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

    // Resolve orchestrator model from config, CLI option, or SDK default
    const modelConfig = await getModelConfig(this.cwd);
    const orchestratorModel = resolveModel(options.model ?? modelConfig.orchestrator);

    const { session } = await createAgentSession({
      cwd: this.cwd,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader,
      sessionManager,
      model: orchestratorModel,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: toolNames,
      customTools: ORCHESTRATOR_TOOLS,
    });

    this.session = session;

    // Default telemetry subscription — streams assistant text to stdout
    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          if (event.assistantMessageEvent.type === "text_delta") {
            process.stdout.write(event.assistantMessageEvent.delta);
          }
          break;
        }
        case "tool_execution_start": {
          // eslint-disable-next-line no-console
          console.error(`\n[TOOL START] ${event.toolName}\n`);
          break;
        }
        case "tool_execution_end": {
          // eslint-disable-next-line no-console
          console.error(
            `\n[TOOL END] ${event.toolName} — ${event.isError ? "ERROR" : "OK"}\n`,
          );
          break;
        }
        case "agent_start": {
          // eslint-disable-next-line no-console
          console.error("\n[AGENT START]\n");
          break;
        }
        case "agent_end": {
          // eslint-disable-next-line no-console
          console.error("\n[AGENT END]\n");
          break;
        }
      }
    });
  }

  /**
   * Send a prompt to the orchestrator and wait for it to finish.
   * If a mission state exists, it is automatically injected as context.
   */
  async prompt(text: string): Promise<void> {
    if (!this.session) {
      throw new Error("OrchestratorAgent not initialised. Call init() first.");
    }

    // Inject current mission state into the prompt
    let augmented = text;
    try {
      const state = await loadMissionState(this.cwd);
      const summary = summarizeMissionState(state);
      augmented = `${summary}\n\n---\n\n${text}`;
    } catch {
      // If no mission state exists yet, proceed with raw prompt
    }

    await this.session.prompt(augmented);
  }

  /**
   * Subscribe to raw session events.
   * Returns an unsubscribe function.
   */
  subscribe(
    listener: Parameters<AgentSession["subscribe"]>[0],
  ): () => void {
    if (!this.session) {
      throw new Error("OrchestratorAgent not initialised. Call init() first.");
    }
    return this.session.subscribe(listener);
  }

  /**
   * Access the underlying AgentSession.
   */
  getSession(): AgentSession {
    if (!this.session) {
      throw new Error("OrchestratorAgent not initialised. Call init() first.");
    }
    return this.session;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
  }
}

/* ── Standalone entrypoint (useful for quick tests) ── */

async function main() {
  const agent = new OrchestratorAgent();
  await agent.init({
    thinkingLevel: "medium",
  });

  try {
    await agent.prompt(
      "I want to build a Slack clone with workspace auth, channels, threads, real-time messaging, reactions, mentions, file uploads, search, and presence notifications. " +
        "Walk me through the intake and discovery phases.",
    );
    // eslint-disable-next-line no-console
    console.log("\n--- Done ---");
  } finally {
    agent.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
