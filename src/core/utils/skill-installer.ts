/**
 * Skill auto-discovery and installation for the Ratel factory.
 *
 * When the orchestrator identifies a tech stack (Next.js, Drizzle, etc.),
 * it lists framework-specific skills in worker-skills.json. If those skills
 * don't exist locally, this module searches the skills.sh registry and installs
 * them automatically — no manual intervention required.
 *
 * Philosophy (Pi-style): give the model rope. The agent decides what skills
 * it needs; the harness handles the bookkeeping of fetching them.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { loadSkillsFromDir, DEFAULT_ORCHESTRATOR_SKILLS_DIR } from "./skills.js";

const execAsync = promisify(exec);

/** Result of checking whether requested skills exist locally. */
export interface SkillCheckResult {
  /** Skills that exist in .pi/skills/ or the global skills dir. */
  found: string[];
  /** Skills that are missing and need installation. */
  missing: string[];
}

/** Result of attempting to install a single skill. */
export interface SkillInstallResult {
  /** The skill name that was requested. */
  requested: string;
  /** Whether installation succeeded. */
  success: boolean;
  /** The canonical name the skill was installed under (may differ from requested). */
  installedName?: string;
  /** Human-readable explanation. */
  message: string;
  /** Error detail if success is false. */
  error?: string;
}

/**
 * Check which of the requested skills already exist locally.
 * Searches .pi/skills/ (project-local) and ~/.pi/agent/skills/ (global).
 */
export async function checkSkillsExist(
  skillNames: string[],
  cwd: string,
): Promise<SkillCheckResult> {
  const found: string[] = [];
  const missing: string[] = [];

  // Load all locally available skills
  const localSkills = await loadSkillsFromDir(cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  const localNames = new Set(localSkills.map((s) => s.name));

  // Also check global skills dir
  const globalSkillsDir = join(process.env.HOME ?? "~", ".pi", "agent", "skills");
  let globalNames = new Set<string>();
  try {
    const globalSkills = await loadSkillsFromDir(globalSkillsDir, ".");
    globalNames = new Set(globalSkills.map((s) => s.name));
  } catch {
    /* global dir may not exist */
  }

  for (const name of skillNames) {
    if (localNames.has(name) || globalNames.has(name)) {
      found.push(name);
    } else {
      missing.push(name);
    }
  }

  return { found, missing };
}

/**
 * Parse the ANSI-colored output of `npx skills find` into structured results.
 * The CLI prints lines like:
 *   owner/repo@skill-name  15.7K installs
 *   └ https://skills.sh/owner/repo/skill-name
 */
function parseSkillsFindOutput(stdout: string): Array<{
  packageSpec: string;
  name: string;
  installs: string;
}> {
  const lines = stdout.split("\n");
  const results: Array<{ packageSpec: string; name: string; installs: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match package spec and install count: "owner/repo@skill-name  15.7K installs"
    const match = line.match(/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)@([a-zA-Z0-9_-]+)\s+([\d.]+[KkMm]? installs)/);
    if (match) {
      results.push({
        packageSpec: `${match[1]}@${match[2]}`,
        name: match[2],
        installs: match[3],
      });
    }
  }

  return results;
}

/**
 * Search the skills.sh registry for a skill matching the given name.
 * Returns the top result with metadata, or null if nothing found.
 */
export async function searchSkillRegistry(
  query: string,
): Promise<{ packageSpec: string; name: string; installs: string; source: string } | null> {
  try {
    const { stdout } = await execAsync(`npx skills find ${query}`, {
      timeout: 30000,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", TERM: "dumb" },
    });

    const results = parseSkillsFindOutput(stdout);
    if (results.length === 0) return null;

    // Return the top result (first = best match from CLI)
    const top = results[0];
    return {
      packageSpec: top.packageSpec,
      name: top.name,
      installs: top.installs,
      source: `https://skills.sh/${top.packageSpec.split("@")[0]}/${top.name}`,
    };
  } catch {
    return null;
  }
}

/**
 * Install a skill from the registry using `npx skills add`.
 * Installs globally so all agents can use it.
 */
export async function installSkill(packageSpec: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr } = await execAsync(`npx skills add ${packageSpec} -g -y`, {
      timeout: 60000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    if (stderr && stderr.includes("error")) {
      return { success: false, error: stderr.trim() };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ensure a list of skills are available, installing any that are missing.
 *
 * This is the main entry point used by the `ensure_skills_installed` tool.
 */
export async function ensureSkillsInstalled(
  skillNames: string[],
  cwd: string,
): Promise<{ requested: string[]; found: string[]; installed: SkillInstallResult[] }> {
  const check = await checkSkillsExist(skillNames, cwd);
  const installed: SkillInstallResult[] = [];

  for (const missing of check.missing) {
    // Search registry for best match
    const registryResult = await searchSkillRegistry(missing);

    if (!registryResult) {
      installed.push({
        requested: missing,
        success: false,
        message: `No skill found in registry matching "${missing}".`,
        error: "Search returned no results.",
      });
      continue;
    }

    // Install the skill
    const installResult = await installSkill(registryResult.packageSpec);

    if (installResult.success) {
      installed.push({
        requested: missing,
        success: true,
        installedName: registryResult.name,
        message: `Installed ${registryResult.name} from ${registryResult.source} (${registryResult.installs} installs).`,
      });
    } else {
      installed.push({
        requested: missing,
        success: false,
        message: `Failed to install skill matching "${missing}".`,
        error: installResult.error,
      });
    }
  }

  return {
    requested: skillNames,
    found: check.found,
    installed,
  };
}
