/**
 * Tests for the in-process RatelRuntime.
 *
 * Uses a fake OrchestratorAgent factory and a real temp project root so the
 * disk-backed mission scope/event helpers are exercised without spawning any
 * real agent session or HTTP service.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RatelRuntime, type OrchestratorFactory } from "../src/runtime.js";

/** Minimal fake orchestrator that records prompt/init/dispose calls. */
function createFakeOrchestratorFactory(calls: {
  initCalls: number;
  promptCalls: string[];
  disposed: boolean;
}): OrchestratorFactory {
  return () => {
    const fake = {
      init: async () => {
        calls.initCalls += 1;
      },
      prompt: async (text: string) => {
        calls.promptCalls.push(text);
      },
      subscribe: () => () => undefined,
      getSession: () => {
        throw new Error("not used");
      },
      dispose: () => {
        calls.disposed = true;
      },
    };
    return fake as unknown as import("@ratel-factory/core").OrchestratorAgent;
  };
}

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ratel-runtime-test-"));
  mkdirSync(join(dir, ".ratel"), { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function appendEvent(dir: string, missionId: string, event: Record<string, unknown>): void {
  const missionDir = join(dir, ".ratel", "missions", missionId);
  mkdirSync(missionDir, { recursive: true });
  const path = join(missionDir, "events.jsonl");
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    trace_id: "t",
    span_id: "s",
    ...event,
  });
  writeFileSync(path, line + "\n", { flag: "a" });
}

function writeState(dir: string, missionId: string, phase: string): void {
  const missionDir = join(dir, ".ratel", "missions", missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(
    join(missionDir, "state.json"),
    JSON.stringify({ phase, version: 1, updatedAt: new Date().toISOString() }),
    "utf-8",
  );
}

describe("RatelRuntime — in-process (no HTTP)", () => {
  let dir: string;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { cleanup(dir); });

  it("startMission creates a mission id, persists current-mission.json, and prompts the orchestrator", async () => {
    const calls = { initCalls: 0, promptCalls: [] as string[], disposed: false };
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory(calls),
      startObservatoryFn: async () => null,
    });
    try {
      const result = await runtime.startMission("build a thing");
      assert.equal(result.status, "started");
      assert.ok(result.missionId.startsWith("mis_"));
      assert.equal(calls.initCalls, 1, "orchestrator must be initialised once");
      assert.equal(calls.promptCalls.length, 1, "must run one prompt");
      assert.match(calls.promptCalls[0], /build a thing/);

      const current = await import("node:fs/promises").then((m) =>
        m.readFile(join(dir, ".ratel", "current-mission.json"), "utf-8"),
      );
      assert.ok(current.includes(result.missionId), "current-mission.json must record the id");
    } finally {
      await runtime.dispose();
    }
  });

  it("getStatus reports no active mission when none has been started", async () => {
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory({ initCalls: 0, promptCalls: [], disposed: false }),
      startObservatoryFn: async () => null,
    });
    try {
      const status = await runtime.getStatus();
      assert.equal(status.active, false);
      assert.match(status.message ?? "", /No active mission/i);
    } finally {
      await runtime.dispose();
    }
  });

  it("getStatus reads local state.json after a mission is started", async () => {
    const calls = { initCalls: 0, promptCalls: [] as string[], disposed: false };
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory(calls),
      startObservatoryFn: async () => null,
    });
    try {
      const result = await runtime.startMission("goal");
      writeState(dir, result.missionId, "user_approval");
      const status = await runtime.getStatus();
      assert.equal(status.active, true);
      assert.equal(status.status, "waiting_for_approval");
      assert.equal(status.phase, "user_approval");
      assert.equal(status.missionId, result.missionId);
    } finally {
      await runtime.dispose();
    }
  });

  it("pollStatus returns a compact no-mission result when no mission is active", async () => {
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory({ initCalls: 0, promptCalls: [], disposed: false }),
      startObservatoryFn: async () => null,
    });
    try {
      const text = await runtime.pollStatus({ timeoutSeconds: 1, intervalSeconds: 1 });
      const parsed = JSON.parse(text);
      assert.equal(parsed.active, false);
      assert.equal(parsed.stopReason, "no_mission");
      assert.ok(!/ratel --serve/i.test(text));
    } finally {
      await runtime.dispose();
    }
  });

  it("pollStatus detects a pending_question stop condition from local events.jsonl", async () => {
    const calls = { initCalls: 0, promptCalls: [] as string[], disposed: false };
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory(calls),
      startObservatoryFn: async () => null,
    });
    try {
      const result = await runtime.startMission("goal");
      writeState(dir, result.missionId, "clarification");
      appendEvent(dir, result.missionId, {
        event_type: "pending_question",
        data: { questionId: "q1", question: "Pick?", options: ["a", "b"], questionType: "choice" },
      });

      const text = await runtime.pollStatus({
        timeoutSeconds: 3,
        intervalSeconds: 1,
        stopWhen: "orchestrator_question,mission_complete,halted",
      });
      const parsed = JSON.parse(text);
      assert.equal(parsed.stopReason, "orchestrator_question");
      assert.equal(parsed.approvalNeeded, true);
      assert.equal(parsed.pendingQuestion.questionId, "q1");
      assert.deepEqual(parsed.pendingQuestion.options, ["a", "b"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("replyToFactory / answerQuestion / approvePlan / runFeatureWorker / runValidation prompt the orchestrator (serialized)", async () => {
    const calls = { initCalls: 0, promptCalls: [] as string[], disposed: false };
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory(calls),
      startObservatoryFn: async () => null,
    });
    try {
      await runtime.startMission("goal");
      calls.promptCalls.length = 0; // reset after start

      await runtime.replyToFactory("hello there", "q_1");
      await runtime.answerQuestion("q_1", "yes");
      await runtime.approvePlan(true, "looks good");
      await runtime.runFeatureWorker("FEAT-001");
      await runtime.runValidation("MS-1");

      assert.equal(calls.promptCalls.length, 5);
      assert.match(calls.promptCalls[0], /hello there/);
      assert.match(calls.promptCalls[1], /yes/);
      assert.match(calls.promptCalls[2], /APPROVED/);
      assert.match(calls.promptCalls[2], /looks good/);
      assert.match(calls.promptCalls[3], /FEAT-001/);
      assert.match(calls.promptCalls[4], /MS-1/);
    } finally {
      await runtime.dispose();
    }
  });

  it("pingAgents reports local in-process availability with no HTTP/service language", async () => {
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory({ initCalls: 0, promptCalls: [], disposed: false }),
      startObservatoryFn: async () => null,
    });
    try {
      const result = await runtime.pingAgents();
      assert.equal(result.ok, true);
      assert.ok(result.totalAgents > 0);
      assert.equal(result.failedCount, 0);
    } finally {
      await runtime.dispose();
    }
  });

  it("getObservatoryInfo returns the local mission dir when the dashboard is not running", async () => {
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory({ initCalls: 0, promptCalls: [], disposed: false }),
      startObservatoryFn: async () => null,
    });
    try {
      const result = await runtime.startMission("goal");
      const info = await runtime.getObservatoryInfo();
      assert.equal(info.enabled, false);
      assert.ok(info.missionDir?.includes(result.missionId));
      assert.ok(info.message?.includes(".ratel/missions"));
    } finally {
      await runtime.dispose();
    }
  });

  it("getObservatoryInfo returns the dashboard url when one is started in-process", async () => {
    const runtime = new RatelRuntime({
      projectRoot: dir,
      createOrchestrator: createFakeOrchestratorFactory({ initCalls: 0, promptCalls: [], disposed: false }),
      startObservatoryFn: async () => ({
        enabled: true,
        url: "http://localhost:9999",
        shutdown: async () => undefined,
      }) as unknown as import("@ratel-factory/core").ObservatoryHandle,
    });
    try {
      const info = await runtime.getObservatoryInfo();
      assert.equal(info.enabled, true);
      assert.equal(info.url, "http://localhost:9999");
    } finally {
      await runtime.dispose();
    }
  });
});
