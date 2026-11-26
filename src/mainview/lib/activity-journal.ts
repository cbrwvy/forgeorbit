import type { ActivityEvent, ActivityEventType, ActivityQueryFilter } from "../../shared/activity/types.ts";

export const EVENT_STATUS = {
  "employee.hired": "included", "employee.archived": "archived", "employee.unarchived": "included",
  "employee.assigned": "included", "employee.unassigned": "removed",
  "task.proposal.created": "proposed", "task.assignment.proposed": "proposed",
  "task.assignment.approved": "approved", "task.assignment.rejected": "rejected",
  "execution.reviewed": "reviewed", "execution.approved": "approved", "execution.started": "started",
  "run.completed": "completed", "run.failed": "failed",
  "turn.proposed": "proposed", "turn.approved": "approved", "turn.submitted": "submitted",
  "delivery.indeterminate": "indeterminate",
  "queue.preparation.enabled": "enabled", "queue.preparation.disabled": "disabled",
  "queue.plan.confirmed": "confirmed", "queue.paused": "paused", "queue.resumed": "resumed", "queue.stopped": "stopped",
  "queue.handoff.prepared": "prepared", "queue.authorization.granted": "granted", "queue.authorization.revoked": "revoked",
  "autonomy.grant.approved": "approved", "autonomy.execution.started": "started", "autonomy.grant.exhausted": "exhausted",
  "autonomy.grant.expired": "expired", "autonomy.grant.revoked": "revoked", "autonomy.execution.blocked": "blocked",
  "autonomy.execution.resumed": "resumed",
  "autonomy.policy.activated": "approved",
  "autonomy.policy.paused": "paused",
  "autonomy.policy.resumed": "resumed",
  "autonomy.policy.revoked": "revoked",
  "autonomy.action.authorized": "approved",
  "autonomy.action.denied": "rejected",
  "autonomy.emergency.stopped": "stopped",
  "autonomy.test.observed": "completed",
  "autonomy.test.blocked": "blocked",
  "permission.test.finished": "finished",
  "permission.workspace_development.updated": "confirmed",
  "handsoff.policy.updated": "confirmed",
  "deployment.request.created": "proposed",
  "deployment.request.approved": "approved",
  "deployment.request.rejected": "rejected",
  "deployment.dry_run.completed": "completed",
  "deployment.execution.authorized": "authorized",
  "deployment.execution.started": "started",
  "deployment.execution.finished": "finished",
  "deployment.execution.reconciliation_required": "reconciliation",
  "qc.recovery.reconciled": "reconciliation",
  "qc.recovery.approved": "approved",
  "qc.recovery.started": "started",
  "qc.recovery.cancelled": "revoked",
  "qc.test.prepared": "prepared",
  "qc.test.approved": "approved",
  "qc.test.executed": "completed",
  "qc.test.cancelled": "revoked",
  "qc.extension.authorized": "approved",
  "qc.extension.used": "started",
  "project.lifecycle.draining": "draining",
  "project.lifecycle.paused": "paused",
  "project.lifecycle.resumed": "resumed",
  "project.lifecycle.reconciled": "reconciliation",
  "brain.proposal.created": "proposed",
  "brain.proposal.approved": "approved",
  "brain.proposal.rejected": "rejected",
  "browser.session.created": "started",
  "browser.navigation.requested": "proposed",
  "browser.navigation.accepted": "approved",
  "browser.navigation.refused": "rejected",
  "browser.session.closed": "completed",
  "browser.session.failed": "failed",
  "browser.session.interrupted": "indeterminate",
  "browser.agent.granted": "approved",
  "browser.agent.revoked": "revoked",
  "browser.agent.action.accepted": "approved",
  "browser.agent.action.refused": "rejected",
  "browser.agent.action.interrupted": "indeterminate",
  "native.session.created": "started",
  "native.target.selected": "approved",
  "native.observation.requested": "proposed",
  "native.action.approved": "approved",
  "native.action.completed": "completed",
  "native.action.refused": "rejected",
  "native.action.interrupted": "indeterminate",
  "native.session.closed": "completed",
  "native.session.interrupted": "indeterminate",
  "native.agent.granted": "approved",
  "native.agent.revoked": "revoked",
  "native.agent.action.accepted": "approved",
  "native.agent.action.refused": "rejected",
  "native.agent.action.interrupted": "indeterminate",
  "improvement.candidate.proposed": "proposed",
  "improvement.evaluated": "finished",
  "improvement.activated": "approved",
  "improvement.rolled_back": "revoked",
  "usage.estimate.saved": "included",
  "usage.pricing.saved": "included",
  "usage.adjustment.recorded": "included",
  "owner.trust.enrolled": "included",
  "owner.trust.approved": "approved",
  "owner.trust.refused": "rejected",
  "owner.trust.consumed": "confirmed",
  "owner.trust.revoked": "removed",
} as const satisfies Record<ActivityEventType, string>;

/** SQLite sequence is canonical, including equal or non-monotonic timestamps. */
export function mergeActivity(previous: ActivityEvent[], incoming: ActivityEvent[], projectPath?: string): ActivityEvent[] {
  const byId = new Map(previous.concat(incoming).filter(e => !projectPath || e.projectPath === projectPath).map(e => [e.id, e]));
  return [...byId.values()].sort((a, b) => b.sequenceId - a.sequenceId);
}
export function activityDay(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
/** Contiguous day groups preserve sequence ordering even if the clock moves back. */
export function groupActivity(events: ActivityEvent[]) {
  const groups: { key: string; at: number; events: ActivityEvent[] }[] = [];
  const occurrences = new Map<string, number>();
  for (const event of events) {
    const day = activityDay(event.createdAt);
    const last = groups.at(-1);
    if (last && activityDay(last.at) === day) last.events.push(event);
    else {
      const occurrence = occurrences.get(day) ?? 0;
      occurrences.set(day, occurrence + 1);
      groups.push({ key: `${day}:${occurrence}`, at: event.createdAt, events: [event] });
    }
  }
  return groups;
}
export function activityDateRange(from: string, to: string): Pick<ActivityQueryFilter, "from" | "to"> {
  const start = from ? new Date(`${from}T00:00:00`).getTime() : undefined;
  const end = to ? new Date(`${to}T00:00:00`).getTime() : undefined;
  if (start !== undefined && !Number.isFinite(start) || end !== undefined && !Number.isFinite(end)) throw new Error("date");
  const until = end === undefined ? undefined : new Date(new Date(end).setDate(new Date(end).getDate() + 1)).getTime() - 1;
  if (start !== undefined && until !== undefined && start > until) throw new Error("range");
  return { from: start, to: until };
}
