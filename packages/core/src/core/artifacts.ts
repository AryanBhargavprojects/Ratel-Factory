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
  ValidationAssertion,
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
import { indexGherkinFeature } from "./mission/gherkin-index.js";

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
  const missionDir = getMissionDir(scope);

  // 1. Canonical JSON
  await atomicWriteJson(join(missionDir, "validation-contract.json"), contract);

  // 2. Human-readable markdown projection
  const lines: string[] = [`# Validation Contract v${contract.version}`, `**Created:** ${contract.createdAt}`];
  if (contract.gaps.length > 0) {
    lines.push(`## Gaps`);
    for (const g of contract.gaps) lines.push(`- ${g}`);
  }
  if (contract.crossCuttingAssertions.length > 0) {
    lines.push(`## Cross-cutting Assertions`);
    for (const c of contract.crossCuttingAssertions) lines.push(`- ${c}`);
  }
  lines.push(`## Assertions`);
  for (const a of contract.assertions) {
    lines.push(`### ${a.id}: ${a.title}`);
    lines.push(`**Feature:** ${a.featureFile}`);
    lines.push(`**Scenario:** ${a.scenario}`);
    lines.push(`**Description:** ${a.description}`);
    lines.push(`**Evidence Type:** ${a.evidenceType}`);
    if (a.requirementRefs.length) lines.push(`**Requirement Refs:** ${a.requirementRefs.join(", ")}`);
    if (a.preconditions?.length) lines.push(`**Preconditions:** ${a.preconditions.join("; ")}`);
    lines.push(`**Success Criteria:** ${a.successCriteria}`);
  }
  await atomicWriteFile(join(missionDir, "validation-contract.md"), lines.join("\n\n") + "\n");
}

/**
 * Compute a simple deterministic hash for legacy assertion IDs.
 * Uses djb2 over the input string.
 */
function djb2Hash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i); // hash * 33 + c
    hash = hash & 0xffffffff; // keep 32-bit
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createLegacyAssertionId(featureFile: string, scenario: string): string {
  return `LEGACY-${djb2Hash(`${featureFile}:${scenario}`)}`;
}

export async function readValidationContract(scope: import("./mission/scope.js").MissionScope): Promise<ValidationContract | undefined> {
  const missionDir = getMissionDir(scope);

  // 1. Prefer canonical JSON
  const jsonPath = join(missionDir, "validation-contract.json");
  const jsonRaw = await readJsonFile<ValidationContract>(jsonPath);
  if (jsonRaw) {
    // Structural validation
    if (
      typeof jsonRaw.version === "number" &&
      typeof jsonRaw.createdAt === "string" &&
      Array.isArray(jsonRaw.assertions) &&
      jsonRaw.assertions.every(
        (a) =>
          typeof a.id === "string" &&
          typeof a.title === "string" &&
          typeof a.description === "string" &&
          typeof a.featureFile === "string" &&
          typeof a.scenario === "string" &&
          ["screenshot", "test", "log", "manual"].includes(a.evidenceType) &&
          Array.isArray(a.requirementRefs) &&
          typeof a.successCriteria === "string"
      ) &&
      Array.isArray(jsonRaw.gaps) &&
      Array.isArray(jsonRaw.crossCuttingAssertions)
    ) {
      return jsonRaw;
    }
    // Invalid JSON schema — fall through to legacy parsing if available
  }

  // 2. Legacy fallback: markdown + feature files
  const mdRaw = await readArtifact(scope, "validation-contract.md");
  if (!mdRaw) return undefined;

  const versionMatch = mdRaw.match(/#\s*Validation Contract v?(\d+)/i);
  const createdMatch = mdRaw.match(/\*\*Created:\*\*\s*(.+)/i);

  const featureFiles = await listFeatureFiles(scope);
  if (featureFiles.length === 0) return undefined;

  const assertions: ValidationAssertion[] = [];
  for (const filename of featureFiles) {
    const content = await readFeatureFile(scope, filename);
    if (!content) continue;
    try {
      const index = indexGherkinFeature(filename, content);
      for (const sc of index.scenarios) {
        assertions.push({
          id: createLegacyAssertionId(filename, sc.name),
          title: sc.name,
          description: `Scenario from ${filename}`,
          featureFile: filename,
          scenario: sc.name,
          evidenceType: "manual",
          requirementRefs: [],
          successCriteria: "Pass this scenario",
        });
      }
    } catch {
      // Duplicate scenario names or parse errors → reject contract
      return undefined;
    }
  }

  if (assertions.length === 0) return undefined;

  const gaps: string[] = [];
  const crossCutting: string[] = [];

  // Extract gaps from markdown if present
  const gapsSection = mdRaw.match(/##\s*Gaps[\s\S]*?(?=##|$)/i);
  if (gapsSection) {
    for (const line of gapsSection[0].split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) gaps.push(trimmed.slice(2).trim());
    }
  }

  // Extract cross-cutting assertions from markdown if present
  const crossSection = mdRaw.match(/##\s*Cross-cutting[\s\S]*?(?=##|$)/i);
  if (crossSection) {
    for (const line of crossSection[0].split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) crossCutting.push(trimmed.slice(2).trim());
    }
  }

  return {
    version: versionMatch ? parseInt(versionMatch[1], 10) : 1,
    createdAt: createdMatch ? createdMatch[1].trim() : new Date().toISOString(),
    assertions,
    gaps,
    crossCuttingAssertions: crossCutting,
  };
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
  return features ? selectCompletedFeaturesForMilestone(features, milestoneId) : [];
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
  const missionDir = getMissionDir(scope);

  // 1. Append canonical JSONL first
  const jsonlPath = join(missionDir, "decisions.jsonl");
  let jsonlContent = "";
  try {
    jsonlContent = await readFile(jsonlPath, "utf-8");
  } catch {
    // file may not exist yet
  }
  const line = JSON.stringify(decision);
  jsonlContent = jsonlContent.trimEnd() + "\n" + line + "\n";
  await atomicWriteFile(jsonlPath, jsonlContent);

  // 2. Render markdown projection
  try {
    const entry = `## ${decision.id}\n**Timestamp:** ${decision.timestamp}\n**Context:** ${decision.context}\n**Decision:** ${decision.decision}\n**Rationale:** ${decision.rationale}\n`;
    await writeArtifact(scope, "decision-log.md", entry, "append", logger);
  } catch (err) {
    // Markdown projection failure must not roll back canonical JSONL
    console.error(`[appendDecision] markdown projection failed for ${decision.id}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function readDecisionLog(scope: import("./mission/scope.js").MissionScope): Promise<Decision[] | undefined> {
  const missionDir = getMissionDir(scope);

  // 1. Prefer canonical JSONL
  try {
    const jsonlRaw = await readFile(join(missionDir, "decisions.jsonl"), "utf-8");
    const lines = jsonlRaw.trimEnd().split("\n").filter((l) => l.trim().length > 0);
    const decisions: Decision[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]) as Decision;
        if (
          typeof parsed.id === "string" &&
          typeof parsed.timestamp === "string" &&
          typeof parsed.context === "string" &&
          typeof parsed.decision === "string" &&
          typeof parsed.rationale === "string"
        ) {
          decisions.push(parsed);
        }
      } catch {
        // tolerate truncated final line only
        if (i === lines.length - 1) {
          // ignore malformed last line
        }
        // malformed non-final lines are silently skipped
      }
    }
    if (decisions.length > 0) return decisions;
    // empty JSONL — fall through to markdown fallback
  } catch {
    // decisions.jsonl missing — fall through
  }

  // 2. Legacy markdown fallback
  const mdRaw = await readArtifact(scope, "decision-log.md");
  if (!mdRaw) return undefined;

  return parseLegacyDecisionLog(mdRaw);
}

/**
 * Parse the exact legacy markdown decision log format.
 * Multiline values continue until the next bold field or decision heading.
 */
function parseLegacyDecisionLog(mdRaw: string): Decision[] | undefined {
  const decisions: Decision[] = [];
  const headingRegex = /^##\s*(DEC-[A-Za-z0-9_-]+)\s*$/gm;
  let match: RegExpExecArray | null;
  const sections: Array<{ id: string; body: string }> = [];

  while ((match = headingRegex.exec(mdRaw)) !== null) {
    const start = match.index + match[0].length;
    const nextMatch = headingRegex.exec(mdRaw);
    const end = nextMatch ? nextMatch.index : mdRaw.length;
    sections.push({ id: match[1], body: mdRaw.slice(start, end) });
    if (!nextMatch) break;
    headingRegex.lastIndex = nextMatch.index;
  }

  for (const section of sections) {
    const fieldPattern = /\*\*(\w+):\*\*\s*/g;
    const fields: Record<string, string> = {};
    let fm: RegExpExecArray | null;
    const fieldStarts: Array<{ key: string; contentStart: number; headerStart: number }> = [];

    while ((fm = fieldPattern.exec(section.body)) !== null) {
      fieldStarts.push({ key: fm[1], contentStart: fm.index + fm[0].length, headerStart: fm.index });
    }

    for (let i = 0; i < fieldStarts.length; i++) {
      const { key, contentStart } = fieldStarts[i];
      const end = i + 1 < fieldStarts.length ? fieldStarts[i + 1].headerStart : section.body.length;
      fields[key] = section.body.slice(contentStart, end).trim();
    }

    if (fields.Timestamp && fields.Context && fields.Decision && fields.Rationale) {
      decisions.push({
        id: section.id,
        timestamp: fields.Timestamp,
        context: fields.Context,
        decision: fields.Decision,
        rationale: fields.Rationale,
      });
    }
  }

  return decisions.length > 0 ? decisions : undefined;
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
  const decisions = (await readDecisionLog(scope)) ?? [];

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
    decisions,
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
    lines.push(`Version: ${state.validationContract.version}`);
    lines.push(`${state.validationContract.assertions.length} assertions defined.`);
    if (state.validationContract.gaps.length > 0) {
      lines.push(`Gaps:`);
      for (const g of state.validationContract.gaps.slice(0, 5)) {
        lines.push(`- ${g}`);
      }
    }
  }

  if (state.features) {
    lines.push(`\n### Features`);
    lines.push(`${state.features.length} features across ${state.milestones?.length ?? 0} milestones.`);
  }

  if (state.decisions.length > 0) {
    lines.push(`\n### Recent Decisions`);
    const recent = state.decisions.slice(-5).reverse();
    for (const d of recent) {
      const text = `${d.id}: ${d.decision}`.slice(0, 120);
      lines.push(`- ${text}`);
    }
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
