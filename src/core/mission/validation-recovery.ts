import type { Feature, ScrutinyReport, UserTestingReport, ValidationIssue } from "../types.js";

export type ValidationRecoveryKind = "no_blocking_issues" | "fix_features_required";

export interface SuggestedFixFeature extends Feature {
  sourceIssueId: string;
  sourceIssueSeverity: string;
  sourceIssueEvidence?: string;
}

export interface ValidationRecoveryPlan {
  kind: ValidationRecoveryKind;
  shouldHalt: false;
  milestoneId: string;
  blockingIssueIds: string[];
  suggestedFixFeatures: SuggestedFixFeature[];
  orchestratorInstruction: string;
}

function issueSeverity(issue: { severity?: unknown }): string {
  return typeof issue.severity === "string" ? issue.severity : "";
}

function issueId(issue: ValidationIssue, index: number): string {
  return typeof issue.id === "string" && issue.id.trim().length > 0
    ? issue.id
    : `ISSUE-${index + 1}`;
}

function issueDescription(issue: ValidationIssue): string {
  return typeof issue.description === "string" && issue.description.trim().length > 0
    ? issue.description
    : "Validation issue requires correction.";
}

function fixFeatureId(milestoneId: string, id: string): string {
  return `${milestoneId}-FIX-${id}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function buildFixFeature(milestoneId: string, issue: ValidationIssue, index: number): SuggestedFixFeature {
  const id = issueId(issue, index);
  const description = issueDescription(issue);
  return {
    id: fixFeatureId(milestoneId, id),
    title: `Fix ${id}: ${description.slice(0, 80)}`,
    description: [
      `Resolve validation issue ${id}.`,
      description,
      issue.evidence ? `Evidence: ${issue.evidence}` : "",
      issue.relatedFeatureId ? `Related feature: ${issue.relatedFeatureId}` : "",
      "After implementation, rerun scrutiny validation for the same milestone.",
    ].filter(Boolean).join("\n"),
    assertions: issue.relatedScenario ? [issue.relatedScenario] : [],
    milestoneId,
    status: "pending",
    sourceIssueId: id,
    sourceIssueSeverity: issueSeverity(issue),
    sourceIssueEvidence: issue.evidence,
  };
}

/**
 * Convert parsed validator findings into recovery guidance for the orchestrator.
 * A parsed report with blocking issues is not a tooling failure; it is normal
 * validation feedback and should become same-milestone fix features.
 */
export function buildValidationRecoveryPlan(
  report: ScrutinyReport | UserTestingReport,
  milestoneId: string = report.milestoneId,
): ValidationRecoveryPlan {
  const blockingIssues = report.issues.filter((issue) => issueSeverity(issue) === "blocking");

  if (blockingIssues.length === 0) {
    return {
      kind: "no_blocking_issues",
      shouldHalt: false,
      milestoneId,
      blockingIssueIds: [],
      suggestedFixFeatures: [],
      orchestratorInstruction:
        "No blocking validation issues were found. Continue to the next validator or milestone; do not call halt_mission for this report.",
    };
  }

  const suggestedFixFeatures = blockingIssues.map((issue, index) => buildFixFeature(milestoneId, issue, index));
  const blockingIssueIds = blockingIssues.map(issueId);

  return {
    kind: "fix_features_required",
    shouldHalt: false,
    milestoneId,
    blockingIssueIds,
    suggestedFixFeatures,
    orchestratorInstruction:
      `Do not call halt_mission for parseStatus=ok validation findings. ` +
      `Create ${suggestedFixFeatures.length} same milestone fix feature(s) for blocking issue(s): ${blockingIssueIds.join(", ")}. ` +
      `Run workers serially for those fix features, then rerun validation for milestone ${milestoneId}. ` +
      `Only halt if recovery is ambiguous, blocked by missing user input, or not converging after the configured retry limit.`,
  };
}
