/**
 * Ratel Pi Extension — Local Event Reader
 *
 * Reads Ratel mission events from the durable `events.jsonl` file that
 * `@ratel-factory/core`'s `EventLogger` writes under
 * `.ratel/missions/<missionId>/events.jsonl`.
 *
 * This is the in-process replacement for the old out-of-band event reader.
 * The extension reads durable mission state directly from disk via core
 * helpers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getMissionDir, type MissionScope } from "@ratel-factory/core";

/**
 * A Ratel event record. Structurally compatible with the `RatelEvent` type
 * exported by `@ratel-factory/core`'s `EventLogger`. Kept local so the
 * extension's polling helpers do not need to import the core observability
 * internals.
 */
export interface RatelEvent {
  timestamp: string;
  event_type: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  agent_level?: string;
  data: Record<string, unknown>;
}

export interface MissionEventsSlice {
  missionId: string;
  events: RatelEvent[];
  /** Index of the next event to read on a subsequent call. */
  nextAfter: number;
  /** Total number of events currently in the log. */
  total: number;
}

/**
 * Read all events from a mission's `events.jsonl` and return the slice
 * starting at `after` (0-based event index).
 *
 * If the file does not exist yet (mission just initialized, no events
 * written), returns an empty slice.
 */
export async function readMissionEvents(
  scope: MissionScope,
  after: number = 0,
): Promise<MissionEventsSlice> {
  const path = join(getMissionDir(scope), "events.jsonl");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { missionId: scope.missionId, events: [], nextAfter: 0, total: 0 };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const total = lines.length;
  const start = Math.max(0, after);
  const sliceLines = lines.slice(start);
  const events: RatelEvent[] = [];

  for (const line of sliceLines) {
    try {
      const parsed = JSON.parse(line) as RatelEvent;
      if (
        typeof parsed.event_type === "string" &&
        typeof parsed.timestamp === "string" &&
        typeof parsed.data === "object" &&
        parsed.data !== null
      ) {
        events.push(parsed);
      }
    } catch {
      // Tolerate a partially-written final line.
    }
  }

  return {
    missionId: scope.missionId,
    events,
    nextAfter: start + events.length,
    total,
  };
}
