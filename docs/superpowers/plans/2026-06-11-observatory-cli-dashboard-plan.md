# Ratel Mission Control CLI-Style Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully rewrite the observatory dashboard into a monochrome 3-column terminal panel displaying Orchestration, Worker (with live hunk diffs), and Validator consoles, and update the server unit tests to match.

**Architecture:** We will replace the main `dashboard.html` with our prototype code, adjust styling class overrides, update test assertions in `observatory-server.test.ts` to assert the new 3-pane DOM structure instead of the old 38/62 split, and execute the test runner to ensure compatibility.

**Tech Stack:** Node.js, HTML, CSS, client-side JS.

---

### Task 1: Replace `dashboard.html` with Prototype Code

**Files:**
- Modify: `src/observatory/dashboard.html`

- [ ] **Step 1: Replace the entire contents of `src/observatory/dashboard.html`**
  Overwrite `src/observatory/dashboard.html` with the verified prototype HTML structure:
  ```html
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ratel Observatory</title>
    <style>
      /* ── Typography & Base Styles ── */
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@300;400;600&display=swap');

      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #060608;
        color: #e1e1e6;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      /* ── Top Status Bar ── */
      #top-bar {
        background: rgba(18, 18, 22, 0.7);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-bottom: 1px solid #1a1a20;
        padding: 12px 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
        z-index: 100;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .brand-logo {
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.5px;
        color: #ffffff;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .brand-logo span {
        background: #ffffff;
        color: #060608;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .mission-status {
        display: flex;
        align-items: center;
        gap: 20px;
        font-size: 13px;
      }
      .status-item {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #121216;
        border: 1px solid #222228;
        padding: 6px 12px;
        border-radius: 6px;
      }
      .status-label {
        color: #8e8e93;
        text-transform: uppercase;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      .status-value {
        color: #ffffff;
        font-weight: 600;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #8e8e93;
        display: inline-block;
      }
      .status-dot.active {
        background: #ffffff;
        box-shadow: 0 0 8px #ffffff;
        animation: pulse 2s infinite;
      }
      #btn-plan {
        background: transparent;
        border: 1px solid #3a3a44;
        color: #e1e1e6;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s;
      }
      #btn-plan:hover {
        background: #ffffff;
        color: #060608;
        border-color: #ffffff;
      }

      /* ── Collapsible Plan Checklist Panel ── */
      #plan-panel {
        max-height: 0;
        overflow: hidden;
        background: #0b0b0d;
        border-bottom: 0 solid #1a1a20;
        transition: max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1), padding 0.35s ease, border-width 0.1s;
        flex-shrink: 0;
        box-sizing: border-box;
      }
      #plan-panel.expanded {
        max-height: 250px;
        border-bottom-width: 1px;
        padding: 16px 24px;
        overflow-y: auto;
      }
      .plan-title {
        font-size: 11px;
        text-transform: uppercase;
        color: #8e8e93;
        letter-spacing: 1px;
        font-weight: 700;
        margin-bottom: 12px;
      }
      #plan-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 10px;
      }
      .plan-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        background: #121216;
        border: 1px solid #1c1c22;
        padding: 10px 14px;
        border-radius: 6px;
        font-size: 12px;
      }
      .plan-item.completed {
        opacity: 0.6;
        border-color: #121216;
      }
      .plan-item-checkbox {
        font-family: monospace;
        font-size: 13px;
        color: #8e8e93;
        user-select: none;
      }
      .plan-item.completed .plan-item-checkbox {
        color: #ffffff;
      }
      .plan-item-text {
        color: #ffffff;
        line-height: 1.4;
      }
      .plan-item.completed .plan-item-text {
        text-decoration: line-through;
        color: #8e8e93;
      }

      /* ── Main View Grid ── */
      #observatory-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
        flex: 1;
        padding: 16px;
        overflow: hidden;
        box-sizing: border-box;
      }

      /* ── Console / Pane Container ── */
      .console-pane {
        display: flex;
        flex-direction: column;
        background: #09090b;
        border: 1px solid #1a1a20;
        border-radius: 10px;
        overflow: hidden;
        position: relative;
      }
      .console-pane.active-running {
        border-color: #3a3a44;
        box-shadow: 0 4px 30px rgba(0,0,0,0.6);
      }
      .console-header {
        background: #111114;
        border-bottom: 1px solid #1a1a20;
        padding: 10px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      .console-title {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.5px;
        color: #8e8e93;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .console-pane.active-running .console-title {
        color: #ffffff;
      }
      .console-status-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 9px;
        text-transform: uppercase;
        font-family: 'JetBrains Mono', monospace;
        padding: 2px 8px;
        border-radius: 4px;
        background: #18181c;
        color: #8e8e93;
        border: 1px solid #222228;
      }
      .console-pane.active-running .console-status-badge {
        background: #ffffff;
        color: #060608;
        border-color: #ffffff;
      }

      /* ── Console Content & Logs ── */
      .console-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        line-height: 1.6;
        color: #d1d1d6;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scroll-behavior: smooth;
      }

      /* ── CLI Elements ── */
      .cli-line {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .cli-prompt {
        color: #8e8e93;
        font-weight: bold;
        user-select: none;
      }
      .cli-content {
        flex: 1;
        word-break: break-all;
        white-space: pre-wrap;
      }
      
      /* System & Thoughts */
      .system-log {
        color: #8e8e93;
        font-size: 11px;
        border-left: 2px solid #3a3a44;
        padding-left: 8px;
        margin: 4px 0;
      }
      .thought-card {
        background: #0f0f13;
        border: 1px solid #1e1e24;
        border-radius: 6px;
        padding: 10px 14px;
        color: #a1a1a8;
        font-size: 11px;
      }
      .thought-header {
        font-size: 9px;
        text-transform: uppercase;
        color: #8e8e93;
        font-weight: bold;
        margin-bottom: 4px;
        letter-spacing: 0.5px;
      }

      /* Active Tool Executions */
      .tool-execution-card {
        background: #121216;
        border: 1px solid #22222a;
        border-radius: 6px;
        overflow: hidden;
        margin: 4px 0;
      }
      .tool-exec-header {
        background: #181820;
        padding: 6px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #22222a;
        font-size: 11px;
      }
      .tool-exec-name {
        font-weight: bold;
        color: #ffffff;
      }
      .tool-exec-status {
        font-size: 9px;
        text-transform: uppercase;
        color: #8e8e93;
      }
      .tool-exec-status.running {
        color: #ffffff;
        animation: flash 1.5s infinite;
      }
      .tool-exec-cmd {
        padding: 10px 12px;
        background: #08080a;
        overflow-x: auto;
        font-size: 11px;
        white-space: pre;
        color: #a1a1a8;
      }

      /* ── Split Screen Diff inside Worker column ── */
      .worker-split-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .worker-log-pane {
        flex: 1;
        overflow-y: auto;
        min-height: 150px;
      }
      .worker-diff-pane {
        height: 45%;
        border-top: 1px solid #1a1a20;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: #08080a;
      }
      .diff-header {
        background: #111114;
        border-bottom: 1px solid #1a1a20;
        padding: 6px 16px;
        font-size: 10px;
        font-weight: bold;
        color: #8e8e93;
        text-transform: uppercase;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .diff-content-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
        font-size: 11px;
      }
      
      /* Diff hunks */
      .diff-container { display: flex; flex-direction: column; gap: 8px; }
      .diff-hunk { border: 1px solid #222228; border-radius: 4px; overflow: hidden; background: #0c0c0e; }
      .diff-hunk-header { background: #121216; padding: 4px 10px; border-bottom: 1px solid #222228; color: #8e8e93; font-size: 10px; }
      .diff-line { display: flex; line-height: 1.5; font-family: monospace; }
      .diff-line-num { width: 32px; text-align: right; padding-right: 6px; color: #5c5c64; user-select: none; }
      .diff-line-ind { width: 12px; text-align: center; color: #5c5c64; user-select: none; }
      .diff-line-text { flex: 1; white-space: pre; overflow-x: auto; }
      .diff-line-ctx { color: #8e8e93; }
      .diff-line-add { background: rgba(63, 185, 80, 0.12); color: #7ee787; }
      .diff-line-add .diff-line-ind { color: #3fb950; }
      .diff-line-del { background: rgba(248, 81, 73, 0.12); color: #ff7b72; }
      .diff-line-del .diff-line-ind { color: #f85149; }

      /* ── Idle / Sleeping State Screensavers ── */
      .screensaver-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: #3e3e44;
        text-align: center;
        padding: 24px;
        user-select: none;
      }
      .screensaver-ascii {
        font-family: monospace;
        white-space: pre;
        line-height: 1.2;
        font-size: 10px;
        margin-bottom: 20px;
        color: #222228;
      }
      .screensaver-text {
        font-size: 11px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        font-weight: 600;
        color: #3e3e44;
      }
      .screensaver-sub {
        font-size: 10px;
        color: #2a2a30;
        margin-top: 4px;
      }
      .screensaver-cursor {
        display: inline-block;
        width: 6px;
        height: 12px;
        background: #3e3e44;
        margin-left: 4px;
        animation: blink 1s step-end infinite;
        vertical-align: middle;
      }

      /* ── Animations ── */
      @keyframes pulse {
        0% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.4); }
        70% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 8px rgba(255, 255, 255, 0); }
        100% { transform: scale(1); opacity: 0; box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); }
      }
      @keyframes flash {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 1; }
      }
      @keyframes blink {
        0%, 100% { opacity: 0; }
        50% { opacity: 1; }
      }

      /* Scrollbars */
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: #09090b; }
      ::-webkit-scrollbar-thumb { background: #222228; border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: #33333d; }
    </style>
  </head>
  <body>

    <!-- ── Top Bar ── -->
    <div id="top-bar">
      <div class="brand">
        <div class="brand-logo">RATEL <span>Observatory</span></div>
      </div>
      <div id="goal-banner" style="font-size: 13px; color: #a1a1a8; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        Goal: <span id="goal-text" style="color: #ffffff; font-weight: 600;">—</span>
      </div>
      <div class="mission-status">
        <div class="status-item">
          <span class="status-label">Phase</span>
          <span id="stat-phase" class="status-value">—</span>
        </div>
        <div class="status-item">
          <span class="status-label">Engine</span>
          <span class="status-value" style="display: flex; align-items: center; gap: 6px;">
            <span class="status-dot active"></span>
            Running
          </span>
        </div>
        <button id="btn-plan">
          [+] Plan Checklist
        </button>
      </div>
    </div>

    <!-- ── Collapsible Plan Checklist ── -->
    <div id="plan-panel">
      <div class="plan-title">Original Feature Plan Checklist</div>
      <div id="plan-list">
        <div class="empty" style="color: #8e8e93; font-style: italic;">No features defined yet.</div>
      </div>
    </div>

    <!-- ── Side-by-Side 3 Column Grid ── -->
    <div id="observatory-grid">

      <!-- 1. ORCHESTRATION COLUMN -->
      <div class="console-pane" id="pane-orchestration">
        <div class="console-header">
          <div class="console-title">◈ ORCHESTRATION</div>
          <div class="console-status-badge">Root Agent</div>
        </div>
        <div class="console-body" id="body-orchestration">
          <!-- Live stream content populated here -->
        </div>
      </div>

      <!-- 2. WORKER COLUMN -->
      <div class="console-pane" id="pane-worker">
        <div class="console-header">
          <div class="console-title">◇ WORKER PANEL</div>
          <div class="console-status-badge" id="badge-worker">Sleeping</div>
        </div>
        <!-- Split Container inside worker for Diff viewer -->
        <div class="worker-split-container">
          <!-- Top Half: Terminal Logs -->
          <div class="worker-log-pane">
            <div class="console-body" id="body-worker">
              <!-- Sleep screensaver or CLI logs -->
            </div>
          </div>
          <!-- Bottom Half: Code Diff -->
          <div class="worker-diff-pane" id="container-worker-diff" style="display: none;">
            <div class="diff-header">
              <span>Live Hunk Diff View</span>
              <span style="font-family: monospace; font-size: 9px; color: #5c5c64;">$ git diff</span>
            </div>
            <div class="diff-content-scroll" id="body-worker-diff">
              <!-- Hunk diffs loaded here -->
            </div>
          </div>
        </div>
      </div>

      <!-- 3. VALIDATOR COLUMN -->
      <div class="console-pane" id="pane-validator">
        <div class="console-header">
          <div class="console-title">⬪ VALIDATION CONTROL</div>
          <div class="console-status-badge" id="badge-validator">Sleeping</div>
        </div>
        <div class="console-body" id="body-validator">
          <!-- Sleep screensaver or validator test logs -->
        </div>
      </div>

    </div>

    <!-- ── Client Logic ── -->
    <script>
      'use strict';

      // State representation
      const state = {
        events: [],
        lastEventCount: 0,
        activeWorkerSpan: null,
        activeValidatorSpan: null,
        planExpanded: false
      };

      // DOM references
      const $planPanel = document.getElementById('plan-panel');
      const $btnPlan = document.getElementById('btn-plan');
      const $goalText = document.getElementById('goal-text');
      const $statPhase = document.getElementById('stat-phase');
      const $planList = document.getElementById('plan-list');

      const $paneOrchestration = document.getElementById('pane-orchestration');
      const $bodyOrchestration = document.getElementById('body-orchestration');

      const $paneWorker = document.getElementById('pane-worker');
      const $badgeWorker = document.getElementById('badge-worker');
      const $bodyWorker = document.getElementById('body-worker');
      const $containerWorkerDiff = document.getElementById('container-worker-diff');
      const $bodyWorkerDiff = document.getElementById('body-worker-diff');

      const $paneValidator = document.getElementById('pane-validator');
      const $badgeValidator = document.getElementById('badge-validator');
      const $bodyValidator = document.getElementById('body-validator');

      // Toggle Checklist Expand
      $btnPlan.addEventListener('click', () => {
        state.planExpanded = !state.planExpanded;
        if (state.planExpanded) {
          $planPanel.classList.add('expanded');
          $btnPlan.textContent = '[-] Close Plan';
        } else {
          $planPanel.classList.remove('expanded');
          $btnPlan.textContent = '[+] Plan Checklist';
        }
      });

      // ASCII Screensavers
      const SLEEP_ASCII_WORKER = `
   _ _ _  _ _ _  _ _ _  _ _ _ 
  | | | || | | ||  _  ||  _  |
  | | | || | | || | | || |_| |
  |  _  ||  _  || |_| ||  _  |
  |_| |_||_| |_||_ _ _||_| |_|
      `;
      const SLEEP_ASCII_VALIDATOR = `
   _ _ _  _ _ _  _ _ _  _ _ _ 
  |  _  ||  _  ||_ _ _||  _  |
  | | | || |_| |  | |  | | | |
  | |_| ||  _  |  | |  | |_| |
  |_ _ _||_| |_|  |_|  |_ _ _|
      `;

      function getSleepHtml(type, asciiText, subtitle) {
        return `
          <div class="screensaver-container">
            <div class="screensaver-ascii">${asciiText}</div>
            <div class="screensaver-text">${type} SLEEPING<span class="screensaver-cursor"></span></div>
            <div class="screensaver-sub">${subtitle}</div>
          </div>
        `;
      }

      // Helper functions
      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      }

      function fmtTime(iso) {
        try {
          const d = new Date(iso);
          return d.toTimeString().slice(0, 8);
        } catch { return '--:--:--'; }
      }

      function summarizeEvent(e) {
        const d = e.data || {};
        if (e.event_type === 'agent_start') return `Starting subagent: ${d.agentType || ''} ${d.featureId ? '['+d.featureId+']' : ''}`;
        if (e.event_type === 'agent_end') return `Subagent finished. Status: ${d.parseStatus || 'unknown'} (${d.durationMs || 0}ms)`;
        if (e.event_type === 'tool_call') return `${d.toolName || ''}(${JSON.stringify(d.params || {})})`;
        if (e.event_type === 'tool_result') return `result: ${d.parseStatus || ''} ${d.durationMs ? '('+d.durationMs+'ms)' : ''}`;
        if (e.event_type === 'session_tool_start') return `Invoked tool: ${d.toolName || ''}`;
        if (e.event_type === 'session_tool_end') return `Tool returned: ${d.isError ? 'ERROR' : 'SUCCESS'}`;
        if (e.event_type === 'validation_recovery') return `Validation Recovery triggered for ${d.milestoneId || ''}`;
        if (e.event_type === 'integration_preflight') return `Preflight check: ${d.status || ''}`;
        if (e.event_type === 'phase_transition') return `Phase transition: ${d.from} → ${d.to}`;
        if (e.event_type === 'artifact_write') return `Wrote file: ${d.artifactName}`;
        if (e.event_type === 'halt') return `HALT: ${d.reason || ''}`;
        return d.message || JSON.stringify(d);
      }

      // Diff rendering logic (hunks)
      function parseUnifiedDiff(diffText) {
        const lines = diffText.split('\n');
        const files = [];
        let currentFile = null;
        let currentHunk = null;

        for (const line of lines) {
          if (line.startsWith('diff --git')) {
            currentFile = { hunks: [] };
            files.push(currentFile);
            currentHunk = null;
          } else if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
              currentHunk = {
                oldStart: parseInt(match[1], 10),
                oldCount: parseInt(match[2] || '1', 10),
                newStart: parseInt(match[3], 10),
                newCount: parseInt(match[4] || '1', 10),
                lines: []
              };
              if (currentFile) currentFile.hunks.push(currentHunk);
            }
          } else if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
            const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
            currentHunk.lines.push({ type, text: line.slice(1) });
          }
        }
        return files;
      }

      function renderDiff(diffText) {
        if (!diffText || !diffText.trim()) {
          return '<div style="color: #5c5c64; font-style: italic; text-align: center; margin-top: 15px;">No file modifications.</div>';
        }
        const files = parseUnifiedDiff(diffText);
        if (files.length === 0 || files.every(f => f.hunks.length === 0)) {
          return '<div style="color: #5c5c64; font-style: italic; text-align: center; margin-top: 15px;">No file modifications.</div>';
        }
        let html = '<div class="diff-container">';
        for (const file of files) {
          for (const hunk of file.hunks) {
            html += '<div class="diff-hunk">';
            html += `<div class="diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@</div>`;
            let oldNum = hunk.oldStart;
            let newNum = hunk.newStart;
            for (const line of hunk.lines) {
              let oldNumStr = '';
              let newNumStr = '';
              let typeClass = '';
              let indicator = '';
              if (line.type === 'ctx') {
                oldNumStr = oldNum;
                newNumStr = newNum;
                oldNum++;
                newNum++;
                typeClass = 'diff-line-ctx';
                indicator = ' ';
              } else if (line.type === 'del') {
                oldNumStr = oldNum;
                oldNum++;
                typeClass = 'diff-line-del';
                indicator = '-';
              } else if (line.type === 'add') {
                newNumStr = newNum;
                newNum++;
                typeClass = 'diff-line-add';
                indicator = '+';
              }
              html += `<div class="diff-line ${typeClass}">
                <span class="diff-line-num">${oldNumStr}</span>
                <span class="diff-line-ind">${indicator}</span>
                <span class="diff-line-text">${escapeHtml(line.text)}</span>
              </div>`;
            }
            html += '</div>';
          }
        }
        html += '</div>';
        return html;
      }

      // Rendering event rows inside terminal feeds
      function getEventRowHtml(e) {
        const timeStr = `[${fmtTime(e.timestamp)}]`;
        
        if (e.event_type === 'decision_logged' && e.data && e.data.decision) {
          return `
            <div class="thought-card">
              <div class="thought-header">Thought Process</div>
              <div>${escapeHtml(e.data.decision)}</div>
            </div>
          `;
        }

        if (e.event_type === 'tool_call' || e.event_type === 'session_tool_start') {
          const toolName = e.data.toolName;
          const params = e.data.params || {};
          const cmd = params.CommandLine || JSON.stringify(params, null, 2);
          return `
            <div class="tool-execution-card">
              <div class="tool-exec-header">
                <span class="tool-exec-name">${escapeHtml(toolName)}</span>
                <span class="tool-exec-status running">Executing</span>
              </div>
              <div class="tool-exec-cmd">$ ${escapeHtml(cmd)}</div>
            </div>
          `;
        }

        if (e.event_type === 'tool_result' || e.event_type === 'session_tool_end') {
          const isError = e.data.isError || e.data.parseStatus === 'failed';
          const statusLabel = isError ? 'FAILED' : 'COMPLETED';
          return `
            <div class="system-log">
              <b>${statusLabel}</b> — ${escapeHtml(summarizeEvent(e))}
            </div>
          `;
        }

        const summary = summarizeEvent(e);
        return `
          <div class="cli-line">
            <span class="cli-prompt">$</span>
            <span class="cli-content">${escapeHtml(summary)}</span>
          </div>
        `;
      }

      // Core Processing & Rendering
      function processEvents(events) {
        // Find active worker/validator spans
        let activeWorker = null;
        let activeValidator = null;

        for (const e of events) {
          if (e.event_type === 'agent_start') {
            if (e.agent_level === 'worker') {
              activeWorker = e.span_id;
            } else if (e.agent_level && e.agent_level.includes('validator')) {
              activeValidator = e.span_id;
            }
          } else if (e.event_type === 'agent_end') {
            if (e.agent_level === 'worker' && activeWorker === e.span_id) {
              activeWorker = null;
            } else if (e.agent_level && e.agent_level.includes('validator') && activeValidator === e.span_id) {
              activeValidator = null;
            }
          }
        }

        state.activeWorkerSpan = activeWorker;
        state.activeValidatorSpan = activeValidator;

        // Filter events per column
        const orchEvents = [];
        const workerEvents = [];
        const validatorEvents = [];

        for (const e of events) {
          // Orchestrator
          if (e.agent_level === 'orchestrator' || !e.agent_level || e.event_type === 'phase_transition' || e.event_type === 'halt') {
            orchEvents.push(e);
          }
          
          // Worker
          if (e.agent_level === 'worker' || e.parent_span_id === activeWorker || e.span_id === activeWorker) {
            workerEvents.push(e);
          }
          
          // Validator
          if ((e.agent_level && e.agent_level.includes('validator')) || e.parent_span_id === activeValidator || e.span_id === activeValidator) {
            validatorEvents.push(e);
          }
        }

        // Render Orchestration
        $paneOrchestration.classList.add('active-running');
        $bodyOrchestration.innerHTML = orchEvents.map(getEventRowHtml).join('');
        $bodyOrchestration.scrollTop = $bodyOrchestration.scrollHeight;

        // Render Worker
        if (state.activeWorkerSpan) {
          $paneWorker.classList.add('active-running');
          $badgeWorker.textContent = 'Running';
          $bodyWorker.innerHTML = workerEvents.map(getEventRowHtml).join('');
          $bodyWorker.scrollTop = $bodyWorker.scrollHeight;
          $containerWorkerDiff.style.display = 'flex';
        } else {
          $paneWorker.classList.remove('active-running');
          $badgeWorker.textContent = 'Sleeping';
          $bodyWorker.innerHTML = getSleepHtml('Worker', SLEEP_ASCII_WORKER, 'Waiting for Orchestrator to compile features.');
          $containerWorkerDiff.style.display = 'none';
        }

        // Render Validator
        if (state.activeValidatorSpan) {
          $paneValidator.classList.add('active-running');
          $badgeValidator.textContent = 'Running';
          $bodyValidator.innerHTML = validatorEvents.map(getEventRowHtml).join('');
          $bodyValidator.scrollTop = $bodyValidator.scrollHeight;
        } else {
          $paneValidator.classList.remove('active-running');
          $badgeValidator.textContent = 'Sleeping';
          $bodyValidator.innerHTML = getSleepHtml('Validator', SLEEP_ASCII_VALIDATOR, 'Awaiting test verification from Worker output.');
        }
      }

      // API Polling Functions
      async function pollEvents() {
        try {
          const res = await fetch('/api/events');
          if (!res.ok) return;
          const events = await res.json();
          if (events.length === state.lastEventCount) return;
          state.events = events;
          state.lastEventCount = events.length;
          processEvents(events);
        } catch (err) {
          console.error('Failed to poll events:', err);
        }
      }

      async function pollDiff() {
        try {
          const res = await fetch('/api/diff');
          if (!res.ok) return;
          const data = await res.json();
          $bodyWorkerDiff.innerHTML = renderDiff(data.diff);
        } catch (err) {
          console.error('Failed to poll diffs:', err);
        }
      }

      async function pollMission() {
        try {
          const res = await fetch('/api/mission');
          if (!res.ok) return;
          const data = await res.json();

          // Update Goal
          $goalText.textContent = data.requirements?.goal || 'No goal specified';
          $statPhase.textContent = data.state?.phase || '—';

          // Plan features list
          const features = data.features?.features || [];
          if (features.length === 0) {
            $planList.innerHTML = '<div style="color: #8e8e93; font-style: italic;">No features defined yet.</div>';
          } else {
            $planList.innerHTML = features.map(f => {
              const isDone = f.status === 'completed';
              const checkbox = isDone ? '[✓]' : (f.status === 'active' || f.status === 'running' ? '[●]' : '[ ]');
              return `
                <div class="plan-item ${isDone ? 'completed' : ''}">
                  <div class="plan-item-checkbox">${checkbox}</div>
                  <div class="plan-item-text"><b>${escapeHtml(f.id)}</b>: ${escapeHtml(f.title || '')}</div>
                </div>
              `;
            }).join('');
          }
        } catch (err) {
          console.error('Failed to poll mission state:', err);
        }
      }

      // Initialize Polling loops
      pollEvents();
      setInterval(pollEvents, 500);

      pollDiff();
      setInterval(pollDiff, 1000);

      pollMission();
      setInterval(pollMission, 1000);

    </script>
  </body>
  </html>
  ```

- [ ] **Step 2: Commit file replacement**
  ```bash
  git add src/observatory/dashboard.html
  git commit -m "feat(observatory): replace dashboard.html with 3-section CLI layout"
  ```

---

### Task 2: Update Unit Test Layout Assertions

**Files:**
- Modify: `test/observatory-server.test.ts`

- [ ] **Step 1: Update test/observatory-server.test.ts**
  Since the layout is now a three-column grid, we will modify the tests that assert the 38% / 62% splits to instead check for the existence of `#observatory-grid` and the three pane IDs (`#pane-orchestration`, `#pane-worker`, `#pane-validator`).
  ```typescript
  // Replace the "timeline pane occupies 38% width" test:
  test("dashboard has three vertical columns", () => {
    const html = getDashboardHtml();
    assert.ok(html.includes('id="observatory-grid"'), "should contain #observatory-grid");
    assert.ok(html.includes('id="pane-orchestration"'), "should contain #pane-orchestration");
    assert.ok(html.includes('id="pane-worker"'), "should contain #pane-worker");
    assert.ok(html.includes('id="pane-validator"'), "should contain #pane-validator");
  });
  ```

- [ ] **Step 2: Remove old layout check tests**
  Remove the outdated tests:
  - `test("timeline pane occupies 38% width", ...)`
  - `test("details pane occupies 62% width", ...)`
  - `test("tab elements exist for Live Workspace Diff and Event Raw JSON", ...)` (tabs are now columns)
  - `test("timeline container is present", ...)` (the timeline is integrated into orchestration column)
  - `test("details pane container is present", ...)`

- [ ] **Step 3: Run the test runner**
  Run: `npm run build && npx tsx test/observatory-server.test.ts`
  Expected: PASS

- [ ] **Step 4: Commit test updates**
  ```bash
  git add test/observatory-server.test.ts
  git commit -m "test(observatory): update server test suite to verify 3-column layout"
  ```
