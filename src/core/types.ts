/**
 * Mission artifact types — canonical truth structures for the Ratel AI Software Factory.
 */

export type ReportSource = "tool_submission" | "jsonl_fallback" | "missing";

export type MissionPhase =
  | "intake"
  | "discovery"
  | "clarification"
  | "constraint_analysis"
  | "validation_contract"
  | "feature_decomposition"
  | "user_approval"
  | "approved"
  | "execution"
  | "completed"
  | "halted";

export interface MissionRequirements {
  goal: string;
  productIntent: string;
  nonGoals: string[];
  deadlines?: string;
  riskTolerance: "low" | "medium" | "high";
  /** Explicit target directory for the mission workspace. When set, the factory uses this directory as the canonical git repo instead of auto-discovering sibling repos. */
  directory?: string;
}

export interface ValidationAssertion {
  id: string;
  title: string;
  description: string;
  evidenceType: "screenshot" | "test" | "log" | "manual";
  preconditions?: string[];
  successCriteria: string;
}

export interface ValidationContract {
  version: number;
  createdAt: string;
  assertions: ValidationAssertion[];
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  assertions: string[]; // assertion IDs this feature claims to satisfy
  milestoneId: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  commitSha?: string;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  featureIds: string[];
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export interface Decision {
  id: string;
  timestamp: string;
  context: string;
  decision: string;
  rationale: string;
}

export interface WorkerHandoff {
  featureId: string;
  completedAt: string;
  completed: string[];
  leftUndone: string[];
  commandsRun: Array<{ command: string; exitCode: number; output?: string }>;
  issuesDiscovered: Array<{ description: string; severity: "low" | "medium" | "high" }>;
  proceduresAbided: boolean;
  gitCommit?: string;
  summary: string;
}

export interface WorkerResult {
  featureId: string;
  /**
   * Always "unknown" — the deterministic layer does not decide pass/fail/blocked.
   * The orchestrator prompt inspects handoff fields and decides.
   */
  status: "unknown";
  handoff: WorkerHandoff;
  /**
   * Whether the worker's response was successfully parsed as a structured
   * JSONL handoff. "failed" means the worker did not produce a parseable
   * handoff (treat as a halt signal, do not infer success).
   */
  parseStatus: "ok" | "failed";
  /** Raw assistant text captured from the worker session. Used for audit and health checks. */
  rawResponse: string;
  error?: string;
  /** How the handoff was obtained: tool submission preferred, JSONL fallback, or missing. */
  reportSource?: ReportSource;
}

export interface WorkerRunReceipt {
  featureId: string;
  recordedAt: string;
  parseStatus: "ok" | "failed";
  reportSource: ReportSource;
  handoffPath: string;
  rawFilename: string;
  handoff: WorkerHandoff;
  workspace: import("./mission/worker-workspace.js").WorkerWorkspaceResult;
  workspaceFinalization: import("./mission/worker-workspace.js").WorkerWorkspaceResult;
}

/**
 * Details returned by validation tools (run_validation, run_user_testing).
 * The tool never declares pass/fail — it surfaces the raw output and a
 * parse status. The orchestrator decides what to do with it.
 */
export interface ValidationToolDetails {
  parseStatus: "ok" | "failed";
  rawFilename: string;
  /** Parsed structured report, or null if parsing failed. */
  report: ScrutinyReport | UserTestingReport | null;
}

export type IssueSeverity = "blocking" | "non-blocking" | "suggestion";

export type IssueCategory =
  | "test"
  | "typecheck"
  | "lint"
  | "code-review"
  | "behavioral"
  | "ux"
  | "performance";

export interface ValidationIssue {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  description: string;
  relatedFeatureId?: string;
  relatedScenario?: string; // e.g. "auth.feature: Scenario name"
  evidence?: string;
}

export interface CodeReviewResult {
  featureId: string;
  filesReviewed: string[];
  findings: string;
  severity: IssueSeverity;
  issues: Array<{
    id: string;
    severity: IssueSeverity;
    category: IssueCategory;
    description: string;
    evidence?: string;
  }>;
}

export interface ScrutinyReport {
  validatorType: "scrutiny";
  milestoneId: string;
  createdAt: string;
  automatedChecks: {
    tests: { passed: boolean; command: string; exitCode: number; output: string };
    typecheck: { passed: boolean; command: string; exitCode: number; output: string };
    lint: { passed: boolean; command: string; exitCode: number; output: string };
  };
  codeReviews: Array<{
    featureId: string;
    filesReviewed: string[];
    findings: string;
    severity: IssueSeverity;
  }>;
  issues: ValidationIssue[];
  summary: string;
}

export interface WorkerSkillsConfig {
  /** Skill names to ADD to the default set. Resolved from .pi/skills/ at spawn time. */
  additionalSkills: string[];
}

export interface UserTestingStepResult {
  keyword: "Given" | "When" | "Then" | "And" | "But";
  text: string;
  status: "passed" | "failed" | "skipped";
  screenshotPath?: string;
  consoleErrors?: string[];
  error?: string;
}

export interface UserTestingScenarioResult {
  featureFile: string;
  scenarioName: string;
  status: "passed" | "failed" | "skipped";
  steps: UserTestingStepResult[];
  screenshotPaths: string[];
  consoleErrors: string[];
  durationMs: number;
}

export interface UserTestingShard {
  shardId: string;
  milestoneId: string;
  featureFile: string;
  scenarioSelectors: string[];
  featureIds: string[];
  screenshotDir: string;
  assignedPort: number;
  timeoutMs: number;
}

export interface UserTestingShardReport {
  validatorType: "user-testing-shard";
  milestoneId: string;
  shardId: string;
  createdAt: string;
  featureFiles: string[];
  appStartCommand: string;
  baseURL: string;
  scenarioResults: UserTestingScenarioResult[];
  issues: ValidationIssue[];
  summary: string;
  durationMs: number;
  isolationNotes?: string;
}

export interface UserTestingShardRunResult {
  shard: UserTestingShard;
  parseStatus: "ok" | "failed";
  reportSource: ReportSource;
  rawFilename: string;
  reportPath?: string;
  report: UserTestingShardReport | null;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface UserTestingReport {
  validatorType: "user-testing";
  milestoneId: string;
  createdAt: string;
  appStartCommand: string;
  baseURL: string;
  scenarioResults: UserTestingScenarioResult[];
  issues: ValidationIssue[];
  summary: string;
  coverageStatus?: "complete" | "incomplete";
  shards?: Array<{
    shardId: string;
    featureFiles: string[];
    parseStatus: "ok" | "failed";
    reportSource: ReportSource;
    rawFilename: string;
    reportPath?: string;
    durationMs: number;
    timedOut: boolean;
    scenarioCount: number;
    issueCount: number;
  }>;
}

export interface MissionState {
  phase: MissionPhase;
  version: number;
  updatedAt: string;
  requirements?: MissionRequirements;
  constraints?: string;
  researchNotes?: string;
  validationContract?: ValidationContract;
  features?: Feature[];
  milestones?: Milestone[];
  decisions: Decision[];
}

export interface MissionStateFile {
  phase: MissionPhase;
  version: number;
  updatedAt: string;
  traceId?: string;
}

/** Names of all mission artifacts. */
export const ARTIFACT_NAMES = [
  "state.json",
  "requirements.json",
  "constraints.md",
  "research-notes.md",
  "validation-contract.md",
  "features.json",
  "milestones.json",
  "decision-log.md",
  "halt-reason.md",
  "agents.md",
  "worker-skills.json",
] as const;

export type ArtifactName = (typeof ARTIFACT_NAMES)[number];
