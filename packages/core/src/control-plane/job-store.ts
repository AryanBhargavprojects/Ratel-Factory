import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteJson, readJsonFile } from "../core/mission/atomic-file.js";
import { withFileLock } from "./mutex.js";
import { MissionStore } from "./mission-store.js";
import type { MissionJob, MissionJobStatus, MissionJobType } from "./types.js";

export class JobTransitionError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly from: string,
    public readonly to: string,
    public readonly reason: string
  ) {
    super(`Invalid transition for job ${jobId}: ${from} -> ${to}. ${reason}`);
  }
}

function generateJobId(): string {
  return `job_${randomUUID().replace(/-/g, "")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

export class JobStore {
  constructor(private missions: MissionStore) {}

  private getJobsDir(missionId: string): string {
    return join(this.missions.projectRoot, ".ratel", "missions", missionId, "jobs");
  }

  private getJobPath(missionId: string, jobId: string): string {
    return join(this.getJobsDir(missionId), `${jobId}.json`);
  }

  private getIdempotencyPath(key: string): string {
    return join(this.missions.projectRoot, ".ratel", "idempotency", `${sha256(key)}.json`);
  }

  async createJob(input: {
    missionId: string;
    type: MissionJobType;
    payload: Record<string, unknown>;
    maxAttempts: number;
    idempotencyKey?: string;
  }): Promise<{ job: MissionJob; created: boolean }> {
    const mission = await this.missions.getMission(input.missionId);
    if (!mission) {
      throw new Error(`Mission does not exist: ${input.missionId}`);
    }

    if (input.idempotencyKey) {
      const idemPath = this.getIdempotencyPath(input.idempotencyKey);
      return withFileLock(idemPath, async () => {
        const existing = await readJsonFile<{ missionId: string; jobId: string }>(idemPath);
        if (existing && existing.missionId === input.missionId) {
          const job = await this.getJob(input.missionId, existing.jobId);
          if (job) {
            return { job, created: false };
          }
        }
        return this.createJobInner(input);
      });
    }

    return this.createJobInner(input);
  }

  private async createJobInner(input: {
    missionId: string;
    type: MissionJobType;
    payload: Record<string, unknown>;
    maxAttempts: number;
    idempotencyKey?: string;
  }): Promise<{ job: MissionJob; created: boolean }> {
    const jobId = generateJobId();
    const now = nowIso();
    const job: MissionJob = {
      jobId,
      missionId: input.missionId,
      type: input.type,
      payload: input.payload,
      status: "queued",
      attempt: 0,
      maxAttempts: input.maxAttempts,
      createdAt: now,
      updatedAt: now,
    };

    const jobPath = this.getJobPath(input.missionId, jobId);
    await withFileLock(jobPath, async () => {
      await mkdir(this.getJobsDir(input.missionId), { recursive: true });
      await atomicWriteJson(jobPath, job);
    });

    if (input.idempotencyKey) {
      const idemPath = this.getIdempotencyPath(input.idempotencyKey);
      await withFileLock(idemPath, async () => {
        await atomicWriteJson(idemPath, { missionId: input.missionId, jobId });
      });
    }

    return { job, created: true };
  }

  async getJob(missionId: string, jobId: string): Promise<MissionJob | undefined> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      return await readJsonFile<MissionJob>(path);
    });
  }

  async listJobs(missionId: string): Promise<MissionJob[]> {
    const entries: MissionJob[] = [];
    try {
      const dir = this.getJobsDir(missionId);
      const files = await readdir(dir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const jobId = file.name.slice(0, -5); // remove .json
        const job = await this.getJob(missionId, jobId);
        if (job) {
          entries.push(job);
        }
      }
    } catch {
      // Directory may not exist yet
    }
    // Sort by createdAt, then jobId
    entries.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      return cmp !== 0 ? cmp : a.jobId.localeCompare(b.jobId);
    });
    return entries;
  }

  async claimNextJob(ownerId: string, leaseMs: number): Promise<MissionJob | undefined> {
    const missions = await this.missions.listMissions();
    const now = new Date();
    const nowIso = now.toISOString();

    for (const mission of missions) {
      const jobs = await this.listJobs(mission.missionId);
      const candidates = jobs.filter((j) => {
        if (j.status === "queued") return true;
        if (j.status === "running" && j.leaseExpiresAt && j.leaseExpiresAt < nowIso) {
          return true;
        }
        return false;
      });

      // Sort by createdAt, then jobId
      candidates.sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt);
        return cmp !== 0 ? cmp : a.jobId.localeCompare(b.jobId);
      });

      for (const candidate of candidates) {
        const path = this.getJobPath(candidate.missionId, candidate.jobId);
        try {
          return await withFileLock(path, async () => {
            const current = await readJsonFile<MissionJob>(path);
            if (!current) return undefined;

            // Re-check eligibility under lock
            if (current.status === "queued") {
              // OK
            } else if (current.status === "running" && current.leaseExpiresAt && current.leaseExpiresAt < nowIso) {
              // OK - expired lease
            } else {
              return undefined; // Another worker claimed it
            }

            const updated: MissionJob = {
              ...current,
              status: "running",
              attempt: current.attempt + 1,
              leaseOwner: ownerId,
              leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
              startedAt: current.startedAt || nowIso,
              updatedAt: nowIso,
            };
            await atomicWriteJson(path, updated);
            return updated;
          });
        } catch {
          // Continue to next candidate
        }
      }
    }
    return undefined;
  }

  async heartbeat(
    missionId: string,
    jobId: string,
    ownerId: string,
    leaseMs: number
  ): Promise<MissionJob> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionJob>(path);
      if (!current) {
        throw new Error(`Job ${jobId} not found`);
      }
      if (current.status !== "running") {
        throw new JobTransitionError(jobId, current.status, "running", "Job is not running");
      }
      if (current.leaseOwner !== ownerId) {
        throw new Error(`Job ${jobId} is owned by ${current.leaseOwner}, not ${ownerId}`);
      }
      const updated: MissionJob = {
        ...current,
        leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: nowIso(),
      };
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async markWaitingForApproval(missionId: string, jobId: string): Promise<MissionJob> {
    return this.transition(missionId, jobId, "running", "waiting_for_approval", (job) => ({
      ...job,
      finishedAt: nowIso(),
    }));
  }

  async markSucceeded(missionId: string, jobId: string): Promise<MissionJob> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionJob>(path);
      if (!current) {
        throw new Error(`Job ${jobId} not found`);
      }
      const allowedFrom: MissionJobStatus[] = ["running", "waiting_for_approval"];
      if (!allowedFrom.includes(current.status)) {
        throw new JobTransitionError(
          jobId,
          current.status,
          "succeeded",
          `Expected status ${allowedFrom.join(" or ")}`
        );
      }
      const updated: MissionJob = {
        ...current,
        status: "succeeded",
        finishedAt: nowIso(),
        updatedAt: nowIso(),
      };
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async markFailed(
    missionId: string,
    jobId: string,
    error: MissionJob["error"]
  ): Promise<MissionJob> {
    return this.transition(missionId, jobId, "running", "failed", (job) => ({
      ...job,
      finishedAt: nowIso(),
      error,
    }));
  }

  async requeue(missionId: string, jobId: string, error: MissionJob["error"]): Promise<MissionJob> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionJob>(path);
      if (!current) {
        throw new Error(`Job ${jobId} not found`);
      }
      if (current.status !== "running") {
        throw new JobTransitionError(jobId, current.status, "queued", "Can only requeue from running");
      }

      const isRetryable = error?.retryable ?? true;
      const canRetry = current.attempt < current.maxAttempts;

      if (!isRetryable || !canRetry) {
        const updated: MissionJob = {
          ...current,
          status: "failed",
          finishedAt: nowIso(),
          error,
          updatedAt: nowIso(),
        };
        await atomicWriteJson(path, updated);
        return updated;
      }

      const updated: MissionJob = {
        ...current,
        status: "queued",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        error,
        updatedAt: nowIso(),
      };
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async requestCancellation(missionId: string, jobId: string): Promise<MissionJob> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionJob>(path);
      if (!current) {
        throw new Error(`Job ${jobId} not found`);
      }
      if (current.status === "cancelled") {
        return current;
      }
      const updated: MissionJob = {
        ...current,
        cancellationRequestedAt: nowIso(),
        updatedAt: nowIso(),
      };
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async markCancelled(missionId: string, jobId: string): Promise<MissionJob> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionJob>(path);
      if (!current) {
        throw new Error(`Job ${jobId} not found`);
      }
      if (current.status === "cancelled") {
        return current;
      }
      const allowedFrom: MissionJobStatus[] = ["queued", "running", "waiting_for_approval", "succeeded", "failed"];
      if (!allowedFrom.includes(current.status)) {
        throw new JobTransitionError(
          jobId,
          current.status,
          "cancelled",
          `Can only cancel from ${allowedFrom.join(", ")}`
        );
      }
      const updated: MissionJob = {
        ...current,
        status: "cancelled",
        finishedAt: nowIso(),
        updatedAt: nowIso(),
      };
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async recoverExpiredJobs(now: Date = new Date()): Promise<MissionJob[]> {
    const missions = await this.missions.listMissions();
    const nowIso = now.toISOString();
    const recovered: MissionJob[] = [];

    for (const mission of missions) {
      const jobs = await this.listJobs(mission.missionId);
      const expired = jobs.filter(
        (j) => j.status === "running" && j.leaseExpiresAt && j.leaseExpiresAt < nowIso
      );

      for (const job of expired) {
        const path = this.getJobPath(job.missionId, job.jobId);
        try {
          const updated = await withFileLock(path, async () => {
            const current = await readJsonFile<MissionJob>(path);
            if (!current) return undefined;
            if (current.status !== "running" || !current.leaseExpiresAt || current.leaseExpiresAt >= nowIso) {
              return undefined;
            }
            // Do not reclaim if attempts exhausted
            if (current.attempt >= current.maxAttempts) {
              const failed: MissionJob = {
                ...current,
                status: "failed",
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                updatedAt: nowIso,
                error: {
                  code: "LEASE_EXPIRED",
                  message: "Job lease expired and max attempts exhausted.",
                  retryable: false,
                },
              };
              await atomicWriteJson(path, failed);
              return failed;
            }
            const next: MissionJob = {
              ...current,
              status: "queued",
              leaseOwner: undefined,
              leaseExpiresAt: undefined,
              updatedAt: nowIso,
            };
            await atomicWriteJson(path, next);
            return next;
          });
          if (updated) {
            recovered.push(updated);
          }
        } catch {
          // Continue
        }
      }
    }

    return recovered;
  }

  private async transition(
    missionId: string,
    jobId: string,
    expectedFrom: MissionJobStatus,
    to: MissionJobStatus,
    mutator?: (job: MissionJob) => Partial<MissionJob>
  ): Promise<MissionJob> {
    const path = this.getJobPath(missionId, jobId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionJob>(path);
      if (!current) {
        throw new Error(`Job ${jobId} not found`);
      }
      if (current.status !== expectedFrom) {
        throw new JobTransitionError(
          jobId,
          current.status,
          to,
          `Expected status ${expectedFrom}`
        );
      }
      const updated: MissionJob = {
        ...current,
        ...mutator?.(current),
        status: to,
        updatedAt: nowIso(),
      };
      await atomicWriteJson(path, updated);
      return updated;
    });
  }
}
