import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadMissionState,
  summarizeMissionState,
  writeState,
  writeFeatures,
  writeArtifact,
} from "../src/core/artifacts.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import type { Feature, MissionPhase } from "../src/core/types.js";

async function setPhase(scope: ReturnType<typeof createMissionScope>, phase: MissionPhase): Promise<void> {
  await writeState(scope, { phase, version: 1, updatedAt: new Date().toISOString() });
}

function makeFeature(id: string, status: Feature["status"]): Feature {
  return {
    id,
    title: `Feature ${id}`,
    description: "desc",
    assertions: [],
    milestoneId: "M1",
    status,
  };
}

describe("loadMissionState richer summary", () => {
  let projectRoot: string;
  let scope: ReturnType<typeof createMissionScope>;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-state-"));
    scope = createMissionScope(projectRoot, "mis_state_00001");
    await mkdir(getMissionDir(scope), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("gracefully omits approval/budget/halt/featureStatus when artifacts are missing", async () => {
    await setPhase(scope, "intake");
    const state = await loadMissionState(scope);
    assert.strictEqual(state.phase, "intake");
    assert.strictEqual(state.approval, undefined);
    assert.strictEqual(state.budget, undefined);
    assert.strictEqual(state.haltReason, undefined);
    assert.strictEqual(state.featureStatus, undefined);
    assert.ok(Array.isArray(state.recommendedActions));
    assert.ok(state.recommendedActions!.length > 0);
  });

  it("projects approval summary when approval.json exists", async () => {
    await setPhase(scope, "execution");
    await writeFile(
      join(getMissionDir(scope), "approval.json"),
      JSON.stringify({
        status: "approved",
        missionId: scope.missionId,
        feedback: "looks good",
        decidedAt: "2026-06-21T00:00:00Z",
      }),
      "utf-8",
    );
    const state = await loadMissionState(scope);
    assert.ok(state.approval);
    assert.strictEqual(state.approval.status, "approved");
    assert.strictEqual(state.approval.feedback, "looks good");
    assert.strictEqual(state.approval.decidedAt, "2026-06-21T00:00:00Z");

    const summary = summarizeMissionState(state);
    assert.ok(summary.includes("### Approval"));
    assert.ok(summary.includes("Status: approved"));
    assert.ok(summary.includes("looks good"));
  });

  it("projects halt reason when halt-reason.md exists", async () => {
    await setPhase(scope, "halted");
    await writeArtifact(
      scope,
      "halt-reason.md",
      `# Mission Halted\n\n**Reason:** Insufficient budget\n\n**Context:** x\n\n**Resume Hint:** y\n`,
    );
    const state = await loadMissionState(scope);
    assert.ok(state.haltReason);
    assert.match(state.haltReason!, /Insufficient budget/);

    const summary = summarizeMissionState(state);
    assert.ok(summary.includes("### Halt Reason"));
    assert.ok(summary.includes("Insufficient budget"));
  });

  it("projects budget summary when budget.json exists", async () => {
    await setPhase(scope, "execution");
    await writeFile(
      join(getMissionDir(scope), "budget.json"),
      JSON.stringify({
        limits: {
          maxCostUsd: 10,
          maxTotalTokens: 1_000_000,
          maxInputTokens: null,
          maxOutputTokens: null,
          maxWallClockMinutes: 60,
          maxAgentRuns: 50,
          maxModelAttemptsPerRun: 3,
        },
        startedAt: "2026-06-21T00:00:00Z",
        updatedAt: "2026-06-21T01:00:00Z",
        agentRuns: 5,
        input: 1000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1500,
        costUsd: 2.5,
        byRole: {},
      }),
      "utf-8",
    );
    const state = await loadMissionState(scope);
    assert.ok(state.budget);
    assert.strictEqual(state.budget.used.costUsd, 2.5);
    assert.strictEqual(state.budget.used.totalTokens, 1500);
    assert.strictEqual(state.budget.used.agentRuns, 5);
    assert.strictEqual(state.budget.remaining.costUsd, 7.5);
    assert.strictEqual(state.budget.remaining.totalTokens, 998_500);
    assert.strictEqual(state.budget.remaining.agentRuns, 45);
    assert.strictEqual(state.budget.limits.maxCostUsd, 10);

    const summary = summarizeMissionState(state);
    assert.ok(summary.includes("### Budget"));
    assert.ok(summary.includes("cost=$2.5000"));
    assert.ok(summary.includes("tokens=1500"));
    assert.ok(summary.includes("runs=5"));
  });

  it("projects exhausted budget metadata when budget.json marks exhaustion", async () => {
    await setPhase(scope, "execution");
    await writeFile(
      join(getMissionDir(scope), "budget.json"),
      JSON.stringify({
        limits: { maxCostUsd: 5, maxTotalTokens: null, maxInputTokens: null, maxOutputTokens: null, maxWallClockMinutes: null, maxAgentRuns: null, maxModelAttemptsPerRun: 3 },
        startedAt: "2026-06-21T00:00:00Z",
        updatedAt: "2026-06-21T01:00:00Z",
        agentRuns: 10,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        costUsd: 6,
        byRole: {},
        exhausted: { reason: "costUsd", at: "2026-06-21T01:30:00Z" },
      }),
      "utf-8",
    );
    const state = await loadMissionState(scope);
    assert.ok(state.budget?.exhausted);
    assert.strictEqual(state.budget!.exhausted!.reason, "costUsd");
    assert.ok(state.recommendedActions!.some((a) => a.includes("Budget exhausted")));
  });

  it("projects feature status summary when features.json exists", async () => {
    await setPhase(scope, "execution");
    await writeFeatures(scope, [
      makeFeature("F1", "pending"),
      makeFeature("F2", "in_progress"),
      makeFeature("F3", "integrated"),
      makeFeature("F4", "validated"),
      makeFeature("F5", "blocked"),
      makeFeature("F6", "pending"),
    ]);
    const state = await loadMissionState(scope);
    assert.ok(state.featureStatus);
    assert.strictEqual(state.featureStatus!.total, 6);
    assert.strictEqual(state.featureStatus!.byStatus.pending, 2);
    assert.strictEqual(state.featureStatus!.byStatus.in_progress, 1);
    assert.strictEqual(state.featureStatus!.byStatus.integrated, 1);
    assert.strictEqual(state.featureStatus!.byStatus.validated, 1);
    assert.strictEqual(state.featureStatus!.byStatus.blocked, 1);

    const summary = summarizeMissionState(state);
    assert.ok(summary.includes("### Features"));
    assert.ok(summary.includes("Status:"));
    assert.ok(summary.includes("pending=2"));
    assert.ok(summary.includes("blocked=1"));
  });

  it("produces deterministic recommended actions for a freshly approved mission", async () => {
    await setPhase(scope, "approved");
    await writeFile(
      join(getMissionDir(scope), "approval.json"),
      JSON.stringify({ status: "approved", decidedAt: "2026-06-21T00:00:00Z" }),
      "utf-8",
    );
    const state = await loadMissionState(scope);
    assert.ok(state.recommendedActions!.some((a) => a.includes("Begin execution")));
  });

  it("recommended actions prioritize halt recovery when halted", async () => {
    await setPhase(scope, "halted");
    await writeArtifact(scope, "halt-reason.md", `# Mission Halted\n\n**Reason:** Bad inputs\n`);
    const state = await loadMissionState(scope);
    assert.ok(state.recommendedActions!.length > 0);
    assert.match(state.recommendedActions![0], /halt/i);
  });

  it("recommended actions reference pending approval when status is pending", async () => {
    await setPhase(scope, "user_approval");
    await writeFile(
      join(getMissionDir(scope), "approval.json"),
      JSON.stringify({ status: "pending", createdAt: "2026-06-21T00:00:00Z" }),
      "utf-8",
    );
    const state = await loadMissionState(scope);
    assert.ok(state.recommendedActions!.some((a) => a.includes("approval decision")));
  });

  it("summarizeMissionState includes Recommended Next Actions section", async () => {
    await setPhase(scope, "intake");
    const state = await loadMissionState(scope);
    const summary = summarizeMissionState(state);
    assert.ok(summary.includes("### Recommended Next Actions"));
  });

  it("remains backward compatible: contract + decisions still load", async () => {
    await setPhase(scope, "execution");
    // No new artifacts; legacy fields must still work.
    const state = await loadMissionState(scope);
    assert.strictEqual(state.phase, "execution");
    assert.deepStrictEqual(state.decisions, []);
    assert.strictEqual(state.features, undefined);
    assert.strictEqual(state.validationContract, undefined);
  });
});
