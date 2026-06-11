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

// ── Types ────────────────────────────────────────────────────────────────

export interface ModelConfig {
  orchestrator: string | null;
  worker: string | null;
  validator: string | null;
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

export interface RatelConfig {
  name?: string;
  version?: string;
  observability?: ObservabilityConfig;
  orchestrator?: {
    systemPrompt?: string | null;
    thinkingLevel?: string;
    model?: string | null;
    tools?: string[];
    customTools?: string[];
    defaultSkills?: string[];
    phaseSkills?: Record<string, string[]>;
  };
  workers?: {
    model?: string | null;
    defaultTools?: string[];
  };
  validators?: {
    model?: string | null;
    defaultTools?: string[];
  };
  validation?: {
    userTesting?: UserTestingConfig;
  };
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
 * Returns the updated full ModelConfig.
 */
export async function setModelConfig(
  cwd: string,
  level: "orchestrator" | "worker" | "validator",
  model: string | null,
): Promise<ModelConfig> {
  const config = await readRatelConfig(cwd);

  if (level === "orchestrator") {
    if (!config.orchestrator) config.orchestrator = {};
    config.orchestrator.model = model;
  } else if (level === "worker") {
    if (!config.workers) config.workers = {};
    config.workers.model = model;
  } else {
    if (!config.validators) config.validators = {};
    config.validators.model = model;
  }

  await writeRatelConfig(cwd, config);
  return getModelConfig(cwd);
}

// ── Model Resolution ─────────────────────────────────────────────────────

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
 */
export function resolveModel(modelString?: string | null): ReturnType<ModelRegistry["find"]> {
  if (!modelString) return undefined;

  // Model strings are "provider/model-id". Some providers (notably OpenRouter)
  // use model IDs that themselves contain slashes, e.g.
  // "openrouter/z-ai/glm-5.1". Split only on the first slash.
  const slashIndex = modelString.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelString.length - 1) {
    console.warn(
      `[resolveModel] Invalid model string format: "${modelString}" — expected "provider/model-id"`,
    );
    return undefined;
  }
  const provider = modelString.slice(0, slashIndex);
  const id = modelString.slice(slashIndex + 1);

  // Use ModelRegistry which loads custom providers from ~/.pi/agent/models.json
  // in addition to the built-in provider catalog.
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(getAgentDir(process.cwd()), "models.json"),
  );
  const model = modelRegistry.find(provider, id);

  if (!model) {
    console.warn(
      `[resolveModel] Model not found in registry: provider="${provider}" id="${id}" — will fall back to SDK default`,
    );
  }
  return model;
}

// ── Model Discovery ──────────────────────────────────────────────────────

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
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
 * Uses AuthStorage to check which providers have API keys configured.
 */
export async function listAvailableModels(cwd: string): Promise<ModelInfo[]> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage, join(getAgentDir(cwd), "models.json"));

  const models = modelRegistry.getAvailable();
  return models.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    hasAuth: modelRegistry.hasConfiguredAuth(m),
  }));
}

/**
 * Get the default agent directory path. Tries to match Pi's default.
 */
function getAgentDir(cwd: string): string {
  // Default agent dir — matches Pi's default
  return join(process.env.HOME ?? "~", ".pi", "agent");
}