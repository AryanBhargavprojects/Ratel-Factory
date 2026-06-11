import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  loadSkillsFromDir as loadPiSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_ORCHESTRATOR_SKILLS_DIR = ".pi/skills";

export async function loadSkillsFromDir(
  cwd: string,
  relativeDir: string,
): Promise<Skill[]> {
  const root = resolve(cwd, relativeDir);

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  return loadPiSkillsFromDir({
    dir: root,
    source: "ratel-orchestrator-default",
  }).skills;
}
