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

  // ── POST /api/v1/missions/:missionId/messages ────────────────────────

  it("POST /api/v1/missions/:missionId/messages enqueues continue_orchestrator", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Messages test" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Use PostgreSQL for the database" }),
    });

    assert.strictEqual(res.status, 202);
    const body = res.body as Record<string, unknown>;
    assert.strictEqual(body.missionId, mission.missionId);
    assert.ok(body.jobId);
    assert.strictEqual(body.status, "queued");

    // The enqueued job should be a continue_orchestrator carrying the message
    const jobStore = (cp as any).jobStore;
    const jobs = await jobStore.listJobs(mission.missionId);
    const cont = jobs.find((j: any) => j.type === "continue_orchestrator");
    assert.ok(cont, "continue_orchestrator job must be enqueued");
    assert.strictEqual(cont.payload.message, "Use PostgreSQL for the database");
  });

  it("POST /api/v1/missions/:missionId/messages preserves questionId when provided", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Messages questionId" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "yes", questionId: "q_123" }),
    });

    assert.strictEqual(res.status, 202);
    const jobStore = (cp as any).jobStore;
    const jobs = await jobStore.listJobs(mission.missionId);
    const cont = jobs.find((j: any) => j.type === "continue_orchestrator");
    assert.strictEqual(cont.payload.questionId, "q_123");
  });

  it("POST /api/v1/missions/:missionId/messages trims whitespace-only message to 400", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Messages empty" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/v1/missions/:missionId/messages returns 400 when message missing", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Messages missing" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/v1/missions/:missionId/messages returns 400 when message not a string", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Messages badtype" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: 42 }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/v1/missions/:missionId/messages returns 404 for unknown mission", async () => {
    const res = await fetchJson(`${baseUrl}/api/v1/missions/mis_unknown000/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("POST /api/v1/missions/:missionId/messages returns 400 for invalid JSON", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Messages invalid json" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.strictEqual(res.status, 400);
  });

  // ── POST /api/v1/missions/:missionId/questions/:questionId/answer ────

  it("POST /api/v1/missions/:id/questions/:qid/answer enqueues continue_orchestrator", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Answer test" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/questions/q_abc/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "PostgreSQL" }),
    });

    assert.strictEqual(res.status, 202);
    const body = res.body as Record<string, unknown>;
    assert.strictEqual(body.missionId, mission.missionId);
    assert.strictEqual(body.questionId, "q_abc");
    assert.ok(body.jobId);
    assert.strictEqual(body.status, "queued");

    const jobStore = (cp as any).jobStore;
    const jobs = await jobStore.listJobs(mission.missionId);
    const cont = jobs.find((j: any) => j.type === "continue_orchestrator");
    assert.ok(cont);
    assert.ok(String(cont.payload.message).includes("q_abc"));
    assert.ok(String(cont.payload.message).includes("PostgreSQL"));
    assert.strictEqual(cont.payload.questionId, "q_abc");
  });

  it("POST /api/v1/missions/:id/questions/:qid/answer accepts structured answer", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Answer structured" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/questions/q_struct/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: { db: "postgres", replicas: 2 } }),
    });
    assert.strictEqual(res.status, 202);
    const jobStore = (cp as any).jobStore;
    const jobs = await jobStore.listJobs(mission.missionId);
    const cont = jobs.find((j: any) => j.type === "continue_orchestrator");
    assert.ok(cont);
    assert.deepStrictEqual(cont.payload.answer, { db: "postgres", replicas: 2 });
  });

  it("POST /api/v1/missions/:id/questions/:qid/answer returns 400 when answer missing", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Answer missing" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/questions/q_x/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/v1/missions/:id/questions/:qid/answer returns 400 for empty string answer", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Answer empty" });
    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/questions/q_x/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "   " }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/v1/missions/:id/questions/:qid/answer returns 404 for unknown mission", async () => {
    const res = await fetchJson(`${baseUrl}/api/v1/missions/mis_unknown000/questions/q_x/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "x" }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("POST /api/v1/missions/:id/questions/:qid/answer writes answer to pending-question.json when current", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Answer file" });
    const missionDir = join(projectRoot, ".ratel", "missions", mission.missionId);
    await mkdir(missionDir, { recursive: true });
    await writeFile(
      join(missionDir, "pending-question.json"),
      JSON.stringify({ questionId: "q_curr", missionId: mission.missionId, status: "pending" }),
      "utf-8",
    );

    const res = await fetchJson(`${baseUrl}/api/v1/missions/${mission.missionId}/questions/q_curr/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "yes" }),
    });
    assert.strictEqual(res.status, 202);

    const updated = JSON.parse(await readFile(join(missionDir, "pending-question.json"), "utf-8"));
    assert.strictEqual(updated.status, "answered");
    assert.strictEqual(updated.answer, "yes");
  });

  // ── Deprecated /api/mission/complete backward compatibility ──────────

  it("deprecated /api/mission/complete accepts body.message and uses it", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Deprecated msg" });
    const res = await fetchJson(`${baseUrl}/api/mission/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionId: mission.missionId, message: "User reply: use Redis" }),
    });
    assert.strictEqual(res.status, 200);
    const jobStore = (cp as any).jobStore;
    const jobs = await jobStore.listJobs(mission.missionId);
    const cont = jobs.find((j: any) => j.type === "continue_orchestrator");
    assert.ok(cont);
    assert.strictEqual(cont.payload.message, "User reply: use Redis");
  });

  it("deprecated /api/mission/complete falls back to featureId hardcode when no message", async () => {
    const { mission } = await cp.enqueueMission({ goal: "Deprecated fallback" });
    const res = await fetchJson(`${baseUrl}/api/mission/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionId: mission.missionId, featureId: "FEAT-7" }),
    });
    assert.strictEqual(res.status, 200);
    const jobStore = (cp as any).jobStore;
    const jobs = await jobStore.listJobs(mission.missionId);
    const cont = jobs.find((j: any) => j.type === "continue_orchestrator");
    assert.ok(cont);
    assert.strictEqual(cont.payload.message, "Mark feature FEAT-7 as complete");
  });
});
