/**
 * Ratel Pi Extension — In-Process Runtime
 *
 * Owns exactly one local Ratel orchestrator session at a time and wires the
 * Pi extension's tools/commands to `@ratel-factory/core` **in-process**.
 *
 * There is no separate daemon and no out-of-band process. The extension
 * imports core directly and drives the
 * orchestrator through its programmatic API. All durable mission state lives
 * under `.ratel/missions/<missionId>/` via core's mission/event helpers.
 *
 * Responsibilities:
 *   - Resolve project root (with a filesystem-root guard).
 *   - Create/restore mission id from `.ratel/current-mission.json`.
 *   - Create mission scope + initialize mission directories via core helpers.
 *   - Set up EventLogger / global logger for `events.jsonl`.
 *   - Lazily instantiate `OrchestratorAgent` in-process.
 *   - Serialize mutating orchestrator prompt calls with a simple mutex so
 *     parallel Pi tool calls cannot race.
 *   - Read compact status / poll local events from disk — no HTTP.
 */

import {
  OrchestratorAgent,
  EventLogger,
  setGlobalLogger,
  clearGlobalLogger,
  createMissionScope,
  getRatelDir,
  ensureMissionInitialized,
  loadMissionState,
  readState,
  readJsonFile,
  atomicWriteJson,
  startObservatory,
  getObservabilityConfig,
  type MissionScope,
  type ObservatoryHandle,
} from "@ratel-factory/core";
import { join } from "node:path";
import { readMissionEvents, type RatelEvent } from "./events.js";
import {
  clampTiming,
  detectStopCondition,
  formatPollResponse,
  parseStopWhen,
  type StopWhen,
} from "./polling.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Factory that creates an OrchestratorAgent. Injected for tests. */
export type OrchestratorFactory = () => OrchestratorAgent;

export interface RuntimeOptions {
  projectRoot: string;
  /** Override OrchestratorAgent construction for tests. */
  createOrchestrator?: OrchestratorFactory;
  /** Override observatory start for tests. Return null to disable. */
  startObservatoryFn?: (cwd: string) => Promise<ObservatoryHandle | null>;
}

export interface StartMissionResult {
  missionId: string;
  status: "started";
  /** Best-effort: empty until the orchestrator writes state. */
  note: string;
}

export type MissionStatus =
  | "active"
  | "waiting_for_approval"
  | "completed"
  | "halted";

export interface StatusSummary {
  active: boolean;
  missionId?: string;
  phase?: string;
  status?: MissionStatus;
  goal?: string;
  updatedAt?: string;
  message?: string;
}

export interface PollOptions {
  /** 0-based event index to start reading from. */
  after?: number;
  /** Comma-separated stop conditions. */
  stopWhen?: string;
  /** Max total seconds before giving up (default 60, clamped to [1, 300]). */
  timeoutSeconds?: number;
  /** Seconds between re-reads when waiting for new events (default 2, clamped to [1, 60]). */
  intervalSeconds?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface PingAgentsResult {
  ok: boolean;
  totalAgents: number;
  okCount: number;
  failedCount: number;
  agents: Array<{ role: string; status: "ok" | "unavailable"; detail?: string }>;
}

export interface ObservatoryInfo {
  enabled: boolean;
  url?: string;
  /** Local mission directory for manual inspection when no dashboard is running. */
  missionDir?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a mission phase (from state.json) to a compact status string. */
function phaseToStatus(phase: string | undefined): MissionStatus {
  switch (phase) {
    case "completed":
      return "completed";
    case "halted":
      return "halted";
    case "user_approval":
      return "waiting_for_approval";
    default:
      return "active";
  }
}

function generateMissionId(): string {
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `mis_${Date.now()}_${rand}`;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class RatelRuntime {
  private readonly projectRoot: string;
  private readonly createOrchestrator: OrchestratorFactory;
  private readonly startObservatoryFn: (cwd: string) => Promise<ObservatoryHandle | null>;

  private orchestrator: OrchestratorAgent | null = null;
  private missionId: string | null = null;
  private scope: MissionScope | null = null;
  private logger: EventLogger | null = null;
  private observatory: ObservatoryHandle | null = null;
  private observatoryStarted = false;

  /** Mutex chain so parallel prompt calls serialize. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: RuntimeOptions) {
    this.projectRoot = options.projectRoot;
    this.createOrchestrator = options.createOrchestrator ?? (() => new OrchestratorAgent());
    this.startObservatoryFn = options.startObservatoryFn ?? defaultStartObservatory;
  }

  // ── Project / mission bookkeeping ──────────────────────────────────────

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getMissionId(): string | null {
    return this.missionId;
  }

  /** Read `.ratel/current-mission.json` if present. */
  async restoreMissionId(): Promise<string | null> {
    try {
      const record = await readJsonFile<{ missionId: string }>(
        join(getRatelDir(this.projectRoot), "current-mission.json"),
      );
      if (record?.missionId) {
        this.missionId = record.missionId;
        return record.missionId;
      }
    } catch {
      // ignore — no current mission yet
    }
    return null;
  }

  private async persistCurrentMission(missionId: string): Promise<void> {
    const ratelDir = getRatelDir(this.projectRoot);
    await atomicWriteJson(join(ratelDir, "current-mission.json"), { missionId });
  }

  /**
   * Initialize mission scope + logger + state.json for the given mission id.
   * Does not create the orchestrator.
   */
  private async initMissionScope(missionId: string): Promise<MissionScope> {
    const scope = createMissionScope(this.projectRoot, missionId);
    const logger = await EventLogger.forMission(scope);
    await ensureMissionInitialized(scope, logger);
    setGlobalLogger(logger);
    this.scope = scope;
    this.logger = logger;
    return scope;
  }

  /**
   * Lazily create and init the in-process OrchestratorAgent for the current
   * mission. Cached on the runtime so subsequent prompt calls reuse it.
   */
  private async ensureOrchestrator(): Promise<OrchestratorAgent> {
    if (this.orchestrator) return this.orchestrator;
    if (!this.scope) {
      throw new Error("No active mission. Start a mission with ratel_start_mission.");
    }
    const agent = this.createOrchestrator();
    await agent.init({ cwd: this.projectRoot, missionId: this.scope.missionId });
    this.orchestrator = agent;
    return agent;
  }

  /** Serialize a mutating orchestrator call. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn(), () => fn());
    // Keep the chain alive even if fn rejects.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ── Public API used by tools/commands ──────────────────────────────────

  /** Start a new mission: create scope, init orchestrator, prompt with goal. */
  async startMission(goal: string, signal?: AbortSignal): Promise<StartMissionResult> {
    const trimmed = goal.trim();
    if (!trimmed) throw new Error("goal is required");

    // Reset any previous session.
    await this.disposeOrchestrator();

    const missionId = generateMissionId();
    await this.persistCurrentMission(missionId);
    this.missionId = missionId;
    await this.initMissionScope(missionId);

    await this.withLock(async () => {
      const agent = await this.ensureOrchestrator();
      await agent.prompt(
        `Start a new Ratel factory mission.\n\nGoal: ${trimmed}\n\nRun intake and discovery, then produce a validation contract and await user approval.`,
        signal,
      );
    });

    return { missionId, status: "started", note: "Orchestrator turn complete. Use ratel_poll_status to watch progress." };
  }

  /** Compact mission status read from local artifacts (no orchestrator needed). */
  async getStatus(): Promise<StatusSummary> {
    const missionId = this.missionId ?? (await this.restoreMissionId());
    if (!missionId) {
      return {
        active: false,
        message: "No active mission. Start a mission with ratel_start_mission.",
      };
    }
    this.missionId = missionId;
    const scope = createMissionScope(this.projectRoot, missionId);
    const state = await readState(scope);
    let goal: string | undefined;
    try {
      const full = await loadMissionState(scope);
      goal = full.requirements?.goal;
    } catch {
      // best-effort
    }
    const status = phaseToStatus(state?.phase);
    return {
      active: status === "active" || status === "waiting_for_approval",
      missionId,
      phase: state?.phase,
      status,
      goal,
      updatedAt: state?.updatedAt,
    };
  }

  /**
   * Poll local events from `events.jsonl` until a stop condition fires or
   * timeout. No HTTP calls. Re-reads the file on each interval; if no new
   * events arrive and no stop condition is met, waits and retries up to
   * timeoutSeconds.
   */
  async pollStatus(options: PollOptions = {}): Promise<string> {
    const missionId = this.missionId ?? (await this.restoreMissionId());
    if (!missionId) {
      return JSON.stringify(
        {
          active: false,
          stopReason: "no_mission",
          message: "No active mission. Start a mission with ratel_start_mission.",
        },
        null,
        2,
      );
    }
    this.missionId = missionId;
    const scope = createMissionScope(this.projectRoot, missionId);

    const { intervalSeconds, timeoutSeconds } = clampTiming(
      options.intervalSeconds ?? 2,
      options.timeoutSeconds ?? 60,
    );
    const stopWhen: StopWhen[] = parseStopWhen(options.stopWhen);
    const startedAt = Date.now();
    let offset = options.after ?? 0;
    let eventsSeen = 0;
    const matched: RatelEvent[] = [];
    let lastTotal = -1;
    let stableReads = 0;

    while (true) {
      if (options.signal?.aborted) {
        return formatPollResponse({
          missionId,
          stopReason: "aborted",
          approvalNeeded: false,
          latestStatus: "unknown",
          eventsSeen,
          lastOffset: offset,
          matchedEvents: matched,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          intervalSeconds,
          timeoutSeconds,
        });
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutSeconds * 1000) {
        return formatPollResponse({
          missionId,
          stopReason: "timeout",
          approvalNeeded: false,
          latestStatus: await this.deriveStatus(scope),
          eventsSeen,
          lastOffset: offset,
          matchedEvents: matched,
          elapsedSeconds: Math.round(elapsed / 1000),
          intervalSeconds,
          timeoutSeconds,
        });
      }

      const slice = await readMissionEvents(scope, offset);
      eventsSeen += slice.events.length;
      offset = slice.nextAfter;

      const status = await this.deriveStatus(scope);
      const detection = detectStopCondition(slice.events, status, stopWhen);

      for (const e of slice.events) {
        if (e.event_type === "phase_transition" || e.event_type === "halt") {
          matched.push(e);
        }
      }

      if (detection.stopped) {
        if (detection.matchedEvent) matched.push(detection.matchedEvent);
        let assistantMessage: string | undefined;
        const assistantEvent = matched.find((e) => e.event_type === "assistant_message");
        if (typeof assistantEvent?.data?.preview === "string") {
          assistantMessage = assistantEvent.data.preview;
        }
        return formatPollResponse({
          missionId,
          stopReason: detection.stopReason!,
          approvalNeeded: detection.approvalNeeded ?? false,
          latestStatus: status,
          eventsSeen,
          lastOffset: offset,
          matchedEvents: matched,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          intervalSeconds,
          timeoutSeconds,
          assistantMessage,
          pendingQuestion: detection.pendingQuestion,
        });
      }

      // If no new events arrived, wait briefly; otherwise loop again quickly.
      if (slice.total === lastTotal) {
        stableReads += 1;
        await sleep(intervalSeconds * 1000, options.signal);
      } else {
        stableReads = 0;
        // Short back-off when events are still flowing but no stop fired.
        if (slice.events.length === 0) {
          await sleep(Math.min(intervalSeconds * 1000, 1000), options.signal);
        }
      }
      lastTotal = slice.total;
    }
  }

  private async deriveStatus(scope: MissionScope): Promise<string> {
    try {
      const state = await readState(scope);
      return phaseToStatus(state?.phase);
    } catch {
      return "unknown";
    }
  }

  /** Send a free-form user reply to the orchestrator. */
  async replyToFactory(message: string, questionId?: string, signal?: AbortSignal): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("message is required");
    await this.withLock(async () => {
      const agent = await this.ensureOrchestrator();
      const q = questionId ? ` (answering question ${questionId})` : "";
      await agent.prompt(`User reply${q}: ${trimmed}`, signal);
    });
  }

  /** Submit a direct answer to a pending question. */
  async answerQuestion(questionId: string, answer: unknown, signal?: AbortSignal): Promise<void> {
    if (!questionId) throw new Error("questionId is required");
    const text = typeof answer === "string" ? answer : JSON.stringify(answer);
    await this.withLock(async () => {
      const agent = await this.ensureOrchestrator();
      await agent.prompt(
        `Answer to pending question ${questionId}: ${text}`,
        signal,
      );
    });
  }

  /** Approve or reject the plan. */
  async approvePlan(approved: boolean, feedback?: string, signal?: AbortSignal): Promise<void> {
    await this.withLock(async () => {
      const agent = await this.ensureOrchestrator();
      const verdict = approved ? "APPROVED" : "REJECTED";
      const fb = feedback ? `\nFeedback: ${feedback}` : "";
      await agent.prompt(
        `User decision: ${verdict}.${fb} Continue the mission accordingly.`,
        signal,
      );
    });
  }

  /** Prompt the orchestrator to run a worker for a feature. */
  async runFeatureWorker(featureId: string, signal?: AbortSignal): Promise<void> {
    if (!featureId) throw new Error("featureId is required");
    await this.withLock(async () => {
      const agent = await this.ensureOrchestrator();
      await agent.prompt(`Run the worker for feature ${featureId}.`, signal);
    });
  }

  /** Prompt the orchestrator to run validation for a milestone. */
  async runValidation(milestoneId: string, signal?: AbortSignal): Promise<void> {
    if (!milestoneId) throw new Error("milestoneId is required");
    await this.withLock(async () => {
      const agent = await this.ensureOrchestrator();
      await agent.prompt(`Run validation for milestone ${milestoneId}.`, signal);
    });
  }

  /**
   * Ping factory subagents. Core does not expose a standalone ping function
   * outside the orchestrator tool suite, so report local in-process
   * availability: the extension + core module are loaded, and the
   * orchestrator session is live if one has been started.
   */
  async pingAgents(): Promise<PingAgentsResult> {
    const roles = [
      "orchestrator",
      "research",
      "smart_friend",
      "contract_writer",
      "worker",
      "scrutiny_validator",
      "user_testing_validator",
    ];
    const orchestratorLive = this.orchestrator !== null;
    const agents = roles.map((role) => ({
      role,
      status: "ok" as const,
      detail: role === "orchestrator" && !orchestratorLive ? "not started" : undefined,
    }));
    return {
      ok: true,
      totalAgents: roles.length,
      okCount: roles.length,
      failedCount: 0,
      agents,
    };
  }

  /**
   * Start (lazily) and return local Observatory info. The Observatory is an
   * in-process read-only HTTP dashboard provided by core; it is NOT the
   * Ratel service API. If it cannot bind a port, return the local mission
   * directory so the user can inspect artifacts directly.
   */
  async getObservatoryInfo(): Promise<ObservatoryInfo> {
    const missionId = this.missionId ?? (await this.restoreMissionId());
    let missionDir: string | undefined;
    if (missionId) {
      this.missionId = missionId;
      missionDir = join(getRatelDir(this.projectRoot), "missions", missionId);
    }

    if (!this.observatoryStarted) {
      this.observatoryStarted = true;
      try {
        this.observatory = await this.startObservatoryFn(this.projectRoot);
      } catch {
        this.observatory = null;
      }
    }

    if (this.observatory?.enabled && this.observatory.url) {
      return {
        enabled: true,
        url: this.observatory.url,
        missionDir,
      };
    }

    return {
      enabled: false,
      missionDir,
      message:
        "Observatory dashboard is not running in this session. " +
        "Mission artifacts are persisted locally under .ratel/missions/<missionId>/ — open events.jsonl and state.json directly.",
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  private async disposeOrchestrator(): Promise<void> {
    if (this.orchestrator) {
      try {
        this.orchestrator.dispose();
      } catch {
        // best-effort
      }
      this.orchestrator = null;
    }
    if (this.logger) {
      try {
        await this.logger.shutdown();
      } catch {
        // best-effort
      }
      this.logger = null;
    }
    clearGlobalLogger();
  }

  async dispose(): Promise<void> {
    await this.disposeOrchestrator();
    if (this.observatory) {
      try {
        await this.observatory.shutdown();
      } catch {
        // best-effort
      }
      this.observatory = null;
    }
    this.scope = null;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

async function defaultStartObservatory(cwd: string): Promise<ObservatoryHandle | null> {
  try {
    const config = await getObservabilityConfig(cwd);
    return await startObservatory({ cwd, config });
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
