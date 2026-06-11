/**
 * Workspace resolution logic for the Ratel factory.
 *
 * When a mission's requirements.json has an explicit `directory` field, the
 * factory uses that directory as the canonical workspace unconditionally.
 * This prevents auto-discovery from accidentally selecting a sibling repo
 * that happens to have a .git directory (e.g. a previously completed app).
 *
 * If no explicit directory is set, the factory falls back to auto-discovery.
 */

import { mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readRequirements } from "../artifacts.js";

const execFile = promisify(execFileCb);

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

/**
 * Read requirements.json and return the explicit workspace directory.
 * The path is resolved relative to `cwd` unless it is already absolute.
 */
export async function getExplicitWorkspaceDirectory(cwd: string): Promise<string | undefined> {
  const requirements = await readRequirements(cwd);
  if (!requirements?.directory) return undefined;
  const dir = requirements.directory.trim();
  if (dir.length === 0) return undefined;
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

/**
 * Initialize a git repository at `dir` if it is not already one.
 * Ensure the named branch exists (create it if needed).
 */
export async function ensureGitRepo(dir: string, branch = "integration"): Promise<void> {
  await mkdir(dir, { recursive: true });

  const isGitRepo = await gitOk(dir, ["rev-parse", "--git-dir"]);
  if (!isGitRepo) {
    await git(dir, ["init"]);
  }

  const hasCommits = await gitOk(dir, ["rev-parse", "HEAD"]);
  if (!hasCommits) {
    await git(dir, ["config", "user.email", "ratel@factory.local"]);
    await git(dir, ["config", "user.name", "Ratel Factory"]);
    // Create an initial commit so the branch actually exists
    const placeholder = join(dir, ".ratel-git-placeholder");
    await import("node:fs/promises").then((fs) => fs.writeFile(placeholder, "", "utf-8"));
    await git(dir, ["add", ".ratel-git-placeholder"]);
    await git(dir, ["commit", "-m", "init: ratel factory workspace"]);
    await git(dir, ["branch", "-m", branch]);
    return;
  }

  // Ensure the branch exists; if we're on a different branch, create the target branch from HEAD
  const currentBranch = await git(dir, ["branch", "--show-current"]);
  const branchExists = await gitOk(dir, ["rev-parse", "--verify", branch]);
  if (!branchExists) {
    await git(dir, ["branch", branch]);
  }
  if (currentBranch !== branch) {
    await git(dir, ["checkout", branch]);
  }
}

/** Internal auto-discovery: scan sibling directories for a git repo on the expected branch. */
async function findRepoOnBranchViaDiscovery(cwd: string, branch: string): Promise<string | undefined> {
  // Check cwd itself
  if (await isGitRepoOnBranch(cwd, branch)) return cwd;

  // Scan immediate children
  const { readdir } = await import("node:fs/promises");
  const { Dirent } = await import("node:fs");
  let entries: import("node:fs").Dirent[];
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

async function isGitRepoOnBranch(dir: string, branch: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    return await git(dir, ["branch", "--show-current"]) === branch;
  } catch {
    return false;
  }
}

/**
 * Resolve the canonical workspace directory for a mission.
 *
 * 1. If requirements.json has an explicit `directory`, use that directory.
 *    Initialize git there if needed. Do NOT scan sibling directories.
 * 2. Otherwise, fall back to auto-discovering a git repo on `branch` under `cwd`.
 */
export async function resolveCanonicalWorkspace(
  cwd: string,
  branch = "integration",
): Promise<string | undefined> {
  const explicitDir = await getExplicitWorkspaceDirectory(cwd);
  if (explicitDir) {
    await ensureGitRepo(explicitDir, branch);
    return explicitDir;
  }

  return findRepoOnBranchViaDiscovery(cwd, branch);
}
