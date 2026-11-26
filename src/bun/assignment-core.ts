/**
 * AI employee task assignments (FO-010C).
 *
 * Links an existing task to one worker. Reads task ownership from the
 * project registry and writes only the assignment tables. It does not start
 * a run, call the model router, switch an account, or edit the task,
 * employee, project, or harness rows.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { validateProjectPath } from "../shared/clusters/paths.ts";
import {
  ACTIVE_TASK_ASSIGNMENT_GUARD,
  ASSIGNMENT_LIMITS,
  ASSIGNMENT_ROUTER_HANDOFF,
  type AssignmentAction,
  type AssignmentCandidate,
  type AssignmentProvenance,
  type AssignmentTaskVisibility,
  type TaskAssignment,
  type TaskAssignmentEvent,
} from "../shared/assignments/types.ts";
import { ownershipOf, type TaskOwnership } from "./project-ownership.ts";

export class AssignmentCoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AssignmentCoreError";
  }
}

export interface AssignmentCoreOptions {
  now?: () => number;
  /** Fresh ownership of one workdir. Tests inject the pure classifier. */
  classify?: (workdir: string) => TaskOwnership;
  /**
   * Test-only hook. Runs inside the write transaction before any read, so a
   * second connection can commit a conflicting row first. Production leaves
   * it unset.
   */
  beforeWrite?: () => void;
}

interface AssignmentRow {
  id: string;
  task_id: string;
  project_path: string;
  employee_id: string;
  status: "active" | "unassigned";
  provenance: AssignmentProvenance;
  revision: number;
  created_at: number;
  updated_at: number;
  assigned_at: number;
  unassigned_at: number | null;
}

interface EmployeeRow {
  id: string;
  kind: string;
  name: string;
  project_path: string | null;
  status: string;
  archived_at: number | null;
}

interface TaskRow {
  id: string;
  title: string;
  column_id: string;
  workdir: string;
  archived_at: number | null;
  pipeline_parent_id: string | null;
}

interface EventRow {
  id: number;
  assignment_id: string;
  task_id: string;
  project_path: string;
  employee_id: string;
  previous_employee_id: string | null;
  action: AssignmentAction;
  provenance: AssignmentProvenance;
  revision: number;
  created_at: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string, status = 400): never {
  throw new AssignmentCoreError(message, status);
}

export class AssignmentCore {
  private readonly now: () => number;
  private readonly classify: (workdir: string) => TaskOwnership;
  private readonly beforeWrite?: () => void;

  constructor(private readonly db: Database, options: AssignmentCoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.classify = options.classify ?? ((workdir) => ownershipOf(workdir, { fresh: true }));
    this.beforeWrite = options.beforeWrite;
  }

  assign(taskId: unknown, employeeId: unknown): { assignment: TaskAssignment; created: boolean } {
    const task = this.uuid(taskId, "taskId");
    const employee = this.uuid(employeeId, "employeeId");
    return this.write(() => {
      this.beforeWrite?.();
      this.lockEmployee(employee);
      const person = this.requireEmployee(employee);
      const active = this.activeRow(task);
      if (active?.employee_id === employee) return { assignment: this.view(active), created: false };
      if (active) fail("This task already has a worker. Reassign it explicitly.", 409);
      const row = this.requireTask(task);
      this.assertOpenTask(row);
      const ownership = this.assertOwned(row);
      this.assertWorker(person, ownership.projectPath);
      const now = this.now();
      const id = randomUUID();
      this.db.run(
        `INSERT INTO employee_task_assignments (
           id, task_id, project_path, employee_id, status, provenance, revision,
           created_at, updated_at, assigned_at, unassigned_at
         ) VALUES (?, ?, ?, ?, 'active', 'owner', 1, ?, ?, ?, NULL)`,
        [id, task, ownership.projectPath, employee, now, now, now],
      );
      this.markEstimatesStale(task);
      this.insertEvent({
        assignmentId: id,
        taskId: task,
        projectPath: ownership.projectPath,
        employeeId: employee,
        previousEmployeeId: null,
        action: "assigned",
        revision: 1,
        at: now,
      });
      new ActivityJournalCore(this.db).record({
        eventType: "employee.assigned",
        projectPath: ownership.projectPath,
        actorType: "owner",
        actorId: "owner",
        targetType: "task",
        targetId: task,
        taskId: task,
        employeeId: employee,
        idempotencyKey: `assignment:${id}:1`,
        payload: {
          assignmentId: id,
          taskId: task,
          taskTitle: row.title,
          employeeId: employee,
          employeeName: person.name,
          revision: 1,
          previousEmployeeId: null,
        },
        createdAt: now,
      });
      return { assignment: this.view(this.requireActive(task)), created: true };
    });
  }

  reassign(taskId: unknown, employeeId: unknown, expectedRevision: unknown): TaskAssignment {
    const task = this.uuid(taskId, "taskId");
    const employee = this.uuid(employeeId, "employeeId");
    const revision = this.revisionValue(expectedRevision);
    return this.write(() => {
      this.beforeWrite?.();
      const active = this.activeRow(task);
      if (!active) fail(this.missingAssignmentMessage(task), this.missingAssignmentStatus(task));
      if (active.employee_id === employee) fail("This task is already assigned to this employee.", 409);
      if (active.revision !== revision) fail("Assignment revision is stale. Refresh and try again.", 409);
      this.lockEmployee(employee);
      this.lockEmployee(active.employee_id);
      const current = this.activeRow(task);
      if (!current || current.revision !== revision || current.employee_id !== active.employee_id) {
        fail("This task's assignment changed concurrently. Refresh and try again.", 409);
      }
      const person = this.requireEmployee(employee);
      const row = this.requireTask(task);
      this.assertOpenTask(row);
      const ownership = this.assertOwned(row);
      if (ownership.projectPath !== current.project_path) {
        fail("This task is no longer in the project it was assigned from. Unassign it before assigning it again.", 409);
      }
      this.assertWorker(person, ownership.projectPath);
      const now = this.now();
      const next = current.revision + 1;
      const changed = this.db.run(
        `UPDATE employee_task_assignments
            SET employee_id = ?, revision = ?, assigned_at = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND revision = ?`,
        [employee, next, now, now, current.id, current.revision],
      ).changes;
      if (changed !== 1) fail("This task's assignment changed concurrently. Refresh and try again.", 409);
      this.markEstimatesStale(task);
      this.insertEvent({
        assignmentId: current.id,
        taskId: task,
        projectPath: current.project_path,
        employeeId: employee,
        previousEmployeeId: current.employee_id,
        action: "reassigned",
        revision: next,
        at: now,
      });
      new ActivityJournalCore(this.db).record({
        eventType: "employee.assigned",
        projectPath: current.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "task",
        targetId: task,
        taskId: task,
        employeeId: employee,
        idempotencyKey: `assignment:${current.id}:${next}`,
        payload: {
          assignmentId: current.id,
          taskId: task,
          taskTitle: row.title,
          employeeId: employee,
          employeeName: person.name,
          revision: next,
          previousEmployeeId: current.employee_id,
        },
        createdAt: now,
      });
      return this.view(this.requireActive(task));
    });
  }

  unassign(taskId: unknown, expectedRevision: unknown): TaskAssignment {
    const task = this.uuid(taskId, "taskId");
    const revision = this.revisionValue(expectedRevision);
    return this.write(() => {
      this.beforeWrite?.();
      const active = this.activeRow(task);
      if (!active) fail(this.missingAssignmentMessage(task), this.missingAssignmentStatus(task));
      if (active.revision !== revision) fail("Assignment revision is stale. Refresh and try again.", 409);
      this.lockEmployee(active.employee_id);
      const current = this.activeRow(task);
      if (!current || current.revision !== revision) {
        fail("This task's assignment changed concurrently. Refresh and try again.", 409);
      }
      const now = this.now();
      const next = current.revision + 1;
      const changed = this.db.run(
        `UPDATE employee_task_assignments
            SET status = 'unassigned', unassigned_at = ?, revision = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND revision = ?`,
        [now, next, now, current.id, current.revision],
      ).changes;
      if (changed !== 1) fail("This task's assignment changed concurrently. Refresh and try again.", 409);
      this.markEstimatesStale(task);
      this.insertEvent({
        assignmentId: current.id,
        taskId: task,
        projectPath: current.project_path,
        employeeId: current.employee_id,
        previousEmployeeId: null,
        action: "unassigned",
        revision: next,
        at: now,
      });
      new ActivityJournalCore(this.db).record({
        eventType: "employee.unassigned",
        projectPath: current.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "task",
        targetId: task,
        taskId: task,
        employeeId: current.employee_id,
        idempotencyKey: `assignment:${current.id}:${next}`,
        payload: {
          assignmentId: current.id,
          taskId: task,
          employeeId: current.employee_id,
          revision: next,
        },
        createdAt: now,
      });
      const stored = this.db.query<AssignmentRow, [string]>(`SELECT * FROM employee_task_assignments WHERE id = ?`).get(current.id);
      if (!stored) fail("Assignment could not be read back.", 500);
      return this.view(stored);
    });
  }

  /**
   * FO-DIRECTION12. The assigned worker is a planning input of a Backlog estimate: it selects the specialist
   * cohort and is saved with the estimate. Assigning, reassigning or removing the worker therefore marks the
   * task's saved (non-mission) revisions no longer current, the same way a scope or resource edit does, so a
   * start that did not re-estimate can never freeze a revision made for a different worker. Nothing is deleted
   * or rewritten and a run that already froze a revision keeps it. This is an explicit statement and not a
   * trigger on purpose: a trigger's row count would leak into the `.changes` checks above. Mission revisions
   * take the worker from the mission plan, not from this table.
   */
  private markEstimatesStale(taskId: string): void {
    this.db.run(
      `UPDATE usage_task_estimates SET superseded = 1 WHERE task_id = ? AND mission_id IS NULL AND superseded = 0`,
      [taskId],
    );
  }

  forTask(taskId: unknown): TaskAssignment | null {
    const task = this.uuid(taskId, "taskId");
    const active = this.activeRow(task);
    if (!active) {
      if (!this.taskRow(task)) fail("Task not found.", 404);
      return null;
    }
    return this.view(active);
  }

  forEmployee(employeeId: unknown): TaskAssignment[] {
    const employee = this.uuid(employeeId, "employeeId");
    this.requireEmployee(employee);
    return this.db.query<AssignmentRow, [string]>(
      `SELECT * FROM employee_task_assignments WHERE employee_id = ? AND status = 'active' ORDER BY assigned_at ASC, id ASC`,
    ).all(employee).map((row) => this.view(row));
  }

  /**
   * Active assignments whose task is still unambiguously inside this
   * registered project. A task that now belongs to another project is left
   * out, so this list cannot be used to read that other project.
   */
  forProject(projectPath: unknown): TaskAssignment[] {
    const project = this.requireProject(projectPath);
    return this.db.query<AssignmentRow, [string]>(
      `SELECT * FROM employee_task_assignments WHERE project_path = ? AND status = 'active' ORDER BY assigned_at ASC, id ASC`,
    ).all(project).filter((row) => this.visibility(row) === "in-project").map((row) => this.view(row));
  }

  history(scope: { taskId?: unknown; employeeId?: unknown; projectPath?: unknown }): { events: TaskAssignmentEvent[]; truncated: boolean } {
    const keys = (["taskId", "employeeId", "projectPath"] as const).filter((key) => scope[key] != null);
    if (keys.length !== 1) fail("History needs exactly one of taskId, employeeId, or projectPath.");
    const limit = ASSIGNMENT_LIMITS.history;
    if (scope.taskId != null) {
      const taskId = this.uuid(scope.taskId, "taskId");
      const events = this.eventRows(`WHERE task_id = ?`, [taskId], limit + 1);
      if (events.length === 0 && !this.taskRow(taskId)) fail("Task not found.", 404);
      return this.pageEvents(events, limit);
    }
    if (scope.employeeId != null) {
      const employeeId = this.uuid(scope.employeeId, "employeeId");
      this.requireEmployee(employeeId);
      const events = this.eventRows(
        `WHERE employee_id = ? OR previous_employee_id = ?`,
        [employeeId, employeeId],
        limit + 1,
      );
      return this.pageEvents(events, limit);
    }
    const project = this.requireProject(scope.projectPath);
    const events = this.eventRows(`WHERE project_path = ?`, [project], limit + 1).filter((event) => {
      const visibility = this.taskVisibility(event.task_id, event.project_path);
      return visibility === "in-project" || visibility === "missing" || visibility === "unattributed";
    });
    return this.pageEvents(events, limit);
  }

  candidates(employeeId: unknown): { tasks: AssignmentCandidate[]; truncated: boolean } {
    const id = this.uuid(employeeId, "employeeId");
    const employee = this.requireEmployee(id);
    if (employee.kind !== "worker" || employee.status !== "active" || employee.archived_at != null || !employee.project_path) {
      return { tasks: [], truncated: false };
    }
    if (!this.projectName(employee.project_path)) return { tasks: [], truncated: false };
    const rows = this.db.query<TaskRow, []>(
      `SELECT id, title, "column" AS column_id, workdir, archived_at, pipeline_parent_id
         FROM tasks
        WHERE pipeline_parent_id IS NULL AND archived_at IS NULL
        ORDER BY updated_at DESC, id ASC`,
    ).all();
    const assignees = new Map(this.db.query<{ task_id: string; employee_id: string }, []>(
      `SELECT task_id, employee_id FROM employee_task_assignments WHERE status = 'active'`,
    ).all().map((row) => [row.task_id, row.employee_id]));
    const matched: AssignmentCandidate[] = [];
    for (const row of rows) {
      const ownership = this.safeOwnership(row.workdir);
      if (ownership?.kind !== "owned" || ownership.projectPath !== employee.project_path) continue;
      matched.push({
        id: row.id,
        title: row.title,
        column: row.column_id,
        assigneeEmployeeId: assignees.get(row.id) ?? null,
      });
    }
    const open = matched.filter((task) => task.assigneeEmployeeId == null);
    return {
      tasks: open.slice(0, ASSIGNMENT_LIMITS.candidates),
      truncated: open.length > ASSIGNMENT_LIMITS.candidates,
    };
  }

  private view(row: AssignmentRow): TaskAssignment {
    const task = this.taskRow(row.task_id);
    const visibility = this.visibility(row);
    const showTask = visibility !== "missing";
    return {
      id: row.id,
      taskId: row.task_id,
      projectPath: row.project_path,
      projectName: this.projectName(row.project_path),
      projectRegistered: this.projectName(row.project_path) != null,
      employeeId: row.employee_id,
      employeeName: this.employeeName(row.employee_id),
      status: row.status,
      provenance: row.provenance,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      assignedAt: row.assigned_at,
      unassignedAt: row.unassigned_at,
      task: {
        title: showTask ? task?.title ?? null : null,
        column: showTask ? task?.column_id ?? null : null,
        archived: task?.archived_at != null,
        visibility,
      },
      routerHandoff: ASSIGNMENT_ROUTER_HANDOFF,
    };
  }

  private visibility(row: AssignmentRow): AssignmentTaskVisibility {
    return this.taskVisibility(row.task_id, row.project_path);
  }

  private taskVisibility(taskId: string, projectPath: string): AssignmentTaskVisibility {
    const task = this.taskRow(taskId);
    if (!task) return "missing";
    const ownership = this.safeOwnership(task.workdir);
    if (!ownership || ownership.kind !== "owned") return "unattributed";
    if (ownership.projectPath !== projectPath) return "diverged";
    return "in-project";
  }

  private safeOwnership(workdir: string): TaskOwnership | null {
    try {
      return this.classify(workdir);
    } catch {
      return null;
    }
  }

  private assertOwned(task: TaskRow): { projectPath: string } {
    const ownership = this.safeOwnership(task.workdir);
    if (!ownership || ownership.kind === "unattributed") {
      fail("This task has no registered project, so it cannot be assigned.", 409);
    }
    if (ownership.kind === "ambiguous") {
      fail("This task's folder matches more than one project, so it cannot be assigned.", 409);
    }
    return { projectPath: ownership.projectPath };
  }

  private assertOpenTask(task: TaskRow): void {
    if (task.pipeline_parent_id) fail("A pipeline step is not a board task and cannot be assigned.", 409);
    if (task.archived_at != null) fail("An archived task cannot be assigned.", 409);
  }

  private assertWorker(employee: EmployeeRow, projectPath: string): void {
    if (employee.kind !== "worker") fail("Only an active worker can be assigned to a task.", 409);
    if (employee.archived_at != null || employee.status === "archived") fail("Employee is archived.", 409);
    if (employee.status !== "active") fail("Only an active worker can be assigned to a task.", 409);
    if (!employee.project_path) fail("The employee is not assigned to a project.", 409);
    if (!this.projectName(employee.project_path)) fail("The employee's project is no longer registered.", 409);
    if (employee.project_path !== projectPath) fail("This employee is not an active worker of the task's project.", 409);
  }

  private missingAssignmentMessage(taskId: string): string {
    return this.taskRow(taskId) ? "This task has no active assignment." : "Task not found.";
  }

  private missingAssignmentStatus(taskId: string): number {
    return this.taskRow(taskId) ? 409 : 404;
  }

  private activeRow(taskId: string): AssignmentRow | null {
    return this.db.query<AssignmentRow, [string]>(
      `SELECT * FROM employee_task_assignments WHERE task_id = ? AND status = 'active'`,
    ).get(taskId) ?? null;
  }

  private requireActive(taskId: string): AssignmentRow {
    const row = this.activeRow(taskId);
    if (!row) fail("Assignment could not be read back.", 500);
    return row;
  }

  private requireEmployee(id: string): EmployeeRow {
    const row = this.db.query<EmployeeRow, [string]>(
      `SELECT id, kind, name, project_path, status, archived_at FROM ai_employees WHERE id = ?`,
    ).get(id);
    if (!row) fail("Employee not found.", 404);
    return row;
  }

  private requireTask(id: string): TaskRow {
    const row = this.taskRow(id);
    if (!row) fail("Task not found.", 404);
    return row;
  }

  private taskRow(id: string): TaskRow | null {
    return this.db.query<TaskRow, [string]>(
      `SELECT id, title, "column" AS column_id, workdir, archived_at, pipeline_parent_id FROM tasks WHERE id = ?`,
    ).get(id) ?? null;
  }

  private requireProject(projectPath: unknown): string {
    const parsed = validateProjectPath(projectPath);
    if (!parsed.ok) fail(parsed.error, 400);
    if (!this.projectName(parsed.path)) fail("Project is not registered.", 404);
    return parsed.path;
  }

  private projectName(projectPath: string): string | null {
    return this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(projectPath)?.name ?? null;
  }

  private employeeName(id: string): string | null {
    return this.db.query<{ name: string }, [string]>(`SELECT name FROM ai_employees WHERE id = ?`).get(id)?.name ?? null;
  }

  private lockEmployee(id: string): void {
    this.db.run(`UPDATE ai_employees SET updated_at = updated_at WHERE id = ?`, [id]);
  }

  private insertEvent(event: {
    assignmentId: string;
    taskId: string;
    projectPath: string;
    employeeId: string;
    previousEmployeeId: string | null;
    action: AssignmentAction;
    revision: number;
    at: number;
  }): void {
    this.db.run(
      `INSERT INTO employee_task_assignment_events (
         assignment_id, task_id, project_path, employee_id, previous_employee_id,
         action, provenance, revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?)`,
      [
        event.assignmentId,
        event.taskId,
        event.projectPath,
        event.employeeId,
        event.previousEmployeeId,
        event.action,
        event.revision,
        event.at,
      ],
    );
  }

  private eventRows(where: string, params: string[], limit: number): EventRow[] {
    return this.db.query<EventRow, Array<string | number>>(
      `SELECT * FROM employee_task_assignment_events ${where} ORDER BY id ASC LIMIT ?`,
    ).all(...params, limit);
  }

  private pageEvents(events: EventRow[], limit: number): { events: TaskAssignmentEvent[]; truncated: boolean } {
    const truncated = events.length > limit;
    return {
      events: events.slice(0, limit).map((event) => ({
        id: event.id,
        assignmentId: event.assignment_id,
        taskId: event.task_id,
        projectPath: event.project_path,
        employeeId: event.employee_id,
        employeeName: this.employeeName(event.employee_id),
        previousEmployeeId: event.previous_employee_id,
        previousEmployeeName: event.previous_employee_id ? this.employeeName(event.previous_employee_id) : null,
        action: event.action,
        provenance: event.provenance,
        revision: event.revision,
        at: event.created_at,
      })),
      truncated,
    };
  }

  private uuid(value: unknown, label: string): string {
    if (typeof value !== "string" || !UUID_RE.test(value)) fail(`Invalid ${label}.`);
    return value.toLowerCase();
  }

  private revisionValue(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("Invalid expectedRevision.");
    return value;
  }

  private write<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (error) {
      if (error instanceof AssignmentCoreError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint failed: employee_task_assignments/i.test(message) || /SQLITE_BUSY|database is locked/i.test(message)) {
        fail("This task's assignment changed concurrently. Refresh and try again.", 409);
      }
      throw error;
    }
  }
}

export { ACTIVE_TASK_ASSIGNMENT_GUARD };
