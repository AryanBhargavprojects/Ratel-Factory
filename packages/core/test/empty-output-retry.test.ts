import { describe, it } from "node:test";
import assert from "node:assert";
import {
  collectResponse,
  collectResponseWithRetry,
} from "../src/core/models/session-runner.js";
import {
  EmptyOutputError,
  classifyAgentError,
} from "../src/core/models/error-classifier.js";
import { extractLastJsonLine } from "../src/core/utils/jsonl.js";
import type { WorkerHandoff } from "../src/core/types.js";

describe("empty-output retry (Issue #3) — collectResponseWithRetry", () => {
  it("first empty then non-empty returns non-empty and prompts exactly twice", async () => {
    let promptCalls = 0;
    let currentCb: ((event: unknown) => void) | null = null;
    const session: any = {
      subscribe(cb: (event: unknown) => void) {
        currentCb = cb;
        return () => { currentCb = null; };
      },
      async prompt(_p: string) {
        promptCalls++;
        const cb = currentCb;
        if (cb) {
          const deltas = promptCalls === 1 ? "" : "hello world";
          if (deltas.length > 0) {
            cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: deltas } });
          }
        }
      },
      dispose() {},
    };
    const result = await collectResponseWithRetry(session, "hi");
    assert.strictEqual(result, "hello world");
    assert.strictEqual(promptCalls, 2, "expected exactly two prompt attempts");
  });

  it("non-empty first attempt returns immediately with one prompt", async () => {
    let promptCalls = 0;
    let currentCb: ((event: unknown) => void) | null = null;
    const session: any = {
      subscribe(cb: (event: unknown) => void) {
        currentCb = cb;
        return () => { currentCb = null; };
      },
      async prompt(_p: string) {
        promptCalls++;
        const cb = currentCb;
        if (cb) {
          cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "immediate" } });
        }
      },
      dispose() {},
    };
    const result = await collectResponseWithRetry(session, "hi");
    assert.strictEqual(result, "immediate");
    assert.strictEqual(promptCalls, 1, "should not retry when first attempt is non-empty");
  });

  it("empty twice throws EmptyOutputError (classified empty_output)", async () => {
    let promptCalls = 0;
    let currentCb: ((event: unknown) => void) | null = null;
    const session: any = {
      subscribe(cb: (event: unknown) => void) {
        currentCb = cb;
        return () => { currentCb = null; };
      },
      async prompt(_p: string) {
        promptCalls++;
        // Always emit nothing (0-byte).
        void currentCb;
      },
      dispose() {},
    };
    await assert.rejects(
      collectResponseWithRetry(session, "hi"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyOutputError, "expected EmptyOutputError after two empty attempts");
        const classified = classifyAgentError(err);
        assert.strictEqual(classified.category, "empty_output");
        assert.strictEqual(classified.retryable, true);
        return true;
      },
    );
    assert.strictEqual(promptCalls, 2, "expected exactly two prompt attempts before giving up");
  });

  it("whitespace-only is treated as empty (throws EmptyOutputError, retried)", async () => {
    let promptCalls = 0;
    let currentCb: ((event: unknown) => void) | null = null;
    const session: any = {
      subscribe(cb: (event: unknown) => void) {
        currentCb = cb;
        return () => { currentCb = null; };
      },
      async prompt(_p: string) {
        promptCalls++;
        const cb = currentCb;
        if (cb) {
          cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "   \n\t " } });
        }
      },
      dispose() {},
    };
    await assert.rejects(
      collectResponseWithRetry(session, "hi"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyOutputError);
        const classified = classifyAgentError(err);
        assert.strictEqual(classified.category, "empty_output");
        return true;
      },
    );
    assert.strictEqual(promptCalls, 2);
  });

  it("non-retryable errors propagate unchanged (no retry)", async () => {
    let promptCalls = 0;
    const session: any = {
      subscribe() { return () => {}; },
      async prompt(_p: string) {
        promptCalls++;
        throw new Error("Unauthorized: 401");
      },
      dispose() {},
    };
    await assert.rejects(
      collectResponseWithRetry(session, "hi"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes("401"));
        return true;
      },
    );
    assert.strictEqual(promptCalls, 1, "non-empty/non-EmptyOutput errors must not trigger retry");
  });
});

describe("empty-output retry (Issue #3) — parse_failure separation", () => {
  /** Structural guard matching worker.ts isValidHandoff (subset). */
  function isValidHandoff(obj: unknown): obj is WorkerHandoff {
    if (!obj || typeof obj !== "object") return false;
    const h = obj as Record<string, unknown>;
    return (
      typeof h.featureId === "string" &&
      typeof h.completedAt === "string" &&
      Array.isArray(h.completed) &&
      Array.isArray(h.leftUndone) &&
      Array.isArray(h.commandsRun) &&
      Array.isArray(h.issuesDiscovered) &&
      typeof h.proceduresAbided === "boolean" &&
      typeof h.summary === "string"
    );
  }

  it("non-empty malformed output stays parse_failure, NOT empty_output", async () => {
    // A non-empty but malformed response must be returned by
    // collectResponseWithRetry (no EmptyOutputError) and then parse as
    // parseStatus "failed" via extractLastJsonLine — i.e. parse_failure,
    // not empty_output.
    let promptCalls = 0;
    let currentCb: ((event: unknown) => void) | null = null;
    const malformed = "Here is my handoff: {not valid json";
    const session: any = {
      subscribe(cb: (event: unknown) => void) {
        currentCb = cb;
        return () => { currentCb = null; };
      },
      async prompt(_p: string) {
        promptCalls++;
        const cb = currentCb;
        if (cb) {
          cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: malformed } });
        }
      },
      dispose() {},
    };

    const response = await collectResponseWithRetry(session, "hi");
    assert.strictEqual(promptCalls, 1, "non-empty output should not trigger retry");
    assert.strictEqual(response, malformed);
    assert.ok(response.trim().length > 0, "response is non-empty so not empty_output");

    const parseResult = extractLastJsonLine<WorkerHandoff>(response, isValidHandoff);
    assert.strictEqual(parseResult.parseStatus, "failed");
    assert.strictEqual(parseResult.data, null);
  });

  it("non-empty valid JSONL handoff parses as ok (not empty_output, not parse_failure)", async () => {
    const validHandoff: WorkerHandoff = {
      featureId: "F-1",
      completedAt: new Date().toISOString(),
      completed: ["did thing"],
      leftUndone: [],
      commandsRun: ["npm test"],
      issuesDiscovered: [],
      proceduresAbided: true,
      summary: "done",
    };
    const response = JSON.stringify(validHandoff);
    const parseResult = extractLastJsonLine<WorkerHandoff>(response, isValidHandoff);
    assert.strictEqual(parseResult.parseStatus, "ok");
    assert.ok(parseResult.data);
    assert.strictEqual(parseResult.data!.featureId, "F-1");
  });
});

describe("empty-output retry (Issue #3) — collectResponse base helper", () => {
  it("collectResponse throws EmptyOutputError on 0-byte response", async () => {
    const session: any = {
      subscribe() { return () => {}; },
      async prompt() {},
      dispose() {},
    };
    await assert.rejects(
      collectResponse(session, "hi"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyOutputError);
        return true;
      },
    );
  });
});
