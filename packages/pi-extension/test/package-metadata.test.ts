/**
 * Tests for package metadata and Pi manifest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = join(here, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<string, unknown>;

describe("package.json — publishability", () => {
  it("is not private", () => {
    assert.notEqual(pkg.private, true, "private:true blocks publishing");
  });

  it("has version 0.2.2", () => {
    assert.equal(pkg.version, "0.2.2");
  });

  it("has publishConfig access public", () => {
    assert.deepEqual(pkg.publishConfig, { access: "public" });
  });

  it("has the pi-package keyword", () => {
    const keywords = (pkg.keywords as string[]) ?? [];
    assert.ok(keywords.includes("pi-package"), "must include pi-package keyword");
  });

  it("declares a pi manifest pointing at dist + skills", () => {
    const pi = pkg.pi as { extensions?: string[]; skills?: string[] } | undefined;
    assert.ok(pi, "pi manifest must exist");
    assert.ok(pi.extensions?.includes("./dist/index.js"), "pi.extensions must include ./dist/index.js");
    assert.ok(pi.skills?.includes("./skills"), "pi.skills must include ./skills");
  });

  it("main + exports point at dist/index.js", () => {
    assert.equal(pkg.main, "dist/index.js");
    const exports = pkg.exports as Record<string, { import?: string }>;
    assert.equal(exports["."]?.import, "./dist/index.js");
  });

  it("files whitelist includes dist and skills", () => {
    const files = (pkg.files as string[]) ?? [];
    assert.ok(files.includes("dist/"), "files must include dist/");
    assert.ok(files.includes("skills/"), "files must include skills/");
  });

  it("has a prepack/build script", () => {
    const scripts = pkg.scripts as Record<string, string>;
    assert.equal(typeof scripts.build, "string");
    assert.equal(scripts.prepack, "npm run build");
  });

  it("declares pi-coding-agent as a peer dependency", () => {
    const peers = pkg.peerDependencies as Record<string, string> | undefined;
    assert.ok(peers?.["@earendil-works/pi-coding-agent"], "pi-coding-agent must be a peer dependency");
  });

  it("declares @ratel-factory/core as a publishable semver runtime dependency", () => {
    const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
    const coreRange = deps["@ratel-factory/core"];
    assert.ok(coreRange, "@ratel-factory/core must be declared as a runtime dependency");
    assert.ok(
      /^\^?\d/.test(coreRange),
      "@ratel-factory/core must be a publishable semver range, not a workspace '*'",
    );
    assert.notEqual(coreRange, "*", "@ratel-factory/core must not use workspace '*' range");
  });
});
