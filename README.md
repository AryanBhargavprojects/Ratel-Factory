<p align="center">
  <img src="Ratel_logo.png" alt="Ratel Logo" width="200">
</p>

<h1 align="center">Ratel — AI Software Factory</h1>

<p align="center">
  <strong>Thin deterministic orchestration + model-owned implementation for autonomous software missions</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#adapters">Adapters</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#development">Development</a>
</p>

---

## What is Ratel?

Ratel is an **AI Software Factory** — a framework for running autonomous software development missions. It orchestrates AI agents to plan, implement, and validate software projects while maintaining thin deterministic control over bookkeeping, isolation, routing, schemas, timeouts, persistence, and handoffs.

**Core philosophy:**
- **Deterministic code** owns schemas, persistence, routing, timeouts, integration, completion integrity, aggregation
- **Model agents** own planning, implementation, validation judgment, and product interpretation
- **Non-bypassable gates** ensure features can only complete when workers produce clean handoffs with merged branches and zero high-severity issues

---

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Git
- (Optional) Ollama for local AI models
- (Optional) API keys for OpenAI, Anthropic, or other Pi-supported providers

### Installation

Ratel supports multiple coding agents. Choose the installer for your agent:

#### OpenCode

```bash
curl -fsSL https://ratel.dev/install-opencode.sh | bash
```

This installs:
- `@ratel/core` — the factory service
- `@ratel/opencode` — the OpenCode plugin with `/ratel` commands and tools
- Command stubs: `/ratel`, `/ratel-mission`, `/ratel-observatory`
- Starts the Ratel service in the background

#### Pi SDK

```bash
curl -fsSL https://ratel.dev/install-pi.sh | bash
```

This installs:
- `@ratel/core` — the factory service
- `@ratel/pi-extension` — the Pi extension with lifecycle hooks and tools
- Starts the Ratel service in the background

Then activate the extension:
```bash
pi install @ratel/pi-extension
```

#### Development (from source)

```bash
# Clone the repository
git clone <repository-url>
cd ratel

# Install dependencies
npm install

# Build all packages
npm run build:all

# Start the factory in direct mode
npm run dev
```

**Installer flags:**
- `--dev` — Install from local workspace instead of npm
- `--port 9999` — Override the default service port (8765)
- `--help` — Show usage

**Example:**
```bash
bash install/install-opencode.sh --dev --port 9999
```

### Running a Mission

1. Start the factory: `npm run dev`
2. The factory will enter **Intake** phase and ask about your project
3. Describe what you want to build (e.g., "A real-time chat app with AI categorization")
4. The orchestrator will run through phases: Discovery → Clarification → Constraint Analysis → Validation Contract → Feature Decomposition → User Approval → Execution
5. Workers implement features one at a time, validators verify them
6. Mission artifacts are persisted in `.missions/current/`

---

## Architecture

```
User (OpenCode or Pi SDK)
  ↓
Adapter (thin wrapper — no orchestration logic)
  │   • OpenCode Plugin: /ratel commands, ratel_start_mission tool
  │   • Pi Extension: lifecycle hooks, phase management, tools
  ↓
Ratel Service (HTTP API)
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
  └─→ User-Testing Validator (browser-based scenario execution)
            └─→ Sharded per .feature file
```

### Adapter Architecture

Ratel uses a **service-first** architecture:

- **Core Service** (`@ratel/core`) — runs as a standalone HTTP service. All state lives here.
- **Adapters** are thin HTTP clients that register tools/commands with the agent's extension API.
- **Direct mode** — `src/adapters/pi-sdk/main.ts` runs the core in-process without the HTTP layer (for development).

**Key rule:** Adapters hold no state. All state lives in the service.

### Key Components

| Component | Responsibility |
|-----------|---------------|
| **Orchestrator** | Mission lifecycle, user communication, agent spawning, go/no-go decisions |
| **Worker** | Single-feature implementation with TDD, git commits, structured handoff |
| **Scrutiny Validator** | Automated tests, typecheck, lint + parallel code review subagents |
| **User-Testing Coordinator** | Deterministic shard planning, one shard per `.feature` file |
| **User-Testing Shard** | Browser automation per feature file, scenario execution |
| **Observatory** | Live dashboard of agent lifecycles, tool calls, parse status |

---

## How It Works

### Mission Phases

1. **Intake** — User describes the project goal
2. **Discovery** — Codebase inspection, feasibility analysis
3. **Clarification** — Requirements refinement with user
4. **Constraint Analysis** — Tech stack, non-goals, risk assessment
5. **Validation Contract** — Gherkin `.feature` files defining "done"
6. **Feature Decomposition** — Break into implementable features with assertions
7. **User Approval** — Present plan, user confirms or adjusts
8. **Execution** — Workers implement features, validators verify

### Workspace Resolution

The factory discovers or prepares the canonical workspace:
- Reads `requirements.json` for explicit `directory` field
- Auto-initializes git in the target directory if needed
- Creates `integration` branch as the canonical integration point
- Workers work in serial feature branches (`feat/F1`, `feat/F2`, ...)
- Clean handoffs are merged back to `integration`

### Completion Gate

A feature can only be marked **completed** when:
- Worker handoff parses successfully (`parseStatus: "ok"`)
- `leftUndone` is empty
- No high-severity issues discovered
- Workspace finalization is `merged` or `skipped`

This is enforced by the `mark_feature_completed` tool — direct `features.json` writes are rejected.

---

## Configuration

### `ratel.json`

The main factory configuration:

```json
{
  "name": "ratel",
  "version": "0.1.0",
  "orchestrator": {
    "model": "opencode-go/deepseek-v4-pro",
    "thinkingLevel": "medium",
    "defaultSkills": [
      "grill-with-docs",
      "parallel-web-search",
      "agent-browser",
      ...
    ]
  },
  "workers": {
    "model": "ollama/kimi-k2.6:cloud",
    "defaultTools": ["read", "bash", "edit", "write"]
  },
  "validators": {
    "model": "ollama/minimax-m3:cloud",
    "defaultTools": ["read", "bash", "grep", "find", "ls"]
  }
}
```

### Model Configuration

Ratel uses the Pi SDK model registry. Set models via:
- `ratel.json` — default for all missions
- `set_model` tool — per-session override
- Environment / Pi SDK auth storage — provider API keys

### Skills

Skills are loaded from:
- `.pi/skills/` — Pi SDK built-in skills (agent-browser, find-docs, etc.)
- `skills/` — Your custom skills
- `.agents/skills/` — Agent-specific skills

See `skills-lock.json` for the skills manifest.

---

## Development

### Scripts

```bash
# Development
npm run dev          # Start factory in direct mode (tsx)
npm run dev:core     # Start core service (tsx)

# Building
npm run build        # Build root package
npm run build:all    # Build all packages

# Testing
npm test             # Run all tests (10 tests)
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
│   ├── core/                     # @ratel/core — Factory service
│   │   ├── src/
│   │   │   ├── api.ts            # HTTP API server
│   │   │   ├── index.ts          # Service entry point
│   │   │   ├── core/             # Factory core logic
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── tools.ts
│   │   │   │   ├── workers/
│   │   │   │   ├── mission/
│   │   │   │   └── ...
│   │   │   └── observatory/      # Dashboard service
│   │   └── package.json
│   │
│   ├── opencode-plugin/          # @ratel/opencode — OpenCode plugin
│   │   ├── src/
│   │   │   ├── plugin.ts         # Plugin entry
│   │   │   ├── service.ts        # HTTP client
│   │   │   ├── commands.ts       # Command handlers
│   │   │   └── prompts.ts        # Prompts
│   │   ├── commands/             # Slash command stubs
│   │   │   ├── ratel.md
│   │   │   ├── ratel-mission.md
│   │   │   └── ratel-observatory.md
│   │   └── package.json
│   │
│   └── pi-extension/             # @ratel/pi-extension — Pi extension
│       ├── src/
│       │   ├── extension.ts      # Extension entry
│       │   ├── service.ts        # HTTP client
│       │   ├── tool-scope.ts     # Phase management
│       │   ├── commands.ts       # Command handlers
│       │   └── prompts.ts        # Prompts
│       └── package.json
│
├── src/                    # Factory source code (backward compat)
│   ├── core/              # Original core logic
│   ├── observatory/       # Original observatory
│   └── adapters/          # Pi SDK direct mode
│       └── pi-sdk/
│           ├── main.ts    # Direct/headless entry
│           └── agents.ts  # Pi-specific helpers
│
├── test/                   # Factory tests (10 tests)
├── install/               # Installer scripts
│   ├── install-opencode.sh
│   └── install-pi.sh
│
├── .pi/skills/            # Pi SDK skills
├── skills/                # Custom skills
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

### OpenCode Plugin (`@ratel/opencode`)

**Commands:**
- `/ratel` — Toggle factory mode
- `/ratel-mission` — Show current mission status
- `/ratel-observatory` — Open Observatory dashboard

**Tools:**
- `ratel_start_mission` — Start a new mission with a goal
- `ratel_get_status` — Get mission status
- `ratel_run_worker` — Run a worker for a feature
- `ratel_run_validation` — Run validation for a milestone

### Pi Extension (`@ratel/pi-extension`)

**Commands:**
- `/ratel` — Toggle factory mode
- `/ratel-mission` — Show current mission status
- `/ratel-observatory` — Open Observatory dashboard

**Tools:**
- `ratel_start_mission` — Start a new mission
- `ratel_run_worker` — Run a worker for a feature
- `ratel_run_validator` — Run validation for a milestone

**Lifecycle hooks:**
- `session_start` — Restore persisted phase state
- `before_agent_start` — Inject factory context
- `turn_end` — Track phase transitions based on tool usage
- `tool_call` — Gate writes during planning phase

### Service API

```bash
GET  /health                    → { status: "ok" }
POST /api/mission/start         → { goal: string } → { missionId }
GET  /api/mission/status        → { missionId } → { state }
POST /api/mission/worker        → { missionId, featureId } → { status }
POST /api/mission/validate      → { missionId, milestoneId } → { status }
GET  /api/mission/artifacts     → { missionId } → { artifacts }
POST /api/mission/complete      → { missionId, featureId } → { status }
GET  /api/observatory/events    → { events }
GET  /api/observatory/status    → { enabled, url }
```

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

[Add your license here]

---

<p align="center">
  <em>Built with the Pi SDK — agent-native orchestration for autonomous software development</em>
</p>
