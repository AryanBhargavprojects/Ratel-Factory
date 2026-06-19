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
import { ensureRatelService, readServicePortfile, type ServiceLogger } from "./service-lifecycle.js";
import { handleCommand } from "./commands.js";
import { getFactoryModePrompt } from "./prompts.js";
import {
  bridgeOpenCodeAuthForProject,
  extractProviderId,
  type BridgeResult,
  type BridgeOptions,
} from "./auth-bridge.js";
import {
  createAuthSyncWatcher,
  type SyncLogger,
} from "./auth-sync-watcher.js";
import { resolveProjectRoot } from "./resolve-project-root.js";
import { safeLog } from "./logging.js";
import {
  clampTiming,
  detectStopCondition,
  formatPollResponse,
  type StopWhen,
} from "./polling.js";

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

  // Auto-discover or auto-start the Ratel service.
  // Pass a logger bound to safeLog so lifecycle diagnostics route
  // through ctx.client.app.log instead of raw stdout.
  const serviceLogger: ServiceLogger = (level, message) =>
    safeLog(ctx, level, message);
  const disableServiceAutostart =
    process.env.RATEL_OPENCODE_DISABLE_SERVICE_AUTOSTART === "1" ||
    process.env.npm_lifecycle_event === "test";
  const existingPortfile = disableServiceAutostart
    ? await readServicePortfile(projectRoot)
    : null;
  const service = disableServiceAutostart && !existingPortfile
    ? null
    : await ensureRatelService(projectRoot, serviceLogger);

  if (!service && !disableServiceAutostart) {
    await safeLog(
      ctx,
      "error",
      "Service could not be started. Check that `ratel` is installed and on PATH.",
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

  async function ensureAuthBridge(options?: BridgeOptions): Promise<BridgeResult | null> {
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

        // Before-tool / startup sync uses force=false so the hash/mtime
        // change detection can skip no-op writes. Watch events call this
        // with force=true via the watcher's own bridge invocation.
        const result = await bridgeOpenCodeAuthForProject(
          projectRoot,
          extraProviderIds,
          options,
        );

        if (result.skipped) {
          // Change-detection short-circuit — nothing to log per call.
          return result;
        }
        if (result.bridgedProviders.length > 0) {
          const names = result.bridgedProviders.join(", ");
          await safeLog(ctx, "info", `Auth bridge: synced ${names} from OpenCode credentials`);
        }
        if (result.removedProviders.length > 0) {
          const names = result.removedProviders.join(", ");
          await safeLog(ctx, "info", `Auth bridge: removed stale providers ${names}`);
        }
        if (result.missingProviders.length > 0) {
          const names = result.missingProviders.join(", ");
          await safeLog(ctx, "info", `Auth bridge: no OpenCode credentials found for ${names}`);
        }
        return result;
      } catch (err) {
        await safeLog(
          ctx,
          "warning",
          `Auth bridge: skipped (${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      } finally {
        authBridgeInflight = null;
      }
    })();

    return authBridgeInflight;
  }

  // ── Test-safe guard for proactive startup auth sync ─────────────
  // The config hook normally schedules a best-effort, non-blocking
  // `ensureAuthBridge` on the next tick and starts the proactive
  // fs.watch + fallback-poll auth sync watcher. Both of these touch real
  // user auth/lock paths (`~/.local/share/opencode/auth.json`,
  // `~/.pi/agent/auth.json`) and start long-lived FSWatcher handles that
  // keep the event loop alive. Under tests this (a) pollutes the real
  // user's auth storage and (b) prevents the test process from exiting
  // (the watcher's fs.watch handle is not unref'd by Node).
  //
  // Guard flags (explicit, read at call time so tests can toggle):
  //   - RATEL_OPENCODE_DISABLE_AUTH_WATCH=1  → skip startup sync + watcher
  //   - NODE_ENV=test                          → skip startup sync + watcher
  //   - npm_lifecycle_event=test               → skip during `npm test` even when NODE_ENV is unset
  //
  // Production behaviour is unchanged: when neither flag is set the config
  // hook still schedules the non-blocking bridge and starts the watcher.
  // The before-tool `ensureAuthBridge` path is NOT guarded — tools still
  // sync credentials when executed with a service available.
  function shouldDisableStartupAuthSync(): boolean {
    return (
      process.env.RATEL_OPENCODE_DISABLE_AUTH_WATCH === "1" ||
      process.env.NODE_ENV === "test" ||
      process.env.npm_lifecycle_event === "test"
    );
  }

  // ── Proactive real-time sync watcher ────────────────────────────
  // Watches OpenCode's auth.json (fs.watch + periodic stat fallback) and
  // re-runs the bridge with force=true / overwrite / removeStale when the
  // file changes. Idempotent: createAuthSyncWatcher guards against
  // duplicate watchers for the same auth path across repeated config hooks.
  let authSyncStarted = false;
  function startAuthSyncWatcher(): void {
    if (authSyncStarted) return;
    authSyncStarted = true;
    try {
      const syncLogger: SyncLogger = (level, message) => {
        // Route through safeLog so watcher diagnostics never leak to raw
        // stdout / the OpenCode composer.
        safeLog(ctx, level, message).catch(() => {
          // Best-effort; safeLog never throws normally.
        });
      };
      createAuthSyncWatcher({
        projectRoot,
        logger: syncLogger,
        // Defaults (debounceMs=800, fallbackPollMs=60000) are fine for
        // production. Tests override via the exported helpers directly.
      });
    } catch {
      // Best-effort: watcher is non-critical. The before-tool bridge calls
      // still keep auth in sync on the next tool invocation.
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

      // Startup sync: best-effort, non-blocking. Run on the next tick so
      // the config hook returns promptly and never blocks plugin startup.
      // Uses force=false so the hash/mtime change detection can no-op when
      // nothing has changed since the last bridge run.
      //
      // SKIPPED under NODE_ENV=test, npm_lifecycle_event=test, or RATEL_OPENCODE_DISABLE_AUTH_WATCH=1
      // so tests don't touch real user auth/lock paths or start long-lived
      // watchers that keep the event loop alive. See
      // `shouldDisableStartupAuthSync` above.
      if (!shouldDisableStartupAuthSync()) {
        setImmediate(() => {
          ensureAuthBridge({ force: false }).catch(() => {
            // Best-effort; ensureAuthBridge already logs internally.
          });
        });

        // Start the proactive fs.watch + fallback poll sync for OpenCode auth.
        // Idempotent: createAuthSyncWatcher reuses an existing watcher for the
        // resolved auth path, so repeated config hook invocations are safe.
        startAuthSyncWatcher();
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

      // Best-effort diagnostic log — only when RATEL_OPENCODE_DEBUG=1
      // so normal /ratel usage does not leak to the OpenCode input bar.
      if (DEBUG_ENABLED) {
        console.log(
          `[Ratel] command.execute.before raw=${JSON.stringify(rawCommand)} normalized=${normalizedCommand} inferred=${inferredCommand}`,
        );
      }

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
          ctx,
          "error",
          "Service is not available. Check that `ratel` is installed and on PATH.",
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
          await ensureAuthBridge({ force: false });
          try {
            const result = await service.startMission(args.goal ?? "");
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Mission queued: ${result.missionId} (job ${result.jobId})`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to start mission: ${err instanceof Error ? err.message : String(err)}`;
            await safeLog(ctx, "error", msg);
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
            await safeLog(ctx, "error", msg);
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
          await ensureAuthBridge({ force: false });
          try {
            const result = await service.runWorker(args.missionId ?? "", args.featureId ?? "");
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Worker queued: ${result.jobId} for mission ${result.missionId}`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to run worker: ${err instanceof Error ? err.message : String(err)}`;
            await safeLog(ctx, "error", msg);
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
          await ensureAuthBridge({ force: false });
          try {
            const result = await service.runValidation(args.missionId ?? "", args.milestoneId ?? "");
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Validation queued: ${result.jobId} for mission ${result.missionId}`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to run validation: ${err instanceof Error ? err.message : String(err)}`;
            await safeLog(ctx, "error", msg);
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
          await ensureAuthBridge({ force: false });
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
      ratel_poll_status: {
        description:
          "Poll mission events until a stop condition is met or timeout. " +
          "Use after ratel_start_mission to watch progress without expensive raw dumps. " +
          "Returns compact summary: stopReason, latestStatus, approvalNeeded, eventsSeen, nextAfter, " +
          "intervalSeconds, timeoutSeconds (effective clamped values). " +
          "intervalSeconds is clamped to [1, 60] (default 10). timeoutSeconds is clamped to [1, 300] (default 300). " +
          "Stop conditions: orchestrator_question (needs user approval), phase_change (any phase transition), " +
          "mission_complete (completed), halted (halted/cancelled). job_complete is unsupported (no real event).",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID to poll",
          },
          intervalSeconds: {
            type: "number",
            description: "Seconds between polls (default 10, clamped to [1, 60])",
          },
          timeoutSeconds: {
            type: "number",
            description: "Max total seconds before giving up (default 300, clamped to [1, 300])",
          },
          stopWhen: {
            type: "string",
            description:
              "Comma-separated stop conditions: orchestrator_question, phase_change, mission_complete, halted. " +
              "Default: orchestrator_question,mission_complete,halted",
          },
        },
        async execute(args: any) {
          if (!service) return SERVICE_UNAVAILABLE_MSG;

          const missionId: string = args.missionId ?? "";
          if (!missionId) return "Error: missionId is required";

          // Clamp timing args to prevent hot loops or overly-long tool calls
          const { intervalSeconds, timeoutSeconds } = clampTiming(
            args.intervalSeconds,
            args.timeoutSeconds,
          );
          const intervalMs = intervalSeconds * 1000;
          const timeoutMs = timeoutSeconds * 1000;

          // Parse stopWhen
          const rawStopWhen: string = args.stopWhen ?? "orchestrator_question,mission_complete,halted";
          const stopWhen: StopWhen[] = rawStopWhen
            .split(",")
            .map((s: string) => s.trim())
            .filter((s: string) =>
              ["orchestrator_question", "phase_change", "mission_complete", "halted", "job_complete"].includes(s),
            ) as StopWhen[];

          // In-memory offset tracking per missionId
          let offset = 0;
          let eventsSeen = 0;
          const allMatchedEvents: import("../src/service.js").RatelEvent[] = [];

          const startedAt = Date.now();

          while (true) {
            const elapsed = Date.now() - startedAt;
            if (elapsed >= timeoutMs) {
              return formatPollResponse({
                missionId,
                stopReason: "timeout",
                approvalNeeded: false,
                latestStatus: "unknown",
                eventsSeen,
                lastOffset: offset,
                matchedEvents: allMatchedEvents,
                elapsedSeconds: Math.round(elapsed / 1000),
                intervalSeconds,
                timeoutSeconds,
              });
            }

            try {
              // Fetch events
              const eventsResp = await service.getMissionEvents(missionId, offset);
              const newEvents = eventsResp.events;
              eventsSeen += newEvents.length;
              offset = eventsResp.nextAfter;

              // Fetch mission status
              let missionStatus = "unknown";
              try {
                const statusResp = await service.getMissionStatus(missionId);
                missionStatus = statusResp.status ?? "unknown";
              } catch {
                // Status fetch is best-effort; continue with events alone
              }

              // Detect stop condition
              const detection = detectStopCondition(newEvents, missionStatus, stopWhen);

              if (detection.stopped) {
                if (detection.matchedEvent) {
                  allMatchedEvents.push(detection.matchedEvent);
                }

                // Extract assistant message preview if the matched event is an assistant_message
                let assistantMessage: string | undefined;
                const assistantEvent = allMatchedEvents.find(
                  (e) => e.event_type === "assistant_message",
                );
                if (assistantEvent?.data?.preview) {
                  assistantMessage = String(assistantEvent.data.preview);
                }

                return formatPollResponse({
                  missionId,
                  stopReason: detection.stopReason!,
                  approvalNeeded: detection.approvalNeeded ?? false,
                  latestStatus: missionStatus,
                  eventsSeen,
                  lastOffset: offset,
                  matchedEvents: allMatchedEvents,
                  elapsedSeconds: Math.round(elapsed / 1000),
                  intervalSeconds,
                  timeoutSeconds,
                  assistantMessage,
                  pendingQuestion: detection.pendingQuestion,
                });
              }

              // Collect any interesting events for the summary (phase_transition, halt)
              for (const e of newEvents) {
                if (e.event_type === "phase_transition" || e.event_type === "halt") {
                  allMatchedEvents.push(e);
                }
              }
            } catch (err) {
              const msg = err instanceof RatelServiceError
                ? err.message
                : `Poll error: ${err instanceof Error ? err.message : String(err)}`;
              await safeLog(ctx, "warning", msg);
              // Continue polling on transient errors
            }

            // Sleep for interval
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
          }
        },
      },
      ratel_approve_mission: {
        description:
          "Approve or reject a mission that is waiting for user approval. " +
          "Call after ratel_poll_status returns stopReason=orchestrator_question and the user has reviewed the plan.",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID to approve",
          },
          approved: {
            type: "boolean",
            description: "Whether to approve (default true)",
          },
          feedback: {
            type: "string",
            description: "Optional feedback for the orchestrator",
          },
        },
        async execute(args: any) {
          if (!service) return SERVICE_UNAVAILABLE_MSG;

          const missionId: string = args.missionId ?? "";
          if (!missionId) return "Error: missionId is required";

          // Approving causes the orchestrator to take another turn — sync auth first.
          await ensureAuthBridge({ force: false });
          try {
            const result = await service.approveMission(missionId, {
              approved: args.approved ?? true,
              feedback: args.feedback,
            });
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Mission ${args.approved === false ? "rejected" : "approved"}: ${result.missionId} (job ${result.jobId})`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to approve mission: ${err instanceof Error ? err.message : String(err)}`;
            await safeLog(ctx, "error", msg);
            return msg;
          }
        },
      },
      ratel_send_message: {
        description:
          "Send a free-form user reply / clarification / answer to the current mission orchestrator. " +
          "Use after ratel_poll_status returns stopReason: orchestrator_question with a pendingQuestion or assistantMessage, " +
          "once you have asked the user in chat and collected their answer. " +
          "After sending, call ratel_poll_status again to watch the next turn. " +
          "This is the blessed replacement for the deprecated /api/mission/complete intake loop.",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID to send the message to",
          },
          message: {
            type: "string",
            description: "The user's free-form reply or clarification text",
          },
          questionId: {
            type: "string",
            description: "Optional pending question ID this message answers",
          },
        },
        async execute(args: any) {
          if (!service) return SERVICE_UNAVAILABLE_MSG;

          const missionId: string = args.missionId ?? "";
          if (!missionId) return "Error: missionId is required";
          const message: string = args.message ?? "";
          if (typeof message !== "string" || message.trim().length === 0) {
            return "Error: message is required";
          }
          const questionId: string | undefined =
            typeof args.questionId === "string" && args.questionId.length > 0
              ? args.questionId
              : undefined;

          // Sending a message wakes the orchestrator for another turn — sync auth first.
          await ensureAuthBridge({ force: false });
          try {
            const result = await service.sendMessage(missionId, message.trim(), questionId);
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Message queued to mission ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch the next orchestrator turn.`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to send message: ${err instanceof Error ? err.message : String(err)}`;
            await safeLog(ctx, "error", msg);
            return msg;
          }
        },
      },
      ratel_answer_question: {
        description:
          "Submit a direct answer to a specific pending question from the orchestrator. " +
          "Use when ratel_poll_status returned a pendingQuestion with a questionId. " +
          "After answering, call ratel_poll_status again to watch the next turn.",
        args: {
          missionId: {
            type: "string",
            description: "Mission ID",
          },
          questionId: {
            type: "string",
            description: "The pending question ID to answer",
          },
          answer: {
            type: "string",
            description: "The answer text (or JSON-encoded value for structured answers)",
          },
        },
        async execute(args: any) {
          if (!service) return SERVICE_UNAVAILABLE_MSG;

          const missionId: string = args.missionId ?? "";
          if (!missionId) return "Error: missionId is required";
          const questionId: string = args.questionId ?? "";
          if (!questionId) return "Error: questionId is required";
          if (args.answer === undefined || args.answer === null) {
            return "Error: answer is required";
          }

          // Tolerate JSON-encoded structured answers.
          let answerValue: unknown = args.answer;
          if (typeof args.answer === "string") {
            const trimmed = args.answer.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
              try {
                answerValue = JSON.parse(trimmed);
              } catch {
                answerValue = args.answer;
              }
            } else if (trimmed.length === 0) {
              return "Error: answer is required";
            } else {
              answerValue = trimmed;
            }
          }

          // Answering wakes the orchestrator for another turn — sync auth first.
          await ensureAuthBridge({ force: false });
          try {
            const result = await service.answerQuestion(missionId, questionId, answerValue);
            cachedMissionId = result.missionId;
            cachedJobId = result.jobId;
            return `Answer queued for question ${questionId} on mission ${result.missionId} (job ${result.jobId}). Call ratel_poll_status to watch the next orchestrator turn.`;
          } catch (err) {
            const msg = err instanceof RatelServiceError
              ? err.message
              : `Failed to answer question: ${err instanceof Error ? err.message : String(err)}`;
            await safeLog(ctx, "error", msg);
            return msg;
          }
        },
      },
    },
  };

  return plugin;
};

export default RatelPlugin;
