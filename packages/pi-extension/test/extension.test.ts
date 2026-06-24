/**
 * Tests for extension registration against a mock Pi ExtensionAPI.
 *
 * Verifies that the factory registers the expected commands, tools, and
 * lifecycle hooks without performing any real orchestrator work, and that no
 * user-facing tool/registration text references the old HTTP-service design
 * (`ratel --serve`, HTTP service, service unavailable, etc.).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const EXPECTED_HOOKS = ["session_start", "before_agent_start", "session_shutdown"];

// Phrases that must NOT appear in any user-facing tool description/guideline
// or command description now that the extension is in-process.
const FORBIDDEN_PHRASES = [
  /ratel --serve/i,
  /HTTP service/i,
  /Ratel service is not available/i,
  /service unavailable/i,
  /RatelServiceClient/i,
  /portfile/i,
  /connect to the Ratel service/i,
];

describe("RatelExtension — registration", () => {
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

  it("registers session_start, before_agent_start, session_shutdown hooks", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const events = pi._handlers.map((h: MockHandler) => h.event);
    for (const ev of EXPECTED_HOOKS) {
      assert.ok(events.includes(ev), `must register ${ev} hook`);
    }
    // The old tool_call health-gate must NOT be registered.
    assert.ok(!events.includes("tool_call"), "tool_call health gate must be removed");
  });

  it("no tool description/guideline or command description contains forbidden service-era phrases", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const surfaces: string[] = [];
    for (const tool of pi._tools.values()) {
      surfaces.push(tool.description);
      surfaces.push(tool.promptSnippet ?? "");
      for (const g of tool.promptGuidelines ?? []) surfaces.push(g);
    }
    for (const cmd of pi._commands.values()) {
      surfaces.push(cmd.description ?? "");
    }

    for (const surface of surfaces) {
      for (const forbidden of FORBIDDEN_PHRASES) {
        assert.ok(
          !forbidden.test(surface),
          `forbidden phrase ${forbidden} found in: ${surface}`,
        );
      }
    }
  });

  it("tools return a no-active-mission message (never service unavailable) when no mission is active", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const startTool = pi._tools.get("ratel_start_mission");
    // startMission with empty goal returns an error result, not a crash.
    const result = await startTool!.execute("callId", { goal: "" }, undefined, undefined, makeMockCtx());
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(text, /goal is required/i);

    const getStatus = pi._tools.get("ratel_get_status");
    const statusResult = await getStatus!.execute("callId", { missionId: "mis_test" }, undefined, undefined, makeMockCtx());
    const statusText = (statusResult as { content: Array<{ text: string }> }).content[0].text;
    // Must not reference service unavailability.
    assert.ok(!/ratel --serve/i.test(statusText), "must not say ratel --serve");
    assert.ok(!/service unavailable/i.test(statusText), "must not say service unavailable");
  });

  it("session_start does not throw with a mock ctx", async () => {
    const { default: RatelExtension } = await import("../src/extension.js");
    const pi = createMockPi();
    RatelExtension(pi);

    const startHandler = pi._handlers.find((h: MockHandler) => h.event === "session_start")!;
    // Use a real temp dir so runtime fs helpers do not throw on the mock cwd.
    const os = await import("node:os");
    const fs = await import("node:fs");
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ratel-pi-ext-"));
    try {
      await startHandler.fn({ reason: "startup" }, makeMockCtx({ cwd: tmp }));
      // No assertion needed — reaching here without throwing is the contract.
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("prompts — in-process, no service-era wording", () => {
  it("factory mode prompt references .ratel/missions/<missionId>/ and in-process Pi extension", async () => {
    const { getFactoryModePrompt } = await import("../src/prompts.js");
    const p = getFactoryModePrompt();
    assert.ok(p.includes(".ratel/missions/<missionId>/"), "must reference durable .ratel state");
    assert.ok(!p.includes(".missions/current/"), "must not reference legacy .missions/current");
    assert.ok(p.includes("ratel_poll_status"));
    assert.ok(p.includes("ratel_approve_plan"));
    assert.ok(p.includes("ratel_reply_to_factory"));
    assert.ok(p.includes("ratel_answer_question"));
    assert.ok(p.toLowerCase().includes("in-process"));
    assert.ok(!/ratel --serve/i.test(p), "must not reference ratel --serve");
    assert.ok(!/HTTP service/i.test(p), "must not reference HTTP service");
  });
});

describe("source grep — no service-era imports or user-facing constants", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, "..", "src");

  const SRC_FILES = [
    "index.ts",
    "extension.ts",
    "commands.ts",
    "runtime.ts",
    "events.ts",
    "polling.ts",
    "prompts.ts",
    "resolve-project-root.ts",
    "tool-scope.ts",
  ];

  it("no src file imports ./service.js or ./service-lifecycle.js", () => {
    for (const f of SRC_FILES) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      assert.ok(
        !/from\s+["']\.\/service\.js["']/.test(content),
        `${f} must not import ./service.js`,
      );
      assert.ok(
        !/from\s+["']\.\/service-lifecycle\.js["']/.test(content),
        `${f} must not import ./service-lifecycle.js`,
      );
    }
  });

  it("no src file mentions `ratel --serve` or RatelServiceClient in user-facing constants", () => {
    for (const f of SRC_FILES) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      assert.ok(
        !/ratel --serve/i.test(content),
        `${f} must not mention ratel --serve`,
      );
      assert.ok(
        !/RatelServiceClient/.test(content),
        `${f} must not reference RatelServiceClient`,
      );
      assert.ok(
        !/RatelServiceError/.test(content),
        `${f} must not reference RatelServiceError`,
      );
    }
  });
});
