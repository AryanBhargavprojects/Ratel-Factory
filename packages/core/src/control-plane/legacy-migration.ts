/**
 * One-time legacy migration from `.missions/current` to `.ratel/missions/<missionId>/`.
 *
 * Rules:
 * 1. When `.missions/current` exists and `.ratel/migration-v1.json` does not:
 *    - Read legacy `state.json`
 *    - If `traceId` matches mission-ID regex, reuse it. Otherwise strip invalid
 *      chars, prefix with `mis_` if suffix >= 8 chars. Otherwise generate
 *      `mis_<uuid-without-dashes>`.
 *    - Recursively copy legacy directory into `.ratel/missions/<missionId>`.
 *    - Never delete or modify `.missions/current`.
 *    - Write `mission.json`.
 *    - Write `.ratel/current-mission.json`.
 *    - Write `.ratel/migration-v1.json`.
 * 2. Idempotent: if `.ratel/migration-v1.json` exists, do nothing.
 */

import { mkdir, copyFile, readFile, writeFile, readdir, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getRatelDir } from "../core/mission/scope.js";

export interface LegacyMigrationResult {
  migrated: boolean;
  missionId?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readLegacyState(projectRoot: string): Promise<{ traceId?: string } | undefined> {
  try {
    const raw = await readFile(join(projectRoot, ".missions", "current", "state.json"), "utf-8");
    return JSON.parse(raw) as { traceId?: string };
  } catch {
    return undefined;
  }
}

const MISSION_ID_REGEX = /^mis_[A-Za-z0-9_-]{8,80}$/;

function generateMissionId(traceId?: string): string {
  if (traceId && MISSION_ID_REGEX.test(traceId)) {
    return traceId;
  }
  let suffix = traceId
    ? traceId.replace(/[^A-Za-z0-9_-]/g, "")
    : "";
  if (suffix.length >= 8) {
    return `mis_${suffix}`;
  }
  return `mis_${randomUUID().replace(/-/g, "")}`;
}

async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

export async function runLegacyMigration(projectRoot: string): Promise<LegacyMigrationResult> {
  const legacyDir = join(projectRoot, ".missions", "current");
  const ratelDir = getRatelDir(projectRoot);
  const migrationRecordPath = join(ratelDir, "migration-v1.json");

  if (!(await pathExists(legacyDir))) {
    return { migrated: false };
  }

  if (await pathExists(migrationRecordPath)) {
    try {
      const record = JSON.parse(await readFile(migrationRecordPath, "utf-8")) as { missionId?: string };
      return { migrated: false, missionId: record.missionId };
    } catch {
      return { migrated: false };
    }
  }

  const legacyState = await readLegacyState(projectRoot);
  const missionId = generateMissionId(legacyState?.traceId);
  const missionDir = join(ratelDir, "missions", missionId);

  await copyDirectoryRecursive(legacyDir, missionDir);

  await writeFile(
    join(missionDir, "mission.json"),
    JSON.stringify({ missionId, migratedFrom: ".missions/current", migratedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf-8",
  );

  await writeFile(
    join(ratelDir, "current-mission.json"),
    JSON.stringify({ missionId, setAt: new Date().toISOString() }, null, 2) + "\n",
    "utf-8",
  );

  await writeFile(
    migrationRecordPath,
    JSON.stringify({ migrated: true, missionId, migratedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf-8",
  );

  return { migrated: true, missionId };
}
