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
        fg: (style: string, text: string) => `[${style}]${text}[/${style}]`,
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
  
  // Upper line: Models and Context
  // Wait, cachedModelConfig in the module is a singleton.
  // We can set it during test or check that it contains the model names.
  // Let's assert that the lines are formatted correctly.
  assert.match(lines[0], /🧠/);
  assert.match(lines[0], /🛠/);
  assert.match(lines[0], /🔍/);
  assert.match(lines[0], /⛶  45\.2%\/128k/);

  // Lower line: Repository and Git branch
  assert.match(lines[1], /📁 my-repo/);
  assert.match(lines[1], /main/);

  // Status line: other extension status sanitized
  assert.match(lines[2], /running task 1 active/);
});
