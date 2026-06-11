/**
 * Ratel Core Service — HTTP API
 *
 * Provides REST endpoints for mission management, worker execution,
 * validation, and observatory access. Reuses the existing core logic.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { OrchestratorAgent } from "./core/orchestrator.js";
import {
  ensureMissionInitialized,
  loadMissionState,
  readState,
  readFeatures,
  getMissionDir,
  listValidationReports,
  listUserTestingReports,
  listFeatureFiles,
  writeArtifact,
} from "./core/artifacts.js";
import { getObservabilityConfig } from "./core/config.js";
import { startObservatory, type ObservatoryHandle } from "./observatory/service.js";
import { getCurrentDashboardUrl } from "./observatory/server.js";

export interface ApiOptions {
  cwd: string;
  port?: number;
  host?: string;
}

export interface ApiServer {
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
  shutdown: () => Promise<void>;
}

/** Simple in-memory store for active missions while service is running. */
const activeMissions = new Map<string, OrchestratorAgent>();

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

export async function createApiServer(options: ApiOptions): Promise<ApiServer> {
  const { cwd, port = 8765, host = "127.0.0.1" } = options;

  // Start observatory on startup
  let observatory: ObservatoryHandle = { enabled: false, shutdown: async () => undefined };
  try {
    observatory = await startObservatory({
      cwd,
      config: await getObservabilityConfig(cwd),
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

      // POST /api/mission/start
      if (url.pathname === "/api/mission/start" && method === "POST") {
        const body = await parseBody(req) as { goal?: string };
        if (!body.goal) {
          sendError(res, 400, "Missing 'goal' field");
          return;
        }
        await ensureMissionInitialized(cwd);
        const state = await readState(cwd);
        const missionId = state?.traceId ?? `mission-${Date.now()}`;
        const agent = new OrchestratorAgent();
        await agent.init({ cwd, inMemory: true });
        activeMissions.set(missionId, agent);
        await agent.prompt(body.goal);
        sendJson(res, 200, { missionId });
        return;
      }

      // GET /api/mission/status
      if (url.pathname === "/api/mission/status" && method === "GET") {
        const missionId = url.searchParams.get("missionId");
        if (!missionId) {
          sendError(res, 400, "Missing 'missionId' query parameter");
          return;
        }
        const state = await loadMissionState(cwd);
        sendJson(res, 200, { missionId, state });
        return;
      }

      // POST /api/mission/worker
      if (url.pathname === "/api/mission/worker" && method === "POST") {
        const body = await parseBody(req) as { missionId?: string; featureId?: string };
        if (!body.missionId || !body.featureId) {
          sendError(res, 400, "Missing 'missionId' or 'featureId'");
          return;
        }
        // Worker execution is delegated to the orchestrator
        const agent = activeMissions.get(body.missionId);
        if (!agent) {
          sendError(res, 404, "Mission not found");
          return;
        }
        await agent.prompt(`Run worker for feature ${body.featureId}`);
        sendJson(res, 200, { missionId: body.missionId, featureId: body.featureId, status: "started" });
        return;
      }

      // POST /api/mission/validate
      if (url.pathname === "/api/mission/validate" && method === "POST") {
        const body = await parseBody(req) as { missionId?: string; milestoneId?: string };
        if (!body.missionId || !body.milestoneId) {
          sendError(res, 400, "Missing 'missionId' or 'milestoneId'");
          return;
        }
        const agent = activeMissions.get(body.missionId);
        if (!agent) {
          sendError(res, 404, "Mission not found");
          return;
        }
        await agent.prompt(`Run validation for milestone ${body.milestoneId}`);
        sendJson(res, 200, { missionId: body.missionId, milestoneId: body.milestoneId, status: "started" });
        return;
      }

      // GET /api/mission/artifacts
      if (url.pathname === "/api/mission/artifacts" && method === "GET") {
        const missionId = url.searchParams.get("missionId");
        if (!missionId) {
          sendError(res, 400, "Missing 'missionId' query parameter");
          return;
        }
        const artifacts: Record<string, string[]> = {};
        try {
          const reportsDir = join(getMissionDir(cwd), "validation-reports");
          await access(reportsDir);
          const entries = await readdir(reportsDir, { withFileTypes: true });
          artifacts.validationReports = entries.filter(e => e.isFile() && e.name.endsWith(".json")).map(e => e.name);
        } catch {
          artifacts.validationReports = [];
        }
        try {
          const featuresDir = join(getMissionDir(cwd), "features");
          await access(featuresDir);
          const entries = await readdir(featuresDir, { withFileTypes: true });
          artifacts.features = entries.filter(e => e.isFile() && e.name.endsWith(".feature")).map(e => e.name);
        } catch {
          artifacts.features = [];
        }
        try {
          const handoffsDir = join(getMissionDir(cwd), "handoffs");
          await access(handoffsDir);
          const entries = await readdir(handoffsDir, { withFileTypes: true });
          artifacts.handoffs = entries.filter(e => e.isFile() && e.name.endsWith(".json")).map(e => e.name);
        } catch {
          artifacts.handoffs = [];
        }
        sendJson(res, 200, { missionId, artifacts });
        return;
      }

      // POST /api/mission/complete
      if (url.pathname === "/api/mission/complete" && method === "POST") {
        const body = await parseBody(req) as { missionId?: string; featureId?: string };
        if (!body.missionId || !body.featureId) {
          sendError(res, 400, "Missing 'missionId' or 'featureId'");
          return;
        }
        const agent = activeMissions.get(body.missionId);
        if (!agent) {
          sendError(res, 404, "Mission not found");
          return;
        }
        await agent.prompt(`Mark feature ${body.featureId} as complete`);
        sendJson(res, 200, { missionId: body.missionId, featureId: body.featureId, status: "completed" });
        return;
      }

      // GET /api/observatory/events
      if (url.pathname === "/api/observatory/events" && method === "GET") {
        const eventsPath = join(cwd, ".missions", "current", "events.jsonl");
        try {
          await access(eventsPath);
          const raw = await readFile(eventsPath, "utf-8");
          const events: unknown[] = [];
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              events.push(JSON.parse(trimmed));
            } catch {
              // Skip malformed lines
            }
          }
          sendJson(res, 200, { events });
        } catch {
          sendJson(res, 200, { events: [] });
        }
        return;
      }

      // GET /api/observatory/status
      if (url.pathname === "/api/observatory/status" && method === "GET") {
        const url = getCurrentDashboardUrl(cwd) ?? null;
        sendJson(res, 200, { enabled: observatory.enabled, url });
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
          shutdown: () => new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
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
