<p align="center">
  <img src="RatelLogo.png" alt="Ratel Logo" width="160">
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D%2018-3c873a?style=flat-square&logo=node.js" alt="Node.js version"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0+-3178c6?style=flat-square&logo=typescript" alt="TypeScript version"></a>
  <a href="https://github.com/earendil-works/pi-coding-agent"><img src="https://img.shields.io/badge/built%20with-Pi%20SDK-purple?style=flat-square" alt="Pi SDK badge"></a>
</p>

<div align="center">
  <strong>
    <h2>Your ultimate AI Software Factory 🤖</h2><br />
    Ratel: An alternative to OpenHands, Aider, Plandex, and Sweep.dev<br /><br />
  </strong>
  Ratel offers everything you need to run autonomous AI coding agents,<br />
  validate changes with automated tests, and monitor missions from a live dashboard.
</div>

<p align="center">
  <br />
  ⭐ If you like this project, star it on GitHub!
  <br />
</p>

<p align="center">
  <a href="#what-is-ratel">What is Ratel?</a> •
  <a href="#key-features">Key Features</a> •
  <a href="#installation--setup">Installation & Setup</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#development">Development</a>
</p>

---

## What is Ratel?

Ratel is an **AI Software Factory** — a framework designed for running autonomous, end-to-end software development missions. It orchestrates specialised LLM agents to plan, implement, and validate software projects while maintaining strict, deterministic control over process scheduling, repository isolation, schema validation, persistence, and branch integration.

> [!IMPORTANT]
> **Core Philosophy:** 
> * **Deterministic Code** owns the structural framework: database schemas, local persistence, execution timeouts, agent routing, and completion logic.
> * **Model Agents** own the cognitive work: task planning, source implementation, test creation, code reviews, and product judgment.
> * **Non-Bypassable Gates** ensure that features can only be merged into the main codebase when they pass all validators with zero high-severity issues.

---

## Key Features

*   ⚙️ **Deterministic Process Control** — Rigid validation gates, timeouts, and state machines ensure agent pipelines are stable and reproducible.
*   🛰️ **Live Observatory Dashboard** — Web-based monitoring interface showing live timelines, stdout streams, active git diffs, and validation feedback.
*   📄 **Interactive Widescreen Plan Review** — Review and modify the generated validation contracts and Gherkin feature files in real-time from your browser before launching missions.
*   🛠️ **Automated Sharded Testing** — Coordinates parallel user-testing shards to run automated browser and integration scenarios in isolated environments.
*   🔄 **Automatic Validation Recovery** — Identifies and attempts automatic correction of compilation, lint, or runtime errors before submitting final reports.

---

## Installation & Setup

Ratel supports two first-class end-user adapters: the **OpenCode adapter** (service-backed — runs `@ratel-factory/core` as a standalone HTTP service) and the **native Pi Coding Agent extension** (in-process — imports and runs `@ratel-factory/core` directly inside the Pi session, with no separate daemon). Both ship a bundled `ratel-factory` skill. Pick the one matching your agent.

### 1. Automated Installation (OpenCode)

```bash
curl -fsSL https://ratelfactory.dev/install-opencode.sh | bash
```

To pin a specific release instead of npm `latest`:

```bash
RATEL_VERSION=0.2.0 bash <(curl -fsSL https://ratelfactory.dev/install-opencode.sh)
```

This script will automatically:
*   Install the latest `@ratel-factory/core` and `@ratel-factory/opencode` packages from npm.
*   Add the `@ratel-factory/opencode` plugin hook configuration inside your `opencode.json`.
*   Install command stubs (`/ratel`, `/ratel-mission`, `/ratel-observatory`) and the `ratel-factory` OpenCode skill.
*   Configure the OpenCode plugin tools for starting missions, polling low-token status, answering intake questions, approving plans, and running workers/validators.
*   Bridge OpenCode API-key credentials into Pi/Ratel auth so factory agents can use the same provider keys and model namespaces as OpenCode.
*   Clean up stale legacy packages, stale `.ratel/service.json` metadata, and running Ratel service processes so an outdated service cannot be reused.

After installing, open OpenCode in a project and run:

```text
/ratel
```

`/ratel` is a health command only: it pings all factory agents and does not start a mission or inspect the codebase.

### 2. Pi Coding Agent (native extension)

Ratel ships a **first-class native Pi Coding Agent extension** (`@ratel-factory/pi-extension`). This is a separate, Pi-native adapter — it is *not* the OpenCode plugin ported to Pi. Unlike the OpenCode adapter (which is service-backed), the Pi extension imports and uses `@ratel-factory/core` **in-process**: the orchestrator runs inside the Pi session itself. There is no separate daemon, no out-of-band process, no HTTP service boundary, no service discovery/autostart, no `.ratel/service.json`, and no `ratel --serve` to start. All mission/job/event state is durable under `.ratel/missions/<missionId>/` via core's mission/event helpers.

The recommended install path is the direct Pi command, which installs the extension and pulls in `@ratel-factory/core` as a dependency automatically:

```bash
pi install npm:@ratel-factory/pi-extension
```

To pin a specific release:

```bash
pi install npm:@ratel-factory/pi-extension@0.2.2
```

`pi install` installs the extension's `dependencies` (including `@ratel-factory/core`) and registers the extension with Pi. You do **not** need to separately `npm install -g @ratel-factory/core`, and no service is started — the extension loads core in-process when a Pi session starts.

After installing, open Pi in a project and run:

```text
/ratel
```

The extension registers Pi-native slash commands (`/ratel`, `/ratel-start`, `/ratel-status`, `/ratel-approve`, `/ratel-observatory`), Pi-native tools (`ratel_start_mission`, `ratel_poll_status`, `ratel_get_status`, `ratel_approve_plan`, `ratel_answer_question`, `ratel_reply_to_factory`, `ratel_run_feature_worker`, `ratel_run_validation`, `ratel_ping_agents`), lifecycle hooks (`session_start`, `before_agent_start`, `session_shutdown`), and the bundled `ratel-factory` skill that documents the mission loop.

A local dev helper script is available for workspace installs:

```bash
bash install/install-pi.sh --dev
```

Pi mode is the supported path for Ratel users who run the Pi Coding Agent as their primary agent.

### 3. Manual Source Setup (Development Mode)

If you are developing custom adapters, dashboard components, or core tools, build the codebase from source:

```bash
# Clone the repository
git clone <repository-url>
cd ratel-web

# Install package dependencies
npm install

# Build all packages
npm run build:all

# Install the local OpenCode adapter build
bash install/install-opencode.sh --dev

# Start the factory in direct, interactive mode
npm run dev
```

**Installer flags:**
- `--dev` — Install from local workspace instead of npm
- `--help` — Show usage

**Example:**
```bash
bash install/install-opencode.sh --dev
```

---

## Architecture

Ratel separates client-side platform hooks (Adapters) from factory scheduling and orchestration logic (Core). Core can run either as a standalone HTTP service (the OpenCode adapter path) or in-process inside the agent (the Pi extension path and direct/headless mode).

### Canonical Core Package

There is **one canonical core**: `@ratel-factory/core`. All factory logic lives in `packages/core/src/`.

- **Core Service** (`@ratel-factory/core`) — can run as a standalone HTTP service (used by the OpenCode adapter). All state lives here.
- **OpenCode adapter** is a service-backed thin HTTP client that registers tools/commands with the OpenCode plugin API and talks to core over HTTP.
- **Pi extension** imports and runs `@ratel-factory/core` **in-process** inside the Pi session — no HTTP layer, no separate daemon, no `ratel --serve`.
- **Direct mode** — `src/adapters/pi-sdk/main.ts` also runs the core in-process without the HTTP layer (for headless/development use).
- **Legacy source** (`src/core/`, `src/observatory/`) is a deprecated path that has been ported into `packages/core/src/`. The architecture guard (`npm run check:canonical-core`) blocks any resurrection.

**Key rule:** Core is authoritative. In service mode the service owns all durable mission and job state; in in-process mode (Pi extension / direct mode) the core instance running in the process owns it. Adapters may cache UI state for display purposes only.

```mermaid
graph TD
    User([User CLI / UI]) -->|1. Goal| Hook[Adapter Layer: OpenCode / Pi SDK]
    Hook -->|2. Register Tools & Hooks| Daemon[Ratel Core Service]
    Daemon -->|3. Start Dashboard| Obs[Observatory Server]
    Obs -->|Widescreen Plan Approval Gate| User
    
    Daemon -->|4. Research| Res[Research Agent]
    Daemon -->|5. Create Contract| Contract[Contract Writer]
    Daemon -->|6. Delegate Coding| Worker[Worker Agent]
    Daemon -->|7. Request Verification| Val[User-Testing Coordinator]
    
    Worker -->|Writes features & tests| Branch[Isolated git Branch]
    Val -->|Decomposes scenarios| Shards[Parallel Test Shards]
    Shards -->|Browser Automation| Branch
```

```
User (OpenCode or Pi)
  ↓
Adapter (no orchestration logic)
  │   • OpenCode Plugin (service-backed): /ratel commands, ratel_start_mission tool → core over HTTP
  │   • Pi Extension (in-process): lifecycle hooks, tools → imports @ratel-factory/core directly
  ↓
Ratel Core (HTTP service for OpenCode; in-process for Pi extension)
  │   • Mission management
  │   • Worker spawning
  │   • Validation
  │   • Observatory
  ↓
Orchestrator (mission planning, user interaction, phase transitions)
  ├─→ Research Agent (read-only investigation)
  ├─→ Smart Friend (peer reviewer)
  ├─→ Contract Writer (Gherkin .feature files)
  ├─→ Worker Agent (implements one feature)
  │     └─→ Prepared serial git branch (integration → feat/Fx)
  ├─→ Scrutiny Validator (automated checks + code review)
  └─→ User-Testing Coordinator (browser-based scenario execution)
            └─→ Sharded per .feature file
```

### Adapter Architecture

Ratel supports two adapter modes:

- **OpenCode adapter (service-backed)** — `@ratel-factory/core` runs as a standalone HTTP service; the OpenCode plugin is a thin HTTP client that registers tools/commands with the OpenCode plugin API.
- **Pi extension (in-process)** — `@ratel-factory/core` is imported and run directly inside the Pi session. No HTTP layer, no separate daemon, no `ratel --serve`.
- **Direct mode** — `src/adapters/pi-sdk/main.ts` runs the core in-process without the HTTP layer (for headless/development use).

**Key rule:** Core is authoritative. In service mode the service owns all durable mission and job state; in in-process mode the core instance running in the process owns it. Adapters may cache UI state for display purposes only.

### Key Components

| Component | Responsibility |
|---|---|
| **Adapter Layer** | Client-side wrappers (`src/adapters`) that map Ratel tools and slash commands into native agent environments (OpenCode CLI, Pi Interactive TUI). |
| **Orchestrator** | Coordinates the lifecycle flow, schedules agent sessions, and manages state checkpoints. |
| **Research Agent** | Inspects the repository and codebase structure to identify dependencies and constraints in a read-only environment. |
| **Contract Writer** | Formulates the high-level `validation-contract.md` and generates individual Gherkin `.feature` specifications. |
| **Worker Agent** | Implements code changes in parallel git branches under test-driven development (TDD). |
| **Scrutiny Validator** | Automatically verifies code syntax, typings, lints, and executes code reviews on worker submissions. |
| **User-Testing Coordinator** | Schedules sharded browser runs using cucumber frameworks to verify user flows. |
| **Observatory Dashboard** | Node HTTP web dashboard (`src/observatory`) used for monitoring timelines, viewing file diffs, and reviewing Gherkin plans. |

---

## How It Works

### Mission Lifecycle Phases

1.  **Intake**: The orchestrator receives the goal specification from the user.
2.  **Discovery**: Agents inspect the directory structure and existing code libraries to ensure compatibility.
3.  **Clarification**: The system resolves ambiguous requirements through interactive CLI prompts.
4.  **Constraint Analysis**: Identifies technological boundaries, non-goals, and dependency requirements.
5.  **Validation Contract**: The contract agent drafts high-level verification criteria and details scenarios.
6.  **Feature Decomposition**: Deconstructs the contract into concrete feature directories with automated checks.
7.  **User Approval**: The user reviews the plan and feature specifications in the browser dashboard.
8.  **Execution**: Worker subagents code, write tests, and integrate features serially upon successful validations.

### Workspace Isolation

Ratel enforces rigorous Git safety gates to prevent agent-owned modifications from polluting your primary codebase:
*   The orchestrator auto-discovers or sets up a clean `integration` branch.
*   Worker agents spawn a separate feature branch (`feat/F1`, `feat/F2`, etc.) for each milestone.
*   A feature is only merged back to `integration` upon passing all security and execution checks.

### Feature Lifecycle: `integrated` vs `validated`

The factory uses two distinct states for features to separate "code is merged" from "code is verified":

*   **`integrated`** — the worker handoff was clean, workspace finalization succeeded, and the commit is reachable from the `integration` branch. The orchestrator may **not** mark a feature `integrated` directly; only the deterministic `mark_feature_integrated` gate (or equivalent tool) can write this status.
*   **`validated`** — milestone validation (scrutiny + user testing) passed with zero blocking issues and all automated checks green. Only the validation finalization logic may transition `integrated` → `validated`.

Legacy aliases (`complete`, `completed`) are normalized to `integrated` on read.

### Feature Completion Gate

A feature is strictly blocked from completion unless the following requirements are met:
*   The worker submits a valid, parseable handoff report (`parseStatus: "ok"`).
*   No `leftUndone` items exist in the feature manifest.
*   Zero high-severity issues or compiler warnings are discovered by the validators.
*   Workspace finalization successfully completes a git merge.

---

## Configuration

Ratel is configured via a global `ratel.json` file in the root directory:

```json
{
  "name": "ratel",
  "version": "0.1.0",
  "observability": {
    "enabled": true,
    "port": 8765,
    "autoOpen": false
  },
  "orchestrator": {
    "model": "openai/gpt-4o",
    "thinkingLevel": "medium",
    "defaultSkills": [
      "grill-with-docs",
      "parallel-web-search"
    ]
  },
  "workers": {
    "model": "anthropic/claude-3-5-sonnet",
    "defaultTools": ["read", "bash", "edit", "write"]
  },
  "validators": {
    "model": "openai/gpt-4o",
    "defaultTools": ["read", "bash", "grep"]
  },
  "budget": {
    "maxCostUsd": 50,
    "maxTotalTokens": 5000000,
    "maxWallClockMinutes": 480,
    "maxAgentRuns": 200
  },
  "fallbackModels": {
    "orchestrator": {
      "model": "openai/gpt-4o",
      "fallbackModels": ["anthropic/claude-3-5-sonnet"]
    },
    "worker": {
      "model": "anthropic/claude-3-5-sonnet",
      "fallbackModels": []
    },
    "validator": {
      "model": "openai/gpt-4o",
      "fallbackModels": []
    }
  }
}
```

**Budget configuration** (`budget`):
- `maxCostUsd` — maximum total cost per mission (default: 50).
- `maxTotalTokens` — maximum total tokens per mission (default: 5,000,000).
- `maxWallClockMinutes` — wall-clock budget in minutes (default: 480).
- `maxAgentRuns` — maximum agent sessions per mission (default: 200).
- Budgets are enforced at the start of every agent turn and recorded in `usage.jsonl`.
- If any budget limit is exceeded, the mission halts with a non-retryable error.

**Fallback model configuration** (`fallbackModels`):
- `orchestrator`, `worker`, `validator` each have a primary `model` and an ordered list of `fallbackModels`.
- When a retryable provider error occurs (429, 503, timeout, network reset), the orchestrator transparently retries with the next fallback model.
- Non-retryable errors (401, 403, context overflow, content policy, budget exceeded) do **not** trigger fallback.
- Model health is tracked via a circuit breaker (open after `failureThreshold` consecutive retryable failures, half-open after `cooldownMs`).

> [!TIP]
> Model configurations map to the Pi SDK registry. You can override active models per-session using the CLI `set_model` tool.

---

## Development

### Script Commands

```bash
# Development
npm run dev          # Start factory in direct mode (tsx)
npm run dev:core     # Start core service (tsx)

# Building
npm run build        # Build root package
npm run build:all    # Build all packages

# Testing
npm test             # Run all tests (root test/)
npm test --workspace=@ratel-factory/core   # Run core tests
npm test:all         # Test all packages

# Running
npm start            # Run compiled factory (node dist/main.js)

# Package-specific
npm run build --workspace=packages/core
npm run build --workspace=packages/opencode-plugin
npm run build --workspace=packages/pi-extension
```

### Project Structure

```
ratel/
├── packages/
│   ├── core/                     # @ratel-factory/core — Factory service
│   │   ├── src/
│   │   │   ├── api.ts            # HTTP API server (v1 + deprecated)
│   │   │   ├── index.ts          # Service entry point
│   │   │   ├── control-plane/    # Mission store, job store, job runner
│   │   │   ├── core/             # Factory core logic
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── tools.ts
│   │   │   │   ├── workers/
│   │   │   │   ├── mission/
│   │   │   │   ├── budget/
│   │   │   │   ├── models/
│   │   │   │   └── ...
│   │   │   └── observatory/      # Dashboard service
│   │   └── test/                 # Core package tests (20+)
│   │
│   ├── opencode-plugin/          # @ratel-factory/opencode — OpenCode plugin
│   │   ├── src/
│   │   │   ├── plugin.ts         # Plugin entry
│   │   │   ├── service.ts        # HTTP client
│   │   │   ├── service-lifecycle.ts # Service discovery/auto-start
│   │   │   ├── auth-bridge.ts    # OpenCode → Pi/Ratel auth bridge
│   │   │   ├── auth-sync-watcher.ts # OpenCode auth.json watcher/fallback sync
│   │   │   ├── polling.ts        # Low-token mission polling helpers
│   │   │   ├── logging.ts        # OpenCode app-log safe logger
│   │   │   ├── resolve-project-root.ts # OpenCode cwd/worktree resolver
│   │   │   ├── commands.ts       # Command handlers
│   │   │   └── prompts.ts        # Prompts
│   │   ├── commands/             # Slash command stubs
│   │   ├── skills/               # Bundled OpenCode skill
│   │   └── package.json
│   │
│   ├── pi-extension/             # @ratel-factory/pi-extension — Pi extension (in-process)
│   │   ├── src/
│   │   │   ├── extension.ts      # Extension entry
│   │   │   ├── runtime.ts        # In-process core runtime (no HTTP, no daemon)
│   │   │   ├── events.ts         # Local events.jsonl polling helpers
│   │   │   ├── polling.ts        # Mission poll/stop-condition helpers
│   │   │   ├── tool-scope.ts     # Phase management
│   │   │   ├── commands.ts       # Command handlers
│   │   │   ├── resolve-project-root.ts # Pi cwd resolver
│   │   │   ├── prompts.ts        # Prompts
│   │   └── package.json
│   │
│   └── pi-sdk/                   # Pi SDK direct mode (native/headless)
│       ├── src/
│       │   ├── main.ts           # Direct/headless entry
│       │   └── agents.ts         # Pi-specific helpers
│       └── package.json
│
├── src/                    # Legacy source (deprecated; ported to packages/core)
│   └── adapters/           # Pi SDK direct mode only
│       └── pi-sdk/
│           ├── main.ts
│           └── agents.ts
│
├── scripts/               # CI/architecture scripts
│   └── check-canonical-core.mjs
│
├── test/                  # Root-level tests
├── install/               # Installer scripts
├── ratel.json             # Factory configuration
├── tsconfig.json          # TypeScript configuration
└── package.json           # Workspace root
```

### Testing

The factory has 77 tests covering:
- Workspace resolution with explicit directories
- Feature completion gate enforcement
- Report submission and parsing
- JSONL robustness
- Mission schema normalization
- Integration preflight checks
- User-testing shard aggregation
- Validation recovery semantics

### Observatory Dashboard

When the factory starts, it launches a read-only observatory dashboard:
- URL: `http://localhost:8765` (auto-falls back if port busy)
- Shows: agent spans, tool calls, parse status, phase transitions, halt events
- Data source: `.missions/current/events.jsonl`

---

## Adapters

### OpenCode Plugin (`@ratel-factory/opencode`)

Current prepared package version: `@ratel-factory/opencode@0.2.0` with `@ratel-factory/core@0.2.0`.

**Commands:**
- `/ratel` — Ping factory health and all six factory agents. This is health/status only: it does **not** start a mission, inspect the codebase, or modify project state.
- `/ratel-mission` — Show current mission status
- `/ratel-observatory` — Open Observatory dashboard

**Factory agents pinged by `/ratel`:**
- `research`
- `smart_friend`
- `contract_writer`
- `worker`
- `scrutiny_validator`
- `user_testing_validator`

**Tools:**
- `ratel_start_mission` — Start a new mission with a goal
- `ratel_poll_status` — Poll mission events until a compact stop condition is reached (`orchestrator_question`, `phase_change`, `mission_complete`, or `halted`)
- `ratel_send_message` — Send a free-form user reply or clarification back to the orchestrator during intake/discovery
- `ratel_answer_question` — Answer a specific pending question returned by polling
- `ratel_approve_mission` — Approve or reject the generated mission plan/validation contract
- `ratel_get_status` — Get mission status
- `ratel_run_worker` — Run a worker for a feature
- `ratel_run_validation` — Run validation for a milestone
- `ratel_ping_agents` — Ping all factory agents and report per-agent health

**OpenCode mission loop:**
1. Start a mission with `ratel_start_mission`.
2. Call `ratel_poll_status` instead of streaming raw events into the chat context.
3. If polling returns `stopReason: "orchestrator_question"`, show the returned `pendingQuestion` or `assistantMessage` to the user.
4. Send the user reply with `ratel_answer_question` when a `questionId` is present, or `ratel_send_message` for free-form clarification.
5. Poll again until approval, worker execution, halt, or mission completion.

**Service lifecycle:**
- The plugin auto-discovers a local Ratel service using `.ratel/service.json` in the project root.
- If no healthy service exists, it starts `ratel --serve` for the project.
- The plugin rejects filesystem-root worktrees such as `/` and falls back to the actual OpenCode directory so `ratel.json` is found correctly.
- Service-mode orchestrator text, pending questions, and durable progress are written to mission events so OpenCode can safely poll without relying on hidden stdout.

**Auth bridge:**
- The plugin reuses existing OpenCode API credentials, especially `opencode-go`, by bridging OpenCode auth into Pi/Ratel auth.
- Changed OpenCode API keys overwrite stale Pi/Ratel keys for bridge-managed providers.
- Providers removed from OpenCode are removed from Pi/Ratel auth only when they were previously bridge-managed; unrelated manual Pi providers are preserved.
- The bridge stores non-secret provider metadata and key hashes in `.ratel/provider-namespaces.json`; it never stores raw keys outside the Pi auth file.
- Sync runs before agent-spawning/orchestrator-waking tools and also watches OpenCode `auth.json` with a debounced filesystem watcher plus periodic fallback.
- V1 defaults to using the same OpenCode model for all factory agents. Users can later change specific agent models in `ratel.json`.

### Pi Extension (`@ratel-factory/pi-extension`)

A native Pi Coding Agent extension (not an OpenCode port). The extension runs `@ratel-factory/core` **in-process** — it imports core directly and drives the orchestrator inside the Pi session. There is no HTTP service boundary, no separate daemon, no service discovery, no `.ratel/service.json`, and no `ratel --serve`. All mission/job/event state is durable under `.ratel/missions/<missionId>/` via core's mission/event helpers. It ships a bundled `ratel-factory` skill that documents the Pi-native mission loop.

**Commands:**
- `/ratel` — Show in-process Ratel availability and ping factory roles
- `/ratel-start <goal>` — Start a new mission
- `/ratel-status` — Show current mission status (`/ratel-mission` is an alias)
- `/ratel-approve` — Approve the current mission waiting for approval
- `/ratel-observatory` — Open Observatory dashboard

**Tools:**
- `ratel_start_mission` — Start a new mission from a goal
- `ratel_poll_status` — Compact progress polling with stop conditions (stop reasons, pending questions, assistant messages)
- `ratel_get_status` — One-off mission status
- `ratel_approve_plan` — Approve/reject a mission waiting for approval (`ratel_approve_mission` alias)
- `ratel_answer_question` — Answer a specific pending orchestrator question
- `ratel_reply_to_factory` — Send a free-form user reply (`ratel_send_message` alias)
- `ratel_run_feature_worker` — Run a worker for a feature (`ratel_run_worker` alias)
- `ratel_run_validation` — Run validation for a milestone (`ratel_run_validator` alias)
- `ratel_ping_agents` — Ping all factory subagent roles

**Lifecycle hooks:**
- `session_start` — Resolve project root, construct the in-process runtime, restore cached mission ID for UI continuity
- `before_agent_start` — Inject Ratel factory mode prompt when a mission is active
- `session_shutdown` — Dispose the in-process runtime for this session

### Service API (OpenCode / direct core service mode)

This HTTP API applies to the **service-backed** path only — the OpenCode adapter, or running `@ratel-factory/core` as a standalone service directly. The **Pi extension does not use this API**: it imports and runs core in-process, so there is no HTTP boundary to call. (Mission state is still durable under `.ratel/missions/<missionId>/` in both modes.)

All requests return immediately with a job ID. Clients poll `GET /api/v1/missions/:missionId/jobs/:jobId` or consume the SSE stream (`GET /api/v1/missions/:missionId/events/stream`) for real-time updates.

**v1 API:**

```bash
GET  /health                              → { status: "ok" }
POST /api/v1/missions                     → { goal: string } → 202 { missionId, jobId }
GET  /api/v1/missions/:missionId          → { missionId, goal, status, ... }
GET  /api/v1/missions/:missionId/jobs     → { jobs: [...] }
GET  /api/v1/missions/:missionId/jobs/:jobId → { jobId, status, attempt, ... }
POST /api/v1/missions/:missionId/jobs/:jobId/cancel → { status: "cancelled" }
POST /api/v1/missions/:missionId/workers  → { featureId } → 202 { jobId, status: "queued" }
POST /api/v1/missions/:missionId/validations → { milestoneId } → 202 { jobId, status: "queued" }
POST /api/v1/missions/:missionId/user-testing → { milestoneId } → 202 { jobId, status: "queued" }
POST /api/v1/missions/:missionId/approval → { approved: bool, feedback?, files? } → 202 { jobId, status: "queued" }
POST /api/v1/missions/:missionId/messages → { message, questionId? } → 202 { jobId, status: "queued" }
POST /api/v1/missions/:missionId/questions/:questionId/answer → { answer } → 202 { jobId, status: "queued" }
GET  /api/v1/missions/:missionId/events   → { events: [...] }
GET  /api/v1/missions/:missionId/events/stream → SSE stream
GET  /api/observatory/status              → { enabled, url }
```

**Deprecated routes** (still supported with `Deprecation: true` header):
```bash
POST /api/mission/start   → 200 { missionId, jobId }
GET  /api/mission/status  → 200 { missionId, status, jobs }
POST /api/mission/worker  → 200 { missionId, featureId, jobId, status }
POST /api/mission/validate → 200 { missionId, milestoneId, jobId, status }
GET  /api/mission/artifacts → 200 { artifacts }
```

### Durable State

- **Mission state** is isolated under `.ratel/missions/<missionId>/`.
- Each mission directory contains: `mission.json`, `state.json`, `features.json`, `milestones.json`, `decision-log.md`, `budget.json`, `usage.jsonl`, `events.jsonl`, `approval.json`, `handoffs/`, `worker-runs/`, `validation-reports/`, `validation-receipts/`.
- **Jobs** are stored per-mission under `.ratel/missions/<missionId>/jobs/<jobId>.json`.
- Jobs survive process restart because they are file-backed, not in-memory. The control plane recovers expired leases on startup.
- **Budget and usage** are persisted atomically in `budget.json` and append-only in `usage.jsonl`.
- **Approval** is stored as `approval.json` and the orchestrator resumes from the next `continue_orchestrator` job after restart.
- **Token/cost records** are deduplicated by `recordId`; replaying the same record after restart is idempotent.

### Legacy Migration

If `.missions/current` exists (the legacy layout) and `.ratel/migration-v1.json` does not, the control plane performs a one-time migration on startup:
1. Reads legacy `state.json` to extract the mission/trace ID.
2. Copies `.missions/current` contents into `.ratel/missions/<missionId>/`.
3. Writes `.ratel/migration-v1.json` and `.ratel/current-mission.json`.
4. The legacy directory is **never deleted**.

The migration is idempotent: if `migration-v1.json` exists, nothing happens.

---

## Philosophy & Constraints

**What the factory controls (deterministic):**
- Branch detection, workspace finalization
- Parse/report schema validation
- Timeouts, raw output persistence
- Shard IDs, concurrency limits
- Artifact paths, aggregate bookkeeping

**What models control (judgment):**
- Planning, implementation decisions
- Pass/fail judgment on validation
- Product issue severity and rationale
- Scope interpretation

**Anti-patterns the factory avoids:**
- Hard-coded scenario severity rules
- Deterministic product behavior rules
- Replacing validators with deterministic BDD runners
- Heavy deterministic state machines

---

## License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](LICENSE) file for details.
