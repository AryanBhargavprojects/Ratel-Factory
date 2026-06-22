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
import { createOrchestratorTools } from "./tools.js";
import { loadMissionState, summarizeMissionState, ensureMissionInitialized } from "./artifacts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "./utils/skills.js";
import { getModelConfig, resolveModel, getFallbackModelConfig } from "./config.js";
import { EventLogger } from "./observability/event-logger.js";
import { createMissionScope } from "./mission/scope.js";
import type { MissionExecutionContext } from "./mission/execution-context.js";
import { BudgetManager } from "./budget/budget-manager.js";
import { ModelRouter } from "./models/model-router.js";

/** Maximum characters before emitting an intermediate assistant_message chunk. */
const ASSISTANT_CHUNK_THRESHOLD = 2000;

/** Maximum characters stored in a single assistant_message event payload. */
const ASSISTANT_MAX_TEXT_LENGTH = 8000;

/** Maximum preview length for poll responses. */
const ASSISTANT_PREVIEW_LENGTH = 300;

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
  /** Mission ID (defaults to generating one from state or a new UUID) */
  missionId?: string;
  /** In-memory sessions only (default: true) */
  inMemory?: boolean;
  /** Override the default orchestrator system prompt */
  systemPrompt?: string;
  /** Thinking level (default: medium) */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Model pattern (e.g. "claude-sonnet-4", "openai/gpt-4o") — uses first available if omitted */
  model?: string;
  /** Job control for durable approval flow */
  jobControl?: MissionExecutionContext["jobControl"];
  /** Budget manager for mission-level budget enforcement */
  budget?: BudgetManager;
}

export class OrchestratorAgent {
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private cwd: string = process.cwd();
  private context: MissionExecutionContext | undefined;

  /**
   * Initialise the orchestrator agent session with its custom tool suite.
   */
  async init(options: OrchestratorOptions = {}): Promise<void> {
    this.cwd = options.cwd ?? process.cwd();

    // Create or resolve mission scope
    const missionId = options.missionId ?? "mis_00000001";
    const scope = createMissionScope(this.cwd, missionId);

    // Initialize mission state before anything else
    const logger = await EventLogger.forMission(scope);
    await ensureMissionInitialized(scope, logger);

    // Initialize model router with fallback chain support
    const fallbackConfig = await getFallbackModelConfig(this.cwd);
    const models = new ModelRouter({
      projectRoot: this.cwd,
      orchestrator: {
        model: fallbackConfig.orchestrator.model ?? "sdk-default",
        fallbackModels: fallbackConfig.orchestrator.fallbackModels ?? [],
      },
      worker: {
        model: fallbackConfig.worker.model ?? "sdk-default",
        fallbackModels: fallbackConfig.worker.fallbackModels ?? [],
      },
      validator: {
        model: fallbackConfig.validator.model ?? "sdk-default",
        fallbackModels: fallbackConfig.validator.fallbackModels ?? [],
      },
      modelRouting: fallbackConfig.modelRouting,
    });
    await models.init();

    this.context = { scope, logger, budget: options.budget!, models, jobControl: options.jobControl };

    const inMemory = options.inMemory ?? true;

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
      customTools: createOrchestratorTools(this.context!),
    });

    this.session = session;

    // Default telemetry subscription — streams assistant text to stdout
    // AND accumulates text for durable assistant_message events.
    let accumulatedText = "";
    let lastChunkEnd = 0;

    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          if (event.assistantMessageEvent.type === "text_delta") {
            process.stdout.write(event.assistantMessageEvent.delta);
            accumulatedText += event.assistantMessageEvent.delta;

            // Emit intermediate chunk if we've crossed the threshold
            // and are at a natural break (paragraph or sentence boundary).
            if (accumulatedText.length - lastChunkEnd >= ASSISTANT_CHUNK_THRESHOLD) {
              const newText = accumulatedText.slice(lastChunkEnd);
              const breakIdx = findNaturalBreak(newText);
              if (breakIdx > 0) {
                const chunk = newText.slice(0, breakIdx);
                lastChunkEnd += breakIdx;
                const bounded = boundText(chunk);
                this.context?.logger.assistantMessage({
                  role: "orchestrator",
                  text: bounded.text,
                  length: chunk.length,
                  truncated: bounded.truncated,
                  preview: makePreview(chunk),
                }, "orchestrator");
              }
            }
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

          // Emit final accumulated text as a durable assistant_message event.
          // This is the primary durable artifact for service-mode visibility.
          if (accumulatedText.length > 0) {
            const finalText = accumulatedText.slice(lastChunkEnd);
            if (finalText.length > 0) {
              const bounded = boundText(finalText);
              this.context?.logger.assistantMessage({
                role: "orchestrator",
                text: bounded.text,
                length: finalText.length,
                truncated: bounded.truncated,
                preview: makePreview(finalText),
              }, "orchestrator");
            }
          }
          break;
        }
      }
    });
  }

  /**
   * Send a prompt to the orchestrator and wait for it to finish.
   * If a mission state exists, it is automatically injected as context.
   */
  async prompt(text: string, signal?: AbortSignal): Promise<void> {
    if (!this.session) {
      throw new Error("OrchestratorAgent not initialised. Call init() first.");
    }
    if (!this.context) {
      throw new Error("OrchestratorAgent context not initialized.");
    }

    // Inject current mission state into the prompt
    let augmented = text;
    try {
      const state = await loadMissionState(this.context.scope);
      const summary = summarizeMissionState(state);
      augmented = `${summary}\n\n---\n\n${text}`;
    } catch {
      // If no mission state exists yet, proceed with raw prompt
    }

    // Wire abort signal to session abort
    let abortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        throw new Error("Prompt aborted before execution");
      }
      abortHandler = () => {
        this.session?.abort();
      };
      signal.addEventListener("abort", abortHandler);
    }

    try {
      await this.session.prompt(augmented);
    } finally {
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
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

/* ── Assistant text helpers ── */

/**
 * Find a natural break point in text (paragraph, sentence, or line boundary)
 * within the first chunkThreshold characters. Returns 0 if no good break found.
 */
function findNaturalBreak(text: string): number {
  // Prefer paragraph break (double newline)
  const paraIdx = text.indexOf("\n\n");
  if (paraIdx > 0 && paraIdx < ASSISTANT_CHUNK_THRESHOLD) return paraIdx + 2;

  // Then sentence break (.!? followed by space/newline)
  const sentenceMatch = text.match(/[.!?]\s/g);
  if (sentenceMatch) {
    // Find the last sentence break within threshold
    let lastIdx = 0;
    const regex = /[.!?]\s/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index + 2 <= ASSISTANT_CHUNK_THRESHOLD) {
        lastIdx = m.index + 2;
      } else {
        break;
      }
    }
    if (lastIdx > 0) return lastIdx;
  }

  // Fall back to line break
  const lineIdx = text.indexOf("\n");
  if (lineIdx > 0 && lineIdx < ASSISTANT_CHUNK_THRESHOLD) return lineIdx + 1;

  return 0;
}

/** Bound text to max length, returning truncated flag. */
function boundText(text: string): { text: string; truncated: boolean } {
  if (text.length <= ASSISTANT_MAX_TEXT_LENGTH) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, ASSISTANT_MAX_TEXT_LENGTH),
    truncated: true,
  };
}

/** Create a short preview from the beginning of the text. */
function makePreview(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.length <= ASSISTANT_PREVIEW_LENGTH) return trimmed;
  return trimmed.slice(0, ASSISTANT_PREVIEW_LENGTH) + "…";
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
