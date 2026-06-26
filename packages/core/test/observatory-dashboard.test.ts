import { describe, it } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, "..", "src", "observatory", "dashboard.html");

async function readDashboardHtml(): Promise<string> {
  return readFile(DASHBOARD_HTML_PATH, "utf-8");
}

/** Required top-level element ids the dashboard JS depends on. */
const REQUIRED_ELEMENT_IDS = [
  "top-bar",
  "tab-bar",
  "content",
  "agent-tree",
  "activity-feed",
  "plan-doc",
  "approval-bar",
  "files-layout",
  "files-tree",
  "files-editor-body",
  "modal-overlay",
  "toast",
  "halt-banner",
];

const REQUIRED_TABS = ["live", "plan", "files"];

describe("Observatory dashboard structure (3-tab Live/Plan/Files)", () => {
  it("contains the required top-level DOM element ids", async () => {
    const html = await readDashboardHtml();
    for (const id of REQUIRED_ELEMENT_IDS) {
      const escId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`id=["']${escId}["']`);
      assert.ok(pattern.test(html), `Missing DOM element with id="${id}" in dashboard.html`);
    }
  });

  it("declares all three tab panes", async () => {
    const html = await readDashboardHtml();
    for (const tabId of REQUIRED_TABS) {
      const pattern = new RegExp(`data-pane=["']${tabId}["']`);
      assert.ok(pattern.test(html), `Missing tab pane with data-pane="${tabId}" in dashboard.html`);
    }
  });

  it("registers the three tabs in the tab bar", async () => {
    const html = await readDashboardHtml();
    for (const tab of REQUIRED_TABS) {
      const pattern = new RegExp(`class="tab[^"]*"[^>]*data-tab=["']${tab}["']`);
      assert.ok(pattern.test(html), `Missing tab with data-tab="${tab}" in dashboard.html`);
    }
  });

  it("has the agent tree container (#2)", async () => {
    const html = await readDashboardHtml();
    assert.ok(html.includes('id="agent-tree"'), "should have agent-tree container");
    assert.ok(html.includes("tree-node-dot"), "should have tree node dot CSS for glowing nodes");
    assert.ok(html.includes("@keyframes glow"), "should have glow animation for active nodes");
  });

  it("has the activity feed container (#3)", async () => {
    const html = await readDashboardHtml();
    assert.ok(html.includes('id="activity-feed"'), "should have activity-feed container");
    assert.ok(html.includes("activity-row"), "should have activity row CSS");
    assert.ok(html.includes("activity-cat"), "should have activity category CSS");
  });

  it("has the approval bar with Approve/Request-changes/Edit-draft (#4)", async () => {
    const html = await readDashboardHtml();
    assert.ok(html.includes('id="approval-bar"'), "should have approval-bar");
    assert.ok(html.includes('id="btn-approve"'), "should have approve button");
    assert.ok(html.includes('id="btn-request-changes"'), "should have request-changes button");
    assert.ok(html.includes('id="edit-toggle"'), "should have edit-draft toggle");
    assert.ok(html.includes('id="edit-panel"'), "should have edit panel for proposed amendments");
  });

  it("has the Files tab with tree + editor + save", async () => {
    const html = await readDashboardHtml();
    assert.ok(html.includes('id="files-layout"'), "should have files layout");
    assert.ok(html.includes('id="files-tree"'), "should have files tree");
    assert.ok(html.includes('id="files-editor-body"'), "should have files editor body");
    assert.ok(html.includes('id="btn-save-file"'), "should have save button");
    assert.ok(html.includes('id="btn-edit-file"'), "should have edit button");
  });

  it("is self-contained (no external CSS/JS)", async () => {
    const html = await readDashboardHtml();
    assert.ok(html.includes("<style>"), "should have inline CSS");
    assert.ok(html.includes("<script>"), "should have inline JS");
    assert.strictEqual((html.match(/<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']+["']/gi) || []).length, 0, "no external CSS");
    assert.strictEqual((html.match(/<script[^>]*src=["'][^"']+["']/gi) || []).length, 0, "no external JS");
  });

  it("every $-prefixed identifier referenced in the script is declared", async () => {
    const html = await readDashboardHtml();
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "dashboard.html must contain an inline <script> block");
    const script = scriptMatch![1];

    const declared = new Set<string>();
    for (const m of script.matchAll(/const\s+(\$[A-Za-z][A-Za-z0-9_]*)\s*=/g)) {
      declared.add(m[1]);
    }

    const referenced = new Set<string>();
    for (const m of script.matchAll(/(?<![A-Za-z0-9_])(\$[A-Za-z][A-Za-z0-9_]*)\b/g)) {
      referenced.add(m[1]);
    }

    const undeclared = [...referenced].filter((name) => !declared.has(name));
    assert.deepEqual(undeclared, [], `Undeclared $-identifiers: ${undeclared.join(", ")}`);
  });
});