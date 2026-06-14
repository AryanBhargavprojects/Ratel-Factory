/**
 * Common session runner with budget-aware model failover.
 *
 * Every agent spawn (research, smart friend, contract writer, worker,
 * validator, shard) should route through this runner.
 */

import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, AuthStorage, ModelRegistry, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { MissionExecutionContext } from "../mission/execution-context.js";
import type { AgentRole } from "./model-router.js";
import { classifyAgentError, type ResolvedModel } from "./error-classifier.js";
import { BudgetExceededError } from "../budget/types.js";
import { resolveModel } from "../config.js";

export interface SessionRunnerOptions<T> {
  context: MissionExecutionContext;
  role: AgentRole;
  signal?: AbortSignal;
  attempt: (model: ResolvedModel, signal: AbortSignal) => Promise<T>;
}

/**
 * Collect the full text response from a session after prompting.
 *
 * Logs a warning when the response is empty AND the session ended very quickly
 * (< 1 second) — this is a strong signal that the model never actually ran.
 * Common causes:
 *   - Model resolution failure (resolveModel returned undefined)
 *   - Provider not configured (e.g., Azure fallback when no Azure creds)
 *   - API error before any tokens were generated
 * Without this warning, the empty response is silently propagated to the
 * tool layer, which then reports "contract writer produced no artifacts"
 * without indicating the real cause.
 */
export async function collectResponse(session: AgentSession, prompt: string): Promise<string> {
  let response = "";
  const startTime = Date.now();
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      response += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe();
  }

  const durationMs = Date.now() - startTime;

  if (response.length === 0 && durationMs < 1000) {
    console.warn(
      `[collectResponse] Agent produced no output in ${durationMs}ms — ` +
        `possible model resolution failure, missing API credentials, upstream API error, or non-text output. ` +
        `Empty response will propagate to the calling tool.`,
    );
  } else if (response.length === 0) {
    console.warn(
      `[collectResponse] Agent produced no output in ${durationMs}ms. ` +
        `Empty response will propagate to the calling tool.`,
    );
  }

  return response;
}

/**
 * Run an agent session with automatic model failover.
 *
 * Rules:
 * 1. Check budget before each attempt
 * 2. Resolve candidates through ModelRouter
 * 3. Never silently use SDK default when configured model cannot resolve
 * 4. Create fresh session for each fallback attempt
 * 5. Count each attempt in budget
 * 6. Stop at maxModelAttemptsPerRun
 * 7. Retry only classified retryable failures
 * 8. Record circuit success/failure
 * 9. Emit model_attempt and model_fallback events
 * 10. Preserve final typed error
 */
export async function runSessionWithFailover<T>(options: SessionRunnerOptions<T>): Promise<T> {
  const { context, role, signal } = options;

  if (signal?.aborted) {
    throw new Error("Session aborted before first attempt");
  }

  const models = context.models;
  const budget = context.budget;
  const logger = context.logger;

  // Ensure router is initialized
  await models.init();

  const candidates = await models.getCandidates(role);

  if (candidates.length === 0) {
    throw new Error(`No model candidates available for role: ${role}`);
  }

  const maxAttempts = (await budget.getState()).limits.maxModelAttemptsPerRun;
  let lastError: Error | undefined;

  for (let attemptIndex = 0; attemptIndex < Math.min(candidates.length, maxAttempts); attemptIndex++) {
    if (signal?.aborted) {
      throw new Error("Session aborted during attempt");
    }

    // 1. Check budget before each attempt
    try {
      await budget.assertCanStart(role === "orchestrator" ? "orchestrator" : role === "worker" ? "worker" : "scrutiny_validator");
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        throw err;
      }
      throw new Error(`Budget check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await budget.recordAgentStart(role === "orchestrator" ? "orchestrator" : role === "worker" ? "worker" : "scrutiny_validator");

    const modelString = candidates[attemptIndex];

    // 9. Emit model_attempt event
    logger.toolCall("model_attempt", { role, model: modelString, attemptIndex: attemptIndex + 1 });

    try {
      const resolvedModel: ResolvedModel = {
        modelString,
        provider: modelString.split("/")[0] ?? "unknown",
        id: modelString.split("/").slice(1).join("/") ?? modelString,
      };

      const result = await options.attempt(resolvedModel, signal ?? new AbortController().signal);

      // 8. Record circuit success
      await models.recordSuccess(modelString);

      logger.toolResult("model_attempt", { role, model: modelString, attemptIndex: attemptIndex + 1, success: true });

      return result;
    } catch (err) {
      const classified = classifyAgentError(err);
      lastError = classified.original;

      // 8. Record circuit failure (only retryable ones poison health)
      await models.recordFailure(modelString, classified);

      logger.toolResult("model_attempt", {
        role,
        model: modelString,
        attemptIndex: attemptIndex + 1,
        success: false,
        retryable: classified.retryable,
        category: classified.category,
      });

      // 7. Retry only classified retryable failures
      if (!classified.retryable) {
        throw lastError;
      }

      // 9. Emit model_fallback event if there are more candidates
      if (attemptIndex + 1 < Math.min(candidates.length, maxAttempts)) {
        const nextModel = candidates[attemptIndex + 1];
        logger.toolCall("model_fallback", {
          role,
          fromModel: modelString,
          toModel: nextModel,
          reason: classified.category,
        });
      }
    }
  }

  // If we exhausted all candidates or max attempts, throw a clear exhaustion error
  const exhaustedError = lastError
    ? new Error(
        `All model attempts exhausted for role: ${role} (maxModelAttemptsPerRun=${maxAttempts}). ` +
        `Last error: ${lastError.message}`
      )
    : new Error(`All model attempts exhausted for role: ${role}`);
  throw exhaustedError;
}

/**
 * Helper to create a fresh Pi AgentSession for a given model string.
 * This abstracts away the Pi SDK boilerplate so callers can focus on
 * the prompt and session lifecycle.
 *
 * IMPORTANT: This does NOT own failover. It creates ONE session.
 * Callers should use runSessionWithFailover for automatic failover.
 */
export async function createAgentSessionForModel(options: {
  cwd: string;
  modelString: string;
  systemPrompt: string;
  tools: string[];
  customTools?: any[];
  skills?: any[];
  thinkingLevel?: string;
}): Promise<{ session: AgentSession; dispose: () => void }> {
  const { cwd, modelString, systemPrompt, tools, customTools, skills, thinkingLevel } = options;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => systemPrompt,
    skillsOverride: skills ? () => ({ skills, diagnostics: [] }) : undefined,
  });
  await resourceLoader.reload();

  const resolvedModel = resolveModel(modelString);
  if (!resolvedModel) {
    throw new Error(
      `Configured model could not be resolved: ${modelString} — expected "provider/model-id"`,
    );
  }

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools,
    customTools,
    model: resolvedModel,
    thinkingLevel: (thinkingLevel ?? "medium") as any,
  });

  return {
    session,
    dispose: () => session.dispose(),
  };
}
