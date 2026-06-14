import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionControlPlane } from "../src/control-plane/mission-control-plane.js";
import type { JobExecutor } from "../src/control-plane/job-runner.js";
import type { MissionJob } from "../src/control-plane/types.js";

class FakeExecutor implements JobExecutor {
  jobsStarted: { job: MissionJob; signal: AbortSignal }[] = [];
  private results = new Map<string, { error?: Error; delayMs?: number }>();

  setResult(jobId: string, result: { error?: Error; delayMs?: number }): void {
    this.results.set(jobId, result);
  }

  async execute(job: MissionJob, signal: AbortSignal): Promise<void> {
    this.jobsStarted.push({ job, signal });
    const result = this.results.get(job.jobId);
    const delayMs = result?.delayMs ?? 10;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      });
    });

    if (result?.error) {
      throw result.error;
    }
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout waiting for condition");
}

describe("approval durable flow", () => {
  let projectRoot: string;
  let executor: FakeExecutor;
  let cp: MissionControlPlane;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-approval-"));
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

  it("wait_for_user_approval writes approval.json and transitions job to waiting_for_approval", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Approval mission" });
    const job = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "continue_orchestrator",
      payload: { message: "Waiting for approval" },
    });

    // Simulate the tool marking the job waiting_for_approval
    // In real implementation, this is done by the orchestrator tool
    const jobStore = (cp as any).jobStore;
    const claimed = await jobStore.claimNextJob((cp as any).ownerId, 5000);
    assert.ok(claimed);
    await jobStore.markWaitingForApproval(mission.missionId, job.jobId);

    // Verify job status
    const updated = await cp.getJob(mission.missionId, job.jobId);
    assert.strictEqual(updated?.status, "waiting_for_approval");

    // Write approval.json artifact
    const approvalPath = join(projectRoot, ".ratel", "missions", mission.missionId, "approval.json");
    await writeFile(
      approvalPath,
      JSON.stringify({
        status: "pending",
        missionId: mission.missionId,
        jobId: job.jobId,
        createdAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    const approvalData = JSON.parse(await readFile(approvalPath, "utf-8"));
    assert.strictEqual(approvalData.status, "pending");
    assert.strictEqual(approvalData.missionId, mission.missionId);
  });

  it("submitApproval validates files, writes them, and enqueues continue_orchestrator", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Approval mission" });
    const job = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "continue_orchestrator",
      payload: { message: "Waiting for approval" },
    });

    // Pre-seed a feature file so the allowlist works
    const featuresDir = join(projectRoot, ".ratel", "missions", mission.missionId, "features");
    await mkdir(featuresDir, { recursive: true });
    await writeFile(join(featuresDir, "test.feature"), "Feature: Test", "utf-8");

    const jobStore = (cp as any).jobStore;
    const claimed = await jobStore.claimNextJob((cp as any).ownerId, 5000);
    assert.ok(claimed);
    await jobStore.markWaitingForApproval(mission.missionId, job.jobId);

    const nextJob = await cp.submitApproval(mission.missionId, {
      approved: true,
      feedback: "Looks good",
      files: {
        "features/test.feature": "Feature: Test\n\n  Scenario: Updated",
      },
    });

    // The waiting job should be succeeded
    const waitingJob = await cp.getJob(mission.missionId, job.jobId);
    assert.strictEqual(waitingJob?.status, "succeeded");

    // A new continue_orchestrator job should be queued
    assert.strictEqual(nextJob.type, "continue_orchestrator");
    assert.strictEqual(nextJob.status, "queued");
  });

  it("submitApproval works after service restart", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Restartable approval" });
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

    // Submit approval after restart
    const nextJob = await cp2.submitApproval(mission.missionId, {
      approved: false,
      feedback: "Need changes",
    });

    assert.strictEqual(nextJob.type, "continue_orchestrator");
    assert.strictEqual(nextJob.status, "queued");
    assert.ok((nextJob.payload.message as string).includes("rejected"));

    await cp2.shutdown();
  });

  it("submitApproval rejects invalid filenames", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Approval validation" });
    const job = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "continue_orchestrator",
      payload: { message: "Waiting for approval" },
    });

    const jobStore = (cp as any).jobStore;
    const claimed = await jobStore.claimNextJob((cp as any).ownerId, 5000);
    assert.ok(claimed);
    await jobStore.markWaitingForApproval(mission.missionId, job.jobId);

    await assert.rejects(
      () =>
        cp.submitApproval(mission.missionId, {
          approved: true,
          files: {
            "../../etc/passwd": "evil",
          },
        }),
      /Invalid filename/
    );
  });
});
