import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertValidMissionId,
  createMissionScope,
  getMissionDir,
  getRatelDir,
  getMissionRelativeDir,
} from "../src/core/mission/scope.js";
import {
  atomicWriteJson,
  readJsonFile,
} from "../src/core/mission/atomic-file.js";

describe("mission scope", () => {
  it("creates separate directories for two scopes under same project root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-scope-"));
    const scopeA = createMissionScope(projectRoot, "mis_00000001");
    const scopeB = createMissionScope(projectRoot, "mis_00000002");

    const dirA = getMissionDir(scopeA);
    const dirB = getMissionDir(scopeB);

    assert.strictEqual(dirA, join(projectRoot, ".ratel", "missions", "mis_00000001"));
    assert.strictEqual(dirB, join(projectRoot, ".ratel", "missions", "mis_00000002"));
    assert.notStrictEqual(dirA, dirB);

    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    await writeFile(join(dirA, "state.json"), JSON.stringify({ phase: "intake", version: 1, updatedAt: "2024-01-01T00:00:00Z" }));
    await writeFile(join(dirB, "state.json"), JSON.stringify({ phase: "execution", version: 2, updatedAt: "2024-01-02T00:00:00Z" }));

    const stateA = JSON.parse(await readFile(join(dirA, "state.json"), "utf-8"));
    const stateB = JSON.parse(await readFile(join(dirB, "state.json"), "utf-8"));

    assert.strictEqual(stateA.phase, "intake");
    assert.strictEqual(stateB.phase, "execution");

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("writing one mission does not alter the other", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-scope-"));
    const scopeA = createMissionScope(projectRoot, "mis_00000003");
    const scopeB = createMissionScope(projectRoot, "mis_00000004");

    const dirA = getMissionDir(scopeA);
    const dirB = getMissionDir(scopeB);

    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    await atomicWriteJson(join(dirA, "features.json"), { features: [{ id: "F1", title: "A", description: "", assertions: [], milestoneId: "M1", status: "pending" }] });

    const featuresB = await readJsonFile(join(dirB, "features.json"));
    assert.strictEqual(featuresB, undefined);

    const featuresA = await readJsonFile<{ features: unknown[] }>(join(dirA, "features.json"));
    assert.strictEqual(featuresA?.features.length, 1);

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("rejects mission IDs with slash", () => {
    assert.throws(() => assertValidMissionId("mis_0000000/1"), /Invalid missionId/);
  });

  it("rejects mission IDs with backslash", () => {
    assert.throws(() => assertValidMissionId("mis_0000000\\1"), /Invalid missionId/);
  });

  it("rejects mission IDs with dot-dot", () => {
    assert.throws(() => assertValidMissionId("mis_0000000..1"), /Invalid missionId/);
  });

  it("rejects mission IDs with whitespace", () => {
    assert.throws(() => assertValidMissionId("mis_0000000 1"), /Invalid missionId/);
  });

  it("rejects mission IDs with shell chars", () => {
    assert.throws(() => assertValidMissionId("mis_0000000;1"), /Invalid missionId/);
    assert.throws(() => assertValidMissionId("mis_0000000|1"), /Invalid missionId/);
    assert.throws(() => assertValidMissionId("mis_0000000&1"), /Invalid missionId/);
    assert.throws(() => assertValidMissionId("mis_0000000$1"), /Invalid missionId/);
  });

  it("accepts valid mission IDs", () => {
    assert.doesNotThrow(() => assertValidMissionId("mis_00000001"));
    assert.doesNotThrow(() => assertValidMissionId("mis_ABCDEFGH"));
    assert.doesNotThrow(() => assertValidMissionId("mis_abcdefghijklmnopqrstuvwxyz0123456789_"));
  });

  it("getMissionRelativeDir returns relative path", () => {
    const scope = createMissionScope("/project", "mis_00000001");
    assert.strictEqual(getMissionRelativeDir(scope), join(".ratel", "missions", "mis_00000001"));
  });

  it("getRatelDir returns absolute path", () => {
    assert.strictEqual(getRatelDir("/project"), join("/project", ".ratel"));
  });
});
