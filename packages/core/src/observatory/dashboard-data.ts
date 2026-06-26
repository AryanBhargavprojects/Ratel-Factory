/**
 * Ratel Observatory — Dashboard Data Layer (read-only)
 *
 * Deep read layer over mission artifacts and events. Every HTTP route in
 * server.ts delegates here so business logic lives in one place, not
 * scattered across route handlers.
 *
 * All methods resolve the mission scope internally from a missionId (or the
 * current-mission pointer when omitted), so callers never repeat that
 * boilerplate. Reads are fail-soft: missing artifacts yield `undefined` or
 * empty arrays, never throws.
 */

import { readFile, access, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, relative, dirname } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createMissionScope, getMissionDir, getRatelDir, type MissionScope } from "../core/mission/scope.js";
import { readJsonFile, atomicWriteFile, atomicWriteJson } from "../core/mission/atomic-file.js";
import { resolveCanonicalWorkspace } from "../core/mission/workspace-resolution.js";
import {
  loadMissionState,
  readState,
  readArtifact,
  readFeatures,
  readMilestones,
  readDecisionLog,
  readValidationContract,
  readHandoff,
  listFeatureFiles,
  readFeatureFile,
  listValidationReports,
  readValidationReport,
  listUserTestingReports,
  readUserTestingReport,
  readHaltReason,
  readBudgetSummary,
  readWorkerSkillsConfig,
  readRequirements,
} from "../core/artifacts.js";
import { ARTIFACT_NAMES } from "../core/types.js";
import type {
  MissionState,
  MissionPhase,
  Feature,
  Milestone,
  Decision,
  ValidationContract,
  WorkerHandoff,
  ScrutinyReport,
  UserTestingReport,
} from "../core/types.js";
import type { MissionJob } from "../control-plane/types.js";
import type { RatelEvent, EventType, AgentLevel } from "../core/observability/event-logger.js";
import type { JobStore } from "../control-plane/job-store.js";
import type { MissionStore } from "../control-plane/mission-store.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DashboardMode = "service" | "in-process" | "none";

export interface AgentRosterEntry {
  role: AgentLevel;
  state: "idle" | "running" | "failed" | "unknown";
  since?: string;
  featureId?: string;
  milestoneId?: string;
  shardId?: string;
  model?: string;
  lastParseStatus?: "ok" | "failed";
}

export interface BudgetSnapshot {
  used: { costUsd: number; totalTokens: number; agentRuns: number };
  remaining: { costUsd: number | null; totalTokens: number | null; agentRuns: number | null };
  limits: { maxCostUsd: number | null; maxTotalTokens: number | null; maxAgentRuns: number | null };
  exhausted?: { reason: string; at: string };
}

export interface MissionStatusSnapshot {
  missionId: string;
  goal?: string;
  phase: MissionPhase;
  status: "active" | "waiting_for_approval" | "completed" | "halted";
  version: number;
  updatedAt: string;
  complexity?: string;
  agents: AgentRosterEntry[];
  budget?: BudgetSnapshot;
  approval?: { status: string; decidedAt?: string; feedback?: string };
  pendingQuestion?: { questionId: string; question: string; options?: string[]; status: string };
  haltReason?: string;
  recommendedActions: string[];
  actionsAvailable: boolean;
  mode: DashboardMode;
}

export interface EventQuery {
  after?: number;
  limit?: number;
  types?: EventType[];
  agentLevels?: AgentLevel[];
  toolName?: string;
  q?: string;
}

export interface EventSlice {
  events: RatelEvent[];
  nextAfter: number;
  total: number;
}

// ── Agent tree (#2: tree structure, glowing active nodes) ────────────────

export interface AgentTreeNode {
  id: string;
  role: AgentLevel | "feature" | "milestone";
  label: string;
  state: "idle" | "running" | "failed" | "waiting" | "unknown";
  model?: string;
  featureId?: string;
  milestoneId?: string;
  since?: string;
  lastParseStatus?: "ok" | "failed";
  children: AgentTreeNode[];
}

// ── Semantic activity feed (#3: plain-language log) ──────────────────────

export interface ActivityEntry {
  timestamp: string;
  category: "agent" | "file" | "validation" | "phase" | "decision" | "budget" | "halt" | "approval" | "question";
  text: string;
  agentLevel?: AgentLevel;
  featureId?: string;
  milestoneId?: string;
}

export interface ActivityFeed {
  entries: ActivityEntry[];
  total: number;
}

export interface UsageRow {
  role: string;
  provider: string;
  model: string;
  totalTokens: number;
  costUsd: number;
  agentRuns: number;
}

export interface UsageAggregate {
  rows: UsageRow[];
  totals: { totalTokens: number; costUsd: number; agentRuns: number };
}

export interface HandoffSummary {
  featureId: string;
  parseStatus: "ok" | "failed";
  summary: string;
  completedCount: number;
  leftUndoneCount: number;
  highIssueCount: number;
  gitCommit?: string;
  proceduresAbided: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: FileTreeNode[];
}

export interface ArtifactBundle {
  state?: { phase: MissionPhase; version: number; updatedAt: string };
  requirements?: Awaited<ReturnType<typeof readRequirements>>;
  constraints?: string;
  researchNotes?: string;
  contractJson?: ValidationContract;
  contractMd?: string;
  features?: Feature[];
  milestones?: Milestone[];
  decisions?: Decision[];
  workerSkills?: { additionalSkills: string[] };
  agentsMd?: string;
  haltReason?: string;
  featureFiles?: Array<{ name: string; content: string }>;
}

// ---------------------------------------------------------------------------
// DashboardData
// ---------------------------------------------------------------------------

export interface DashboardDataOptions {
  cwd: string;
  mode?: DashboardMode;
  jobStore?: JobStore;
  missionStore?: MissionStore;
}

export class DashboardData {
  private readonly cwd: string;
  private readonly _mode: DashboardMode;
  private readonly jobStore?: JobStore;
  private readonly missionStore?: MissionStore;

  constructor(options: DashboardDataOptions) {
    this.cwd = options.cwd;
    this._mode = options.mode ?? "none";
    this.jobStore = options.jobStore;
    this.missionStore = options.missionStore;
  }

  get mode(): DashboardMode {
    return this._mode;
  }

  get actionsAvailable(): boolean {
    return this.mode === "service" || this.mode === "in-process";
  }

  // ── Mission resolution ────────────────────────────────────────────────

  /** Resolve mission id from arg or current-mission pointer. Returns undefined if none found (for endpoints that can work without a mission). */
  async resolveMissionId(missionId?: string): Promise<string> {
    if (missionId) return missionId;
    const record = await readJsonFile<{ missionId: string }>(
      join(getRatelDir(this.cwd), "current-mission.json"),
    );
    if (record?.missionId) {
      return record.missionId;
    }
    throw new Error("No mission id provided and no current-mission.json found");
  }

  /** Best-effort mission resolution — returns undefined instead of throwing. */
  async tryResolveMissionId(missionId?: string): Promise<string | undefined> {
    try {
      return await this.resolveMissionId(missionId);
    } catch {
      return undefined;
    }
  }

  private async scope(missionId?: string): Promise<{ scope: MissionScope; missionId: string }> {
    const id = await this.resolveMissionId(missionId);
    return { scope: createMissionScope(this.cwd, id), missionId: id };
  }

  // ── Status snapshot ───────────────────────────────────────────────────

  async getMissionStatus(missionId?: string): Promise<MissionStatusSnapshot> {
    const { scope, missionId: id } = await this.scope(missionId);
    const state = await loadMissionState(scope);
    const agents = await this.deriveAgentRoster(scope);
    const budget = await readBudgetSummary(scope);
    const haltReason = state.haltReason ?? (await readHaltReason(scope));
    const pendingQuestion = await this.readPendingQuestion(scope);
    const complexity = await this.deriveComplexity(scope);

    const status: MissionStatusSnapshot["status"] =
      state.phase === "halted" ? "halted"
      : state.phase === "completed" ? "completed"
      : state.phase === "user_approval" ? "waiting_for_approval"
      : "active";

    return {
      missionId: id,
      goal: state.requirements?.goal,
      phase: state.phase,
      status,
      version: state.version,
      updatedAt: state.updatedAt,
      complexity,
      agents,
      budget: budget ? this.toBudgetSnapshot(budget) : undefined,
      approval: state.approval,
      pendingQuestion,
      haltReason,
      recommendedActions: state.recommendedActions ?? [],
      actionsAvailable: this.actionsAvailable,
      mode: this.mode,
    };
  }

  // ── Events ─────────────────────────────────────────────────────────────

  async getEvents(missionId: string, query: EventQuery = {}): Promise<EventSlice> {
    const { scope } = await this.scope(missionId);
    const eventsPath = join(getMissionDir(scope), "events.jsonl");
    const after = Math.max(0, query.after ?? 0);
    const limit = Math.min(Math.max(1, query.limit ?? 500), 5000);

    let raw = "";
    try {
      raw = await readFile(eventsPath, "utf-8");
    } catch {
      return { events: [], nextAfter: after, total: 0 };
    }

    const all = parseEventsJsonl(raw) as RatelEvent[];
    const total = all.length;
    const filtered = filterEvents(all, query);
    const window = filtered.slice(after, after + limit);

    return {
      events: window,
      nextAfter: after + window.length,
      total,
    };
  }

  async getAssistantMessages(missionId: string, after = 0, limit = 200): Promise<RatelEvent[]> {
    const { scope } = await this.scope(missionId);
    const eventsPath = join(getMissionDir(scope), "events.jsonl");
    let raw = "";
    try {
      raw = await readFile(eventsPath, "utf-8");
    } catch {
      return [];
    }
    const all = parseEventsJsonl(raw) as RatelEvent[];
    const msgs = all.filter((e) => e.event_type === "assistant_message");
    return msgs.slice(after, after + Math.min(Math.max(1, limit), 1000));
  }

  // ── Usage ─────────────────────────────────────────────────────────────

  async getUsage(missionId: string, groupBy: "role" | "model" | "provider" = "role"): Promise<UsageAggregate> {
    const { scope } = await this.scope(missionId);
    const usagePath = join(getMissionDir(scope), "usage.jsonl");
    let raw = "";
    try {
      raw = await readFile(usagePath, "utf-8");
    } catch {
      return { rows: [], totals: { totalTokens: 0, costUsd: 0, agentRuns: 0 } };
    }

    const rows = new Map<string, UsageRow>();
    let totalTokens = 0;
    let costUsd = 0;
    let agentRuns = 0;

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const role = String(rec.role ?? "unknown");
      const provider = String(rec.provider ?? "");
      const model = String(rec.model ?? "");
      const key = groupBy === "role" ? role : groupBy === "model" ? model : provider;
      const existing = rows.get(key) ?? { role, provider, model, totalTokens: 0, costUsd: 0, agentRuns: 0 };
      existing.totalTokens += Number(rec.totalTokens ?? 0);
      existing.costUsd += Number(rec.costUsd ?? 0);
      existing.agentRuns += 1;
      rows.set(key, existing);
      totalTokens += Number(rec.totalTokens ?? 0);
      costUsd += Number(rec.costUsd ?? 0);
      agentRuns += 1;
    }

    return {
      rows: Array.from(rows.values()).sort((a, b) => b.totalTokens - a.totalTokens),
      totals: { totalTokens, costUsd, agentRuns },
    };
  }

  // ── Jobs ──────────────────────────────────────────────────────────────

  async getJobs(missionId: string): Promise<MissionJob[]> {
    if (!this.jobStore) return [];
    try {
      return await this.jobStore.listJobs(missionId);
    } catch {
      return [];
    }
  }

  // ── Handoffs ──────────────────────────────────────────────────────────

  async getHandoffs(missionId: string): Promise<HandoffSummary[]> {
    const { scope } = await this.scope(missionId);
    const dir = join(getMissionDir(scope), "handoffs");
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries: HandoffSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const featureId = entry.name.replace(/\.json$/, "");
      const handoff = await readHandoff(scope, featureId);
      if (!handoff) continue;
      summaries.push({
        featureId,
        parseStatus: "ok",
        summary: handoff.summary,
        completedCount: handoff.completed.length,
        leftUndoneCount: handoff.leftUndone.length,
        highIssueCount: handoff.issuesDiscovered.filter((i) => i.severity === "high").length,
        gitCommit: handoff.gitCommit,
        proceduresAbided: handoff.proceduresAbided,
      });
    }
    return summaries.sort((a, b) => a.featureId.localeCompare(b.featureId));
  }

  async getHandoffDetail(missionId: string, featureId: string): Promise<WorkerHandoff | undefined> {
    const { scope } = await this.scope(missionId);
    return readHandoff(scope, featureId);
  }

  async getWorkerRawOutput(missionId: string, featureId: string): Promise<{ filename: string; content: string } | undefined> {
    const { scope } = await this.scope(missionId);
    const dir = join(getMissionDir(scope), "worker-runs");
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const match = entries
      .filter((e) => e.isFile() && e.name.startsWith(`${featureId}-`) && e.name.endsWith(".raw.txt"))
      .sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!match) return undefined;
    try {
      const content = await readFile(join(dir, match.name), "utf-8");
      return { filename: match.name, content };
    } catch {
      return undefined;
    }
  }

  // ── Validation + user-testing reports ─────────────────────────────────

  async getValidationReports(missionId: string, milestoneId?: string): Promise<Array<{ filename: string; report: ScrutinyReport }>> {
    const { scope } = await this.scope(missionId);
    const files = await listValidationReports(scope, milestoneId);
    const out: Array<{ filename: string; report: ScrutinyReport }> = [];
    for (const filename of files) {
      const report = await readValidationReport(scope, filename);
      if (report && report.validatorType === "scrutiny") {
        out.push({ filename, report });
      }
    }
    return out;
  }

  async getUserTestingReports(missionId: string, milestoneId?: string): Promise<Array<{ filename: string; report: UserTestingReport }>> {
    const { scope } = await this.scope(missionId);
    const files = await listUserTestingReports(scope, milestoneId);
    const out: Array<{ filename: string; report: UserTestingReport }> = [];
    for (const filename of files) {
      const report = await readUserTestingReport(scope, filename);
      if (report && report.validatorType === "user-testing") {
        out.push({ filename, report });
      }
    }
    return out;
  }

  // ── Artifacts bundle (Plan tab) ────────────────────────────────────────

  async getArtifacts(missionId: string): Promise<ArtifactBundle> {
    const { scope } = await this.scope(missionId);
    const state = await readState(scope);
    const requirements = await readRequirements(scope);
    const constraints = await readArtifact(scope, "constraints.md");
    const researchNotes = await readArtifact(scope, "research-notes.md");
    const contractJson = await readValidationContract(scope);
    const contractMd = await readArtifact(scope, "validation-contract.md");
    const features = await readFeatures(scope);
    const milestones = await readMilestones(scope);
    const decisions = await readDecisionLog(scope);
    const workerSkills = await readWorkerSkillsConfig(scope);
    const agentsMd = await readArtifact(scope, "agents.md");
    const haltReason = await readHaltReason(scope);

    const featureFileNames = await listFeatureFiles(scope);
    const featureFiles: Array<{ name: string; content: string }> = [];
    for (const name of featureFileNames) {
      const content = await readFeatureFile(scope, name);
      if (content !== undefined) featureFiles.push({ name, content });
    }

    return {
      state: state,
      requirements,
      constraints: constraints ?? undefined,
      researchNotes: researchNotes ?? undefined,
      contractJson,
      contractMd: contractMd ?? undefined,
      features,
      milestones,
      decisions: decisions ?? [],
      workerSkills,
      agentsMd: agentsMd ?? undefined,
      haltReason,
      featureFiles,
    };
  }

  // ── File tree + single file ───────────────────────────────────────────

  async getFileTree(missionId: string): Promise<FileTreeNode | null> {
    const { scope } = await this.scope(missionId);
    const dir = getMissionDir(scope);
    return buildFileTree(dir, dir);
  }

  async getFile(missionId: string, relPath: string): Promise<{ path: string; content: string } | undefined> {
    if (!relPath || relPath.includes("..")) return undefined;
    const { scope } = await this.scope(missionId);
    const fullPath = join(getMissionDir(scope), relPath);
    try {
      const content = await readFile(fullPath, "utf-8");
      return { path: relPath, content };
    } catch {
      return undefined;
    }
  }

  // ── Diff ──────────────────────────────────────────────────────────────

  async getDiff(missionId?: string): Promise<{ diff: string; status: string }> {
    // Use a real scope when a mission exists; otherwise a synthetic scope
    // rooted at cwd so resolveCanonicalWorkspace can still auto-discover a
    // git repo in the project directory.
    let scope: MissionScope;
    let resolvedId = missionId;
    if (!resolvedId) {
      resolvedId = await this.tryResolveMissionId();
    }
    if (resolvedId) {
      scope = createMissionScope(this.cwd, resolvedId);
    } else {
      // Synthetic scope: projectRoot = cwd, missionId = a placeholder that
      // satisfies the id regex. resolveCanonicalWorkspace reads requirements.json
      // from the mission dir (which won't exist) then falls back to auto-discovery.
      scope = createMissionScope(this.cwd, "mis_00000000");
    }
    const workspace = await resolveCanonicalWorkspace(scope);
    if (!workspace) {
      return { diff: "", status: "Not a git repository" };
    }
    let diff = "";
    let status = "";
    try {
      const r = await execFile("git", ["diff"], { cwd: workspace });
      diff = r.stdout;
    } catch {
      diff = "";
    }
    try {
      const r = await execFile("git", ["status", "--short"], { cwd: workspace });
      status = r.stdout;
    } catch {
      status = "Error reading git status";
    }
    return { diff, status };
  }

  // ── Decisions (append-only read) ──────────────────────────────────────

  async getDecisions(missionId: string): Promise<Decision[]> {
    const { scope } = await this.scope(missionId);
    return (await readDecisionLog(scope)) ?? [];
  }

  // ── Agent tree (#2) ────────────────────────────────────────────────────

  /**
   * Build a tree: orchestrator root → milestone branches → feature leaves →
   * worker/validator children. Active nodes have state="running" so the UI
   * can glow them. Derived from events.jsonl + features.json + milestones.json.
   */
  async getAgentTree(missionId: string): Promise<AgentTreeNode> {
    const { scope } = await this.scope(missionId);
    const state = await loadMissionState(scope);
    const events = await this.readAllEvents(scope);

    // Build per-agent latest state from events
    const agentState = new Map<string, { state: "running" | "idle" | "failed" | "waiting" | "unknown"; since?: string; featureId?: string; milestoneId?: string; model?: string; parseStatus?: string }>();
    for (const e of events) {
      const level = e.agent_level;
      if (!level) continue;
      const d = e.data as Record<string, unknown>;
      if (e.event_type === "agent_start") {
        agentState.set(level + ":" + (d.featureId ?? d.milestoneId ?? d.shardId ?? ""), {
          state: "running",
          since: e.timestamp,
          featureId: typeof d.featureId === "string" ? d.featureId : undefined,
          milestoneId: typeof d.milestoneId === "string" ? d.milestoneId : undefined,
          model: typeof d.model === "string" ? d.model : undefined,
        });
      } else if (e.event_type === "agent_end") {
        const key = level + ":" + (d.featureId ?? d.milestoneId ?? d.shardId ?? "");
        const existing = agentState.get(key);
        if (existing) {
          existing.state = typeof d.parseStatus === "string" && d.parseStatus === "failed" ? "failed" : "idle";
        }
      }
    }

    // Root: orchestrator
    const orchState = agentState.get("orchestrator:") ?? { state: "idle" };
    const root: AgentTreeNode = {
      id: "orchestrator",
      role: "orchestrator",
      label: "Orchestrator",
      state: orchState.state as AgentTreeNode["state"],
      model: orchState.model,
      since: orchState.since,
      children: [],
    };

    // Add research / smart_friend / contract_writer as direct children of orchestrator
    for (const helperRole of ["research", "smart_friend", "contract_writer"] as AgentLevel[]) {
      const helperKey = helperRole + ":";
      const hs = agentState.get(helperKey);
      if (hs) {
        root.children.push({
          id: helperRole,
          role: helperRole,
          label: roleLabel(helperRole),
          state: hs.state as AgentTreeNode["state"],
          model: hs.model,
          since: hs.since,
          children: [],
        });
      }
    }

    // Milestone branches → feature leaves → worker/validator children
    const milestones = state.milestones ?? [];
    const features = state.features ?? [];

    for (const milestone of milestones) {
      const milestoneNode: AgentTreeNode = {
        id: `milestone:${milestone.id}`,
        role: "milestone",
        label: milestone.title,
        state: milestone.status === "completed" ? "idle" : milestone.status === "blocked" ? "failed" : "waiting",
        milestoneId: milestone.id,
        children: [],
      };

      const milestoneFeatures = features.filter((f) => f.milestoneId === milestone.id);
      for (const feature of milestoneFeatures) {
        const workerKey = `worker:${feature.id}`;
        const ws = agentState.get(workerKey);
        const featureNode: AgentTreeNode = {
          id: `feature:${feature.id}`,
          role: "feature",
          label: feature.title,
          state: ws?.state ?? (feature.status === "integrated" || feature.status === "validated" ? "idle" : feature.status === "blocked" ? "failed" : "waiting"),
          featureId: feature.id,
          since: ws?.since,
          children: [],
        };

        // Worker child
        if (ws) {
          featureNode.children.push({
            id: `worker:${feature.id}`,
            role: "worker",
            label: "Worker",
            state: ws.state as AgentTreeNode["state"],
            model: ws.model,
            featureId: feature.id,
            since: ws.since,
            children: [],
          });
        }

        // Scrutiny validator child (if validation ran for this milestone)
        const valKey = `scrutiny_validator:${milestone.id}`;
        const vs = agentState.get(valKey);
        if (vs) {
          featureNode.children.push({
            id: `validator:${milestone.id}`,
            role: "scrutiny_validator",
            label: "Scrutiny",
            state: vs.state as AgentTreeNode["state"],
            milestoneId: milestone.id,
            since: vs.since,
            children: [],
          });
        }

        milestoneNode.children.push(featureNode);
      }

      root.children.push(milestoneNode);
    }

    return root;
  }

  // ── Semantic activity feed (#3) ────────────────────────────────────────

  /**
   * Convert raw events into plain-language activity entries:
   * "Worker F2 created features/authentication.feature"
   * "Orchestrator transitioned: discovery → validation_contract"
   */
  async getActivityFeed(missionId: string, limit = 100, after = 0): Promise<ActivityFeed> {
    const { scope } = await this.scope(missionId);
    const events = await this.readAllEvents(scope);
    const entries: ActivityEntry[] = [];

    for (const e of events) {
      const entry = eventToActivity(e);
      if (entry) entries.push(entry);
    }

    const total = entries.length;
    const slice = entries.slice(after, after + limit);
    return { entries: slice, total };
  }

  // ── Internal: read all events ──────────────────────────────────────────

  private async readAllEvents(scope: MissionScope): Promise<RatelEvent[]> {
    const eventsPath = join(getMissionDir(scope), "events.jsonl");
    try {
      const raw = await readFile(eventsPath, "utf-8");
      return parseEventsJsonl(raw) as RatelEvent[];
    } catch {
      return [];
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private toBudgetSnapshot(b: NonNullable<Awaited<ReturnType<typeof readBudgetSummary>>>): BudgetSnapshot {
    return {
      used: b.used,
      remaining: b.remaining,
      limits: b.limits,
      exhausted: b.exhausted,
    };
  }

  /** Derive live agent states from the events.jsonl stream. */
  private async deriveAgentRoster(scope: MissionScope): Promise<AgentRosterEntry[]> {
    const eventsPath = join(getMissionDir(scope), "events.jsonl");
    let raw = "";
    try {
      raw = await readFile(eventsPath, "utf-8");
    } catch {
      return ALL_ROLES.map((role) => ({ role, state: "unknown" as const }));
    }
    const events = parseEventsJsonl(raw) as RatelEvent[];
    const byRole = new Map<AgentLevel, AgentRosterEntry>();

    for (const e of events) {
      const level = e.agent_level;
      if (!level) continue;
      if (e.event_type === "agent_start") {
        const d = e.data as Record<string, unknown>;
        byRole.set(level, {
          role: level,
          state: "running",
          since: e.timestamp,
          featureId: typeof d.featureId === "string" ? d.featureId : undefined,
          milestoneId: typeof d.milestoneId === "string" ? d.milestoneId : undefined,
          shardId: typeof d.shardId === "string" ? d.shardId : undefined,
          model: typeof d.model === "string" ? d.model : undefined,
        });
      } else if (e.event_type === "agent_end") {
        const d = e.data as Record<string, unknown>;
        const existing = byRole.get(level);
        byRole.set(level, {
          role: level,
          state: typeof d.parseStatus === "string" && d.parseStatus === "failed" ? "failed" : "idle",
          since: e.timestamp,
          featureId: existing?.featureId,
          milestoneId: existing?.milestoneId,
          shardId: existing?.shardId,
          model: existing?.model,
          lastParseStatus: typeof d.parseStatus === "string" ? d.parseStatus as "ok" | "failed" : undefined,
        });
      }
    }

    // Ensure every known role appears.
    for (const role of ALL_ROLES) {
      if (!byRole.has(role)) byRole.set(role, { role, state: "unknown" });
    }
    return ALL_ROLES.map((r) => byRole.get(r)!).filter(Boolean);
  }

  private async readPendingQuestion(scope: MissionScope): Promise<MissionStatusSnapshot["pendingQuestion"] | undefined> {
    try {
      const raw = await readFile(join(getMissionDir(scope), "pending-question.json"), "utf-8");
      const parsed = JSON.parse(raw) as {
        questionId?: string;
        question?: string;
        options?: string[];
        status?: string;
      };
      if (!parsed.questionId) return undefined;
      return {
        questionId: parsed.questionId,
        question: parsed.question ?? "",
        options: parsed.options,
        status: parsed.status ?? "pending",
      };
    } catch {
      return undefined;
    }
  }

  private async deriveComplexity(scope: MissionScope): Promise<string | undefined> {
    try {
      const raw = await readFile(join(getMissionDir(scope), "events.jsonl"), "utf-8");
      const events = parseEventsJsonl(raw) as RatelEvent[];
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.event_type !== "decision_logged") continue;
        const d = e.data as Record<string, unknown>;
        const ctx = typeof d.context === "string" ? d.context.toLowerCase() : "";
        const dec = typeof d.decision === "string" ? d.decision.toLowerCase() : "";
        if (ctx.includes("complexity") || dec.includes("simple") || dec.includes("medium") || dec.includes("complex")) {
          for (const word of ["simple", "medium", "complex"]) {
            if (dec.includes(word)) return word;
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const ALL_ROLES: AgentLevel[] = [
  "orchestrator",
  "research",
  "smart_friend",
  "contract_writer",
  "worker",
  "scrutiny_validator",
  "user_testing_validator",
  "code_review",
];

/** Parse a JSONL string into an array of objects, skipping malformed lines. */
export function parseEventsJsonl(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // partially written line mid-flush — skip
    }
  }
  return events;
}

/** Apply query filters to an event array. */
function filterEvents(events: RatelEvent[], query: EventQuery): RatelEvent[] {
  if (!query.types?.length && !query.agentLevels?.length && !query.toolName && !query.q) {
    return events;
  }
  const types = query.types ? new Set(query.types) : undefined;
  const levels = query.agentLevels ? new Set(query.agentLevels) : undefined;
  const q = query.q?.toLowerCase().trim();
  return events.filter((e) => {
    if (types && !types.has(e.event_type)) return false;
    if (levels && (!e.agent_level || !levels.has(e.agent_level))) return false;
    if (query.toolName) {
      const tn = (e.data as Record<string, unknown>)?.toolName;
      if (typeof tn !== "string" || !tn.includes(query.toolName)) return false;
    }
    if (q) {
      const haystack = JSON.stringify(e.data).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Build a recursive file tree rooted at `rootDir`, relative paths. */
async function buildFileTree(rootDir: string, currentDir: string): Promise<FileTreeNode | null> {
  const name = relative(rootDir, currentDir) || ".";
  try {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const children: FileTreeNode[] = [];
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        const child = await buildFileTree(rootDir, fullPath);
        if (child) children.push(child);
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath);
          children.push({ name: entry.name, path: relPath, type: "file", size: s.size });
        } catch {
          children.push({ name: entry.name, path: relPath, type: "file", size: 0 });
        }
      }
    }
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { name, path: relative(rootDir, currentDir) || ".", type: "dir", children };
  } catch {
    return null;
  }
}

// Re-export for the write layer + tests.
export { atomicWriteFile, atomicWriteJson, readJsonFile, ARTIFACT_NAMES };

// ── Activity feed helpers (#3) ───────────────────────────────────────────

/** Human-readable label for an agent role (falls back to the raw string). */
function roleLabel(role: AgentLevel | string): string {
  const labels: Partial<Record<string, string>> = {
    orchestrator: "Orchestrator",
    worker: "Worker",
    scrutiny_validator: "Scrutiny Validator",
    user_testing_validator: "User-Testing Validator",
    user_testing_shard: "Test Shard",
    research: "Research",
    smart_friend: "Smart Friend",
    contract_writer: "Contract Writer",
    code_review: "Code Review",
  };
  return labels[role] ?? role;
}

/** Convert a raw event into a plain-language activity entry. Returns undefined if not actionable. */
function eventToActivity(e: RatelEvent): ActivityEntry | undefined {
  const d = e.data as Record<string, unknown>;
  const base = { timestamp: e.timestamp, agentLevel: e.agent_level };

  switch (e.event_type) {
    case "agent_start": {
      const feature = typeof d.featureId === "string" ? d.featureId : "";
      const milestone = typeof d.milestoneId === "string" ? d.milestoneId : "";
      const role = e.agent_level ?? "agent";
      const target = feature || milestone || "";
      return {
        ...base,
        category: "agent",
        text: target ? `${roleLabel(role)} started for ${target}` : `${roleLabel(role)} started`,
        featureId: feature || undefined,
        milestoneId: milestone || undefined,
      };
    }
    case "agent_end": {
      const status = typeof d.parseStatus === "string" ? d.parseStatus : "";
      const role = e.agent_level ?? "agent";
      const feature = typeof d.featureId === "string" ? d.featureId : "";
      return {
        ...base,
        category: "agent",
        text: `${roleLabel(role)} finished${status ? ` (${status})` : ""}${feature ? ` — ${feature}` : ""}`,
        featureId: feature || undefined,
      };
    }
    case "artifact_write": {
      const name = typeof d.artifactName === "string" ? d.artifactName : "";
      const bytes = typeof d.byteCount === "number" ? d.byteCount : 0;
      return {
        ...base,
        category: "file",
        text: `${d.mode === "append" ? "Appended to" : "Wrote"} ${name}${bytes ? ` (${bytes}B)` : ""}`,
      };
    }
    case "phase_transition": {
      const from = typeof d.from === "string" ? d.from : "";
      const to = typeof d.to === "string" ? d.to : "";
      return {
        ...base,
        category: "phase",
        text: `Phase: ${from} → ${to}`,
      };
    }
    case "decision_logged": {
      const decision = typeof d.decision === "string" ? d.decision : "";
      return {
        ...base,
        category: "decision",
        text: `Decision: ${decision.slice(0, 120)}`,
      };
    }
    case "halt": {
      const reason = typeof d.reason === "string" ? d.reason : "";
      return {
        ...base,
        category: "halt",
        text: `Mission halted: ${reason}`,
      };
    }
    case "budget_exceeded": {
      const reason = typeof d.reason === "string" ? d.reason : "";
      return {
        ...base,
        category: "budget",
        text: `Budget exceeded: ${reason}`,
      };
    }
    case "validation_recovery": {
      const milestone = typeof d.milestoneId === "string" ? d.milestoneId : "";
      const count = Array.isArray(d.blockingIssueIds) ? d.blockingIssueIds.length : 0;
      return {
        ...base,
        category: "validation",
        text: `Validation recovery: ${count} blocking issue(s)${milestone ? ` in ${milestone}` : ""}`,
        milestoneId: milestone || undefined,
      };
    }
    case "integration_preflight": {
      const milestone = typeof d.milestoneId === "string" ? d.milestoneId : "";
      const status = typeof d.status === "string" ? d.status : "";
      return {
        ...base,
        category: "validation",
        text: `Integration preflight: ${status}${milestone ? ` for ${milestone}` : ""}`,
        milestoneId: milestone || undefined,
      };
    }
    case "tool_call": {
      const tool = typeof d.toolName === "string" ? d.toolName : "";
      const params = d.params as Record<string, unknown> | undefined;
      const featureId = params && typeof params.featureId === "string" ? params.featureId : undefined;
      const milestoneId = params && typeof params.milestoneId === "string" ? params.milestoneId : undefined;
      return {
        ...base,
        category: "agent",
        text: `Called ${tool}${featureId ? ` for ${featureId}` : milestoneId ? ` for ${milestoneId}` : ""}`,
        featureId,
        milestoneId,
      };
    }
    case "tool_result": {
      const tool = typeof d.toolName === "string" ? d.toolName : "";
      const parseStatus = typeof d.parseStatus === "string" ? d.parseStatus : "";
      return {
        ...base,
        category: "agent",
        text: `${tool} result: ${parseStatus || "done"}${typeof d.durationMs === "number" ? ` (${d.durationMs}ms)` : ""}`,
      };
    }
    case "pending_question": {
      const question = typeof d.question === "string" ? d.question : "";
      return {
        ...base,
        category: "question",
        text: `Question: ${question.slice(0, 150)}`,
      };
    }
    default:
      return undefined;
  }
}