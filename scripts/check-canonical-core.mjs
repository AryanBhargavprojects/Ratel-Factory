#!/usr/bin/env node
/**
 * Architecture guard: ensures packages/core/src/core/ and packages/core/src/observatory/
 * are the ONLY canonical core implementations.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());

let failed = false;

function fail(msg) {
  console.error("FAIL:", msg);
  failed = true;
}

// 1. Check src/core and src/observatory exist
if (existsSync(join(ROOT, "src", "core"))) {
  fail("src/core/ exists — must be deleted after porting to packages/core/src/core/");
}
if (existsSync(join(ROOT, "src", "observatory"))) {
  fail("src/observatory/ exists — must be deleted after porting to packages/core/src/observatory/");
}

// 2. Check for forbidden imports in TypeScript files under packages/, .pi/, test/, package.json
async function* walk(dir, includeJson = false) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const name = entry.name;
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      yield* walk(path, includeJson);
    } else if (entry.isFile()) {
      const isTs = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".js") || entry.name.endsWith(".jsx") || entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs");
      if (isTs || (includeJson && entry.name.endsWith(".json"))) {
        yield path;
      }
    }
  }
}

const forbiddenPatterns = [
  // Match import/require statements that reference root src/core or src/observatory
  // Skip plain text strings by requiring import/require syntax
  // Exclude paths that go through packages/core/src/ (canonical package)
  { source: /src\/core/, exclude: /packages\/core\/src\/core/ },
  { source: /\.\.\/\.\.\/core/, exclude: null },      // ../../core
  { source: /src\/observatory/, exclude: /packages\/core\/src\/observatory/ },       // root src/observatory
];

const scanDirs = [
  join(ROOT, "packages"),
  join(ROOT, ".pi"),
  join(ROOT, "test"),
];

for (const scanDir of scanDirs) {
  if (!existsSync(scanDir)) continue;
  for await (const path of walk(scanDir)) {
    const rel = path.slice(ROOT.length + 1);
    const text = await readFile(path, "utf-8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.source.test(text)) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (pattern.source.test(line) && (!pattern.exclude || !pattern.exclude.test(line))) {
            // Only flag actual import/require lines, not prose strings
            const isImportLine = /(?:^\s*import\s|^\s*from\s|require\()/.test(line);
            if (isImportLine) {
              fail(`${rel}:${i + 1} contains forbidden import matching ${pattern.source.source}`);
            }
          }
        }
      }
    }
  }
}

// Also check package.json for forbidden references
const packageJsonPath = join(ROOT, "package.json");
if (existsSync(packageJsonPath)) {
  const text = await readFile(packageJsonPath, "utf-8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.source.test(text)) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pattern.source.test(line) && (!pattern.exclude || !pattern.exclude.test(line))) {
          fail(`package.json:${i + 1} contains forbidden reference matching ${pattern.source.source}`);
        }
      }
    }
  }
}

// 3. Check that packages/core/src/core exists and no other production core dir exists
const canonicalCore = join(ROOT, "packages", "core", "src", "core");
const canonicalObservatory = join(ROOT, "packages", "core", "src", "observatory");

if (!existsSync(canonicalCore)) {
  fail("Canonical core directory packages/core/src/core/ is missing");
}
if (!existsSync(canonicalObservatory)) {
  fail("Canonical observatory directory packages/core/src/observatory/ is missing");
}

// Check for any other production core directory
const possibleCoreDirs = [
  join(ROOT, "src", "core"),
  join(ROOT, "src", "observatory"),
];

for (const dir of possibleCoreDirs) {
  if (existsSync(dir)) {
    const s = await stat(dir);
    if (s.isDirectory()) {
      fail(`Duplicate production core directory exists: ${dir}`);
    }
  }
}

if (failed) {
  console.error("\nArchitecture guard failed. Fix the issues above.");
  process.exit(1);
} else {
  console.log("OK: Canonical core architecture is clean.");
  process.exit(0);
}
