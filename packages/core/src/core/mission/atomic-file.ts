import { writeFile, rename, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * fsync error codes that indicate the filesystem does not support fsync
 * (or does not support fsync on this object type). These are treated as
 * non-fatal: the write/rename still provides atomicity; only durability is
 * lost, which is acceptable on cloud-sync (OneDrive/Dropbox), network
 * mounts (NFS/SMB), and virtual/FUSE filesystems.
 */
const FSYNC_IGNORE_CODES = new Set([
  "EPERM",   // Windows + OneDrive cloud-filter reparse point
  "EINVAL",  // NFS / some FUSE mounts rejecting fsync
  "ENOSYS",  // Filesystem does not implement fsync
  "ENOTSUP", // Operation not supported (some macOS network mounts)
]);

/**
 * Best-effort fsync of a file descriptor. Ignores error codes that indicate
 * the filesystem doesn't support fsync. Other errors (EBADF, EIO) rethrow.
 */
async function syncFd(fd: import("node:fs/promises").FileHandle): Promise<void> {
  try {
    await fd.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && FSYNC_IGNORE_CODES.has(code)) return;
    throw err;
  }
}

/**
 * Best-effort fsync of the parent directory for durability of the rename.
 * Directory fsync is unsupported on many filesystems (Windows, some network
 * mounts) and is treated as optional.
 */
async function syncDir(dir: string): Promise<void> {
  let dirFd: import("node:fs/promises").FileHandle | undefined;
  try {
    dirFd = await open(dir, "r");
    await syncFd(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EISDIR/EACCES on some platforms when opening a dir for "r+"; EPERM
    // on OneDrive. All non-fatal for durability.
    if (code && (FSYNC_IGNORE_CODES.has(code) || code === "EISDIR" || code === "EACCES")) return;
    throw err;
  } finally {
    if (dirFd) await dirFd.close().catch(() => {});
  }
}

/**
 * Atomically write a text file.
 * Write to a temp file, fsync (best-effort), rename over destination,
 * fsync parent dir (best-effort). Clean up temp file on failure.
 *
 * Atomicity (the rename) is always guaranteed. Durability (fsync) is
 * best-effort: on filesystems that reject fsync (OneDrive, NFS, FUSE),
 * the write still succeeds — only crash-durability is relaxed.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tempPath, content, "utf-8");
    const fd = await open(tempPath, "r+");
    await syncFd(fd);
    await fd.close();
    await rename(tempPath, filePath);
    await syncDir(dir);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Atomically write a JSON file.
 * JSON must end with a trailing newline.
 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2) + "\n";
  await atomicWriteFile(filePath, json);
}

/**
 * Read and parse a JSON file.
 * Returns undefined if the file does not exist or is not valid JSON.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
