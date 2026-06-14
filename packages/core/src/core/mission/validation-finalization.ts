/**
 * Validation finalization gate.
 * The orchestrator decides WHEN to request milestone validation.
 * This module decides WHETHER the milestone can be validated and transitions
 * integrated features to validated.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MissionScope } from "./scope.js";
import { readFeatures, writeFeatures, readMilestones, writeMilestones, readValidationReport, readUserTestingReport } from "../artifacts.js";
import { getMissionDir } from "./scope.js";
import { atomicWriteJson } from "../mission/atomic-file.js";
import type { ScrutinyReport, UserTestingReport, Feature } from "../types.js";

export interface ValidationFinalizationResult {
  success: boolean;
  milestoneId: string;
  featureIds: string[];
  errors: string[];
  receiptPath?: string;
}

function isBlocking(issue: { severity: string }): boolean {
  return issue.severity === "blocking";
}

async function getFileMtimeMs(scope: MissionScope, filename: string): Promise<number | undefined> {
  try {
    const s = await stat(join(getMissionDir(scope), "validation-reports", filename));
    return s.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Evaluate whether a milestone can be validated.
 */
export async function evaluateMilestoneValidation(
  scope: MissionScope,
  input: {
    milestoneId: string;
    scrutinyReportFilename: string;
    userTestingReportFilename: string;
  },
): Promise<ValidationFinalizationResult> {
  const errors: string[] = [];
  const featureIds: string[] = [];

  // 1. Milestone exists
  const milestones = await readMilestones(scope);
  if (!milestones) {
    return { success: false, milestoneId: input.milestoneId, featureIds: [], errors: ["No milestones.json found."] };
  }
  const milestone = milestones.find((m) => m.id === input.milestoneId);
  if (!milestone) {
    return { success: false, milestoneId: input.milestoneId, featureIds: [], errors: [`Milestone ${input.milestoneId} not found.`] };
  }

  // 2. Every milestone feature is integrated or validated
  const features = await readFeatures(scope);
  if (!features) {
    return { success: false, milestoneId: input.milestoneId, featureIds: [], errors: ["No features.json found."] };
  }
  const milestoneFeatures = features.filter((f) => f.milestoneId === input.milestoneId);
  for (const feature of milestoneFeatures) {
    if (feature.status === "pending" || feature.status === "in_progress" || feature.status === "blocked") {
      errors.push(`Feature ${feature.id} is "${feature.status}". All features must be integrated or validated before validation.`);
    } else if (feature.status === "integrated" || feature.status === "validated") {
      if (feature.status === "integrated") {
        featureIds.push(feature.id);
      }
    }
  }

  // 3. Both reports exist and match milestone
  const scrutinyPath = join(getMissionDir(scope), "validation-reports", input.scrutinyReportFilename);
  const userTestingPath = join(getMissionDir(scope), "validation-reports", input.userTestingReportFilename);

  let scrutinyReport: ScrutinyReport | undefined;
  let userTestingReport: UserTestingReport | undefined;

  try {
    const raw = await readFile(scrutinyPath, "utf-8");
    scrutinyReport = JSON.parse(raw) as ScrutinyReport;
  } catch {
    errors.push(`Scrutiny report file not readable: ${input.scrutinyReportFilename}`);
  }

  try {
    const raw = await readFile(userTestingPath, "utf-8");
    userTestingReport = JSON.parse(raw) as UserTestingReport;
  } catch {
    errors.push(`User testing report file not readable: ${input.userTestingReportFilename}`);
  }

  if (scrutinyReport && scrutinyReport.milestoneId !== input.milestoneId) {
    errors.push(`Scrutiny report milestoneId (${scrutinyReport.milestoneId}) does not match ${input.milestoneId}.`);
  }
  if (userTestingReport && userTestingReport.milestoneId !== input.milestoneId) {
    errors.push(`User testing report milestoneId (${userTestingReport.milestoneId}) does not match ${input.milestoneId}.`);
  }

  // 4. Both report files persisted after newest integratedAt
  if (featureIds.length > 0) {
    const newestIntegratedAt = Math.max(
      ...milestoneFeatures
        .filter((f): f is Feature & { integratedAt: string } => Boolean(f.integratedAt))
        .map((f) => new Date(f.integratedAt).getTime()),
    );

    const scrutinyMtime = await getFileMtimeMs(scope, input.scrutinyReportFilename);
    const userTestingMtime = await getFileMtimeMs(scope, input.userTestingReportFilename);

    if (scrutinyMtime !== undefined && scrutinyMtime < newestIntegratedAt) {
      errors.push(`Scrutiny report is stale (file mtime before latest integratedAt).`);
    }
    if (userTestingMtime !== undefined && userTestingMtime < newestIntegratedAt) {
      errors.push(`User testing report is stale (file mtime before latest integratedAt).`);
    }
  }

  // 5. Tests, typecheck, and lint passed
  if (scrutinyReport) {
    if (!scrutinyReport.automatedChecks.tests.passed) {
      errors.push(`Automated tests failed.`);
    }
    if (!scrutinyReport.automatedChecks.typecheck.passed) {
      errors.push(`Automated typecheck failed.`);
    }
    if (!scrutinyReport.automatedChecks.lint.passed) {
      errors.push(`Automated lint failed.`);
    }
  }

  // 6. Scrutiny has no blocking issue
  if (scrutinyReport && scrutinyReport.issues.some(isBlocking)) {
    errors.push(`Scrutiny report contains blocking issues.`);
  }

  // 7. User testing has coverageStatus === "complete"
  if (userTestingReport && userTestingReport.coverageStatus !== "complete") {
    errors.push(`User testing coverage is incomplete.`);
  }

  // 8. User testing has no failed scenario
  if (userTestingReport) {
    const failedScenarios = userTestingReport.scenarioResults.filter((s) => s.status === "failed");
    if (failedScenarios.length > 0) {
      errors.push(`User testing has ${failedScenarios.length} failed scenario(s).`);
    }
  }

  // 9. User testing has no blocking issue
  if (userTestingReport && userTestingReport.issues.some(isBlocking)) {
    errors.push(`User testing report contains blocking issues.`);
  }

  if (errors.length > 0) {
    return { success: false, milestoneId: input.milestoneId, featureIds: [], errors };
  }

  return { success: true, milestoneId: input.milestoneId, featureIds, errors: [] };
}

/**
 * Apply the validation transition:
 * - Write validation receipt
 * - Transition integrated features to validated
 * - Set milestone status to completed
 */
export async function applyMilestoneValidation(
  scope: MissionScope,
  result: ValidationFinalizationResult,
): Promise<void> {
  if (!result.success) {
    throw new Error("Cannot apply failed validation result.");
  }

  // Write receipt
  const receiptPath = join(getMissionDir(scope), "validation-receipts", `${result.milestoneId}.json`);
  await atomicWriteJson(receiptPath, {
    milestoneId: result.milestoneId,
    featureIds: result.featureIds,
    validatedAt: new Date().toISOString(),
    success: true,
  });

  // Transition features
  const features = await readFeatures(scope);
  if (!features) throw new Error("No features.json found");
  const updatedFeatures = features.map((f) =>
    result.featureIds.includes(f.id)
      ? { ...f, status: "validated" as const, validatedAt: new Date().toISOString() }
      : f,
  );
  await writeFeatures(scope, updatedFeatures);

  // Transition milestone
  const milestones = await readMilestones(scope);
  if (!milestones) throw new Error("No milestones.json found");
  const updatedMilestones = milestones.map((m) =>
    m.id === result.milestoneId
      ? { ...m, status: "completed" as const }
      : m,
  );
  await writeMilestones(scope, updatedMilestones);
}

/**
 * Mark a mission as completed if all features are validated and all milestones are completed.
 */
export async function markMissionCompleted(scope: MissionScope): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  const features = await readFeatures(scope);
  if (!features) {
    errors.push("No features.json found.");
    return { success: false, errors };
  }

  const unvalidatedFeatures = features.filter((f) => f.status !== "validated");
  if (unvalidatedFeatures.length > 0) {
    errors.push(`Features not validated: ${unvalidatedFeatures.map((f) => f.id).join(", ")}.`);
  }

  const milestones = await readMilestones(scope);
  if (!milestones) {
    errors.push("No milestones.json found.");
    return { success: false, errors };
  }

  const incompleteMilestones = milestones.filter((m) => m.status !== "completed");
  if (incompleteMilestones.length > 0) {
    errors.push(`Milestones not completed: ${incompleteMilestones.map((m) => m.id).join(", ")}.`);
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, errors: [] };
}
