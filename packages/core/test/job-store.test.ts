import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionStore } from "../src/control-plane/mission-store.js";
import { JobStore, JobTransitionError } from "../src/control-plane/job-store.js";

describe("job store", () => {
  let projectRoot: string;
  let missionStore: MissionStore;
  let jobStore: JobStore;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-job-"));
    missionStore = new MissionStore(projectRoot);
    await missionStore.initialize();
    jobStore = new JobStore(missionStore);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("create and reload jobs", async () => {
    const { mission } = await missionStore.createMission({ goal: "Job test" });
    const { job, created } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: { foo: "bar" },
      maxAttempts: 3,
    });
    assert.strictEqual(created, true);
    assert.strictEqual(job.missionId, mission.missionId);
    assert.strictEqual(job.status, "queued");

    const reloaded = await jobStore.getJob(mission.missionId, job.jobId);
    assert.deepStrictEqual(reloaded, job);
  });

  it("reject a job whose mission does not exist", async () => {
    await assert.rejects(
      () => jobStore.createJob({
        missionId: "mis_doesnotexist",
        type: "start_mission",
        payload: {},
        maxAttempts: 3,
      }),
      /Mission does not exist/
    );
  });

  it("cancelling a terminal job is idempotent", async () => {
    const { mission } = await missionStore.createMission({ goal: "Cancel idempotent" });
    const { job } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: {},
      maxAttempts: 3,
    });

    // Claim, succeed, then cancel
    const claimed = await jobStore.claimNextJob("owner-1", 5000);
    assert.ok(claimed);
    const succeeded = await jobStore.markSucceeded(claimed!.missionId, claimed!.jobId);
    assert.strictEqual(succeeded.status, "succeeded");

    // Cancellation should succeed and be idempotent
    const cancelled = await jobStore.requestCancellation(succeeded.missionId, succeeded.jobId);
    assert.strictEqual(cancelled.status, "succeeded");
    assert.ok(cancelled.cancellationRequestedAt);

    const cancelled2 = await jobStore.markCancelled(succeeded.missionId, succeeded.jobId);
    assert.strictEqual(cancelled2.status, "cancelled");

    // Idempotent: markCancelled again should not throw
    const cancelled3 = await jobStore.markCancelled(succeeded.missionId, succeeded.jobId);
    assert.strictEqual(cancelled3.status, "cancelled");
  });

  it("an expired running lease becomes queued after recovery", async () => {
    const { mission } = await missionStore.createMission({ goal: "Expired lease" });
    const { job } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 3,
    });

    // Claim with a very short lease
    const claimed = await jobStore.claimNextJob("owner-1", 1);
    assert.ok(claimed);
    assert.strictEqual(claimed!.status, "running");

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 50));

    const recovered = await jobStore.recoverExpiredJobs(new Date());
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].status, "queued");
    assert.strictEqual(recovered[0].jobId, job.jobId);
  });

  it("a non-expired lease remains running", async () => {
    const { mission } = await missionStore.createMission({ goal: "Non-expired lease" });
    await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 3,
    });

    const claimed = await jobStore.claimNextJob("owner-2", 60000);
    assert.ok(claimed);
    assert.strictEqual(claimed!.status, "running");

    const recovered = await jobStore.recoverExpiredJobs(new Date());
    assert.strictEqual(recovered.length, 0);
  });

  it("a job at maxAttempts becomes failed instead of requeued", async () => {
    const { mission } = await missionStore.createMission({ goal: "Max attempts" });
    const { job } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 2,
    });

    // First attempt fails
    const claimed1 = await jobStore.claimNextJob("owner-1", 5000);
    assert.ok(claimed1);
    const requeued1 = await jobStore.requeue(claimed1!.missionId, claimed1!.jobId, {
      code: "ERR_TEST",
      message: "first fail",
      retryable: true,
    });
    assert.strictEqual(requeued1.status, "queued");
    assert.strictEqual(requeued1.attempt, 1);

    // Second attempt fails
    const claimed2 = await jobStore.claimNextJob("owner-1", 5000);
    assert.ok(claimed2);
    assert.strictEqual(claimed2!.jobId, job.jobId);
    const requeued2 = await jobStore.requeue(claimed2!.missionId, claimed2!.jobId, {
      code: "ERR_TEST",
      message: "second fail",
      retryable: true,
    });
    assert.strictEqual(requeued2.status, "failed");
    assert.strictEqual(requeued2.attempt, 2);
  });

  it("non-retryable error marks job as failed immediately", async () => {
    const { mission } = await missionStore.createMission({ goal: "Non-retryable" });
    const { job } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 3,
    });

    const claimed = await jobStore.claimNextJob("owner-1", 5000);
    assert.ok(claimed);
    const failed = await jobStore.requeue(claimed!.missionId, claimed!.jobId, {
      code: "ERR_BUDGET",
      message: "budget exceeded",
      retryable: false,
    });
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.attempt, 1);
  });

  it("invalid transition throws JobTransitionError", async () => {
    const { mission } = await missionStore.createMission({ goal: "Invalid transition" });
    const { job } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_validation",
      payload: {},
      maxAttempts: 3,
    });

    await assert.rejects(
      () => jobStore.markSucceeded(mission.missionId, job.jobId),
      JobTransitionError
    );
  });

  it("listJobs returns jobs in creation order", async () => {
    const { mission } = await missionStore.createMission({ goal: "List jobs" });
    const { job: j1 } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: {},
      maxAttempts: 3,
    });
    const { job: j2 } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 3,
    });

    const list = await jobStore.listJobs(mission.missionId);
    const ids = list.map((j) => j.jobId);
    assert.deepStrictEqual(ids, [j1.jobId, j2.jobId]);
  });

  it("claimNextJob respects FIFO order", async () => {
    const { mission } = await missionStore.createMission({ goal: "FIFO" });
    await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: {},
      maxAttempts: 3,
    });
    await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 3,
    });

    const claimed = await jobStore.claimNextJob("owner-1", 5000);
    assert.ok(claimed);
    assert.strictEqual(claimed!.type, "start_mission");
  });

  it("heartbeat extends lease", async () => {
    const { mission } = await missionStore.createMission({ goal: "Heartbeat" });
    await jobStore.createJob({
      missionId: mission.missionId,
      type: "run_worker",
      payload: {},
      maxAttempts: 3,
    });

    const claimed = await jobStore.claimNextJob("owner-1", 50);
    assert.ok(claimed);

    // Wait for original lease to nearly expire
    await new Promise((r) => setTimeout(r, 40));

    // Heartbeat extends lease
    const heartbeat = await jobStore.heartbeat(claimed!.missionId, claimed!.jobId, "owner-1", 60000);
    assert.ok(heartbeat.leaseExpiresAt! > new Date().toISOString());

    // Recovery should not find it because lease is extended
    const recovered = await jobStore.recoverExpiredJobs(new Date());
    assert.strictEqual(recovered.length, 0);
  });

  it("markWaitingForApproval transitions from running", async () => {
    const { mission } = await missionStore.createMission({ goal: "Approval" });
    await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: {},
      maxAttempts: 3,
    });

    const claimed = await jobStore.claimNextJob("owner-1", 5000);
    assert.ok(claimed);
    const waiting = await jobStore.markWaitingForApproval(claimed!.missionId, claimed!.jobId);
    assert.strictEqual(waiting.status, "waiting_for_approval");
  });

  it("idempotency key returns original job", async () => {
    const { mission } = await missionStore.createMission({ goal: "Job idempotency" });
    const key = "job-idem-001";
    const { job: first, created: c1 } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: { a: 1 },
      maxAttempts: 3,
      idempotencyKey: key,
    });
    assert.strictEqual(c1, true);

    const { job: second, created: c2 } = await jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: { a: 2 },
      maxAttempts: 3,
      idempotencyKey: key,
    });
    assert.strictEqual(c2, false);
    assert.strictEqual(second.jobId, first.jobId);
    assert.deepStrictEqual(second.payload, { a: 1 });
  });
});
