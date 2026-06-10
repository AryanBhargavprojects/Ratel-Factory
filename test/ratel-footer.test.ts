import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// We will import the functions and component from the extension file.
// Since we are running in tsx, it will load the ts file directly.
import {
  cleanModelName,
  formatTokens,
  sanitizeStatusText,
  setModelLevels,
  RatelFooterComponent,
} from "../.pi/extensions/ratel-model.ts";

test("cleanModelName helper", () => {
  assert.strictEqual(cleanModelName("anthropic/claude-3-5-sonnet"), "claude-3-5-sonnet");
  assert.strictEqual(cleanModelName("default"), "default");
  assert.strictEqual(cleanModelName(null), "default");
  assert.strictEqual(cleanModelName("openai/gpt-4o"), "gpt-4o");
});

test("formatTokens helper", () => {
  assert.strictEqual(formatTokens(950), "950");
  assert.strictEqual(formatTokens(1500), "1.5k");
  assert.strictEqual(formatTokens(45000), "45k");
  assert.strictEqual(formatTokens(2300000), "2.3M");
  assert.strictEqual(formatTokens(12000000), "12M");
});

test("sanitizeStatusText helper", () => {
  assert.strictEqual(
    sanitizeStatusText("hello\r\n\tworld   foo"),
    "hello world foo"
  );
  assert.strictEqual(
    sanitizeStatusText("   already   clean   "),
    "already clean"
  );
});

test("setModelLevels refactoring", async () => {
  // Use a temporary folder for ratel.json config test
  const tempDir = join(process.cwd(), "test-temp-config");
  mkdirSync(tempDir, { recursive: true });
  
  try {
    const configPath = join(tempDir, "ratel.json");
    // Initial config: all missing or empty
    writeFileSync(configPath, JSON.stringify({}), "utf-8");

    // 1. Update only orchestrator
    await setModelLevels(tempDir, { orchestrator: "provider/orch-model" });
    let config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(config, {
      orchestrator: { model: "provider/orch-model" }
    });

    // 2. Update worker with null (SDK default)
    await setModelLevels(tempDir, { worker: null });
    config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(config, {
      orchestrator: { model: "provider/orch-model" },
      workers: { model: null }
    });

    // 3. Update validator and orchestrator (confirming orchestrator isn't overwritten if validator is updated)
    await setModelLevels(tempDir, { validator: "provider/val-model" });
    config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(config, {
      orchestrator: { model: "provider/orch-model" },
      workers: { model: null },
      validators: { model: "provider/val-model" }
    });
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("RatelFooterComponent rendering", () => {
  // Mock ctx and footerData
  const mockCtx = {
    ui: {
      theme: {
        fg: (style: string, text: string) => text,
      },
    },
    cwd: "/path/to/my-repo",
    getContextUsage: () => ({
      percent: 45.2,
      contextWindow: 128000,
    }),
    model: {
      contextWindow: 128000,
    },
  };

  const mockFooterData = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([
      ["ratel-models", "ignored status"],
      ["other-extension", "running task 1\n\r\t  active  "],
    ]),
  };

  const footer = new RatelFooterComponent(mockCtx, mockFooterData);
  const lines = footer.render(80);

  // Assert line counts and format
  assert.strictEqual(lines.length, 3);
  
  // Status line: other extension status sanitized (now rendered first, above the footer)
  assert.match(lines[0], /running task 1 active/);

  // Upper footer line: Models in Agnoster bar style (O:, W:, V:, and  transition)
  assert.match(lines[1], /O: default/);
  assert.match(lines[1], /W: default/);
  assert.match(lines[1], /V: default/);
  assert.match(lines[1], //);

  // Lower footer line: Repository, Git branch, and Context window (using Nerd Font icons, no 📁)
  assert.match(lines[2], /my-repo/);
  assert.match(lines[2], / main/);
  assert.match(lines[2], /󰘚 45\.2%\/128k/);
  assert.strictEqual(lines[2].includes("📁"), false);
});
