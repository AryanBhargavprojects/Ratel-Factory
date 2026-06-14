/**
 * Ratel Pi Extension — Command Handlers
 *
 * Real implementations for /ratel, /ratel-mission, /ratel-observatory.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RatelServiceClient } from "./service.js";

export interface CommandContext {
  command: string;
  ctx: ExtensionContext;
  service: RatelServiceClient;
  cachedMissionId?: string;
  cachedJobId?: string;
}

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { command, ctx: extCtx, service, cachedMissionId, cachedJobId } = ctx;

  try {
    switch (command) {
      case "ratel": {
        const health = await service.health();
        extCtx.ui.notify(
          `Ratel service is ${health.status}. Use /ratel-mission for status, /ratel-observatory for dashboard.`,
          "info",
        );
        break;
      }
      case "ratel-mission": {
        if (!cachedMissionId) {
          extCtx.ui.notify("No active mission. Start one with the ratel_start_mission tool.", "info");
          return;
        }
        const [mission, job] = await Promise.all([
          service.getMissionStatus(cachedMissionId).catch((e: Error) => ({ missionId: cachedMissionId, state: { error: e.message } })),
          cachedJobId ? service.getJobStatus(cachedMissionId, cachedJobId).catch((e: Error) => ({ jobId: cachedJobId, status: `error: ${e.message}` })) : undefined,
        ]);
        const lines = [
          `Mission: ${mission.missionId}`,
          `State: ${JSON.stringify(mission.state, null, 2)}`,
        ];
        if (job) {
          lines.push(`Job: ${(job as any).jobId ?? cachedJobId} — status: ${(job as any).status ?? "unknown"}`);
        }
        extCtx.ui.notify(lines.join("\n"), "info");
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
