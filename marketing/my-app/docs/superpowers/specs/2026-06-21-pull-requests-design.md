# Design Spec: Pull Requests Status Panel

* **Date:** 2026-06-21
* **Topic:** Add a "Pull Requests" (PR) panel to the bottom of the left sidebar to fill empty space and balance the dashboard layout.

---

## 1. Requirements

### Context & Goal
The left sidebar currently has a large empty space in the bottom half. To restore balance to the 3-column layout, we are adding a "Pull Requests" panel containing mock integration data that represents the outputs of the Ratel factory.

### Success Criteria
1. The left sidebar is fully populated, matching the height/weight of the right sidebar.
2. The UI matches the existing glassmorphic, sci-fi theme.
3. Typography is clean, responsive, and fits within the sidebar width.
4. Lints and compilation checks pass with zero errors.

---

## 2. Component Design

### Location
* File: `app/Dashboard.tsx`
* Component Name: `PullRequests`

### Layout & Elements
* Container: `<div className="panel" style={{ animationDelay: "0.22s" }}>`
* Title: "Pull Requests" (with dot-pulse indicator matching other panels).
* List: A list of 4 PR rows.
* Row structure:
  ```tsx
  <li className="pr-row">
    <div className="pr-meta">
      <span className="pr-id">#142</span>
      <span className="pr-agent">orchestrator</span>
    </div>
    <span className="pr-title">feat: integrate next-auth providers</span>
    <span className="pr-badge merged">merged</span>
  </li>
  ```

---

## 3. Styling Specifications (`app/globals.css`)

```css
.pr-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.pr-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-size: 0.76rem;
}

.pr-row:last-child {
  border-bottom: none;
}

.pr-meta {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.pr-id {
  font-family: var(--font-geist-mono, monospace);
  color: #8a8a8a;
  font-size: 0.68rem;
}

.pr-agent {
  font-family: var(--font-geist-mono, monospace);
  color: #b0b0b0;
  font-weight: 500;
  font-size: 0.72rem;
}

.pr-title {
  color: #e0e0e0;
  line-height: 1.3;
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
  font-family: var(--font-geist-mono, monospace);
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
