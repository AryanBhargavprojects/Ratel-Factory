/**
 * Ratel Core Service — Entry Point
 *
 * Starts the HTTP API server and makes the factory core available
 * as a standalone service. Can be started with:
 *   node packages/core/dist/index.js --serve
 */

import { startService, createApiServer, type ApiOptions } from "./api.js";

export { startService, createApiServer };
export type { ApiOptions, ApiServer } from "./api.js";

// Re-export core modules for programmatic use
export { OrchestratorAgent } from "./core/orchestrator.js";
export * from "./core/artifacts.js";
export * from "./core/config.js";
export * from "./core/types.js";
export * from "./core/tools.js";
export * from "./core/prompts.js";
export { startObservatory } from "./observatory/service.js";
export { startDashboardServer, startDashboardServerOnAvailablePort, getCurrentDashboardUrl } from "./observatory/server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldServe = args.includes("--serve");
  const cwd = process.cwd();

  if (shouldServe) {
    const portIndex = args.indexOf("--port");
    const port = portIndex !== -1 ? Number.parseInt(args[portIndex + 1], 10) || 8765 : 8765;
    const api = await startService({ cwd, port });

    const shutdown = async (): Promise<void> => {
      console.log("\n[Service] Shutting down...");
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
