import { writeFile, rename, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomically write a text file.
 * Write to a temp file, fsync, rename over destination, fsync parent dir.
 * Clean up temp file on failure.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tempPath, content, "utf-8");
    const fd = await open(tempPath, "r+");
    await fd.sync();
    await fd.close();
    await rename(tempPath, filePath);
    const dirFd = await open(dir, "r");
    await dirFd.sync();
    await dirFd.close();
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
