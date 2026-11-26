import type { planCapacity } from "./capacity.ts";
import type { TaskForecast } from "./forecast.ts";

/**
 * First meaningful constraint per task (FO-FORECAST-PORTFOLIO01). A read-only summary of results the
 * scheduler and the capacity planner already produced: dependencies, project holds, resource
 * evidence, pool shortfalls, Unknown capacity and busy slots. Nothing is recomputed here and nothing
 * is launched or authorized. A forecast is not a launch authorization.
 */
export type ConstraintKind =
  | "project-hold" | "owner-decision" | "dependency" | "dependency-outside" | "resource-evidence"
  | "quota-shortfall" | "quota-unknown" | "busy-slot";

type Pool = ReturnType<typeof planCapacity>["rows"][number];

export interface PoolSummary {
  id: string;
  window: string;
  unit: Pool["unit"];
  shared: boolean;
  accountIds: readonly string[];
  status: Pool["status"];
  evidence: Pool["evidence"];
  remaining: number | null;
  knownDemand: number;
  unknownStages: number;
  shortfall: number | null;
}

export interface Constraint {
  kind: ConstraintKind;
  stageId: string | null;
  stageKind: string | null;
  waitingOn: Array<{ taskId: string; title: string | null }>;
  pool: PoolSummary | null;
  resources: string[];
  /** Short machine reason: project state, resource issue, or the unresolved dependency kind. */
  reason: string | null;
}

export interface TaskConstraint {
  taskId: string;
  title: string;
  projectPath: string | null;
  first: Constraint | null;
  also: Constraint[];
}

export interface ConstraintInput {
  estimates: Array<Pick<TaskForecast, "taskId" | "title" | "projectPath" | "dependsOn" | "roles" | "remainingRoles" | "developer" | "reviewer">>;
  stages: Array<{ id: string; taskId: string; kind: string; delayedBy: string[]; resources: string[] }>;
  capacity: { rows: Pool[]; uncoveredStageIds: string[] };
  ownerGates: string[];
  projectHolds: Record<string, string>;
}

export const poolSummary = (pool: Pool): PoolSummary => ({
  id: pool.id, window: pool.window, unit: pool.unit, shared: pool.shared, accountIds: pool.accountIds, status: pool.status,
  evidence: pool.evidence, remaining: pool.remaining, knownDemand: pool.knownDemand, unknownStages: pool.unknownStages, shortfall: pool.shortfall,
});

/** Stages the pool cannot fund, in charging order: exhausted funds none, insufficient funds until the running demand passes the balance. */
export function shortStages(pool: Pool): Set<string> {
  const short = new Set<string>();
  if (pool.status !== "insufficient" && pool.status !== "exhausted") return short;
  let used = 0;
  for (const { stageId, demand } of pool.stageDemands) {
    if (demand === null) continue;
    used += demand;
    if (pool.status === "exhausted" || pool.remaining === null || used > pool.remaining) short.add(stageId);
  }
  return short;
}

export function deriveConstraints(input: ConstraintInput): TaskConstraint[] {
  const selected = new Set(input.estimates.map(estimate => estimate.taskId));
  const titles = new Map(input.estimates.map(estimate => [estimate.taskId, estimate.title]));
  const gates = new Set(input.ownerGates);
  const uncovered = new Set(input.capacity.uncoveredStageIds);
  const shortByPool = input.capacity.rows.map(pool => ({ pool, short: shortStages(pool) }));
  const stageKind = new Map(input.stages.map(stage => [stage.id, stage.kind]));
  const base = (): Omit<Constraint, "kind"> => ({ stageId: null, stageKind: null, waitingOn: [], pool: null, resources: [], reason: null });

  return input.estimates.map((estimate): TaskConstraint => {
    const found: Constraint[] = [];
    const hold = estimate.projectPath ? input.projectHolds[estimate.projectPath] : undefined;
    if (hold) found.push({ ...base(), kind: "project-hold", reason: hold });
    const inside = estimate.dependsOn.filter(id => selected.has(id));
    const outside = estimate.dependsOn.filter(id => !selected.has(id));
    const gated = estimate.dependsOn.filter(id => gates.has(id));
    if (gated.length) found.push({ ...base(), kind: "owner-decision", waitingOn: gated.map(id => ({ taskId: id, title: titles.get(id) ?? null })), reason: "awaiting_owner" });
    if (inside.length) found.push({ ...base(), kind: "dependency", waitingOn: inside.map(id => ({ taskId: id, title: titles.get(id) ?? null })), reason: "pending-task" });
    if (outside.length) found.push({ ...base(), kind: "dependency-outside", waitingOn: outside.map(id => ({ taskId: id, title: null })), reason: "outside-selection" });
    const resources = (estimate.remainingRoles ?? estimate.roles).flatMap(role => {
      const option = estimate[role];
      if (!option) return [`${role}:none`];
      if (!option.planningEligible) return [`${role}:unavailable`];
      // A Simulated option is preflight-only evidence, except in the guarded QA preview where the forecast has already judged it
      // eligible for this calculation: there the quota fact, not the label, is the constraint worth naming first.
      return option.eligibility === "preflight" || (option.simulated && option.eligibility !== "eligible") ? [`${role}:preflight`] : [];
    });
    if (resources.length) found.push({ ...base(), kind: "resource-evidence", reason: resources.join(", ") });
    const stageIds = new Set(input.stages.filter(stage => stage.taskId === estimate.taskId).map(stage => stage.id));
    const ownStages = (pool: Pool) => pool.stageDemands.filter(item => item.taskId === estimate.taskId);
    for (const { pool, short } of shortByPool) {
      const first = ownStages(pool).find(item => short.has(item.stageId));
      if (first) {
        found.push({ ...base(), kind: "quota-shortfall", stageId: first.stageId, stageKind: stageKind.get(first.stageId) ?? null, pool: poolSummary(pool), reason: pool.status });
        break;
      }
    }
    const unknownPool = input.capacity.rows.find(pool => !["insufficient", "exhausted"].includes(pool.status) &&
      ownStages(pool).some(item => item.demand === null || pool.status === "unknown" || pool.evidence !== "verified"));
    const uncoveredStage = [...stageIds].find(id => uncovered.has(id));
    if (unknownPool || uncoveredStage) {
      const stage = unknownPool ? ownStages(unknownPool)[0]?.stageId ?? null : uncoveredStage ?? null;
      found.push({
        ...base(), kind: "quota-unknown", stageId: stage, stageKind: stage ? stageKind.get(stage) ?? null : null,
        pool: unknownPool ? poolSummary(unknownPool) : null, reason: unknownPool ? "pool-unknown" : "no-quota-evidence",
      });
    }
    const delayed = input.stages.find(stage => stage.taskId === estimate.taskId && stage.delayedBy.length > 0);
    if (delayed) found.push({ ...base(), kind: "busy-slot", stageId: delayed.id, stageKind: delayed.kind, resources: delayed.delayedBy, reason: "slot-busy" });
    return { taskId: estimate.taskId, title: estimate.title, projectPath: estimate.projectPath, first: found[0] ?? null, also: found.slice(1) };
  });
}

const RESOURCE_PRIORITY: ConstraintKind[] = ["project-hold", "resource-evidence", "quota-shortfall", "quota-unknown", "busy-slot"];

/**
 * The portfolio's first constraint that is a resource or capacity fact rather than waiting on another
 * task. The most serious kind wins (a hold, missing evidence, a known shortfall, Unknown capacity,
 * then a merely busy slot); within a kind, the first task in selection order.
 */
export function firstResourceConstraint(items: TaskConstraint[]): { taskId: string; kind: ConstraintKind } | null {
  for (const kind of RESOURCE_PRIORITY) {
    const found = items.find(item => [item.first, ...item.also].some(constraint => constraint?.kind === kind));
    if (found) return { taskId: found.taskId, kind };
  }
  return null;
}
