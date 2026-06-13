# Design Specification: Ratel Landing Page & Developer Hub

This document specifies the design, typography, layout, content structure, and interactive components for the Ratel AI Software Factory landing page.

---

## 1. Design Ethos: "Hybrid Cyber-Monospace"

Inspired by `exe.dev`, the website follows a hacker-minimalist aesthetic tailored for developers:
*   **Monospace Stack**: Monospace typography is used for all text (headings, body, code, buttons, nav links) to emphasize the terminal-like nature of the tool.
*   **Strict Density**: High information density with clean, compact text spacing.
*   **Borders as Dividers**: Grid lines and sections are separated by sharp `1px` borders instead of drop shadows or gradient backgrounds.
*   **Selective Color Accents**: A strict monochrome layout base with terminal-like highlights: **Console Green** for status indicators and caret prompts, and **Sky Blue** for arguments and hyperlinks.

---

## 2. Typography System

We import the `JetBrains Mono` font stack from Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Typography Hierarchy

| Element | Font Size (Desktop) | Font Size (Mobile) | Font Weight | Line Height | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Hero Title** | `clamp(2.5rem, 6.5vw, 4.8rem)` | `clamp(1.75rem, 11vw, 2.75rem)` | `700` (Bold) | `1.05` | Stretching letter spacing (`-0.02em`) |
| **H2 Section Header** | `1.4rem` | `1.25rem` | `600` (Semibold) | `1.2` | Bold section anchors |
| **H3 Feature Header** | `0.95rem` | `0.95rem` | `600` (Semibold) | `1.3` | Matches feature cards |
| **Navigation & Buttons**| `0.80rem` | `0.75rem` | `500` (Medium) | `1.6` | Smaller uppercase style |
| **Body Copy** | `0.80rem` | `0.80rem` | `400` (Regular) | `1.7` | Spacious line height |
| **Meta / Code Copy** | `0.78rem` | `0.70rem` | `400` (Regular) | `1.5` | Labels, terminal outputs, code blocks |

---

## 3. Color Theme System

The page adapts dynamically to light or dark mode using media queries:

```css
:root {
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  --bg-color: #ffffff;
  --text-color: #111111;
  --text-muted: #6b7280;
  --border-color: #e5e7eb;
  --card-bg: #fafafa;
  --console-green: #008000;
  --console-blue: #0066cc;
  --accent-action: #111111;
  --accent-hover: #333333;
  --accent-text: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-color: #111111;
    --text-color: #f3f4f6;
    --text-muted: #9ca3af;
    --border-color: #2a2a2a;
    --card-bg: #1a1a1a;
    --console-green: #32d74b;
    --console-blue: #64d2ff;
    --accent-action: #f3f4f6;
    --accent-hover: #d1d5db;
    --accent-text: #111111;
  }
}
```

*Note: For the code terminal emulator, we use a fixed Unix Dark scheme (`--bg-color: #1c1c1e` and `--text-color: #e5e5e7`).*

---

## 4. Page Layout & Content Structure

The layout is divided into 4 main sections using two maximum-width bounds:
1.  **Wide Content Container (`max-width: 1200px`)**: Used for the Navigation, Hero Header, and Feature Grid.
2.  **Narrow Content Container (`max-width: 720px`)**: Used for the Onboarding Guides, Configuration snippet, and Footer.

### Section 1: Navigation
*   **Header Logo**: Centered brand text `Ratel` with status ticker indicator `Engine: Online` (green pulsing indicator).
*   **Right Side Link**: A single link to GitHub or local documentation.

### Section 2: Hero Area (Dynamic Split View)
*   **Left Column**:
    *   Malleable animated heading: `Ratel — AI Software Factory`.
    *   Sub-proposition: *"A thin deterministic core managing state, schemas, and workspace branches, while specialized AI agents plan, code, and validate features."*
    *   CTA Group: `[Get Started]` button scrolling to onboarding, next to a copyable cmd widget displaying `npm i -g @ratel/core`.
*   **Right Column**: Monospace Terminal Emulator.
    *   Types out `ratel start "A Svelte currency converter"`.
    *   Streams a sequence of mock logs simulating the 8 intake, contract, and execution phases.
    *   Color codes green carets/success lines, blue phase indicators, and gray sub-steps.

### Section 3: Technical Specifications Grid
*   **Header**: `02 / CORE SYSTEMS` H2 header.
*   **Grid layout**: 3 columns on desktop, 1 column on mobile. Cards separated by sharp `1px` borders and anchored with a thick (`2px`) top border.
*   **Core Systems Card Content**:
    *   *01 / Branch Isolation*: Editing takes place on isolated `feat/Fx` branches.
    *   *02 / Completion Gates*: Milestones gated by reports check and validation tests.
    *   *03 / Live Observatory*: Web dashboard displaying live streams and git diffs.
    *   *04 / Shard Orchestration*: Shards cucumber features to run E2E scenarios.
    *   *05 / Auto-Recovery*: Automatically attempts recovery loops on errors.
    *   *06 / Configuration Decoupling*: Models and pipelines configured in `ratel.json`.

### Section 4: Onboarding & Setup
*   **Header**: `03 / INSTALLATION & ONBOARDING` H2 header.
*   **Tabbed Code Box**: Monospace switcher tabs: `[ OpenCode ]`, `[ Pi SDK ]`, `[ Source Setup ]`.
*   *OpenCode content*: Script install command `curl -fsSL https://ratel.dev/install-opencode.sh | bash` and info notes.
*   *Pi SDK content*: Script command `curl -fsSL https://ratel.dev/install-pi.sh | bash` and activation note `pi install @ratel/pi-extension`.
*   *Source Setup content*: Standard CLI setup `git clone`, `npm install`, `npm run build`, `npm run dev`.
*   **Config Snippet**: Core config JSON block representation explaining model levels.

### Footer
*   **Left Side**: Muted text: `Proudly open-source ❤️`.
*   **Right Side**: Minimalist navigation links: `GitHub • Docs • X`.

---

## 5. Micro-Animations & Interactivity

To make the developer hub feel alive, the page implements:
1.  **Terminal Autotyping loop**: Typing effect at 50ms/char, line output pacing at 300ms–800ms, loops with a 6-second delay.
2.  **Tab Switcher Utility**: Vanilla JS event listener toggles classes on buttons and switches active code display card content.
3.  **Click-to-Copy helper**: Click handler on the code snippets copies text to clipboard and briefly changes button state to `[Copied!]`.
4.  **OS-Native Dark Mode**: CSS rules automatically adapt variables without layout shifts.
