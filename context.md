# Ratel Factory Session Context Handoff

## Current Session

- Date: 2026-06-16
- Active repo: `/Users/aryanbhargav/Desktop/Projects/ratel-factory`
- Branch: `ratel-factory`
- Git status at handoff:
  - Branch is ahead of `origin/ratel-factory` by 25 commits.
  - Modified in this session:
    - `package.json`
    - `packages/pi-sdk/src/main.ts`
    - `packages/core/src/core/orchestrator.ts`
  - Pre-existing untracked items observed:
    - `packages/core/src/core/mission/model-config.ts`
    - `packages/core/test/model-snapshot.test.ts`
    - `release/`
- Important instruction from repo `AGENTS.md`: use Context7 MCP for library/framework/SDK/API/CLI/cloud docs questions.

## User Intent

The user wants to run the Ratel factory locally in the same direct interactive mode they used before:

```bash
cd /Users/aryanbhargav/Desktop/Projects/ratel-factory
npm run dev
```

They do **not** mean the standalone core HTTP service when they say "run Ratel factory locally". They expect the Pi TUI to load the Ratel factory orchestrator prompt, skills, extensions, and custom tools.

## Project Shape

This repo is now an npm workspace monorepo:

- Root package: `ratel`
- Workspaces: `packages/*`
- Key packages:
  - `packages/core` / `@ratel/core`: durable core service, control plane, mission stores, orchestrator, tools, Observatory.
  - `packages/pi-sdk` / `@ratel/pi-sdk`: direct Pi SDK interactive factory mode.
  - `packages/pi-extension`: thin Pi extension HTTP adapter.
  - `packages/opencode-plugin`: thin OpenCode HTTP adapter.

Important commands after this session:

```bash
# Direct interactive factory mode. Run from repo root.
npm run dev

# Core HTTP service only. This is not the factory TUI.
npm run dev:core

# Equivalent core service command from root.
npm run dev --workspace=packages/core

# Equivalent core service command from package dir.
cd packages/core && npm run dev
```

## Runtime/Port Work Done

The user initially hit:

```text
Error: listen EADDRINUSE: address already in use 127.0.0.1:8765
```

Root cause:

- `packages/core` service wants API port `127.0.0.1:8765`.
- Observatory can fall back to another port, but the core API does not fall back.
- Stale local and VPS Ratel processes were still listening on Ratel ports.

Actions taken:

- Used cmux to target the VPS pane:
  - `workspace:4`
  - `pane:14`
  - `surface:18`
- On the VPS, stopped:

```text
PID 13465
/root/.nvm/.../node_modules/@ratel/core/dist/index.js --serve ...
listening on 127.0.0.1:8766
```

- Verified VPS no longer had listeners on `8765`, `8766`, or `8769`.
- Locally stopped old Ratel listeners:

```text
PID 3338  -> local tsx src/main.ts on 8765
PID 27483 -> local global @ratel/core on 8766
```

After this, `packages/core` service started successfully:

```text
Ratel Observatory Dashboard: http://localhost:8766
Ratel Service API: http://127.0.0.1:8765
Health: http://127.0.0.1:8765/health
```

That service is healthy, but it is service-only mode, not the direct factory TUI.

## Main Bug Diagnosed

After PR #10:

```text
Merge pull request #10 from AryanBhargavprojects/architecture-refactor
```

root `npm run dev` had changed to:

```json
"dev": "npm run dev --workspace=packages/pi-sdk"
```

That caused npm to run the Pi SDK workspace script with:

```text
process.cwd() = /Users/aryanbhargav/Desktop/Projects/ratel-factory/packages/pi-sdk
```

But Ratel direct mode expects repo root as cwd because root contains:

- `.pi/skills`
- `.pi/extensions`
- `.ratel`
- root project context

Evidence gathered:

```text
/Users/.../ratel-factory                skills=35
/Users/.../ratel-factory/packages/pi-sdk skills=0
/Users/.../ratel-factory/packages/core   skills=0
```

This explains the user's symptom: Pi opened, but it felt like a normal Pi instance because it was running from the package directory and could not see the repo-root Ratel skills/extensions/state.

Stray state files were also observed:

```text
packages/pi-sdk/.ratel/observatory-url.txt
packages/core/.ratel/observatory-url.txt
.ratel/observatory-url.txt
.ratel/current-mission.json
```

Do not assume package-local `.ratel` is canonical. The intended project root state is root `.ratel`.

## Code Changes Made

### `package.json`

Changed root direct mode back to run from repo root:

```json
"dev": "tsx packages/pi-sdk/src/main.ts"
```

Added explicit core service script:

```json
"dev:core": "npm run dev --workspace=packages/core"
```

Changed root start script to:

```json
"start": "node packages/pi-sdk/dist/main.js"
```

Reason: root `npm run dev` must preserve repo root cwd for direct interactive factory mode.

### `packages/pi-sdk/src/main.ts`

Fixed two direct-mode issues.

1. Tool allowlist was stale.

Added missing factory tool names:

```text
mark_feature_integrated
mark_milestone_validated
mark_mission_completed
get_feature_complexity
```

The SDK allowlist now includes all custom tools exported by `createOrchestratorTools`.

2. Direct-mode execution context was missing `modelConfig`.

Build failed with:

```text
Property 'modelConfig' is missing in type '{ scope; logger; budget; models; }'
```

Fixed by building a `missionModelConfig` snapshot from `getFallbackModelConfig(cwd)` and passing it to both `ModelRouter` and `createOrchestratorTools` context:

```ts
const missionModelConfig = {
  orchestrator: {
    model: fallbackConfig.orchestrator.model,
    fallbackModels: fallbackConfig.orchestrator.fallbackModels ?? [],
  },
  worker: {
    model: fallbackConfig.worker.model,
    fallbackModels: fallbackConfig.worker.fallbackModels ?? [],
  },
  validator: {
    model: fallbackConfig.validator.model,
    fallbackModels: fallbackConfig.validator.fallbackModels ?? [],
  },
};
```

### `packages/core/src/core/orchestrator.ts`

Aligned the source orchestrator tool allowlist with the actual custom tool exports by adding:

```text
mark_feature_integrated
mark_milestone_validated
mark_mission_completed
get_feature_complexity
```

Reason: `tools` is an allowlist in Pi. If a custom tool is omitted from this list, it is filtered out even if provided in `customTools`.

## Verification Performed

Build verification:

```bash
npm run build --workspace=packages/pi-sdk
```

Result:

```text
> @ratel/pi-sdk@0.1.0 build
> tsc
```

Exit code: 0.

Static tool allowlist check:

```text
custom tools 19
allowlist entries 25
missing custom tools from allowlist (none)
```

Also verified root skills load from the intended cwd:

```text
cwd /Users/aryanbhargav/Desktop/Projects/ratel-factory
ratel skills loaded from root 35
has grill-me
```

## Correct Way To Run After This Session

For the user's desired local factory TUI:

```bash
cd /Users/aryanbhargav/Desktop/Projects/ratel-factory
npm run dev
```

Expected behavior:

- Pi TUI launches.
- Ratel factory orchestrator prompt is active.
- Root `.pi/skills` are available.
- Ratel custom tools include `run_worker`, `run_validation`, `run_user_testing`, `wait_for_user_approval`, etc.
- Observatory should start and print its dashboard URL.

For service-only testing:

```bash
cd /Users/aryanbhargav/Desktop/Projects/ratel-factory
npm run dev:core
```

Expected service output:

```text
Ratel Observatory Dashboard
Ratel Service
API: http://127.0.0.1:8765
Health: http://127.0.0.1:8765/health
```

If ports are blocked:

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
lsof -nP -iTCP:8766 -sTCP:LISTEN
```

Stop old Ratel/Pi processes carefully. Do not kill unrelated services.

## Important Source/Dist Drift Observed

There is source/dist drift in `packages/core`.

Examples observed:

- `packages/core/dist/index.js` contains exports for model setup APIs/types that are not all present in `packages/core/src/index.ts`.
- `packages/core/dist/core/mission/execution-context.d.ts` requires `MissionExecutionContext.modelConfig`.
- `packages/core/src/core/mission/execution-context.ts` did not show `modelConfig` in the source interface during this session.
- `packages/core/src/core/mission/model-config.ts` is untracked.
- `packages/core/test/model-snapshot.test.ts` is untracked.

This means:

- Do not assume `dist` and `src` agree.
- Building `packages/core` may expose additional failures or overwrite behavior.
- The Pi SDK build uses package exports/types from `@ratel/core`, which currently resolve through `packages/core/dist`.

Recommended next cleanup:

```bash
npm run build --workspace=packages/core
npm run build --workspace=packages/pi-sdk
```

Then reconcile any source/dist mismatch deliberately.

## Other Codebase Findings From This Session

Project architecture:

- `packages/core/src/api.ts` starts the HTTP API service and Observatory.
- `packages/core/src/index.ts` is the core CLI entrypoint; `--serve` starts service mode.
- `packages/core/src/control-plane/` contains durable mission/job stores, `MissionControlPlane`, and `JobRunner`.
- `packages/core/src/core/tools.ts` provides factory custom tools via `createOrchestratorTools`.
- `packages/core/src/core/workers/worker.ts` spawns Pi worker agents.
- `packages/core/src/core/workers/validators.ts` spawns scrutiny/user-testing validators.
- `packages/core/src/observatory/` contains dashboard service/server/UI.

Current v1 service routes include:

- `/health`
- `POST /api/v1/missions`
- mission/job/cancel/worker/validation/user-testing/approval/events/SSE routes
- Observatory status routes
- deprecated old routes

Potential issues previously noted:

- `install/install-opencode.sh` had a likely typo:

```text
n  exit 1
```

instead of:

```text
exit 1
```

- First-mission model setup appears partially applied across source/dist/tests.
- `packages/opencode-plugin` tests referenced newer model setup/idempotency APIs that current source may not fully expose.
- `packages/core/src/core/workers/validators.ts` had a suspicious hardcoded user-testing shard scope with `missionId: "unknown"` in one path.

Treat these as investigation leads, not confirmed fixes.

## Commands/Diagnostics Used

Useful port/process commands:

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
lsof -nP -iTCP:8766 -sTCP:LISTEN
ps -axo pid,ppid,command | rg -i 'ratel|tsx src/main|tsx src/index|@ratel/core|8765|8766'
```

Useful Ratel/Pi checks:

```bash
npm exec --workspace=packages/pi-sdk -- node -p "process.cwd()"
npm exec --workspace=packages/core -- node -p "process.cwd()"
```

Skill loading check:

```bash
node --input-type=module <<'NODE'
import { DEFAULT_ORCHESTRATOR_SKILLS_DIR, loadSkillsFromDir } from '@ratel/core';
for (const cwd of [process.cwd(), `${process.cwd()}/packages/pi-sdk`, `${process.cwd()}/packages/core`]) {
  const skills = await loadSkillsFromDir(cwd, DEFAULT_ORCHESTRATOR_SKILLS_DIR);
  console.log(cwd, 'skills=', skills.length, skills.slice(0, 5).map(s => s.name).join(','));
}
NODE
```

Tool allowlist check:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { createOrchestratorTools } from '@ratel/core';
const src = readFileSync('packages/pi-sdk/src/main.ts', 'utf8');
const block = src.match(/const ORCHESTRATOR_TOOL_NAMES = \[([\s\S]*?)\];/)?.[1] ?? '';
const allowlist = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
const custom = createOrchestratorTools({
  scope: { projectRoot: process.cwd(), missionId: 'debug' },
  logger: {},
  budget: {},
  models: {},
  modelConfig: {
    orchestrator: { model: null, fallbackModels: [] },
    worker: { model: null, fallbackModels: [] },
    validator: { model: null, fallbackModels: [] },
  },
}).map(t => t.name);
const missing = custom.filter(name => !allowlist.includes(name));
console.log('custom tools', custom.length);
console.log('allowlist entries', allowlist.length);
console.log('missing custom tools from allowlist', missing.join(',') || '(none)');
NODE
```

## Next Session Priorities

1. Ask the user to try:

```bash
cd /Users/aryanbhargav/Desktop/Projects/ratel-factory
npm run dev
```

2. Confirm inside the Pi TUI that Ratel is actually loaded:
   - prompt should behave like Ratel orchestrator intake,
   - Ratel tools should be available,
   - Observatory link should appear/start.

3. If the TUI still looks like plain Pi:
   - verify `process.cwd()` from the root script,
   - inspect active Pi session directory under `~/.pi/agent/sessions/--Users-aryanbhargav-Desktop-Projects-ratel-factory--`,
   - start a new Pi session if it resumed an old normal session,
   - check active tool names if possible.

4. Reconcile `packages/core` source/dist drift before larger changes.

5. Avoid reverting unrelated user changes or untracked files. The worktree was already dirty.

