/**
 * Ratel Service HTTP Client
 *
 * Thin HTTP client that talks to the Ratel core service.
 * All adapter packages use this to delegate to the service.
 */

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
    const res = await fetch(this.resolve(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.resolve(path), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async health(): Promise<{ status: string }> {
    return this.get("/health");
  }

  async startMission(goal: string): Promise<EnqueuedJobResponse> {
    return this.post("/mission/start", { goal });
  }

  async getMissionStatus(missionId: string): Promise<MissionStatusResponse> {
    return this.get(`/mission/status?missionId=${encodeURIComponent(missionId)}`);
  }

  async getJobStatus(jobId: string): Promise<JobStatusResponse> {
    return this.get(`/job/status?jobId=${encodeURIComponent(jobId)}`);
  }

  async cancelJob(jobId: string): Promise<{ jobId: string; status: string }> {
    return this.post("/job/cancel", { jobId });
  }

  async approveMission(missionId: string): Promise<EnqueuedJobResponse> {
    return this.post("/mission/approve", { missionId });
  }

  async runWorker(missionId: string, featureId: string): Promise<EnqueuedJobResponse> {
    return this.post("/mission/worker", { missionId, featureId });
  }

  async runValidation(missionId: string, milestoneId: string): Promise<EnqueuedJobResponse> {
    return this.post("/mission/validate", { missionId, milestoneId });
  }

  async getObservatoryUrl(): Promise<ObservatoryStatusResponse> {
    return this.get("/observatory/status");
  }

  getMissionEventsUrl(missionId: string): string {
    return `${this.baseUrl}/api/v1/mission/${encodeURIComponent(missionId)}/events`;
  }
}
