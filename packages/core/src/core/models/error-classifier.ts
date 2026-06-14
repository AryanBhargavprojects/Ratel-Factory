/**
 * Error classifier for model failures.
 *
 * Distinguishes retryable provider failures (circuit-break eligible)
 * from non-retryable errors (circuit-break ineligible).
 */

export interface ClassifiedAgentError {
  retryable: boolean;
  category:
    | "rate_limit"
    | "server_error"
    | "timeout"
    | "network"
    | "unknown"
    | "invalid_request"
    | "auth"
    | "context_overflow"
    | "content_policy"
    | "parse_failure"
    | "user_abort"
    | "budget_exhausted";
  original: Error;
}

/** Lightweight resolved model reference used by session-runner. */
export interface ResolvedModel {
  modelString: string;
  provider: string;
  id: string;
  /** The Pi Model object, if resolved. */
  piModel?: unknown;
}

const RETRYABLE_PATTERNS: Array<{ pattern: RegExp; category: ClassifiedAgentError["category"] }> = [
  { pattern: /\b429\b/, category: "rate_limit" },
  { pattern: /\b500\b/, category: "server_error" },
  { pattern: /\b502\b/, category: "server_error" },
  { pattern: /\b503\b/, category: "server_error" },
  { pattern: /\b504\b/, category: "timeout" },
  { pattern: /rate[-_\s]?limit/i, category: "rate_limit" },
  { pattern: /overloaded/i, category: "server_error" },
  { pattern: /\btimed?[-_\s]?out\b/i, category: "timeout" },
  { pattern: /ECONNRESET/i, category: "network" },
  { pattern: /transient.*network/i, category: "network" },
  { pattern: /network.*error/i, category: "network" },
  { pattern: /connection.*reset/i, category: "network" },
];

const NON_RETRYABLE_PATTERNS: Array<{ pattern: RegExp; category: ClassifiedAgentError["category"] }> = [
  { pattern: /\b400\b/, category: "invalid_request" },
  { pattern: /\b401\b/, category: "auth" },
  { pattern: /\b403\b/, category: "auth" },
  { pattern: /context.*(length|overflow|exceeded)/i, category: "context_overflow" },
  { pattern: /content.*policy/i, category: "content_policy" },
  { pattern: /parse.*(failure|error)/i, category: "parse_failure" },
  { pattern: /failed to parse/i, category: "parse_failure" },
];

/**
 * Classify an error as retryable or non-retryable.
 * Retryable errors are eligible for model failover.
 * Non-retryable errors should not poison model health.
 */
export function classifyAgentError(err: unknown): ClassifiedAgentError {
  const error = err instanceof Error ? err : new Error(String(err));
  const message = error.message;

  // Check non-retryable first (stronger signal)
  for (const { pattern, category } of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return { retryable: false, category, original: error };
    }
  }

  // AbortError / user abort
  if (error.name === "AbortError" || /abort/i.test(message)) {
    return { retryable: false, category: "user_abort", original: error };
  }

  // Budget exceeded
  if (error.name === "BudgetExceededError" || /budget.*exceeded/i.test(message)) {
    return { retryable: false, category: "budget_exhausted", original: error };
  }

  // Check retryable patterns
  for (const { pattern, category } of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return { retryable: true, category, original: error };
    }
  }

  // Default: treat unknown as retryable (conservative)
  return { retryable: true, category: "unknown", original: error };
}

/**
 * Convenience predicate: is this error retryable?
 */
export function isRetryableError(err: unknown): boolean {
  return classifyAgentError(err).retryable;
}
