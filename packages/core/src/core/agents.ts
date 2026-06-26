/**
 * Helper agent spawners.
 * Each helper is a fresh Pi AgentSession with a narrow toolset and role-specific prompt.
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  getAgentDir,
  defineTool,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  RESEARCH_AGENT_PROMPT,
  SMART_FRIEND_PROMPT,
  CONTRACT_AGENT_PROMPT,
} from "./prompts.js";
import {
  DEFAULT_ORCHESTRATOR_SKILLS_DIR,
  loadSkillsFromDir,
} from "./utils/skills.js";
import { resolveModel } from "./config.js";
import type { EventLogger } from "./observability/event-logger.js";
import { observeAgentSession } from "./observability/session-events.js";
import { writeFeatureFile } from "./artifacts.js";
import type { MissionScope } from "./mission/scope.js";
import type { MissionExecutionContext } from "./mission/execution-context.js";
import { runSessionWithFailover, collectResponse, createAgentSessionForModel } from "./models/session-runner.js";
import type { AgentRole } from "./models/model-router.js";

/** Common skill filter: replace auto-discovered skills with only the role-specific set. */
function isolateSkills(
  allSkills: Awaited<ReturnType<typeof loadSkillsFromDir>>,
  names: Set<string>,
) {
  return allSkills.filter((s) => names.has(s.name));
}

/**
 * Inline custom tools for the contract agent. Defined here (not in tools.ts)
 * to avoid a circular import: tools.ts depends on agents.ts for spawnContractAgent,
 * and agents.ts would otherwise depend on tools.ts for writeMissionArtifactTool.
 * Both tools wrap the underlying writeArtifact / writeFeatureFile functions and
 * give the contract agent a way to persist its output.
 *
 * IMPORTANT: these MUST use defineTool() with TypeBox schemas (Type.Object) —
 * NOT plain { type: "object", properties: {...} } objects. The Pi SDK's
 * createAgentSession expects ToolDefinition[] with TSchema parameters. Plain
 * JSON Schema objects are silently rejected by the tool registry, which means
 * the model receives a prompt instructing it to call tools that don't exist.
 * The model then produces empty output because it cannot fulfill the instruction.
 */
function buildContractAgentCustomTools(scope: MissionScope, logger: EventLogger | undefined) {
  type WriteFeatureDetails = { error?: string };
  type SubmitContractDetails = { error?: string; errors?: string[]; id?: string; filename?: string; assertionId?: string; featureFile?: string; scenario?: string; version?: number; assertionCount?: number };

  return [
    defineTool({
      name: "write_feature_file",
      label: "Write Feature File",
      description:
        "Write a Gherkin .feature file under .ratel/missions/<missionId>/features/. " +
        "Used by the Contract Agent to write validation contract scenarios. " +
        "The filename MUST end with .feature.",
      parameters: Type.Object({
        filename: Type.String({ description: "Feature file name, e.g. 'auth.feature'" }),
        content: Type.String({ description: "Full Gherkin content" }),
      }),
      execute: async (_id: string, params: { filename: string; content: string }): Promise<{ content: { type: "text"; text: string }[]; details: WriteFeatureDetails }> => {
        if (!params.filename.endsWith(".feature")) {
          return { content: [{ type: "text", text: `ERROR: filename must end with .feature` }], details: { error: "invalid_filename" } };
        }
        if (!params.content || params.content.trim().length === 0) {
          return { content: [{ type: "text", text: `ERROR: content is empty` }], details: { error: "empty_content" } };
        }
        await writeFeatureFile(scope, params.filename, params.content);
        logger?.artifactWrite(`features/${params.filename}`, "overwrite", Buffer.byteLength(params.content, "utf-8"));
        return { content: [{ type: "text", text: `Wrote .ratel/missions/${scope.missionId}/features/${params.filename} (${Buffer.byteLength(params.content, "utf-8")} bytes).` }], details: {} };
      },
    }),
    defineTool({
      name: "submit_validation_contract",
      label: "Submit Validation Contract",
      description:
        "Submit a structured ValidationContract object after all .feature files are written. " +
        "The tool validates the contract with TypeBox, indexes every written feature file, " +
        "verifies every assertion's feature and scenario reference, rejects duplicate assertion IDs, " +
        "and atomically writes validation-contract.json and validation-contract.md. " +
        "Do NOT call this until you have written at least one valid .feature file.",
      parameters: Type.Object({
        contract: Type.Object({
          version: Type.Number(),
          createdAt: Type.String(),
          assertions: Type.Array(
            Type.Object({
              id: Type.String(),
              title: Type.String(),
              description: Type.String(),
              featureFile: Type.String(),
              scenario: Type.String(),
              evidenceType: Type.Union([
                Type.Literal("screenshot"),
                Type.Literal("test"),
                Type.Literal("log"),
                Type.Literal("manual"),
              ]),
              requirementRefs: Type.Array(Type.String()),
              successCriteria: Type.String(),
              preconditions: Type.Optional(Type.Array(Type.String())),
            }),
          ),
          gaps: Type.Array(Type.String()),
          crossCuttingAssertions: Type.Array(Type.String()),
        }),
      }),
      execute: async (_id: string, params: { contract: unknown }): Promise<{ content: { type: "text"; text: string }[]; details: SubmitContractDetails }> => {
        const { validateSchema } = await import("./schema/report-schemas.js");
        const { ValidationContractSchema } = await import("./schema/report-schemas.js");
        const { indexGherkinFeature } = await import("./mission/gherkin-index.js");
        const { writeValidationContract, listFeatureFiles, readFeatureFile } = await import("./artifacts.js");

        const validation = validateSchema(ValidationContractSchema, params.contract);
        if (!validation.valid) {
          return {
            content: [{ type: "text", text: `ERROR: Invalid contract.\n${validation.errors.join("\n")}` }],
            details: { error: "invalid_contract", errors: validation.errors },
          };
        }

        const contract = params.contract as import("./types.js").ValidationContract;

        // Reject duplicate assertion IDs
        const ids = new Set<string>();
        for (const a of contract.assertions) {
          if (ids.has(a.id)) {
            return {
              content: [{ type: "text", text: `ERROR: Duplicate assertion ID "${a.id}"` }],
              details: { error: "duplicate_assertion_id", id: a.id },
            };
          }
          ids.add(a.id);
        }

        // Index all feature files and verify references
        const featureFiles = await listFeatureFiles(scope);
        if (featureFiles.length === 0) {
          return {
            content: [{ type: "text", text: `ERROR: No .feature files found. Write at least one feature file before submitting the contract.` }],
            details: { error: "no_feature_files" },
          };
        }

        const scenarioMap = new Map<string, Set<string>>();
        for (const f of featureFiles) {
          const content = await readFeatureFile(scope, f);
          if (!content) continue;
          try {
            const index = indexGherkinFeature(f, content);
            const set = new Set(index.scenarios.map((s) => s.name));
            scenarioMap.set(f, set);
          } catch (err) {
            return {
              content: [{ type: "text", text: `ERROR: Failed to index ${f}: ${err instanceof Error ? err.message : String(err)}` }],
              details: { error: "index_failed", filename: f },
            };
          }
        }

        for (const a of contract.assertions) {
          const scenarios = scenarioMap.get(a.featureFile);
          if (!scenarios) {
            return {
              content: [{ type: "text", text: `ERROR: Assertion "${a.id}" references missing feature file "${a.featureFile}"` }],
              details: { error: "missing_feature_file", assertionId: a.id, featureFile: a.featureFile },
            };
          }
          if (!scenarios.has(a.scenario)) {
            return {
              content: [{ type: "text", text: `ERROR: Assertion "${a.id}" references missing scenario "${a.scenario}" in "${a.featureFile}"` }],
              details: { error: "missing_scenario", assertionId: a.id, featureFile: a.featureFile, scenario: a.scenario },
            };
          }
        }

        await writeValidationContract(scope, contract);
        logger?.artifactWrite("validation-contract.json", "overwrite", Buffer.byteLength(JSON.stringify(contract), "utf-8"));
        return {
          content: [{ type: "text", text: `Submitted validation contract v${contract.version} with ${contract.assertions.length} assertions.` }],
          details: { version: contract.version, assertionCount: contract.assertions.length },
        };
      },
    }),
  ];
}

/**
 * Spawn a fresh read-only Research Agent.
 * Routes through runSessionWithFailover for automatic model failover.
 */
export async function spawnResearchAgent(
  query: string,
  searchScope: string,
  context: MissionExecutionContext,
): Promise<string> {
  const projectRoot = context.scope.projectRoot;
  const startTime = Date.now();

  const allSkills = await loadSkillsFromDir(projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const researchSkillNames = new Set([
    "parallel-web-search",
    "parallel-deep-research",
    "find-docs",
  ]);
  const researchSkills = isolateSkills(allSkills, researchSkillNames);

  const prompt = `Research query: ${query}\nScope: ${searchScope}\nWorking directory: ${projectRoot}\n\nReturn structured findings in the exact format specified in your system prompt. Use /skill:parallel-web-search for web research when relevant.`;

  return runSessionWithFailover({
    context,
    role: "orchestrator",
    attempt: async (model) => {
      const { session, dispose } = await createAgentSessionForModel({
        cwd: projectRoot,
        modelString: model.modelString,
        systemPrompt: RESEARCH_AGENT_PROMPT,
        tools: ["read", "grep", "find", "ls", "bash"],
        skills: researchSkills,
      });

      const agentSpanId = context.logger.agentSpanStart("research", {
        agentType: "research",
        model: model.modelString,
        skills: researchSkills.map((s) => s.name),
        tools: ["read", "grep", "find", "ls", "bash"],
      });

      const unobserve = observeAgentSession(session, {
        logger: context.logger,
        agentLevel: "research",
        parentSpanId: agentSpanId,
      });

      try {
        const response = await collectResponse(session, prompt);
        const durationMs = Date.now() - startTime;
        if (agentSpanId) context.logger.agentSpanEnd("research", agentSpanId, { durationMs });
        return response;
      } finally {
        unobserve();
        dispose();
      }
    },
  });
}

/**
 * Spawn a skeptical Smart Friend agent.
 * Routes through runSessionWithFailover for automatic model failover.
 */
export async function spawnSmartFriendAgent(
  missionStateSummary: string,
  question: string,
  context: MissionExecutionContext,
): Promise<string> {
  const projectRoot = context.scope.projectRoot;
  const startTime = Date.now();

  const allSkills = await loadSkillsFromDir(projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const smartFriendSkillNames = new Set([
    "software-design-philosophy",
    "architecture-blueprint-generator",
    "grill-with-docs",
    "parallel-web-search",
    "find-docs",
    "deep-research",
    "web-design-guidelines",
    "ui-ux-pro-max",
  ]);
  const smartFriendSkills = isolateSkills(allSkills, smartFriendSkillNames);

  const prompt = `## Full Mission State\n${missionStateSummary}\n\n---\n\n## Specific Question from Orchestrator\n${question}\n\n---\n\n## Working Directory\nYou are operating in: ${projectRoot}\n\nRemember: you are an OVER-SCOPED reviewer. Look at the ENTIRE trajectory and mission state above. Do not just answer the question — critique what the orchestrator may have missed, overlooked, or failed to investigate. If you need to explore the codebase to verify an assumption, use read, grep, find, or ls.\n\nReturn structured critique in the exact format specified in your system prompt.`;

  return runSessionWithFailover({
    context,
    role: "orchestrator",
    attempt: async (model) => {
      const { session, dispose } = await createAgentSessionForModel({
        cwd: projectRoot,
        modelString: model.modelString,
        systemPrompt: SMART_FRIEND_PROMPT,
        tools: ["read", "grep", "find", "ls"],
        skills: smartFriendSkills,
      });

      const agentSpanId = context.logger.agentSpanStart("smart_friend", {
        agentType: "smart_friend",
        model: model.modelString,
        skills: smartFriendSkills.map((s) => s.name),
        tools: ["read", "grep", "find", "ls"],
      });

      const unobserve = observeAgentSession(session, {
        logger: context.logger,
        agentLevel: "smart_friend",
        parentSpanId: agentSpanId,
      });

      try {
        const response = await collectResponse(session, prompt);
        const durationMs = Date.now() - startTime;
        if (agentSpanId) context.logger.agentSpanEnd("smart_friend", agentSpanId, { durationMs });
        return response;
      } finally {
        unobserve();
        dispose();
      }
    },
  });
}

/**
 * Spawn a Validation Contract Writer agent.
 * Routes through runSessionWithFailover for automatic model failover.
 */
export async function spawnContractAgent(
  requirements: string,
  constraints: string,
  researchNotes: string,
  decisionLog: string,
  context: MissionExecutionContext,
): Promise<string> {
  const scope = context.scope;
  const startTime = Date.now();

  const allSkills = await loadSkillsFromDir(scope.projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const contractSkillNames = new Set([
    "parallel-web-search",
    "find-docs",
    "software-design-philosophy",
    "ui-ux-pro-max",
    "slc-product-thinking",
    "html-as-output",
    "gherkin-contract",
    "cucumber-gherkin",
  ]);
  const contractSkills = isolateSkills(allSkills, contractSkillNames);

  const prompt = `## Requirements\n${requirements}\n\n---\n\n## Constraints\n${constraints}\n\n---\n\n## Research Notes\n${researchNotes}\n\n---\n\n## Decision Log\n${decisionLog || "(No decisions recorded yet.)"}\n\n---\n\n## Working Directory\nYou are operating in: ${scope.projectRoot}\n\nWrite a validation contract in the exact format specified in your system prompt.\n\nBEFORE writing:\n1. Explore the codebase (read, grep, find, ls) to understand existing test patterns and conventions.\n2. Use /skill:parallel-web-search to research domain-specific validation patterns if needed.\n3. Ensure every requirement has at least one assertion. Flag any gaps explicitly.\n\nWHEN writing the contract artifacts, use these tools in this exact sequence:\n1. Use \`write_feature_file\` for each .feature file (e.g., write_feature_file({filename: 'auth.feature', content: '...'})). The filename MUST end with .feature.\n2. After ALL feature files are written, call \`submit_validation_contract\` with the structured contract object. The tool validates, indexes feature files, and writes both validation-contract.json and validation-contract.md atomically.\n\nDo NOT use bash to write files. Do NOT call \`write_mission_artifact\` for validation-contract.md. The submission tool writes it deterministically. Write ALL feature files first, then submit. Partial output will be rejected.\n\nAfter submitting the contract, write a brief summary of what you produced.\n\nRemember: you do NOT know the feature plan. Write assertions based purely on requirements, constraints, research, and decisions.`;

  return runSessionWithFailover({
    context,
    role: "orchestrator",
    attempt: async (model) => {
      const { session, dispose } = await createAgentSessionForModel({
        cwd: scope.projectRoot,
        modelString: model.modelString,
        systemPrompt: CONTRACT_AGENT_PROMPT,
        // No bash: the contract writer MUST use write_feature_file and
        // submit_validation_contract to persist artifacts. Giving it bash
        // lets it write files directly, bypassing schema validation and
        // producing a tool-only completion with no assistant text — which
        // collectResponse() then misclassifies as empty_output.
        //
        // NOTE: The Pi SDK's `tools` array is an allowlist. Custom tools
        // passed via `customTools` are filtered out by _refreshToolRegistry()
        // unless their names also appear in `tools`. So write_feature_file
        // and submit_validation_contract MUST be listed here, otherwise the
        // model sees a prompt instructing it to call tools that don't exist.
        tools: ["read", "grep", "find", "ls", "write_feature_file", "submit_validation_contract"],
        customTools: buildContractAgentCustomTools(scope, context.logger),
        skills: contractSkills,
      });

      const agentSpanId = context.logger.agentSpanStart("contract_writer", {
        agentType: "contract_writer",
        model: model.modelString,
        skills: contractSkills.map((s) => s.name),
        tools: ["read", "grep", "find", "ls", "write_feature_file", "submit_validation_contract"],
      });

      const unobserve = observeAgentSession(session, {
        logger: context.logger,
        agentLevel: "contract_writer",
        parentSpanId: agentSpanId,
      });

      try {
        const response = await collectResponse(session, prompt);
        const durationMs = Date.now() - startTime;
        if (agentSpanId) context.logger.agentSpanEnd("contract_writer", agentSpanId, { durationMs });
        return response;
      } finally {
        unobserve();
        dispose();
      }
    },
  });
}
