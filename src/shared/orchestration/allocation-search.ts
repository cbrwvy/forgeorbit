/** Bounded, deterministic assignment of remaining stages to eligible resources. */

export const ALLOCATION_SEARCH_LIMIT = 256;

export const ALLOCATION_OBJECTIVES = ["fastest", "lowest-charge", "balanced", "quota-preserving", "minimum-wait"] as const;
export type AllocationObjective = (typeof ALLOCATION_OBJECTIVES)[number];

export interface AllocationOption {
  id: string;
  accountId: string;
  durationMs: number;
  /** Comparable API charge. Null means this option cannot enter a lowest-charge ranking. */
  charge: number | null;
  waitMs: number;
  poolId: string | null;
  /** Native demand. Null is unknown and is not treated as zero. */
  demand: number | null;
  concurrency: number;
  provider?: string | null;
}

export interface AllocationStage {
  id: string;
  dependsOn: string[];
  options: AllocationOption[];
  projectId?: string;
  clusterId?: string;
  role?: string;
  /** A paused or draining stage is withheld. Dependents wait. */
  withheld?: string | null;
}

export interface AllocationOccupant {
  accountId?: string | null;
  projectId?: string | null;
  clusterId?: string | null;
  role?: string | null;
  poolId?: string | null;
  demand?: number | null;
  untilMs?: number;
}

export interface AllocationLimits {
  globalMax?: number | null;
  perProjectMax?: number | null;
  perClusterMax?: number | null;
  perRoleMax?: number | null;
  blockedProviders?: string[];
  occupied?: AllocationOccupant[];
  /** Caps the caller could not measure. They are disclosed and are not treated as unlimited. */
  unmeasured?: string[];
}

export interface AllocationPool {
  id: string;
  /** Evidenced remaining capacity. Null is not a promise of future capacity. */
  remaining: number | null;
}

export interface AllocationCandidate {
  objective: AllocationObjective;
  feasible: boolean;
  /** True only when every feasible assignment was examined. */
  optimal: boolean;
  explored: number;
  limit: number;
  score: number | null;
  assignment: Record<string, string>;
  reason: string | null;
  limitations: string[];
  withheld: Record<string, string>;
}

interface Placement {
  option: AllocationOption;
  start: number;
  end: number;
}

const keyOf = (assignment: Record<string, string>) => Object.keys(assignment).sort().map(id => `${id}=${assignment[id]}`).join("|");

function orderStages(stages: AllocationStage[]): AllocationStage[] | null {
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const pending = new Set(stages.map(stage => stage.id));
  const ordered: AllocationStage[] = [];
  while (pending.size) {
    const ready = [...pending].filter(id => (byId.get(id)?.dependsOn ?? []).every(dep => !pending.has(dep))).sort();
    const id = ready[0];
    if (!id) return null;
    pending.delete(id);
    ordered.push(byId.get(id)!);
  }
  return ordered;
}

function pushSpan(map: Map<string, Array<[number, number]>>, key: string | null | undefined, span: [number, number]) {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(span);
  map.set(key, list);
}

function withholdStages(stages: AllocationStage[]) {
  const withheld = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of stages) {
      if (withheld.has(stage.id)) continue;
      if (stage.withheld) {
        withheld.set(stage.id, stage.withheld);
        changed = true;
        continue;
      }
      const blocker = stage.dependsOn.find(id => withheld.has(id));
      if (blocker) {
        withheld.set(stage.id, `Waiting on ${blocker}, which is withheld: ${withheld.get(blocker)}`);
        changed = true;
      }
    }
  }
  return withheld;
}

function scoreOf(objective: AllocationObjective, placements: Placement[], pools: Map<string, number | null>): number | null {
  if (objective === "fastest") return Math.max(0, ...placements.map(row => row.end));
  if (objective === "minimum-wait") return placements.reduce((sum, row) => sum + row.option.waitMs, 0);
  if (objective === "lowest-charge") {
    if (placements.some(row => row.option.charge === null)) return null;
    return placements.reduce((sum, row) => sum + row.option.charge!, 0);
  }
  if (objective === "balanced") {
    const load = new Map<string, number>();
    for (const row of placements) load.set(row.option.accountId, (load.get(row.option.accountId) ?? 0) + row.end - row.start);
    return Math.max(0, ...load.values());
  }
  let peak = 0;
  const used = new Map<string, number>();
  for (const row of placements) {
    if (!row.option.poolId || row.option.demand === null) continue;
    used.set(row.option.poolId, (used.get(row.option.poolId) ?? 0) + row.option.demand);
  }
  for (const [id, amount] of used) {
    const remaining = pools.get(id);
    if (remaining === null || remaining === undefined || remaining <= 0) return null;
    peak = Math.max(peak, amount / remaining);
  }
  return peak;
}

function fits(option: AllocationOption, used: Map<string, number>, pools: Map<string, number | null>, strict: boolean) {
  if (!option.poolId) return !strict || option.demand === null;
  const remaining = pools.get(option.poolId) ?? null;
  if (option.demand === null || remaining === null) return !strict;
  return (used.get(option.poolId) ?? 0) + option.demand <= remaining;
}

function earliestConstrained(groups: Array<{ intervals: Array<[number, number]>; limit: number }>, start: number, duration: number): number | null {
  let time = start;
  for (let guard = 0; guard < 10_000; guard++) {
    let next: number | null = null;
    for (const group of groups) {
      if (!Number.isSafeInteger(group.limit) || group.limit < 1) return null;
      const overlapping = group.intervals.filter(([from, to]) => from < time + duration && to > time);
      if (overlapping.length >= group.limit) {
        const until = Math.min(...overlapping.map(([, to]) => to));
        next = next === null ? until : Math.max(next, until);
      }
    }
    if (next === null) return time;
    if (next <= time) return null;
    time = next;
  }
  return null;
}

function bucket(map: Map<string, Array<[number, number]>>, key: string) {
  const list = map.get(key) ?? [];
  map.set(key, list);
  return list;
}

export function searchAllocation(
  stages: AllocationStage[], objective: AllocationObjective, pools: AllocationPool[], strict: boolean, limit = ALLOCATION_SEARCH_LIMIT,
  caps?: AllocationLimits,
): AllocationCandidate {
  const limitations = [...(caps?.unmeasured ?? [])];
  if (caps?.perRoleMax == null) limitations.push("Specialist concurrency is enforced at admission as one live employee assignment. This search does not claim a separate numeric role cap.");
  const withheldMap = withholdStages(stages);
  const withheld = Object.fromEntries(withheldMap);
  const empty = (reason: string | null, feasible: boolean, optimal: boolean, explored = 0): AllocationCandidate => ({
    objective, feasible, optimal, explored, limit, score: feasible ? 0 : null, assignment: {}, reason, limitations, withheld,
  });
  const active = stages.filter(stage => !withheldMap.has(stage.id));
  if (withheldMap.size === stages.length && stages.length > 0) {
    return empty([...withheldMap.values()][0] ?? "Every remaining stage is withheld.", false, true);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) return empty("The search limit must be a positive integer.", false, true);
  if (active.length > 12) return empty("Too many stages for a bounded allocation search.", false, false);
  const ordered = orderStages(active.map(stage => ({ ...stage, dependsOn: stage.dependsOn.filter(id => !withheldMap.has(id)) })));
  if (!ordered) return empty("Stage dependencies contain a cycle.", false, true);
  if (ordered.some(stage => stage.options.length === 0)) return empty("A remaining stage has no eligible resource.", false, true);
  const poolRemaining = new Map(pools.map(pool => [pool.id, pool.remaining]));
  const accounts = new Map<string, Array<[number, number]>>();
  const projects = new Map<string, Array<[number, number]>>();
  const clusters = new Map<string, Array<[number, number]>>();
  const roles = new Map<string, Array<[number, number]>>();
  const globalSpans: Array<[number, number]> = [];
  const seeded = new Map<string, number>();
  for (const row of caps?.occupied ?? []) {
    const span: [number, number] = [0, row.untilMs ?? 86_400_000];
    if (caps?.globalMax != null) globalSpans.push(span);
    pushSpan(accounts, row.accountId, span);
    pushSpan(projects, row.projectId, span);
    pushSpan(clusters, row.clusterId, span);
    pushSpan(roles, row.role, span);
    if (row.poolId && row.demand != null) seeded.set(row.poolId, (seeded.get(row.poolId) ?? 0) + row.demand);
  }
  const blocked = new Set(caps?.blockedProviders ?? []);
  let explored = 0;
  let exhausted = true;
  const best: { score: number; assignment: Record<string, string> }[] = [];
  const consider = (assignment: Record<string, string>, placements: Placement[]) => {
    const score = scoreOf(objective, placements, poolRemaining);
    if (score === null) return;
    const key = keyOf(assignment);
    const current = best[0];
    if (!current || score < current.score || score === current.score && key < keyOf(current.assignment)) best[0] = { score, assignment: { ...assignment } };
  };
  const walk = (
    index: number, assignment: Record<string, string>, used: Map<string, number>, placements: Map<string, Placement>,
  ) => {
    if (explored >= limit) {
      exhausted = false;
      return;
    }
    explored += 1;
    if (index === ordered.length) {
      consider(assignment, [...placements.values()]);
      return;
    }
    const stage = ordered[index]!;
    const readyAt = stage.dependsOn.reduce((at, id) => Math.max(at, placements.get(id)?.end ?? 0), 0);
    for (const option of [...stage.options].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      if (explored >= limit) {
        exhausted = false;
        return;
      }
      if (option.provider && blocked.has(option.provider)) continue;
      if (!Number.isFinite(option.durationMs) || option.durationMs < 0 || !Number.isFinite(option.waitMs) || option.waitMs < 0 || option.concurrency < 1) continue;
      if (!fits(option, used, poolRemaining, strict)) continue;
      const duration = option.durationMs + option.waitMs;
      const account = bucket(accounts, option.accountId);
      const groups = [{ intervals: account, limit: option.concurrency }];
      if (caps?.globalMax != null) groups.push({ intervals: globalSpans, limit: caps.globalMax });
      if (caps?.perProjectMax != null && stage.projectId) groups.push({ intervals: bucket(projects, stage.projectId), limit: caps.perProjectMax });
      if (caps?.perClusterMax != null && stage.clusterId) groups.push({ intervals: bucket(clusters, stage.clusterId), limit: caps.perClusterMax });
      if (caps?.perRoleMax != null && stage.role) groups.push({ intervals: bucket(roles, stage.role), limit: caps.perRoleMax });
      const start = earliestConstrained(groups, readyAt, duration);
      if (start === null) continue;
      const end = start + duration;
      const placed = [...placements.values()];
      const partial = objective === "fastest" ? end : objective === "minimum-wait"
        ? placed.reduce((sum, row) => sum + row.option.waitMs, 0) + option.waitMs
        : objective === "lowest-charge" && option.charge !== null ? placed.reduce((sum, row) => sum + (row.option.charge ?? 0), 0) + option.charge : null;
      if (best[0] && partial !== null && partial > best[0].score) continue;
      assignment[stage.id] = option.id;
      const span: [number, number] = [start, end];
      for (const group of groups) group.intervals.push(span);
      if (option.poolId && option.demand !== null) used.set(option.poolId, (used.get(option.poolId) ?? 0) + option.demand);
      placements.set(stage.id, { option, start, end });
      walk(index + 1, assignment, used, placements);
      placements.delete(stage.id);
      for (const group of groups) group.intervals.pop();
      if (option.poolId && option.demand !== null) used.set(option.poolId, (used.get(option.poolId) ?? 0) - option.demand);
      delete assignment[stage.id];
    }
  };
  walk(0, {}, new Map(seeded), new Map());
  const found = best[0];
  if (!found) return { ...empty(exhausted ? "No feasible allocation respects the evidenced capacity." : "The search limit was reached before a feasible allocation was found.", false, exhausted, explored), explored };
  const reason = exhausted ? null : "The best feasible allocation found so far is not proven globally optimal.";
  return {
    objective, feasible: true, optimal: exhausted, explored, limit, score: found.score, assignment: found.assignment,
    reason, limitations, withheld,
  };
}

export function compareAllocations(stages: AllocationStage[], pools: AllocationPool[], strict: boolean, limit = ALLOCATION_SEARCH_LIMIT) {
  return ALLOCATION_OBJECTIVES.map(objective => searchAllocation(stages, objective, pools, strict, limit));
}
