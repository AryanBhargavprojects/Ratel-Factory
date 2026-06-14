import type { MissionScope } from "./scope.js";
import type { EventLogger } from "../observability/event-logger.js";
import type { BudgetManager } from "../budget/budget-manager.js";
import type { ModelRouter } from "../models/model-router.js";

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
}
