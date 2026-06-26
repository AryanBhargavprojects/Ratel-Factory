/**
 * Ratel Core Service — HTTP API
 *
 * Provides REST endpoints for mission management, worker execution,
 * validation, and observatory access. Uses durable MissionControlPlane.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, access, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { URL } from "node:url";
import { pingAllAgents } from "./core/ping-agents.js";
import { MissionControlPlane } from "./control-plane/mission-control-plane.js";
import { JobRunner } from "./control-plane/job-runner.js";
import { MissionStore } from "./control-plane/mission-store.js";
import { JobStore } from "./control-plane/job-store.js";
import { withFileLock } from "./control-plane/mutex.js";
import { runLegacyMigration } from "./control-plane/legacy-migration.js";
import { ARTIFACT_NAMES } from "./core/types.js";
import { getObservabilityConfig } from "./core/config.js";
import { startObservatory, type ObservatoryHandle } from "./observatory/service.js";
import { getCurrentDashboardUrl } from "./observatory/server.js";
import { createMissionScope } from "./core/mission/scope.js";
import { getMissionDir } from "./core/mission/scope.js";
import { EventLogger } from "./core/observability/event-logger.js";
import { ensureMissionInitialized } from "./core/artifacts.js";
import { readJsonFile } from "./core/mission/atomic-file.js";

export interface ApiOptions {
  cwd: string;
  port?: number;
  host?: string;
  controlPlane?: MissionControlPlane;
}

export interface ApiServer {
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
  shutdown: () => Promise<void>;
}

function parseBody(req: IncomingMessage): Promise<unknown> {
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isValidArtifactFilename(filename: string): boolean {
  if (ARTIFACT_NAMES.includes(filename as any)) return true;
  if (filename.startsWith("features/") && filename.endsWith(".feature") && !filename.includes("..")) return true;
  return false;
}

export async function createApiServer(options: ApiOptions): Promise<ApiServer> {
  const { cwd, port = 8765, host = "127.0.0.1" } = options;

  let controlPlane: MissionControlPlane;
  if (options.controlPlane) {
    controlPlane = options.controlPlane;
  } else {
    const missionStore = new MissionStore(cwd);
    const jobStore = new JobStore(missionStore);
    const executor = new JobRunner({ cwd, jobStore });
    controlPlane = new MissionControlPlane({ cwd, executor, concurrency: 1 });
    await controlPlane.start();
  }

  // Start observatory on startup (on port + 1 to avoid conflict)
  let observatory: ObservatoryHandle = { enabled: false, shutdown: async () => undefined };
  try {
    const obsConfig = await getObservabilityConfig(cwd);
    observatory = await startObservatory({
      cwd,
      config: { ...obsConfig, port: (obsConfig.port ?? port) + 1 },
      controlPlane,
    });
  } catch (err) {
    console.warn("[API] Observatory startup failed:", err instanceof Error ? err.message : err);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    try {
      // GET /health
      if (url.pathname === "/health" && method === "GET") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // POST /api/v1/ping/agents
      if (url.pathname === "/api/v1/ping/agents" && method === "POST") {
        let body: { timeoutMs?: number };
        try {
          body = await parseBody(req) as { timeoutMs?: number };
        } catch {
          body = {};
        }
        const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0
          ? body.timeoutMs
          : 20000;
        try {
          const result = await pingAllAgents(cwd, timeoutMs);
          sendJson(res, 200, result);
        } catch (err) {
          console.error("[API] ping/agents failed:", err);
          sendError(res, 500, err instanceof Error ? err.message : "Internal ping error");
        }
        return;
      }

      // === v1 API ===

      // POST /api/v1/missions
      if (url.pathname === "/api/v1/missions" && method === "POST") {
        let body: { goal?: string };
        try {
          body = await parseBody(req) as { goal?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.goal || typeof body.goal !== "string" || body.goal.trim().length === 0) {
          sendError(res, 400, "Missing or invalid 'goal' field");
          return;
        }
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        const { mission, job } = await controlPlane.enqueueMission({
          goal: body.goal,
          idempotencyKey,
        });
        sendJson(res, 202, { missionId: mission.missionId, jobId: job.jobId });
        return;
      }

      // GET /api/v1/missions/:missionId
      const missionMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)$/);
      if (missionMatch && method === "GET") {
        const missionId = missionMatch[1];
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        sendJson(res, 200, mission);
        return;
      }

      // POST /api/v1/missions/:missionId/messages
      // Free-form user reply / clarification to the mission orchestrator.
      // Blessed replacement for deprecated /api/mission/complete.
      const messagesMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/messages$/);
      if (messagesMatch && method === "POST") {
        const missionId = messagesMatch[1];
        let body: { message?: string; questionId?: string };
        try {
          body = await parseBody(req) as { message?: string; questionId?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (typeof body.message !== "string" || body.message.trim().length === 0) {
          sendError(res, 400, "Missing or empty 'message' field");
          return;
        }
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        const payload: Record<string, unknown> = { message: body.message.trim() };
        if (typeof body.questionId === "string" && body.questionId.length > 0) {
          payload.questionId = body.questionId;
        }
        const job = await controlPlane.enqueueJob({
          missionId,
          type: "continue_orchestrator",
          payload,
        });
        sendJson(res, 202, { missionId, jobId: job.jobId, status: "queued" });
        return;
      }

      // POST /api/v1/missions/:missionId/questions/:questionId/answer
      // Direct answer endpoint — wrapper over the messages endpoint. Validates
      // the question exists/current if easy, writes an answer artifact, and
      // enqueues a continue_orchestrator job with a message referencing the
      // question id. Direct unblocking of an in-flight ask_user promise is
      // NOT performed; the answer is delivered via queued continuation.
      const answerMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/questions\/([^\/]+)\/answer$/);
      if (answerMatch && method === "POST") {
        const missionId = answerMatch[1];
        const questionId = answerMatch[2];
        let body: { answer?: unknown };
        try {
          body = await parseBody(req) as { answer?: unknown };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (body.answer === undefined || body.answer === null) {
          sendError(res, 400, "Missing 'answer' field");
          return;
        }
        if (typeof body.answer === "string" && body.answer.trim().length === 0) {
          sendError(res, 400, "Empty 'answer' field");
          return;
        }
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }

        // Best-effort: record the answer against the pending-question artifact
        // so an in-flight ask_user short-wait (if enabled) can observe it. This
        // is fail-soft; missing file does not block the queued continuation.
        const scope = createMissionScope(cwd, missionId);
        const missionDir = getMissionDir(scope);
        try {
          const pendingPath = join(missionDir, "pending-question.json");
          const raw = await readFile(pendingPath, "utf-8");
          const parsed = JSON.parse(raw) as { questionId?: string; status?: string };
          if (parsed.questionId === questionId) {
            const updated = {
              ...parsed,
              status: "answered",
              answer: body.answer,
              answeredAt: new Date().toISOString(),
            } as Record<string, unknown>;
            await writeFile(pendingPath, JSON.stringify(updated, null, 2), "utf-8");
          }
        } catch {
          // No pending question file or stale — proceed with queued continuation.
        }

        const answerStr = typeof body.answer === "string" ? body.answer : JSON.stringify(body.answer);
        const message = `Answer to question ${questionId}: ${answerStr}`;
        const job = await controlPlane.enqueueJob({
          missionId,
          type: "continue_orchestrator",
          payload: { message, questionId, answer: body.answer },
        });
        sendJson(res, 202, { missionId, questionId, jobId: job.jobId, status: "queued" });
        return;
      }

      // GET /api/v1/missions/:missionId/jobs
      const jobsListMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/jobs$/);
      if (jobsListMatch && method === "GET") {
        const missionId = jobsListMatch[1];
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        const jobStore = new JobStore(new MissionStore(cwd));
        const jobs = await jobStore.listJobs(missionId);
        sendJson(res, 200, { missionId, jobs });
        return;
      }

      // GET /api/v1/missions/:missionId/jobs/:jobId
      const jobMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/jobs\/([^\/]+)$/);
      if (jobMatch && method === "GET") {
        const missionId = jobMatch[1];
        const jobId = jobMatch[2];
        const job = await controlPlane.getJob(missionId, jobId);
        if (!job) {
          sendError(res, 404, "Job not found");
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      // POST /api/v1/missions/:missionId/jobs/:jobId/cancel
      const cancelMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/jobs\/([^\/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        const missionId = cancelMatch[1];
        const jobId = cancelMatch[2];
        try {
          const job = await controlPlane.cancelJob(missionId, jobId);
          sendJson(res, 200, job);
        } catch (err) {
          sendError(res, 404, err instanceof Error ? err.message : "Not found");
        }
        return;
      }

      // POST /api/v1/missions/:missionId/workers
      const workersMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/workers$/);
      if (workersMatch && method === "POST") {
        const missionId = workersMatch[1];
        let body: { featureId?: string };
        try {
          body = await parseBody(req) as { featureId?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.featureId) {
          sendError(res, 400, "Missing 'featureId' field");
          return;
        }
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        const job = await controlPlane.enqueueJob({
          missionId,
          type: "run_worker",
          payload: { featureId: body.featureId },
        });
        sendJson(res, 202, { missionId, jobId: job.jobId, status: "queued" });
        return;
      }

      // POST /api/v1/missions/:missionId/validations
      const validationsMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/validations$/);
      if (validationsMatch && method === "POST") {
        const missionId = validationsMatch[1];
        let body: { milestoneId?: string };
        try {
          body = await parseBody(req) as { milestoneId?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.milestoneId) {
          sendError(res, 400, "Missing 'milestoneId' field");
          return;
        }
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        const job = await controlPlane.enqueueJob({
          missionId,
          type: "run_validation",
          payload: { milestoneId: body.milestoneId },
        });
        sendJson(res, 202, { missionId, jobId: job.jobId, status: "queued" });
        return;
      }

      // POST /api/v1/missions/:missionId/user-testing
      const userTestingMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/user-testing$/);
      if (userTestingMatch && method === "POST") {
        const missionId = userTestingMatch[1];
        let body: { milestoneId?: string };
        try {
          body = await parseBody(req) as { milestoneId?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.milestoneId) {
          sendError(res, 400, "Missing 'milestoneId' field");
          return;
        }
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        const job = await controlPlane.enqueueJob({
          missionId,
          type: "run_user_testing",
          payload: { milestoneId: body.milestoneId },
        });
        sendJson(res, 202, { missionId, jobId: job.jobId, status: "queued" });
        return;
      }

      // POST /api/v1/missions/:missionId/approval
      const approvalMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/approval$/);
      if (approvalMatch && method === "POST") {
        const missionId = approvalMatch[1];
        let body: { approved?: boolean; feedback?: string; files?: Record<string, string> };
        try {
          body = await parseBody(req) as { approved?: boolean; feedback?: string; files?: Record<string, string> };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (typeof body.approved !== "boolean") {
          sendError(res, 400, "Missing 'approved' field (must be boolean)");
          return;
        }

        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }

        // Validate files
        if (body.files) {
          for (const filename of Object.keys(body.files)) {
            if (!isValidArtifactFilename(filename)) {
              sendError(res, 400, `Invalid filename: ${filename}`);
              return;
            }
          }

          // Write files
          const scope = createMissionScope(cwd, missionId);
          const missionDir = getMissionDir(scope);
          for (const [filename, content] of Object.entries(body.files)) {
            const filePath = join(missionDir, filename);
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, content, "utf-8");
          }
        }

        // Write approval.json
        const scope = createMissionScope(cwd, missionId);
        const missionDir = getMissionDir(scope);
        await mkdir(missionDir, { recursive: true });
        await writeFile(
          join(missionDir, "approval.json"),
          JSON.stringify({
            status: body.approved ? "approved" : "rejected",
            missionId,
            feedback: body.feedback,
            files: body.files ? Object.keys(body.files) : undefined,
            decidedAt: new Date().toISOString(),
          }, null, 2),
          "utf-8"
        );

        const job = await controlPlane.submitApproval(missionId, {
          approved: body.approved,
          feedback: body.feedback,
          files: body.files,
        });
        sendJson(res, 202, { missionId, jobId: job.jobId, status: "queued" });
        return;
      }

      // GET /api/v1/missions/:missionId/events
      const eventsMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/events$/);
      if (eventsMatch && method === "GET") {
        const missionId = eventsMatch[1];
        const after = Number(url.searchParams.get("after") ?? "0");
        const scope = createMissionScope(cwd, missionId);
        const eventsPath = join(getMissionDir(scope), "events.jsonl");
        const events: unknown[] = [];
        try {
          await access(eventsPath);
          const raw = await readFile(eventsPath, "utf-8");
          const lines = raw.split("\n");
          for (let i = after; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;
            try {
              events.push(JSON.parse(trimmed));
            } catch {
              // Skip malformed
            }
          }
        } catch {
          // File doesn't exist
        }
        sendJson(res, 200, { missionId, events, after });
        return;
      }

      // GET /api/v1/missions/:missionId/events/stream — SSE
      const eventsStreamMatch = url.pathname.match(/^\/api\/v1\/missions\/([^\/]+)\/events\/stream$/);
      if (eventsStreamMatch && method === "GET") {
        const missionId = eventsStreamMatch[1];
        const after = Number(url.searchParams.get("after") ?? "0");
        const scope = createMissionScope(cwd, missionId);
        const eventsPath = join(getMissionDir(scope), "events.jsonl");

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        let lastOffset = after;
        let heartbeatTimer: ReturnType<typeof setInterval>;
        let fileWatcher: ReturnType<typeof setInterval>;
        let clientDisconnected = false;

        const sendHeartbeat = () => {
          if (clientDisconnected) return;
          res.write(": heartbeat\n\n");
        };

        const sendEvents = async () => {
          if (clientDisconnected) return;
          try {
            await access(eventsPath);
            const raw = await readFile(eventsPath, "utf-8");
            const lines = raw.split("\n");
            const newEvents: unknown[] = [];
            for (let i = lastOffset; i < lines.length; i++) {
              const trimmed = lines[i].trim();
              if (!trimmed) continue;
              try {
                newEvents.push(JSON.parse(trimmed));
              } catch {
                // Skip malformed
              }
            }
            if (newEvents.length > 0) {
              lastOffset = lines.length;
              for (const event of newEvents) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            }
          } catch {
            // File may not exist yet
          }
        };

        // Send initial events
        await sendEvents();

        heartbeatTimer = setInterval(sendHeartbeat, 15000);
        fileWatcher = setInterval(sendEvents, 1000);

        req.on("close", () => {
          clientDisconnected = true;
          clearInterval(heartbeatTimer);
          clearInterval(fileWatcher);
        });

        req.on("error", () => {
          clientDisconnected = true;
          clearInterval(heartbeatTimer);
          clearInterval(fileWatcher);
        });

        return;
      }

      // === Deprecated routes ===

      // POST /api/mission/start (deprecated)
      if (url.pathname === "/api/mission/start" && method === "POST") {
        res.setHeader("Deprecation", "true");
        let body: { goal?: string };
        try {
          body = await parseBody(req) as { goal?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.goal) {
          sendError(res, 400, "Missing 'goal' field");
          return;
        }
        const { mission, job } = await controlPlane.enqueueMission({ goal: body.goal });
        sendJson(res, 200, { missionId: mission.missionId, jobId: job.jobId });
        return;
      }

      // GET /api/mission/status (deprecated)
      if (url.pathname === "/api/mission/status" && method === "GET") {
        res.setHeader("Deprecation", "true");
        const missionId = url.searchParams.get("missionId");
        if (!missionId) {
          sendError(res, 400, "Missing 'missionId' query parameter");
          return;
        }
        const mission = await controlPlane.getMission(missionId);
        if (!mission) {
          sendError(res, 404, "Mission not found");
          return;
        }
        const jobStore = new JobStore(new MissionStore(cwd));
        const jobs = await jobStore.listJobs(missionId);
        sendJson(res, 200, { missionId, status: mission.status, jobs });
        return;
      }

      // POST /api/mission/worker (deprecated)
      if (url.pathname === "/api/mission/worker" && method === "POST") {
        res.setHeader("Deprecation", "true");
        let body: { missionId?: string; featureId?: string };
        try {
          body = await parseBody(req) as { missionId?: string; featureId?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.missionId || !body.featureId) {
          sendError(res, 400, "Missing 'missionId' or 'featureId'");
          return;
        }
        const job = await controlPlane.enqueueJob({
          missionId: body.missionId,
          type: "run_worker",
          payload: { featureId: body.featureId },
        });
        sendJson(res, 200, { missionId: body.missionId, featureId: body.featureId, jobId: job.jobId, status: "queued" });
        return;
      }

      // POST /api/mission/validate (deprecated)
      if (url.pathname === "/api/mission/validate" && method === "POST") {
        res.setHeader("Deprecation", "true");
        let body: { missionId?: string; milestoneId?: string };
        try {
          body = await parseBody(req) as { missionId?: string; milestoneId?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.missionId || !body.milestoneId) {
          sendError(res, 400, "Missing 'missionId' or 'milestoneId'");
          return;
        }
        const job = await controlPlane.enqueueJob({
          missionId: body.missionId,
          type: "run_validation",
          payload: { milestoneId: body.milestoneId },
        });
        sendJson(res, 200, { missionId: body.missionId, milestoneId: body.milestoneId, jobId: job.jobId, status: "queued" });
        return;
      }

      // POST /api/mission/complete (deprecated)
      if (url.pathname === "/api/mission/complete" && method === "POST") {
        res.setHeader("Deprecation", "true");
        let body: { missionId?: string; featureId?: string; message?: string };
        try {
          body = await parseBody(req) as { missionId?: string; featureId?: string; message?: string };
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return;
        }
        if (!body.missionId) {
          sendError(res, 400, "Missing 'missionId'");
          return;
        }
        // Backward-compatible message: prefer an explicit body.message, then
        // fall back to the historical "Mark feature X as complete" for callers
        // that only supply featureId.
        const message =
          typeof body.message === "string" && body.message.trim().length > 0
            ? body.message.trim()
            : `Mark feature ${body.featureId ?? "unknown"} as complete`;
        const job = await controlPlane.enqueueJob({
          missionId: body.missionId,
          type: "continue_orchestrator",
          payload: { message },
        });
        sendJson(res, 200, { missionId: body.missionId, featureId: body.featureId, jobId: job.jobId, status: "queued" });
        return;
      }

      // GET /api/mission/artifacts (deprecated)
      if (url.pathname === "/api/mission/artifacts" && method === "GET") {
        res.setHeader("Deprecation", "true");
        const missionId = url.searchParams.get("missionId");
        if (!missionId) {
          sendError(res, 400, "Missing 'missionId' query parameter");
          return;
        }
        const scope = createMissionScope(cwd, missionId);
        const artifacts: Record<string, string[]> = {};
        try {
          const reportsDir = join(getMissionDir(scope), "validation-reports");
          await access(reportsDir);
          const entries = await readdir(reportsDir, { withFileTypes: true });
          artifacts.validationReports = entries.filter(e => e.isFile() && e.name.endsWith(".json")).map(e => e.name);
        } catch {
          artifacts.validationReports = [];
        }
        try {
          const featuresDir = join(getMissionDir(scope), "features");
          await access(featuresDir);
          const entries = await readdir(featuresDir, { withFileTypes: true });
          artifacts.features = entries.filter(e => e.isFile() && e.name.endsWith(".feature")).map(e => e.name);
        } catch {
          artifacts.features = [];
        }
        try {
          const handoffsDir = join(getMissionDir(scope), "handoffs");
          await access(handoffsDir);
          const entries = await readdir(handoffsDir, { withFileTypes: true });
          artifacts.handoffs = entries.filter(e => e.isFile() && e.name.endsWith(".json")).map(e => e.name);
        } catch {
          artifacts.handoffs = [];
        }
        sendJson(res, 200, { missionId, artifacts });
        return;
      }

      // GET /api/observatory/events (deprecated)
      if (url.pathname === "/api/observatory/events" && method === "GET") {
        res.setHeader("Deprecation", "true");
        const missionId = url.searchParams.get("missionId") ?? "mis_00000001";
        const scope = createMissionScope(cwd, missionId);
        const eventsPath = join(getMissionDir(scope), "events.jsonl");
        const events: unknown[] = [];
        try {
          await access(eventsPath);
          const raw = await readFile(eventsPath, "utf-8");
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              events.push(JSON.parse(trimmed));
            } catch {
              // Skip malformed
            }
          }
        } catch {
          // File doesn't exist
        }
        sendJson(res, 200, { events });
        return;
      }

      // GET /api/observatory/status
      if (url.pathname === "/api/observatory/status" && method === "GET") {
        const dashboardUrl = getCurrentDashboardUrl(cwd) ?? null;
        sendJson(res, 200, { enabled: observatory.enabled, url: dashboardUrl });
        return;
      }

      // 404
      sendError(res, 404, `Not found: ${method} ${url.pathname}`);
    } catch (err) {
      console.error("[API] Error handling request:", err);
      sendError(res, 500, err instanceof Error ? err.message : "Internal server error");
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        const actualUrl = `http://${host}:${address.port}`;
        resolve({
          server,
          port: address.port,
          url: actualUrl,
          shutdown: async () => {
            await new Promise<void>((res, rej) => {
              server.close((err) => (err ? rej(err) : res()));
            });
            if (!options.controlPlane) {
              await controlPlane.shutdown();
            }
            await observatory.shutdown();
          },
        });
      } else {
        reject(new Error("Server address is not available"));
      }
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startService(options: ApiOptions): Promise<ApiServer> {
  const api = await createApiServer(options);
  console.log(`\n🚀 Ratel Service`);
  console.log(`   API: ${api.url}`);
  console.log(`   Health: ${api.url}/health\n`);
  return api;
}
