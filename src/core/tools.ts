/**
 * Custom tools exposed to the Orchestrator.
 * Each tool is a controlled gateway: subagents return recommendations;
 * the orchestrator decides what to accept and writes canonical artifacts.
 */

import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  writeArtifact,
  readArtifact,
  readFeatures,
  readWorkerSkillsConfig,
  writeHandoff,
  writeValidationReport,
  writeUserTestingReport,
  loadMissionState,
  summarizeMissionState,
  writeState,
  readState,
  bumpVersion,
  listFeatureFiles,
  writeFeatureFile,
  getCompletedFeaturesForMilestone,
} from "./artifacts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "./utils/skills.js";
import {
  spawnResearchAgent,
  spawnSmartFriendAgent,
  spawnContractAgent,
} from "../adapters/pi-sdk/agents.js";
import { spawnWorkerAgent } from "./workers/worker.js";
import { spawnScrutinyValidator, spawnUserTestingValidator } from "./workers/validators.js";
import type { MissionPhase, ArtifactName, Feature, ScrutinyReport, UserTestingReport } from "./types.js";
import { getModelConfig, setModelConfig, listAvailableModels, resolveModel } from "./config.js";
import { extractLastJsonLine, writeRawOutput } from "./utils/jsonl.js";
import { getGlobalLogger } from "./observability/event-logger.js";
import { ensureSkillsInstalled } from "./utils/skill-installer.js";
import {
  canonicalizeMissionArtifactContent,
  isStructuredArtifact,
  MissionArtifactSchemaError,
} from "./schema/mission-schema.js";
import { writeWorkerRawOutput } from "./workers/worker-output.js";
import { buildValidationRecoveryPlan } from "./mission/validation-recovery.js";
import { checkCompletedFeatureIntegration } from "./mission/integration-preflight.js";
import { resolveFeatureAssertions, formatFeatureAssertionsForPrompt, computeFeatureComplexity } from "./mission/feature-assertions.js";
import { prepareSerialWorkerBranch, finalizeSerialWorkerBranch, copyFeatureFilesToWorkspace } from "./mission/worker-workspace.js";
import {
  evaluateCompletionGate,
  applyFeatureCompletion,
  wouldIntroduceCompletedTransition,
} from "./mission/feature-completion.js";
import { createReportReceiver, persistSubmittedReport, persistWorkerReceipt } from "./report-submission.js";
import { runUserTestingCoordinator } from "./mission/user-testing-coordinator.js";

/** Shared cwd reference — set by OrchestratorAgent at init time. */
let _cwd: string = process.cwd();

export function setToolCwd(cwd: string): void {
  _cwd = cwd;
}

/**
 * Type guard: a parsed object is a structurally valid ScrutinyReport.
 * We check the discriminator (validatorType) and required fields.
 */
function isScrutinyReport(obj: unknown): obj is ScrutinyReport {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  return (
    r.validatorType === "scrutiny" &&
    typeof r.milestoneId === "string" &&
    Array.isArray(r.issues)
  );
}

/**
 * Type guard: a parsed object is a structurally valid UserTestingReport.
 */
function isUserTestingReport(obj: unknown): obj is UserTestingReport {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  return (
    r.validatorType === "user-testing" &&
    typeof r.milestoneId === "string" &&
    Array.isArray(r.scenarioResults)
  );
}

/**
 * Spawn a read-only Research Agent to investigate the codebase.
 * Returns structured findings, evidence, risks, unknowns, recommendations.
 */
export const runResearchTool = defineTool({
  name: "run_research",
  label: "Run Research",
  description:
    "Spawns a fresh read-only Research Agent to investigate repo context, docs, prior patterns, and feasibility. " +
    "Returns structured findings (summary, evidence, risks, unknowns, recommendations).",
  parameters: Type.Object({
    query: Type.String({ description: "What to research" }),
    scope: Type.String({
      description: "Files, directories, or topics to inspect",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("run_research", { query: params.query });

    const modelConfig = await getModelConfig(_cwd);
    const findings = await spawnResearchAgent(params.query, params.scope, _cwd, modelConfig.orchestrator ?? undefined);
    const durationMs = Date.now() - startTime;
    getGlobalLogger()?.toolResult("run_research", { durationMs });
    return {
      content: [{ type: "text", text: findings }],
      details: {},
    };
  },
});

/**
 * Spawn an over-scoped Smart Friend agent to critique the orchestrator's trajectory.
 * The Smart Friend receives the FULL mission state, explores the codebase independently,
 * and looks beyond the specific question to find what the orchestrator missed.
 */
export const askSmartFriendTool = defineTool({
  name: "ask_smart_friend",
  label: "Ask Smart Friend",
  description:
    "Spawns a skeptical peer reviewer with full mission context. " +
    "The Smart Friend critiques the ENTIRE trajectory — not just the specific question. " +
    "It explores the codebase independently, finds what the orchestrator missed, flags skipped investigation steps, " +
    "and suggests files/directories to investigate before proceeding.",
  parameters: Type.Object({
    question: Type.String({
      description: "Specific question or topic to ask the reviewer about",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("ask_smart_friend", { question: params.question });

    // Load full mission state — Smart Friend gets everything, not a curated summary
    const state = await loadMissionState(_cwd);
    const missionSummary = summarizeMissionState(state);

    const modelConfig = await getModelConfig(_cwd);
    const critique = await spawnSmartFriendAgent(
      missionSummary,
      params.question,
      _cwd,
      modelConfig.orchestrator ?? undefined,
    );
    const durationMs = Date.now() - startTime;
    getGlobalLogger()?.toolResult("ask_smart_friend", { durationMs });
    return {
      content: [{ type: "text", text: critique }],
      details: {},
    };
  },
});

/**
 * Spawn a Validation Contract Writer agent.
 * CRITICAL: this must be called BEFORE feature decomposition.
 * The agent receives requirements + constraints + research + decision log, NOT the feature plan.
 * Can explore codebase and research domain validation patterns independently.
 */
export const draftValidationContractTool = defineTool({
  name: "draft_validation_contract",
  label: "Draft Validation Contract",
  description:
    "Spawns a specialized contract writer to produce testable behavioral assertions that define 'done'. " +
    "MUST be called BEFORE any feature decomposition. The agent does NOT receive the feature plan. " +
    "It explores the codebase for existing test patterns and researches domain validation patterns. " +
    "Returns a structured contract with coverage summary, grouped assertions, edge cases, and negative cases.",
  parameters: Type.Object({
    requirements: Type.String({
      description: "Requirements content (from requirements.json)",
    }),
    constraints: Type.String({
      description: "Constraints content (from constraints.md)",
    }),
    researchNotes: Type.String({
      description: "Research notes content (from research-notes.md)",
    }),
    decisionLog: Type.String({
      description: "Decision log content (from decision-log.md)",
      default: "",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("draft_validation_contract", { requirements: params.requirements });

    const contractModelConfig = await getModelConfig(_cwd);
    const contract = await spawnContractAgent(
      params.requirements,
      params.constraints,
      params.researchNotes,
      params.decisionLog,
      _cwd,
      contractModelConfig.orchestrator ?? undefined,
    );
    const durationMs = Date.now() - startTime;

    // ── Artifact verification ──
    // The contract agent's response is prose/Gherkin, not JSONL, so we cannot
    // JSONL-parse it. Instead, we verify that the expected artifact files were
    // actually written to disk. If the agent returned an image, an error, or
    // just prose without writing the artifacts, the mission cannot proceed.
    //
    // Required artifacts:
    //   1. .missions/current/validation-contract.md (non-empty)
    //   2. At least one .missions/current/features/*.feature file (non-empty)
    let validationContractContent: string | undefined;
    let featureFiles: string[] = [];
    let featureContentSizes: number[] = [];
    let missingArtifacts: string[] = [];

    try {
      validationContractContent = await readArtifact(_cwd, "validation-contract.md");
    } catch {
      missingArtifacts.push("validation-contract.md");
    }
    if (!validationContractContent || validationContractContent.trim().length === 0) {
      if (!missingArtifacts.includes("validation-contract.md")) {
        missingArtifacts.push("validation-contract.md (empty)");
      }
    }

    try {
      featureFiles = await listFeatureFiles(_cwd);
      for (const f of featureFiles) {
        const content = await readFeatureFileSafe(_cwd, f);
        featureContentSizes.push(content?.length ?? 0);
      }
    } catch {
      /* listFeatureFiles returns [] on error */
    }
    if (featureFiles.length === 0) {
      missingArtifacts.push("features/*.feature (no .feature files found)");
    } else if (featureContentSizes.every((size) => size === 0)) {
      missingArtifacts.push("features/*.feature (all files empty)");
    }

    const parseStatus: "ok" | "failed" = missingArtifacts.length === 0 ? "ok" : "failed";

    if (parseStatus === "failed") {
      getGlobalLogger()?.toolResult("draft_validation_contract", {
        durationMs,
        parseStatus: "failed",
        error: `Contract artifacts missing or empty: ${missingArtifacts.join(", ")}`,
        reportIssueCount: missingArtifacts.length,
      });
      const result: {
        content: { type: "text"; text: string }[];
        details: {
          parseStatus: "ok" | "failed";
          contract: { summaryPath: string; summarySize: number; featureFiles: string[]; featureContentSizes: number[] } | null;
          missingArtifacts: string[];
          featureFiles: string[];
          rawOutput: string;
        };
      } = {
        content: [{
          type: "text",
          text:
            `CRITICAL: Contract writer did not produce the required artifacts.\n\n` +
            `Missing or empty: ${missingArtifacts.join(", ")}\n\n` +
            `The contract writer's response was:\n---\n${contract}\n---\n\n` +
            `This usually means the model returned an image, an error, or just prose ` +
            `without writing the actual Gherkin .feature files and validation-contract.md.\n\n` +
            `DO NOT proceed. Call halt_mission() with reason: "Contract writer did not produce parseable artifacts".`,
        }],
        details: {
          parseStatus: "failed",
          contract: null,
          missingArtifacts,
          featureFiles: [],
          rawOutput: contract,
        },
      };
      return result;
    }

    getGlobalLogger()?.toolResult("draft_validation_contract", {
      durationMs,
      parseStatus: "ok",
      featureFileCount: featureFiles.length,
      featureFileNames: featureFiles,
      validationContractSize: validationContractContent?.length ?? 0,
    });
    const result: {
      content: { type: "text"; text: string }[];
      details: {
        parseStatus: "ok" | "failed";
        contract: { summaryPath: string; summarySize: number; featureFiles: string[]; featureContentSizes: number[] } | null;
        missingArtifacts: string[];
        featureFiles: string[];
        rawOutput: string;
      };
    } = {
      content: [{
        type: "text",
        text:
          `Validation contract written successfully.\n\n` +
          `Artifacts:\n` +
          `  - .missions/current/validation-contract.md (${validationContractContent?.length ?? 0} bytes)\n` +
          `  - .missions/current/features/ (${featureFiles.length} .feature files: ${featureFiles.join(", ")})\n\n` +
          `You may now proceed to feature decomposition.`,
      }],
      details: {
        parseStatus: "ok",
        contract: {
          summaryPath: "validation-contract.md",
          summarySize: validationContractContent?.length ?? 0,
          featureFiles,
          featureContentSizes,
        },
        missingArtifacts: [],
        featureFiles,
        rawOutput: contract,
      },
    };
    return result;
  },
});

/**
 * Safely read a feature file, returning undefined on any error.
 */
async function readFeatureFileSafe(cwd: string, filename: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return await readFile(join(cwd, ".missions", "current", "features", filename), "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Write or append a canonical mission artifact.
 * This is the ONLY way mission state is persisted.
 */
export const writeMissionArtifactTool = defineTool({
  name: "write_mission_artifact",
  label: "Write Mission Artifact",
  description:
    "Write or append a canonical mission artifact under .missions/current/. " +
    "Supported artifacts: state.json, requirements.json, constraints.md, research-notes.md, " +
    "validation-contract.md, features.json, milestones.json, decision-log.md, halt-reason.md, " +
    "agents.md, worker-skills.json. " +
    "For decision-log, mode=append is recommended.",
  parameters: Type.Object({
    artifact: Type.String({
      description: "Artifact name (e.g. requirements.json, constraints.md, agents.md, worker-skills.json)",
    }),
    content: Type.String({ description: "Content to write" }),
    mode: Type.String({
      description: "overwrite or append",
      default: "overwrite",
    }),
  }),
  execute: async (_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
    getGlobalLogger()?.toolCall("write_mission_artifact", { artifact: params.artifact, mode: params.mode });

    const artifact = params.artifact as ArtifactName;
    const mode = params.mode === "append" ? "append" : "overwrite";

    let contentToWrite = params.content;
    if (isStructuredArtifact(artifact)) {
      if (mode === "append") {
        const message = `Invalid ${artifact}: structured JSON artifacts cannot be appended; use overwrite with a complete canonical document.`;
        getGlobalLogger()?.toolResult("write_mission_artifact", { parseStatus: "failed", error: message });
        return {
          content: [{ type: "text" as const, text: `ERROR: ${message}` }],
          details: { error: "structured_append_rejected", artifact },
        };
      }

      try {
        contentToWrite = canonicalizeMissionArtifactContent(artifact, params.content);
      } catch (err) {
        const message = err instanceof MissionArtifactSchemaError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
        getGlobalLogger()?.toolResult("write_mission_artifact", { parseStatus: "failed", error: message });
        return {
          content: [{ type: "text" as const, text: `ERROR: Invalid ${artifact}: ${message}. Previous artifact was not overwritten.` }],
          details: { error: "schema_validation_failed", artifact, message },
        };
      }
    }

    // If writing features.json, block direct transitions to "completed".
    if (artifact === "features.json") {
      const currentFeatures = await readFeatures(_cwd);
      let proposedFeatures: Feature[] | undefined;
      try {
        proposedFeatures = JSON.parse(contentToWrite).features;
      } catch {
        /* invalid JSON handled by canonicalizeMissionArtifactContent above */
      }
      const transitionCheck = wouldIntroduceCompletedTransition(currentFeatures, proposedFeatures);
      if (transitionCheck.blocked) {
        getGlobalLogger()?.toolResult("write_mission_artifact", { parseStatus: "failed", error: transitionCheck.reason });
        return {
          content: [{ type: "text" as const, text: `ERROR: ${transitionCheck.reason}` }],
          details: { error: "completed_transition_blocked", artifact, reason: transitionCheck.reason },
        };
      }
    }

    // If writing state.json, update updatedAt inside the already-canonical document.
    if (artifact === "state.json") {
      const state = JSON.parse(contentToWrite) as Record<string, unknown>;
      state.updatedAt = new Date().toISOString();
      contentToWrite = canonicalizeMissionArtifactContent("state.json", JSON.stringify(state));
    }

    await writeArtifact(
      _cwd,
      artifact,
      contentToWrite,
      mode,
    );

    if (artifact !== "state.json") {
      // Bump version for non-state artifacts after the artifact itself was safely written.
      await bumpVersion(_cwd);
    }

    getGlobalLogger()?.toolResult("write_mission_artifact", { byteCount: contentToWrite.length });
    return {
      content: [
        {
          type: "text",
          text: `Wrote ${artifact} (${mode}).`,
        },
      ],
      details: {},
    };
  },
});

/**
 * Mark a feature as completed through the non-bypassable completion gate.
 * The orchestrator decides WHEN to call this; the gate validates WHETHER the
 * transition is structurally and operationally valid.
 */
export const markFeatureCompletedTool = defineTool({
  name: "mark_feature_completed",
  label: "Mark Feature Completed",
  description:
    "Mark a feature as completed after verifying the worker handoff is clean, " +
    "no high issues were discovered, leftUndone is empty, and the workspace was merged or skipped. " +
    "This is the ONLY way to transition a feature to 'completed'. " +
    "Do NOT write features.json directly to mark completion.",
  parameters: Type.Object({
    featureId: Type.String({ description: "Feature ID to mark as completed" }),
  }),
  execute: async (_toolCallId, params) => {
    getGlobalLogger()?.toolCall("mark_feature_completed", { featureId: params.featureId });

    const gate = await evaluateCompletionGate(_cwd, params.featureId);

    const resultDetails = !gate.success
      ? { success: false as const, featureId: params.featureId, commitSha: undefined as string | undefined, errors: gate.errors }
      : { success: true as const, featureId: params.featureId, commitSha: gate.commitSha, errors: [] as string[] };

    if (!gate.success) {
      getGlobalLogger()?.toolResult("mark_feature_completed", { success: false, errors: gate.errors });
      return {
        content: [{
          type: "text" as const,
          text: [
            `Feature ${params.featureId} cannot be marked completed:`,
            "",
            ...gate.errors.map((e) => `- ${e}`),
            "",
            "Create recovery work or halt if the gate cannot be satisfied.",
          ].join("\n"),
        }],
        details: resultDetails,
      };
    }

    await applyFeatureCompletion(_cwd, params.featureId, gate.commitSha);

    getGlobalLogger()?.toolResult("mark_feature_completed", { success: true, featureId: params.featureId, commitSha: gate.commitSha });
    return {
      content: [{
        type: "text" as const,
        text: `Feature ${params.featureId} marked as completed.${gate.commitSha ? ` Commit: ${gate.commitSha}` : ""}`,
      }],
      details: resultDetails,
    };
  },
});

/**
 * Write a Gherkin .feature file under .missions/current/features/.
 * Used by the Contract Agent to write validation contract scenarios.
 */
export const writeFeatureFileTool = defineTool({
  name: "write_feature_file",
  label: "Write Feature File",
  description:
    "Write a Gherkin .feature file under .missions/current/features/. " +
    "Used by the Contract Agent to write validation contract scenarios. " +
    "The file must end with .feature extension. " +
    "Returns the written file's path and byte count.",
  parameters: Type.Object({
    filename: Type.String({
      description: "Feature file name (must end with .feature, e.g. 'auth.feature')",
    }),
    content: Type.String({
      description: "Full Gherkin content to write to the file",
    }),
  }),
  execute: async (_toolCallId, params) => {
    getGlobalLogger()?.toolCall("write_feature_file", { filename: params.filename });

    // Validate filename
    if (!params.filename.endsWith(".feature")) {
      const result: { content: { type: "text"; text: string }[]; details: { error: string; filename?: string; path?: string; byteCount?: number } } = {
        content: [{
          type: "text",
          text: `ERROR: Feature filename must end with .feature extension. Got: "${params.filename}"`,
        }],
        details: { error: "invalid_filename" },
      };
      return result;
    }

    // Validate content
    if (!params.content || params.content.trim().length === 0) {
      const result: { content: { type: "text"; text: string }[]; details: { error: string; filename?: string; path?: string; byteCount?: number } } = {
        content: [{
          type: "text",
          text: `ERROR: Feature file content is empty. Cannot write empty .feature file.`,
        }],
        details: { error: "empty_content" },
      };
      return result;
    }

    await writeFeatureFile(_cwd, params.filename, params.content);
    const byteCount = Buffer.byteLength(params.content, "utf-8");

    getGlobalLogger()?.toolResult("write_feature_file", { byteCount });
    const result: { content: { type: "text"; text: string }[]; details: { error: string; filename?: string; path?: string; byteCount?: number } } = {
      content: [{
        type: "text",
        text: `Wrote .missions/current/features/${params.filename} (${byteCount} bytes).`,
      }],
      details: {
        error: "",
        filename: params.filename,
        path: `.missions/current/features/${params.filename}`,
        byteCount,
      },
    };
    return result;
  },
});

/**
 * Load the current mission state from all artifacts and return a structured summary.
 * Call this before making decisions.
 */
export const loadMissionStateTool = defineTool({
  name: "load_mission_state",
  label: "Load Mission State",
  description:
    "Loads all mission artifacts from .missions/current/ and returns a structured summary. " +
    "Call this before making decisions to ensure you have the latest canonical state.",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params) => {
    getGlobalLogger()?.toolCall("load_mission_state", {});
    const state = await loadMissionState(_cwd);
    const summary = summarizeMissionState(state);
    getGlobalLogger()?.toolResult("load_mission_state", {
      phase: state.phase,
      version: state.version,
      featureCount: state.features?.length,
      milestoneCount: state.milestones?.length,
    });
    return {
      content: [{ type: "text", text: summary }],
      details: { fullState: state },
    };
  },
});

/**
 * Halt the current mission and return control to the user.
 * Writes a halt record to .missions/current/halt-reason.md.
 */
export const haltMissionTool = defineTool({
  name: "halt_mission",
  label: "Halt Mission",
  description:
    "Halt the current mission and return control to the user. " +
    "Use when: a helper agent surfaces a blocking issue, the user disagrees with direction, " +
    "validation fails irreversibly, or insufficient information exists to proceed safely. " +
    "Writes a halt record to .missions/current/halt-reason.md and stops further phase transitions.",
  parameters: Type.Object({
    reason: Type.String({ description: "Why the mission is halted" }),
    context: Type.String({ description: "What the user should know before resuming" }),
    resumeHint: Type.String({ description: "What would allow the mission to resume" }),
  }),
  execute: async (_toolCallId, params) => {
    getGlobalLogger()?.toolCall("halt_mission", { reason: params.reason });
    const haltedAt = new Date().toISOString();
    const haltRecord = `# Mission Halted

**Reason:** ${params.reason}

**Context:** ${params.context}

**Resume Hint:** ${params.resumeHint}

**Halted At:** ${haltedAt}
`;
    await writeArtifact(_cwd, "halt-reason.md", haltRecord);

    const currentState = await readState(_cwd);
    await writeState(_cwd, {
      ...(currentState ?? { version: 0 }),
      phase: "halted",
      version: (currentState?.version ?? 0) + 1,
      updatedAt: haltedAt,
    });

    getGlobalLogger()?.halt(params.reason, params.resumeHint);
    getGlobalLogger()?.toolResult("halt_mission", { phase: "halted" });
    return {
      content: [{ type: "text", text: `Mission halted. Record written to halt-reason.md. Reason: ${params.reason}` }],
      details: { halted: true, phase: "halted" },
    };
  },
});

/**
 * Append a structured decision entry to the decision-log.
 * Use this for every significant architectural, product, or scope decision.
 */
export const logDecisionTool = defineTool({
  name: "log_decision",
  label: "Log Decision",
  description:
    "Append a structured decision entry to the decision-log.md artifact. " +
    "Use this every time you make a significant architectural, product, or scope decision. " +
    "This creates an append-only audit trail of why the mission evolved the way it did.",
  parameters: Type.Object({
    context: Type.String({ description: "What was the situation / question being decided" }),
    decision: Type.String({ description: "What you decided" }),
    rationale: Type.String({ description: "Why you decided this way" }),
  }),
  execute: async (_toolCallId, params) => {
    getGlobalLogger()?.toolCall("log_decision", { context: params.context, decision: params.decision });
    const id = `DEC-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const entry = `## ${id}\n**Timestamp:** ${timestamp}\n**Context:** ${params.context}\n**Decision:** ${params.decision}\n**Rationale:** ${params.rationale}\n\n`;
    await writeArtifact(_cwd, "decision-log.md", entry, "append");
    getGlobalLogger()?.toolResult("log_decision", { decisionId: id });
    return {
      content: [{ type: "text", text: `Logged decision ${id} to decision-log.md.` }],
      details: { decisionId: id },
    };
  },
});

/**
 * After all features in a milestone are completed, spawn the Scrutiny Validator.
 * The Scrutiny Validator runs automated checks (tests, typecheck, lint) and spawns
 * parallel code review subagents for each completed feature.
 */
export const runValidationTool = defineTool({
  name: "run_validation",
  label: "Run Validation",
  description:
    "After all features in a milestone are completed, spawns the Scrutiny Validator to verify correctness. " +
    "The Scrutiny Validator runs automated checks (tests, typecheck, lint) and spawns parallel code review subagents for each completed feature. " +
    "Returns a structured validation report with categorized issues (blocking, non-blocking, suggestion). " +
    "NOTE: User-Testing Validator will be added in Phase 2.",
  parameters: Type.Object({
    milestoneId: Type.String({ description: "Milestone ID to validate" }),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("run_validation", { milestoneId: params.milestoneId });

    let contentText = "";
    let details: Record<string, unknown> = {};

    // 1. Read completed features for this milestone through the canonical
    //    artifact schema boundary. This accepts legacy mission artifacts at the
    //    edge but exposes only canonical Feature objects to validators.
    const milestoneFeatures = await getCompletedFeaturesForMilestone(_cwd, params.milestoneId);

    if (milestoneFeatures.length === 0) {
      contentText = `No completed features found for milestone ${params.milestoneId}.`;
      details = { error: "no_completed_features", milestoneId: params.milestoneId };
    } else {
      // 2. Deterministic integration preflight. Validation runs against the
      //    canonical integration branch, so completed feature commits must be
      //    reachable from that branch before spawning expensive validators.
      const preflight = await checkCompletedFeatureIntegration(_cwd, milestoneFeatures);
      getGlobalLogger()?.integrationPreflight({
        milestoneId: params.milestoneId,
        status: preflight.status,
        branch: preflight.branch,
        repoPath: preflight.repoPath,
        checkedFeatureCount: preflight.checkedFeatureCount,
        missingFeatureIds: preflight.missing.map((item) => item.featureId),
      });

      if (preflight.status === "failed") {
        contentText = [
          `## Validation Preflight Blocked for Milestone ${params.milestoneId}`,
          "",
          `**Preflight status:** failed`,
          `**Integration branch:** ${preflight.branch}`,
          `**Repository:** ${preflight.repoPath ?? "unknown"}`,
          `**Missing completed features:** ${preflight.missing.map((item) => item.featureId).join(", ")}`,
          "",
          preflight.recoveryInstruction,
          "",
          `Do NOT run scrutiny yet. Create a same-milestone merge recovery feature, run it, then rerun run_validation(${JSON.stringify(params.milestoneId)}).`,
        ].join("\n");
        details = {
          parseStatus: "ok",
          preflightStatus: "failed",
          preflight,
          report: null,
          recovery: {
            kind: "merge_required",
            shouldHalt: false,
            milestoneId: params.milestoneId,
            missing: preflight.missing,
            orchestratorInstruction: preflight.recoveryInstruction,
          },
        };
      } else {
        // 3. Run Scrutiny Validator
        const validatorModelConfig = await getModelConfig(_cwd);
        const scrutinyReportRaw = await spawnScrutinyValidator(
          params.milestoneId,
          milestoneFeatures.map((f) => f.id),
          _cwd,
          validatorModelConfig.validator ?? undefined,
        );

      // 3. ALWAYS persist raw validator output for audit / fallback inspection.
      const rawFilename = `scrutiny-${params.milestoneId}-${Date.now()}.raw.txt`;
      await writeRawOutput(_cwd, "validation-reports", rawFilename, scrutinyReportRaw);

      // 4. Parse the last valid JSON line (JSONL). Bottom-up scan, robust
      //    against preamble, postamble, and markdown fences.
      const parseResult = extractLastJsonLine<ScrutinyReport>(scrutinyReportRaw, isScrutinyReport);

      // 5. If parsed, also persist the structured report.
      if (parseResult.parseStatus === "ok" && parseResult.data) {
        await writeValidationReport(_cwd, parseResult.data);
      }

      // 6. Return NEUTRAL text. The tool NEVER declares pass/fail — that is
      //    the orchestrator's job. We surface parseStatus, the raw file
      //    location, and recovery guidance so the orchestrator can decide what
      //    to write next.
      const issueCount =
        parseResult.parseStatus === "ok" && parseResult.data
          ? parseResult.data.issues.length
          : 0;
      const recovery = parseResult.parseStatus === "ok" && parseResult.data
        ? buildValidationRecoveryPlan(parseResult.data, params.milestoneId)
        : undefined;

      if (recovery?.kind === "fix_features_required") {
        getGlobalLogger()?.validationRecovery({
          milestoneId: params.milestoneId,
          blockingIssueIds: recovery.blockingIssueIds,
          fixFeatureCount: recovery.suggestedFixFeatures.length,
          rawFilename,
        });
      }

      contentText = [
        `## Validation Complete for Milestone ${params.milestoneId}`,
        "",
        `**Raw output:** .missions/current/validation-reports/${rawFilename}`,
        `**Parse status:** ${parseResult.parseStatus}`,
        "",
        parseResult.parseStatus === "ok"
          ? recovery?.kind === "fix_features_required"
            ? `**Blocking issues found:** ${recovery.blockingIssueIds.length}. This is recoverable validation feedback, not a tooling halt. Create same-milestone fix features from details.recovery.suggestedFixFeatures, run workers serially, then rerun validation.`
            : `**Issues found:** ${issueCount}. No blocking recovery work required. Read details.report for non-blocking findings.`
          : `**WARNING:** Validator output could not be parsed as JSONL. The raw text is preserved at the path above. Do NOT infer success — call halt_mission() and surface the raw text to the user.`,
      ].join("\n");

      details = {
        parseStatus: parseResult.parseStatus,
        rawFilename,
        report: parseResult.data, // null if parse failed
        recovery,
      };
      }
    }

    const durationMs = Date.now() - startTime;
    getGlobalLogger()?.toolResult("run_validation", {
      parseStatus: details.parseStatus as "ok" | "failed" | undefined,
      rawFilename: details.rawFilename as string | undefined,
      reportIssueCount:
        details.report && typeof details.report === "object" && "issues" in details.report
          ? Array.isArray((details.report as { issues: unknown[] }).issues)
            ? (details.report as { issues: unknown[] }).issues.length
            : undefined
          : undefined,
      durationMs,
    });
    return {
      content: [{ type: "text" as const, text: contentText }],
      details,
    };
  },
});

/**
 * Spawn a Worker Agent to implement a single feature.
 * The worker receives the feature spec + validation assertions + shared procedures.
 * It implements the feature using TDD, commits, and writes a structured handoff.
 */
export const runWorkerTool = defineTool({
  name: "run_worker",
  label: "Run Worker",
  description:
    "Spawns a Worker Agent to implement a single feature. The worker starts with fresh context, " +
    "receives the feature spec and validation assertions it must satisfy, implements using TDD, " +
    "commits via git, and writes a structured handoff. Workers run serially — only one at a time. " +
    "Pass timeoutMinutes for large features (default 30, max 120).",
  parameters: Type.Object({
    featureId: Type.String({ description: "The feature ID to implement" }),
    timeoutMinutes: Type.Optional(
      Type.Number({
        description: "Custom timeout for this worker spawn in minutes. Default is 30 minutes. Maximum is 120 minutes.",
        minimum: 1,
        maximum: 120,
      })
    ),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("run_worker", { featureId: params.featureId });

    let contentText = "";
    let details: Record<string, unknown> = {};

    // Load the feature
    const features = await readFeatures(_cwd);
    if (!features) {
      contentText = "No features.json found. Cannot run worker.";
      details = { error: "no_features" };
    } else {
      const feature = features.find((f: Feature) => f.id === params.featureId);
      if (!feature) {
        contentText = `Feature ${params.featureId} not found in features.json.`;
        details = { error: "feature_not_found" };
      } else {
        // Resolve concrete Gherkin acceptance criteria for this feature. The
        // worker receives the relevant .feature content instead of vague
        // assertion names, so it does not have to infer what "done" means.
        const resolvedAssertions = await resolveFeatureAssertions(_cwd, feature);
        const acceptanceCriteria = formatFeatureAssertionsForPrompt(resolvedAssertions);

        // Prepare the canonical serial branch workspace. Workers run one at a
        // time, so a local feature branch in the integration checkout avoids
        // duplicated worktrees/node_modules and prevents stale integration.
        const workspace = await prepareSerialWorkerBranch(_cwd, feature.id);

        // Copy resolved .feature assertion files into the worker's workspace
        // so the worker can find them at features/*.feature. Only resolved
        // documents are copied; missing references are skipped.
        let copiedFeatureFiles: string[] = [];
        if (workspace.status !== "blocked" && workspace.repoPath) {
          copiedFeatureFiles = await copyFeatureFilesToWorkspace(workspace.repoPath, resolvedAssertions.documents);
        }

        if (workspace.status === "blocked") {
          contentText = [
            `Cannot start worker ${feature.id}: serial workspace preparation blocked.`,
            "",
            workspace.reason ?? "Unknown workspace preparation failure.",
          ].join("\n");
          details = {
            featureId: feature.id,
            parseStatus: "failed",
            error: "workspace_blocked",
            workspace,
          };
        } else {

        // Load shared procedures from mission artifact (written by orchestrator)
        // Falls back to project root AGENTS.md for backwards compatibility
        let procedures = "";
        const missionProcedures = await readArtifact(_cwd, "agents.md");
        if (missionProcedures) {
          procedures = missionProcedures;
        } else {
          const { readFile } = await import("node:fs/promises");
          const { join: pathJoin } = await import("node:path");
          try {
            procedures = await readFile(pathJoin(_cwd, "AGENTS.md"), "utf-8");
          } catch {
            procedures = "";
          }
        }

        // Load default worker skills from .pi/skills/
        const allAvailableSkills = await loadSkillsFromDir(_cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);

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

        // Load mission-specific skills from worker-skills.json
        const skillsConfig = await readWorkerSkillsConfig(_cwd);
        const missionSkillNames = skillsConfig?.additionalSkills ?? [];
        const mergedSkillNames = new Set([...defaultWorkerSkillNames, ...missionSkillNames]);

        // Filter to only skills that actually exist
        const workerSkills = allAvailableSkills.filter((s) => mergedSkillNames.has(s.name));

        // NOTE: feature.status mutation has been removed. The deterministic
        // layer does NOT update features.json. The orchestrator prompt
        // inspects the handoff and decides whether to mark the feature
        // completed, blocked, or in need of fixes — and writes the update
        // via write_mission_artifact().

        const DEFAULT_TIMEOUT_MINUTES = 30;
        const MAX_TIMEOUT_MINUTES = 120;
        const effectiveTimeoutMinutes = Math.min(
          params.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
          MAX_TIMEOUT_MINUTES
        );

        const workerModelConfig = await getModelConfig(_cwd);
        const result = await spawnWorkerAgent(feature, acceptanceCriteria, procedures, _cwd, workerSkills, workerModelConfig.worker ?? undefined, workspace, effectiveTimeoutMinutes);

        // Persist the raw worker transcript before interpreting the handoff.
        // This preserves the ground truth needed to debug parseStatus failures.
        const rawFilename = await writeWorkerRawOutput(_cwd, result.featureId, result.rawResponse);

        // Persist the structured/fallback handoff separately.
        await writeHandoff(_cwd, result.handoff);

        const highIssueCount = result.handoff.issuesDiscovered.filter((i) => i.severity === "high").length;
        const shouldFinalizeWorkspace =
          workspace.status === "ready" &&
          result.parseStatus === "ok" &&
          result.handoff.leftUndone.length === 0 &&
          highIssueCount === 0;
        const workspaceFinalization = shouldFinalizeWorkspace
          ? await finalizeSerialWorkerBranch(_cwd, result.featureId, workspace.integrationBranch, workspace.repoPath)
          : workspace.status === "ready"
            ? {
                status: "blocked" as const,
                repoPath: workspace.repoPath,
                integrationBranch: workspace.integrationBranch,
                featureBranch: workspace.featureBranch,
                reason: "Worker branch was not merged because the handoff was not cleanly complete.",
              }
            : workspace;

        // Persist deterministic worker receipt for the completion gate.
        await persistWorkerReceipt(_cwd, {
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

        // NEUTRAL return — surface parseStatus, handoff fields, and branch
        // finalization. The orchestrator still decides feature status.
        contentText = [
          `## Worker Handoff for ${result.featureId}`,
          "",
          `**Parse status:** ${result.parseStatus}`,
          `**Status (tool-reported):** ${result.status} (orchestrator decides pass/fail)`,
          `**Procedures Abided:** ${result.handoff.proceduresAbided}`,
          `**Handoff file:** .missions/current/handoffs/${result.featureId}.json`,
          `**Raw output:** .missions/current/${rawFilename}`,
          `**Workspace:** prepared=${workspace.status}; finalization=${workspaceFinalization.status}`,
          "",
          `**Summary:** ${result.handoff.summary}`,
          "",
          `**Completed:** ${result.handoff.completed.length} item(s)`,
          `**Left Undone:** ${result.handoff.leftUndone.length} item(s)`,
          `**Issues Discovered:** ${result.handoff.issuesDiscovered.length} (high: ${highIssueCount})`,
        ].join("\n");

        if (result.parseStatus === "failed") {
          contentText +=
            "\n\n**WARNING:** Worker handoff could not be parsed as JSONL. Inspect the raw response and the worker prompt. Do NOT infer success.";
        }

        details = {
          featureId: result.featureId,
          handoff: result.handoff,
          parseStatus: result.parseStatus,
          rawFilename,
          assertions: {
            resolvedCount: resolvedAssertions.documents.length,
            missing: resolvedAssertions.missing,
            copiedFeatureFiles,
          },
          workspace,
          workspaceFinalization,
        };
        }
      }
    }

    const durationMs = Date.now() - startTime;
    getGlobalLogger()?.toolResult("run_worker", {
      parseStatus: details.parseStatus as "ok" | "failed" | undefined,
      featureId: details.featureId as string | undefined,
      rawFilename: details.rawFilename as string | undefined,
      durationMs,
    });
    return {
      content: [{ type: "text" as const, text: contentText }],
      details,
    };
  },
});

/**
 * After scrutiny validation passes, spawn the User-Testing Validator.
 * The validator reads Gherkin .feature files, starts the app, opens it with agent-browser,
 * executes scenarios step-by-step, and writes a structured report with screenshot evidence.
 */
export const runUserTestingTool = defineTool({
  name: "run_user_testing",
  label: "Run User Testing",
  description:
    "Spawns the User-Testing Validator to perform end-to-end browser validation of completed features. " +
    "MUST be called AFTER run_validation passes. The validator reads Gherkin .feature files, starts the app, " +
    "opens it with agent-browser, executes scenarios step-by-step, and writes a structured report with " +
    "screenshot evidence.",
  parameters: Type.Object({
    milestoneId: Type.String({ description: "Milestone ID to validate" }),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("run_user_testing", { milestoneId: params.milestoneId });

    const milestoneFeatures = await getCompletedFeaturesForMilestone(_cwd, params.milestoneId);

    if (milestoneFeatures.length === 0) {
      const durationMs = Date.now() - startTime;
      getGlobalLogger()?.toolResult("run_user_testing", { durationMs });
      return {
        content: [{ type: "text" as const, text: `No completed features found for milestone ${params.milestoneId}` }],
        details: { error: "no_completed_features", milestoneId: params.milestoneId } as Record<string, unknown>,
      };
    }

    const preflight = await checkCompletedFeatureIntegration(_cwd, milestoneFeatures);
    getGlobalLogger()?.integrationPreflight({
      milestoneId: params.milestoneId,
      status: preflight.status,
      branch: preflight.branch,
      repoPath: preflight.repoPath,
      checkedFeatureCount: preflight.checkedFeatureCount,
      missingFeatureIds: preflight.missing.map((item) => item.featureId),
    });

    if (preflight.status === "failed") {
      const durationMs = Date.now() - startTime;
      getGlobalLogger()?.toolResult("run_user_testing", {
        parseStatus: "ok",
        preflightStatus: "failed",
        durationMs,
      });
      return {
        content: [{
          type: "text" as const,
          text: [
            `## User Testing Preflight Blocked for Milestone ${params.milestoneId}`,
            "",
            `**Preflight status:** failed`,
            `**Integration branch:** ${preflight.branch}`,
            `**Repository:** ${preflight.repoPath ?? "unknown"}`,
            `**Missing completed features:** ${preflight.missing.map((item) => item.featureId).join(", ")}`,
            "",
            preflight.recoveryInstruction,
            "",
            `Do NOT run user testing yet. Create a same-milestone merge recovery feature, run it, then rerun validation/user testing.`,
          ].join("\n"),
        }],
        details: {
          parseStatus: "ok",
          preflightStatus: "failed",
          preflight,
          report: null,
          recovery: {
            kind: "merge_required",
            shouldHalt: false,
            milestoneId: params.milestoneId,
            missing: preflight.missing,
            orchestratorInstruction: preflight.recoveryInstruction,
          },
        } as Record<string, unknown>,
      };
    }

    // Use the deterministic coordinator instead of a single monolithic validator.
    const utModelConfig = await getModelConfig(_cwd);
    const coordinatorResult = await runUserTestingCoordinator(
      _cwd,
      params.milestoneId,
      milestoneFeatures,
      utModelConfig.validator ?? undefined,
    );

    // Persist aggregate report
    if (coordinatorResult.report) {
      await writeUserTestingReport(_cwd, coordinatorResult.report);
    }

    const report = coordinatorResult.report;
    const issueCount = report.issues.length;
    const recovery = report
      ? buildValidationRecoveryPlan(report, params.milestoneId)
      : undefined;

    if (recovery?.kind === "fix_features_required") {
      getGlobalLogger()?.validationRecovery({
        milestoneId: params.milestoneId,
        blockingIssueIds: recovery.blockingIssueIds,
        fixFeatureCount: recovery.suggestedFixFeatures.length,
        rawFilename: `user-testing-shards/${params.milestoneId}/`,
      });
    }

    const contentText = [
      `## User Testing Complete for Milestone ${params.milestoneId}`,
      "",
      `**Coordinator status:** ${coordinatorResult.coordinatorStatus}`,
      `**Parse status:** ${coordinatorResult.parseStatus}`,
      `**Shards:** ${report.shards?.length ?? 0}`,
      `**Scenarios:** ${report.scenarioResults.length}`,
      `**Issues:** ${issueCount}`,
      "",
      coordinatorResult.coordinatorStatus === "incomplete"
        ? `**WARNING:** User testing coverage is incomplete. Inspect shard details in details.shards. Do NOT proceed to milestone completion until coverage is complete.`
        : recovery?.kind === "fix_features_required"
          ? `**Blocking issues found:** ${recovery.blockingIssueIds.length}. This is recoverable validation feedback, not a tooling halt. Create same-milestone fix features from details.recovery.suggestedFixFeatures, run workers serially, then rerun validation.`
          : `**Issues found:** ${issueCount}. No blocking recovery work required. Read details.report for non-blocking findings.`,
    ].join("\n");

    const durationMs = Date.now() - startTime;
    getGlobalLogger()?.toolResult("run_user_testing", {
      parseStatus: coordinatorResult.parseStatus,
      coordinatorStatus: coordinatorResult.coordinatorStatus,
      reportIssueCount: issueCount,
      shardCount: report.shards?.length ?? 0,
      durationMs,
    });

    return {
      content: [{ type: "text" as const, text: contentText }],
      details: {
        parseStatus: coordinatorResult.parseStatus,
        coordinatorStatus: coordinatorResult.coordinatorStatus,
        report: coordinatorResult.report,
        recovery,
        shards: coordinatorResult.shards,
      },
    };
  },
});

/**
 * Set the model for a specific agent level (orchestrator, worker, or validator).
 * Updates ratel.json with the new model string. The model takes effect on the next
 * agent spawn — running agents are not affected.
 */
export const setModelTool = defineTool({
  name: "set_model",
  label: "Set Model",
  description:
    "Set the model for a specific agent level. Three levels: orchestrator (also used by research, smart-friend, contract), " +
    "worker (used by all worker spawns), validator (used by scrutiny, code-review, user-testing). " +
    "Format: 'provider/model-id' (e.g. 'anthropic/claude-sonnet-4'). Pass null or empty string to revert to SDK default. " +
    "The model change takes effect on the next agent spawn — running agents are not affected.",
  parameters: Type.Object({
    level: Type.Union([
      Type.Literal("orchestrator"),
      Type.Literal("worker"),
      Type.Literal("validator"),
    ], { description: "Agent level: orchestrator, worker, or validator" }),
    model: Type.String({
      description: "Model in provider/model-id format (e.g. 'anthropic/claude-sonnet-4'). Pass '' to clear (revert to SDK default).",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const model = params.model.trim() || null;
    const updated = await setModelConfig(_cwd, params.level, model);
    const levelLabel = params.level.charAt(0).toUpperCase() + params.level.slice(1);
    const modelLabel = model || "SDK default";
    return {
      content: [{
        type: "text",
        text: `${levelLabel} model set to: ${modelLabel}\n\nCurrent model config:\n- Orchestrator: ${updated.orchestrator || "SDK default"}\n- Worker: ${updated.worker || "SDK default"}\n- Validator: ${updated.validator || "SDK default"}`,
      }],
      details: { level: params.level, model, config: updated },
    };
  },
});

/**
 * List available models and current model configuration.
 * Uses Pi's ModelRegistry to discover models with configured API keys.
 */
export const listModelsTool = defineTool({
  name: "list_models",
  label: "List Models",
  description:
    "List available models (from Pi's ModelRegistry) and current model configuration for all three agent levels. " +
    "Shows which providers have API keys configured and which models are available.",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params) => {
    const [availableModels, currentConfig] = await Promise.all([
      listAvailableModels(_cwd),
      getModelConfig(_cwd),
    ]);

    // Group by provider
    const byProvider = new Map<string, typeof availableModels>();
    for (const m of availableModels) {
      const existing = byProvider.get(m.provider) ?? [];
      existing.push(m);
      byProvider.set(m.provider, existing);
    }

    const lines: string[] = [
      "## Current Model Configuration",
      `- **Orchestrator**: ${currentConfig.orchestrator || "SDK default"}`,
      `- **Worker**: ${currentConfig.worker || "SDK default"}`,
      `- **Validator**: ${currentConfig.validator || "SDK default"}`,
      "",
      "## Available Models",
    ];

    for (const [provider, models] of [...byProvider.entries()].sort()) {
      lines.push(``);  
      lines.push(`### ${provider}`);
      for (const m of models.sort((a, b) => a.id.localeCompare(b.id))) {
        lines.push(`- ${m.provider}/${m.id}`);
      }
    }

    if (availableModels.length === 0) {
      lines.push("No models with configured API keys found. Set API keys in ~/.pi/agent/auth.json or environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { config: currentConfig, availableCount: availableModels.length },
    };
  },
});

/**
 * Ping all subagents to verify factory health.
 * Spawns a trivial task in each of the six subagent roles and reports per-agent status.
 */
export const pingAgentsTool = defineTool({
  name: "ping_agents",
  label: "Ping All Agents",
  description:
    "Spawns a trivial task in each of the six subagent roles (research, smart_friend, " +
    "contract_writer, worker, scrutiny_validator, user_testing_validator) and reports back " +
    "per-agent status. Use this to verify the factory is healthy before starting a long " +
    "mission, or to diagnose which subagent is broken when something fails. Each ping has a " +
    "20-second default timeout. Total wall-clock time is bounded at ~20 seconds (parallel execution). " +
    "Returns: { totalAgents, okCount, failedCount, results: { [agentName]: { status, durationMs, response, error } } }",
  parameters: Type.Object({
    timeoutMs: Type.Optional(Type.Number({
      description: "Per-agent timeout in milliseconds (default: 20000)",
      default: 20000,
    })),
  }),
  execute: async (_toolCallId, params) => {
    const startTime = Date.now();
    getGlobalLogger()?.toolCall("ping_agents", { timeoutMs: params.timeoutMs });

    const timeoutMs = params.timeoutMs ?? 20000;

    type PingResult = {
      status: "ok" | "failed" | "timeout";
      durationMs: number;
      response?: string;
      error?: string;
    };

    type PingRole = {
      name: string;
      model: string | null;
      skillNames: string[];
      tools: string[];
      expectedText: string;
    };

    const modelConfig = await getModelConfig(_cwd);
    const allSkills = await loadSkillsFromDir(_cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);

    const roles: PingRole[] = [
      {
        name: "research",
        model: modelConfig.orchestrator,
        skillNames: ["parallel-web-search", "parallel-deep-research", "find-docs"],
        tools: ["read", "grep", "find", "ls", "bash"],
        expectedText: "research ok",
      },
      {
        name: "smart_friend",
        model: modelConfig.orchestrator,
        skillNames: [
          "software-design-philosophy",
          "architecture-blueprint-generator",
          "grill-with-docs",
          "parallel-web-search",
          "find-docs",
          "deep-research",
          "web-design-guidelines",
          "ui-ux-pro-max",
        ],
        tools: ["read", "grep", "find", "ls"],
        expectedText: "smart_friend ok",
      },
      {
        name: "contract_writer",
        model: modelConfig.orchestrator,
        skillNames: [
          "parallel-web-search",
          "find-docs",
          "software-design-philosophy",
          "ui-ux-pro-max",
          "slc-product-thinking",
          "html-as-output",
          "gherkin-contract",
          "cucumber-gherkin",
        ],
        tools: ["read", "grep", "find", "ls", "bash"],
        expectedText: "contract_writer ok",
      },
      {
        name: "worker",
        model: modelConfig.worker,
        skillNames: [
          "test-driven-development",
          "systematic-debugging",
          "using-git-worktrees",
          "diagnose",
          "software-design-philosophy",
          "writing-plans",
          "find-docs",
          "executing-plans",
          "verification-before-completion",
        ],
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        expectedText: "worker ok",
      },
      {
        name: "scrutiny_validator",
        model: modelConfig.validator,
        skillNames: [
          "test-driven-development",
          "software-design-philosophy",
          "diagnose",
          "systematic-debugging",
          "find-docs",
          "dispatching-parallel-agents",
          "requesting-code-review",
        ],
        tools: ["read", "grep", "find", "ls", "bash"],
        expectedText: "scrutiny_validator ok",
      },
      {
        name: "user_testing_validator",
        model: modelConfig.validator,
        skillNames: ["agent-browser", "find-docs"],
        tools: ["read", "grep", "find", "ls", "bash"],
        expectedText: "user_testing_validator ok",
      },
    ];

    async function runLightweightPing(role: PingRole): Promise<PingResult> {
      const pingStart = Date.now();
      let timeout: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          (async () => {
            const resolvedModel = resolveModel(role.model);
            if (role.model && !resolvedModel) {
              throw new Error(`Configured model could not be resolved: ${role.model}`);
            }

            const authStorage = AuthStorage.create();
            const modelRegistry = ModelRegistry.create(authStorage);
            const settingsManager = SettingsManager.inMemory({
              compaction: { enabled: false },
              retry: { enabled: true, maxRetries: 0 },
            });
            const skills = allSkills.filter((s) => role.skillNames.includes(s.name));
            const resourceLoader = new DefaultResourceLoader({
              cwd: _cwd,
              agentDir: getAgentDir(),
              settingsManager,
              systemPromptOverride: () =>
                `You are the Ratel ${role.name} health-check target. ` +
                `This is a lightweight availability ping, not a mission. ` +
                `Do not inspect files. Do not call tools. Reply with ONLY: ${role.expectedText}`,
              skillsOverride: () => ({ skills, diagnostics: [] }),
            });
            await resourceLoader.reload();

            const { session } = await createAgentSession({
              cwd: _cwd,
              authStorage,
              modelRegistry,
              settingsManager,
              resourceLoader,
              sessionManager: SessionManager.inMemory(_cwd),
              tools: role.tools,
              model: resolvedModel,
            });

            let response = "";
            const unsubscribe = session.subscribe((event) => {
              if (
                event.type === "message_update" &&
                event.assistantMessageEvent.type === "text_delta"
              ) {
                response += event.assistantMessageEvent.delta;
              }
            });

            try {
              await session.prompt(`Reply with ONLY: ${role.expectedText}`);
            } finally {
              unsubscribe();
              session.dispose();
            }
            return response;
          })(),
          new Promise<string>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`Ping timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        if (timeout) clearTimeout(timeout);

        const responseText = result.trim();
        return {
          status: responseText.length > 0 ? "ok" : "failed",
          durationMs: Date.now() - pingStart,
          response: responseText.slice(0, 200),
          error: responseText.length > 0 ? undefined : "Empty response from agent",
        };
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        const isTimeout = err instanceof Error && err.message.includes("timed out");
        return {
          status: isTimeout ? "timeout" : "failed",
          durationMs: Date.now() - pingStart,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Launch all pings in parallel. These are safe lightweight pings, not the
    // production spawners, so they must not write mission artifacts or start apps.
    const results = await Promise.allSettled(roles.map((role) => runLightweightPing(role)));

    // Map results to a structured object
    const agentNames = ["research", "smart_friend", "contract_writer", "worker", "scrutiny_validator", "user_testing_validator"];
    const pingResults: Record<string, { status: "ok" | "failed" | "timeout"; durationMs: number; response?: string; error?: string }> = {};
    let okCount = 0;
    let failedCount = 0;

    for (let i = 0; i < agentNames.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        pingResults[agentNames[i]] = r.value;
        if (r.value.status === "ok") okCount++;
        else failedCount++;
      } else {
        pingResults[agentNames[i]] = {
          status: "failed",
          durationMs: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
        failedCount++;
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const overallStatus = failedCount === 0 ? "ok" : "degraded";

    getGlobalLogger()?.toolResult("ping_agents", {
      durationMs: totalDurationMs,
      totalAgents: agentNames.length,
      okCount,
      failedCount,
      overallStatus,
    });

    // Log ping events for each agent
    for (const name of agentNames) {
      const r = pingResults[name];
      getGlobalLogger()?.ping(name, r.status, r.durationMs, r.error);
    }

    // Format user-facing summary
    const summaryLines: string[] = [
      `Factory health check: ${overallStatus.toUpperCase()}`,
      `  Total agents: ${agentNames.length}`,
      `  OK: ${okCount}`,
      `  Failed: ${failedCount}`,
      `  Total time: ${totalDurationMs}ms`,
      ``,
      `Per-agent results:`,
    ];
    for (const name of agentNames) {
      const r = pingResults[name];
      const icon = r.status === "ok" ? "✓" : "✗";
      summaryLines.push(`  ${icon} ${name}: ${r.status} (${r.durationMs}ms)${r.error ? ` — ${r.error}` : ""}`);
    }

    if (failedCount > 0) {
      summaryLines.push(``);
      summaryLines.push(`RECOMMENDATION: At least one agent is degraded. Common causes:`);
      summaryLines.push(`  - Timeout too low for the role's model + prompt/skill bundle`);
      summaryLines.push(`  - Invalid model string in ratel.json (check resolveModel warnings in startup logs)`);
      summaryLines.push(`  - Missing API credentials for the configured provider`);
      summaryLines.push(`  - Missing tool registration for a subagent`);
      summaryLines.push(``);
      summaryLines.push(`Model tiers:`);
      summaryLines.push(`  - research/smart_friend/contract_writer use orchestrator: ${modelConfig.orchestrator ?? "SDK default"}`);
      summaryLines.push(`  - worker uses worker: ${modelConfig.worker ?? "SDK default"}`);
      summaryLines.push(`  - scrutiny_validator/user_testing_validator use validator: ${modelConfig.validator ?? "SDK default"}`);
      summaryLines.push(`Check .missions/current/events.jsonl and .missions/current/factory-health-report.md for details.`);
    }

    const reportPath = ".missions/current/factory-health-report.md";
    const reportLines = [
      `# Factory Health Report`,
      ``,
      `**Created:** ${new Date().toISOString()}`,
      `**Overall status:** ${overallStatus}`,
      `**Timeout:** ${timeoutMs}ms per agent`,
      `**Total duration:** ${totalDurationMs}ms`,
      ``,
      `## Model Tiers`,
      ``,
      `- Orchestrator (research, smart_friend, contract_writer): ${modelConfig.orchestrator ?? "SDK default"}`,
      `- Worker: ${modelConfig.worker ?? "SDK default"}`,
      `- Validator (scrutiny_validator, user_testing_validator): ${modelConfig.validator ?? "SDK default"}`,
      ``,
      `## Results`,
      ``,
      `| Agent | Status | Duration | Error | Response preview |`,
      `|---|---:|---:|---|---|`,
      ...agentNames.map((name) => {
        const r = pingResults[name];
        return `| ${name} | ${r.status} | ${r.durationMs}ms | ${r.error ?? ""} | ${(r.response ?? "").replace(/\|/g, "\\|")} |`;
      }),
      ``,
      `## Notes`,
      ``,
      `- This is a lightweight availability ping. It does not run the production contract writer, write contract artifacts, start apps, or execute mission work.`,
      `- A contract_writer timeout does not imply validator model failure; contract_writer uses the orchestrator model tier.`,
      `- If only contract_writer times out while research/smart_friend pass on the same model, the most likely cause is timeout margin plus the contract writer's larger prompt/skill bundle. Retry with a higher timeout, e.g. ping_agents({ timeoutMs: 30000 }).`,
    ];

    try {
      await mkdir(join(_cwd, ".missions", "current"), { recursive: true });
      await writeFile(join(_cwd, reportPath), reportLines.join("\n") + "\n", "utf-8");
    } catch {
      // Fail-soft: health observability must not break the factory.
    }

    return {
      content: [{ type: "text", text: summaryLines.join("\n") }],
      details: {
        overallStatus,
        totalAgents: agentNames.length,
        okCount,
        failedCount,
        totalDurationMs,
        reportPath,
        results: pingResults,
      },
    };
  },
});

/**
 * Auto-install mission-specific skills that are missing from the local .pi/skills/ directory.
 * Searches the skills.sh registry and installs the best match for each missing skill.
 * Used during Feature Decomposition before workers are spawned.
 */
export const ensureSkillsInstalledTool = defineTool({
  name: "ensure_skills_installed",
  label: "Ensure Skills Installed",
  description:
    "Auto-install any missing skills listed in worker-skills.json. " +
    "Searches the skills.sh registry for each missing skill and installs the best match globally. " +
    "Returns which skills were already present and which were installed.",
  parameters: Type.Object({
    skillNames: Type.Array(Type.String(), {
      description: "Skill names to ensure are installed (from worker-skills.json)",
    }),
  }),
  execute: async (_toolCallId, params) => {
    getGlobalLogger()?.toolCall("ensure_skills_installed", { skillNames: params.skillNames });
    const startTime = Date.now();
    const result = await ensureSkillsInstalled(params.skillNames, _cwd);
    const durationMs = Date.now() - startTime;
    const installedCount = result.installed.filter((r) => r.success).length;
    const failedCount = result.installed.filter((r) => !r.success).length;
    getGlobalLogger()?.toolResult("ensure_skills_installed", { durationMs, installedCount, failedCount });

    const lines: string[] = [
      `## Skill Installation Report (${durationMs}ms)`,
      ``,
      `**Requested:** ${result.requested.join(", ")}`,
      `**Already present:** ${result.found.length > 0 ? result.found.join(", ") : "none"}`,
      `**Installed:** ${installedCount}`,
      `**Failed:** ${failedCount}`,
      ``,
    ];
    for (const r of result.installed) {
      const icon = r.success ? "\u2705" : "\u274C";
      lines.push(`${icon} ${r.requested} \u2014 ${r.message}`);
      if (r.error) lines.push(`   Error: ${r.error}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { ...result, durationMs },
    };
  },
});

/**
 * Compute deterministic complexity metrics for a feature before spawning a worker.
 * The deterministic layer provides data only; the orchestrator (model) decides
 * whether to spawn or split. No hardcoded thresholds.
 */
export const getFeatureComplexityTool = defineTool({
  name: "get_feature_complexity",
  label: "Get Feature Complexity",
  description:
    "Query the complexity of a feature before spawning a worker. " +
    "Returns assertion count, feature file count, scenario count, and total Gherkin lines. " +
    "Use this before run_worker to decide if a feature should be split into smaller pieces.",
  parameters: Type.Object({
    featureId: Type.String({ description: "The feature ID to query" }),
  }),
  execute: async (_toolCallId, params) => {
    getGlobalLogger()?.toolCall("get_feature_complexity", { featureId: params.featureId });

    const features = await readFeatures(_cwd);
    if (!features) {
      return {
        content: [{ type: "text" as const, text: "No features.json found. Cannot compute complexity." }],
        details: { error: "no_features" } as Record<string, unknown>,
      };
    }

    const feature = features.find((f: Feature) => f.id === params.featureId);
    if (!feature) {
      return {
        content: [{ type: "text" as const, text: `Feature ${params.featureId} not found in features.json.` }],
        details: { error: "feature_not_found", featureId: params.featureId } as Record<string, unknown>,
      };
    }

    const complexity = await computeFeatureComplexity(_cwd, feature);

    getGlobalLogger()?.toolResult("get_feature_complexity", {
      featureId: complexity.featureId,
      assertionCount: complexity.assertionCount,
      featureFileCount: complexity.featureFileCount,
      scenarioCount: complexity.scenarioCount,
      totalLinesOfGherkin: complexity.totalLinesOfGherkin,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Feature ${feature.id} complexity:`,
          `- Assertions: ${complexity.assertionCount}`,
          `- Feature files: ${complexity.featureFileCount}`,
          `- Scenarios: ${complexity.scenarioCount}`,
          `- Total Gherkin lines: ${complexity.totalLinesOfGherkin}`,
        ].join("\n"),
      }],
      details: { complexity } as Record<string, unknown>,
    };
  },
});

/** All orchestrator custom tools. */
export const ORCHESTRATOR_TOOLS = [
  runResearchTool,
  askSmartFriendTool,
  draftValidationContractTool,
  writeMissionArtifactTool,
  markFeatureCompletedTool,
  loadMissionStateTool,
  haltMissionTool,
  logDecisionTool,
  runValidationTool,
  runWorkerTool,
  runUserTestingTool,
  setModelTool,
  listModelsTool,
  pingAgentsTool,
  ensureSkillsInstalledTool,
  getFeatureComplexityTool,
];
