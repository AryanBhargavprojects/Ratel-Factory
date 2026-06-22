/**
 * Custom tools exposed to the Orchestrator.
 * Each tool is a controlled gateway: subagents return recommendations;
 * the orchestrator decides what to accept and writes canonical artifacts.
 */

import { Type } from "@sinclair/typebox";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  getIntegratedFeaturesForMilestone,
  appendDecision,
} from "./artifacts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "./utils/skills.js";
import {
  spawnResearchAgent,
  spawnSmartFriendAgent,
  spawnContractAgent,
} from "./agents.js";
import { spawnWorkerAgent } from "./workers/worker.js";
import { spawnScrutinyValidator, spawnUserTestingValidator } from "./workers/validators.js";
import type { MissionPhase, ArtifactName, Feature, ScrutinyReport, UserTestingReport } from "./types.js";
import { getModelConfig, setModelConfig, listAvailableModels, resolveModel, getDefaultAgentDir } from "./config.js";
import type { ModelConfig } from "./config.js";
import { pingAllAgents } from "./ping-agents.js";
import { extractLastJsonLine, writeRawOutput } from "./utils/jsonl.js";
import { ensureSkillsInstalled } from "./utils/skill-installer.js";
import {
  canonicalizeMissionArtifactContent,
  isStructuredArtifact,
  MissionArtifactSchemaError,
} from "./schema/mission-schema.js";
import { ValidationContractSchema, validateSchema } from "./schema/report-schemas.js";
import { writeWorkerRawOutput } from "./workers/worker-output.js";
import { buildValidationRecoveryPlan } from "./mission/validation-recovery.js";
import { checkIntegratedFeatureIntegration } from "./mission/integration-preflight.js";
import { resolveFeatureAssertions, formatFeatureAssertionsForPrompt, computeFeatureComplexity } from "./mission/feature-assertions.js";
import { prepareSerialWorkerBranch, finalizeSerialWorkerBranch, copyFeatureFilesToWorkspace } from "./mission/worker-workspace.js";
import {
  evaluateFeatureIntegrationGate,
  applyFeatureIntegration,
  wouldIntroduceIntegratedTransition,
} from "./mission/feature-completion.js";
import { createReportReceiver, persistSubmittedReport, persistWorkerReceipt } from "./report-submission.js";
import { runUserTestingCoordinator } from "./mission/user-testing-coordinator.js";
import { getCurrentDashboardUrl } from "../observatory/server.js";
import { evaluateMilestoneValidation, applyMilestoneValidation, markMissionCompleted } from "./mission/validation-finalization.js";
import type { MissionExecutionContext } from "./mission/execution-context.js";
import { checkExecutionAuthorization, type ExecutionGateResult } from "./mission/execution-gate.js";
import { runModelPreflight, type ModelPreflightDeps, type ModelPreflightResult, type PreflightProblemCode } from "./mission/model-preflight.js";
import { EmptyOutputError } from "./models/error-classifier.js";

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
export function runResearchTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("run_research", { query: params.query });

      const findings = await spawnResearchAgent(params.query, params.scope, context);
      const durationMs = Date.now() - startTime;
      context.logger.toolResult("run_research", { durationMs });
      return {
        content: [{ type: "text", text: findings }],
        details: {},
      };
    },
  });
}

/**
 * Spawn an over-scoped Smart Friend agent to critique the orchestrator's trajectory.
 * The Smart Friend receives the FULL mission state, explores the codebase independently,
 * and looks beyond the specific question to find what the orchestrator missed.
 */
export function askSmartFriendTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("ask_smart_friend", { question: params.question });

      // Load full mission state — Smart Friend gets everything, not a curated summary
      const state = await loadMissionState(context.scope);
      const missionSummary = summarizeMissionState(state);

      const critique = await spawnSmartFriendAgent(
        missionSummary,
        params.question,
        context,
      );
      const durationMs = Date.now() - startTime;
      context.logger.toolResult("ask_smart_friend", { durationMs });
      return {
        content: [{ type: "text", text: critique }],
        details: {},
      };
    },
  });
}

/**
 * Spawn a Validation Contract Writer agent.
 * CRITICAL: this must be called BEFORE feature decomposition.
 * The agent receives requirements + constraints + research + decision log, NOT the feature plan.
 * Can explore codebase and research domain validation patterns independently.
 */
export function draftValidationContractTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("draft_validation_contract", { requirements: params.requirements });

      const contractModelConfig = await getModelConfig(context.scope.projectRoot);
      const contract = await spawnContractAgent(
        params.requirements,
        params.constraints,
        params.researchNotes,
        params.decisionLog,
        context,
      );
      const durationMs = Date.now() - startTime;

      // ── Artifact verification ──
      // The contract agent's response is prose/Gherkin, not JSONL, so we cannot
      // JSONL-parse it. Instead, we verify that the expected artifact files were
      // actually written to disk. If the agent returned an image, an error, or
      // just prose without writing the artifacts, the mission cannot proceed.
      //
      // Required artifacts:
      //   1. .ratel/missions/<missionId>/validation-contract.md (non-empty)
      //   2. At least one .ratel/missions/<missionId>/features/*.feature file (non-empty)
      let validationContractContent: string | undefined;
      let featureFiles: string[] = [];
      let featureContentSizes: number[] = [];
      let missingArtifacts: string[] = [];

      try {
        validationContractContent = await readArtifact(context.scope, "validation-contract.md");
      } catch {
        missingArtifacts.push("validation-contract.md");
      }
      if (!validationContractContent || validationContractContent.trim().length === 0) {
        if (!missingArtifacts.includes("validation-contract.md")) {
          missingArtifacts.push("validation-contract.md (empty)");
        }
      }

      try {
        featureFiles = await listFeatureFiles(context.scope);
        for (const f of featureFiles) {
          const content = await readFeatureFileSafe(context.scope, f);
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
        context.logger.toolResult("draft_validation_contract", {
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

      context.logger.toolResult("draft_validation_contract", {
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
            `  - .ratel/missions/${context.scope.missionId}/validation-contract.md (${validationContractContent?.length ?? 0} bytes)\n` +
            `  - .ratel/missions/${context.scope.missionId}/features/ (${featureFiles.length} .feature files: ${featureFiles.join(", ")})\n\n` +
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
}

/**
 * Safely read a feature file, returning undefined on any error.
 */
async function readFeatureFileSafe(scope: import("./mission/scope.js").MissionScope, filename: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return await readFile(join(getMissionDir(scope), "features", filename), "utf-8");
  } catch {
    return undefined;
  }
}

function getMissionDir(scope: import("./mission/scope.js").MissionScope): string {
  return join(scope.projectRoot, ".ratel", "missions", scope.missionId);
}

/**
 * Write or append a canonical mission artifact.
 * This is the ONLY way mission state is persisted.
 */
export function writeMissionArtifactTool(context: MissionExecutionContext) {
  return defineTool({
    name: "write_mission_artifact",
    label: "Write Mission Artifact",
    description:
      "Write or append a canonical mission artifact under .ratel/missions/<missionId>/. " +
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
      context.logger.toolCall("write_mission_artifact", { artifact: params.artifact, mode: params.mode });

      const artifact = params.artifact as ArtifactName;
      const mode = params.mode === "append" ? "append" : "overwrite";

      let contentToWrite = params.content;
      if (isStructuredArtifact(artifact)) {
        if (mode === "append") {
          const message = `Invalid ${artifact}: structured JSON artifacts cannot be appended; use overwrite with a complete canonical document.`;
          context.logger.toolResult("write_mission_artifact", { parseStatus: "failed", error: message });
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
          context.logger.toolResult("write_mission_artifact", { parseStatus: "failed", error: message });
          return {
            content: [{ type: "text" as const, text: `ERROR: Invalid ${artifact}: ${message}. Previous artifact was not overwritten.` }],
            details: { error: "schema_validation_failed", artifact, message },
          };
        }
      }

      // If writing features.json, block direct transitions to "integrated" or "validated".
      if (artifact === "features.json") {
        const currentFeatures = await readFeatures(context.scope);
        let proposedFeatures: Feature[] | undefined;
        try {
          proposedFeatures = JSON.parse(contentToWrite).features;
        } catch {
          /* invalid JSON handled by canonicalizeMissionArtifactContent above */
        }
        const transitionCheck = wouldIntroduceIntegratedTransition(currentFeatures, proposedFeatures);
        if (transitionCheck.blocked) {
          context.logger.toolResult("write_mission_artifact", { parseStatus: "failed", error: transitionCheck.reason });
          return {
            content: [{ type: "text" as const, text: `ERROR: ${transitionCheck.reason}` }],
            details: { error: "integrated_transition_blocked", artifact, reason: transitionCheck.reason },
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
        context.scope,
        artifact,
        contentToWrite,
        mode,
        context.logger,
      );

      if (artifact !== "state.json") {
        // Bump version for non-state artifacts after the artifact itself was safely written.
        await bumpVersion(context.scope);
      }

      context.logger.toolResult("write_mission_artifact", { byteCount: contentToWrite.length });
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
}

/**
 * Mark a feature as integrated through the non-bypassable integration gate.
 * The orchestrator decides WHEN to request integration.
 * The gate validates WHETHER the requested transition is structurally and operationally valid.
 */
export function markFeatureIntegratedTool(context: MissionExecutionContext) {
  return defineTool({
    name: "mark_feature_integrated",
    label: "Mark Feature Integrated",
    description:
      "Mark a feature as integrated after verifying the worker handoff is clean, " +
      "no high issues were discovered, leftUndone is empty, and the workspace was merged or skipped. " +
      "This is the ONLY way to transition a feature to 'integrated'. " +
      "Workers CANNOT complete or validate a feature. Do NOT write features.json directly to mark integration.",
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to mark as integrated" }),
    }),
    execute: async (_toolCallId, params) => {
      context.logger.toolCall("mark_feature_integrated", { featureId: params.featureId });

      const gate = await evaluateFeatureIntegrationGate(context.scope, params.featureId);

      const resultDetails = !gate.success
        ? { success: false as const, featureId: params.featureId, commitSha: undefined as string | undefined, errors: gate.errors }
        : { success: true as const, featureId: params.featureId, commitSha: gate.commitSha, errors: [] as string[] };

      if (!gate.success) {
        context.logger.toolResult("mark_feature_integrated", { success: false, errors: gate.errors });
        return {
          content: [{
            type: "text" as const,
            text: [
              `Feature ${params.featureId} cannot be marked integrated:`,
              "",
              ...gate.errors.map((e) => `- ${e}`),
              "",
              "Create recovery work or halt if the gate cannot be satisfied.",
            ].join("\n"),
          }],
          details: resultDetails,
        };
      }

      await applyFeatureIntegration(context.scope, params.featureId, gate.commitSha);

      context.logger.toolResult("mark_feature_integrated", { success: true, featureId: params.featureId, commitSha: gate.commitSha });
      return {
        content: [{
          type: "text" as const,
          text: `Feature ${params.featureId} marked as integrated.${gate.commitSha ? ` Commit: ${gate.commitSha}` : ""}`,
        }],
        details: resultDetails,
      };
    },
  });
}

/**
 * Write a Gherkin .feature file under .ratel/missions/<missionId>/features/.
 * Used by the Contract Agent to write validation contract scenarios.
 */
export function writeFeatureFileTool(context: MissionExecutionContext) {
  return defineTool({
    name: "write_feature_file",
    label: "Write Feature File",
    description:
      "Write a Gherkin .feature file under .ratel/missions/<missionId>/features/. " +
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
      context.logger.toolCall("write_feature_file", { filename: params.filename });

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

      await writeFeatureFile(context.scope, params.filename, params.content);
      const byteCount = Buffer.byteLength(params.content, "utf-8");

      context.logger.toolResult("write_feature_file", { byteCount });
      const result: { content: { type: "text"; text: string }[]; details: { error: string; filename?: string; path?: string; byteCount?: number } } = {
        content: [{
          type: "text",
          text: `Wrote .ratel/missions/${context.scope.missionId}/features/${params.filename} (${byteCount} bytes).`,
        }],
        details: {
          error: "",
          filename: params.filename,
          path: `.ratel/missions/${context.scope.missionId}/features/${params.filename}`,
          byteCount,
        },
      };
      return result;
    },
  });
}

/**
 * Load the current mission state from all artifacts and return a structured summary.
 * Call this before making decisions.
 */
export function loadMissionStateTool(context: MissionExecutionContext) {
  return defineTool({
    name: "load_mission_state",
    label: "Load Mission State",
    description:
      "Loads all mission artifacts from .ratel/missions/<missionId>/ and returns a structured summary. " +
      "Call this before making decisions to ensure you have the latest canonical state.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params) => {
      context.logger.toolCall("load_mission_state", {});
      const state = await loadMissionState(context.scope);
      const summary = summarizeMissionState(state);
      context.logger.toolResult("load_mission_state", {
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
}

/**
 * Halt the current mission and return control to the user.
 * Writes a halt record to .ratel/missions/<missionId>/halt-reason.md.
 */
export function haltMissionTool(context: MissionExecutionContext) {
  return defineTool({
    name: "halt_mission",
    label: "Halt Mission",
    description:
      "Halt the current mission and return control to the user. " +
      "Use when: a helper agent surfaces a blocking issue, the user disagrees with direction, " +
      "validation fails irreversibly, or insufficient information exists to proceed safely. " +
      "Writes a halt record to .ratel/missions/<missionId>/halt-reason.md and stops further phase transitions.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the mission is halted" }),
      context: Type.String({ description: "What the user should know before resuming" }),
      resumeHint: Type.String({ description: "What would allow the mission to resume" }),
    }),
    execute: async (_toolCallId, params) => {
      context.logger.toolCall("halt_mission", { reason: params.reason });
      const haltedAt = new Date().toISOString();
      const haltRecord = `# Mission Halted

**Reason:** ${params.reason}

**Context:** ${params.context}

**Resume Hint:** ${params.resumeHint}

**Halted At:** ${haltedAt}
`;
      await writeArtifact(context.scope, "halt-reason.md", haltRecord);

      const currentState = await readState(context.scope);
      await writeState(context.scope, {
        ...(currentState ?? { version: 0 }),
        phase: "halted",
        version: (currentState?.version ?? 0) + 1,
        updatedAt: haltedAt,
      });

      context.logger.halt(params.reason, params.resumeHint);
      context.logger.toolResult("halt_mission", { phase: "halted" });
      return {
        content: [{ type: "text", text: `Mission halted. Record written to halt-reason.md. Reason: ${params.reason}` }],
        details: { halted: true, phase: "halted" },
      };
    },
  });
}

/**
 * Append a structured decision entry to the decision-log.
 * Use this for every significant architectural, product, or scope decision.
 */
export function logDecisionTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("log_decision", { context: params.context, decision: params.decision });
      const id = `DEC-${Date.now()}`;
      const timestamp = new Date().toISOString();
      const decision = {
        id,
        timestamp,
        context: params.context,
        decision: params.decision,
        rationale: params.rationale,
      };
      await appendDecision(context.scope, decision, context.logger);
      context.logger.toolResult("log_decision", { decisionId: id });
      return {
        content: [{ type: "text", text: `Logged decision ${id} to decisions.jsonl.` }],
        details: { decisionId: id },
      };
    },
  });
}

/**
 * After all features in a milestone are completed, spawn the Scrutiny Validator.
 * The Scrutiny Validator runs automated checks (tests, typecheck, lint) and spawns
 * parallel code review subagents for each completed feature.
 */
export function runValidationTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("run_validation", { milestoneId: params.milestoneId });

      // ── Wave 3: hard phase-transition enforcement ──
      // 1. Execution authorization gate — refuse before any expensive work.
      const gate = await checkExecutionAuthorization(context.scope);
      if (!gate.authorized) {
        const refusal = authorizationRefusalResult("run_validation", gate);
        context.logger.toolResult("run_validation", { refused: true, gate: "execution_authorization", reason: gate.reason });
        return refusal;
      }

      // 2. Model/credential preflight — after authorization, before agent spawn.
      //    Never consumes tokens; never spawns a validator.
      const modelPreflight = await runModelPreflight(context.scope.projectRoot, context.preflightDeps);
      if (!modelPreflight.ok) {
        const refusal = preflightRefusalResult("run_validation", modelPreflight);
        context.logger.toolResult("run_validation", { refused: true, gate: "model_preflight", noTokensConsumed: true });
        return refusal;
      }

      let contentText = "";
      let details: Record<string, unknown> = {};

      // 1. Read integrated features for this milestone through the canonical
      //    artifact schema boundary. This accepts legacy mission artifacts at the
      //    edge but exposes only canonical Feature objects to validators.
      const milestoneFeatures = await getIntegratedFeaturesForMilestone(context.scope, params.milestoneId);

      if (milestoneFeatures.length === 0) {
        contentText = `No integrated features found for milestone ${params.milestoneId}.`;
        details = { error: "no_integrated_features", milestoneId: params.milestoneId };
      } else {
        // 2. Deterministic integration preflight. Validation runs against the
        //    canonical integration branch, so completed feature commits must be
        //    reachable from that branch before spawning expensive validators.
        const preflight = await checkIntegratedFeatureIntegration(context.scope, milestoneFeatures);
        context.logger.integrationPreflight({
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
            `**Missing integrated features:** ${preflight.missing.map((item) => item.featureId).join(", ")}`,
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
          const validatorModelConfig = await getModelConfig(context.scope.projectRoot);
          let scrutinyReportRaw: string;
          let emptyOutput = false;
          try {
            scrutinyReportRaw = await spawnScrutinyValidator(
              params.milestoneId,
              milestoneFeatures.map((f) => f.id),
              context.scope.projectRoot,
              context.logger,
              context.scope,
              validatorModelConfig.validator ?? undefined,
              context.budget,
            );
          } catch (err) {
            // 0-byte output after retry: classify as `empty_output`
            // (infrastructure failure), NOT parse_failure. Surface it as a
            // parseStatus: "failed" result with explicit classification so
            // the orchestrator can distinguish it from a malformed response.
            if (err instanceof EmptyOutputError) {
              emptyOutput = true;
              scrutinyReportRaw = "";
            } else {
              throw err;
            }
          }

        // 3. ALWAYS persist raw validator output for audit / fallback inspection.
        const rawFilename = `scrutiny-${params.milestoneId}-${Date.now()}.raw.txt`;
        await writeRawOutput(context.scope, "validation-reports", rawFilename, scrutinyReportRaw);

        // 4. Parse the last valid JSON line (JSONL). Bottom-up scan, robust
        //    against preamble, postamble, and markdown fences.
        const parseResult = extractLastJsonLine<ScrutinyReport>(scrutinyReportRaw, isScrutinyReport);

        // 5. If parsed, also persist the structured report.
        if (parseResult.parseStatus === "ok" && parseResult.data) {
          await writeValidationReport(context.scope, parseResult.data);
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
          context.logger.validationRecovery({
            milestoneId: params.milestoneId,
            blockingIssueIds: recovery.blockingIssueIds,
            fixFeatureCount: recovery.suggestedFixFeatures.length,
            rawFilename,
          });
        }

        contentText = [
          `## Validation Complete for Milestone ${params.milestoneId}`,
          "",
          `**Raw output:** .ratel/missions/${context.scope.missionId}/validation-reports/${rawFilename}`,
          `**Parse status:** ${parseResult.parseStatus}`,
          "",
          parseResult.parseStatus === "ok"
            ? recovery?.kind === "fix_features_required"
              ? `**Blocking issues found:** ${recovery.blockingIssueIds.length}. This is recoverable validation feedback, not a tooling halt. Create same-milestone fix features from details.recovery.suggestedFixFeatures, run workers serially, then rerun validation.`
              : `**Issues found:** ${issueCount}. No blocking recovery work required. Read details.report for non-blocking findings.`
            : emptyOutput
              ? `**WARNING:** Validator produced no text output after retry (empty_output). This is an infrastructure failure, not a parse error. Do NOT infer success — call halt_mission() and surface the empty_output classification to the user.`
              : `**WARNING:** Validator output could not be parsed as JSONL. The raw text is preserved at the path above. Do NOT infer success — call halt_mission() and surface the raw text to the user.`,
        ].join("\n");

        details = {
          parseStatus: parseResult.parseStatus,
          rawFilename,
          report: parseResult.data, // null if parse failed
          recovery,
          ...(emptyOutput ? { failureCategory: "empty_output" as const } : {}),
        };
        }
      }

      const durationMs = Date.now() - startTime;
      context.logger.toolResult("run_validation", {
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
}

/**
 * Spawn a Worker Agent to implement a single feature.
 * The worker receives the feature spec + validation assertions + shared procedures.
 * It implements the feature using TDD, commits, and writes a structured handoff.
 */
export function runWorkerTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("run_worker", { featureId: params.featureId });

      // ── Wave 3: hard phase-transition enforcement ──
      // 1. Execution authorization gate — refuse before any expensive work.
      const gate = await checkExecutionAuthorization(context.scope);
      if (!gate.authorized) {
        const refusal = authorizationRefusalResult("run_worker", gate);
        context.logger.toolResult("run_worker", { refused: true, gate: "execution_authorization", reason: gate.reason });
        return refusal;
      }

      // 2. Model/credential preflight — after authorization, before agent spawn.
      //    Never consumes tokens; never spawns a worker.
      const modelPreflight = await runModelPreflight(context.scope.projectRoot, context.preflightDeps);
      if (!modelPreflight.ok) {
        const refusal = preflightRefusalResult("run_worker", modelPreflight);
        context.logger.toolResult("run_worker", { refused: true, gate: "model_preflight", noTokensConsumed: true });
        return refusal;
      }

      // 3. Conservative pre-run budget estimate/refusal — refuse to start a
      //    worker the mission cannot afford to validate. Idempotent; never
      //    mutates budget state.
      const budgetCheck = await checkWorkerRunBudget(context.budget);
      if (budgetCheck.refuse) {
        const refusal = budgetRefusalResult("run_worker", budgetCheck);
        context.logger.toolResult("run_worker", { refused: true, gate: "budget_estimate", category: budgetCheck.category });
        return refusal;
      }

      let contentText = "";
      let details: Record<string, unknown> = {};

      // Load the feature
      const features = await readFeatures(context.scope);
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
          const resolvedAssertions = await resolveFeatureAssertions(context.scope, feature);
          const acceptanceCriteria = formatFeatureAssertionsForPrompt(resolvedAssertions);

          // Prepare the canonical serial branch workspace. Workers run one at a
          // time, so a local feature branch in the integration checkout avoids
          // duplicated worktrees/node_modules and prevents stale integration.
          const workspace = await prepareSerialWorkerBranch(context.scope, feature.id);

          // Copy resolved .feature assertion files into the worker's workspace
          // so the worker can find them at features/*.feature. Only resolved
          // documents are copied; missing references are skipped.
          let copiedFeatureFiles: string[] = [];
          if (workspace.status !== "blocked" && workspace.repoPath) {
            copiedFeatureFiles = await copyFeatureFilesToWorkspace(workspace.repoPath, resolvedAssertions.documents, context.logger);
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
          const missionProcedures = await readArtifact(context.scope, "agents.md");
          if (missionProcedures) {
            procedures = missionProcedures;
          } else {
            const { readFile } = await import("node:fs/promises");
            const { join: pathJoin } = await import("node:path");
            try {
              procedures = await readFile(pathJoin(context.scope.projectRoot, "AGENTS.md"), "utf-8");
            } catch {
              procedures = "";
            }
          }

          // Load default worker skills from .pi/skills/
          const allAvailableSkills = await loadSkillsFromDir(context.scope.projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);

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
          const skillsConfig = await readWorkerSkillsConfig(context.scope);
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

          const workerModelConfig = await getModelConfig(context.scope.projectRoot);
          const result = await spawnWorkerAgent(feature, acceptanceCriteria, procedures, context.scope, context.logger, workerSkills, workerModelConfig.worker ?? undefined, workspace, effectiveTimeoutMinutes, context.budget);

          // Persist the raw worker transcript before interpreting the handoff.
          // This preserves the ground truth needed to debug parseStatus failures.
          const rawFilename = await writeWorkerRawOutput(context.scope, result.featureId, result.rawResponse);

          // Persist the structured/fallback handoff separately.
          await writeHandoff(context.scope, result.handoff);

          const highIssueCount = result.handoff.issuesDiscovered.filter((i) => i.severity === "high").length;
          const shouldFinalizeWorkspace =
            workspace.status === "ready" &&
            result.parseStatus === "ok" &&
            result.handoff.leftUndone.length === 0 &&
            highIssueCount === 0;
          const workspaceFinalization = shouldFinalizeWorkspace
            ? await finalizeSerialWorkerBranch(context.scope.projectRoot, result.featureId, workspace.integrationBranch, workspace.repoPath)
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
          await persistWorkerReceipt(context.scope, {
            featureId: result.featureId,
            recordedAt: new Date().toISOString(),
            parseStatus: result.parseStatus,
            reportSource: result.reportSource ?? "jsonl_fallback",
            handoffPath: `.ratel/missions/${context.scope.missionId}/handoffs/${result.featureId}.json`,
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
            `**Handoff file:** .ratel/missions/${context.scope.missionId}/handoffs/${result.featureId}.json`,
            `**Raw output:** .ratel/missions/${context.scope.missionId}/${rawFilename}`,
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
              result.failureCategory === "empty_output"
                ? "\n\n**WARNING:** Worker produced no text output after retry (empty_output). This is an infrastructure failure, not a parse error. Do NOT infer success."
                : "\n\n**WARNING:** Worker handoff could not be parsed as JSONL. Inspect the raw response and the worker prompt. Do NOT infer success.";
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
            ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
          };
          }
        }
      }

      const durationMs = Date.now() - startTime;
      context.logger.toolResult("run_worker", {
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
}

/**
 * After scrutiny validation passes, spawn the User-Testing Validator.
 * The validator reads Gherkin .feature files, starts the app, opens it with agent-browser,
 * executes scenarios step-by-step, and writes a structured report with screenshot evidence.
 */
export function runUserTestingTool(context: MissionExecutionContext) {
  return defineTool({
    name: "run_user_testing",
    label: "Run User Testing",
    description:
      "Spawns the User-Testing Validator to perform end-to-end browser validation of integrated features. " +
      "MUST be called AFTER run_validation passes. The validator reads Gherkin .feature files, starts the app, " +
      "opens it with agent-browser, executes scenarios step-by-step, and writes a structured report with " +
      "screenshot evidence.",
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to validate" }),
    }),
    execute: async (_toolCallId, params) => {
      const startTime = Date.now();
      context.logger.toolCall("run_user_testing", { milestoneId: params.milestoneId });

      // ── Wave 3: hard phase-transition enforcement ──
      // 1. Execution authorization gate — refuse before any expensive work.
      const gate = await checkExecutionAuthorization(context.scope);
      if (!gate.authorized) {
        const refusal = authorizationRefusalResult("run_user_testing", gate);
        context.logger.toolResult("run_user_testing", { refused: true, gate: "execution_authorization", reason: gate.reason });
        return refusal;
      }

      // 2. Model/credential preflight — after authorization, before agent spawn.
      //    Never consumes tokens; never spawns a user-testing validator.
      const modelPreflight = await runModelPreflight(context.scope.projectRoot, context.preflightDeps);
      if (!modelPreflight.ok) {
        const refusal = preflightRefusalResult("run_user_testing", modelPreflight);
        context.logger.toolResult("run_user_testing", { refused: true, gate: "model_preflight", noTokensConsumed: true });
        return refusal;
      }

      const milestoneFeatures = await getIntegratedFeaturesForMilestone(context.scope, params.milestoneId);

      if (milestoneFeatures.length === 0) {
        const durationMs = Date.now() - startTime;
        context.logger.toolResult("run_user_testing", { durationMs });
        return {
          content: [{ type: "text" as const, text: `No integrated features found for milestone ${params.milestoneId}` }],
          details: { error: "no_completed_features", milestoneId: params.milestoneId } as Record<string, unknown>,
        };
      }

      const preflight = await checkIntegratedFeatureIntegration(context.scope, milestoneFeatures);
      context.logger.integrationPreflight({
        milestoneId: params.milestoneId,
        status: preflight.status,
        branch: preflight.branch,
        repoPath: preflight.repoPath,
        checkedFeatureCount: preflight.checkedFeatureCount,
        missingFeatureIds: preflight.missing.map((item) => item.featureId),
      });

      if (preflight.status === "failed") {
        const durationMs = Date.now() - startTime;
        context.logger.toolResult("run_user_testing", {
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
              `**Missing integrated features:** ${preflight.missing.map((item) => item.featureId).join(", ")}`,
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
      const utModelConfig = await getModelConfig(context.scope.projectRoot);
      const coordinatorResult = await runUserTestingCoordinator(
        context.scope,
        params.milestoneId,
        milestoneFeatures,
        utModelConfig.validator ?? undefined,
        context.logger,
      );

      // Persist aggregate report
      if (coordinatorResult.report) {
        await writeUserTestingReport(context.scope, coordinatorResult.report);
      }

      const report = coordinatorResult.report;
      const issueCount = report.issues.length;
      const recovery = report
        ? buildValidationRecoveryPlan(report, params.milestoneId)
        : undefined;

      if (recovery?.kind === "fix_features_required") {
        context.logger.validationRecovery({
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
      context.logger.toolResult("run_user_testing", {
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
}

/**
 * Set the model for a specific agent level (orchestrator, worker, or validator).
 * Updates ratel.json with the new model string. The model takes effect on the next
 * agent spawn — running agents are not affected.
 */
export function setModelTool(context: MissionExecutionContext) {
  return defineTool({
    name: "set_model",
    label: "Set Model",
    description:
      "Set the model for a specific agent level. Three levels: orchestrator (also used by research, smart-friend, contract), " +
      "worker (used by all worker spawns), validator (used by scrutiny, code-review, user-testing). " +
      "Format: 'provider/model-id' (e.g. 'openai-codex/gpt-5.4'). Pass null or empty string to revert to SDK default. " +
      "The model is validated against the live model registry before persisting — unknown provider/model slugs are rejected. " +
      "Provider aliases (e.g. 'openai' → 'openai-codex') are normalized to canonical slugs. " +
      "The model change takes effect on the next agent spawn — running agents are not affected.",
    parameters: Type.Object({
      level: Type.Union([
        Type.Literal("orchestrator"),
        Type.Literal("worker"),
        Type.Literal("validator"),
      ], { description: "Agent level: orchestrator, worker, or validator" }),
      model: Type.String({
        description: "Model in provider/model-id format (e.g. 'openai-codex/gpt-5.4'). Pass '' to clear (revert to SDK default).",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const model = params.model.trim() || null;
      const levelLabel = params.level.charAt(0).toUpperCase() + params.level.slice(1);

      let resultConfig: ModelConfig;
      let resultError: string | undefined;

      try {
        resultConfig = await setModelConfig(
          context.scope.projectRoot,
          params.level,
          model,
          getDefaultAgentDir(),
        );
        resultError = undefined;
      } catch (err) {
        resultConfig = await getModelConfig(context.scope.projectRoot);
        resultError = err instanceof Error ? err.message : String(err);
      }

      const modelLabel = model || "SDK default";
      const details: { level: typeof params.level; model: string | null; config: ModelConfig; error: string | undefined } = {
        level: params.level,
        model,
        config: resultConfig,
        error: resultError,
      };

      if (resultError) {
        return {
          content: [{
            type: "text",
            text: `ERROR: ${resultError}\n\nThe model was NOT changed. Use list_models to see available models and their canonical slugs.`,
          }],
          details,
        };
      }
      return {
        content: [{
          type: "text",
          text: `${levelLabel} model set to: ${modelLabel}\n\nCurrent model config:\n- Orchestrator: ${resultConfig.orchestrator || "SDK default"}\n- Worker: ${resultConfig.worker || "SDK default"}\n- Validator: ${resultConfig.validator || "SDK default"}`,
        }],
        details,
      };
    },
  });
}

/**
 * List available models and current model configuration.
 * Uses Pi's ModelRegistry to discover models with configured API keys.
 */
export function listModelsTool(context: MissionExecutionContext) {
  return defineTool({
    name: "list_models",
    label: "List Models",
    description:
      "List available models (from Pi's ModelRegistry) and current model configuration for all three agent levels. " +
      "Shows canonical provider/model-id slugs, which providers have API keys configured, and auth status. " +
      "The registry is refreshed before listing to pick up any changes to models.json.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params) => {
      const [availableModels, currentConfig] = await Promise.all([
        listAvailableModels(context.scope.projectRoot, getDefaultAgentDir()),
        getModelConfig(context.scope.projectRoot),
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
        `_Use canonical slugs (provider/model-id) with set_model.`,
        "",
      ];

      for (const [provider, models] of [...byProvider.entries()].sort()) {
        const authStatus = models[0]?.hasAuth ? "🔑 auth configured" : "⚠️ no auth";
        lines.push(`### ${provider} (${authStatus})`);
        for (const m of models.sort((a, b) => a.id.localeCompare(b.id))) {
          const authIcon = m.hasAuth ? "🔑" : "⚠️";
          lines.push(`- ${authIcon} \`${m.canonical}\` — ${m.name}`);
        }
      }

      if (availableModels.length === 0) {
        lines.push("No models with configured API keys found. Set API keys in ~/.pi/agent/auth.json or environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          config: currentConfig,
          availableCount: availableModels.length,
          models: availableModels.map((m) => ({
            canonical: m.canonical,
            provider: m.provider,
            id: m.id,
            name: m.name,
            hasAuth: m.hasAuth,
          })),
        },
      };
    },
  });
}

/**
 * Ping all subagents to verify factory health.
 * Spawns a trivial task in each of the six subagent roles and reports per-agent status.
 */
export function pingAgentsTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("ping_agents", { timeoutMs: params.timeoutMs });

      const timeoutMs = params.timeoutMs ?? 20000;

      const result = await pingAllAgents(context.scope.projectRoot, timeoutMs);

      const totalDurationMs = Date.now() - startTime;
      const overallStatus = result.ok ? "ok" : "degraded";

      context.logger.toolResult("ping_agents", {
        durationMs: totalDurationMs,
        totalAgents: result.totalAgents,
        okCount: result.okCount,
        failedCount: result.failedCount,
        overallStatus,
      });

      // Log ping events for each agent
      for (const a of result.agents) {
        context.logger.ping(a.role, a.status, a.timeMs, a.error);
      }

      // Get model config for report
      const modelConfig = await getModelConfig(context.scope.projectRoot);

      // Format user-facing summary
      const summaryLines: string[] = [
        `Factory health check: ${overallStatus.toUpperCase()}`,
        `  Total agents: ${result.totalAgents}`,
        `  OK: ${result.okCount}`,
        `  Failed: ${result.failedCount}`,
        `  Total time: ${totalDurationMs}ms`,
        ``,
        `Per-agent results:`,
      ];
      for (const a of result.agents) {
        const icon = a.status === "ok" ? "✓" : "✗";
        summaryLines.push(`  ${icon} ${a.role}: ${a.status} (${a.timeMs}ms)${a.error ? ` — ${a.error}` : ""}`);
      }

      if (result.failedCount > 0) {
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
        summaryLines.push(`Check .ratel/missions/${context.scope.missionId}/events.jsonl and .ratel/missions/${context.scope.missionId}/factory-health-report.md for details.`);
      }

      const reportPath = `.ratel/missions/${context.scope.missionId}/factory-health-report.md`;
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
        `| Agent | Status | Duration | Error |`,
        `|---|---:|---|---|`,
        ...result.agents.map((a) =>
          `| ${a.role} | ${a.status} | ${a.timeMs}ms | ${a.error ?? ""} |`
        ),
        ``,
        `## Notes`,
        ``,
        `- This is a lightweight availability ping. It does not run the production contract writer, write contract artifacts, start apps, or execute mission work.`,
        `- A contract_writer timeout does not imply validator model failure; contract_writer uses the orchestrator model tier.`,
        `- If only contract_writer times out while research/smart_friend pass on the same model, the most likely cause is timeout margin plus the contract writer's larger prompt/skill bundle. Retry with a higher timeout, e.g. ping_agents({ timeoutMs: 30000 }).`,
      ];

      try {
        await mkdir(join(context.scope.projectRoot, ".ratel", "missions", context.scope.missionId), { recursive: true });
        await writeFile(join(context.scope.projectRoot, reportPath), reportLines.join("\n") + "\n", "utf-8");
      } catch {
        // Fail-soft: health observability must not break the factory.
      }

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: {
          overallStatus,
          totalAgents: result.totalAgents,
          okCount: result.okCount,
          failedCount: result.failedCount,
          totalDurationMs,
          reportPath,
          results: Object.fromEntries(result.agents.map(a => [a.role, { status: a.status, durationMs: a.timeMs, error: a.error }])),
        },
      };
    },
  });
}

/**
 * Budget visibility tool. Exposes the current mission budget state, remaining
 * headroom, and a coarse risk level. Visibility only — does NOT reserve or
 * refuse budget (reservation/refusal is a later wave).
 */
export function getBudgetStatusTool(context: MissionExecutionContext) {
  return defineTool({
    name: "get_budget_status",
    label: "Get Budget Status",
    description:
      "Returns the current mission budget state, remaining headroom for each metric " +
      "(cost, total tokens, wall-clock, agent runs), per-metric used fraction, and a coarse " +
      "risk level (ok | warning | critical | exhausted). Visibility only; does not reserve " +
      "or refuse budget. Use this to decide whether to start a costly step.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params) => {
      const state = await context.budget.getState();
      const remaining = await context.budget.remaining();
      const usedFraction = computeBudgetUsedFraction(state);
      const risk = computeBudgetRiskLevel(state, usedFraction);

      const lines: string[] = [
        `## Budget Status: ${risk.toUpperCase()}`,
        "",
        `| Metric | Used | Limit | Remaining | Used % |`,
        `|---|---:|---:|---:|---:|`,
        formatBudgetMetricRow("costUsd", state.costUsd, state.limits.maxCostUsd, remaining.costUsd, usedFraction.costUsd, "$"),
        formatBudgetMetricRow("totalTokens", state.totalTokens, state.limits.maxTotalTokens, remaining.totalTokens, usedFraction.totalTokens),
        formatBudgetMetricRow("agentRuns", state.agentRuns, state.limits.maxAgentRuns, remaining.agentRuns, usedFraction.agentRuns),
        formatBudgetMetricRow("wallClockMin", wallClockElapsedMinutes(state), state.limits.maxWallClockMinutes, remaining.wallClockMs != null ? remaining.wallClockMs / 60000 : null, usedFraction.wallClock),
        "",
      ];
      if (state.exhausted) {
        lines.push(`**Exhausted:** ${state.exhausted.reason} at ${state.exhausted.at}`);
      }

      context.logger.toolCall("get_budget_status", {});
      context.logger.toolResult("get_budget_status", { risk });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          state,
          remaining,
          usedFraction,
          risk,
        },
      };
    },
  });
}

/** Compute the used fraction (0..1) for each budget metric that has a limit. */
function computeBudgetUsedFraction(state: import("./budget/types.js").MissionBudgetState) {
  const elapsedMin = wallClockElapsedMinutes(state);
  return {
    costUsd: fraction(state.costUsd, state.limits.maxCostUsd),
    totalTokens: fraction(state.totalTokens, state.limits.maxTotalTokens),
    agentRuns: fraction(state.agentRuns, state.limits.maxAgentRuns),
    wallClock: fraction(elapsedMin, state.limits.maxWallClockMinutes),
  };
}

/** Coarse risk level from exhausted flag + max used fraction across metrics. */
function computeBudgetRiskLevel(
  state: import("./budget/types.js").MissionBudgetState,
  usedFraction: ReturnType<typeof computeBudgetUsedFraction>,
): "ok" | "warning" | "critical" | "exhausted" {
  if (state.exhausted) return "exhausted";
  const fractions = [
    usedFraction.costUsd,
    usedFraction.totalTokens,
    usedFraction.agentRuns,
    usedFraction.wallClock,
  ].filter((f): f is number => f !== null);
  const maxFraction = fractions.length > 0 ? Math.max(...fractions) : 0;
  if (maxFraction >= 0.9) return "critical";
  if (maxFraction >= 0.75) return "warning";
  return "ok";
}

function fraction(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return used / limit;
}

function wallClockElapsedMinutes(state: import("./budget/types.js").MissionBudgetState): number {
  return (Date.now() - new Date(state.startedAt).getTime()) / 1000 / 60;
}

function formatBudgetMetricRow(
  name: string,
  used: number,
  limit: number | null,
  remaining: number | null,
  usedFrac: number | null,
  prefix = "",
): string {
  const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(n >= 100 ? 0 : 2));
  const pct = usedFrac === null ? "—" : `${(usedFrac * 100).toFixed(0)}%`;
  return `| ${name} | ${prefix}${fmt(used)} | ${prefix}${fmt(limit)} | ${prefix}${fmt(remaining)} | ${pct} |`;
}

// ─── Wave 3: execution authorization / preflight / budget refusal helpers ───

/**
 * Conservative flat estimate of the budget headroom a single `run_worker` call
 * needs before it is safe to start. The estimate covers worker + validation
 * (scrutiny + code reviews + at least one user-testing shard) so that a
 * mission does not begin a worker it cannot afford to validate.
 *
 * This is deliberately a deterministic, conservative flat estimate — not a
 * mutable reservation — to avoid breaking BudgetManager idempotency.
 */
const WORKER_RUN_BUDGET_ESTIMATE = {
  estimatedAgentRuns: 4, // 1 worker + ~3 validation (scrutiny + reviews + ut shard)
  estimatedCostUsd: 5,
  estimatedTotalTokens: 500_000,
} as const;

type BudgetRemaining = {
  costUsd: number | null;
  totalTokens: number | null;
  agentRuns: number | null;
  wallClockMs: number | null;
};

/** Result of the pre-run budget estimate/refusal for `run_worker`. */
interface WorkerBudgetCheck {
  refuse: boolean;
  category?: "budget_exhausted" | "budget_risk";
  reason?: string;
  estimate: typeof WORKER_RUN_BUDGET_ESTIMATE;
  remaining: BudgetRemaining;
}

/**
 * Conservative pre-run budget estimate/refusal for `run_worker`.
 * Refuses to start when the remaining headroom cannot cover the worker +
 * validation estimate. Uses `budget_exhausted` when the budget is already
 * exhausted or a metric has no remaining headroom, otherwise `budget_risk`.
 * Never mutates budget state — idempotent.
 */
async function checkWorkerRunBudget(
  budget: import("./budget/budget-manager.js").BudgetManager,
): Promise<WorkerBudgetCheck> {
  const state = await budget.getState();
  const remaining = await budget.remaining();
  const estimate = WORKER_RUN_BUDGET_ESTIMATE;

  if (state.exhausted) {
    return {
      refuse: true,
      category: "budget_exhausted",
      reason: state.exhausted.reason,
      estimate,
      remaining,
    };
  }

  const checks: Array<{ metric: keyof BudgetRemaining; rem: number | null; need: number }> = [
    { metric: "agentRuns", rem: remaining.agentRuns, need: estimate.estimatedAgentRuns },
    { metric: "costUsd", rem: remaining.costUsd, need: estimate.estimatedCostUsd },
    { metric: "totalTokens", rem: remaining.totalTokens, need: estimate.estimatedTotalTokens },
  ];

  for (const { metric, rem, need } of checks) {
    if (rem !== null && rem < need) {
      return {
        refuse: true,
        category: rem <= 0 ? "budget_exhausted" : "budget_risk",
        reason: `Insufficient ${String(metric)} headroom for worker+validation estimate (need ${need}, have ${rem}).`,
        estimate,
        remaining,
      };
    }
  }

  return { refuse: false, estimate, remaining };
}

/** Map a preflight problem code to the failure surface category. */
function preflightFailureCategory(
  problems: { code: PreflightProblemCode }[],
): PreflightProblemCode {
  if (problems.some((p) => p.code === "adapter_auth_failure")) return "adapter_auth_failure";
  if (problems.some((p) => p.code === "missing_config")) return "missing_config";
  if (problems.some((p) => p.code === "unresolved_model")) return "unresolved_model";
  return "missing_config";
}

/** Build a structured authorization-refusal tool result. */
function authorizationRefusalResult(
  toolName: string,
  gate: ExecutionGateResult,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const approvalHint =
    gate.reason === "approval_pending" || gate.reason === "missing_approval"
      ? "Call wait_for_user_approval() (or return to the approval step) so the user can approve the plan before any execution tools run."
      : gate.reason === "approval_rejected"
        ? "The user rejected the plan. Revise the plan and re-request approval via wait_for_user_approval(); do not run execution tools until approval is granted."
        : gate.reason === "wrong_phase"
          ? "Return the mission to the approval/execution phase before running execution tools."
          : "Ensure durable mission state exists and the mission is approved before running execution tools.";
  const text = [
    `## ${toolName} refused: execution not authorized`,
    "",
    `**Reason:** ${gate.reason ?? "unknown"}`,
    gate.phase ? `**Current phase:** ${gate.phase}` : "**Current phase:** (no durable state)",
    gate.approvalStatus ? `**Approval status:** ${gate.approvalStatus}` : "**Approval status:** (no approval artifact)",
    "",
    gate.message,
    "",
    approvalHint,
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      refused: true,
      gate: "execution_authorization",
      reason: gate.reason,
      phase: gate.phase,
      approvalStatus: gate.approvalStatus,
      message: gate.message,
      instruction: approvalHint,
    },
  };
}

/** Build a structured preflight-failure tool result. No tokens consumed. */
function preflightRefusalResult(
  toolName: string,
  preflight: ModelPreflightResult,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const category = preflightFailureCategory(preflight.problems);
  const problemLines = preflight.problems.map(
    (p) => `- [${p.role}] ${p.code}: ${p.message}${p.model ? ` (model: ${p.model})` : ""}`,
  );
  const text = [
    `## ${toolName} refused: model/credential preflight failed`,
    "",
    `**Category:** ${category}`,
    `**No tokens consumed:** true (no worker/validator/user-testing agent was spawned)`,
    "",
    "Preflight problems:",
    ...problemLines,
    "",
    category === "adapter_auth_failure"
      ? "Configure API credentials for the configured provider(s) in ~/.pi/agent/auth.json or environment variables, then retry."
      : category === "unresolved_model"
        ? "The configured model slug could not be resolved in the registry. Use list_models to inspect available models and set_model to fix the configuration."
        : "No usable model is configured for one or more agent roles. Use set_model to configure a model with valid credentials.",
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      refused: true,
      gate: "model_preflight",
      preflightFailed: true,
      category,
      noTokensConsumed: true,
      preflight,
      instruction:
        category === "adapter_auth_failure"
          ? "Configure API credentials, then retry."
          : "Fix the model configuration, then retry.",
    },
  };
}

/** Build a structured budget-refusal tool result for `run_worker`. */
function budgetRefusalResult(
  toolName: string,
  check: WorkerBudgetCheck,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(n >= 100 ? 0 : 2));
  const text = [
    `## ${toolName} refused: insufficient budget headroom`,
    "",
    `**Category:** ${check.category}`,
    `**Reason:** ${check.reason ?? "Remaining budget cannot cover the worker+validation estimate."}`,
    "",
    "Conservative estimate (worker + validation):",
    `- Agent runs: ${check.estimate.estimatedAgentRuns}`,
    `- Cost (USD): ${check.estimate.estimatedCostUsd}`,
    `- Total tokens: ${check.estimate.estimatedTotalTokens}`,
    "",
    "Remaining headroom:",
    `- Agent runs: ${fmt(check.remaining.agentRuns)}`,
    `- Cost (USD): ${fmt(check.remaining.costUsd)}`,
    `- Total tokens: ${fmt(check.remaining.totalTokens)}`,
    "",
    "Would you like to continue anyway, increase the mission budget, or set a new project limit for the rest of this mission? " +
      "Use get_budget_status to inspect the full budget state, then ask the user how to proceed before retrying run_worker.",
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      refused: true,
      gate: "budget_estimate",
      category: check.category,
      reason: check.reason,
      estimate: check.estimate,
      remaining: check.remaining,
      instruction:
        "Ask the user whether to continue, increase the mission budget, or set a new project limit before retrying run_worker.",
    },
  };
}

/**
 * Auto-install mission-specific skills that are missing from the local .pi/skills/ directory.
 * Searches the skills.sh registry and installs the best match for each missing skill.
 * Used during Feature Decomposition before workers are spawned.
 */
export function ensureSkillsInstalledTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("ensure_skills_installed", { skillNames: params.skillNames });
      const startTime = Date.now();
      const result = await ensureSkillsInstalled(params.skillNames, context.scope.projectRoot);
      const durationMs = Date.now() - startTime;
      const installedCount = result.installed.filter((r) => r.success).length;
      const failedCount = result.installed.filter((r) => !r.success).length;
      context.logger.toolResult("ensure_skills_installed", { durationMs, installedCount, failedCount });

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
}

/**
 * Compute deterministic complexity metrics for a feature before spawning a worker.
 * The deterministic layer provides data only; the orchestrator (model) decides
 * whether to spawn or split. No hardcoded thresholds.
 */
export function getFeatureComplexityTool(context: MissionExecutionContext) {
  return defineTool({
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
      context.logger.toolCall("get_feature_complexity", { featureId: params.featureId });

      const features = await readFeatures(context.scope);
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

      const complexity = await computeFeatureComplexity(context.scope, feature);

      context.logger.toolResult("get_feature_complexity", {
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
}

/**
 * Durable wait for user approval.
 * Writes approval.json, marks the current job waiting_for_approval, and
 * instructs the orchestrator to end the current turn. After restart, the
 * approval submission will enqueue a continue_orchestrator job.
 */
export function waitForUserApprovalTool(context: MissionExecutionContext) {
  return defineTool({
    name: "wait_for_user_approval",
    label: "Wait for User Approval",
    description:
      "Pauses the current orchestrator turn and waits for the user to approve or reject the plan via the Observatory dashboard or API. " +
      "Writes approval.json and transitions the current job to waiting_for_approval. " +
      "The orchestrator MUST end its turn after calling this tool. " +
      "After the user submits approval, a continue_orchestrator job will be queued automatically.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params): Promise<{
      content: { type: "text"; text: string }[];
      details: { waiting: true; status: string };
    }> => {
      const port = 8765;
      const url = getCurrentDashboardUrl(context.scope.projectRoot) || `http://localhost:${port}`;

      console.log(`\n🛰️  Waiting for user plan approval on the dashboard...`);
      console.log(`   Please open: ${url}\n`);

      // 1. Write approval.json
      const missionDir = getMissionDir(context.scope);
      await mkdir(missionDir, { recursive: true });
      await writeFile(
        join(missionDir, "approval.json"),
        JSON.stringify(
          {
            status: "pending",
            missionId: context.scope.missionId,
            jobId: context.jobId,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );

      // 2. Mark job waiting for approval via jobControl
      if (context.jobControl) {
        await context.jobControl.markWaitingForApproval();
      }

      // 3. Return instruction to end turn
      return {
        content: [
          {
            type: "text",
            text: "Waiting for user approval. The orchestrator MUST end this turn now. After the user approves or rejects via the dashboard, a continue_orchestrator job will be queued automatically.",
          },
        ],
        details: {
          waiting: true,
          status: "waiting_for_approval",
        },
      };
    },
  });
}

/**
 * Mark a milestone as validated after scrutiny and user testing reports pass.
 * The orchestrator decides WHEN to request validation.
 * The gate verifies report existence, freshness, automated checks, and blocking issues.
 */
export function markMilestoneValidatedTool(context: MissionExecutionContext) {
  return defineTool({
    name: "mark_milestone_validated",
    label: "Mark Milestone Validated",
    description:
      "Mark a milestone as validated after verifying both scrutiny and user-testing reports pass all gates. " +
      "This transitions integrated features to validated and marks the milestone as completed. " +
      "Only validators can produce validated features.",
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to validate" }),
      scrutinyReportFilename: Type.String({ description: "Filename of the scrutiny report in validation-reports/" }),
      userTestingReportFilename: Type.String({ description: "Filename of the user-testing report in validation-reports/" }),
    }),
    execute: async (_toolCallId, params) => {
      context.logger.toolCall("mark_milestone_validated", {
        milestoneId: params.milestoneId,
        scrutinyReportFilename: params.scrutinyReportFilename,
        userTestingReportFilename: params.userTestingReportFilename,
      });

      const result = await evaluateMilestoneValidation(context.scope, {
        milestoneId: params.milestoneId,
        scrutinyReportFilename: params.scrutinyReportFilename,
        userTestingReportFilename: params.userTestingReportFilename,
      });

      if (!result.success) {
        context.logger.toolResult("mark_milestone_validated", { success: false, errors: result.errors });
        return {
          content: [{
            type: "text" as const,
            text: [
              `Milestone ${params.milestoneId} cannot be marked validated:`,
              "",
              ...result.errors.map((e) => `- ${e}`),
              "",
              "Address the issues and retry.",
            ].join("\n"),
          }],
          details: { success: false, errors: result.errors, milestoneId: undefined as string | undefined, featureIds: undefined as string[] | undefined },
        };
      }

      await applyMilestoneValidation(context.scope, result);

      context.logger.toolResult("mark_milestone_validated", {
        success: true,
        milestoneId: params.milestoneId,
        featureIds: result.featureIds,
      });
      return {
        content: [{
          type: "text" as const,
          text: `Milestone ${params.milestoneId} marked as validated. Features transitioned: ${result.featureIds.join(", ")}.`,
        }],
        details: { success: true, milestoneId: params.milestoneId, featureIds: result.featureIds, errors: [] as string[] },
      };
    },
  });
}

/**
 * Mark the entire mission as completed.
 * Verifies all features are validated and all milestones are completed.
 */
export function markMissionCompletedTool(context: MissionExecutionContext) {
  return defineTool({
    name: "mark_mission_completed",
    label: "Mark Mission Completed",
    description:
      "Mark the entire mission as completed after verifying all features are validated and all milestones are completed. " +
      "This is the ONLY way to transition mission phase to 'completed'.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params) => {
      context.logger.toolCall("mark_mission_completed", {});

      const result = await markMissionCompleted(context.scope);

      if (!result.success) {
        context.logger.toolResult("mark_mission_completed", { success: false, errors: result.errors });
        return {
          content: [{
            type: "text" as const,
            text: [
              `Mission cannot be marked completed:`,
              "",
              ...result.errors.map((e) => `- ${e}`),
            ].join("\n"),
          }],
          details: { success: false, errors: result.errors, phase: undefined as string | undefined },
        };
      }

      const currentState = await readState(context.scope);
      await writeState(context.scope, {
        ...(currentState ?? { version: 0 }),
        phase: "completed",
        version: (currentState?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });

      context.logger.toolResult("mark_mission_completed", { success: true, phase: "completed" });
      return {
        content: [{
          type: "text" as const,
          text: "Mission marked as completed.",
        }],
        details: { success: true, phase: "completed", errors: [] as string[] },
      };
    },
  });
}

/**
 * ask_user — service-mode bridge for structured user questions.
 *
 * The Pi extension `ask_user` (`.pi/extensions/ratel-ask.ts`) drives the TUI
 * (`ctx.ui.select`/`input`/`confirm`). In service mode there is no TUI, so the
 * built-in returns immediately with `cancelled: true` / `null` answers,
 * which causes intake loops. This custom tool overrides the extension tool
 * (customTools are registered after extension tools in the pi tool registry)
 * and bridges the gap:
 *
 * - Interactive / TUI mode (`ctx.hasUI`): replicates the extension's UI
 *   behaviour so dev mode is preserved.
 * - Service / headless mode (`!ctx.hasUI`): persists a durable pending
 *   question under the mission dir, emits a `pending_question` event (which
 *   counts as durable progress so the no-progress gate does not kill the
 *   turn), and returns a structured `{ status: "waiting_for_user", ... }`
 *   result instead of an empty/cancelled answer. The user's reply arrives
 *   asynchronously via `POST /api/v1/missions/:id/messages` (or the answer
 *   endpoint), which enqueues a `continue_orchestrator` job.
 *
 * Parameter shape is compatible with the Pi ask_user usage (`questions`
 * array with `id`/`type`/`question`/`options`/etc.) and also tolerates
 * simpler shapes (a bare `question` string, or a single `{question, options}`
 * object without an enclosing array).
 */
export function askUserTool(context: MissionExecutionContext) {
  return defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present structured questions to the user and collect answers. " +
      "Supports select (single choice), multi_select (multiple choices), " +
      "text (free input), and confirm (yes/no) question types. " +
      "In service mode, persists the question for asynchronous user reply " +
      "via the Ratel API and returns a waiting_for_user status.",
    promptSnippet: "Ask the user structured questions and collect answers",
    promptGuidelines: [
      "Use ask_user when you need the user's input on a decision, choice, or requirement.",
      "Ask questions one at a time or in small groups (2-5 questions max).",
      "For select questions, always include a sensible default option if one exists.",
      "For confirm questions, frame the question so 'yes' means proceed and 'no' means stop.",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Unique identifier for this question" }),
          question: Type.String({ description: "The question text to display to the user" }),
          type: Type.Union([
            Type.Literal("select"),
            Type.Literal("multi_select"),
            Type.Literal("text"),
            Type.Literal("confirm"),
          ], { description: "Question type" }),
          options: Type.Optional(
            Type.Array(Type.String(), {
              description: "Options for select/multi_select.",
            }),
          ),
          placeholder: Type.Optional(Type.String()),
          required: Type.Optional(Type.Boolean({ default: true })),
        }),
        { description: "Questions to ask the user" },
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> => {
      const questions = normalizeAskUserParams(params);
      context.logger.toolCall("ask_user", {
        questionCount: questions.length,
        serviceMode: !(ctx as { hasUI?: boolean } | undefined)?.hasUI,
      });

      const hasUI = (ctx as { hasUI?: boolean } | undefined)?.hasUI === true;

      // ── Interactive / TUI mode: replicate the extension's UI behaviour ──
      if (hasUI && ctx?.ui) {
        const result = await runInteractiveAskUser(questions, ctx as {
          ui: {
            select: (q: string, opts: string[], o?: { signal?: AbortSignal }) => Promise<string | undefined>;
            input: (q: string, placeholder?: string, o?: { signal?: AbortSignal }) => Promise<string | undefined>;
            confirm: (q: string, _placeholder?: string, o?: { signal?: AbortSignal }) => Promise<boolean>;
            setStatus: (key: string, value: string | undefined) => void;
          };
        }, signal);
        context.logger.toolResult("ask_user", { mode: "interactive", answered: result.answers.length });
        return {
          content: [{ type: "text", text: JSON.stringify({ answers: result.answers }, null, 2) }],
          details: { answers: result.answers, mode: "interactive" },
        };
      }

      // ── Service / headless mode: persist + emit + return waiting status ──
      const questionId = `q_${randomUUID()}`;
      const missionDir = getMissionDir(context.scope);
      await mkdir(missionDir, { recursive: true });

      const now = new Date().toISOString();
      const previewQuestion = questions[0]?.question ?? "";
      const previewOptions = (questions[0]?.options ?? []).slice(0, 8);
      const previewType = questions[0]?.type ?? "text";

      const pendingRecord = {
        questionId,
        missionId: context.scope.missionId,
        jobId: context.jobId,
        questions,
        status: "pending",
        createdAt: now,
      };

      // Durable representation: pending-question.json (latest) + questions.jsonl (append-only)
      await writeFile(
        join(missionDir, "pending-question.json"),
        JSON.stringify(pendingRecord, null, 2),
        "utf-8",
      );
      await appendFile(
        join(missionDir, "questions.jsonl"),
        JSON.stringify(pendingRecord) + "\n",
        "utf-8",
      );

      // Durable event so ratel_poll_status can stop and the no-progress gate passes.
      context.logger.pendingQuestion({
        questionId,
        missionId: context.scope.missionId,
        jobId: context.jobId,
        question: truncateForPreview(previewQuestion, 300),
        options: previewOptions,
        questionType: previewType,
        status: "waiting_for_user",
      });

      // Optional short wait for a synchronous answer file. Default 0s (do not
      // hold service worker jobs). The answer normally arrives via an
      // enqueued continue_orchestrator job, not by blocking this call.
      const waitMs = resolveAskUserWaitMs();
      if (waitMs > 0) {
        const answered = await waitForAnswerFile(missionDir, questionId, waitMs, signal);
        if (answered) {
          context.logger.toolResult("ask_user", { mode: "service", answered: true, questionId });
          return {
            content: [{ type: "text", text: JSON.stringify({ answers: answered.answers, questionId }, null, 2) }],
            details: { answers: answered.answers, questionId, mode: "service", status: "answered" },
          };
        }
      }

      context.logger.toolResult("ask_user", { mode: "service", answered: false, questionId });
      const waitingResult = {
        status: "waiting_for_user",
        questionId,
        missionId: context.scope.missionId,
        question: previewQuestion,
        options: previewOptions,
        questionType: previewType,
        questions,
        instruction:
          "No synchronous answer is available in service mode. The user's reply will arrive via POST /api/v1/missions/" +
          context.scope.missionId +
          "/messages (or the answer endpoint), which enqueues a continue_orchestrator job. End this turn; do NOT loop.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(waitingResult, null, 2) }],
        details: { ...waitingResult, mode: "service" },
      };
    },
  });
}

/** Normalize ask_user params into a canonical questions array, tolerating simpler shapes. */
function normalizeAskUserParams(params: Record<string, unknown>): Array<{
  id: string;
  question: string;
  type: "select" | "multi_select" | "text" | "confirm";
  options?: string[];
  placeholder?: string;
  required?: boolean;
}> {
  const raw = params as {
    questions?: unknown;
    question?: unknown;
    options?: unknown;
    type?: unknown;
    id?: unknown;
    placeholder?: unknown;
    required?: unknown;
  };

  let rawQuestions: unknown[] | undefined;
  if (Array.isArray(raw.questions)) {
    rawQuestions = raw.questions;
  } else if (typeof raw.question === "string" || (raw.question && typeof raw.question === "object")) {
    // Bare single question shape: { question, options, type }
    rawQuestions = [raw];
  } else if (Array.isArray(raw.options)) {
    // { options: [...] } with no question text
    rawQuestions = [raw];
  }

  const list = rawQuestions ?? [];
  const normalized = list.map((entry, idx): {
    id: string;
    question: string;
    type: "select" | "multi_select" | "text" | "confirm";
    options?: string[];
    placeholder?: string;
    required?: boolean;
  } => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const type = normalizeQuestionType(e.type);
    const options = Array.isArray(e.options) ? e.options.filter((o): o is string => typeof o === "string") : undefined;
    const question = typeof e.question === "string" ? e.question : typeof e === "string" ? e : "";
    return {
      id: typeof e.id === "string" ? e.id : `q_${idx}`,
      question,
      type,
      options,
      placeholder: typeof e.placeholder === "string" ? e.placeholder : undefined,
      required: typeof e.required === "boolean" ? e.required : true,
    };
  });

  return normalized.length > 0
    ? normalized
    : [{ id: "q_0", question: "", type: "text" }];
}

function normalizeQuestionType(t: unknown): "select" | "multi_select" | "text" | "confirm" {
  if (t === "select" || t === "multi_select" || t === "text" || t === "confirm") return t;
  return "text";
}

function truncateForPreview(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/** Resolve the optional service-mode ask_user synchronous wait window (0-2000ms). */
function resolveAskUserWaitMs(): number {
  const raw = process.env.RATEL_ASK_USER_WAIT_MS;
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(2000, Math.round(n));
}

/**
 * Best-effort short wait for an answer file written by the answer endpoint.
 * Returns parsed answers if the file appears within waitMs, else undefined.
 */
async function waitForAnswerFile(
  missionDir: string,
  questionId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<{ answers: unknown } | undefined> {
  const path = join(missionDir, "pending-question.json");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return undefined;
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { questionId?: string; status?: string; answer?: unknown; answers?: unknown };
      if (parsed.questionId === questionId && parsed.status === "answered") {
        const answers = parsed.answers ?? (parsed.answer !== undefined ? [{ id: questionId, answer: parsed.answer }] : undefined);
        return { answers: answers ?? [] };
      }
    } catch {
      // file missing or invalid — keep waiting
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** Replicate the ratel-ask extension's interactive UI flow for dev/TUI mode. */
async function runInteractiveAskUser(
  questions: Array<{ id: string; question: string; type: string; options?: string[]; placeholder?: string; required?: boolean }>,
  ctx: {
    ui: {
      select: (q: string, opts: string[], o?: { signal?: AbortSignal }) => Promise<string | undefined>;
      input: (q: string, placeholder?: string, o?: { signal?: AbortSignal }) => Promise<string | undefined>;
      confirm: (q: string, _placeholder?: string, o?: { signal?: AbortSignal }) => Promise<boolean>;
      setStatus: (key: string, value: string | undefined) => void;
    };
  },
  signal?: AbortSignal,
): Promise<{ answers: Array<{ id: string; question: string; answer: string | string[] | null; cancelled?: boolean }> }> {
  const FREE_TEXT_OPTION = "(Type your own answer)";
  const SKIP_OPTION = "";
  const DONE_OPTION = "Done";
  const answers: Array<{ id: string; question: string; answer: string | string[] | null; cancelled?: boolean }> = [];
  const total = questions.length;

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    ctx.ui.setStatus("ratel-ask", `Question ${i + 1} of ${total}: ${q.question}`);
    let answer: string | string[] | null = null;
    let cancelled = false;
    let skip = false;

    try {
      switch (q.type) {
        case "select": {
          const opts = [...(q.options ?? []), SKIP_OPTION, FREE_TEXT_OPTION];
          const result = await ctx.ui.select(q.question, opts, { signal });
          if (result === undefined) cancelled = true;
          else if (result === SKIP_OPTION) skip = true;
          else if (result === FREE_TEXT_OPTION) {
            const custom = await ctx.ui.input(q.question, "Your answer", { signal });
            if (custom === undefined) cancelled = true;
            else answer = custom;
          } else answer = result;
          break;
        }
        case "multi_select": {
          const selected: string[] = [];
          const remaining = [...(q.options ?? [])];
          while (remaining.length > 0) {
            const header = selected.length === 0 ? "none" : selected.join(", ");
            const opts = [...remaining, SKIP_OPTION, DONE_OPTION];
            const result = await ctx.ui.select(`${q.question}\nSelected: ${header}`, opts, { signal });
            if (result === undefined || result === DONE_OPTION) break;
            if (result === SKIP_OPTION) continue;
            selected.push(result);
            const idx = remaining.indexOf(result);
            if (idx >= 0) remaining.splice(idx, 1);
          }
          answer = selected.length > 0 ? selected : null;
          break;
        }
        case "text": {
          const result = await ctx.ui.input(q.question, q.placeholder ?? "", { signal });
          if (result === undefined) cancelled = true;
          else answer = result;
          break;
        }
        case "confirm": {
          const result = await ctx.ui.confirm(q.question, "", { signal });
          answer = result ? "yes" : "no";
          break;
        }
      }
    } catch {
      cancelled = true;
    }

    if (skip) continue;
    answers.push({ id: q.id, question: q.question, answer, cancelled });
    if (cancelled && (q.required ?? true)) break;
  }

  ctx.ui.setStatus("ratel-ask", undefined);
  return { answers };
}

/** Create orchestrator custom tools from a mission execution context. */
export function createOrchestratorTools(context: MissionExecutionContext) {
  return [
    runResearchTool(context),
    askSmartFriendTool(context),
    draftValidationContractTool(context),
    writeMissionArtifactTool(context),
    markFeatureIntegratedTool(context),
    markMilestoneValidatedTool(context),
    markMissionCompletedTool(context),
    loadMissionStateTool(context),
    haltMissionTool(context),
    logDecisionTool(context),
    runValidationTool(context),
    runWorkerTool(context),
    runUserTestingTool(context),
    setModelTool(context),
    listModelsTool(context),
    pingAgentsTool(context),
    getBudgetStatusTool(context),
    ensureSkillsInstalledTool(context),
    getFeatureComplexityTool(context),
    waitForUserApprovalTool(context),
    // ask_user is registered last so it overrides the pi extension's
    // `.pi/extensions/ratel-ask.ts` tool of the same name (customTools are
    // applied after extension-registered tools in the pi tool registry).
    askUserTool(context),
  ];
}

/** Deprecated backward-compatibility exports for pi-sdk. */
export const ORCHESTRATOR_TOOLS: any[] = [];
export function setToolCwd(_cwd: string): void {
  // No-op: tools now receive cwd via MissionExecutionContext
}
