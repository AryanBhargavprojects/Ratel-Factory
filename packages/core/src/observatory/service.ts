import type { Server } from "node:http";
import { startDashboardServerOnAvailablePort, type DashboardServerHandle } from "./server.js";
import type { ResolvedObservabilityConfig } from "../core/config.js";

export interface StartObservatoryOptions {
  cwd: string;
  config: ResolvedObservabilityConfig;
  controlPlane?: import("../control-plane/mission-control-plane.js").MissionControlPlane;
}

export interface ObservatoryHandle {
  enabled: boolean;
  port?: number;
  url?: string;
  server?: Server;
  shutdown: () => Promise<void>;
}

function disabledHandle(): ObservatoryHandle {
  return {
    enabled: false,
    shutdown: async () => undefined,
  };
}

function enabledHandle(handle: DashboardServerHandle): ObservatoryHandle {
  return {
    enabled: true,
    port: handle.port,
    url: handle.url,
    server: handle.server,
    shutdown: handle.close,
  };
}

/**
 * Start the read-only Observatory dashboard as part of factory startup.
 *
 * This is intentionally deterministic and fail-soft:
 * - enabled by default via config resolution
 * - started before InteractiveMode receives the first user prompt
 * - port conflicts fall back to the next available port
 * - startup failures are reported but never prevent the factory from running
 */
export async function startObservatory(options: StartObservatoryOptions): Promise<ObservatoryHandle> {
  const { cwd, config } = options;

  if (!config.enabled) {
    console.log("[Observatory] Disabled by ratel.json observability.enabled=false.");
    return disabledHandle();
  }

  try {
    const dashboard = await startDashboardServerOnAvailablePort({
      cwd,
      port: config.port,
    });

    if (config.autoOpen) {
      console.warn("[Observatory] autoOpen=true is configured, but browser auto-open is not implemented yet. Open the printed URL manually.");
    }

    return enabledHandle(dashboard);
  } catch (err) {
    console.warn(
      "[Observatory] Failed to start dashboard; continuing without Observatory:",
      err instanceof Error ? err.message : err,
    );
    return disabledHandle();
  }
}
