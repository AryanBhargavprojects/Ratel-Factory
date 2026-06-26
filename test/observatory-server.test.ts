import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { request } from "node:http";

import { startDashboardServerOnAvailablePort } from "../packages/core/src/observatory/server.ts";

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

function httpPost(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let resBody = "";
        res.on("data", (chunk) => { resBody += chunk; });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: resBody,
          });
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// /api/diff
// ---------------------------------------------------------------------------

test("GET /api/diff returns JSON with diff and status for a git workspace", async () => {
  const tempDir = join(process.cwd(), "test-temp-diff-repo");
  mkdirSync(tempDir, { recursive: true });

  try {
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    writeFileSync(join(tempDir, "file.txt"), "initial", "utf-8");
    execSync("git add file.txt", { cwd: tempDir });
    execSync("git commit -m 'init'", { cwd: tempDir });
    execSync("git branch -m integration", { cwd: tempDir });

    writeFileSync(join(tempDir, "file.txt"), "modified", "utf-8");
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
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
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
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("GET /api/diff returns graceful error when workspace is not a git repository", async () => {
  const tempDir = join(process.cwd(), "test-temp-nogit");
  mkdirSync(tempDir, { recursive: true });

  try {
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
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("OPTIONS /api/diff returns CORS headers", async () => {
  const tempDir = join(process.cwd(), "test-temp-cors");
  mkdirSync(tempDir, { recursive: true });

  try {
    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpOptions(`${serverHandle.url}/api/diff`);
      assert.strictEqual(res.status, 204);

      assert.strictEqual(res.headers["access-control-allow-origin"], "*");
      assert.strictEqual(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    } finally {
      await serverHandle.close();
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// /api/status (new aggregated snapshot)
// ---------------------------------------------------------------------------

test("GET /api/status returns a mission snapshot with mode and actionsAvailable", async () => {
  const tempDir = join(process.cwd(), "test-temp-status-api");
  mkdirSync(tempDir, { recursive: true });

  try {
    // Seed a current-mission pointer + minimal state
    mkdirSync(join(tempDir, ".ratel", "missions", "mis_teststatus0001"), { recursive: true });
    writeFileSync(join(tempDir, ".ratel", "current-mission.json"), JSON.stringify({ missionId: "mis_teststatus0001" }), "utf-8");
    writeFileSync(
      join(tempDir, ".ratel", "missions", "mis_teststatus0001", "state.json"),
      JSON.stringify({ phase: "intake", version: 1, updatedAt: new Date().toISOString() }),
      "utf-8",
    );

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/status?missionId=mis_teststatus0001`);
      assert.strictEqual(res.status, 200);

      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.missionId, "mis_teststatus0001");
      assert.strictEqual(parsed.phase, "intake");
      assert.ok(typeof parsed.actionsAvailable === "boolean");
      assert.ok(["service", "in-process", "none"].includes(parsed.mode));
      assert.ok(Array.isArray(parsed.agents));
      assert.ok(Array.isArray(parsed.recommendedActions));
    } finally {
      await serverHandle.close();
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// /api/artifacts (new bundle endpoint)
// ---------------------------------------------------------------------------

test("GET /api/artifacts returns the artifact bundle", async () => {
  const tempDir = join(process.cwd(), "test-temp-artifacts-api");
  mkdirSync(tempDir, { recursive: true });

  try {
    mkdirSync(join(tempDir, ".ratel", "missions", "mis_testart0001"), { recursive: true });
    writeFileSync(join(tempDir, ".ratel", "current-mission.json"), JSON.stringify({ missionId: "mis_testart0001" }), "utf-8");
    writeFileSync(
      join(tempDir, ".ratel", "missions", "mis_testart0001", "requirements.json"),
      JSON.stringify({ goal: "test", productIntent: "intent", nonGoals: [], riskTolerance: "low" }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, ".ratel", "missions", "mis_testart0001", "constraints.md"),
      "# Constraints\n- none",
      "utf-8",
    );

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpGet(`${serverHandle.url}/api/artifacts?missionId=mis_testart0001`);
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.requirements.goal, "test");
      assert.ok(parsed.constraints.includes("Constraints"));
    } finally {
      await serverHandle.close();
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// /api/artifact POST (single write path, #4)
// ---------------------------------------------------------------------------

test("POST /api/artifact writes an allowlisted artifact atomically", async () => {
  const tempDir = join(process.cwd(), "test-temp-artifact-write");
  mkdirSync(tempDir, { recursive: true });

  try {
    mkdirSync(join(tempDir, ".ratel", "missions", "mis_testwrite001"), { recursive: true });
    writeFileSync(join(tempDir, ".ratel", "current-mission.json"), JSON.stringify({ missionId: "mis_testwrite001" }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpPost(`${serverHandle.url}/api/artifact`, {
        missionId: "mis_testwrite001",
        filename: "constraints.md",
        content: "# Updated constraints\n- rule one",
      });
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.ok, true);
      assert.strictEqual(parsed.artifact, "constraints.md");

      const written = readFileSync(join(tempDir, ".ratel", "missions", "mis_testwrite001", "constraints.md"), "utf-8");
      assert.ok(written.includes("Updated constraints"));
    } finally {
      await serverHandle.close();
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("POST /api/artifact rejects a non-allowlisted filename", async () => {
  const tempDir = join(process.cwd(), "test-temp-artifact-reject");
  mkdirSync(tempDir, { recursive: true });

  try {
    mkdirSync(join(tempDir, ".ratel", "missions", "mis_testrej0001"), { recursive: true });
    writeFileSync(join(tempDir, ".ratel", "current-mission.json"), JSON.stringify({ missionId: "mis_testrej0001" }), "utf-8");

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpPost(`${serverHandle.url}/api/artifact`, {
        missionId: "mis_testrej0001",
        filename: "../../../etc/passwd",
        content: "bad",
      });
      assert.strictEqual(res.status, 403);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.gated, true);
    } finally {
      await serverHandle.close();
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// /api/features POST (gate blocks integrated/validated, #6)
// ---------------------------------------------------------------------------

test("POST /api/features blocks direct transition to integrated", async () => {
  const tempDir = join(process.cwd(), "test-temp-features-gate");
  mkdirSync(tempDir, { recursive: true });

  try {
    mkdirSync(join(tempDir, ".ratel", "missions", "mis_testfg0001"), { recursive: true });
    writeFileSync(join(tempDir, ".ratel", "current-mission.json"), JSON.stringify({ missionId: "mis_testfg0001" }), "utf-8");
    // Seed a pending feature
    writeFileSync(
      join(tempDir, ".ratel", "missions", "mis_testfg0001", "features.json"),
      JSON.stringify({ features: [{ id: "F1", title: "T", description: "D", assertions: [], milestoneId: "M1", status: "pending" }] }),
      "utf-8",
    );

    const serverHandle = await startDashboardServerOnAvailablePort({ cwd: tempDir, port: 0, host: "127.0.0.1" });
    try {
      const res = await httpPost(`${serverHandle.url}/api/features`, {
        missionId: "mis_testfg0001",
        features: [{ id: "F1", title: "T", description: "D", assertions: [], milestoneId: "M1", status: "integrated" }],
      });
      assert.strictEqual(res.status, 403);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.gated, true);
      assert.ok(parsed.error.includes("integrated"));
    } finally {
      await serverHandle.close();
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// Dashboard HTML structure
// ---------------------------------------------------------------------------

const DASHBOARD_PATH = join(process.cwd(), "packages", "core", "src", "observatory", "dashboard.html");

function getDashboardHtml(): string {
  return readFileSync(DASHBOARD_PATH, "utf-8");
}

test("dashboard is a single self-contained HTML file with inline CSS and JS", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("<!DOCTYPE html>"), "should be an HTML file");
  assert.ok(html.includes("<style>"), "should have inline CSS");
  assert.ok(html.includes("<script>"), "should have inline JS");

  const externalCssRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']+["']/gi;
  assert.strictEqual(html.match(externalCssRegex)?.length ?? 0, 0, "should not reference external CSS files");

  const externalJsRegex = /<script[^>]*src=["'][^"']+["']/gi;
  assert.strictEqual(html.match(externalJsRegex)?.length ?? 0, 0, "should not reference external JS files");
});

test("dashboard has the three tabs", () => {
  const html = getDashboardHtml();
  for (const tab of ["live", "plan", "files"]) {
    assert.ok(html.includes(`data-tab="${tab}"`), `should contain tab "${tab}"`);
  }
});

test("dashboard Plan tab is a single scrollable document with sections", () => {
  const html = getDashboardHtml();
  // Plan tab has no sub-tabs — it is one document with section headings
  assert.ok(!html.includes("data-subtab"), "should not have sub-tab attributes");
  // Assert the four section containers exist
  assert.ok(html.includes('id="plan-context"'), "should have plan-context section");
  assert.ok(html.includes('id="plan-contract"'), "should have plan-contract section");
  assert.ok(html.includes('id="plan-features"'), "should have plan-features section");
  assert.ok(html.includes('id="plan-milestones"'), "should have plan-milestones section");
  // Assert the section header labels
  assert.ok(html.includes(">Context<"), "should have Context section header");
  assert.ok(html.includes(">Validation Contract<"), "should have Validation Contract section header");
  assert.ok(html.includes(">Features<"), "should have Features section header");
  assert.ok(html.includes(">Milestones<"), "should have Milestones section header");
});

test("dashboard background is dark", () => {
  const html = getDashboardHtml();
  const bodyBgRegex = /body\s*\{[^}]*background:\s*#(000000|060608)/;
  const bodyBgRegex2 = /body\s*\{[^}]*background-color:\s*#(000000|060608)/;
  assert.ok(
    bodyBgRegex.test(html) || bodyBgRegex2.test(html),
    "body background should be #000000 or #060608"
  );
});

test("dashboard primary text is light", () => {
  const html = getDashboardHtml();
  const bodyColorRegex = /body\s*\{[^}]*color:\s*#(ffffff|e1e1e6)/;
  assert.ok(bodyColorRegex.test(html), "body text color should be #ffffff or #e1e1e6");
});

test("dashboard has a modal for detail views", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes('id="modal-overlay"'), "should have a modal overlay element");
  assert.ok(html.includes('id="modal-body"'), "should have a modal body element");
});

test("dashboard has a toast for feedback", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes('id="toast"'), "should have a toast element");
});

test("dashboard polls live tab with setInterval", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("setInterval"), "should use setInterval for polling");
  assert.ok(html.includes("renderLive"), "should call renderLive in the polling loop");
});

test("dashboard has mode-aware approval bar (approve/request-changes)", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes('id="btn-approve"'), "should have approve button");
  assert.ok(html.includes('id="btn-request-changes"'), "should have request-changes button");
  assert.ok(html.includes('id="approval-hint"'), "should have approval hint element");
  assert.ok(html.includes("actionsAvailable"), "should check actionsAvailable state");
});