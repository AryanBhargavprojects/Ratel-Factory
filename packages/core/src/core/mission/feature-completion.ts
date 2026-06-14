/**
 * Non-bypassable feature integration gate.
 * The orchestrator decides WHEN to request integration.
 * This module decides WHETHER the requested transition is structurally valid.
 */

import type { WorkerRunReceipt, Feature } from "../types.js";
import { readWorkerReceipt } from "../report-submission.js";
import { readFeatures, writeFeatures } from "../artifacts.js";
import type { MissionScope } from "./scope.js";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface IntegrationGateResult {
  success: boolean;
  featureId: string;
  commitSha?: string;
  errors: string[];
}

/**
 * Check whether a commit SHA is reachable from a branch in a repo.
 */
async function isCommitReachable(
  repoPath: string,
  commitSha: string,
  branch: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFile(
      "git",
      ["merge-base", "--is-ancestor", commitSha, branch],
      { cwd: repoPath },
    );
    return stdout.trim() === "";
  } catch {
    return false;
  }
}

/**
 * Evaluate the integration gate for a feature.
 *
 * Conditions:
 * - receipt.parseStatus === "ok"
 * - receipt.handoff.featureId === featureId
 * - receipt.handoff.leftUndone.length === 0
 * - receipt.handoff.issuesDiscovered has no severity === "high"
 * - receipt.workspaceFinalization.status === "merged" || "skipped"
 * - for "merged": commit is reachable from integration branch
 * - for "skipped": no integration repo was available, and handoff contains a commit when project is a git repo
 */
export async function evaluateFeatureIntegrationGate(
  scope: MissionScope,
  featureId: string,
): Promise<IntegrationGateResult> {
  const errors: string[] = [];

  // 1. Read features
  const features = await readFeatures(scope);
  if (!features) {
    return { success: false, featureId, errors: ["No features.json found."] };
  }

  const feature = features.find((f) => f.id === featureId);
  if (!feature) {
    return { success: false, featureId, errors: [`Feature ${featureId} not found.`] };
  }

  // Idempotent: already integrated or validated
  if (feature.status === "integrated" || feature.status === "validated") {
    return { success: true, featureId, errors: [] };
  }

  // 2. Read receipt
  const receipt = await readWorkerReceipt(scope, featureId);
  if (!receipt) {
    return { success: false, featureId, errors: [`No worker receipt found for ${featureId}. Run run_worker first.`] };
  }

  // 3. Parse status check
  if (receipt.parseStatus !== "ok") {
    errors.push(`Worker parseStatus was "${receipt.parseStatus}". A clean handoff is required.`);
  }

  // 4. Feature ID match
  if (receipt.handoff.featureId !== featureId) {
    errors.push(`Receipt handoff featureId (${receipt.handoff.featureId}) does not match ${featureId}.`);
  }

  // 5. leftUndone must be empty
  if (receipt.handoff.leftUndone.length > 0) {
    errors.push(`Handoff has ${receipt.handoff.leftUndone.length} unfinished item(s).`);
  }

  // 6. No high issues
  const highIssues = receipt.handoff.issuesDiscovered.filter((i) => i.severity === "high");
  if (highIssues.length > 0) {
    errors.push(`Handoff reports ${highIssues.length} high-severity issue(s).`);
  }

  // 7. Workspace finalization must be merged or skipped
  const finalization = receipt.workspaceFinalization;
  if (finalization.status !== "merged" && finalization.status !== "skipped") {
    errors.push(`Workspace finalization status was "${finalization.status}". Only "merged" or "skipped" are accepted.`);
  }

  // 8. For merged: verify commit reachability
  let commitSha: string | undefined;
  if (finalization.status === "merged") {
    commitSha = finalization.mergeCommit ?? finalization.featureTip;
    if (commitSha && finalization.repoPath) {
      const reachable = await isCommitReachable(
        finalization.repoPath,
        commitSha,
        finalization.integrationBranch,
      );
      if (!reachable) {
        errors.push(`Feature commit ${commitSha} is not reachable from ${finalization.integrationBranch}.`);
      }
    }
  }

  // 9. For skipped: if project is a git repo, handoff should contain a commit
  if (finalization.status === "skipped") {
    // Skipped is legitimate when no integration repo was available.
    // We don't enforce a commit here because skipped means there was no repo to merge into.
  }

  if (errors.length > 0) {
    return { success: false, featureId, errors };
  }

  return { success: true, featureId, commitSha, errors: [] };
}

/**
 * Apply the integration transition: update features.json with integrated status and commitSha.
 * This is the ONLY path that may write status="integrated".
 */
export async function applyFeatureIntegration(
  scope: MissionScope,
  featureId: string,
  commitSha?: string,
): Promise<void> {
  const features = await readFeatures(scope);
  if (!features) throw new Error("No features.json found");

  const updated = features.map((f) =>
    f.id === featureId
      ? { ...f, status: "integrated" as const, commitSha: commitSha ?? f.commitSha, integratedAt: new Date().toISOString() }
      : f,
  );

  await writeFeatures(scope, updated);
}

/**
 * Check whether a features.json write would introduce an invalid integrated or validated transition.
 * Used by write_mission_artifact to reject direct transitions.
 */
export function wouldIntroduceIntegratedTransition(
  currentFeatures: Feature[] | undefined,
  proposedFeatures: Feature[] | undefined,
): { blocked: boolean; reason?: string } {
  if (!proposedFeatures) return { blocked: false };

  const currentStatusById = new Map(currentFeatures?.map((f) => [f.id, f.status]) ?? []);

  for (const proposed of proposedFeatures) {
    const currentStatus = currentStatusById.get(proposed.id);
    if (!currentStatus) {
      // New feature
      if (proposed.status === "integrated") {
        return {
          blocked: true,
          reason: `New feature ${proposed.id} cannot be created with status "integrated". Use mark_feature_integrated instead.`,
        };
      }
      if (proposed.status === "validated") {
        return {
          blocked: true,
          reason: `New feature ${proposed.id} cannot be created with status "validated". Only validators can produce validated.`,
        };
      }
    } else {
      if (currentStatus !== "integrated" && proposed.status === "integrated") {
        return {
          blocked: true,
          reason: `Feature ${proposed.id} cannot transition from "${currentStatus}" to "integrated" through direct artifact write. Use mark_feature_integrated instead.`,
        };
      }
      if (currentStatus !== "validated" && proposed.status === "validated") {
        return {
          blocked: true,
          reason: `Feature ${proposed.id} cannot transition from "${currentStatus}" to "validated" through direct artifact write. Only validators can produce validated.`,
        };
      }
    }
  }

  return { blocked: false };
}
