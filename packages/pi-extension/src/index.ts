/**
 * Ratel Factory — Native Pi Coding Agent extension entry point.
 *
 * Default-exports the extension factory so Pi can load it via the `pi`
 * manifest (`pi.extensions = ["./dist/index.js"]`).
 */
export { default } from "./extension.js";
export { default as RatelExtension } from "./extension.js";
export { RatelServiceClient, RatelServiceError } from "./service.js";
export {
  clampTiming,
  detectStopCondition,
  formatPollResponse,
  parseStopWhen,
  type StopWhen,
} from "./polling.js";
export {
  ensureRatelService,
  readServicePortfile,
  cleanupSpawnedService,
  type ServicePortfile,
} from "./service-lifecycle.js";
export { resolveProjectRoot } from "./resolve-project-root.js";
export { getFactoryModePrompt, getMissionStartPrompt } from "./prompts.js";
