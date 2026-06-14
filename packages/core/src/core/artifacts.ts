/**
 * Mission artifact read/write utilities.
 * All canonical truth lives in .ratel/missions/<missionId>/
 */

import { mkdir, readFile, access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventLogger } from "./observability/event-logger.js";
import type {
  MissionState,
  MissionStateFile,
  MissionRequirements,
  ValidationContract,
  Feature,
  Milestone,
  Decision,
  ArtifactName,
  WorkerHandoff,
  ScrutinyReport,
  UserTestingReport,
  WorkerSkillsConfig,
} from "./types.js";
import {
  normalizeFeaturesDocument,
  normalizeMilestonesDocument,
  normalizeStateDocument,
  selectCompletedFeaturesForMilestone,
} from "./schema/mission-schema.js";
import { getMissionDir } from "./mission/scope.js";
import { atomicWriteJson, atomicWriteFile, readJsonFile } from "./mission/atomic-file.js";

export async function artifactExists(scope: import("./mission/scope.js").MissionScope, name: ArtifactName): Promise<boolean> {
  try {
    await access(join(getMissionDir(scope), name));
    return true;
  } catch {
    return false;
  }
}

export async function writeArtifact(
  scope: import("./mission/scope.js").MissionScope,
  name: ArtifactName,
  content: string,
  mode: "overwrite" | "append" = "overwrite",
  logger?: EventLogger,
): Promise<void> {
  await mkdir(getMissionDir(scope), { recursive: true });
  const path = join(getMissionDir(scope), name);
  if (mode === "append") {
    try {
      const existing = await readFile(path, "utf-8");
      content = existing.trimEnd() + "\n\n" + content;
    } catch {
      // file does not exist yet
    }
    await writeFile(path, content, "utf-8");
  } else {
    await atomicWriteFile(path, content);
  }

  const byteCount = Buffer.byteLength(content, "utf-8");
  logger?.artifactWrite(name, mode, byteCount);
}

export async function readArtifact(scope: import("./mission/scope.js").MissionScope, name: ArtifactName): Promise<string | undefined> {
  try {
    return await readFile(join(getMissionDir(scope), name), "utf-8");
  } catch {
    return undefined;
  }
}

export async function writeState(scope: import("./mission/scope.js").MissionScope, state: MissionStateFile): Promise<void> {
  await atomicWriteJson(join(getMissionDir(scope), "state.json"), state);
}

export async function readState(scope: import("./mission/scope.js").MissionScope): Promise<MissionStateFile | undefined> {
  return readJsonFile<MissionStateFile>(join(getMissionDir(scope), "state.json"));
}

export async function bumpVersion(scope: import("./mission/scope.js").MissionScope): Promise<number> {
  const state = (await readState(scope)) ?? { phase: "intake", version: 0, updatedAt: "" };
  state.version += 1;
  state.updatedAt = new Date().toISOString();
  await writeState(scope, state);
  return state.version;
}

export async function ensureMissionInitialized(
  scope: import("./mission/scope.js").MissionScope,
  logger?: EventLogger,
): Promise<MissionStateFile> {
  await mkdir(getMissionDir(scope), { recursive: true });
  const existing = await readState(scope);
  if (existing) {
    logger?.missionInitialized();
    return existing;
  }

  const initial: MissionStateFile = {
    phase: "intake",
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await writeState(scope, initial);

  // Seed empty decision log
  await writeArtifact(scope, "decision-log.md", "# Decision Log\n\n", "overwrite", logger);

  logger?.missionInitialized();

  return initial;
}

export async function writeRequirements(scope: import("./mission/scope.js").MissionScope, req: MissionRequirements): Promise<void> {
  await atomicWriteJson(join(getMissionDir(scope), "requirements.json"), req);
}

export async function readRequirements(scope: import("./mission/scope.js").MissionScope): Promise<MissionRequirements | undefined> {
  return readJsonFile<MissionRequirements>(join(getMissionDir(scope), "requirements.json"));
}

export async function writeValidationContract(scope: import("./mission/scope.js").MissionScope, contract: ValidationContract): Promise<void> {
  // Serialize to markdown for human readability + JSON for structure
  const lines: string[] = [`# Validation Contract v${contract.version}\n`, `**Created:** ${contract.createdAt}\n`];
  for (const a of contract.assertions) {
    lines.push(`## ${a.id}: ${a.title}`);
    lines.push(`**Description:** ${a.description}`);
    lines.push(`**Evidence Type:** ${a.evidenceType}`);
    if (a.preconditions?.length) lines.push(`**Preconditions:** ${a.preconditions.join("; ")}`);
    lines.push(`**Success Criteria:** ${a.successCriteria}\n`);
  }
  await atomicWriteFile(join(getMissionDir(scope), "validation-contract.md"), lines.join("\n"));
}

export async function readValidationContract(scope: import("./mission/scope.js").MissionScope): Promise<ValidationContract | undefined> {
  // For now, read the markdown. In a fuller implementation we could parse it.
  const raw = await readArtifact(scope, "validation-contract.md");
  if (!raw) return undefined;
  // Simple heuristic: if it starts with # Validation Contract, we treat it as present.
  // Full parsing would extract assertions with regex.
  return undefined; // placeholder
}

export async function writeFeatures(scope: import("./mission/scope.js").MissionScope, features: Feature[]): Promise<void> {
  const normalized = normalizeFeaturesDocument({ features });
  await atomicWriteJson(join(getMissionDir(scope), "features.json"), normalized);
}

export async function readFeatures(scope: import("./mission/scope.js").MissionScope): Promise<Feature[] | undefined> {
  const raw = await readJsonFile<{ features: Feature[] }>(join(getMissionDir(scope), "features.json"));
  if (!raw) return undefined;
  try {
    return normalizeFeaturesDocument(raw).features;
  } catch {
    return undefined;
  }
}

export async function getIntegratedFeaturesForMilestone(scope: import("./mission/scope.js").MissionScope, milestoneId: string): Promise<Feature[]> {
  const features = await readFeatures(scope);
  return features ? selectIntegratedFeaturesForMilestone(features, milestoneId) : [];
}

export async function writeMilestones(scope: import("./mission/scope.js").MissionScope, milestones: Milestone[]): Promise<void> {
  const normalized = normalizeMilestonesDocument({ milestones });
  await atomicWriteJson(join(getMissionDir(scope), "milestones.json"), normalized);
}

export async function readMilestones(scope: import("./mission/scope.js").MissionScope): Promise<Milestone[] | undefined> {
  const raw = await readJsonFile<{ milestones: Milestone[] }>(join(getMissionDir(scope), "milestones.json"));
  if (!raw) return undefined;
  try {
    return normalizeMilestonesDocument(raw).milestones;
  } catch {
    return undefined;
  }
}

export async function appendDecision(scope: import("./mission/scope.js").MissionScope, decision: Decision, logger?: EventLogger): Promise<void> {
  const entry = `## ${decision.id}
**Timestamp:** ${decision.timestamp}
**Context:** ${decision.context}
**Decision:** ${decision.decision}
**Rationale:** ${decision.rationale}\n`;
  await writeArtifact(scope, "decision-log.md", entry, "append", logger);
}

export async function readDecisionLog(scope: import("./mission/scope.js").MissionScope): Promise<Decision[] | undefined> {
  const raw = await readArtifact(scope, "decision-log.md");
  if (!raw) return undefined;
  // TODO: parse markdown into Decision[] if needed
  return undefined;
}

/**
 * Load the full mission state from all artifacts.
 * Returns a structured object suitable for injection into orchestrator context.
 */
export async function loadMissionState(scope: import("./mission/scope.js").MissionScope): Promise<MissionState> {
  const stateFile = await readState(scope);
  const requirements = await readRequirements(scope);
  const constraints = await readArtifact(scope, "constraints.md") ?? undefined;
  const researchNotes = await readArtifact(scope, "research-notes.md") ?? undefined;
  const validationContract = await readValidationContract(scope);
  const features = await readFeatures(scope);
  const milestones = await readMilestones(scope);

  return {
    phase: stateFile?.phase ?? "intake",
    version: stateFile?.version ?? 1,
    updatedAt: stateFile?.updatedAt ?? new Date().toISOString(),
    requirements,
    constraints,
    researchNotes,
    validationContract,
    features,
    milestones,
    decisions: [], // TODO: parse decision-log.md
  };
}

/**
 * Summarize mission state into a compact text block for prompt injection.
 */
export function summarizeMissionState(state: MissionState): string {
  const lines: string[] = [
    `## Current Mission State`,
    `Phase: ${state.phase}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.requirements) {
    lines.push(`\n### Requirements`);
    lines.push(`Goal: ${state.requirements.goal}`);
    lines.push(`Intent: ${state.requirements.productIntent}`);
    if (state.requirements.deadlines) lines.push(`Deadlines: ${state.requirements.deadlines}`);
    lines.push(`Risk Tolerance: ${state.requirements.riskTolerance}`);
  }

  if (state.constraints) {
    lines.push(`\n### Constraints`);
    lines.push(state.constraints.slice(0, 800)); // cap length
  }

  if (state.researchNotes) {
    lines.push(`\n### Research Notes`);
    lines.push(state.researchNotes.slice(0, 800));
  }

  if (state.validationContract) {
    lines.push(`\n### Validation Contract`);
    lines.push(`${state.validationContract.assertions.length} assertions defined.`);
  }

  if (state.features) {
    lines.push(`\n### Features`);
    lines.push(`${state.features.length} features across ${state.milestones?.length ?? 0} milestones.`);
  }

  return lines.join("\n");
}

export async function writeHandoff(scope: import("./mission/scope.js").MissionScope, handoff: WorkerHandoff): Promise<void> {
  const handoffDir = join(getMissionDir(scope), "handoffs");
  await mkdir(handoffDir, { recursive: true });
  const path = join(handoffDir, `${handoff.featureId}.json`);
  await atomicWriteJson(path, handoff);
}

export async function readHandoff(scope: import("./mission/scope.js").MissionScope, featureId: string): Promise<WorkerHandoff | undefined> {
  try {
    const raw = await readFile(join(getMissionDir(scope), "handoffs", `${featureId}.json`), "utf-8");
    return JSON.parse(raw) as WorkerHandoff;
  } catch {
    return undefined;
  }
}

export async function writeFeatureFile(scope: import("./mission/scope.js").MissionScope, filename: string, content: string): Promise<void> {
  const featuresDir = join(getMissionDir(scope), "features");
  await mkdir(featuresDir, { recursive: true });
  const path = join(featuresDir, filename);
  await atomicWriteFile(path, content);
}

export async function readFeatureFile(scope: import("./mission/scope.js").MissionScope, filename: string): Promise<string | undefined> {
  try {
    return await readFile(join(getMissionDir(scope), "features", filename), "utf-8");
  } catch {
    return undefined;
  }
}

export async function listFeatureFiles(scope: import("./mission/scope.js").MissionScope): Promise<string[]> {
  const featuresDir = join(getMissionDir(scope), "features");
  try {
    const entries = await readdir(featuresDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".feature")).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function writeValidationReport(scope: import("./mission/scope.js").MissionScope, report: ScrutinyReport): Promise<string> {
  const reportsDir = join(getMissionDir(scope), "validation-reports");
  await mkdir(reportsDir, { recursive: true });
  const filename = `${report.validatorType}-${report.milestoneId}-${Date.now()}.json`;
  const path = join(reportsDir, filename);
  await atomicWriteJson(path, report);
  return filename;
}

export async function listValidationReports(scope: import("./mission/scope.js").MissionScope, milestoneId?: string): Promise<string[]> {
  const reportsDir = join(getMissionDir(scope), "validation-reports");
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const reports = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name);
    if (milestoneId) {
      return reports.filter((name) => name.includes(`-${milestoneId}-`));
    }
    return reports;
  } catch {
    return [];
  }
}

export async function readValidationReport(scope: import("./mission/scope.js").MissionScope, filename: string): Promise<ScrutinyReport | undefined> {
  try {
    const raw = await readFile(
      join(getMissionDir(scope), "validation-reports", filename),
      "utf-8",
    );
    return JSON.parse(raw) as ScrutinyReport;
  } catch {
    return undefined;
  }
}

export async function readWorkerSkillsConfig(scope: import("./mission/scope.js").MissionScope): Promise<WorkerSkillsConfig | undefined> {
  const raw = await readArtifact(scope, "worker-skills.json");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as WorkerSkillsConfig;
  } catch {
    return undefined;
  }
}

export async function writeUserTestingReport(scope: import("./mission/scope.js").MissionScope, report: UserTestingReport): Promise<string> {
  const reportsDir = join(getMissionDir(scope), "validation-reports");
  await mkdir(reportsDir, { recursive: true });
  const filename = `user-testing-${report.milestoneId}-${Date.now()}.json`;
  const path = join(reportsDir, filename);
  await atomicWriteJson(path, report);
  return filename;
}

export async function listUserTestingReports(scope: import("./mission/scope.js").MissionScope, milestoneId?: string): Promise<string[]> {
  const reportsDir = join(getMissionDir(scope), "validation-reports");
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const reports = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name.startsWith("user-testing-"))
      .map((e) => e.name);
    if (milestoneId) {
      return reports.filter((name) => name.includes(`-${milestoneId}-`));
    }
    return reports;
  } catch {
    return [];
  }
}

export async function readUserTestingReport(scope: import("./mission/scope.js").MissionScope, filename: string): Promise<UserTestingReport | undefined> {
  try {
    const raw = await readFile(
      join(getMissionDir(scope), "validation-reports", filename),
      "utf-8",
    );
    return JSON.parse(raw) as UserTestingReport;
  } catch {
    return undefined;
  }
}
