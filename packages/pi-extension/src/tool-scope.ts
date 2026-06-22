/**
 * Ratel Pi Extension — Tool Scope
 *
 * The in-process orchestrator (via {@link RatelRuntime}) owns lifecycle/phase
 * state under `.ratel/missions/<missionId>/`. The extension does not maintain
 * a local phase copy. This module is retained as a placeholder for any future
 * tool-gating helpers. It currently exports nothing.
 */

// No local phase state. Use runtime status and mission state for gating.
export {};
