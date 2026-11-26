import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import type { ProfessionalTurn, TurnContext, TurnStatus } from "../shared/execution/turn.ts";
import { MAX_PROMPT_BYTES } from "../shared/employees/profile-types.ts";
import type { EmployeeRunRow } from "./employee-run-core.ts";
import type { ProfessionalBinding } from "../shared/execution/professional.ts";

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function resolveTurnProjectPath(
  db: Database,
  turnRow: Pick<ProfessionalTurn, "attempt_id" | "run_id" | "task_id" | "facts_json">,
): string | null {
  const attempt = db
    .query<{ project_path: string }, [string, string, string]>(
      `SELECT project_path FROM employee_executions WHERE id = ? AND run_id = ? AND task_id = ? LIMIT 1`,
    )
    .get(turnRow.attempt_id, turnRow.run_id, turnRow.task_id);
  if (attempt?.project_path) {
    return attempt.project_path;
  }
  try {
    const facts = JSON.parse(turnRow.facts_json) as { projectPath?: unknown };
    if (typeof facts?.projectPath === "string" && facts.projectPath.trim()) {
      return facts.projectPath;
    }
  } catch {
    // Ignore malformed facts_json
  }
  return null;
}

export const professionalExecutionKey = (task: { agent: string; model?: string | null; effort?: string | null; mode?: string | null; fast?: boolean; maxMode?: boolean; agentProfileId?: string | null; workdir: string; worktreePath?: string | null; isolation?: string; pipelineId?: string | null }) => hash(JSON.stringify([task.agent, task.model, task.effort, task.mode, task.fast, task.maxMode, task.agentProfileId, task.workdir, task.worktreePath, task.isolation, task.pipelineId]));

/** Called inside canonical startTask's Run transaction. No historical backfill. */
export function recordInitialProfessionalTurn(db: Database, row: EmployeeRunRow, binding: ProfessionalBinding | null, runId: string, payload: string, factsJson = "{}") {
  if (binding?.kind !== "professional") return;
  if (!row.professional_json) throw new Error("Original professional snapshot is unavailable.");
  db.run(`INSERT INTO employee_execution_turns (id, run_id, task_id, employee_id, attempt_id,
    snapshot_revision_id, snapshot_sha256, turn_number, authorization_ref, prompt_sha256, facts_json,
    status, idempotency_key, created_at, expires_at, approved_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'prepared', 'initial', ?, ?, ?, ?)`,
  [randomUUID(), runId, row.task_id, row.employee_id, row.id, binding.revisionId, hash(row.professional_json),
    `owner-attempt:${row.id}`, hash(payload), factsJson, Date.now(), row.expires_at, row.approved_at, Date.now()]);
}

export function settleInitialProfessionalTurn(db: Database, runId: string, included: boolean, sessionId: string | null) {
  // Initial spawn failure may already have exposed bytes to an external process.
  db.transaction(() => {
    const now = Date.now();
    const targetStatus = included ? "included" : "indeterminate";
    const changes = db.run(
      `UPDATE employee_execution_turns SET status = ?, session_id = ?, settled_at = ?, revision = revision + 1
        WHERE run_id = ? AND turn_number = 1 AND status = 'prepared'`,
      [targetStatus, sessionId, now, runId],
    ).changes;

    if (!included && changes === 1) {
      const turnRow = db
        .query<ProfessionalTurn, [string]>(
          `SELECT * FROM employee_execution_turns WHERE run_id = ? AND turn_number = 1 LIMIT 1`,
        )
        .get(runId);
      if (turnRow && turnRow.status === "indeterminate") {
        const projectPath = resolveTurnProjectPath(db, turnRow);
        new ActivityJournalCore(db).record({
          eventType: "delivery.indeterminate",
          projectPath,
          actorType: "system",
          actorId: "runtime",
          targetType: "turn",
          targetId: turnRow.id,
          taskId: turnRow.task_id,
          runId: turnRow.run_id,
          employeeId: turnRow.employee_id,
          executionId: turnRow.attempt_id,
          turnId: turnRow.id,
          idempotencyKey: `turn:${turnRow.id}:indeterminate`,
          payload: {
            turnId: turnRow.id,
            attemptId: turnRow.attempt_id,
            runId: turnRow.run_id,
            taskId: turnRow.task_id,
            employeeId: turnRow.employee_id,
            turnNumber: 1,
            reason: turnRow.reason ?? "Initial turn delivery outcome could not be confirmed.",
            status: "indeterminate",
          },
          createdAt: now,
        });
      }
    }
  }).immediate();
}

/** Codex/Cursor discover their initial session after returning a handle. Bind once; never replace. */
export function recordProfessionalInitialSession(db: Database, runId: string, sessionId: string) {
  db.run(`UPDATE employee_execution_turns SET session_id = ? WHERE run_id = ? AND turn_number = 1 AND session_id IS NULL`, [sessionId, runId]);
}

/** Run settlement observed after submission, never a claim that a particular message was executed. */
export function recordProfessionalTurnRunOutcome(db: Database, runId: string, status: string, endedAt: number) {
  db.run(`UPDATE employee_execution_turns SET observed_run_status = ?, observed_run_ended_at = ?
    WHERE run_id = ? AND submitted_at IS NOT NULL AND observed_run_status IS NULL`, [status, endedAt, runId]);
}
export class TurnError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** No process launch, globals, current-profile lookup or automatic redelivery. */
export class ProfessionalTurnCore {
  constructor(readonly db: Database, readonly now: () => number = Date.now) {}
  get(id: string): ProfessionalTurn {
    const row = this.db.query<ProfessionalTurn, [string]>("SELECT * FROM employee_execution_turns WHERE id = ?").get(id);
    if (!row) throw new TurnError("Turn not found.", 404);
    return row;
  }
  list(runId: string): ProfessionalTurn[] {
    return this.db.query<ProfessionalTurn, [string]>("SELECT * FROM employee_execution_turns WHERE run_id = ? ORDER BY turn_number").all(runId);
  }
  initial(runId: string): ProfessionalTurn | null {
    return this.db.query<ProfessionalTurn, [string]>("SELECT * FROM employee_execution_turns WHERE run_id = ? AND turn_number = 1").get(runId);
  }
  review(context: () => TurnContext, prompt: string, key: string): { turn: ProfessionalTurn; replayed: boolean } {
    if (typeof prompt !== "string" || !prompt.trim() || !prompt.isWellFormed()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)
      || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new TurnError("Invalid follow-up prompt.", 400);
    // Slash commands and file attachment syntax are external CLI operations,
    // not plain user content. Initial starts retain their existing behavior.
    if (prompt.trimStart().startsWith("/") || /(^|\s)@\S/.test(prompt)) throw new TurnError("CLI commands and attachment references are unsupported in professional follow-ups.", 400);
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(key)) throw new TurnError("Invalid idempotency key.", 400);
    return this.db.transaction(() => {
      const c = context();
      const existing = this.db.query<ProfessionalTurn, [string, string]>("SELECT * FROM employee_execution_turns WHERE run_id = ? AND idempotency_key = ?").get(c.runId, key);
      if (existing) {
        if (existing.prompt !== prompt) throw new TurnError("Idempotency key already names a different payload.");
        return { turn: existing, replayed: true };
      }
      const pending = this.db.query<Pick<ProfessionalTurn, "id" | "status" | "expires_at">, [string]>(
        "SELECT id, status, expires_at FROM employee_execution_turns WHERE run_id = ? AND status NOT IN ('included','failed') LIMIT 1").get(c.runId);
      if (pending?.status === "reviewed" && pending.expires_at <= this.now()) this.transition(pending.id, "reviewed", "failed", "Review expired before approval.");
      else if (pending) throw new TurnError("A prior turn is pending or its delivery is Unknown. A new execution needs Owner review.");
      const prior = this.db.query<Pick<ProfessionalTurn, "id" | "turn_number">, [string]>(
        "SELECT id, turn_number FROM employee_execution_turns WHERE run_id = ? ORDER BY turn_number DESC LIMIT 1").get(c.runId);
      if (!prior) throw new TurnError("Original Turn evidence is unavailable; a new execution needs Owner review.");
      const id = randomUUID(), now = this.now();
      this.db.run(`INSERT INTO employee_execution_turns (id, run_id, task_id, employee_id, attempt_id,
        snapshot_revision_id, snapshot_sha256, turn_number, parent_turn_id, session_id,
        prompt, prompt_sha256, facts_json, status, idempotency_key, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reviewed', ?, ?, ?)`,
      [id, c.runId, c.taskId, c.employeeId, c.attemptId, c.revisionId, c.snapshotSha256,
        prior.turn_number + 1, prior.id, c.sessionId, prompt, hash(prompt), JSON.stringify(c), key, now, now + 5 * 60_000]);
      const turnRow = this.get(id);
      const projectPath = resolveTurnProjectPath(this.db, turnRow) ?? c.projectPath;
      new ActivityJournalCore(this.db).record({
        eventType: "turn.proposed",
        projectPath,
        actorType: "owner",
        actorId: "owner",
        targetType: "turn",
        targetId: id,
        taskId: turnRow.task_id,
        runId: turnRow.run_id,
        employeeId: turnRow.employee_id,
        executionId: turnRow.attempt_id,
        turnId: id,
        idempotencyKey: `turn:${id}:proposed`,
        payload: {
          turnId: id,
          runId: turnRow.run_id,
          taskId: turnRow.task_id,
          employeeId: turnRow.employee_id,
          employeeName: c.employeeName,
          turnNumber: turnRow.turn_number,
          promptSha256: hash(prompt),
          promptLength: prompt.length,
        },
        createdAt: now,
      });
      return { turn: turnRow, replayed: false };
    }).immediate();
  }
  transition(id: string, from: TurnStatus, to: TurnStatus, reason: string | null = null) {
    this.db.transaction(() => {
      const now = this.now();
      const changes = this.db.run(`UPDATE employee_execution_turns SET status = ?, revision = revision + 1,
        reason = ?, submitted_at = CASE WHEN ? = 'prepared' THEN ? ELSE submitted_at END,
        settled_at = CASE WHEN ? IN ('included','failed','indeterminate') THEN ? ELSE settled_at END
        WHERE id = ? AND status = ?`, [to, reason, to, now, to, now, id, from]).changes;
      if (changes !== 1) throw new TurnError("Stale turn state.");
      if (to === "included") {
        const turnRow = this.get(id);
        if (turnRow.status === "included") {
          const projectPath = resolveTurnProjectPath(this.db, turnRow);
          new ActivityJournalCore(this.db).record({
            eventType: "turn.submitted",
            projectPath,
            actorType: "system",
            actorId: "runtime",
            targetType: "turn",
            targetId: id,
            taskId: turnRow.task_id,
            runId: turnRow.run_id,
            employeeId: turnRow.employee_id,
            executionId: turnRow.attempt_id,
            turnId: id,
            idempotencyKey: `turn:${id}:submitted`,
            payload: {
              turnId: id,
              runId: turnRow.run_id,
              taskId: turnRow.task_id,
              employeeId: turnRow.employee_id,
              turnNumber: turnRow.turn_number,
              status: "included",
            },
            createdAt: now,
          });
        }
      } else if (to === "indeterminate") {
        const turnRow = this.get(id);
        if (turnRow.status === "indeterminate") {
          const projectPath = resolveTurnProjectPath(this.db, turnRow);
          new ActivityJournalCore(this.db).record({
            eventType: "delivery.indeterminate",
            projectPath,
            actorType: "system",
            actorId: "runtime",
            targetType: "turn",
            targetId: id,
            taskId: turnRow.task_id,
            runId: turnRow.run_id,
            employeeId: turnRow.employee_id,
            executionId: turnRow.attempt_id,
            turnId: id,
            idempotencyKey: `turn:${id}:indeterminate`,
            payload: {
              turnId: id,
              attemptId: turnRow.attempt_id,
              runId: turnRow.run_id,
              taskId: turnRow.task_id,
              employeeId: turnRow.employee_id,
              turnNumber: turnRow.turn_number,
              reason: turnRow.reason ?? reason,
              status: "indeterminate",
            },
            createdAt: now,
          });
        }
      }
    }).immediate();
  }
  claim(id: string, revision: number, key: string, context: () => TurnContext): { turn: ProfessionalTurn; replayed: boolean } {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.idempotency_key !== key) throw new TurnError("Idempotency key mismatch.");
      if (row.status !== "reviewed") return { turn: row, replayed: true };
      if (row.revision !== revision) throw new TurnError("Stale review revision.");
      if (row.expires_at <= this.now()) throw new TurnError("Review expired. Review again.");
      if (JSON.stringify(context()) !== row.facts_json || hash(row.prompt!) !== row.prompt_sha256) throw new TurnError("Session, assignment, project or authority changed. Review again.");
      const now = this.now();
      const n = this.db.run(`UPDATE employee_execution_turns SET status = 'approved', revision = revision + 1,
        authorization_ref = ?, approved_at = ? WHERE id = ? AND status = 'reviewed' AND revision = ?`,
      [`owner-turn:${id}`, now, id, revision]).changes;
      if (n !== 1) throw new TurnError("Stale review revision.");
      this.transition(id, "approved", "claimed");
      const c = context();
      const projectPath = resolveTurnProjectPath(this.db, row) ?? c.projectPath;
      new ActivityJournalCore(this.db).record({
        eventType: "turn.approved",
        projectPath,
        actorType: "owner",
        actorId: "owner",
        targetType: "turn",
        targetId: id,
        taskId: row.task_id,
        runId: row.run_id,
        employeeId: row.employee_id,
        executionId: row.attempt_id,
        turnId: id,
        idempotencyKey: `turn:${id}:approved:${revision}`,
        payload: {
          turnId: id,
          runId: row.run_id,
          taskId: row.task_id,
          employeeId: row.employee_id,
          turnNumber: row.turn_number,
          approvedAt: now,
        },
        createdAt: now,
      });
      return { turn: this.get(id), replayed: false };
    }).immediate();
  }
  /** Only at backend startup, before accepting requests. Never during a live send. */
  recover(): number {
    return this.db.transaction(() => {
      const rows = this.db.query<ProfessionalTurn, []>("SELECT * FROM employee_execution_turns WHERE turn_number > 1 AND status IN ('approved','claimed','prepared')").all();
      for (const row of rows) this.transition(row.id, row.status, row.status === "prepared" ? "indeterminate" : "failed",
        row.status === "prepared" ? "Backend stopped after delivery preparation. Delivery Unknown; never automatically resend." : "Backend stopped before submission. No prompt submitted.");
      return rows.length;
    }).immediate();
  }
}
