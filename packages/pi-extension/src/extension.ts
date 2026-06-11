/**
 * Ratel Pi Extension
 *
 * Thin adapter that registers lifecycle hooks, commands, and tools
 * for the Ratel AI Software Factory. Delegates to the service via HTTP.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RatelServiceClient } from "./service.js";
import { getToolsForPhase, type Phase } from "./tool-scope.js";
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
  const service = new RatelServiceClient(`http://localhost:${servicePort}/api`);

  let phase: Phase = "idle";

  // Persist state across sessions
  function persistState(): void {
    pi.appendEntry("ratel", { phase });
  }

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("ratel", {
    description: "Toggle Ratel factory mode",
    handler: async (_args, ctx) => {
      await handleCommand({ command: "ratel", ctx, service });
    },
  });

  pi.registerCommand("ratel-mission", {
    description: "Show current Ratel mission status",
    handler: async (_args, ctx) => {
      await handleCommand({ command: "ratel-mission", ctx, service });
    },
  });

  pi.registerCommand("ratel-observatory", {
    description: "Open Ratel Observatory dashboard",
    handler: async (_args, ctx) => {
      await handleCommand({ command: "ratel-observatory", ctx, service });
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
      return {
        content: [{ type: "text" as const, text: `Mission started: ${result.missionId}` }],
        details: { missionId: result.missionId },
      };
    },
  });

  pi.registerTool({
    name: "ratel_run_worker",
    label: "Run Worker",
    description:
      "Run a worker for a specific feature in the current mission.",
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
      return {
        content: [{ type: "text" as const, text: `Worker started: ${result.status}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "ratel_run_validator",
    label: "Run Validator",
    description:
      "Run validation for a milestone.",
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
      return {
        content: [{ type: "text" as const, text: `Validation started: ${result.status}` }],
        details: result,
      };
    },
  });

  // ── Lifecycle Hooks ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted state
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "ratel",
      )
      .pop() as { data?: { phase?: Phase } } | undefined;

    if (stateEntry?.data?.phase) {
      phase = stateEntry.data.phase;
    }

    // Update tool access based on phase
    if (phase !== "idle") {
      const activeTools = pi.getActiveTools();
      pi.setActiveTools(getToolsForPhase(activeTools, phase));
    }

    ctx.ui.setStatus("ratel", phase === "idle" ? undefined : `Ratel: ${phase}`);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (phase === "idle") return;

    // Inject factory context
    const prompt = getFactoryModePrompt();
    return {
      systemPrompt: prompt,
    };
  });

  pi.on("turn_end", async (event, _ctx) => {
    // Track phase transitions based on tool usage from the turn result
    const message = (event as any).message;
    if (!message) return;

    const toolCalls = (message as any).toolCalls ?? [];
    for (const tc of toolCalls) {
      if (tc.name === "ratel_start_mission") {
        phase = "planning";
        persistState();
      } else if (tc.name === "ratel_run_worker") {
        phase = "executing";
        persistState();
      } else if (tc.name === "ratel_run_validator") {
        phase = "validating";
        persistState();
      }
    }
  });

  // Gate writes during planning
  pi.on("tool_call", async (event, ctx) => {
    if (phase !== "planning") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const inputPath = event.input.path as string;
    // During planning, only allow markdown writes inside cwd
    const isMarkdown = /\.(md|mdx)$/i.test(inputPath);
    const isInsideCwd = inputPath.startsWith(ctx.cwd) || !inputPath.startsWith("/");
    if (!isMarkdown || !isInsideCwd) {
      return {
        block: true,
        reason: `Ratel: during planning, writes are limited to markdown files (.md, .mdx) inside the working directory. Blocked: ${inputPath}`,
      };
    }
  });
}
