/**
 * Ratel OpenCode Command Handlers
 *
 * Stub implementations for /ratel, /ratel-mission, /ratel-observatory.
 * These are intercepted by the plugin and handled here.
 */

import type { RatelServiceClient } from "./service.js";

export interface CommandContext {
  command: string;
  client: any;
  sessionId: string;
  rawArgs: string;
  cwd: string;
  service: RatelServiceClient;
}

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { command, client, service } = ctx;

  try {
    switch (command) {
      case "ratel": {
        console.log("[Ratel] /ratel command received — toggling factory mode");
        const health = await service.health();
        try {
          await client.app.log({
            level: "info",
            message: `[Ratel] Service is ${health.status}. Use /ratel-mission for status, /ratel-observatory for dashboard.`,
          });
        } catch {
          // Best-effort logging
        }
        break;
      }
      case "ratel-mission": {
        console.log("[Ratel] /ratel-mission command received — showing mission status");
        try {
          await client.app.log({
            level: "info",
            message: "[Ratel] Mission status: active mission context not yet implemented in plugin.",
          });
        } catch {
          // Best-effort logging
        }
        break;
      }
      case "ratel-observatory": {
        console.log("[Ratel] /ratel-observatory command received — opening dashboard");
        const status = await service.getObservatoryUrl();
        if (status.url) {
          try {
            await client.app.log({
              level: "info",
              message: `[Ratel] Observatory: ${status.url}`,
            });
          } catch {
            // Best-effort logging
          }
        } else {
          try {
            await client.app.log({
              level: "warning",
              message: "[Ratel] Observatory is not running. Start the service with `ratel --serve`.",
            });
          } catch {
            // Best-effort logging
          }
        }
        break;
      }
      default: {
        console.log(`[Ratel] Unknown command: ${command}`);
      }
    }
  } catch (err) {
    console.error(`[Ratel] Command error (${command}):`, err);
    try {
      await client.app.log({
        level: "error",
        message: `[Ratel] Command failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      // Best-effort logging
    }
  }
}
