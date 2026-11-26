/**
 * One fail-closed answer to "may this task start as far as its prerequisites
 * go?" (FO-ORCH05). Every start path asks it: the Task Plan View, batch
 * previews and launches, the employee preflight, the supervised review and
 * the orchestrator's own `startTask` (which also covers a manual re-run).
 *
 * A prerequisite counts only when its task is Done. A prerequisite that was
 * deleted keeps blocking through its tombstone (migration 093) until the
 * Owner clears it; a run that merely succeeded, a task in Review, an
 * archived or foreign prerequisite never opens the gate. A task with no
 * dependency rows and no tombstones is always open: nothing is invented.
 */

import { taskScheduling, tasks } from "./db.ts";
import { ownerProjectOf, taskInProject } from "./project-ownership.ts";
import { dependencyReadiness, type DependencyInfo } from "../shared/task-scheduling.ts";
import type { Task } from "../shared/types.ts";

export interface DependencyGateReason {
  taskId: string;
  code: "deleted" | "not-done" | "other-project" | "archived";
  message: string;
}

export interface DependencyGate {
  open: boolean;
  reasons: DependencyGateReason[];
}

// Local on purpose: `task-scheduling.ts` pulls in the HTTP layer, and the
// orchestrator (which asks this gate) must not import that.
function infoOf(projectPath: string, id: string, fresh: boolean): DependencyInfo {
  const task = tasks.get(id);
  if (!task) return { exists: false, inProject: false, title: taskScheduling.deletedTitle(id) ?? id.slice(0, 8), column: null, archived: false };
  return { exists: true, inProject: taskInProject(task, projectPath, { fresh }), title: task.title, column: task.column, archived: task.archivedAt != null };
}

export function dependencyGateFor(task: Task, opts: { fresh?: boolean } = {}): DependencyGate {
  if (task.pipelineParentId) return { open: true, reasons: [] };
  const reasons: DependencyGateReason[] = [];
  for (const row of taskScheduling.tombstonesOf(task.id)) {
    reasons.push({
      taskId: row.missingId,
      code: "deleted",
      message: `“${row.title}” was deleted. This task waited for it, so it stays blocked until you clear that link.`,
    });
  }
  const live = taskScheduling.dependenciesOf(task.id);
  if (live.length > 0) {
    const projectPath = ownerProjectOf(task.workdir, { fresh: opts.fresh ?? true }) ?? task.workdir;
    const info = (id: string) => infoOf(projectPath, id, opts.fresh ?? true);
    const readiness = dependencyReadiness(live, info);
    if (readiness.state === "blocked") {
      for (const by of readiness.by) {
        const dep = info(by.taskId);
        reasons.push({
          taskId: by.taskId,
          code: !dep.exists ? "deleted" : !dep.inProject ? "other-project" : "archived",
          message: by.reason,
        });
      }
    } else if (readiness.state === "waiting") {
      for (const id of readiness.on) {
        const dep = info(id);
        reasons.push({ taskId: id, code: "not-done", message: `“${dep.title}” is not Done yet (${dep.column ?? "unknown"}). A finished run in Review does not count.` });
      }
    }
  }
  return { open: reasons.length === 0, reasons };
}

/** Plain-text refusal for a start that must not proceed, or null when open. */
export function dependencyRefusal(taskId: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const gate = dependencyGateFor(task);
  if (gate.open) return null;
  return `dependencies are not satisfied — ${gate.reasons.map((r) => r.message).join(" ")}`;
}
