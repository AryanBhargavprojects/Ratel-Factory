/**
 * Shared worker execution logic — extracted from runWorkerTool so the
 * core service can spawn workers without duplicating business logic.
 */

import type {
  Feature,
  WorkerResult,
  ReportSource,
} from "../types.js";
import type { WorkerWorkspaceResult } from "../mission/worker-workspace.js";
import {
  resolveFeatureAssertions,
  formatFeatureAssertionsForPrompt,
  type ResolvedFeatureAssertions,
} from "../mission/feature-assertions.js";
import {
  prepareSerialWorkerBranch,
  copyFeatureFilesToWorkspace,
  finalizeSerialWorkerBranch,
} from "../mission/worker-workspace.js";
import {
  readArtifact,
  writeHandoff,
  readWorkerSkillsConfig,
} from "../artifacts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "../utils/skills.js";
import { getModelConfig } from "../config.js";
import { spawnWorkerAgent } from "./worker.js";
import { writeWorkerRawOutput } from "./worker-output.js";
import { persistWorkerReceipt } from "../report-submission.js";

export interface RunWorkerOptions {
  feature: Feature;
  cwd: string;
  timeoutMinutes?: number;
}

export interface RunWorkerExecution {
  result: WorkerResult;
  rawFilename: string;
  workspace: WorkerWorkspaceResult;
  workspaceFinalization: WorkerWorkspaceResult;
  resolvedAssertions: ResolvedFeatureAssertions;
  copiedFeatureFiles: string[];
}

export class WorkerRunBlockedError extends Error {
  constructor(
    public readonly featureId: string,
    public readonly workspace: WorkerWorkspaceResult
  ) {
    super(
      `Cannot start worker ${featureId}: serial workspace preparation blocked. ${workspace.reason ?? ""}`
    );
  }
}

export async function runWorkerFeature(
  options: RunWorkerOptions
): Promise<RunWorkerExecution> {
  const { feature, cwd, timeoutMinutes } = options;

  const resolvedAssertions = await resolveFeatureAssertions(cwd, feature);
  const acceptanceCriteria = formatFeatureAssertionsForPrompt(resolvedAssertions);

  const workspace = await prepareSerialWorkerBranch(cwd, feature.id);

  let copiedFeatureFiles: string[] = [];
  if (workspace.status !== "blocked" && workspace.repoPath) {
    copiedFeatureFiles = await copyFeatureFilesToWorkspace(
      workspace.repoPath,
      resolvedAssertions.documents
    );
  }

  if (workspace.status === "blocked") {
    throw new WorkerRunBlockedError(feature.id, workspace);
  }

  let procedures = "";
  const missionProcedures = await readArtifact(cwd, "agents.md");
  if (missionProcedures) {
    procedures = missionProcedures;
  } else {
    const { readFile } = await import("node:fs/promises");
    const { join: pathJoin } = await import("node:path");
    try {
      procedures = await readFile(pathJoin(cwd, "AGENTS.md"), "utf-8");
    } catch {
      procedures = "";
    }
  }

  const allAvailableSkills = await loadSkillsFromDir(
    cwd,
    DEFAULT_ORCHESTRATOR_SKILLS_DIR
  );

  const defaultWorkerSkillNames = new Set([
    "test-driven-development",
    "systematic-debugging",
    "using-git-worktrees",
    "diagnose",
    "software-design-philosophy",
    "writing-plans",
    "find-docs",
    "executing-plans",
    "verification-before-completion",
  ]);

  const skillsConfig = await readWorkerSkillsConfig(cwd);
  const missionSkillNames = skillsConfig?.additionalSkills ?? [];
  const mergedSkillNames = new Set([
    ...defaultWorkerSkillNames,
    ...missionSkillNames,
  ]);

  const workerSkills = allAvailableSkills.filter((s) =>
    mergedSkillNames.has(s.name)
  );

  const DEFAULT_TIMEOUT_MINUTES = 30;
  const MAX_TIMEOUT_MINUTES = 120;
  const effectiveTimeoutMinutes = Math.min(
    timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    MAX_TIMEOUT_MINUTES
  );

  const workerModelConfig = await getModelConfig(cwd);
  const result = await spawnWorkerAgent(
    feature,
    acceptanceCriteria,
    procedures,
    cwd,
    workerSkills,
    workerModelConfig.worker ?? undefined,
    workspace,
    effectiveTimeoutMinutes
  );

  const rawFilename = await writeWorkerRawOutput(
    cwd,
    result.featureId,
    result.rawResponse
  );
  await writeHandoff(cwd, result.handoff);

  const highIssueCount = result.handoff.issuesDiscovered.filter(
    (i) => i.severity === "high"
  ).length;
  const shouldFinalizeWorkspace =
    workspace.status === "ready" &&
    result.parseStatus === "ok" &&
    result.handoff.leftUndone.length === 0 &&
    highIssueCount === 0;
  const workspaceFinalization = shouldFinalizeWorkspace
    ? await finalizeSerialWorkerBranch(
        cwd,
        result.featureId,
        workspace.integrationBranch,
        workspace.repoPath
      )
    : workspace.status === "ready"
      ? {
          status: "blocked" as const,
          repoPath: workspace.repoPath,
          integrationBranch: workspace.integrationBranch,
          featureBranch: workspace.featureBranch,
          reason:
            "Worker branch was not merged because the handoff was not cleanly complete.",
        }
      : workspace;

  await persistWorkerReceipt(cwd, {
    featureId: result.featureId,
    recordedAt: new Date().toISOString(),
    parseStatus: result.parseStatus,
    reportSource: result.reportSource ?? "jsonl_fallback",
    handoffPath: `.missions/current/handoffs/${result.featureId}.json`,
    rawFilename,
    handoff: result.handoff,
    workspace,
    workspaceFinalization,
  });

  return {
    result,
    rawFilename,
    workspace,
    workspaceFinalization,
    resolvedAssertions,
    copiedFeatureFiles,
  };
}
