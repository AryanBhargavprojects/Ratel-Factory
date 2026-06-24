/**
 * Ratel Factory — Native Pi Coding Agent extension entry point.
 *
 * Default-exports the extension factory so Pi can load it via the `pi`
 * manifest (`pi.extensions = ["./dist/index.js"]`). The extension runs the
 * Ratel orchestrator in-process — no separate daemon, no out-of-band process.
 */
export { default } from "./extension.js";
export { default as RatelExtension } from "./extension.js";
export { RatelRuntime } from "./runtime.js";
export type {
  RuntimeOptions,
  StartMissionResult,
  StatusSummary,
  PollOptions,
  MissionStatus,
  PingAgentsResult,
  ObservatoryInfo,
  OrchestratorFactory,
} from "./runtime.js";
export { readMissionEvents, type RatelEvent, type MissionEventsSlice } from "./events.js";
export {
  clampTiming,
  detectStopCondition,
  formatPollResponse,
  parseStopWhen,
  type StopWhen,
  type PendingQuestion,
  type StopDetectionResult,
  type PollResponseInput,
} from "./polling.js";
export { resolveProjectRoot } from "./resolve-project-root.js";
export { getFactoryModePrompt, getMissionStartPrompt } from "./prompts.js";
