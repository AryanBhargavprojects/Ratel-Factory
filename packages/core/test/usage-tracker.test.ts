import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetManager } from "../src/core/budget/budget-manager.js";
import { extractUsageFromTurnEnd } from "../src/core/observability/session-events.js";
import type { MissionBudgetLimits } from "../src/core/budget/types.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";

describe("usage tracker", () => {
  it("extracts usage from turn_end event with assistant message", () => {
    const event = {
      type: "turn_end",
      message: {
        role: "assistant",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          totalTokens: 165,
          costUsd: 0.0025,
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4",
      sessionId: "sess_abc",
      timestamp: "2026-06-14T12:00:00Z",
    };

    const record = extractUsageFromTurnEnd(event, "worker", "mis_001");
    assert.ok(record);
    assert.strictEqual(record!.input, 100);
    assert.strictEqual(record!.output, 50);
    assert.strictEqual(record!.cacheRead, 10);
    assert.strictEqual(record!.cacheWrite, 5);
    assert.strictEqual(record!.totalTokens, 165);
    assert.strictEqual(record!.costUsd, 0.0025);
    assert.strictEqual(record!.provider, "anthropic");
    assert.strictEqual(record!.model, "claude-sonnet-4");
    assert.strictEqual(record!.role, "worker");
    assert.strictEqual(record!.missionId, "mis_001");
    assert.strictEqual(record!.stopReason, "end_turn");
    assert.ok(record!.recordId);
    assert.ok(record!.timestamp);
  });

  it("returns null for non-assistant turn_end", () => {
    const event = {
      type: "turn_end",
      message: { role: "user", usage: { totalTokens: 10 } },
    };
    const record = extractUsageFromTurnEnd(event, "orchestrator", "mis_001");
    assert.strictEqual(record, null);
  });

  it("returns null for missing usage block", () => {
    const event = {
      type: "turn_end",
      message: { role: "assistant" },
    };
    const record = extractUsageFromTurnEnd(event, "orchestrator", "mis_001");
    assert.strictEqual(record, null);
  });

  it("aggregates all Pi usage fields correctly through BudgetManager", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-usage-"));
    const scope = createMissionScope(projectRoot, "mis_usage_001");
    await mkdir(getMissionDir(scope), { recursive: true });

    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());

    await mgr.recordUsage(makeUsageRecord({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, costUsd: 0.01 }));
    await mgr.recordUsage(makeUsageRecord({ input: 200, output: 100, cacheRead: 20, cacheWrite: 10, totalTokens: 330, costUsd: 0.02 }));

    const state = await mgr.getState();
    assert.strictEqual(state.input, 300);
    assert.strictEqual(state.output, 150);
    assert.strictEqual(state.cacheRead, 30);
    assert.strictEqual(state.cacheWrite, 15);
    assert.strictEqual(state.totalTokens, 495);
    assert.strictEqual(state.costUsd, 0.03);

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("per-role totals aggregate correctly", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-usage-role-"));
    const scope = createMissionScope(projectRoot, "mis_usage_002");
    await mkdir(getMissionDir(scope), { recursive: true });

    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());

    await mgr.recordUsage(makeUsageRecord({ role: "orchestrator", totalTokens: 100, costUsd: 0.01 }));
    await mgr.recordUsage(makeUsageRecord({ role: "worker", totalTokens: 200, costUsd: 0.02 }));
    await mgr.recordUsage(makeUsageRecord({ role: "worker", totalTokens: 300, costUsd: 0.03 }));

    const state = await mgr.getState();
    assert.strictEqual(state.byRole["orchestrator"].totalTokens, 100);
    assert.strictEqual(state.byRole["orchestrator"].costUsd, 0.01);
    assert.strictEqual(state.byRole["worker"].totalTokens, 500);
    assert.strictEqual(state.byRole["worker"].costUsd, 0.05);

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("retry/failover usage counts toward same mission budget", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-usage-retry-"));
    const scope = createMissionScope(projectRoot, "mis_usage_003");
    await mkdir(getMissionDir(scope), { recursive: true });

    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());

    // Simulate original attempt + retry (same mission)
    await mgr.recordUsage(makeUsageRecord({ totalTokens: 500, costUsd: 0.05 }));
    await mgr.recordUsage(makeUsageRecord({ totalTokens: 500, costUsd: 0.05 }));

    const state = await mgr.getState();
    assert.strictEqual(state.totalTokens, 1000);
    assert.strictEqual(state.costUsd, 0.10);

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("exceeding budget durably writes halted mission state and budget event", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-budget-halt-"));
    const scope = createMissionScope(projectRoot, "mis_usage_004");
    await mkdir(getMissionDir(scope), { recursive: true });

    const mgr = new BudgetManager(scope);
    const limits: MissionBudgetLimits = { ...defaultLimits(), maxCostUsd: 0.01 };
    await mgr.initialize(limits);

    try {
      await mgr.recordUsage(makeUsageRecord({ costUsd: 1 }));
      assert.fail("expected BudgetExceededError");
    } catch (err) {
      assert.ok(err instanceof Error);
    }

    const state = await mgr.getState();
    assert.ok(state.exhausted);
    assert.strictEqual(state.exhausted?.reason, "costUsd");

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

function makeUsageRecord(overrides: Partial<import("../src/core/budget/types.js").UsageRecord> = {}): import("../src/core/budget/types.js").UsageRecord {
  const now = new Date().toISOString();
  const sessionId = "sess_retry";
  const provider = "test-provider";
  const model = "test-model";
  const timestamp = overrides.timestamp ?? now;
  const recordId = overrides.recordId ?? `sha256-${sessionId}:${timestamp}:${provider}:${model}:${Math.random().toString(36).slice(2)}`;
  return {
    recordId,
    missionId: "mis_usage_xxx",
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
