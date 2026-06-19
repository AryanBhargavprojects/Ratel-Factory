/**
 * Tests for the Ratel OpenCode Plugin
 *
 * Verifies that auth-bridge and diagnostic logging routes through
 * ctx.client.app.log (safeLog) instead of raw console.log, so
 * messages don't leak into the OpenCode composer/input bar.
 *
 * Uses Node's built-in test runner via `tsx --test`.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// We import the plugin default export from plugin.js and safeLog
// from the separate logging module for direct testing.
import RatelPlugin from "../src/plugin.js";
import { safeLog } from "../src/logging.js";

// ---------------------------------------------------------------------------
// safeLog routing tests
// ---------------------------------------------------------------------------

describe("safeLog", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
  });

  afterEach(() => {
    mock.reset();
  });

  it("routes through ctx.client.app.log when available (info level)", async () => {
    const appLogCalls: Array<{ level: string; message: string }> = [];
    const mockCtx = {
      client: {
        app: {
          log: async (entry: { level: string; message: string }) => {
            appLogCalls.push(entry);
          },
        },
      },
    };

    await safeLog(mockCtx, "info", "auth bridge synced");

    assert.equal(appLogCalls.length, 1);
    assert.equal(appLogCalls[0].level, "info");
    assert.equal(appLogCalls[0].message, "auth bridge synced");
    // Must NOT fall back to console.log
    assert.equal(consoleLogSpy.mock.calls.length, 0);
  });

  it("routes through ctx.client.app.log when available (warning level)", async () => {
    const appLogCalls: Array<{ level: string; message: string }> = [];
    const mockCtx = {
      client: {
        app: {
          log: async (entry: { level: string; message: string }) => {
            appLogCalls.push(entry);
          },
        },
      },
    };

    await safeLog(mockCtx, "warning", "auth bridge skipped");

    assert.equal(appLogCalls.length, 1);
    assert.equal(appLogCalls[0].level, "warning");
    assert.equal(appLogCalls[0].message, "auth bridge skipped");
    assert.equal(consoleLogSpy.mock.calls.length, 0);
  });

  it("routes through ctx.client.app.log when available (error level)", async () => {
    const appLogCalls: Array<{ level: string; message: string }> = [];
    const mockCtx = {
      client: {
        app: {
          log: async (entry: { level: string; message: string }) => {
            appLogCalls.push(entry);
          },
        },
      },
    };

    await safeLog(mockCtx, "error", "service unavailable");

    assert.equal(appLogCalls.length, 1);
    assert.equal(appLogCalls[0].level, "error");
    assert.equal(appLogCalls[0].message, "service unavailable");
    assert.equal(consoleLogSpy.mock.calls.length, 0);
  });

  it("falls back to console.log when ctx.client.app.log is absent", async () => {
    const mockCtx = { client: {} }; // no app.log

    await safeLog(mockCtx, "info", "fallback message");

    assert.equal(consoleLogSpy.mock.calls.length, 1);
    const callArgs = consoleLogSpy.mock.calls[0].arguments as string[];
    assert.ok(callArgs[0].includes("fallback message"));
  });

  it("falls back to console.log when ctx.client is absent", async () => {
    const mockCtx = {}; // no client at all

    await safeLog(mockCtx, "warning", "no client fallback");

    assert.equal(consoleLogSpy.mock.calls.length, 1);
    const callArgs = consoleLogSpy.mock.calls[0].arguments as string[];
    assert.ok(callArgs[0].includes("[Ratel WARN]"));
    assert.ok(callArgs[0].includes("no client fallback"));
  });

  it("falls back to console.log when ctx is null/undefined", async () => {
    await safeLog(null, "error", "null ctx fallback");

    assert.equal(consoleLogSpy.mock.calls.length, 1);
    const callArgs = consoleLogSpy.mock.calls[0].arguments as string[];
    assert.ok(callArgs[0].includes("[Ratel ERROR]"));
    assert.ok(callArgs[0].includes("null ctx fallback"));
  });

  it("never throws even if app.log itself throws (silently swallows, no stdout fallback)", async () => {
    const mockCtx = {
      client: {
        app: {
          log: async () => {
            throw new Error("log explosion");
          },
        },
      },
    };

    // Must not throw
    await safeLog(mockCtx, "info", "should not throw");
    // When app.log throws, safeLog silently swallows the error.
    // It does NOT fall back to console.log because that would leak
    // to the OpenCode composer — the safer choice is silence.
    assert.equal(consoleLogSpy.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Plugin structure tests
// ---------------------------------------------------------------------------

describe("RatelPlugin", () => {
  it("plugin entry module exposes only a default export (no named runtime exports)", async () => {
    // OpenCode treats named exports from plugin modules as provider
    // plugins, which breaks provider listing (e.g. opencode models opencode).
    // This test verifies that plugin.ts has only the default export.
    const mod = await import("../src/plugin.js");
    const keys = Object.keys(mod);

    // Must have a default export
    assert.ok("default" in mod, "plugin module must have a default export");
    assert.equal(typeof mod.default, "function", "default export must be a function");

    // Must NOT have any named runtime exports
    const namedExports = keys.filter(k => k !== "default");
    assert.equal(
      namedExports.length,
      0,
      `plugin module must not have named runtime exports, found: ${namedExports.join(", ")}`,
    );
  });

  it("returns a plugin object with expected shape", async () => {
    const mockCtx = {
      directory: "/tmp/test-project",
      client: {
        app: {
          log: async () => {},
        },
      },
    };

    const plugin = await RatelPlugin(mockCtx);

    // Plugin must have config hook
    assert.equal(typeof plugin.config, "function");

    // Plugin must have command.execute.before hook
    assert.equal(typeof plugin["command.execute.before"], "function");

    // Plugin must have tool definitions
    assert.ok(plugin.tool);
    assert.ok(plugin.tool.ratel_start_mission);
    assert.ok(plugin.tool.ratel_get_status);
    assert.ok(plugin.tool.ratel_run_worker);
    assert.ok(plugin.tool.ratel_run_validation);
    assert.ok(plugin.tool.ratel_ping_agents);

    // Each tool must have description, args, and execute
    for (const toolName of Object.keys(plugin.tool)) {
      const tool = plugin.tool[toolName];
      assert.equal(typeof tool.description, "string");
      assert.equal(typeof tool.args, "object");
      assert.equal(typeof tool.execute, "function");
    }
  });

  it("config hook captures opencodeConfig snapshot without throwing", async () => {
    const mockCtx = {
      directory: "/tmp/test-project",
      client: { app: { log: async () => {} } },
    };

    const plugin = await RatelPlugin(mockCtx);

    const testConfig = {
      model: "opencode-go/gpt-5.5",
      provider: { "opencode-go": { type: "api", key: "test" } },
      system: [],
    };

    // Must not throw
    await plugin.config(testConfig);
  });

  it("command.execute.before hook handles non-ratel commands gracefully", async () => {
    const mockCtx = {
      directory: "/tmp/test-project",
      client: { app: { log: async () => {} } },
    };

    const plugin = await RatelPlugin(mockCtx);

    const input = { command: "/some-other-command", sessionID: "test-session", arguments: "" };
    const output = { parts: [{ type: "text", text: "some other text" }] };

    // Must not throw for non-ratel commands
    await plugin["command.execute.before"](input, output);
  });

  it("ratel_ping_agents tool returns SERVICE_UNAVAILABLE_MSG when no service", async () => {
    const mockCtx = {
      directory: "/tmp/test-project",
      client: { app: { log: async () => {} } },
    };

    const plugin = await RatelPlugin(mockCtx);
    const result = await plugin.tool.ratel_ping_agents.execute({});

    assert.equal(typeof result, "string");
    assert.ok(result.includes("not available"));
  });
});
