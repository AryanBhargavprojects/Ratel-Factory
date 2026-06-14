import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFile,
} from "../src/core/mission/atomic-file.js";

describe("atomic file", () => {
  it("atomicWriteFile writes readable content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ratel-atomic-"));
    const path = join(dir, "test.txt");
    await atomicWriteFile(path, "hello world");
    const content = await readFile(path, "utf-8");
    assert.strictEqual(content, "hello world");
    await rm(dir, { recursive: true, force: true });
  });

  it("atomicWriteJson writes JSON with trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ratel-atomic-"));
    const path = join(dir, "test.json");
    await atomicWriteJson(path, { a: 1 });
    const content = await readFile(path, "utf-8");
    assert.ok(content.endsWith("\n"), "JSON must end with newline");
    assert.deepStrictEqual(JSON.parse(content), { a: 1 });
    await rm(dir, { recursive: true, force: true });
  });

  it("readJsonFile returns undefined for missing file", async () => {
    const result = await readJsonFile("/nonexistent/path/file.json");
    assert.strictEqual(result, undefined);
  });

  it("readJsonFile parses existing JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ratel-atomic-"));
    const path = join(dir, "test.json");
    await atomicWriteJson(path, { b: 2 });
    const result = await readJsonFile<{ b: number }>(path);
    assert.deepStrictEqual(result, { b: 2 });
    await rm(dir, { recursive: true, force: true });
  });
});
