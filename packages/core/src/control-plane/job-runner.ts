import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMissionScope, getMissionDir } from "../core/mission/scope.js";
import { EventLogger } from "../core/observability/event-logger.js";
import { ensureMissionInitialized } from "../core/artifacts.js";
import { OrchestratorAgent } from "../core/orchestrator.js";
import type { MissionJob } from "./types.js";
import type { JobStore } from "./job-store.js";
import { BudgetManager } from "../core/budget/budget-manager.js";
import { getBudgetConfig, getFallbackModelConfig } from "../core/config.js";
import { BudgetExceededError } from "../core/budget/types.js";
import { observeAgentSession } from "../core/observability/session-events.js";
import { ModelRouter } from "../core/models/model-router.js";
import { classifyAgentError } from "../core/models/error-classifier.js";
import {
  NoMissionProgressError,
  hasDurableProgress,
} from "./progress-detector.js";
import type { RatelEvent } from "../core/observability/event-logger.js";

export interface JobExecutor {
  execute(job: MissionJob, signal: AbortSignal): Promise<void>;
}

export interface JobRunnerOptions {
  cwd: string;
  jobStore?: JobStore;
  /** Maximum model failover attempts for orchestrator jobs. Defaults to budget maxModelAttemptsPerRun. */
  maxModelAttempts?: number;
}

export class JobRunner implements JobExecutor {
  constructor(private options: JobRunnerOptions) {}

  async execute(job: MissionJob, signal: AbortSignal): Promise<void> {
    const scope = createMissionScope(this.options.cwd, job.missionId);
    const logger = await EventLogger.forMission(scope);
    await ensureMissionInitialized(scope, logger);

    // Resolve and initialize budget limits
    const budgetLimits = await getBudgetConfig(this.options.cwd, job.payload.budget as import("../core/config.js").MissionBudgetConfig | undefined);
    const budget = new BudgetManager(scope);
    await budget.initialize(budgetLimits);

    // Initialize model router with fallback chain support
    const fallbackConfig = await getFallbackModelConfig(this.options.cwd);
    const models = new ModelRouter({
      projectRoot: this.options.cwd,
      orchestrator: {
        model: fallbackConfig.orchestrator.model ?? "sdk-default",
        fallbackModels: fallbackConfig.orchestrator.fallbackModels ?? [],
      },
      worker: {
        model: fallbackConfig.worker.model ?? "sdk-default",
        fallbackModels: fallbackConfig.worker.fallbackModels ?? [],
      },
      validator: {
        model: fallbackConfig.validator.model ?? "sdk-default",
        fallbackModels: fallbackConfig.validator.fallbackModels ?? [],
      },
      modelRouting: fallbackConfig.modelRouting,
    });
    await models.init();

    const jobControl = this.options.jobStore
      ? {
          markWaitingForApproval: async () => {
            await this.options.jobStore!.markWaitingForApproval(job.missionId, job.jobId);
          },
        }
      : undefined;

    const context = { scope, logger, budget, models, jobControl };

    // Model failover loop for orchestrator jobs
    const candidates = await models.getCandidates("orchestrator");
    const maxAttempts = this.options.maxModelAttempts ?? budgetLimits.maxModelAttemptsPerRun;
    const effectiveMaxAttempts = Math.min(candidates.length, maxAttempts);
    let lastError: Error | undefined;

    for (let attemptIndex = 0; attemptIndex < effectiveMaxAttempts; attemptIndex++) {
      if (signal.aborted) {
        throw new Error("Job aborted");
      }

      const modelString = candidates[attemptIndex];
      const agent = new OrchestratorAgent();

      try {
        // Budget gate: assert can start before prompt
        await budget.assertCanStart("orchestrator");
        await budget.recordAgentStart("orchestrator");

        await agent.init({
          cwd: this.options.cwd,
          missionId: job.missionId,
          inMemory: true,
          model: modelString,
          jobControl,
          budget,
        });

        // Observe agent session for budget usage tracking
        const session = agent.getSession();
        const unsubscribe = observeAgentSession(session, {
          logger,
          agentLevel: "orchestrator",
          parentSpanId: logger.getTraceId(),
          budgetManager: budget,
        });

        // Collect event types for progress detection.
        // We subscribe to the same session to capture tool events that
        // observeAgentSession forwards to the logger.
        const progressEvents: RatelEvent[] = [];
        const progressUnsub = session.subscribe((event) => {
          // We only need event_type for progress detection.
          // Cast the session event to extract what we can.
          const record = event && typeof event === "object" ? event as Record<string, unknown> : null;
          if (record?.type) {
            progressEvents.push({
              timestamp: new Date().toISOString(),
              event_type: String(record.type) as RatelEvent["event_type"],
              trace_id: logger.getTraceId(),
              span_id: "",
              data: {},
            });
          }
        });

        const wallClockSignal = budget.createWallClockAbortSignal(signal);
        const prompt = this.buildPrompt(job);
        await agent.prompt(prompt, wallClockSignal);

        // Flush logger to ensure all events are persisted before we check progress
        await logger.flush();

        // ── Service-mode progress gate ──
        // For orchestrator jobs (start_mission, continue_orchestrator),
        // verify that the turn produced at least one durable progress marker.
        // If not, throw NoMissionProgressError so the control plane does NOT
        // mark the job succeeded.
        if (job.type === "start_mission" || job.type === "continue_orchestrator") {
          if (!hasDurableProgress(progressEvents)) {
            // Also check the logger's flushed events as a fallback.
            // The session subscription may not capture all event types
            // (e.g., artifact_write emitted directly by tools).
            const fileEvents = await readRecentEventsFromFile(scope);
            const allEvents = [...progressEvents, ...fileEvents];

            if (!hasDurableProgress(allEvents)) {
              progressUnsub();
              unsubscribe();
              agent.dispose();
              await logger.shutdown();
              throw new NoMissionProgressError(
                `Orchestrator job ${job.type} completed with no durable progress (${allEvents.length} events seen)`,
                allEvents.length,
              );
            }
          }
        }

        progressUnsub();

        // Success — record circuit success and clean up
        await models.recordSuccess(modelString);
        unsubscribe();
        agent.dispose();
        await logger.shutdown();
        return;
      } catch (err) {
        const classified = classifyAgentError(err);
        lastError = classified.original;

        // Record circuit failure (only retryable ones poison health)
        await models.recordFailure(modelString, classified);

        // Dispose failed orchestrator before constructing next one
        agent.dispose();

        if (!classified.retryable) {
          // Non-retryable error — do not attempt fallback models
          if (err instanceof BudgetExceededError) {
            await this.handleBudgetExceeded(scope, logger, budget, job, err);
          }
          await logger.shutdown();
          throw lastError;
        }

        // Retryable error — if there are more candidates, continue the loop
        if (attemptIndex + 1 >= effectiveMaxAttempts) {
          // Exhausted all candidates
          await logger.shutdown();
          throw lastError;
        }

        // Fresh orchestrator with next model will be constructed on next iteration
        // Do NOT persist private model chat history as canonical mission state
      }
    }

    // Should never reach here, but defensively throw the last error
    await logger.shutdown();
    throw lastError ?? new Error("All model attempts exhausted for orchestrator job");
  }

  private async handleBudgetExceeded(
    scope: import("../core/mission/scope.js").MissionScope,
    logger: EventLogger,
    budget: BudgetManager,
    job: MissionJob,
    error: BudgetExceededError,
  ): Promise<void> {
    // Emit budget exceeded event
    logger.budgetExceeded({
      missionId: scope.missionId,
      reason: error.metric,
      limit: error.limit,
      actual: error.actual,
    });

    // Write halt reason
    const haltPath = join(getMissionDir(scope), "halt-reason.md");
    await writeFile(
      haltPath,
      `# Halted: Budget Exceeded\n\nMetric: ${error.metric}\nLimit: ${error.limit}\nActual: ${error.actual}\nMission: ${scope.missionId}\n`,
      "utf-8",
    );

    // Mark job failed with budget_exceeded code
    if (this.options.jobStore) {
      await this.options.jobStore.markFailed(job.missionId, job.jobId, {
        code: "budget_exceeded",
        message: `Budget exceeded: ${error.metric} (${error.actual} > ${error.limit})`,
        retryable: false,
      });
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

/**
 * Read recent events from the mission's events.jsonl file.
 * Used as a fallback when the in-memory session subscription may miss
 * events emitted directly by tools (e.g., artifact_write).
 */
async function readRecentEventsFromFile(
  scope: import("../core/mission/scope.js").MissionScope,
): Promise<RatelEvent[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { getMissionDir } = await import("../core/mission/scope.js");

    const eventsPath = join(getMissionDir(scope), "events.jsonl");
    const raw = await readFile(eventsPath, "utf-8");
    const lines = raw.trimEnd().split("\n").filter((l) => l.trim().length > 0);

    // Parse the last 50 lines (enough to cover a single orchestrator turn)
    const recent = lines.slice(-50);
    const events: RatelEvent[] = [];
    for (const line of recent) {
      try {
        const parsed = JSON.parse(line) as RatelEvent;
        if (parsed.event_type && parsed.timestamp) {
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}
