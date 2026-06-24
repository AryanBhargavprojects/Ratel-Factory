/**
 * Ratel Observatory — Dashboard Server
 *
 * Serves a single-file HTML dashboard at http://localhost:<port>
 * and an /api/events endpoint that returns the contents of events.jsonl
 * as a JSON array.
 *
 * The dashboard is a READ-ONLY view. All event data is written by the
 * EventLogger in event-logger.ts. This server only reads events.jsonl.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, access, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { resolveCanonicalWorkspace } from "../core/mission/workspace-resolution.js";
import { createMissionScope } from "../core/mission/scope.js";
import { getMissionDir } from "../core/mission/scope.js";
import { readJsonFile } from "../core/mission/atomic-file.js";
import { getRatelDir } from "../core/mission/scope.js";
import { ARTIFACT_NAMES } from "../core/types.js";

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));

// dashboard.html is co-located with this server file so it deploys together.
const DASHBOARD_HTML_PATH = join(__dirname, "dashboard.html");

// Shared mutable state so the TUI footer and Pi commands can discover the
// actual URL even when the port falls back dynamically.
let currentDashboardUrl: string | undefined;

function getDashboardUrlFilePath(cwd: string): string {
  return join(cwd, ".ratel", "observatory-url.txt");
}

function persistDashboardUrl(cwd: string, url: string): void {
  try {
    const dir = join(cwd, ".ratel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(getDashboardUrlFilePath(cwd), url, "utf-8");
  } catch {
    // Best-effort persistence; silently ignore write errors.
  }
}

function readDashboardUrlFile(cwd: string): string | undefined {
  try {
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
  controlPlane?: import("../control-plane/mission-control-plane.js").MissionControlPlane;
}

export interface DashboardServerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function parseEventsJsonl(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // JSONL may contain a partially written/corrupt line if read mid-flush.
      // Skip bad lines so one malformed event does not blank the dashboard.
    }
  }
  return events;
}

async function resolveMissionId(cwd: string, preferredMissionId?: string): Promise<string> {
  if (preferredMissionId) return preferredMissionId;
  const currentMissionPath = join(getRatelDir(cwd), "current-mission.json");
  const record = await readJsonFile<{ missionId: string }>(currentMissionPath);
  return record?.missionId ?? "mis_00000001";
}

interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: FileTreeNode[];
}

async function buildFileTree(rootDir: string, currentDir: string): Promise<FileTreeNode | null> {
  const name = relative(rootDir, currentDir) || ".";
  try {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const children: FileTreeNode[] = [];
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        const child = await buildFileTree(rootDir, fullPath);
        if (child) children.push(child);
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath);
          children.push({ name: entry.name, path: relPath, type: "file", size: s.size });
        } catch {
          children.push({ name: entry.name, path: relPath, type: "file", size: 0 });
        }
      }
    }
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { name, path: relative(rootDir, currentDir) || ".", type: "dir", children };
  } catch {
    return null;
  }
}

function createDashboardServer(cwd: string, controlPlane?: import("../control-plane/mission-control-plane.js").MissionControlPlane): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS headers — allow the dashboard to be opened from anywhere.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: Return all parseable events as a JSON array.
    const eventsMatch = pathname.match(/^\/api\/events(?:\/)?(?:\?.*)?$/);
    if (eventsMatch && (pathname === "/api/events" || pathname.startsWith("/api/events"))) {
      const missionId = await resolveMissionId(cwd, url.searchParams.get("missionId") ?? undefined);
      const scope = createMissionScope(cwd, missionId);
      const eventsPath = join(getMissionDir(scope), "events.jsonl");
      try {
        await access(eventsPath);
        const raw = await readFile(eventsPath, "utf-8");
        const events = parseEventsJsonl(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(events));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // API: Return the mission workspace as a file tree.
    if (pathname === "/api/workspace" || pathname.startsWith("/api/workspace")) {
      try {
        const missionId = await resolveMissionId(cwd, url.searchParams.get("missionId") ?? undefined);
        if (!missionId) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ tree: null, missionId: null }));
          return;
        }
        const scope = createMissionScope(cwd, missionId);
        const missionDir = getMissionDir(scope);
        const tree = await buildFileTree(missionDir, missionDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tree, missionId }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Return a single file's content by relative path within the mission dir.
    if (pathname === "/api/file" || pathname.startsWith("/api/file")) {
      try {
        const missionId = await resolveMissionId(cwd, url.searchParams.get("missionId") ?? undefined);
        if (!missionId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No mission found" }));
          return;
        }
        const scope = createMissionScope(cwd, missionId);
        const missionDir = getMissionDir(scope);
        const relPath = url.searchParams.get("path") ?? "";
        if (!relPath || relPath.includes("..")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid path" }));
          return;
        }
        const fullPath = join(missionDir, relPath);
        try {
          const content = await readFile(fullPath, "utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ path: relPath, content }));
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found", path: relPath }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Return git diff and status for the canonical workspace.
    if (pathname === "/api/diff" || pathname.startsWith("/api/diff")) {
      try {
        const missionId = await resolveMissionId(cwd, url.searchParams.get("missionId") ?? undefined);
        const scope = createMissionScope(cwd, missionId);
        const workspace = await resolveCanonicalWorkspace(scope);
        if (!workspace) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ diff: "", status: "Not a git repository" }));
          return;
        }

        let diff = "";
        let status = "";

        try {
          const diffResult = await execFile("git", ["diff"], { cwd: workspace });
          diff = diffResult.stdout;
        } catch {
          diff = "";
        }

        try {
          const statusResult = await execFile("git", ["status", "--short"], { cwd: workspace });
          status = statusResult.stdout;
        } catch {
          status = "Error reading git status";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ diff, status }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ diff: "", status: "Error resolving workspace" }));
      }
      return;
    }

    // API: Return mission state, requirements, and features.
    if (pathname === "/api/mission" || pathname.startsWith("/api/mission")) {
      try {
        const missionId = await resolveMissionId(cwd, url.searchParams.get("missionId") ?? undefined);
        const scope = createMissionScope(cwd, missionId);
        const statePath = join(getMissionDir(scope), "state.json");
        const reqPath = join(getMissionDir(scope), "requirements.json");
        const featPath = join(getMissionDir(scope), "features.json");
        const contractPath = join(getMissionDir(scope), "validation-contract.md");

        let state = {};
        let requirements = {};
        let features = {};
        let validationContractMd = "";

        try {
          state = JSON.parse(await readFile(statePath, "utf-8"));
        } catch {}
        try {
          requirements = JSON.parse(await readFile(reqPath, "utf-8"));
        } catch {}
        try {
          features = JSON.parse(await readFile(featPath, "utf-8"));
        } catch {}
        try {
          validationContractMd = await readFile(contractPath, "utf-8");
        } catch {}

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state, requirements, features, validationContractMd }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Approve plan
    if (pathname === "/api/approve" && req.method === "POST") {
      try {
        let rawBody = "";
        for await (const chunk of req) {
          rawBody += chunk;
        }
        const body = rawBody ? JSON.parse(rawBody) : {};
        const missionId = await resolveMissionId(cwd, body.missionId ?? undefined);
        const scope = createMissionScope(cwd, missionId);

        if (body.files) {
          for (const [filename, content] of Object.entries(body.files)) {
            const isValidArtifact =
              (ARTIFACT_NAMES as readonly string[]).includes(filename) ||
              (filename.startsWith("features/") && filename.endsWith(".feature") && !filename.includes(".."));

            if (isValidArtifact) {
              const filePath = join(getMissionDir(scope), filename);
              await mkdir(dirname(filePath), { recursive: true });
              await writeFile(filePath, content as string, "utf-8");
            }
          }
        }

        // Write approval decision to approval.json for durability
        const approvalPath = join(getMissionDir(scope), "approval.json");
        await writeFile(
          approvalPath,
          JSON.stringify(
            {
              status: "approved",
              missionId,
              feedback: body.feedback,
              files: body.files ? Object.keys(body.files) : undefined,
              decidedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          "utf-8"
        );

        // Resume mission through the control plane if available
        if (controlPlane) {
          const nextJob = await controlPlane.submitApproval(missionId, {
            approved: true,
            feedback: body.feedback,
            files: body.files,
          });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, missionId, jobId: nextJob.jobId, status: nextJob.status }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, missionId }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Reject plan / Request changes
    if (pathname === "/api/reject" && req.method === "POST") {
      try {
        let rawBody = "";
        for await (const chunk of req) {
          rawBody += chunk;
        }
        const body = rawBody ? JSON.parse(rawBody) : {};
        const missionId = await resolveMissionId(cwd, body.missionId ?? undefined);
        const scope = createMissionScope(cwd, missionId);

        if (body.files) {
          for (const [filename, content] of Object.entries(body.files)) {
            const isValidArtifact =
              (ARTIFACT_NAMES as readonly string[]).includes(filename) ||
              (filename.startsWith("features/") && filename.endsWith(".feature") && !filename.includes(".."));

            if (isValidArtifact) {
              const filePath = join(getMissionDir(scope), filename);
              await mkdir(dirname(filePath), { recursive: true });
              await writeFile(filePath, content as string, "utf-8");
            }
          }
        }

        // Write approval decision to approval.json for durability
        const approvalPath = join(getMissionDir(scope), "approval.json");
        await writeFile(
          approvalPath,
          JSON.stringify(
            {
              status: "rejected",
              missionId,
              feedback: body.feedback,
              files: body.files ? Object.keys(body.files) : undefined,
              decidedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          "utf-8"
        );

        // Resume mission through the control plane if available
        if (controlPlane) {
          const nextJob = await controlPlane.submitApproval(missionId, {
            approved: false,
            feedback: body.feedback,
            files: body.files,
          });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, missionId, jobId: nextJob.jobId, status: nextJob.status }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, missionId }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Serve the dashboard HTML for all other routes.
    try {
      const html = await readFile(DASHBOARD_HTML_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Dashboard HTML not found. Expected: " + DASHBOARD_HTML_PATH);
    }
  });
}

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
  const { cwd, port = 8765, host = "127.0.0.1", controlPlane } = options;
  const server = createDashboardServer(cwd, controlPlane);

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
  const { cwd, port = 8765, host = "127.0.0.1", maxPortAttempts = 20, controlPlane } = options;
  const candidatePorts = port === 0
    ? [0]
    : Array.from({ length: maxPortAttempts }, (_, index) => port + index);

  let lastError: unknown;
  for (const candidatePort of candidatePorts) {
    const server = createDashboardServer(cwd, controlPlane);
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
