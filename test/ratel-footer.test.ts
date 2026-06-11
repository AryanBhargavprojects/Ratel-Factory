import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  cleanModelName,
  formatTokens,
  sanitizeStatusText,
  setModelLevels,
  RatelTopWidget,
  RatelBottomWidget,
} from "../.pi/extensions/ratel-model.ts";
import { setCurrentDashboardUrl } from "../src/observatory/server.ts";

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
  const tempDir = join(process.cwd(), "test-temp-config");
  mkdirSync(tempDir, { recursive: true });
  
  try {
    const configPath = join(tempDir, "ratel.json");
    writeFileSync(configPath, JSON.stringify({}), "utf-8");

    await setModelLevels(tempDir, { orchestrator: "provider/orch-model" });
    let config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(config, {
      orchestrator: { model: "provider/orch-model" }
    });

    await setModelLevels(tempDir, { worker: null });
    config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(config, {
      orchestrator: { model: "provider/orch-model" },
      workers: { model: null }
    });

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

test("RatelTopWidget rendering", () => {
  const mockCtx = {
    ui: {
      theme: {
        fg: (style: string, text: string) => text,
      },
    },
  };

  const mockFooterData = {
    getExtensionStatuses: () => new Map([
      ["ratel-models", "ignored status"],
      ["other-extension", "running task 1\n\r\t  active  "],
    ]),
  };

  const topWidget = new RatelTopWidget(mockCtx, mockFooterData);
  const lines = topWidget.render(80);

  // Line 1: Status line from other extension sanitized
  // Line 2: Models in minimalist style (O/W/V and thin separators)
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /running task 1 active/);
  assert.match(lines[1], //);
  assert.match(lines[1], /⚙/);
  assert.match(lines[1], /🔍/);
  assert.match(lines[1], /default/);
});

test("RatelBottomWidget rendering", () => {
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
  };

  // Inject a dashboard URL so the widget renders the link (otherwise it hides
  // the link when no server is running).
  setCurrentDashboardUrl("http://localhost:9999");

  const bottomWidget = new RatelBottomWidget(mockCtx, mockFooterData);
  const lines = bottomWidget.render(80);

  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /localhost:9999/);
  assert.match(lines[0], /my-repo/);
  assert.match(lines[0], / main/);
  assert.match(lines[0], /󰘚 45\.2%\/128k/);
  assert.strictEqual(lines[0].includes("📁"), false);

  // Clean up so later tests are not affected.
  setCurrentDashboardUrl(undefined);
});
