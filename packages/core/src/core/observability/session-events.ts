import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentLevel, EventLogger } from "./event-logger.js";
import { computeRecordId } from "../budget/types.js";
import type { UsageRecord } from "../budget/types.js";

export interface ForwardAgentSessionEventOptions {
  logger: EventLogger;
  agentLevel: AgentLevel;
  parentSpanId: string;
  event: unknown;
  toolStartTimes?: Map<string, number>;
  budgetManager?: import("../budget/budget-manager.js").BudgetManager;
}

export interface ObserveAgentSessionOptions {
  logger: EventLogger | undefined;
  agentLevel: AgentLevel;
  parentSpanId: string | undefined;
  budgetManager?: import("../budget/budget-manager.js").BudgetManager;
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

/**
 * Extract a UsageRecord from a Pi SDK turn_end event.
 * Only records when message.role === "assistant" and usage is present.
 * Returns null for non-assistant turns or missing usage.
 */
export function extractUsageFromTurnEnd(
  event: unknown,
  role: AgentLevel,
  missionId: string,
): UsageRecord | null {
  const record = asRecord(event);
  if (!record) return null;
  if (eventType(record) !== "turn_end") return null;

  const message = asRecord(record.message);
  if (!message) return null;
  if (message.role !== "assistant") return null;

  const usage = asRecord(message.usage);
  if (!usage) return null;

  const provider = typeof record.provider === "string" ? record.provider : "";
  const model = typeof record.model === "string" ? record.model : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
  const stopReason = typeof usage.stopReason === "string" ? usage.stopReason : "end_turn";

  const totalTokens =
    typeof usage.totalTokens === "number"
      ? usage.totalTokens
      : (typeof usage.inputTokens === "number" ? usage.inputTokens : 0) +
        (typeof usage.outputTokens === "number" ? usage.outputTokens : 0);

  const rec: UsageRecord = {
    recordId: computeRecordId(sessionId, timestamp, provider, model),
    missionId,
    sessionId,
    role,
    provider,
    model,
    timestamp,
    input: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
    output: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    cacheRead: typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
    cacheWrite: typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0,
    totalTokens,
    costUsd: typeof usage.costUsd === "number" ? usage.costUsd : 0,
    stopReason,
  };

  return rec;
}

/** Subscribe to a child AgentSession and forward nested tool/lifecycle events. */
export function observeAgentSession(
  session: AgentSession,
  options: ObserveAgentSessionOptions,
): () => void {
  const { logger, agentLevel, parentSpanId, budgetManager } = options;
  if (!logger || !parentSpanId) return () => undefined;

  const toolStartTimes = new Map<string, number>();
  return session.subscribe((event) => {
    forwardAgentSessionEvent({
      logger,
      agentLevel,
      parentSpanId,
      event,
      toolStartTimes,
      budgetManager,
    });

    // Record usage on turn_end for assistant messages only
    if (budgetManager) {
      try {
        const usageRecord = extractUsageFromTurnEnd(event, agentLevel, budgetManager["scope"].missionId);
        if (usageRecord) {
          budgetManager.recordUsage(usageRecord).catch(() => {
            // Fail-soft: usage recording errors should not crash the agent session
          });
        }
      } catch {
        // ignore extraction errors
      }
    }
  });
}
