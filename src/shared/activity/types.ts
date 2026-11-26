/**
 * FO-015A.1 Company Activity Journal Types.
 *
 * Append-only structured activity journal for the ForgeOrbit virtual AI company.
 * Language-agnostic canonical representation suitable for future EN/RU localization.
 */

export type ActivityActorType = "owner" | "project-manager" | "employee" | "system";

export type ActivityTargetType =
  | "company"
  | "project"
  | "employee"
  | "task"
  | "proposal"
  | "execution"
  | "turn"
  | "browser-session"
  | "native-session";

export const ACTIVITY_EVENT_TYPES = [
  // Organization
  "employee.hired",
  "employee.archived",
  "employee.unarchived",
  "employee.assigned",
  "employee.unassigned",
  // Project Management
  "task.proposal.created",
  "task.assignment.proposed",
  "task.assignment.approved",
  "task.assignment.rejected",
  // Execution
  "execution.reviewed",
  "execution.approved",
  "execution.started",
  "run.completed",
  "run.failed",
  // Multi-Turn
  "turn.proposed",
  "turn.approved",
  "turn.submitted",
  "delivery.indeterminate",
  // Queue preparation opt-in (FO-ORCH06). Records only the Owner's switch; it
  // grants no permission to start, assign, retry or confirm anything.
  "queue.preparation.enabled",
  "queue.preparation.disabled",
  // Owner decisions about a queue and the batches handed to it (FO-ORCH07).
  // Each records one Owner act; none of them starts, assigns or confirms a run.
  "queue.plan.confirmed",
  "queue.paused",
  "queue.resumed",
  "queue.stopped",
  "queue.handoff.prepared",
  "queue.authorization.granted",
  "queue.authorization.revoked",
  // Bounded autonomous execution (FO-ORCH08). Each records one Owner act or one
  // state change of an Owner-approved grant; none of them starts a run.
  "autonomy.grant.approved",
  "autonomy.execution.started",
  "autonomy.grant.exhausted",
  "autonomy.grant.expired",
  "autonomy.grant.revoked",
  "autonomy.execution.blocked",
  "autonomy.execution.resumed",
  // FO-AUTONOMY-FULL01. Owner policy identity travels with every autonomous act.
  "autonomy.policy.activated",
  "autonomy.policy.paused",
  "autonomy.policy.resumed",
  "autonomy.policy.revoked",
  "autonomy.action.authorized",
  "autonomy.action.denied",
  "autonomy.emergency.stopped",
  "autonomy.test.observed",
  "autonomy.test.blocked",
  // Project permission request decided (run one project test). Outcome and authority only.
  "permission.test.finished",
  // Owner toggled project-scoped Development in a working copy.
  "permission.workspace_development.updated",
  // Owner saved a project's Work independently (hands-off) policy.
  "handsoff.policy.updated",
  // FO-DEPLOY01 deployment requests (dry-run only; no remote execution).
  "deployment.request.created",
  "deployment.request.approved",
  "deployment.request.rejected",
  "deployment.dry_run.completed",
  "deployment.execution.authorized",
  "deployment.execution.started",
  "deployment.execution.finished",
  "deployment.execution.reconciliation_required",
  // FO-QC-RECOVERY01. Each records one Owner act. None of them starts a Developer run or resumes a batch.
  "qc.recovery.reconciled",
  "qc.recovery.approved",
  "qc.recovery.started",
  "qc.recovery.cancelled",
  // FO-QC-PREFLIGHT01. Each records one Owner act on a single Bun test. None starts a Reviewer or a Developer.
  "qc.test.prepared",
  "qc.test.approved",
  "qc.test.executed",
  "qc.test.cancelled",
  // Direction 8. The Owner authorizes ONE additional review round after every round is used; the second records its use.
  // Neither starts a Developer, a test or a review, and neither approves any output.
  "qc.extension.authorized",
  "qc.extension.used",
  // FO-PROJECT-LIFECYCLE01. Project-wide AI execution Stop / Drain / Pause / Start transitions.
  "project.lifecycle.draining",
  "project.lifecycle.paused",
  "project.lifecycle.resumed",
  "project.lifecycle.reconciled",
  // FO-BRAIN03. A proposal is not a memory. Approval is the Owner act that creates one.
  "brain.proposal.created",
  "brain.proposal.approved",
  "brain.proposal.rejected",
  // FO-BROWSER01. Owner browser control only. Payloads carry hosts and reason codes, never page text.
  "browser.session.created",
  "browser.navigation.requested",
  "browser.navigation.accepted",
  "browser.navigation.refused",
  "browser.session.closed",
  "browser.session.failed",
  "browser.session.interrupted",
  // FO-BROWSER02. One Owner grant, one manager message, one browser action.
  "browser.agent.granted",
  "browser.agent.revoked",
  "browser.agent.action.accepted",
  "browser.agent.action.refused",
  "browser.agent.action.interrupted",
  // FO-NATIVE-CU01. Owner native session only. Payloads carry ids and reason codes, never UI text or screenshots.
  "native.session.created",
  "native.target.selected",
  "native.observation.requested",
  "native.action.approved",
  "native.action.completed",
  "native.action.refused",
  "native.action.interrupted",
  "native.session.closed",
  "native.session.interrupted",
  // FO-NATIVE-CU02. One Owner grant, one manager message, one native action.
  "native.agent.granted",
  "native.agent.revoked",
  "native.agent.action.accepted",
  "native.agent.action.refused",
  "native.agent.action.interrupted",
  // FO-SELF-IMPROVE01. Records one improvement decision. None of these events grants a permission.
  "improvement.candidate.proposed",
  "improvement.evaluated",
  "improvement.activated",
  "improvement.rolled_back",
  "usage.estimate.saved",
  "usage.pricing.saved",
  "usage.adjustment.recorded",
  "owner.trust.enrolled",
  "owner.trust.approved",
  "owner.trust.refused",
  "owner.trust.consumed",
  "owner.trust.revoked",
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

export interface ActivityEventRecord {
  sequence_id: number;
  id: string;
  event_type: ActivityEventType;
  schema_version: number;
  project_path: string | null;
  actor_type: ActivityActorType;
  actor_id: string | null;
  target_type: ActivityTargetType;
  target_id: string;
  task_id: string | null;
  run_id: string | null;
  execution_id: string | null;
  turn_id: string | null;
  employee_id: string | null;
  idempotency_key: string;
  source_event_id: string | null;
  payload_json: string;
  created_at: number;
}

export interface ActivityEvent {
  sequenceId: number;
  id: string;
  eventType: ActivityEventType;
  schemaVersion: number;
  projectPath: string | null;
  actorType: ActivityActorType;
  actorId: string | null;
  targetType: ActivityTargetType;
  targetId: string;
  taskId: string | null;
  runId: string | null;
  executionId: string | null;
  turnId: string | null;
  employeeId: string | null;
  idempotencyKey: string;
  sourceEventId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ActivityEventInput {
  id?: string;
  eventType: ActivityEventType;
  schemaVersion?: number;
  projectPath?: string | null;
  actorType: ActivityActorType;
  actorId?: string | null;
  targetType: ActivityTargetType;
  targetId: string;
  taskId?: string | null;
  runId?: string | null;
  executionId?: string | null;
  turnId?: string | null;
  employeeId?: string | null;
  idempotencyKey?: string;
  sourceEventId?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: number;
}

export interface ActivityQueryFilter {
  projectPath?: string;
  actorType?: ActivityActorType;
  actorId?: string;
  employeeId?: string;
  eventType?: string | string[];
  targetType?: ActivityTargetType;
  targetId?: string;
  taskId?: string;
  runId?: string;
  since?: number;
  until?: number;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string | number | null;
  direction?: "forward" | "backward";
}

export interface ActivityEventsResponse {
  events: ActivityEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}
