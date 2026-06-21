/**
 * Ratel Pi Extension — HTTP Client
 *
 * Thin HTTP client that talks to the Ratel core service. The service is the
 * authoritative owner of all mission/job/event state; this client only
 * performs HTTP calls and normalizes responses.
 *
 * This is a Pi-native module. It does not import any OpenCode plugin APIs.
 */

export class RatelServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RatelServiceError";
  }
}

export interface EnqueuedJobResponse {
  missionId: string;
  jobId: string;
  status: "queued";
}

export interface RatelEvent {
  timestamp: string;
  event_type: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  agent_level?: string;
  data: Record<string, unknown>;
}

export interface MissionEventsResponse {
  missionId: string;
  events: RatelEvent[];
  after: number;
  /** Client-computed: after + events.length for next poll */
  nextAfter: number;
}

export interface ApproveMissionOptions {
  approved?: boolean;
  feedback?: string;
  files?: Record<string, string>;
}

/** Mission status values returned by the core service. */
export type MissionStatus =
  | "active"
  | "waiting_for_approval"
  | "completed"
  | "halted"
  | "cancelled";

export interface MissionStatusResponse {
  missionId: string;
  status: MissionStatus;
  goal?: string;
  [key: string]: unknown;
}

export interface JobsListResponse {
  jobs: Array<{ jobId: string; status: string; [key: string]: unknown }>;
}

export interface JobStatusResponse {
  jobId: string;
  missionId: string;
  status: string;
  attempt?: number;
  result?: unknown;
  [key: string]: unknown;
}

export interface ObservatoryStatusResponse {
  enabled: boolean;
  url: string | null;
}

export interface AgentPingResult {
  role: string;
  status: "ok" | "failed" | "timeout";
  timeMs: number;
  error?: string;
}

export interface PingAgentsResponse {
  ok: boolean;
  totalAgents: number;
  okCount: number;
  failedCount: number;
  totalTimeMs: number;
  agents: AgentPingResult[];
}

export class RatelServiceClient {
  constructor(private baseUrl: string) {}

  private resolve(path: string): string {
    // Health is unversioned; everything else is under /api/v1
    if (path === "/health") {
      return `${this.baseUrl}${path}`;
    }
    return `${this.baseUrl}/api/v1${path}`;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.resolve(path);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof RatelServiceError) throw err;
      throw new RatelServiceError(
        `Unable to connect to Ratel service at ${this.baseUrl}. Is it running? (${err instanceof Error ? err.message : String(err)})`,
        err,
      );
    }
  }

  private async get<T>(path: string): Promise<T> {
    const url = this.resolve(path);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof RatelServiceError) throw err;
      throw new RatelServiceError(
        `Unable to connect to Ratel service at ${this.baseUrl}. Is it running? (${err instanceof Error ? err.message : String(err)})`,
        err,
      );
    }
  }

  async health(): Promise<{ status: string }> {
    return this.get("/health");
  }

  async startMission(goal: string): Promise<EnqueuedJobResponse> {
    return this.post("/missions", { goal });
  }

  async getMissionStatus(missionId: string): Promise<MissionStatusResponse> {
    return this.get(`/missions/${encodeURIComponent(missionId)}`);
  }

  async listJobs(missionId: string): Promise<JobsListResponse> {
    return this.get(`/missions/${encodeURIComponent(missionId)}/jobs`);
  }

  async getJobStatus(missionId: string, jobId: string): Promise<JobStatusResponse> {
    return this.get(`/missions/${encodeURIComponent(missionId)}/jobs/${encodeURIComponent(jobId)}`);
  }

  async cancelJob(missionId: string, jobId: string): Promise<{ jobId: string; status: string }> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  async approveMission(missionId: string, options?: ApproveMissionOptions): Promise<EnqueuedJobResponse> {
    const body: Record<string, unknown> = {
      approved: options?.approved ?? true,
    };
    if (options?.feedback) body.feedback = options.feedback;
    if (options?.files) body.files = options.files;
    return this.post(`/missions/${encodeURIComponent(missionId)}/approval`, body);
  }

  async getMissionEvents(missionId: string, after?: number): Promise<MissionEventsResponse> {
    const offset = after ?? 0;
    const raw = await this.get<{ missionId: string; events: RatelEvent[]; after: number }>(
      `/missions/${encodeURIComponent(missionId)}/events?after=${offset}`,
    );
    return {
      missionId: raw.missionId,
      events: raw.events,
      after: raw.after,
      nextAfter: offset + raw.events.length,
    };
  }

  async runWorker(missionId: string, featureId: string): Promise<EnqueuedJobResponse> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/workers`, { featureId });
  }

  async runValidation(missionId: string, milestoneId: string): Promise<EnqueuedJobResponse> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/validations`, { milestoneId });
  }

  /**
   * Send a free-form user message / reply / clarification to the mission
   * orchestrator. Enqueues a continue_orchestrator job.
   */
  async sendMessage(
    missionId: string,
    message: string,
    questionId?: string,
  ): Promise<EnqueuedJobResponse> {
    const body: Record<string, unknown> = { message };
    if (questionId) body.questionId = questionId;
    return this.post(`/missions/${encodeURIComponent(missionId)}/messages`, body);
  }

  /**
   * Submit a direct answer to a specific pending question. The core service
   * enqueues a continue_orchestrator job with a message referencing the
   * question id.
   */
  async answerQuestion(
    missionId: string,
    questionId: string,
    answer: unknown,
  ): Promise<EnqueuedJobResponse> {
    return this.post(
      `/missions/${encodeURIComponent(missionId)}/questions/${encodeURIComponent(questionId)}/answer`,
      { answer },
    );
  }

  async getObservatoryUrl(): Promise<ObservatoryStatusResponse> {
    return this.get("/observatory/status");
  }

  async pingAgents(): Promise<PingAgentsResponse> {
    return this.post("/ping/agents", {});
  }

  getMissionEventsUrl(missionId: string): string {
    return `${this.baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}/events`;
  }

  /** Expose the base URL for service-lifecycle diagnostics. */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}
