/**
 * Organizational assignment proposals (FO-010D).
 *
 * A proposal is a durable, reviewable suggestion: "this worker could take this
 * task". It lives in its own tables. It becomes an assignment only when the
 * owner approves it, and then only through the existing FO-010C
 * AssignmentCore (same validation, same events, same optimistic revision).
 *
 * This module never starts a run, calls the model router, switches an
 * account, reads a path from a client, or edits tasks, employees or projects.
 * Writes touch assignment_proposals / assignment_proposal_events, plus the
 * FO-010C assignment tables through the core on approval.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { validateProjectPath } from "../shared/clusters/paths.ts";
import {
  PROPOSAL_EXECUTION_NOTE,
  PROPOSAL_LIMITS,
  PROPOSAL_STATUSES,
  STALE_REASONS,
  type AssignmentDraft,
  type AssignmentProposal,
  type AssignmentProposalEvent,
  type ProposalAction,
  type ProposalActor,
  type ProposalAuthor,
  type ProposalStatus,
  type ProposalSummary,
  type ProposalTaskVisibility,
  type TeamPromptMember,
  workerRefOf,
} from "../shared/assignments/proposals.ts";
import { AssignmentCore, AssignmentCoreError } from "./assignment-core.ts";
import { ownershipOf, type TaskOwnership } from "./project-ownership.ts";

export class AssignmentProposalError extends Error {
  constructor(message: string, readonly status = 400, readonly proposal?: AssignmentProposal) {
    super(message);
    this.name = "AssignmentProposalError";
  }
}

export interface AssignmentProposalOptions {
  now?: () => number;
  /** Fresh ownership of one workdir. Tests inject the pure classifier. */
  classify?: (workdir: string) => TaskOwnership;
}

interface ProposalRow {
  id: string;
  task_id: string;
  project_path: string;
  employee_id: string;
  proposed_by_kind: ProposalAuthor;
  proposed_by_employee_id: string | null;
  delegation_id: string | null;
  source_message_id: string | null;
  rationale: string;
  status: ProposalStatus;
  revision: number;
  base_assignee_id: string | null;
  base_assignment_revision: number | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_from_revision: number | null;
  decision_reassign: number | null;
  stale_reason: string | null;
  assignment_id: string | null;
  result_assignment_revision: number | null;
}

interface EventRow {
  id: number;
  proposal_id: string;
  task_id: string;
  project_path: string;
  employee_id: string;
  action: ProposalAction;
  actor: ProposalActor;
  proposal_revision: number;
  reassign: number | null;
  assignment_id: string | null;
  assignment_revision: number | null;
  note: string | null;
  created_at: number;
}

interface TaskRow {
  id: string;
  title: string;
  column_id: string;
  workdir: string;
  archived_at: number | null;
  pipeline_parent_id: string | null;
}

interface EmployeeRow {
  id: string;
  kind: string;
  name: string;
  job_title: string;
  project_path: string | null;
  status: string;
  archived_at: number | null;
}

interface ActiveRow {
  id: string;
  employee_id: string;
  revision: number;
}

export interface ApproveBody {
  expectedRevision: unknown;
  expectedAssignmentRevision: unknown;
  allowReassign: unknown;
}

export interface ProposalFilter {
  projectPath?: unknown;
  status?: unknown;
  taskId?: unknown;
  employeeId?: unknown;
}

export interface ManagerContext {
  messageId: string | null;
  delegationId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string, status = 400, proposal?: AssignmentProposal): never {
  throw new AssignmentProposalError(message, status, proposal);
}

export class AssignmentProposalCore {
  private readonly now: () => number;
  private readonly classify: (workdir: string) => TaskOwnership;

  constructor(
    private readonly db: Database,
    private readonly assignments: AssignmentCore,
    options: AssignmentProposalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.classify = options.classify ?? ((workdir) => ownershipOf(workdir, { fresh: true }));
  }

  /* ──────────────────────────── creation ──────────────────────────── */

  /**
   * Owner-entered proposal. The project is derived from the task's own
   * ownership; no project path is accepted from the caller.
   */
  create(taskId: unknown, employeeId: unknown, rationale: unknown): AssignmentProposal {
    const task = this.uuid(taskId, "taskId");
    const employee = this.uuid(employeeId, "employeeId");
    const reason = this.rationaleValue(rationale);
    const id = this.write(() => this.insertProposal({ task, employee, reason, project: null, author: "owner", authorEmployee: null, ctx: { messageId: null, delegationId: null } }));
    return this.get(id);
  }

  /**
   * Suggestions from a project manager's reply. Untrusted: every ref is
   * resolved against this project's own tasks and workers, and every entry
   * passes the same checks as an owner-entered one. A bad entry is dropped
   * with a short note; it never fails the others.
   */
  createFromManager(
    projectPath: string,
    drafts: readonly AssignmentDraft[],
    ctx: ManagerContext,
  ): { created: AssignmentProposal[]; dropped: string[] } {
    const created: AssignmentProposal[] = [];
    const dropped: string[] = [];
    if (!this.projectName(projectPath)) return { created, dropped: ["The project is not registered, so no suggestion was recorded."] };
    const manager = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM ai_employees WHERE kind = 'project-manager' AND project_path = ? AND archived_at IS NULL`,
    ).get(projectPath)?.id ?? null;
    for (const draft of drafts.slice(0, PROPOSAL_LIMITS.perReply)) {
      try {
        const task = this.resolveTaskRef(draft.taskRef);
        const employee = this.resolveWorkerRef(projectPath, draft.workerRef);
        const id = this.write(() =>
          this.insertProposal({
            task,
            employee,
            reason: this.rationaleValue(draft.rationale),
            project: projectPath,
            author: "project-manager",
            authorEmployee: manager,
            ctx,
          }));
        created.push(this.get(id));
      } catch (error) {
        const message = error instanceof AssignmentProposalError || error instanceof AssignmentCoreError
          ? error.message
          : "It could not be recorded.";
        dropped.push(`#${draft.taskRef} → w:${draft.workerRef}: ${message}`);
      }
    }
    return { created, dropped };
  }

  private insertProposal(input: {
    task: string;
    employee: string;
    reason: string;
    /** Required project (manager path). Null derives it from the task. */
    project: string | null;
    author: ProposalAuthor;
    authorEmployee: string | null;
    ctx: ManagerContext;
  }): string {
    const task = this.requireTask(input.task);
    this.assertEligibleTask(task);
    const ownership = this.safeOwnership(task.workdir);
    if (!ownership || ownership.kind === "unattributed") fail("This task has no registered project.", 409);
    if (ownership.kind === "ambiguous") fail("This task's folder matches more than one project.", 409);
    const project = ownership.projectPath;
    if (input.project != null && input.project !== project) fail("This task is not in this project.", 409);
    if (!this.projectName(project)) fail("The task's project is no longer registered.", 409);

    const person = this.requireEmployee(input.employee);
    const problem = this.workerProblem(person, project);
    if (problem) fail(problem, 409);

    const active = this.activeRow(task.id);
    if (active?.employee_id === person.id) fail(STALE_REASONS.alreadyAssigned, 409);

    const pending = this.db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM assignment_proposals WHERE project_path = ? AND status = 'pending'`,
    ).get(project)?.n ?? 0;
    if (pending >= PROPOSAL_LIMITS.pendingPerProject) fail("This project has too many pending proposals. Decide some first.", 409);

    const now = this.now();
    const id = randomUUID();
    try {
      this.db.run(
        `INSERT INTO assignment_proposals (
           id, task_id, project_path, employee_id, proposed_by_kind, proposed_by_employee_id,
           delegation_id, source_message_id, rationale, status, revision,
           base_assignee_id, base_assignment_revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
        [
          id, task.id, project, person.id, input.author, input.authorEmployee,
          input.ctx.delegationId, input.ctx.messageId, input.reason,
          active?.employee_id ?? null, active?.revision ?? null, now, now,
        ],
      );
    } catch (error) {
      if (/UNIQUE constraint failed: assignment_proposals\.task_id/i.test(error instanceof Error ? error.message : "")) {
        fail("This task already has a pending proposal. Decide or cancel it first.", 409);
      }
      throw error;
    }
    this.insertEvent({
      proposalId: id, taskId: task.id, project, employee: person.id, action: "created",
      actor: input.author, revision: 1, reassign: null, assignmentId: null, assignmentRevision: null,
      note: input.ctx.delegationId ? "from a delegated request" : null, at: now,
    });
    new ActivityJournalCore(this.db).record({
      eventType: "task.assignment.proposed",
      projectPath: project,
      actorType: input.author === "project-manager" ? "project-manager" : "owner",
      actorId: input.authorEmployee ?? (input.author === "project-manager" ? "project-manager" : "owner"),
      targetType: "proposal",
      targetId: id,
      taskId: task.id,
      employeeId: person.id,
      idempotencyKey: `assignment_proposal:${id}:created`,
      payload: {
        proposalId: id,
        taskId: task.id,
        employeeId: person.id,
        employeeName: person.name,
        rationale: input.reason,
        delegationId: input.ctx.delegationId,
      },
      createdAt: now,
    });
    return id;
  }

  /* ──────────────────────────── decisions ──────────────────────────── */

  approve(id: unknown, body: ApproveBody, validateRouting?: () => string | null): { proposal: AssignmentProposal; alreadyApplied: boolean } {
    const proposalId = this.uuid(id, "proposal id");
    const expected = this.revisionValue(body.expectedRevision, "expectedRevision");
    const expectedAssignment = this.nullableRevision(body.expectedAssignmentRevision);
    if (typeof body.allowReassign !== "boolean") fail("Invalid allowReassign.");
    const allowReassign = body.allowReassign;

    type Outcome =
      | { kind: "done"; alreadyApplied: boolean }
      | { kind: "stale"; reason: string };
    const outcome = this.write<Outcome>(() => {
      const row = this.requireRow(proposalId);
      if (row.status === "approved") {
        if (row.decided_from_revision === expected) return { kind: "done", alreadyApplied: true };
        fail("This proposal was already approved.", 409);
      }
      if (row.status !== "pending") fail(`This proposal is ${row.status}.`, 409);
      if (row.revision !== expected) fail("This proposal changed. Refresh and review it again.", 409);

      const stale = this.evaluate(row);
      if (stale) {
        this.markStale(row, stale);
        return { kind: "stale", reason: stale };
      }

      const active = this.activeRow(row.task_id);
      const currentRevision = active?.revision ?? null;
      if (currentRevision !== expectedAssignment) fail("The task's assignment changed since you reviewed this. Refresh and review it again.", 409);

      const routingProblem = validateRouting?.();
      if (routingProblem) fail(routingProblem, 409);
      const now = this.now();
      let assignmentId: string;
      let assignmentRevision: number | null;
      let reassigned = false;
      try {
        if (active) {
          if (!allowReassign) fail("This task already has a worker. Approving replaces that worker, so it needs your explicit consent to reassign.", 409);
          const result = this.assignments.reassign(row.task_id, row.employee_id, active.revision);
          assignmentId = result.id;
          assignmentRevision = result.revision;
          reassigned = true;
        } else {
          const result = this.assignments.assign(row.task_id, row.employee_id);
          assignmentId = result.assignment.id;
          assignmentRevision = result.assignment.revision;
        }
      } catch (error) {
        if (error instanceof AssignmentCoreError) fail(error.message, error.status);
        throw error;
      }

      const changed = this.db.run(
        `UPDATE assignment_proposals
            SET status = 'approved', revision = revision + 1, updated_at = ?, decided_at = ?,
                decided_from_revision = ?, decision_reassign = ?, assignment_id = ?, result_assignment_revision = ?
          WHERE id = ? AND status = 'pending' AND revision = ?`,
        [now, now, row.revision, reassigned ? 1 : 0, assignmentId, assignmentRevision, row.id, row.revision],
      ).changes;
      if (changed !== 1) fail("This proposal changed concurrently. Refresh and try again.", 409);
      this.insertEvent({
        proposalId: row.id, taskId: row.task_id, project: row.project_path, employee: row.employee_id,
        action: "approved", actor: "owner", revision: row.revision + 1, reassign: reassigned,
        assignmentId, assignmentRevision, note: null, at: now,
      });
      new ActivityJournalCore(this.db).record({
        eventType: "task.assignment.approved",
        projectPath: row.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "proposal",
        targetId: row.id,
        taskId: row.task_id,
        employeeId: row.employee_id,
        idempotencyKey: `assignment_proposal:${row.id}:approved`,
        payload: {
          proposalId: row.id,
          taskId: row.task_id,
          employeeId: row.employee_id,
          assignmentId,
          assignmentRevision,
        },
        createdAt: now,
      });
      return { kind: "done", alreadyApplied: false };
    });

    if (outcome.kind === "stale") fail(outcome.reason, 409, this.get(proposalId));
    return { proposal: this.get(proposalId), alreadyApplied: outcome.alreadyApplied };
  }

  reject(id: unknown, expectedRevision: unknown): { proposal: AssignmentProposal; alreadyApplied: boolean } {
    return this.close(id, expectedRevision, "rejected");
  }

  cancel(id: unknown, expectedRevision: unknown): { proposal: AssignmentProposal; alreadyApplied: boolean } {
    return this.close(id, expectedRevision, "cancelled");
  }

  private close(id: unknown, expectedRevision: unknown, target: "rejected" | "cancelled"): { proposal: AssignmentProposal; alreadyApplied: boolean } {
    const proposalId = this.uuid(id, "proposal id");
    const expected = this.revisionValue(expectedRevision, "expectedRevision");
    const replay = this.write(() => {
      const row = this.requireRow(proposalId);
      if (row.status === target) {
        if (row.decided_from_revision === expected) return true;
        fail(`This proposal was already ${target}.`, 409);
      }
      if (row.status !== "pending") fail(`This proposal is ${row.status}.`, 409);
      if (row.revision !== expected) fail("This proposal changed. Refresh and review it again.", 409);
      const now = this.now();
      const changed = this.db.run(
        `UPDATE assignment_proposals
            SET status = ?, revision = revision + 1, updated_at = ?, decided_at = ?, decided_from_revision = ?
          WHERE id = ? AND status = 'pending' AND revision = ?`,
        [target, now, now, row.revision, row.id, row.revision],
      ).changes;
      if (changed !== 1) fail("This proposal changed concurrently. Refresh and try again.", 409);
      this.insertEvent({
        proposalId: row.id, taskId: row.task_id, project: row.project_path, employee: row.employee_id,
        action: target, actor: "owner", revision: row.revision + 1, reassign: null,
        assignmentId: null, assignmentRevision: null, note: null, at: now,
      });
      if (target === "rejected") {
        new ActivityJournalCore(this.db).record({
          eventType: "task.assignment.rejected",
          projectPath: row.project_path,
          actorType: "owner",
          actorId: "owner",
          targetType: "proposal",
          targetId: row.id,
          taskId: row.task_id,
          employeeId: row.employee_id,
          idempotencyKey: `assignment_proposal:${row.id}:rejected`,
          payload: {
            proposalId: row.id,
            taskId: row.task_id,
            employeeId: row.employee_id,
          },
          createdAt: now,
        });
      }
      return false;
    });
    return { proposal: this.get(proposalId), alreadyApplied: replay };
  }

  /* ──────────────────────────── staleness ──────────────────────────── */

  /**
   * First reason a pending proposal is no longer valid, or null. Reads fresh
   * ownership, so a task moved to another project or a worker moved away is
   * caught. A project moving between clusters changes none of this: the
   * canonical project path is what a proposal pins, not its cluster.
   */
  private evaluate(row: ProposalRow): string | null {
    if (!this.projectName(row.project_path)) return STALE_REASONS.projectRemoved;
    const task = this.taskRow(row.task_id);
    if (!task) return STALE_REASONS.taskMissing;
    if (task.archived_at != null) return STALE_REASONS.taskArchived;
    if (task.pipeline_parent_id) return STALE_REASONS.taskStep;
    if (task.column_id === "done") return STALE_REASONS.taskDone;
    const ownership = this.safeOwnership(task.workdir);
    if (!ownership || ownership.kind === "unattributed") return STALE_REASONS.taskUnattributed;
    if (ownership.kind === "ambiguous") return STALE_REASONS.taskAmbiguous;
    if (ownership.projectPath !== row.project_path) return STALE_REASONS.taskMoved;

    const person = this.employeeRow(row.employee_id);
    if (!person) return STALE_REASONS.workerMissing;
    if (person.archived_at != null || person.status === "archived") return STALE_REASONS.workerArchived;
    if (person.kind !== "worker") return STALE_REASONS.workerNotWorker;
    if (person.status !== "active") return STALE_REASONS.workerInactive;
    if (!person.project_path) return STALE_REASONS.workerUnassigned;
    if (person.project_path !== row.project_path) return STALE_REASONS.workerMoved;

    const active = this.activeRow(row.task_id);
    if (active?.employee_id === row.employee_id) return STALE_REASONS.alreadyAssigned;
    if (row.base_assignee_id == null) {
      if (active) return STALE_REASONS.assignmentChanged;
    } else if (!active || active.employee_id !== row.base_assignee_id || active.revision !== row.base_assignment_revision) {
      return STALE_REASONS.assignmentChanged;
    }
    return null;
  }

  private markStale(row: ProposalRow, reason: string): boolean {
    const now = this.now();
    const changed = this.db.run(
      `UPDATE assignment_proposals
          SET status = 'stale', revision = revision + 1, updated_at = ?, decided_at = ?,
              decided_from_revision = ?, stale_reason = ?
        WHERE id = ? AND status = 'pending' AND revision = ?`,
      [now, now, row.revision, reason, row.id, row.revision],
    ).changes;
    if (changed !== 1) return false;
    this.insertEvent({
      proposalId: row.id, taskId: row.task_id, project: row.project_path, employee: row.employee_id,
      action: "stale", actor: "system", revision: row.revision + 1, reassign: null,
      assignmentId: null, assignmentRevision: null, note: reason, at: now,
    });
    return true;
  }

  /**
   * Re-check every pending proposal in scope and persist the ones that are
   * out of date. Only ever pending → stale. It never assigns, unassigns or
   * reassigns, and never rewrites FO-010C history.
   */
  refresh(scope: { projectPath?: string; taskId?: string; employeeId?: string } = {}): number {
    const clauses = [`status = 'pending'`];
    const params: string[] = [];
    if (scope.projectPath) { clauses.push(`project_path = ?`); params.push(scope.projectPath); }
    if (scope.taskId) { clauses.push(`task_id = ?`); params.push(scope.taskId); }
    if (scope.employeeId) { clauses.push(`employee_id = ?`); params.push(scope.employeeId); }
    const rows = this.db.query<ProposalRow, string[]>(
      `SELECT * FROM assignment_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT 500`,
    ).all(...params);
    let marked = 0;
    for (const row of rows) {
      const reason = this.evaluate(row);
      if (!reason) continue;
      const done = this.write(() => {
        const fresh = this.requireRow(row.id);
        if (fresh.status !== "pending") return false;
        const again = this.evaluate(fresh);
        return again ? this.markStale(fresh, again) : false;
      });
      if (done) marked += 1;
    }
    return marked;
  }

  /* ──────────────────────────── reads ──────────────────────────── */

  get(id: unknown): AssignmentProposal {
    const proposalId = this.uuid(id, "proposal id");
    const row = this.requireRow(proposalId);
    if (row.status === "pending") this.refresh({ taskId: row.task_id });
    return this.view(this.requireRow(proposalId));
  }

  list(filter: ProposalFilter = {}): { proposals: AssignmentProposal[]; truncated: boolean } {
    const clauses: string[] = [];
    const params: string[] = [];
    const scope: { projectPath?: string; taskId?: string; employeeId?: string } = {};
    if (filter.projectPath != null) {
      const project = this.requireProject(filter.projectPath);
      clauses.push(`project_path = ?`);
      params.push(project);
      scope.projectPath = project;
    }
    if (filter.taskId != null) {
      const task = this.uuid(filter.taskId, "taskId");
      clauses.push(`task_id = ?`);
      params.push(task);
      scope.taskId = task;
    }
    if (filter.employeeId != null) {
      const employee = this.uuid(filter.employeeId, "employeeId");
      clauses.push(`employee_id = ?`);
      params.push(employee);
      scope.employeeId = employee;
    }
    if (filter.status != null) {
      if (typeof filter.status !== "string" || !(PROPOSAL_STATUSES as readonly string[]).includes(filter.status)) fail("Invalid status.");
      clauses.push(`status = ?`);
      params.push(filter.status);
    }
    this.refresh(scope);
    const limit = PROPOSAL_LIMITS.list;
    const rows = this.db.query<ProposalRow, Array<string | number>>(
      `SELECT * FROM assignment_proposals ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id ASC LIMIT ?`,
    ).all(...params, limit + 1);
    return { proposals: rows.slice(0, limit).map((row) => this.view(row)), truncated: rows.length > limit };
  }

  history(id: unknown): { events: AssignmentProposalEvent[]; truncated: boolean } {
    const proposalId = this.uuid(id, "proposal id");
    this.requireRow(proposalId);
    const limit = PROPOSAL_LIMITS.history;
    const rows = this.db.query<EventRow, [string, number]>(
      `SELECT * FROM assignment_proposal_events WHERE proposal_id = ? ORDER BY id ASC LIMIT ?`,
    ).all(proposalId, limit + 1);
    return {
      truncated: rows.length > limit,
      events: rows.slice(0, limit).map((row) => ({
        id: row.id,
        proposalId: row.proposal_id,
        taskId: row.task_id,
        projectPath: row.project_path,
        employeeId: row.employee_id,
        employeeName: this.employeeRow(row.employee_id)?.name ?? null,
        action: row.action,
        actor: row.actor,
        proposalRevision: row.proposal_revision,
        reassign: row.reassign == null ? null : row.reassign === 1,
        assignmentId: row.assignment_id,
        assignmentRevision: row.assignment_revision,
        note: row.note,
        at: row.created_at,
      })),
    };
  }

  /** Pending proposals per registered project. Read-only except for stale marking. */
  summary(): ProposalSummary {
    this.refresh();
    const rows = this.db.query<{ project_path: string; name: string; n: number; latest: number }, []>(
      `SELECT p.path AS project_path, p.name AS name, COUNT(*) AS n, MAX(a.created_at) AS latest
         FROM assignment_proposals a JOIN projects p ON p.path = a.project_path
        WHERE a.status = 'pending'
        GROUP BY p.path, p.name
        ORDER BY latest DESC, p.name ASC`,
    ).all();
    return {
      pendingTotal: rows.reduce((sum, row) => sum + row.n, 0),
      projects: rows.map((row) => ({ projectPath: row.project_path, projectName: row.name, pending: row.n, latestAt: row.latest })),
    };
  }

  private view(row: ProposalRow): AssignmentProposal {
    const task = this.taskRow(row.task_id);
    const visibility = this.visibilityOf(task, row.project_path);
    // A task that left the project (or has no project now) is not described
    // through the old one: its title could belong to a project the viewer
    // did not open.
    const showTask = visibility === "in-project";
    const person = this.employeeRow(row.employee_id);
    const manager = row.proposed_by_employee_id ? this.employeeRow(row.proposed_by_employee_id) : null;
    const active = this.activeRow(row.task_id);
    const currentAssignment = active
      ? { assignmentId: active.id, employeeId: active.employee_id, employeeName: this.employeeRow(active.employee_id)?.name ?? null, revision: active.revision }
      : null;
    const pending = row.status === "pending";
    const needsReassign = pending && currentAssignment != null && currentAssignment.employeeId !== row.employee_id;
    const conflicts: string[] = [];
    if (pending) {
      const problem = this.evaluate(row);
      if (problem) conflicts.push(problem);
      else if (needsReassign) {
        conflicts.push(`The task is currently assigned to ${currentAssignment.employeeName ?? "another worker"}. Approving replaces that worker and needs your explicit consent.`);
      }
    }
    return {
      id: row.id,
      taskId: row.task_id,
      projectPath: row.project_path,
      projectName: this.projectName(row.project_path),
      projectRegistered: this.projectName(row.project_path) != null,
      task: {
        title: showTask ? task?.title ?? null : null,
        column: showTask ? task?.column_id ?? null : null,
        archived: task?.archived_at != null,
        visibility,
      },
      worker: {
        id: row.employee_id,
        name: person?.name ?? null,
        jobTitle: person?.job_title ?? null,
        status: person?.status ?? null,
        archived: person ? person.archived_at != null || person.status === "archived" : false,
        projectPath: person?.project_path ?? null,
      },
      proposedBy: {
        kind: row.proposed_by_kind,
        employeeId: row.proposed_by_employee_id,
        employeeName: manager?.name ?? null,
        delegationId: row.delegation_id,
      },
      rationale: row.rationale,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at,
      decidedFromRevision: row.decided_from_revision,
      staleReason: row.stale_reason,
      baseAssignment: row.base_assignee_id != null && row.base_assignment_revision != null
        ? { employeeId: row.base_assignee_id, employeeName: this.employeeRow(row.base_assignee_id)?.name ?? null, revision: row.base_assignment_revision }
        : null,
      currentAssignment,
      needsReassign,
      conflicts,
      result: row.status === "approved" && row.assignment_id
        ? { assignmentId: row.assignment_id, assignmentRevision: row.result_assignment_revision, reassigned: row.decision_reassign === 1 }
        : null,
      execution: PROPOSAL_EXECUTION_NOTE,
    };
  }

  /* ──────────────────────────── helpers ──────────────────────────── */

  private visibilityOf(task: TaskRow | null, projectPath: string): ProposalTaskVisibility {
    if (!task) return "missing";
    const ownership = this.safeOwnership(task.workdir);
    if (!ownership || ownership.kind !== "owned") return "unattributed";
    return ownership.projectPath === projectPath ? "in-project" : "diverged";
  }

  private safeOwnership(workdir: string): TaskOwnership | null {
    try {
      return this.classify(workdir);
    } catch {
      return null;
    }
  }

  private assertEligibleTask(task: TaskRow): void {
    if (task.pipeline_parent_id) fail("A pipeline step is not a board task.", 409);
    if (task.archived_at != null) fail("An archived task cannot be assigned.", 409);
    if (task.column_id === "done") fail("A finished task does not need a worker.", 409);
  }

  private workerProblem(person: EmployeeRow, projectPath: string): string | null {
    if (person.archived_at != null || person.status === "archived") return "Employee is archived.";
    if (person.kind !== "worker") return "Only an active worker can be proposed for a task.";
    if (person.status !== "active") return "Only an active worker can be proposed for a task.";
    if (!person.project_path) return "The employee is not assigned to a project.";
    if (person.project_path !== projectPath) return "This employee is not a worker of the task's project.";
    return null;
  }

  /** Unique task whose id starts with the 8-hex ref. */
  private resolveTaskRef(ref: string): string {
    const rows = this.db.query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE id LIKE ? || '%' LIMIT 2`).all(ref);
    if (rows.length === 0) fail("No such task.", 404);
    if (rows.length > 1) fail("The task id is ambiguous.", 409);
    return rows[0]!.id;
  }

  /** Unique active worker of this project whose id starts with the 8-hex ref. */
  private resolveWorkerRef(projectPath: string, ref: string): string {
    const rows = this.db.query<{ id: string }, [string, string]>(
      `SELECT id FROM ai_employees
        WHERE kind = 'worker' AND project_path = ? AND replace(id, '-', '') LIKE ? || '%'
        LIMIT 2`,
    ).all(projectPath, ref);
    if (rows.length === 0) fail("No such worker in this project.", 404);
    if (rows.length > 1) fail("The worker id is ambiguous.", 409);
    return rows[0]!.id;
  }

  private activeRow(taskId: string): ActiveRow | null {
    return this.db.query<ActiveRow, [string]>(
      `SELECT id, employee_id, revision FROM employee_task_assignments WHERE task_id = ? AND status = 'active'`,
    ).get(taskId) ?? null;
  }

  private requireRow(id: string): ProposalRow {
    const row = this.db.query<ProposalRow, [string]>(`SELECT * FROM assignment_proposals WHERE id = ?`).get(id);
    if (!row) fail("Proposal not found.", 404);
    return row;
  }

  private taskRow(id: string): TaskRow | null {
    return this.db.query<TaskRow, [string]>(
      `SELECT id, title, "column" AS column_id, workdir, archived_at, pipeline_parent_id FROM tasks WHERE id = ?`,
    ).get(id) ?? null;
  }

  private requireTask(id: string): TaskRow {
    const row = this.taskRow(id);
    if (!row) fail("Task not found.", 404);
    return row;
  }

  private employeeRow(id: string): EmployeeRow | null {
    return this.db.query<EmployeeRow, [string]>(
      `SELECT id, kind, name, job_title, project_path, status, archived_at FROM ai_employees WHERE id = ?`,
    ).get(id) ?? null;
  }

  private requireEmployee(id: string): EmployeeRow {
    const row = this.employeeRow(id);
    if (!row) fail("Employee not found.", 404);
    return row;
  }

  private projectName(projectPath: string): string | null {
    return this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(projectPath)?.name ?? null;
  }

  private requireProject(projectPath: unknown): string {
    const parsed = validateProjectPath(projectPath);
    if (!parsed.ok) fail(parsed.error, 400);
    if (!this.projectName(parsed.path)) fail("Project is not registered.", 404);
    return parsed.path;
  }

  private insertEvent(event: {
    proposalId: string;
    taskId: string;
    project: string;
    employee: string;
    action: ProposalAction;
    actor: ProposalActor;
    revision: number;
    reassign: boolean | null;
    assignmentId: string | null;
    assignmentRevision: number | null;
    note: string | null;
    at: number;
  }): void {
    this.db.run(
      `INSERT INTO assignment_proposal_events (
         proposal_id, task_id, project_path, employee_id, action, actor,
         proposal_revision, reassign, assignment_id, assignment_revision, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.proposalId, event.taskId, event.project, event.employee, event.action, event.actor,
        event.revision, event.reassign == null ? null : event.reassign ? 1 : 0,
        event.assignmentId, event.assignmentRevision, event.note, event.at,
      ],
    );
  }

  private uuid(value: unknown, label: string): string {
    if (typeof value !== "string" || !UUID_RE.test(value)) fail(`Invalid ${label}.`);
    return value.toLowerCase();
  }

  private revisionValue(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`Invalid ${label}.`);
    return value;
  }

  private nullableRevision(value: unknown): number | null {
    if (value === null) return null;
    return this.revisionValue(value, "expectedAssignmentRevision");
  }

  private rationaleValue(value: unknown): string {
    if (typeof value !== "string") fail("A short reason is required.");
    const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) fail("A short reason is required.");
    if (text.length > PROPOSAL_LIMITS.rationale) fail(`The reason is limited to ${PROPOSAL_LIMITS.rationale} characters.`);
    return text;
  }

  private write<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn).immediate();
    } catch (error) {
      if (error instanceof AssignmentProposalError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        fail("This proposal changed concurrently. Refresh and try again.", 409);
      }
      throw error;
    }
  }
}

const TEAM_PROMPT_LIMIT = 30;

/**
 * What a project manager's prompt may say about the team: active workers of
 * this project and who holds which task. Read-only. Names are labels the
 * owner typed; the prompt marks them as data.
 */
export function teamForPrompt(
  db: Database,
  projectPath: string,
): { team: TeamPromptMember[]; assignees: Map<string, string> } {
  const workers = db.query<{ id: string; name: string; job_title: string; specializations: string }, [string, number]>(
    `SELECT id, name, job_title, specializations FROM ai_employees
      WHERE kind = 'worker' AND project_path = ? AND status = 'active' AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(projectPath, TEAM_PROMPT_LIMIT);
  const held = db.query<{ task_id: string; employee_id: string }, [string]>(
    `SELECT a.task_id AS task_id, a.employee_id AS employee_id
       FROM employee_task_assignments a JOIN tasks t ON t.id = a.task_id
      WHERE a.project_path = ? AND a.status = 'active' AND t.archived_at IS NULL AND t."column" != 'done'`,
  ).all(projectPath);
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const worker of workers) names.set(worker.id, worker.name);
  const assignees = new Map<string, string>();
  for (const row of held) {
    counts.set(row.employee_id, (counts.get(row.employee_id) ?? 0) + 1);
    const name = names.get(row.employee_id) ?? db.query<{ name: string }, [string]>(`SELECT name FROM ai_employees WHERE id = ?`).get(row.employee_id)?.name;
    if (name) assignees.set(row.task_id, name.replace(/\s+/g, " ").slice(0, 80));
  }
  const team = workers.map((worker): TeamPromptMember => {
    let specializations: string[] = [];
    try {
      const parsed: unknown = JSON.parse(worker.specializations);
      if (Array.isArray(parsed)) specializations = parsed.filter((item): item is string => typeof item === "string").slice(0, 6);
    } catch {
      specializations = [];
    }
    return {
      ref: workerRefOf(worker.id),
      name: worker.name.replace(/\s+/g, " ").slice(0, 80),
      jobTitle: worker.job_title.replace(/\s+/g, " ").slice(0, 120),
      specializations,
      openAssignments: counts.get(worker.id) ?? 0,
    };
  });
  return { team, assignees };
}
