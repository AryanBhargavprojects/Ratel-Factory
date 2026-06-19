/**
 * Ratel Service Lifecycle — Plugin-side discovery & auto-start
 *
 * Uses only Node built-ins so it works inside OpenCode's Bun runtime.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { RatelServiceClient } from "./service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger abstraction for service lifecycle diagnostics.
 *
 * When provided (e.g. from the OpenCode plugin ctx), messages route
 * through the app log channel instead of raw stdout/stderr.  This
 * prevents lifecycle messages from leaking into the OpenCode
 * composer / input bar.
 */
export type ServiceLogger = (
  level: "info" | "warning" | "error",
  message: string,
) => void | Promise<void>;

export interface ServicePortfile {
  pid: number;
  url: string;
  port: number;
  cwd: string;
  startedAt: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a log function that respects the injected logger, falling
 * back to console only when no logger is available.
 *
 * - Info messages are gated behind RATEL_OPENCODE_DEBUG=1 when no
 *   logger is present (routine discovery/startup diagnostics).
 * - Warnings and errors always reach the logger; when no logger is
 *   available they fall back to console.error (user-relevant).
 *
 * The env var is read at call time so tests can toggle it.
 */
function createLog(
  logger?: ServiceLogger,
): (level: "info" | "warning" | "error", message: string) => Promise<void> {
  return async (level, message) => {
    try {
      if (logger) {
        await Promise.resolve(logger(level, message));
      } else if (level === "error" || level === "warning") {
        const prefix =
          level === "error" ? "[Ratel ERROR]" : "[Ratel WARN]";
        console.error(`${prefix} ${message}`);
      } else if (process.env.RATEL_OPENCODE_DEBUG === "1") {
        console.log(`[Ratel] ${message}`);
      }
    } catch {
      // Never let logging errors propagate
    }
  };
}

// ---------------------------------------------------------------------------
// Portfile reader
// ---------------------------------------------------------------------------

export async function readServicePortfile(
  projectRoot: string,
): Promise<ServicePortfile | null> {
  const portfilePath = join(projectRoot, ".ratel", "service.json");
  try {
    await access(portfilePath);
    const raw = await readFile(portfilePath, "utf-8");
    const data = JSON.parse(raw) as ServicePortfile;

    // Validate required fields
    if (!data.url || typeof data.port !== "number" || !data.cwd) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function healthCheck(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return false;

    const data = (await res.json()) as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ensure service (primary entry point)
// ---------------------------------------------------------------------------

/**
 * Discovers or auto-starts the Ratel core service for the given project root.
 *
 * 1. Looks for `.ratel/service.json` in the project root.
 * 2. If found and healthy, returns a connected client.
 * 3. Otherwise spawns `ratel --serve` and polls until ready.
 *
 * @returns A connected client, or null if the service could not be started.
 */
export async function ensureRatelService(
  projectRoot: string,
  logger?: ServiceLogger,
  _spawn?: typeof spawn,
): Promise<RatelServiceClient | null> {
  const log = createLog(logger);

  // 1. Check for existing portfile
  const portfile = await readServicePortfile(projectRoot);

  if (portfile) {
    // 2. Health-check the existing service
    const healthy = await healthCheck(portfile.url);

    if (healthy && portfile.cwd === projectRoot) {
      await log("info", `Discovered running service at ${portfile.url}`);
      return new RatelServiceClient(portfile.url);
    }

    // Portfile exists but service isn't healthy or cwd mismatch
    if (!healthy) {
      await log(
        "info",
        `Existing portfile found but service at ${portfile.url} is not healthy. Starting a new one.`,
      );
    }
  }

  // 3. No healthy service — spawn one
  await log("info", `Starting service for project: ${projectRoot}`);
  return waitForService(projectRoot, 15000, logger, _spawn);
}

// ---------------------------------------------------------------------------
// Wait for auto-started service
// ---------------------------------------------------------------------------

/**
 * Spawns `ratel --serve` as a child process and polls for the portfile.
 *
 * @param projectRoot Absolute path to the project.
 * @param timeoutMs  Maximum time to wait for the service to become ready.
 * @returns A connected client, or null on timeout / process failure.
 */
export async function waitForService(
  projectRoot: string,
  timeoutMs: number,
  logger?: ServiceLogger,
  _spawn?: typeof spawn,
): Promise<RatelServiceClient | null> {
  const log = createLog(logger);
  const doSpawn = _spawn ?? spawn;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = doSpawn("ratel", ["--serve"], {
        cwd: projectRoot,
        stdio: "ignore",
        detached: false,
      });
    } catch (err) {
      log(
        "error",
        `Failed to spawn ratel process: ${err instanceof Error ? err.message : String(err)}`,
      ).finally(() => resolve(null));
      return;
    }

    const startTime = Date.now();
    let settled = false;

    const done = (client: RatelServiceClient | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      // Do NOT kill child on success — it needs to keep running
      resolve(client);
    };

    child.on("exit", (code, signal) => {
      if (!settled) {
        log(
          "error",
          `Service process exited (code=${code}, signal=${signal}) before becoming ready.`,
        ).finally(() => done(null));
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        log("error", `Service process error: ${err.message}`).finally(() =>
          done(null),
        );
      }
    });

    const interval = setInterval(async () => {
      // Timeout guard
      if (Date.now() - startTime > timeoutMs) {
        log(
          "error",
          `Timed out after ${timeoutMs}ms waiting for service to start.`,
        ).finally(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
          done(null);
        });
        return;
      }

      // Poll for portfile + health
      const pf = await readServicePortfile(projectRoot);
      if (pf && pf.cwd === projectRoot) {
        const healthy = await healthCheck(pf.url);
        if (healthy) {
          await log("info", `Auto-started service at ${pf.url}`);
          done(new RatelServiceClient(pf.url));
        }
      }
    }, 500);
  });
}
