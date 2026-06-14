import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MissionScope } from "../mission/scope.js";
import { getMissionDir } from "../mission/scope.js";
import type {
  MissionBudgetLimits,
  MissionBudgetState,
  UsageRecord,
} from "./types.js";
import { BudgetExceededError } from "./types.js";
import type { AgentLevel } from "../observability/event-logger.js";

/**
 * BudgetManager enforces durable mission budgets.
 *
 * - Persisted state in budget.json (atomic overwrite)
 * - Append-only usage records in usage.jsonl
 * - Idempotent deduplication via recordId hash set
 * - Wall-clock budget enforced via AbortSignal
 */
export class BudgetManager {
  private state!: MissionBudgetState;
  private recordIds = new Set<string>();
  private usagePath: string;
  private budgetPath: string;
  private exhausted = false;

  constructor(public readonly scope: MissionScope) {
    const dir = getMissionDir(scope);
    this.usagePath = join(dir, "usage.jsonl");
    this.budgetPath = join(dir, "budget.json");
  }

  /** Initialize (or rehydrate) budget state for the mission. */
  async initialize(limits: MissionBudgetLimits): Promise<MissionBudgetState> {
    // Rebuild record ID set from existing usage.jsonl for idempotency across restarts
    await this.rebuildRecordIds();

    // Try to load existing budget.json to preserve aggregates across restarts
    const existing = await this.loadExistingState();
    if (existing) {
      this.state = { ...existing, limits };
      if (existing.exhausted) {
        this.exhausted = true;
      }
      await this.persistState();
      return this.state;
    }

    const now = new Date().toISOString();
    this.state = {
      limits,
      startedAt: now,
      updatedAt: now,
      agentRuns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
      byRole: {},
    };

    await this.persistState();
    return this.state;
  }

  /** Get current budget state. */
  async getState(): Promise<MissionBudgetState> {
    return this.state;
  }

  /** Assert that a new agent run can start under current limits. Throws BudgetExceededError if any limit exceeded. */
  async assertCanStart(role: AgentLevel): Promise<void> {
    if (this.exhausted) {
      const reason = this.state.exhausted?.reason ?? "budget";
      throw new BudgetExceededError(reason, 0, 0, this.scope.missionId);
    }

    const elapsedMinutes = (Date.now() - new Date(this.state.startedAt).getTime()) / 1000 / 60;

    if (this.state.limits.maxAgentRuns !== null && this.state.agentRuns >= this.state.limits.maxAgentRuns) {
      throw new BudgetExceededError("agentRuns", this.state.limits.maxAgentRuns, this.state.agentRuns, this.scope.missionId);
    }

    if (this.state.limits.maxWallClockMinutes !== null && elapsedMinutes >= this.state.limits.maxWallClockMinutes) {
      throw new BudgetExceededError("wallClockMinutes", this.state.limits.maxWallClockMinutes, elapsedMinutes, this.scope.missionId);
    }

    if (this.state.limits.maxTotalTokens !== null && this.state.totalTokens >= this.state.limits.maxTotalTokens) {
      throw new BudgetExceededError("totalTokens", this.state.limits.maxTotalTokens, this.state.totalTokens, this.scope.missionId);
    }

    if (this.state.limits.maxCostUsd !== null && this.state.costUsd >= this.state.limits.maxCostUsd) {
      throw new BudgetExceededError("costUsd", this.state.limits.maxCostUsd, this.state.costUsd, this.scope.missionId);
    }

    // maxInputTokens / maxOutputTokens checked on a per-usage basis in recordUsage
  }

  /** Record the start of an agent run. Increments agentRuns and byRole. */
  async recordAgentStart(role: AgentLevel): Promise<void> {
    this.state.agentRuns += 1;
    const roleKey = role as string;
    if (!this.state.byRole[roleKey]) {
      this.state.byRole[roleKey] = { agentRuns: 0, totalTokens: 0, costUsd: 0 };
    }
    this.state.byRole[roleKey].agentRuns += 1;
    this.state.updatedAt = new Date().toISOString();
    await this.persistState();
  }

  /** Record a usage record. Idempotent by recordId. Returns updated state. */
  async recordUsage(record: UsageRecord): Promise<MissionBudgetState> {
    if (this.recordIds.has(record.recordId)) {
      return this.state; // idempotent
    }

    this.recordIds.add(record.recordId);

    // Append to usage.jsonl
    const line = JSON.stringify(record) + "\n";
    await mkdir(getMissionDir(this.scope), { recursive: true });
    await appendFile(this.usagePath, line, "utf-8");

    // Update aggregates
    this.state.input += record.input;
    this.state.output += record.output;
    this.state.cacheRead += record.cacheRead;
    this.state.cacheWrite += record.cacheWrite;
    this.state.totalTokens += record.totalTokens;
    this.state.costUsd += record.costUsd;

    const roleKey = record.role as string;
    if (!this.state.byRole[roleKey]) {
      this.state.byRole[roleKey] = { agentRuns: 0, totalTokens: 0, costUsd: 0 };
    }
    this.state.byRole[roleKey].totalTokens += record.totalTokens;
    this.state.byRole[roleKey].costUsd += record.costUsd;

    this.state.updatedAt = new Date().toISOString();

    // Check input/output per-call limits
    if (this.state.limits.maxInputTokens !== null && this.state.input >= this.state.limits.maxInputTokens) {
      await this.setExhausted("maxInputTokens", this.state.limits.maxInputTokens, this.state.input);
      await this.persistState();
      return this.state;
    }
    if (this.state.limits.maxOutputTokens !== null && this.state.output >= this.state.limits.maxOutputTokens) {
      await this.setExhausted("maxOutputTokens", this.state.limits.maxOutputTokens, this.state.output);
      await this.persistState();
      return this.state;
    }

    // Check total/cost limits after update
    if (this.state.limits.maxTotalTokens !== null && this.state.totalTokens >= this.state.limits.maxTotalTokens) {
      await this.setExhausted("totalTokens", this.state.limits.maxTotalTokens, this.state.totalTokens);
      await this.persistState();
      return this.state;
    }
    if (this.state.limits.maxCostUsd !== null && this.state.costUsd >= this.state.limits.maxCostUsd) {
      await this.setExhausted("costUsd", this.state.limits.maxCostUsd, this.state.costUsd);
      await this.persistState();
      return this.state;
    }

    await this.persistState();
    return this.state;
  }

  /** Calculate remaining budget headroom. */
  async remaining(): Promise<{
    costUsd: number | null;
    totalTokens: number | null;
    wallClockMs: number | null;
    agentRuns: number | null;
  }> {
    const elapsedMs = Date.now() - new Date(this.state.startedAt).getTime();
    const wallClockMs = this.state.limits.maxWallClockMinutes !== null
      ? Math.max(0, this.state.limits.maxWallClockMinutes * 60 * 1000 - elapsedMs)
      : null;

    return {
      costUsd: this.state.limits.maxCostUsd !== null ? Math.max(0, this.state.limits.maxCostUsd - this.state.costUsd) : null,
      totalTokens: this.state.limits.maxTotalTokens !== null ? Math.max(0, this.state.limits.maxTotalTokens - this.state.totalTokens) : null,
      wallClockMs,
      agentRuns: this.state.limits.maxAgentRuns !== null ? Math.max(0, this.state.limits.maxAgentRuns - this.state.agentRuns) : null,
    };
  }

  /**
   * Create an AbortSignal that aborts when the wall-clock budget is exhausted.
   * If a parent signal is provided, the returned signal also aborts when the parent does.
   */
  createWallClockAbortSignal(parent?: AbortSignal): AbortSignal {
    const controller = new AbortController();

    if (parent) {
      if (parent.aborted) {
        controller.abort();
        return controller.signal;
      }
      parent.addEventListener("abort", () => controller.abort(), { once: true });
    }

    if (this.state.limits.maxWallClockMinutes === null) {
      return controller.signal;
    }

    const maxMs = this.state.limits.maxWallClockMinutes * 60 * 1000;
    const elapsedMs = Date.now() - new Date(this.state.startedAt).getTime();
    const remainingMs = Math.max(0, maxMs - elapsedMs);

    if (remainingMs <= 0) {
      controller.abort();
      return controller.signal;
    }

    const timer = setTimeout(() => {
      controller.abort();
    }, remainingMs);

    // Clean up timer if signal is aborted externally before timeout
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

    return controller.signal;
  }

  private async loadExistingState(): Promise<MissionBudgetState | undefined> {
    try {
      const raw = await readFile(this.budgetPath, "utf-8");
      const parsed = JSON.parse(raw) as MissionBudgetState;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(getMissionDir(this.scope), { recursive: true });
    await writeFile(this.budgetPath, JSON.stringify(this.state, null, 2) + "\n", "utf-8");
  }

  private async rebuildRecordIds(): Promise<void> {
    try {
      const raw = await readFile(this.usagePath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as { recordId: string };
          if (record.recordId) this.recordIds.add(record.recordId);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // usage.jsonl may not exist yet
    }
  }

  private async setExhausted(metric: string, limit: number, actual: number): Promise<void> {
    this.exhausted = true;
    this.state.exhausted = { reason: metric, at: new Date().toISOString() };
    this.state.updatedAt = this.state.exhausted.at;
  }

  private async markExhausted(metric: string, limit: number, actual: number): Promise<void> {
    await this.setExhausted(metric, limit, actual);
    await this.persistState();
    throw new BudgetExceededError(metric, limit, actual, this.scope.missionId);
  }
}
