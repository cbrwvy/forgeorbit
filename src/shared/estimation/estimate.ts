/**
 * Public forecast entry. Reads the request, writes nothing, and never fills a
 * gap with a provider price or a default duration.
 */

import { assessConfidence } from "./confidence.ts";
import { forecastScenario } from "./forecast.ts";
import { findCycles } from "./schedule.ts";
import type {
  EstimationIssue,
  EstimationRequest,
  EstimationResult,
  ProvenanceEntry,
  ScenarioForecast,
  ScenarioId,
  WhatIfPatch,
  WorkItemInput,
} from "./types.ts";
import { SCENARIOS } from "./types.ts";
import { validateRequest } from "./validate.ts";
import { applyWhatIf } from "./what-if.ts";

export const BASE_ASSUMPTIONS = [
  "Stages inside one work item run one after another, in the order given.",
  "Optimistic, expected, and conservative figures are the matching fields of the supplied ranges. They are not a statistical confidence interval and they are not a percentage of the expected case.",
  "A complexity label never becomes a duration.",
  "Observed history never fills a missing effort range.",
  "Recurring subscription fees are reported in full for their billing period and are not divided across tasks.",
  "A percent-used or opaque quota is not converted into tokens, requests, credits, or hours.",
  "No provider price, quota, or exchange rate is built into this module.",
  "Additional cash is zero only when measured remaining quota covers the work, when there is no work, or when extra spend is explicitly turned off. Turning extra spend off is not proof that a subscription covers the work.",
  "List scheduling, when a concurrency cap binds, is a feasible plan. It is not an optimal assignment of every minute.",
  "This core does not read live usage, start a harness, or open a network connection.",
] as const;

const BASE_SIMPLIFICATIONS = [
  "The core does not search combinations of accounts and tasks.",
  "Pipeline graphs are not interpreted here. The caller flattens steps into work items and stages.",
] as const;

function refused(request: EstimationRequest, issues: EstimationIssue[]): EstimationResult {
  const assessed = assessConfidence(request, [], null, [], [], false);
  return {
    ok: false,
    issues,
    scope: request.scope,
    scenarios: null,
    confidence: assessed.confidence,
    assumptions: [...BASE_ASSUMPTIONS],
    missing: assessed.missing,
    warnings: [],
    provenance: [],
    simplifications: [...BASE_SIMPLIFICATIONS],
    cycles: [],
  };
}

function selectItems(request: EstimationRequest): { items: WorkItemInput[]; external: string[] } {
  let items = request.items;
  if (request.scope.itemIds) {
    const allow = new Set(request.scope.itemIds);
    items = items.filter((item) => allow.has(item.id));
  }
  if (request.scope.projectIds && request.scope.projectIds.length > 0) {
    const allow = new Set(request.scope.projectIds);
    items = items.filter((item) => allow.has(item.projectId));
  }
  if (request.scope.groupIds && request.scope.groupIds.length > 0) {
    const allow = new Set(request.scope.groupIds);
    items = items.filter((item) => item.groupId != null && allow.has(item.groupId));
  }
  const selected = new Set(items.map((item) => item.id));
  const external: string[] = [];
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      if (!selected.has(dep)) external.push(dep);
    }
  }
  return { items, external: [...new Set(external)] };
}

function dependencyMap(items: readonly WorkItemInput[]): Map<string, string[]> {
  const selected = new Set(items.map((item) => item.id));
  const deps = new Map<string, string[]>();
  for (const item of items) {
    deps.set(
      item.id,
      (item.dependsOn ?? []).filter((id) => selected.has(id)),
    );
  }
  return deps;
}

function provenanceFor(request: EstimationRequest, items: readonly WorkItemInput[]): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [];
  for (const item of items) {
    for (const stage of item.stages) {
      if (stage.effort) {
        entries.push({
          path: `items.${item.id}.stages.${stage.id}.effort`,
          origin: stage.effort.origin,
          detail: "Caller-supplied effort range.",
        });
      }
      if (stage.consumption) {
        entries.push({
          path: `items.${item.id}.stages.${stage.id}.consumption`,
          origin: stage.consumption.origin,
          detail: "Caller-supplied consumption for one execution of the stage.",
        });
      }
    }
    for (const blocker of item.blockers ?? []) {
      if (blocker.wait) {
        entries.push({
          path: `items.${item.id}.blockers.${blocker.id}`,
          origin: blocker.wait.origin,
          detail: "Caller-supplied blocker wait.",
        });
      }
    }
  }
  for (const sub of request.subscriptions) {
    if (sub.recurringFee || sub.purchasePrice) {
      entries.push({
        path: `subscriptions.${sub.id}.price`,
        origin: sub.priceOrigin,
        detail: "Caller-supplied subscription price. Not a per-request rate.",
      });
    }
    for (const quota of sub.quotas) {
      entries.push({
        path: `subscriptions.${sub.id}.quotas.${quota.id}`,
        origin: quota.origin,
        detail:
          quota.unit.kind === "percent-used" || quota.unit.kind === "opaque"
            ? "Quota is not a convertible balance."
            : "Caller-supplied remaining quota.",
      });
    }
  }
  for (const rate of request.apiRates ?? []) {
    entries.push({ path: `apiRates.${rate.id}`, origin: rate.origin, detail: "Caller-supplied API-equivalent rate." });
  }
  for (const rate of request.exchangeRates) {
    entries.push({
      path: `exchangeRates.${rate.from}-${rate.to}`,
      origin: rate.origin,
      detail: "Caller-supplied minor-unit exchange rate.",
    });
  }
  return entries;
}

function warningsFor(
  request: EstimationRequest,
  items: readonly WorkItemInput[],
  cycles: string[][],
  external: string[],
  expected: ScenarioForecast,
): EstimationIssue[] {
  const issues: EstimationIssue[] = [];
  const push = (code: string, path: string, message: string): void => {
    issues.push({ severity: "warning", code, path, message });
  };
  for (const cycle of cycles) push("cycle", "items", `Dependency cycle: ${cycle.join(" → ")}. No calendar completion time was produced.`);
  if (external.length > 0) {
    push("external-dependency", "items", `Depends on items outside this scope: ${external.join(", ")}.`);
  }
  if (items.length === 0 && request.items.length > 0) {
    push("empty-scope", "scope", "The scope matched no work items.");
  }
  if (expected.additionalCash.basis === "policy" && expected.additionalCash.note) {
    push("policy-zero", "additionalCash", expected.additionalCash.note);
  }
  if (expected.additionalCash.status === "unknown" && expected.additionalCash.note) {
    push("unknown-cash", "additionalCash", expected.additionalCash.note);
  }
  for (const note of expected.coverage.notes) push("coverage", "coverage", note);
  if (expected.calendar.note && expected.calendar.status !== "known") push("calendar", "calendar", expected.calendar.note);
  return issues;
}

export function estimate(request: EstimationRequest): EstimationResult {
  const errors = validateRequest(request);
  if (errors.length > 0) return refused(request, errors);

  const { items, external } = selectItems(request);
  const cycles = findCycles(
    items.map((item) => item.id),
    dependencyMap(items),
  ).slice(0, 20);

  const scenarios = {} as Record<ScenarioId, ScenarioForecast>;
  for (const scenario of SCENARIOS) {
    scenarios[scenario] = forecastScenario(request, items, scenario, cycles, external);
  }

  const assessed = assessConfidence(request, items, scenarios.expected, cycles, external, true);
  const issues = warningsFor(request, items, cycles, external, scenarios.expected);
  const assumptions: string[] = [...BASE_ASSUMPTIONS];
  if (items.some((item) => item.stages.some((stage) => !stage.repetitions))) {
    assumptions.push("Stages without a repetition range run once in every scenario.");
  }

  return {
    ok: true,
    issues,
    scope: request.scope,
    scenarios,
    confidence: assessed.confidence,
    assumptions,
    missing: assessed.missing,
    warnings: issues.map((issue) => issue.message),
    provenance: provenanceFor(request, items),
    simplifications: [...BASE_SIMPLIFICATIONS, ...scenarios.expected.calendar.simplifications],
    cycles,
  };
}

export function estimateWhatIf(request: EstimationRequest, patch: WhatIfPatch): EstimationResult {
  const applied = applyWhatIf(request, patch);
  if (applied.issues.length > 0) return refused(applied.request, applied.issues);
  return estimate(applied.request);
}
