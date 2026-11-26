/**
 * Dependency graph and a bounded schedule.
 *
 * Critical path is exact for an unbounded crew. A concurrency cap uses list
 * scheduling (longest remaining path first). That is a feasible plan, not a
 * search over assignments — multiprocessor scheduling stays NP-hard, and this
 * core does not pretend to solve it.
 */

/** A work item holds each named slot for its scheduled interval. */
export interface ScheduleResources {
  keysByItem: ReadonlyMap<string, readonly string[]>;
  limits: ReadonlyMap<string, number>;
  releaseMs?: ReadonlyMap<string, number>;
  occupiedUntil?: ReadonlyArray<{ keys: readonly string[]; endMs: number }>;
}

export interface ScheduledInterval {
  id: string;
  readyMs: number;
  startMs: number;
  endMs: number;
  delayedBy: string[];
}

export interface ScheduleResult {
  cycles: string[][];
  scheduleMs: number | null;
  criticalPathMs: number | null;
  criticalPath: string[];
  serialMs: number | null;
  method: "critical-path" | "list-scheduling" | "none";
  exact: boolean;
  intervals?: ScheduledInterval[];
}

export function findCycles(ids: readonly string[], dependsOn: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const pred of dependsOn.get(id) ?? []) {
      const state = color.get(pred) ?? 0;
      if (state === 1) {
        const at = stack.indexOf(pred);
        if (at >= 0) {
          const cycle = stack.slice(at);
          cycle.push(pred);
          cycles.push(cycle);
        }
      } else if (state === 0) {
        visit(pred);
      }
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const id of ids) {
    if ((color.get(id) ?? 0) === 0) visit(id);
  }
  return cycles;
}

function criticalPath(
  ids: readonly string[],
  durationMs: ReadonlyMap<string, number>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
): { ms: number; ids: string[] } | null {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    successors.set(id, []);
  }
  for (const id of ids) {
    for (const pred of dependsOn.get(id) ?? []) {
      if (!indegree.has(pred)) return null;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      successors.get(pred)?.push(id);
    }
  }
  const queue: string[] = [];
  for (const id of ids) if ((indegree.get(id) ?? 0) === 0) queue.push(id);
  queue.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const finish = new Map<string, number>();
  let seen = 0;
  let tail: string | null = null;
  const previous = new Map<string, string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    seen += 1;
    let start = 0;
    for (const pred of dependsOn.get(id) ?? []) {
      const predFinish = finish.get(pred) ?? 0;
      if (predFinish > start || !previous.has(id)) {
        start = predFinish;
        previous.set(id, pred);
      }
    }
    const end = start + (durationMs.get(id) ?? 0);
    finish.set(id, end);
    if (tail === null || end > finish.get(tail)!) tail = id;
    const next = successors.get(id) ?? [];
    for (const child of next) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
    queue.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (seen !== ids.length) return null;
  const path: string[] = [];
  const ms = tail === null ? 0 : finish.get(tail)!;
  for (let id = tail; id !== null; id = previous.get(id) ?? null) path.push(id);
  return { ms, ids: path.reverse() };
}

function longestPathPriority(
  ids: readonly string[],
  durationMs: ReadonlyMap<string, number>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const successors = new Map<string, string[]>();
  for (const id of ids) successors.set(id, []);
  for (const id of ids) {
    for (const pred of dependsOn.get(id) ?? []) successors.get(pred)?.push(id);
  }
  const memo = new Map<string, number>();
  const visit = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    let best = 0;
    for (const child of successors.get(id) ?? []) best = Math.max(best, visit(child));
    const value = (durationMs.get(id) ?? 0) + best;
    memo.set(id, value);
    return value;
  };
  for (const id of ids) visit(id);
  return memo;
}

function listSchedule(
  ids: readonly string[],
  durationMs: ReadonlyMap<string, number>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
  cap: number,
  resources?: ScheduleResources,
): { elapsed: number; intervals: ScheduledInterval[] } | null {
  const priority = longestPathPriority(ids, durationMs, dependsOn);
  const done = new Set<string>();
  const running = new Map<string, number>();
  const occupied = new Map<string, number>();
  const intervals = new Map<string, ScheduledInterval>();
  const delays = new Map<string, Set<string>>();
  const record = (id: string, duration: number) => {
    const readyMs = Math.max(0, ...(dependsOn.get(id) ?? []).map(pred => intervals.get(pred)!.endMs));
    intervals.set(id, { id, readyMs, startMs: time, endMs: time + duration, delayedBy: [...(delays.get(id) ?? [])] });
  };
  const resourceKeys = (id: string) => resources?.keysByItem.get(id) ?? [];
  const adjust = (id: string, delta: number) => {
    for (const key of resourceKeys(id)) occupied.set(key, (occupied.get(key) ?? 0) + delta);
  };
  const preexisting = (resources?.occupiedUntil ?? []).filter(slot => slot.endMs > 0);
  for (const slot of preexisting) for (const key of slot.keys) occupied.set(key, (occupied.get(key) ?? 0) + 1);
  let time = 0;
  const guardMax = ids.length * ids.length + ids.length + preexisting.length + 5;
  let guard = 0;

  const ready = (): string[] => {
    const list: string[] = [];
    for (const id of ids) {
      if (done.has(id) || running.has(id) || (resources?.releaseMs?.get(id) ?? 0) > time) continue;
      const preds = dependsOn.get(id) ?? [];
      if (preds.every((pred) => done.has(pred))) list.push(id);
    }
    list.sort((a, b) => {
      const delta = (priority.get(b) ?? 0) - (priority.get(a) ?? 0);
      if (delta !== 0) return delta;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return list;
  };

  while (done.size < ids.length) {
    guard += 1;
    if (guard > guardMax) return null;
    let progressed = false;
    // Close zero-duration stage chains at this clock tick before starting
    // other work or jumping to the next resource release.
    for (;;) {
      const milestones = ready().filter(id => (durationMs.get(id) ?? 0) === 0);
      if (!milestones.length) break;
      for (const id of milestones) {
        record(id, 0);
        done.add(id);
      }
      progressed = true;
    }
    if (done.size === ids.length) break;
    for (const id of ready()) {
      const duration = durationMs.get(id) ?? 0;
      if (duration <= 0) continue;
      const saturated = resourceKeys(id).filter(key => (occupied.get(key) ?? 0) >= (resources?.limits.get(key) ?? Infinity));
      if (running.size + preexisting.length >= cap) saturated.push("global");
      if (saturated.length) {
        delays.set(id, new Set([...(delays.get(id) ?? []), ...saturated]));
        continue;
      }
      record(id, duration);
      running.set(id, time + duration);
      adjust(id, 1);
      progressed = true;
    }
    if (done.size === ids.length) break;
    if (!running.size && progressed) continue;
    let next = Infinity;
    for (const finish of running.values()) if (finish < next) next = finish;
    for (const { endMs } of preexisting) next = Math.min(next, endMs);
    for (const id of ids) {
      const release = resources?.releaseMs?.get(id) ?? 0;
      if (release > time) next = Math.min(next, release);
    }
    if (!Number.isFinite(next)) return null;
    time = next;
    for (let i = preexisting.length - 1; i >= 0; i--) {
      const slot = preexisting[i]!;
      if (slot.endMs !== time) continue;
      for (const key of slot.keys) occupied.set(key, (occupied.get(key) ?? 1) - 1);
      preexisting.splice(i, 1);
    }
    for (const [id, finish] of [...running]) {
      if (finish === time) {
        running.delete(id);
        adjust(id, -1);
        done.add(id);
      }
    }
  }
  return { elapsed: time, intervals: [...intervals.values()] };
}

export function scheduleItems(
  ids: readonly string[],
  durationMs: ReadonlyMap<string, number>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
  cap: number | "unbounded",
  resources?: ScheduleResources,
): ScheduleResult {
  const cycles = findCycles(ids, dependsOn);
  if (cycles.length > 0 || ids.length === 0) {
    return {
      cycles,
      scheduleMs: ids.length === 0 && cycles.length === 0 ? 0 : null,
      criticalPathMs: ids.length === 0 && cycles.length === 0 ? 0 : null,
      criticalPath: [],
      serialMs: ids.length === 0 ? 0 : null,
      method: ids.length === 0 && cycles.length === 0 ? "critical-path" : "none",
      exact: ids.length === 0 && cycles.length === 0,
    };
  }
  const path = criticalPath(ids, durationMs, dependsOn);
  if (path === null) {
    return {
      cycles,
      scheduleMs: null,
      criticalPathMs: null,
      criticalPath: [],
      serialMs: null,
      method: "none",
      exact: false,
    };
  }
  let serial = 0;
  for (const id of ids) {
    const duration = durationMs.get(id) ?? 0;
    if (!Number.isSafeInteger(serial + duration)) {
      return { cycles, scheduleMs: null, criticalPathMs: path.ms, criticalPath: path.ids, serialMs: null, method: "none", exact: false };
    }
    serial += duration;
  }
  if (!resources && (cap === "unbounded" || cap >= ids.length)) {
    return {
      cycles,
      scheduleMs: path.ms,
      criticalPathMs: path.ms, criticalPath: path.ids,
      serialMs: serial,
      method: "critical-path",
      exact: true,
    };
  }
  const scheduled = listSchedule(ids, durationMs, dependsOn, cap === "unbounded" ? ids.length : cap, resources);
  if (scheduled === null) {
    return { cycles, scheduleMs: null, criticalPathMs: path.ms, criticalPath: path.ids, serialMs: serial, method: "none", exact: false };
  }
  const exact = scheduled.elapsed === path.ms || cap === 1 && !resources?.occupiedUntil?.length && !resources?.releaseMs?.size;
  return {
    cycles,
    scheduleMs: scheduled.elapsed, intervals: scheduled.intervals,
    criticalPathMs: path.ms, criticalPath: path.ids,
    serialMs: serial,
    method: exact && scheduled.elapsed === path.ms ? "critical-path" : "list-scheduling",
    exact,
  };
}
