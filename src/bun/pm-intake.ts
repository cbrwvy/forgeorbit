/**
 * Server-side backlog → inbox admission and grant-backed PM promotions.
 */

import { canAdmitTaskToInbox, columnExecutionBlocked, parseIntakePromotionDrafts } from "../shared/pm-intake-promotion.ts";
import type { TaskRefLookup } from "../shared/project-manager.ts";
import type { Task } from "../shared/types.ts";
import { moveTaskColumn } from "./orchestrator.ts";
import { taskInProject } from "./project-ownership.ts";
import { tasks } from "./db.ts";
import { pmIntakeGrants } from "./pm-intake-grants.ts";

export { columnExecutionBlocked, canAdmitTaskToInbox };

export function admitTaskToInbox(taskId: string, projectPath: string): { ok: true; task: Task } | { ok: false; error: string } {
  const task = tasks.get(taskId);
  if (!task) return { ok: false, error: "Task not found." };
  if (!taskInProject(task, projectPath)) return { ok: false, error: "That task is not part of this project." };
  if (!canAdmitTaskToInbox(task)) {
    return { ok: false, error: task.column === "inbox" ? "This task is already in the project inbox." : "Only Backlog tasks can be admitted to the project inbox." };
  }
  moveTaskColumn(taskId, "inbox");
  const updated = tasks.get(taskId);
  return updated ? { ok: true, task: updated } : { ok: false, error: "Task not found." };
}

export interface ApplyIntakePromotionsResult {
  promoted: string[];
  skipped: string[];
  notes: string[];
}

/**
 * Apply `<intake_promotions>` from a manager reply when the owner granted
 * promotion on the same message. Without a valid grant, returns empty.
 */
export function applyManagerIntakePromotions(
  projectPath: string,
  messageId: string,
  grantId: string | null,
  replyText: string,
  lookup: TaskRefLookup,
): ApplyIntakePromotionsResult {
  const out: ApplyIntakePromotionsResult = { promoted: [], skipped: [], notes: [] };
  const parsed = parseIntakePromotionDrafts(replyText, lookup);
  out.notes.push(...parsed.errors);
  if (parsed.drafts.length === 0) return out;
  if (!grantId) {
    out.notes.push("Intake promotion was ignored: no owner grant on this message.");
    return out;
  }
  const grant = pmIntakeGrants.consume(projectPath, grantId, messageId);
  if (!grant.ok) {
    out.notes.push(grant.error);
    return out;
  }
  for (const draft of parsed.drafts) {
    if (grant.allowedTaskIds != null && !grant.allowedTaskIds.includes(draft.taskId)) {
      out.skipped.push(draft.taskId);
      out.notes.push(`#${draft.taskId.slice(0, 8)} was not covered by the intake grant.`);
      continue;
    }
    const result = admitTaskToInbox(draft.taskId, projectPath);
    if (result.ok) out.promoted.push(result.task.id);
    else {
      out.skipped.push(draft.taskId);
      out.notes.push(result.error);
    }
  }
  return out;
}

export function createIntakeGrant(projectPath: string, taskIds: string[] | null): { ok: true; grantId: string } | { ok: false; error: string } {
  const allowed = taskIds?.length
    ? taskIds.filter((id) => {
        const task = tasks.get(id);
        return task && taskInProject(task, projectPath) && canAdmitTaskToInbox(task);
      })
    : null;
  if (taskIds?.length && (!allowed || allowed.length === 0)) {
    return { ok: false, error: "None of those tasks can be admitted from Backlog." };
  }
  const grantId = pmIntakeGrants.create(projectPath, allowed);
  return { ok: true, grantId };
}
