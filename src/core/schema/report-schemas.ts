/**
 * TypeBox schemas for structured report submission.
 * Centralizes report format knowledge so it does not leak across workers,
 * validators, tools, and tests.
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const WorkerHandoffSchema = Type.Object({
  featureId: Type.String(),
  completedAt: Type.String(),
  completed: Type.Array(Type.String()),
  leftUndone: Type.Array(Type.String()),
  commandsRun: Type.Array(
    Type.Object({
      command: Type.String(),
      exitCode: Type.Number(),
      output: Type.Optional(Type.String()),
    }),
  ),
  issuesDiscovered: Type.Array(
    Type.Object({
      description: Type.String(),
      severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    }),
  ),
  proceduresAbided: Type.Boolean(),
  gitCommit: Type.Optional(Type.String()),
  summary: Type.String(),
});

export type WorkerHandoffSchemaType = Static<typeof WorkerHandoffSchema>;

export const ScrutinyReportSchema = Type.Object({
  validatorType: Type.Literal("scrutiny"),
  milestoneId: Type.String(),
  createdAt: Type.String(),
  automatedChecks: Type.Object({
    tests: Type.Object({
      passed: Type.Boolean(),
      command: Type.String(),
      exitCode: Type.Number(),
      output: Type.String(),
    }),
    typecheck: Type.Object({
      passed: Type.Boolean(),
      command: Type.String(),
      exitCode: Type.Number(),
      output: Type.String(),
    }),
    lint: Type.Object({
      passed: Type.Boolean(),
      command: Type.String(),
      exitCode: Type.Number(),
      output: Type.String(),
    }),
  }),
  codeReviews: Type.Array(
    Type.Object({
      featureId: Type.String(),
      filesReviewed: Type.Array(Type.String()),
      findings: Type.String(),
      severity: Type.Union([
        Type.Literal("blocking"),
        Type.Literal("non-blocking"),
        Type.Literal("suggestion"),
      ]),
    }),
  ),
  issues: Type.Array(
    Type.Object({
      id: Type.String(),
      severity: Type.Union([
        Type.Literal("blocking"),
        Type.Literal("non-blocking"),
        Type.Literal("suggestion"),
      ]),
      category: Type.Union([
        Type.Literal("test"),
        Type.Literal("typecheck"),
        Type.Literal("lint"),
        Type.Literal("code-review"),
        Type.Literal("behavioral"),
        Type.Literal("ux"),
        Type.Literal("performance"),
      ]),
      description: Type.String(),
      relatedFeatureId: Type.Optional(Type.String()),
      relatedScenario: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }),
  ),
  summary: Type.String(),
});

export type ScrutinyReportSchemaType = Static<typeof ScrutinyReportSchema>;

export const UserTestingShardReportSchema = Type.Object({
  validatorType: Type.Literal("user-testing-shard"),
  milestoneId: Type.String(),
  shardId: Type.String(),
  createdAt: Type.String(),
  featureFiles: Type.Array(Type.String()),
  appStartCommand: Type.String(),
  baseURL: Type.String(),
  scenarioResults: Type.Array(
    Type.Object({
      featureFile: Type.String(),
      scenarioName: Type.String(),
      status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
      steps: Type.Array(
        Type.Object({
          keyword: Type.Union([
            Type.Literal("Given"),
            Type.Literal("When"),
            Type.Literal("Then"),
            Type.Literal("And"),
            Type.Literal("But"),
          ]),
          text: Type.String(),
          status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
          screenshotPath: Type.Optional(Type.String()),
          consoleErrors: Type.Optional(Type.Array(Type.String())),
          error: Type.Optional(Type.String()),
        }),
      ),
      screenshotPaths: Type.Array(Type.String()),
      consoleErrors: Type.Array(Type.String()),
      durationMs: Type.Number(),
    }),
  ),
  issues: Type.Array(
    Type.Object({
      id: Type.String(),
      severity: Type.Union([
        Type.Literal("blocking"),
        Type.Literal("non-blocking"),
        Type.Literal("suggestion"),
      ]),
      category: Type.Union([
        Type.Literal("test"),
        Type.Literal("typecheck"),
        Type.Literal("lint"),
        Type.Literal("code-review"),
        Type.Literal("behavioral"),
        Type.Literal("ux"),
        Type.Literal("performance"),
      ]),
      description: Type.String(),
      relatedFeatureId: Type.Optional(Type.String()),
      relatedScenario: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }),
  ),
  summary: Type.String(),
  durationMs: Type.Number(),
  isolationNotes: Type.Optional(Type.String()),
});

export type UserTestingShardReportSchemaType = Static<typeof UserTestingShardReportSchema>;

/**
 * Validate a value against a TypeBox schema.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
import { Value } from "@sinclair/typebox/value";

export function validateSchema<T>(schema: import("@sinclair/typebox").TSchema, value: unknown): { valid: true } | { valid: false; errors: string[] } {
  if (Value.Check(schema, value)) {
    return { valid: true };
  }
  const errors = Value.Errors(schema, value);
  const messages: string[] = [];
  for (const error of errors) {
    messages.push(`${error.path}: ${error.message}`);
  }
  return { valid: false, errors: messages };
}
