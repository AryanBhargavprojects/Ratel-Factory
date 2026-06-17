import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FallbackModelConfig } from "../config.js";
import { getFallbackModelConfig } from "../config.js";
import { getMissionDir, type MissionScope } from "./scope.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** Serializable snapshot of the fallback model config for all three agent levels. */
export interface MissionModelConfigSnapshot {
  orchestrator: FallbackModelConfig;
  worker: FallbackModelConfig;
  validator: FallbackModelConfig;
}

export interface MissionModelConfigFile {
  schemaVersion: 1;
  configDigest: string;
  capturedAt: string;
  config: MissionModelConfigSnapshot;
}

// ── Digest ───────────────────────────────────────────────────────────────

function computeModelConfigDigest(config: MissionModelConfigSnapshot): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(config));
  return hash.digest("hex");
}

export async function captureProjectModelConfig(projectRoot: string): Promise<{
  config: MissionModelConfigSnapshot;
  configDigest: string;
}> {
  const projectConfig = await getFallbackModelConfig(projectRoot);
  const config: MissionModelConfigSnapshot = {
    orchestrator: {
      model: projectConfig.orchestrator.model,
      fallbackModels: [...(projectConfig.orchestrator.fallbackModels ?? [])],
    },
    worker: {
      model: projectConfig.worker.model,
      fallbackModels: [...(projectConfig.worker.fallbackModels ?? [])],
    },
    validator: {
      model: projectConfig.validator.model,
      fallbackModels: [...(projectConfig.validator.fallbackModels ?? [])],
    },
  };
  return {
    config,
    configDigest: computeModelConfigDigest(config),
  };
}

export async function readMissionModelConfig(
  scope: MissionScope,
): Promise<MissionModelConfigSnapshot> {
  const snapshotPath = join(getMissionDir(scope), "model-config.json");
  let raw: string;
  try {
    raw = await readFile(snapshotPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return (await captureProjectModelConfig(scope.projectRoot)).config;
    }
    throw error;
  }

  let snapshot: MissionModelConfigFile;
  try {
    snapshot = JSON.parse(raw) as MissionModelConfigFile;
  } catch {
    throw new Error(`Invalid mission model configuration snapshot: ${snapshotPath}`);
  }

  if (
    snapshot.schemaVersion !== 1
    || !isModelConfigSnapshot(snapshot.config)
    || typeof snapshot.configDigest !== "string"
    || computeModelConfigDigest(snapshot.config) !== snapshot.configDigest
  ) {
    throw new Error(`Invalid mission model configuration snapshot: ${snapshotPath}`);
  }

  return snapshot.config;
}

function isModelConfigSnapshot(value: unknown): value is MissionModelConfigSnapshot {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return ["orchestrator", "worker", "validator"].every((role) => {
    const chain = config[role];
    if (!chain || typeof chain !== "object") return false;
    const record = chain as Record<string, unknown>;
    return (
      (record.model === null || typeof record.model === "string")
      && Array.isArray(record.fallbackModels)
      && record.fallbackModels.every((model) => typeof model === "string")
    );
  });
}
