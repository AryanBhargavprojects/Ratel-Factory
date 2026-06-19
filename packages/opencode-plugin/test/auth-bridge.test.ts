/**
 * Tests for the OpenCode → Pi Auth Bridge
 *
 * Covers the real-time sync fix:
 *   - Overwrite mode (rotated API keys)
 *   - Change detection (no-op when nothing changed)
 *   - Safe provider removal (only managed providers, never user entries)
 *   - Conservative behaviour on missing/corrupt metadata
 *   - Metadata stores key hashes, not raw keys
 *   - Backward-compatible metadata fields preserved
 *
 * Uses Node's built-in test runner via `tsx --test`.
 *
 * Each test uses a fresh temp directory for project root + a temp
 * PI_AGENT_DIR so Pi auth.json and OpenCode auth.json live in isolated
 * locations. We override paths via env vars + the exported resolvers.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bridgeOpenCodeAuthForProject,
  resolveOpenCodeAuthPath,
  resolvePiAuthPath,
  resolveProviderNamespacesPath,
  readProviderNamespacesMetadata,
  readPiAuth,
  hashApiKey,
  type BridgeOptions,
} from "../src/auth-bridge.js";

// ---------------------------------------------------------------------------
// Harness: isolated temp dirs per test
// ---------------------------------------------------------------------------

interface Sandbox {
  home: string;
  projectRoot: string;
  openCodeAuthPath: string;
  piAuthPath: string;
  metaPath: string;
  setEnv: () => void;
  restoreEnv: () => void;
}

async function makeSandbox(ratelConfig?: Record<string, unknown>): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "authbridge-"));
  const xdgData = join(home, ".local", "share");
  const opencodeDir = join(xdgData, "opencode");
  await mkdir(opencodeDir, { recursive: true });

  const piAgentDir = join(home, ".pi", "agent");
  await mkdir(piAgentDir, { recursive: true });

  const projectRoot = await mkdtemp(join(tmpdir(), "ratelproj-"));
  // Write a ratel.json with an opencode-go model by default.
  const config =
    ratelConfig ??
    {
      orchestrator: { model: "opencode-go/gpt-5.5", fallbackModels: [] },
      workers: { model: "opencode-go/gpt-5.5", fallbackModels: [] },
      validators: { model: "opencode-go/gpt-5.5", fallbackModels: [] },
    };
  await writeFile(join(projectRoot, "ratel.json"), JSON.stringify(config), "utf-8");

  const openCodeAuthPath = join(opencodeDir, "auth.json");
  const piAuthPath = join(piAgentDir, "auth.json");
  const metaPath = resolveProviderNamespacesPath(projectRoot);

  const prevXdg = process.env.XDG_DATA_HOME;
  const prevPi = process.env.PI_AGENT_DIR;

  const setEnv = () => {
    process.env.XDG_DATA_HOME = xdgData;
    process.env.PI_AGENT_DIR = piAgentDir;
  };
  const restoreEnv = () => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevPi === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = prevPi;
  };

  setEnv();
  return {
    home,
    projectRoot,
    openCodeAuthPath,
    piAuthPath,
    metaPath,
    setEnv,
    restoreEnv,
  };
}

async function writeOpenCodeAuth(s: Sandbox, creds: Record<string, { type: string; key: string }>): Promise<void> {
  await writeFile(s.openCodeAuthPath, JSON.stringify(creds), "utf-8");
}

async function writePiAuth(s: Sandbox, creds: Record<string, { type: string; key: string }>): Promise<void> {
  await writeFile(s.piAuthPath, JSON.stringify(creds), "utf-8");
}

async function cleanup(s: Sandbox): Promise<void> {
  s.restoreEnv();
  await rm(s.home, { recursive: true, force: true });
  await rm(s.projectRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth-bridge — overwrite mode", () => {
  let s: Sandbox;
  beforeEach(async () => { s = await makeSandbox(); });
  afterEach(async () => { await cleanup(s); });

  it("overwrites a changed key when OpenCode has a new key and Pi has an old one", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "new-key" } });
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "old-key" } });

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);

    assert.equal(result.skipped, false);
    assert.deepEqual(result.updatedProviders, ["opencode-go"]);
    assert.deepEqual(result.addedProviders, []);
    assert.deepEqual(result.removedProviders, []);
    assert.equal(result.authChanged, true);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "new-key");
    assert.equal(pi["opencode-go"]?.type, "api_key");
  });

  it("adds a missing provider when Pi auth lacks it", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    // No Pi auth file yet
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);

    assert.deepEqual(result.addedProviders, ["opencode-go"]);
    assert.deepEqual(result.updatedProviders, []);
    assert.equal(result.authChanged, true);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "k1");
  });

  it("does not overwrite when overwrite=false", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "new-key" } });
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "old-key" } });

    const opts: BridgeOptions = { overwrite: false };
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot, undefined, opts);

    assert.deepEqual(result.updatedProviders, []);
    assert.deepEqual(result.skippedProviders, ["opencode-go"]);
    assert.equal(result.authChanged, false);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "old-key");
  });

  it("skips when the key is already in sync", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "same-key" } });
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "same-key" } });

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);

    assert.deepEqual(result.updatedProviders, []);
    assert.deepEqual(result.addedProviders, []);
    assert.deepEqual(result.skippedProviders, ["opencode-go"]);
    assert.equal(result.authChanged, false);
  });

  it("bridgedProviders (backward-compat) = added + updated", async () => {
    await writeOpenCodeAuth(s, {
      "opencode-go": { type: "api", key: "go-key" },
    });
    await writePiAuth(s, {
      "opencode-go": { type: "api_key", key: "old-go" },
    });

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.deepEqual(result.bridgedProviders, ["opencode-go"]);
  });
});

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

describe("auth-bridge — change detection", () => {
  let s: Sandbox;
  beforeEach(async () => { s = await makeSandbox(); });
  afterEach(async () => { await cleanup(s); });

  it("does not rewrite Pi auth when nothing changed (force=false)", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "k1" } });

    // First bridge to populate metadata.
    await bridgeOpenCodeAuthForProject(s.projectRoot);
    const piStatBefore = await stat(s.piAuthPath);
    const mtimeBefore = piStatBefore.mtimeMs;

    // Small delay so mtime would change if rewritten.
    await new Promise(r => setTimeout(r, 30));

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.equal(result.skipped, true);
    assert.equal(result.authChanged, false);
    assert.equal(result.metadataChanged, false);

    const piStatAfter = await stat(s.piAuthPath);
    assert.equal(piStatAfter.mtimeMs, mtimeBefore, "Pi auth file should not be rewritten");
  });

  it("force=true bypasses change detection and re-runs the bridge", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "k1" } });

    await bridgeOpenCodeAuthForProject(s.projectRoot);
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot, undefined, { force: true });

    assert.equal(result.skipped, false);
  });

  it("re-bridges when OpenCode auth file hash changes", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await bridgeOpenCodeAuthForProject(s.projectRoot);

    // Rotate the key in OpenCode.
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k2" } });
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);

    assert.equal(result.skipped, false);
    assert.deepEqual(result.updatedProviders, ["opencode-go"]);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "k2");
  });
});

// ---------------------------------------------------------------------------
// Safe provider removal
// ---------------------------------------------------------------------------

describe("auth-bridge — safe provider removal", () => {
  let s: Sandbox;
  beforeEach(async () => { s = await makeSandbox(); });
  afterEach(async () => { await cleanup(s); });

  it("removes a stale managed provider absent from OpenCode auth", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await bridgeOpenCodeAuthForProject(s.projectRoot);

    // Now remove the credential from OpenCode.
    await writeOpenCodeAuth(s, {});

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.deepEqual(result.removedProviders, ["opencode-go"]);
    assert.equal(result.authChanged, true);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"], undefined);

    // Metadata should no longer list it as managed.
    const meta = await readProviderNamespacesMetadata(s.projectRoot);
    assert.equal(meta?.managedProviders["opencode-go"], undefined);
  });

  it("leaves an unrelated, non-managed Pi provider alone", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    // Pi has an extra provider the bridge never managed.
    await writePiAuth(s, {
      "opencode-go": { type: "api_key", key: "k1" },
      "manual-provider": { type: "api_key", key: "user-secret" },
    });

    await bridgeOpenCodeAuthForProject(s.projectRoot);

    // Remove opencode-go from OpenCode; the bridge should remove only
    // opencode-go (managed) and keep manual-provider.
    await writeOpenCodeAuth(s, {});
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);

    assert.deepEqual(result.removedProviders, ["opencode-go"]);
    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["manual-provider"]?.key, "user-secret");
  });

  it("does not remove a managed provider whose Pi key was manually changed", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await bridgeOpenCodeAuthForProject(s.projectRoot);

    // User manually changes the Pi key away from what the bridge recorded.
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "user-override" } });
    // And removes it from OpenCode.
    await writeOpenCodeAuth(s, {});

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.deepEqual(result.removedProviders, []);
    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "user-override");
  });

  it("removeStale=false keeps stale managed providers in Pi auth", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await bridgeOpenCodeAuthForProject(s.projectRoot);

    await writeOpenCodeAuth(s, {});
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot, undefined, {
      removeStale: false,
    });

    assert.deepEqual(result.removedProviders, []);
    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "k1");
  });
});

// ---------------------------------------------------------------------------
// Metadata missing / corrupt
// ---------------------------------------------------------------------------

describe("auth-bridge — missing/corrupt metadata", () => {
  let s: Sandbox;
  beforeEach(async () => { s = await makeSandbox(); });
  afterEach(async () => { await cleanup(s); });

  it("does not delete existing Pi providers when metadata is missing", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    // Pi has a provider with no metadata file present yet.
    await writePiAuth(s, {
      "opencode-go": { type: "api_key", key: "k1" },
      "manual-provider": { type: "api_key", key: "user-secret" },
    });

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.deepEqual(result.removedProviders, []);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["manual-provider"]?.key, "user-secret");
  });

  it("does not delete existing Pi providers when metadata is corrupt", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "k1" } });
    await writePiAuth(s, {
      "opencode-go": { type: "api_key", key: "k1" },
      "manual-provider": { type: "api_key", key: "user-secret" },
    });
    // Write a corrupt metadata file.
    await mkdir(join(s.projectRoot, ".ratel"), { recursive: true });
    await writeFile(s.metaPath, "{ not valid json", "utf-8");

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.deepEqual(result.removedProviders, []);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["manual-provider"]?.key, "user-secret");
  });

  it("still updates/adds relevant OpenCode providers when metadata is corrupt", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "new-key" } });
    await writePiAuth(s, { "opencode-go": { type: "api_key", key: "old-key" } });
    await mkdir(join(s.projectRoot, ".ratel"), { recursive: true });
    await writeFile(s.metaPath, "{ not valid json", "utf-8");

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);
    assert.deepEqual(result.updatedProviders, ["opencode-go"]);

    const pi = await readPiAuth(s.piAuthPath);
    assert.equal(pi["opencode-go"]?.key, "new-key");
  });
});

// ---------------------------------------------------------------------------
// Metadata security + backward compatibility
// ---------------------------------------------------------------------------

describe("auth-bridge — metadata security & backward compatibility", () => {
  let s: Sandbox;
  beforeEach(async () => { s = await makeSandbox(); });
  afterEach(async () => { await cleanup(s); });

  it("stores key hashes and managed provider IDs in metadata, not raw keys", async () => {
    await writeOpenCodeAuth(s, { "opencode-go": { type: "api", key: "super-secret-key" } });
    await bridgeOpenCodeAuthForProject(s.projectRoot);

    const raw = await readFile(s.metaPath, "utf-8");
    assert.ok(!raw.includes("super-secret-key"), "metadata must not contain raw key");

    const meta = await readProviderNamespacesMetadata(s.projectRoot);
    const entry = meta?.managedProviders["opencode-go"];
    assert.ok(entry, "managed provider entry should exist");
    assert.equal(entry?.keyHash, hashApiKey("super-secret-key"));
    assert.ok(entry?.lastBridgedAt);
  });

  it("preserves backward-compatible fields (openCodeProviderIds, bridgedProviderIds, bridgedAt)", async () => {
    await writeOpenCodeAuth(s, {
      "opencode-go": { type: "api", key: "k1" },
      "other-prov": { type: "api", key: "k2" },
    });
    await bridgeOpenCodeAuthForProject(s.projectRoot);

    const meta = await readProviderNamespacesMetadata(s.projectRoot);
    assert.ok(meta);
    assert.ok(Array.isArray(meta?.openCodeProviderIds));
    assert.ok((meta?.openCodeProviderIds ?? []).includes("opencode-go"));
    assert.ok((meta?.openCodeProviderIds ?? []).includes("other-prov"));
    assert.ok(Array.isArray(meta?.bridgedProviderIds));
    assert.ok((meta?.bridgedProviderIds ?? []).includes("opencode-go"));
    assert.ok(typeof meta?.bridgedAt === "string" && meta!.bridgedAt.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Provider namespace detection (project + extra providers)
// ---------------------------------------------------------------------------

describe("auth-bridge — provider namespace detection", () => {
  let s: Sandbox;
  beforeEach(async () => { s = await makeSandbox(); });
  afterEach(async () => { await cleanup(s); });

  it("only bridges providers relevant to the project + extra ids", async () => {
    // Project uses opencode-go; OpenCode also has an unrelated provider.
    await writeOpenCodeAuth(s, {
      "opencode-go": { type: "api", key: "k1" },
      "unrelated-prov": { type: "api", key: "k2" },
    });

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot);

    assert.deepEqual(result.addedProviders, ["opencode-go"]);
    assert.ok(!result.bridgedProviders.includes("unrelated-prov"));
    // openCodeProviderIds still surfaces everything OpenCode has.
    assert.deepEqual(result.openCodeProviderIds, ["opencode-go", "unrelated-prov"]);
  });

  it("bridges extra provider ids supplied by the caller", async () => {
    await writeOpenCodeAuth(s, {
      "opencode-go": { type: "api", key: "k1" },
      "extra-prov": { type: "api", key: "k2" },
    });

    const result = await bridgeOpenCodeAuthForProject(s.projectRoot, ["extra-prov"]);
    assert.deepEqual(result.addedProviders.sort(), ["extra-prov", "opencode-go"]);
  });

  it("extra provider id change triggers a re-bridge even with same OpenCode auth", async () => {
    await writeOpenCodeAuth(s, {
      "opencode-go": { type: "api", key: "k1" },
      "extra-prov": { type: "api", key: "k2" },
    });
    await bridgeOpenCodeAuthForProject(s.projectRoot, ["opencode-go"]);

    // Same OpenCode auth file, but now we ask for an extra provider.
    const result = await bridgeOpenCodeAuthForProject(s.projectRoot, ["extra-prov"]);
    assert.equal(result.skipped, false);
    assert.ok(result.addedProviders.includes("extra-prov"));
  });
});

// ---------------------------------------------------------------------------
// Path resolvers (env overrides)
// ---------------------------------------------------------------------------

describe("auth-bridge — path resolvers", () => {
  it("resolveOpenCodeAuthPath honors XDG_DATA_HOME", () => {
    const prev = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/tmp/xdgtest-xyz";
      const p = resolveOpenCodeAuthPath();
      assert.equal(p, join("/tmp/xdgtest-xyz", "opencode", "auth.json"));
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
    }
  });

  it("resolvePiAuthPath honors PI_AGENT_DIR", () => {
    const prev = process.env.PI_AGENT_DIR;
    try {
      process.env.PI_AGENT_DIR = "/tmp/pitest-xyz";
      const p = resolvePiAuthPath();
      assert.equal(p, join("/tmp/pitest-xyz", "auth.json"));
    } finally {
      if (prev === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = prev;
    }
  });
});
