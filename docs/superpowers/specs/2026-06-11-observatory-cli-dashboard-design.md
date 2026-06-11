# Design Specification: Ratel Observatory CLI-Style Dashboard

## 1. Goal & Overview
Redesign the Ratel Observatory Dashboard UI into an interactive, multi-pane terminal screen resembling modern developer CLI tools (e.g., Claude Code, Codex, ChatGPT CLI). 

The screen is split into three main vertical columns (Orchestration, Worker, Validator) to show the parallel progress of the root orchestrator and subagents in real-time. When subagents are inactive, they display interactive, animated "sleeping" states.

## 2. UI Layout & Visual Design
* **Palette**: Strict monochrome dark theme (`#060608` background, `#ffffff` primary text, `#8e8e93` accent gray, `#1a1a20` borders).
* **Typography**: Modern font pairings using **Outfit** for headers/structure and **JetBrains Mono** for CLI outputs.
* **Top Status Bar**: Holds the mission goal, phase, and engine state. Includes a collapsible panel button to pull down the original feature plan checklist.
* **Console Columns (Grid)**:
  * **◈ ORCHESTRATION**: Root agent log stream. Renders thoughts as distinct cards and tool execution logs with command-line prompts (`$`).
  * **◇ WORKER PANEL**: Shows worker logs, active tool names, and a dedicated, persistent **Live Hunk Diff Pane** at the bottom (displaying additions in green, deletions in red, and context lines in neutral gray).
  * **⬪ VALIDATION CONTROL**: Green-on-black console showing validation preflight checks, recovery states, and test execution results.

## 3. Dynamic Agent States (Active vs. Sleep)
* **Sleeping State**: If no active span is detected for the subagent, the pane displays a retro ASCII art representation of the agent logo, along with a slowly blinking cursor and text: `[AGENT] SLEEPING`.
* **Running State**: Shifts dynamically to active styling (glow border, white text, active status badge) and begins streaming CLI logs when the orchestrator starts the subagent span.

## 4. Integration & Testing
* We will replace the main `src/observatory/dashboard.html` file with the approved prototype code.
* We will update `test/observatory-server.test.ts` to reflect the new DOM selectors and width constraints, ensuring all tests pass.
