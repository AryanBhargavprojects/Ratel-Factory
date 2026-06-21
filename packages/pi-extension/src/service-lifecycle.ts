/**
 * Ratel Pi Extension — Service Lifecycle (discovery & autostart)
 *
 * Pi-native helper that discovers or auto-starts the Ratel core service for a
 * project. Uses only Node built-ins plus the Pi UI notify surface — it does
 * not import any OpenCode plugin APIs.
 *
 * Flow:
 *   1. Read `.ratel/service.json` portfile in the project root.
 *   2. Health-check the URL. If healthy and cwd matches, reuse it.
 *   3. Otherwise spawn `ratel --serve` and poll the portfile until ready.
 *
 * The spawned child is tracked so the extension can clean it up on
 * session_shutdown. Children discovered via an existing portfile are owned by
 * the user and are NOT killed on shutdown.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { RatelServiceClient } from "./service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger abstraction for service lifecycle diagnostics. When provided, route
 * messages through Pi's `ctx.ui.notify` instead of raw stdout/stderr so
 * diagnostics never leak into the Pi chat surface.
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

export interface EnsureServiceOptions {
  /** Absolute project root used to locate `.ratel/service.json`. */
  projectRoot: string;
  /** Optional Pi logger (e.g. ctx.ui.notify-bound). */
  logger?: ServiceLogger;
  /** Override spawn for tests. */
  spawnFn?: typeof spawn;
  /** Disable autostart; only discover existing healthy services. */
  disableAutostart?: boolean;
  /** Max time (ms) to wait for an auto-started service. Default 15000. */
  timeoutMs?: number;
}

export interface EnsureServiceResult {
  client: RatelServiceClient | null;
  /** Spawned child to clean up on session_shutdown, if any. */
  child: ChildProcess | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createLog(logger?: ServiceLogger): (level: "info" | "warning" | "error", message: string) => Promise<void> {
  return async (level, message) => {
    try {
      if (logger) {
        await Promise.resolve(logger(level, message));
      } else if (level === "error" || level === "warning") {
        const prefix = level === "error" ? "[Ratel ERROR]" : "[Ratel WARN]";
        console.error(`${prefix} ${message}`);
      } else if (process.env.RATEL_PI_DEBUG === "1") {
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
 * Discover or auto-start the Ratel core service for the given project root.
 */
export async function ensureRatelService(
  options: EnsureServiceOptions,
): Promise<EnsureServiceResult> {
  const { projectRoot, logger, spawnFn, disableAutostart, timeoutMs } = options;
  const log = createLog(logger);

  const portfile = await readServicePortfile(projectRoot);

  if (portfile) {
    const healthy = await healthCheck(portfile.url);
    if (healthy && portfile.cwd === projectRoot) {
      await log("info", `Discovered running Ratel service at ${portfile.url}`);
      return { client: new RatelServiceClient(portfile.url), child: null };
    }
    if (!healthy) {
      await log(
        "info",
        `Existing portfile found but service at ${portfile.url} is not healthy. Starting a new one.`,
      );
    }
  }

  if (disableAutostart) {
    return { client: null, child: null };
  }

  await log("info", `Starting Ratel service for project: ${projectRoot}`);
  return waitForService({ projectRoot, timeoutMs, logger, spawnFn });
}

// ---------------------------------------------------------------------------
// Wait for auto-started service
// ---------------------------------------------------------------------------

export interface WaitForServiceOptions {
  projectRoot: string;
  timeoutMs?: number;
  logger?: ServiceLogger;
  spawnFn?: typeof spawn;
}

/**
 * Spawn `ratel --serve` as a child process and poll for the portfile.
 *
 * @returns A connected client plus the spawned child, or null on timeout/failure.
 */
export function waitForService(
  options: WaitForServiceOptions,
): Promise<EnsureServiceResult> {
  const { projectRoot, timeoutMs = 15000, logger, spawnFn } = options;
  const log = createLog(logger);
  const doSpawn = spawnFn ?? spawn;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const spawnOpts: SpawnOptions = {
        cwd: projectRoot,
        stdio: "ignore",
        detached: false,
      };
      child = doSpawn("ratel", ["--serve"], spawnOpts);
    } catch (err) {
      log(
        "error",
        `Failed to spawn ratel process: ${err instanceof Error ? err.message : String(err)}`,
      ).finally(() => resolve({ client: null, child: null }));
      return;
    }

    const startTime = Date.now();
    let settled = false;

    const done = (result: EnsureServiceResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      // Do NOT kill child on success — it needs to keep running.
      resolve(result);
    };

    child.on("exit", (code, signal) => {
      if (!settled) {
        log(
          "error",
          `Ratel service process exited (code=${code}, signal=${signal}) before becoming ready.`,
        ).finally(() => done({ client: null, child: null }));
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        log("error", `Ratel service process error: ${err.message}`).finally(() =>
          done({ client: null, child: null }),
        );
      }
    });

    const interval = setInterval(async () => {
      if (Date.now() - startTime > timeoutMs) {
        log(
          "error",
          `Timed out after ${timeoutMs}ms waiting for Ratel service to start.`,
        ).finally(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
          done({ client: null, child: null });
        });
        return;
      }

      const pf = await readServicePortfile(projectRoot);
      if (pf && pf.cwd === projectRoot) {
        const healthy = await healthCheck(pf.url);
        if (healthy) {
          await log("info", `Auto-started Ratel service at ${pf.url}`);
          done({ client: new RatelServiceClient(pf.url), child });
        }
      }
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Kill a spawned Ratel service child if we own it. No-op for null/already-exited
 * children. Safe to call from a session_shutdown handler.
 */
export function cleanupSpawnedService(child: ChildProcess | null): void {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup
  }
}
