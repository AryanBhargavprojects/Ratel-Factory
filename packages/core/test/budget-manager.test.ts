import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetManager } from "../src/core/budget/budget-manager.js";
import { BudgetExceededError } from "../src/core/budget/types.js";
import type { MissionBudgetLimits, MissionBudgetState } from "../src/core/budget/types.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";

describe("BudgetManager", () => {
  async function setupScope() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-budget-"));
    const scope = createMissionScope(projectRoot, "mis_budget_001");
    await mkdir(getMissionDir(scope), { recursive: true });
    return { projectRoot, scope };
  }

  it("initializes with correct default limits", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const state = await mgr.initialize(defaultLimits());
    assert.strictEqual(state.limits.maxCostUsd, 50);
    assert.strictEqual(state.limits.maxTotalTokens, 5_000_000);
    assert.strictEqual(state.limits.maxWallClockMinutes, 480);
    assert.strictEqual(state.limits.maxAgentRuns, 200);
    assert.strictEqual(state.limits.maxModelAttemptsPerRun, 3);
    assert.strictEqual(state.agentRuns, 0);
    assert.strictEqual(state.costUsd, 0);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("persists resolved snapshot to budget.json", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    const raw = await readFile(join(getMissionDir(scope), "budget.json"), "utf-8");
    const parsed = JSON.parse(raw) as MissionBudgetState;
    assert.strictEqual(parsed.limits.maxCostUsd, 50);
    assert.ok(parsed.startedAt);
    assert.ok(parsed.updatedAt);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("assertCanStart allows when within limits", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    await assert.doesNotReject(async () => mgr.assertCanStart("orchestrator"));
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("assertCanStart throws BudgetExceededError when cost exceeded", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxCostUsd: 1 };
    await mgr.initialize(limits);
    await mgr.recordUsage(makeRecord({ costUsd: 0.5 }));
    await mgr.recordUsage(makeRecord({ costUsd: 0.5 }));
    await assert.rejects(
      async () => mgr.assertCanStart("orchestrator"),
      (err: unknown) => err instanceof BudgetExceededError && (err as BudgetExceededError).metric === "costUsd"
    );
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("assertCanStart throws BudgetExceededError when tokens exceeded", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxTotalTokens: 100 };
    await mgr.initialize(limits);
    await mgr.recordUsage(makeRecord({ totalTokens: 60 }));
    await mgr.recordUsage(makeRecord({ totalTokens: 40 }));
    await assert.rejects(
      async () => mgr.assertCanStart("orchestrator"),
      (err: unknown) => err instanceof BudgetExceededError && (err as BudgetExceededError).metric === "totalTokens"
    );
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("assertCanStart throws BudgetExceededError when agentRuns exceeded", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxAgentRuns: 2 };
    await mgr.initialize(limits);
    await mgr.recordAgentStart("orchestrator");
    await mgr.recordAgentStart("worker");
    await mgr.recordAgentStart("worker");
    await assert.rejects(
      async () => mgr.assertCanStart("orchestrator"),
      (err: unknown) => err instanceof BudgetExceededError && (err as BudgetExceededError).metric === "agentRuns"
    );
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("wall-clock limit blocks assertCanStart", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxWallClockMinutes: 0.001 };
    await mgr.initialize(limits);
    // Wait briefly so wall-clock exceeds 0.001 minutes (0.06 seconds)
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(
      async () => mgr.assertCanStart("orchestrator"),
      (err: unknown) => err instanceof BudgetExceededError && (err as BudgetExceededError).metric === "wallClockMinutes"
    );
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("createWallClockAbortSignal aborts when wall-clock exceeded", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxWallClockMinutes: 0.001 };
    await mgr.initialize(limits);
    const signal = mgr.createWallClockAbortSignal();
    assert.strictEqual(signal.aborted, false);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(signal.aborted, true);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("recordAgentStart increments agentRuns and byRole", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    await mgr.recordAgentStart("worker");
    const state = await mgr.getState();
    assert.strictEqual(state.agentRuns, 1);
    assert.strictEqual(state.byRole["worker"].agentRuns, 1);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("recordUsage aggregates totals and per-role", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    await mgr.recordUsage(makeRecord({ role: "worker", input: 10, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 37, costUsd: 0.01 }));
    await mgr.recordUsage(makeRecord({ role: "worker", input: 5, output: 5, totalTokens: 10, costUsd: 0.005 }));
    const state = await mgr.getState();
    assert.strictEqual(state.input, 15);
    assert.strictEqual(state.output, 25);
    assert.strictEqual(state.cacheRead, 5);
    assert.strictEqual(state.cacheWrite, 2);
    assert.strictEqual(state.totalTokens, 47);
    assert.strictEqual(state.costUsd, 0.015);
    assert.strictEqual(state.byRole["worker"].totalTokens, 47);
    assert.strictEqual(state.byRole["worker"].costUsd, 0.015);
    assert.strictEqual(state.byRole["worker"].agentRuns, 0);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("recording same assistant message twice is idempotent", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    const rec = makeRecord({ totalTokens: 100, costUsd: 0.01 });
    await mgr.recordUsage(rec);
    await mgr.recordUsage(rec);
    const state = await mgr.getState();
    assert.strictEqual(state.totalTokens, 100);
    assert.strictEqual(state.costUsd, 0.01);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("deduplicates record IDs after restart by reading usage.jsonl", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr1 = new BudgetManager(scope);
    await mgr1.initialize(defaultLimits());
    const rec = makeRecord({ totalTokens: 200, costUsd: 0.02 });
    await mgr1.recordUsage(rec);
    await mgr1.recordUsage(rec);

    // Simulate restart: new BudgetManager instance
    const mgr2 = new BudgetManager(scope);
    await mgr2.initialize(defaultLimits());
    // Same record ID should be skipped
    await mgr2.recordUsage(rec);
    const state = await mgr2.getState();
    assert.strictEqual(state.totalTokens, 200);
    assert.strictEqual(state.costUsd, 0.02);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("remaining reflects used budget", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    await mgr.recordUsage(makeRecord({ totalTokens: 1_000_000, costUsd: 20 }));
    await mgr.recordAgentStart("orchestrator");
    const rem = await mgr.remaining();
    assert.strictEqual(rem.costUsd, 30);
    assert.strictEqual(rem.totalTokens, 4_000_000);
    assert.strictEqual(rem.agentRuns, 199);
    assert.ok(typeof rem.wallClockMs === "number");
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("exhausted flag is set on budget exceeded", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxCostUsd: 0.5 };
    await mgr.initialize(limits);
    try {
      await mgr.recordUsage(makeRecord({ costUsd: 1 }));
      assert.fail("expected BudgetExceededError");
    } catch {
      /* expected */
    }
    const state = await mgr.getState();
    assert.ok(state.exhausted);
    assert.strictEqual(state.exhausted?.reason, "costUsd");
    assert.ok(state.exhausted.at);
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("appends usage records to usage.jsonl", async () => {
    const { projectRoot, scope } = await setupScope();
    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());
    await mgr.recordUsage(makeRecord({ totalTokens: 50 }));
    await mgr.recordUsage(makeRecord({ totalTokens: 100 }));
    const raw = await readFile(join(getMissionDir(scope), "usage.jsonl"), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 2);
    await rm(projectRoot, { recursive: true, force: true });
  });
});

function defaultLimits(): MissionBudgetLimits {
  return {
    maxCostUsd: 50,
    maxTotalTokens: 5_000_000,
    maxInputTokens: null,
    maxOutputTokens: null,
    maxWallClockMinutes: 480,
    maxAgentRuns: 200,
    maxModelAttemptsPerRun: 3,
  };
}

function makeRecord(overrides: Partial<import("../src/core/budget/types.js").UsageRecord> = {}): import("../src/core/budget/types.js").UsageRecord {
  const now = new Date().toISOString();
  const sessionId = "sess_001";
  const provider = "test-provider";
  const model = "test-model";
  const timestamp = overrides.timestamp ?? now;
  const recordId = overrides.recordId ?? `sha256-${sessionId}:${timestamp}:${provider}:${model}:${Math.random().toString(36).slice(2)}`;
  return {
    recordId,
    missionId: "mis_budget_001",
    sessionId,
    role: "orchestrator",
    provider,
    model,
    timestamp,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    stopReason: "end_turn",
    ...overrides,
  };
}
