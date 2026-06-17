/**
 * Ratel OpenCode Plugin
 *
 * Thin adapter that registers tools, commands, and prompt injection
 * for the Ratel AI Software Factory. Delegates all work to the Ratel
 * service via HTTP.
 *
 * Auto-discovers or auto-starts the Ratel core service using the
 * .ratel/service.json portfile.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { RatelServiceClient, RatelServiceError } from "./service.js";
import { ensureRatelService } from "./service-lifecycle.js";
import { handleCommand } from "./commands.js";
import { getFactoryModePrompt } from "./prompts.js";
import {
  bridgeOpenCodeAuthForProject,
  extractProviderId,
  type BridgeResult,
} from "./auth-bridge.js";
import { resolveProjectRoot } from "./resolve-project-root.js";

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

const DEBUG_ENABLED = process.env.RATEL_OPENCODE_DEBUG === "1";
const DEBUG_LOG_PATH = "/tmp/ratel-opencode-command-hook.log";

function debugLog(entry: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Best-effort debug logging — never let it propagate
  }
}

// ---------------------------------------------------------------------------
// Command normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw command string from OpenCode.
 * OpenCode may pass commands like "/ratel", "/ratel-mission", or with
 * leading/trailing whitespace. This helper strips those variations so we
 * can match against the bare command name.
 */
function normalizeCommand(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.trim();
  // Strip all leading '/' characters (handles "/ratel", "//ratel", etc.)
  s = s.replace(/^\/+/, "");
  // Strip a leading "command:" prefix if OpenCode passes it that way
  s = s.replace(/^command:\s*/i, "");
  return s;
}

// ---------------------------------------------------------------------------
// Part text extraction
// ---------------------------------------------------------------------------

/**
 * Safely extract a preview string from output.parts for inference.
 * output.parts is an array of TextPart / ToolUsePart / etc. objects.
 * We join their text-like content into a single preview string.
 */
function safeStringifyParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  try {
    return parts
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.text && typeof p.text === "string") return p.text;
        if (p?.content && typeof p.content === "string") return p.content;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Replace output.parts in-place with a single text part containing
 * the given prompt string. This mutates the existing array so that
 * OpenCode reads the rewritten prompt on the same turn.
 */
function replaceCommandParts(output: any, text: string): void {
  if (!output?.parts || !Array.isArray(output.parts)) return;
  output.parts.length = 0;
  output.parts.push({ type: "text", text } as any);
}

// Deterministic prompt for /ratel so fallback command-file behaviour
// matches the prompt rewriting done in the hook.
const RATEL_PROMPT = [
  "This is the /ratel factory health command.",
  "Call the ratel_ping_agents tool exactly once.",
  "Do not call bash, read, grep, find, ls, or inspect the codebase.",
  "After the tool result, report only the factory health summary and per-agent statuses.",
].join("\n");

/**
 * Infer the Ratel command name from output.parts text when input.command
 * is not a direct /ratel command.
 *
 * This makes interception resilient: if OpenCode passes an unexpected
 * input.command value but the command template text is exposed in
 * output.parts, we can still match and suppress.
 */
function inferRatelCommand(partText: string): string | null {
  const lower = partText.toLowerCase();
  if (lower.includes("ping ratel factory health")) return "ratel";
  if (lower.includes("show current mission status")) return "ratel-mission";
  if (lower.includes("open ratel observatory dashboard")) return "ratel-observatory";
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const SERVICE_UNAVAILABLE_MSG =
  "Ratel service is not available. Run `ratel --serve` manually or restart OpenCode.";

const RatelPlugin: Plugin = async (ctx: any) => {
  // Determine project root deterministically, guarding against a
  // filesystem-root worktree that OpenCode sometimes reports.
  const projectRoot: string = resolveProjectRoot(ctx);

  // Auto-discover or auto-start the Ratel service
  const service = await ensureRatelService(projectRoot);

  if (!service) {
    console.error(
      "[Ratel] Service could not be started. Check that `ratel` is installed and on PATH.",
    );
  }

  // Convenience cache for UI continuity; always refresh from service
  let cachedMissionId: string | undefined;
  let cachedJobId: string | undefined;

  // Auth bridge: in-flight promise guard only.
  // Runs before every tool path that spawns subagents so we never miss
  // ratel.json or OpenCode provider/model changes. Concurrent calls share
  // the same bridge promise to avoid races.
  let authBridgeInflight: Promise<BridgeResult | null> | null = null;

  /** Defensively extract provider IDs from an OpenCode config object. */
  function detectOpenCodeProviders(opencodeConfig: unknown): string[] {
    const providers = new Set<string>();
    if (!opencodeConfig || typeof opencodeConfig !== "object") return [];
    const c = opencodeConfig as Record<string, unknown>;
    // model: "provider/model"
    const p1 = extractProviderId(c.model as string | undefined);
    if (p1) providers.add(p1);
    // small_model: "provider/model"
    const p2 = extractProviderId(c.small_model as string | undefined);
    if (p2) providers.add(p2);
    // provider: { "provider-name": { ... } } keys
    if (c.provider && typeof c.provider === "object") {
      for (const key of Object.keys(c.provider as Record<string, unknown>)) {
        if (key) providers.add(key);
      }
    }
    return [...providers];
  }

  // Capture OpenCode config for provider detection.
  // Set during the config hook and read during bridge.
  let openCodeConfigSnapshot: unknown = undefined;

  async function ensureAuthBridge(): Promise<BridgeResult | null> {
    // Reuse in-flight bridge promise so concurrent tool calls don't
    // race against each other.
    if (authBridgeInflight) return authBridgeInflight;

    authBridgeInflight = (async (): Promise<BridgeResult | null> => {
      try {
        // Detect extra provider IDs from the captured OpenCode config
        let extraProviderIds: string[] | undefined;
        if (openCodeConfigSnapshot) {
          extraProviderIds = detectOpenCodeProviders(openCodeConfigSnapshot);
        }

        const result = await bridgeOpenCodeAuthForProject(projectRoot, extraProviderIds);

        if (result.bridgedProviders.length > 0) {
          const names = result.bridgedProviders.join(", ");
          console.log(`[Ratel] Auth bridge: synced ${names} from OpenCode credentials`);
        }
        if (result.missingProviders.length > 0) {
          const names = result.missingProviders.join(", ");
          console.log(`[Ratel] Auth bridge: no OpenCode credentials found for ${names}`);
        }
        return result;
      } catch (err) {
        console.log(
          `[Ratel] Auth bridge: skipped (${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      } finally {
        authBridgeInflight = null;
      }
    })();

    return authBridgeInflight;
  }

  // -----------------------------------------------------------------------
  // Safe logging helper
  // -----------------------------------------------------------------------
  async function safeLog(level: "info" | "warning" | "error", message: string): Promise<void> {
    try {
      if (ctx?.client?.app?.log) {
        await ctx.client.app.log({ level, message });
      } else {
        const prefix = level === "error" ? "[Ratel ERROR]" : level === "warning" ? "[Ratel WARN]" : "[Ratel]";
        console.log(`${prefix} ${message}`);
      }
    } catch {
      // Never let logging errors propagate
    }
  }

  const plugin: any = {
    config: async (opencodeConfig: any) => {
      // Capture config snapshot for later provider detection in auth bridge
      openCodeConfigSnapshot = opencodeConfig;

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
      // Extract command info for diagnostics
      const rawCommand = input.command;
      const normalizedCommand = normalizeCommand(rawCommand);
      const partTextPreview = safeStringifyParts(output?.parts);
      const partCount = Array.isArray(output?.parts) ? output.parts.length : 0;
      const inferredCommand = inferRatelCommand(partTextPreview);

      // Always log for diagnostics when debug is enabled
      debugLog({
        rawCommand,
        normalizedCommand,
        inferredCommand,
        partTextPreview: partTextPreview.slice(0, 200),
        partCount,
      });

      // Best-effort console log so live tests can confirm the hook fires
      console.log(
        `[Ratel] command.execute.before raw=${JSON.stringify(rawCommand)} normalized=${normalizedCommand} inferred=${inferredCommand}`,
      );

      // Determine the effective command: use normalized input, fall back to
      // inference from parts (resilient if OpenCode passes unexpected input.command).
      const effectiveCommand =
        normalizedCommand === "ratel" ||
        normalizedCommand === "ratel-mission" ||
        normalizedCommand === "ratel-observatory"
          ? normalizedCommand
          : inferredCommand;

      if (!effectiveCommand) return;

      // ── /ratel ────────────────────────────────────────────────
      // Deterministic tool-prompt rewriting instead of clearing the
      // prompt.  OpenCode 1.17.7 does NOT cancel the model turn when
      // output.parts.length === 0; it still runs the model with an
      // empty prompt and starts exploration.  Replace the command
      // text in-place so the model gets a single, locked instruction.
      if (effectiveCommand === "ratel") {
        replaceCommandParts(output, RATEL_PROMPT);
        return;
      }

      // ── /ratel-mission & /ratel-observatory ─────────────────
      // Suppress the prompt and handle via direct service calls
      // (existing behaviour kept for now).
      if (output?.parts && Array.isArray(output.parts)) {
        output.parts.length = 0;
      }

      if (!service) {
        await safeLog(
          "error",
          "[Ratel] Service is not available. Check that `ratel` is installed and on PATH.",
        );
        return;
      }

      await handleCommand({
        command: effectiveCommand,
        client: ctx.client,
        sessionId: input.sessionID,
        rawArgs: input.arguments ?? "",
        cwd: ctx.directory,
        service,
        cachedMissionId,
        cachedJobId,
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
          if (!service) return SERVICE_UNAVAILABLE_MSG;
          // Bridge OpenCode credentials before starting mission so agents can auth
          await ensureAuthBridge();
          try {
            const result = await service.startMission(args.goal ?? "");
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Mission queued: ${result.missionId} (job ${result.jobId})`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to start mission: ${err instanceof Error ? err.message : String(err)}`;
            console.error("[Ratel]", msg);
            return msg;
          }
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
          if (!service) return SERVICE_UNAVAILABLE_MSG;
          try {
            const result = await service.getMissionStatus(args.missionId ?? "");
            return JSON.stringify(result, null, 2);
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to get mission status: ${err instanceof Error ? err.message : String(err)}`;
            console.error("[Ratel]", msg);
            return msg;
          }
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
          if (!service) return SERVICE_UNAVAILABLE_MSG;
          // Bridge credentials before spawning worker agents
          await ensureAuthBridge();
          try {
            const result = await service.runWorker(args.missionId ?? "", args.featureId ?? "");
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Worker queued: ${result.jobId} for mission ${result.missionId}`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to run worker: ${err instanceof Error ? err.message : String(err)}`;
            console.error("[Ratel]", msg);
            return msg;
          }
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
          if (!service) return SERVICE_UNAVAILABLE_MSG;
          // Bridge credentials before spawning validator agents
          await ensureAuthBridge();
          try {
            const result = await service.runValidation(args.missionId ?? "", args.milestoneId ?? "");
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Validation queued: ${result.jobId} for mission ${result.missionId}`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to run validation: ${err instanceof Error ? err.message : String(err)}`;
            console.error("[Ratel]", msg);
            return msg;
          }
        },
      },
      ratel_ping_agents: {
        description: "Ping all Ratel factory subagent roles and report health.",
        args: {},
        async execute() {
          if (!service) return SERVICE_UNAVAILABLE_MSG;
          // Bridge OpenCode credentials before pinging so subagents can auth
          await ensureAuthBridge();
          const result = await service.pingAgents();
          const lines = [
            `Ratel Factory health: ${result.ok ? "OK" : "DEGRADED"}`,
            `Total agents: ${result.totalAgents}`,
            `OK: ${result.okCount}`,
            `Failed: ${result.failedCount}`,
            `Total time: ${result.totalTimeMs}ms`,
            "",
            ...result.agents.map(a => `  ${a.status === "ok" ? "✓" : "✗"} ${a.role}${a.timeMs ? ` (${a.timeMs}ms)` : ""}${a.error ? ` — ${a.error}` : ""}`)
          ];
          return lines.join("\n");
        }
      },
    },
  };

  return plugin;
};

export default RatelPlugin;
