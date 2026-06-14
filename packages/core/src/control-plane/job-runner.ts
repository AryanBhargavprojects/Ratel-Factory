import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMissionScope } from "../core/mission/scope.js";
import { EventLogger } from "../core/observability/event-logger.js";
import { ensureMissionInitialized } from "../core/artifacts.js";
import { OrchestratorAgent } from "../core/orchestrator.js";
import type { MissionJob } from "./types.js";
import type { JobStore } from "./job-store.js";

export interface JobExecutor {
  execute(job: MissionJob, signal: AbortSignal): Promise<void>;
}

export interface JobRunnerOptions {
  cwd: string;
  jobStore?: JobStore;
}

export class JobRunner implements JobExecutor {
  constructor(private options: JobRunnerOptions) {}

  async execute(job: MissionJob, signal: AbortSignal): Promise<void> {
    const scope = createMissionScope(this.options.cwd, job.missionId);
    const logger = await EventLogger.forMission(scope);
    await ensureMissionInitialized(scope, logger);

    const jobControl = this.options.jobStore
      ? {
          markWaitingForApproval: async () => {
            await this.options.jobStore!.markWaitingForApproval(job.missionId, job.jobId);
          },
        }
      : undefined;

    const agent = new OrchestratorAgent();
    await agent.init({
      cwd: this.options.cwd,
      missionId: job.missionId,
      inMemory: true,
      jobControl,
    });

    try {
      if (signal.aborted) {
        throw new Error("Job aborted");
      }

      const prompt = this.buildPrompt(job);
      await agent.prompt(prompt);
    } finally {
      agent.dispose();
      await logger.shutdown();
    }
  }

  private buildPrompt(job: MissionJob): string {
    const payload = job.payload;
    switch (job.type) {
      case "start_mission":
        return String(payload.goal ?? "");
      case "continue_orchestrator":
        return String(payload.message ?? "");
      case "run_worker":
        return `Run worker for feature ${payload.featureId}`;
      case "run_validation":
        return `Run scrutiny validation for milestone ${payload.milestoneId}`;
      case "run_user_testing":
        return `Run user testing for milestone ${payload.milestoneId}`;
      default:
        return "";
    }
  }
}
