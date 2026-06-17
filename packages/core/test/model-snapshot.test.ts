import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MissionControlPlane } from "../src/control-plane/mission-control-plane.js";
import type { JobExecutor } from "../src/control-plane/job-runner.js";
import type { MissionJob } from "../src/control-plane/types.js";
import { ARTIFACT_NAMES } from "../src/core/types.js";

class NoopExecutor implements JobExecutor {
  async execute(_job: MissionJob, _signal: AbortSignal): Promise<void> {}
}

describe("mission model snapshots", () => {
  it("registers model-config.json as a canonical mission artifact", () => {
    assert.ok(ARTIFACT_NAMES.includes("model-config.json" as never));
  });

  it("preserves missing standalone model selections as SDK defaults", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-model-default-snapshot-"));
    const controlPlane = new MissionControlPlane({
      cwd: projectRoot,
      executor: new NoopExecutor(),
      pollIntervalMs: 1000,
    });

    try {
      await controlPlane.start();
      const { mission } = await controlPlane.enqueueMission({
        intakeMode: "standalone",
        goal: "Use the SDK default models",
      });
      const snapshot = JSON.parse(await readFile(join(
        projectRoot,
        ".ratel",
        "missions",
        mission.missionId,
        "model-config.json",
      ), "utf-8"));

      assert.deepStrictEqual(snapshot.config, {
        orchestrator: { model: null, fallbackModels: [] },
        worker: { model: null, fallbackModels: [] },
        validator: { model: null, fallbackModels: [] },
      });
    } finally {
      await controlPlane.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("captures standalone project models and does not change after ratel.json changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-model-snapshot-"));
    const controlPlane = new MissionControlPlane({
      cwd: projectRoot,
      executor: new NoopExecutor(),
      pollIntervalMs: 1000,
    });

    try {
      const originalConfig = {
        orchestrator: { model: "provider/orchestrator", fallbackModels: ["provider/orchestrator-fallback"] },
        workers: { model: "provider/worker", fallbackModels: ["provider/worker-fallback"] },
        validators: { model: "provider/validator", fallbackModels: [] },
      };
      await writeFile(join(projectRoot, "ratel.json"), JSON.stringify(originalConfig), "utf-8");
      await controlPlane.start();

      const { mission } = await controlPlane.enqueueMission({
        intakeMode: "standalone",
        goal: "Snapshot the configured models",
      });
      const snapshotPath = join(
        projectRoot,
        ".ratel",
        "missions",
        mission.missionId,
        "model-config.json",
      );
      const before = JSON.parse(await readFile(snapshotPath, "utf-8"));

      await writeFile(join(projectRoot, "ratel.json"), JSON.stringify({
        orchestrator: { model: "provider/new-orchestrator", fallbackModels: [] },
        workers: { model: "provider/new-worker", fallbackModels: [] },
        validators: { model: "provider/new-validator", fallbackModels: [] },
      }), "utf-8");

      const { readMissionModelConfig } = await import("../src/core/mission/model-config.js");
      const resolved = await readMissionModelConfig({
        projectRoot,
        missionId: mission.missionId,
      });
      const after = JSON.parse(await readFile(snapshotPath, "utf-8"));

      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(resolved, before.config);
      assert.deepStrictEqual(resolved, {
        orchestrator: {
          model: "provider/orchestrator",
          fallbackModels: ["provider/orchestrator-fallback"],
        },
        worker: {
          model: "provider/worker",
          fallbackModels: ["provider/worker-fallback"],
        },
        validator: {
          model: "provider/validator",
          fallbackModels: [],
        },
      });
    } finally {
      await controlPlane.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects a tampered mission model snapshot instead of using live config", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-model-tampered-snapshot-"));
    const controlPlane = new MissionControlPlane({
      cwd: projectRoot,
      executor: new NoopExecutor(),
      pollIntervalMs: 1000,
    });

    try {
      await writeFile(join(projectRoot, "ratel.json"), JSON.stringify({
        orchestrator: { model: "provider/original", fallbackModels: [] },
        workers: { model: "provider/worker", fallbackModels: [] },
        validators: { model: "provider/validator", fallbackModels: [] },
      }), "utf-8");
      await controlPlane.start();
      const { mission } = await controlPlane.enqueueMission({
        intakeMode: "standalone",
        goal: "Reject model snapshot tampering",
      });
      const snapshotPath = join(
        projectRoot,
        ".ratel",
        "missions",
        mission.missionId,
        "model-config.json",
      );
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf-8"));
      snapshot.config.orchestrator.model = "provider/tampered";
      await writeFile(snapshotPath, JSON.stringify(snapshot), "utf-8");

      const { readMissionModelConfig } = await import("../src/core/mission/model-config.js");
      await assert.rejects(
        readMissionModelConfig({
          projectRoot,
          missionId: mission.missionId,
        }),
        /model configuration snapshot/i,
      );
    } finally {
      await controlPlane.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
