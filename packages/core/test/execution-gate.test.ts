import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkExecutionAuthorization,
  readApprovalStatus,
} from "../src/core/mission/execution-gate.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { writeState } from "../src/core/artifacts.js";
import type { MissionPhase } from "../src/core/types.js";

async function setup(projectRoot: string, missionId: string) {
  const scope = createMissionScope(projectRoot, missionId);
  await mkdir(getMissionDir(scope), { recursive: true });
  return scope;
}

async function writeApproval(
  scope: ReturnType<typeof createMissionScope>,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(getMissionDir(scope), "approval.json"), JSON.stringify(payload, null, 2), "utf-8");
}

async function setPhase(scope: ReturnType<typeof createMissionScope>, phase: MissionPhase): Promise<void> {
  await writeState(scope, { phase, version: 1, updatedAt: new Date().toISOString() });
}

describe("execution-gate", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-execgate-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns unauthorized no_mission_state when state.json is missing", async () => {
    const scope = await setup(projectRoot, "mis_eg_00001");
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "no_mission_state");
  });

  it("returns unauthorized missing_approval when no approval.json exists", async () => {
    const scope = await setup(projectRoot, "mis_eg_00002");
    await setPhase(scope, "execution");
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "missing_approval");
    assert.strictEqual(result.phase, "execution");
  });

  it("returns unauthorized approval_pending when approval status is pending", async () => {
    const scope = await setup(projectRoot, "mis_eg_00003");
    await setPhase(scope, "execution");
    await writeApproval(scope, {
      status: "pending",
      missionId: scope.missionId,
      createdAt: new Date().toISOString(),
    });
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "approval_pending");
    assert.strictEqual(result.approvalStatus, "pending");
  });

  it("returns unauthorized approval_rejected when approval status is rejected", async () => {
    const scope = await setup(projectRoot, "mis_eg_00004");
    await setPhase(scope, "execution");
    await writeApproval(scope, {
      status: "rejected",
      missionId: scope.missionId,
      feedback: "Need changes",
      decidedAt: new Date().toISOString(),
    });
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "approval_rejected");
    assert.strictEqual(result.approvalStatus, "rejected");
  });

  it("authorizes when approved and phase is approved", async () => {
    const scope = await setup(projectRoot, "mis_eg_00005");
    await setPhase(scope, "approved");
    await writeApproval(scope, {
      status: "approved",
      missionId: scope.missionId,
      decidedAt: new Date().toISOString(),
    });
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, true);
    assert.strictEqual(result.reason, undefined);
    assert.strictEqual(result.phase, "approved");
    assert.strictEqual(result.approvalStatus, "approved");
  });

  it("authorizes when approved and phase is execution", async () => {
    const scope = await setup(projectRoot, "mis_eg_00006");
    await setPhase(scope, "execution");
    await writeApproval(scope, {
      status: "approved",
      missionId: scope.missionId,
      decidedAt: new Date().toISOString(),
    });
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, true);
    assert.strictEqual(result.phase, "execution");
  });

  it("returns unauthorized wrong_phase when approved but phase is pre-approval", async () => {
    const scope = await setup(projectRoot, "mis_eg_00007");
    await setPhase(scope, "user_approval");
    await writeApproval(scope, {
      status: "approved",
      missionId: scope.missionId,
      decidedAt: new Date().toISOString(),
    });
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "wrong_phase");
    assert.strictEqual(result.phase, "user_approval");
  });

  it("returns unauthorized missing_approval for an unknown approval status", async () => {
    const scope = await setup(projectRoot, "mis_eg_00008");
    await setPhase(scope, "execution");
    await writeApproval(scope, { status: "weird", missionId: scope.missionId });
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "missing_approval");
  });

  it("readApprovalStatus returns undefined for missing or malformed approval", async () => {
    const scope = await setup(projectRoot, "mis_eg_00009");
    assert.strictEqual(await readApprovalStatus(scope), undefined);
    await writeFile(
      join(getMissionDir(scope), "approval.json"),
      "not-json",
      "utf-8",
    );
    assert.strictEqual(await readApprovalStatus(scope), undefined);
    await writeFile(
      join(getMissionDir(scope), "approval.json"),
      JSON.stringify({ noStatus: true }),
      "utf-8",
    );
    assert.strictEqual(await readApprovalStatus(scope), undefined);
  });

  it("never throws even when the mission dir is missing entirely", async () => {
    const scope = createMissionScope(projectRoot, "mis_eg_00010");
    // Intentionally do NOT create the mission dir.
    const result = await checkExecutionAuthorization(scope);
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "no_mission_state");
  });
});
