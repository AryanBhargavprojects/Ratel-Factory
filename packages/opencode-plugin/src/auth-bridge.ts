/**
 * OpenCode → Pi Auth Bridge
 *
 * Bridges provider credentials from OpenCode's auth.json into Pi's
 * auth.json so Ratel factory agents can reuse the same provider/model
 * as the OpenCode host — especially opencode-go.
 *
 * ## File shapes
 *
 * OpenCode auth.json (supports two layouts):
 *   { "opencode-go": { "type": "api", "key": "..." } }
 *   { "credentials": { "opencode-go": { "type": "api", "key": "..." } } }
 *
 * Pi auth.json:
 *   { "opencode-go": { "type": "api_key", "key": "..." } }
 *
 * ## Security
 *
 * - Never logs or prints secret values.
 * - Never overwrites existing Pi auth entries.
 * - Only bridges API-key credentials (type "api" or "api_key"); skips
 *   oauth / wellknown / unknown shapes.
 * - Uses atomic temp-file + rename writes with an exclusive `.lock` to
 *   prevent concurrent read/modify/write races.
 * - Sets mode 0o600 on the Pi auth file when possible.
 * - Reads are best-effort; failures are silent (no crash).
 */

import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────

export interface BridgeResult {
  attemptedProviders: string[];
  bridgedProviders: string[];
  missingProviders: string[];
  piAuthPath: string;
  openCodeAuthPath: string;
  /** mtime (ms since epoch) of ratel.json at the time of bridging,
   *  for cache invalidation. undefined if ratel.json could not be read. */
  ratelMtime: number | undefined;
}

interface OpenCodeCredential {
  type: string;
  key: string;
}

interface PiCredential {
  type: string;
  key: string;
}

// ── Path resolution ──────────────────────────────────────────────────────

/**
 * Resolve the OpenCode auth.json path.
 * Default: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json`
 */
export function resolveOpenCodeAuthPath(): string {
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdgData, "opencode", "auth.json");
}

/**
 * Resolve the Pi agent auth.json path.
 * Default: `${PI_AGENT_DIR:-$HOME/.pi/agent}/auth.json`
 */
export function resolvePiAuthPath(): string {
  const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "auth.json");
}

// ── Provider ID extraction from ratel.json ───────────────────────────────

/**
 * Extract the provider ID from a model string like "opencode-go/gpt-5.5".
 * Splits on the first "/". Returns undefined for empty/null/invalid strings.
 */
export function extractProviderId(model: string | null | undefined): string | undefined {
  if (!model || typeof model !== "string") return undefined;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) return undefined;
  return model.slice(0, slashIndex);
}

/**
 * Parse ratel.json at the given project root and return the set of unique
 * provider IDs used across all three agent levels (including fallbacks).
 * Returns an empty set if ratel.json cannot be read.
 */
export async function getProjectProviderIds(projectRoot: string): Promise<Set<string>> {
  const providerIds = new Set<string>();

  try {
    const raw = await readFile(join(projectRoot, "ratel.json"), "utf-8");
    const config = JSON.parse(raw);

    // Orchestrator
    const orchProvider = extractProviderId(config?.orchestrator?.model);
    if (orchProvider) providerIds.add(orchProvider);
    for (const fb of config?.orchestrator?.fallbackModels ?? []) {
      const p = extractProviderId(fb);
      if (p) providerIds.add(p);
    }

    // Workers
    const workProvider = extractProviderId(config?.workers?.model);
    if (workProvider) providerIds.add(workProvider);
    for (const fb of config?.workers?.fallbackModels ?? []) {
      const p = extractProviderId(fb);
      if (p) providerIds.add(p);
    }

    // Validators
    const valProvider = extractProviderId(config?.validators?.model);
    if (valProvider) providerIds.add(valProvider);
    for (const fb of config?.validators?.fallbackModels ?? []) {
      const p = extractProviderId(fb);
      if (p) providerIds.add(p);
    }
  } catch {
    // ratel.json unreadable — no providers to bridge
  }

  return providerIds;
}

// ── OpenCode auth reader ──────────────────────────────────────────────────

/** Only accept credentials with type "api" or "api_key" and a non-empty key. */
function isApiKeyCredential(value: unknown): value is { type: string; key: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || v.key.length === 0) return false;
  const credType = typeof v.type === "string" ? v.type : "";
  // Only bridge API-key credentials. Skip oauth, wellknown, and unknown shapes
  // that would produce invalid Pi auth entries.
  return credType === "api" || credType === "api_key";
}

/**
 * Read and parse OpenCode's auth.json.
 * Supports two layouts:
 *   1. Flat:  { "provider": { "type": "api", "key": "..." }, ... }
 *   2. Wrapped: { "credentials": { "provider": { "type": "api", "key": "..." }, ... } }
 *
 * Only API-key credentials (type "api" / "api_key") are returned.
 * OAuth, wellknown, and unrecognised shapes are silently skipped.
 *
 * Returns a flat map of provider → credential, or an empty object if the file
 * cannot be read or parsed.
 */
export async function readOpenCodeAuth(
  openCodeAuthPath: string,
): Promise<Record<string, OpenCodeCredential>> {
  try {
    const raw = await readFile(openCodeAuthPath, "utf-8");
    const data = JSON.parse(raw);

    // Wrapped shape: { "credentials": { ... } }
    if (data?.credentials && typeof data.credentials === "object") {
      return filterCredentials(data.credentials);
    }

    // Flat shape: { "provider": { "type": "api", "key": "..." }, ... }
    return filterCredentials(data);
  } catch {
    return {};
  }
}

function filterCredentials(obj: Record<string, unknown>): Record<string, OpenCodeCredential> {
  const result: Record<string, OpenCodeCredential> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isApiKeyCredential(value)) {
      result[key] = {
        type: value.type,
        key: value.key,
      };
    }
  }
  return result;
}

// ── Pi auth reader/writer ─────────────────────────────────────────────────

/**
 * Read Pi's auth.json and return the parsed object.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
export async function readPiAuth(
  piAuthPath: string,
): Promise<Record<string, PiCredential>> {
  try {
    const raw = await readFile(piAuthPath, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, PiCredential>;
    }
    return {};
  } catch {
    return {};
  }
}

// ── Atomic file locking ──────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30000; // only remove locks much older than any expected bridge call

interface LockToken {
  path: string;
  nonce: string;
}

/**
 * Acquire an exclusive lock using a `.lock` file next to the target path.
 *
 * Writes a random nonce to the lock file. If the lock file already exists
 * we poll until it disappears or timeout. A live lock is never stolen:
 * existing lock files are removed only when their mtime is older than
 * LOCK_STALE_MS. On timeout the call throws without deleting a fresh lock.
 *
 * Returns a token containing the lock file path and nonce. The caller MUST
 * call releaseLock() with the same token to remove it.
 */
async function acquireLock(targetPath: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<LockToken> {
  const lockPath = targetPath + ".lock";
  const nonce = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // O_EXCL ensures atomic creation — fails if file already exists
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(nonce, "utf-8");
      await handle.close();
      return { path: lockPath, nonce };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }

    // Lock exists. Only remove it if it is stale (significantly older than
    // expected). This prevents stealing a live lock held by another process.
    try {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
        try { await unlink(lockPath); } catch { /* ignore, will retry loop */ }
      }
    } catch { /* lock may have been removed already */ }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock: ${lockPath}`);
    }

    await new Promise(r => setTimeout(r, LOCK_POLL_MS));
  }
}

/**
 * Release a lock file previously acquired via acquireLock().
 *
 * Validates the nonce so a caller can only remove its own lock. If the lock
 * file is missing or has a different nonce, the release is a no-op.
 * Best-effort; never throws.
 */
async function releaseLock(lock: LockToken): Promise<void> {
  try {
    const raw = await readFile(lock.path, "utf-8");
    if (raw.trim() !== lock.nonce) return; // another process owns the lock now
  } catch {
    // Lock missing or unreadable — nothing for us to release
    return;
  }
  try { await unlink(lock.path); } catch { /* best-effort */ }
}

// ── File mtime helper ────────────────────────────────────────────────────

/**
 * Return the mtime (ms since epoch) of a file, or undefined if unreadable.
 */
export async function getFileMtime(filePath: string): Promise<number | undefined> {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Result returned by an `updatePiAuthAtomically` updater.
 */
export interface PiAuthUpdate<T> {
  /** New Pi auth contents to write. Not required when `skipWrite` is true. */
  data?: Record<string, PiCredential>;
  /** Value returned to the caller after a successful update. */
  value: T;
  /** When true, no file I/O is performed (useful when nothing changed). */
  skipWrite?: boolean;
}

/**
 * Update Pi auth.json atomically under an exclusive lock.
 *
 * 1. Acquire a .lock file.
 * 2. Read the current Pi auth while the lock is held.
 * 3. Run the caller-supplied `updater(current)` to produce new contents.
 * 4. Write JSON to a temp file in the same directory (unless skipped).
 * 5. Atomically rename temp → target.
 * 6. chmod 0o600 on the final file.
 * 7. Release lock.
 *
 * This keeps the entire read/merge/write cycle under one lock so the merge
 * can never be based on a stale snapshot of Pi auth.
 *
 * Ensures parent directory exists.
 * On any error, lock is released and the temp file is cleaned up best-effort.
 */
export async function updatePiAuthAtomically<T>(
  piAuthPath: string,
  updater: (
    current: Record<string, PiCredential>,
  ) => Promise<PiAuthUpdate<T>> | PiAuthUpdate<T>,
): Promise<T> {
  const dir = dirname(piAuthPath);
  await mkdir(dir, { recursive: true });

  const lock = await acquireLock(piAuthPath);
  const tmpPath = piAuthPath + ".tmp." + randomBytes(6).toString("hex");

  try {
    const current = await readPiAuth(piAuthPath);
    const { data, value, skipWrite } = await updater(current);

    if (!skipWrite && data) {
      const json = JSON.stringify(data, null, 2) + "\n";
      await writeFile(tmpPath, json, { encoding: "utf-8", mode: 0o600 });
      await rename(tmpPath, piAuthPath);

      // Best-effort chmod on the final file
      try { await chmod(piAuthPath, 0o600); } catch { /* non-fatal */ }
    }

    return value;
  } finally {
    await releaseLock(lock);
    // Best-effort cleanup of orphaned temp file
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Write Pi auth.json atomically with an exclusive lock to prevent races.
 *
 * Implemented on top of {@link updatePiAuthAtomically} so all writes share
 * the same locking protocol.
 */
export async function atomicWritePiAuth(
  piAuthPath: string,
  data: Record<string, PiCredential>,
): Promise<void> {
  await updatePiAuthAtomically(piAuthPath, () => ({ data, value: undefined }));
}

// ── Bridge function ───────────────────────────────────────────────────────

/**
 * Bridge OpenCode provider credentials into Pi's auth storage.
 *
 * For every provider ID extracted from the project's ratel.json (and any
 * extraProviderIds passed in):
 *   1. Look up the credential in OpenCode's auth.json.
 *   2. If found, check whether Pi auth.json already has that provider.
 *   3. If Pi lacks the provider, add it (mapping `type: "api"` → `type: "api_key"`).
 *   4. Never overwrite existing Pi entries.
 *
 * Writes are atomic with an exclusive lock to prevent concurrent read/modify/write
 * races with other bridge callers or manual edits.
 *
 * @param projectRoot  Path to the project root containing ratel.json.
 * @param extraProviderIds  Additional provider IDs to attempt to bridge, e.g.
 *                          the OpenCode host's current/default provider.
 * @returns A BridgeResult detailing what was attempted, bridged, missing,
 *          and the mtime of ratel.json for cache invalidation.
 */
export async function bridgeOpenCodeAuthForProject(
  projectRoot: string,
  extraProviderIds?: string[],
): Promise<BridgeResult> {
  const openCodeAuthPath = resolveOpenCodeAuthPath();
  const piAuthPath = resolvePiAuthPath();

  // 1. Discover which providers this project uses (from ratel.json)
  const providerIds = await getProjectProviderIds(projectRoot);

  // Also include any extra provider IDs (e.g. OpenCode default provider)
  if (extraProviderIds) {
    for (const p of extraProviderIds) {
      if (p) providerIds.add(p);
    }
  }

  // Capture ratel.json mtime for cache invalidation
  const ratelMtime = await getFileMtime(join(projectRoot, "ratel.json"));

  // 2. Read OpenCode credentials (best-effort)
  const openCodeCredentials = await readOpenCodeAuth(openCodeAuthPath);

  const attemptedProviders = [...providerIds].sort();

  // 3. Read existing Pi credentials, merge, and write all under one lock.
  // The merge decision uses the fresh Pi auth read inside updatePiAuthAtomically,
  // so a provider added by another process between discovery and write is never
  // overwritten with a stale snapshot.
  let bridgedProviders: string[] = [];
  let missingProviders: string[] = [];
  let updateResult:
    | { bridged: string[]; missing: string[]; modified: boolean }
    | undefined;

  try {
    await updatePiAuthAtomically(piAuthPath, async (existingPiAuth) => {
      const mergedPiAuth = { ...existingPiAuth };
      const localBridged: string[] = [];
      const localMissing: string[] = [];

      for (const provider of attemptedProviders) {
        const openCodeCred = openCodeCredentials[provider];

        if (!openCodeCred) {
          localMissing.push(provider);
          continue;
        }

        // Never overwrite existing Pi entries
        if (existingPiAuth[provider]) {
          continue;
        }

        // Map "api" or "api_key" → Pi "api_key"
        mergedPiAuth[provider] = {
          type: "api_key",
          key: openCodeCred.key,
        };
        localBridged.push(provider);
      }

      const modified = localBridged.length > 0;
      updateResult = {
        bridged: localBridged,
        missing: localMissing,
        modified,
      };

      return {
        data: mergedPiAuth,
        value: undefined,
        skipWrite: !modified,
      };
    });

    if (updateResult) {
      bridgedProviders = updateResult.bridged;
      missingProviders = updateResult.missing;
    }
  } catch (err) {
    // If we couldn't write, treat every provider we intended to add as missing.
    if (updateResult) {
      missingProviders = [...updateResult.missing, ...updateResult.bridged];
    } else {
      missingProviders = attemptedProviders.filter(p => !openCodeCredentials[p]);
    }
    bridgedProviders = [];
  }

  return {
    attemptedProviders,
    bridgedProviders,
    missingProviders,
    piAuthPath,
    openCodeAuthPath,
    ratelMtime,
  };
}
