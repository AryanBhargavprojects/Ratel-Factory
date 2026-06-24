import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRawOutput } from "../src/core/utils/jsonl.js";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";

describe("writeRawOutput", () => {
  async function setupScope() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-jsonl-"));
    const scope = createMissionScope(projectRoot, "mis_jsonl_0001");
    return { projectRoot, scope };
  }

  it("writes a flat filename to the top dir", async () => {
    const { projectRoot, scope } = await setupScope();
    await writeRawOutput(scope, "raw", "report.jsonl", "line-one\n");
    const raw = await readFile(join(getMissionDir(scope), "raw", "report.jsonl"), "utf-8");
    assert.strictEqual(raw, "line-one\n");
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("writes a nested filename creating full parent directories", async () => {
    const { projectRoot, scope } = await setupScope();
    // Mirrors the user-testing-coordinator raw output convention:
    //   writeRawOutput(scope, "validation-reports", `user-testing-shards/${runId}/${shardId}.raw.txt`, ...)
    await writeRawOutput(
      scope,
      "validation-reports",
      "user-testing-shards/mis_jsonl_0001/shard_001.raw.txt",
      "shard-raw-content\n",
    );
    const raw = await readFile(
      join(
        getMissionDir(scope),
        "validation-reports",
        "user-testing-shards",
        "mis_jsonl_0001",
        "shard_001.raw.txt",
      ),
      "utf-8",
    );
    assert.strictEqual(raw, "shard-raw-content\n");
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("writes deeply nested filename creating all parent directories", async () => {
    const { projectRoot, scope } = await setupScope();
    await writeRawOutput(
      scope,
      "shards",
      "a/b/c/output.txt",
      "deep\n",
    );
    const raw = await readFile(
      join(getMissionDir(scope), "shards", "a", "b", "c", "output.txt"),
      "utf-8",
    );
    assert.strictEqual(raw, "deep\n");
    await rm(projectRoot, { recursive: true, force: true });
  });
});
