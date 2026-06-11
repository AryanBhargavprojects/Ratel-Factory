import type { Feature } from "../types.js";
import { readFeatureFile } from "../artifacts.js";

export interface FeatureAssertionSelection {
  kind: "full-file" | "scenario";
  reference: string;
  selector?: string;
}

export interface FeatureAssertionDocument {
  reference: string;
  filename: string;
  selection: FeatureAssertionSelection;
  content: string;
}

export interface ResolvedFeatureAssertions {
  featureId: string;
  documents: FeatureAssertionDocument[];
  missing: string[];
}

function parseReference(reference: string): { filename: string; selector?: string } | undefined {
  const match = reference.match(/([^\s:()]+\.feature)(?::\s*(.+))?/);
  if (!match) return undefined;
  return {
    filename: match[1],
    selector: match[2]?.trim(),
  };
}

function normalizeScenarioName(value: string): string {
  return value
    .trim()
    .replace(/^Scenario(?: Outline)?:\s*/i, "")
    .trim()
    .toLowerCase();
}

function isScenarioLine(line: string): boolean {
  return /^\s*Scenario(?: Outline)?:\s*/.test(line);
}

function isBlockBoundary(line: string): boolean {
  return /^\s*(Rule:|Scenario(?: Outline)?:)\s*/.test(line);
}

function extractBackground(lines: string[]): string[] {
  const start = lines.findIndex((line) => /^\s*Background:\s*/.test(line));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlockBoundary(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

function findParentRule(lines: string[], scenarioStart: number): string | undefined {
  for (let i = scenarioStart - 1; i >= 0; i--) {
    if (/^\s*Rule:\s*/.test(lines[i])) return lines[i];
    if (/^\s*Feature:\s*/.test(lines[i])) return undefined;
  }
  return undefined;
}

function extractScenario(featureText: string, selector: string): string | undefined {
  const lines = featureText.split("\n");
  const wanted = normalizeScenarioName(selector);
  const scenarioStart = lines.findIndex((line) => isScenarioLine(line) && normalizeScenarioName(line) === wanted);
  if (scenarioStart < 0) return undefined;

  let scenarioEnd = lines.length;
  for (let i = scenarioStart + 1; i < lines.length; i++) {
    if (isBlockBoundary(lines[i])) {
      scenarioEnd = i;
      break;
    }
  }

  const featureHeader = lines.find((line) => /^\s*Feature:\s*/.test(line));
  const background = extractBackground(lines);
  const parentRule = findParentRule(lines, scenarioStart);
  const scenario = lines.slice(scenarioStart, scenarioEnd);

  return [
    featureHeader,
    background.length > 0 ? background.join("\n") : undefined,
    parentRule,
    scenario.join("\n"),
  ].filter(Boolean).join("\n\n");
}

export async function resolveFeatureAssertions(cwd: string, feature: Feature): Promise<ResolvedFeatureAssertions> {
  const documents: FeatureAssertionDocument[] = [];
  const missing: string[] = [];

  for (const reference of feature.assertions) {
    const parsed = parseReference(reference);
    if (!parsed) {
      missing.push(reference);
      continue;
    }

    const fileText = await readFeatureFile(cwd, parsed.filename);
    if (!fileText) {
      missing.push(reference);
      continue;
    }

    if (parsed.selector) {
      const scenario = extractScenario(fileText, parsed.selector);
      if (!scenario) {
        missing.push(reference);
        continue;
      }
      documents.push({
        reference,
        filename: parsed.filename,
        selection: { kind: "scenario", reference, selector: parsed.selector },
        content: scenario,
      });
      continue;
    }

    documents.push({
      reference,
      filename: parsed.filename,
      selection: { kind: "full-file", reference },
      content: fileText,
    });
  }

  return { featureId: feature.id, documents, missing };
}

export interface FeatureComplexity {
  featureId: string;
  assertionCount: number;
  featureFileCount: number;
  scenarioCount: number;
  totalLinesOfGherkin: number;
}

export async function computeFeatureComplexity(
  cwd: string,
  feature: Feature,
): Promise<FeatureComplexity> {
  const resolved = await resolveFeatureAssertions(cwd, feature);

  const distinctFilenames = new Set<string>();
  let scenarioCount = 0;
  let totalLinesOfGherkin = 0;

  for (const doc of resolved.documents) {
    distinctFilenames.add(doc.filename);
    if (doc.selection.kind === "scenario") {
      scenarioCount++;
    }
    totalLinesOfGherkin += doc.content.split("\n").length;
  }

  return {
    featureId: feature.id,
    assertionCount: feature.assertions.length,
    featureFileCount: distinctFilenames.size,
    scenarioCount,
    totalLinesOfGherkin,
  };
}

export function formatFeatureAssertionsForPrompt(resolved: ResolvedFeatureAssertions): string {
  const lines: string[] = [
    "These acceptance criteria are authoritative. Implement only the feature scope needed to satisfy them.",
  ];

  if (resolved.documents.length === 0) {
    lines.push("No concrete assertion documents were resolved for this feature.");
  }

  for (const document of resolved.documents) {
    const label = document.selection.kind === "scenario"
      ? `${document.filename} (${document.selection.selector})`
      : document.filename;
    lines.push("", `### ${label}`, "```gherkin", document.content.trim(), "```");
  }

  if (resolved.missing.length > 0) {
    lines.push("", "Missing assertion references:");
    for (const reference of resolved.missing) {
      lines.push(`- ${reference}`);
    }
    lines.push("Do not silently infer missing acceptance criteria; report the missing references in the handoff if they block implementation.");
  }

  return lines.join("\n");
}
