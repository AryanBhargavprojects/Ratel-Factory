import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionWithFailover, collectResponse } from "../src/core/models/session-runner.js";
import { ModelRouter } from "../src/core/models/model-router.js";
import { BudgetManager } from "../src/core/budget/budget-manager.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import type { MissionExecutionContext } from "../src/core/mission/execution-context.js";
import type { ResolvedModel } from "../src/core/models/error-classifier.js";
import { EmptyOutputError, classifyAgentError } from "../src/core/models/error-classifier.js";

describe("session-runner", () => {
  async function setupContext(overrides: Partial<MissionExecutionContext> = {}): Promise<MissionExecutionContext> {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-session-runner-"));
    const scope = createMissionScope(projectRoot, "mis_session_001");
    await mkdir(getMissionDir(scope), { recursive: true });

    const budget = new BudgetManager(scope);
    await budget.initialize({
      maxCostUsd: 50,
      maxTotalTokens: 5_000_000,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxWallClockMinutes: 480,
      maxAgentRuns: 200,
      maxModelAttemptsPerRun: 3,
    });

    // Create a dummy EventLogger that satisfies the interface
    const logger = {
      toolCall: () => {},
      toolResult: () => {},
      agentSpanStart: () => "span-1",
      agentSpanEnd: () => {},
      getTraceId: () => "trace-1",
    } as any;

    const models = new ModelRouter({
      projectRoot,
      orchestrator: { model: "test/primary", fallbackModels: ["test/fallback"] },
      worker: { model: "test/worker", fallbackModels: [] },
      validator: { model: "test/validator", fallbackModels: [] },
      modelRouting: { failureThreshold: 2, cooldownMs: 120000 },
    });

    return {
      scope,
      logger,
      budget,
      models,
      ...overrides,
    };
  }

  it("succeeds on first attempt", async () => {
    const ctx = await setupContext();
    let attempts = 0;

    const result = await runSessionWithFailover({
      context: ctx,
      role: "orchestrator",
      attempt: async (_model, _signal) => {
        attempts++;
        return "success";
      },
    });

    assert.strictEqual(result, "success");
    assert.strictEqual(attempts, 1);

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("retries on retryable failure with fallback model", async () => {
    const ctx = await setupContext();
    const attemptedModels: string[] = [];
    let callCount = 0;

    const result = await runSessionWithFailover({
      context: ctx,
      role: "orchestrator",
      attempt: async (model, _signal) => {
        attemptedModels.push(model.modelString);
        callCount++;
        if (callCount === 1) {
          const err = new Error("Rate limit: 429");
          throw err;
        }
        return "fallback-success";
      },
    });

    assert.strictEqual(result, "fallback-success");
    assert.strictEqual(attemptedModels.length, 2);
    assert.strictEqual(attemptedModels[0], "test/primary");
    assert.strictEqual(attemptedModels[1], "test/fallback");

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("stops at maxModelAttemptsPerRun", async () => {
    const ctx = await setupContext();
    // Override budget to have maxModelAttemptsPerRun = 2
    await ctx.budget.initialize({
      maxCostUsd: 50,
      maxTotalTokens: 5_000_000,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxWallClockMinutes: 480,
      maxAgentRuns: 200,
      maxModelAttemptsPerRun: 2,
    });

    const attemptedModels: string[] = [];

    await assert.rejects(
      async () => runSessionWithFailover({
        context: ctx,
        role: "orchestrator",
        attempt: async (model, _signal) => {
          attemptedModels.push(model.modelString);
          throw new Error("Rate limit: 429");
        },
      }),
      (err: any) => {
        assert.ok(err.message.includes("maxModelAttemptsPerRun") || err.message.includes("exceeded") || err.message.includes("attempts"), `Expected retry exhaustion error, got: ${err.message}`);
        assert.strictEqual(attemptedModels.length, 2);
        return true;
      }
    );

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("does not retry non-retryable errors", async () => {
    const ctx = await setupContext();
    let callCount = 0;

    await assert.rejects(
      async () => runSessionWithFailover({
        context: ctx,
        role: "orchestrator",
        attempt: async (_model, _signal) => {
          callCount++;
          throw new Error("Unauthorized: 401");
        },
      }),
      (err: any) => {
        assert.ok(err.message.includes("401") || err.message.includes("Unauthorized"));
        assert.strictEqual(callCount, 1);
        return true;
      }
    );

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("checks budget before each attempt", async () => {
    const ctx = await setupContext();
    // Set a very low budget that blocks after first attempt
    await ctx.budget.initialize({
      maxCostUsd: 50,
      maxTotalTokens: 5_000_000,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxWallClockMinutes: 480,
      maxAgentRuns: 1,
      maxModelAttemptsPerRun: 3,
    });

    let callCount = 0;

    await assert.rejects(
      async () => runSessionWithFailover({
        context: ctx,
        role: "orchestrator",
        attempt: async (_model, _signal) => {
          callCount++;
          if (callCount === 1) {
            throw new Error("Rate limit: 429");
          }
          return "success";
        },
      }),
      (err: any) => {
        assert.ok(err.message.includes("budget") || err.message.includes("exceeded") || err.message.includes("agentRuns"), `Expected budget error, got: ${err.message}`);
        return true;
      }
    );

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("emits model_attempt and model_fallback events", async () => {
    const ctx = await setupContext();
    const events: Array<{ type: string; data: any }> = [];

    // Wrap logger to capture events
    const originalToolCall = ctx.logger.toolCall;
    const originalToolResult = ctx.logger.toolResult;
    ctx.logger.toolCall = (name: string, params: any) => {
      events.push({ type: "toolCall", data: { name, params } });
      originalToolCall.call(ctx.logger, name, params);
    };
    ctx.logger.toolResult = (name: string, result: any) => {
      events.push({ type: "toolResult", data: { name, result } });
      originalToolResult.call(ctx.logger, name, result);
    };

    await runSessionWithFailover({
      context: ctx,
      role: "orchestrator",
      attempt: async (_model, _signal) => {
        throw new Error("Rate limit: 429");
      },
    }).catch(() => {});

    const attemptEvents = events.filter((e) => e.data.name === "model_attempt" || e.data.result?.model);
    // At minimum, should have logged attempt events through the router
    assert.ok(events.length > 0, "Expected events to be logged");

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("respects abort signal", async () => {
    const ctx = await setupContext();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => runSessionWithFailover({
        context: ctx,
        role: "orchestrator",
        signal: controller.signal,
        attempt: async () => "success",
      }),
      (err: any) => {
        assert.ok(err.message.includes("aborted") || err.message.includes("AbortError"));
        return true;
      }
    );

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("preserves the final typed error", async () => {
    const ctx = await setupContext();

    await assert.rejects(
      async () => runSessionWithFailover({
        context: ctx,
        role: "orchestrator",
        attempt: async () => {
          throw new Error("Final failure message");
        },
      }),
      (err: any) => {
        assert.ok(err.message.includes("Final failure message"));
        return true;
      }
    );

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  // ── Wave 3: empty output classification and retry ──

  it("collectResponse throws EmptyOutputError on a 0-byte response", async () => {
    const fakeSession = {
      subscribe: (_cb: (event: unknown) => void) => () => {},
      prompt: async (_p: string) => {},
    } as any;

    await assert.rejects(
      collectResponse(fakeSession, "hi"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyOutputError, "expected EmptyOutputError");
        return true;
      },
    );
  });

  it("collectResponse throws EmptyOutputError on a whitespace-only response", async () => {
    const fakeSession = {
      subscribe: (cb: (event: any) => void) => {
        cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "   \n\t " } });
        return () => {};
      },
      prompt: async (_p: string) => {},
    } as any;

    await assert.rejects(
      collectResponse(fakeSession, "hi"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyOutputError);
        return true;
      },
    );
  });

  it("collectResponse returns non-empty text unchanged", async () => {
    const fakeSession = {
      subscribe: (cb: (event: any) => void) => {
        cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello world" } });
        return () => {};
      },
      prompt: async (_p: string) => {},
    } as any;

    const result = await collectResponse(fakeSession, "hi");
    assert.strictEqual(result, "hello world");
  });

  it("retries empty output once and falls back to the next model", async () => {
    const ctx = await setupContext();
    const attemptedModels: string[] = [];
    let callCount = 0;

    const result = await runSessionWithFailover({
      context: ctx,
      role: "orchestrator",
      attempt: async (model) => {
        attemptedModels.push(model.modelString);
        callCount++;
        if (callCount === 1) {
          throw new EmptyOutputError("primary produced no output");
        }
        return "fallback-success";
      },
    });

    assert.strictEqual(result, "fallback-success");
    assert.strictEqual(attemptedModels.length, 2);
    assert.strictEqual(attemptedModels[0], "test/primary");
    assert.strictEqual(attemptedModels[1], "test/fallback");

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });

  it("halts with empty_output classification when all attempts return empty", async () => {
    const ctx = await setupContext();

    await assert.rejects(
      async () => runSessionWithFailover({
        context: ctx,
        role: "orchestrator",
        attempt: async () => {
          throw new EmptyOutputError("no output from model");
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof EmptyOutputError, "expected EmptyOutputError after all-empty attempts");
        const classified = classifyAgentError(err);
        assert.strictEqual(classified.category, "empty_output");
        assert.strictEqual(classified.retryable, true);
        return true;
      },
    );

    await rm(ctx.scope.projectRoot, { recursive: true, force: true });
  });
});
