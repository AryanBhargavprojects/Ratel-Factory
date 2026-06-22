/**
 * JSONL (JSON Lines) parsing utilities.
 *
 * Why JSONL: Models wrap outputs in markdown fences, add preamble/postamble,
 * and occasionally truncate. A single JSON blob is fragile — one syntax error
 * anywhere breaks the entire parse. JSONL (one JSON object per line) is
 * robust because we scan line-by-line from bottom to top, and the LAST
 * valid JSON line wins.
 *
 * Contract for every structured output (worker handoff, scrutiny report,
 * user-testing report, code review): exactly ONE JSON object on ONE line
 * at the END of the response. The model may add prose before it, but the
 * last non-empty, non-fence line must be a valid JSON object.
 */

import type { MissionScope } from "../mission/scope.js";
import { getMissionDir } from "../mission/scope.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ParseResult<T> {
  /** "ok" if a valid JSON object matching the expected shape was found. */
  parseStatus: "ok" | "failed";
  /** The parsed object, or null if parseStatus is "failed". */
  data: T | null;
  /** The exact line that was parsed (for audit / debugging). */
  rawLine: string | null;
  /** The full input text (always returned, for debugging and audit). */
  fullText: string;
}

/**
 * Scan text line-by-line from bottom to top and return the first JSON object
 * that parses and (optionally) matches a type-guard. Skips lines that look
 * like markdown fence markers (```).
 *
 * Robust against:
 * - Models wrapping output in ```json ... ``` fences
 * - Preamble ("Here's the report:") and postamble ("Hope this helps!")
 * - Truncated responses (we get whatever lines are complete)
 * - Multiple JSON-like lines (we pick the LAST one — most recent)
 * - A model prefixing the final object on the same line, e.g.
 *   "Final JSON:{...}"
 */
function findBalancedJsonObject(line: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < line.length; i++) {
    const ch = line[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return line.slice(start, i + 1);
    }
  }

  return null;
}

function jsonCandidatesForLine(line: string): string[] {
  const candidates = [line];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "{") continue;
    const candidate = findBalancedJsonObject(line, i);
    if (candidate && candidate !== line) candidates.push(candidate);
  }
  return candidates;
}

export function extractLastJsonLine<T>(
  text: string,
  validate?: (obj: unknown) => obj is T,
): ParseResult<T> {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip markdown fence markers themselves — they aren't valid JSON
    if (line.startsWith("```")) continue;
    for (const candidate of jsonCandidatesForLine(line)) {
      try {
        const parsed = JSON.parse(candidate);
        if (validate) {
          if (validate(parsed)) {
            return { parseStatus: "ok", data: parsed, rawLine: candidate, fullText: text };
          }
          // Parsed as JSON but didn't match shape — keep scanning upward
        } else {
          return { parseStatus: "ok", data: parsed as T, rawLine: candidate, fullText: text };
        }
      } catch {
        // Not valid JSON — keep scanning upward
      }
    }
  }

  return { parseStatus: "failed", data: null, rawLine: null, fullText: text };
}

/**
 * Persist raw model output to mission-scoped storage for audit.
 * Always write — even if parsing failed. The raw text is the ground truth
 * the orchestrator falls back to when parseStatus is "failed".
 */
export async function writeRawOutput(
  scope: MissionScope,
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  // The filename may itself contain path separators (e.g. callers pass
  // `user-testing-shards/<runId>/<shard>.raw.txt` as the filename). Create the
  // FULL parent directory tree of the final file path, not just the top dir.
  const outPath = join(getMissionDir(scope), dir, filename);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, content, "utf-8");
}
