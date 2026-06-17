/**
 * Ratel OpenCode Command Handlers
 *
 * Real implementations for /ratel, /ratel-mission, /ratel-observatory.
 * These are intercepted by the plugin and handled here.
 */

import type { RatelServiceClient, RatelServiceError } from "./service.js";

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
      if (client?.app?.log) {
        await client.app.log({ level, message });
      } else {
        // Fallback: print to console when client.app.log is unavailable
        const prefix = level === "error" ? "[Ratel ERROR]" : level === "warning" ? "[Ratel WARN]" : "[Ratel]";
        console.log(`${prefix} ${message}`);
      }
    } catch {
      // Best-effort logging — never let logging errors propagate
    }
  }

  function healthFailureMessage(err: unknown): string {
    const detail = err instanceof Error ? err.message : String(err);
    return [
      `[Ratel] Could not connect to the Ratel service.`,
      `[Ratel] Error: ${detail}`,
      `[Ratel] Start it with: ratel --serve`,
      `[Ratel] Or set RATEL_SERVICE_URL to the correct URL.`,
    ].join("\n");
  }

  try {
    switch (command) {
      case "ratel": {
        console.log("[Ratel] /ratel command received — pinging factory agents");
        try {
          // Fast sanity check first
          const health = await service.health();
          if (health.status !== "ok") {
            await log("warning", "[Ratel] Service health check failed. The factory may not be running.");
            return;
          }

          // Full per-agent ping
          const ping = await service.pingAgents();
          const statusIcon = ping.ok ? "✅" : "⚠️";
          const statusLabel = ping.ok ? "fully healthy" : "degraded";

          const lines: string[] = [
            `Ratel factory is ${statusLabel}. ${statusIcon}`,
            "",
            ping.ok
              ? `All ${ping.totalAgents} subagent roles are online and responding:`
              : `${ping.okCount}/${ping.totalAgents} subagent roles are online (${ping.failedCount} failed):`,
            "",
          ];

          // Table header
          const colRole = "Role";
          const colStatus = "Status";
          const colLatency = "Latency";
          const roleW = Math.max(colRole.length, ...ping.agents.map(a => a.role.length));
          const statusW = Math.max(colStatus.length, ...ping.agents.map(a => a.status.length));
          const latencyW = Math.max(colLatency.length, ...ping.agents.map(a => `${(a.timeMs / 1000).toFixed(1)}s`.length));

          const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
          const sep = `├${"─".repeat(roleW + 2)}┼${"─".repeat(statusW + 2)}┼${"─".repeat(latencyW + 2)}┤`;
          const top = `┌${"─".repeat(roleW + 2)}┬${"─".repeat(statusW + 2)}┬${"─".repeat(latencyW + 2)}┐`;
          const bot = `└${"─".repeat(roleW + 2)}┴${"─".repeat(statusW + 2)}┴${"─".repeat(latencyW + 2)}┘`;

          lines.push(top);
          lines.push(`│ ${pad(colRole, roleW)} │ ${pad(colStatus, statusW)} │ ${pad(colLatency, latencyW)} │`);
          lines.push(sep);

          for (const a of ping.agents) {
            const icon = a.status === "ok" ? "OK" : a.status.toUpperCase();
            const lat = `${(a.timeMs / 1000).toFixed(1)}s`;
            lines.push(`│ ${pad(a.role, roleW)} │ ${pad(icon, statusW)} │ ${pad(lat, latencyW)} │`);
          }

          lines.push(bot);
          lines.push("");

          if (!ping.ok) {
            lines.push("Troubleshooting:");
            lines.push("  - Check API credentials for the configured provider");
            lines.push("  - Verify model strings in ratel.json");
            lines.push("  - Use /ratel-observatory for the dashboard");
          }

          lines.push(`Total ping time: ${(ping.totalTimeMs / 1000).toFixed(1)}s`);

          await log("info", `[Ratel] ${lines.join("\n")}`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await log("warning", [
            `[Ratel] Could not ping factory agents.`,
            `[Ratel] Error: ${detail}`,
            `[Ratel] Start the service with: ratel --serve`,
            `[Ratel] Or set RATEL_SERVICE_URL to the correct URL.`,
          ].join("\n"));
        }
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
        try {
          const status = await service.getObservatoryUrl();
          if (status.url) {
            await log("info", `[Ratel] Observatory: ${status.url}`);
          } else {
            await log("warning", "[Ratel] Observatory is not running. Start the service with `ratel --serve`.");
          }
        } catch (err) {
          await log("warning", healthFailureMessage(err));
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
