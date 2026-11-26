import { t as tr } from "@/i18n/core";
/**
 * Display helpers for task assignments on the company card.
 * Labels only. Nothing here counts work, cost, or a model.
 */

import { columnLabel } from "./status-presenters";
import type { AssignmentAction, AssignmentTaskVisibility, TaskAssignmentEvent } from "../../shared/assignments/types.ts";

export function assignmentColumnLabel(column: string | null, archived: boolean): string {
  const label = column ? columnLabel(column) : tr("common.unknown");
  if (!column && archived) return tr("common.archived_bdb865");
  return archived ? tr("common.archived_88889e", { p0: String(label) }) : label;
}

export function assignmentProvenanceLabel(provenance: string): string {
  return provenance === "owner" ? tr("common.owner") : provenance;
}

export function assignmentVisibilityNote(visibility: AssignmentTaskVisibility): string | null {
  if (visibility === "unattributed") return tr("common.this_task_s_project_is_no_longer_registered");
  if (visibility === "diverged") return tr("common.this_task_is_no_longer_attributed_to_the");
  if (visibility === "missing") return tr("common.this_task_is_no_longer_in_the_registry");
  return null;
}

export function assignmentActionLabel(action: AssignmentAction): string {
  if (action === "assigned") return tr("common.assigned");
  if (action === "reassigned") return tr("common.reassigned");
  return tr("common.unassigned");
}

function person(name: string | null): string {
  return name?.trim() || tr("common.unknown_employee");
}

export function assignmentHistoryDetail(event: Pick<TaskAssignmentEvent, "action" | "employeeName" | "previousEmployeeName">): string {
  if (event.action === "assigned") return tr("common.assigned_to", { p0: String(person(event.employeeName)) });
  if (event.action === "reassigned") return tr("common.reassigned_from_to", { p0: String(person(event.previousEmployeeName)), p1: String(person(event.employeeName)) });
  return tr("common.unassigned_from", { p0: String(person(event.employeeName)) });
}

export function unassignTaskConfirmCopy(title: string): { title: string; description: string; confirmLabel: string } {
  return {
    title: tr("common.unassign_this_task"),
    description: tr("common.will_have_no_worker_the_assignment_history_is", { p0: String(title || tr("common.this_task")) }),
    confirmLabel: tr("common.unassign"),
  };
}
