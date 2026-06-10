import type { ArtifactName, Feature, Milestone, MissionPhase, MissionRequirements, MissionStateFile, WorkerSkillsConfig } from "./types.js";

export class MissionArtifactSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionArtifactSchemaError";
  }
}

export interface FeaturesDocument {
  features: Feature[];
}

export interface MilestonesDocument {
  milestones: Milestone[];
}

const STRUCTURED_ARTIFACTS = new Set<ArtifactName>([
  "state.json",
  "requirements.json",
  "features.json",
  "milestones.json",
  "worker-skills.json",
]);

const VALID_FEATURE_STATUSES = new Set<Feature["status"]>([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

const VALID_PHASES = new Set<MissionPhase>([
  "intake",
  "discovery",
  "clarification",
  "constraint_analysis",
  "validation_contract",
  "feature_decomposition",
  "user_approval",
  "approved",
  "execution",
  "completed",
  "halted",
]);

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionArtifactSchemaError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissionArtifactSchemaError(`${context} must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown, defaultValue: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : defaultValue;
}

function asStringArray(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new MissionArtifactSchemaError(`${context} must be an array of strings`);
  }
  return value;
}

function normalizeStatus(value: unknown, context: string): Feature["status"] {
  const raw = typeof value === "string" ? value : "pending";
  const normalized = raw === "complete" ? "completed" : raw;
  if (!VALID_FEATURE_STATUSES.has(normalized as Feature["status"])) {
    throw new MissionArtifactSchemaError(
      `${context} has invalid status "${raw}"; expected pending, in_progress, completed, blocked, or legacy complete`,
    );
  }
  return normalized as Feature["status"];
}

function normalizePhase(value: unknown): MissionPhase {
  const raw = typeof value === "string" ? value : "intake";
  if (!VALID_PHASES.has(raw as MissionPhase)) {
    throw new MissionArtifactSchemaError(`state.json has invalid phase "${raw}"`);
  }
  return raw as MissionPhase;
}

function parseJson(content: string, artifact: ArtifactName): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (err) {
    throw new MissionArtifactSchemaError(
      `${artifact} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function stringifyCanonical(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function isStructuredArtifact(name: ArtifactName): boolean {
  return STRUCTURED_ARTIFACTS.has(name);
}

export function normalizeFeature(input: unknown, index = 0): Feature {
  const record = asRecord(input, `features[${index}]`);
  const id = asString(record.id, `features[${index}].id`);
  const title = asOptionalString(record.title, asOptionalString(record.name, id));
  const description = asOptionalString(record.description, title);
  const assertions = asStringArray(record.assertions ?? record.covers, `features[${index}].assertions`);
  const milestoneId = asString(record.milestoneId ?? record.milestone, `features[${index}].milestoneId`);
  const status = normalizeStatus(record.status, `features[${index}]`);

  const canonical: Record<string, unknown> = {
    ...record,
    id,
    title,
    description,
    assertions,
    milestoneId,
    status,
  };

  delete canonical.name;
  delete canonical.covers;
  delete canonical.milestone;

  return canonical as unknown as Feature;
}

export function normalizeFeaturesDocument(input: unknown): FeaturesDocument {
  const record = asRecord(input, "features.json");
  if (!Array.isArray(record.features)) {
    throw new MissionArtifactSchemaError("features.json.features must be an array");
  }
  return {
    features: record.features.map((feature, index) => normalizeFeature(feature, index)),
  };
}

export function normalizeMilestone(input: unknown, index = 0): Milestone {
  const record = asRecord(input, `milestones[${index}]`);
  const id = asString(record.id, `milestones[${index}].id`);
  const title = asOptionalString(record.title, asOptionalString(record.name, id));
  const description = asOptionalString(record.description, title);
  const featureIds = asStringArray(record.featureIds ?? record.features, `milestones[${index}].featureIds`);
  const status = normalizeStatus(record.status, `milestones[${index}]`);

  const canonical: Record<string, unknown> = {
    ...record,
    id,
    title,
    description,
    featureIds,
    status,
  };

  delete canonical.name;
  delete canonical.features;

  return canonical as unknown as Milestone;
}

export function normalizeMilestonesDocument(input: unknown): MilestonesDocument {
  const record = asRecord(input, "milestones.json");
  if (!Array.isArray(record.milestones)) {
    throw new MissionArtifactSchemaError("milestones.json.milestones must be an array");
  }
  return {
    milestones: record.milestones.map((milestone, index) => normalizeMilestone(milestone, index)),
  };
}

export function normalizeStateDocument(input: unknown): MissionStateFile {
  const record = asRecord(input, "state.json");
  const version = typeof record.version === "number" && Number.isInteger(record.version) && record.version >= 0
    ? record.version
    : 1;
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0
    ? record.updatedAt
    : new Date().toISOString();

  return {
    ...record,
    phase: normalizePhase(record.phase),
    version,
    updatedAt,
  } as MissionStateFile;
}

function asOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function normalizeRequirementsDocument(input: unknown): MissionRequirements {
  const record = asRecord(input, "requirements.json");
  return {
    ...record,
    goal: asString(record.goal, "requirements.json.goal"),
    productIntent: asString(record.productIntent, "requirements.json.productIntent"),
    nonGoals: asStringArray(record.nonGoals, "requirements.json.nonGoals"),
    riskTolerance: (record.riskTolerance === "low" || record.riskTolerance === "medium" || record.riskTolerance === "high")
      ? record.riskTolerance
      : "medium",
    directory: asOptionalStringValue(record.directory),
  } as MissionRequirements;
}

export function normalizeWorkerSkillsDocument(input: unknown): WorkerSkillsConfig {
  const record = asRecord(input, "worker-skills.json");
  return {
    additionalSkills: asStringArray(record.additionalSkills, "worker-skills.json.additionalSkills"),
  };
}

export function canonicalizeMissionArtifactContent(name: ArtifactName, content: string): string {
  if (!isStructuredArtifact(name)) return content;

  const parsed = parseJson(content, name);
  switch (name) {
    case "features.json":
      return stringifyCanonical(normalizeFeaturesDocument(parsed));
    case "milestones.json":
      return stringifyCanonical(normalizeMilestonesDocument(parsed));
    case "state.json":
      return stringifyCanonical(normalizeStateDocument(parsed));
    case "requirements.json":
      return stringifyCanonical(normalizeRequirementsDocument(parsed));
    case "worker-skills.json":
      return stringifyCanonical(normalizeWorkerSkillsDocument(parsed));
    default:
      return content;
  }
}

export function getFeatureMilestoneId(feature: Feature): string {
  return feature.milestoneId;
}

export function isFeatureCompleted(feature: Feature): boolean {
  return feature.status === "completed";
}

export function selectCompletedFeaturesForMilestone(features: Feature[], milestoneId: string): Feature[] {
  return features.filter(
    (feature) => getFeatureMilestoneId(feature) === milestoneId && isFeatureCompleted(feature),
  );
}
