/**
 * Storage for employee execution attempts (FO-010E2, migration 085).
 *
 * Every state change is one guarded UPDATE (compare-and-set on `status`), so
 * two tabs, a double click, or two SQLite connections can never both win the
 * same transition. No call here starts a process, touches a task, an
 * assignment, an account, or a harness. The runner (`employee-run.ts`)
 * decides; this class only records, atomically.
 */

import type { Database } from "bun:sqlite";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import {
  phaseOf,
  type EmployeeRunReviewFacts,
  type EmployeeRunResult,
  type EmployeeRunStatus,
  type EmployeeRunView,
} from "../shared/execution/run.ts";
import type { AttributionProvenance } from "../shared/execution/attribution.ts";

export interface EmployeeRunRow {
  id: string;
  task_id: string;
  task_title: string;
  project_path: string;
  employee_id: string;
  employee_name: string;
  assignment_id: string;
  assignment_revision: number;
  status: EmployeeRunStatus;
  revision: number;
  requested_harness_id: string;
  requested_model: string | null;
  requested_effort: string | null;
  requested_complexity: string | null;
  requested_policy: string;
  requested_mode: string;
  inputs_key: string;
  task_fingerprint: string;
  config_json: string;
  review_json: string;
  professional_json: string | null;
  professional_payload_status: import("../shared/execution/professional.ts").ProfessionalPayloadStatus;
  professional_payload_at: number | null;
  professional_payload_sha256: string | null;
  usage_notice: string | null;
  unconfirmed_prior: number;
  execution_id: string | null;
  run_id: string | null;
  actual_harness_id: string | null;
  actual_model: string | null;
  actual_account_id: string | null;
  actual_provenance: AttributionProvenance;
  approval_provenance: AttributionProvenance;
  result: EmployeeRunResult | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  approved_at: number | null;
  claimed_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface NewEmployeeRun {
  id: string;
  taskId: string;
  taskTitle: string;
  projectPath: string;
  employeeId: string;
  employeeName: string;
  assignmentId: string;
  assignmentRevision: number;
  requestedHarnessId: string;
  requestedModel: string | null;
  requestedEffort: string | null;
  requestedComplexity: string | null;
  requestedPolicy: string;
  requestedMode: string;
  inputsKey: string;
  taskFingerprint: string;
  configJson: string;
  reviewJson: string;
  professionalJson?: string;
  usageNotice: string | null;
  unconfirmedPrior: boolean;
  expiresAt: number;
}

export type ClaimResult =
  | { ok: true; row: EmployeeRunRow }
  | { ok: false; reason: "not-open" | "expired" | "revision" | "invalid"; problem?: string; row: EmployeeRunRow | null };

export class EmployeeRunCore {
  constructor(private readonly db: Database, readonly now: () => number = Date.now) {}

  get(id: string): EmployeeRunRow | null {
    return this.db.query<EmployeeRunRow, [string]>(`SELECT * FROM employee_executions WHERE id = ?`).get(id) ?? null;
  }

  byRun(runId: string): EmployeeRunRow | null {
    return this.db.query<EmployeeRunRow, [string]>(`SELECT * FROM employee_executions WHERE run_id = ?`).get(runId) ?? null;
  }

  listForTask(taskId: string, limit: number): EmployeeRunRow[] {
    return this.db.query<EmployeeRunRow, [string, number]>(
      `SELECT * FROM employee_executions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(taskId, limit);
  }

  listForEmployee(employeeId: string, limit: number, before?: string): EmployeeRunRow[] {
    return this.db.query<EmployeeRunRow, [string, string | null, string | null, number]>(
      `SELECT * FROM employee_executions AS e WHERE employee_id = ?
       AND (? IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM employee_executions c WHERE c.id = ? AND c.employee_id = e.employee_id))
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(employeeId, before ?? null, before ?? null, limit);
  }

  /** Rows whose start was claimed but never recorded as finished. */
  listStarting(): EmployeeRunRow[] {
    return this.db.query<EmployeeRunRow, []>(`SELECT * FROM employee_executions WHERE status = 'starting'`).all();
  }

  /** Started rows whose run end has not been written yet. */
  listUnfinished(): EmployeeRunRow[] {
    return this.db.query<EmployeeRunRow, []>(
      `SELECT * FROM employee_executions WHERE status = 'started' AND finished_at IS NULL AND run_id IS NOT NULL`,
    ).all();
  }

  /** Uncertainty is never cleared by acknowledgement or by a later start. */
  hasUnconfirmed(taskId: string, exceptId = ""): boolean {
    return !!this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM employee_executions
       WHERE task_id = ? AND id != ? AND (status IN ('starting', 'indeterminate')
         OR (status = 'started' AND (finished_at IS NULL OR result = 'orphaned')))
       LIMIT 1`,
    ).get(taskId, exceptId);
  }

  /**
   * Record a review. Open reviews for the task that are past their deadline
   * expire first; a still-valid one with the same inputs is returned as is
   * (idempotent), a different one is superseded. Throws when a start is in
   * flight (the unique index), which callers report as a conflict.
   */
  createOrReuse(input: NewEmployeeRun): { row: EmployeeRunRow; reused: boolean } {
    return this.db.transaction(() => {
      const now = this.now();
      if (this.hasUnconfirmed(input.taskId)) throw new Error("unresolved-execution");
      this.db.run(
        `UPDATE employee_executions SET status = 'expired', updated_at = ? WHERE task_id = ? AND status = 'awaiting-approval' AND expires_at <= ?`,
        [now, input.taskId, now],
      );
      const open = this.db.query<EmployeeRunRow, [string]>(
        `SELECT * FROM employee_executions WHERE task_id = ? AND status = 'awaiting-approval'`,
      ).get(input.taskId);
      if (open && open.inputs_key === input.inputsKey && open.unconfirmed_prior === 0) return { row: open, reused: true };
      if (open) {
        this.db.run(`UPDATE employee_executions SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'awaiting-approval'`, [now, open.id]);
      }
      this.db.run(
        `INSERT INTO employee_executions (
           id, task_id, task_title, project_path, employee_id, employee_name, assignment_id, assignment_revision,
           status, revision, requested_harness_id, requested_model, requested_effort, requested_complexity,
           requested_policy, requested_mode, inputs_key, task_fingerprint, config_json, review_json, usage_notice,
           unconfirmed_prior, created_at, updated_at, expires_at, professional_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-approval', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id, input.taskId, input.taskTitle, input.projectPath, input.employeeId, input.employeeName,
          input.assignmentId, input.assignmentRevision, input.requestedHarnessId, input.requestedModel,
          input.requestedEffort, input.requestedComplexity, input.requestedPolicy, input.requestedMode,
          input.inputsKey, input.taskFingerprint, input.configJson, input.reviewJson, input.usageNotice,
          input.unconfirmedPrior ? 1 : 0, now, now, input.expiresAt, input.professionalJson ?? null,
        ],
      );
      new ActivityJournalCore(this.db).record({
        eventType: "execution.reviewed",
        projectPath: input.projectPath,
        actorType: "owner",
        actorId: "owner",
        targetType: "execution",
        targetId: input.id,
        taskId: input.taskId,
        employeeId: input.employeeId,
        executionId: input.id,
        idempotencyKey: `execution:${input.id}:reviewed`,
        payload: {
          attemptId: input.id,
          taskId: input.taskId,
          taskTitle: input.taskTitle,
          employeeId: input.employeeId,
          employeeName: input.employeeName,
          harnessId: input.requestedHarnessId,
          mode: input.requestedMode,
        },
        createdAt: now,
      });
      return { row: this.get(input.id)!, reused: false };
    }).immediate();
  }

  /**
   * Validate and claim in one write transaction. `validate` runs inside it,
   * after the row is read and before the UPDATE; it returns a problem string
   * to refuse. A refusal is recorded (`rejected`) in the same transaction so
   * a stale approval can never be used later. The winner of two concurrent
   * claims is whoever's UPDATE finds `awaiting-approval` first.
   */
  claim(id: string, revision: number, executionId: string, validate?: (row: EmployeeRunRow) => string | null): ClaimResult {
    return this.db.transaction((): ClaimResult => {
      const now = this.now();
      const row = this.get(id);
      if (!row || row.status !== "awaiting-approval") return { ok: false, reason: "not-open", row };
      if (row.expires_at <= now) {
        this.db.run(`UPDATE employee_executions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting-approval'`, [now, id]);
        return { ok: false, reason: "expired", row: this.get(id) };
      }
      if (row.revision !== revision) return { ok: false, reason: "revision", row };
      let problem: string | null = null;
      try {
        problem = validate ? validate(row) : null;
      } catch {
        problem = "The task, worker, or harness could not be verified.";
      }
      if (problem) {
        this.db.run(
          `UPDATE employee_executions SET status = 'rejected', reason = ?, updated_at = ? WHERE id = ? AND status = 'awaiting-approval'`,
          [problem, now, id],
        );
        return { ok: false, reason: "invalid", problem, row: this.get(id) };
      }
      const changed = this.db.run(
        `UPDATE employee_executions
            SET status = 'starting', revision = revision + 1, execution_id = ?, approved_at = ?, claimed_at = ?,
                approval_provenance = 'owner', updated_at = ?
          WHERE id = ? AND status = 'awaiting-approval' AND revision = ?`,
        [executionId, now, now, now, id, revision],
      ).changes;
      if (changed !== 1) return { ok: false, reason: "not-open", row: this.get(id) };
      new ActivityJournalCore(this.db).record({
        eventType: "execution.approved",
        projectPath: row.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "execution",
        targetId: id,
        taskId: row.task_id,
        employeeId: row.employee_id,
        executionId,
        idempotencyKey: `execution:${id}:approved:${revision}`,
        payload: {
          attemptId: id,
          taskId: row.task_id,
          taskTitle: row.task_title,
          employeeId: row.employee_id,
          employeeName: row.employee_name,
          executionId,
          harnessId: row.requested_harness_id,
          approvedAt: now,
        },
        createdAt: now,
      });
      return { ok: true, row: this.get(id)! };
    }).immediate();
  }

  cancel(id: string, revision: number | null): EmployeeRunRow | null {
    const now = this.now();
    this.db.run(
      `UPDATE employee_executions SET status = 'cancelled', reason = 'Cancelled by you. Nothing was started.', updated_at = ?
        WHERE id = ? AND status = 'awaiting-approval' AND (? IS NULL OR revision = ?)`,
      [now, id, revision, revision],
    );
    return this.get(id);
  }

  expire(id: string): EmployeeRunRow | null {
    this.db.run(
      `UPDATE employee_executions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting-approval' AND expires_at <= ?`,
      [this.now(), id, this.now()],
    );
    return this.get(id);
  }

  /** The runtime accepted the start. `actual*` hold only what the runtime established. */
  markStarted(
    id: string,
    fact: { runId: string; startedAt: number; actualHarnessId: string | null; reason?: string | null },
  ): EmployeeRunRow | null {
    return this.db.transaction(() => {
      if (!fact.runId || typeof fact.runId !== "string" || !fact.runId.trim()) {
        return this.get(id);
      }
      const changes = this.db.run(
        `UPDATE employee_executions
            SET status = 'started', run_id = ?, started_at = ?, actual_harness_id = ?, actual_provenance = ?,
                reason = COALESCE(?, reason), updated_at = ?
          WHERE id = ? AND status IN ('starting', 'indeterminate') AND (run_id IS NULL OR run_id = ?)`,
        [fact.runId, fact.startedAt, fact.actualHarnessId, fact.actualHarnessId ? "runtime" : "unknown", fact.reason ?? null, this.now(), id, fact.runId],
      ).changes;
      const row = this.get(id);
      if (changes === 1 && row && row.status === "started" && row.run_id === fact.runId) {
        new ActivityJournalCore(this.db).record({
          eventType: "execution.started",
          projectPath: row.project_path,
          actorType: "system",
          actorId: "runtime",
          targetType: "execution",
          targetId: id,
          taskId: row.task_id,
          runId: row.run_id,
          employeeId: row.employee_id,
          executionId: row.execution_id,
          idempotencyKey: `execution:${id}:started:${row.run_id}`,
          payload: {
            attemptId: id,
            taskId: row.task_id,
            taskTitle: row.task_title,
            employeeId: row.employee_id,
            employeeName: row.employee_name,
            runId: row.run_id,
            actualHarnessId: row.actual_harness_id,
            startedAt: row.started_at,
          },
          createdAt: fact.startedAt,
        });
      }
      return row;
    }).immediate();
  }

  /** The start ended without a run, or the outcome cannot be confirmed. */
  settleStart(id: string, status: "start-failed" | "indeterminate" | "rejected", reason: string, runId: string | null = null): EmployeeRunRow | null {
    return this.db.transaction(() => {
      const now = this.now();
      const changes = this.db.run(
        `UPDATE employee_executions SET status = ?, reason = ?, run_id = COALESCE(?, run_id), updated_at = ? WHERE id = ? AND status IN ('starting', 'indeterminate') AND (status != ? OR reason IS NOT ?)`,
        [status, reason, runId, now, id, status, reason],
      ).changes;
      const row = this.get(id);
      if (changes === 1 && row && row.status === "indeterminate" && status === "indeterminate") {
        new ActivityJournalCore(this.db).record({
          eventType: "delivery.indeterminate",
          projectPath: row.project_path,
          actorType: "system",
          actorId: "runtime",
          targetType: "execution",
          targetId: id,
          taskId: row.task_id,
          runId: row.run_id ?? runId,
          employeeId: row.employee_id,
          executionId: row.execution_id,
          idempotencyKey: `execution:${id}:indeterminate`,
          payload: {
            attemptId: id,
            taskId: row.task_id,
            employeeId: row.employee_id,
            reason: row.reason,
            status: "indeterminate",
          },
          createdAt: now,
        });
      }
      return row;
    }).immediate();
  }

  /** Write the end of the run once; later calls change nothing. */
  finish(id: string, fact: { finishedAt: number; result: EmployeeRunResult; reason: string }): EmployeeRunRow | null {
    return this.db.transaction(() => {
      const changes = this.db.run(
        `UPDATE employee_executions SET finished_at = ?, result = ?, reason = ?, updated_at = ?
          WHERE id = ? AND status = 'started' AND finished_at IS NULL`,
        [fact.finishedAt, fact.result, fact.reason, this.now(), id],
      ).changes;
      const row = this.get(id);
      if (changes === 1 && row && row.status === "started" && row.finished_at != null && row.result != null) {
        new ActivityJournalCore(this.db).record({
          eventType: row.result === "succeeded" ? "run.completed" : "run.failed",
          projectPath: row.project_path,
          actorType: "employee",
          actorId: row.employee_id,
          targetType: "task",
          targetId: row.task_id,
          taskId: row.task_id,
          runId: row.run_id,
          employeeId: row.employee_id,
          executionId: row.execution_id,
          idempotencyKey: `run:${row.run_id ?? id}:finished`,
          payload: {
            attemptId: id,
            taskId: row.task_id,
            taskTitle: row.task_title,
            employeeId: row.employee_id,
            employeeName: row.employee_name,
            runId: row.run_id,
            result: row.result,
            reason: row.reason,
            finishedAt: row.finished_at,
          },
          createdAt: row.finished_at,
        });
      }
      return row;
    }).immediate();
  }

  view(row: EmployeeRunRow, runStatus: EmployeeRunView["runStatus"]): EmployeeRunView {
    const review = JSON.parse(row.review_json) as EmployeeRunReviewFacts;
    // Requested = what the runtime is asked to use: the owner's explicit choice, else the task's own setting.
    const config = JSON.parse(row.config_json) as { model?: string; effort?: string | null };
    return {
      id: row.id,
      status: row.status,
      revision: row.revision,
      taskId: row.task_id,
      taskTitle: row.task_title,
      projectPath: row.project_path,
      employee: { id: row.employee_id, name: row.employee_name },
      assignment: { id: row.assignment_id, revision: row.assignment_revision },
      requested: {
        harnessId: row.requested_harness_id,
        model: row.requested_model ?? config.model ?? null,
        effort: row.requested_effort ?? config.effort ?? null,
        mode: row.requested_mode,
        complexity: row.requested_complexity,
      },
      actual: { harnessId: row.actual_harness_id, model: row.actual_model, accountId: row.actual_account_id },
      provenance: { actual: row.actual_provenance, approval: row.approval_provenance },
      review,
      professional: row.professional_json ? {
        binding: JSON.parse(row.professional_json), payloadStatus: row.professional_payload_status,
        payloadAt: row.professional_payload_at, payloadSha256: row.professional_payload_sha256,
      } : null,
      usageNotice: row.usage_notice,
      requiresUnconfirmedAck: row.unconfirmed_prior === 1,
      runId: row.run_id,
      executionId: row.execution_id,
      runStatus,
      result: row.result,
      reason: row.reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approvedAt: row.approved_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      phase: phaseOf(row, runStatus),
    };
  }
}
