/**
 * Deterministic TypeScript User-Testing Coordinator.
 *
 * The orchestrator calls run_user_testing(milestoneId).
 * The coordinator owns mechanics: shard planning, concurrency, timeouts,
 * artifact paths, parsing, and aggregation.
 * Shard agents own browser testing, judgment, and severity.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  UserTestingShard,
  UserTestingShardReport,
  UserTestingShardRunResult,
  UserTestingReport,
  Feature,
  ReportSource,
} from "../types.js";
import { createReportReceiver, persistSubmittedReport } from "../report-submission.js";
import { EmptyOutputError } from "../models/error-classifier.js";
import { extractLastJsonLine, writeRawOutput } from "../utils/jsonl.js";
import { getUserTestingConfig } from "../config.js";
import type { EventLogger } from "../observability/event-logger.js";
import { listFeatureFiles, readFeatureFile } from "../artifacts.js";
import { spawnUserTestingShardAgent } from "../workers/validators.js";
import type { MissionScope } from "../mission/scope.js";
import { getMissionDir } from "../mission/scope.js";

/**
 * Parse assertion references into file + optional scenario selectors.
 */
export function parseAssertionRef(ref: string): { file: string; selector?: string } {
  const colonIndex = ref.indexOf(":");
  if (colonIndex === -1) {
    return { file: ref.trim() };
  }
  const file = ref.slice(0, colonIndex).trim();
  const selector = ref.slice(colonIndex + 1).trim();
  return { file, selector: selector.length > 0 ? selector : undefined };
}

/**
 * Build shards from completed feature assertions.
 * One shard per unique .feature file.
 */
export async function buildShards(
  scope: MissionScope,
  milestoneId: string,
  features: Feature[],
  basePort: number,
  shardTimeoutMs: number,
): Promise<{ shards: UserTestingShard[]; unresolvedRefs: string[]; coverageStatus: "complete" | "incomplete" }> {
  // Collect all assertion references from integrated or validated features in this milestone
  const allRefs: string[] = [];
  for (const feature of features) {
    if (feature.milestoneId === milestoneId && (feature.status === "integrated" || feature.status === "validated")) {
      allRefs.push(...feature.assertions);
    }
  }

  // Deduplicate refs while preserving order
  const seenRefs = new Set<string>();
  const uniqueRefs: string[] = [];
  for (const ref of allRefs) {
    if (!seenRefs.has(ref)) {
      seenRefs.add(ref);
      uniqueRefs.push(ref);
    }
  }

  // Parse refs and group by file
  const byFile = new Map<string, { selectors: Set<string>; featureIds: Set<string> }>();
  for (const ref of uniqueRefs) {
    const parsed = parseAssertionRef(ref);
    const entry = byFile.get(parsed.file) ?? { selectors: new Set<string>(), featureIds: new Set<string>() };
    if (parsed.selector) {
      entry.selectors.add(parsed.selector);
    }
    byFile.set(parsed.file, entry);
  }

  // Map features to files for featureIds
  for (const feature of features) {
    if (feature.milestoneId === milestoneId && (feature.status === "integrated" || feature.status === "validated")) {
      for (const ref of feature.assertions) {
        const { file } = parseAssertionRef(ref);
        const entry = byFile.get(file);
        if (entry) {
          entry.featureIds.add(feature.id);
        }
      }
    }
  }

  // Check which files actually exist
  const availableFeatureFiles = await listFeatureFiles(scope);
  const availableSet = new Set(availableFeatureFiles);
  const unresolvedRefs: string[] = [];
  const resolvedFiles = new Map<string, { selectors: Set<string>; featureIds: Set<string> }>();

  for (const [file, data] of byFile.entries()) {
    if (availableSet.has(file)) {
      resolvedFiles.set(file, data);
    } else {
      unresolvedRefs.push(file);
    }
  }

  // If no refs at all, return empty with incomplete
  if (uniqueRefs.length === 0) {
    return { shards: [], unresolvedRefs: [], coverageStatus: "incomplete" };
  }

  // Build shards
  const shards: UserTestingShard[] = [];
  let port = basePort;
  let shardIndex = 0;
  for (const [file, data] of resolvedFiles.entries()) {
    shards.push({
      shardId: `shard-${shardIndex + 1}`,
      milestoneId,
      featureFile: file,
      scenarioSelectors: Array.from(data.selectors),
      featureIds: Array.from(data.featureIds),
      screenshotDir: join(getMissionDir(scope), "validation-reports", "screenshots", milestoneId, file.replace(/\.feature$/, "")),
      assignedPort: port++,
      timeoutMs: shardTimeoutMs,
    });
    shardIndex++;
  }

  const coverageStatus: "complete" | "incomplete" =
    unresolvedRefs.length > 0 || shards.length === 0 ? "incomplete" : "complete";

  return { shards, unresolvedRefs, coverageStatus };
}

function isValidShardReport(obj: unknown): obj is UserTestingShardReport {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  return (
    r.validatorType === "user-testing-shard" &&
    typeof r.milestoneId === "string" &&
    typeof r.shardId === "string" &&
    Array.isArray(r.scenarioResults)
  );
}

/**
 * Run a single shard agent with timeout and structured submission.
 */
export async function runShard(
  scope: MissionScope,
  shard: UserTestingShard,
  model: string | undefined,
  runId: string,
  logger?: EventLogger,
  budgetManager?: import("../budget/budget-manager.js").BudgetManager,
): Promise<UserTestingShardRunResult> {
  const startTime = Date.now();
  const rawFilename = `user-testing-shards/${runId}/${shard.shardId}.raw.txt`;

  // Parent span for coordinator, child span for shard
  const parentSpanId = logger?.agentSpanStart("user_testing_validator", {
    agentType: "user_testing_coordinator",
    milestoneId: shard.milestoneId,
  });

  let responseText = "";
  let timedOut = false;
  let error: string | undefined;
  let failureCategory: "empty_output" | "parse_failure" | undefined;
  let shardReceiver: ReturnType<typeof import("../workers/validators.js").createSubmitUserTestingShardReportTool>["receiver"] | undefined;

  try {
    const shardResult = await spawnUserTestingShardAgent(shard, scope.projectRoot, model, logger, parentSpanId, budgetManager);
    responseText = shardResult.response;
    shardReceiver = shardResult.receiver;
  } catch (err) {
    if (err instanceof EmptyOutputError) {
      // 0-byte output after retry: classify as `empty_output` (infrastructure
      // failure), NOT parse_failure.
      failureCategory = "empty_output";
      error = err.message;
      timedOut = false;
    } else {
      error = err instanceof Error ? err.message : String(err);
      timedOut = error.includes("timeout");
    }
  }

  // Persist raw output
  await writeRawOutput(scope, "validation-reports", rawFilename, responseText || error || "");

  // Try to parse JSONL fallback if no tool submission
  let report: UserTestingShardReport | null = null;
  let reportSource: ReportSource = "missing";

  const submissionResult = shardReceiver?.getResult();
  if (submissionResult?.report && submissionResult.source === "tool_submission") {
    report = submissionResult.report;
    reportSource = "tool_submission";
    const artifactPath = `validation-reports/user-testing-shards/${runId}/${shard.shardId}.json`;
    await persistSubmittedReport(scope, artifactPath, report);
  } else {
    const parseResult = extractLastJsonLine<UserTestingShardReport>(responseText, isValidShardReport);
    if (parseResult.parseStatus === "ok" && parseResult.data) {
      report = parseResult.data;
      reportSource = "jsonl_fallback";
    }
  }

  const durationMs = Date.now() - startTime;

  if (parentSpanId) {
    logger?.agentSpanEnd("user_testing_validator", parentSpanId, {
      milestoneId: shard.milestoneId,
      durationMs,
      parseStatus: report ? "ok" : "failed",
    });
  }

  // If the shard produced no text at all, keep `empty_output` classification
  // instead of letting the missing report collapse into a generic parse_failure.
  if (!report && failureCategory === undefined && error) {
    failureCategory = "parse_failure";
  }

  return {
    shard,
    parseStatus: report ? "ok" : "failed",
    reportSource,
    rawFilename,
    reportPath: reportSource === "tool_submission" ? `validation-reports/user-testing-shards/${runId}/${shard.shardId}.json` : undefined,
    report,
    durationMs,
    timedOut,
    error,
    failureCategory,
  };
}

/**
 * Run all shards with bounded concurrency.
 */
export async function runShards(
  scope: MissionScope,
  shards: UserTestingShard[],
  model: string | undefined,
  maxConcurrency: number,
  logger?: EventLogger,
): Promise<UserTestingShardRunResult[]> {
  const runId = `${Date.now()}`;
  const results: UserTestingShardRunResult[] = [];

  if (maxConcurrency <= 1) {
    for (const shard of shards) {
      results.push(await runShard(scope, shard, model, runId, logger));
    }
  } else {
    // Bounded concurrency: start up to maxConcurrency at once, then
    // refill slots as each shard completes.
    const queue = [...shards];
    const running = new Map<string, Promise<void>>();

    async function runOne(shard: UserTestingShard): Promise<void> {
      results.push(await runShard(scope, shard, model, runId, logger));
    }

    // Seed initial batch
    while (running.size < maxConcurrency && queue.length > 0) {
      const shard = queue.shift()!;
      const p = runOne(shard).finally(() => running.delete(shard.shardId));
      running.set(shard.shardId, p);
    }

    // As slots free up, pull from queue
    while (queue.length > 0 || running.size > 0) {
      if (running.size === 0) break;
      await Promise.race(running.values());
      while (running.size < maxConcurrency && queue.length > 0) {
        const shard = queue.shift()!;
        const p = runOne(shard).finally(() => running.delete(shard.shardId));
        running.set(shard.shardId, p);
      }
    }
  }

  return results;
}

/**
 * Aggregate shard results into a UserTestingReport.
 */
export function aggregateShardResults(
  milestoneId: string,
  shards: UserTestingShardRunResult[],
  unresolvedRefs: string[],
): UserTestingReport {
  const scenarioResults: UserTestingReport["scenarioResults"] = [];
  const issues: UserTestingReport["issues"] = [];
  const shardSummaries: string[] = [];
  let totalDurationMs = 0;

  const shardMetas: NonNullable<UserTestingReport["shards"]> = [];

  for (const result of shards) {
    if (result.report) {
      scenarioResults.push(...result.report.scenarioResults);

      // Deduplicate issue IDs by prefixing with shard ID
      for (const issue of result.report.issues) {
        issues.push({
          ...issue,
          id: `${result.shard.shardId}-${issue.id}`,
        });
      }

      shardSummaries.push(result.report.summary);
    }

    shardMetas.push({
      shardId: result.shard.shardId,
      featureFiles: [result.shard.featureFile],
      parseStatus: result.parseStatus,
      reportSource: result.reportSource,
      rawFilename: result.rawFilename,
      reportPath: result.reportPath,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      scenarioCount: result.report?.scenarioResults.length ?? 0,
      issueCount: result.report?.issues.length ?? 0,
    });

    totalDurationMs += result.durationMs;
  }

  const anyFailed = shards.some((s) => s.parseStatus === "failed" || s.timedOut);
  const coverageStatus: "complete" | "incomplete" =
    shards.length === 0 || unresolvedRefs.length > 0 || anyFailed ? "incomplete" : "complete";

  const totalShards = shards.length;
  const okShards = shards.filter((s) => s.parseStatus === "ok" && !s.timedOut).length;

  const summary =
    `User testing for ${milestoneId}: ${totalShards} shard(s) assigned, ${okShards} report(s) received, ${totalShards - okShards} incomplete, ` +
    `${scenarioResults.length} scenario(s) reported, ${issues.length} model-reported issue(s).`;

  return {
    validatorType: "user-testing",
    milestoneId,
    createdAt: new Date().toISOString(),
    appStartCommand: shards[0]?.report?.appStartCommand ?? "npm run dev",
    baseURL: shards[0]?.report?.baseURL ?? "http://localhost:3000",
    scenarioResults,
    issues,
    summary,
    coverageStatus,
    shards: shardMetas,
  };
}

/**
 * Main entry point: deterministic coordinator for user testing.
 */
export async function runUserTestingCoordinator(
  scope: MissionScope,
  milestoneId: string,
  features: Feature[],
  model: string | undefined,
  logger?: EventLogger,
  budgetManager?: import("../budget/budget-manager.js").BudgetManager,
): Promise<{
  parseStatus: "ok" | "failed";
  coordinatorStatus: "complete" | "incomplete";
  report: UserTestingReport;
  shards: UserTestingShardRunResult[];
}> {
  const config = await getUserTestingConfig(scope.projectRoot);

  const { shards, unresolvedRefs, coverageStatus: buildCoverage } = await buildShards(
    scope,
    milestoneId,
    features,
    config.basePort,
    config.shardTimeoutMs,
  );

  if (shards.length === 0) {
    const report = aggregateShardResults(milestoneId, [], unresolvedRefs);
    return {
      parseStatus: "ok",
      coordinatorStatus: "incomplete",
      report,
      shards: [],
    };
  }

  const shardResults = await runShards(scope, shards, model, config.maxConcurrency, logger);
  const report = aggregateShardResults(milestoneId, shardResults, unresolvedRefs);

  const anyParseFailed = shardResults.some((s) => s.parseStatus === "failed");
  const anyTimedOut = shardResults.some((s) => s.timedOut);
  const coordinatorStatus: "complete" | "incomplete" =
    buildCoverage === "incomplete" || anyParseFailed || anyTimedOut ? "incomplete" : "complete";

  return {
    parseStatus: "ok",
    coordinatorStatus,
    report,
    shards: shardResults,
  };
}
