/**
 * Head of PM reads the same Smart Router evaluation the Owner UI uses.
 * The text is evidence. It is not an approval and it does not start a run.
 */

import { tasks } from "../db.ts";
import type { HeadScopeSnapshot } from "../../shared/head-pm-scope.ts";
import { RECOMMENDATION_BOUNDARY } from "../../shared/router-v2/resource-decision.ts";
import { routerV2Service } from "./router-v2-service.ts";

const routerQuestion = /best model|suitable developer|available account|fastest eligible|cheapest|quality requirement|limited codex|why did you choose|bottleneck|fallback|reallocate|another plan|verified results|routing policy|smart router|лучш|модел|аккаунт|запасн|квот|маршрут/i;

export function headRouterEvidence(question: string, scope: HeadScopeSnapshot | undefined): string[] {
  if (!routerQuestion.test(question)) return [];
  const policy = routerV2Service.getPolicy(scope?.scope.kind === "project" ? scope.scope.path : "global");
  const lines = [
    `Smart Router policy: ${policy.preset}. Quota policy: ${policy.quotaPolicy}. Autonomy preference: ${policy.autonomyMode}.`,
    RECOMMENDATION_BOUNDARY,
    "Configured quality tiers are not measured benchmarks. Subscription coverage is not a free API execution. Unknown quota stays Unknown.",
  ];
  const taskId = scope?.scope.kind === "task" ? scope.scope.id : null;
  if (!taskId) {
    lines.push("Name a task or mission before an allocation can be compared. No resource was changed.");
    return lines;
  }
  const task = tasks.get(taskId);
  if (!task) {
    lines.push("The scoped task was not found. No resource was changed.");
    return lines;
  }
  const evaluation = routerV2Service.evaluateTaskSync({
    taskId: task.id,
    projectId: scope?.scope.kind === "task" ? "global" : "global",
    title: task.title,
    role: task.column === "review" ? "reviewer" : "developer",
    type: task.taskType === "bug" ? "backend" : "general",
  });
  if (!evaluation.selected) {
    lines.push(`No eligible resource. Rejected: ${evaluation.ineligible.slice(0, 5).map(row => `${row.kind}/${row.modelId}: ${row.eliminationReasons[0] ?? "ineligible"}`).join(" | ") || "none"}.`);
  } else {
    const selected = evaluation.selected;
    lines.push(`Recommended ${selected.kind}/${selected.modelId}/account ${selected.accountId ?? "Unknown"}/mode ${selected.mode}. Provider identity: ${selected.providerIdentity ?? "Unknown"}.`);
    lines.push(`Quality evidence: ${selected.scores.quality.evidence}. Cost evidence: ${selected.scores.cost.evidence}. Quota: ${selected.scores.quota.capacityClass ?? "unknown"}. History confidence: ${selected.scores.history.confidence ?? "none"}.`);
    lines.push(evaluation.explanation);
  }
  if (/fallback|reallocate|запасн/i.test(question)) {
    lines.push("A fallback proposal must be approved through the existing mission reauthorization service. The failed run is not retried automatically.");
  }
  return lines;
}
