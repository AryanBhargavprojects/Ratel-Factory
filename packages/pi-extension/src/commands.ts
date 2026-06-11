/**
 * Ratel Pi Extension — Command Handlers
 *
 * Stub implementations for /ratel, /ratel-mission, /ratel-observatory.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RatelServiceClient } from "./service.js";

export interface CommandContext {
  command: string;
  ctx: ExtensionContext;
  service: RatelServiceClient;
}

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { command, ctx: extCtx, service } = ctx;

  try {
    switch (command) {
      case "ratel": {
        const health = await service.health();
        extCtx.ui.notify(`Ratel service is ${health.status}. Use /ratel-mission for status, /ratel-observatory for dashboard.`, "info");
        break;
      }
      case "ratel-mission": {
        extCtx.ui.notify("Ratel: Mission status not yet implemented in extension.", "info");
        break;
      }
      case "ratel-observatory": {
        const status = await service.getObservatoryUrl();
        if (status.url) {
          extCtx.ui.notify(`Ratel Observatory: ${status.url}`, "info");
        } else {
          extCtx.ui.notify("Ratel Observatory is not running. Start the service with `ratel --serve`.", "warning");
        }
        break;
      }
      default: {
        extCtx.ui.notify(`Unknown Ratel command: ${command}`, "error");
      }
    }
  } catch (err) {
    console.error(`[Ratel] Command error (${command}):`, err);
    extCtx.ui.notify(`Ratel command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
