/**
 * Ratel Observatory Dashboard — Pi Extension
 *
 * Registers a `view_observatory` tool that launches the Ratel Observatory
 * dashboard server. The orchestrator can call this tool to give the user
 * a live view of factory activity (agent lifecycles, tool calls, parse
 * status, phase transitions).
 *
 * The dashboard is a READ-ONLY view over the events.jsonl file written by
 * the EventLogger in event-logger.ts. It does not modify any state.
 *
 * Browser launch strategy (Phase 2):
 *   - ctx.notify shows a TUI toast with the URL (interactive mode only)
 *   - The server also prints the URL to stdout (works in all modes)
 *   - No auto-open: the user clicks the URL or copies it
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startDashboardServer } from "./server.js";
import type { Server } from "node:http";

let activeServer: Server | undefined;

export default function register(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "view_observatory",
      label: "View Observatory Dashboard",
      description:
        "Launch the Ratel Observatory dashboard server. The dashboard is a " +
        "live, read-only view of the factory's events.jsonl — it shows agent " +
        "lifecycles, tool calls, parse status, phase transitions, and halts in " +
        "real time. Useful at any point during a mission to give the user " +
        "visibility into what is happening. The URL is printed to stdout and " +
        "shown as a TUI notification.",
      parameters: Type.Object({
        port: Type.Number({
          default: 8765,
          description: "Port for the dashboard server",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const cwd = process.cwd();
        const port = params.port;

        // Stop any previously launched server so we can swap ports or restart cleanly.
        if (activeServer) {
          try {
            activeServer.close();
          } catch {
            /* ignore close errors */
          }
          activeServer = undefined;
        }

        activeServer = startDashboardServer({ cwd, port });

        const url = `http://localhost:${port}`;

        // Best-effort TUI toast (only works in interactive mode; no-op elsewhere).
        try {
          pi.sendUserMessage?.(`🛰️  Observatory dashboard running at ${url}`);
        } catch {
          /* extension context may not have UI methods */
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Observatory dashboard running at ${url}\n\nThe URL has also been printed to stdout. Open it in a browser to see the live timeline.`,
            },
          ],
          details: { port, url, pid: process.pid },
        };
      },
    }),
  );
}
