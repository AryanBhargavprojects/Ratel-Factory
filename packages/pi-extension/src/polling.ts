/**
 * Ratel Pi Extension — Polling Helpers
 *
 * Pure functions for stop-condition detection and compact response formatting.
 * Extracted so the extension entry module stays focused on registration. These
 * helpers keep Pi chat context lean by surfacing only stop reasons, pending
 * questions, and assistant-message previews — never raw event dumps.
 */

import type { RatelEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopWhen =
  | "orchestrator_question"
  | "phase_change"
  | "mission_complete"
  | "halted"
  | "job_complete";

export interface PendingQuestion {
  questionId: string;
  question: string;
  options?: string[];
  questionType?: string;
}

export interface StopDetectionResult {
  stopped: boolean;
  stopReason?: string;
  approvalNeeded?: boolean;
  matchedEvent?: RatelEvent;
  /** Compact pending-question details extracted from a pending_question event. */
  pendingQuestion?: PendingQuestion;
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
  pendingQuestion?: PendingQuestion;
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

const STOP_WHEN_VALUES = new Set<StopWhen>([
  "orchestrator_question",
  "phase_change",
  "mission_complete",
  "halted",
  "job_complete",
]);

/** Parse a comma-separated stopWhen string into a validated list. */
export function parseStopWhen(raw: string | undefined): StopWhen[] {
  if (!raw) return ["orchestrator_question", "mission_complete", "halted"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is StopWhen => STOP_WHEN_VALUES.has(s as StopWhen));
}

function extractPendingQuestion(data: Record<string, unknown>): PendingQuestion {
  return {
    questionId: String(data.questionId ?? ""),
    question: String(data.question ?? ""),
    options: Array.isArray(data.options)
      ? (data.options as unknown[]).filter((o): o is string => typeof o === "string")
      : undefined,
    questionType: typeof data.questionType === "string" ? data.questionType : undefined,
  };
}

/**
 * Analyze a batch of events and mission status to detect stop conditions.
 *
 * Semantic mappings from user-facing stopWhen names to real events:
 * - orchestrator_question → pending_question event, OR phase_transition
 *   data.to === "user_approval", OR assistant_message event, OR mission
 *   status "waiting_for_approval".
 * - phase_change → any phase_transition event.
 * - mission_complete → phase_transition data.to === "completed" OR mission
 *   status "completed".
 * - halted → halt event OR mission status "halted" / "cancelled".
 * - job_complete → no real event exists; silently ignored (never triggers).
 */
export function detectStopCondition(
  events: RatelEvent[],
  missionStatus: string,
  stopWhen: StopWhen[],
): StopDetectionResult {
  for (const condition of stopWhen) {
    switch (condition) {
      case "orchestrator_question": {
        const pendingEvent = events.find((e) => e.event_type === "pending_question");
        if (pendingEvent) {
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
            matchedEvent: pendingEvent,
            pendingQuestion: extractPendingQuestion((pendingEvent.data ?? {}) as Record<string, unknown>),
          };
        }
        const approvalEvent = events.find(
          (e) => e.event_type === "phase_transition" && e.data?.to === "user_approval",
        );
        if (approvalEvent) {
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
            matchedEvent: approvalEvent,
          };
        }
        const assistantMsgEvent = events.find((e) => e.event_type === "assistant_message");
        if (assistantMsgEvent) {
          return {
            stopped: true,
            stopReason: "orchestrator_question",
            approvalNeeded: true,
            matchedEvent: assistantMsgEvent,
          };
        }
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
        const phaseEvent = events.find((e) => e.event_type === "phase_transition");
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
        const completeEvent = events.find(
          (e) => e.event_type === "phase_transition" && e.data?.to === "completed",
        );
        if (completeEvent) {
          return {
            stopped: true,
            stopReason: "mission_complete",
            matchedEvent: completeEvent,
          };
        }
        if (missionStatus === "completed") {
          return {
            stopped: true,
            stopReason: "mission_complete",
          };
        }
        break;
      }

      case "halted": {
        const haltEvent = events.find((e) => e.event_type === "halt");
        if (haltEvent) {
          return {
            stopped: true,
            stopReason: "halted",
            matchedEvent: haltEvent,
          };
        }
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

  if (input.assistantMessage) {
    response.assistantMessage = input.assistantMessage;
  }

  if (input.pendingQuestion) {
    response.pendingQuestion = input.pendingQuestion;
  }

  return JSON.stringify(response, null, 2);
}
