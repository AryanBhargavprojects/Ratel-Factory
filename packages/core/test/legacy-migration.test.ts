import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLegacyMigration } from "../src/control-plane/legacy-migration.js";

describe("legacy migration", () => {
  it("copies legacy .missions/current to .ratel/missions/<id> when migration-v1.json missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-migrate-"));
    const legacyDir = join(projectRoot, ".missions", "current");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "state.json"),
      JSON.stringify({ phase: "execution", version: 3, updatedAt: "2024-01-01T00:00:00Z", traceId: "mis_abc12345" }),
    );
    await writeFile(join(legacyDir, "requirements.json"), JSON.stringify({ goal: "test", productIntent: "test", nonGoals: [], riskTolerance: "low" }));

    const result = await runLegacyMigration(projectRoot);
    assert.strictEqual(result.migrated, true);
    assert.strictEqual(result.missionId, "mis_abc12345");

    const newState = await readFile(join(projectRoot, ".ratel", "missions", "mis_abc12345", "state.json"), "utf-8");
    assert.deepStrictEqual(JSON.parse(newState).phase, "execution");

    const requirements = await readFile(join(projectRoot, ".ratel", "missions", "mis_abc12345", "requirements.json"), "utf-8");
    assert.deepStrictEqual(JSON.parse(requirements).goal, "test");

    const migrationRecord = await readFile(join(projectRoot, ".ratel", "migration-v1.json"), "utf-8");
    assert.strictEqual(JSON.parse(migrationRecord).migrated, true);

    const currentMission = await readFile(join(projectRoot, ".ratel", "current-mission.json"), "utf-8");
    assert.strictEqual(JSON.parse(currentMission).missionId, "mis_abc12345");

    // Legacy dir must still exist
    await access(join(projectRoot, ".missions", "current"));

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("is idempotent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-migrate-"));
    const legacyDir = join(projectRoot, ".missions", "current");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "state.json"),
      JSON.stringify({ phase: "execution", version: 1, updatedAt: "2024-01-01T00:00:00Z", traceId: "mis_idempotent" }),
    );

    const r1 = await runLegacyMigration(projectRoot);
    assert.strictEqual(r1.migrated, true);

    const r2 = await runLegacyMigration(projectRoot);
    assert.strictEqual(r2.migrated, false);
    assert.strictEqual(r2.missionId, "mis_idempotent");

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("generates a mission ID when traceId is missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-migrate-"));
    const legacyDir = join(projectRoot, ".missions", "current");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "state.json"),
      JSON.stringify({ phase: "intake", version: 1, updatedAt: "2024-01-01T00:00:00Z" }),
    );

    const result = await runLegacyMigration(projectRoot);
    assert.strictEqual(result.migrated, true);
    assert.ok(result.missionId.startsWith("mis_"));
    assert.ok(result.missionId.length >= 12);

    await rm(projectRoot, { recursive: true, force: true });
  });

  it("does nothing when .missions/current does not exist", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-migrate-"));
    const result = await runLegacyMigration(projectRoot);
    assert.strictEqual(result.migrated, false);
    assert.strictEqual(result.missionId, undefined);
    await rm(projectRoot, { recursive: true, force: true });
  });
});
