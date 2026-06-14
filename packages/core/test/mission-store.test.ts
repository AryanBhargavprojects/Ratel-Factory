import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionStore } from "../src/control-plane/mission-store.js";

describe("mission store", () => {
  let projectRoot: string;
  let store: MissionStore;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-mission-"));
    store = new MissionStore(projectRoot);
    await store.initialize();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("create and reload a mission", async () => {
    const { mission, created } = await store.createMission({ goal: "Build a durable store" });
    assert.strictEqual(created, true);
    assert.ok(mission.missionId.startsWith("mis_"));
    assert.strictEqual(mission.goal, "Build a durable store");
    assert.strictEqual(mission.status, "active");

    const reloaded = await store.getMission(mission.missionId);
    assert.deepStrictEqual(reloaded, mission);
  });

  it("list missions in deterministic creation order", async () => {
    const { mission: m1 } = await store.createMission({ goal: "First mission" });
    const { mission: m2 } = await store.createMission({ goal: "Second mission" });
    const list = await store.listMissions();
    const ids = list.map((m) => m.missionId);
    assert.deepStrictEqual(ids, [m1.missionId, m2.missionId]);
  });

  it("idempotency key returns original mission", async () => {
    const key = "idem-001";
    const { mission: first, created: c1 } = await store.createMission({ goal: "Idempotent mission", idempotencyKey: key });
    assert.strictEqual(c1, true);

    const { mission: second, created: c2 } = await store.createMission({ goal: "Different goal", idempotencyKey: key });
    assert.strictEqual(c2, false);
    assert.strictEqual(second.missionId, first.missionId);
    assert.strictEqual(second.goal, "Idempotent mission");
  });

  it("reject empty goals", async () => {
    await assert.rejects(
      () => store.createMission({ goal: "" }),
      /goal must be a non-empty string/
    );
  });

  it("updateMission modifies and persists", async () => {
    const { mission } = await store.createMission({ goal: "Update test" });
    const updated = await store.updateMission(mission.missionId, (m) => ({
      ...m,
      status: "completed" as const,
      updatedAt: new Date().toISOString(),
    }));
    assert.strictEqual(updated.status, "completed");

    const reloaded = await store.getMission(mission.missionId);
    assert.strictEqual(reloaded?.status, "completed");
  });

  it("getCurrentMissionId and setCurrentMissionId", async () => {
    const { mission } = await store.createMission({ goal: "Current mission" });
    assert.strictEqual(await store.getCurrentMissionId(), undefined);
    await store.setCurrentMissionId(mission.missionId);
    assert.strictEqual(await store.getCurrentMissionId(), mission.missionId);
  });
});
