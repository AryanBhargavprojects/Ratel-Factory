/**
 * Deterministic project-root resolution for the Pi extension.
 *
 * Pi sessions run inside a project working directory exposed via
 * `ctx.cwd`. In rare cases (e.g. headless/RPC invocations or misconfigured
 * shells) that value can be empty or a filesystem root. This helper picks a
 * sensible project root and normalizes it to an absolute path so the
 * in-process Ratel core reads/writes its local `.ratel/` state in the right
 * place.
 */

import { resolve } from "node:path";

export interface ProjectRootInput {
  cwd?: string | null | undefined;
}

/** Returns true for POSIX root `/` and Windows drive roots like `C:\` or `C:/`. */
function isFilesystemRoot(p: string): boolean {
  if (p === "/") return true;
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return true;
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolve the project root for a Pi session.
 *
 * Priority:
 *   1. `ctx.cwd` if it is non-empty and not a filesystem root.
 *   2. `process.cwd()`.
 *
 * The chosen value is normalized to an absolute path via `path.resolve`.
 */
export function resolveProjectRoot(input: ProjectRootInput): string {
  const candidate =
    isNonEmptyString(input.cwd) && !isFilesystemRoot(input.cwd)
      ? input.cwd
      : process.cwd();

  return resolve(candidate);
}
