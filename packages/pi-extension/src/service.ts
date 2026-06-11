/**
 * Ratel Pi Extension — HTTP Client
 *
 * Same HTTP client as the OpenCode plugin. Talks to the Ratel service.
 */

export interface MissionStartResponse {
  missionId: string;
}

export interface MissionStatusResponse {
  missionId: string;
  state: unknown;
}

export interface WorkerResponse {
  missionId: string;
  featureId: string;
  status: string;
}

export interface ValidationResponse {
  missionId: string;
  milestoneId: string;
  status: string;
}

export interface ObservatoryStatusResponse {
  enabled: boolean;
  url: string | null;
}

export class RatelServiceClient {
  constructor(private baseUrl: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
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
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
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

  async startMission(goal: string): Promise<MissionStartResponse> {
    return this.post("/mission/start", { goal });
  }

  async getStatus(missionId: string): Promise<MissionStatusResponse> {
    return this.get(`/mission/status?missionId=${encodeURIComponent(missionId)}`);
  }

  async runWorker(missionId: string, featureId: string): Promise<WorkerResponse> {
    return this.post("/mission/worker", { missionId, featureId });
  }

  async runValidation(missionId: string, milestoneId: string): Promise<ValidationResponse> {
    return this.post("/mission/validate", { missionId, milestoneId });
  }

  async getObservatoryUrl(): Promise<ObservatoryStatusResponse> {
    return this.get("/observatory/status");
  }
}
