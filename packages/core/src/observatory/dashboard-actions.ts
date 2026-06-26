/**
 * Ratel Observatory — Dashboard Actions Layer (write + resume)
 *
 * The single safe write path for the dashboard. Every edit from the UI goes
 * through here so filename allowlists, the feature-completion gate, and the
 * contract consistency rules are enforced in ONE place, not duplicated in
 * route handlers.
 *
 * Resume semantics are mode-aware via the ActionBridge:
 *   - service: enqueue a continue_orchestrator / approval job on the control plane
 *   - in-process: delegate to the Pi extension runtime (replyToFactory/approve)
 *   - none: writes land on disk only; the next orchestrator turn picks them up
 *
 * Refinement guarantees:
 *   #2 saveContract writes validation-contract.json AND .md consistently
 *   #3 appendDecision is append-only; no overwrite path is exposed
 *   #4 saveFile delegates to the same allowlist/gate as saveArtifact
 *   #5 mode-aware resume via ActionBridge; actionsAvailable reflects mode
 *   #6 reports are read-only (no write methods for handoffs/reports)
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createMissionScope, getMissionDir, type MissionScope } from "../core/mission/scope.js";
import { atomicWriteFile, atomicWriteJson } from "../core/mission/atomic-file.js";
import { ARTIFACT_NAMES } from "../core/types.js";
import type { ArtifactName, ValidationContract, Feature, Milestone, Decision } from "../core/types.js";
import {
  writeArtifact,
  readArtifact,
  readFeatures,
  writeFeatures,
  writeMilestones,
  appendDecision,
  writeValidationContract,
} from "../core/artifacts.js";
import { wouldIntroduceIntegratedTransition } from "../core/mission/feature-completion.js";
import type { MissionControlPlane } from "../control-plane/mission-control-plane.js";
import type { MissionJob } from "../control-plane/types.js";

// ---------------------------------------------------------------------------
// ActionBridge — mode-aware resume interface
// ---------------------------------------------------------------------------

export type BridgeMode = "service" | "in-process" | "none";

export interface ResumeResult {
  jobId?: string;
  status?: string;
  ok: boolean;
  message?: string;
}

export interface ActionBridge {
  readonly mode: BridgeMode;
  readonly actionsAvailable: boolean;
  resumeWithMessage(missionId: string, message: string, questionId?: string): Promise<ResumeResult>;
  approve(missionId: string, approved: boolean, feedback?: string, files?: Record<string, string>): Promise<ResumeResult>;
}

// ── NoActionBridge ──────────────────────────────────────────────────────

export class NoActionBridge implements ActionBridge {
  readonly mode: BridgeMode = "none";
  readonly actionsAvailable = false;

  async resumeWithMessage(_missionId: string, _message: string, _questionId?: string): Promise<ResumeResult> {
    return {
      ok: false,
      message: "Actions unavailable — no control plane or in-process bridge. Edits are saved to disk only; the next orchestrator turn will pick them up.",
    };
  }

  async approve(_missionId: string, _approved: boolean, _feedback?: string, _files?: Record<string, string>): Promise<ResumeResult> {
    return { ok: false, message: "Approval unavailable — no control plane or in-process bridge." };
  }
}

// ── ControlPlaneActionBridge ───────────────────────────────────────────

export class ControlPlaneActionBridge implements ActionBridge {
  readonly mode: BridgeMode = "service";
  readonly actionsAvailable = true;

  constructor(private readonly controlPlane: MissionControlPlane) {}

  async resumeWithMessage(missionId: string, message: string, questionId?: string): Promise<ResumeResult> {
    const payload: Record<string, unknown> = { message };
    if (questionId) payload.questionId = questionId;
    const job = await this.controlPlane.enqueueJob({
      missionId,
      type: "continue_orchestrator",
      payload,
    });
    return { ok: true, jobId: job.jobId, status: job.status };
  }

  async approve(missionId: string, approved: boolean, feedback?: string, files?: Record<string, string>): Promise<ResumeResult> {
    const job = await this.controlPlane.submitApproval(missionId, { approved, feedback, files });
    return { ok: true, jobId: job.jobId, status: job.status };
  }
}

// ── InProcessActionBridge ──────────────────────────────────────────────

export interface InProcessBridgeCallbacks {
  replyToFactory(missionId: string, message: string, questionId?: string): Promise<void>;
  approve(missionId: string, approved: boolean, feedback?: string): Promise<void>;
}

export class InProcessActionBridge implements ActionBridge {
  readonly mode: BridgeMode = "in-process";
  readonly actionsAvailable = true;

  constructor(private readonly callbacks: InProcessBridgeCallbacks) {}

  async resumeWithMessage(missionId: string, message: string, questionId?: string): Promise<ResumeResult> {
    await this.callbacks.replyToFactory(missionId, message, questionId);
    return { ok: true, status: "delivered" };
  }

  async approve(missionId: string, approved: boolean, feedback?: string): Promise<ResumeResult> {
    await this.callbacks.approve(missionId, approved, feedback);
    return { ok: true, status: "delivered" };
  }
}

// ---------------------------------------------------------------------------
// Save results
// ---------------------------------------------------------------------------

export interface SaveResult {
  ok: boolean;
  artifact?: string;
  byteCount?: number;
  error?: string;
  gated?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// DashboardActions
// ---------------------------------------------------------------------------

export interface DashboardActionsOptions {
  cwd: string;
  bridge?: ActionBridge;
}

const FEATURE_FILE_PREFIX = "features/";
const FEATURE_FILE_SUFFIX = ".feature";

export class DashboardActions {
  private readonly cwd: string;
  private readonly bridge: ActionBridge;

  constructor(options: DashboardActionsOptions) {
    this.cwd = options.cwd;
    this.bridge = options.bridge ?? new NoActionBridge();
  }

  get actionMode(): BridgeMode {
    return this.bridge.mode;
  }

  get actionsAvailable(): boolean {
    return this.bridge.actionsAvailable;
  }

  getBridge(): ActionBridge {
    return this.bridge;
  }

  // ── Mission resolution ────────────────────────────────────────────────

  private async scopeOf(missionId: string): Promise<MissionScope> {
    return createMissionScope(this.cwd, missionId);
  }

  // ── Allowlist ─────────────────────────────────────────────────────────

  /** Validate that a filename is a known mission artifact or a .feature file. */
  isValidArtifactFilename(filename: string): boolean {
    if ((ARTIFACT_NAMES as readonly string[]).includes(filename)) return true;
    if (
      filename.startsWith(FEATURE_FILE_PREFIX) &&
      filename.endsWith(FEATURE_FILE_SUFFIX) &&
      !filename.includes("..") &&
      !filename.includes("\\")
    ) {
      return true;
    }
    return false;
  }

  // ── saveArtifact — the one safe write path ───────────────────────────

  async saveArtifact(missionId: string, filename: string, content: string): Promise<SaveResult> {
    if (!this.isValidArtifactFilename(filename)) {
      return { ok: false, error: `Invalid filename: ${filename}`, gated: true };
    }

    const scope = await this.scopeOf(missionId);

    // Contract: delegate to saveContract so JSON+MD stay consistent (#2).
    if (filename === "validation-contract.md" || filename === "validation-contract.json") {
      return this.saveContract(missionId, content, filename.endsWith(".json") ? "json" : "md");
    }

    // features.json: enforce the integration/validated transition gate (#6).
    if (filename === "features.json") {
      const gateCheck = await this.checkFeaturesGate(scope, content);
      if (!gateCheck.ok) return gateCheck;
    }

    try {
      await writeArtifact(scope, filename as ArtifactName, content, "overwrite");
      const byteCount = Buffer.byteLength(content, "utf-8");
      return { ok: true, artifact: filename, byteCount };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * saveFile — generic file write within the mission dir.
   * Delegates to the SAME allowlist + gate as saveArtifact (#4).
   * Used by /api/file POST. Any non-allowlisted path is rejected.
   */
  async saveFile(missionId: string, relPath: string, content: string): Promise<SaveResult> {
    if (!relPath || relPath.includes("..") || relPath.startsWith("/") || relPath.includes("\\")) {
      return { ok: false, error: `Invalid path: ${relPath}`, gated: true };
    }
    return this.saveArtifact(missionId, relPath, content);
  }

  // ── saveContract — keep JSON + MD consistent (#2) ────────────────────

  /**
   * Save the validation contract. `format` indicates which representation was
   * edited; both files are regenerated so the canonical JSON and the markdown
   * projection never diverge.
   *
   * - When `format === "json"`: the content is parsed as ValidationContract and
   *   re-projected to markdown via writeValidationContract (writes BOTH).
   * - When `format === "md"`: only the markdown is overwritten. The JSON is
   *   left untouched because we cannot safely reverse-derive the structured
   *   contract from prose. The orchestrator's next contract run will refresh
   *   the JSON; readValidationContract prefers JSON, so a stale-JSON guard
   *   logs a warning if the md is newer.
   */
  async saveContract(missionId: string, content: string, format: "json" | "md"): Promise<SaveResult> {
    const scope = await this.scopeOf(missionId);
    const missionDir = getMissionDir(scope);

    if (format === "json") {
      let parsed: ValidationContract;
      try {
        parsed = JSON.parse(content) as ValidationContract;
      } catch (err) {
        return { ok: false, error: `Invalid validation-contract.json: ${err instanceof Error ? err.message : String(err)}` };
      }
      try {
        await writeValidationContract(scope, parsed); // writes both .json and .md
        return { ok: true, artifact: "validation-contract.json", byteCount: Buffer.byteLength(content, "utf-8") };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // md-only: just overwrite the markdown file.
    try {
      await atomicWriteFile(join(missionDir, "validation-contract.md"), content);
      return { ok: true, artifact: "validation-contract.md", byteCount: Buffer.byteLength(content, "utf-8") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── appendDecision — append-only (#3) ────────────────────────────────

  async appendDecision(missionId: string, entry: { context: string; decision: string; rationale: string }): Promise<SaveResult> {
    const scope = await this.scopeOf(missionId);
    const decision: Decision = {
      id: `DEC-${Date.now()}`,
      timestamp: new Date().toISOString(),
      context: entry.context,
      decision: entry.decision,
      rationale: entry.rationale,
    };
    try {
      await appendDecision(scope, decision);
      return { ok: true, artifact: "decisions.jsonl", byteCount: 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── saveFeatures / saveMilestones — structured editors ───────────────

  async saveFeatures(missionId: string, features: Feature[]): Promise<SaveResult> {
    const scope = await this.scopeOf(missionId);
    const current = await readFeatures(scope);
    const gate = wouldIntroduceIntegratedTransition(current, features);
    if (gate.blocked) {
      return { ok: false, error: gate.reason, gated: true };
    }
    try {
      await writeFeatures(scope, features);
      return { ok: true, artifact: "features.json", byteCount: 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async saveMilestones(missionId: string, milestones: Milestone[]): Promise<SaveResult> {
    const scope = await this.scopeOf(missionId);
    try {
      await writeMilestones(scope, milestones);
      return { ok: true, artifact: "milestones.json", byteCount: 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Resume actions ────────────────────────────────────────────────────

  async sendMessage(missionId: string, message: string, questionId?: string): Promise<ResumeResult> {
    const trimmed = message.trim();
    if (!trimmed) return { ok: false, message: "message is required" };
    // Persist a durable record of the user reply regardless of bridge mode.
    await this.persistUserReply(missionId, trimmed, questionId);
    return this.bridge.resumeWithMessage(missionId, trimmed, questionId);
  }

  async approvePlan(missionId: string, feedback?: string, files?: Record<string, string>): Promise<ResumeResult> {
    // Validate any file payloads before resuming.
    if (files) {
      for (const filename of Object.keys(files)) {
        if (!this.isValidArtifactFilename(filename)) {
          return { ok: false, message: `Invalid filename in approval files: ${filename}` };
        }
      }
      // Write files first so they land before the resume job runs.
      const scope = await this.scopeOf(missionId);
      for (const [filename, content] of Object.entries(files)) {
        const filePath = join(getMissionDir(scope), filename);
        await mkdir(dirname(filePath), { recursive: true });
        await atomicWriteFile(filePath, content);
      }
    }
    // Persist approval.json (durability + dashboard visibility).
    await this.persistApproval(missionId, true, feedback, files);
    return this.bridge.approve(missionId, true, feedback, files);
  }

  async rejectPlan(missionId: string, feedback?: string, files?: Record<string, string>): Promise<ResumeResult> {
    if (files) {
      for (const filename of Object.keys(files)) {
        if (!this.isValidArtifactFilename(filename)) {
          return { ok: false, message: `Invalid filename in reject files: ${filename}` };
        }
      }
      const scope = await this.scopeOf(missionId);
      for (const [filename, content] of Object.entries(files)) {
        const filePath = join(getMissionDir(scope), filename);
        await mkdir(dirname(filePath), { recursive: true });
        await atomicWriteFile(filePath, content);
      }
    }
    await this.persistApproval(missionId, false, feedback, files);
    return this.bridge.approve(missionId, false, feedback, files);
  }

  /**
   * Approve the plan WITH proposed edits. The edits are written to disk first
   * (as proposed amendments), then the approval is sent with the files
   * attached so the orchestrator sees both "approved" and "here are the
   * changes I want." This implements the smart friend's "Edit draft" mode:
   * edits are proposed amendments, not silent mutation.
   */
  async approveWithEdits(missionId: string, edits: Record<string, string>, feedback?: string): Promise<ResumeResult> {
    return this.approvePlan(missionId, feedback, edits);
  }

  /**
   * Request changes with proposed edits. Same semantics as rejectPlan but
   * the edits are the proposed corrections the orchestrator should incorporate.
   */
  async requestChanges(missionId: string, edits: Record<string, string>, feedback?: string): Promise<ResumeResult> {
    return this.rejectPlan(missionId, feedback, edits);
  }

  /**
   * Create a fix feature from a validation recovery suggestion. Writes the
   * feature via the orchestrator resume path (so the orchestrator owns the
   * features.json mutation), rather than mutating reports (#6).
   */
  async createFixFeature(missionId: string, milestoneId: string, suggestion: { title: string; description: string; issueIds: string[] }): Promise<ResumeResult> {
    const message =
      `Create a fix feature in milestone ${milestoneId} for blocking issues ${suggestion.issueIds.join(", ")}.\n` +
      `Suggested title: ${suggestion.title}\n` +
      `Suggested description: ${suggestion.description}\n` +
      `Add it to features.json under milestone ${milestoneId} with status "pending", then run the worker for it.`;
    return this.sendMessage(missionId, message);
  }

  // ── Gate helpers ──────────────────────────────────────────────────────

  private async checkFeaturesGate(scope: MissionScope, content: string): Promise<SaveResult> {
    let proposed: Feature[] | undefined;
    try {
      proposed = (JSON.parse(content) as { features?: Feature[] }).features;
    } catch {
      // Malformed JSON — let writeArtifact surface the canonicalize error.
      return { ok: true };
    }
    const current = await readFeatures(scope);
    const gate = wouldIntroduceIntegratedTransition(current, proposed);
    if (gate.blocked) {
      return { ok: false, error: gate.reason, gated: true };
    }
    return { ok: true };
  }

  // ── Durability helpers ────────────────────────────────────────────────

  private async persistUserReply(missionId: string, message: string, questionId?: string): Promise<void> {
    const scope = await this.scopeOf(missionId);
    const dir = getMissionDir(scope);
    const entry = {
      timestamp: new Date().toISOString(),
      source: "dashboard",
      message,
      questionId,
    };
    try {
      const { appendFile } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "user-replies.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // best-effort — never block a resume on durability logging
    }
  }

  private async persistApproval(missionId: string, approved: boolean, feedback?: string, files?: Record<string, string>): Promise<void> {
    const scope = await this.scopeOf(missionId);
    const dir = getMissionDir(scope);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "approval.json"),
        JSON.stringify(
          {
            status: approved ? "approved" : "rejected",
            missionId,
            feedback,
            files: files ? Object.keys(files) : undefined,
            decidedAt: new Date().toISOString(),
            source: "dashboard",
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch {
      // best-effort
    }
  }
}