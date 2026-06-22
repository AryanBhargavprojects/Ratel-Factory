import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyAgentError,
  isRetryableError,
  EmptyOutputError,
  type ClassifiedAgentError,
} from "../src/core/models/error-classifier.js";

describe("error-classifier", () => {
  describe("classifyAgentError", () => {
    it("classifies HTTP 429 as retryable", () => {
      const err = new Error("Rate limit exceeded: 429");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "rate_limit");
    });

    it("classifies HTTP 500 as retryable", () => {
      const err = new Error("Internal server error: 500");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "server_error");
    });

    it("classifies HTTP 502 as retryable", () => {
      const err = new Error("Bad gateway: 502");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "server_error");
    });

    it("classifies HTTP 503 as retryable", () => {
      const err = new Error("Service unavailable: 503");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "server_error");
    });

    it("classifies HTTP 504 as retryable", () => {
      const err = new Error("Gateway timeout: 504");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "timeout");
    });

    it("classifies 'rate limit' message as retryable", () => {
      const err = new Error("You have exceeded your rate limit");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "rate_limit");
    });

    it("classifies 'overloaded' message as retryable", () => {
      const err = new Error("The server is overloaded");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "server_error");
    });

    it("classifies 'timeout' message as retryable", () => {
      const err = new Error("Request timed out after 30000ms");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "timeout");
    });

    it("classifies ECONNRESET as retryable", () => {
      const err = new Error("Connection reset by peer");
      (err as any).code = "ECONNRESET";
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "network");
    });

    it("classifies 'transient network' as retryable", () => {
      const err = new Error("Transient network error occurred");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "network");
    });

    it("classifies HTTP 400 as non-retryable", () => {
      const err = new Error("Bad request: 400");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "invalid_request");
    });

    it("classifies HTTP 401 as non-retryable", () => {
      const err = new Error("Unauthorized: 401");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "auth");
    });

    it("classifies HTTP 403 as non-retryable", () => {
      const err = new Error("Forbidden: 403");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "auth");
    });

    it("classifies context overflow as non-retryable", () => {
      const err = new Error("Context length exceeded maximum tokens");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "context_overflow");
    });

    it("classifies content policy as non-retryable", () => {
      const err = new Error("Content policy violation detected");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "content_policy");
    });

    it("classifies structured report parse failure as non-retryable", () => {
      const err = new Error("Failed to parse structured report");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "parse_failure");
    });

    it("classifies AbortError as non-retryable", () => {
      const err = new Error("AbortError: user aborted");
      err.name = "AbortError";
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "user_abort");
    });

    it("classifies BudgetExceededError as non-retryable", () => {
      const err = new Error("Budget exceeded: costUsd (100 > 50)");
      err.name = "BudgetExceededError";
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "budget_exhausted");
    });

    it("classifies unknown errors as retryable by default", () => {
      const err = new Error("Something unexpected happened");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "unknown");
    });

    it("classifies missing API key/config as adapter_auth_failure (non-retryable)", () => {
      const err = new Error("Missing API key for provider: anthropic");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "adapter_auth_failure");
    });

    it("classifies EmptyOutputError as empty_output (retryable)", () => {
      const err = new EmptyOutputError("worker produced no output after 3000ms");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.category, "empty_output");
    });

    it("classifies ENOENT / no such file as path_error (non-retryable)", () => {
      const err = new Error("ENOENT: no such file or directory, open '/tmp/missing.json'");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "path_error");
    });

    it("classifies 'no such file' message as path_error (non-retryable)", () => {
      const err = new Error("no such file or directory");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "path_error");
    });

    it("classifies product blocking issue as product_blocking_issue (non-retryable)", () => {
      const err = new Error("product blocking issue: requirements contradict each other");
      const classified = classifyAgentError(err);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.category, "product_blocking_issue");
    });
  });

  describe("isRetryableError", () => {
    it("returns true for retryable errors", () => {
      assert.strictEqual(isRetryableError(new Error("429 rate limit")), true);
      assert.strictEqual(isRetryableError(new Error("503 overloaded")), true);
    });

    it("returns false for non-retryable errors", () => {
      assert.strictEqual(isRetryableError(new Error("401 unauthorized")), false);
      assert.strictEqual(isRetryableError(new Error("context overflow")), false);
    });
  });
});
