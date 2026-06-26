/**
 * Ratel Observatory — Dashboard Server
 *
 * THIN HTTP glue over DashboardData (read layer) and DashboardActions
 * (write/action layer). Every route parses params, calls a layer method,
 * and serializes JSON. No business logic lives here.
 *
 * Endpoints:
 *   GET  /api/status                         → mission snapshot (agents, budget, phase, actions)
 *   GET  /api/mission                        → legacy: state + requirements + features + contract
 *   GET  /api/artifacts                       → full artifact bundle (Plan tab)
 *   POST /api/artifact                        → write/overwrite a single mission artifact (#4: single write path)
 *   POST /api/decision                        → append-only decision entry (#3)
 *   POST /api/contract                        → save validation contract (#2: JSON+MD consistent)
 *   POST /api/features                        → save features.json (#6: gate blocks integrated/validated)
 *   POST /api/milestones                      → save milestones.json
 *   POST /api/message                         → free-form reply → orchestrator (#5: mode-aware)
 *   POST /api/approve                         → approve plan (+ optional files)
 *   POST /api/reject                          → reject plan (+ optional files)
 *   POST /api/fix-feature                     → create fix feature from validation recovery
 *   GET  /api/events?after&limit&types&levels&tool&q  → paginated, filtered events (#7)
 *   GET  /api/events/assistant                → assistant_message events (view-only)
 *   GET  /api/usage?groupBy                    → usage aggregate
 *   GET  /api/jobs                            → jobs list
 *   GET  /api/handoffs                        → worker handoff summaries
 *   GET  /api/handoffs/:featureId             → handoff detail
 *   GET  /api/handoffs/:featureId/raw         → worker raw output
 *   GET  /api/reports/validation              → scrutiny reports (optionally ?milestoneId)
 *   GET  /api/reports/user-testing            → user-testing reports
 *   GET  /api/workspace                       → mission file tree
 *   GET  /api/file?path                       → single file content
 *   POST /api/file                            → write a single file (delegates to same gate as /api/artifact)
 *   GET  /api/diff                            → git diff + status
 *   GET  /api/decisions                       → decision log (append-only)
 *   GET  /                                    → dashboard.html
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { DashboardData, parseEventsJsonl, type FileTreeNode } from "./dashboard-data.js";
import {
  DashboardActions,
  ControlPlaneActionBridge,
  NoActionBridge,
  type ActionBridge,
} from "./dashboard-actions.js";
import type { MissionControlPlane } from "../control-plane/mission-control-plane.js";
import { JobStore } from "../control-plane/job-store.js";
import { MissionStore } from "../control-plane/mission-store.js";
import type { EventType, AgentLevel } from "../core/observability/event-logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, "dashboard.html");

// Shared mutable state so the TUI footer and Pi commands can discover the
// actual URL even when the port falls back dynamically.
let currentDashboardUrl: string | undefined;

function getDashboardUrlFilePath(cwd: string): string {
  return join(cwd, ".ratel", "observatory-url.txt");
}

function persistDashboardUrl(cwd: string, url: string): void {
  try {
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(cwd, ".ratel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(getDashboardUrlFilePath(cwd), url, "utf-8");
  } catch {
    // Best-effort persistence; silently ignore write errors.
  }
}

function readDashboardUrlFile(cwd: string): string | undefined {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = readFileSync(getDashboardUrlFilePath(cwd), "utf-8");
    return raw.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function getCurrentDashboardUrl(cwd?: string): string | undefined {
  if (currentDashboardUrl) return currentDashboardUrl;
  if (cwd) return readDashboardUrlFile(cwd);
  return undefined;
}

/** Test-only helper to inject a URL so unit tests can assert link rendering. */
export function setCurrentDashboardUrl(url: string | undefined): void {
  currentDashboardUrl = url;
}

export interface DashboardServerOptions {
  cwd: string;
  port?: number;
  host?: string;
  controlPlane?: MissionControlPlane;
  /** Inject a custom action bridge (e.g. InProcessActionBridge). Defaults to ControlPlane/None. */
  actionBridge?: ActionBridge;
}

export interface DashboardServerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function queryParam(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v === null ? undefined : v;
}

function queryNumber(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function queryList(url: URL, name: string): string[] | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function pathParam(pathname: string, regex: RegExp, group: number): string | undefined {
  const m = pathname.match(regex);
  return m ? m[group] : undefined;
}

// ---------------------------------------------------------------------------
// Dashboard context: holds the data + actions layers for the lifetime of a server
// ---------------------------------------------------------------------------

interface DashboardContext {
  data: DashboardData;
  actions: DashboardActions;
}

function buildContext(cwd: string, bridge: ActionBridge, jobStore?: JobStore): DashboardContext {
  const data = new DashboardData({
    cwd,
    mode: bridge.mode,
    jobStore,
  });
  const actions = new DashboardActions({ cwd, bridge });
  return { data, actions };
}

function createDashboardServer(cwd: string, controlPlane?: MissionControlPlane, actionBridge?: ActionBridge): Server {
  const bridge = actionBridge
    ?? (controlPlane ? new ControlPlaneActionBridge(controlPlane) : new NoActionBridge());
  const jobStore = controlPlane ? new JobStore(new MissionStore(cwd)) : undefined;
  const ctx = buildContext(cwd, bridge, jobStore);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    setCors(res);
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      await route(ctx, req, res, url, pathname, method);
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });
}

// ---------------------------------------------------------------------------
// Router — one function per endpoint, thin delegation to the layers
// ---------------------------------------------------------------------------

async function route(
  ctx: DashboardContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  method: string,
): Promise<void> {
  const { data, actions } = ctx;

  // ── GET /api/status ─────────────────────────────────────────────────
  if (pathname === "/api/status" && method === "GET") {
    const missionId = queryParam(url, "missionId") ?? await data.tryResolveMissionId();
    if (!missionId) {
      sendJson(res, 200, {
        missionId: null,
        phase: "intake",
        status: "active",
        version: 0,
        updatedAt: "",
        agents: [],
        recommendedActions: [],
        actionsAvailable: data.actionsAvailable,
        mode: data.mode,
      });
      return;
    }
    const snapshot = await data.getMissionStatus(missionId);
    sendJson(res, 200, snapshot);
    return;
  }

  // ── GET /api/mission (legacy aggregated shape) ───────────────────────
  if (pathname === "/api/mission" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const bundle = await data.getArtifacts(missionId);
    sendJson(res, 200, {
      state: bundle.state ?? {},
      requirements: bundle.requirements ?? {},
      features: bundle.features ?? [],
      validationContractMd: bundle.contractMd ?? "",
    });
    return;
  }

  // ── GET /api/artifacts ───────────────────────────────────────────────
  if (pathname === "/api/artifacts" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const bundle = await data.getArtifacts(missionId);
    sendJson(res, 200, bundle);
    return;
  }

  // ── POST /api/artifact ───────────────────────────────────────────────
  if (pathname === "/api/artifact" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; filename?: string; content?: string };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.filename || typeof body.content !== "string") {
      sendError(res, 400, "Missing 'filename' or 'content'");
      return;
    }
    const result = await actions.saveArtifact(missionId, body.filename, body.content);
    sendJson(res, result.ok ? 200 : (result.gated ? 403 : 400), result);
    return;
  }

  // ── POST /api/decision (append-only) ─────────────────────────────────
  if (pathname === "/api/decision" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; context?: string; decision?: string; rationale?: string };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.context || !body.decision || !body.rationale) {
      sendError(res, 400, "Missing 'context', 'decision', or 'rationale'");
      return;
    }
    const result = await actions.appendDecision(missionId, {
      context: body.context,
      decision: body.decision,
      rationale: body.rationale,
    });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── POST /api/contract (JSON+MD consistent save, #2) ─────────────────
  if (pathname === "/api/contract" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; content?: string; format?: "json" | "md" };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.content || !body.format) {
      sendError(res, 400, "Missing 'content' or 'format' (must be 'json' or 'md')");
      return;
    }
    const result = await actions.saveContract(missionId, body.content, body.format);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── POST /api/features ───────────────────────────────────────────────
  if (pathname === "/api/features" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; features?: unknown[] };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!Array.isArray(body.features)) {
      sendError(res, 400, "Missing 'features' array");
      return;
    }
    const result = await actions.saveFeatures(missionId, body.features as never[]);
    sendJson(res, result.ok ? 200 : (result.gated ? 403 : 400), result);
    return;
  }

  // ── POST /api/milestones ─────────────────────────────────────────────
  if (pathname === "/api/milestones" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; milestones?: unknown[] };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!Array.isArray(body.milestones)) {
      sendError(res, 400, "Missing 'milestones' array");
      return;
    }
    const result = await actions.saveMilestones(missionId, body.milestones as never[]);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── POST /api/message (free-form reply, mode-aware #5) ───────────────
  if (pathname === "/api/message" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; message?: string; questionId?: string };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.message || typeof body.message !== "string") {
      sendError(res, 400, "Missing 'message' string");
      return;
    }
    const result = await actions.sendMessage(missionId, body.message, body.questionId);
    sendJson(res, result.ok ? 202 : 200, result);
    return;
  }

  // ── POST /api/approve ────────────────────────────────────────────────
  if (pathname === "/api/approve" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; feedback?: string; files?: Record<string, string> };
    const missionId = await data.resolveMissionId(body.missionId);
    const result = await actions.approvePlan(missionId, body.feedback, body.files);
    sendJson(res, result.ok ? 202 : 200, result);
    return;
  }

  // ── POST /api/reject ─────────────────────────────────────────────────
  if (pathname === "/api/reject" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; feedback?: string; files?: Record<string, string> };
    const missionId = await data.resolveMissionId(body.missionId);
    const result = await actions.rejectPlan(missionId, body.feedback, body.files);
    sendJson(res, result.ok ? 202 : 200, result);
    return;
  }

  // ── POST /api/fix-feature (validation recovery, #6 action button) ────
  if (pathname === "/api/fix-feature" && method === "POST") {
    const body = await parseBody(req) as {
      missionId?: string;
      milestoneId?: string;
      suggestion?: { title: string; description: string; issueIds: string[] };
    };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.milestoneId || !body.suggestion) {
      sendError(res, 400, "Missing 'milestoneId' or 'suggestion'");
      return;
    }
    const result = await actions.createFixFeature(missionId, body.milestoneId, body.suggestion);
    sendJson(res, result.ok ? 202 : 200, result);
    return;
  }

  // ── POST /api/approve-with-edits (proposed amendments, smart friend #3) ─
  if (pathname === "/api/approve-with-edits" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; edits?: Record<string, string>; feedback?: string };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.edits) {
      sendError(res, 400, "Missing 'edits' object");
      return;
    }
    const result = await actions.approveWithEdits(missionId, body.edits, body.feedback);
    sendJson(res, result.ok ? 202 : 200, result);
    return;
  }

  // ── POST /api/request-changes (reject with proposed edits) ─────────────
  if (pathname === "/api/request-changes" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; edits?: Record<string, string>; feedback?: string };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.edits) {
      sendError(res, 400, "Missing 'edits' object");
      return;
    }
    const result = await actions.requestChanges(missionId, body.edits, body.feedback);
    sendJson(res, result.ok ? 202 : 200, result);
    return;
  }

  // ── GET /api/events (paginated + filtered, #7) ───────────────────────
  if (pathname === "/api/events" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const slice = await data.getEvents(missionId, {
      after: queryNumber(url, "after"),
      limit: queryNumber(url, "limit"),
      types: queryList(url, "types") as EventType[] | undefined,
      agentLevels: queryList(url, "levels") as AgentLevel[] | undefined,
      toolName: queryParam(url, "tool"),
      q: queryParam(url, "q"),
    });
    sendJson(res, 200, slice);
    return;
  }

  // ── GET /api/events/assistant (view-only messages) ───────────────────
  if (pathname === "/api/events/assistant" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const msgs = await data.getAssistantMessages(
      missionId,
      queryNumber(url, "after") ?? 0,
      queryNumber(url, "limit") ?? 200,
    );
    sendJson(res, 200, { events: msgs });
    return;
  }

  // ── GET /api/usage ───────────────────────────────────────────────────
  if (pathname === "/api/usage" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const groupBy = (queryParam(url, "groupBy") as "role" | "model" | "provider") ?? "role";
    const agg = await data.getUsage(missionId, groupBy);
    sendJson(res, 200, agg);
    return;
  }

  // ── GET /api/jobs ─────────────────────────────────────────────────────
  if (pathname === "/api/jobs" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const jobs = await data.getJobs(missionId);
    sendJson(res, 200, { missionId, jobs });
    return;
  }

  // ── GET /api/handoffs ─────────────────────────────────────────────────
  if (pathname === "/api/handoffs" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const handoffs = await data.getHandoffs(missionId);
    sendJson(res, 200, { missionId, handoffs });
    return;
  }

  // ── GET /api/handoffs/:featureId ──────────────────────────────────────
  {
    const detailMatch = pathname.match(/^\/api\/handoffs\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
      const featureId = detailMatch[1];
      const handoff = await data.getHandoffDetail(missionId, featureId);
      if (!handoff) {
        sendError(res, 404, `No handoff found for feature ${featureId}`);
        return;
      }
      sendJson(res, 200, handoff);
      return;
    }
  }

  // ── GET /api/handoffs/:featureId/raw ──────────────────────────────────
  {
    const rawMatch = pathname.match(/^\/api\/handoffs\/([^/]+)\/raw$/);
    if (rawMatch && method === "GET") {
      const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
      const featureId = rawMatch[1];
      const raw = await data.getWorkerRawOutput(missionId, featureId);
      if (!raw) {
        sendError(res, 404, `No raw output found for feature ${featureId}`);
        return;
      }
      sendJson(res, 200, raw);
      return;
    }
  }

  // ── GET /api/reports/validation ───────────────────────────────────────
  if (pathname === "/api/reports/validation" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const milestoneId = queryParam(url, "milestoneId");
    const reports = await data.getValidationReports(missionId, milestoneId);
    sendJson(res, 200, { missionId, reports });
    return;
  }

  // ── GET /api/reports/user-testing ─────────────────────────────────────
  if (pathname === "/api/reports/user-testing" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const milestoneId = queryParam(url, "milestoneId");
    const reports = await data.getUserTestingReports(missionId, milestoneId);
    sendJson(res, 200, { missionId, reports });
    return;
  }

  // ── GET /api/workspace ────────────────────────────────────────────────
  if (pathname === "/api/workspace" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const tree = await data.getFileTree(missionId);
    sendJson(res, 200, { tree, missionId });
    return;
  }

  // ── GET /api/file?path= ───────────────────────────────────────────────
  if (pathname === "/api/file" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const relPath = queryParam(url, "path") ?? "";
    const file = await data.getFile(missionId, relPath);
    if (!file) {
      sendError(res, 404, "File not found");
      return;
    }
    sendJson(res, 200, file);
    return;
  }

  // ── POST /api/file (delegates to the same gate as /api/artifact, #4) ─
  if (pathname === "/api/file" && method === "POST") {
    const body = await parseBody(req) as { missionId?: string; path?: string; content?: string };
    const missionId = await data.resolveMissionId(body.missionId);
    if (!body.path || typeof body.content !== "string") {
      sendError(res, 400, "Missing 'path' or 'content'");
      return;
    }
    const result = await actions.saveFile(missionId, body.path, body.content);
    sendJson(res, result.ok ? 200 : (result.gated ? 403 : 400), result);
    return;
  }

  // ── GET /api/diff ─────────────────────────────────────────────────────
  if (pathname === "/api/diff" && method === "GET") {
    const missionId = queryParam(url, "missionId") ?? await data.tryResolveMissionId();
    const result = await data.getDiff(missionId);
    sendJson(res, 200, result);
    return;
  }

  // ── GET /api/agent-tree (#2: agent tree with glowing nodes) ────────────
  if (pathname === "/api/agent-tree" && method === "GET") {
    const missionId = queryParam(url, "missionId") ?? await data.tryResolveMissionId();
    if (!missionId) {
      sendJson(res, 200, { tree: null });
      return;
    }
    const tree = await data.getAgentTree(missionId);
    sendJson(res, 200, { tree });
    return;
  }

  // ── GET /api/activity (#3: semantic activity feed) ─────────────────────
  if (pathname === "/api/activity" && method === "GET") {
    const missionId = queryParam(url, "missionId") ?? await data.tryResolveMissionId();
    if (!missionId) {
      sendJson(res, 200, { entries: [], total: 0 });
      return;
    }
    const feed = await data.getActivityFeed(
      missionId,
      queryNumber(url, "limit") ?? 100,
      queryNumber(url, "after") ?? 0,
    );
    sendJson(res, 200, feed);
    return;
  }

  // ── GET /api/decisions ───────────────────────────────────────────────
  if (pathname === "/api/decisions" && method === "GET") {
    const missionId = await data.resolveMissionId(queryParam(url, "missionId"));
    const decisions = await data.getDecisions(missionId);
    sendJson(res, 200, { missionId, decisions });
    return;
  }

  // ── Serve dashboard.html for all other routes ────────────────────────
  try {
    const html = await readFile(DASHBOARD_HTML_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Dashboard HTML not found. Expected: " + DASHBOARD_HTML_PATH);
  }
}

// ---------------------------------------------------------------------------
// Listen / close helpers
// ---------------------------------------------------------------------------

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function isAddressInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EADDRINUSE";
}

export function logDashboardUrl(port: number): void {
  console.log(`\n🛰️  Ratel Observatory Dashboard`);
  console.log(`   http://localhost:${port}\n`);
}

/**
 * Legacy/manual API used by the Pi extension. Starts exactly on the requested
 * port and returns the raw Server synchronously.
 */
export function startDashboardServer(options: DashboardServerOptions): Server {
  const { cwd, port = 8765, host = "127.0.0.1", controlPlane, actionBridge } = options;
  const server = createDashboardServer(cwd, controlPlane, actionBridge);

  server.listen(port, host, () => {
    const address = server.address() as AddressInfo;
    const url = `http://localhost:${address.port}`;
    currentDashboardUrl = url;
    persistDashboardUrl(cwd, url);
    logDashboardUrl(address.port);
  });

  return server;
}

/**
 * Startup API used by the factory lifecycle. It is fail-soft around port
 * conflicts: if the preferred port is busy, it tries subsequent ports.
 */
export async function startDashboardServerOnAvailablePort(
  options: DashboardServerOptions & { maxPortAttempts?: number },
): Promise<DashboardServerHandle> {
  const { cwd, port = 8765, host = "127.0.0.1", maxPortAttempts = 20, controlPlane, actionBridge } = options;
  const candidatePorts = port === 0
    ? [0]
    : Array.from({ length: maxPortAttempts }, (_, index) => port + index);

  let lastError: unknown;
  for (const candidatePort of candidatePorts) {
    const server = createDashboardServer(cwd, controlPlane, actionBridge);
    try {
      const actualPort = await listen(server, candidatePort, host);
      if (candidatePort !== port && port !== 0) {
        console.warn(
          `[Observatory] Port ${port} unavailable; using http://localhost:${actualPort} instead.`,
        );
      }
      const url = `http://localhost:${actualPort}`;
      currentDashboardUrl = url;
      persistDashboardUrl(cwd, url);
      logDashboardUrl(actualPort);
      return {
        server,
        port: actualPort,
        url,
        close: () => closeServer(server),
      };
    } catch (err) {
      lastError = err;
      await closeServer(server).catch(() => undefined);
      if (!isAddressInUse(err)) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to start Observatory on or after port ${port}`);
}