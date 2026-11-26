/**
 * Persisted vertical order of the Kanban board (FO-KANBAN-URGENCY01).
 *
 * A reorder moves one task inside ITS OWN (project, column, urgency) group. It rewrites one `board_rank` row, or
 * renumbers that one group when two neighbours ran out of room; it never touches a task's status, urgency,
 * content, assignee, dependencies, runs or grants, and it does not go through the project lifecycle (a paused
 * project can be reordered without resuming it). The server enforces the urgency boundary: an anchor from another
 * urgency, column or project is refused, whatever the client drew.
 *
 * Concurrency: the whole read-plan-write runs in one IMMEDIATE transaction. A client states the column and urgency
 * it saw (`expected*`); if the task has moved since, the reorder is refused as stale and the canonical order is
 * returned so the board can redraw it. Replaying the same placement writes nothing.
 */
import { db, tasks } from "./db.ts";
import { notifySmartQueueChanged } from "./handsoff/queue-events.ts";
import { ownerProjectOf } from "./project-ownership.ts";
import { isUrgency, planReorder, type Placement } from "../shared/board-order.ts";
import type { Task } from "../shared/types.ts";

export class KanbanOrderError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly code: string, readonly order?: string[]) {
    super(message);
    this.name = "KanbanOrderError";
  }
}

export interface ReorderRequest {
  /** The column and urgency the client saw the task in. A mismatch is a stale request (409). */
  expectedColumn?: unknown;
  expectedUrgency?: unknown;
  placement?: unknown;
}

export interface ReorderResult {
  task: Task;
  /** The group's final order, top first (ids of every task of that project, column and urgency, archived included). */
  order: string[];
  /** Rows written (0 when the task was already there). */
  rowsWritten: number;
  renumbered: boolean;
}

function parsePlacement(raw: unknown): Placement | null {
  if (raw === "first" || raw === "last") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    const record = raw as Record<string, unknown>;
    if (keys.length === 1 && keys[0] === "after" && typeof record.after === "string" && record.after) return { after: record.after };
    if (keys.length === 1 && keys[0] === "before" && typeof record.before === "string" && record.before) return { before: record.before };
  }
  return null;
}

/** The project scope a task is ordered in: its registered owner project, else its own folder. */
const scopeOf = (workdir: string): string => ownerProjectOf(workdir) ?? workdir;

interface GroupRow { id: string; workdir: string; board_rank: number }

/** Every task of the same project, column and urgency, the way a full (unfiltered) board would list them. */
function groupRows(column: string, urgency: number, scope: string): GroupRow[] {
  return db
    .query<GroupRow, [string, number]>(`SELECT id, workdir, board_rank FROM tasks WHERE "column" = ? AND urgency = ? AND pipeline_parent_id IS NULL`)
    .all(column, urgency)
    .filter((row) => scopeOf(row.workdir) === scope);
}

export function reorderTask(taskId: unknown, request: ReorderRequest): ReorderResult {
  if (typeof taskId !== "string" || !taskId) throw new KanbanOrderError("A task is required.", 400, "task");
  const placement = parsePlacement(request.placement);
  if (!placement) throw new KanbanOrderError('placement must be "first", "last", { "after": id } or { "before": id }.', 400, "placement");
  if (!isUrgency(request.expectedUrgency)) throw new KanbanOrderError("expectedUrgency must be a whole number from 1 to 5.", 400, "expected-urgency");
  if (typeof request.expectedColumn !== "string" || !request.expectedColumn) throw new KanbanOrderError("expectedColumn is required.", 400, "expected-column");
  const expectedColumn = request.expectedColumn;
  const expectedUrgency = request.expectedUrgency;

  let changedScope: string | null = null;
  const result = db.transaction((): ReorderResult => {
    const task = tasks.get(taskId);
    if (!task) throw new KanbanOrderError("Task not found.", 404, "not-found");
    if (task.archivedAt != null) throw new KanbanOrderError("An archived task cannot be reordered. Unarchive it first.", 409, "archived");
    if (task.pipelineParentId) throw new KanbanOrderError("A pipeline step is ordered with its pipeline task.", 409, "pipeline-step");
    const scope = scopeOf(task.workdir);
    const urgency = task.urgency ?? 3;
    const rows = groupRows(task.column, urgency, scope);
    const group = rows.map((row) => ({ id: row.id, rank: row.board_rank }));
    // Stale: the task is no longer where the client saw it. The canonical order lets the board redraw.
    if (task.column !== expectedColumn || urgency !== expectedUrgency) {
      throw new KanbanOrderError("The task changed column or urgency since you saw it. The board was refreshed.", 409, "stale", group.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1)).map((row) => row.id));
    }
    const plan = planReorder(group, taskId, placement);
    if (plan === "unknown-task") throw new KanbanOrderError("Task not found.", 404, "not-found");
    if (plan === "self-anchor") throw new KanbanOrderError("A task cannot be placed relative to itself.", 400, "self-anchor");
    if (plan === "unknown-anchor") {
      // The anchor is in another urgency, column or project (or gone): the boundary is enforced here, not in the browser.
      throw new KanbanOrderError("That position is outside the task's urgency group. Tasks can be reordered only within the same urgency level.", 409, "outside-group", group.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1)).map((row) => row.id));
    }
    // Targeted writes: no `updated_at` bump (a reorder is not an edit), nothing but the rank changes.
    for (const write of plan.writes) db.run(`UPDATE tasks SET board_rank = ? WHERE id = ?`, [write.rank, write.id]);
    if (plan.writes.length > 0) changedScope = scope;
    return { task: tasks.get(taskId)!, order: plan.order, rowsWritten: plan.writes.length, renumbered: plan.renumbered };
  }).immediate();
  if (changedScope) notifySmartQueueChanged(changedScope, "reorder");
  return result;
}
