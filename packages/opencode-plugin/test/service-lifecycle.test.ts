/**
 * Tests for service-lifecycle.ts
 *
 * Verifies that service discovery/startup/error paths route through
 * the injected ServiceLogger instead of raw console.log/console.error,
 * and that the RATEL_OPENCODE_DEBUG gate works correctly when no
 * logger is provided.
 *
 * Uses Node's built-in test runner via `tsx --test`.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import {
  readServicePortfile,
  ensureRatelService,
  waitForService,
  type ServiceLogger,
} from "../src/service-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogCall {
  level: "info" | "warning" | "error";
  message: string;
}

function makeLogger(): { calls: LogCall[]; logger: ServiceLogger } {
  const calls: LogCall[] = [];
  const logger: ServiceLogger = (level, message) => {
    calls.push({ level, message });
  };
  return { calls, logger };
}

function makePortfile(overrides: Partial<{
  pid: number;
  url: string;
  port: number;
  cwd: string;
  startedAt: string;
  version: string;
}> = {}): Record<string, unknown> {
  return {
    pid: 12345,
    url: "http://127.0.0.1:3200",
    port: 3200,
    cwd: "/tmp/test-project",
    startedAt: new Date().toISOString(),
    version: "0.1.0",
    ...overrides,
  };
}

function setupTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ratel-test-"));
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Create a spawn mock that throws synchronously (simulating ENOENT). */
function spawnThrows(): typeof import("node:child_process").spawn {
  return (() => {
    const err = new Error("spawn ratel ENOENT");
    (err as any).code = "ENOENT";
    throw err;
  }) as unknown as typeof import("node:child_process").spawn;
}

/** Create a spawn mock that returns a fake ChildProcess emitting an event. */
function spawnEmits(
  event: string,
  ...args: any[]
): typeof import("node:child_process").spawn {
  return (() => {
    const child = new EventEmitter() as any;
    child.kill = () => {};
    setImmediate(() => child.emit(event, ...args));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

/** Create a spawn mock that returns a silent child (for polling success). */
function spawnSilent(): typeof import("node:child_process").spawn {
  return (() => {
    const child = new EventEmitter() as any;
    child.kill = () => {};
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

// ---------------------------------------------------------------------------
// readServicePortfile tests
// ---------------------------------------------------------------------------

describe("readServicePortfile", () => {
  it("returns null when .ratel/service.json does not exist", async () => {
    const dir = setupTempDir();
    try {
      const result = await readServicePortfile(dir);
      assert.equal(result, null);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("returns parsed portfile when .ratel/service.json is valid", async () => {
    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      const portfile = makePortfile({ cwd: dir });
      writeFileSync(join(ratelDir, "service.json"), JSON.stringify(portfile), "utf-8");

      const result = await readServicePortfile(dir);
      assert.ok(result !== null);
      assert.equal(result!.url, "http://127.0.0.1:3200");
      assert.equal(result!.port, 3200);
      assert.equal(result!.cwd, dir);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("returns null when portfile is missing required fields", async () => {
    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      // Missing url field
      writeFileSync(
        join(ratelDir, "service.json"),
        JSON.stringify({ pid: 123, port: 3200, cwd: dir }),
        "utf-8",
      );

      const result = await readServicePortfile(dir);
      assert.equal(result, null);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("returns null when portfile is malformed JSON", async () => {
    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      writeFileSync(join(ratelDir, "service.json"), "not json {{{", "utf-8");

      const result = await readServicePortfile(dir);
      assert.equal(result, null);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRatelService — logger routing (discovery path)
// ---------------------------------------------------------------------------

describe("ensureRatelService — logger routing", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    mock.reset();
    globalThis.fetch = originalFetch;
  });

  it("routes discovery message through logger, not raw console", async () => {
    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      const portfile = makePortfile({ cwd: dir });
      writeFileSync(join(ratelDir, "service.json"), JSON.stringify(portfile), "utf-8");

      // Mock fetch to return healthy
      globalThis.fetch = async () =>
        ({ ok: true, json: async () => ({ status: "ok" }) }) as any;

      const { calls, logger } = makeLogger();
      const result = await ensureRatelService(dir, logger);

      assert.ok(result !== null);
      const discoveryCall = calls.find(c => c.message.includes("Discovered running service"));
      assert.ok(discoveryCall, "expected a log call with 'Discovered running service'");
      assert.equal(discoveryCall!.level, "info");

      // Must NOT have used raw console
      assert.equal(consoleLogSpy.mock.calls.length, 0);
      assert.equal(consoleErrorSpy.mock.calls.length, 0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("routes unhealthy-service + spawn-error messages through logger, not raw console", async () => {
    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      const portfile = makePortfile({ cwd: dir });
      writeFileSync(join(ratelDir, "service.json"), JSON.stringify(portfile), "utf-8");

      // Mock fetch to return unhealthy
      globalThis.fetch = async () =>
        ({ ok: false, json: async () => ({ status: "error" }) }) as any;

      const { calls, logger } = makeLogger();
      const result = await ensureRatelService(dir, logger, spawnThrows());

      assert.equal(result, null);
      // Must have logged unhealthy message
      const unhealthyCall = calls.find(c => c.message.includes("not healthy"));
      assert.ok(unhealthyCall, "expected a log call about unhealthy service");
      assert.equal(unhealthyCall!.level, "info");

      // Must have logged "Starting service"
      const startCall = calls.find(c => c.message.includes("Starting service"));
      assert.ok(startCall, "expected a log call about starting service");

      // Must have logged spawn error
      const errorCall = calls.find(c => c.message.includes("Failed to spawn"));
      assert.ok(errorCall, "expected a log call about spawn failure");
      assert.equal(errorCall!.level, "error");

      // Must NOT have used raw console
      assert.equal(consoleLogSpy.mock.calls.length, 0);
      assert.equal(consoleErrorSpy.mock.calls.length, 0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("routes spawn error through logger, not raw console (no portfile)", async () => {
    const dir = setupTempDir();
    try {
      const { calls, logger } = makeLogger();
      const result = await ensureRatelService(dir, logger, spawnThrows());

      assert.equal(result, null);
      const startCall = calls.find(c => c.message.includes("Starting service"));
      assert.ok(startCall);

      const errorCall = calls.find(c => c.message.includes("Failed to spawn"));
      assert.ok(errorCall);
      assert.equal(errorCall!.level, "error");

      assert.equal(consoleLogSpy.mock.calls.length, 0);
      assert.equal(consoleErrorSpy.mock.calls.length, 0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRatelService — DEBUG gate (no logger)
// ---------------------------------------------------------------------------

describe("ensureRatelService — DEBUG gate (no logger)", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;
  let originalFetch: typeof globalThis.fetch;
  let originalDebug: string | undefined;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
    originalFetch = globalThis.fetch;
    originalDebug = process.env.RATEL_OPENCODE_DEBUG;
  });

  afterEach(() => {
    mock.reset();
    globalThis.fetch = originalFetch;
    if (originalDebug === undefined) {
      delete process.env.RATEL_OPENCODE_DEBUG;
    } else {
      process.env.RATEL_OPENCODE_DEBUG = originalDebug;
    }
  });

  it("suppresses info messages when DEBUG=0 and no logger", async () => {
    delete process.env.RATEL_OPENCODE_DEBUG;

    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      const portfile = makePortfile({ cwd: dir });
      writeFileSync(join(ratelDir, "service.json"), JSON.stringify(portfile), "utf-8");

      globalThis.fetch = async () =>
        ({ ok: true, json: async () => ({ status: "ok" }) }) as any;

      const result = await ensureRatelService(dir);

      assert.ok(result !== null);
      // Info messages must be suppressed (no logger, DEBUG=0)
      assert.equal(consoleLogSpy.mock.calls.length, 0);
      assert.equal(consoleErrorSpy.mock.calls.length, 0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("emits info messages when DEBUG=1 and no logger", async () => {
    process.env.RATEL_OPENCODE_DEBUG = "1";

    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      const portfile = makePortfile({ cwd: dir });
      writeFileSync(join(ratelDir, "service.json"), JSON.stringify(portfile), "utf-8");

      globalThis.fetch = async () =>
        ({ ok: true, json: async () => ({ status: "ok" }) }) as any;

      const result = await ensureRatelService(dir);

      assert.ok(result !== null);
      const logCalls = consoleLogSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
      const discoveryCall = logCalls.find(s => s.includes("Discovered running service"));
      assert.ok(discoveryCall, "expected console.log with 'Discovered running service' when DEBUG=1");
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("always emits errors to console.error when no logger (even DEBUG=0)", async () => {
    delete process.env.RATEL_OPENCODE_DEBUG;

    const dir = setupTempDir();
    try {
      const result = await ensureRatelService(dir, undefined, spawnThrows());

      assert.equal(result, null);
      const errCalls = consoleErrorSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
      const spawnErrCall = errCalls.find(s => s.includes("Failed to spawn"));
      assert.ok(spawnErrCall, "expected console.error with spawn failure even when DEBUG=0");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// waitForService — logger routing (error paths)
// ---------------------------------------------------------------------------

describe("waitForService — logger routing", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
  });

  afterEach(() => {
    mock.reset();
  });

  it("routes spawn failure through logger, not raw console", async () => {
    const { calls, logger } = makeLogger();
    const result = await waitForService("/tmp/test-project", 5000, logger, spawnThrows());

    assert.equal(result, null);
    const errorCall = calls.find(c => c.message.includes("Failed to spawn"));
    assert.ok(errorCall);
    assert.equal(errorCall!.level, "error");

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("routes process error event through logger, not raw console", async () => {
    const { calls, logger } = makeLogger();
    const result = await waitForService(
      "/tmp/test-project",
      5000,
      logger,
      spawnEmits("error", new Error("spawn ratel ENOENT")),
    );

    assert.equal(result, null);
    const errorCall = calls.find(c => c.message.includes("Service process error"));
    assert.ok(errorCall);
    assert.equal(errorCall!.level, "error");

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });

  it("routes process exit event through logger, not raw console", async () => {
    const { calls, logger } = makeLogger();
    const result = await waitForService(
      "/tmp/test-project",
      5000,
      logger,
      spawnEmits("exit", 1, "SIGTERM"),
    );

    assert.equal(result, null);
    const errorCall = calls.find(c => c.message.includes("Service process exited"));
    assert.ok(errorCall);
    assert.equal(errorCall!.level, "error");

    assert.equal(consoleLogSpy.mock.calls.length, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// waitForService — DEBUG gate (no logger)
// ---------------------------------------------------------------------------

describe("waitForService — DEBUG gate (no logger)", () => {
  let consoleLogSpy: ReturnType<typeof mock.method>;
  let consoleErrorSpy: ReturnType<typeof mock.method>;
  let originalDebug: string | undefined;

  beforeEach(() => {
    consoleLogSpy = mock.method(console, "log");
    consoleErrorSpy = mock.method(console, "error");
    originalDebug = process.env.RATEL_OPENCODE_DEBUG;
  });

  afterEach(() => {
    mock.reset();
    if (originalDebug === undefined) {
      delete process.env.RATEL_OPENCODE_DEBUG;
    } else {
      process.env.RATEL_OPENCODE_DEBUG = originalDebug;
    }
  });

  it("errors go to console.error when no logger (even DEBUG=0)", async () => {
    delete process.env.RATEL_OPENCODE_DEBUG;

    const result = await waitForService("/tmp/test-project", 5000, undefined, spawnThrows());

    assert.equal(result, null);
    const errCalls = consoleErrorSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
    const spawnErrCall = errCalls.find(s => s.includes("Failed to spawn"));
    assert.ok(spawnErrCall, "expected console.error with spawn failure");
  });

  it("info messages are suppressed when DEBUG=0 and no logger", async () => {
    delete process.env.RATEL_OPENCODE_DEBUG;

    const dir = setupTempDir();
    try {
      const ratelDir = join(dir, ".ratel");
      mkdirSync(ratelDir, { recursive: true });
      const portfile = makePortfile({ cwd: dir });
      writeFileSync(join(ratelDir, "service.json"), JSON.stringify(portfile), "utf-8");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({ ok: true, json: async () => ({ status: "ok" }) }) as any;

      try {
        const result = await waitForService(dir, 2000, undefined, spawnSilent());
        assert.ok(result !== null);
        // Info message ("Auto-started service") should be suppressed
        const logCalls = consoleLogSpy.mock.calls.map(c => (c.arguments as string[]).join(" "));
        const autoStartCall = logCalls.find(s => s.includes("Auto-started service"));
        assert.equal(autoStartCall, undefined, "info message should be suppressed when DEBUG=0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});
