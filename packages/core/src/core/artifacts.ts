/**
 * Mission artifact read/write utilities.
 * All canonical truth lives in .missions/current/
 */

import { mkdir, readFile, writeFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalLogger } from "./observability/event-logger.js";
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

export const MISSION_DIR = ".missions/current";

export function getMissionDir(cwd: string): string {
  return join(cwd, MISSION_DIR);
}

async function ensureMissionDir(cwd: string): Promise<void> {
  await mkdir(getMissionDir(cwd), { recursive: true });
}

export async function artifactExists(cwd: string, name: ArtifactName): Promise<boolean> {
  try {
    await access(join(getMissionDir(cwd), name));
    return true;
  } catch {
    return false;
  }
}

export async function writeArtifact(
  cwd: string,
  name: ArtifactName,
  content: string,
  mode: "overwrite" | "append" = "overwrite",
): Promise<void> {
  await ensureMissionDir(cwd);
  const path = join(getMissionDir(cwd), name);
  if (mode === "append") {
    try {
      const existing = await readFile(path, "utf-8");
      content = existing.trimEnd() + "\n\n" + content;
    } catch {
      // file does not exist yet
    }
  }
  await writeFile(path, content, "utf-8");

  const byteCount = Buffer.byteLength(content, "utf-8");
  getGlobalLogger()?.artifactWrite(name, mode, byteCount);
}

export async function readArtifact(cwd: string, name: ArtifactName): Promise<string | undefined> {
  try {
    return await readFile(join(getMissionDir(cwd), name), "utf-8");
  } catch {
    return undefined;
  }
}

export async function writeState(cwd: string, state: MissionStateFile): Promise<void> {
  await writeArtifact(cwd, "state.json", JSON.stringify(state, null, 2));
}

export async function readState(cwd: string): Promise<MissionStateFile | undefined> {
  const raw = await readArtifact(cwd, "state.json");
  if (!raw) return undefined;
  try {
    return normalizeStateDocument(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function bumpVersion(cwd: string): Promise<number> {
  const state = (await readState(cwd)) ?? { phase: "intake", version: 0, updatedAt: "" };
  state.version += 1;
  state.updatedAt = new Date().toISOString();
  await writeState(cwd, state);
  return state.version;
}

export async function ensureMissionInitialized(cwd: string): Promise<MissionStateFile> {
  await ensureMissionDir(cwd);
  const existing = await readState(cwd);
  if (existing) {
    getGlobalLogger()?.missionInitialized();
    return existing;
  }

  const initial: MissionStateFile = {
    phase: "intake",
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await writeState(cwd, initial);

  // Seed empty decision log
  await writeArtifact(cwd, "decision-log.md", "# Decision Log\n\n", "overwrite");

  getGlobalLogger()?.missionInitialized();

  return initial;
}

export async function writeRequirements(cwd: string, req: MissionRequirements): Promise<void> {
  await writeArtifact(cwd, "requirements.json", JSON.stringify(req, null, 2));
}

export async function readRequirements(cwd: string): Promise<MissionRequirements | undefined> {
  const raw = await readArtifact(cwd, "requirements.json");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as MissionRequirements;
  } catch {
    return undefined;
  }
}

export async function writeValidationContract(cwd: string, contract: ValidationContract): Promise<void> {
  // Serialize to markdown for human readability + JSON for structure
  const lines: string[] = [`# Validation Contract v${contract.version}\n`, `**Created:** ${contract.createdAt}\n`];
  for (const a of contract.assertions) {
    lines.push(`## ${a.id}: ${a.title}`);
    lines.push(`**Description:** ${a.description}`);
    lines.push(`**Evidence Type:** ${a.evidenceType}`);
    if (a.preconditions?.length) lines.push(`**Preconditions:** ${a.preconditions.join("; ")}`);
    lines.push(`**Success Criteria:** ${a.successCriteria}\n`);
  }
  await writeArtifact(cwd, "validation-contract.md", lines.join("\n"));
}

export async function readValidationContract(cwd: string): Promise<ValidationContract | undefined> {
  // For now, read the markdown. In a fuller implementation we could parse it.
  const raw = await readArtifact(cwd, "validation-contract.md");
  if (!raw) return undefined;
  // Simple heuristic: if it starts with # Validation Contract, we treat it as present.
  // Full parsing would extract assertions with regex.
  return undefined; // placeholder
}

export async function writeFeatures(cwd: string, features: Feature[]): Promise<void> {
  const normalized = normalizeFeaturesDocument({ features });
  await writeArtifact(cwd, "features.json", JSON.stringify(normalized, null, 2));
}

export async function readFeatures(cwd: string): Promise<Feature[] | undefined> {
  const raw = await readArtifact(cwd, "features.json");
  if (!raw) return undefined;
  try {
    return normalizeFeaturesDocument(JSON.parse(raw)).features;
  } catch {
    return undefined;
  }
}

export async function getCompletedFeaturesForMilestone(cwd: string, milestoneId: string): Promise<Feature[]> {
  const features = await readFeatures(cwd);
  return features ? selectCompletedFeaturesForMilestone(features, milestoneId) : [];
}

export async function writeMilestones(cwd: string, milestones: Milestone[]): Promise<void> {
  const normalized = normalizeMilestonesDocument({ milestones });
  await writeArtifact(cwd, "milestones.json", JSON.stringify(normalized, null, 2));
}

export async function readMilestones(cwd: string): Promise<Milestone[] | undefined> {
  const raw = await readArtifact(cwd, "milestones.json");
  if (!raw) return undefined;
  try {
    return normalizeMilestonesDocument(JSON.parse(raw)).milestones;
  } catch {
    return undefined;
  }
}

export async function appendDecision(cwd: string, decision: Decision): Promise<void> {
  const entry = `## ${decision.id}
**Timestamp:** ${decision.timestamp}
**Context:** ${decision.context}
**Decision:** ${decision.decision}
**Rationale:** ${decision.rationale}\n`;
  await writeArtifact(cwd, "decision-log.md", entry, "append");
}

export async function readDecisionLog(cwd: string): Promise<Decision[] | undefined> {
  const raw = await readArtifact(cwd, "decision-log.md");
  if (!raw) return undefined;
  // TODO: parse markdown into Decision[] if needed
  return undefined;
}

/**
 * Load the full mission state from all artifacts.
 * Returns a structured object suitable for injection into orchestrator context.
 */
export async function loadMissionState(cwd: string): Promise<MissionState> {
  const stateFile = await readState(cwd);
  const requirements = await readRequirements(cwd);
  const constraints = await readArtifact(cwd, "constraints.md") ?? undefined;
  const researchNotes = await readArtifact(cwd, "research-notes.md") ?? undefined;
  const validationContract = await readValidationContract(cwd);
  const features = await readFeatures(cwd);
  const milestones = await readMilestones(cwd);

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

export async function writeHandoff(cwd: string, handoff: WorkerHandoff): Promise<void> {
  const handoffDir = join(getMissionDir(cwd), "handoffs");
  await mkdir(handoffDir, { recursive: true });
  const path = join(handoffDir, `${handoff.featureId}.json`);
  await writeFile(path, JSON.stringify(handoff, null, 2), "utf-8");
}

export async function readHandoff(cwd: string, featureId: string): Promise<WorkerHandoff | undefined> {
  try {
    const raw = await readFile(join(getMissionDir(cwd), "handoffs", `${featureId}.json`), "utf-8");
    return JSON.parse(raw) as WorkerHandoff;
  } catch {
    return undefined;
  }
}

export async function writeFeatureFile(cwd: string, filename: string, content: string): Promise<void> {
  const featuresDir = join(getMissionDir(cwd), "features");
  await mkdir(featuresDir, { recursive: true });
  const path = join(featuresDir, filename);
  await writeFile(path, content, "utf-8");
}

export async function readFeatureFile(cwd: string, filename: string): Promise<string | undefined> {
  try {
    return await readFile(join(getMissionDir(cwd), "features", filename), "utf-8");
  } catch {
    return undefined;
  }
}

export async function listFeatureFiles(cwd: string): Promise<string[]> {
  const featuresDir = join(getMissionDir(cwd), "features");
  try {
    const entries = await readdir(featuresDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".feature")).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function writeValidationReport(cwd: string, report: ScrutinyReport): Promise<void> {
  const reportsDir = join(getMissionDir(cwd), "validation-reports");
  await mkdir(reportsDir, { recursive: true });
  const filename = `${report.validatorType}-${report.milestoneId}-${Date.now()}.json`;
  const path = join(reportsDir, filename);
  await writeFile(path, JSON.stringify(report, null, 2), "utf-8");
}

export async function listValidationReports(cwd: string, milestoneId?: string): Promise<string[]> {
  const reportsDir = join(getMissionDir(cwd), "validation-reports");
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

export async function readValidationReport(cwd: string, filename: string): Promise<ScrutinyReport | undefined> {
  try {
    const raw = await readFile(
      join(getMissionDir(cwd), "validation-reports", filename),
      "utf-8",
    );
    return JSON.parse(raw) as ScrutinyReport;
  } catch {
    return undefined;
  }
}

export async function readWorkerSkillsConfig(cwd: string): Promise<WorkerSkillsConfig | undefined> {
  const raw = await readArtifact(cwd, "worker-skills.json");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as WorkerSkillsConfig;
  } catch {
    return undefined;
  }
}

export async function writeUserTestingReport(cwd: string, report: UserTestingReport): Promise<void> {
  const reportsDir = join(getMissionDir(cwd), "validation-reports");
  await mkdir(reportsDir, { recursive: true });
  const filename = `user-testing-${report.milestoneId}-${Date.now()}.json`;
  const path = join(reportsDir, filename);
  await writeFile(path, JSON.stringify(report, null, 2), "utf-8");
}

export async function listUserTestingReports(cwd: string, milestoneId?: string): Promise<string[]> {
  const reportsDir = join(getMissionDir(cwd), "validation-reports");
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

export async function readUserTestingReport(cwd: string, filename: string): Promise<UserTestingReport | undefined> {
  try {
    const raw = await readFile(
      join(getMissionDir(cwd), "validation-reports", filename),
      "utf-8",
    );
    return JSON.parse(raw) as UserTestingReport;
  } catch {
    return undefined;
  }
}
