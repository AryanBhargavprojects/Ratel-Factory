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
import { readFile, access } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { resolveCanonicalWorkspace } from "../core/mission/workspace-resolution.js";

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));

// dashboard.html is co-located with this server file so it deploys together.
const DASHBOARD_HTML_PATH = join(__dirname, "dashboard.html");

// Shared mutable state so the TUI footer and Pi commands can discover the
// actual URL even when the port falls back dynamically.
let currentDashboardUrl: string | undefined;

function getDashboardUrlFilePath(cwd: string): string {
  return join(cwd, ".missions", "current", "observatory-url.txt");
}

function persistDashboardUrl(cwd: string, url: string): void {
  try {
    const dir = join(cwd, ".missions", "current");
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

function createDashboardServer(cwd: string): Server {
  const eventsPath = join(cwd, ".missions", "current", "events.jsonl");

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    // CORS headers — allow the dashboard to be opened from anywhere.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: Return all parseable events as a JSON array.
    if (url === "/api/events" || url === "/api/events/") {
      try {
        await access(eventsPath);
        const raw = await readFile(eventsPath, "utf-8");
        const events = parseEventsJsonl(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(events));
      } catch {
        // File doesn't exist or cannot be read — return empty array.
        // The dashboard will simply render an empty timeline.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // API: Return git diff and status for the canonical workspace.
    if (url === "/api/diff" || url.startsWith("/api/diff")) {
      try {
        const workspace = await resolveCanonicalWorkspace(cwd);
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
    if (url === "/api/mission" || url === "/api/mission/") {
      try {
        const statePath = join(cwd, ".missions", "current", "state.json");
        const reqPath = join(cwd, ".missions", "current", "requirements.json");
        const featPath = join(cwd, ".missions", "current", "features.json");

        let state = {};
        let requirements = {};
        let features = {};

        try {
          state = JSON.parse(await readFile(statePath, "utf-8"));
        } catch {}
        try {
          requirements = JSON.parse(await readFile(reqPath, "utf-8"));
        } catch {}
        try {
          features = JSON.parse(await readFile(featPath, "utf-8"));
        } catch {}

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state, requirements, features }));
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
  const { cwd, port = 8765, host = "127.0.0.1" } = options;
  const server = createDashboardServer(cwd);

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
  const { cwd, port = 8765, host = "127.0.0.1", maxPortAttempts = 20 } = options;
  const candidatePorts = port === 0
    ? [0]
    : Array.from({ length: maxPortAttempts }, (_, index) => port + index);

  let lastError: unknown;
  for (const candidatePort of candidatePorts) {
    const server = createDashboardServer(cwd);
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
