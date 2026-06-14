import type { MissionScope } from "./scope.js";
import type { EventLogger } from "../observability/event-logger.js";

/**
 * Execution context passed to tools and helpers.
 * Holds the mission scope, the event logger, and an optional job ID.
 */
export interface MissionExecutionContext {
  scope: MissionScope;
  logger: EventLogger;
  jobId?: string;
  jobControl?: {
    markWaitingForApproval(): Promise<void>;
  };
}
