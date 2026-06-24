/**
 * Execution authorization gate for issue #1.
 *
 * Determines whether execution tools (run_worker / run_validation /
 * run_user_testing) may run for a mission by reading durable mission state
 * (state.json) and the approval artifact (approval.json).
 *
 * The gate NEVER throws. Every outcome is returned as a structured
 * `ExecutionGateResult` with a machine-readable `reason` when unauthorized.
 *
 * Authorization policy:
 *   execution is authorized ONLY when
 *     1. a durable mission state exists,
 *     2. approval.json exists with `status === "approved"`, AND
 *     3. the mission phase is one of the execution-ready phases.
 *
 * Phase choice: the canonical `MissionPhase` model (see ../types.ts) has both
 * an `"approved"` phase (entered immediately after user approval, before any
 * build work) and an `"execution"` phase (active build). We accept BOTH so a
 * freshly-approved mission can immediately dispatch execution tools without
 * requiring an intermediate phase bump. This is documented here and exercised
 * by the test suite (approved+approved phase, approved+execution phase).
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { MissionScope } from "./scope.js";
import { getMissionDir } from "./scope.js";
import { readState } from "../artifacts.js";
import type { MissionPhase } from "../types.js";

export type ExecutionGateReason =
  | "no_mission_state"
  | "missing_approval"
  | "approval_pending"
  | "approval_rejected"
  | "wrong_phase";

export interface ExecutionGateResult {
  authorized: boolean;
  /** Present only when `authorized` is false. */
  reason?: ExecutionGateReason;
  /** Human-readable explanation. */
  message: string;
  /** Current mission phase, when a state file was readable. */
  phase?: MissionPhase;
  /** Raw approval status string, when an approval artifact was readable. */
  approvalStatus?: string;
}

/**
 * Phases in which execution tools may run once formal approval exists.
 *
 * See module docstring for the rationale behind accepting both "approved"
 * and "execution".
 */
const EXECUTION_ALLOWED_PHASES: ReadonlySet<MissionPhase> = new Set<MissionPhase>([
  "approved",
  "execution",
]);

/**
 * Read and parse approval.json into a minimal shape.
 * Returns undefined when missing or unparseable.
 */
export async function readApprovalStatus(scope: MissionScope): Promise<
  | { status: string; decidedAt?: string; feedback?: string }
  | undefined
> {
  try {
    const raw = await readFile(join(getMissionDir(scope), "approval.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      status?: unknown;
      feedback?: unknown;
      decidedAt?: unknown;
    };
    if (typeof parsed.status !== "string") return undefined;
    return {
      status: parsed.status,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : undefined,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Check whether execution tools may run for the given mission.
 * Never throws.
 */
export async function checkExecutionAuthorization(
  scope: MissionScope,
): Promise<ExecutionGateResult> {
  let state;
  try {
    state = await readState(scope);
  } catch {
    state = undefined;
  }

  if (!state) {
    return {
      authorized: false,
      reason: "no_mission_state",
      message: "No durable mission state found; cannot authorize execution.",
    };
  }

  let approval;
  try {
    approval = await readApprovalStatus(scope);
  } catch {
    approval = undefined;
  }

  if (!approval) {
    return {
      authorized: false,
      reason: "missing_approval",
      message:
        "No approval artifact found; execution requires formal user approval (approval.json with status \"approved\").",
      phase: state.phase,
    };
  }

  const status = approval.status;
  const statusLower = status.toLowerCase();

  if (statusLower === "pending") {
    return {
      authorized: false,
      reason: "approval_pending",
      message: "Approval is pending; execution is blocked until the user approves.",
      phase: state.phase,
      approvalStatus: status,
    };
  }

  if (statusLower === "rejected") {
    return {
      authorized: false,
      reason: "approval_rejected",
      message: "Approval was rejected; execution is blocked.",
      phase: state.phase,
      approvalStatus: status,
    };
  }

  if (statusLower !== "approved") {
    return {
      authorized: false,
      reason: "missing_approval",
      message: `Approval status "${status}" is not "approved"; execution is blocked.`,
      phase: state.phase,
      approvalStatus: status,
    };
  }

  if (!EXECUTION_ALLOWED_PHASES.has(state.phase)) {
    return {
      authorized: false,
      reason: "wrong_phase",
      message: `Mission phase is "${state.phase}"; execution tools require phase "approved" or "execution".`,
      phase: state.phase,
      approvalStatus: status,
    };
  }

  return {
    authorized: true,
    message:
      "Execution authorized: formal approval exists and mission phase permits execution.",
    phase: state.phase,
    approvalStatus: status,
  };
}
