import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { atomicWriteFile } from "../src/core/mission/atomic-file.js";
import {
  appendDecision,
  readDecisionLog,
  loadMissionState,
  ensureMissionInitialized,
  summarizeMissionState,
  writeValidationContract,
} from "../src/core/artifacts.js";
import type { Decision, ValidationContract } from "../src/core/types.js";

describe("decision log", () => {
  async function setupMissionDir() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-decision-"));
    const missionId = "mis_decision_test";
    const scope = createMissionScope(projectRoot, missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });
    return { projectRoot, scope, missionDir };
  }

  async function cleanup(projectRoot: string) {
    await rm(projectRoot, { recursive: true, force: true });
  }

  describe("JSONL canonical", () => {
    it("appendDecision writes to decisions.jsonl and decision-log.md", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      const decision: Decision = {
        id: "DEC-001",
        timestamp: "2026-06-14T12:00:00Z",
        context: "Choosing auth method",
        decision: "Use OAuth2",
        rationale: "Better security",
      };

      await appendDecision(scope, decision);

      const jsonlRaw = await readFile(join(missionDir, "decisions.jsonl"), "utf-8");
      const lines = jsonlRaw.trim().split("\n");
      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.strictEqual(parsed.id, "DEC-001");
      assert.strictEqual(parsed.decision, "Use OAuth2");

      const mdRaw = await readFile(join(missionDir, "decision-log.md"), "utf-8");
      assert.ok(mdRaw.includes("DEC-001"));
      assert.ok(mdRaw.includes("Use OAuth2"));

      await cleanup(projectRoot);
    });

    it("decisions append to JSONL in order", async () => {
      const { projectRoot, scope } = await setupMissionDir();

      const d1: Decision = {
        id: "DEC-001",
        timestamp: "2026-06-14T12:00:00Z",
        context: "First",
        decision: "A",
        rationale: "Because A",
      };
      const d2: Decision = {
        id: "DEC-002",
        timestamp: "2026-06-14T12:01:00Z",
        context: "Second",
        decision: "B",
        rationale: "Because B",
      };

      await appendDecision(scope, d1);
      await appendDecision(scope, d2);

      const decisions = await readDecisionLog(scope);
      assert.ok(decisions);
      assert.strictEqual(decisions.length, 2);
      assert.strictEqual(decisions[0].id, "DEC-001");
      assert.strictEqual(decisions[1].id, "DEC-002");

      await cleanup(projectRoot);
    });

    it("malformed final JSONL line does not erase prior valid decisions", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      const d1: Decision = {
        id: "DEC-001",
        timestamp: "2026-06-14T12:00:00Z",
        context: "First",
        decision: "A",
        rationale: "Because A",
      };

      await appendDecision(scope, d1);

      // Append a truncated final line
      await atomicWriteFile(join(missionDir, "decisions.jsonl"), "\n{\"id\": \"DEC-002\", \"timestamp\": \"2026-06-14", "append");

      const decisions = await readDecisionLog(scope);
      assert.ok(decisions);
      assert.strictEqual(decisions.length, 1);
      assert.strictEqual(decisions[0].id, "DEC-001");

      await cleanup(projectRoot);
    });
  });

  describe("legacy markdown parsing", () => {
    it("parses exact legacy markdown format", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      const legacyMarkdown = `# Decision Log

## DEC-001
**Timestamp:** 2026-06-14T12:00:00Z
**Context:** Choosing auth method
**Decision:** Use OAuth2
**Rationale:** Better security than basic auth

## DEC-002
**Timestamp:** 2026-06-14T12:01:00Z
**Context:** Choosing database
**Decision:** Use PostgreSQL
**Rationale:** ACID compliance
`;

      await atomicWriteFile(join(missionDir, "decision-log.md"), legacyMarkdown);

      const decisions = await readDecisionLog(scope);
      assert.ok(decisions);
      assert.strictEqual(decisions.length, 2);
      assert.strictEqual(decisions[0].id, "DEC-001");
      assert.strictEqual(decisions[0].decision, "Use OAuth2");
      assert.strictEqual(decisions[1].id, "DEC-002");
      assert.strictEqual(decisions[1].decision, "Use PostgreSQL");

      await cleanup(projectRoot);
    });

    it("handles multiline values in legacy markdown", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      const legacyMarkdown = `# Decision Log

## DEC-001
**Timestamp:** 2026-06-14T12:00:00Z
**Context:** Complex decision
**Decision:** Use a multi-line
approach here
**Rationale:** Because it makes
sense to do so

## DEC-002
**Timestamp:** 2026-06-14T12:01:00Z
**Context:** Next
**Decision:** B
**Rationale:** Why not
`;

      await atomicWriteFile(join(missionDir, "decision-log.md"), legacyMarkdown);
      // No JSONL exists

      const decisions = await readDecisionLog(scope);
      assert.ok(decisions);
      assert.strictEqual(decisions.length, 2);
      assert.strictEqual(decisions[0].id, "DEC-001");
      assert.ok(decisions[0].decision.includes("multi-line"));
      assert.ok(decisions[0].decision.includes("approach here"));
      assert.ok(decisions[0].rationale.includes("sense to do so"));
      assert.strictEqual(decisions[1].id, "DEC-002");

      await cleanup(projectRoot);
    });
  });

  describe("loadMissionState integration", () => {
    it("loadMissionState returns both contract and decisions", async () => {
      const { projectRoot, scope } = await setupMissionDir();
      await ensureMissionInitialized(scope);

      const contract: ValidationContract = {
        version: 1,
        createdAt: "2026-06-14T12:00:00Z",
        assertions: [
          {
            id: "ASSERT-001",
            title: "User can log in",
            description: "Valid credentials redirect to dashboard",
            featureFile: "auth.feature",
            scenario: "User logs in with valid credentials",
            evidenceType: "test",
            requirementRefs: [],
            successCriteria: "Redirect to /dashboard",
          },
        ],
        gaps: [],
        crossCuttingAssertions: [],
      };
      await writeValidationContract(scope, contract);

      const decision: Decision = {
        id: "DEC-001",
        timestamp: "2026-06-14T12:00:00Z",
        context: "Test",
        decision: "D",
        rationale: "R",
      };
      await appendDecision(scope, decision);

      const state = await loadMissionState(scope);
      assert.ok(state.validationContract);
      assert.strictEqual(state.validationContract.version, 1);
      assert.strictEqual(state.decisions.length, 1);
      assert.strictEqual(state.decisions[0].id, "DEC-001");

      await cleanup(projectRoot);
    });
  });

  describe("summarizeMissionState", () => {
    it("includes contract version, assertion count, gaps, and recent decisions", async () => {
      const { projectRoot, scope } = await setupMissionDir();
      await ensureMissionInitialized(scope);

      const contract: ValidationContract = {
        version: 2,
        createdAt: "2026-06-14T12:00:00Z",
        assertions: Array.from({ length: 10 }, (_, i) => ({
          id: `ASSERT-${i}`,
          title: `Assertion ${i}`,
          description: "Desc",
          featureFile: "auth.feature",
          scenario: `Scenario ${i}`,
          evidenceType: "test" as const,
          requirementRefs: [],
          successCriteria: "Pass",
        })),
        gaps: ["Missing edge case for admin login"],
        crossCuttingAssertions: [],
      };
      await writeValidationContract(scope, contract);

      for (let i = 0; i < 7; i++) {
        await appendDecision(scope, {
          id: `DEC-${String(i).padStart(3, "0")}`,
          timestamp: `2026-06-14T12:${String(i).padStart(2, "0")}:00Z`,
          context: "Ctx",
          decision: `Decision ${i}`,
          rationale: "R",
        });
      }

      const state = await loadMissionState(scope);
      const summary = summarizeMissionState(state);

      assert.ok(summary.includes("Validation Contract"));
      assert.ok(summary.includes("Version: 2"));
      assert.ok(summary.includes("10 assertions"));
      assert.ok(summary.includes("Missing edge case for admin login"));
      assert.ok(summary.includes("DEC-006"));
      assert.ok(summary.includes("DEC-002"));
      assert.ok(!summary.includes("DEC-000")); // Should cap at 5 most recent

      await cleanup(projectRoot);
    });
  });
});
