export type MissionStatus = "active" | "waiting_for_approval" | "completed" | "halted" | "cancelled";

export interface MissionRecord {
  missionId: string;
  projectRoot: string;
  goal: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  currentJobId?: string;
}

export type MissionJobType =
  | "start_mission"
  | "continue_orchestrator"
  | "run_worker"
  | "run_validation"
  | "run_user_testing";

export type MissionJobStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface MissionJob {
  jobId: string;
  missionId: string;
  type: MissionJobType;
  payload: Record<string, unknown>;
  status: MissionJobStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  cancellationRequestedAt?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
