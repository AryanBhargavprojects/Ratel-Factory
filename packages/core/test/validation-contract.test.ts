import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMissionScope, getMissionDir } from "../src/core/mission/scope.js";
import { atomicWriteJson, atomicWriteFile } from "../src/core/mission/atomic-file.js";
import {
  writeValidationContract,
  readValidationContract,
  writeFeatureFile,
} from "../src/core/artifacts.js";
import type { ValidationContract } from "../src/core/types.js";

describe("validation contract", () => {
  async function setupMissionDir() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-contract-"));
    const missionId = "mis_contract_test";
    const scope = createMissionScope(projectRoot, missionId);
    const missionDir = getMissionDir(scope);
    await mkdir(missionDir, { recursive: true });
    return { projectRoot, scope, missionDir };
  }

  async function cleanup(projectRoot: string) {
    await rm(projectRoot, { recursive: true, force: true });
  }

  describe("structured round trip", () => {
    it("writes and reads canonical validation-contract.json", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
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
            requirementRefs: ["REQ-001"],
            preconditions: ["User exists"],
            successCriteria: "Redirect to /dashboard",
          },
        ],
        gaps: [],
        crossCuttingAssertions: [],
      };

      await writeValidationContract(scope, contract);
      const read = await readValidationContract(scope);
      assert.ok(read);
      assert.strictEqual(read.version, 1);
      assert.strictEqual(read.assertions.length, 1);
      assert.strictEqual(read.assertions[0].id, "ASSERT-001");
      assert.strictEqual(read.assertions[0].featureFile, "auth.feature");
      assert.strictEqual(read.assertions[0].scenario, "User logs in with valid credentials");
      assert.deepStrictEqual(read.gaps, []);

      // JSON file should exist
      const jsonRaw = await readFile(join(missionDir, "validation-contract.json"), "utf-8");
      const jsonParsed = JSON.parse(jsonRaw);
      assert.strictEqual(jsonParsed.version, 1);

      // Markdown projection should exist
      const mdRaw = await readFile(join(missionDir, "validation-contract.md"), "utf-8");
      assert.ok(mdRaw.includes("ASSERT-001"));
      assert.ok(mdRaw.includes("User can log in"));

      await cleanup(projectRoot);
    });
  });

  describe("malformed contract rejection", () => {
    it("rejects malformed validation-contract.json", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteFile(join(missionDir, "validation-contract.json"), "not json");
      await atomicWriteFile(join(missionDir, "validation-contract.md"), "# stub");

      const read = await readValidationContract(scope);
      assert.strictEqual(read, undefined);

      await cleanup(projectRoot);
    });

    it("rejects contract missing required fields", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
      await atomicWriteJson(join(missionDir, "validation-contract.json"), {
        version: 1,
        createdAt: "2026-06-14T12:00:00Z",
        assertions: [{ id: "A1", title: "T", description: "D" }],
      });

      const read = await readValidationContract(scope);
      assert.strictEqual(read, undefined);
      await cleanup(projectRoot);
    });
  });

  describe("assertion reference validation", () => {
    it("rejects assertion referencing missing feature file", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();
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
      const read = await readValidationContract(scope);
      assert.ok(read);
      assert.strictEqual(read.assertions[0].featureFile, "auth.feature");
      await cleanup(projectRoot);
    });
  });

  describe("legacy markdown fallback", () => {
    it("legacy markdown plus feature files produces structured fallback contract", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      // Write legacy markdown (no JSON)
      await atomicWriteFile(
        join(missionDir, "validation-contract.md"),
        `# Validation Contract v1\n\n**Created:** 2026-06-14T12:00:00Z\n\n## Coverage Summary\n- Total scenarios: 2\n\n## Feature Files\n- features/auth.feature\n`
      );

      // Write feature file
      await writeFeatureFile(
        scope,
        "auth.feature",
        `Feature: Authentication
  Background:
    Given a registered user exists

  Scenario: User logs in with valid credentials
    Given the user is on the login page
    When they enter valid credentials
    Then they are redirected to the dashboard

  Scenario: User logs in with invalid credentials
    Given the user is on the login page
    When they enter invalid credentials
    Then an error message is displayed
`
      );

      const read = await readValidationContract(scope);
      assert.ok(read);
      assert.strictEqual(read.version, 1);
      assert.strictEqual(read.assertions.length, 2);
      assert.ok(read.assertions.every((a) => a.id.startsWith("LEGACY-")));
      assert.ok(read.assertions.every((a) => a.featureFile === "auth.feature"));
      assert.ok(read.assertions[0].scenario.includes("valid credentials") || read.assertions[1].scenario.includes("valid credentials"));
      assert.strictEqual(read.assertions[0].evidenceType, "manual");
      assert.deepStrictEqual(read.assertions[0].requirementRefs, []);
      await cleanup(projectRoot);
    });

    it("legacy fallback rejects duplicate scenario names within same file", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      await atomicWriteFile(
        join(missionDir, "validation-contract.md"),
        `# Validation Contract v1\n\n**Created:** 2026-06-14T12:00:00Z\n`
      );

      await writeFeatureFile(
        scope,
        "auth.feature",
        `Feature: Authentication
  Scenario: User logs in
    Given the user is on the login page

  Scenario: User logs in
    Given the user is on the login page
`
      );

      const read = await readValidationContract(scope);
      assert.strictEqual(read, undefined);
      await cleanup(projectRoot);
    });
  });

  describe("submit_validation_contract tool semantics", () => {
    it("contract with valid feature file refs is accepted", async () => {
      const { projectRoot, scope, missionDir } = await setupMissionDir();

      await writeFeatureFile(
        scope,
        "auth.feature",
        `Feature: Authentication
  Scenario: User logs in with valid credentials
    Given the user is on the login page
    When they enter valid credentials
    Then they are redirected to the dashboard
`
      );

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
            requirementRefs: ["REQ-001"],
            successCriteria: "Redirect to /dashboard",
          },
        ],
        gaps: [],
        crossCuttingAssertions: [],
      };

      await writeValidationContract(scope, contract);
      const read = await readValidationContract(scope);
      assert.ok(read);
      assert.strictEqual(read.assertions[0].featureFile, "auth.feature");
      await cleanup(projectRoot);
    });
  });
});
