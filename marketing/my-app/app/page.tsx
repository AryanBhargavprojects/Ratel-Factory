import BackgroundVideo from "./BackgroundVideo";
import {
  AgentGrid,
  MissionProgress,
  ValidationGates,
  BudgetUsage,
  ActivityFeed,
  PullRequests,
} from "./Dashboard";

export default function Home() {
  return (
    <section className="dashboard">
      <aside className="sidebar sidebar-left">
        <AgentGrid />
        <MissionProgress />
        <PullRequests />
      </aside>
      <div className="factory-stage">
        <BackgroundVideo />
        <div className="factory-overlay" aria-hidden="true" />
        <div className="factory-content">
          <h1 className="factory-title">Ratel Factory</h1>
          <p className="factory-subtitle">
            Open-source software factory for your coding agent
          </p>
          <a className="factory-cta" href="#get-started">
            Get started
          </a>
        </div>
      </div>
      <aside className="sidebar sidebar-right">
        <ValidationGates />
        <BudgetUsage />
        <ActivityFeed />
      </aside>
    </section>
  );
}
