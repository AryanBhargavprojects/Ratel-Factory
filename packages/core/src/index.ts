#!/usr/bin/env node
/**
 * Ratel Core Service — Entry Point
 *
 * Starts the HTTP API server and makes the factory core available
 * as a standalone service. Can be started with:
 *   node packages/core/dist/index.js --serve
 *
 * When --serve is used without --port, the service auto-discovers an
 * available port (8765–8799) and writes a .ratel/service.json portfile
 * so plugins can auto-discover it.
 */

import { startService, createApiServer, type ApiOptions, type ApiServer } from "./api.js";
import { writeFile, rename, mkdir, unlink, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { startService, createApiServer };
export type { ApiOptions, ApiServer } from "./api.js";

// Re-export control plane modules
export { MissionControlPlane } from "./control-plane/mission-control-plane.js";
export { JobRunner } from "./control-plane/job-runner.js";
export type { JobExecutor } from "./control-plane/job-runner.js";
export { MissionStore } from "./control-plane/mission-store.js";
export { JobStore } from "./control-plane/job-store.js";
export type { MissionRecord, MissionJob, MissionJobType, MissionJobStatus } from "./control-plane/types.js";

// Re-export core modules for programmatic use
export { OrchestratorAgent } from "./core/orchestrator.js";
export * from "./core/artifacts.js";
export * from "./core/config.js";
export * from "./core/types.js";
export * from "./core/tools.js";
export * from "./core/prompts.js";
export { spawnResearchAgent, spawnSmartFriendAgent, spawnContractAgent } from "./core/agents.js";
export { EventLogger, setGlobalLogger, getGlobalLogger, clearGlobalLogger } from "./core/observability/event-logger.js";
export { DEFAULT_ORCHESTRATOR_SKILLS_DIR, loadSkillsFromDir } from "./core/utils/skills.js";
export { createMissionScope, getMissionDir, getRatelDir, type MissionScope } from "./core/mission/scope.js";
export { readJsonFile, atomicWriteJson, atomicWriteFile } from "./core/mission/atomic-file.js";
export { BudgetManager } from "./core/budget/budget-manager.js";
export { ModelRouter } from "./core/models/model-router.js";
export { startObservatory, type ObservatoryHandle } from "./observatory/service.js";
export { startDashboardServer, startDashboardServerOnAvailablePort, getCurrentDashboardUrl } from "./observatory/server.js";
export { default as registerObservatoryDashboard } from "./observatory/dashboard.js";

// ---------------------------------------------------------------------------
// Portfile
// ---------------------------------------------------------------------------

interface ServicePortfile {
  pid: number;
  url: string;
  port: number;
  cwd: string;
  startedAt: string;
  version: string;
}

async function getPackageVersion(): Promise<string> {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), "..", "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

async function writeServicePortfile(api: ApiServer, cwd: string): Promise<void> {
  const ratelDir = join(cwd, ".ratel");
  await mkdir(ratelDir, { recursive: true });

  const portfile: ServicePortfile = {
    pid: process.pid,
    url: api.url,
    port: api.port,
    cwd,
    startedAt: new Date().toISOString(),
    version: await getPackageVersion(),
  };

  // Atomic write: tmp then rename
  const tmpPath = join(ratelDir, "service.json.tmp");
  const finalPath = join(ratelDir, "service.json");
  await writeFile(tmpPath, JSON.stringify(portfile, null, 2) + "\n", "utf-8");
  await rename(tmpPath, finalPath);
}

async function deleteServicePortfile(cwd: string): Promise<void> {
  try {
    await unlink(join(cwd, ".ratel", "service.json"));
  } catch {
    // Already deleted or never existed — ignore
  }
}

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 8765;
const MAX_PORT = 8799;

async function findAvailablePortAndStart(cwd: string): Promise<ApiServer> {
  let lastError: unknown = null;

  for (let port = DEFAULT_PORT; port <= MAX_PORT; port++) {
    try {
      return await startService({ cwd, port });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Could not find an available port in range ${DEFAULT_PORT}-${MAX_PORT}. Last error: ${msg}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldServe = args.includes("--serve");
  const cwd = process.cwd();

  if (shouldServe) {
    // Determine port: explicit or auto-discover
    const portIndex = args.indexOf("--port");
    const rawPort = portIndex !== -1 ? args[portIndex + 1] : undefined;
    const explicitPort =
      rawPort !== undefined ? Number.parseInt(rawPort, 10) : undefined;
    const hasExplicitPort =
      explicitPort !== undefined && !Number.isNaN(explicitPort);

    let api: ApiServer;

    if (hasExplicitPort) {
      api = await startService({ cwd, port: explicitPort as number });
    } else {
      api = await findAvailablePortAndStart(cwd);
    }

    // Write portfile so plugins can auto-discover the service
    await writeServicePortfile(api, cwd);
    console.log(`[Service] Portfile written to ${join(cwd, ".ratel", "service.json")}`);

    const shutdown = async (): Promise<void> => {
      console.log("\n[Service] Shutting down...");
      await deleteServicePortfile(cwd);
      await api.shutdown();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  } else {
    console.log("Ratel Core Service");
    console.log("Usage: node packages/core/dist/index.js --serve [--port <port>]");
  }
}

// ---------------------------------------------------------------------------
// ESM CLI entrypoint detection — robust against npm global symlinks
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) return false;
    return realpathSync(modulePath) === realpathSync(scriptPath);
  } catch {
    // realpathSync may throw if a path doesn't exist; fall back to importing
    // (not the main module if we can't resolve paths)
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
