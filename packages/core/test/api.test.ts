import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../src/api.js";
import { MissionControlPlane } from "../src/control-plane/mission-control-plane.js";
import type { JobExecutor } from "../src/control-plane/job-runner.js";
import type { MissionJob } from "../src/control-plane/types.js";
import type { ApiServer } from "../src/api.js";

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

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, init);
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => "");
  }
  return { status: res.status, body, headers: res.headers };
}

describe("api v1", () => {
  let projectRoot: string;
  let executor: FakeExecutor;
  let cp: MissionControlPlane;
  let api: ApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-api-"));
    executor = new FakeExecutor();
    cp = new MissionControlPlane({
      cwd: projectRoot,
      executor,
      pollIntervalMs: 50,
      leaseMs: 500,
    });
    await cp.start();

    api = await createApiServer({ cwd: projectRoot, port: 0, controlPlane: cp });
    baseUrl = api.url;
  });

  afterEach(async () => {
    await api.shutdown();
    await cp.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("POST /api/v1/missions returns 202 with missionId and jobId", async () => {
    const res = await fetchJson(`${baseUrl}/api/v1/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-test-1" },
      body: JSON.stringify({ goal: "API test mission" }),
    });

    assert.strictEqual(res.status, 202);
    assert.ok((res.body as Record<string, unknown>).missionId);
    assert.ok((res.body as Record<string, unknown>).jobId);
  });

  it("GET /api/v1/missions/:missionId returns mission", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Get test" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.body as Record<string, unknown>).missionId, mission.missionId);
  });

  it("GET /api/v1/missions/:missionId returns 404 for unknown", async () => {
    const res = await fetchJson(`${baseUrl}/api/v1/missions/mis_unknown000`);
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/v1/missions/:missionId/jobs lists jobs", async () => {
    const { mission } = await cp.enqueueMission({ goal: "List jobs" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/jobs`);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray((res.body as Record<string, unknown>).jobs));
    assert.strictEqual(((res.body as Record<string, unknown>).jobs as unknown[]).length, 1);
  });

  it("GET /api/v1/missions/:missionId/jobs/:jobId returns job", async () => {
    const { mission, job } = await cp.enqueueMission({ goal: "Get job" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/jobs/${job.jobId}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.body as Record<string, unknown>).jobId, job.jobId);
  });

  it("POST /api/v1/missions/:missionId/jobs/:jobId/cancel cancels job", async () => {
    const { mission, job } = await cp.enqueueMission({ goal: "Cancel job" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/jobs/${job.jobId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.body as Record<string, unknown>).status, "cancelled");
  });

  it("POST /api/v1/missions/:missionId/workers enqueues worker job", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Worker test" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "FEAT-001" }),
    });

    assert.strictEqual(res.status, 202);
    assert.ok((res.body as Record<string, unknown>).jobId);
  });

  it("POST /api/v1/missions/:missionId/validations enqueues validation job", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Validation test" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/validations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestoneId: "M1" }),
    });

    assert.strictEqual(res.status, 202);
    assert.ok((res.body as Record<string, unknown>).jobId);
  });

  it("POST /api/v1/missions/:missionId/user-testing enqueues user testing job", async () => {
    const { mission } = await cp.enqueueMission({ goal: "User testing" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/user-testing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestoneId: "M1" }),
    });

    assert.strictEqual(res.status, 202);
    assert.ok((res.body as Record<string, unknown>).jobId);
  });

  it("POST /api/v1/missions/:missionId/approval submits approval", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Approval test" });
    const job = await cp.enqueueJob({
      missionId: mission.missionId,
      type: "continue_orchestrator",
      payload: { message: "Waiting for approval" },
    });

    // Mark the job as waiting for approval using the internal jobStore
    const jobStore = (cp as any).jobStore;
    const claimed = await jobStore.claimNextJob((cp as any).ownerId, 5000);
    assert.ok(claimed);
    await jobStore.markWaitingForApproval(mission.missionId, job.jobId);

    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, feedback: "Looks good" }),
    });

    assert.strictEqual(res.status, 202);
    assert.ok((res.body as Record<string, unknown>).jobId);
  });

  it("GET /health returns ok", async () => {
    const res = await fetchJson(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.body as Record<string, unknown>).status, "ok");
  });

  it("returns 400 for invalid body", async () => {
    const res = await fetchJson(`${baseUrl}/api/v1/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 404 for unknown job", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Unknown job" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/jobs/job_unknown000/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 404);
  });

  it("deprecated old routes still work with Deprecation header", async () => {
    const res = await fetchJson(`${baseUrl}/api/mission/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Deprecated route" }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("Deprecation"), "true");
  });

  it("GET /api/v1/missions/:missionId/events returns events", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Events test" });
    // Write some events
    const eventsPath = join(projectRoot, ".ratel", "missions", mission.missionId, "events.jsonl");
    await mkdir(join(projectRoot, ".ratel", "missions", mission.missionId), { recursive: true });
    await writeFile(eventsPath, `{"event_type":"test"}\n`, "utf-8");

    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/events`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray((res.body as Record<string, unknown>).events));
  });
});
