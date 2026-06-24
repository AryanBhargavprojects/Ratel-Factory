import { describe, it } from "node:test";
import assert from "node:assert";
import { runModelPreflight } from "../src/core/mission/model-preflight.js";
import type {
  ModelPreflightDeps,
  ResolvedModelAuth,
} from "../src/core/mission/model-preflight.js";
import type { FallbackModelConfig } from "../src/core/config.js";
import type { AgentRole } from "../src/core/models/model-router.js";

function roleConfig(model: string | null, fallbackModels: string[] = []): FallbackModelConfig {
  return { model, fallbackModels };
}

function fullConfig(
  orchestrator: FallbackModelConfig,
  worker: FallbackModelConfig,
  validator: FallbackModelConfig,
): {
  orchestrator: FallbackModelConfig;
  worker: FallbackModelConfig;
  validator: FallbackModelConfig;
} {
  return { orchestrator, worker, validator };
}

/** Build a deps override with a fake getConfig and fake resolveModelAuth. */
function makeDeps(
  config: ReturnType<typeof fullConfig>,
  resolve: (slug: string | null) => ResolvedModelAuth,
): ModelPreflightDeps {
  return {
    getConfig: async () => config,
    resolveModelAuth: resolve,
  };
}

describe("model-preflight", () => {
  it("returns ok with resolvedModels when every role resolves with auth", async () => {
    const config = fullConfig(
      roleConfig("anthropic/claude-sonnet-4", ["openai-codex/gpt-5.4"]),
      roleConfig("openai-codex/gpt-5.4"),
      roleConfig("anthropic/claude-sonnet-4"),
    );
    const deps = makeDeps(config, (slug) => {
      assert.ok(slug, "primary models are non-null in this scenario");
      return { canonical: slug, hasAuth: true, resolved: true };
    });

    const result = await runModelPreflight("/tmp/ratel-preflight-ok", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.noTokensConsumed, true);
    assert.strictEqual(result.problems.length, 0);
    assert.strictEqual(result.resolvedModels.length, 3);
    const roles = result.resolvedModels.map((r) => r.role);
    assert.deepEqual(roles.sort(), ["orchestrator", "validator", "worker"]);
    for (const r of result.resolvedModels) {
      assert.strictEqual(r.hasAuth, true);
    }
  });

  it("uses the SDK default (null primary, no fallbacks) when it resolves with auth", async () => {
    const config = fullConfig(roleConfig(null), roleConfig(null), roleConfig(null));
    const deps = makeDeps(config, (slug) => {
      assert.strictEqual(slug, null);
      return { canonical: "sdk-default/model", hasAuth: true, resolved: true };
    });

    const result = await runModelPreflight("/tmp/ratel-preflight-default", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.resolvedModels.length, 3);
    for (const r of result.resolvedModels) {
      assert.strictEqual(r.canonical, "sdk-default/model");
      assert.strictEqual(r.hasAuth, true);
    }
  });

  it("reports missing_config when no model is configured and no SDK default resolves", async () => {
    const config = fullConfig(roleConfig(null), roleConfig(null), roleConfig(null));
    const deps = makeDeps(config, () => ({
      canonical: null,
      hasAuth: false,
      resolved: false,
    }));

    const result = await runModelPreflight("/tmp/ratel-preflight-missing", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.noTokensConsumed, true);
    assert.strictEqual(result.problems.length, 3);
    for (const p of result.problems) {
      assert.strictEqual(p.code, "missing_config");
    }
    assert.strictEqual(result.resolvedModels.length, 0);
  });

  it("reports adapter_auth_failure when a configured model resolves but lacks credentials", async () => {
    const config = fullConfig(
      roleConfig("anthropic/claude-sonnet-4"),
      roleConfig("openai-codex/gpt-5.4"),
      roleConfig("anthropic/claude-sonnet-4"),
    );
    const deps = makeDeps(config, (slug) => {
      assert.ok(slug);
      return { canonical: slug, hasAuth: false, resolved: true };
    });

    const result = await runModelPreflight("/tmp/ratel-preflight-noauth", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.problems.length, 3);
    for (const p of result.problems) {
      assert.strictEqual(p.code, "adapter_auth_failure");
      assert.ok(p.model);
    }
  });

  it("reports unresolved_model for unknown slugs and falls back to a valid fallback", async () => {
    const config = fullConfig(
      roleConfig("bogus/unknown-model", ["anthropic/claude-sonnet-4"]),
      roleConfig("openai-codex/gpt-5.4"),
      roleConfig("anthropic/claude-sonnet-4"),
    );
    const deps = makeDeps(config, (slug) => {
      if (slug === "bogus/unknown-model") {
        return { canonical: null, hasAuth: false, resolved: false };
      }
      return { canonical: slug!, hasAuth: true, resolved: true };
    });

    const result = await runModelPreflight("/tmp/ratel-preflight-fallback", deps);

    // Orchestrator falls back to anthropic/claude-sonnet-4 → ok overall
    assert.strictEqual(result.ok, false, "unresolved primary should still record a problem");
    assert.ok(
      result.problems.some(
        (p) => p.code === "unresolved_model" && p.model === "bogus/unknown-model" && p.role === "orchestrator",
      ),
    );
    const orch = result.resolvedModels.find((r) => r.role === "orchestrator");
    assert.ok(orch, "orchestrator should have a resolved fallback model");
    assert.strictEqual(orch!.canonical, "anthropic/claude-sonnet-4");
  });

  it("reports missing_config for all roles when getConfig throws", async () => {
    const deps: ModelPreflightDeps = {
      getConfig: async () => {
        throw new Error("ratel.json unreadable");
      },
      resolveModelAuth: () => ({ canonical: null, hasAuth: false, resolved: false }),
    };

    const result = await runModelPreflight("/tmp/ratel-preflight-throw", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.problems.length, 3);
    for (const p of result.problems) {
      assert.strictEqual(p.code, "missing_config");
      assert.match(p.message, /ratel\.json unreadable/);
    }
    assert.strictEqual(result.resolvedModels.length, 0);
  });

  it("reports adapter_auth_failure when SDK default resolves but lacks auth", async () => {
    const config = fullConfig(roleConfig(null), roleConfig(null), roleConfig(null));
    const deps = makeDeps(config, () => ({
      canonical: "sdk-default/model",
      hasAuth: false,
      resolved: true,
    }));

    const result = await runModelPreflight("/tmp/ratel-preflight-default-noauth", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.problems.length, 3);
    for (const p of result.problems) {
      assert.strictEqual(p.code, "adapter_auth_failure");
    }
    // resolvedModels still populated (resolved but no auth) for observability
    assert.strictEqual(result.resolvedModels.length, 3);
    for (const r of result.resolvedModels) {
      assert.strictEqual(r.hasAuth, false);
    }
  });

  it("does not spawn a worker/validator session (no token-consuming side effects)", async () => {
    // The contract: deps entirely drive resolution; no network/spawn occurs.
    let calls = 0;
    const config = fullConfig(
      roleConfig("anthropic/claude-sonnet-4"),
      roleConfig("anthropic/claude-sonnet-4"),
      roleConfig("anthropic/claude-sonnet-4"),
    );
    const deps: ModelPreflightDeps = {
      getConfig: async () => config,
      resolveModelAuth: (slug) => {
        calls += 1;
        return { canonical: slug, hasAuth: true, resolved: true };
      },
    };

    const result = await runModelPreflight("/tmp/ratel-preflight-nospawn", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.noTokensConsumed, true);
    // One resolution call per role (primary resolves immediately, no fallbacks tried).
    assert.strictEqual(calls, 3);
  });
});
