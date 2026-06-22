/**
 * Ratel Pi Extension — Command Handlers
 *
 * Real implementations for the Pi-native slash commands:
 *   /ratel, /ratel-start, /ratel-status, /ratel-approve,
 *   /ratel-mission (alias), /ratel-observatory
 *
 * All commands are backed by the in-process {@link RatelRuntime} — there is
 * no separate daemon and no out-of-band process. User feedback flows
 * through `ctx.ui.notify` (Pi-native), never raw stdout/stderr.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RatelRuntime } from "./runtime.js";

export interface CommandContext {
  command: string;
  args: string;
  ctx: ExtensionCommandContext;
  runtime: RatelRuntime;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleCommand(ctx: CommandContext): Promise<void> {
  const { command, args, ctx: extCtx, runtime } = ctx;

  try {
    switch (command) {
      case "ratel": {
        const ping = await runtime.pingAgents();
        const lines: string[] = [
          "Ratel Factory (in-process, Pi extension): available ✓",
          "",
          ping.ok
            ? `All ${ping.totalAgents} factory roles report local availability:`
            : `${ping.okCount}/${ping.totalAgents} factory roles available (${ping.failedCount} unavailable):`,
          "",
          ...ping.agents.map(
            (a) => `  ✓ ${a.role}${a.detail ? ` — ${a.detail}` : ""}`,
          ),
          "",
          "No separate daemon is required. The orchestrator runs inside this Pi session.",
        ];
        if (!runtime.getMissionId()) {
          lines.push("", "No active mission. Start one with /ratel-start <goal>.");
        }
        extCtx.ui.notify(lines.join("\n"), "info");
        break;
      }

      case "ratel-start": {
        const goal = args.trim();
        if (!goal) {
          extCtx.ui.notify("Usage: /ratel-start <mission goal>", "info");
          return;
        }
        extCtx.ui.notify(`Starting Ratel mission in-process: ${goal.slice(0, 80)}…`, "info");
        const result = await runtime.startMission(goal);
        extCtx.ui.notify(
          `Mission started: ${result.missionId}. Use ratel_poll_status to watch progress.`,
          "info",
        );
        break;
      }

      case "ratel-status":
      case "ratel-mission": {
        const status = await runtime.getStatus();
        if (!status.active) {
          extCtx.ui.notify(status.message ?? "No active mission. Start one with /ratel-start.", "info");
          return;
        }
        const lines = [
          `Mission: ${status.missionId}`,
          `Phase: ${status.phase ?? "unknown"}`,
          `Status: ${status.status ?? "unknown"}`,
        ];
        if (status.goal) lines.push(`Goal: ${status.goal}`);
        if (status.updatedAt) lines.push(`Updated: ${status.updatedAt}`);
        extCtx.ui.notify(lines.join("\n"), "info");
        break;
      }

      case "ratel-approve": {
        const status = await runtime.getStatus();
        if (!status.active) {
          extCtx.ui.notify("No active mission to approve. Start one with /ratel-start.", "info");
          return;
        }
        await runtime.approvePlan(true);
        extCtx.ui.notify(
          `Mission ${status.missionId} approved in-process. Use ratel_poll_status to watch progress.`,
          "info",
        );
        break;
      }

      case "ratel-observatory": {
        const info = await runtime.getObservatoryInfo();
        if (info.enabled && info.url) {
          const url = info.missionDir
            ? `${info.url}?missionId=${encodeURIComponent(runtime.getMissionId() ?? "")}`
            : info.url;
          extCtx.ui.notify(`Ratel Observatory: ${url}`, "info");
        } else if (info.missionDir) {
          extCtx.ui.notify(
            `Observatory dashboard is not running in this session. Mission artifacts are at: ${info.missionDir}`,
            "info",
          );
        } else {
          extCtx.ui.notify(
            "No active mission. Start one with /ratel-start to populate .ratel/missions/<missionId>/.",
            "info",
          );
        }
        break;
      }

      default: {
        extCtx.ui.notify(`Unknown Ratel command: ${command}`, "error");
      }
    }
  } catch (err) {
    extCtx.ui.notify(`Ratel command failed: ${describeError(err)}`, "error");
  }
}
