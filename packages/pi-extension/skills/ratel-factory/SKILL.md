---
name: ratel-factory
description: Ratel AI Software Factory integration for the Pi Coding Agent. Use when the user wants to run autonomous, end-to-end software development missions through Ratel — starting a mission, polling progress, answering orchestrator questions, approving plans, running workers/validators, and opening the Observatory dashboard. Triggers on "ratel", "factory mission", "start a mission", "approve the plan", "ratel observatory", or any reference to the Ratel tools registered by the @ratel-factory/pi-extension.
---

# Ratel Factory (Pi Coding Agent Extension)

You are running inside the **Pi Coding Agent** with the **Ratel Factory** native extension (`@ratel-factory/pi-extension`) installed. Ratel is an AI Software Factory that orchestrates specialised LLM agents to plan, implement, and validate software missions while keeping all durable state on disk.

This extension is a **thin adapter**. It registers Pi-native commands, tools, and lifecycle hooks. The Ratel orchestrator runs **in-process** inside the Pi session via `@ratel-factory/core` — there is no separate daemon and no out-of-band process to start. All durable mission/job/event state lives under `.ratel/missions/<missionId>/` in the project, read and written directly through core's mission/event helpers.

## When to use this skill

Use the Ratel tools/commands when the user wants to:

- Kick off an autonomous software factory mission from a goal.
- Check on a running mission's progress.
- Answer a question the orchestrator asked during intake/discovery.
- Approve (or reject) a generated plan/contract.
- Run a worker for a specific feature, or run validation for a milestone.
- Ping factory subagents to verify health.
- Open the Observatory dashboard.

## The mission loop (Pi-native)

1. **Start**: call `ratel_start_mission` with the user's goal. Cache the returned `missionId` and `jobId`.
2. **Poll**: call `ratel_poll_status` with `stopWhen=orchestrator_question,mission_complete,halted` (the default). It returns a *compact* summary — never a raw event dump — so Pi chat context stays lean.
3. **React to the stop reason**:
   - `stopReason: orchestrator_question` **with a `pendingQuestion`**: read `pendingQuestion.question` and `pendingQuestion.options`. Ask the user in chat for their answer, then call `ratel_answer_question` with the `questionId` and the user's answer.
   - `stopReason: orchestrator_question` **with an `assistantMessage` and no `pendingQuestion`**: report the message to the user, ask for their reply, then call `ratel_reply_to_factory` with their reply.
   - `stopReason: orchestrator_question` **with `approvalNeeded: true` and no pending question**: report the plan to the user, then call `ratel_approve_plan` once they approve (or reject with `approved: false`).
4. **Continue**: after answering/approving/replying, call `ratel_poll_status` again to watch the next orchestrator turn. Repeat until `stopReason: mission_complete` or `stopReason: halted`.
5. **Execute**: when the user wants to drive a specific feature/milestone, call `ratel_run_feature_worker` / `ratel_run_validation` and poll again.

## Pi slash commands

- `/ratel` — show in-process factory availability and ping factory agents.
- `/ratel-start <goal>` — start a new mission from a goal.
- `/ratel-status` — show the current mission's compact status (`/ratel-mission` is an alias).
- `/ratel-approve` — approve the current mission waiting for approval.
- `/ratel-observatory` — open the Ratel Observatory dashboard URL.

## Tools

Canonical tools (use these names):

| Tool | Purpose |
|---|---|
| `ratel_start_mission` | Start a mission from a goal. |
| `ratel_poll_status` | Compact progress polling with stop conditions. |
| `ratel_get_status` | One-off mission status (use sparingly). |
| `ratel_approve_plan` | Approve/reject a mission waiting for approval. |
| `ratel_answer_question` | Answer a specific pending orchestrator question. |
| `ratel_reply_to_factory` | Send a free-form user reply to the orchestrator. |
| `ratel_run_feature_worker` | Run a worker for a feature. |
| `ratel_run_validation` | Run validation for a milestone. |
| `ratel_ping_agents` | Ping all factory subagent roles. |

Compatibility aliases (older names that delegate to the same in-process logic):

| Alias | Canonical |
|---|---|
| `ratel_approve_mission` | `ratel_approve_plan` |
| `ratel_send_message` | `ratel_reply_to_factory` |
| `ratel_run_worker` | `ratel_run_feature_worker` |
| `ratel_run_validator` | `ratel_run_validation` |

## Polling details

`ratel_poll_status` accepts:

- `missionId` (required)
- `intervalSeconds` — default 10, clamped to **[1, 60]**.
- `timeoutSeconds` — default 300, clamped to **[1, 300]**.
- `stopWhen` — comma-separated: `orchestrator_question`, `phase_change`, `mission_complete`, `halted`. (`job_complete` is unsupported and silently ignored.)

The compact response includes: `missionId`, `stopReason`, `approvalNeeded`, `latestStatus`, `eventsSeen`, `nextAfter`, `elapsedSeconds`, `intervalSeconds`, `timeoutSeconds`, `matchedEvents` (last 5), and optional `assistantMessage` / `pendingQuestion`. It never includes the raw full event array.

## In-process runtime

On session start the extension resolves the project root and constructs a `RatelRuntime` that drives `@ratel-factory/core`'s orchestrator directly inside the Pi session. There is no separate daemon to start, discover, or keep healthy. The runtime restores any persisted current-mission id from `.ratel/current-mission.json` for UI continuity and disposes the orchestrator on session shutdown.

Mutating tools (`ratel_start_mission`, `ratel_run_feature_worker`, `ratel_run_validation`) call into the in-process orchestrator directly and are never blocked by a missing external process.

## Constraints

- **No manual worktrees/branches.** Core manages workspace isolation under `.ratel/missions/<missionId>/`.
- **Do not** mark a feature complete unless the orchestrator reports workspace finalization is merged or skipped.
- Prefer `ratel_poll_status` over repeated `ratel_get_status` calls to keep Pi context lean.
