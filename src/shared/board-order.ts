/**
 * Kanban urgency and vertical order (FO-KANBAN-URGENCY01). Pure, zero imports: the Bun server, the webview and the
 * tests all use these functions, so "what order is a column in" and "where does a dropped card go" cannot drift.
 *
 * Urgency (1..5, higher is more urgent) is a Kanban ordering attribute. It is deliberately NOT the scheduling
 * priority in `task_priorities` (four levels, read by the approved-batch scheduler and frozen into approvals):
 * nothing that decides what may run reads it, and changing it never starts, stops or re-grants anything.
 *
 * The displayed order of any list of tasks of one column is always
 *   1. urgency descending,
 *   2. rank ascending (the user's manual order inside the urgency),
 *   3. created time ascending, then id (a stable, deterministic tie-breaker).
 * A drag changes only the rank.
 */

export type Urgency = 1 | 2 | 3 | 4 | 5;

export const URGENCY_LEVELS: readonly Urgency[] = [5, 4, 3, 2, 1];
export const DEFAULT_URGENCY: Urgency = 3;
/** Distance between neighbouring ranks. A reorder rewrites one row unless two neighbours run out of room. */
export const RANK_STEP = 1024;

/** The i18n key of an urgency's label (Critical … Minimal). */
export const urgencyLabelKey = (urgency: Urgency): `kanban.urgency.${Urgency}` => `kanban.urgency.${urgency}`;

export function isUrgency(value: unknown): value is Urgency {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** A stored or received value read as an urgency; anything else (missing, NaN, out of range) is Normal. */
export function normalizeUrgency(value: unknown): Urgency {
  return isUrgency(value) ? value : DEFAULT_URGENCY;
}

export interface OrderedTask {
  id: string;
  urgency?: number | null;
  boardRank?: number | null;
  createdAt?: number | null;
}

const rankOf = (task: OrderedTask): number => (typeof task.boardRank === "number" && Number.isFinite(task.boardRank) ? task.boardRank : Number.MAX_SAFE_INTEGER);
const createdOf = (task: OrderedTask): number => (typeof task.createdAt === "number" && Number.isFinite(task.createdAt) ? task.createdAt : 0);

/** Comparator for tasks of one column: urgency descending, rank ascending, then created time and id. */
export function compareBoardTasks(a: OrderedTask, b: OrderedTask): number {
  const urgency = normalizeUrgency(b.urgency) - normalizeUrgency(a.urgency);
  if (urgency !== 0) return urgency;
  const rank = rankOf(a) - rankOf(b);
  if (rank !== 0) return rank > 0 ? 1 : -1;
  const created = createdOf(a) - createdOf(b);
  if (created !== 0) return created > 0 ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortBoardTasks<T extends OrderedTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort(compareBoardTasks);
}

export interface UrgencyGroup<T> { urgency: Urgency; tasks: T[] }

/** Splits an already sorted column into its urgency groups (only the levels that contain tasks). */
export function groupByUrgency<T extends OrderedTask>(sorted: readonly T[]): UrgencyGroup<T>[] {
  const groups: UrgencyGroup<T>[] = [];
  for (const task of sorted) {
    const urgency = normalizeUrgency(task.urgency);
    const last = groups[groups.length - 1];
    if (last && last.urgency === urgency) last.tasks.push(task);
    else groups.push({ urgency, tasks: [task] });
  }
  return groups;
}

/**
 * Where a card goes inside its own (project, column, urgency) group, named against another task of that group:
 * directly after it, directly before it, or at either end. A filtered view names its VISIBLE neighbour; the
 * placement is then applied to the full group (hidden tasks keep their relative order).
 */
export type Placement =
  | { after: string }
  | { before: string }
  | "first"
  | "last";

export interface RankedId { id: string; rank: number }

export interface ReorderPlan {
  /** Rows to write. Empty when the task is already where the placement puts it. */
  writes: RankedId[];
  /** The group's final order, top first. */
  order: string[];
  /** True when two neighbours had no room and the whole group was renumbered. */
  renumbered: boolean;
}

export type ReorderRefusal = "unknown-task" | "unknown-anchor" | "self-anchor";

function sortedGroup(group: readonly RankedId[]): RankedId[] {
  return [...group].sort((a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? -1 : 1) : a.id < b.id ? -1 : 1));
}

/**
 * Computes the rows that move `taskId` to `placement` inside `group` (the group's current ranks, any order).
 * Duplicate ranks are repaired by renumbering. Deterministic and idempotent: planning the same placement again on
 * the result writes nothing.
 */
export function planReorder(group: readonly RankedId[], taskId: string, placement: Placement): ReorderPlan | ReorderRefusal {
  if (!group.some((row) => row.id === taskId)) return "unknown-task";
  const ordered = sortedGroup(group);
  const currentOrder = ordered.map((row) => row.id);
  const rest = ordered.filter((row) => row.id !== taskId);
  let index: number;
  if (placement === "first") index = 0;
  else if (placement === "last") index = rest.length;
  else {
    const anchorId = "after" in placement ? placement.after : placement.before;
    if (anchorId === taskId) return "self-anchor";
    const at = rest.findIndex((row) => row.id === anchorId);
    if (at < 0) return "unknown-anchor";
    index = "after" in placement ? at + 1 : at;
  }
  const finalOrder = [...rest.slice(0, index).map((row) => row.id), taskId, ...rest.slice(index).map((row) => row.id)];
  const self = ordered.find((row) => row.id === taskId)!;
  const hasDuplicates = ordered.some((row, i) => i > 0 && row.rank === ordered[i - 1]!.rank);
  if (!hasDuplicates && finalOrder.every((id, i) => id === currentOrder[i])) return { writes: [], order: finalOrder, renumbered: false };

  const prev = index > 0 ? rest[index - 1]! : null;
  const next = index < rest.length ? rest[index]! : null;
  let rank: number | null = null;
  if (!hasDuplicates) {
    if (!prev && !next) rank = self.rank;
    else if (!prev) rank = next!.rank - RANK_STEP;
    else if (!next) rank = prev.rank + RANK_STEP;
    else if (next.rank - prev.rank >= 2) rank = prev.rank + Math.floor((next.rank - prev.rank) / 2);
  }
  if (rank !== null && Number.isSafeInteger(rank)) return { writes: rank === self.rank ? [] : [{ id: taskId, rank }], order: finalOrder, renumbered: false };

  // No room (or repaired duplicates): renumber the whole group in its final order, writing only rows that change.
  const byId = new Map(group.map((row) => [row.id, row.rank]));
  const writes = finalOrder.flatMap((id, i) => (byId.get(id) === (i + 1) * RANK_STEP ? [] : [{ id, rank: (i + 1) * RANK_STEP }]));
  return { writes, order: finalOrder, renumbered: true };
}

/** The next rank at the end of a group: after the largest existing one. */
export function endRank(ranks: readonly number[]): number {
  const max = ranks.reduce((m, r) => (Number.isFinite(r) && r > m ? r : m), 0);
  return max + RANK_STEP;
}

/**
 * Turns the order a drag produced into a placement against a same-project neighbour. `visibleGroup` is the
 * visible, sorted group after the move (it may hold tasks of other projects in an all-projects view or tasks hidden
 * by nothing); `projectOf` names a task's project scope. Prefers the nearest previous task of the same project,
 * falls back to the nearest following one.
 */
export function placementForMoved(visibleGroupAfterMove: readonly { id: string }[], movedId: string, projectOf: (id: string) => string): Placement | null {
  const at = visibleGroupAfterMove.findIndex((row) => row.id === movedId);
  if (at < 0) return null;
  const scope = projectOf(movedId);
  for (let i = at - 1; i >= 0; i--) if (projectOf(visibleGroupAfterMove[i]!.id) === scope) return { after: visibleGroupAfterMove[i]!.id };
  for (let i = at + 1; i < visibleGroupAfterMove.length; i++) if (projectOf(visibleGroupAfterMove[i]!.id) === scope) return { before: visibleGroupAfterMove[i]!.id };
  return "last";
}

/** Moves one item of an array by `delta` places, clamped to the array (the keyboard path inside a group). */
export function moveWithinGroup<T extends { id: string }>(group: readonly T[], id: string, delta: number | "start" | "end"): T[] {
  const from = group.findIndex((row) => row.id === id);
  if (from < 0) return [...group];
  const target = delta === "start" ? 0 : delta === "end" ? group.length - 1 : Math.max(0, Math.min(group.length - 1, from + delta));
  const next = [...group];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}
