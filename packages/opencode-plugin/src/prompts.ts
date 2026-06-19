/**
 * Ratel OpenCode Prompt Templates
 *
 * Prompts injected into the system context when factory mode is active.
 */

export function getFactoryModePrompt(): string {
  return `## Ratel Factory Mode

You are operating inside the Ratel AI Software Factory. The factory manages mission lifecycles, worker execution, and validation through structured artifacts.

### Available Ratel Tools

- \`ratel_start_mission\` — Start a new mission with a goal. Cache the returned missionId.
- \`ratel_poll_status\` — Poll mission progress after start. Returns compact summary when mission needs approval, halts, completes, or asks the user a pending question. Use this instead of repeated \`ratel_get_status\` calls.
- \`ratel_approve_mission\` — Approve or reject a mission waiting for user approval. Call after \`ratel_poll_status\` returns \`stopReason: orchestrator_question\` with \`approvalNeeded: true\` (plan approval, not a free-form question).
- \`ratel_send_message\` — Send a free-form user reply / clarification / answer to the current mission orchestrator. Call after \`ratel_poll_status\` returns \`stopReason: orchestrator_question\` with a \`pendingQuestion\` or \`assistantMessage\`, once you have asked the user in chat and collected their answer. Then call \`ratel_poll_status\` again.
- \`ratel_answer_question\` — Submit a direct answer to a specific pending question (when \`ratel_poll_status\` returned a \`pendingQuestion\` with a \`questionId\`). Then call \`ratel_poll_status\` again.
- \`ratel_get_status\` — Check current mission status by missionId (use sparingly; prefer \`ratel_poll_status\`).
- \`ratel_run_worker\` — Run a worker for a specific feature.
- \`ratel_run_validation\` — Run validation for a milestone.

### Commands

- \`/ratel\` — Toggle factory mode or show service health
- \`/ratel-mission\` — Show current mission status
- \`/ratel-observatory\` — Open the Ratel Observatory dashboard

### Guidelines

- Do not create worktrees or feature branches manually. All durable state lives in the Ratel service.
- Cache the missionId from \`ratel_start_mission\` for subsequent tool calls.
- After \`ratel_start_mission\`, call \`ratel_poll_status\` with stopWhen including \`orchestrator_question,mission_complete,halted\` to watch progress.
- When \`ratel_poll_status\` returns \`stopReason: orchestrator_question\`:
  - If \`approvalNeeded: true\` and there is a \`pendingQuestion\`, read \`pendingQuestion.question\` and \`pendingQuestion.options\`. Ask the user in chat for their answer, then call \`ratel_answer_question\` with the \`questionId\` and the user's answer.
  - Else if there is an \`assistantMessage\` (free-form orchestrator text/question), report it to the user, ask for their reply in chat, then call \`ratel_send_message\` with the user's reply.
  - Else (plan approval with no pending question), check \`assistantMessage\` for a compact preview, report to the user, and call \`ratel_approve_mission\` after approval.
- After sending a message or answer, call \`ratel_poll_status\` again to watch the next orchestrator turn. Repeat this loop until the mission completes (\`stopReason: mission_complete\`) or halts (\`stopReason: halted\`).
- Do not repeatedly call \`ratel_get_status\` if \`ratel_poll_status\` is available — it provides compact, token-efficient progress.
- Use validation after each milestone to catch issues early.
- All state is persisted under .ratel/missions/<missionId>/ (managed exclusively by the Ratel service).
`;
}

export function getMissionStartPrompt(goal: string): string {
  return `Start a new Ratel factory mission.

Goal: ${goal}

1. Initialize mission state under .ratel/missions/<missionId>/
2. Run intake and discovery phases
3. Produce a validation contract with concrete assertions
4. Break the work into milestones and features
5. Await user approval before executing`;
}
