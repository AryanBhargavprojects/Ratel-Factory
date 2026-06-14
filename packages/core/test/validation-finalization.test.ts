import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { atomicWriteJson } from "../src/core/mission/atomic-file.js";
import { writeFeatures, writeMilestones, readFeatures, readMilestones } from "../src/core/artifacts.js";
import type { Feature, ScrutinyReport, UserTestingReport, Milestone } from "../src/core/types.js";
import {
  evaluateMilestoneValidation,
  applyMilestoneValidation,
} from "../src/core/mission/validation-finalization.js";
import type { ValidationFinalizationResult } from "../src/core/mission/validation-finalization.js";

describe("validation finalization gate", () => {
  async function setupMissionDir() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-validation-"));
    const missionId = "mis_validation_test";
    const scope = createMissionScope(projectRoot, missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });
    await mkdir(join(missionDir, "validation-reports"), { recursive: true });
    await mkdir(join(missionDir, "validation-receipts"), { recursive: true });
    return { projectRoot, scope, missionDir };
  }

  async function cleanup(projectRoot: string) {
    await rm(projectRoot, { recursive: true, force: true });
  }

  function makeGoodScrutinyReport(milestoneId: string): ScrutinyReport {
    return {
      validatorType: "scrutiny",
      milestoneId,
      createdAt: new Date().toISOString(),
      automatedChecks: {
        tests: { passed: true, command: "npm test", exitCode: 0, output: "ok" },
        typecheck: { passed: true, command: "tsc --noEmit", exitCode: 0, output: "ok" },
        lint: { passed: true, command: "eslint .", exitCode: 0, output: "ok" },
      },
      codeReviews: [],
      issues: [],
      summary: "All clear",
    };
  }

  function makeGoodUserTestingReport(milestoneId: string): UserTestingReport {
    return {
      validatorType: "user-testing",
      milestoneId,
      createdAt: new Date().toISOString(),
      appStartCommand: "npm run dev",
      baseURL: "http://localhost:3000",
      scenarioResults: [
        {
          featureFile: "auth.feature",
          scenarioName: "Login works",
          status: "passed",
          steps: [],
          screenshotPaths: [],
          consoleErrors: [],
          durationMs: 1000,
        },
      ],
      issues: [],
      summary: "All clear",
      coverageStatus: "complete",
    };
  }

  async function writeReportFiles(missionDir: string, milestoneId: string, scrutiny: ScrutinyReport, userTesting: UserTestingReport) {
    const scrutinyFilename = `scrutiny-${milestoneId}-${Date.now()}.json`;
    const userTestingFilename = `user-testing-${milestoneId}-${Date.now()}.json`;
    await atomicWriteJson(join(missionDir, "validation-reports", scrutinyFilename), scrutiny);
    await atomicWriteJson(join(missionDir, "validation-reports", userTestingFilename), userTesting);
    return { scrutinyFilename, userTestingFilename };
  }

  it("successful reports transition integrated features to validated", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
      { id: "F2", title: "B", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1", "F2"], status: "in_progress" },
    ]);

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(
      missionDir,
      "M1",
      makeGoodScrutinyReport("M1"),
      makeGoodUserTestingReport("M1"),
    );

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, true, `Expected success but got errors: ${result.errors.join(", ")}`);
    assert.deepStrictEqual(result.featureIds, ["F1", "F2"]);

    await applyMilestoneValidation(scope, result);

    const features = await readFeatures(scope);
    const f1 = features?.find((f) => f.id === "F1");
    const f2 = features?.find((f) => f.id === "F2");
    assert.strictEqual(f1?.status, "validated");
    assert.strictEqual(f2?.status, "validated");
    assert.ok(f1?.validatedAt);
    assert.ok(f2?.validatedAt);

    const milestones = await readMilestones(scope);
    const m1 = milestones?.find((m) => m.id === "M1");
    assert.strictEqual(m1?.status, "completed");

    await cleanup(projectRoot);
  });

  it("stale reports (before latest integratedAt) are rejected", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    // Feature integrated in the future relative to report writes
    const futureIntegratedAt = new Date(Date.now() + 60_000).toISOString();
    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: futureIntegratedAt },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(
      missionDir,
      "M1",
      makeGoodScrutinyReport("M1"),
      makeGoodUserTestingReport("M1"),
    );

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("stale") || e.includes("integratedAt") || e.includes("fresh")));
    await cleanup(projectRoot);
  });

  it("failed automated checks reject validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const scrutiny: ScrutinyReport = {
      ...makeGoodScrutinyReport("M1"),
      automatedChecks: {
        tests: { passed: false, command: "npm test", exitCode: 1, output: "failed" },
        typecheck: { passed: true, command: "tsc --noEmit", exitCode: 0, output: "ok" },
        lint: { passed: true, command: "eslint .", exitCode: 0, output: "ok" },
      },
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", scrutiny, makeGoodUserTestingReport("M1"));

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("test") || e.includes("automated")));
    await cleanup(projectRoot);
  });

  it("failed typecheck rejects validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const scrutiny: ScrutinyReport = {
      ...makeGoodScrutinyReport("M1"),
      automatedChecks: {
        tests: { passed: true, command: "npm test", exitCode: 0, output: "ok" },
        typecheck: { passed: false, command: "tsc --noEmit", exitCode: 1, output: "failed" },
        lint: { passed: true, command: "eslint .", exitCode: 0, output: "ok" },
      },
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", scrutiny, makeGoodUserTestingReport("M1"));

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("typecheck")));
    await cleanup(projectRoot);
  });

  it("failed lint rejects validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const scrutiny: ScrutinyReport = {
      ...makeGoodScrutinyReport("M1"),
      automatedChecks: {
        tests: { passed: true, command: "npm test", exitCode: 0, output: "ok" },
        typecheck: { passed: true, command: "tsc --noEmit", exitCode: 0, output: "ok" },
        lint: { passed: false, command: "eslint .", exitCode: 1, output: "failed" },
      },
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", scrutiny, makeGoodUserTestingReport("M1"));

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("lint")));
    await cleanup(projectRoot);
  });

  it("failed browser scenarios reject validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const userTesting: UserTestingReport = {
      ...makeGoodUserTestingReport("M1"),
      scenarioResults: [
        {
          featureFile: "auth.feature",
          scenarioName: "Login fails",
          status: "failed",
          steps: [],
          screenshotPaths: [],
          consoleErrors: [],
          durationMs: 1000,
        },
      ],
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", makeGoodScrutinyReport("M1"), userTesting);

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("scenario") || e.includes("failed")));
    await cleanup(projectRoot);
  });

  it("incomplete user-testing coverage rejects validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const userTesting: UserTestingReport = {
      ...makeGoodUserTestingReport("M1"),
      coverageStatus: "incomplete",
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", makeGoodScrutinyReport("M1"), userTesting);

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("coverage") || e.includes("incomplete")));
    await cleanup(projectRoot);
  });

  it("any blocking issue in scrutiny rejects validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const scrutiny: ScrutinyReport = {
      ...makeGoodScrutinyReport("M1"),
      issues: [
        { id: "SCR-1", severity: "blocking", category: "test", description: "bad test" },
      ],
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", scrutiny, makeGoodUserTestingReport("M1"));

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("blocking")));
    await cleanup(projectRoot);
  });

  it("any blocking issue in user testing rejects validation", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const userTesting: UserTestingReport = {
      ...makeGoodUserTestingReport("M1"),
      issues: [
        { id: "UT-1", severity: "blocking", category: "behavioral", description: "bad behavior" },
      ],
    };

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(missionDir, "M1", makeGoodScrutinyReport("M1"), userTesting);

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("blocking")));
    await cleanup(projectRoot);
  });

  it("already-validated features remain validated and are not reverted", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "validated", validatedAt: "2024-01-01T00:00:00Z" },
      { id: "F2", title: "B", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1", "F2"], status: "in_progress" },
    ]);

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(
      missionDir,
      "M1",
      makeGoodScrutinyReport("M1"),
      makeGoodUserTestingReport("M1"),
    );

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.featureIds, ["F2"]);

    await applyMilestoneValidation(scope, result);

    const features = await readFeatures(scope);
    const f1 = features?.find((f) => f.id === "F1");
    assert.strictEqual(f1?.status, "validated");
    assert.strictEqual(f1?.validatedAt, "2024-01-01T00:00:00Z");

    await cleanup(projectRoot);
  });

  it("writes validation receipt on success", async () => {
    const { projectRoot, scope, missionDir } = await setupMissionDir();

    await writeFeatures(scope, [
      { id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "integrated", integratedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    await writeMilestones(scope, [
      { id: "M1", title: "M", description: "", featureIds: ["F1"], status: "in_progress" },
    ]);

    const { scrutinyFilename, userTestingFilename } = await writeReportFiles(
      missionDir,
      "M1",
      makeGoodScrutinyReport("M1"),
      makeGoodUserTestingReport("M1"),
    );

    const result = await evaluateMilestoneValidation(scope, {
      milestoneId: "M1",
      scrutinyReportFilename: scrutinyFilename,
      userTestingReportFilename: userTestingFilename,
    });

    assert.strictEqual(result.success, true);

    await applyMilestoneValidation(scope, result);

    const receiptPath = join(missionDir, "validation-receipts", "M1.json");
    const receipt = JSON.parse(await (await import("node:fs/promises")).readFile(receiptPath, "utf-8"));
    assert.strictEqual(receipt.milestoneId, "M1");
    assert.deepStrictEqual(receipt.featureIds, ["F1"]);
    assert.strictEqual(receipt.success, true);

    await cleanup(projectRoot);
  });
});
