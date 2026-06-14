import { join } from "node:path";

export interface MissionScope {
  projectRoot: string;
  missionId: string;
}

const MISSION_ID_REGEX = /^mis_[A-Za-z0-9_-]{8,80}$/;

/**
 * Validate a mission ID.
 * Rejects path traversal, whitespace, and shell metacharacters explicitly
 * even if the regex does not allow them.
 */
export function assertValidMissionId(missionId: string): void {
  if (typeof missionId !== "string" || missionId.length === 0) {
    throw new Error(`Invalid missionId: must be a non-empty string`);
  }
  if (missionId.includes("/") || missionId.includes("\\") || missionId.includes("..") || missionId.includes(" ")) {
    throw new Error(`Invalid missionId: contains path traversal or whitespace characters`);
  }
  if (!MISSION_ID_REGEX.test(missionId)) {
    throw new Error(`Invalid missionId: must match ${MISSION_ID_REGEX.source}`);
  }
}

export function createMissionScope(projectRoot: string, missionId: string): MissionScope {
  assertValidMissionId(missionId);
  return { projectRoot, missionId };
}

export function getRatelDir(projectRoot: string): string {
  return join(projectRoot, ".ratel");
}

export function getMissionDir(scope: MissionScope): string {
  return join(getRatelDir(scope.projectRoot), "missions", scope.missionId);
}

export function getMissionRelativeDir(scope: MissionScope): string {
  return join(".ratel", "missions", scope.missionId);
}
