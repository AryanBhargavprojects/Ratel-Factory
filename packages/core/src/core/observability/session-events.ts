import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentLevel, EventLogger } from "./event-logger.js";

export interface ForwardAgentSessionEventOptions {
  logger: EventLogger;
  agentLevel: AgentLevel;
  parentSpanId: string;
  event: unknown;
  toolStartTimes?: Map<string, number>;
}

export interface ObserveAgentSessionOptions {
  logger: EventLogger | undefined;
  agentLevel: AgentLevel;
  parentSpanId: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function eventType(event: unknown): string | undefined {
  const record = asRecord(event);
  return typeof record?.type === "string" ? record.type : undefined;
}

function toolName(event: Record<string, unknown>): string {
  return typeof event.toolName === "string" ? event.toolName : "unknown_tool";
}

function toolCallId(event: Record<string, unknown>): string | undefined {
  return typeof event.toolCallId === "string" ? event.toolCallId : undefined;
}

function toolKey(event: Record<string, unknown>): string {
  return toolCallId(event) ?? toolName(event);
}

/**
 * Forward a single Pi AgentSession event into Ratel's mission event log. This
 * is intentionally lossy: it records lifecycle/tool metadata needed for nested
 * observability without dumping model text deltas or large payloads into JSONL.
 */
export function forwardAgentSessionEvent(options: ForwardAgentSessionEventOptions): void {
  const { logger, agentLevel, parentSpanId, event } = options;
  const record = asRecord(event);
  if (!record) return;

  const type = eventType(record);
  const startTimes = options.toolStartTimes;

  if (type === "tool_execution_start") {
    const key = toolKey(record);
    startTimes?.set(key, Date.now());
    logger.sessionToolStart(agentLevel, parentSpanId, {
      toolName: toolName(record),
      toolCallId: toolCallId(record),
    });
    return;
  }

  if (type === "tool_execution_end") {
    const key = toolKey(record);
    const startedAt = startTimes?.get(key);
    if (startedAt !== undefined) startTimes?.delete(key);
    logger.sessionToolEnd(agentLevel, parentSpanId, {
      toolName: toolName(record),
      toolCallId: toolCallId(record),
      isError: typeof record.isError === "boolean" ? record.isError : undefined,
      durationMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
    });
    return;
  }

  if (type === "agent_start" || type === "agent_end") {
    logger.sessionAgentEvent(agentLevel, parentSpanId, { sessionEventType: type });
    return;
  }

  if (type === "compaction_start" || type === "compaction_end") {
    logger.sessionAgentEvent(agentLevel, parentSpanId, {
      sessionEventType: type,
      reason: typeof record.reason === "string" ? record.reason : undefined,
      aborted: typeof record.aborted === "boolean" ? record.aborted : undefined,
      willRetry: typeof record.willRetry === "boolean" ? record.willRetry : undefined,
      errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : undefined,
    });
  }
}

/** Subscribe to a child AgentSession and forward nested tool/lifecycle events. */
export function observeAgentSession(
  session: AgentSession,
  options: ObserveAgentSessionOptions,
): () => void {
  const { logger, agentLevel, parentSpanId } = options;
  if (!logger || !parentSpanId) return () => undefined;

  const toolStartTimes = new Map<string, number>();
  return session.subscribe((event) => {
    forwardAgentSessionEvent({
      logger,
      agentLevel,
      parentSpanId,
      event,
      toolStartTimes,
    });
  });
}
