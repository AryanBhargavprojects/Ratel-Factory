# Ratel Landing Page & Developer Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hacker-style developer landing page and onboarding hub for Ratel using Astro in `marketing/`, including an interactive terminal simulator and custom layout matching the design spec.

**Architecture:** We will implement an Astro page structure containing modular components for the terminal emulator and feature blocks. To ensure high quality, we will write a build verification test in the root `test/` suite that compiles the marketing package and asserts the presence of the styled containers, typography, and specific footer links.

**Tech Stack:** Node.js, Astro (v6), HTML, CSS, JavaScript (ESM).

---

### Task 1: Add Build Verification Test Case to Test Suite

**Files:**
- Create: `test/marketing-build.test.ts`

- [ ] **Step 1: Create the build verification test file**
  Create `test/marketing-build.test.ts` with the following contents:
  ```typescript
  import { test } from "node:test";
  import assert from "node:assert";
  import { execSync } from "node:child_process";
  import { readFileSync, existsSync } from "node:fs";
  import { join } from "node:path";

  test("marketing site builds successfully and contains expected elements", () => {
    const marketingDir = join(process.cwd(), "marketing");
    
    // 1. Run build command inside marketing
    execSync("npm run build", { cwd: marketingDir, stdio: "ignore" });
    
    // 2. Check output index.html exists
    const htmlPath = join(marketingDir, "dist", "index.html");
    assert.ok(existsSync(htmlPath), "Built index.html should exist");
    
    const html = readFileSync(htmlPath, "utf-8");
    
    // 3. Assert title is correct
    assert.ok(html.includes("<title>Ratel — AI Software Factory</title>"), "Title should match design spec");
    
    // 4. Assert JetBrains Mono font is imported
    assert.ok(html.includes("fonts.googleapis.com/css2?family=JetBrains+Mono"), "JetBrains Mono font should be imported");
    
    // 5. Assert layout components are present
    assert.ok(html.includes('id="terminal-container"'), "Terminal emulator container should be present");
    assert.ok(html.includes("02 / CORE SYSTEMS"), "Features grid section should be present");
    assert.ok(html.includes("03 / INSTALLATION & ONBOARDING") || html.includes("03 / INSTALLATION &amp; ONBOARDING"), "Onboarding section should be present");
    
    // 6. Assert footer modifications are present
    assert.ok(html.includes("Proudly open-source"), "Footer should contain Proudly open-source");
    assert.ok(html.includes("GitHub"), "Footer should contain GitHub link");
    assert.ok(html.includes("Docs"), "Footer should contain Docs link");
    assert.ok(html.includes("X"), "Footer should contain X link");
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx test/marketing-build.test.ts`
  Expected: FAIL (either because `npm run build` fails on the default welcome templates lacking these IDs, or because file assertions fail).

- [ ] **Step 3: Commit**
  Run:
  ```bash
  git add test/marketing-build.test.ts
  git commit -m "test: add marketing build verification test"
  ```

---

### Task 2: Configure Global Layout (`Layout.astro`) and CSS Variables

**Files:**
- Modify: `marketing/src/layouts/Layout.astro`

- [ ] **Step 1: Rewrite `Layout.astro` to set up metadata and the design system variables**
  Overwrite `marketing/src/layouts/Layout.astro` with the following code:
  ```astro
  ---
  interface Props {
    title?: string;
  }
  const { title = "Ratel — AI Software Factory" } = Astro.props;
  ---
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <meta name="generator" content={Astro.generator} />
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
      <title>{title}</title>
    </head>
    <body>
      <slot />
    </body>
  </html>

  <style is:global>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

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

    html,
    body {
      font-family: var(--font-mono);
      background: var(--bg-color);
      color: var(--text-color);
      min-height: 100dvh;
      overflow-x: hidden;
      font-size: 0.8rem;
      scroll-behavior: smooth;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    .container-wide {
      max-width: 1200px;
      margin: 0 auto;
      padding: 4rem 2rem;
      width: 100%;
    }

    .container-narrow {
      max-width: 720px;
      margin: 0 auto;
      padding: 4rem 2rem;
      width: 100%;
    }

    .divider-section {
      border-top: 1px solid var(--border-color);
    }
  </style>
  ```

- [ ] **Step 2: Run verification build**
  Run: `npm run build` inside the `marketing` directory.
  Expected: Success, compiling Layout.

- [ ] **Step 3: Commit**
  Run:
  ```bash
  git add marketing/src/layouts/Layout.astro
  git commit -m "feat: configure Layout.astro with global styles and variables"
  ```

---

### Task 3: Implement Monospace Terminal Emulator Component

**Files:**
- Create: `marketing/src/components/TerminalEmulator.astro`

- [ ] **Step 1: Create the Terminal Emulator component**
  Create `marketing/src/components/TerminalEmulator.astro` with the following code:
  ```astro
  ---
  ---
  <div id="terminal-container" class="terminal-window">
    <div class="terminal-header">
      <div class="terminal-buttons">
        <span class="btn-dot close"></span>
        <span class="btn-dot minimize"></span>
        <span class="btn-dot expand"></span>
      </div>
      <div class="terminal-title">ratel-mission-runner</div>
    </div>
    <div class="terminal-body">
      <div id="terminal-output" class="terminal-text"></div>
    </div>
  </div>

  <style>
    .terminal-window {
      background: #1c1c1e;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 380px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }

    .terminal-header {
      background: #2c2c2e;
      padding: 8px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #3a3a3c;
      flex-shrink: 0;
      user-select: none;
    }

    .terminal-buttons {
      display: flex;
      gap: 6px;
    }

    .btn-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }

    .btn-dot.close { background: #ff453a; }
    .btn-dot.minimize { background: #ffd60a; }
    .btn-dot.expand { background: #30d158; }

    .terminal-title {
      font-size: 0.72rem;
      color: #98989d;
      font-family: var(--font-mono);
      flex: 1;
      text-align: center;
      padding-right: 36px;
    }

    .terminal-body {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .terminal-text {
      color: #e5e5e7;
      font-family: var(--font-mono);
      font-size: 0.76rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }
  </style>

  <script>
    const lines = [
      { type: "input", text: "ratel start \"A Svelte currency converter\"" },
      { type: "info", text: "\n[INFO] Initializing Ratel Software Factory..." },
      { type: "phase", text: "[PHASE 1] Intake: Registering goal... OK" },
      { type: "phase", text: "[PHASE 2] Discovery: Scanning workspace files..." },
      { type: "sub", text: "  -> Found src/components/, package.json" },
      { type: "phase", text: "[PHASE 4] Constraint Analysis: Detecting dependencies..." },
      { type: "sub", text: "  -> Framework: Svelte" },
      { type: "sub", text: "  -> Target directory: ./currency-converter" },
      { type: "phase", text: "[PHASE 5] Validation Contract: Writing Gherkin features..." },
      { type: "sub", text: "  -> Created features/calculations.feature" },
      { type: "sub", text: "  -> Created validation-contract.md" },
      { type: "phase", text: "[PHASE 7] User Approval: Awaiting dashboard confirmation..." },
      { type: "sub", text: "  -> Opening Observatory dashboard at http://localhost:8765" },
      { type: "sub", text: "  -> Plan APPROVED by user." },
      { type: "phase", text: "[PHASE 8] Execution: Spawning worker and validator agents..." },
      { type: "sub", text: "  -> [feat/F1] Coding currency calculation logic... OK" },
      { type: "sub", text: "  -> [Validator] Running Vitest checks... 12/12 PASSED" },
      { type: "sub", text: "  -> [Validator] Executing Playwright E2E shard... PASSED" },
      { type: "sub", text: "  -> [Gate] Verification contract satisfied." },
      { type: "success", text: "[SUCCESS] Mission completed! Changes merged into integration branch.\n" }
    ];

    const outputElement = document.getElementById("terminal-output");
    
    async function runTerminalSimulation() {
      if (!outputElement) return;
      outputElement.innerHTML = "";

      for (const line of lines) {
        if (line.type === "input") {
          // Type command
          const promptSpan = document.createElement("span");
          promptSpan.style.color = "#32d74b";
          promptSpan.textContent = "guest@ratel-factory:~$ ";
          outputElement.appendChild(promptSpan);

          const cmdSpan = document.createElement("span");
          outputElement.appendChild(cmdSpan);

          for (let i = 0; i < line.text.length; i++) {
            cmdSpan.textContent += line.text[i];
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else {
          // Print logs
          const logSpan = document.createElement("span");
          if (line.type === "phase") {
            logSpan.style.color = "#64d2ff";
          } else if (line.type === "success") {
            logSpan.style.color = "#32d74b";
            logSpan.style.fontWeight = "bold";
          } else if (line.type === "sub") {
            logSpan.style.color = "#9ca3af";
          }
          logSpan.textContent = line.text + "\n";
          outputElement.appendChild(logSpan);
          
          // Scroll container to bottom
          const body = outputElement.parentElement;
          if (body) {
            body.scrollTop = body.scrollHeight;
          }
          
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }

      // Loop restart
      await new Promise((resolve) => setTimeout(resolve, 6000));
      runTerminalSimulation();
    }

    // Launch simulation on load
    runTerminalSimulation();
  </script>
  ```

- [ ] **Step 2: Run verification build**
  Run: `npm run build` inside `marketing`
  Expected: Success.

- [ ] **Step 3: Commit**
  Run:
  ```bash
  git add marketing/src/components/TerminalEmulator.astro
  git commit -m "feat: add TerminalEmulator component with typing simulation"
  ```

---

### Task 4: Implement Feature Card Block Component

**Files:**
- Create: `marketing/src/components/FeatureBlock.astro`

- [ ] **Step 1: Create the FeatureBlock component**
  Create `marketing/src/components/FeatureBlock.astro` with the following code:
  ```astro
  ---
  interface Props {
    num: string;
    title: string;
    codeSnippet?: string;
  }
  const { num, title, codeSnippet } = Astro.props;
  ---
  <div class="feature-block">
    <div class="feature-num">{num}</div>
    <h3 class="feature-title">{title}</h3>
    <p class="feature-desc">
      <slot />
    </p>
    {codeSnippet && <code class="feature-code">{codeSnippet}</code>}
  </div>

  <style>
    .feature-block {
      padding-top: 1.5rem;
      border-top: 2px solid var(--text-color);
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .feature-num {
      font-size: 0.72rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .feature-title {
      font-size: 0.95rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-color);
    }

    .feature-desc {
      color: var(--text-muted);
      line-height: 1.6;
      font-size: 0.80rem;
    }

    .feature-code {
      align-self: flex-start;
      margin-top: 0.4rem;
      font-size: 0.72rem;
      background: var(--tag-fill);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--console-blue);
      border: 1px solid var(--border-color);
    }
  </style>
  ```

- [ ] **Step 2: Run verification build**
  Run: `npm run build` inside `marketing`
  Expected: Success.

- [ ] **Step 3: Commit**
  Run:
  ```bash
  git add marketing/src/components/FeatureBlock.astro
  git commit -m "feat: add FeatureBlock component with top border layouts"
  ```

---

### Task 5: Assemble the Index Page (`index.astro`) & Onboarding Section

**Files:**
- Modify: `marketing/src/pages/index.astro`

- [ ] **Step 1: Replace `index.astro` with the complete layout**
  Overwrite `marketing/src/pages/index.astro` with the following code:
  ```astro
  ---
  import Layout from '../layouts/Layout.astro';
  import TerminalEmulator from '../components/TerminalEmulator.astro';
  import FeatureBlock from '../components/FeatureBlock.astro';
  ---
  <Layout>
    <!-- ── NAV ── -->
    <nav class="container-wide nav-bar">
      <div class="nav-brand">
        <span class="brand-logo">RATEL</span>
        <span class="brand-status"><span class="pulse-dot"></span>Engine: Online</span>
      </div>
      <div class="nav-links">
        <a href="https://github.com/AryanBhargavprojects/Ratel-Factory" class="nav-link">GitHub</a>
      </div>
    </nav>

    <!-- ── HERO SECTION ── -->
    <header class="container-wide hero-section">
      <div class="hero-intro">
        <h1 class="hero-title">Ratel — AI Software Factory</h1>
        <p class="hero-desc">
          A thin deterministic core managing state, schemas, and workspace branches, while specialized AI agents plan, code, and validate features.
        </p>
        <div class="hero-ctas">
          <a href="#installation-guide" class="btn-primary">Get Started</a>
          <div class="cmd-snippet">
            <span class="cmd-prefix">$</span>
            <span id="cmd-text">npm i -g @ratel/core</span>
            <button id="btn-copy-install" class="btn-copy">copy</button>
          </div>
        </div>
      </div>
      <div class="hero-showcase">
        <TerminalEmulator />
      </div>
    </header>

    <!-- ── CORE FEATURES ── -->
    <section class="divider-section">
      <div class="container-wide">
        <h2 class="section-header">02 / CORE SYSTEMS</h2>
        <div class="features-grid">
          <FeatureBlock num="01" title="Branch Isolation" codeSnippet="git checkout -b feat/F1">
            Worker agents execute modifications entirely inside dedicated feature branches, ensuring your main workspace is never left in a broken state.
          </FeatureBlock>
          <FeatureBlock num="02" title="Completion Gates" codeSnippet='{ "parseStatus": "ok" }'>
            Enforces strict gates. Features cannot be merged unless reports parse correctly, tests pass, and zero high-severity issues are reported.
          </FeatureBlock>
          <FeatureBlock num="03" title="Observatory Console" codeSnippet="http://localhost:8765">
            Timeline dashboards run natively to stream agent tool execution logs, git diffs, and host the interactive widescreen plan review console.
          </FeatureBlock>
          <FeatureBlock num="04" title="Parallel Sharding" codeSnippet="playwright test --shard=1/3">
            Splits Cucumber scenario tests into concurrent execution shards to reduce integration latency and run E2E browser checks in parallel.
          </FeatureBlock>
          <FeatureBlock num="05" title="Auto-Recovery" codeSnippet="[Recovery] Retrying...">
            Automatically intercepts typescript compilations, lints, or test errors, feeding compiler logs back into workers to resolve bugs in-loop.
          </FeatureBlock>
          <FeatureBlock num="06" title="Decoupled Config" codeSnippet="ratel.json">
            Persists agent configurations in standard workspace JSON files, allowing models and tools to be customized per-milestone.
          </FeatureBlock>
        </div>
      </div>
    </section>

    <!-- ── ONBOARDING & SETUP ── -->
    <section id="installation-guide" class="divider-section">
      <div class="container-narrow">
        <h2 class="section-header">03 / INSTALLATION & ONBOARDING</h2>
        <p class="section-intro">
          Ratel supports multiple coding agents. Choose the installer matching your active ecosystem or build from source:
        </p>
        
        <!-- Tabbed Container -->
        <div class="tab-container">
          <div class="tab-headers">
            <button id="tab-opencode" class="tab-btn active" data-tab="opencode">[ OpenCode ]</button>
            <button id="tab-pi" class="tab-btn" data-tab="pi">[ Pi SDK ]</button>
            <button id="tab-source" class="tab-btn" data-tab="source">[ Source Setup ]</button>
          </div>
          
          <div class="tab-body">
            <button id="btn-copy-code" class="btn-copy-overlay">Copy</button>
            <pre class="code-block"><code id="code-display"></code></pre>
          </div>
        </div>

        <!-- Configurations preview -->
        <div class="config-section">
          <h3 class="config-title">Sample ratel.json</h3>
          <pre class="code-block"><code>{
  "name": "ratel",
  "version": "0.1.0",
  "observability": {
    "enabled": true,
    "port": 8765
  },
  "orchestrator": {
    "model": "openai/gpt-4o"
  },
  "workers": {
    "model": "anthropic/claude-3-5-sonnet"
  }
}</code></pre>
        </div>
      </div>
    </section>

    <!-- ── FOOTER ── -->
    <footer class="divider-section footer-bar">
      <div class="container-narrow footer-content">
        <div class="footer-left">
          Proudly open-source ❤️
        </div>
        <div class="footer-right">
          <a href="https://github.com/AryanBhargavprojects/Ratel-Factory" class="footer-link">GitHub</a> •
          <a href="https://github.com/AryanBhargavprojects/Ratel-Factory#readme" class="footer-link">Docs</a> •
          <a href="https://x.com" class="footer-link">X</a>
        </div>
      </div>
    </footer>
  </Layout>

  <style>
    /* Nav bar styling */
    .nav-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 1.5rem;
      padding-bottom: 1.5rem;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand-logo {
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .brand-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.72rem;
      color: var(--text-muted);
      border: 1px solid var(--border-color);
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--card-bg);
    }
    .pulse-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--console-green);
      display: inline-block;
      box-shadow: 0 0 6px var(--console-green);
      animation: pulseAnim 2s infinite;
    }
    @keyframes pulseAnim {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }
    .nav-link {
      font-size: 0.76rem;
      color: var(--text-muted);
      transition: color 0.15s;
    }
    .nav-link:hover {
      color: var(--text-color);
    }

    /* Hero section styling */
    .hero-section {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      align-items: center;
      gap: 4rem;
      padding-top: 4rem;
      padding-bottom: 6rem;
    }
    .hero-intro {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    .hero-title {
      font-size: clamp(2rem, 5.5vw, 3.2rem);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.5px;
    }
    .hero-desc {
      font-size: 0.88rem;
      color: var(--text-muted);
      line-height: 1.6;
    }
    .hero-ctas {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      margin-top: 0.5rem;
    }
    .btn-primary {
      font-size: 0.78rem;
      font-weight: 600;
      padding: 8px 16px;
      background: var(--accent-action);
      color: var(--accent-text);
      border-radius: 4px;
      border: 1px solid var(--border-color);
      transition: background 0.15s;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    .cmd-snippet {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.72rem;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      padding: 6px 12px;
      border-radius: 4px;
      color: var(--text-color);
      font-family: var(--font-mono);
    }
    .cmd-prefix {
      color: var(--console-green);
      font-weight: bold;
      user-select: none;
    }
    .btn-copy {
      background: transparent;
      border: none;
      color: var(--console-blue);
      cursor: pointer;
      font-size: 0.72rem;
      font-family: var(--font-mono);
      padding: 0 4px;
      outline: none;
    }
    .btn-copy:hover {
      text-decoration: underline;
    }

    /* Features Grid section */
    .section-header {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 2rem;
      letter-spacing: 1px;
      color: var(--text-color);
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--border-color);
    }
    .features-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2.5rem 2rem;
    }

    /* Onboarding section styling */
    .section-intro {
      font-size: 0.84rem;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .tab-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 2.5rem;
    }
    .tab-headers {
      display: flex;
      gap: 12px;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 0.76rem;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      outline: none;
      transition: all 0.15s;
    }
    .tab-btn:hover {
      color: var(--text-color);
      border-color: var(--text-color);
    }
    .tab-btn.active {
      color: var(--accent-text);
      background: var(--accent-action);
      border-color: var(--accent-action);
    }
    .tab-body {
      position: relative;
    }
    .btn-copy-overlay {
      position: absolute;
      top: 8px;
      right: 12px;
      background: transparent;
      border: none;
      color: var(--console-blue);
      font-family: var(--font-mono);
      font-size: 0.72rem;
      cursor: pointer;
      outline: none;
    }
    .btn-copy-overlay:hover {
      text-decoration: underline;
    }
    .code-block {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
    }
    .code-block code {
      font-family: var(--font-mono);
      font-size: 0.76rem;
      line-height: 1.5;
      color: var(--text-color);
    }
    .config-section {
      margin-top: 3rem;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .config-title {
      font-size: 0.84rem;
      font-weight: 600;
      color: var(--text-color);
    }

    /* Footer bar styling */
    .footer-bar {
      margin-top: 4rem;
    }
    .footer-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 2rem;
      padding-bottom: 2rem;
    }
    .footer-left {
      font-size: 0.76rem;
      color: var(--text-muted);
    }
    .footer-right {
      font-size: 0.76rem;
      color: var(--text-muted);
      display: flex;
      gap: 12px;
    }
    .footer-link {
      transition: color 0.15s;
    }
    .footer-link:hover {
      color: var(--text-color);
    }

    /* Responsive styling */
    @media (max-width: 900px) {
      .hero-section {
        grid-template-columns: 1fr;
        gap: 3rem;
        padding-top: 2rem;
        padding-bottom: 4rem;
      }
      .features-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 2rem;
      }
    }
    @media (max-width: 600px) {
      .features-grid {
        grid-template-columns: 1fr;
      }
      .nav-bar {
        padding-top: 1rem;
        padding-bottom: 1rem;
      }
      .hero-ctas {
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
      }
      .cmd-snippet {
        justify-content: space-between;
      }
    }
  </style>

  <script>
    const tabCodeMap = {
      opencode: `# 1. Run the automatic script installer
curl -fsSL https://ratel.dev/install-opencode.sh | bash

# 2. This script installs:
#    - @ratel/core (the background daemon)
#    - Configures @ratel/opencode plugin in your opencode.json
#    - Adds slash commands: /ratel, /ratel-mission`,

      pi: `# 1. Run the Pi SDK extension installer
curl -fsSL https://ratel.dev/install-pi.sh | bash

# 2. Activate the extension in your active session
pi install @ratel/pi-extension`,

      source: `# 1. Clone the codebase locally
git clone https://github.com/AryanBhargavprojects/Ratel-Factory.git
cd ratel-web

# 2. Install dependencies & build TS modules
npm install
npm run build

# 3. Start the factory in direct TUI mode
npm run dev`
    };

    let activeTab = 'opencode';

    const codeDisplay = document.getElementById("code-display");
    const btnCopyCode = document.getElementById("btn-copy-code");
    const btnCopyInstall = document.getElementById("btn-copy-install");

    // Initialize code box
    function updateCodeView() {
      if (codeDisplay) {
        codeDisplay.textContent = tabCodeMap[activeTab];
      }
    }
    updateCodeView();

    // Tab buttons event listeners
    const tabButtons = document.querySelectorAll(".tab-btn");
    tabButtons.forEach(btn => {
      btn.addEventListener("click", (e) => {
        const target = e.currentTarget;
        if (!target) return;
        
        // Remove active class from all buttons
        tabButtons.forEach(b => b.classList.remove("active"));
        
        // Add active class to clicked button
        target.classList.add("active");
        
        // Swap content
        const tab = target.getAttribute("data-tab");
        if (tab && tab in tabCodeMap) {
          activeTab = tab;
          updateCodeView();
        }
      });
    });

    // Copy to clipboard helper
    async function copyToClipboard(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        const originalText = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = originalText;
        }, 1500);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    }

    if (btnCopyCode) {
      btnCopyCode.addEventListener("click", () => {
        copyToClipboard(tabCodeMap[activeTab], btnCopyCode);
      });
    }

    if (btnCopyInstall) {
      btnCopyInstall.addEventListener("click", () => {
        const cmdText = document.getElementById("cmd-text");
        if (cmdText) {
          copyToClipboard(cmdText.textContent || "", btnCopyInstall);
        }
      });
    }
  </script>
  ```

- [ ] **Step 2: Run verification test**
  Run: `npx tsx test/marketing-build.test.ts`
  Expected: PASS. All elements, custom styles, titles, and footers successfully asserted.

- [ ] **Step 3: Commit**
  Run:
  ```bash
  git add marketing/src/pages/index.astro
  git commit -m "feat: assemble index.astro with layout, emulator, and specs"
  ```
