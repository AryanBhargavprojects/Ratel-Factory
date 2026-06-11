import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
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
    // No git init here, and no explicit directory in requirements.json
    // so auto-discovery yields nothing and the server returns the graceful
    // non-git error.

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/diff`);
      assert.strictEqual(res.status, 200);

      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.diff, "");
      assert.strictEqual(parsed.status, "Not a git repository");
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

test("GET /api/mission returns mission state, requirements, and features", async () => {
  const tempDir = join(process.cwd(), "test-temp-mission-api");
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(join(tempDir, ".missions", "current"), { recursive: true });

  try {
    writeFileSync(join(tempDir, ".missions", "current", "state.json"), JSON.stringify({ phase: "testing" }), "utf-8");
    writeFileSync(join(tempDir, ".missions", "current", "requirements.json"), JSON.stringify({ goal: "verify dashboard" }), "utf-8");
    writeFileSync(join(tempDir, ".missions", "current", "features.json"), JSON.stringify({ features: [] }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/mission`);
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.state.phase, "testing");
      assert.strictEqual(parsed.requirements.goal, "verify dashboard");
    } finally {
      await serverHandle.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

const DASHBOARD_PATH = join(process.cwd(), "src", "observatory", "dashboard.html");

function getDashboardHtml(): string {
  return readFileSync(DASHBOARD_PATH, "utf-8");
}

test("dashboard is a single self-contained HTML file with inline CSS and JS", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("<!DOCTYPE html>"), "should be an HTML file");
  assert.ok(html.includes("<style>"), "should have inline CSS");
  assert.ok(html.includes("<script>"), "should have inline JS");

  // Must not reference external CSS files
  const externalCssRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']+["']/gi;
  assert.strictEqual(html.match(externalCssRegex)?.length ?? 0, 0, "should not reference external CSS files");

  // Must not reference external JS files
  const externalJsRegex = /<script[^>]*src=["'][^"']+["']/gi;
  assert.strictEqual(html.match(externalJsRegex)?.length ?? 0, 0, "should not reference external JS files");
});

test("dashboard has three vertical columns", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes('id="observatory-grid"'), "should contain #observatory-grid");
  assert.ok(html.includes('id="pane-orchestration"'), "should contain #pane-orchestration");
  assert.ok(html.includes('id="pane-worker"'), "should contain #pane-worker");
  assert.ok(html.includes('id="pane-validator"'), "should contain #pane-validator");
});

test("modal popup is removed", () => {
  const html = getDashboardHtml();
  assert.ok(!html.includes('id="modal"'), "should not have a modal element");
  assert.ok(!html.includes('class="hidden"'), "should not have hidden modal class");
});

test("dashboard background is black", () => {
  const html = getDashboardHtml();
  const bodyBgRegex = /body\s*\{[^}]*background:\s*#(000000|060608)/;
  const bodyBgRegex2 = /body\s*\{[^}]*background-color:\s*#(000000|060608)/;
  assert.ok(
    bodyBgRegex.test(html) || bodyBgRegex2.test(html),
    "body background should be #000000 or #060608"
  );
});

test("primary text is white", () => {
  const html = getDashboardHtml();
  const bodyColorRegex = /body\s*\{[^}]*color:\s*#(ffffff|e1e1e6)/;
  assert.ok(bodyColorRegex.test(html), "body text color should be #ffffff or #e1e1e6");
});

test("accent color is gray", () => {
  const html = getDashboardHtml();
  const accentRegex = /#8e8e93/;
  assert.ok(accentRegex.test(html), "should use #8e8e93 as an accent color");
});



test("diff parser function exists", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("parseUnifiedDiff"), "should have parseUnifiedDiff function");
});

test("diff hunk rendering function exists", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("renderDiff"), "should have renderDiff function");
});



test("diff viewer CSS includes green for additions", () => {
  const html = getDashboardHtml();
  const greenRegex = /#[37]fb950|#7ee787/;
  assert.ok(greenRegex.test(html), "should use green color (#3fb950 or #7ee787) for additions");
  assert.ok(html.includes('diff-line-add') || html.includes('diff-add') || html.includes("background") && greenRegex.test(html), "should have CSS selector or class for added lines");
});

test("diff viewer CSS includes red for deletions", () => {
  const html = getDashboardHtml();
  const redRegex = /#f85149|#ff7b72/;
  assert.ok(redRegex.test(html), "should use red color (#f85149 or #ff7b72) for deletions");
  assert.ok(html.includes('diff-line-del') || html.includes('diff-del') || html.includes("background") && redRegex.test(html), "should have CSS selector or class for deleted lines");
});

test("diff viewer CSS is neutral for context lines", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes('diff-line-ctx') || html.includes('diff-ctx'), "should have CSS selector or class for context lines");
});

test("diff line numbers rendering logic exists", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("diff-line-num"), "should have line number CSS class or element");
  assert.ok(html.includes("diff-old-num") || html.includes("oldNum"), "should reference old line numbers");
  assert.ok(html.includes("diff-new-num") || html.includes("newNum"), "should reference new line numbers");
});

test("diff polling interval is 1000ms", () => {
  const html = getDashboardHtml();
  const pollDiffRegex = /pollDiff[\s\S]*?setInterval\(\s*pollDiff\s*,\s*1000\s*\)/;
  const setIntervalRegex = /setInterval\([^,]*,\s*1000\s*\)/;
  assert.ok(pollDiffRegex.test(html) || setIntervalRegex.test(html), "should poll diff at 1000ms interval");
});

test("event polling interval remains 500ms", () => {
  const html = getDashboardHtml();
  const pollEventsRegex = /pollEvents[\s\S]*?setInterval\(\s*pollEvents\s*,\s*500\s*\)/;
  const setIntervalRegex = /setInterval\([^,]*,\s*500\s*\)/;
  assert.ok(pollEventsRegex.test(html) || setIntervalRegex.test(html), "should poll events at 500ms interval");
});



test("no modal element exists", () => {
  const html = getDashboardHtml();
  assert.ok(!html.includes('id="modal"'), "should not have a modal element");
});



test("dist/observatory/dashboard.html exists and matches src", () => {
  const srcPath = join(process.cwd(), "src", "observatory", "dashboard.html");
  const distPath = join(process.cwd(), "dist", "observatory", "dashboard.html");

  assert.strictEqual(existsSync(distPath), true, "dist/observatory/dashboard.html should exist after build");

  const srcContent = readFileSync(srcPath, "utf-8");
  const distContent = readFileSync(distPath, "utf-8");

  assert.strictEqual(distContent, srcContent, "copied file must be byte-for-byte identical to source");
});
