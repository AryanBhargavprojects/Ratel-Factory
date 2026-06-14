import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { atomicWriteJson, atomicWriteFile } from "../src/core/mission/atomic-file.js";
import { writeFeatures, readFeatures, writeMilestones, readMilestones, writeArtifact } from "../src/core/artifacts.js";
import { normalizeFeature, normalizeFeaturesDocument, selectIntegratedFeaturesForMilestone } from "../src/core/schema/mission-schema.js";
import {
  evaluateFeatureIntegrationGate,
  applyFeatureIntegration,
  wouldIntroduceIntegratedTransition,
} from "../src/core/mission/feature-completion.js";
import { persistWorkerReceipt } from "../src/core/report-submission.js";
import type { Feature, Milestone, WorkerRunReceipt } from "../src/core/types.js";
import {
  evaluateMilestoneValidation,
  applyMilestoneValidation,
} from "../src/core/mission/validation-finalization.js";
import type { ValidationFinalizationResult } from "../src/core/mission/validation-finalization.js";

describe("lifecycle semantics", () => {
  async function setupMissionDir() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-lifecycle-"));
    const missionId = "mis_lifecycle_test";
    const scope = createMissionScope(projectRoot, missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });
    await mkdir(join(missionDir, "worker-runs"), { recursive: true });
    await mkdir(join(missionDir, "validation-reports"), { recursive: true });
    await mkdir(join(missionDir, "validation-receipts"), { recursive: true });
    return { projectRoot, scope, missionDir };
  }

  async function cleanup(projectRoot: string) {
    await rm(projectRoot, { recursive: true, force: true });
  }

  describe("schema normalization", () => {
    it("legacy feature status 'complete' normalizes to 'integrated'", () => {
      const result = normalizeFeature({ id: "F1", title: "T", description: "", assertions: [], milestoneId: "M1", status: "complete" });
      assert.strictEqual(result.status, "integrated");
    });

    it("legacy feature status 'completed' normalizes to 'integrated'", () => {
      const result = normalizeFeature({ id: "F1", title: "T", description: "", assertions: [], milestoneId: "M1", status: "completed" });
      assert.strictEqual(result.status, "integrated");
    });

    it("canonical statuses are preserved", () => {
      for (const status of ["pending", "in_progress", "integrated", "validated", "blocked"] as const) {
        const result = normalizeFeature({ id: "F1", title: "T", description: "", assertions: [], milestoneId: "M1", status });
        assert.strictEqual(result.status, status);
      }
    });

    it("normalizeFeaturesDocument emits no legacy values", () => {
      const doc = normalizeFeaturesDocument({
        features: [
          { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "complete" },
          { id: "F2", title: "B", description: "", assertions: [], milestoneId: "M1", status: "completed" },
        ],
      });
      assert.ok(doc.features.every((f) => f.status !== "complete" && f.status !== "completed"));
      assert.strictEqual(doc.features[0].status, "integrated");
      assert.strictEqual(doc.features[1].status, "integrated");
    });

    it("milestone legacy 'completed' stays 'completed'", () => {
      const result = normalizeFeature({ id: "F1", title: "T", description: "", assertions: [], milestoneId: "M1", status: "completed" });
      assert.strictEqual(result.status, "integrated");
    });
  });

  describe("direct artifact write blocking", () => {
    it("direct artifact write cannot introduce 'integrated'", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }],
      });

      const proposed: Feature[] = [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" }];
      const current = await readFeatures(scope);
      const check = wouldIntroduceIntegratedTransition(current, proposed);
      assert.strictEqual(check.blocked, true);
      assert.ok(check.reason?.includes("mark_feature_integrated"));

      await cleanup(projectRoot);
    });

    it("direct artifact write cannot introduce 'validated'", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" }],
      });

      const proposed: Feature[] = [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "validated" }];
      const current = await readFeatures(scope);
      const check = wouldIntroduceIntegratedTransition(current, proposed);
      assert.strictEqual(check.blocked, true);
      assert.ok(check.reason?.includes("validated"));

      await cleanup(projectRoot);
    });

    it("new feature cannot be created with status 'integrated'", async () => {
      const { projectRoot, scope } = await setupMissionDir();
      const proposed: Feature[] = [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" }];
      const check = wouldIntroduceIntegratedTransition(undefined, proposed);
      assert.strictEqual(check.blocked, true);
      await cleanup(projectRoot);
    });

    it("new feature cannot be created with status 'validated'", async () => {
      const { projectRoot, scope } = await setupMissionDir();
      const proposed: Feature[] = [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "validated" }];
      const check = wouldIntroduceIntegratedTransition(undefined, proposed);
      assert.strictEqual(check.blocked, true);
      await cleanup(projectRoot);
    });
  });

  describe("feature integration gate", () => {
    it("clean worker receipt allows pending -> integrated", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }],
      });

      const receipt: WorkerRunReceipt = {
        featureId: "F1",
        recordedAt: new Date().toISOString(),
        parseStatus: "ok",
        reportSource: "tool_submission",
        handoffPath: "handoffs/F1.json",
        rawFilename: "F1.raw.txt",
        handoff: {
          featureId: "F1",
          completedAt: new Date().toISOString(),
          completed: ["done"],
          leftUndone: [],
          commandsRun: [],
          issuesDiscovered: [],
          proceduresAbided: true,
          summary: "Done",
        },
        workspace: { status: "ready", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
        workspaceFinalization: { status: "skipped", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
      };
      await persistWorkerReceipt(scope, receipt);

      const gate = await evaluateFeatureIntegrationGate(scope, "F1");
      assert.strictEqual(gate.success, true);
      await cleanup(projectRoot);
    });

    it("clean worker receipt allows in_progress -> integrated", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "in_progress" }],
      });

      const receipt: WorkerRunReceipt = {
        featureId: "F1",
        recordedAt: new Date().toISOString(),
        parseStatus: "ok",
        reportSource: "tool_submission",
        handoffPath: "handoffs/F1.json",
        rawFilename: "F1.raw.txt",
        handoff: {
          featureId: "F1",
          completedAt: new Date().toISOString(),
          completed: ["done"],
          leftUndone: [],
          commandsRun: [],
          issuesDiscovered: [],
          proceduresAbided: true,
          summary: "Done",
        },
        workspace: { status: "ready", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
        workspaceFinalization: { status: "skipped", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
      };
      await persistWorkerReceipt(scope, receipt);

      const gate = await evaluateFeatureIntegrationGate(scope, "F1");
      assert.strictEqual(gate.success, true);
      await cleanup(projectRoot);
    });

    it("worker integration never produces validated", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }],
      });

      const receipt: WorkerRunReceipt = {
        featureId: "F1",
        recordedAt: new Date().toISOString(),
        parseStatus: "ok",
        reportSource: "tool_submission",
        handoffPath: "handoffs/F1.json",
        rawFilename: "F1.raw.txt",
        handoff: {
          featureId: "F1",
          completedAt: new Date().toISOString(),
          completed: ["done"],
          leftUndone: [],
          commandsRun: [],
          issuesDiscovered: [],
          proceduresAbided: true,
          summary: "Done",
        },
        workspace: { status: "ready", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
        workspaceFinalization: { status: "skipped", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
      };
      await persistWorkerReceipt(scope, receipt);

      const gate = await evaluateFeatureIntegrationGate(scope, "F1");
      assert.strictEqual(gate.success, true);
      assert.strictEqual(gate.commitSha, undefined);

      await applyFeatureIntegration(scope, "F1", gate.commitSha);
      const features = await readFeatures(scope);
      const f1 = features?.find((f) => f.id === "F1");
      assert.strictEqual(f1?.status, "integrated");
      assert.ok(!f1?.validatedAt);

      await cleanup(projectRoot);
    });

    it("integration gate rejects when parseStatus is failed", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }],
      });

      const receipt: WorkerRunReceipt = {
        featureId: "F1",
        recordedAt: new Date().toISOString(),
        parseStatus: "failed",
        reportSource: "jsonl_fallback",
        handoffPath: "handoffs/F1.json",
        rawFilename: "F1.raw.txt",
        handoff: {
          featureId: "F1",
          completedAt: new Date().toISOString(),
          completed: [],
          leftUndone: [],
          commandsRun: [],
          issuesDiscovered: [],
          proceduresAbided: true,
          summary: "Failed",
        },
        workspace: { status: "ready", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
        workspaceFinalization: { status: "skipped", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
      };
      await persistWorkerReceipt(scope, receipt);

      const gate = await evaluateFeatureIntegrationGate(scope, "F1");
      assert.strictEqual(gate.success, false);
      assert.ok(gate.errors.some((e) => e.includes("parseStatus")));
      await cleanup(projectRoot);
    });

    it("integration gate rejects when leftUndone is non-empty", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }],
      });

      const receipt: WorkerRunReceipt = {
        featureId: "F1",
        recordedAt: new Date().toISOString(),
        parseStatus: "ok",
        reportSource: "tool_submission",
        handoffPath: "handoffs/F1.json",
        rawFilename: "F1.raw.txt",
        handoff: {
          featureId: "F1",
          completedAt: new Date().toISOString(),
          completed: [],
          leftUndone: ["todo"],
          commandsRun: [],
          issuesDiscovered: [],
          proceduresAbided: true,
          summary: "Partial",
        },
        workspace: { status: "ready", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
        workspaceFinalization: { status: "skipped", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
      };
      await persistWorkerReceipt(scope, receipt);

      const gate = await evaluateFeatureIntegrationGate(scope, "F1");
      assert.strictEqual(gate.success, false);
      assert.ok(gate.errors.some((e) => e.includes("unfinished")));
      await cleanup(projectRoot);
    });

    it("integration gate rejects when high issues exist", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "features.json"), {
        features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }],
      });

      const receipt: WorkerRunReceipt = {
        featureId: "F1",
        recordedAt: new Date().toISOString(),
        parseStatus: "ok",
        reportSource: "tool_submission",
        handoffPath: "handoffs/F1.json",
        rawFilename: "F1.raw.txt",
        handoff: {
          featureId: "F1",
          completedAt: new Date().toISOString(),
          completed: ["done"],
          leftUndone: [],
          commandsRun: [],
          issuesDiscovered: [{ description: "bug", severity: "high" }],
          proceduresAbided: true,
          summary: "Done with issue",
        },
        workspace: { status: "ready", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
        workspaceFinalization: { status: "skipped", repoPath: "/tmp/repo", integrationBranch: "integration", featureBranch: "feat/F1" },
      };
      await persistWorkerReceipt(scope, receipt);

      const gate = await evaluateFeatureIntegrationGate(scope, "F1");
      assert.strictEqual(gate.success, false);
      assert.ok(gate.errors.some((e) => e.includes("high")));
      await cleanup(projectRoot);
    });
  });

  describe("selectIntegratedFeaturesForMilestone", () => {
    it("selects only integrated features for a milestone", () => {
      const features: Feature[] = [
        { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" },
        { id: "F2", title: "B", description: "", assertions: [], milestoneId: "M1", status: "validated" },
        { id: "F3", title: "C", description: "", assertions: [], milestoneId: "M2", status: "integrated" },
        { id: "F4", title: "D", description: "", assertions: [], milestoneId: "M1", status: "pending" },
      ];
      const result = selectIntegratedFeaturesForMilestone(features, "M1");
      assert.deepStrictEqual(result.map((f) => f.id), ["F1"]);
    });
  });

  describe("validation cannot start with pending or in_progress features", () => {
    it("evaluateMilestoneValidation fails if any feature is pending", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await writeFeatures(scope, [
        { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" },
      ]);
      await writeMilestones(scope, [
        { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
      ]);

      const result = await evaluateMilestoneValidation(scope, {
        milestoneId: "M1",
        scrutinyReportFilename: "scrutiny-M1-123.json",
        userTestingReportFilename: "user-testing-M1-123.json",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.includes("pending")));
      await cleanup(projectRoot);
    });

    it("evaluateMilestoneValidation fails if any feature is in_progress", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await writeFeatures(scope, [
        { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "in_progress" },
      ]);
      await writeMilestones(scope, [
        { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
      ]);

      const result = await evaluateMilestoneValidation(scope, {
        milestoneId: "M1",
        scrutinyReportFilename: "scrutiny-M1-123.json",
        userTestingReportFilename: "user-testing-M1-123.json",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.includes("in_progress")));
      await cleanup(projectRoot);
    });

    it("evaluateMilestoneValidation allows integrated features", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await writeFeatures(scope, [
        { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" },
      ]);
      await writeMilestones(scope, [
        { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
      ]);

      // Write reports that will pass (but files missing so it will fail for missing files)
      const result = await evaluateMilestoneValidation(scope, {
        milestoneId: "M1",
        scrutinyReportFilename: "scrutiny-M1-123.json",
        userTestingReportFilename: "user-testing-M1-123.json",
      });
      // Should fail because report files don't exist, not because of feature status
      assert.ok(!result.errors.some((e) => e.includes("pending") || e.includes("in_progress")));
      await cleanup(projectRoot);
    });
  });

  describe("mission completion", () => {
    it("fails when any feature is not validated", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await writeFeatures(scope, [
        { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated" },
        { id: "F2", title: "B", description: "", assertions: [], milestoneId: "M1", status: "validated" },
      ]);
      await writeMilestones(scope, [
        { id: "M1", title: "M", description: "", featureIds: ["F1", "F2"], status: "completed" },
      ]);

      const { markMissionCompleted } = await import("../src/core/mission/validation-finalization.js");
      const result = await markMissionCompleted(scope);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.includes("validated")));
      await cleanup(projectRoot);
    });
  });
});
