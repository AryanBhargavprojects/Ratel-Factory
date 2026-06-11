/**
 * Ratel Pi Extension — Tool Scope / Phase Management
 *
 * Manages phase-based tool access control:
 *   idle      → full tool access
 *   planning  → restricted to read, write (markdown only), ratel_start_mission
 *   executing → full tool access + ratel_run_worker
 *   validating→ full tool access + ratel_run_validator
 */

export type Phase = "idle" | "planning" | "executing" | "validating";

const PLANNING_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "ratel_start_mission",
  "ratel_run_worker",
  "ratel_run_validator",
]);

const EXECUTING_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "ratel_start_mission",
  "ratel_run_worker",
  "ratel_run_validator",
]);

const VALIDATING_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "ratel_start_mission",
  "ratel_run_worker",
  "ratel_run_validator",
]);

export function getToolsForPhase(activeTools: string[], phase: Phase): string[] {
  if (phase === "idle") {
    return activeTools;
  }

  const allowed = phase === "planning"
    ? PLANNING_TOOLS
    : phase === "executing"
      ? EXECUTING_TOOLS
      : VALIDATING_TOOLS;

  return activeTools.filter((t) => allowed.has(t));
}

export function isPhaseTransitionAllowed(from: Phase, to: Phase): boolean {
  const transitions: Record<Phase, Phase[]> = {
    idle: ["planning", "executing", "validating"],
    planning: ["idle", "executing", "validating"],
    executing: ["idle", "planning", "validating"],
    validating: ["idle", "planning", "executing"],
  };
  return transitions[from].includes(to);
}
