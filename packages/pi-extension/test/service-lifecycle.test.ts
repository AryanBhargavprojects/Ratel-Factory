/**
 * Tests for service-lifecycle discovery and autostart.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import {
  readServicePortfile,
  ensureRatelService,
  waitForService,
  cleanupSpawnedService,
  defaultResolveRatelCli,
  type ServiceLogger,
} from "../src/service-lifecycle.js";

function makeLogger(): { calls: Array<{ level: string; message: string }>; logger: ServiceLogger } {
  const calls: Array<{ level: string; message: string }> = [];
  return { calls, logger: (level, message) => { calls.push({ level, message }); } };
}

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ratel-pi-test-"));
  mkdirSync(join(dir, ".ratel"), { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writePortfile(dir: string, url: string, port: number): void {
  writeFileSync(
    join(dir, ".ratel", "service.json"),
    JSON.stringify({ pid: 1, url, port, cwd: dir, startedAt: new Date().toISOString(), version: "0.2.0" }),
    "utf-8",
  );
}

function spawnEmits(event: string, ...args: unknown[]): typeof import("node:child_process").spawn {
  return (() => {
    const child = new EventEmitter() as any;
    child.kill = () => {};
    child.killed = false;
    setImmediate(() => child.emit(event, ...args));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

/**
 * Returns a spawn stub that records the command + args it was called with and
 * emits the given event (e.g. "exit") after a tick so waitForService settles.
 */
function spawnCapturing(
  captures: { command: string; args: string[] }[],
  event: string,
  ...eventArgs: unknown[]
): typeof import("node:child_process").spawn {
  return ((command: string, args: string[]) => {
    captures.push({ command, args });
    const child = new EventEmitter() as any;
    child.kill = () => {};
    child.killed = false;
    setImmediate(() => child.emit(event, ...eventArgs));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("readServicePortfile", () => {
  it("returns null when no portfile exists", async () => {
    const dir = tmpProject();
    try {
      const pf = await readServicePortfile(dir);
      assert.equal(pf, null);
    } finally {
      cleanup(dir);
    }
  });

  it("parses a valid portfile", async () => {
    const dir = tmpProject();
    try {
      writePortfile(dir, "http://127.0.0.1:4000", 4000);
      const pf = await readServicePortfile(dir);
      assert.equal(pf?.url, "http://127.0.0.1:4000");
      assert.equal(pf?.port, 4000);
      assert.equal(pf?.cwd, dir);
    } finally {
      cleanup(dir);
    }
  });
});

describe("ensureRatelService — discovery", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("reuses a healthy service from the portfile (no child spawned)", async () => {
    const dir = tmpProject();
    const { logger } = makeLogger();
    try {
      writePortfile(dir, "http://127.0.0.1:4001", 4001);
      globalThis.fetch = async (input: any) => {
        assert.equal(String(input), "http://127.0.0.1:4001/health");
        return { ok: true, json: async () => ({ status: "ok" }) } as any;
      };
      const result = await ensureRatelService({ projectRoot: dir, logger, disableAutostart: true });
      assert.ok(result.client, "should return a client");
      assert.equal(result.child, null, "should not spawn a child");
    } finally {
      cleanup(dir);
    }
  });

  it("returns null client when autostart disabled and no healthy service", async () => {
    const dir = tmpProject();
    try {
      globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "" }) as any;
      const result = await ensureRatelService({ projectRoot: dir, disableAutostart: true });
      assert.equal(result.client, null);
      assert.equal(result.child, null);
    } finally {
      cleanup(dir);
    }
  });
});

describe("waitForService — spawn failure", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("resolves null when the spawned process exits before ready", async () => {
    const dir = tmpProject();
    try {
      const result = await waitForService({
        projectRoot: dir,
        timeoutMs: 2000,
        spawnFn: spawnEmits("exit", 1, "SIGTERM") as any,
      });
      assert.equal(result.client, null);
      assert.equal(result.child, null);
    } finally {
      cleanup(dir);
    }
  });
});

describe("waitForService — bundled core resolution", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("spawns process.execPath with the resolved bundled core path when available", async () => {
    const dir = tmpProject();
    const { logger, calls } = makeLogger();
    const captures: { command: string; args: string[] }[] = [];
    const fakeCorePath = "/fake/node_modules/@ratel-factory/core/dist/index.js";
    try {
      const result = await waitForService({
        projectRoot: dir,
        timeoutMs: 2000,
        logger,
        spawnFn: spawnCapturing(captures, "exit", 1, "SIGTERM") as any,
        resolveRatelCli: () => fakeCorePath,
      });
      assert.equal(result.client, null);
      assert.equal(result.child, null);
      assert.equal(captures.length, 1, "should spawn exactly once");
      assert.equal(captures[0].command, process.execPath, "should use Node binary");
      assert.deepEqual(
        captures[0].args,
        [fakeCorePath, "--serve"],
        "should pass [coreEntry, --serve]",
      );
      assert.ok(
        calls.some((c) => c.message.includes("bundled core")),
        "log should mention bundled core",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("falls back to bare 'ratel' when resolver returns null", async () => {
    const dir = tmpProject();
    const { logger, calls } = makeLogger();
    const captures: { command: string; args: string[] }[] = [];
    try {
      const result = await waitForService({
        projectRoot: dir,
        timeoutMs: 2000,
        logger,
        spawnFn: spawnCapturing(captures, "exit", 1, "SIGTERM") as any,
        resolveRatelCli: () => null,
      });
      assert.equal(result.client, null);
      assert.equal(result.child, null);
      assert.equal(captures.length, 1, "should spawn exactly once");
      assert.equal(captures[0].command, "ratel", "should fall back to PATH ratel");
      assert.deepEqual(captures[0].args, ["--serve"]);
      assert.ok(
        calls.some((c) => c.message.includes("fallback")),
        "log should mention fallback",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("defaultResolveRatelCli returns a string or null without throwing", () => {
    // In the test environment core is a workspace sibling, so resolution may
    // either succeed (resolving to the core dist entry) or fail; both are
    // valid. We only assert it never throws and returns the right type.
    const result = defaultResolveRatelCli();
    assert.ok(
      result === null || typeof result === "string",
      "defaultResolveRatelCli must return string | null",
    );
  });
});

describe("cleanupSpawnedService", () => {
  it("is a no-op for null and already-killed children", () => {
    cleanupSpawnedService(null);
    const fake = { killed: true, kill: () => { throw new Error("should not be called"); } };
    cleanupSpawnedService(fake as any);
  });

  it("calls kill on a live child", () => {
    let killed = false;
    const fake = { killed: false, kill: () => { killed = true; } };
    cleanupSpawnedService(fake as any);
    assert.equal(killed, true);
  });
});
