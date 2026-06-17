/**
 * Shared agent-ping logic used by both the ping_agents orchestrator tool
 * and the HTTP API endpoint (POST /api/v1/ping/agents).
 *
 * Spawns a trivial task in each of the six subagent roles and reports
 * per-agent status. Each ping has a configurable timeout (default 20s).
 *
 * IMPORTANT: This module spawns lightweight Pi AgentSessions — it is NOT
 * a dry-run or config-only check. Each ping actually calls the configured
 * LLM provider. The HTTP endpoint that calls this function will block for
 * up to ~20 s while all six pings complete in parallel.
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModelConfig, resolveModel } from "./config.js";
import { DEFAULT_ORCHESTRATOR_SKILLS_DIR, loadSkillsFromDir } from "./utils/skills.js";

// ── Public types ──────────────────────────────────────────────────────────

export interface AgentPingResult {
  role: string;
  status: "ok" | "failed" | "timeout";
  timeMs: number;
  error?: string;
}

export interface PingAgentsResponse {
  ok: boolean;
  totalAgents: number;
  okCount: number;
  failedCount: number;
  totalTimeMs: number;
  agents: AgentPingResult[];
}

// ── Internal types ────────────────────────────────────────────────────────

interface PingRole {
  name: string;
  model: string | null;
  skillNames: string[];
  tools: string[];
  expectedText: string;
}

interface RawPingResult {
  status: "ok" | "failed" | "timeout";
  durationMs: number;
  response?: string;
  error?: string;
}

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Ping all six subagent roles in parallel.
 *
 * Each role receives a minimal system prompt asking it to reply with a
 * single fixed string.  The function returns as soon as every ping has
 * either completed or timed out (the per-agent timeout is configurable;
 * the overall wall-clock time is bounded by the slowest agent).
 *
 * @param projectRoot  Absolute path to the project directory (used to read
 *                     ratel.json for model config and skills).
 * @param timeoutMs    Per-agent timeout in milliseconds. Default 20000.
 */
export async function pingAllAgents(
  projectRoot: string,
  timeoutMs: number = 20000,
): Promise<PingAgentsResponse> {
  const startTime = Date.now();

  const modelConfig = await getModelConfig(projectRoot);
  const allSkills = await loadSkillsFromDir(projectRoot, DEFAULT_ORCHESTRATOR_SKILLS_DIR);

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

  async function runLightweightPing(role: PingRole): Promise<RawPingResult> {
    const pingStart = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
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
            cwd: projectRoot,
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
            cwd: projectRoot,
            authStorage,
            modelRegistry,
            settingsManager,
            resourceLoader,
            sessionManager: SessionManager.inMemory(projectRoot),
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

  // Launch all pings in parallel.
  const results = await Promise.allSettled(roles.map((role) => runLightweightPing(role)));

  const agentNames = ["research", "smart_friend", "contract_writer", "worker", "scrutiny_validator", "user_testing_validator"];
  const pingResults: Record<string, RawPingResult> = {};
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

  const totalTimeMs = Date.now() - startTime;

  return {
    ok: failedCount === 0,
    totalAgents: agentNames.length,
    okCount,
    failedCount,
    totalTimeMs,
    agents: agentNames.map((name) => ({
      role: name,
      status: pingResults[name].status,
      timeMs: pingResults[name].durationMs,
      error: pingResults[name].error,
    })),
  };
}
