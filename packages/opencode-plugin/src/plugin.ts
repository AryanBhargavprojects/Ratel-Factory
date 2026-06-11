/**
 * Ratel OpenCode Plugin
 *
 * Thin adapter that registers tools, commands, and prompt injection
 * for the Ratel AI Software Factory. Delegates all work to the Ratel
 * service via HTTP.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { RatelServiceClient } from "./service.js";
import { handleCommand } from "./commands.js";
import { getFactoryModePrompt } from "./prompts.js";

const DEFAULT_SERVICE_PORT = 8765;

function getServicePort(): number {
  const raw = process.env.RATEL_SERVICE_PORT?.trim();
  if (!raw) return DEFAULT_SERVICE_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVICE_PORT;
}

const RatelPlugin: Plugin = async (ctx: any) => {
  const servicePort = getServicePort();
  const service = new RatelServiceClient(`http://localhost:${servicePort}/api`);

  const plugin: any = {
    config: async (opencodeConfig: any) => {
      // Inject factory instructions when in factory mode
      if (process.env.RATEL_FACTORY_MODE === "1" || process.env.RATEL_FACTORY_MODE === "true") {
        opencodeConfig.system = opencodeConfig.system ?? [];
        if (!opencodeConfig.system.some((s: string) => s.includes("Ratel Factory"))) {
          opencodeConfig.system.push(getFactoryModePrompt());
        }
      }
    },

    // Intercept /ratel-* commands before the agent sees them
    "command.execute.before": async (input: any, output: any) => {
      const cmd = input.command;
      if (
        cmd !== "ratel" &&
        cmd !== "ratel-mission" &&
        cmd !== "ratel-observatory"
      ) return;

      // Suppress the command text so the agent doesn't process it
      output.parts.length = 0;

      const event = {
        properties: { sessionID: input.sessionID, arguments: input.arguments },
      };

      await handleCommand({
        command: cmd,
        client: ctx.client,
        sessionId: input.sessionID,
        rawArgs: input.arguments ?? "",
        cwd: ctx.directory,
        service,
      });
    },

    // Tool definitions
    tool: {
      ratel_start_mission: {
        description: "Start a new Ratel factory mission with a goal.",
        args: {
          goal: {
            type: "string",
            description: "The mission goal or user request",
          },
        },
        async execute(args: any) {
          const result = await service.startMission(args.goal ?? "");
          return `Mission started: ${result.missionId}`;
        },
      },
      ratel_get_status: {
        description: "Get the current mission status.",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID to query",
          },
        },
        async execute(args: any) {
          const result = await service.getStatus(args.missionId ?? "");
          return JSON.stringify(result, null, 2);
        },
      },
      ratel_run_worker: {
        description: "Run a worker for a specific feature.",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID",
          },
          featureId: {
            type: "string",
            description: "Feature ID to run",
          },
        },
        async execute(args: any) {
          const result = await service.runWorker(args.missionId ?? "", args.featureId ?? "");
          return `Worker started: ${result.status}`;
        },
      },
      ratel_run_validation: {
        description: "Run validation for a milestone.",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID",
          },
          milestoneId: {
            type: "string",
            description: "Milestone ID to validate",
          },
        },
        async execute(args: any) {
          const result = await service.runValidation(args.missionId ?? "", args.milestoneId ?? "");
          return `Validation started: ${result.status}`;
        },
      },
    },
  };

  return plugin;
};

export default RatelPlugin;
