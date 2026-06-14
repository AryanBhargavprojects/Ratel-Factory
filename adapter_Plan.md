# Ratel Adapter Installation Plan

## Goal

Create installable adapters for **OpenCode** (plugin) and **Pi SDK** (extension), plus a **headless** mode. Each adapter follows the **Plannotator pattern** — one-command install, thin wrappers, agent-agnostic core.

## Architecture Overview

```
User <-> Coding Agent (OpenCode/Pi) <-> Ratel Adapter <-> Ratel Service
                                                             |
                                                             v
                                                        Orchestrator
                                                             |
                                                             v
                                                        Worker/Validator
```

**Key rule:** The adapter is a **thin communication layer**. The factory core (orchestrator, workers, validators) runs as a **service** and never lives inside the agent.

---

## OpenCode Adapter

### How Plannotator Does It

Plannotator's OpenCode plugin (`apps/opencode-plugin/`):
- **Plugin entry**: `index.ts` exports a plugin object with tools and event handlers
- **Plugin registration**: Added to `opencode.json` as `"@plannotator/opencode@latest"`
- **One-command install**: `curl -fsSL https://plannotator.ai/install.sh | bash`
- **Install script does**:
  1. Downloads the binary
  2. Installs Claude Code skills (`apps/skills/claude/`, `apps/skills/core/`)
  3. Installs OpenCode command stubs (`apps/opencode-plugin/commands/`)
  4. Registers Codex hooks
  5. Updates Pi extension
  6. Clears caches

### What Ratel Should Do

**OpenCode Plugin** (`packages/opencode-plugin/`):

```
packages/opencode-plugin/
├── package.json              # "@ratel/opencode"
├── src/
│   ├── plugin.ts             # Plugin entry - exports RatelPlugin
│   ├── service.ts            # HTTP client to Ratel service
│   ├── commands.ts           # Command handlers (/ratel, /ratel-mission, /ratel-observatory)
│   └── prompts.ts            # Prompts for agent-factory interaction
├── commands/                 # Slash command stubs
│   ├── ratel.md
│   ├── ratel-mission.md
│   └── ratel-observatory.md
└── dist/
    └── index.js              # Built plugin
```

**Plugin behavior**:
1. **Tool registration**: Registers `ratel_start_mission`, `ratel_get_status`, `ratel_run_worker`, `ratel_run_validation`, etc.
2. **Command interception**: Intercepts `/ratel-*` commands before the agent sees them
3. **Service bridge**: HTTP client that talks to `http://localhost:RATEL_PORT/api/`
4. **Prompt injection**: Injects factory instructions into system prompt when in "factory mode"

**One-command install**:
```bash
curl -fsSL https://ratel.dev/install.sh | bash
```

**Install script flow**:
1. Detect environment (OpenCode installed? Pi installed? Headless?)
2. Download the appropriate plugin
3. Install OpenCode plugin into `~/.config/opencode/plugins/`
4. Install OpenCode command stubs into `~/.config/opencode/commands/`
5. Install Claude Code skills into `~/.claude/skills/` (if Claude Code is present)
6. Install shared agent skills into `~/.agents/skills/` (if any shared agent framework is present)
7. Start the Ratel service (`ratel --serve`)
8. Verify installation

---

## Pi SDK Adapter

### How Plannotator Does It

Plannotator's Pi extension (`apps/pi-extension/`):
- **Extension entry**: `index.ts` exports an extension object with lifecycle hooks
- **Extension registration**: `pi install npm:@plannotator/pi-extension`
- **Phase-based system**: `planning` → `executing` → `reviewing` → `idle`
- **Tool registration**: `plannotator_submit_plan` tool
- **Command registration**: `/plannotator`, `/plannotator-review`, `/plannotator-annotate`
- **State machine**: Manages phases with per-phase tool access and prompts

### What Ratel Should Do

**Pi Extension** (`packages/pi-extension/`):

```
packages/pi-extension/
├── package.json              # "@ratel/pi-extension"
├── src/
│   ├── extension.ts          # Extension entry - exports RatelExtension
│   ├── service.ts            # HTTP client to Ratel service
│   ├── tool-scope.ts         # Per-phase tool access control
│   ├── commands.ts           # Command handlers (/ratel, /ratel-mission)
│   └── prompts.ts            # Prompts for agent-factory interaction
└── dist/
    └── index.js
```

**Extension behavior**:
1. **Lifecycle hooks**: `before_agent_start`, `after_agent_end`, `before_tool_use`, `after_tool_result`
2. **Phase management**: `idle` → `planning` → `executing` → `validating` → `idle`
3. **Tool registration**: `ratel_submit_mission`, `ratel_run_worker`, `ratel_run_validator`
4. **Command registration**: `/ratel` (toggle factory mode), `/ratel-mission` (show mission status), `/ratel-observatory` (open dashboard)
5. **State persistence**: Uses Pi's `appendEntry` API to persist factory state across sessions

**One-command install**:
```bash
# For Pi users
curl -fsSL https://ratel.dev/install.sh | bash

# Or directly from Pi CLI
pi install npm:@ratel/pi-extension
```

**Install script flow**:
1. Detect Pi SDK installation
2. Download the Pi extension
3. Install Pi extension into Pi's extension directory
4. Install Pi command stubs
5. Start the Ratel service
6. Verify installation

---

## Headless Mode (Already Exists)

**The headless mode is already the current Pi SDK direct mode.**

```bash
# Current entry point
npm run dev        # runs tsx src/adapters/pi-sdk/main.ts
npm start          # runs node dist/adapters/pi-sdk/main.js
```

**What it does**:
1. Runs the Pi SDK TUI directly
2. The orchestrator runs in the same process
3. Workers/validators are spawned via Pi SDK
4. The `.pi/extensions/ratel-model.ts` extension adds `/dashboard` command and model config UI

**No separate headless package needed** — this is the native Pi mode. The "headless" concept is just the current `npm run dev` / `npm start` flow.

---

## Ratel Service

The **core service** that all adapters talk to.

```
packages/core-service/
├── package.json              # "@ratel/core"
├── src/
│   ├── api.ts                # Service API (HTTP routes)
│   ├── orchestrator.ts       # Mission orchestration
│   ├── workers/
│   │   ├── worker.ts         # Worker spawning
│   │   └── validators.ts     # Validator spawning
│   ├── observability/
│   │   ├── event-logger.ts   # Event logging
│   │   └── service.ts        # Observatory service
│   └── index.ts              # Entry point
└── dist/
    └── index.js
```

**Service API** (v1):

```typescript
// POST /api/v1/missions
{ goal: string }
// => 202 { missionId, jobId }

// GET /api/v1/missions/:missionId
// => 200 { missionId, goal, status, ... }

// GET /api/v1/missions/:missionId/jobs
// => 200 { jobs: [...] }

// GET /api/v1/missions/:missionId/jobs/:jobId
// => 200 { jobId, status, attempt, ... }

// POST /api/v1/missions/:missionId/jobs/:jobId/cancel
// => 200 { status: "cancelled" }

// POST /api/v1/missions/:missionId/workers
{ featureId: string }
// => 202 { jobId, status: "queued" }

// POST /api/v1/missions/:missionId/validations
{ milestoneId: string }
// => 202 { jobId, status: "queued" }

// POST /api/v1/missions/:missionId/user-testing
{ milestoneId: string }
// => 202 { jobId, status: "queued" }

// POST /api/v1/missions/:missionId/approval
{ approved: boolean, feedback?: string, files?: Record<string, string> }
// => 202 { jobId, status: "queued" }

// GET /api/v1/missions/:missionId/events
// => 200 { events: [...] }

// GET /api/v1/missions/:missionId/events/stream
// => SSE stream

// GET /api/observatory/status
// => { enabled, url }
```

---

## One-Command Installation

### Universal Installer

```bash
curl -fsSL https://ratel.dev/install.sh | bash
```

**What the installer does**:
1. **Detect environment**: Check which agents are installed (OpenCode, Pi, Claude Code, Codex, etc.)
2. **Download Ratel service**: Install `@ratel/core` globally
3. **Install adapters**:
   - If OpenCode detected: install `@ratel/opencode` plugin
   - If Pi detected: install `@ratel/pi-extension` extension
   - If neither: warn user and install `@ratel/core` service only (for manual use)
4. **Install skills**: Copy `SKILL.md` files to appropriate agent directories
5. **Start service**: Run `ratel --serve` in background
6. **Verify**: Check that the service is running and responding

### Per-Agent Install

```bash
# OpenCode only
curl -fsSL https://ratel.dev/install.sh | bash -s -- --opencode

# Pi only
curl -fsSL https://ratel.dev/install.sh | bash -s -- --pi

# Service only (no UI adapter)
curl -fsSL https://ratel.dev/install.sh | bash -s -- --service-only
```

---

## Directory Structure (Full)

```
ratel/
├── packages/
│   ├── core/                     # Factory core service
│   │   ├── package.json          # "@ratel/core"
│   │   ├── src/
│   │   │   ├── api.ts            # HTTP API
│   │   │   ├── orchestrator.ts   # Mission orchestration
│   │   │   ├── workers/
│   │   │   │   ├── worker.ts
│   │   │   │   └── validators.ts
│   │   │   ├── observability/
│   │   │   │   ├── event-logger.ts
│   │   │   │   └── service.ts
│   │   │   └── index.ts
│   │   └── dist/
│   │
│   ├── opencode-plugin/          # OpenCode plugin
│   │   ├── package.json          # "@ratel/opencode"
│   │   ├── src/
│   │   │   ├── plugin.ts         # Plugin entry
│   │   │   ├── service.ts        # HTTP client
│   │   │   ├── commands.ts       # Command handlers
│   │   │   └── prompts.ts        # Prompts
│   │   ├── commands/             # Slash command stubs
│   │   │   ├── ratel.md
│   │   │   ├── ratel-mission.md
│   │   │   └── ratel-observatory.md
│   │   └── dist/
│   │
│   ├── pi-extension/             # Pi extension
│   │   ├── package.json          # "@ratel/pi-extension"
│   │   ├── src/
│   │   │   ├── extension.ts      # Extension entry
│   │   │   ├── service.ts        # HTTP client
│   │   │   ├── tool-scope.ts     # Phase tool access
│   │   │   ├── commands.ts       # Command handlers
│   │   │   └── prompts.ts        # Prompts
│   │   └── dist/
│   │
│   └── pi-sdk/                   # Pi SDK direct mode (native/headless)
│       ├── package.json          # "ratel" (main package)
│       ├── src/
│       │   ├── main.ts           # Entry point (current)
│       │   └── agents.ts         # Pi-specific helpers
│       └── dist/
│
├── skills/                       # Agent skills
│   ├── ratel-factory/            # Core factory skill
│   │   ├── SKILL.md
│   │   └── prompts.ts
│   ├── ratel-mission/            # Mission management skill
│   │   ├── SKILL.md
│   │   └── prompts.ts
│   └── ratel-observatory/        # Dashboard skill
│       ├── SKILL.md
│       └── prompts.ts
│
├── install/
│   ├── install.sh                # Universal installer
│   ├── install-opencode.sh       # OpenCode-specific
│   ├── install-pi.sh             # Pi-specific
│   └── install-headless.sh       # Headless-specific
│
└── package.json                  # Root workspace
```

---

## Implementation Plan

### Phase 1: Core Service

1. Create `packages/core/` package structure
2. Extract service API from current `src/core/`
3. Create HTTP server (`src/api.ts`)
4. Implement mission endpoints (`/api/mission/*`)
5. Implement worker endpoints (`/api/worker/*`)
6. Implement observatory endpoints (`/api/observatory/*`)
7. Test service standalone

### Phase 2: OpenCode Plugin

1. Create `packages/opencode-plugin/` package
2. Implement plugin entry (`src/plugin.ts`)
3. Implement service bridge (`src/service.ts`)
4. Implement command handlers (`src/commands.ts`)
5. Create slash command stubs (`commands/*.md`)
6. Write prompts (`src/prompts.ts`)
7. Test with OpenCode

### Phase 3: Pi Extension

1. Create `packages/pi-extension/` package
2. Implement extension entry (`src/extension.ts`)
3. Implement service bridge (`src/service.ts`)
4. Implement tool scope (`src/tool-scope.ts`)
5. Implement command handlers (`src/commands.ts`)
6. Write prompts (`src/prompts.ts`)
7. Test with Pi SDK

### Phase 4: Installer

1. Create `install/install.sh` universal installer
2. Implement environment detection
3. Implement per-adapter install logic
4. Implement service startup
5. Implement verification
6. Test on all platforms

### Phase 5: Skills

1. Create `skills/ratel-factory/` skill
2. Create `skills/ratel-mission/` skill
3. Create `skills/ratel-observatory/` skill
4. Install skills to appropriate agent directories
5. Test skill invocation

### Phase 6: Pi SDK Direct Mode

1. Keep current `src/adapters/pi-sdk/main.ts` as the headless/direct entry point
2. Ensure `.pi/extensions/ratel-model.ts` still works with the new service architecture
3. Test that `npm run dev` still works (backward compatibility)
4. The Pi SDK mode will talk to the service internally (or run directly if service is not running)

---

## Key Design Decisions

1. **Service-first**: The core always runs as a service. Adapters are thin HTTP clients.
2. **Plugin pattern**: OpenCode uses `@opencode-ai/plugin`, Pi uses `@earendil-works/pi-coding-agent`.
3. **One-command install**: Universal installer detects environment and installs appropriate adapters.
4. **Skills included**: Each adapter installs skills to the agent's skill directory.
5. **Service is authoritative**: Adapters may cache UI state, but all durable mission and job state lives in the service.
6. **Headless is Pi SDK direct mode**: `npm run dev` runs the factory directly. No separate headless package.
7. **Backward compatible**: Existing Pi SDK mode (`src/adapters/pi-sdk/`) still works as a direct adapter.
8. **Budget and fallback models**: Mission budgets and model fallback chains are configurable in `ratel.json` and enforced deterministically.

---

## File Mapping

| Current | New | Notes |
|---------|-----|-------|
| `src/core/` | `packages/core/src/` | Factory core |
| `src/observatory/` | `packages/core/src/observatory/` | Dashboard (now part of core service) |
| `src/adapters/opencode/` | `packages/opencode-plugin/src/` | OpenCode plugin |
| `src/adapters/pi-sdk/` | `packages/pi-extension/src/` | Pi extension |
| `src/adapters/pi-sdk/main.ts` | `src/adapters/pi-sdk/main.ts` | Headless/direct mode (keep as-is) |
| `src/skills/` | `skills/` | Agent skills |

---

## Success Criteria

1. `curl -fsSL https://ratel.dev/install.sh | bash` works on macOS and Linux
2. OpenCode plugin installs and registers tools
3. Pi extension installs and registers commands
4. Headless mode works (current `npm run dev` / `npm start`)
5. All adapters can start missions, run workers, and validate
6. Observatory dashboard is accessible via all adapters
7. Pi SDK direct mode still works (backward compatible)
8. OpenCode plugin can connect to the Ratel service
