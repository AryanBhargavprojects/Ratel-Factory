import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRouter } from "../src/core/models/model-router.js";
import type { ClassifiedAgentError } from "../src/core/models/error-classifier.js";

async function setupDir() {
  const dir = await mkdtemp(join(tmpdir(), "ratel-model-router-"));
  return dir;
}

describe("ModelRouter", () => {
  it("returns primary model as first candidate", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: ["openai/v1", "openai/v2"] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });

    const candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary", "openai/fallback"]);

    const workerCandidates = await router.getCandidates("worker");
    assert.deepStrictEqual(workerCandidates, ["anthropic/worker"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("removes duplicate fallback models", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["anthropic/primary", "openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });

    const candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary", "openai/fallback"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("opens circuit after failureThreshold retryable failures", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });

    const retryableFailure: ClassifiedAgentError = { retryable: true, category: "rate_limit", original: new Error("429") };

    await router.recordFailure("anthropic/primary", retryableFailure);
    let candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary", "openai/fallback"]);

    await router.recordFailure("anthropic/primary", retryableFailure);
    candidates = await router.getCandidates("orchestrator");
    // After 2 failures, primary should be open (skipped)
    assert.deepStrictEqual(candidates, ["openai/fallback"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("non-retryable errors do not poison model health", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });

    const nonRetryable: ClassifiedAgentError = { retryable: false, category: "auth", original: new Error("401") };

    await router.recordFailure("anthropic/primary", nonRetryable);
    await router.recordFailure("anthropic/primary", nonRetryable);

    const candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary", "openai/fallback"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("after cooldown, allows one half-open probe", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 1, cooldownMs: 50 },
    });

    const retryableFailure: ClassifiedAgentError = { retryable: true, category: "rate_limit", original: new Error("429") };
    await router.recordFailure("anthropic/primary", retryableFailure);

    // Immediately after failure, should be skipped
    let candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["openai/fallback"]);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 100));

    // After cooldown, half-open: primary should be included as a probe
    candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary", "openai/fallback"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("success on half-open probe closes circuit", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 1, cooldownMs: 50 },
    });

    const retryableFailure: ClassifiedAgentError = { retryable: true, category: "rate_limit", original: new Error("429") };
    await router.recordFailure("anthropic/primary", retryableFailure);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 100));

    // Record success on the half-open probe
    await router.recordSuccess("anthropic/primary");

    // Circuit should be closed now
    const candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary", "openai/fallback"]);

    // Another failure should require a fresh threshold count
    await router.recordFailure("anthropic/primary", retryableFailure);
    // Still included because only 1 failure and threshold is 1 but cooldown not reached
    const candidates2 = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates2, ["openai/fallback"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("failure on half-open probe re-opens circuit", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 1, cooldownMs: 50 },
    });

    const retryableFailure: ClassifiedAgentError = { retryable: true, category: "rate_limit", original: new Error("429") };
    await router.recordFailure("anthropic/primary", retryableFailure);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 100));

    // Failure on half-open probe
    await router.recordFailure("anthropic/primary", retryableFailure);

    // Should still be open
    const candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["openai/fallback"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("persists health state to disk", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 1, cooldownMs: 120000 },
    });

    const retryableFailure: ClassifiedAgentError = { retryable: true, category: "rate_limit", original: new Error("429") };
    await router.recordFailure("anthropic/primary", retryableFailure);

    // Verify file was written
    const healthPath = join(dir, ".ratel", "model-health.json");
    const raw = await readFile(healthPath, "utf-8");
    const health = JSON.parse(raw);
    assert.ok(Array.isArray(health.models));
    const primary = health.models.find((m: any) => m.model === "anthropic/primary");
    assert.ok(primary);
    assert.strictEqual(primary.state, "open");
    assert.strictEqual(primary.consecutiveRetryableFailures, 1);

    await rm(dir, { recursive: true, force: true });
  });

  it("rehydrates health state from disk", async () => {
    const dir = await setupDir();
    const ratelDir = join(dir, ".ratel");
    await mkdir(ratelDir, { recursive: true });
    const healthPath = join(ratelDir, "model-health.json");
    await writeFile(healthPath, JSON.stringify({
      models: [{
        model: "anthropic/primary",
        state: "open",
        consecutiveRetryableFailures: 2,
        openedAt: new Date().toISOString(),
        lastFailureAt: new Date().toISOString(),
      }],
    }, null, 2), "utf-8");

    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });
    await router.init();

    const candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["openai/fallback"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("reloadConfig updates candidate list from ratel.json", async () => {
    const dir = await setupDir();
    // Start with a router that has "anthropic/primary" as the orchestrator model.
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: [] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });

    let candidates = await router.getCandidates("orchestrator");
    assert.deepStrictEqual(candidates, ["anthropic/primary"]);

    // Write a ratel.json with a different model. The model string won't
    // resolve in the test registry, so getFallbackModelConfig returns null,
    // which reloadConfig coalesces to "sdk-default".
    await mkdir(join(dir, ".ratel"), { recursive: true });
    await writeFile(join(dir, "ratel.json"), JSON.stringify({
      orchestrator: { model: "nonexistent/fake-model-xyz-test" },
    }, null, 2), "utf-8");

    await router.reloadConfig(dir);

    candidates = await router.getCandidates("orchestrator");
    // "nonexistent/fake-model-xyz-test" won't resolve in the registry → null → "sdk-default"
    assert.deepStrictEqual(candidates, ["sdk-default"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("reloadConfig preserves circuit breaker health", async () => {
    const dir = await setupDir();
    const router = new ModelRouter({
      projectRoot: dir,
      orchestrator: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      worker: { model: "anthropic/worker", fallbackModels: [] },
      validator: { model: "anthropic/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 1, cooldownMs: 120000 },
    });

    // Open the circuit for anthropic/primary
    const retryableFailure: ClassifiedAgentError = { retryable: true, category: "rate_limit", original: new Error("429") };
    await router.recordFailure("anthropic/primary", retryableFailure);

    // Write an empty ratel.json so reloadConfig sets model to "sdk-default"
    await mkdir(join(dir, ".ratel"), { recursive: true });
    await writeFile(join(dir, "ratel.json"), "{}", "utf-8");

    await router.reloadConfig(dir);

    // "sdk-default" has no health entry, so it should be included
    const candidates = await router.getCandidates("orchestrator");
    assert.ok(candidates.includes("sdk-default"));

    // But the health state for "anthropic/primary" should still be persisted
    const healthPath = join(dir, ".ratel", "model-health.json");
    const raw = await readFile(healthPath, "utf-8");
    const health = JSON.parse(raw);
    const primary = health.models.find((m: any) => m.model === "anthropic/primary");
    assert.ok(primary);
    assert.strictEqual(primary.state, "open");

    await rm(dir, { recursive: true, force: true });
  });
});
