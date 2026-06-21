import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetManager } from "../src/core/budget/budget-manager.js";
import type { MissionBudgetLimits } from "../src/core/budget/types.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { EventLogger } from "../src/core/observability/event-logger.js";
import { ModelRouter } from "../src/core/models/model-router.js";
import { createOrchestratorTools } from "../src/core/tools.js";
import type { MissionExecutionContext } from "../src/core/mission/execution-context.js";
import type { UsageRecord } from "../src/core/budget/types.js";

async function setupContext() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ratel-budget-status-"));
  const scope = createMissionScope(projectRoot, "mis_bs_00001");
  await mkdir(getMissionDir(scope), { recursive: true });
  const logger = await EventLogger.forMission(scope);
  const budget = new BudgetManager(scope);
  const models = new ModelRouter({
    projectRoot,
    orchestrator: { model: null, fallbackModels: [] },
    worker: { model: null, fallbackModels: [] },
    validator: { model: null, fallbackModels: [] },
    modelRouting: { failureThreshold: 3, cooldownMs: 1000 },
  });
  await models.init();
  const context: MissionExecutionContext = { scope, logger, budget, models };
  return { projectRoot, scope, logger, budget, context };
}

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

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  const now = new Date().toISOString();
  const sessionId = "sess_bs_001";
  const provider = "test-provider";
  const model = "test-model";
  const timestamp = overrides.timestamp ?? now;
  const recordId =
    overrides.recordId ??
    `sha256-${sessionId}:${timestamp}:${provider}:${model}:${Math.random().toString(36).slice(2)}`;
  return {
    recordId,
    missionId: "mis_bs_00001",
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

/** Find a registered tool by name in createOrchestratorTools output. */
function findTool(tools: ReturnType<typeof createOrchestratorTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

describe("get_budget_status", () => {
  it("is registered by createOrchestratorTools", () => {
    const { context } = {} as { context: MissionExecutionContext };
    // Build tools with a throwaway context just to check registration.
    const tools = createOrchestratorTools({
      scope: createMissionScope("/tmp", "mis_bs_reg001"),
      logger: undefined as unknown as EventLogger,
      budget: undefined as unknown as BudgetManager,
      models: undefined as unknown as ModelRouter,
    });
    assert.ok(tools.some((t) => t.name === "get_budget_status"));
  });

  it("returns ok risk and full remaining for a fresh budget", async () => {
    const { projectRoot, context, logger } = await setupContext();
    try {
      await context.budget.initialize(defaultLimits());
      const tools = createOrchestratorTools(context);
      const tool = findTool(tools, "get_budget_status");
      const result = await tool.execute("call_1", {});
      assert.ok(Array.isArray(result.content));
      assert.ok(result.content.some((c: any) => c.type === "text"));
      const details = (result as any).details;
      assert.strictEqual(details.risk, "ok");
      assert.strictEqual(details.state.costUsd, 0);
      assert.strictEqual(details.remaining.costUsd, 50);
      assert.strictEqual(details.remaining.totalTokens, 5_000_000);
      assert.strictEqual(details.remaining.agentRuns, 200);
    } finally {
      await logger.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns warning risk when usage crosses 75% of cost budget", async () => {
    const { projectRoot, context, logger } = await setupContext();
    try {
      const limits: MissionBudgetLimits = { ...defaultLimits(), maxCostUsd: 10 };
      await context.budget.initialize(limits);
      // Use 8 / 10 = 80% -> warning
      await context.budget.recordUsage(makeRecord({ costUsd: 8 }));
      const tools = createOrchestratorTools(context);
      const tool = findTool(tools, "get_budget_status");
      const result = await tool.execute("call_2", {});
      const details = (result as any).details;
      assert.strictEqual(details.risk, "warning");
      assert.strictEqual(details.remaining.costUsd, 2);
      assert.ok(details.usedFraction.costUsd >= 0.75);
    } finally {
      await logger.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns critical risk when usage crosses 90% of cost budget", async () => {
    const { projectRoot, context, logger } = await setupContext();
    try {
      const limits: MissionBudgetLimits = { ...defaultLimits(), maxCostUsd: 10 };
      await context.budget.initialize(limits);
      await context.budget.recordUsage(makeRecord({ costUsd: 9.5 }));
      const tools = createOrchestratorTools(context);
      const tool = findTool(tools, "get_budget_status");
      const result = await tool.execute("call_3", {});
      const details = (result as any).details;
      assert.strictEqual(details.risk, "critical");
      assert.ok(details.usedFraction.costUsd >= 0.9);
    } finally {
      await logger.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns exhausted risk when budget is exhausted", async () => {
    const { projectRoot, context, logger } = await setupContext();
    try {
      const limits: MissionBudgetLimits = { ...defaultLimits(), maxCostUsd: 1 };
      await context.budget.initialize(limits);
      try {
        await context.budget.recordUsage(makeRecord({ costUsd: 2 }));
      } catch {
        /* BudgetExceededError expected */
      }
      const state = await context.budget.getState();
      assert.ok(state.exhausted, "precondition: budget should be exhausted");
      const tools = createOrchestratorTools(context);
      const tool = findTool(tools, "get_budget_status");
      const result = await tool.execute("call_4", {});
      const details = (result as any).details;
      assert.strictEqual(details.risk, "exhausted");
      assert.ok(details.state.exhausted);
    } finally {
      await logger.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
