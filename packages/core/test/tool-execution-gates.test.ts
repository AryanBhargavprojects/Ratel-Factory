import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetManager } from "../src/core/budget/budget-manager.js";
import type { MissionBudgetLimits, UsageRecord } from "../src/core/budget/types.js";
import { ModelRouter } from "../src/core/models/model-router.js";
import { EventLogger } from "../src/core/observability/event-logger.js";
import { createOrchestratorTools } from "../src/core/tools.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { writeState } from "../src/core/artifacts.js";
import type { MissionExecutionContext } from "../src/core/mission/execution-context.js";
import type { MissionPhase } from "../src/core/types.js";
import type {
  ModelPreflightDeps,
  ResolvedModelAuth,
} from "../src/core/mission/model-preflight.js";
import type { FallbackModelConfig } from "../src/core/config.js";

function roleConfig(model: string | null, fallbackModels: string[] = []): FallbackModelConfig {
  return { model, fallbackModels };
}

function fullConfig(
  orchestrator: FallbackModelConfig,
  worker: FallbackModelConfig,
  validator: FallbackModelConfig,
): { orchestrator: FallbackModelConfig; worker: FallbackModelConfig; validator: FallbackModelConfig } {
  return { orchestrator, worker, validator };
}

/** Preflight deps that report ok for every role. */
function okPreflightDeps(): ModelPreflightDeps {
  const config = fullConfig(
    roleConfig("test/primary"),
    roleConfig("test/worker"),
    roleConfig("test/validator"),
  );
  return {
    getConfig: async () => config,
    resolveModelAuth: (slug) => ({ canonical: slug ?? "sdk/default", hasAuth: true, resolved: true }),
  };
}

/** Preflight deps that report adapter_auth_failure for every role. */
function noAuthPreflightDeps(): ModelPreflightDeps {
  const config = fullConfig(
    roleConfig("test/primary"),
    roleConfig("test/worker"),
    roleConfig("test/validator"),
  );
  return {
    getConfig: async () => config,
    resolveModelAuth: (slug) => ({ canonical: slug ?? "sdk/default", hasAuth: false, resolved: true }),
  };
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
  return {
    recordId: `sha256-sess:${now}:${Math.random().toString(36).slice(2)}`,
    missionId: "mis_gate_00001",
    sessionId: "sess_gate_001",
    role: "orchestrator",
    provider: "test-provider",
    model: "test-model",
    timestamp: now,
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

async function setupContext(
  projectRoot: string,
  preflightDeps?: ModelPreflightDeps,
): Promise<{ context: MissionExecutionContext; logger: EventLogger; budget: BudgetManager }> {
  const scope = createMissionScope(projectRoot, "mis_gate_00001");
  await mkdir(getMissionDir(scope), { recursive: true });
  const logger = await EventLogger.forMission(scope);
  const budget = new BudgetManager(scope);
  await budget.initialize(defaultLimits());
  const models = new ModelRouter({
    projectRoot,
    orchestrator: { model: "test/primary", fallbackModels: ["test/fallback"] },
    worker: { model: "test/worker", fallbackModels: [] },
    validator: { model: "test/validator", fallbackModels: [] },
    modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
  });
  await models.init();
  const context: MissionExecutionContext = {
    scope,
    logger,
    budget,
    models,
    preflightDeps,
  };
  return { context, logger, budget };
}

async function writeApproval(
  projectRoot: string,
  missionId: string,
  status: string,
): Promise<void> {
  const dir = join(projectRoot, ".ratel", "missions", missionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "approval.json"),
    JSON.stringify({ status, missionId, decidedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

async function setPhase(
  projectRoot: string,
  missionId: string,
  phase: MissionPhase,
): Promise<void> {
  const scope = createMissionScope(projectRoot, missionId);
  await writeState(scope, { phase, version: 1, updatedAt: new Date().toISOString() });
}

function findTool(tools: ReturnType<typeof createOrchestratorTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

describe("tool execution gates (Wave 3)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-tool-gates-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe("run_worker", () => {
    it("refuses before spawn when no approval exists", async () => {
      const { context, logger } = await setupContext(projectRoot, okPreflightDeps());
      try {
        // state.json exists (execution phase) but no approval.json
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_worker");
        const result: any = await tool.execute("call_rw_1", { featureId: "F-1" });
        const details = result.details;
        assert.strictEqual(details.refused, true);
        assert.strictEqual(details.gate, "execution_authorization");
        assert.strictEqual(details.reason, "missing_approval");
        assert.strictEqual(details.phase, "execution");
        assert.ok(result.content[0].text.includes("run_worker refused"));
        assert.ok(result.content[0].text.includes("wait_for_user_approval"));
      } finally {
        await logger.shutdown();
      }
    });

    it("refuses before spawn when approval is pending", async () => {
      const { context, logger } = await setupContext(projectRoot, okPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        await writeApproval(projectRoot, "mis_gate_00001", "pending");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_worker");
        const result: any = await tool.execute("call_rw_2", { featureId: "F-1" });
        assert.strictEqual(result.details.refused, true);
        assert.strictEqual(result.details.reason, "approval_pending");
        assert.strictEqual(result.details.approvalStatus, "pending");
      } finally {
        await logger.shutdown();
      }
    });

    it("returns preflight_failed / adapter_auth_failure / noTokensConsumed when approved but preflight fails", async () => {
      const { context, logger } = await setupContext(projectRoot, noAuthPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        await writeApproval(projectRoot, "mis_gate_00001", "approved");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_worker");
        const result: any = await tool.execute("call_rw_3", { featureId: "F-1" });
        const details = result.details;
        assert.strictEqual(details.refused, true);
        assert.strictEqual(details.gate, "model_preflight");
        assert.strictEqual(details.preflightFailed, true);
        assert.strictEqual(details.category, "adapter_auth_failure");
        assert.strictEqual(details.noTokensConsumed, true);
        assert.ok(details.preflight);
        assert.strictEqual(details.preflight.noTokensConsumed, true);
        assert.ok(result.content[0].text.includes("preflight failed"));
        // Sanity: every preflight problem is adapter_auth_failure
        for (const p of details.preflight.problems) {
          assert.strictEqual(p.code, "adapter_auth_failure");
        }
      } finally {
        await logger.shutdown();
      }
    });

    it("refuses with budget guidance before spawn when remaining budget is too low", async () => {
      const { context, logger, budget } = await setupContext(projectRoot, okPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        await writeApproval(projectRoot, "mis_gate_00001", "approved");
        // Re-initialize with a tiny budget that cannot cover the estimate.
        await budget.initialize({
          ...defaultLimits(),
          maxCostUsd: 1,
          maxAgentRuns: 1,
          maxTotalTokens: 1000,
        });
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_worker");
        const result: any = await tool.execute("call_rw_4", { featureId: "F-1" });
        const details = result.details;
        assert.strictEqual(details.refused, true);
        assert.strictEqual(details.gate, "budget_estimate");
        assert.ok(
          details.category === "budget_exhausted" || details.category === "budget_risk",
          `expected budget category, got ${details.category}`,
        );
        assert.ok(details.estimate);
        assert.ok(details.remaining);
        assert.ok(result.content[0].text.includes("run_worker refused"));
        assert.ok(result.content[0].text.includes("budget"));
      } finally {
        await logger.shutdown();
      }
    });

    it("refuses with budget_exhausted when budget is already exhausted", async () => {
      const { context, logger, budget } = await setupContext(projectRoot, okPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        await writeApproval(projectRoot, "mis_gate_00001", "approved");
        // Exhaust the budget by recording usage beyond the limit.
        await budget.initialize({ ...defaultLimits(), maxCostUsd: 1 });
        try {
          await budget.recordUsage(makeRecord({ costUsd: 5 }));
        } catch {
          /* BudgetExceededError expected */
        }
        const state = await budget.getState();
        assert.ok(state.exhausted, "precondition: budget should be exhausted");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_worker");
        const result: any = await tool.execute("call_rw_5", { featureId: "F-1" });
        const details = result.details;
        assert.strictEqual(details.refused, true);
        assert.strictEqual(details.gate, "budget_estimate");
        assert.strictEqual(details.category, "budget_exhausted");
      } finally {
        await logger.shutdown();
      }
    });
  });

  describe("run_validation", () => {
    it("refuses before spawn when no approval exists", async () => {
      const { context, logger } = await setupContext(projectRoot, okPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        // No approval.json
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_validation");
        const result: any = await tool.execute("call_rv_1", { milestoneId: "M-1" });
        assert.strictEqual(result.details.refused, true);
        assert.strictEqual(result.details.gate, "execution_authorization");
        assert.strictEqual(result.details.reason, "missing_approval");
        assert.ok(result.content[0].text.includes("run_validation refused"));
        assert.ok(result.content[0].text.includes("wait_for_user_approval"));
      } finally {
        await logger.shutdown();
      }
    });

    it("returns preflight_failed / adapter_auth_failure / noTokensConsumed when approved but preflight fails", async () => {
      const { context, logger } = await setupContext(projectRoot, noAuthPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        await writeApproval(projectRoot, "mis_gate_00001", "approved");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_validation");
        const result: any = await tool.execute("call_rv_2", { milestoneId: "M-1" });
        const details = result.details;
        assert.strictEqual(details.refused, true);
        assert.strictEqual(details.gate, "model_preflight");
        assert.strictEqual(details.preflightFailed, true);
        assert.strictEqual(details.category, "adapter_auth_failure");
        assert.strictEqual(details.noTokensConsumed, true);
        assert.ok(result.content[0].text.includes("preflight failed"));
      } finally {
        await logger.shutdown();
      }
    });
  });

  describe("run_user_testing", () => {
    it("refuses before spawn when no approval exists", async () => {
      const { context, logger } = await setupContext(projectRoot, okPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_user_testing");
        const result: any = await tool.execute("call_rut_1", { milestoneId: "M-1" });
        assert.strictEqual(result.details.refused, true);
        assert.strictEqual(result.details.gate, "execution_authorization");
        assert.strictEqual(result.details.reason, "missing_approval");
        assert.ok(result.content[0].text.includes("run_user_testing refused"));
        assert.ok(result.content[0].text.includes("wait_for_user_approval"));
      } finally {
        await logger.shutdown();
      }
    });

    it("returns preflight_failed / adapter_auth_failure / noTokensConsumed when approved but preflight fails", async () => {
      const { context, logger } = await setupContext(projectRoot, noAuthPreflightDeps());
      try {
        await setPhase(projectRoot, "mis_gate_00001", "execution");
        await writeApproval(projectRoot, "mis_gate_00001", "approved");
        const tools = createOrchestratorTools(context);
        const tool = findTool(tools, "run_user_testing");
        const result: any = await tool.execute("call_rut_2", { milestoneId: "M-1" });
        const details = result.details;
        assert.strictEqual(details.refused, true);
        assert.strictEqual(details.gate, "model_preflight");
        assert.strictEqual(details.preflightFailed, true);
        assert.strictEqual(details.category, "adapter_auth_failure");
        assert.strictEqual(details.noTokensConsumed, true);
        assert.ok(result.content[0].text.includes("preflight failed"));
      } finally {
        await logger.shutdown();
      }
    });
  });

  describe("authorization refusal for a mission with no durable state at all", () => {
    it("run_worker refuses with no_mission_state", async () => {
      // Use a fresh project root with NO state.json written. We must avoid
      // EventLogger.forMission here because it persists a traceId into
      // state.json, which would make the gate see a durable state.
      const scope = createMissionScope(projectRoot, "mis_gate_00001");
      await mkdir(getMissionDir(scope), { recursive: true });
      const budget = new BudgetManager(scope);
      await budget.initialize(defaultLimits());
      const models = new ModelRouter({
        projectRoot,
        orchestrator: { model: "test/primary", fallbackModels: ["test/fallback"] },
        worker: { model: "test/worker", fallbackModels: [] },
        validator: { model: "test/validator", fallbackModels: [] },
        modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
      });
      await models.init();
      const stubLogger = {
        toolCall: () => {},
        toolResult: () => {},
        agentSpanStart: () => "span-1",
        agentSpanEnd: () => {},
        getTraceId: () => "trace-gate",
      } as any as EventLogger;
      const context: MissionExecutionContext = {
        scope,
        logger: stubLogger,
        budget,
        models,
        preflightDeps: okPreflightDeps(),
      };
      const tools = createOrchestratorTools(context);
      const tool = findTool(tools, "run_worker");
      const result: any = await tool.execute("call_rw_6", { featureId: "F-1" });
      assert.strictEqual(result.details.refused, true);
      assert.strictEqual(result.details.reason, "no_mission_state");
    });
  });
});
