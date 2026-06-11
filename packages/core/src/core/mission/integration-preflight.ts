import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Feature } from "../types.js";
import { resolveCanonicalWorkspace } from "./workspace-resolution.js";

const execFile = promisify(execFileCb);

export type IntegrationPreflightStatus = "ok" | "failed" | "skipped";

export interface MissingIntegrationFeature {
  featureId: string;
  commitSha: string;
  title?: string;
  branchHint?: string;
}

export interface IntegrationPreflightResult {
  status: IntegrationPreflightStatus;
  branch: string;
  repoPath?: string;
  checkedFeatureCount: number;
  missing: MissingIntegrationFeature[];
  reason?: string;
  recoveryInstruction: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

/**
 * Find the canonical integration repository for a mission.
 *
 * Priority:
 * 1. If requirements.json has an explicit `directory`, use that directory
 *    (initialize git there if needed). Do NOT scan sibling directories.
 * 2. Otherwise, fall back to auto-discovering a git repo on `branch`.
 */
export async function findIntegrationRepo(cwd: string, branch = "integration"): Promise<string | undefined> {
  return resolveCanonicalWorkspace(cwd, branch);
}

async function commitExists(repoPath: string, commitSha: string): Promise<boolean> {
  try {
    await git(repoPath, ["cat-file", "-e", `${commitSha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function commitReachableFromBranch(repoPath: string, commitSha: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", commitSha, branch]);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", branchName]);
    return true;
  } catch {
    return false;
  }
}

async function branchHintForFeature(repoPath: string, featureId: string): Promise<string | undefined> {
  const candidates = [`feat/${featureId}`, `feature/${featureId}`, featureId];
  for (const candidate of candidates) {
    if (await branchExists(repoPath, candidate)) return candidate;
  }
  return undefined;
}

function featureCommitSha(feature: Feature): string | undefined {
  const raw = (feature as Feature & { commitSha?: unknown }).commitSha;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function buildRecoveryInstruction(branch: string, missing: MissingIntegrationFeature[]): string {
  if (missing.length === 0) {
    return `All verifiable completed feature commits are reachable from ${branch}.`;
  }

  const mergeTargets = missing.map((item) => item.branchHint ?? item.commitSha).join(", ");
  const featureIds = missing.map((item) => item.featureId).join(", ");
  return [
    `Do not run milestone validation yet. Completed feature commit(s) for ${featureIds} are not reachable from ${branch}.`,
    `Create a same-milestone merge recovery feature: merge ${mergeTargets} into ${branch} in dependency order, resolve conflicts, verify the commits or equivalent diffs are present, then rerun checks before validation.`,
  ].join(" ");
}

/**
 * Ensure completed feature commits are present on the canonical integration
 * branch before validators run. Validation must inspect the integration branch,
 * not isolated feature worktrees, so accepting handoffs without this check lets
 * the same blocking issues repeat indefinitely.
 */
export async function checkCompletedFeatureIntegration(
  cwd: string,
  features: Feature[],
  branch = "integration",
): Promise<IntegrationPreflightResult> {
  const repoPath = await findIntegrationRepo(cwd, branch);
  const completedWithCommits = features
    .filter((feature) => feature.status === "completed")
    .map((feature) => ({ feature, commitSha: featureCommitSha(feature) }))
    .filter((item): item is { feature: Feature; commitSha: string } => Boolean(item.commitSha));

  if (!repoPath) {
    return {
      status: "skipped",
      branch,
      checkedFeatureCount: completedWithCommits.length,
      missing: [],
      reason: `No git repository with branch ${branch} was found under ${cwd}; integration preflight skipped.`,
      recoveryInstruction: `No git repository with branch ${branch} was found; validation can proceed only if this mission does not use an integration branch.`,
    };
  }

  const missing: MissingIntegrationFeature[] = [];
  for (const { feature, commitSha } of completedWithCommits) {
    const exists = await commitExists(repoPath, commitSha);
    const reachable = exists && await commitReachableFromBranch(repoPath, commitSha, branch);
    if (!reachable) {
      missing.push({
        featureId: feature.id,
        title: feature.title,
        commitSha,
        branchHint: await branchHintForFeature(repoPath, feature.id),
      });
    }
  }

  return {
    status: missing.length > 0 ? "failed" : "ok",
    branch,
    repoPath,
    checkedFeatureCount: completedWithCommits.length,
    missing,
    recoveryInstruction: buildRecoveryInstruction(branch, missing),
  };
}
