/**
 * Tests for the RatelServiceClient HTTP methods.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("RatelServiceClient — health", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("GETs /health (unversioned)", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: string[] = [];
    globalThis.fetch = async (input: any) => {
      calls.push(String(input));
      return { ok: true, json: async () => ({ status: "ok" }) } as any;
    };
    const result = await client.health();
    assert.equal(result.status, "ok");
    assert.equal(calls[0], "http://127.0.0.1:8765/health");
  });
});

describe("RatelServiceClient — startMission", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("POSTs /api/v1/missions with { goal }", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = async (input: any, init: any) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, json: async () => ({ missionId: "mis_1", jobId: "job_1", status: "queued" }) } as any;
    };
    const result = await client.startMission("build a feature");
    assert.deepEqual(result, { missionId: "mis_1", jobId: "job_1", status: "queued" });
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.includes("/api/v1/missions"));
    assert.deepEqual(calls[0].body, { goal: "build a feature" });
  });
});

describe("RatelServiceClient — getMissionEvents", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("constructs URL with after=0 by default and computes nextAfter", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: string[] = [];
    globalThis.fetch = async (input: any) => {
      calls.push(String(input));
      return { ok: true, json: async () => ({ missionId: "mis_1", events: [{ event_type: "x" }], after: 0 }) } as any;
    };
    const result = await client.getMissionEvents("mis_1");
    assert.equal(result.nextAfter, 1);
    assert.ok(calls[0].includes("/api/v1/missions/mis_1/events?after=0"));
  });
});

describe("RatelServiceClient — sendMessage / answerQuestion", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sendMessage posts to /messages with optional questionId", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input: any, init: any) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, json: async () => ({ missionId: "mis_1", jobId: "j", status: "queued" }) } as any;
    };
    await client.sendMessage("mis_1", "hello", "q_1");
    assert.ok(calls[0].url.includes("/api/v1/missions/mis_1/messages"));
    assert.deepEqual(calls[0].body, { message: "hello", questionId: "q_1" });
  });

  it("answerQuestion posts to /questions/:qid/answer and URL-encodes ids", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input: any, init: any) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, json: async () => ({ missionId: "mis/s", jobId: "j", status: "queued" }) } as any;
    };
    await client.answerQuestion("mis/s", "q/1", "yes");
    assert.ok(calls[0].url.includes("/missions/mis%2Fs/questions/q%2F1/answer"));
    assert.deepEqual(calls[0].body, { answer: "yes" });
  });
});

describe("RatelServiceClient — approveMission / pingAgents / observatory", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("approveMission defaults approved:true and forwards options", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const bodies: unknown[] = [];
    globalThis.fetch = async (_input: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ missionId: "m", jobId: "j", status: "queued" }) } as any;
    };
    await client.approveMission("m", { approved: false, feedback: "no" });
    assert.equal((bodies[0] as any).approved, false);
    assert.equal((bodies[0] as any).feedback, "no");
  });

  it("pingAgents posts to /ping/agents", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: string[] = [];
    globalThis.fetch = async (input: any) => {
      calls.push(String(input));
      return { ok: true, json: async () => ({ ok: true, totalAgents: 1, okCount: 1, failedCount: 0, totalTimeMs: 5, agents: [] }) } as any;
    };
    const result = await client.pingAgents();
    assert.ok(calls[0].includes("/api/v1/ping/agents"));
    assert.equal(result.ok, true);
  });

  it("getObservatoryUrl GETs /observatory/status", async () => {
    const { RatelServiceClient } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    const calls: string[] = [];
    globalThis.fetch = async (input: any) => {
      calls.push(String(input));
      return { ok: true, json: async () => ({ enabled: true, url: "http://localhost:8765" }) } as any;
    };
    const result = await client.getObservatoryUrl();
    assert.ok(calls[0].includes("/api/v1/observatory/status"));
    assert.equal(result.url, "http://localhost:8765");
  });
});

describe("RatelServiceClient — error normalization", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("wraps HTTP failures in RatelServiceError", async () => {
    const { RatelServiceClient, RatelServiceError } = await import("../src/service.js");
    const client = new RatelServiceClient("http://127.0.0.1:8765");
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" }) as any;
    await assert.rejects(() => client.startMission("g"), RatelServiceError);
  });
});
