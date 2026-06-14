import { writeRawOutput } from "../utils/jsonl.js";
import type { MissionScope } from "../mission/scope.js";

/**
 * Persist the complete text returned by a worker agent before any parser or
 * orchestrator interpretation. This is the audit trail used when JSONL handoff
 * parsing fails; callers receive a mission-relative filename they can surface
 * to the user and observability timeline.
 */
export async function writeWorkerRawOutput(
  scope: MissionScope,
  featureId: string,
  rawResponse: string,
  timestamp: number = Date.now(),
): Promise<string> {
  const safeFeatureId = featureId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${safeFeatureId}-${timestamp}.raw.txt`;
  await writeRawOutput(scope, "worker-raw-output", filename, rawResponse);
  return `worker-raw-output/${filename}`;
}
