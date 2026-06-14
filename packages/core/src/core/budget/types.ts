export interface MissionBudgetLimits {
  maxCostUsd: number | null;
  maxTotalTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxWallClockMinutes: number | null;
  maxAgentRuns: number | null;
  maxModelAttemptsPerRun: number;
}
