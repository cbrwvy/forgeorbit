/**
 * Structured task dependencies and priorities (FO-005C.1), per project.
 *
 * The scheduler of an approved execution batch reads these rows, never the
 * "## Depends on" Markdown in a prompt. Every change is validated and
 * written synchronously (no await between the check and the write), so two
 * requests can't sneak a cycle in between them. Links stay inside one
 * project, and a task never depends on itself.
 *
 * "Inside one project" uses the shared ownership contract
 * (`project-ownership.ts`): a task in a subfolder or a proven worktree of the
 * project counts; an ambiguous or escaping folder belongs to no project.
 * Writes re-check ownership fresh.
 */

import { executionBatches, taskScheduling, tasks } from "./db.ts";
import { notifySmartQueueChanged } from "./handsoff/queue-events.ts";
import { resolveProject } from "./environment/http.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { ownerProjectOf, projectTasks, projectWorkdirs, taskInProject } from "./project-ownership.ts";
import {
  dependencyReadiness,
  hasMarkdownDependencies,
  isActiveBatch,
  normalizeTaskPriority,
  sanitizeStoredBatch,
  validateDependencies,
  type DependencyInfo,
  type DependencyTaskRef,
  type TaskPriority,
  type TaskSchedulingView,
} from "../shared/task-scheduling.ts";
import type { ColumnId, Task } from "../shared/types.ts";

export type SchedulingResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

function fail<T>(status: number, error: string, body?: Record<string, unknown>): SchedulingResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

/** For validation: the task's owning project, fresh. A task no project
 *  owns gets a value that never equals a project path. */
export function dependencyRef(task: Task): DependencyTaskRef {
  const owner = ownerProjectOf(task.workdir, { fresh: true });
  return { id: task.id, projectPath: owner ?? `\u0000unowned:${task.workdir}`, title: task.title, pipelineStep: !!task.pipelineParentId };
}

export function dependencyInfo(projectPath: string, id: string, opts: { fresh?: boolean } = {}): DependencyInfo {
  const task = tasks.get(id);
  if (!task) return { exists: false, inProject: false, title: taskScheduling.deletedTitle(id) ?? id.slice(0, 8), column: null, archived: false };
  return { exists: true, inProject: taskInProject(task, projectPath, opts), title: task.title, column: task.column, archived: task.archivedAt != null };
}

function viewOf(projectPath: string, task: Task): TaskSchedulingView {
  const deps = taskScheduling.dependenciesOf(task.id);
  return {
    taskId: task.id,
    title: task.title,
    column: task.column,
    archived: task.archivedAt != null,
    priority: taskScheduling.priorityOf(task.id),
    dependsOn: deps.map((id) => {
      const info = dependencyInfo(projectPath, id);
      return { taskId: id, title: info.title, column: info.column, done: info.column === "done", exists: info.exists, inProject: info.inProject };
    }),
    dependents: taskScheduling.dependentsOf(task.id),
    readiness: dependencyReadiness(taskScheduling.blockingDependenciesOf(task.id), (id) => dependencyInfo(projectPath, id)),
    deletedDependencies: taskScheduling.tombstonesOf(task.id).map((row) => ({ taskId: row.missingId, title: row.title, deletedAt: row.deletedAt })),
    markdownDependencies: deps.length === 0 && hasMarkdownDependencies(task.prompt),
  };
}

function registered(rawPath: unknown): SchedulingResult<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

/** A top-level task of the project; another project's task reads as missing. */
function projectTask(projectPath: string, taskId: unknown): SchedulingResult<Task> {
  const task = typeof taskId === "string" ? tasks.get(taskId) : null;
  if (!task || !taskInProject(task, projectPath, { fresh: true })) return fail(404, "Task not found in this project.");
  if (task.pipelineParentId) return fail(409, "This is a step of a pipeline run. Schedule the pipeline task instead.");
  return { ok: true, value: task };
}

/** Priorities, dependencies and readiness of every unarchived top-level task. */
export function listScheduling(rawPath: unknown): SchedulingResult<{ tasks: TaskSchedulingView[] }> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const rows = projectTasks(project.value)
    .filter((task) => task.archivedAt == null)
    .map((task) => viewOf(project.value, task));
  return { ok: true, value: { tasks: rows } };
}

/** Approved, running or paused batches that include the task. */
export function activeBatchesFor(projectPath: string, taskId: string): string[] {
  return executionBatches.list(projectPath, 200)
    .map((raw) => {
      try {
        return sanitizeStoredBatch(JSON.parse(raw));
      } catch {
        return null;
      }
    })
    .filter((batch) => batch != null && isActiveBatch(batch.status) && batch.entries.some((entry) => entry.taskId === taskId))
    .map((batch) => batch!.id);
}

/**
 * Set a task's priority and/or replace its dependencies. Validated against
 * the project's whole graph; refused on a self-link, a missing or foreign
 * task, a pipeline step, or a cycle. Batches already approved keep their
 * frozen dependency list: a start whose live links differ is held.
 */
export function updateScheduling(
  rawPath: unknown,
  taskId: string,
  body: { priority?: unknown; dependsOn?: unknown; acknowledgeMissing?: unknown },
): SchedulingResult<{ task: TaskSchedulingView; affectsBatches: string[] }> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const found = projectTask(project.value, taskId);
  if (!found.ok) return found;
  const task = found.value;
  if (body.priority === undefined && body.dependsOn === undefined && body.acknowledgeMissing === undefined) {
    return fail(400, "Send priority, dependsOn, acknowledgeMissing, or a combination.");
  }
  // Clearing a deleted prerequisite is the Owner's explicit decision; it is
  // never implied by editing the other links.
  let clearMissing: string[] | null = null;
  if (body.acknowledgeMissing !== undefined) {
    if (!Array.isArray(body.acknowledgeMissing) || body.acknowledgeMissing.some((id) => typeof id !== "string" || !id || id.length > 200)) {
      return fail(400, "acknowledgeMissing must be a list of deleted task ids");
    }
    const known = new Set(taskScheduling.tombstonesOf(task.id).map((row) => row.missingId));
    const unknown = (body.acknowledgeMissing as string[]).filter((id) => !known.has(id));
    if (unknown.length > 0) return fail(404, "That deleted prerequisite is not recorded for this task.");
    clearMissing = body.acknowledgeMissing as string[];
  }
  let priority: TaskPriority | null = null;
  if (body.priority !== undefined) {
    priority = normalizeTaskPriority(body.priority);
    if (!priority) return fail(400, "priority must be critical, high, normal, or low");
  }
  let dependsOn: string[] | null = null;
  if (body.dependsOn !== undefined) {
    if (!Array.isArray(body.dependsOn) || body.dependsOn.some((id) => typeof id !== "string" || !id || id.length > 200)) {
      return fail(400, "dependsOn must be a list of task ids");
    }
    const checked = validateDependencies(
      dependencyRef(task),
      body.dependsOn as string[],
      (id) => {
        const target = tasks.get(id);
        return target ? dependencyRef(target) : null;
      },
      taskScheduling.edgesForProject(projectWorkdirs(project.value)),
    );
    if (!checked.ok) {
      const status = checked.code === "missing" ? 404 : checked.code === "too-many" ? 400 : 409;
      return fail(status, checked.error, { code: checked.code, ...(checked.cycle ? { cycle: checked.cycle } : {}) });
    }
    dependsOn = checked.dependsOn;
  }
  // Synchronous from here: validated and written with no await between.
  if (clearMissing) {
    taskScheduling.clearTombstones(task.id, clearMissing);
    announceDependencies(project.value, [task.id]);
  }
  if (priority) taskScheduling.setPriority(task.id, priority);
  if (dependsOn) {
    const changed = !sameIds(taskScheduling.dependenciesOf(task.id), dependsOn);
    taskScheduling.replaceDependencies(task.id, dependsOn);
    if (changed) {
      announceDependencies(project.value, [task.id]);
      notifySmartQueueChanged(project.value, "dependencies");
    }
  }
  return { ok: true, value: { task: viewOf(project.value, tasks.get(task.id)!), affectsBatches: activeBatchesFor(project.value, task.id) } };
}

/**
 * Write the dependencies a task proposal named (already resolved to task
 * ids) for tasks the proposal just created. Links that would be invalid —
 * a cycle, a foreign or missing task — are skipped and reported, never
 * forced. Idempotent.
 */
export function linkProposalDependencies(
  projectPath: string,
  links: { taskId: string; dependsOn: string[] }[],
): string[] {
  const warnings: string[] = [];
  const changed: string[] = [];
  for (const link of links) {
    const task = tasks.get(link.taskId);
    if (!task || !taskInProject(task, projectPath, { fresh: true })) continue;
    const existing = taskScheduling.dependenciesOf(task.id);
    const wanted = [...existing];
    for (const id of link.dependsOn) {
      if (wanted.includes(id)) continue;
      const checked = validateDependencies(
        dependencyRef(task),
        [...wanted, id],
        (other) => {
          const target = tasks.get(other);
          return target ? dependencyRef(target) : null;
        },
        taskScheduling.edgesForProject(projectWorkdirs(projectPath)),
      );
      if (!checked.ok) {
        warnings.push(`“${task.title}”: ${checked.error}`);
        continue;
      }
      wanted.push(id);
    }
    const added = wanted.filter((id) => !existing.includes(id));
    if (added.length > 0) {
      taskScheduling.addDependencies(task.id, added);
      changed.push(task.id);
    }
  }
  if (changed.length > 0) announceDependencies(projectPath, changed);
  return warnings;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** After the write: tell `/app/events` subscribers to re-read the links. */
function announceDependencies(projectPath: string, taskIds: string[]): void {
  broadcastAppEvent({ type: "task_dependencies", projectPath, taskIds, ts: Date.now() });
}
