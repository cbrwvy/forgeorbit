/**
 * Confidence is a checklist, not a probability. A missing price or a missing
 * effort lowers it. Nothing here turns a gap into a number.
 */

import type {
  ConfidenceCheck,
  ConfidenceLevel,
  ConfidenceReport,
  EstimationRequest,
  MissingDatum,
  ScenarioForecast,
  WorkItemInput,
} from "./types.ts";

function check(id: string, applicable: boolean, passed: boolean, message: string): ConfidenceCheck {
  return { id, applicable, passed: applicable ? passed : true, message };
}

function historyCovers(request: EstimationRequest, items: readonly WorkItemInput[]): boolean {
  for (const sample of request.history ?? []) {
    if (sample.sampleCount < 1) continue;
    const hit = items.some((item) => {
      if (sample.workType && sample.workType === item.workType) return true;
      if (sample.complexity && sample.complexity === item.complexity) return true;
      if (sample.stageKind && item.stages.some((stage) => stage.kind === sample.stageKind)) return true;
      return false;
    });
    if (hit) return true;
  }
  return false;
}

export function assessConfidence(
  request: EstimationRequest,
  items: readonly WorkItemInput[],
  expected: ScenarioForecast | null,
  cycles: readonly string[][],
  external: readonly string[],
  structuralOk: boolean,
): { confidence: ConfidenceReport; missing: MissingDatum[] } {
  const hasWork = items.length > 0;
  const effortGap = items.some(
    (item) =>
      item.stages.some((stage) => !stage.effort) ||
      (item.requiresReview === true && !item.stages.some((stage) => stage.kind === "review")) ||
      (item.requiresValidation === true && !item.stages.some((stage) => stage.kind === "validation")),
  );
  const cash = expected?.additionalCash ?? null;
  const calendar = expected?.calendar ?? null;
  const agent = expected?.agent ?? null;
  const usesAccount = items.some((item) => item.stages.some((stage) => stage.accountId));
  const coverageApplies = hasWork && (request.subscriptions.length > 0 || usesAccount);

  const checks: ConfidenceCheck[] = [
    check("inputs-valid", true, structuralOk, structuralOk ? "The request passed structural validation." : "The request is structurally invalid."),
    check(
      "efforts-present",
      true,
      !effortGap,
      effortGap
        ? "One or more stages have no effort range, or a required review or validation stage is missing."
        : "Every stage has an effort range, and required phases are present.",
    ),
    check("acyclic", true, cycles.length === 0, cycles.length === 0 ? "Dependencies have no cycle." : "Dependencies contain a cycle."),
    check(
      "no-external-deps",
      true,
      external.length === 0,
      external.length === 0 ? "Every dependency is inside the scope." : "A dependency points outside the scope.",
    ),
    check(
      "parallelism-declared",
      true,
      request.parallelism.maxConcurrentItems !== null,
      request.parallelism.maxConcurrentItems === null
        ? "Item concurrency was not provided."
        : "Item concurrency was provided.",
    ),
    check(
      "machine-known",
      true,
      request.machine.dutyCycle !== null && request.machine.plannedPauseMs !== null,
      request.machine.dutyCycle === null || request.machine.plannedPauseMs === null
        ? "Local machine availability was not provided."
        : "Local machine availability was provided.",
    ),
    check(
      "agent-time-known",
      true,
      agent?.status === "known",
      agent?.status === "known" ? "Agent execution time is known for the expected scenario." : "Agent execution time is not known for the expected scenario.",
    ),
    check(
      "calendar-proven",
      true,
      calendar?.status === "known" && calendar.exact === true,
      calendar?.status === "known" && calendar.exact
        ? "Calendar completion time is determined for the expected scenario."
        : "Calendar completion time is not a proven figure for the expected scenario.",
    ),
    check(
      "cash-known",
      true,
      cash?.status === "known",
      cash?.status === "known"
        ? "Additional cash is known for the expected scenario."
        : "Additional cash is not known for the expected scenario.",
    ),
    check(
      "cash-basis",
      cash?.status === "known",
      cash?.basis === "capacity" || cash?.basis === "none" || cash?.basis === "priced",
      cash?.basis === "policy"
        ? "Additional cash is zero only because extra spend is turned off, not because remaining quota was shown to cover the work."
        : "Additional cash is either measured, priced, or there is no work.",
    ),
    check(
      "api-priced",
      request.apiRates !== null && hasWork,
      expected?.apiEquivalent.status === "known",
      expected?.apiEquivalent.status === "known"
        ? "API-equivalent cost is priced for every active stage."
        : "API-equivalent cost was requested and is not fully priced.",
    ),
    check(
      "history-matches",
      hasWork,
      historyCovers(request, items),
      historyCovers(request, items)
        ? "Observed history matches this scope."
        : request.history && request.history.length > 0
          ? "Observed history does not match this scope's work type, complexity, or stage."
          : "No observed history of similar tasks was provided.",
    ),
    check(
      "currencies-resolved",
      true,
      cash?.status !== "mixed-currency" &&
        expected?.subscriptionFees.status !== "mixed-currency" &&
        expected?.allocation.status !== "mixed-currency" &&
        expected?.apiEquivalent.status !== "mixed-currency",
      cash?.status === "mixed-currency" ||
        expected?.subscriptionFees.status === "mixed-currency" ||
        expected?.allocation.status === "mixed-currency" ||
        expected?.apiEquivalent.status === "mixed-currency"
        ? "A money figure uses a currency with no exchange rate into the report currency."
        : "Every money figure either shares the report currency or has an exchange rate.",
    ),
    check(
      "coverage-measured",
      coverageApplies,
      expected?.coverage.status === "sufficient",
      expected?.coverage.status === "sufficient"
        ? "Remaining quota was compared with declared consumption and covers it."
        : "Remaining subscription capacity is missing or is not in a unit that can be compared with this work.",
    ),
  ];

  const applicable = checks.filter((entry) => entry.applicable);
  const passed = applicable.filter((entry) => entry.passed).length;
  const failed = applicable.filter((entry) => !entry.passed);
  const inputCompleteness = applicable.length === 0 ? 0 : passed / applicable.length;

  let level: ConfidenceLevel;
  if (!structuralOk || !expected) level = "none";
  else if (agent?.status !== "known" || cash?.status !== "known") level = "low";
  else if (failed.length === 0) level = "high";
  else level = "medium";

  const summary =
    level === "none"
      ? "No confidence: the request is invalid, so no forecast was produced."
      : level === "high"
        ? "High confidence: effort, calendar, measured coverage, and observed history were all provided for the expected scenario. This is not a statistical confidence interval."
        : `${level === "low" ? "Low confidence" : "Medium confidence"}: ${failed
            .slice(0, 3)
            .map((entry) => entry.message)
            .join(" ")}`;

  const missing: MissingDatum[] = [];
  for (const entry of failed) {
    missing.push({ code: entry.id, path: entry.id, message: entry.message });
  }
  for (const item of items) {
    for (const stage of item.stages) {
      if (!stage.effort) {
        missing.push({
          code: "missing-effort",
          path: `items.${item.id}.stages.${stage.id}`,
          message: `Stage ${item.id}/${stage.id} has no effort range.`,
        });
      }
    }
    if (item.requiresReview && !item.stages.some((stage) => stage.kind === "review")) {
      missing.push({
        code: "missing-review",
        path: `items.${item.id}`,
        message: `Item ${item.id} requires review and no review stage was provided. No review duration was invented.`,
      });
    }
    if (item.requiresValidation && !item.stages.some((stage) => stage.kind === "validation")) {
      missing.push({
        code: "missing-validation",
        path: `items.${item.id}`,
        message: `Item ${item.id} requires validation and no validation stage was provided. No validation duration was invented.`,
      });
    }
  }

  return {
    confidence: { level, inputCompleteness, checks, summary },
    missing,
  };
}
