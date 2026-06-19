/**
 * Tests for command handlers (commands.ts)
 *
 * Verifies that command handling routes all logging through
 * ctx.client.app.log when available, and does NOT call raw
 * console.log / console.error — preventing leaks into the
 * OpenCode composer/input bar.
 *
 * Uses Node's built-in test runner via `tsx --test`.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { handleCommand, type CommandContext } from "../src/commands.js";

// ---------------------------------------------------------------------------
// Helpers: build mock service & context
// ---------------------------------------------------------------------------

interface AppLogCall {
  level: string;
  message: string;
}

function makeMockService(overrides: Record<string, any> = {}) {
  return {
    health: async () => ({ status: "ok" }),
    pingAgents: async () => ({
      ok: true,
      totalAgents: 3,
      okCount: 3,
      failedCount: 0,
      totalTimeMs: 150,
      agents: [
        { role: "architect", status: "ok", timeMs: 50 },
        { role: "worker", status: "ok", timeMs: 50 },
        { role: "validator", status: "ok", timeMs: 50 },
      ],
    }),
    getMissionStatus: async (_missionId: string) => ({
      missionId: "test-mission",
      status: "active",
    }),
    getJobStatus: async (_missionId: string, _jobId: string) => ({
      jobId: "test-job",
      missionId: "test-mission",
      status: "running",
    }),
    getObservatoryUrl: async () => ({
      enabled: true,
      url: "http://localhost:3100",
    }),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CommandContext> & { appLog?: ((entry: { level: string; message: string }) => Promise<void>) | null } = {}): CommandContext {
  const { appLog, ...rest } = overrides;
  return {
    command: "ratel",
    client: appLog === null
      ? {}
      : { app: { log: appLog ?? (async () => {}) } },
    sessionId: "test-session",
    rawArgs: "",
    cwd: "/tmp/test-project",
    service: makeMockService() as any,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Tests: app.log routing (no raw console when app.log exists)
// ---------------------------------------------------------------------------

describe("handleCommand — app.log routing", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
  });

  afterEach(() => {
    mock.reset();
  });

  // ── /ratel ────────────────────────────────────────────────

  it("/ratel routes all output through app.log, never raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel",
      appLog: async (entry) => { appLogCalls.push(entry); },
    });

    await handleCommand(ctx);

    // Must have at least the "received" and the result log calls
    assert.ok(appLogCalls.length >= 2, `expected >=2 appLog calls, got ${appLogCalls.length}`);
    assert.equal(appLogCalls[0].level, "info");
    assert.ok(appLogCalls[0].message.includes("/ratel command received"));

    // Must NOT fall back to console.log or console.error
    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel with degraded health routes warning through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel",
      appLog: async (entry) => { appLogCalls.push(entry); },
      service: makeMockService({
        health: async () => ({ status: "degraded" }),
      }) as any,
    });

    await handleCommand(ctx);

    const warningCalls = appLogCalls.filter(c => c.level === "warning");
    assert.ok(warningCalls.length >= 1, "expected at least one warning log call");
    assert.ok(warningCalls[0].message.includes("health check failed"));

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel with ping failure routes warning through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel",
      appLog: async (entry) => { appLogCalls.push(entry); },
      service: makeMockService({
        pingAgents: async () => { throw new Error("ping timeout"); },
      }) as any,
    });

    await handleCommand(ctx);

    const warningCalls = appLogCalls.filter(c => c.level === "warning");
    assert.ok(warningCalls.length >= 1, "expected at least one warning log call");
    assert.ok(warningCalls[0].message.includes("Could not ping"));

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  // ── /ratel-mission ────────────────────────────────────────

  it("/ratel-mission with no cached mission routes info through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-mission",
      appLog: async (entry) => { appLogCalls.push(entry); },
      cachedMissionId: undefined,
    });

    await handleCommand(ctx);

    // First call is "received", second is "No active mission"
    assert.ok(appLogCalls.length >= 2, `expected >=2 appLog calls, got ${appLogCalls.length}`);
    const noMissionCall = appLogCalls.find(c => c.message.includes("No active mission"));
    assert.ok(noMissionCall, "expected a log call containing 'No active mission'");

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel-mission with cached mission routes info through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-mission",
      appLog: async (entry) => { appLogCalls.push(entry); },
      cachedMissionId: "test-mission",
      cachedJobId: "test-job",
    });

    await handleCommand(ctx);

    assert.ok(appLogCalls.length >= 1);
    const resultCall = appLogCalls.find(c => c.message.includes("Mission:"));
    assert.ok(resultCall, "expected a log call containing mission info");

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  // ── /ratel-observatory ────────────────────────────────────

  it("/ratel-observatory routes info through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-observatory",
      appLog: async (entry) => { appLogCalls.push(entry); },
    });

    await handleCommand(ctx);

    assert.ok(appLogCalls.length >= 1);
    const urlCall = appLogCalls.find(c => c.message.includes("Observatory:"));
    assert.ok(urlCall, "expected a log call containing observatory URL");

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel-observatory with no URL routes warning through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-observatory",
      appLog: async (entry) => { appLogCalls.push(entry); },
      service: makeMockService({
        getObservatoryUrl: async () => ({ enabled: false, url: null }),
      }) as any,
    });

    await handleCommand(ctx);

    const warningCalls = appLogCalls.filter(c => c.level === "warning");
    assert.ok(warningCalls.length >= 1);
    assert.ok(warningCalls[0].message.includes("not running"));

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel-observatory with fetch error routes warning through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-observatory",
      appLog: async (entry) => { appLogCalls.push(entry); },
      service: makeMockService({
        getObservatoryUrl: async () => { throw new Error("connection refused"); },
      }) as any,
    });

    await handleCommand(ctx);

    const warningCalls = appLogCalls.filter(c => c.level === "warning");
    assert.ok(warningCalls.length >= 1);
    assert.ok(warningCalls[0].message.includes("Could not connect"));

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel-observatory with cached mission includes missionId in URL", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-observatory",
      appLog: async (entry) => { appLogCalls.push(entry); },
      cachedMissionId: "mis_test123",
    });

    await handleCommand(ctx);

    const urlCall = appLogCalls.find(c => c.message.includes("Observatory:"));
    assert.ok(urlCall, "expected a log call containing observatory URL");
    assert.ok(
      urlCall.message.includes("?missionId=mis_test123"),
      `expected URL to include ?missionId=mis_test123, got: ${urlCall.message}`
    );

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("/ratel-observatory without cached mission does NOT include missionId", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "ratel-observatory",
      appLog: async (entry) => { appLogCalls.push(entry); },
      cachedMissionId: undefined,
    });

    await handleCommand(ctx);

    const urlCall = appLogCalls.find(c => c.message.includes("Observatory:"));
    assert.ok(urlCall, "expected a log call containing observatory URL");
    assert.ok(
      !urlCall.message.includes("?missionId="),
      `expected URL to NOT include missionId, got: ${urlCall.message}`
    );

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  // ── unknown command ───────────────────────────────────────

  it("unknown command routes warning through app.log, no raw console", async () => {
    const appLogCalls: AppLogCall[] = [];
    const ctx = makeCtx({
      command: "some-unknown-cmd",
      appLog: async (entry) => { appLogCalls.push(entry); },
    });

    await handleCommand(ctx);

    assert.equal(appLogCalls.length, 1);
    assert.equal(appLogCalls[0].level, "warning");
    assert.ok(appLogCalls[0].message.includes("Unknown command"));

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  // ── console.error never called (structural) ──────────────
  // The outer catch block was cleaned up to only call log("error", ...)
  // without console.error.  All reachable error paths are covered by
  // the per-command tests above, which already assert consoleErrorSpy
  // is never called.  The outer catch is a safety net that is
  // structurally correct but unreachable in normal operation
  // (every case block has its own error handling).

});

// ---------------------------------------------------------------------------
// Tests: console.log fallback when app.log is absent
// ---------------------------------------------------------------------------

describe("handleCommand — console.log fallback (no app.log)", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
  });

  afterEach(() => {
    mock.reset();
  });

  it("/ratel falls back to console.log when client has no app.log", async () => {
    const ctx = makeCtx({
      command: "ratel",
      appLog: null, // signals: no app.log at all
    });

    await handleCommand(ctx);

    // Should have console.log calls as fallback
    assert.ok(consoleLogSpy.mock.calls.length >= 1, "expected fallback console.log calls");
    const calls = consoleLogSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
    const receivedCall = calls.find(s => s.includes("/ratel command received"));
    assert.ok(receivedCall, "expected a console.log with 'received' message");
  });

  it("/ratel-mission falls back to console.log when client has no app.log", async () => {
    const ctx = makeCtx({
      command: "ratel-mission",
      appLog: null,
      cachedMissionId: undefined,
    });

    await handleCommand(ctx);

    assert.ok(consoleLogSpy.mock.calls.length >= 1);
    const calls = consoleLogSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
    const receivedCall = calls.find(s => s.includes("No active mission"));
    assert.ok(receivedCall);
  });

  it("unknown command falls back to console.log when client has no app.log", async () => {
    const ctx = makeCtx({
      command: "unknown-cmd",
      appLog: null,
    });

    await handleCommand(ctx);

    assert.ok(consoleLogSpy.mock.calls.length >= 1);
    const calls = consoleLogSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
    const warnCall = calls.find(s => s.includes("[Ratel WARN]") && s.includes("Unknown command"));
    assert.ok(warnCall);
  });
});

// ---------------------------------------------------------------------------
// Tests: app.log throws → silent swallow, no console fallback
// ---------------------------------------------------------------------------

describe("handleCommand — app.log throws (silent swallow)", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
  });

  afterEach(() => {
    mock.reset();
  });

  it("does not fall back to console.log when app.log itself throws", async () => {
    const ctx = makeCtx({
      command: "ratel",
      appLog: async () => { throw new Error("log explosion"); },
    });

    // Must not throw
    await handleCommand(ctx);

    // When app.log throws, the log() helper silently swallows.
    // It must NOT fall back to console.log — that would leak to
    // the OpenCode composer.
    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });
});
