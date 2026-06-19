/**
 * Tests for the service-mode progress detector.
 *
 * Covers:
 * - hasDurableProgress / isDurableProgressEvent: correctly identifies durable
 *   progress vs lifecycle/telemetry/read-only activity.
 * - filterProgressEvents: filters to only durable progress events.
 * - NoMissionProgressError: typed error with code and retryable flag.
 *
 * Key regression: a continuation job that only called `load_mission_state`
 * (producing session_tool_start/end and tool_call/tool_result) must NOT be
 * considered durable progress.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasDurableProgress,
  filterProgressEvents,
  isDurableProgressEvent,
  NoMissionProgressError,
} from "../src/control-plane/progress-detector.js";
import type { RatelEvent } from "../src/core/observability/event-logger.js";

function makeEvent(eventType: string, data: Record<string, unknown> = {}): RatelEvent {
  return {
    timestamp: new Date().toISOString(),
    event_type: eventType as RatelEvent["event_type"],
    trace_id: "trace-1",
    span_id: "span-1",
    data,
  };
}

describe("hasDurableProgress — always-durable event types", () => {
  it("returns true when artifact_write event is present", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("artifact_write", { artifactName: "requirements.json" }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), true);
  });

  it("returns true when phase_transition event is present", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("phase_transition", { from: "intake", to: "discovery" }),
    ];
    assert.equal(hasDurableProgress(events), true);
  });

  it("returns true when halt event is present", () => {
    const events = [makeEvent("halt", { reason: "budget" })];
    assert.equal(hasDurableProgress(events), true);
  });

  it("returns true when assistant_message event is present", () => {
    const events = [
      makeEvent("assistant_message", {
        role: "orchestrator",
        text: "Hello",
        preview: "Hello",
      }),
    ];
    assert.equal(hasDurableProgress(events), true);
  });

  it("returns true when decision_logged event is present", () => {
    const events = [makeEvent("decision_logged", { decisionId: "DEC-1" })];
    assert.equal(hasDurableProgress(events), true);
  });
});

describe("hasDurableProgress — durable mutating tool events", () => {
  for (const toolName of [
    "run_worker",
    "run_validation",
    "run_user_testing",
    "write_mission_artifact",
    "write_feature_file",
    "draft_validation_contract",
    "halt_mission",
    "wait_for_user_approval",
    "mark_feature_integrated",
    "mark_milestone_validated",
    "mark_mission_completed",
    "ensure_skills_installed",
  ]) {
    it(`returns true for tool_call of ${toolName}`, () => {
      const events = [
        makeEvent("agent_start"),
        makeEvent("tool_call", { toolName }),
        makeEvent("tool_result", { toolName }),
        makeEvent("agent_end"),
      ];
      assert.equal(hasDurableProgress(events), true);
    });

    it(`returns true for session_tool_start of ${toolName}`, () => {
      const events = [makeEvent("session_tool_start", { toolName })];
      assert.equal(hasDurableProgress(events), true);
    });

    it(`returns true for session_tool_end of ${toolName}`, () => {
      const events = [makeEvent("session_tool_end", { toolName })];
      assert.equal(hasDurableProgress(events), true);
    });
  }
});

describe("hasDurableProgress — read-only / non-durable tool events", () => {
  for (const toolName of [
    "load_mission_state",
    "list_models",
    "get_feature_complexity",
    "ping_agents",
  ]) {
    it(`returns false for tool_call/tool_result of ${toolName}`, () => {
      const events = [
        makeEvent("agent_start"),
        makeEvent("tool_call", { toolName }),
        makeEvent("tool_result", { toolName }),
        makeEvent("agent_end"),
      ];
      assert.equal(hasDurableProgress(events), false);
    });

    it(`returns false for session_tool_start/end of ${toolName}`, () => {
      const events = [
        makeEvent("session_tool_start", { toolName }),
        makeEvent("session_tool_end", { toolName }),
      ];
      assert.equal(hasDurableProgress(events), false);
    });
  }

  it("returns false for tool events with unknown toolName (conservative)", () => {
    const events = [
      makeEvent("tool_call", { toolName: "some_random_unknown_tool" }),
      makeEvent("tool_result", { toolName: "some_random_unknown_tool" }),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false for tool events missing a toolName (conservative)", () => {
    const events = [
      makeEvent("session_tool_start", {}),
      makeEvent("session_tool_end", {}),
    ];
    assert.equal(hasDurableProgress(events), false);
  });
});

describe("hasDurableProgress — lifecycle / telemetry events are NOT durable", () => {
  it("returns false when only agent_start and agent_end are present", () => {
    const events = [makeEvent("agent_start"), makeEvent("agent_end")];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only mission_initialized is present", () => {
    const events = [makeEvent("mission_initialized")];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only state_loaded is present", () => {
    const events = [makeEvent("state_loaded", { phase: "intake" })];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only ping is present", () => {
    const events = [makeEvent("ping", { agentName: "worker" })];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only session_agent_event (lifecycle) is present", () => {
    const events = [
      makeEvent("session_agent_event", { sessionEventType: "agent_start" }),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only budget_usage is present", () => {
    const events = [makeEvent("budget_usage", { costUsd: 0.01 })];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only budget_exceeded is present", () => {
    const events = [makeEvent("budget_exceeded", { reason: "limit" })];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only validation_recovery is present", () => {
    const events = [
      makeEvent("validation_recovery", { milestoneId: "M1", blockingIssueIds: [] }),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false when only integration_preflight is present", () => {
    const events = [
      makeEvent("integration_preflight", { milestoneId: "M1", status: "ok" }),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false for empty events array", () => {
    assert.equal(hasDurableProgress([]), false);
  });

  it("returns false when only non-progress lifecycle events are present", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("state_loaded"),
      makeEvent("mission_initialized"),
      makeEvent("budget_usage"),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), false);
  });
});

describe("hasDurableProgress — regression: load_mission_state-only turn", () => {
  // This is the verified bug: a continuation job that only called
  // load_mission_state produced session_tool_start/end + tool_call/tool_result
  // and was incorrectly considered durable progress.
  it("returns false for a load_mission_state-only turn with agent_start/end", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "load_mission_state" }),
      makeEvent("session_tool_start", { toolName: "load_mission_state" }),
      makeEvent("session_tool_end", { toolName: "load_mission_state" }),
      makeEvent("tool_result", { toolName: "load_mission_state" }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns false for load_mission_state + ping_agents read-only combo", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "load_mission_state" }),
      makeEvent("tool_result", { toolName: "load_mission_state" }),
      makeEvent("tool_call", { toolName: "ping_agents" }),
      makeEvent("tool_result", { toolName: "ping_agents" }),
      makeEvent("tool_call", { toolName: "get_feature_complexity" }),
      makeEvent("tool_result", { toolName: "get_feature_complexity" }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns true when a read-only turn also enqueued run_worker", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "load_mission_state" }),
      makeEvent("tool_result", { toolName: "load_mission_state" }),
      makeEvent("tool_call", { toolName: "run_worker", featureId: "F1" }),
      makeEvent("tool_result", { toolName: "run_worker" }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), true);
  });
});

describe("hasDurableProgress — pending_question (service-mode intake bridge)", () => {
  it("returns true when a pending_question event is present", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("pending_question", {
        questionId: "q_1",
        question: "Pick a flavor",
        options: ["vanilla", "chocolate"],
        questionType: "choice",
      }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), true);
  });

  it("returns true for a lone pending_question event (no lifecycle around it)", () => {
    const events = [
      makeEvent("pending_question", { questionId: "q_1", question: "Continue?" }),
    ];
    assert.equal(hasDurableProgress(events), true);
  });
});

describe("hasDurableProgress — ask_user tool events are NOT durable alone", () => {
  for (const toolName of ["ask_user"]) {
    it(`returns false for tool_call/tool_result of ${toolName} alone`, () => {
      const events = [
        makeEvent("agent_start"),
        makeEvent("tool_call", { toolName }),
        makeEvent("tool_result", { toolName }),
        makeEvent("agent_end"),
      ];
      assert.equal(hasDurableProgress(events), false);
    });

    it(`returns false for session_tool_start/end of ${toolName} alone`, () => {
      const events = [
        makeEvent("session_tool_start", { toolName }),
        makeEvent("session_tool_end", { toolName }),
      ];
      assert.equal(hasDurableProgress(events), false);
    });
  }

  it("returns false when only ask_user tool events (all four shapes) are present", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "ask_user" }),
      makeEvent("session_tool_start", { toolName: "ask_user" }),
      makeEvent("session_tool_end", { toolName: "ask_user" }),
      makeEvent("tool_result", { toolName: "ask_user" }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), false);
  });

  it("returns true when ask_user tool events are accompanied by a pending_question event", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "ask_user" }),
      makeEvent("session_tool_start", { toolName: "ask_user" }),
      makeEvent("pending_question", {
        questionId: "q_1",
        question: "Continue?",
        questionType: "yes_no",
      }),
      makeEvent("session_tool_end", { toolName: "ask_user" }),
      makeEvent("tool_result", { toolName: "ask_user" }),
      makeEvent("agent_end"),
    ];
    assert.equal(hasDurableProgress(events), true);
  });
});

describe("isDurableProgressEvent", () => {
  it("returns true for artifact_write", () => {
    assert.equal(isDurableProgressEvent(makeEvent("artifact_write")), true);
  });

  it("returns false for budget_usage", () => {
    assert.equal(isDurableProgressEvent(makeEvent("budget_usage")), false);
  });

  it("returns false for session_tool_start of load_mission_state", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("session_tool_start", { toolName: "load_mission_state" }),
      ),
      false,
    );
  });

  it("returns true for session_tool_start of run_worker", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("session_tool_start", { toolName: "run_worker" }),
      ),
      true,
    );
  });

  it("returns true for a pending_question event", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("pending_question", { questionId: "q_1", question: "Pick" }),
      ),
      true,
    );
  });

  it("returns false for tool_call of ask_user (alone, not durable)", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("tool_call", { toolName: "ask_user" }),
      ),
      false,
    );
  });

  it("returns false for tool_result of ask_user (alone, not durable)", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("tool_result", { toolName: "ask_user" }),
      ),
      false,
    );
  });

  it("returns false for session_tool_start of ask_user (alone, not durable)", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("session_tool_start", { toolName: "ask_user" }),
      ),
      false,
    );
  });

  it("returns false for session_tool_end of ask_user (alone, not durable)", () => {
    assert.equal(
      isDurableProgressEvent(
        makeEvent("session_tool_end", { toolName: "ask_user" }),
      ),
      false,
    );
  });
});

describe("filterProgressEvents", () => {
  it("filters out non-progress and read-only tool events, keeps durable ones", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "load_mission_state" }),
      makeEvent("tool_result", { toolName: "load_mission_state" }),
      makeEvent("artifact_write", { artifactName: "requirements.json" }),
      makeEvent("state_loaded"),
      makeEvent("phase_transition", { from: "intake", to: "discovery" }),
      makeEvent("session_tool_start", { toolName: "ping_agents" }),
      makeEvent("budget_usage", { costUsd: 0.01 }),
      makeEvent("agent_end"),
    ];
    const filtered = filterProgressEvents(events);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].event_type, "artifact_write");
    assert.equal(filtered[1].event_type, "phase_transition");
  });

  it("keeps durable tool events and drops read-only tool events", () => {
    const events = [
      makeEvent("tool_call", { toolName: "load_mission_state" }),
      makeEvent("tool_call", { toolName: "run_worker" }),
      makeEvent("session_tool_start", { toolName: "get_feature_complexity" }),
      makeEvent("session_tool_start", { toolName: "halt_mission" }),
    ];
    const filtered = filterProgressEvents(events);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].data.toolName, "run_worker");
    assert.equal(filtered[1].data.toolName, "halt_mission");
  });

  it("returns empty array when no durable progress events", () => {
    const events = [
      makeEvent("agent_start"),
      makeEvent("tool_call", { toolName: "load_mission_state" }),
      makeEvent("budget_usage"),
      makeEvent("agent_end"),
    ];
    const filtered = filterProgressEvents(events);
    assert.equal(filtered.length, 0);
  });
});

describe("NoMissionProgressError", () => {
  it("has code no_mission_progress", () => {
    const err = new NoMissionProgressError();
    assert.equal(err.code, "no_mission_progress");
  });

  it("is retryable", () => {
    const err = new NoMissionProgressError();
    assert.equal(err.retryable, true);
  });

  it("includes eventsSeen count as a property", () => {
    const err = new NoMissionProgressError("test", 42);
    assert.equal(err.eventsSeen, 42);
  });

  it("default message is informative when eventsSeen is provided", () => {
    const err = new NoMissionProgressError(undefined, 5);
    assert.equal(err.eventsSeen, 5);
    assert.ok(err.message.length > 0);
    assert.ok(err.message.toLowerCase().includes("progress"));
  });

  it("is an instance of Error", () => {
    const err = new NoMissionProgressError();
    assert.ok(err instanceof Error);
  });

  it("has name NoMissionProgressError", () => {
    const err = new NoMissionProgressError();
    assert.equal(err.name, "NoMissionProgressError");
  });
});
