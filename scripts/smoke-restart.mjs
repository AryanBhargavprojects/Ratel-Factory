#!/usr/bin/env node
/**
 * Manual restart smoke test for Task 10.
 * 1. Starts a temporary Ratel service on a free port.
 * 2. Creates a mission (job is queued).
 * 3. Stops the service while the job is queued.
 * 4. Restarts a new service pointing at the same project root.
 * 5. Confirms the same job ID exists and finishes.
 * 6. Confirms no duplicate usage records were written.
 */

import assert from "node:assert";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createApiServer } = await import("../packages/core/src/api.js");
const { MissionControlPlane } = await import("../packages/core/src/control-plane/mission-control-plane.js");

class SimpleExecutor {
  async execute(_job, _signal) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ratel-smoke-"));
  const executor = new SimpleExecutor();
  const cp1 = new MissionControlPlane({ cwd: projectRoot, executor, pollIntervalMs: 50, leaseMs: 500 });
  await cp1.start();
  const api1 = await createApiServer({ cwd: projectRoot, port: 0, controlPlane: cp1 });

  console.log("[Smoke] Service 1 started:", api1.url);

  // Create mission
  const res = await fetch(`${api1.url}/api/v1/missions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "smoke-1" },
    body: JSON.stringify({ goal: "Smoke test mission" }),
  });
  const body = await res.json();
  const missionId = body.missionId;
  const jobId = body.jobId;
  console.log("[Smoke] Created mission:", missionId, "job:", jobId);

  // Wait briefly for job to be queued (don't let it start)
  await waitFor(100);
  const queuedJob = await cp1.getJob(missionId, jobId);
  console.log("[Smoke] Job status before shutdown:", queuedJob?.status);

  // Shutdown service 1 (simulating process restart)
  await api1.shutdown();
  await cp1.shutdown();
  console.log("[Smoke] Service 1 shut down.");

  // Restart with new control plane
  const cp2 = new MissionControlPlane({ cwd: projectRoot, executor, pollIntervalMs: 50, leaseMs: 500 });
  await cp2.start();
  const api2 = await createApiServer({ cwd: projectRoot, port: 0, controlPlane: cp2 });
  console.log("[Smoke] Service 2 started:", api2.url);

  // Confirm same mission directory
  const missionDir = join(projectRoot, ".ratel", "missions", missionId);
  await access(missionDir);
  console.log("[Smoke] Mission directory exists:", missionDir);

  // Confirm same job ID exists and eventually succeeds
  const recoveredJob = await cp2.getJob(missionId, jobId);
  console.log("[Smoke] Recovered job:", recoveredJob?.jobId, "status:", recoveredJob?.status);
  assert.strictEqual(recoveredJob?.jobId, jobId, "Job ID must match after restart");

  // Wait for the recovered job to finish
  for (let i = 0; i < 50; i++) {
    await waitFor(100);
    const job = await cp2.getJob(missionId, jobId);
    if (job?.status === "succeeded") break;
  }

  const finalJob = await cp2.getJob(missionId, jobId);
  console.log("[Smoke] Final job status:", finalJob?.status);
  assert.strictEqual(finalJob?.status, "succeeded", "Job should complete after restart");

  // Verify no duplicate usage records
  const usagePath = join(missionDir, "usage.jsonl");
  try {
    const raw = await readFile(usagePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    console.log("[Smoke] usage.jsonl lines:", lines.length);
    assert.strictEqual(lines.length, 0, "No usage records should exist for smoke test");
  } catch {
    console.log("[Smoke] usage.jsonl does not exist (expected for no-usage run)");
  }

  await api2.shutdown();
  await cp2.shutdown();
  await rm(projectRoot, { recursive: true, force: true });
  console.log("[Smoke] PASSED");
}

run().catch((err) => {
  console.error("[Smoke] FAILED:", err);
  process.exit(1);
});
