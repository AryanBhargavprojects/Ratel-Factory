# Pull Requests Status Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a modern, responsive, and glassmorphic "Pull Requests" panel to the left sidebar of the Ratel Factory landing page to balance the dashboard layout.

**Architecture:** The layout will integrate a client-side component in the dashboard system. We will create a `PullRequests` component in `Dashboard.tsx` that exposes mock PR list metrics, add styles to `globals.css`, and import/mount the component in the main `page.tsx` grid under `MissionProgress`.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS v4 / Custom CSS.

---

### Task 1: Add Styling to `globals.css`

**Files:**
* Modify: `app/globals.css`

- [ ] **Step 1: Add styles to globals.css**

Append the following styles to the bottom of the file (or under sidebar panel styles):

```css
/* --- Pull Requests panel --- */

.pr-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

.pr-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-size: 0.76rem;
}

.pr-row:last-child {
  border-bottom: none;
}

.pr-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 4.8rem;
}

.pr-id {
  font-family: var(--font-geist-mono, ui-monospace, monospace);
  color: #8a8a8a;
  font-size: 0.68rem;
  letter-spacing: 0.02em;
}

.pr-agent {
  font-family: var(--font-geist-mono, ui-monospace, monospace);
  color: #b0b0b0;
  font-weight: 500;
  font-size: 0.72rem;
}

.pr-title {
  color: #e0e0e0;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pr-badge {
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  font-size: 0.64rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-family: var(--font-geist-mono, ui-monospace, monospace);
  text-align: center;
  min-width: 4.6rem;
}

.pr-badge.merged {
  background: rgba(34, 197, 94, 0.08);
  border: 1px solid rgba(34, 197, 94, 0.2);
  color: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.15);
}

.pr-badge.reviewing {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  box-shadow: 0 0 6px rgba(251, 191, 36, 0.15);
}

.pr-badge.failed {
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #f87171;
  box-shadow: 0 0 6px rgba(248, 113, 113, 0.15);
}
```

---

### Task 2: Implement Component in `Dashboard.tsx`

**Files:**
* Modify: `app/Dashboard.tsx`

- [ ] **Step 1: Export the `PullRequests` component**

Add the mock data and component code to the bottom of the file:

```typescript
const MOCK_PRS = [
  { id: "#142", agent: "orchestrator", title: "feat: integrate next-auth providers", status: "merged" },
  { id: "#141", agent: "scrutiny_validator", title: "test: verify state verifyToken", status: "reviewing" },
  { id: "#140", agent: "worker", title: "fix: database postgres connection pool", status: "failed" },
  { id: "#139", agent: "research", title: "docs: oauth callback flow architecture", status: "merged" }
];

export function PullRequests() {
  return (
    <div className="panel" style={{ animationDelay: "0.22s" }}>
      <h2 className="panel-title">Pull Requests</h2>
      <ul className="pr-list">
        {MOCK_PRS.map((pr) => (
          <li key={pr.id} className="pr-row">
            <div className="pr-meta">
              <span className="pr-id">{pr.id}</span>
              <span className="pr-agent">{pr.agent}</span>
            </div>
            <span className="pr-title" title={pr.title}>
              {pr.title}
            </span>
            <span className={`pr-badge ${pr.status}`}>{pr.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

### Task 3: Mount Component in `page.tsx`

**Files:**
* Modify: `app/page.tsx`

- [ ] **Step 1: Import the new component**

Modify the import block at lines 1-8 to include `PullRequests`:

```typescript
import {
  AgentGrid,
  MissionProgress,
  PullRequests,
  ValidationGates,
  BudgetUsage,
  ActivityFeed,
} from "./Dashboard";
```

- [ ] **Step 2: Add `<PullRequests />` to the left sidebar**

Mount the component in page.tsx under `<MissionProgress />` inside `sidebar-left`:

```typescript
      <aside className="sidebar sidebar-left">
        <AgentGrid />
        <MissionProgress />
        <PullRequests />
      </aside>
```

---

### Task 4: Run Verification and Checks

**Files:**
* None

- [ ] **Step 1: Run linter**

Run: `npm run lint`
Expected: Passes with 0 errors/problems.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Prerenders `/` successfully with zero static generation errors.
