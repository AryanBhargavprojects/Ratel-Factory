/**
 * Tests for polling helpers: clampTiming, parseStopWhen, detectStopCondition,
 * formatPollResponse.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("clampTiming", () => {
  it("defaults to 10s / 300s", async () => {
    const { clampTiming } = await import("../src/polling.js");
    const r = clampTiming(undefined, undefined);
    assert.equal(r.intervalSeconds, 10);
    assert.equal(r.timeoutSeconds, 300);
  });

  it("clamps interval to [1,60] and timeout to [1,300]", async () => {
    const { clampTiming } = await import("../src/polling.js");
    assert.deepEqual(clampTiming(0, 0), { intervalSeconds: 1, timeoutSeconds: 1 });
    assert.deepEqual(clampTiming(999, 9999), { intervalSeconds: 60, timeoutSeconds: 300 });
  });

  it("rounds fractional values", async () => {
    const { clampTiming } = await import("../src/polling.js");
    assert.deepEqual(clampTiming(2.7, 299.1), { intervalSeconds: 3, timeoutSeconds: 299 });
  });
});

describe("parseStopWhen", () => {
  it("defaults to orchestrator_question,mission_complete,halted", async () => {
    const { parseStopWhen } = await import("../src/polling.js");
    assert.deepEqual(parseStopWhen(undefined), ["orchestrator_question", "mission_complete", "halted"]);
  });

  it("filters unknown values", async () => {
    const { parseStopWhen } = await import("../src/polling.js");
    assert.deepEqual(parseStopWhen("phase_change, bogus, halted"), ["phase_change", "halted"]);
  });
});

describe("detectStopCondition", () => {
  it("detects pending_question as orchestrator_question with details", async () => {
    const { detectStopCondition } = await import("../src/polling.js");
    const events = [
      { event_type: "pending_question", trace_id: "t", span_id: "s", timestamp: "", data: { questionId: "q1", question: "Pick?", options: ["a", "b"], questionType: "choice" } },
    ];
    const r = detectStopCondition(events, "active", ["orchestrator_question"]);
    assert.equal(r.stopped, true);
    assert.equal(r.stopReason, "orchestrator_question");
    assert.equal(r.approvalNeeded, true);
    assert.equal(r.pendingQuestion?.questionId, "q1");
    assert.deepEqual(r.pendingQuestion?.options, ["a", "b"]);
  });

  it("detects mission_complete from status", async () => {
    const { detectStopCondition } = await import("../src/polling.js");
    const r = detectStopCondition([], "completed", ["mission_complete"]);
    assert.equal(r.stopped, true);
    assert.equal(r.stopReason, "mission_complete");
  });

  it("detects halted from status cancelled", async () => {
    const { detectStopCondition } = await import("../src/polling.js");
    const r = detectStopCondition([], "cancelled", ["halted"]);
    assert.equal(r.stopped, true);
    assert.equal(r.stopReason, "halted");
  });

  it("does not stop when nothing matches", async () => {
    const { detectStopCondition } = await import("../src/polling.js");
    const r = detectStopCondition([{ event_type: "tool_call", trace_id: "t", span_id: "s", timestamp: "", data: {} }], "active", ["orchestrator_question"]);
    assert.equal(r.stopped, false);
  });
});

describe("formatPollResponse", () => {
  it("produces a compact response without raw events array", async () => {
    const { formatPollResponse } = await import("../src/polling.js");
    const out = formatPollResponse({
      missionId: "m1",
      stopReason: "orchestrator_question",
      approvalNeeded: true,
      latestStatus: "waiting_for_approval",
      eventsSeen: 3,
      lastOffset: 3,
      matchedEvents: [{ event_type: "phase_transition", trace_id: "t", span_id: "s", timestamp: "x", data: { to: "user_approval" } }],
      elapsedSeconds: 12,
      intervalSeconds: 10,
      timeoutSeconds: 300,
      pendingQuestion: { questionId: "q1", question: "ok?" },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.missionId, "m1");
    assert.equal(parsed.stopReason, "orchestrator_question");
    assert.equal(parsed.nextAfter, 3);
    assert.equal(parsed.events, undefined); // no raw dump
    assert.equal(parsed.pendingQuestion.questionId, "q1");
  });
});
