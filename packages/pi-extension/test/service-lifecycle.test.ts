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
