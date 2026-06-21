/**
 * Ratel Factory — Native Pi Coding Agent Extension
 *
 * Thin adapter that registers Pi-native commands, tools, and lifecycle hooks
 * for the Ratel AI Software Factory. Delegates all mission/job/event/state
 * work to the Ratel core service over HTTP. The extension itself performs no
 * orchestration.
 *
 * Loaded via `pi install npm:@ratel-factory/pi-extension` and the Pi
 * extension API (default factory export). See the bundled
 * `skills/ratel-factory/SKILL.md` for the end-user mission loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RatelServiceClient, RatelServiceError } from "./service.js";
import {
  ensureRatelService,
  cleanupSpawnedService,
  type ServiceLogger,
} from "./service-lifecycle.js";
import { resolveProjectRoot } from "./resolve-project-root.js";
import { handleCommand } from "./commands.js";
import { getFactoryModePrompt } from "./prompts.js";
import {
  clampTiming,
  detectStopCondition,
  formatPollResponse,
  parseStopWhen,
} from "./polling.js";
import type { RatelEvent } from "./service.js";

// ---------------------------------------------------------------------------
// Schemas (TypeBox — Pi-native tool parameter definitions)
// ---------------------------------------------------------------------------

const GoalSchema = Type.Object({
  goal: Type.String({ description: "The mission goal or user request" }),
});

const MissionIdSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID" }),
});

const RunWorkerSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID" }),
  featureId: Type.String({ description: "Feature ID to run" }),
});

const RunValidationSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID" }),
  milestoneId: Type.String({ description: "Milestone ID to validate" }),
});

const ApprovePlanSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID to approve" }),
  approved: Type.Optional(Type.Boolean({ description: "Whether to approve (default true)" })),
  feedback: Type.Optional(Type.String({ description: "Optional feedback for the orchestrator" })),
});

const SendMessageSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID to send the message to" }),
  message: Type.String({ description: "The user's free-form reply or clarification text" }),
  questionId: Type.Optional(Type.String({ description: "Optional pending question ID this message answers" })),
});

const AnswerQuestionSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID" }),
  questionId: Type.String({ description: "The pending question ID to answer" }),
  answer: Type.String({ description: "The answer text (or JSON-encoded value for structured answers)" }),
});

const PollStatusSchema = Type.Object({
  missionId: Type.String({ description: "Mission ID to poll" }),
  intervalSeconds: Type.Optional(
    Type.Number({ description: "Seconds between polls (default 10, clamped to [1, 60])" }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({ description: "Max total seconds before giving up (default 300, clamped to [1, 300])" }),
  ),
  stopWhen: Type.Optional(
    Type.String({
      description:
        "Comma-separated stop conditions: orchestrator_question, phase_change, mission_complete, halted. " +
        "Default: orchestrator_question,mission_complete,halted",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_UNAVAILABLE_MSG =
  "Ratel service is not available. Run `ratel --serve` manually or restart your Pi session.";

/** Format a tool result as a single text content block. */
function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

/** Tolerate JSON-encoded structured answers. */
function normalizeAnswer(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return trimmed;
}

function describeError(err: unknown): string {
  if (err instanceof RatelServiceError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function RatelExtension(pi: ExtensionAPI): void {
  // Convenience cache for UI continuity; the service is always authoritative.
  let cachedMissionId: string | undefined;
  let cachedJobId: string | undefined;
  let service: RatelServiceClient | null = null;
  let spawnedChild: import("node:child_process").ChildProcess | null = null;
  let projectRoot: string = process.cwd();

  function persistIds(): void {
    pi.appendEntry("ratel", { missionId: cachedMissionId, jobId: cachedJobId });
  }

  function rememberMission(missionId: string, jobId: string): void {
    cachedMissionId = missionId;
    cachedJobId = jobId;
    persistIds();
  }

  const serviceLogger: ServiceLogger = (level, message) => {
    try {
      // Route lifecycle diagnostics through Pi notify (never raw stdout).
      // Map info→info, warning→warning, error→error so the Pi surface shows
      // them at the right severity.
      pi.sendMessage(
        {
          customType: "ratel-lifecycle",
          content: message,
          display: false,
          details: { level },
        },
        { deliverAs: "nextTurn" },
      );
    } catch {
      // Best-effort; never let logging propagate.
    }
  };

  // ── Commands ──────────────────────────────────────────────────────────

  const commandSpecs: Array<{ name: string; description: string }> = [
    { name: "ratel", description: "Show Ratel service health and ping factory agents" },
    { name: "ratel-start", description: "Start a new Ratel mission: /ratel-start <goal>" },
    { name: "ratel-status", description: "Show the current Ratel mission status" },
    { name: "ratel-approve", description: "Approve the current mission waiting for approval" },
    { name: "ratel-mission", description: "Alias for /ratel-status (compatibility)" },
    { name: "ratel-observatory", description: "Open the Ratel Observatory dashboard" },
  ];

  for (const spec of commandSpecs) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      handler: async (args, ctx) => {
        await handleCommand({
          command: spec.name,
          args,
          ctx,
          service,
          cachedMissionId,
          cachedJobId,
        });
      },
    });
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ratel_start_mission",
    label: "Start Mission",
    description:
      "Start a new Ratel factory mission with a goal. The factory runs intake, discovery, and produces a validation contract. " +
      "Cache the returned missionId and call ratel_poll_status to watch progress.",
    promptSnippet: "Start a Ratel factory mission from a goal",
    promptGuidelines: [
      "Use ratel_start_mission when the user wants to kick off an autonomous software factory mission. Cache the returned missionId.",
    ],
    parameters: GoalSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      try {
        const result = await service.startMission(params.goal ?? "");
        rememberMission(result.missionId, result.jobId);
        return textResult(
          `Mission queued: ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch progress.`,
          result,
        );
      } catch (err) {
        return textResult(`Failed to start mission: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_get_status",
    label: "Get Mission Status",
    description:
      "Get the current mission status by missionId. Use sparingly; prefer ratel_poll_status for compact, token-efficient progress.",
    promptSnippet: "Check a Ratel mission's current status",
    parameters: MissionIdSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      try {
        const result = await service.getMissionStatus(params.missionId ?? "");
        return textResult(JSON.stringify(result, null, 2), result);
      } catch (err) {
        return textResult(`Failed to get mission status: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_poll_status",
    label: "Poll Mission Status",
    description:
      "Poll Ratel mission events until a stop condition is met or timeout. Use after ratel_start_mission to watch progress without expensive raw dumps. " +
      "Returns a compact summary: stopReason, latestStatus, approvalNeeded, eventsSeen, nextAfter, intervalSeconds, timeoutSeconds (effective clamped values), and optional assistantMessage / pendingQuestion. " +
      "intervalSeconds is clamped to [1, 60] (default 10). timeoutSeconds is clamped to [1, 300] (default 300). " +
      "Stop conditions: orchestrator_question (needs user approval or a pending question), phase_change (any phase transition), mission_complete (completed), halted (halted/cancelled). job_complete is unsupported (no real event).",
    promptSnippet: "Poll Ratel mission progress until a stop condition fires",
    promptGuidelines: [
      "Use ratel_poll_status after ratel_start_mission, and again after ratel_answer_question, ratel_reply_to_factory, or ratel_approve_plan, to watch the next orchestrator turn.",
      "When ratel_poll_status returns stopReason: orchestrator_question with a pendingQuestion, ask the user in chat and then call ratel_answer_question with the questionId and their answer.",
      "When ratel_poll_status returns stopReason: orchestrator_question with an assistantMessage and no pendingQuestion, report it to the user and call ratel_reply_to_factory with their reply.",
      "When ratel_poll_status returns stopReason: orchestrator_question with approvalNeeded and no pending question, report to the user and call ratel_approve_plan after approval.",
    ],
    parameters: PollStatusSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const missionId: string = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");

      const { intervalSeconds, timeoutSeconds } = clampTiming(params.intervalSeconds, params.timeoutSeconds);
      const intervalMs = intervalSeconds * 1000;
      const timeoutMs = timeoutSeconds * 1000;
      const stopWhen = parseStopWhen(params.stopWhen);

      let offset = 0;
      let eventsSeen = 0;
      const allMatchedEvents: RatelEvent[] = [];
      const startedAt = Date.now();

      while (true) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) {
          return textResult(
            formatPollResponse({
              missionId,
              stopReason: "timeout",
              approvalNeeded: false,
              latestStatus: "unknown",
              eventsSeen,
              lastOffset: offset,
              matchedEvents: allMatchedEvents,
              elapsedSeconds: Math.round(elapsed / 1000),
              intervalSeconds,
              timeoutSeconds,
            }),
          );
        }

        try {
          const eventsResp = await service.getMissionEvents(missionId, offset);
          const newEvents = eventsResp.events;
          eventsSeen += newEvents.length;
          offset = eventsResp.nextAfter;

          let missionStatus = "unknown";
          try {
            const statusResp = await service.getMissionStatus(missionId);
            missionStatus = statusResp.status ?? "unknown";
          } catch {
            // Status fetch is best-effort.
          }

          const detection = detectStopCondition(newEvents, missionStatus, stopWhen);

          if (detection.stopped) {
            if (detection.matchedEvent) {
              allMatchedEvents.push(detection.matchedEvent);
            }
            let assistantMessage: string | undefined;
            const assistantEvent = allMatchedEvents.find((e) => e.event_type === "assistant_message");
            if (assistantEvent?.data?.preview) {
              assistantMessage = String(assistantEvent.data.preview);
            }
            return textResult(
              formatPollResponse({
                missionId,
                stopReason: detection.stopReason!,
                approvalNeeded: detection.approvalNeeded ?? false,
                latestStatus: missionStatus,
                eventsSeen,
                lastOffset: offset,
                matchedEvents: allMatchedEvents,
                elapsedSeconds: Math.round(elapsed / 1000),
                intervalSeconds,
                timeoutSeconds,
                assistantMessage,
                pendingQuestion: detection.pendingQuestion,
              }),
            );
          }

          for (const e of newEvents) {
            if (e.event_type === "phase_transition" || e.event_type === "halt") {
              allMatchedEvents.push(e);
            }
          }
        } catch (err) {
          // Transient errors: continue polling. Keep the loop from hot-spinning.
          const msg = describeError(err);
          try {
            pi.sendMessage(
              { customType: "ratel-lifecycle", content: `Poll warning: ${msg}`, display: false, details: { level: "warning" } },
              { deliverAs: "nextTurn" },
            );
          } catch {
            // ignore
          }
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  });

  pi.registerTool({
    name: "ratel_approve_plan",
    label: "Approve Plan",
    description:
      "Approve or reject a Ratel mission that is waiting for user approval. Call after ratel_poll_status returns stopReason=orchestrator_question and the user has reviewed the plan. " +
      "ratel_approve_mission is kept as a compatibility alias.",
    parameters: ApprovePlanSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      try {
        const result = await service.approveMission(missionId, {
          approved: params.approved ?? true,
          feedback: params.feedback,
        });
        rememberMission(result.missionId, result.jobId);
        return textResult(
          `Mission ${params.approved === false ? "rejected" : "approved"}: ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch progress.`,
          result,
        );
      } catch (err) {
        return textResult(`Failed to approve mission: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_reply_to_factory",
    label: "Reply To Factory",
    description:
      "Send a free-form user reply / clarification / answer to the current Ratel mission orchestrator. " +
      "Use after ratel_poll_status returns stopReason: orchestrator_question with an assistantMessage (and no pendingQuestion), once you have asked the user in chat and collected their answer. " +
      "After sending, call ratel_poll_status again. ratel_send_message is kept as a compatibility alias.",
    parameters: SendMessageSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      const message = (params.message ?? "").trim();
      if (message.length === 0) return textResult("Error: message is required");
      const questionId =
        typeof params.questionId === "string" && params.questionId.length > 0 ? params.questionId : undefined;
      try {
        const result = await service.sendMessage(missionId, message, questionId);
        rememberMission(result.missionId, result.jobId);
        return textResult(
          `Message queued to mission ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch the next orchestrator turn.`,
          result,
        );
      } catch (err) {
        return textResult(`Failed to send message: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_answer_question",
    label: "Answer Question",
    description:
      "Submit a direct answer to a specific pending Ratel orchestrator question. Use when ratel_poll_status returned a pendingQuestion with a questionId. " +
      "After answering, call ratel_poll_status again to watch the next turn.",
    parameters: AnswerQuestionSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      const questionId = params.questionId ?? "";
      if (!questionId) return textResult("Error: questionId is required");
      if (params.answer === undefined || params.answer === null || String(params.answer).trim() === "") {
        return textResult("Error: answer is required");
      }
      const answerValue = normalizeAnswer(String(params.answer));
      try {
        const result = await service.answerQuestion(missionId, questionId, answerValue);
        rememberMission(result.missionId, result.jobId);
        return textResult(
          `Answer queued for question ${questionId} on mission ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch the next orchestrator turn.`,
          result,
        );
      } catch (err) {
        return textResult(`Failed to answer question: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_run_feature_worker",
    label: "Run Feature Worker",
    description:
      "Run a worker for a specific feature in the current Ratel mission. ratel_run_worker is kept as a compatibility alias.",
    parameters: RunWorkerSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const { missionId, featureId } = params as { missionId: string; featureId: string };
      try {
        const result = await service.runWorker(missionId ?? "", featureId ?? "");
        rememberMission(result.missionId, result.jobId);
        return textResult(`Worker queued: ${result.jobId} for mission ${result.missionId}`, result);
      } catch (err) {
        return textResult(`Failed to run worker: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_run_validation",
    label: "Run Validation",
    description: "Run Ratel validation for a milestone. ratel_run_validator is kept as a compatibility alias.",
    parameters: RunValidationSchema,
    async execute(_toolCallId, params) {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const { missionId, milestoneId } = params as { missionId: string; milestoneId: string };
      try {
        const result = await service.runValidation(missionId ?? "", milestoneId ?? "");
        rememberMission(result.missionId, result.jobId);
        return textResult(`Validation queued: ${result.jobId} for mission ${result.missionId}`, result);
      } catch (err) {
        return textResult(`Failed to run validation: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_ping_agents",
    label: "Ping Agents",
    description: "Ping all Ratel factory subagent roles and report health.",
    parameters: Type.Object({}),
    async execute() {
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      try {
        const result = await service.pingAgents();
        const lines = [
          `Ratel Factory health: ${result.ok ? "OK" : "DEGRADED"}`,
          `Total agents: ${result.totalAgents}`,
          `OK: ${result.okCount}`,
          `Failed: ${result.failedCount}`,
          `Total time: ${result.totalTimeMs}ms`,
          "",
          ...result.agents.map(
            (a) => `  ${a.status === "ok" ? "✓" : "✗"} ${a.role}${a.timeMs ? ` (${a.timeMs}ms)` : ""}${a.error ? ` — ${a.error}` : ""}`,
          ),
        ];
        return textResult(lines.join("\n"), result);
      } catch (err) {
        return textResult(`Failed to ping agents: ${describeError(err)}`);
      }
    },
  });

  // ── Lifecycle Hooks ───────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    projectRoot = resolveProjectRoot({ cwd: ctx.cwd });

    // Restore persisted IDs for UI continuity.
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter(
        (e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "ratel",
      )
      .pop() as { data?: { missionId?: string; jobId?: string } } | undefined;
    if (stateEntry?.data?.missionId) cachedMissionId = stateEntry.data.missionId;
    if (stateEntry?.data?.jobId) cachedJobId = stateEntry.data.jobId;

    ctx.ui.setStatus("ratel", cachedMissionId ? `Ratel: ${cachedMissionId}` : undefined);

    // Discover or auto-start the Ratel service. Skip autostart under tests so
    // tests never spawn long-lived processes or touch real user auth.
    const disableAutostart =
      process.env.RATEL_PI_DISABLE_SERVICE_AUTOSTART === "1" ||
      process.env.NODE_ENV === "test" ||
      process.env.npm_lifecycle_event === "test";

    const result = await ensureRatelService({
      projectRoot,
      logger: serviceLogger,
      disableAutostart,
    });
    service = result.client;
    spawnedChild = result.child;

    if (!service && !disableAutostart) {
      ctx.ui.notify(
        "Could not connect to the Ratel service. Check that `ratel` is installed and on PATH, or run `ratel --serve`.",
        "error",
      );
    } else if (service) {
      ctx.ui.setStatus("ratel", cachedMissionId ? `Ratel: ${cachedMissionId}` : "Ratel: ready");
    }

    void event;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!cachedMissionId) return;
    void ctx;
    return { systemPrompt: getFactoryModePrompt() };
  });

  // Gate factory-specific mutating tools against latest service health.
  pi.on("tool_call", async (event) => {
    const factoryMutatingTools = new Set([
      "ratel_start_mission",
      "ratel_run_feature_worker",
      "ratel_run_worker",
      "ratel_run_validation",
    ]);
    if (!factoryMutatingTools.has(event.toolName)) return;
    if (!service) return;
    try {
      const health = await service.health();
      if (health.status !== "ok") {
        return {
          block: true,
          reason: `Ratel service is unhealthy (${health.status}). Factory mutating tools are disabled. Start the service with \`ratel --serve\` and retry.`,
        };
      }
    } catch {
      return {
        block: true,
        reason: `Ratel service is unreachable. Factory mutating tools are disabled. Start the service with \`ratel --serve\` and retry.`,
      };
    }
  });

  pi.on("session_shutdown", async () => {
    // Clean up any service we spawned this session. Discovered services are
    // user-owned and left running.
    cleanupSpawnedService(spawnedChild);
    spawnedChild = null;
    service = null;
  });

  // Re-export a couple of stable aliases for compatibility with callers that
  // learned the older OpenCode-style names. Pi tools are keyed by name, so we
  // register them as additional tools that delegate to the same HTTP calls.
  registerAliasTools(pi, () => service, rememberMission);
}

// ---------------------------------------------------------------------------
// Compatibility alias tools
// ---------------------------------------------------------------------------

/**
 * Register stable alias tool names that older mission prompts may reference.
 * These are thin wrappers around the canonical tools so the Ratel core HTTP
 * semantics stay single-sourced.
 */
function registerAliasTools(
  pi: ExtensionAPI,
  getService: () => RatelServiceClient | null,
  remember: (missionId: string, jobId: string) => void,
): void {
  // ratel_approve_mission → approveMission
  pi.registerTool({
    name: "ratel_approve_mission",
    label: "Approve Mission (alias)",
    description:
      "Compatibility alias for ratel_approve_plan. Approves or rejects a Ratel mission waiting for user approval.",
    parameters: ApprovePlanSchema,
    async execute(_toolCallId, params) {
      const service = getService();
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      try {
        const result = await service.approveMission(missionId, {
          approved: params.approved ?? true,
          feedback: params.feedback,
        });
        remember(result.missionId, result.jobId);
        return textResult(
          `Mission ${params.approved === false ? "rejected" : "approved"}: ${result.missionId} (job ${result.jobId}).`,
          result,
        );
      } catch (err) {
        return textResult(`Failed to approve mission: ${describeError(err)}`);
      }
    },
  });

  // ratel_send_message → sendMessage
  pi.registerTool({
    name: "ratel_send_message",
    label: "Send Message (alias)",
    description:
      "Compatibility alias for ratel_reply_to_factory. Sends a free-form user reply to the Ratel mission orchestrator.",
    parameters: SendMessageSchema,
    async execute(_toolCallId, params) {
      const service = getService();
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      const message = (params.message ?? "").trim();
      if (message.length === 0) return textResult("Error: message is required");
      const questionId =
        typeof params.questionId === "string" && params.questionId.length > 0 ? params.questionId : undefined;
      try {
        const result = await service.sendMessage(missionId, message, questionId);
        remember(result.missionId, result.jobId);
        return textResult(
          `Message queued to mission ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch the next orchestrator turn.`,
          result,
        );
      } catch (err) {
        return textResult(`Failed to send message: ${describeError(err)}`);
      }
    },
  });

  // ratel_run_worker → runWorker
  pi.registerTool({
    name: "ratel_run_worker",
    label: "Run Worker (alias)",
    description: "Compatibility alias for ratel_run_feature_worker. Runs a worker for a feature.",
    parameters: RunWorkerSchema,
    async execute(_toolCallId, params) {
      const service = getService();
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const { missionId, featureId } = params as { missionId: string; featureId: string };
      try {
        const result = await service.runWorker(missionId ?? "", featureId ?? "");
        remember(result.missionId, result.jobId);
        return textResult(`Worker queued: ${result.jobId} for mission ${result.missionId}`, result);
      } catch (err) {
        return textResult(`Failed to run worker: ${describeError(err)}`);
      }
    },
  });

  // ratel_run_validator → runValidation
  pi.registerTool({
    name: "ratel_run_validator",
    label: "Run Validator (alias)",
    description: "Compatibility alias for ratel_run_validation. Runs validation for a milestone.",
    parameters: RunValidationSchema,
    async execute(_toolCallId, params) {
      const service = getService();
      if (!service) return textResult(SERVICE_UNAVAILABLE_MSG);
      const { missionId, milestoneId } = params as { missionId: string; milestoneId: string };
      try {
        const result = await service.runValidation(missionId ?? "", milestoneId ?? "");
        remember(result.missionId, result.jobId);
        return textResult(`Validation queued: ${result.jobId} for mission ${result.missionId}`, result);
      } catch (err) {
        return textResult(`Failed to run validation: ${describeError(err)}`);
      }
    },
  });
}
