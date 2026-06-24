/**
 * Ratel Factory — Native Pi Coding Agent Extension
 *
 * Thin adapter that registers Pi-native commands, tools, and lifecycle hooks
 * for the Ratel AI Software Factory. The extension runs the Ratel orchestrator
 * **in-process** via `@ratel-factory/core` — there is no separate daemon, no
 * out-of-band process, and no service-client/autostart design.
 * All mission/job/event state is durable under
 * `.ratel/missions/<missionId>/` via core's mission/event helpers.
 *
 * Loaded via `pi install npm:@ratel-factory/pi-extension` and the Pi
 * extension API (default factory export). See the bundled
 * `skills/ratel-factory/SKILL.md` for the end-user mission loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RatelRuntime } from "./runtime.js";
import { resolveProjectRoot } from "./resolve-project-root.js";
import { handleCommand } from "./commands.js";
import { getFactoryModePrompt } from "./prompts.js";

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
    Type.Number({ description: "Seconds between re-reads (default 2, clamped to [1, 60])" }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({ description: "Max total seconds before giving up (default 60, clamped to [1, 300])" }),
  ),
  stopWhen: Type.Optional(
    Type.String({
      description:
        "Comma-separated stop conditions: orchestrator_question, phase_change, mission_complete, halted. " +
        "Default: orchestrator_question,mission_complete,halted",
    }),
  ),
  after: Type.Optional(
    Type.Number({ description: "0-based event index to start reading from (default 0)" }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ACTIVE_MISSION_MSG =
  "No active Ratel mission in this Pi session. Start a mission with ratel_start_mission (or /ratel-start <goal>). The Pi extension runs the orchestrator in-process — no separate daemon is required.";

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
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function RatelExtension(pi: ExtensionAPI): void {
  let runtime: RatelRuntime | null = null;

  function getRuntime(): RatelRuntime {
    if (!runtime) {
      // Fallback for tool calls that fire before session_start resolves.
      runtime = new RatelRuntime({ projectRoot: resolveProjectRoot({ cwd: process.cwd() }) });
    }
    return runtime;
  }

  // ── Commands ──────────────────────────────────────────────────────────

  const commandSpecs: Array<{ name: string; description: string }> = [
    { name: "ratel", description: "Show Ratel in-process availability and ping factory roles" },
    { name: "ratel-start", description: "Start a new Ratel mission: /ratel-start <goal>" },
    { name: "ratel-status", description: "Show the current Ratel mission status" },
    { name: "ratel-approve", description: "Approve the current mission waiting for approval" },
    { name: "ratel-mission", description: "Alias for /ratel-status (compatibility)" },
    { name: "ratel-observatory", description: "Show the Ratel Observatory dashboard or local mission directory" },
  ];

  for (const spec of commandSpecs) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      handler: async (args, ctx) => {
        await handleCommand({ command: spec.name, args, ctx, runtime: getRuntime() });
      },
    });
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ratel_start_mission",
    label: "Start Mission",
    description:
      "Start a new Ratel factory mission with a goal. The Pi extension runs the orchestrator in-process (no separate daemon, no out-of-band process). " +
      "The factory runs intake, discovery, and produces a validation contract. Cache the returned missionId and call ratel_poll_status to watch progress.",
    promptSnippet: "Start a Ratel factory mission from a goal",
    promptGuidelines: [
      "Use ratel_start_mission when the user wants to kick off an autonomous software factory mission. Cache the returned missionId.",
    ],
    parameters: GoalSchema,
    async execute(_toolCallId, params, signal) {
      try {
        const result = await getRuntime().startMission(params.goal ?? "", signal);
        return textResult(
          `Mission started in-process: ${result.missionId}. ${result.note} Call ratel_poll_status to watch progress.`,
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
      "Get the current mission status by missionId, read from local .ratel/missions/<missionId>/ artifacts. Use sparingly; prefer ratel_poll_status for compact, token-efficient progress.",
    promptSnippet: "Check a Ratel mission's current status",
    parameters: MissionIdSchema,
    async execute(_toolCallId, params) {
      try {
        const result = await getRuntime().getStatus();
        if (!result.active) {
          return textResult(result.message ?? NO_ACTIVE_MISSION_MSG, result);
        }
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
      "Poll Ratel mission events from the local events.jsonl (no HTTP) until a stop condition is met or timeout. Use after ratel_start_mission to watch progress without expensive raw dumps. " +
      "Returns a compact summary: stopReason, latestStatus, approvalNeeded, eventsSeen, nextAfter, intervalSeconds, timeoutSeconds (effective clamped values), and optional assistantMessage / pendingQuestion. " +
      "intervalSeconds is clamped to [1, 60] (default 2). timeoutSeconds is clamped to [1, 300] (default 60). " +
      "Stop conditions: orchestrator_question (needs user approval or a pending question), phase_change (any phase transition), mission_complete (completed), halted (halted/cancelled).",
    promptSnippet: "Poll Ratel mission progress until a stop condition fires",
    promptGuidelines: [
      "Use ratel_poll_status after ratel_start_mission, and again after ratel_answer_question, ratel_reply_to_factory, or ratel_approve_plan, to watch the next orchestrator turn.",
      "When ratel_poll_status returns stopReason: orchestrator_question with a pendingQuestion, ask the user in chat and then call ratel_answer_question with the questionId and their answer.",
      "When ratel_poll_status returns stopReason: orchestrator_question with an assistantMessage and no pendingQuestion, report it to the user and call ratel_reply_to_factory with their reply.",
      "When ratel_poll_status returns stopReason: orchestrator_question with approvalNeeded and no pending question, report to the user and call ratel_approve_plan after approval.",
    ],
    parameters: PollStatusSchema,
    async execute(_toolCallId, params, signal) {
      const missionId: string = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      try {
        const text = await getRuntime().pollStatus({
          after: typeof params.after === "number" ? params.after : undefined,
          intervalSeconds: typeof params.intervalSeconds === "number" ? params.intervalSeconds : undefined,
          timeoutSeconds: typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined,
          stopWhen: typeof params.stopWhen === "string" ? params.stopWhen : undefined,
          signal,
        });
        return textResult(text);
      } catch (err) {
        return textResult(`Failed to poll mission status: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_approve_plan",
    label: "Approve Plan",
    description:
      "Approve or reject a Ratel mission that is waiting for user approval. The Pi extension prompts the in-process orchestrator directly. Call after ratel_poll_status returns stopReason=orchestrator_question and the user has reviewed the plan. " +
      "ratel_approve_mission is kept as a compatibility alias.",
    parameters: ApprovePlanSchema,
    async execute(_toolCallId, params, signal) {
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      try {
        await getRuntime().approvePlan(params.approved ?? true, params.feedback, signal);
        return textResult(
          `Mission ${params.approved === false ? "rejected" : "approved"} in-process: ${missionId}. Call ratel_poll_status to watch progress.`,
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
      "Send a free-form user reply / clarification / answer to the current Ratel mission orchestrator (in-process). " +
      "Use after ratel_poll_status returns stopReason: orchestrator_question with an assistantMessage (and no pendingQuestion), once you have asked the user in chat and collected their answer. " +
      "After sending, call ratel_poll_status again. ratel_send_message is kept as a compatibility alias.",
    parameters: SendMessageSchema,
    async execute(_toolCallId, params, signal) {
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      const message = (params.message ?? "").trim();
      if (message.length === 0) return textResult("Error: message is required");
      const questionId =
        typeof params.questionId === "string" && params.questionId.length > 0 ? params.questionId : undefined;
      try {
        await getRuntime().replyToFactory(message, questionId, signal);
        return textResult(
          `Reply delivered in-process to mission ${missionId}. Call ratel_poll_status to watch the next orchestrator turn.`,
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
      "Submit a direct answer to a specific pending Ratel orchestrator question (in-process). Use when ratel_poll_status returned a pendingQuestion with a questionId. " +
      "After answering, call ratel_poll_status again to watch the next turn.",
    parameters: AnswerQuestionSchema,
    async execute(_toolCallId, params, signal) {
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      const questionId = params.questionId ?? "";
      if (!questionId) return textResult("Error: questionId is required");
      if (params.answer === undefined || params.answer === null || String(params.answer).trim() === "") {
        return textResult("Error: answer is required");
      }
      const answerValue = normalizeAnswer(String(params.answer));
      try {
        await getRuntime().answerQuestion(questionId, answerValue, signal);
        return textResult(
          `Answer delivered in-process for question ${questionId} on mission ${missionId}. Call ratel_poll_status to watch the next orchestrator turn.`,
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
      "Prompt the in-process orchestrator to run a worker for a specific feature in the current Ratel mission. ratel_run_worker is kept as a compatibility alias.",
    parameters: RunWorkerSchema,
    async execute(_toolCallId, params, signal) {
      const { missionId, featureId } = params as { missionId: string; featureId: string };
      if (!missionId) return textResult("Error: missionId is required");
      if (!featureId) return textResult("Error: featureId is required");
      try {
        await getRuntime().runFeatureWorker(featureId, signal);
        return textResult(`Worker run requested in-process for feature ${featureId} on mission ${missionId}.`);
      } catch (err) {
        return textResult(`Failed to run worker: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_run_validation",
    label: "Run Validation",
    description:
      "Prompt the in-process orchestrator to run Ratel validation for a milestone. ratel_run_validator is kept as a compatibility alias.",
    parameters: RunValidationSchema,
    async execute(_toolCallId, params, signal) {
      const { missionId, milestoneId } = params as { missionId: string; milestoneId: string };
      if (!missionId) return textResult("Error: missionId is required");
      if (!milestoneId) return textResult("Error: milestoneId is required");
      try {
        await getRuntime().runValidation(milestoneId, signal);
        return textResult(`Validation run requested in-process for milestone ${milestoneId} on mission ${missionId}.`);
      } catch (err) {
        return textResult(`Failed to run validation: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_ping_agents",
    label: "Ping Agents",
    description:
      "Report local in-process Ratel factory role availability. The Pi extension runs the orchestrator in-process; there is no separate daemon to ping.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const result = await getRuntime().pingAgents();
        const lines = [
          `Ratel Factory (in-process): ${result.ok ? "available" : "degraded"}`,
          `Total roles: ${result.totalAgents}`,
          `Available: ${result.okCount}`,
          `Unavailable: ${result.failedCount}`,
          "",
          ...result.agents.map(
            (a) => `  ${a.status === "ok" ? "✓" : "✗"} ${a.role}${a.detail ? ` — ${a.detail}` : ""}`,
          ),
          "",
          "No separate daemon is required. The orchestrator runs inside this Pi session.",
        ];
        return textResult(lines.join("\n"), result);
      } catch (err) {
        return textResult(`Failed to ping agents: ${describeError(err)}`);
      }
    },
  });

  // ── Compatibility Aliases ────────────────────────────────────────────
  // Older tool names kept registered so existing prompts/skills that call them
  // keep working. Each alias delegates to the same in-process runtime logic as
  // its canonical counterpart.

  pi.registerTool({
    name: "ratel_approve_mission",
    label: "Approve Mission (alias)",
    description:
      "Compatibility alias for ratel_approve_plan. Approve or reject a Ratel mission that is waiting for user approval, prompting the in-process orchestrator directly. Prefer ratel_approve_plan in new prompts.",
    parameters: ApprovePlanSchema,
    async execute(_toolCallId, params, signal) {
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      try {
        await getRuntime().approvePlan(params.approved ?? true, params.feedback, signal);
        return textResult(
          `Mission ${params.approved === false ? "rejected" : "approved"} in-process: ${missionId}. Call ratel_poll_status to watch progress.`,
        );
      } catch (err) {
        return textResult(`Failed to approve mission: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_send_message",
    label: "Send Message (alias)",
    description:
      "Compatibility alias for ratel_reply_to_factory. Send a free-form user reply / clarification to the current Ratel mission orchestrator (in-process). Prefer ratel_reply_to_factory in new prompts.",
    parameters: SendMessageSchema,
    async execute(_toolCallId, params, signal) {
      const missionId = params.missionId ?? "";
      if (!missionId) return textResult("Error: missionId is required");
      const message = (params.message ?? "").trim();
      if (message.length === 0) return textResult("Error: message is required");
      const questionId =
        typeof params.questionId === "string" && params.questionId.length > 0 ? params.questionId : undefined;
      try {
        await getRuntime().replyToFactory(message, questionId, signal);
        return textResult(
          `Reply delivered in-process to mission ${missionId}. Call ratel_poll_status to watch the next orchestrator turn.`,
        );
      } catch (err) {
        return textResult(`Failed to send message: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_run_worker",
    label: "Run Worker (alias)",
    description:
      "Compatibility alias for ratel_run_feature_worker. Prompt the in-process orchestrator to run a worker for a specific feature in the current Ratel mission. Prefer ratel_run_feature_worker in new prompts.",
    parameters: RunWorkerSchema,
    async execute(_toolCallId, params, signal) {
      const { missionId, featureId } = params as { missionId: string; featureId: string };
      if (!missionId) return textResult("Error: missionId is required");
      if (!featureId) return textResult("Error: featureId is required");
      try {
        await getRuntime().runFeatureWorker(featureId, signal);
        return textResult(`Worker run requested in-process for feature ${featureId} on mission ${missionId}.`);
      } catch (err) {
        return textResult(`Failed to run worker: ${describeError(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "ratel_run_validator",
    label: "Run Validator (alias)",
    description:
      "Compatibility alias for ratel_run_validation. Prompt the in-process orchestrator to run Ratel validation for a milestone. Prefer ratel_run_validation in new prompts.",
    parameters: RunValidationSchema,
    async execute(_toolCallId, params, signal) {
      const { missionId, milestoneId } = params as { missionId: string; milestoneId: string };
      if (!missionId) return textResult("Error: missionId is required");
      if (!milestoneId) return textResult("Error: milestoneId is required");
      try {
        await getRuntime().runValidation(milestoneId, signal);
        return textResult(`Validation run requested in-process for milestone ${milestoneId} on mission ${missionId}.`);
      } catch (err) {
        return textResult(`Failed to run validation: ${describeError(err)}`);
      }
    },
  });

  // ── Lifecycle Hooks ───────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    const projectRoot = resolveProjectRoot({ cwd: ctx.cwd });
    runtime = new RatelRuntime({ projectRoot });

    // Restore persisted mission id for UI continuity.
    const restored = await runtime.restoreMissionId();
    ctx.ui.setStatus("ratel", restored ? `Ratel: ${restored}` : "Ratel: ready");

    void event;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const missionId = runtime?.getMissionId();
    if (!missionId) return;
    void ctx;
    void event;
    return { systemPrompt: getFactoryModePrompt() };
  });

  pi.on("session_shutdown", async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
  });
}
