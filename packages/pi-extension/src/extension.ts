/**
 * Ratel Pi Extension
 *
 * Thin adapter that registers lifecycle hooks, commands, and tools
 * for the Ratel AI Software Factory. Delegates to the service via HTTP.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export default function RatelExtension(pi: ExtensionAPI): void {
  const servicePort = getServicePort();
  const service = new RatelServiceClient(`http://127.0.0.1:${servicePort}`);

  // Convenience cache for UI continuity; always refresh from service
  let cachedMissionId: string | undefined;
  let cachedJobId: string | undefined;

  // Persist only IDs across sessions for UI convenience
  function persistIds(): void {
    pi.appendEntry("ratel", { missionId: cachedMissionId, jobId: cachedJobId });
  }

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("ratel", {
    description: "Toggle Ratel factory mode",
    handler: async (_args, ctx) => {
      await handleCommand({ command: "ratel", ctx, service, cachedMissionId, cachedJobId });
    },
  });

  pi.registerCommand("ratel-mission", {
    description: "Show current Ratel mission status",
    handler: async (_args, ctx) => {
      await handleCommand({ command: "ratel-mission", ctx, service, cachedMissionId, cachedJobId });
    },
  });

  pi.registerCommand("ratel-observatory", {
    description: "Open Ratel Observatory dashboard",
    handler: async (_args, ctx) => {
      await handleCommand({ command: "ratel-observatory", ctx, service, cachedMissionId, cachedJobId });
    },
  });

  // ── Tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ratel_start_mission",
    label: "Start Mission",
    description:
      "Start a new Ratel factory mission with a goal. " +
      "The factory will run intake, discovery, and produce a validation contract.",
    parameters: {
      type: "object" as const,
      properties: {
        goal: {
          type: "string" as const,
          description: "The mission goal or user request",
        },
      },
      required: ["goal"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await service.startMission((params as { goal: string }).goal);
      cachedMissionId = result.missionId;
      cachedJobId = result.jobId;
      persistIds();
      return {
        content: [{ type: "text" as const, text: `Mission queued: ${result.missionId} (job ${result.jobId})` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "ratel_run_worker",
    label: "Run Worker",
    description: "Run a worker for a specific feature in the current mission.",
    parameters: {
      type: "object" as const,
      properties: {
        missionId: {
          type: "string" as const,
          description: "Mission ID",
        },
        featureId: {
          type: "string" as const,
          description: "Feature ID to run",
        },
      },
      required: ["missionId", "featureId"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { missionId, featureId } = params as { missionId: string; featureId: string };
      const result = await service.runWorker(missionId, featureId);
      cachedMissionId = result.missionId;
      cachedJobId = result.jobId;
      persistIds();
      return {
        content: [{ type: "text" as const, text: `Worker queued: ${result.jobId} for mission ${result.missionId}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "ratel_run_validator",
    label: "Run Validator",
    description: "Run validation for a milestone.",
    parameters: {
      type: "object" as const,
      properties: {
        missionId: {
          type: "string" as const,
          description: "Mission ID",
        },
        milestoneId: {
          type: "string" as const,
          description: "Milestone ID to validate",
        },
      },
      required: ["missionId", "milestoneId"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { missionId, milestoneId } = params as { missionId: string; milestoneId: string };
      const result = await service.runValidation(missionId, milestoneId);
      cachedMissionId = result.missionId;
      cachedJobId = result.jobId;
      persistIds();
      return {
        content: [{ type: "text" as const, text: `Validation queued: ${result.jobId} for mission ${result.missionId}` }],
        details: result,
      };
    },
  });

  // ── Lifecycle Hooks ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted IDs
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "ratel",
      )
      .pop() as { data?: { missionId?: string; jobId?: string } } | undefined;

    if (stateEntry?.data?.missionId) {
      cachedMissionId = stateEntry.data.missionId;
    }
    if (stateEntry?.data?.jobId) {
      cachedJobId = stateEntry.data.jobId;
    }

    ctx.ui.setStatus("ratel", cachedMissionId ? `Ratel: ${cachedMissionId}` : undefined);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!cachedMissionId) return;

    // Inject factory context
    const prompt = getFactoryModePrompt();
    return {
      systemPrompt: prompt,
    };
  });

  // Gate factory-specific mutating tools against latest service state
  pi.on("tool_call", async (event, ctx) => {
    const factoryMutatingTools = new Set([
      "ratel_start_mission",
      "ratel_run_worker",
      "ratel_run_validator",
    ]);

    if (!factoryMutatingTools.has(event.toolName)) return;

    try {
      const health = await service.health();
      if (health.status !== "ok") {
        return {
          block: true,
          reason: `Ratel service is unhealthy (${health.status}). Factory mutating tools are disabled. Start the service with \`ratel --serve\` and retry.`,
        };
      }
    } catch {
      return {
        block: true,
        reason: `Ratel service is unreachable. Factory mutating tools are disabled. Start the service with \`ratel --serve\` and retry.`,
      };
    }
  });
}
