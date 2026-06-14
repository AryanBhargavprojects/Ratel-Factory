import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRatelDir } from "../core/mission/scope.js";
import { atomicWriteJson, readJsonFile } from "../core/mission/atomic-file.js";
import { withFileLock } from "./mutex.js";
import type { MissionRecord, MissionStatus } from "./types.js";
import type { MissionBudgetLimits } from "../core/budget/types.js";

function generateMissionId(): string {
  return `mis_${randomUUID().replace(/-/g, "")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MissionStore {
  constructor(readonly projectRoot: string) {}

  private get ratelDir(): string {
    return getRatelDir(this.projectRoot);
  }

  private get missionsDir(): string {
    return join(this.ratelDir, "missions");
  }

  private get idempotencyDir(): string {
    return join(this.ratelDir, "idempotency");
  }

  private get currentMissionPath(): string {
    return join(this.ratelDir, "current-mission.json");
  }

  private getMissionPath(missionId: string): string {
    return join(this.missionsDir, missionId, "mission.json");
  }

  private getIdempotencyPath(key: string): string {
    return join(this.idempotencyDir, `${sha256(key)}.json`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.missionsDir, { recursive: true });
    await mkdir(this.idempotencyDir, { recursive: true });
  }

  async createMission(input: {
    goal: string;
    budget?: Partial<MissionBudgetLimits>;
    idempotencyKey?: string;
  }): Promise<{ mission: MissionRecord; created: boolean }> {
    if (!input.goal || typeof input.goal !== "string" || input.goal.trim().length === 0) {
      throw new Error("goal must be a non-empty string");
    }

    // If an idempotency key is provided, acquire a lock on the idempotency
    // path and hold it for the entire creation to prevent duplicates.
    if (input.idempotencyKey) {
      const idemPath = this.getIdempotencyPath(input.idempotencyKey);
      return withFileLock(idemPath, async () => {
        const existing = await readJsonFile<{ missionId: string; jobId?: string }>(idemPath);
        if (existing) {
          const mission = await this.getMission(existing.missionId);
          if (mission) {
            return { mission, created: false };
          }
        }
        const result = await this.createMissionInner(input);
        await atomicWriteJson(idemPath, { missionId: result.mission.missionId });
        return result;
      });
    }

    return this.createMissionInner(input);
  }

  private async createMissionInner(input: {
    goal: string;
    budget?: Partial<MissionBudgetLimits>;
    idempotencyKey?: string;
  }): Promise<{ mission: MissionRecord; created: boolean }> {
    const missionId = generateMissionId();
    const now = nowIso();
    const mission: MissionRecord = {
      missionId,
      projectRoot: this.projectRoot,
      goal: input.goal.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    const missionPath = this.getMissionPath(missionId);
    await withFileLock(missionPath, async () => {
      await atomicWriteJson(missionPath, mission);
    });

    return { mission, created: true };
  }

  async getMission(missionId: string): Promise<MissionRecord | undefined> {
    const path = this.getMissionPath(missionId);
    return withFileLock(path, async () => {
      return await readJsonFile<MissionRecord>(path);
    });
  }

  async updateMission(
    missionId: string,
    updater: (current: MissionRecord) => MissionRecord
  ): Promise<MissionRecord> {
    const path = this.getMissionPath(missionId);
    return withFileLock(path, async () => {
      const current = await readJsonFile<MissionRecord>(path);
      if (!current) {
        throw new Error(`Mission ${missionId} not found`);
      }
      const updated = updater(current);
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async listMissions(): Promise<MissionRecord[]> {
    const entries: MissionRecord[] = [];
    try {
      const dirs = await readdir(this.missionsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const mission = await this.getMission(dir.name);
        if (mission) {
          entries.push(mission);
        }
      }
    } catch {
      // Directory may not exist yet
    }
    // Deterministic creation order: sort by createdAt, then missionId
    entries.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      return cmp !== 0 ? cmp : a.missionId.localeCompare(b.missionId);
    });
    return entries;
  }

  async getCurrentMissionId(): Promise<string | undefined> {
    const record = await withFileLock(this.currentMissionPath, async () => {
      return await readJsonFile<{ missionId: string }>(this.currentMissionPath);
    });
    return record?.missionId;
  }

  async setCurrentMissionId(missionId: string): Promise<void> {
    await withFileLock(this.currentMissionPath, async () => {
      await atomicWriteJson(this.currentMissionPath, {
        missionId,
        setAt: nowIso(),
      });
    });
  }
}
