import { isSyntheticEvidenceSource, type ForecastSelection, type RunCost } from "../../shared/usage-analytics.ts";
import type { quotaFor } from "./resources.ts";

type Quota = ReturnType<typeof quotaFor>[number];
type Assumptions = ForecastSelection["assumptions"];

export function quotaDemand(quota: Quota, cost: RunCost, runs = 1): number | null {
  if (quota.category !== "api-credit" || quota.unit.kind !== "money" || cost.kind !== "calculated-api" ||
    cost.money?.currency !== quota.unit.currency || !["USD", "CNY", "EUR", "GBP"].includes(quota.unit.currency)) return null;
  const minor = cost.money.amount * runs * 100;
  // Preserve upward rounding without turning an exact cent into two due to
  // floating-point accumulation of input, output, and cache charges.
  const rounded = Math.ceil(minor - 4 * Number.EPSILON * minor);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function capacityEvidence(q: Quota) {
  if (q.current && !isSyntheticEvidenceSource(q.current.source)) return "verified";
  if (q.ownerReported) return "owner-reported";
  if (q.current) return "fixture";
  if (q.historicalVerified && !isSyntheticEvidenceSource(q.historicalVerified.source)) return "verified";
  return q.threshold === null ? "unknown" : "configured";
}

export function poolKey(quota: Quota) {
  const observation = quota.current ?? quota.historicalVerified;
  const pool = observation?.pool;
  return observation && pool?.verified && !isSyntheticEvidenceSource(observation.source)
    ? JSON.stringify([observation.poolProvider, pool.id, pool.scope, pool.window, quota.windowMs, quota.unit])
    : quota.id;
}

interface PoolDemand {
  stageId?: string;
  taskId: string;
  quotas: Quota[];
  cost: RunCost;
  runs: number;
}

export function planCapacity(stages: PoolDemand[], busyQuota: Quota[], now: number, assumptions: Assumptions, strict: boolean) {
  const pools = new Map<string, { readings: Map<string, Quota>; demand: number; unknown: number; tasks: Set<string>; stages: Map<string, number | null>; owners: Map<string, string> }>();
  const busy = new Set(busyQuota.map(poolKey));
  for (const stage of stages) {
    const assigned = new Map<string, number | null>();
    for (const quota of stage.quotas) {
      const key = poolKey(quota);
      const pool = pools.get(key) ?? { readings: new Map(), demand: 0, unknown: 0, tasks: new Set<string>(), stages: new Map<string, number | null>(), owners: new Map<string, string>() };
      pool.readings.set(quota.id, quota);
      pool.tasks.add(stage.taskId);
      pools.set(key, pool);
      const demand = quotaDemand(quota, stage.cost, stage.runs);
      const prior = assigned.get(key);
      assigned.set(key, demand === null || prior === null ? null : Math.max(demand, prior ?? 0));
    }
    for (const [key, demand] of assigned) {
      const pool = pools.get(key)!;
      pool.stages.set(stage.stageId ?? stage.taskId, demand);
      pool.owners.set(stage.stageId ?? stage.taskId, stage.taskId);
      if (demand === null) pool.unknown++;
      else pool.demand += demand;
    }
  }
  // One balance per typed pool/window. Each task stage charges that balance once,
  // even if more than one matching definition describes it.
  const rows = [...pools].map(([key, pool]) => {
    const readings = [...pool.readings.values()];
    const first = readings[0]!;
    const evidence = capacityEvidence(first);
    const observations = readings.map(q => evidence === "verified" ? q.current ?? q.historicalVerified : evidence === "owner-reported" ? q.ownerReported : null);
    const fresh = observations.every((o, i) => o?.freshness === "fresh" && readings[i]!.status === "current" &&
      (evidence !== "verified" || readings[i]!.current?.id === o.id) &&
      (o.resetAt === null || o.resetAt > now) && (o.period?.endAt == null || o.period.endAt > now));
    const agreed = (values: (number | null)[]) => values.every(v => v === values[0]) ? values[0] ?? null : null;
    const sameWindow = observations.every(o => o?.resetAt === observations[0]?.resetAt &&
      o?.period?.startAt === observations[0]?.period?.startAt && o?.period?.endAt === observations[0]?.period?.endAt);
    const valid = fresh && sameWindow;
    const remaining = valid && observations.every(o => o?.remaining != null) ? Math.min(...observations.map(o => o!.remaining!)) : null;
    const resetAt = sameWindow ? agreed(observations.map(o => o?.resetAt ?? null)) : null;
    const limit = valid ? agreed(observations.map(o => o?.limit ?? null)) : null;
    const expiresAt = valid ? Math.min(...observations.map(o => Math.min(o?.expiresAt ?? now, o?.period?.endAt ?? Infinity, o?.resetAt ?? Infinity))) : null;
    const active = busy.has(key);
    const exhausted = valid && (remaining === 0 || observations.some(o => o?.remainingPercent === 0));
    const exceeds = remaining !== null && pool.demand > remaining;
    const assumedRefill = !strict && assumptions?.refillAtReset === true && evidence === "verified" && !active &&
      (exhausted || exceeds) && resetAt !== null && resetAt > now && limit !== null && limit > 0 &&
      limit >= pool.demand && pool.unknown === 0;
    const future = !strict && evidence === "verified" && !active && pool.unknown === 0
      ? (assumptions?.quotaWindows ?? []).filter(window => window.poolId === key).sort((a, b) => a.startsAt - b.startsAt)
      : [];
    const bounded = future.length > 0 && future.every((window, index) =>
      Number.isSafeInteger(window.allowance) && window.allowance > 0 && window.startsAt > now &&
      window.endsAt > window.startsAt && (future[index - 1]?.endsAt ?? 0) <= window.startsAt);
    const windows = bounded ? [
      ...(remaining !== null && expiresAt !== null ? [{
        startsAt: now, endsAt: Math.min(expiresAt, future[0]!.startsAt), allowance: remaining, assumed: false,
      }] : []),
      ...future.map(window => ({ ...window, assumed: true })),
    ].map(window => ({ ...window, remaining: window.allowance })) : [];
    const allocations: { stageId: string; startsAt: number; endsAt: number; assumed: boolean }[] = [];
    for (const [stageId, demand] of pool.stages) {
      const window = windows.find(w => demand !== null && w.remaining >= demand);
      if (!window) break;
      window.remaining -= demand!;
      allocations.push({ stageId, startsAt: window.startsAt, endsAt: window.endsAt, assumed: window.assumed });
    }
    const complete = bounded && allocations.length === pool.stages.size;
    const status = complete && allocations.some(allocation => allocation.assumed) || assumedRefill ? "reset-assumed"
      : exhausted ? "exhausted" : exceeds ? "insufficient"
      : remaining !== null && pool.unknown === 0 && !active ? "fits" : "unknown";
    const blocker = status === "exhausted" || status === "insufficient" ||
      (status === "unknown" || evidence !== "verified") && (strict || !assumptions?.unknownCapacity);
    return {
      id: key, shared: key !== first.id,
      // Stage order is the order the pool charges demand in. A shortfall is the known demand above the observed balance.
      stageDemands: [...pool.stages].map(([stageId, demand]) => ({ stageId, taskId: pool.owners.get(stageId)!, demand })),
      shortfall: exceeds && remaining !== null ? pool.demand - remaining : null, scope: first.scope, window: first.window, unit: first.unit,
      accountIds: [...new Set(readings.map(q => q.accountId))], quotaIds: readings.map(q => q.id),
      taskIds: [...pool.tasks], stageIds: [...pool.stages.keys()], allocations: complete ? allocations : [], evidence, remaining, knownDemand: pool.demand, unknownStages: pool.unknown,
      freshness: valid ? "fresh" : observations.some(Boolean) ? "stale-or-conflicting" : "unknown",
      expiresAt, resetAt, active, status, blocker,
      provenance: observations.flatMap(o => o ? [{ source: o.source, observedAt: o.observedAt, expiresAt: o.expiresAt }] : []),
    } as const;
  });
  const uncovered = stages.filter(stage => !stage.quotas.length);
  return { rows, uncoveredStages: uncovered.length, uncoveredStageIds: uncovered.map(stage => stage.stageId ?? stage.taskId) };
}
