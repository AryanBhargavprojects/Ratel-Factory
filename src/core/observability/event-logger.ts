/**
 * Ratel Observatory — Event Logger
 *
 * Append-only JSONL event log for the Ratel AI Software Factory.
 * Every significant action (agent start/end, tool call/result, phase transition,
 * artifact write, decision, halt) is logged as a structured event.
 *
 * Usage:
 *   const logger = EventLogger.forMission(cwd);
 *   logger.agentStart("worker", { featureId: "FEAT-001", model: "claude-sonnet-4" });
 *   logger.toolCall("run_worker", { featureId: "FEAT-001" });
 *   logger.toolResult("run_worker", { parseStatus: "ok", durationMs: 45000 });
 *   logger.agentEnd("worker", { parseStatus: "ok", handoffSummary: "..." });
 *   await logger.shutdown();
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type AgentLevel =
  | "orchestrator"
  | "worker"
  | "scrutiny_validator"
  | "user_testing_validator"
  | "user_testing_shard"
  | "research"
  | "smart_friend"
  | "contract_writer"
  | "code_review";

export type EventType =
  | "agent_start"
  | "agent_end"
  | "tool_call"
  | "tool_result"
  | "phase_transition"
  | "artifact_write"
  | "state_loaded"
  | "decision_logged"
  | "halt"
  | "mission_initialized"
  | "ping"
  | "session_tool_start"
  | "session_tool_end"
  | "session_agent_event"
  | "validation_recovery"
  | "integration_preflight";

export interface RatelEvent {
  timestamp: string;            // ISO 8601
  event_type: EventType;
  trace_id: string;             // mission ID (reuse from state.json or generate once)
  span_id: string;              // unique per event
  parent_span_id?: string;      // for subagent nesting
  agent_level?: AgentLevel;
  data: Record<string, unknown>;
}

interface EventLoggerOptions {
  missionDir: string;
  traceId?: string;
  flushIntervalMs?: number;
}

export class EventLogger {
  private buffer: RatelEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval>;
  private filePath: string;
  private traceId: string;
  private parentSpanStack: string[] = [];
  private flushIntervalMs: number;
  private flushing = false;

  constructor(options: EventLoggerOptions) {
    this.filePath = join(options.missionDir, "events.jsonl");
    this.traceId = options.traceId ?? randomUUID();
    this.flushIntervalMs = options.flushIntervalMs ?? 100;
    // Wrap flush in a catch so any unhandled error from the timer cannot
    // crash the process. flush() itself is fail-soft, but this is a belt-and-
    // suspenders defense against future regressions.
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error("[EventLogger] timer-fired flush rejected:", err);
      });
    }, this.flushIntervalMs);
  }

  /** Create a logger for the current mission. Reads trace_id from state.json if present. */
  static async forMission(cwd: string): Promise<EventLogger> {
    const missionDir = join(cwd, ".missions", "current");
    await mkdir(missionDir, { recursive: true });

    // Try to read existing trace_id from state.json
    let traceId: string | undefined;
    try {
      const { readFile } = await import("node:fs/promises");
      const stateRaw = await readFile(join(missionDir, "state.json"), "utf-8");
      const state = JSON.parse(stateRaw) as { traceId?: string };
      traceId = state.traceId;
    } catch {
      /* state.json may not exist yet */
    }

    const logger = new EventLogger({ missionDir, traceId });

    // If we generated a new traceId, persist it to state.json
    if (!traceId) {
      try {
        const { readFile, writeFile } = await import("node:fs/promises");
        const statePath = join(missionDir, "state.json");
        let state: Record<string, unknown> = {};
        try {
          state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
        } catch {
          /* no state yet */
        }
        state.traceId = logger.traceId;
        await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
      } catch {
        /* ignore write failures */
      }
    }

    return logger;
  }

  /** Push a new span onto the parent stack. Subsequent events will have this as parent_span_id. */
  pushParentSpan(spanId: string): void {
    this.parentSpanStack.push(spanId);
  }

  /** Pop the most recent parent span. */
  popParentSpan(): void {
    this.parentSpanStack.pop();
  }

  private emit(eventType: EventType, data: Record<string, unknown>, agentLevel?: AgentLevel, options?: { spanId?: string; parentSpanId?: string }): void {
    const event: RatelEvent = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      trace_id: this.traceId,
      span_id: options?.spanId ?? randomUUID(),
      parent_span_id: options && "parentSpanId" in options
        ? options.parentSpanId
        : (this.parentSpanStack.length > 0 ? this.parentSpanStack[this.parentSpanStack.length - 1] : undefined),
      agent_level: agentLevel,
      data,
    };
    this.buffer.push(event);
  }

  /**
   * Log an agent starting (worker, validator, research, etc.) using an explicit
   * span. This does not mutate the parent stack, so it is safe for parallel
   * child agents and read-only review fan-out.
   */
  agentSpanStart(
    level: AgentLevel,
    data: { agentType: string; model?: string; skills?: string[]; tools?: string[]; featureId?: string; milestoneId?: string; shardId?: string },
    parentSpanId?: string,
  ): string {
    const spanId = randomUUID();
    this.emit("agent_start", data, level, { spanId, parentSpanId });
    return spanId;
  }

  /** End an explicitly started agent span. */
  agentSpanEnd(
    level: AgentLevel,
    spanId: string,
    data: { parseStatus?: "ok" | "failed"; durationMs?: number; error?: string; featureId?: string; milestoneId?: string; shardId?: string },
    parentSpanId?: string,
  ): void {
    this.emit("agent_end", data, level, { spanId, parentSpanId });
  }

  /** Log an agent starting and push it onto the legacy parent stack. */
  agentStart(level: AgentLevel, data: { agentType: string; model?: string; skills?: string[]; tools?: string[]; featureId?: string; milestoneId?: string }): string {
    const spanId = this.agentSpanStart(level, data, this.parentSpanStack[this.parentSpanStack.length - 1]);
    this.pushParentSpan(spanId);
    return spanId;
  }

  /** Log an agent ending. Shares the same span_id as the corresponding agent_start. */
  agentEnd(level: AgentLevel, data: { parseStatus?: "ok" | "failed"; durationMs?: number; error?: string; featureId?: string; milestoneId?: string }): void {
    const spanId = this.parentSpanStack[this.parentSpanStack.length - 1] ?? randomUUID();
    this.popParentSpan();
    this.agentSpanEnd(level, spanId, data, this.parentSpanStack[this.parentSpanStack.length - 1]);
  }

  /** Log a tool being called by the orchestrator. */
  toolCall(toolName: string, params: Record<string, unknown>): void {
    this.emit("tool_call", { toolName, params }, "orchestrator");
  }

  /** Log a tool result returned to the orchestrator. */
  toolResult(toolName: string, result: { parseStatus?: "ok" | "failed"; durationMs?: number; error?: string; rawFilename?: string; [key: string]: unknown }): void {
    this.emit("tool_result", { toolName, ...result }, "orchestrator");
  }

  /** Log a phase transition. */
  phaseTransition(from: string, to: string, reason?: string): void {
    this.emit("phase_transition", { from, to, reason });
  }

  /** Log an artifact being written. */
  artifactWrite(artifactName: string, mode: "overwrite" | "append", byteCount: number): void {
    this.emit("artifact_write", { artifactName, mode, byteCount });
  }

  /** Log mission state being loaded. */
  stateLoaded(state: { phase: string; version: number; featureCount?: number; milestoneCount?: number }): void {
    this.emit("state_loaded", state);
  }

  /** Log a decision being recorded. */
  decisionLogged(decisionId: string, context: string, decision: string, rationale: string): void {
    this.emit("decision_logged", { decisionId, context, decision, rationale });
  }

  /** Log a mission halt. */
  halt(reason: string, resumeHint?: string): void {
    this.emit("halt", { reason, resumeHint });
  }

  /** Log mission initialization. */
  missionInitialized(goal?: string): void {
    this.emit("mission_initialized", { goal });
  }

  /** Log a subagent ping result (used by ping_agents tool). */
  ping(agentName: string, status: "ok" | "failed" | "timeout", durationMs: number, error?: string): void {
    this.emit("ping", { agentName, status, durationMs, error });
  }

  /** Log a tool starting inside a child AgentSession. */
  sessionToolStart(level: AgentLevel, parentSpanId: string, data: { toolName: string; toolCallId?: string; [key: string]: unknown }): void {
    this.emit("session_tool_start", data, level, { parentSpanId });
  }

  /** Log a tool ending inside a child AgentSession. */
  sessionToolEnd(level: AgentLevel, parentSpanId: string, data: { toolName: string; toolCallId?: string; isError?: boolean; durationMs?: number; [key: string]: unknown }): void {
    this.emit("session_tool_end", data, level, { parentSpanId });
  }

  /** Log other notable child AgentSession lifecycle events. */
  sessionAgentEvent(level: AgentLevel, parentSpanId: string, data: { sessionEventType: string; [key: string]: unknown }): void {
    this.emit("session_agent_event", data, level, { parentSpanId });
  }

  /** Log that parsed validation findings require same-milestone recovery work. */
  validationRecovery(data: { milestoneId: string; blockingIssueIds: string[]; fixFeatureCount: number; rawFilename?: string }): void {
    this.emit("validation_recovery", data);
  }

  /** Log whether completed feature commits are present on the integration branch before validation. */
  integrationPreflight(data: { milestoneId: string; status: string; branch: string; repoPath?: string; missingFeatureIds?: string[]; checkedFeatureCount?: number }): void {
    this.emit("integration_preflight", data);
  }

  /**
   * Flush buffered events to disk.
   *
   * FAIL-SOFT: Event logging must never crash the factory. If the directory
   * was deleted between flushes, or any I/O error occurs, we:
   * 1. Re-create the parent directory (idempotent)
   * 2. Catch any remaining errors and log them
   * 3. Preserve buffered events on failure (don't lose data)
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      // Snapshot buffer first so new events can accumulate while we write
      const toWrite = this.buffer;
      const lines = toWrite.map((e) => JSON.stringify(e)).join("\n") + "\n";

      // Ensure parent directory exists (it may have been deleted between flushes).
      // mkdir({ recursive: true }) is idempotent and safe to call on every flush.
      await mkdir(dirname(this.filePath), { recursive: true });

      await appendFile(this.filePath, lines, "utf-8");

      // Only clear the events we actually wrote (preserve any added during write)
      this.buffer = this.buffer.slice(toWrite.length);
    } catch (err) {
      // CRITICAL: Do not throw. Event logging is best-effort observability.
      // If the disk is full, the directory is locked, or any other I/O error
      // occurs, the factory must continue running. Log to stderr so the user
      // can see the issue but the mission is not aborted.
      console.error(
        `[EventLogger] flush failed (${this.buffer.length} events retained):`,
        err instanceof Error ? err.message : err
      );
    } finally {
      this.flushing = false;
    }
  }

  /** Flush remaining events and stop the timer. Call before process exit. */
  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}

/** Global logger instance — set once per mission. */
let _globalLogger: EventLogger | undefined;

export function setGlobalLogger(logger: EventLogger): void {
  _globalLogger = logger;
}

export function getGlobalLogger(): EventLogger | undefined {
  return _globalLogger;
}

export function clearGlobalLogger(): void {
  _globalLogger = undefined;
}
