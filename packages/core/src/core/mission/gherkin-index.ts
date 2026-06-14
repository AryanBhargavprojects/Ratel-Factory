/**
 * Deterministic Gherkin feature file indexer.
 * Extracts feature name, rule names, scenario names, and scenario outline names.
 * Ignores comments and blank lines. Rejects duplicate scenario names within same file.
 */

export interface GherkinFeatureIndex {
  filename: string;
  featureName: string;
  scenarios: Array<{ name: string; rule?: string; outline: boolean }>;
}

/**
 * Parse a single .feature file content and return a deterministic index.
 * @throws Error if duplicate scenario names exist within the same file.
 */
export function indexGherkinFeature(filename: string, content: string): GherkinFeatureIndex {
  const lines = content.split("\n");
  let featureName = "";
  let currentRule: string | undefined;
  const scenarios: Array<{ name: string; rule?: string; outline: boolean }> = [];
  const seenNames = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const featureMatch = line.match(/^Feature:\s*(.+)$/i);
    if (featureMatch) {
      featureName = featureMatch[1].trim();
      continue;
    }

    const ruleMatch = line.match(/^Rule:\s*(.+)$/i);
    if (ruleMatch) {
      currentRule = ruleMatch[1].trim();
      continue;
    }

    const scenarioMatch = line.match(/^Scenario:\s*(.+)$/i);
    if (scenarioMatch) {
      const name = scenarioMatch[1].trim();
      if (seenNames.has(name)) {
        throw new Error(`Duplicate scenario name "${name}" in ${filename}`);
      }
      seenNames.add(name);
      scenarios.push({ name, rule: currentRule, outline: false });
      continue;
    }

    const outlineMatch = line.match(/^Scenario Outline:\s*(.+)$/i);
    if (outlineMatch) {
      const name = outlineMatch[1].trim();
      if (seenNames.has(name)) {
        throw new Error(`Duplicate scenario name "${name}" in ${filename}`);
      }
      seenNames.add(name);
      scenarios.push({ name, rule: currentRule, outline: true });
      continue;
    }
  }

  return { filename, featureName, scenarios };
}
