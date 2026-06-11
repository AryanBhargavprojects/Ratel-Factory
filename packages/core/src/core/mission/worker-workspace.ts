import { execFile as execFileCb } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCanonicalWorkspace } from "./workspace-resolution.js";
import { getGlobalLogger } from "../observability/event-logger.js";
import type { FeatureAssertionDocument } from "./feature-assertions.js";

const execFile = promisify(execFileCb);

export type WorkerWorkspaceStatus = "ready" | "skipped" | "blocked" | "merged" | "no_changes";

export interface WorkerWorkspaceResult {
  status: WorkerWorkspaceStatus;
  repoPath?: string;
  integrationBranch: string;
  featureBranch?: string;
  integrationHead?: string;
  featureTip?: string;
  mergeCommit?: string;
  reason?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepoOnBranch(dir: string, branch: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    return await git(dir, ["branch", "--show-current"]) === branch;
  } catch {
    return false;
  }
}

async function findRepoOnBranch(cwd: string, branch: string): Promise<string | undefined> {
  if (await isGitRepoOnBranch(cwd, branch)) return cwd;

  let entries: Dirent[];
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const ignored = new Set(["node_modules", "dist", ".missions", ".pi", ".agents", ".claude"]);
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name)) continue;
    const candidate = join(cwd, entry.name);
    if (await isGitRepoOnBranch(candidate, branch)) return candidate;
  }
  return undefined;
}

function featureBranchName(featureId: string): string {
  return `feat/${featureId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

async function workingTreeStatus(repoPath: string): Promise<string> {
  return git(repoPath, ["status", "--porcelain"]);
}

async function ensureClean(repoPath: string): Promise<string | undefined> {
  const status = await workingTreeStatus(repoPath);
  return status.length > 0 ? status : undefined;
}

/**
 * Auto-clean dirty files that are git-ignored before spawning or finalizing
 * a worker branch. Only removes files that Git itself considers ignored
 * (via git check-ignore). Non-ignored dirty files are never auto-cleaned.
 */
async function prepareCleanWorkspace(
  repoPath: string,
): Promise<{ cleaned: boolean; reason?: string; blocked?: boolean }> {
  const status = await workingTreeStatus(repoPath);
  if (!status.length) return { cleaned: false };

  // Parse dirty file paths from git status --porcelain.
  // Lines have the format "XY filename" or "XY old -> new" (renamed).
  const lines = status.split("\n").filter(Boolean);
  const dirtyFiles: string[] = [];
  for (const line of lines) {
    const afterStatus = line.slice(3).trim();
    if (afterStatus.includes(" -> ")) {
      const [oldPath, newPath] = afterStatus.split(" -> ");
      dirtyFiles.push(oldPath, newPath);
    } else if (afterStatus.length > 0) {
      dirtyFiles.push(afterStatus);
    }
  }

  if (dirtyFiles.length === 0) return { cleaned: false };

  // Check each dirty file against git's ignore rules.
  // git check-ignore exits 0 if the path is excluded by a rule, 1 otherwise.
  let allIgnored = true;
  const nonIgnoredFiles: string[] = [];
  for (const file of dirtyFiles) {
    const isIgnored = await gitOk(repoPath, ["check-ignore", file]);
    if (!isIgnored) {
      allIgnored = false;
      nonIgnoredFiles.push(file);
    }
  }

  if (!allIgnored) {
    const logger = getGlobalLogger();
    logger?.decisionLogged(
      "dirty-workspace-blocked",
      `prepareCleanWorkspace in ${repoPath}`,
      "blocked",
      `Non-ignored files are dirty: ${nonIgnoredFiles.join(", ")}`,
    );
    return {
      cleaned: false,
      blocked: true,
      reason: `Non-ignored files are dirty: ${nonIgnoredFiles.join(", ")}`,
    };
  }

  // All dirty files are git-ignored: auto-clean them.
  // git reset --hard HEAD discards any tracked changes.
  // git clean -fdX removes only ignored untracked files/directories.
  await git(repoPath, ["reset", "--hard", "HEAD"]);
  await git(repoPath, ["clean", "-fdX"]);

  const logger = getGlobalLogger();
  logger?.decisionLogged(
    "dirty-workspace-auto-cleaned",
    `prepareCleanWorkspace in ${repoPath}`,
    "auto-cleaned",
    `Auto-cleaned ${dirtyFiles.length} git-ignored dirty file(s): ${dirtyFiles.join(", ")}`,
  );

  return { cleaned: true };
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return gitOk(repoPath, ["rev-parse", "--verify", branch]);
}

async function revParse(repoPath: string, ref: string): Promise<string> {
  return git(repoPath, ["rev-parse", ref]);
}

async function aheadCount(repoPath: string, base: string, branch: string): Promise<number> {
  const out = await git(repoPath, ["rev-list", "--count", `${base}..${branch}`]);
  return Number.parseInt(out, 10) || 0;
}

export async function prepareSerialWorkerBranch(
  cwd: string,
  featureId: string,
  integrationBranch = "integration",
): Promise<WorkerWorkspaceResult> {
  const repoPath = await resolveCanonicalWorkspace(cwd, integrationBranch);
  const featureBranch = featureBranchName(featureId);

  if (!repoPath) {
    return {
      status: "skipped",
      integrationBranch,
      featureBranch,
      reason: `No git repository with branch ${integrationBranch} was found under ${cwd}.`,
    };
  }

  const cleanResult = await prepareCleanWorkspace(repoPath);
  if (cleanResult.blocked) {
    return {
      status: "blocked",
      repoPath,
      integrationBranch,
      featureBranch,
      reason: `Cannot start worker branch from a dirty repository. ${cleanResult.reason}`,
    };
  }

  // Secondary safety check: after auto-clean (if any), verify the tree is
  // actually clean before proceeding.
  const dirty = await ensureClean(repoPath);
  if (dirty) {
    return {
      status: "blocked",
      repoPath,
      integrationBranch,
      featureBranch,
      reason: `Cannot start worker branch from a dirty repository. Clean or commit these changes first:\n${dirty}`,
    };
  }

  await git(repoPath, ["checkout", integrationBranch]);
  const integrationHead = await revParse(repoPath, integrationBranch);

  if (await branchExists(repoPath, featureBranch)) {
    const ahead = await aheadCount(repoPath, integrationBranch, featureBranch);
    if (ahead > 0) {
      return {
        status: "blocked",
        repoPath,
        integrationBranch,
        featureBranch,
        integrationHead,
        reason: `${featureBranch} already has ${ahead} commit(s) not merged into ${integrationBranch}. Refusing to reset or overwrite existing work.`,
      };
    }
    await git(repoPath, ["branch", "-f", featureBranch, integrationBranch]);
    await git(repoPath, ["checkout", featureBranch]);
  } else {
    await git(repoPath, ["checkout", "-b", featureBranch, integrationBranch]);
  }

  return {
    status: "ready",
    repoPath,
    integrationBranch,
    featureBranch,
    integrationHead,
  };
}

/**
 * Copy resolved .feature files into the worker's git workspace so the
 * worker can reference them by relative path (e.g. features/*.feature).
 * Only documents resolved successfully are copied; missing refs are skipped.
 */
export async function copyFeatureFilesToWorkspace(
  repoPath: string,
  documents: FeatureAssertionDocument[],
): Promise<string[]> {
  const featuresDir = join(repoPath, "features");
  const copied: string[] = [];

  try {
    await mkdir(featuresDir, { recursive: true });
  } catch {
    const logger = getGlobalLogger();
    logger?.decisionLogged(
      "feature-copy-mkdir-failed",
      `copyFeatureFilesToWorkspace: cannot create ${featuresDir}`,
      "skipped",
      "Failed to create features/ directory in workspace — feature files will not be copied.",
    );
    return copied;
  }

  for (const doc of documents) {
    const destPath = join(featuresDir, doc.filename);
    try {
      await writeFile(destPath, doc.content, "utf-8");
      copied.push(destPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logger = getGlobalLogger();
      logger?.decisionLogged(
        "feature-copy-write-failed",
        `copyFeatureFilesToWorkspace: ${doc.filename}`,
        "skipped",
        `Failed to copy ${doc.filename} to workspace: ${message}`,
      );
    }
  }

  return copied;
}

export async function finalizeSerialWorkerBranch(
  cwd: string,
  featureId: string,
  integrationBranch = "integration",
  /** If provided, use this exact repo path instead of re-discovering. Prevents sibling-directory misselection. */
  knownRepoPath?: string,
): Promise<WorkerWorkspaceResult> {
  const featureBranch = featureBranchName(featureId);
  const repoPath = knownRepoPath
    ?? await findRepoOnBranch(cwd, featureBranch)
    ?? await resolveCanonicalWorkspace(cwd, integrationBranch);

  if (!repoPath) {
    return {
      status: "skipped",
      integrationBranch,
      featureBranch,
      reason: `No git repository with branch ${integrationBranch} was found under ${cwd}.`,
    };
  }

  const cleanResult = await prepareCleanWorkspace(repoPath);
  if (cleanResult.blocked) {
    return {
      status: "blocked",
      repoPath,
      integrationBranch,
      featureBranch,
      reason: `Cannot finalize worker branch from a dirty repository. ${cleanResult.reason}`,
    };
  }

  // Secondary safety check: after auto-clean (if any), verify the tree is
  // actually clean before proceeding.
  const dirty = await ensureClean(repoPath);
  if (dirty) {
    return {
      status: "blocked",
      repoPath,
      integrationBranch,
      featureBranch,
      reason: `Cannot finalize worker branch from a dirty repository. Resolve or commit these changes first:\n${dirty}`,
    };
  }

  if (!(await branchExists(repoPath, featureBranch))) {
    return {
      status: "blocked",
      repoPath,
      integrationBranch,
      featureBranch,
      reason: `${featureBranch} does not exist.`,
    };
  }

  const ahead = await aheadCount(repoPath, integrationBranch, featureBranch);
  const featureTip = await revParse(repoPath, featureBranch);
  if (ahead === 0) {
    await git(repoPath, ["checkout", integrationBranch]);
    return {
      status: "no_changes",
      repoPath,
      integrationBranch,
      featureBranch,
      featureTip,
      integrationHead: await revParse(repoPath, integrationBranch),
      reason: `${featureBranch} has no commits ahead of ${integrationBranch}.`,
    };
  }

  await git(repoPath, ["checkout", integrationBranch]);
  try {
    await git(repoPath, ["merge", "--no-ff", featureBranch, "-m", `merge(${featureId}): integrate worker branch`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "blocked",
      repoPath,
      integrationBranch,
      featureBranch,
      featureTip,
      reason: `Merge conflict or merge failure while integrating ${featureBranch}: ${message}`,
    };
  }

  return {
    status: "merged",
    repoPath,
    integrationBranch,
    featureBranch,
    featureTip,
    integrationHead: await revParse(repoPath, integrationBranch),
    mergeCommit: await revParse(repoPath, "HEAD"),
  };
}
