/**
 * Ratel Pi Extension — Command Handlers
 *
 * Real implementations for the Pi-native slash commands:
 *   /ratel, /ratel-start, /ratel-status, /ratel-approve,
 *   /ratel-mission (alias), /ratel-observatory
 *
 * All user feedback flows through `ctx.ui.notify` (Pi-native) — never raw
 * stdout/stderr — so messages render inside the Pi chat surface.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { RatelServiceClient, RatelServiceError } from "./service.js";

export interface CommandContext {
  command: string;
  args: string;
  ctx: ExtensionCommandContext;
  service: RatelServiceClient | null;
  cachedMissionId?: string;
  cachedJobId?: string;
}

function describeServiceError(err: unknown): string {
  if (err instanceof RatelServiceError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { command, args, ctx: extCtx, service, cachedMissionId, cachedJobId } = ctx;

  if (!service) {
    extCtx.ui.notify(
      "Ratel service is not available. Run `ratel --serve` or restart your Pi session.",
      "error",
    );
    return;
  }

  try {
    switch (command) {
      case "ratel": {
        try {
          const health = await service.health();
          if (health.status !== "ok") {
            extCtx.ui.notify("Ratel service health check failed. The factory may not be running.", "warning");
            return;
          }
          const ping = await service.pingAgents();
          const label = ping.ok ? "fully healthy" : "degraded";
          const lines: string[] = [
            `Ratel factory is ${label}. ${ping.ok ? "✅" : "⚠️"}`,
            "",
            ping.ok
              ? `All ${ping.totalAgents} subagent roles are online:`
              : `${ping.okCount}/${ping.totalAgents} subagent roles online (${ping.failedCount} failed):`,
            "",
            ...ping.agents.map(
              (a) => `  ${a.status === "ok" ? "✓" : "✗"} ${a.role}${a.timeMs ? ` (${a.timeMs}ms)` : ""}${a.error ? ` — ${a.error}` : ""}`,
            ),
            "",
            `Total ping time: ${(ping.totalTimeMs / 1000).toFixed(1)}s`,
          ];
          if (!ping.ok) {
            lines.push("Troubleshooting: check API credentials, ratel.json model strings, or /ratel-observatory.");
          }
          extCtx.ui.notify(lines.join("\n"), "info");
        } catch (err) {
          extCtx.ui.notify(`Could not ping Ratel factory agents: ${describeServiceError(err)}`, "warning");
        }
        break;
      }

      case "ratel-start": {
        const goal = args.trim();
        if (!goal) {
          extCtx.ui.notify("Usage: /ratel-start <mission goal>", "info");
          return;
        }
        const result = await service.startMission(goal);
        extCtx.ui.notify(
          `Mission queued: ${result.missionId} (job ${result.jobId}). Use ratel_poll_status to watch progress.`,
          "info",
        );
        break;
      }

      case "ratel-status":
      case "ratel-mission": {
        if (!cachedMissionId) {
          extCtx.ui.notify("No active mission. Start one with ratel_start_mission or /ratel-start.", "info");
          return;
        }
        const [mission, job] = await Promise.all([
          service
            .getMissionStatus(cachedMissionId)
            .catch((e: Error) => ({ missionId: cachedMissionId, status: `error: ${e.message}` })),
          cachedJobId
            ? service
                .getJobStatus(cachedMissionId, cachedJobId)
                .catch((e: Error) => ({ jobId: cachedJobId, status: `error: ${e.message}` }))
            : undefined,
        ]);
        const lines = [
          `Mission: ${(mission as { missionId: string }).missionId}`,
          `Status: ${(mission as { status: string }).status}`,
        ];
        if (job) {
          const j = job as { jobId?: string; status?: string };
          lines.push(`Job: ${j.jobId ?? cachedJobId} — status: ${j.status ?? "unknown"}`);
        }
        extCtx.ui.notify(lines.join("\n"), "info");
        break;
      }

      case "ratel-approve": {
        if (!cachedMissionId) {
          extCtx.ui.notify("No active mission to approve. Start one first.", "info");
          return;
        }
        const result = await service.approveMission(cachedMissionId, { approved: true });
        extCtx.ui.notify(
          `Mission approved: ${result.missionId} (job ${result.jobId}). Use ratel_poll_status to watch progress.`,
          "info",
        );
        break;
      }

      case "ratel-observatory": {
        const status = await service.getObservatoryUrl();
        if (status.url) {
          const url = cachedMissionId
            ? `${status.url}?missionId=${encodeURIComponent(cachedMissionId)}`
            : status.url;
          extCtx.ui.notify(`Ratel Observatory: ${url}`, "info");
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
    extCtx.ui.notify(`Ratel command failed: ${describeServiceError(err)}`, "error");
  }
}
