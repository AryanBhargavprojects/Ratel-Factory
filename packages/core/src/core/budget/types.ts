import { createHash } from "node:crypto";
import type { AgentLevel } from "../observability/event-logger.js";

export interface MissionBudgetLimits {
  maxCostUsd: number | null;
  maxTotalTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxWallClockMinutes: number | null;
  maxAgentRuns: number | null;
  maxModelAttemptsPerRun: number;
}

export interface UsageRecord {
  recordId: string;
  missionId: string;
  sessionId: string;
  role: AgentLevel;
  provider: string;
  model: string;
  timestamp: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  stopReason: string;
}

export interface MissionBudgetState {
  limits: MissionBudgetLimits;
  startedAt: string;
  updatedAt: string;
  agentRuns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  byRole: Record<string, { agentRuns: number; totalTokens: number; costUsd: number }>;
  exhausted?: { reason: string; at: string };
}

export class BudgetExceededError extends Error {
  constructor(
    public metric: string,
    public limit: number,
    public actual: number,
    public missionId: string,
  ) {
    super(`Mission ${missionId} budget exceeded: ${metric} (${actual} > ${limit})`);
    this.name = "BudgetExceededError";
  }
}

/** Default budget limits used when no project-level or mission-level overrides are provided. */
export const DEFAULT_BUDGET_LIMITS: MissionBudgetLimits = {
  maxCostUsd: 50,
  maxTotalTokens: 5_000_000,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxWallClockMinutes: 480,
  maxAgentRuns: 200,
  maxModelAttemptsPerRun: 3,
};

/**
 * Compute a stable record ID from session metadata.
 * Format: sha256(sessionId + ":" + timestamp + ":" + provider + ":" + model)
 */
export function computeRecordId(sessionId: string, timestamp: string, provider: string, model: string): string {
  const hash = createHash("sha256");
  hash.update(`${sessionId}:${timestamp}:${provider}:${model}`);
  return hash.digest("hex");
}

/** Validate and merge mission request limits over project defaults. Rejects negative or non-finite values. */
export function resolveBudgetLimits(
  projectDefaults: Partial<MissionBudgetLimits>,
  missionOverrides: Partial<MissionBudgetLimits>,
): MissionBudgetLimits {
  const sources = [DEFAULT_BUDGET_LIMITS, projectDefaults, missionOverrides];
  const resolved = { ...DEFAULT_BUDGET_LIMITS };

  for (const source of sources) {
    for (const _key of Object.keys(source)) {
      const key = _key as keyof MissionBudgetLimits;
      const val = source[key];
      if (val === undefined) continue;
      if (typeof val === "number") {
        if (!Number.isFinite(val) || val < 0) {
          throw new Error(`Invalid budget limit for ${key}: must be a non-negative finite number, got ${val}`);
        }
        (resolved as Record<string, unknown>)[key] = val;
      } else if (val === null) {
        (resolved as Record<string, unknown>)[key] = null;
      }
    }
  }

  return resolved;
}
