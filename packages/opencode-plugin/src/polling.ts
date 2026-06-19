/**
 * Ratel OpenCode Plugin — Polling Helpers
 *
 * Pure functions for stop-condition detection and response formatting.
 * Extracted from plugin.ts so the plugin entry module keeps only a
 * default export (named runtime exports break OpenCode provider listing).
 */

import type { RatelEvent } from "./service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopWhen =
  | "orchestrator_question"
  | "phase_change"
  | "mission_complete"
  | "halted"
  | "job_complete";

export interface StopDetectionResult {
  stopped: boolean;
  stopReason?: string;
  approvalNeeded?: boolean;
  matchedEvent?: RatelEvent;
  /** Compact pending-question details extracted from a pending_question event. */
  pendingQuestion?: {
    questionId: string;
    question: string;
    options?: string[];
    questionType?: string;
  };
}

export interface PollResponseInput {
  missionId: string;
  stopReason: string;
  approvalNeeded: boolean;
  latestStatus: string;
  eventsSeen: number;
  lastOffset: number;
  matchedEvents: RatelEvent[];
  elapsedSeconds: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  /** Compact assistant message preview, if an assistant_message event was matched. */
  assistantMessage?: string;
  /** Compact pending-question details, if a pending_question event was matched. */
  pendingQuestion?: {
    questionId: string;
    question: string;
    options?: string[];
    questionType?: string;
  };
}

// ---------------------------------------------------------------------------
// Timing clamping
// ---------------------------------------------------------------------------

export interface ClampedTiming {
  intervalSeconds: number;
  timeoutSeconds: number;
}

/**
 * Clamp polling timing args to safe bounds.
 * - intervalSeconds: default 10, min 1, max 60
 * - timeoutSeconds: default 300, min 1, max 300
 */
export function clampTiming(
  rawInterval: number | undefined,
  rawTimeout: number | undefined,
): ClampedTiming {
  const intervalSeconds = Math.max(1, Math.min(60, Math.round(rawInterval ?? 10)));
  const timeoutSeconds = Math.max(1, Math.min(300, Math.round(rawTimeout ?? 300)));
  return { intervalSeconds, timeoutSeconds };
}

// ---------------------------------------------------------------------------
// Stop condition detection
// ---------------------------------------------------------------------------

/**
 * Analyze a batch of events and mission status to detect stop conditions.
 *
 * Semantic mappings from user-facing stopWhen names to real events:
 * - orchestrator_question → phase_transition data.to === "user_approval"
 *   OR mission status "waiting_for_approval"
 * - phase_change → any phase_transition event
 * - mission_complete → phase_transition data.to === "completed"
 *   OR mission status "completed"
 * - halted → halt event OR mission status "halted" / "cancelled"
 * - job_complete → no real event exists; silently ignored (never triggers)
 */
export function detectStopCondition(
  events: RatelEvent[],
  missionStatus: string,
  stopWhen: StopWhen[],
): StopDetectionResult {
  for (const condition of stopWhen) {
    switch (condition) {
      case "orchestrator_question": {
        // Check for pending_question events — the service-mode ask_user bridge
        // persists a question for the user. This is the primary intake signal
        // in service mode (no TUI).
        const pendingEvent = events.find(
          (e) => e.event_type === "pending_question",
        );
        if (pendingEvent) {
          const d = (pendingEvent.data ?? {}) as Record<string, unknown>;
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
            matchedEvent: pendingEvent,
            pendingQuestion: {
              questionId: String(d.questionId ?? ""),
              question: String(d.question ?? ""),
              options: Array.isArray(d.options)
                ? (d.options as unknown[]).filter((o): o is string => typeof o === "string")
                : undefined,
              questionType: typeof d.questionType === "string" ? d.questionType : undefined,
            },
          };
        }
        // Check events for phase_transition to user_approval
        const approvalEvent = events.find(
          (e) =>
            e.event_type === "phase_transition" &&
            e.data?.to === "user_approval",
        );
        if (approvalEvent) {
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
            matchedEvent: approvalEvent,
          };
        }
        // Check for assistant_message events — the orchestrator may have
        // produced user-facing text/questions without a formal phase transition.
        const assistantMsgEvent = events.find(
          (e) => e.event_type === "assistant_message",
        );
        if (assistantMsgEvent) {
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
            matchedEvent: assistantMsgEvent,
          };
        }
        // Check mission status
        if (missionStatus === "waiting_for_approval") {
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
          };
        }
        break;
      }

      case "phase_change": {
        const phaseEvent = events.find(
          (e) => e.event_type === "phase_transition",
        );
        if (phaseEvent) {
          return {
            stopped: true,
            stopReason: "phase_change",
            matchedEvent: phaseEvent,
          };
        }
        break;
      }

      case "mission_complete": {
        // Check events for phase_transition to completed
        const completeEvent = events.find(
          (e) =>
            e.event_type === "phase_transition" &&
            e.data?.to === "completed",
        );
        if (completeEvent) {
          return {
            stopped: true,
            stopReason: "mission_complete",
            matchedEvent: completeEvent,
          };
        }
        // Check mission status
        if (missionStatus === "completed") {
          return {
            stopped: true,
            stopReason: "mission_complete",
          };
        }
        break;
      }

      case "halted": {
        // Check events for halt
        const haltEvent = events.find((e) => e.event_type === "halt");
        if (haltEvent) {
          return {
            stopped: true,
            stopReason: "halted",
            matchedEvent: haltEvent,
          };
        }
        // Check mission status
        if (missionStatus === "halted" || missionStatus === "cancelled") {
          return {
            stopped: true,
            stopReason: "halted",
          };
        }
        break;
      }

      case "job_complete": {
        // No real event exists for job_complete. Silently ignored.
        // Documented as unsupported in tool description.
        break;
      }
    }
  }

  return { stopped: false };
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

/**
 * Format a compact JSON response suitable for model consumption.
 * Does NOT include raw full event arrays — only summary fields.
 */
export function formatPollResponse(input: PollResponseInput): string {
  // Bound matchedEvents to last 5
  const bounded = input.matchedEvents.slice(-5);

  const response: Record<string, unknown> = {
    missionId: input.missionId,
    stopReason: input.stopReason,
    approvalNeeded: input.approvalNeeded,
    latestStatus: input.latestStatus,
    eventsSeen: input.eventsSeen,
    nextAfter: input.lastOffset,
    elapsedSeconds: input.elapsedSeconds,
    intervalSeconds: input.intervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    matchedEvents: bounded.map((e) => ({
      event_type: e.event_type,
      data: e.data,
      timestamp: e.timestamp,
    })),
  };

  // Include compact assistant message preview if present
  if (input.assistantMessage) {
    response.assistantMessage = input.assistantMessage;
  }

  // Include compact pending-question details if present (service-mode intake)
  if (input.pendingQuestion) {
    response.pendingQuestion = input.pendingQuestion;
  }

  return JSON.stringify(response, null, 2);
}
