/**
 * Ratel OpenCode Command Handlers
 *
 * Real implementations for /ratel, /ratel-mission, /ratel-observatory.
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
  cachedMissionId?: string;
  cachedJobId?: string;
}

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { command, client, service, cachedMissionId, cachedJobId } = ctx;

  async function log(level: "info" | "warning" | "error", message: string): Promise<void> {
    try {
      await client.app.log({ level, message });
    } catch {
      // Best-effort logging
    }
  }

  try {
    switch (command) {
      case "ratel": {
        console.log("[Ratel] /ratel command received — toggling factory mode");
        const health = await service.health();
        await log("info", `[Ratel] Service is ${health.status}. Use /ratel-mission for status, /ratel-observatory for dashboard.`);
        break;
      }
      case "ratel-mission": {
        console.log("[Ratel] /ratel-mission command received — showing mission status");
        if (!cachedMissionId) {
          await log("info", "[Ratel] No active mission. Start one with the ratel_start_mission tool.");
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
        await log("info", `[Ratel] ${lines.join("\n")}`);
        break;
      }
      case "ratel-observatory": {
        console.log("[Ratel] /ratel-observatory command received — opening dashboard");
        const status = await service.getObservatoryUrl();
        if (status.url) {
          await log("info", `[Ratel] Observatory: ${status.url}`);
        } else {
          await log("warning", "[Ratel] Observatory is not running. Start the service with `ratel --serve`.");
        }
        break;
      }
      default: {
        console.log(`[Ratel] Unknown command: ${command}`);
      }
    }
  } catch (err) {
    console.error(`[Ratel] Command error (${command}):`, err);
    await log("error", `[Ratel] Command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
