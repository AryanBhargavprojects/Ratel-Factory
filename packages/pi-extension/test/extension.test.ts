/**
 * Tests for extension registration against a mock Pi ExtensionAPI.
 *
 * Verifies that the factory registers the expected commands, tools, and
 * lifecycle hooks without performing any real service work. Service autostart
 * is disabled via env so session_start does not spawn processes.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

interface MockTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface MockCommand {
  name: string;
  description?: string;
  handler: (...args: unknown[]) => Promise<void>;
}

interface MockHandler {
  event: string;
  fn: (...args: unknown[]) => unknown;
}

function createMockPi() {
  const tools = new Map<string, MockTool>();
  const commands = new Map<string, MockCommand>();
  const handlers: MockHandler[] = [];

  const pi: any = {
    registerTool(tool: MockTool) { tools.set(tool.name, tool); },
    registerCommand(name: string, options: { description?: string; handler: (...a: unknown[]) => Promise<void> }) {
      commands.set(name, { name, description: options.description, handler: options.handler });
    },
    on(event: string, fn: (...a: unknown[]) => unknown) { handlers.push({ event, fn }); },
    appendEntry() {},
    sendMessage() {},
    // Helpers exposed for assertions
    _tools: tools,
    _commands: commands,
    _handlers: handlers,
  };
  return pi;
}

function makeMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/ratel-pi-mock-project",
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
    },
    sessionManager: { getEntries: () => [] },
    ...overrides,
  } as any;
}

const EXPECTED_TOOLS = [
  "ratel_start_mission",
  "ratel_get_status",
  "ratel_poll_status",
  "ratel_approve_plan",
  "ratel_reply_to_factory",
  "ratel_answer_question",
  "ratel_run_feature_worker",
  "ratel_run_validation",
  "ratel_ping_agents",
  // compatibility aliases
  "ratel_approve_mission",
  "ratel_send_message",
  "ratel_run_worker",
  "ratel_run_validator",
];

const EXPECTED_COMMANDS = [
  "ratel",
  "ratel-start",
  "ratel-status",
  "ratel-approve",
  "ratel-mission",
  "ratel-observatory",
];

describe("RatelExtension — registration", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.RATEL_PI_DISABLE_SERVICE_AUTOSTART;
    process.env.RATEL_PI_DISABLE_SERVICE_AUTOSTART = "1";
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RATEL_PI_DISABLE_SERVICE_AUTOSTART;
    else process.env.RATEL_PI_DISABLE_SERVICE_AUTOSTART = originalEnv;
  });

  it("registers all expected tools with Pi-style metadata", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    for (const name of EXPECTED_TOOLS) {
      const tool = pi._tools.get(name);
      assert.ok(tool, `tool ${name} must be registered`);
      assert.equal(typeof tool.label, "string");
      assert.ok(tool.label.length > 0);
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0);
      assert.equal(typeof tool.parameters, "object");
      assert.equal(typeof tool.execute, "function");
      // Descriptions must present Pi extension tools, not OpenCode tools.
      assert.ok(
        !/opencode/i.test(tool.description),
        `${name} description must not reference OpenCode`,
      );
    }
  });

  it("registers all expected commands", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    for (const name of EXPECTED_COMMANDS) {
      const cmd = pi._commands.get(name);
      assert.ok(cmd, `command ${name} must be registered`);
      assert.equal(typeof cmd.description, "string");
      assert.equal(typeof cmd.handler, "function");
    }
  });

  it("registers session_start, before_agent_start, tool_call, session_shutdown hooks", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const events = pi._handlers.map((h: MockHandler) => h.event);
    assert.ok(events.includes("session_start"));
    assert.ok(events.includes("before_agent_start"));
    assert.ok(events.includes("tool_call"));
    assert.ok(events.includes("session_shutdown"));
  });

  it("tools return a service-unavailable message when no service is connected", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const startTool = pi._tools.get("ratel_start_mission");
    const result = await startTool!.execute("callId", { goal: "g" }, undefined, undefined, makeMockCtx());
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(text, /not available/i);
  });

  it("ratel_poll_status short-circuits with service-unavailable when no service is connected", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const poll = pi._tools.get("ratel_poll_status");
    const result = await poll!.execute("callId", {}, undefined, undefined, makeMockCtx());
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(text, /not available/i);
  });

  it("session_start does not throw with a mock ctx and autostart disabled", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const startHandler = pi._handlers.find((h: MockHandler) => h.event === "session_start")!;
    await startHandler.fn({ reason: "startup" }, makeMockCtx());
    // No assertion needed — reaching here without throwing is the contract.
  });
});

describe("prompts — Pi-native and no legacy .missions/current", () => {
  it("factory mode prompt references .ratel/missions/<missionId>/ and Pi extension", async () => {
    const { getFactoryModePrompt } = await import("../src/prompts.js");
    const p = getFactoryModePrompt();
    assert.ok(p.includes(".ratel/missions/<missionId>/"), "must reference durable .ratel state");
    assert.ok(!p.includes(".missions/current/"), "must not reference legacy .missions/current");
    assert.ok(p.includes("ratel_poll_status"));
    assert.ok(p.includes("ratel_approve_plan"));
    assert.ok(p.includes("ratel_reply_to_factory"));
    assert.ok(p.includes("ratel_answer_question"));
    assert.ok(p.toLowerCase().includes("pi extension") || p.toLowerCase().includes("pi-native"));
  });
});
