/**
 * Small keyed in-process mutex.
 * One daemon is the supported writer for a project root.
 * All file mutations for the same absolute path are serialized.
 */

const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  while (locks.has(filePath)) {
    await locks.get(filePath);
  }

  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  locks.set(filePath, promise);

  try {
    return await fn();
  } finally {
    locks.delete(filePath);
    resolve!();
  }
}
