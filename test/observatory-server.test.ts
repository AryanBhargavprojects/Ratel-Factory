import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { request } from "node:http";

import { startDashboardServerOnAvailablePort } from "../src/observatory/server.ts";

function httpGet(url: string): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpOptions(url: string): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "OPTIONS" }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/diff returns JSON with diff and status for a git workspace", async () => {
  const tempDir = join(process.cwd(), "test-temp-diff-repo");
  mkdirSync(tempDir, { recursive: true });

  try {
    // Initialize a git repo on the integration branch
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    writeFileSync(join(tempDir, "file.txt"), "initial", "utf-8");
    execSync("git add file.txt", { cwd: tempDir });
    execSync("git commit -m 'init'", { cwd: tempDir });
    execSync("git branch -m integration", { cwd: tempDir });

    // Make a change
    writeFileSync(join(tempDir, "file.txt"), "modified", "utf-8");

    // Point requirements.json to this directory explicitly
    writeFileSync(join(tempDir, "requirements.json"), JSON.stringify({ directory: tempDir }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/diff`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers["content-type"], "application/json");

      const parsed = JSON.parse(res.body);
      assert.ok(typeof parsed.diff === "string", "diff should be a string");
      assert.ok(typeof parsed.status === "string", "status should be a string");
      assert.ok(parsed.diff.includes("modified"), "diff should reflect the actual change");
      assert.ok(parsed.status.includes("file.txt"), "status should indicate the modified file");
      assert.deepStrictEqual(Object.keys(parsed).sort(), ["diff", "status"]);
    } finally {
      await serverHandle.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("GET /api/diff returns empty diff when workspace is clean", async () => {
  const tempDir = join(process.cwd(), "test-temp-clean-repo");
  mkdirSync(tempDir, { recursive: true });

  try {
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    writeFileSync(join(tempDir, "file.txt"), "content", "utf-8");
    execSync("git add file.txt", { cwd: tempDir });
    execSync("git commit -m 'init'", { cwd: tempDir });
    execSync("git branch -m integration", { cwd: tempDir });

    writeFileSync(join(tempDir, "requirements.json"), JSON.stringify({ directory: tempDir }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/diff`);
      assert.strictEqual(res.status, 200);

      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.diff, "");
      assert.ok(typeof parsed.status === "string");
    } finally {
      await serverHandle.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("GET /api/diff returns graceful error when workspace is not a git repository", async () => {
  const tempDir = join(process.cwd(), "test-temp-nogit");
  mkdirSync(tempDir, { recursive: true });

  try {
    // No git init here
    writeFileSync(join(tempDir, "requirements.json"), JSON.stringify({ directory: tempDir }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/diff`);
      assert.strictEqual(res.status, 200);

      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.diff, "");
      assert.ok(typeof parsed.status === "string");
      assert.ok(parsed.status.length > 0, "status should contain an error message");
    } finally {
      await serverHandle.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("GET /api/diff ignores malicious path parameters", async () => {
  const tempDir = join(process.cwd(), "test-temp-malicious");
  mkdirSync(tempDir, { recursive: true });

  try {
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    writeFileSync(join(tempDir, "file.txt"), "initial", "utf-8");
    execSync("git add file.txt", { cwd: tempDir });
    execSync("git commit -m 'init'", { cwd: tempDir });
    execSync("git branch -m integration", { cwd: tempDir });

    writeFileSync(join(tempDir, "requirements.json"), JSON.stringify({ directory: tempDir }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      // Inject shell characters via path
      const res = await httpGet(`${serverHandle.url}/api/diff;rm -rf /`);
      assert.strictEqual(res.status, 200);

      const parsed = JSON.parse(res.body);
      assert.ok(typeof parsed.diff === "string");
      assert.ok(typeof parsed.status === "string");
      // The file should still exist, meaning rm -rf / was NOT executed
      assert.strictEqual(existsSync(join(tempDir, "file.txt")), true);
    } finally {
      await serverHandle.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("OPTIONS /api/diff returns CORS headers", async () => {
  const tempDir = join(process.cwd(), "test-temp-cors");
  mkdirSync(tempDir, { recursive: true });

  try {
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    writeFileSync(join(tempDir, "file.txt"), "initial", "utf-8");
    execSync("git add file.txt", { cwd: tempDir });
    execSync("git commit -m 'init'", { cwd: tempDir });
    execSync("git branch -m integration", { cwd: tempDir });

    writeFileSync(join(tempDir, "requirements.json"), JSON.stringify({ directory: tempDir }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpOptions(`${serverHandle.url}/api/diff`);
      assert.strictEqual(res.status, 204);

      const allowOrigin = res.headers["access-control-allow-origin"];
      const allowMethods = res.headers["access-control-allow-methods"];
      assert.strictEqual(allowOrigin, "*");
      assert.strictEqual(allowMethods, "GET, OPTIONS");
    } finally {
      await serverHandle.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
