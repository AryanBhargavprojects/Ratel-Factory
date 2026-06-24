"use client";

import { useEffect, useState } from "react";

function useCountUp(target: number, duration = 1400) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const startTime = performance.now();
    const tick = (now: number) => {
      if (reduceMotion) {
        setValue(target);
        return;
      }
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setValue(target * eased);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

const AGENTS: { name: string; status: "active" | "idle" }[] = [
  { name: "orchestrator", status: "active" },
  { name: "research", status: "active" },
  { name: "smart_friend", status: "idle" },
  { name: "contract_writer", status: "active" },
  { name: "worker", status: "active" },
  { name: "scrutiny_validator", status: "idle" },
  { name: "user_testing", status: "active" },
];

export function AgentGrid() {
  return (
    <div className="panel" style={{ animationDelay: "0.04s" }}>
      <h2 className="panel-title">Agents</h2>
      <ul className="agent-list">
        {AGENTS.map((a) => (
          <li key={a.name} className="agent-row">
            <span>{a.name}</span>
            <span
              className={`agent-dot ${a.status}`}
              aria-label={a.status}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MissionProgress() {
  const integrated = useCountUp(4);
  const validated = useCountUp(3);
  const inProgress = useCountUp(1);
  const phasePct = useCountUp(87.5, 1600);
  return (
    <div className="panel" style={{ animationDelay: "0.1s" }}>
      <h2 className="panel-title">Mission</h2>
      <p className="mission-name">Add OAuth authentication</p>
      <div className="mission-phase">
        <span className="phase-label">Phase</span>
        <span className="phase-value">Execution</span>
      </div>
      <div className="mission-stats">
        <div className="stat">
          <span className="stat-num">{Math.round(integrated)}</span>
          <span className="stat-label">integrated</span>
        </div>
        <div className="stat">
          <span className="stat-num">{Math.round(validated)}</span>
          <span className="stat-label">validated</span>
        </div>
        <div className="stat">
          <span className="stat-num">{Math.round(inProgress)}</span>
          <span className="stat-label">active</span>
        </div>
      </div>
      <div className="phase-track">
        <div className="phase-fill" style={{ width: `${phasePct}%` }} />
      </div>
      <p className="phase-hint">step 7 / 8</p>
    </div>
  );
}

export function ValidationGates() {
  const passed = useCountUp(12);
  const failed = useCountUp(0);
  const critical = useCountUp(0);
  const shards = useCountUp(8);
  return (
    <div className="panel" style={{ animationDelay: "0.04s" }}>
      <h2 className="panel-title">Validation</h2>
      <div className="validation-grid">
        <div className="val-stat">
          <span className="val-num pass">{Math.round(passed)}</span>
          <span className="val-label">passed</span>
        </div>
        <div className="val-stat">
          <span className="val-num">{Math.round(failed)}</span>
          <span className="val-label">failed</span>
        </div>
        <div className="val-stat">
          <span className="val-num">{Math.round(critical)}</span>
          <span className="val-label">critical</span>
        </div>
        <div className="val-stat">
          <span className="val-num">{Math.round(shards)}</span>
          <span className="val-label">shards</span>
        </div>
      </div>
    </div>
  );
}

function BudgetBar({
  label,
  value,
  limit,
  pct,
}: {
  label: string;
  value: string;
  limit: string;
  pct: number;
}) {
  return (
    <div className="budget-row">
      <div className="budget-label">
        <span>{label}</span>
        <span className="budget-value">
          {value} <span className="budget-limit">/ {limit}</span>
        </span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BudgetUsage() {
  const costPct = useCountUp(24.7);
  const tokenPct = useCountUp(24.8);
  const clockPct = useCountUp(17.1);
  const runPct = useCountUp(23.5);
  const cost = useCountUp(12.34);
  const tokens = useCountUp(1_240_000);
  const clock = useCountUp(82);
  const runs = useCountUp(47);
  return (
    <div className="panel" style={{ animationDelay: "0.1s" }}>
      <h2 className="panel-title">Budget</h2>
      <BudgetBar
        label="Cost"
        value={`$${cost.toFixed(2)}`}
        limit="$50.00"
        pct={costPct}
      />
      <BudgetBar
        label="Tokens"
        value={Math.round(tokens).toLocaleString()}
        limit="5,000,000"
        pct={tokenPct}
      />
      <BudgetBar
        label="Wall-clock"
        value={`${Math.round(clock)}m`}
        limit="480m"
        pct={clockPct}
      />
      <BudgetBar
        label="Agent runs"
        value={`${Math.round(runs)}`}
        limit="200"
        pct={runPct}
      />
    </div>
  );
}

const FEED_ITEMS = [
  "Worker F1 \u2192 feature branch created",
  "Validation F2 \u2192 scrutiny passed",
  "Feature F3 \u2192 merged to integration",
  "Budget check \u2192 within limits",
  "Contract writer \u2192 Gherkin generated",
  "User testing F4 \u2192 3 shards completed",
  "Orchestrator \u2192 phase advanced",
  "Research agent \u2192 codebase scan done",
  "Worker F5 \u2192 TDD cycle started",
  "Validation F1 \u2192 zero critical issues",
  "Orchestrator \u2192 task planning finalized",
  "Smart friend \u2192 code review approved",
  "User testing F2 \u2192 sandbox environments ready",
  "Scrutiny validator \u2192 security audits passing",
  "Worker F2 \u2192 conflict resolution applied",
  "Validation F3 \u2192 performance bench passed",
  "Worker F3 \u2192 test coverage requirements met",
  "Smart friend \u2192 code complexity budget verified",
  "Research agent \u2192 documentation index built",
  "Orchestrator \u2192 mission integration checklist verified"
];


export function ActivityFeed() {
  return (
    <div className="panel feed-panel" style={{ animationDelay: "0.16s" }}>
      <h2 className="panel-title">Activity</h2>
      <div className="feed">
        <ul className="feed-list">
          {[...FEED_ITEMS, ...FEED_ITEMS].map((item, i) => (
            <li key={i} className="feed-item">
              <span className="feed-dot" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const MOCK_PRS = [
  { id: "#142", agent: "orchestrator", title: "feat: integrate next-auth providers", status: "merged" },
  { id: "#141", agent: "scrutiny_validator", title: "test: verify state verifyToken", status: "reviewing" },
  { id: "#140", agent: "worker", title: "fix: database postgres connection pool", status: "failed" },
  { id: "#139", agent: "research", title: "docs: oauth callback flow architecture", status: "merged" },
  { id: "#138", agent: "user_testing", title: "test: end-to-end authentication flow", status: "merged" },
  { id: "#137", agent: "contract_writer", title: "feat: generate oauth login contract", status: "merged" },
  { id: "#136", agent: "worker", title: "fix: token refresh memory leak", status: "failed" },
  { id: "#135", agent: "smart_friend", title: "refactor: simplify token expiration check", status: "merged" }
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

