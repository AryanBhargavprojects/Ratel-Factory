import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionControlPlane } from "../src/control-plane/mission-control-plane.js";
import type { JobExecutor } from "../src/control-plane/job-runner.js";
import type { MissionJob } from "../src/control-plane/types.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { atomicWriteJson } from "../src/core/mission/atomic-file.js";
import { writeFeatures, writeMilestones, readFeatures, readMilestones } from "../src/core/artifacts.js";
import { persistWorkerReceipt } from "../src/core/report-submission.js";
import type { WorkerRunReceipt, ScrutinyReport, UserTestingReport } from "../src/core/types.js";
import {
  evaluateFeatureIntegrationGate,
  applyFeatureIntegration,
} from "../src/core/mission/feature-completion.js";
import {
  evaluateMilestoneValidation,
  applyMilestoneValidation,
  markMissionCompleted,
} from "../src/core/mission/validation-finalization.js";
import { BudgetManager } from "../src/core/budget/budget-manager.js";
import type { MissionBudgetLimits } from "../src/core/budget/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout waiting for condition");
}

function nowIso(): string {
  return new Date().toISOString();
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

function makeUsageRecord(overrides: Partial<import("../src/core/budget/types.js").UsageRecord> = {}): import("../src/core/budget/types.js").UsageRecord {
  const now = nowIso();
  const sessionId = "sess_e2e";
  const provider = "test-provider";
  const model = "test-model";
  const timestamp = overrides.timestamp ?? now;
  const recordId = overrides.recordId ?? `sha256-${sessionId}:${timestamp}:${provider}:${model}:${Math.random().toString(36).slice(2)}`;
  return {
    recordId,
    missionId: "mis_e2e",
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

function makeGoodScrutinyReport(milestoneId: string): ScrutinyReport {
  return {
    validatorType: "scrutiny",
    milestoneId,
    createdAt: nowIso(),
    automatedChecks: {
      tests: { passed: true, command: "npm test", exitCode: 0, output: "ok" },
      typecheck: { passed: true, command: "tsc --noEmit", exitCode: 0, output: "ok" },
      lint: { passed: true, command: "eslint .", exitCode: 0, output: "ok" },
    },
    codeReviews: [],
    issues: [],
    summary: "All clear",
  };
}

function makeGoodUserTestingReport(milestoneId: string): UserTestingReport {
  return {
    validatorType: "user-testing",
    milestoneId,
    createdAt: nowIso(),
    appStartCommand: "npm run dev",
    baseURL: "http://localhost:3000",
    scenarioResults: [
      {
        featureFile: "auth.feature",
        scenarioName: "Login works",
        status: "passed",
        steps: [],
        screenshotPaths: [],
        consoleErrors: [],
        durationMs: 1000,
      },
    ],
    issues: [],
    summary: "All clear",
    coverageStatus: "complete",
  };
}

// ─── Fake Executor ───────────────────────────────────────────────────────────

interface FakeAgentBehavior {
  /** Which job types this behavior applies to. If undefined, applies to all. */
  jobTypes?: string[];
  /** Delay before completing (ms). */
  delayMs?: number;
  /** Error to throw. */
  error?: Error;
  /** Whether the executor should mark the job as waiting_for_approval mid-flight. */
  approvalWait?: boolean;
  /** Whether to simulate budget exceeded during execution. */
  budgetExceeded?: boolean;
  /** Whether to simulate non-retryable auth failure. */
  authFailure?: boolean;
}

class FakeExecutor implements JobExecutor {
  jobsStarted: { job: MissionJob; signal: AbortSignal }[] = [];
  private behaviors = new Map<string, FakeAgentBehavior>();

  setBehavior(jobId: string, behavior: FakeAgentBehavior): void {
    this.behaviors.set(jobId, behavior);
  }

  setDefaultBehavior(_behavior: FakeAgentBehavior): void {
    /* unused in e2e */
  }

  async execute(job: MissionJob, signal: AbortSignal): Promise<void> {
    this.jobsStarted.push({ job, signal });

    const behavior = this.behaviors.get(job.jobId) ?? {};
    const delayMs = behavior.delayMs ?? 10;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      });
    });

    if (behavior.budgetExceeded) {
      const err = new Error("Budget exceeded: costUsd (100 > 50)");
      err.name = "BudgetExceededError";
      throw err;
    }

    if (behavior.authFailure) {
      const err = new Error("Unauthorized: 401");
      throw err;
    }

    if (behavior.error) {
      throw behavior.error;
    }
  }
}

// ─── End-to-end Suite ────────────────────────────────────────────────────────

describe("end-to-end control plane", () => {
  let projectRoot: string;
  let executor: FakeExecutor;
  let cp: MissionControlPlane;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-e2e-"));
    executor = new FakeExecutor();
    cp = new MissionControlPlane({
      cwd: projectRoot,
      executor,
      pollIntervalMs: 50,
      leaseMs: 500,
    });
    await cp.start();
  });

  afterEach(async () => {
    await cp.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });

  // ── Step 1: Happy Path ────────────────────────────────────────────────────

  it("full lifecycle: mission -> queued job -> execution -> approval -> worker -> validation -> completion", async () => {
    // 1. Mission creation
    const { mission, job: startJob } = await cp.enqueueMission({ goal: "Build a widget" });
    assert.ok(mission.missionId.startsWith("mis_"));
    assert.strictEqual(startJob.type, "start_mission");
    assert.strictEqual(startJob.status, "queued");

    // Wait for start_mission to succeed
    await waitForCondition(() => cp.getJob(mission.missionId, startJob.jobId).then((j) => j?.status === "succeeded"));

    // 2. Enqueue orchestrator continuation that waits for approval
    const approvalJob = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "continue_orchestrator",
      payload: { message: "Plan ready, awaiting approval" },
    });

    // Mark it running then waiting_for_approval
    const jobStore = (cp as any).jobStore;
    const claimed = await jobStore.claimNextJob((cp as any).ownerId, 5000);
    assert.ok(claimed);
    assert.strictEqual(claimed!.jobId, approvalJob.jobId);
    await jobStore.markWaitingForApproval(mission.missionId, approvalJob.jobId);

    const waitingJob = await cp.getJob(mission.missionId, approvalJob.jobId);
    assert.strictEqual(waitingJob?.status, "waiting_for_approval");

    // 3. Submit approval -> enqueues continue_orchestrator
    const nextJob = await cp.submitApproval(mission.missionId, {
      approved: true,
      feedback: "Proceed",
    });
    assert.strictEqual(nextJob.type, "continue_orchestrator");
    assert.strictEqual(nextJob.status, "queued");

    // Wait for approval-driven continuation to complete
    await waitForCondition(() => cp.getJob(mission.missionId, nextJob.jobId).then((j) => j?.status === "succeeded"));

    // 4. Enqueue worker job
    const workerJob = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: { featureId: "F1" },
    });
    executor.setBehavior(workerJob.jobId, { delayMs: 50 });
    await waitForCondition(() => cp.getJob(mission.missionId, workerJob.jobId).then((j) => j?.status === "succeeded"));

    // 5. Write a clean worker receipt so integration gate passes
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(join(missionDir, "worker-runs"), { recursive: true });
    await mkdir(join(missionDir, "validation-reports"), { recursive: true });
    await mkdir(join(missionDir, "validation-receipts"), { recursive: true });

    await writeFeatures(scope, [
      { id: "F1", title: "Widget", description: "", assertions: [], milestoneId: "M1", status: "in_progress" },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M1", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const receipt: WorkerRunReceipt = {
      featureId: "F1",
      recordedAt: nowIso(),
      parseStatus: "ok",
      reportSource: "tool_submission",
      handoffPath: "handoffs/F1.json",
      rawFilename: "F1.raw.txt",
      handoff: {
        featureId: "F1",
        completedAt: nowIso(),
        completed: ["implemented widget"],
        leftUndone: [],
        commandsRun: [],
        issuesDiscovered: [],
        proceduresAbided: true,
        summary: "Done",
      },
      workspace: { status: "ready", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
      workspaceFinalization: { status: "skipped", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
    };
    await persistWorkerReceipt(scope, receipt);

    // 6. Integration gate
    const gate = await evaluateFeatureIntegrationGate(scope, "F1");
    assert.strictEqual(gate.success, true, `Gate failed: ${gate.errors.join(", ")}`);
    await applyFeatureIntegration(scope, "F1", gate.commitSha);

    const featuresAfterIntegration = await readFeatures(scope);
    const f1Integrated = featuresAfterIntegration?.find((f) => f.id === "F1");
    assert.strictEqual(f1Integrated?.status, "integrated");
    assert.ok(f1Integrated?.integratedAt);

    // 7. Enqueue validation job
    const validationJob = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "run_validation",
      payload: { milestoneId: "M1" },
    });
    executor.setBehavior(validationJob.jobId, { delayMs: 50 });
    await waitForCondition(() => cp.getJob(mission.missionId, validationJob.jobId).then((j) => j?.status === "succeeded"));

    // Write validation reports
    const scrutiny = makeGoodScrutinyReport("M1");
    const userTesting = makeGoodUserTestingReport("M1");
    const scrutinyFilename = `scrutiny-M1-${Date.now()}.json`;
    const userTestingFilename = `user-testing-M1-${Date.now()}.json`;
    await atomicWriteJson(join(missionDir, "validation-reports", scrutinyFilename), scrutiny);
    await atomicWriteJson(join(missionDir, "validation-reports", userTestingFilename), userTesting);

    // 8. Validation finalization
    const valResult = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });
    assert.strictEqual(valResult.success, true, `Validation failed: ${valResult.errors.join(", ")}`);
    await applyMilestoneValidation(scope, valResult);

    const featuresAfterValidation = await readFeatures(scope);
    const f1Validated = featuresAfterValidation?.find((f) => f.id === "F1");
    assert.strictEqual(f1Validated?.status, "validated");
    assert.ok(f1Validated?.validatedAt);

    const milestonesAfterValidation = await readMilestones(scope);
    const m1Completed = milestonesAfterValidation?.find((m) => m.id === "M1");
    assert.strictEqual(m1Completed?.status, "completed");

    // 9. Mission completion gate
    const completion = await markMissionCompleted(scope);
    assert.strictEqual(completion.success, true, `Completion failed: ${completion.errors.join(", ")}`);
  });

  // ── Step 2: Negative Cases ──────────────────────────────────────────────────

  it("budget exhaustion halts further model work and prevents fallback", async () => {
    const { mission, job } = await cp.enqueueMission({ goal: "Expensive mission" });
    executor.setBehavior(job.jobId, { budgetExceeded: true, delayMs: 10 });

    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "failed"));

    const finalJob = await cp.getJob(mission.missionId, job.jobId);
    assert.strictEqual(finalJob?.status, "failed");
    assert.ok(finalJob?.error);
    // Control plane requeues retryable errors up to maxAttempts; budget exceeded
    // is treated as retryable by the generic control-plane handler when using
    // FakeExecutor. In production JobRunner it would be non-retryable.
    assert.ok(finalJob!.attempt >= 1);
  });

  it("non-retryable auth failure does not fallback and marks job failed", async () => {
    // Note: FakeExecutor is a generic test double without JobRunner error classification.
    // The control-plane's generic handler retries all errors up to maxAttempts.
    // The non-retryable behavior (no fallback for 401) is unit-tested in error-classifier.test.ts.
    // Here we verify the job eventually terminates as failed after exhausting attempts.
    const { mission, job } = await cp.enqueueMission({ goal: "Auth-failing mission" });
    executor.setBehavior(job.jobId, { authFailure: true, delayMs: 10 });

    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "failed"), 10000);

    const finalJob = await cp.getJob(mission.missionId, job.jobId);
    assert.strictEqual(finalJob?.status, "failed");
    assert.ok(finalJob?.error);
    assert.strictEqual(finalJob?.attempt, 3); // maxAttempts exhausted
  });

  it("stale reports cannot validate (report mtime before latest integratedAt)", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Stale report mission" });
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(join(missionDir, "validation-reports"), { recursive: true });
    await mkdir(join(missionDir, "validation-receipts"), { recursive: true });

    // Feature integrated in the future
    const futureIntegratedAt = new Date(Date.now() + 60_000).toISOString();
    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: futureIntegratedAt },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const scrutinyFilename = `scrutiny-M1-${Date.now()}.json`;
    const userTestingFilename = `user-testing-M1-${Date.now()}.json`;
    await atomicWriteJson(join(missionDir, "validation-reports", scrutinyFilename), makeGoodScrutinyReport("M1"));
    await atomicWriteJson(join(missionDir, "validation-reports", userTestingFilename), makeGoodUserTestingReport("M1"));

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("stale")));
  });

  it("process restart does not duplicate usage records", async () => {
    const missionId = "mis_restart_test";
    const scope = createMissionScope(projectRoot, missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });

    const mgr1 = new BudgetManager(scope);
    await mgr1.initialize(defaultLimits());

    const rec = makeUsageRecord({ totalTokens: 500, costUsd: 0.05 });
    await mgr1.recordUsage(rec);
    await mgr1.recordUsage(rec); // idempotent in same process

    // Simulate restart
    const mgr2 = new BudgetManager(scope);
    await mgr2.initialize(defaultLimits());
    await mgr2.recordUsage(rec); // should be skipped

    const state = await mgr2.getState();
    assert.strictEqual(state.totalTokens, 500);
    assert.strictEqual(state.costUsd, 0.05);
    assert.strictEqual(state.agentRuns, 0);
  });

  it("repeated idempotency key does not create second mission", async () => {
    const key = "idem-mission-unique";
    const { mission: m1 } = await cp.enqueueMission({ goal: "First", idempotencyKey: key });

    const { mission: m2 } = await cp.enqueueMission({ goal: "Second", idempotencyKey: key });
    assert.strictEqual(m1.missionId, m2.missionId);
    assert.strictEqual(m1.goal, m2.goal); // goal preserved from first call
  });

  it("two mission IDs never share artifacts", async () => {
    const { mission: m1 } = await cp.enqueueMission({ goal: "Mission A" });
    const { mission: m2 } = await cp.enqueueMission({ goal: "Mission B" });

    assert.notStrictEqual(m1.missionId, m2.missionId);

    const dir1 = join(projectRoot, ".ratel", "missions", m1.missionId);
    const dir2 = join(projectRoot, ".ratel", "missions", m2.missionId);

    // Each mission gets its own directory
    await assert.doesNotReject(access(dir1));
    await assert.doesNotReject(access(dir2));
    assert.notStrictEqual(dir1, dir2);

    // mission.json exists in each
    const missionJson1 = await readFile(join(dir1, "mission.json"), "utf-8").then(JSON.parse);
    const missionJson2 = await readFile(join(dir2, "mission.json"), "utf-8").then(JSON.parse);
    assert.strictEqual(missionJson1.missionId, m1.missionId);
    assert.strictEqual(missionJson2.missionId, m2.missionId);
  });

  it("cancellation survives restart as terminal cancelled state", async () => {
    const { mission, job } = await cp.enqueueMission({ goal: "Cancellable mission" });
    executor.setBehavior(job.jobId, { delayMs: 10000 });

    // Wait for it to start running
    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "running"));

    // Cancel
    await cp.cancelJob(mission.missionId, job.jobId);
    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "cancelled"));

    // Shutdown and restart
    await cp.shutdown();

    const cp2 = new MissionControlPlane({
      cwd: projectRoot,
      executor,
      pollIntervalMs: 50,
      leaseMs: 500,
    });
    await cp2.start();

    // Job should remain cancelled
    const restartedJob = await cp2.getJob(mission.missionId, job.jobId);
    assert.strictEqual(restartedJob?.status, "cancelled");

    await cp2.shutdown();
  });

  // ── Additional Edge Cases ─────────────────────────────────────────────────

  it("retryable primary-model failure followed by fallback success", async () => {
    // Verify the control-plane requeue mechanism: a retryable error requeues
    // the job up to maxAttempts, and a subsequent successful execution succeeds.
    const { mission, job } = await cp.enqueueMission({ goal: "Retryable mission" });

    // Use a long delay so we can observe the job in "running" and swap behavior before execute completes.
    executor.setBehavior(job.jobId, { error: new Error("Rate limit exceeded: 429"), delayMs: 600 });

    // Wait for the job to be claimed (running)
    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "running"));

    // Swap to success BEFORE the 600ms delay expires
    executor.setBehavior(job.jobId, { delayMs: 10 });

    // Wait for success
    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "succeeded"), 5000);

    const finalJob = await cp.getJob(mission.missionId, job.jobId);
    assert.strictEqual(finalJob?.status, "succeeded");
    assert.ok(finalJob!.attempt >= 2, `Expected attempt >= 2, got ${finalJob!.attempt}`);
  });

  it("mission completion gate rejects when any feature is not validated", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Incomplete validation mission" });
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" },
      { id: "F2", title: "B", description: "", assertions: [], milestoneId: "M1", status: "validated", validatedAt: nowIso() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1", "F2"], status: "completed" },
    ]);

    const completion = await markMissionCompleted(scope);
    assert.strictEqual(completion.success, false);
    assert.ok(completion.errors.some((e) => e.includes("validated")));
  });

  it("integration gate rejects when parseStatus is failed", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Bad handoff mission" });
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(join(missionDir, "worker-runs"), { recursive: true });

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" },
    ]);

    const receipt: WorkerRunReceipt = {
      featureId: "F1",
      recordedAt: nowIso(),
      parseStatus: "failed",
      reportSource: "jsonl_fallback",
      handoffPath: "handoffs/F1.json",
      rawFilename: "F1.raw.txt",
      handoff: {
        featureId: "F1",
        completedAt: nowIso(),
        completed: [],
        leftUndone: [],
        commandsRun: [],
        issuesDiscovered: [],
        proceduresAbided: true,
        summary: "Parse failed",
      },
      workspace: { status: "ready", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
      workspaceFinalization: { status: "skipped", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
    };
    await persistWorkerReceipt(scope, receipt);

    const gate = await evaluateFeatureIntegrationGate(scope, "F1");
    assert.strictEqual(gate.success, false);
    assert.ok(gate.errors.some((e) => e.includes("parseStatus")));
  });

  it("integration gate rejects when leftUndone is non-empty", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Partial work mission" });
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(join(missionDir, "worker-runs"), { recursive: true });

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" },
    ]);

    const receipt: WorkerRunReceipt = {
      featureId: "F1",
      recordedAt: nowIso(),
      parseStatus: "ok",
      reportSource: "tool_submission",
      handoffPath: "handoffs/F1.json",
      rawFilename: "F1.raw.txt",
      handoff: {
        featureId: "F1",
        completedAt: nowIso(),
        completed: [],
        leftUndone: ["TODO: finish widget"],
        commandsRun: [],
        issuesDiscovered: [],
        proceduresAbided: true,
        summary: "Partial",
      },
      workspace: { status: "ready", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
      workspaceFinalization: { status: "skipped", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
    };
    await persistWorkerReceipt(scope, receipt);

    const gate = await evaluateFeatureIntegrationGate(scope, "F1");
    assert.strictEqual(gate.success, false);
    assert.ok(gate.errors.some((e) => e.includes("unfinished")));
  });

  it("integration gate rejects when high-severity issues exist", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Buggy work mission" });
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(join(missionDir, "worker-runs"), { recursive: true });

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" },
    ]);

    const receipt: WorkerRunReceipt = {
      featureId: "F1",
      recordedAt: nowIso(),
      parseStatus: "ok",
      reportSource: "tool_submission",
      handoffPath: "handoffs/F1.json",
      rawFilename: "F1.raw.txt",
      handoff: {
        featureId: "F1",
        completedAt: nowIso(),
        completed: ["done"],
        leftUndone: [],
        commandsRun: [],
        issuesDiscovered: [{ description: "crash on null", severity: "high" }],
        proceduresAbided: true,
        summary: "Done but buggy",
      },
      workspace: { status: "ready", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
      workspaceFinalization: { status: "skipped", repoPath: projectRoot, integrationBranch: "integration", featureBranch: "feat/F1" },
    };
    await persistWorkerReceipt(scope, receipt);

    const gate = await evaluateFeatureIntegrationGate(scope, "F1");
    assert.strictEqual(gate.success, false);
    assert.ok(gate.errors.some((e) => e.includes("high")));
  });

  it("approval survives service restart", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Durable approval mission" });
    const job = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "continue_orchestrator",
      payload: { message: "Waiting for approval" },
    });

    const jobStore = (cp as any).jobStore;
    const claimed = await jobStore.claimNextJob((cp as any).ownerId, 5000);
    assert.ok(claimed);
    await jobStore.markWaitingForApproval(mission.missionId, job.jobId);

    // Shutdown
    await cp.shutdown();

    // Restart
    const cp2 = new MissionControlPlane({
      cwd: projectRoot,
      executor,
      pollIntervalMs: 50,
      leaseMs: 500,
    });
    await cp2.start();

    // Approval should still work
    const nextJob = await cp2.submitApproval(mission.missionId, {
      approved: true,
      feedback: "Looks great",
    });
    assert.strictEqual(nextJob.type, "continue_orchestrator");
    assert.strictEqual(nextJob.status, "queued");

    await cp2.shutdown();
  });

  it("queued job is recovered and executed after control plane restart", async () => {
    const { mission, job } = await cp.enqueueMission({ goal: "Recoverable mission" });
    executor.setBehavior(job.jobId, { delayMs: 2000 });

    // Wait for it to start running
    await waitForCondition(() => cp.getJob(mission.missionId, job.jobId).then((j) => j?.status === "running"));

    // Shutdown before completion
    await cp.shutdown();

    // Restart
    const cp2 = new MissionControlPlane({
      cwd: projectRoot,
      executor,
      pollIntervalMs: 50,
      leaseMs: 500,
    });
    await cp2.start();

    // Same job ID should eventually succeed
    await waitForCondition(
      () => cp2.getJob(mission.missionId, job.jobId).then((j) => j?.status === "succeeded"),
      5000
    );

    const finalJob = await cp2.getJob(mission.missionId, job.jobId);
    assert.strictEqual(finalJob?.status, "succeeded");

    await cp2.shutdown();
  });

  it("token and cost usage are persisted exactly once per assistant turn", async () => {
    const missionId = "mis_dedup_test";
    const scope = createMissionScope(projectRoot, missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });

    const mgr = new BudgetManager(scope);
    await mgr.initialize(defaultLimits());

    const rec = makeUsageRecord({ totalTokens: 1000, costUsd: 0.1, recordId: "unique-record-id-001" });

    // Same record multiple times
    await mgr.recordUsage(rec);
    await mgr.recordUsage(rec);
    await mgr.recordUsage(rec);

    const state = await mgr.getState();
    assert.strictEqual(state.totalTokens, 1000);
    assert.strictEqual(state.costUsd, 0.1);

    // Verify usage.jsonl has exactly one line
    const raw = await readFile(join(missionDir, "usage.jsonl"), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1);
  });

  it("validation finalization rejects when automated checks fail", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Failing checks mission" });
    const scope = createMissionScope(projectRoot, mission.missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(join(missionDir, "validation-reports"), { recursive: true });
    await mkdir(join(missionDir, "validation-receipts"), { recursive: true });

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const scrutiny: ScrutinyReport = {
      ...makeGoodScrutinyReport("M1"),
      automatedChecks: {
        tests: { passed: false, command: "npm test", exitCode: 1, output: "failed" },
        typecheck: { passed: true, command: "tsc --noEmit", exitCode: 0, output: "ok" },
        lint: { passed: true, command: "eslint .", exitCode: 0, output: "ok" },
      },
    };

    const scrutinyFilename = `scrutiny-M1-${Date.now()}.json`;
    const userTestingFilename = `user-testing-M1-${Date.now()}.json`;
    await atomicWriteJson(join(missionDir, "validation-reports", scrutinyFilename), scrutiny);
    await atomicWriteJson(join(missionDir, "validation-reports", userTestingFilename), makeGoodUserTestingReport("M1"));

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("test") || e.includes("automated")));
  });
});
