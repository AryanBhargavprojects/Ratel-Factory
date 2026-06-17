/**
 * Deterministic project-root resolution for the OpenCode plugin.
 *
 * OpenCode sometimes reports `worktree: "/"` while `directory` points to the
 * real working directory (e.g. `/root`). This helper prefers `worktree` only
 * when it is a real project path and not a filesystem root, then falls back to
 * `directory`, then `process.cwd()`.
 */

import { resolve } from "node:path";

export interface ProjectRootContext {
  worktree?: string | null | undefined;
  directory?: string | null | undefined;
}

/** Returns true for POSIX root `/` and Windows drive roots like `C:\` or `C:/`. */
function isFilesystemRoot(p: string): boolean {
  if (p === "/") return true;
  // Windows absolute drive root: C:\ or C:/ (with optional trailing slash)
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return true;
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolve the project root from an OpenCode plugin context.
 *
 * Priority:
 *   1. `ctx.worktree` if it is non-empty and not a filesystem root.
 *   2. `ctx.directory` if it is non-empty.
 *   3. `process.cwd()`.
 *
 * The chosen value is normalized to an absolute path via `path.resolve`.
 */
export function resolveProjectRoot(ctx: ProjectRootContext): string {
  const candidate =
    isNonEmptyString(ctx.worktree) && !isFilesystemRoot(ctx.worktree)
      ? ctx.worktree
      : isNonEmptyString(ctx.directory)
        ? ctx.directory
        : process.cwd();

  return resolve(candidate);
}
