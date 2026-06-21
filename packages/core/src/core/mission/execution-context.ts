import type { MissionScope } from "./scope.js";
import type { EventLogger } from "../observability/event-logger.js";
import type { BudgetManager } from "../budget/budget-manager.js";
import type { ModelRouter } from "../models/model-router.js";
import type { ModelPreflightDeps } from "./model-preflight.js";

/**
 * Execution context passed to tools and helpers.
 * Holds the mission scope, the event logger, budget manager, model router, and an optional job ID.
 */
export interface MissionExecutionContext {
  scope: MissionScope;
  logger: EventLogger;
  budget: BudgetManager;
  models: ModelRouter;
  jobId?: string;
  jobControl?: {
    markWaitingForApproval(): Promise<void>;
  };
  /**
   * Optional dependency-injection seam for the model/credential preflight.
   * Production callers omit this so `runModelPreflight` uses the real Pi
   * ModelRegistry / AuthStorage (filesystem reads only — no tokens consumed).
   * Tests supply a fake `ModelPreflightDeps` to force preflight outcomes
   * (ok / adapter_auth_failure / missing_config) without touching the
   * filesystem or the network.
   */
  preflightDeps?: ModelPreflightDeps;
}
