import { randomUUID } from "node:crypto";
import { MissionStore } from "./mission-store.js";
import { JobStore } from "./job-store.js";
import { runLegacyMigration } from "./legacy-migration.js";
import type { JobExecutor } from "./job-runner.js";
import type { MissionRecord, MissionJob, MissionJobType } from "./types.js";

export interface CreateMissionInput {
  goal: string;
  idempotencyKey?: string;
}

export interface CreateMissionJobInput {
  missionId: string;
  type: MissionJobType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface MissionControlPlaneOptions {
  cwd: string;
  executor: JobExecutor;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
}

export class MissionControlPlane {
  private missionStore: MissionStore;
  private jobStore: JobStore;
  private executor: JobExecutor;
  private concurrency: number;
  private pollIntervalMs: number;
  private leaseMs: number;
  private ownerId: string;
  private running = false;
  private pumpPromise: Promise<void> | undefined;
  private wakeResolve: (() => void) | undefined;
  private activeJobs = new Map<string, { missionId: string; abortController: AbortController; heartbeatTimer: ReturnType<typeof setInterval>; runPromise: Promise<void> }>();

  constructor(private options: MissionControlPlaneOptions) {
    this.missionStore = new MissionStore(options.cwd);
    this.jobStore = new JobStore(this.missionStore);
    this.executor = options.executor;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.leaseMs = options.leaseMs ?? 30000;
    this.ownerId = `cp_${randomUUID().replace(/-/g, "")}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await runLegacyMigration(this.options.cwd);
    await this.missionStore.initialize();
    await this.jobStore.recoverExpiredJobs();

    this.pumpPromise = this.pumpLoop();
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.wake();

    // Wait for all active executors to finish (or abort) before requeueing.
    // This prevents the same job from being claimed twice concurrently.
    const activeEntries = Array.from(this.activeJobs.entries());
    for (const [jobId, active] of activeEntries) {
      active.abortController.abort();
      clearInterval(active.heartbeatTimer);
      try {
        await active.runPromise;
      } catch {
        // Executor may have thrown; we only care that it finished.
      }
      try {
        await this.jobStore.requeue(active.missionId, jobId, {
          code: "SHUTDOWN",
          message: "Control plane shut down while job was running",
          retryable: true,
        });
      } catch {
        // Ignore requeue errors during shutdown
      }
    }
    this.activeJobs.clear();

    if (this.pumpPromise) {
      await this.pumpPromise;
    }
  }

  async enqueueMission(input: CreateMissionInput): Promise<{ mission: MissionRecord; job: MissionJob }> {
    const { mission } = await this.missionStore.createMission({
      goal: input.goal,
      idempotencyKey: input.idempotencyKey,
    });

    const { job } = await this.jobStore.createJob({
      missionId: mission.missionId,
      type: "start_mission",
      payload: { goal: input.goal },
      maxAttempts: 3,
      idempotencyKey: input.idempotencyKey,
    });

    this.wake();
    return { mission, job };
  }

  async enqueueJob(input: CreateMissionJobInput): Promise<MissionJob> {
    const { job } = await this.jobStore.createJob({
      missionId: input.missionId,
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts ?? 3,
      idempotencyKey: input.idempotencyKey,
    });

    this.wake();
    return job;
  }

  async getMission(missionId: string): Promise<MissionRecord | undefined> {
    return this.missionStore.getMission(missionId);
  }

  async getJob(missionId: string, jobId: string): Promise<MissionJob | undefined> {
    return this.jobStore.getJob(missionId, jobId);
  }

  async cancelJob(missionId: string, jobId: string): Promise<MissionJob> {
    const job = await this.jobStore.requestCancellation(missionId, jobId);

    const active = this.activeJobs.get(jobId);
    if (active) {
      active.abortController.abort();
    }

    if (job.status !== "running") {
      return this.jobStore.markCancelled(missionId, jobId);
    }

    return job;
  }

  async submitApproval(
    missionId: string,
    decision: { approved: boolean; feedback?: string; files?: Record<string, string> }
  ): Promise<MissionJob> {
    // Validate filenames
    if (decision.files) {
      for (const filename of Object.keys(decision.files)) {
        if (filename.includes("..") || filename.startsWith("/") || filename.includes("\\")) {
          throw new Error(`Invalid filename: ${filename}`);
        }
      }
    }

    const jobs = await this.jobStore.listJobs(missionId);
    const waitingJob = jobs.find((j) => j.status === "waiting_for_approval");
    if (!waitingJob) {
      throw new Error(`No waiting job found for mission ${missionId}`);
    }

    await this.jobStore.markSucceeded(missionId, waitingJob.jobId);

    const message = decision.approved
      ? `User approved the plan. Feedback: ${decision.feedback ?? "None"}`
      : `User rejected the plan. Feedback: ${decision.feedback ?? "None"}`;

    const { job: nextJob } = await this.jobStore.createJob({
      missionId,
      type: "continue_orchestrator",
      payload: { message, approval: decision },
      maxAttempts: 3,
    });

    this.wake();
    return nextJob;
  }

  private wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = undefined;
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      setTimeout(() => {
        if (this.wakeResolve === resolve) {
          this.wakeResolve = undefined;
        }
        resolve();
      }, ms);
    });
  }

  private async pumpLoop(): Promise<void> {
    while (this.running) {
      if (this.activeJobs.size >= this.concurrency) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      const job = await this.jobStore.claimNextJob(this.ownerId, this.leaseMs);
      if (!job) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      // Check if this mission already has an active job
      const missionHasActiveJob = Array.from(this.activeJobs.values()).some(
        (a) => a.missionId === job.missionId
      );
      if (missionHasActiveJob) {
        // Requeue the job immediately so another worker can claim it
        await this.jobStore.requeue(job.missionId, job.jobId, {
          code: "MISSION_SERIAL",
          message: "Mission already has an active job",
          retryable: true,
        });
        this.wake();
        continue;
      }

      // Run job asynchronously (fire-and-forget from pump perspective)
      this.runJob(job).catch(() => {
        // Errors are handled inside runJob
      });
    }
  }

  private async runJob(job: MissionJob): Promise<void> {
    const abortController = new AbortController();
    const heartbeatTimer = setInterval(async () => {
      try {
        await this.jobStore.heartbeat(job.missionId, job.jobId, this.ownerId, this.leaseMs);
      } catch {
        abortController.abort();
      }
    }, Math.max(this.leaseMs / 2, 250));

    const runPromise = this.executor.execute(job, abortController.signal);
    this.activeJobs.set(job.jobId, { missionId: job.missionId, abortController, heartbeatTimer, runPromise });

    try {
      await runPromise;
      await this.jobStore.markSucceeded(job.missionId, job.jobId);
    } catch (err) {
      const isAbort = err instanceof Error && /abort/i.test(err.message);
      if (isAbort) {
        // Check if cancellation was explicitly requested
        const currentJob = await this.jobStore.getJob(job.missionId, job.jobId);
        if (currentJob?.cancellationRequestedAt) {
          await this.jobStore.markCancelled(job.missionId, job.jobId);
        } else {
          await this.jobStore.requeue(job.missionId, job.jobId, {
            code: "ABORT",
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          });
        }
      } else {
        const error = {
          code: err instanceof Error ? err.name : "UNKNOWN",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        };
        await this.jobStore.requeue(job.missionId, job.jobId, error);
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.activeJobs.delete(job.jobId);
      this.wake();
    }
  }
}
