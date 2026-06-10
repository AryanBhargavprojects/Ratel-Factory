/**
 * Ratel model configuration extension.
 *
 * Orchestrator model: handled by Pi's built-in /model and Ctrl+P — we just
 * sync the user's choice to ratel.json via the model_select event.
 *
 * Worker & Validator models: configured via /ratel-model command, which
 * shows a level picker (Worker/Validator/Confirm/Cancel), then opens Pi's
 * full ModelSelectorComponent (search, scroll, group by provider) for the
 * model selection itself. Persists to ratel.json.
 *
 * Status bar shows all three: O:model W:model V:model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────

interface ModelConfig {
  orchestrator: string | null;
  worker: string | null;
  validator: string | null;
}

interface RatelConfig {
  orchestrator?: { model?: string | null };
  workers?: { model?: string | null };
  validators?: { model?: string | null };
}

let cachedModelConfig: ModelConfig = {
  orchestrator: null,
  worker: null,
  validator: null,
};

// ── Config I/O (shared with src/config.ts, duplicated here for extension isolation) ──

async function readRatelConfig(cwd: string): Promise<RatelConfig> {
  try {
    const raw = await readFile(join(cwd, "ratel.json"), "utf-8");
    return JSON.parse(raw) as RatelConfig;
  } catch {
    return {};
  }
}

async function writeRatelConfig(cwd: string, config: RatelConfig): Promise<void> {
  const json = JSON.stringify(config, null, 2) + "\n";
  await writeFile(join(cwd, "ratel.json"), json, "utf-8");
}

async function getModelConfig(cwd: string): Promise<ModelConfig> {
  const config = await readRatelConfig(cwd);
  return {
    orchestrator: config.orchestrator?.model ?? null,
    worker: config.workers?.model ?? null,
    validator: config.validators?.model ?? null,
  };
}

async function setModelLevel(
  cwd: string,
  level: "orchestrator" | "worker" | "validator",
  model: string | null,
): Promise<void> {
  const config = await readRatelConfig(cwd);
  if (level === "orchestrator") {
    if (!config.orchestrator) config.orchestrator = {};
    config.orchestrator.model = model;
  } else if (level === "worker") {
    if (!config.workers) config.workers = {};
    config.workers.model = model;
  } else {
    if (!config.validators) config.validators = {};
    config.validators.model = model;
  }
  await writeRatelConfig(cwd, config);
}

function formatModel(model: string | null): string {
  return model ?? "SDK default";
}

function formatForStatusBar(config: ModelConfig): string {
  return `O:${formatModel(config.orchestrator)} W:${formatModel(config.worker)} V:${formatModel(config.validator)}`;
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Sync orchestrator model to ratel.json when user changes it via /model or Ctrl+P ──
  pi.on("model_select", async (event, ctx) => {
    const modelStr = `${event.model.provider}/${event.model.id}`;
    await setModelLevel(ctx.cwd, "orchestrator", modelStr);
    cachedModelConfig.orchestrator = modelStr;

    const config = await getModelConfig(ctx.cwd);
    ctx.ui.setStatus("ratel-models", formatForStatusBar(config));
    ctx.ui.notify(`Orchestrator model synced: ${modelStr}`, "info");
  });

  // ── /ratel-model command for worker & validator ────────────────────────
  pi.registerCommand("ratel-model", {
    description: "Configure worker and validator models",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const pending: ModelConfig = await getModelConfig(cwd);

      while (true) {
        const options = [
          `\u{1F527} Worker: ${formatModel(pending.worker)}`,
          `\u{1F50D} Validator: ${formatModel(pending.validator)}`,
          "",
          "\u2705 Confirm & Save",
          "\u274C Cancel",
        ];

        // Add a "Clear" option for each level if it currently has a model set.
        // ModelSelectorComponent doesn't expose an explicit "SDK default" choice,
        // so users need a way to reset to null from the level picker.
        if (pending.worker !== null) {
          options.push("\u{1F5D1} Clear Worker (use SDK default)");
        }
        if (pending.validator !== null) {
          options.push("\u{1F5D1} Clear Validator (use SDK default)");
        }

        const choice = await ctx.ui.select("Worker & Validator Models", options);

        if (!choice || choice === "\u274C Cancel") {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        if (choice === "\u2705 Confirm & Save") {
          await setModelLevel(cwd, "worker", pending.worker);
          await setModelLevel(cwd, "validator", pending.validator);
          cachedModelConfig.worker = pending.worker;
          cachedModelConfig.validator = pending.validator;

          const finalConfig = await getModelConfig(cwd);
          ctx.ui.setStatus("ratel-models", formatForStatusBar(finalConfig));
          ctx.ui.notify(
            `Saved — Worker: ${formatModel(finalConfig.worker)}, Validator: ${formatModel(finalConfig.validator)}`,
            "info",
          );
          return;
        }

        // Clear a level (reset to SDK default)
        if (choice.startsWith("\u{1F5D1} Clear Worker")) {
          pending.worker = null;
          ctx.ui.notify("Worker cleared — will use SDK default", "info");
          continue;
        }
        if (choice.startsWith("\u{1F5D1} Clear Validator")) {
          pending.validator = null;
          ctx.ui.notify("Validator cleared — will use SDK default", "info");
          continue;
        }

        // Pick model for the selected level using Pi's full ModelSelectorComponent
        // (search, scroll, group by provider, keyboard navigation).
        const selectedLevel: "worker" | "validator" = choice.startsWith("\u{1F527}") ? "worker" : "validator";
        const levelLabel = selectedLevel === "worker" ? "Worker" : "Validator";

        // Resolve the currently configured model so the selector highlights it.
        const currentModelStr = pending[selectedLevel];
        let currentModel: any | undefined;
        if (currentModelStr) {
          const [provider, ...rest] = currentModelStr.split("/");
          const id = rest.join("/");
          currentModel = ctx.modelRegistry.find(provider, id);
        }

        const selectedModel = await ctx.ui.custom<any | null>(
          (tui, _theme, _keybindings, done) => {
            // Stub settingsManager — we persist to ratel.json ourselves, not to
            // Pi's settings. ModelSelectorComponent only calls
            // setDefaultModelAndProvider in handleSelect, which we no-op here.
            const stubSettingsManager = {
              setDefaultModelAndProvider: () => {},
            } as any;

            const selector = new ModelSelectorComponent(
              tui,
              currentModel,
              stubSettingsManager,
              ctx.modelRegistry,
              [], // no scoped models — we want the full registry
              (model: any) => done(model), // user selected a model
              () => done(null),             // user cancelled
            );
            selector.focused = true;
            return selector;
          },
        );

        if (!selectedModel) {
          continue; // Cancelled or backed out — return to level picker
        }

        const modelStr = `${selectedModel.provider}/${selectedModel.id}`;
        pending[selectedLevel] = modelStr;

        ctx.ui.notify(
          `${levelLabel} \u2192 ${modelStr}. Pick another or confirm.`,
          "info",
        );
      }
    },
  });

  // ── Show status bar on session start ────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const config = await getModelConfig(ctx.cwd);
    cachedModelConfig.orchestrator = config.orchestrator;
    cachedModelConfig.worker = config.worker;
    cachedModelConfig.validator = config.validator;
    ctx.ui.setStatus("ratel-models", formatForStatusBar(config));
  });
}