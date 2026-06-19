/**
 * Service-Mode Progress Detector
 *
 * Detects whether a service-mode orchestrator turn produced any *durable*
 * progress. If not, the job must NOT be marked succeeded — it should be
 * retried or failed with `no_mission_progress`.
 *
 * ## What counts as durable progress
 *
 * Durable progress means the orchestrator turn changed mission state, enqueued
 * real work, persisted a user-facing artifact, or advanced the mission phase.
 * Mere lifecycle/telemetry/read-only activity is NOT durable progress.
 *
 * Always-durable event types (any one is sufficient):
 *   - artifact_write       — a mission artifact was written
 *   - phase_transition     — the mission phase changed
 *   - halt                 — the mission was halted
 *   - assistant_message    — user-facing text was produced (service-mode visibility)
 *   - decision_logged      — a decision was recorded
 *   - pending_question     — the service-mode ask_user bridge persisted a
 *                            question for the user (service-mode visibility)
 *
 * Tool events (`tool_call`, `tool_result`, `session_tool_start`,
 * `session_tool_end`) are durable ONLY when the tool is a mutating/durable
 * tool (see `DURABLE_TOOL_NAMES`). Read-only / lifecycle / telemetry tools
 * such as `load_mission_state`, `list_models`, `get_feature_complexity`, and
 * `ping_agents` are NOT durable progress.
 *
 * Never-durable event types:
 *   - agent_start, agent_end, mission_initialized, state_loaded, ping,
 *     session_agent_event (lifecycle), budget_usage, budget_exceeded
 *     (telemetry), validation_recovery, integration_preflight (preflight
 *     observations — the durable mutation happens via the tool calls they
 *     describe).
 */

import type { RatelEvent, EventType } from "../core/observability/event-logger.js";

/**
 * Event types that ALWAYS count as durable progress, regardless of payload.
 */
const DURABLE_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "artifact_write",
  "phase_transition",
  "halt",
  "assistant_message",
  "decision_logged",
  "pending_question",
]);

/**
 * Event types that carry a `toolName` in their `data` and are durable ONLY
 * when the tool is in `DURABLE_TOOL_NAMES`.
 */
const TOOL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "tool_call",
  "tool_result",
  "session_tool_start",
  "session_tool_end",
]);

/**
 * Mutating / durable tools. A `tool_call`/`tool_result`/`session_tool_start`/
 * `session_tool_end` event for one of these tools counts as durable progress.
 *
 * Read-only or telemetry tools (e.g. `load_mission_state`, `list_models`,
 * `get_feature_complexity`, `ping_agents`, `model_attempt`, `model_fallback`,
 * `run_research`, `ask_smart_friend`) are intentionally NOT listed here.
 */
const DURABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "run_worker",
  "run_validation",
  "run_user_testing",
  "write_mission_artifact",
  "write_feature_file",
  "draft_validation_contract",
  "halt_mission",
  "wait_for_user_approval",
  "mark_feature_integrated",
  "mark_milestone_validated",
  "mark_mission_completed",
  "ensure_skills_installed",
]);

/**
 * Read-only / non-durable tool names. Listed explicitly for clarity and for
 * regression tests; events for these tools must NEVER count as durable
 * progress even if they appear as `tool_call`/`tool_result`/`session_tool_*`.
 */
const NON_DURABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "load_mission_state",
  "list_models",
  "get_feature_complexity",
  "ping_agents",
  // ask_user tool calls alone are NOT durable progress: in service mode the
  // built-in/extension ask_user is a ghost (returns empty/cancelled). The
  // durable marker is the `pending_question` event emitted by the
  // service-mode ask_user bridge, not the tool call itself.
  "ask_user",
]);

/** Event types that are explicitly NOT progress (lifecycle/telemetry). */
const NON_PROGRESS_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "agent_start",
  "agent_end",
  "mission_initialized",
  "state_loaded",
  "ping",
  "session_agent_event",
  "budget_usage",
  "budget_exceeded",
  "validation_recovery",
  "integration_preflight",
]);

/** Extract the tool name from a tool event's `data`. */
function toolNameOf(event: RatelEvent): string | undefined {
  const name = event.data?.toolName;
  return typeof name === "string" ? name : undefined;
}

/**
 * Return true if a single event represents a durable progress marker.
 *
 * - Always-durable event types count regardless of payload.
 * - Tool events count only when their `toolName` is a durable mutating tool.
 * - Everything else does not count.
 */
export function isDurableProgressEvent(event: RatelEvent): boolean {
  const type = event.event_type as EventType;

  if (DURABLE_EVENT_TYPES.has(type)) return true;

  if (TOOL_EVENT_TYPES.has(type)) {
    const toolName = toolNameOf(event);
    // Conservative: a tool event without a toolName is not counted, since we
    // cannot confirm it is a mutating tool.
    if (toolName === undefined) return false;
    if (NON_DURABLE_TOOL_NAMES.has(toolName)) return false;
    return DURABLE_TOOL_NAMES.has(toolName);
  }

  return false;
}

/**
 * Check whether a set of events contains at least one durable progress marker.
 */
export function hasDurableProgress(events: RatelEvent[]): boolean {
  return events.some(isDurableProgressEvent);
}

/**
 * Filter events to only those that represent durable progress.
 */
export function filterProgressEvents(events: RatelEvent[]): RatelEvent[] {
  return events.filter(isDurableProgressEvent);
}

/**
 * Error thrown when a service-mode orchestrator job completes its turn
 * without producing any durable progress.
 */
export class NoMissionProgressError extends Error {
  public readonly code = "no_mission_progress";
  public readonly retryable = true;

  constructor(
    message = "Orchestrator turn completed with no durable progress",
    public readonly eventsSeen: number = 0,
  ) {
    super(message);
    this.name = "NoMissionProgressError";
  }
}
