/**
 * Proactive auth sync watcher for the OpenCode plugin.
 *
 * Watches OpenCode's auth.json for changes and re-runs the auth bridge
 * (with `force: true`, overwrite + stale-removal enabled) so that key
 * rotations and provider removals in OpenCode propagate to Pi auth in near
 * real time.
 *
 * Design notes (see task A/B):
 *   - There is no public OpenCode `auth.changed` hook, so we rely on
 *     `fs.watch` with a debounce plus a periodic stat/hash fallback for
 *     platforms where `fs.watch` is unreliable.
 *   - Duplicate watchers are avoided: `createAuthSyncWatcher` is idempotent
 *     per resolver path within a process (module-level guard).
 *   - Nothing logs or persists raw secret values; the bridge never does
 *     either. This module only logs best-effort, non-secret status lines
 *     through an optional logger callback.
 *   - Helpers (`debounce`, `createAuthSyncWatcher`) are exported so tests
 *     can drive them with fake timers / injected bridge functions and
 *     override intervals to keep tests fast.
 */

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolveOpenCodeAuthPath, type BridgeResult } from "./auth-bridge.js";

/** A bridge function matching `bridgeOpenCodeAuthForProject`'s signature. */
export type BridgeFn = (
  projectRoot: string,
  extraProviderIds?: string[],
  options?: { force?: boolean; overwrite?: boolean; removeStale?: boolean },
) => Promise<BridgeResult>;

/** Logger callback: (level, message). Never throws. */
export type SyncLogger = (level: "info" | "warning" | "error", message: string) => void;

export interface AuthSyncWatcherOptions {
  /** Resolved OpenCode auth file path to watch. Defaults to the resolver. */
  openCodeAuthPath?: string;
  /** Debounce window in ms (default 800). */
  debounceMs?: number;
  /** Periodic fallback poll interval in ms (default 60000). 0 disables. */
  fallbackPollMs?: number;
  /** Inject a bridge function (tests). Defaults to the real bridge. */
  bridge?: BridgeFn;
  /** Inject a logger (tests / plugin). */
  logger?: SyncLogger;
  /** Extra provider IDs to pass to the bridge. */
  extraProviderIds?: string[];
  /** Project root required for the bridge. */
  projectRoot: string;
}

interface ActiveWatcher {
  watcher: FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  bridge: BridgeFn;
  logger: SyncLogger;
  projectRoot: string;
  extraProviderIds?: string[];
  debounceMs: number;
  lastHash: string;
  trigger: () => void;
  cancelDebounce: () => void;
  stopped: boolean;
}

// Module-level guard: one watcher per OpenCode auth path.
const activeWatchers = new Map<string, ActiveWatcher>();

/**
 * Compute a cheap non-secret hash of a file's (size, mtimeMs) tuple.
 * We do NOT read file contents here — the bridge already hashes contents
 * for change detection. The fallback poll only needs to know *that* the
 * file changed, cheaply.
 */
async function fileFingerprint(filePath: string): Promise<string> {
  try {
    const s = await stat(filePath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

/**
 * Create a debounced trigger that coalesces rapid fire fs.watch events into
 * a single bridge call after `wait` ms of quiet. Returns the trigger fn and
 * a cancel fn.
 *
 * Exported for unit testing with fake/real timers.
 */
export function debounce(
  wait: number,
  fn: () => Promise<void>,
): { trigger: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let pending = false;

  const run = async () => {
    timer = null;
    if (!pending) return;
    pending = false;
    try {
      await fn();
    } catch {
      /* best-effort; caller logs inside fn */
    }
  };

  const trigger = () => {
    pending = true;
    if (timer) return;
    timer = setTimeout(run, wait);
  };

  const cancel = () => {
    pending = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { trigger, cancel };
}

/**
 * Start (or reuse) a proactive auth sync watcher for the OpenCode auth file.
 *
 * Idempotent: if a watcher already exists for the resolved auth path, it is
 * reused (its extra provider ids / bridge / logger are refreshed).
 *
 * Returns a `stop` function. Calling it stops this watcher; if another
 * caller still holds a reference the module guard keeps it alive only until
 * `stopAuthSyncWatcher` is called for the path.
 */
export function createAuthSyncWatcher(
  opts: AuthSyncWatcherOptions,
): { stop: () => void; trigger: () => void } {
  const openCodeAuthPath = opts.openCodeAuthPath ?? resolveOpenCodeAuthPath();
  const debounceMs = opts.debounceMs ?? 800;
  const fallbackPollMs = opts.fallbackPollMs ?? 60000;
  const bridge = opts.bridge ?? defaultBridge;
  const logger: SyncLogger = opts.logger ?? (() => {});

  // Reuse existing watcher if present (avoid duplicate watchers).
  const existing = activeWatchers.get(openCodeAuthPath);
  if (existing && !existing.stopped) {
    // Refresh runtime inputs but keep the underlying watcher.
    (existing as any).bridge = bridge;
    (existing as any).logger = logger;
    (existing as any).projectRoot = opts.projectRoot;
    (existing as any).extraProviderIds = opts.extraProviderIds;
    return {
      stop: () => stopAuthSyncWatcher(openCodeAuthPath),
      trigger: existing.trigger,
    };
  }

  let active: ActiveWatcher;

  const runBridge = async (reason: string) => {
    try {
      const result = await bridge(opts.projectRoot, opts.extraProviderIds, {
        force: true,
        overwrite: true,
        removeStale: true,
      });
      if (result.authChanged) {
        const parts = [
          result.addedProviders.length ? `added=${result.addedProviders.join(",")}` : "",
          result.updatedProviders.length ? `updated=${result.updatedProviders.join(",")}` : "",
          result.removedProviders.length ? `removed=${result.removedProviders.join(",")}` : "",
        ].filter(Boolean).join(" ");
        logger("info", `Auth sync (${reason}): ${parts || "no changes"}`);
      }
      // Refresh fingerprint after a bridge run so we don't re-trigger on
      // our own write (the bridge writes Pi auth, not OpenCode auth, but
      // refreshing is still cheap and correct).
      active.lastHash = await fileFingerprint(openCodeAuthPath);
    } catch (err) {
      logger(
        "warning",
        `Auth sync (${reason}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const d = debounce(debounceMs, () => runBridge("watch"));

  active = {
    watcher: null,
    pollTimer: null,
    bridge,
    logger,
    projectRoot: opts.projectRoot,
    extraProviderIds: opts.extraProviderIds,
    debounceMs,
    lastHash: "",
    trigger: d.trigger,
    cancelDebounce: d.cancel,
    stopped: false,
  };
  activeWatchers.set(openCodeAuthPath, active);

  // Guarded trigger: no-ops once the watcher has been stopped so callers
  // holding a stale handle cannot re-arm the debounce after stop().
  const guardedTrigger = () => {
    if (!active.stopped) d.trigger();
  };
  active.trigger = guardedTrigger;

  // Capture initial fingerprint (best-effort, async).
  fileFingerprint(openCodeAuthPath).then((h) => {
    if (!active.stopped) active.lastHash = h;
  });

  // fs.watch (best-effort; may throw on missing file).
  try {
    active.watcher = watch(openCodeAuthPath, () => {
      guardedTrigger();
    });
    active.watcher.on("error", () => {
      // fs.watch errors (e.g. file deleted) are non-fatal; the fallback
      // poll + next bridge call will recover.
    });
    // Don't keep the event loop alive solely for this watcher. This matters
    // in production (so a idle plugin host can exit cleanly) and in tests
    // (so the test process does not hang on an unref'd fs.watch handle).
    if (active.watcher && typeof active.watcher.unref === "function") {
      active.watcher.unref();
    }
  } catch {
    active.watcher = null;
  }

  // Periodic fallback for platforms where fs.watch is unreliable.
  if (fallbackPollMs > 0) {
    active.pollTimer = setInterval(async () => {
      if (active.stopped) return;
      const h = await fileFingerprint(openCodeAuthPath);
      if (h !== active.lastHash) {
        active.lastHash = h;
        guardedTrigger();
      }
    }, fallbackPollMs);
    // Don't keep the event loop alive solely for this poll.
    if (active.pollTimer && typeof active.pollTimer.unref === "function") {
      active.pollTimer.unref();
    }
  }

  return {
    stop: () => stopAuthSyncWatcher(openCodeAuthPath),
    trigger: guardedTrigger,
  };
}

/**
 * Stop and dispose the watcher for a given OpenCode auth path (default: the
 * resolver path). Safe to call multiple times.
 */
export function stopAuthSyncWatcher(openCodeAuthPath?: string): void {
  const path = openCodeAuthPath ?? resolveOpenCodeAuthPath();
  const active = activeWatchers.get(path);
  if (!active) return;
  active.stopped = true;
  try { active.watcher?.close(); } catch { /* best-effort */ }
  if (active.pollTimer) {
    clearInterval(active.pollTimer);
    active.pollTimer = null;
  }
  active.cancelDebounce();
  activeWatchers.delete(path);
}

/**
 * Stop all active watchers (used by tests / plugin teardown).
 */
export function stopAllAuthSyncWatchers(): void {
  for (const path of [...activeWatchers.keys()]) {
    stopAuthSyncWatcher(path);
  }
}

// Default bridge is lazily imported to avoid a circular import at module
// load time (plugin.ts imports this module, this module imports bridge).
async function defaultBridge(
  projectRoot: string,
  extraProviderIds?: string[],
  options?: { force?: boolean; overwrite?: boolean; removeStale?: boolean },
): Promise<BridgeResult> {
  const { bridgeOpenCodeAuthForProject } = await import("./auth-bridge.js");
  return bridgeOpenCodeAuthForProject(projectRoot, extraProviderIds, options);
}

// Re-export for tests that want to await the debounce flush easily.
export { delay };
