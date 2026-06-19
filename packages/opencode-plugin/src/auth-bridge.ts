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
 * - Overwrites existing Pi auth entries **only** for providers that are
 *   relevant to this project (declared in ratel.json or OpenCode config)
 *   and that OpenCode has a credential for. Manual Pi entries for
 *   non-project providers are never touched.
 * - Only bridges API-key credentials (type "api" or "api_key"); skips
 *   oauth / wellknown / unknown shapes.
 * - Provider removal is **safe**: only providers previously recorded as
 *   bridge-managed in `.ratel/provider-namespaces.json` can be removed,
 *   and only when they disappear from OpenCode auth. Unknown/corrupt
 *   metadata ⇒ no removals.
 * - Metadata stores only non-secret key hashes (sha256, truncated), never
 *   raw keys. Raw keys are written only to Pi auth.json.
 * - Uses atomic temp-file + rename writes with an exclusive `.lock` to
 *   prevent concurrent read/modify/write races.
 * - Sets mode 0o600 on the Pi auth file when possible.
 * - Reads are best-effort; failures are silent (no crash).
 */

import {
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
import { randomBytes, createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Options controlling bridge behaviour.
 */
export interface BridgeOptions {
  /**
   * Force a full bridge even if change detection (OpenCode auth file hash,
   * ratel.json mtime, extra provider ids) indicates nothing changed.
   * Use at startup, on file-watch events, and on explicit tool calls.
   */
  force?: boolean;
  /**
   * Overwrite existing Pi auth entries for project-relevant providers when
   * OpenCode has a different key. Defaults to `true`. Set to `false` to
   * only add missing providers and never update existing ones.
   */
  overwrite?: boolean;
  /**
   * Remove Pi auth providers previously managed by the bridge that are now
   * absent from OpenCode auth. Defaults to `true`. Set to `false` to keep
   * stale managed providers (e.g. for read-only/dry-run bridging).
   */
  removeStale?: boolean;
}

export interface BridgeResult {
  attemptedProviders: string[];
  /**
   * Providers that were added OR updated in Pi auth. Kept for backward
   * compatibility with older callers/log messages.
   */
  bridgedProviders: string[];
  /** Providers newly added to Pi auth. */
  addedProviders: string[];
  /** Existing Pi auth entries overwritten with the OpenCode key. */
  updatedProviders: string[];
  /** Previously bridge-managed providers removed from Pi auth. */
  removedProviders: string[];
  /** Providers skipped (already in sync, or not touched due to options). */
  skippedProviders: string[];
  missingProviders: string[];
  piAuthPath: string;
  openCodeAuthPath: string;
  /** mtime (ms since epoch) of ratel.json at the time of bridging,
   *  for cache invalidation. undefined if ratel.json could not be read. */
  ratelMtime: number | undefined;
  /** Canonical provider namespaces discovered from OpenCode credentials.
   *  These are the provider IDs that OpenCode has API keys for — useful for
   *  surfacing available provider namespaces to Ratel. Does NOT include
   *  secret values. */
  openCodeProviderIds: string[];
  /** True if Pi auth.json was modified (add/update/remove). */
  authChanged: boolean;
  /** True if `.ratel/provider-namespaces.json` was rewritten. */
  metadataChanged: boolean;
  /** True if change detection short-circuited the bridge (no-op). */
  skipped: boolean;
}

interface OpenCodeCredential {
  type: string;
  key: string;
}

interface PiCredential {
  type: string;
  key: string;
}

/** Metadata entry for a provider managed by the bridge. Non-secret. */
interface ManagedProviderEntry {
  /** Truncated sha256 of the API key. Never the raw key. */
  keyHash: string;
  /** ISO timestamp of the last successful bridge for this provider. */
  lastBridgedAt: string;
}

interface ProviderNamespacesMetadata {
  // ── Backward-compatible fields (existing readers expect these) ──
  openCodeProviderIds: string[];
  bridgedProviderIds: string[];
  bridgedAt: string;
  // ── New fields for overwrite / removal / change detection ──
  managedProviders: Record<string, ManagedProviderEntry>;
  /** sha256 of OpenCode auth file contents at last bridge. */
  openCodeAuthHash?: string;
  /** ratel.json mtime at last bridge. */
  ratelMtime?: number;
  /** sha256 of sorted extra provider ids at last bridge. */
  extraProviderIdsHash?: string;
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

/**
 * Resolve the `.ratel/provider-namespaces.json` path for a project root.
 * Exported for tests/watch helpers.
 */
export function resolveProviderNamespacesPath(projectRoot: string): string {
  return join(projectRoot, ".ratel", "provider-namespaces.json");
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
  const { credentials } = await readOpenCodeAuthWithHash(openCodeAuthPath);
  return credentials;
}

/**
 * Read OpenCode auth.json together with a sha256 hash of the raw file
 * contents (for change detection). Best-effort: returns empty credentials
 * and an empty hash string if the file cannot be read.
 *
 * Exported for tests.
 */
export async function readOpenCodeAuthWithHash(
  openCodeAuthPath: string,
): Promise<{ credentials: Record<string, OpenCodeCredential>; hash: string }> {
  let raw = "";
  try {
    raw = await readFile(openCodeAuthPath, "utf-8");
  } catch {
    return { credentials: {}, hash: "" };
  }

  const hash = sha256Hex(raw);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { credentials: {}, hash };
  }

  // Wrapped shape: { "credentials": { ... } }
  if (data && typeof data === "object" && (data as any)?.credentials && typeof (data as any).credentials === "object") {
    return { credentials: filterCredentials((data as any).credentials), hash };
  }

  // Flat shape
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { credentials: filterCredentials(data as Record<string, unknown>), hash };
  }

  return { credentials: {}, hash };
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

// ── Hashing helpers (non-secret) ──────────────────────────────────────────

/**
 * Compute the sha256 hex digest of a string.
 */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Compute a truncated, non-secret hash of an API key for metadata storage.
 * Uses the first 16 hex chars of sha256 — enough to detect changes without
 * being reversible to the raw key in any practical sense.
 */
export function hashApiKey(key: string): string {
  return sha256Hex(key).slice(0, 16);
}

/**
 * Hash a sorted list of provider IDs so extraProviderIds changes are detected.
 */
function hashProviderIdList(ids: string[]): string {
  const normalized = [...ids].filter(Boolean).sort().join(",");
  return sha256Hex(normalized).slice(0, 16);
}

// ── Provider namespace metadata ──────────────────────────────────────────

/**
 * Read `.ratel/provider-namespaces.json`. Returns undefined if missing or
 * corrupt (callers must treat corrupt metadata conservatively: no removals).
 */
export async function readProviderNamespacesMetadata(
  projectRoot: string,
): Promise<ProviderNamespacesMetadata | undefined> {
  const targetPath = resolveProviderNamespacesPath(projectRoot);
  try {
    const raw = await readFile(targetPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;

    const m = data as Partial<ProviderNamespacesMetadata>;
    // Validate the shape of managedProviders conservatively.
    const managedProviders: Record<string, ManagedProviderEntry> = {};
    if (m.managedProviders && typeof m.managedProviders === "object" && !Array.isArray(m.managedProviders)) {
      for (const [pid, entry] of Object.entries(m.managedProviders)) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as unknown as Record<string, unknown>;
        if (typeof e.keyHash !== "string" || typeof e.lastBridgedAt !== "string") continue;
        managedProviders[pid] = {
          keyHash: e.keyHash,
          lastBridgedAt: e.lastBridgedAt,
        };
      }
    }

    return {
      openCodeProviderIds: Array.isArray(m.openCodeProviderIds) ? m.openCodeProviderIds : [],
      bridgedProviderIds: Array.isArray(m.bridgedProviderIds) ? m.bridgedProviderIds : [],
      bridgedAt: typeof m.bridgedAt === "string" ? m.bridgedAt : "",
      managedProviders,
      openCodeAuthHash: typeof m.openCodeAuthHash === "string" ? m.openCodeAuthHash : undefined,
      ratelMtime: typeof m.ratelMtime === "number" ? m.ratelMtime : undefined,
      extraProviderIdsHash:
        typeof m.extraProviderIdsHash === "string" ? m.extraProviderIdsHash : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Write provider namespace metadata to .ratel/provider-namespaces.json.
 * Uses atomic temp-file + rename to avoid corruption.
 * Best-effort; never throws.
 */
async function writeProviderNamespacesMetadata(
  projectRoot: string,
  metadata: ProviderNamespacesMetadata,
): Promise<void> {
  try {
    const ratelDir = join(projectRoot, ".ratel");
    await mkdir(ratelDir, { recursive: true });
    const targetPath = resolveProviderNamespacesPath(projectRoot);
    const tmpPath = targetPath + ".tmp." + randomBytes(6).toString("hex");
    const json = JSON.stringify(metadata, null, 2) + "\n";
    await writeFile(tmpPath, json, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, targetPath);
  } catch {
    // Best-effort; metadata file is non-critical
  }
}

// ── Bridge function ───────────────────────────────────────────────────────

/**
 * Bridge OpenCode provider credentials into Pi's auth storage.
 *
 * Behaviour (see {@link BridgeOptions}):
 *   - **Add**: providers relevant to this project (from ratel.json + extra
 *     provider IDs) that OpenCode has a credential for but Pi auth lacks.
 *   - **Update (overwrite)**: when OpenCode has a credential for a
 *     project-relevant provider and Pi auth already has that provider with a
 *     different key, replace the Pi entry (unless `overwrite: false`).
 *   - **Remove (safe)**: providers previously recorded as bridge-managed in
 *     `.ratel/provider-namespaces.json` that are now absent from OpenCode
 *     auth are removed from Pi auth. Providers never managed by the bridge
 *     are never removed. If metadata is missing/corrupt, no removals occur.
 *   - **Change detection**: if the OpenCode auth file hash, ratel.json mtime,
 *     and extra provider IDs all match the last bridge and `force` is false,
 *     the bridge returns quickly without rewriting Pi auth or metadata.
 *
 * Writes are atomic with an exclusive lock to prevent concurrent
 * read/modify/write races with other bridge callers or manual edits.
 *
 * @param projectRoot  Path to the project root containing ratel.json.
 * @param extraProviderIds  Additional provider IDs to attempt to bridge, e.g.
 *                          the OpenCode host's current/default provider.
 * @param options      Bridge behaviour options.
 * @returns A BridgeResult detailing what was added/updated/removed/skipped,
 *          the mtime of ratel.json for cache invalidation, and change flags.
 */
export async function bridgeOpenCodeAuthForProject(
  projectRoot: string,
  extraProviderIds?: string[],
  options?: BridgeOptions,
): Promise<BridgeResult> {
  const force = options?.force === true;
  const overwrite = options?.overwrite !== false; // default true
  const removeStale = options?.removeStale !== false; // default true

  const openCodeAuthPath = resolveOpenCodeAuthPath();
  const piAuthPath = resolvePiAuthPath();

  // 1. Discover which providers this project uses (from ratel.json)
  const providerIds = await getProjectProviderIds(projectRoot);

  const extras = extraProviderIds ? extraProviderIds.filter(Boolean) : [];
  for (const p of extras) {
    if (p) providerIds.add(p);
  }

  // Capture ratel.json mtime for cache invalidation
  const ratelMtime = await getFileMtime(join(projectRoot, "ratel.json"));

  // 2. Read OpenCode credentials + file hash (best-effort)
  const { credentials: openCodeCredentials, hash: openCodeAuthHash } =
    await readOpenCodeAuthWithHash(openCodeAuthPath);

  const openCodeProviderIds = Object.keys(openCodeCredentials).sort();
  const attemptedProviders = [...providerIds].sort();
  const extraProviderIdsHash = hashProviderIdList(extras);

  // 3. Read existing metadata for change detection + managed-provider map.
  const existingMeta = await readProviderNamespacesMetadata(projectRoot);
  const managedProviders: Record<string, ManagedProviderEntry> =
    existingMeta?.managedProviders ?? {};

  // ── Change detection short-circuit ───────────────────────────────
  if (
    !force &&
    existingMeta &&
    existingMeta.openCodeAuthHash !== undefined &&
    existingMeta.openCodeAuthHash === openCodeAuthHash &&
    existingMeta.ratelMtime !== undefined &&
    existingMeta.ratelMtime === ratelMtime &&
    existingMeta.extraProviderIdsHash !== undefined &&
    existingMeta.extraProviderIdsHash === extraProviderIdsHash
  ) {
    return {
      attemptedProviders,
      bridgedProviders: [],
      addedProviders: [],
      updatedProviders: [],
      removedProviders: [],
      skippedProviders: attemptedProviders,
      missingProviders: attemptedProviders.filter(p => !openCodeCredentials[p]),
      piAuthPath,
      openCodeAuthPath,
      ratelMtime,
      openCodeProviderIds,
      authChanged: false,
      metadataChanged: false,
      skipped: true,
    };
  }

  // 4. Read existing Pi credentials, merge/add/update/remove under one lock.
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  // New managed-providers map (rebuilt from the bridge result).
  const newManaged: Record<string, ManagedProviderEntry> = {};
  const nowIso = new Date().toISOString();

  let authChanged = false;
  let bridgeError: Error | undefined;

  try {
    const updateOutcome = await updatePiAuthAtomically(piAuthPath, async (existingPiAuth) => {
      const mergedPiAuth = { ...existingPiAuth };

      // ── Add / Update for project-relevant providers ──
      for (const provider of attemptedProviders) {
        const openCodeCred = openCodeCredentials[provider];

        if (!openCodeCred) {
          missing.push(provider);
          continue;
        }

        const existingPi = existingPiAuth[provider];
        const newKeyHash = hashApiKey(openCodeCred.key);

        if (!existingPi) {
          // Add
          mergedPiAuth[provider] = {
            type: "api_key",
            key: openCodeCred.key,
          };
          added.push(provider);
          newManaged[provider] = { keyHash: newKeyHash, lastBridgedAt: nowIso };
          continue;
        }

        // Pi already has this provider. Compare keys in-memory (never persist).
        if (existingPi.key === openCodeCred.key) {
          // In sync. Keep it managed.
          skipped.push(provider);
          newManaged[provider] = { keyHash: newKeyHash, lastBridgedAt: nowIso };
          continue;
        }

        // Keys differ.
        if (overwrite) {
          mergedPiAuth[provider] = {
            type: "api_key",
            key: openCodeCred.key,
          };
          updated.push(provider);
          newManaged[provider] = { keyHash: newKeyHash, lastBridgedAt: nowIso };
        } else {
          // Respect existing Pi entry; keep prior management info if any.
          skipped.push(provider);
          const prior = managedProviders[provider];
          newManaged[provider] = prior
            ? { keyHash: prior.keyHash, lastBridgedAt: prior.lastBridgedAt }
            : { keyHash: hashApiKey(existingPi.key), lastBridgedAt: nowIso };
        }
      }

      // ── Safe removal of stale managed providers ──
      if (removeStale) {
        for (const [pid, entry] of Object.entries(managedProviders)) {
          if (openCodeCredentials[pid]) continue; // still present in OpenCode
          // Previously managed, now absent from OpenCode auth → remove.
          if (mergedPiAuth[pid]) {
            // Only remove if the current Pi key hash still matches what we
            // recorded. If the user manually changed it after the bridge
            // last ran, be conservative and leave it alone.
            if (hashApiKey(mergedPiAuth[pid].key) === entry.keyHash) {
              delete mergedPiAuth[pid];
              removed.push(pid);
            } else {
              // User modified it manually; drop management but keep entry.
              skipped.push(pid);
            }
          }
          // Either way, drop from newManaged (no longer managed).
        }
      } else {
        // Keep prior managed entries for providers still absent from OpenCode.
        for (const [pid, entry] of Object.entries(managedProviders)) {
          if (!openCodeCredentials[pid] && !newManaged[pid]) {
            newManaged[pid] = entry;
          }
        }
      }

      const modified = added.length > 0 || updated.length > 0 || removed.length > 0;
      authChanged = modified;

      return {
        data: mergedPiAuth,
        value: undefined,
        skipWrite: !modified,
      };
    });
    void updateOutcome;
  } catch (err) {
    bridgeError = err instanceof Error ? err : new Error(String(err));
    // On write failure, treat intended adds/updates as missing for reporting.
    for (const p of [...added, ...updated]) missing.push(p);
    added.length = 0;
    updated.length = 0;
    removed.length = 0;
    authChanged = false;
  }

  // 5. Rebuild and persist metadata.
  //    bridgedProviderIds (backward-compat) = added + updated.
  const bridgedProviderIds = [...added, ...updated].sort();
  const newMeta: ProviderNamespacesMetadata = {
    openCodeProviderIds,
    bridgedProviderIds,
    bridgedAt: nowIso,
    managedProviders: newManaged,
    openCodeAuthHash,
    ratelMtime,
    extraProviderIdsHash,
  };

  let metadataChanged = false;
  if (!bridgeError) {
    // Only rewrite metadata if something meaningful changed. We compare a
    // cheap projection to avoid churning the file on no-op bridges.
    const sameCore =
      existingMeta &&
      arraysEqual(existingMeta.openCodeProviderIds, openCodeProviderIds) &&
      arraysEqual(existingMeta.bridgedProviderIds, bridgedProviderIds) &&
      sameManagedMap(existingMeta.managedProviders, newManaged) &&
      existingMeta.openCodeAuthHash === openCodeAuthHash &&
      existingMeta.ratelMtime === ratelMtime &&
      existingMeta.extraProviderIdsHash === extraProviderIdsHash;

    if (!sameCore) {
      await writeProviderNamespacesMetadata(projectRoot, newMeta);
      metadataChanged = true;
    }
  } else if (!existingMeta) {
    // Even on bridge error, if there's no metadata yet, write a minimal one so
    // change detection can work next time. Safe: no managedProviders yet.
    await writeProviderNamespacesMetadata(projectRoot, newMeta);
    metadataChanged = true;
  }

  return {
    attemptedProviders,
    bridgedProviders: bridgedProviderIds,
    addedProviders: added,
    updatedProviders: updated,
    removedProviders: removed,
    skippedProviders: skipped,
    missingProviders: missing.sort(),
    piAuthPath,
    openCodeAuthPath,
    ratelMtime,
    openCodeProviderIds,
    authChanged,
    metadataChanged,
    skipped: false,
  };
}

// ── Small comparison helpers ─────────────────────────────────────────────

function arraysEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameManagedMap(
  a: Record<string, ManagedProviderEntry>,
  b: Record<string, ManagedProviderEntry>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const be = b[k];
    if (!be) return false;
    if (a[k].keyHash !== be.keyHash) return false;
    if (a[k].lastBridgedAt !== be.lastBridgedAt) return false;
  }
  return true;
}
