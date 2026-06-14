/**
 * ModelRouter with circuit breaker and fallback chain support.
 *
 * Manages model health and candidate selection per agent role.
 * Persisted health in `.ratel/model-health.json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClassifiedAgentError } from "./error-classifier.js";

export type AgentRole = "orchestrator" | "worker" | "validator";

export interface ModelHealth {
  model: string;
  state: "closed" | "open" | "half_open";
  consecutiveRetryableFailures: number;
  openedAt?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

export interface ModelRoutingConfig {
  failureThreshold: number;
  cooldownMs: number;
}

export interface RoleModelConfig {
  /** Primary model string (e.g. "anthropic/claude-sonnet-4"). `null` means SDK default. */
  model: string | null;
  fallbackModels: string[];
}

export interface ModelRouterConfig {
  projectRoot: string;
  orchestrator: RoleModelConfig;
  worker: RoleModelConfig;
  validator: RoleModelConfig;
  modelRouting: ModelRoutingConfig;
}

export class ModelRouter {
  private healthMap = new Map<string, ModelHealth>();
  private healthPath: string;

  constructor(private config: ModelRouterConfig) {
    this.healthPath = join(config.projectRoot, ".ratel", "model-health.json");
  }

  /** Initialize the router and rehydrate persisted health state. */
  async init(): Promise<void> {
    await this.loadHealth();
  }

  /** Get the ordered list of candidate model strings for a role. */
  async getCandidates(role: AgentRole): Promise<string[]> {
    const roleConfig = this.config[role];
    const allModels = [roleConfig.model, ...roleConfig.fallbackModels].filter((m): m is string => m !== null);
    const unique = [...new Set(allModels)];

    const now = Date.now();
    return unique.filter((model) => {
      const health = this.healthMap.get(model);
      if (!health) return true;
      if (health.state === "closed") return true;
      if (health.state === "open") {
        const openedAt = health.openedAt ? new Date(health.openedAt).getTime() : 0;
        if (now - openedAt >= this.config.modelRouting.cooldownMs) {
          // Transition to half_open for one probe
          health.state = "half_open";
          return true;
        }
        return false;
      }
      // half_open: allow exactly one probe attempt
      return true;
    });
  }

  /** Alias for getCandidates — matches the spec naming. */
  selectCandidates(role: AgentRole): Promise<string[]> {
    return this.getCandidates(role);
  }

  /** Record a successful attempt for a model. */
  async recordSuccess(model: string): Promise<void> {
    let health = this.healthMap.get(model);
    if (!health) {
      health = { model, state: "closed", consecutiveRetryableFailures: 0 };
      this.healthMap.set(model, health);
    }

    health.consecutiveRetryableFailures = 0;
    health.lastSuccessAt = new Date().toISOString();

    if (health.state === "half_open") {
      health.state = "closed";
      health.openedAt = undefined;
    }

    await this.persistHealth();
  }

  /** Record a failure for a model. Only retryable failures poison health. */
  async recordFailure(model: string, failure: ClassifiedAgentError): Promise<void> {
    if (!failure.retryable) {
      // Non-retryable errors do not affect circuit breaker state
      return;
    }

    let health = this.healthMap.get(model);
    if (!health) {
      health = { model, state: "closed", consecutiveRetryableFailures: 0 };
      this.healthMap.set(model, health);
    }

    health.consecutiveRetryableFailures += 1;
    health.lastFailureAt = new Date().toISOString();

    if (health.consecutiveRetryableFailures >= this.config.modelRouting.failureThreshold) {
      health.state = "open";
      health.openedAt = new Date().toISOString();
    }

    await this.persistHealth();
  }

  private async loadHealth(): Promise<void> {
    try {
      const raw = await readFile(this.healthPath, "utf-8");
      const parsed = JSON.parse(raw) as { models: ModelHealth[] };
      if (Array.isArray(parsed.models)) {
        for (const m of parsed.models) {
          this.healthMap.set(m.model, m);
        }
      }
    } catch {
      // File may not exist yet
    }
  }

  private async persistHealth(): Promise<void> {
    const payload = {
      models: Array.from(this.healthMap.values()),
    };
    await mkdir(join(this.config.projectRoot, ".ratel"), { recursive: true });
    await writeFile(this.healthPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}
