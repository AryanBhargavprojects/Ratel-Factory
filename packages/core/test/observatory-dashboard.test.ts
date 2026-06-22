import { describe, it } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, "..", "src", "observatory", "dashboard.html");

/**
 * Regression test for the Observatory dashboard rendering bug.
 *
 * Symptom: loading http://localhost:8765/ in a browser with existing events
 * produced console errors:
 *   - `Failed to poll events: ReferenceError: $paneOrchestration is not defined`
 *   - `Failed to poll diffs: ReferenceError: $bodyWorkerDiff is not defined`
 *
 * Root cause: the inline `<script>` in dashboard.html declares a "DOM
 * references" section that wires `const $foo = document.getElementById('foo')`
 * for many elements, but omitted the declarations for the pane/body elements
 * that `processEvents()` and `pollDiff()` reference. As a result `pollEvents()`
 * threw a ReferenceError before it could render the Orchestration pane, and
 * `pollDiff()` threw a ReferenceError before it could update `#body-worker-diff`.
 *
 * This test statically asserts that every DOM element id used by the event/diff
 * rendering path has a matching `const $var = document.getElementById('id')`
 * declaration, so a future regression cannot silently drop one of these refs.
 */

async function readDashboardHtml(): Promise<string> {
  return readFile(DASHBOARD_HTML_PATH, "utf-8");
}

/** Map of { variableName: elementId } that MUST be declared in the DOM refs section. */
const REQUIRED_DOM_REFS: Record<string, string> = {
  $paneOrchestration: "pane-orchestration",
  $bodyOrchestration: "body-orchestration",
  $paneWorker: "pane-worker",
  $badgeWorker: "badge-worker",
  $bodyWorker: "body-worker",
  $containerWorkerDiff: "container-worker-diff",
  $bodyWorkerDiff: "body-worker-diff",
  $paneValidator: "pane-validator",
  $badgeValidator: "badge-validator",
  $bodyValidator: "body-validator",
};

describe("Observatory dashboard DOM references", () => {
  it("declares every required DOM reference used by processEvents/pollDiff", async () => {
    const html = await readDashboardHtml();

    for (const [varName, elementId] of Object.entries(REQUIRED_DOM_REFS)) {
      // The declaration must wire the variable to the element id, e.g.
      //   const $paneOrchestration = document.getElementById('pane-orchestration');
      // Escape regex metacharacters (notably `$` in the var name) in both sides.
      const escVar = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escId = elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `const\\s+${escVar}\\s*=\\s*document\\.getElementById\\(\\s*['"]${escId}['"]\\s*\\)`,
      );
      assert.ok(
        pattern.test(html),
        `Missing DOM reference declaration: expected \`const ${varName} = document.getElementById('${elementId}');\` in dashboard.html`,
      );
    }
  });

  it("every $-prefixed identifier referenced in the script is declared", async () => {
    const html = await readDashboardHtml();

    // Pull out the inline script body so we only look at JS, not the markup.
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "dashboard.html must contain an inline <script> block");
    const script = scriptMatch![1];

    // Find every `const $foo = ...` declaration in the script.
    const declared = new Set<string>();
    for (const m of script.matchAll(/const\s+(\$[A-Za-z][A-Za-z0-9_]*)\s*=/g)) {
      declared.add(m[1]);
    }

    // Find every `$foo` identifier referenced anywhere in the script, and
    // require each one to be declared. This catches the exact class of bug
    // that caused `$paneOrchestration is not defined`.
    const referenced = new Set<string>();
    for (const m of script.matchAll(/(?<![A-Za-z0-9_])(\$[A-Za-z][A-Za-z0-9_]*)\b/g)) {
      referenced.add(m[1]);
    }

    const undeclared = [...referenced].filter((name) => !declared.has(name));
    assert.deepEqual(
      undeclared,
      [],
      `The dashboard script references $-identifiers that are never declared: ${undeclared.join(", ")}`,
    );
  });

  it("the required DOM element ids exist in the HTML markup", async () => {
    const html = await readDashboardHtml();
    for (const elementId of Object.values(REQUIRED_DOM_REFS)) {
      const escId = elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`id=["']${escId}["']`);
      assert.ok(
        pattern.test(html),
        `Missing DOM element with id="${elementId}" in dashboard.html`,
      );
    }
  });
});