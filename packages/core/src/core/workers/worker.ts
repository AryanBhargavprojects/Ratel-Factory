import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  getAgentDir,
  defineTool,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { WORKER_PROMPT } from "../prompts.js";
import type { WorkerHandoff, WorkerResult, Feature } from "../types.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "../utils/skills.js";
import { resolveModel } from "../config.js";
import { extractLastJsonLine, type ParseResult } from "../utils/jsonl.js";
import type { EventLogger } from "../observability/event-logger.js";
import { observeAgentSession } from "../observability/session-events.js";
import { createWorkerSessionSettings } from "./worker-settings.js";
import type { WorkerWorkspaceResult } from "../mission/worker-workspace.js";
import { createReportReceiver, persistSubmittedReport } from "../report-submission.js";
import type { MissionScope } from "../mission/scope.js";
import { collectResponseWithRetry } from "../models/session-runner.js";
import { EmptyOutputError } from "../models/error-classifier.js";

/**
 * Collect the full text response from a session after prompting.
 *
 * NOTE: The shared `collectResponse` / `collectResponseWithRetry` helpers in
 * `models/session-runner.ts` are now used directly by spawn functions below.
 * They classify a 0-byte / whitespace-only response as a retryable
 * `EmptyOutputError` (category `empty_output`) and auto-retry once, so an
 * empty worker run is no longer misclassified as a parse failure.
 */

/**
 * Type guard: a parsed object is a structurally valid WorkerHandoff.
 * Structural validation belongs in the deterministic layer; semantic
 * decisions (pass/fail/blocked) belong in the orchestrator prompt.
 */
function isValidHandoff(obj: unknown): obj is WorkerHandoff {
  if (!obj || typeof obj !== "object") return false;
  const h = obj as Record<string, unknown>;
  return (
    typeof h.featureId === "string" &&
    typeof h.completedAt === "string" &&
    Array.isArray(h.completed) &&
    h.completed.every((x) => typeof x === "string") &&
    Array.isArray(h.leftUndone) &&
    h.leftUndone.every((x) => typeof x === "string") &&
    Array.isArray(h.commandsRun) &&
    Array.isArray(h.issuesDiscovered) &&
    typeof h.proceduresAbided === "boolean" &&
    typeof h.summary === "string"
  );
}

/**
 * Parse the worker's JSONL handoff. Returns a ParseResult — the tool layer
 * NEVER decides pass/fail, it just reports whether a structured handoff was
 * found and what its fields are. The orchestrator inspects the handoff and
 * decides what to accept.
 */
function parseHandoff(featureId: string, response: string): ParseResult<WorkerHandoff> {
  const result = extractLastJsonLine<WorkerHandoff>(response, isValidHandoff);
  if (result.parseStatus === "ok" && result.data) {
    return result;
  }

  // Fallback: worker did not produce a parseable handoff. Return a structured
  // object that signals the failure so the orchestrator sees parseStatus: "failed"
  // and halts, rather than inferring success.
  const fallback: WorkerHandoff = {
    featureId,
    completedAt: new Date().toISOString(),
    completed: [],
    leftUndone: ["Handoff not in expected JSONL format — see full response"],
    commandsRun: [],
    issuesDiscovered: [
      {
        description:
          "Worker did not return a structured handoff. Check raw response and worker prompt.",
        severity: "high",
      },
    ],
    proceduresAbided: false,
    summary: "Worker handoff format error — see full response for raw output.",
  };

  return {
    parseStatus: "failed",
    data: fallback,
    rawLine: null,
    fullText: response,
  };
}

/**
 * Factory that creates a submit_worker_handoff tool bound to a specific feature.
 */
export function createSubmitWorkerHandoffTool(featureId: string, scope: MissionScope) {
  const receiver = createReportReceiver<WorkerHandoff>({
    role: "worker",
    assignment: { featureId },
    artifactPath: `handoffs/${featureId}.json`,
  });

  const tool = defineTool({
    name: "submit_worker_handoff",
    label: "Submit Worker Handoff",
    description:
      "Submit your structured worker handoff. Call this tool BEFORE finishing your session. " +
      "If this tool succeeds, your final text can be a short summary — do NOT repeat the full JSON.",
    parameters: Type.Object({
      handoff: Type.Any({ description: "The structured WorkerHandoff object" }),
    }),
    execute: async (_toolCallId, params) => {
      const result = receiver.submit(params.handoff);
      if (result.accepted) {
        await persistSubmittedReport(scope, `handoffs/${featureId}.json`, params.handoff);
        return {
          content: [{ type: "text", text: "Handoff accepted." }],
          details: { accepted: true, error: undefined as string | undefined },
        };
      }
      return {
        content: [{ type: "text", text: `Handoff rejected: ${result.error}` }],
        details: { accepted: false, error: result.error },
      };
    },
  });

  return { tool, receiver };
}

/**
 * Spawn a Worker Agent to implement a single feature.
 * The worker starts with fresh context, receives the feature spec and assertions,
 * implements the feature, commits, and writes a structured handoff.
 */
export async function spawnWorkerAgent(
  feature: Feature,
  acceptanceCriteria: string,
  sharedProcedures: string,
  scope: MissionScope,
  logger: EventLogger | undefined,
  skillsOverride?: Skill[],
  model?: string,
  workspace?: WorkerWorkspaceResult,
  timeoutMinutes?: number,
  budgetManager?: import("../budget/budget-manager.js").BudgetManager,
): Promise<WorkerResult> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory(createWorkerSessionSettings());

  let workerSkills: Skill[];
  if (skillsOverride && skillsOverride.length > 0) {
    workerSkills = skillsOverride;
  } else {
    const allSkills = await loadSkillsFromDir(scope.projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
    const defaultSkillNames = new Set([
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
    workerSkills = allSkills.filter((s) => defaultSkillNames.has(s.name));
  }

  // Observability: start the worker span
  const startTime = Date.now();
  const resolvedModel = resolveModel(model);
  const agentSpanId = logger?.agentSpanStart("worker", {
    agentType: "worker",
    model: model ?? "sdk-default",
    skills: workerSkills.map((s) => s.name),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    featureId: feature.id,
  });

  // Create report receiver and submission tool for this worker session
  const { tool: submitHandoffTool, receiver: handoffReceiver } = createSubmitWorkerHandoffTool(feature.id, scope);

  const resourceLoader = new DefaultResourceLoader({
    cwd: scope.projectRoot,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => WORKER_PROMPT,
    skillsOverride: () => ({ skills: workerSkills, diagnostics: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: scope.projectRoot,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(scope.projectRoot),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    customTools: [submitHandoffTool],
    model: resolvedModel,
  });

  // Build the feature prompt
  const workspaceSection = workspace?.status === "ready"
    ? [
        `Repository: ${workspace.repoPath}`,
        `Integration branch: ${workspace.integrationBranch}`,
        `Feature branch: ${workspace.featureBranch}`,
        "Work in this prepared feature branch. Do not create a git worktree.",
      ].join("\n")
    : "No serial git workspace was prepared; follow agents.md for repository setup.";

  const prompt = `## Feature Spec
**ID:** ${feature.id}
**Title:** ${feature.title}
**Description:** ${feature.description}

## Prepared Workspace
${workspaceSection}

## Acceptance Criteria You Must Satisfy
${acceptanceCriteria || "(No concrete acceptance criteria were resolved. Report this if it blocks implementation.)"}

## Shared Procedures
${sharedProcedures || "(No shared procedures defined for this mission.)"}

## Instructions
Implement this feature using public-interface TDD. Keep scope to the acceptance criteria. Commit your changes on the prepared feature branch, then write the structured JSONL handoff described in your system prompt.`;

  const unobserve = observeAgentSession(session, {
    logger,
    agentLevel: "worker",
    parentSpanId: agentSpanId,
    budgetManager,
  });

  // Worker safety cap: default 30 minutes, configurable by the orchestrator
  // via timeoutMinutes parameter (max 120). If the model hangs, tests run
  // forever, or the agent enters a loop, this prevents workers from running
  // for hours. The orchestrator receives a parseStatus: "failed" handoff and
  // decides.
  const MAX_TIMEOUT_MINUTES = 120;
  const DEFAULT_TIMEOUT_MINUTES = 30;
  const effectiveTimeoutMinutes = Math.min(
    timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    MAX_TIMEOUT_MINUTES
  );
  const WORKER_TIMEOUT_MS = effectiveTimeoutMinutes * 60 * 1000;
  let response: string;
  let emptyOutput = false;
  // Guard: if the timeout wins the race, the still-pending collect promise
  // may later reject (EmptyOutputError). Attach a no-op catch to avoid an
  // unhandledRejection — the timeout branch owns the failure in that case.
  const collectPromise = collectResponseWithRetry(session, prompt);
  collectPromise.catch(() => {});
  try {
    response = await Promise.race([
      collectPromise,
      new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Worker timeout after ${WORKER_TIMEOUT_MS}ms`));
        }, WORKER_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    // Empty output after retry — classify as `empty_output` (infrastructure
    // failure), NOT parse_failure. The orchestrator sees failureCategory and
    // parseStatus: "failed" and decides whether to retry/skip/halt.
    if (err instanceof EmptyOutputError) {
      emptyOutput = true;
      response = "";
    } else {
      // Timeout — return a structured failure handoff so the orchestrator
      // can decide whether to retry, skip, or halt.
      const timeoutNote = err instanceof Error ? err.message : "Worker timed out";
      const handoffResult: import("../utils/jsonl.js").ParseResult <WorkerHandoff> = {
        parseStatus: "failed",
        data: {
          featureId: feature.id,
          completedAt: new Date().toISOString(),
          completed: [],
          leftUndone: ["Worker timed out — the task may be too large for one feature."],
          commandsRun: [],
          issuesDiscovered: [{
            description: timeoutNote,
            severity: "high",
          }],
          proceduresAbided: false,
          summary: `Worker aborted after ${WORKER_TIMEOUT_MS}ms. Consider splitting this feature into smaller pieces.`,
        },
        rawLine: null,
        fullText: timeoutNote,
      };

      const durationMs = Date.now() - startTime;
      if (agentSpanId) {
        logger?.agentSpanEnd("worker", agentSpanId, {
          parseStatus: "failed",
          durationMs,
          featureId: feature.id,
        });
      }
      unobserve();
      session.dispose();
      return {
        featureId: feature.id,
        status: "unknown",
        handoff: handoffResult.data!,
        parseStatus: "failed",
        rawResponse: timeoutNote,
      };
    }
  }

  // Empty output after retry: build a structured failure handoff classified
  // as `empty_output` so the orchestrator can distinguish it from a
  // non-empty malformed (parse_failure) handoff.
  if (emptyOutput) {
    const emptyNote = "Worker produced no text output after retry (empty_output).";
    const handoff: WorkerHandoff = {
      featureId: feature.id,
      completedAt: new Date().toISOString(),
      completed: [],
      leftUndone: [emptyNote],
      commandsRun: [],
      issuesDiscovered: [{
        description: emptyNote,
        severity: "high",
      }],
      proceduresAbided: false,
      summary: emptyNote,
    };

    const durationMs = Date.now() - startTime;
    unobserve();
    if (agentSpanId) {
      logger?.agentSpanEnd("worker", agentSpanId, {
        parseStatus: "failed",
        durationMs,
        featureId: feature.id,
      });
    }
    session.dispose();
    return {
      featureId: feature.id,
      status: "unknown",
      handoff,
      parseStatus: "failed",
      rawResponse: "",
      failureCategory: "empty_output",
    };
  }

  // Check for tool submission first, then fall back to JSONL parsing.
  const submissionResult = handoffReceiver.getResult();
  let handoff: WorkerHandoff;
  let parseStatus: "ok" | "failed";
  let reportSource: import("../types.js").ReportSource;

  if (submissionResult.report && submissionResult.source === "tool_submission") {
    handoff = submissionResult.report;
    parseStatus = "ok";
    reportSource = "tool_submission";
  } else {
    const handoffResult = parseHandoff(feature.id, response);
    handoff = handoffResult.data!;
    parseStatus = handoffResult.parseStatus;
    reportSource = handoffResult.parseStatus === "ok" ? "jsonl_fallback" : "missing";
  }

  const result: WorkerResult = {
    featureId: feature.id,
    status: "unknown", // Orchestrator prompt decides pass/fail/blocked
    handoff,
    parseStatus,
    rawResponse: response,
    reportSource,
  };

  // Observability: end the worker span
  const durationMs = Date.now() - startTime;
  unobserve();
  if (agentSpanId) {
    logger?.agentSpanEnd("worker", agentSpanId, {
      parseStatus,
      durationMs,
      featureId: feature.id,
    });
  }

  session.dispose();
  return result;
}
