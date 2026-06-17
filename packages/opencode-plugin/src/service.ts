/**
 * Ratel Service HTTP Client
 *
 * Thin HTTP client that talks to the Ratel core service.
 * All adapter packages use this to delegate to the service.
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

export interface MissionStatusResponse {
  missionId: string;
  state: unknown;
}

export interface JobStatusResponse {
  jobId: string;
  missionId: string;
  status: string;
  result?: unknown;
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

  async getJobStatus(missionId: string, jobId: string): Promise<JobStatusResponse> {
    return this.get(`/missions/${encodeURIComponent(missionId)}/jobs/${encodeURIComponent(jobId)}`);
  }

  async cancelJob(missionId: string, jobId: string): Promise<{ jobId: string; status: string }> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  async approveMission(missionId: string): Promise<EnqueuedJobResponse> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/approval`, { approved: true });
  }

  async runWorker(missionId: string, featureId: string): Promise<EnqueuedJobResponse> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/workers`, { featureId });
  }

  async runValidation(missionId: string, milestoneId: string): Promise<EnqueuedJobResponse> {
    return this.post(`/missions/${encodeURIComponent(missionId)}/validations`, { milestoneId });
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
}
