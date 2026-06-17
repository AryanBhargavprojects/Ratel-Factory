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

export interface ServicePortfile {
  pid: number;
  url: string;
  port: number;
  cwd: string;
  startedAt: string;
  version: string;
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
): Promise<RatelServiceClient | null> {
  // 1. Check for existing portfile
  const portfile = await readServicePortfile(projectRoot);

  if (portfile) {
    // 2. Health-check the existing service
    const healthy = await healthCheck(portfile.url);

    if (healthy && portfile.cwd === projectRoot) {
      console.log(`[Ratel] Discovered running service at ${portfile.url}`);
      return new RatelServiceClient(portfile.url);
    }

    // Portfile exists but service isn't healthy or cwd mismatch
    if (!healthy) {
      console.log(
        `[Ratel] Existing portfile found but service at ${portfile.url} is not healthy. Starting a new one.`,
      );
    }
  }

  // 3. No healthy service — spawn one
  console.log(`[Ratel] Starting service for project: ${projectRoot}`);
  return waitForService(projectRoot, 15000);
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
): Promise<RatelServiceClient | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("ratel", ["--serve"], {
        cwd: projectRoot,
        stdio: "ignore",
        detached: false,
      });
    } catch (err) {
      console.error(
        `[Ratel] Failed to spawn ratel process: ${err instanceof Error ? err.message : String(err)}`,
      );
      resolve(null);
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
        console.error(
          `[Ratel] Service process exited (code=${code}, signal=${signal}) before becoming ready.`,
        );
        done(null);
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        console.error(
          `[Ratel] Service process error: ${err.message}`,
        );
        done(null);
      }
    });

    const interval = setInterval(async () => {
      // Timeout guard
      if (Date.now() - startTime > timeoutMs) {
        console.error(
          `[Ratel] Timed out after ${timeoutMs}ms waiting for service to start.`,
        );
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
        done(null);
        return;
      }

      // Poll for portfile + health
      const pf = await readServicePortfile(projectRoot);
      if (pf && pf.cwd === projectRoot) {
        const healthy = await healthCheck(pf.url);
        if (healthy) {
          console.log(`[Ratel] Auto-started service at ${pf.url}`);
          done(new RatelServiceClient(pf.url));
        }
      }
    }, 500);
  });
}
