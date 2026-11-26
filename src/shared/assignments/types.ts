/**
 * Task assignment for one AI employee (FO-010C).
 *
 * The employee is an organizational identity. The assignment says which
 * worker is responsible for an existing task. It does not choose a harness,
 * account, model, or thinking effort, and it does not start a run.
 *
 * Model router handoff, when execution is added later:
 * the owner asks for a read-only POST /model-router/preview for this task,
 * reviews it, and approves a run through the existing supervised path.
 * That preview must stay out of this record. It does not change the
 * assignment, reserve quota, or prove which account ran.
 */

export const ASSIGNMENT_PROVENANCE = ["owner"] as const;
export type AssignmentProvenance = (typeof ASSIGNMENT_PROVENANCE)[number];

export const ASSIGNMENT_STATUSES = ["active", "unassigned"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ASSIGNMENT_ACTIONS = ["assigned", "reassigned", "unassigned"] as const;
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number];

/** Refusal when a worker still holds tasks. Employee moves do not transfer them. */
export const ACTIVE_TASK_ASSIGNMENT_GUARD =
  "This employee still has active task assignments. Unassign those tasks first. Assignments are not moved or deleted automatically.";

export const ASSIGNMENT_LIMITS = {
  history: 100,
  candidates: 200,
  bodyBytes: 8 * 1024,
} as const;

/**
 * Present on every assignment response so a caller can see that routing was
 * not invoked. Assignment code must not call the model router.
 */
export const ASSIGNMENT_ROUTER_HANDOFF = {
  status: "not-invoked",
  previewMethod: "POST",
  previewPath: "/model-router/preview",
  note: "An assignment does not call the model router, reserve quota, or record a harness, account, model, or thinking effort. The owner may request a read-only preview separately. A preview does not change the assignment or prove which account ran.",
} as const;

export type AssignmentRouterHandoff = typeof ASSIGNMENT_ROUTER_HANDOFF;

/** Why a stored assignment is or is not still inside its project. */
export type AssignmentTaskVisibility = "in-project" | "unattributed" | "diverged" | "missing";

export interface AssignmentTaskSnapshot {
  title: string | null;
  /** Kanban column id, when the task still exists. */
  column: string | null;
  archived: boolean;
  visibility: AssignmentTaskVisibility;
}

export interface TaskAssignment {
  id: string;
  taskId: string;
  projectPath: string;
  projectName: string | null;
  projectRegistered: boolean;
  employeeId: string;
  /** Current name, read at request time. History rows do not store it. */
  employeeName: string | null;
  status: AssignmentStatus;
  provenance: AssignmentProvenance;
  revision: number;
  createdAt: number;
  updatedAt: number;
  assignedAt: number;
  unassignedAt: number | null;
  task: AssignmentTaskSnapshot;
  routerHandoff: AssignmentRouterHandoff;
}

export interface TaskAssignmentEvent {
  id: number;
  assignmentId: string;
  taskId: string;
  projectPath: string;
  employeeId: string;
  employeeName: string | null;
  previousEmployeeId: string | null;
  previousEmployeeName: string | null;
  action: AssignmentAction;
  provenance: AssignmentProvenance;
  revision: number;
  at: number;
}

export interface AssignmentCandidate {
  id: string;
  title: string;
  column: string;
  assigneeEmployeeId: string | null;
}
