/**
 * Tests for model registry awareness in config.ts.
 *
 * Covers:
 *  - resolveModelSlug: validation, alias normalization, rejection
 *  - setModelConfig: rejects unknown, normalizes aliases, persists canonical
 *  - getFallbackModelConfig: warns on unknown, filters invalid
 *  - listAvailableModels: refresh, canonical slugs, auth metadata
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We import from source (not dist) so tsx can resolve them.
import {
  resolveModelSlug,
  setModelConfig,
  getModelConfig,
  getFallbackModelConfig,
  listAvailableModels,
  getDefaultAgentDir,
} from "../src/core/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a temporary agent directory with a models.json that registers
 * provider "openai-codex" with model "gpt-5.4" (and no "openai" provider).
 * Also includes a known built-in provider (anthropic) so the registry
 * has at least one real model for listAvailableModels tests.
 */
async function setupAgentDirWithModelsJson(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "ratel-agent-"));
  const modelsJson = {
    providers: {
      "openai-codex": {
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            reasoning: true,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 16384,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
          {
            id: "ratel-custom-test-model",
            name: "Ratel Custom Test Model",
            reasoning: false,
            input: ["text"],
            contextWindow: 64000,
            maxTokens: 8192,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        ],
      },
    },
  };
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify(modelsJson, null, 2),
    "utf-8",
  );
  return agentDir;
}

/**
 * Create a temporary project directory with an optional ratel.json.
 */
async function setupProjectDir(ratelConfig?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratel-project-"));
  if (ratelConfig) {
    await writeFile(
      join(dir, "ratel.json"),
      JSON.stringify(ratelConfig, null, 2),
      "utf-8",
    );
  }
  return dir;
}

// ── resolveModelSlug ─────────────────────────────────────────────────────

describe("resolveModelSlug", () => {
  let agentDir: string;

  before(async () => {
    agentDir = await setupAgentDirWithModelsJson();
  });

  after(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("resolves an exact registry match to canonical slug", () => {
    const result = resolveModelSlug("openai-codex/gpt-5.4", agentDir);
    assert.ok(result, "should resolve");
    assert.strictEqual(result!.canonical, "openai-codex/gpt-5.4");
    assert.strictEqual(result!.model.provider, "openai-codex");
    assert.strictEqual(result!.model.id, "gpt-5.4");
    assert.strictEqual(result!.warning, undefined);
  });

  it("normalizes alias openai -> openai-codex when target exists", () => {
    // Use a model ID that only exists under openai-codex (custom), not in built-in openai.
    const result = resolveModelSlug("openai/ratel-custom-test-model", agentDir);
    assert.ok(result, "should normalize alias");
    assert.strictEqual(result!.canonical, "openai-codex/ratel-custom-test-model");
    assert.strictEqual(result!.model.provider, "openai-codex");
    assert.strictEqual(result!.model.id, "ratel-custom-test-model");
    assert.ok(
      result!.warning?.includes("openai-codex"),
      "warning should mention canonical provider",
    );
  });

  it("returns undefined for unknown provider/model", () => {
    const result = resolveModelSlug("unknown-provider/some-model", agentDir);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for invalid format (no slash)", () => {
    const result = resolveModelSlug("just-a-string", agentDir);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for empty string", () => {
    const result = resolveModelSlug("", agentDir);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for null", () => {
    const result = resolveModelSlug(null, agentDir);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for undefined", () => {
    const result = resolveModelSlug(undefined, agentDir);
    assert.strictEqual(result, undefined);
  });

  it("does not normalize alias when aliased provider/model does not exist", () => {
    // "openai/nonexistent" — openai-codex/nonexistent doesn't exist either
    const result = resolveModelSlug("openai/nonexistent-model", agentDir);
    assert.strictEqual(result, undefined);
  });

  it("does not normalize alias when aliased provider does not exist at all", () => {
    // "azure/gpt-5.4" — azure is not in the alias map, and azure/gpt-5.4 is not in registry
    const result = resolveModelSlug("azure/gpt-5.4", agentDir);
    assert.strictEqual(result, undefined);
  });
});

// ── setModelConfig validation ────────────────────────────────────────────

describe("setModelConfig with registry validation", () => {
  let agentDir: string;

  before(async () => {
    agentDir = await setupAgentDirWithModelsJson();
  });

  after(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("persists a valid model string", async () => {
    const projectDir = await setupProjectDir();
    try {
      await setModelConfig(projectDir, "orchestrator", "openai-codex/gpt-5.4", agentDir);
      const config = await getModelConfig(projectDir);
      assert.strictEqual(config.orchestrator, "openai-codex/gpt-5.4");

      // Verify ratel.json on disk
      const raw = JSON.parse(await readFile(join(projectDir, "ratel.json"), "utf-8"));
      assert.strictEqual(raw.orchestrator.model, "openai-codex/gpt-5.4");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("normalizes alias and persists canonical slug", async () => {
    const projectDir = await setupProjectDir();
    try {
      // Use a model ID unique to openai-codex custom provider
      await setModelConfig(projectDir, "worker", "openai/ratel-custom-test-model", agentDir);
      const config = await getModelConfig(projectDir);
      // Should have been normalized to openai-codex/ratel-custom-test-model
      assert.strictEqual(config.worker, "openai-codex/ratel-custom-test-model");

      const raw = JSON.parse(await readFile(join(projectDir, "ratel.json"), "utf-8"));
      assert.strictEqual(raw.workers.model, "openai-codex/ratel-custom-test-model");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown model string and does not write", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: { model: "anthropic/claude-sonnet-4" },
    });
    try {
      await assert.rejects(
        setModelConfig(projectDir, "orchestrator", "unknown-provider/bogus-model", agentDir),
        /not found in the model registry/i,
      );

      // ratel.json should be unchanged
      const raw = JSON.parse(await readFile(join(projectDir, "ratel.json"), "utf-8"));
      assert.strictEqual(raw.orchestrator.model, "anthropic/claude-sonnet-4");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid format string and does not write", async () => {
    const projectDir = await setupProjectDir();
    try {
      await assert.rejects(
        setModelConfig(projectDir, "validator", "no-slash-here", agentDir),
        /not a valid model slug/i,
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("allows null to clear (revert to SDK default)", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: { model: "openai-codex/gpt-5.4" },
    });
    try {
      await setModelConfig(projectDir, "orchestrator", null, agentDir);
      const config = await getModelConfig(projectDir);
      assert.strictEqual(config.orchestrator, null);

      const raw = JSON.parse(await readFile(join(projectDir, "ratel.json"), "utf-8"));
      assert.strictEqual(raw.orchestrator.model, null);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ── getFallbackModelConfig validation ────────────────────────────────────

describe("getFallbackModelConfig with registry validation", () => {
  let agentDir: string;

  before(async () => {
    agentDir = await setupAgentDirWithModelsJson();
  });

  after(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("passes through valid model strings unchanged", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: { model: "openai-codex/gpt-5.4", fallbackModels: [] },
    });
    try {
      const config = await getFallbackModelConfig(projectDir, agentDir);
      assert.strictEqual(config.orchestrator.model, "openai-codex/gpt-5.4");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("normalizes alias in primary model", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: { model: "openai/ratel-custom-test-model", fallbackModels: [] },
    });
    try {
      const config = await getFallbackModelConfig(projectDir, agentDir);
      // Should normalize the alias
      assert.strictEqual(config.orchestrator.model, "openai-codex/ratel-custom-test-model");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("warns and filters unknown primary model to null", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: { model: "unknown/bogus", fallbackModels: [] },
    });
    try {
      const config = await getFallbackModelConfig(projectDir, agentDir);
      // Unknown model should be nulled out (fall back to SDK default)
      assert.strictEqual(config.orchestrator.model, null);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("warns and filters unknown fallback models", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: {
        model: "openai-codex/gpt-5.4",
        fallbackModels: ["unknown/bogus", "also-bad/string"],
      },
    });
    try {
      const config = await getFallbackModelConfig(projectDir, agentDir);
      assert.strictEqual(config.orchestrator.model, "openai-codex/gpt-5.4");
      assert.deepStrictEqual(config.orchestrator.fallbackModels, []);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("normalizes aliases in fallback models", async () => {
    const projectDir = await setupProjectDir({
      orchestrator: {
        model: "openai-codex/ratel-custom-test-model",
        fallbackModels: ["openai/ratel-custom-test-model"],
      },
    });
    try {
      const config = await getFallbackModelConfig(projectDir, agentDir);
      // The fallback "openai/ratel-custom-test-model" should be normalized to
      // "openai-codex/ratel-custom-test-model" but since it duplicates the primary,
      // it should be removed by deduplication
      assert.deepStrictEqual(config.orchestrator.fallbackModels, []);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves null primary as SDK default", async () => {
    const projectDir = await setupProjectDir({});
    try {
      const config = await getFallbackModelConfig(projectDir, agentDir);
      assert.strictEqual(config.orchestrator.model, null);
      assert.deepStrictEqual(config.orchestrator.fallbackModels, []);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ── listAvailableModels ──────────────────────────────────────────────────

describe("listAvailableModels", () => {
  let agentDir: string;

  before(async () => {
    agentDir = await setupAgentDirWithModelsJson();
  });

  after(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("returns models with canonical slug fields", async () => {
    const projectDir = await setupProjectDir();
    try {
      const models = await listAvailableModels(projectDir, agentDir);
      assert.ok(models.length > 0, "should return at least one model");

      // Every model should have provider, id, name, hasAuth, and canonical
      for (const m of models) {
        assert.ok(typeof m.provider === "string", "provider should be string");
        assert.ok(typeof m.id === "string", "id should be string");
        assert.ok(typeof m.name === "string", "name should be string");
        assert.ok(typeof m.hasAuth === "boolean", "hasAuth should be boolean");
        assert.ok(typeof m.canonical === "string", "canonical should be string");
        assert.strictEqual(m.canonical, `${m.provider}/${m.id}`);
      }

      // Should include our custom openai-codex/gpt-5.4
      const customModel = models.find(
        (m) => m.provider === "openai-codex" && m.id === "gpt-5.4",
      );
      assert.ok(customModel, "should include openai-codex/gpt-5.4");
      assert.strictEqual(customModel!.canonical, "openai-codex/gpt-5.4");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("refreshes registry before listing", async () => {
    const projectDir = await setupProjectDir();
    try {
      // First call
      const models1 = await listAvailableModels(projectDir, agentDir);
      const count1 = models1.length;

      // Second call should still work (refresh is idempotent)
      const models2 = await listAvailableModels(projectDir, agentDir);
      assert.strictEqual(models2.length, count1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
