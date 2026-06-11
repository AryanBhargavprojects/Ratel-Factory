/**
 * Structured report submission infrastructure.
 * Session-scoped receivers validate and persist canonical reports from agents.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerHandoff, ScrutinyReport, UserTestingShardReport, ReportSource } from "./types.js";
import { WorkerHandoffSchema, ScrutinyReportSchema, UserTestingShardReportSchema, validateSchema } from "./schema/report-schemas.js";

export interface ReportSubmissionResult<T> {
  source: ReportSource;
  report: T | null;
  artifactPath?: string;
  submissionCount: number;
  error?: string;
}

interface SubmissionState<T> {
  latestValid: T | null;
  submissionCount: number;
  latestError?: string;
}

/**
 * Create a session-scoped report receiver for a specific role and assignment.
 */
export function createReportReceiver<T extends { featureId?: string; milestoneId?: string; shardId?: string }>(options: {
  role: "worker" | "scrutiny" | "user-testing-shard";
  assignment: { featureId?: string; milestoneId?: string; shardId?: string };
  artifactPath?: string;
}): {
  submit: (report: unknown) => { accepted: boolean; error?: string };
  getResult: () => ReportSubmissionResult<T>;
} {
  const state: SubmissionState<T> = {
    latestValid: null,
    submissionCount: 0,
  };

  function validateAssignment(report: T): boolean {
    if (options.assignment.featureId && (report as unknown as Record<string, unknown>).featureId !== options.assignment.featureId) {
      return false;
    }
    if (options.assignment.milestoneId && (report as unknown as Record<string, unknown>).milestoneId !== options.assignment.milestoneId) {
      return false;
    }
    if (options.assignment.shardId && (report as unknown as Record<string, unknown>).shardId !== options.assignment.shardId) {
      return false;
    }
    return true;
  }

  return {
    submit: (report: unknown) => {
      state.submissionCount++;

      // Schema validation based on role
      let schemaResult: { valid: true } | { valid: false; errors: string[] };
      if (options.role === "worker") {
        schemaResult = validateSchema(WorkerHandoffSchema, report);
      } else if (options.role === "scrutiny") {
        schemaResult = validateSchema(ScrutinyReportSchema, report);
      } else {
        schemaResult = validateSchema(UserTestingShardReportSchema, report);
      }

      if (!schemaResult.valid) {
        const error = `Schema validation failed: ${schemaResult.errors.join("; ")}`;
        state.latestError = error;
        return { accepted: false, error };
      }

      const typedReport = report as T;

      if (!validateAssignment(typedReport)) {
        const error = `Assignment mismatch: expected featureId=${options.assignment.featureId ?? "any"}, milestoneId=${options.assignment.milestoneId ?? "any"}, shardId=${options.assignment.shardId ?? "any"}`;
        state.latestError = error;
        return { accepted: false, error };
      }

      state.latestValid = typedReport;
      state.latestError = undefined;
      return { accepted: true };
    },
    getResult: () => {
      if (state.latestValid) {
        return {
          source: "tool_submission" as ReportSource,
          report: state.latestValid,
          artifactPath: options.artifactPath,
          submissionCount: state.submissionCount,
        };
      }
      return {
        source: "missing" as ReportSource,
        report: null,
        artifactPath: options.artifactPath,
        submissionCount: state.submissionCount,
        error: state.latestError,
      };
    },
  };
}

/**
 * Persist a submitted report to its canonical artifact path.
 */
export async function persistSubmittedReport(cwd: string, relativePath: string, report: unknown): Promise<void> {
  const fullPath = join(cwd, ".missions", "current", relativePath);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, JSON.stringify(report, null, 2), "utf-8");
}

/**
 * Build a deterministic receipt path for a worker run.
 */
export function workerReceiptPath(featureId: string): string {
  return `worker-runs/${featureId}.json`;
}

/**
 * Persist a worker run receipt.
 */
export async function persistWorkerReceipt(
  cwd: string,
  receipt: import("./types.js").WorkerRunReceipt,
): Promise<void> {
  const path = workerReceiptPath(receipt.featureId);
  const fullPath = join(cwd, ".missions", "current", path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, JSON.stringify(receipt, null, 2), "utf-8");
}

/**
 * Read the latest worker receipt for a feature.
 */
export async function readWorkerReceipt(
  cwd: string,
  featureId: string,
): Promise<import("./types.js").WorkerRunReceipt | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const fullPath = join(cwd, ".missions", "current", workerReceiptPath(featureId));
    const raw = await readFile(fullPath, "utf-8");
    return JSON.parse(raw) as import("./types.js").WorkerRunReceipt;
  } catch {
    return undefined;
  }
}
