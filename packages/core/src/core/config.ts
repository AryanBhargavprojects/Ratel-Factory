/**
 * Model configuration for Ratel's three-level agent hierarchy.
 *
 * Levels:
 *   orchestrator — orchestrator, research, smart friend, contract
 *   worker        — every worker spawn
 *   validator     — scrutiny, code review, user-testing
 *
 * Config lives in `ratel.json` at the project root.
 * Model strings use the `"provider/model-id"` format (e.g., `"anthropic/claude-sonnet-4"`).
 * `null` means "use SDK default" (first available model).
 *
 * IMPORTANT: resolveModel() uses ModelRegistry (not the bare pi-ai getModel) so that
 * custom providers registered in ~/.pi/agent/models.json — such as a local Ollama
 * instance — are visible to subagent spawns. Using the bare getModel bypasses
 * custom provider loading and silently returns undefined, causing subagents to
 * fall back to the SDK default (Azure), which is rarely what the user intended.
 */

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBudgetLimits } from "./budget/types.js";
import type { MissionBudgetLimits } from "./budget/types.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ModelConfig {
  orchestrator: string | null;
  worker: string | null;
  validator: string | null;
}

export interface FallbackModelConfig {
  /** Primary model string (e.g. "anthropic/claude-sonnet-4"). `null` means SDK default. */
  model: string | null;
  /** Ordered fallback chain. Duplicates and invalid strings are rejected. */
  fallbackModels?: string[];
}

export interface ModelRoutingConfig {
  /** Consecutive retryable failures before opening circuit. Default 2. */
  failureThreshold: number;
  /** Milliseconds to wait before allowing a half-open probe. Default 120000. */
  cooldownMs: number;
}

export interface ResolvedModelRoutingConfig {
  failureThreshold: number;
  cooldownMs: number;
}

export interface ObservabilityConfig {
  /** Observatory is always on by default; set false to opt out. */
  enabled?: boolean;
  /** Preferred dashboard port. If busy, startup falls back to the next available port. */
  port?: number;
  /** Reserved for future browser auto-open support. Defaults false. */
  autoOpen?: boolean;
}

export interface ResolvedObservabilityConfig {
  enabled: boolean;
  port: number;
  autoOpen: boolean;
}

export interface UserTestingConfig {
  maxConcurrency?: number;
  shardTimeoutMs?: number;
  basePort?: number;
}

export interface MissionBudgetConfig extends Partial<MissionBudgetLimits> {}

export interface RatelConfig {
  name?: string;
  version?: string;
  observability?: ObservabilityConfig;
  budget?: MissionBudgetConfig;
  orchestrator?: {
    systemPrompt?: string | null;
    thinkingLevel?: string;
    model?: string | null;
    fallbackModels?: string[];
    tools?: string[];
    customTools?: string[];
    defaultSkills?: string[];
    phaseSkills?: Record<string, string[]>;
  };
  workers?: {
    model?: string | null;
    fallbackModels?: string[];
    defaultTools?: string[];
  };
  validators?: {
    model?: string | null;
    fallbackModels?: string[];
    defaultTools?: string[];
  };
  validation?: {
    userTesting?: UserTestingConfig;
  };
  /** Model failover and circuit breaker configuration. */
  modelRouting?: Partial<ModelRoutingConfig>;
}

// ── Config I/O (async) ───────────────────────────────────────────────────

/**
 * Read the full ratel.json config. Returns an empty default if the file
 * doesn't exist or can't be parsed — never throws.
 */
export async function readRatelConfig(cwd: string): Promise<RatelConfig> {
  try {
    const raw = await readFile(join(cwd, "ratel.json"), "utf-8");
    return JSON.parse(raw) as RatelConfig;
  } catch {
    return {};
  }
}

/**
 * Write the full ratel.json config. Pretty-prints JSON.
 */
export async function writeRatelConfig(cwd: string, config: RatelConfig): Promise<void> {
  const json = JSON.stringify(config, null, 2) + "\n";
  await writeFile(join(cwd, "ratel.json"), json, "utf-8");
}

/**
 * Get model configuration for all three levels.
 * Falls back to null (SDK default) for any missing level.
 */
export async function getModelConfig(cwd: string): Promise<ModelConfig> {
  const config = await readRatelConfig(cwd);
  return {
    orchestrator: config.orchestrator?.model ?? null,
    worker: config.workers?.model ?? null,
    validator: config.validators?.model ?? null,
  };
}

/**
 * Build fallback-aware model config for all three levels.
 *
 * - Validates primary and fallback model strings against the live registry.
 * - Normalizes provider aliases (e.g. `openai` → `openai-codex`).
 * - Unknown/invalid model strings are warned and filtered out (primary → null,
 *   fallbacks → removed) rather than silently passed through.
 * - `null`/missing primary means "use SDK default" — this is preserved.
 * - Rejects duplicate model strings after normalization.
 *
 * @param agentDir - Optional Pi agent directory for registry lookup.
 */
export async function getFallbackModelConfig(
  cwd: string,
  agentDir?: string,
): Promise<{
  orchestrator: FallbackModelConfig;
  worker: FallbackModelConfig;
  validator: FallbackModelConfig;
  modelRouting: ResolvedModelRoutingConfig;
}> {
  const config = await readRatelConfig(cwd);

  // Resolve a model string through the registry, returning canonical slug or null.
  // Warns on unknown/invalid strings.
  const resolveOrNull = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const resolved = resolveModelSlug(raw, agentDir);
    if (!resolved) {
      console.warn(
        `[getFallbackModelConfig] Unknown model "${raw}" in ratel.json — ` +
        `will fall back to SDK default. Check for typos or run list_models.`,
      );
      return null;
    }
    return resolved.canonical;
  };

  // Resolve and deduplicate a fallback chain.
  const resolveFallbacks = (rawFallbacks: string[] | undefined, primary: string | null): string[] => {
    const seen = new Set<string>();
    if (primary) seen.add(primary);
    const result: string[] = [];
    for (const raw of rawFallbacks ?? []) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const resolved = resolveModelSlug(trimmed, agentDir);
      if (!resolved) {
        console.warn(
          `[getFallbackModelConfig] Unknown fallback model "${trimmed}" in ratel.json — skipped.`,
        );
        continue;
      }
      const canonical = resolved.canonical;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(canonical);
    }
    return result;
  };

  const orchPrimary = resolveOrNull(config.orchestrator?.model);
  const orchFallbacks = resolveFallbacks(config.orchestrator?.fallbackModels, orchPrimary);

  const workPrimary = resolveOrNull(config.workers?.model);
  const workFallbacks = resolveFallbacks(config.workers?.fallbackModels, workPrimary);

  const valPrimary = resolveOrNull(config.validators?.model);
  const valFallbacks = resolveFallbacks(config.validators?.fallbackModels, valPrimary);

  return {
    orchestrator: { model: orchPrimary, fallbackModels: orchFallbacks },
    worker: { model: workPrimary, fallbackModels: workFallbacks },
    validator: { model: valPrimary, fallbackModels: valFallbacks },
    modelRouting: {
      failureThreshold: config.modelRouting?.failureThreshold ?? 2,
      cooldownMs: config.modelRouting?.cooldownMs ?? 120000,
    },
  };
}

/**
 * Get Observatory configuration. The dashboard is always on by default so a
 * human can watch factory activity from the first prompt. `ratel.json` can
 * explicitly disable it with `{ "observability": { "enabled": false } }`.
 */
export async function getObservabilityConfig(cwd: string): Promise<ResolvedObservabilityConfig> {
  const config = await readRatelConfig(cwd);
  return {
    enabled: config.observability?.enabled ?? true,
    port: config.observability?.port ?? 8765,
    autoOpen: config.observability?.autoOpen ?? false,
  };
}

/**
 * Set the model for a specific level. Writes to ratel.json.
 * Pass `null` as model to clear (revert to SDK default).
 *
 * Validates non-null model strings against the live Pi/OpenCode-compatible
 * model registry. Unknown provider/model slugs are rejected with an error.
 * Alias normalization (e.g. `openai` → `openai-codex`) is applied and the
 * canonical slug is persisted.
 *
 * Returns the updated full ModelConfig.
 *
 * @throws If the model string is invalid or not found in the registry.
 */
export async function setModelConfig(
  cwd: string,
  level: "orchestrator" | "worker" | "validator",
  model: string | null,
  agentDir?: string,
): Promise<ModelConfig> {
  // Validate non-null model strings against the registry
  let canonicalSlug: string | null = null;
  if (model !== null) {
    const resolved = resolveModelSlug(model, agentDir);
    if (!resolved) {
      throw new Error(
        `Cannot set model: "${model}" is not a valid model slug or not found in the model registry. ` +
        `Use "provider/model-id" format (e.g. "openai-codex/gpt-5.4"). ` +
        `Run list_models to see available models.`,
      );
    }
    canonicalSlug = resolved.canonical;
  }

  const config = await readRatelConfig(cwd);

  if (level === "orchestrator") {
    if (!config.orchestrator) config.orchestrator = {};
    config.orchestrator.model = canonicalSlug;
  } else if (level === "worker") {
    if (!config.workers) config.workers = {};
    config.workers.model = canonicalSlug;
  } else {
    if (!config.validators) config.validators = {};
    config.validators.model = canonicalSlug;
  }

  await writeRatelConfig(cwd, config);
  return getModelConfig(cwd);
}

// ── Model Resolution ─────────────────────────────────────────────────────

/**
 * Provider alias map for normalizing user-facing provider names to
 * canonical registry provider namespaces.
 *
 * Only applied when the exact provider is NOT found in the registry AND
 * the aliased provider/model combination actually exists.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai-codex",
};

/**
 * Result of resolving a model slug against the registry.
 */
export interface ResolvedModelSlug {
  /** Canonical slug: `${model.provider}/${model.id}` */
  canonical: string;
  /** The resolved Model object from the registry. */
  model: ReturnType<ModelRegistry["find"]>;
  /** Warning message if alias normalization was applied. */
  warning?: string;
}

/**
 * Create a ModelRegistry for the given agent directory.
 * Refreshes to pick up any changes to models.json.
 */
function createRegistry(agentDir?: string): ModelRegistry {
  const authStorage = AuthStorage.create();
  const effectiveAgentDir = agentDir ?? getDefaultAgentDir();
  const registry = ModelRegistry.create(
    authStorage,
    join(effectiveAgentDir, "models.json"),
  );
  registry.refresh();
  return registry;
}

/**
 * Resolve a model slug like `"openai-codex/gpt-5.4"` against the live
 * Pi/OpenCode-compatible model registry.
 *
 * - Trims and validates `provider/model-id` format (split on first slash).
 * - Tries exact registry match first.
 * - If no exact match, tries provider alias normalization (e.g. `openai` → `openai-codex`)
 *   ONLY when the aliased provider/model actually exists in the registry.
 * - Returns the canonical slug and Model object on success.
 * - Returns `undefined` for null/empty/invalid/unknown strings.
 *
 * This is the single source of truth for model string validation.
 * Write paths (setModelConfig) should call this and reject on undefined.
 * Read/fallback paths (getFallbackModelConfig) should call this and
 * warn + filter on undefined.
 *
 * @param modelString - The model slug to resolve (e.g. "openai-codex/gpt-5.4").
 * @param agentDir - Optional Pi agent directory path. Uses default if omitted.
 */
export function resolveModelSlug(
  modelString?: string | null,
  agentDir?: string,
): ResolvedModelSlug | undefined {
  if (!modelString || typeof modelString !== "string") return undefined;

  const trimmed = modelString.trim();
  if (!trimmed) return undefined;

  // Model strings are "provider/model-id". Some providers (notably OpenRouter)
  // use model IDs that themselves contain slashes, e.g.
  // "openrouter/z-ai/glm-5.1". Split only on the first slash.
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    console.warn(
      `[resolveModelSlug] Invalid model string format: "${trimmed}" — expected "provider/model-id"`,
    );
    return undefined;
  }
  const provider = trimmed.slice(0, slashIndex);
  const id = trimmed.slice(slashIndex + 1);

  const registry = createRegistry(agentDir);

  // 1. Try exact match
  let model = registry.find(provider, id);
  if (model) {
    return {
      canonical: `${model.provider}/${model.id}`,
      model,
    };
  }

  // 2. Try alias normalization
  const aliasTarget = PROVIDER_ALIASES[provider];
  if (aliasTarget) {
    const aliasedModel = registry.find(aliasTarget, id);
    if (aliasedModel) {
      const canonical = `${aliasedModel.provider}/${aliasedModel.id}`;
      console.warn(
        `[resolveModelSlug] Normalized alias "${trimmed}" → "${canonical}"`,
      );
      return {
        canonical,
        model: aliasedModel,
        warning: `"${provider}" is an alias for "${aliasTarget}"; persisted as "${canonical}"`,
      };
    }
  }

  // 3. Not found
  console.warn(
    `[resolveModelSlug] Model not found in registry: provider="${provider}" id="${id}"`,
  );
  return undefined;
}

/**
 * Resolve a model string like `"anthropic/claude-sonnet-4"` to a Model object
 * suitable for `createAgentSession({ model })`.
 * Returns `undefined` if the string is empty, null, or invalid.
 *
 * Uses ModelRegistry (not the bare pi-ai getModel) so that custom providers
 * registered in ~/.pi/agent/models.json — such as a local Ollama instance —
 * are visible to subagent spawns. Using the bare getModel bypasses custom
 * provider loading and silently returns undefined, causing subagents to fall
 * back to the SDK default (Azure), which is rarely what the user intended.
 *
 * Logs a warning when a non-empty string cannot be resolved, so config typos
 * are visible in startup output rather than discovered at runtime.
 *
 * Delegates to resolveModelSlug for registry lookup and alias normalization.
 *
 * @param agentDir - Optional Pi agent directory path. Uses default if omitted.
 */
export function resolveModel(
  modelString?: string | null,
  agentDir?: string,
): ReturnType<ModelRegistry["find"]> {
  const resolved = resolveModelSlug(modelString, agentDir);
  if (!resolved) return undefined;
  return resolved.model;
}

// ── Model Discovery ──────────────────────────────────────────────────────

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  /** Canonical slug: `${provider}/${id}` */
  canonical: string;
  hasAuth: boolean;
}

/**
 * Get user-testing validation configuration with defaults.
 */
export async function getUserTestingConfig(cwd: string): Promise<{ maxConcurrency: number; shardTimeoutMs: number; basePort: number }> {
  const config = await readRatelConfig(cwd);
  return {
    maxConcurrency: config.validation?.userTesting?.maxConcurrency ?? 1,
    shardTimeoutMs: config.validation?.userTesting?.shardTimeoutMs ?? 45 * 60 * 1000,
    basePort: config.validation?.userTesting?.basePort ?? 3100,
  };
}

/**
 * List all models available on this machine (from Pi's ModelRegistry).
 *
 * Refreshes the registry before listing to pick up any changes to models.json.
 * Uses AuthStorage to check which providers have API keys configured.
 *
 * Each returned entry includes a `canonical` field with the
 * `${provider}/${id}` slug for use in ratel.json model fields.
 *
 * @param _cwd - Legacy project root (unused, kept for compatibility).
 * @param agentDir - Optional explicit Pi agent directory.
 */
export async function listAvailableModels(_cwd: string, agentDir?: string): Promise<ModelInfo[]> {
  const authStorage = AuthStorage.create();
  const effectiveAgentDir = agentDir ?? getDefaultAgentDir();
  const modelRegistry = ModelRegistry.create(authStorage, join(effectiveAgentDir, "models.json"));

  // Refresh to pick up any changes to models.json
  modelRegistry.refresh();

  const models = modelRegistry.getAvailable();
  return models.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    canonical: `${m.provider}/${m.id}`,
    hasAuth: modelRegistry.hasConfiguredAuth(m),
  }));
}

/**
 * Resolve budget limits from ratel.json project defaults and optional mission request overrides.
 * Rejects negative or non-finite values. Persists resolved snapshot in mission budget.json.
 */
export async function getBudgetConfig(cwd: string, missionOverrides?: MissionBudgetConfig): Promise<MissionBudgetLimits> {
  const config = await readRatelConfig(cwd);
  return resolveBudgetLimits(config.budget ?? {}, missionOverrides ?? {});
}

/**
 * Get the default agent directory path. Tries to match Pi's default.
 */
export function getDefaultAgentDir(): string {
  // Default agent dir — matches Pi's default
  return join(process.env.HOME ?? "~", ".pi", "agent");
}