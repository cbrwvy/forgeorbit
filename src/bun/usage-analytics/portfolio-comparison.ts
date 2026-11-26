import type { forecastBase, TaskForecast } from "./forecast.ts";
import { poolSummary, type Constraint, type PoolSummary } from "./constraints.ts";

type Result = ReturnType<typeof forecastBase>;
type Range = Result["worker"];

/**
 * Current allocation versus one explicit alternative for one task (FO-FORECAST-PORTFOLIO01). Both
 * sides are ordinary `forecast` results over the same selection and assumptions, so this only lines
 * the two up. It starts nothing, selects nothing and grants nothing. Every figure that cannot be
 * compared says why instead of becoming zero or a guess.
 */
export interface ResourceView {
  harnessId: string;
  harnessLabel: string;
  accountId: string | null;
  accountLabel: string | null;
  modelId: string;
  mode: string;
  eligibility: "eligible" | "blocked" | "preflight" | null;
}

export interface RangeRow {
  current: Range | null;
  proposed: Range | null;
  /** Expected-scenario difference (proposed minus current); null whenever `reason` is set. */
  delta: number | null;
  reason: "schedule-unavailable" | "capacity-unresolved" | null;
}

export interface PoolSide {
  status: PoolSummary["status"];
  evidence: PoolSummary["evidence"];
  remaining: number | null;
  knownDemand: number;
  unknownStages: number;
  shortfall: number | null;
}

export interface PoolChange {
  id: string;
  window: string;
  unit: PoolSummary["unit"];
  shared: boolean;
  accountIds: readonly string[];
  current: PoolSide | null;
  proposed: PoolSide | null;
  /** Change in known demand in this pool's own typed unit. Unknown-demand stages are never added to it. */
  knownDemandDelta: number | null;
}

export interface AffectedTask {
  taskId: string;
  title: string;
  why: Array<"resource" | "schedule" | "constraint">;
  current: Constraint | null;
  proposed: Constraint | null;
  currentEndMs: number | null;
  proposedEndMs: number | null;
}

export interface CostChange {
  current: Result["cost"]["totals"];
  proposed: Result["cost"]["totals"];
  currentUnknownStages: number;
  proposedUnknownStages: number;
  currentSubscriptionStages: number;
  proposedSubscriptionStages: number;
  delta: { kind: string; currency: string; amount: number } | null;
  reason: "cost-incomplete" | "different-categories" | null;
}

export interface AlternativeComparison {
  taskId: string;
  title: string;
  projectPath: string | null;
  current: ResourceView | null;
  proposed: ResourceView | null;
  changed: { harness: boolean; account: boolean; model: boolean; mode: boolean };
  elapsed: RangeRow;
  resourceWait: RangeRow;
  completionWindow: { current: Range | null; proposed: Range | null; blockers: string[] };
  bottlenecks: { current: string[]; proposed: string[] };
  affected: AffectedTask[];
  pools: PoolChange[];
  cost: CostChange;
  /** Owner-supplied assumptions the proposed schedule used. They are assumptions, not measured facts. */
  assumptions: Result["assumptions"];
}

const view = (option: TaskForecast["developer"]): ResourceView | null => option ? {
  harnessId: option.harnessId, harnessLabel: option.label, accountId: option.accountId, accountLabel: option.accountLabel,
  modelId: option.modelId, mode: option.mode, eligibility: option.eligibility ?? null,
} : null;

function rangeRow(current: Range | null, proposed: Range | null, unresolved: boolean): RangeRow {
  if (!current || !proposed) return { current, proposed, delta: null, reason: "schedule-unavailable" };
  if (unresolved) return { current, proposed, delta: null, reason: "capacity-unresolved" };
  return { current, proposed, delta: proposed.expected - current.expected, reason: null };
}

const side = (pool: Result["capacity"]["rows"][number] | undefined): PoolSide | null => {
  if (!pool) return null;
  const summary = poolSummary(pool);
  return { status: summary.status, evidence: summary.evidence, remaining: summary.remaining, knownDemand: summary.knownDemand,
    unknownStages: summary.unknownStages, shortfall: summary.shortfall };
};

const sameConstraint = (a: Constraint | null, b: Constraint | null) =>
  a?.kind === b?.kind && a?.pool?.id === b?.pool?.id && a?.stageId === b?.stageId && a?.waitingOn.map(w => w.taskId).join() === b?.waitingOn.map(w => w.taskId).join();

export function compareAlternative(current: Result, proposed: Result, taskId: string): AlternativeComparison {
  const before = current.estimates.find(estimate => estimate.taskId === taskId);
  const after = proposed.estimates.find(estimate => estimate.taskId === taskId);
  const a = view(before?.developer ?? null);
  const b = view(after?.developer ?? null);
  const unresolved = current.blockers.includes("capacity") || proposed.blockers.includes("capacity");
  const stages = (result: Result) => {
    const byTask = new Map<string, { start: number; end: number; key: string }>();
    for (const stage of result.stages) {
      const prior = byTask.get(stage.taskId);
      byTask.set(stage.taskId, {
        start: Math.min(prior?.start ?? Infinity, stage.startMs), end: Math.max(prior?.end ?? 0, stage.endMs),
        key: (prior?.key ?? "") + `|${stage.id}:${stage.startMs}:${stage.endMs}`,
      });
    }
    return byTask;
  };
  const was = stages(current);
  const now = stages(proposed);
  const wasConstraint = new Map(current.constraints.map(item => [item.taskId, item.first]));
  const nowConstraint = new Map(proposed.constraints.map(item => [item.taskId, item.first]));
  const affected: AffectedTask[] = [];
  for (const estimate of proposed.estimates) {
    const why: AffectedTask["why"] = [];
    if (estimate.taskId === taskId) why.push("resource");
    if (was.get(estimate.taskId)?.key !== now.get(estimate.taskId)?.key) why.push("schedule");
    if (!sameConstraint(wasConstraint.get(estimate.taskId) ?? null, nowConstraint.get(estimate.taskId) ?? null)) why.push("constraint");
    if (!why.length) continue;
    affected.push({
      taskId: estimate.taskId, title: estimate.title, why,
      current: wasConstraint.get(estimate.taskId) ?? null, proposed: nowConstraint.get(estimate.taskId) ?? null,
      currentEndMs: was.get(estimate.taskId)?.end ?? null, proposedEndMs: now.get(estimate.taskId)?.end ?? null,
    });
  }
  const poolIds = [...new Set([...current.capacity.rows, ...proposed.capacity.rows].map(pool => pool.id))];
  const pools = poolIds.map((id): PoolChange => {
    const was = current.capacity.rows.find(pool => pool.id === id);
    const now = proposed.capacity.rows.find(pool => pool.id === id);
    const any = (now ?? was)!;
    return {
      id, window: any.window, unit: any.unit, shared: any.shared, accountIds: [...new Set([...(was?.accountIds ?? []), ...(now?.accountIds ?? [])])],
      current: side(was), proposed: side(now), knownDemandDelta: was && now ? now.knownDemand - was.knownDemand : null,
    };
  });
  const money = (result: Result) => result.cost.totals;
  const before$ = money(current);
  const after$ = money(proposed);
  const complete = current.cost.unknown === 0 && proposed.cost.unknown === 0 && current.cost.subscription === 0 && proposed.cost.subscription === 0;
  const single = before$.length === 1 && after$.length === 1 && before$[0]!.kind === after$[0]!.kind && before$[0]!.currency === after$[0]!.currency;
  const cost: CostChange = {
    current: before$, proposed: after$,
    currentUnknownStages: current.cost.unknown, proposedUnknownStages: proposed.cost.unknown,
    currentSubscriptionStages: current.cost.subscription, proposedSubscriptionStages: proposed.cost.subscription,
    delta: complete && single ? { kind: after$[0]!.kind, currency: after$[0]!.currency, amount: after$[0]!.amount - before$[0]!.amount } : null,
    reason: !complete ? "cost-incomplete" : !single ? "different-categories" : null,
  };
  const keys = (result: Result) => result.bottlenecks.map(([key]) => key);
  return {
    taskId, title: after?.title ?? before?.title ?? taskId, projectPath: after?.projectPath ?? before?.projectPath ?? null,
    current: a, proposed: b,
    changed: {
      harness: a?.harnessId !== b?.harnessId, account: a?.accountId !== b?.accountId, model: a?.modelId !== b?.modelId, mode: a?.mode !== b?.mode,
    },
    elapsed: rangeRow(current.elapsed, proposed.elapsed, unresolved),
    resourceWait: rangeRow(current.resourceWait, proposed.resourceWait, unresolved),
    completionWindow: {
      current: current.completionWindow, proposed: proposed.completionWindow,
      blockers: [...new Set([...(current.completionWindow ? [] : current.blockers), ...(proposed.completionWindow ? [] : proposed.blockers)])],
    },
    bottlenecks: { current: keys(current), proposed: keys(proposed) },
    affected, pools, cost, assumptions: proposed.assumptions,
  };
}
