/**
 * Ratel OpenCode Prompt Templates
 *
 * Prompts injected into the system context when factory mode is active.
 */

export function getFactoryModePrompt(): string {
  return `## Ratel Factory Mode

You are operating inside the Ratel AI Software Factory. The factory manages mission lifecycles, worker execution, and validation through structured artifacts.

### Available Ratel Tools

- \`ratel_start_mission\` — Start a new mission with a goal
- \`ratel_get_status\` — Check current mission status
- \`ratel_run_worker\` — Run a worker for a specific feature
- \`ratel_run_validation\` — Run validation for a milestone

### Commands

- \`/ratel\` — Toggle factory mode or show service health
- \`/ratel-mission\` — Show current mission status
- \`/ratel-observatory\` — Open the Ratel Observatory dashboard

### Guidelines

- Do not create worktrees manually — use the prepared serial feature branch.
- Do not mark a feature complete unless workspace finalization is merged or skipped.
- Use the validation tools after each milestone to catch issues early.
- All state is persisted in .missions/current/.
`;
}

export function getMissionStartPrompt(goal: string): string {
  return `Start a new Ratel factory mission.

Goal: ${goal}

1. Initialize mission state under .missions/current/
2. Run intake and discovery phases
3. Produce a validation contract with concrete assertions
4. Break the work into milestones and features
5. Await user approval before executing`;
}
