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

const cachedModelConfig: ModelConfig = {
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

export function cleanModelName(modelStr: string | null): string {
  if (!modelStr) return "default";
  const slashIndex = modelStr.indexOf("/");
  if (slashIndex >= 0) {
    return modelStr.slice(slashIndex + 1);
  }
  return modelStr;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export async function setModelLevels(
  cwd: string,
  updates: { orchestrator?: string | null; worker?: string | null; validator?: string | null },
): Promise<void> {
  const config = await readRatelConfig(cwd);
  if (updates.orchestrator !== undefined) {
    if (!config.orchestrator) config.orchestrator = {};
    config.orchestrator.model = updates.orchestrator;
  }
  if (updates.worker !== undefined) {
    if (!config.workers) config.workers = {};
    config.workers.model = updates.worker;
  }
  if (updates.validator !== undefined) {
    if (!config.validators) config.validators = {};
    config.validators.model = updates.validator;
  }
  await writeRatelConfig(cwd, config);
}

function formatModel(model: string | null): string {
  return model ?? "SDK default";
}

function formatForStatusBar(config: ModelConfig): string {
  return `O:${formatModel(config.orchestrator)} W:${formatModel(config.worker)} V:${formatModel(config.validator)}`;
}

export class RatelFooterComponent {
  constructor(private ctx: any, private footerData: any) {}

  render(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const sepStr = theme.fg("dim", " > ");

    // Get model names
    const oModel = cleanModelName(cachedModelConfig.orchestrator);
    const wModel = cleanModelName(cachedModelConfig.worker);
    const vModel = cleanModelName(cachedModelConfig.validator);

    // Get context usage info
    const contextUsage = this.ctx.getContextUsage();
    const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
      ? `${contextUsage.percent.toFixed(1)}%`
      : "?%";
    const contextWindow = contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
    const contextWindowStr = formatTokens(contextWindow);

    // 1. Upper Line: Models and Context
    const modelSection = [
      `🧠 ${oModel}`,
      `🛠 ${wModel}`,
      `🔍 ${vModel}`,
      `⛶  ${contextPercent}/${contextWindowStr}`
    ].join(sepStr);

    const upperLine = truncateToWidth(modelSection, width, theme.fg("dim", "..."));

    // 2. Lower Line: Repository and Git Branch
    const repoName = basename(this.ctx.cwd);
    const branch = this.footerData.getGitBranch() ?? "no branch";
    const repoSection = `📁 ${repoName}${sepStr} ${branch}`;
    const lowerLine = truncateToWidth(repoSection, width, theme.fg("dim", "..."));

    const lines = [upperLine, lowerLine];

    // 3. Optional Status Line (e.g., questions / task updates)
    const extensionStatuses = this.footerData.getExtensionStatuses();
    if (extensionStatuses.size > 0) {
      const sortedStatuses = Array.from(extensionStatuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key !== "ratel-models") // Skip our own status key
        .map(([_, text]) => sanitizeStatusText(text));
      
      if (sortedStatuses.length > 0) {
        const statusLine = sortedStatuses.join(" ");
        lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
      }
    }

    return lines;
  }
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Sync orchestrator model to ratel.json when user changes it via /model or Ctrl+P ──
  pi.on("model_select", async (event, ctx) => {
    const modelStr = `${event.model.provider}/${event.model.id}`;
    await setModelLevels(ctx.cwd, { orchestrator: modelStr });

    cachedModelConfig.orchestrator = modelStr;
    ctx.ui.setStatus("ratel-models", formatForStatusBar(cachedModelConfig));
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
          await setModelLevels(cwd, {
            worker: pending.worker,
            validator: pending.validator,
          });

          cachedModelConfig.worker = pending.worker;
          cachedModelConfig.validator = pending.validator;

          ctx.ui.setStatus("ratel-models", formatForStatusBar(cachedModelConfig));
          ctx.ui.notify(
            `Saved — Worker: ${formatModel(cachedModelConfig.worker)}, Validator: ${formatModel(cachedModelConfig.validator)}`,
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
    Object.assign(cachedModelConfig, config);
    ctx.ui.setStatus("ratel-models", formatForStatusBar(cachedModelConfig));
    ctx.ui.setFooter((_tui, _theme, footerData) => new RatelFooterComponent(ctx, footerData));
  });
}