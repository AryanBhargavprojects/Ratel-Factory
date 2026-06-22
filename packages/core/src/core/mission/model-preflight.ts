/**
 * Model/credential preflight helper for issue #2.
 *
 * Performs a CHEAP configuration/auth preflight: verifies that the configured
 * model(s) for each agent role can resolve to an authenticated model/provider.
 *
 * It MUST NOT spawn a full worker/validator session and MUST NOT consume any
 * model tokens. The default path only consults the local model registry and
 * AuthStorage (which perform filesystem reads, not API calls).
 *
 * To keep this unit-testable without a real ~/.pi/agent/models.json, the
 * resolution logic is dependency-injectable via `ModelPreflightDeps`. Tests
 * supply a fake `resolveModelAuth` and/or `getConfig`; production callers omit
 * `deps` and the real config + registry utilities are used.
 *
 * Failure metadata distinguishes:
 *   - `missing_config`: no usable model configured for the role (and no
 *     authenticated SDK default is available).
 *   - `adapter_auth_failure`: a model resolves in the registry but lacks
 *     configured authentication credentials.
 *   - `unresolved_model`: a configured model string cannot be resolved in the
 *     registry at all (typo / unknown provider).
 *
 * Every result sets `noTokensConsumed: true` so callers can rely on the
 * guarantee statically.
 */

import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  getFallbackModelConfig,
  resolveModelSlug,
  getDefaultAgentDir,
  type FallbackModelConfig,
} from "../config.js";
import type { AgentRole } from "../models/model-router.js";

export type PreflightProblemCode =
  | "missing_config"
  | "adapter_auth_failure"
  | "unresolved_model";

export interface PreflightProblem {
  role: AgentRole;
  code: PreflightProblemCode;
  message: string;
  /** The model slug the problem pertains to, when applicable. */
  model?: string;
}

export interface PreflightResolvedModel {
  role: AgentRole;
  /** Canonical slug, or null when the role will use the SDK default model. */
  canonical: string | null;
  hasAuth: boolean;
}

export interface ModelPreflightResult {
  ok: boolean;
  /** Always true; preflight never consumes tokens. */
  noTokensConsumed: true;
  problems: PreflightProblem[];
  resolvedModels: PreflightResolvedModel[];
}

/** Output of resolving a single model slug (or null = SDK default). */
export interface ResolvedModelAuth {
  canonical: string | null;
  hasAuth: boolean;
  /** True when the slug resolved to a registry model (or SDK default exists). */
  resolved: boolean;
}

export interface ModelPreflightDeps {
  /**
   * Return the fallback model config for all roles. Defaults to
   * `getFallbackModelConfig(cwd)` (projected to the three role configs).
   */
  getConfig?: (
    cwd: string,
  ) => Promise<{
    orchestrator: FallbackModelConfig;
    worker: FallbackModelConfig;
    validator: FallbackModelConfig;
  }>;
  /**
   * Resolve a single model slug (null = SDK default) to auth metadata.
   * Defaults to a registry-backed implementation.
   */
  resolveModelAuth?: (slug: string | null) => ResolvedModelAuth;
}

const ROLES: AgentRole[] = ["orchestrator", "worker", "validator"];

/**
 * Run the model/credential preflight. Never spawns a worker/validator session.
 */
export async function runModelPreflight(
  cwd: string,
  deps?: ModelPreflightDeps,
): Promise<ModelPreflightResult> {
  const getConfig =
    deps?.getConfig ??
    (async (c: string) => {
      const full = await getFallbackModelConfig(c);
      return {
        orchestrator: full.orchestrator,
        worker: full.worker,
        validator: full.validator,
      };
    });
  const resolveModelAuth = deps?.resolveModelAuth ?? defaultResolveModelAuth;

  let config: {
    orchestrator: FallbackModelConfig;
    worker: FallbackModelConfig;
    validator: FallbackModelConfig;
  };
  try {
    config = await getConfig(cwd);
  } catch (err) {
    const message = `Failed to read model configuration: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return {
      ok: false,
      noTokensConsumed: true,
      problems: ROLES.map((role) => ({ role, code: "missing_config" as const, message })),
      resolvedModels: [],
    };
  }

  const problems: PreflightProblem[] = [];
  const resolvedModels: PreflightResolvedModel[] = [];

  for (const role of ROLES) {
    const roleConfig = config[role];
    const chain = [roleConfig.model, ...(roleConfig.fallbackModels ?? [])].filter(
      (m): m is string => m !== null,
    );

    if (chain.length === 0) {
      // No explicit model configured — verify the SDK default can resolve with auth.
      const resolved = resolveModelAuth(null);
      if (!resolved.resolved) {
        problems.push({
          role,
          code: "missing_config",
          message:
            "No model configured for this role and no authenticated SDK default model is available.",
        });
        continue;
      }
      if (!resolved.hasAuth) {
        problems.push({
          role,
          code: "adapter_auth_failure",
          message:
            "No model configured for this role and the SDK default model lacks configured authentication credentials.",
        });
        resolvedModels.push({ role, canonical: resolved.canonical, hasAuth: false });
        continue;
      }
      resolvedModels.push({ role, canonical: resolved.canonical, hasAuth: true });
      continue;
    }

    let resolvedAny = false;
    for (const slug of chain) {
      const resolved = resolveModelAuth(slug);
      if (!resolved.resolved) {
        problems.push({
          role,
          code: "unresolved_model",
          message: `Model "${slug}" could not be resolved in the model registry.`,
          model: slug,
        });
        continue;
      }
      if (!resolved.hasAuth) {
        problems.push({
          role,
          code: "adapter_auth_failure",
          message: `Model "${slug}" resolves in the registry but lacks configured authentication credentials.`,
          model: slug,
        });
        continue;
      }
      resolvedModels.push({ role, canonical: resolved.canonical, hasAuth: true });
      resolvedAny = true;
      break;
    }
    // If no candidate in the chain resolved with auth, problems were already
    // recorded above; do not emit a duplicate.
    void resolvedAny;
  }

  return {
    ok: problems.length === 0,
    noTokensConsumed: true,
    problems,
    resolvedModels,
  };
}

/**
 * Default registry-backed resolver. Uses the live Pi ModelRegistry and
 * AuthStorage — filesystem reads only, no API calls, no token consumption.
 */
function defaultResolveModelAuth(slug: string | null): ResolvedModelAuth {
  const authStorage = AuthStorage.create();
  const registry = ModelRegistry.create(
    authStorage,
    join(getDefaultAgentDir(), "models.json"),
  );
  registry.refresh();

  if (slug === null) {
    const available = registry.getAvailable();
    if (available.length === 0) {
      return { canonical: null, hasAuth: false, resolved: false };
    }
    const first = available[0];
    return {
      canonical: `${first.provider}/${first.id}`,
      hasAuth: true,
      resolved: true,
    };
  }

  const resolved = resolveModelSlug(slug);
  if (!resolved || !resolved.model) {
    return { canonical: null, hasAuth: false, resolved: false };
  }
  return {
    canonical: resolved.canonical,
    hasAuth: registry.hasConfiguredAuth(resolved.model),
    resolved: true,
  };
}
