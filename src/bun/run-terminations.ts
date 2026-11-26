/** Persistence for run stop and time-limit records (migration 142). */
import type { RunTermination, TerminationOutcome, TerminationReason } from "../shared/run-termination.ts";
import { db } from "./db.ts";

interface Row {
  run_id: string; limit_seconds: number | null; deadline_at: number | null; reason: TerminationReason | null;
  requested_at: number | null; attempts: number; outcome: TerminationOutcome | null; process_id: number | null;
  process_started: string | null; methods: string; checked_at: number | null; exited_at: number | null; note: string | null;
}

function parseMethods(text: string): RunTermination["methods"] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((m): m is RunTermination["methods"][number] => m === "session-kill" || m === "sigterm" || m === "sigkill") : [];
  } catch { return []; }
}

function toTermination(row: Row): RunTermination {
  return {
    runId: row.run_id, limitSeconds: row.limit_seconds, deadlineAt: row.deadline_at, reason: row.reason, requestedAt: row.requested_at,
    attempts: row.attempts, outcome: row.outcome, processId: row.process_id, methods: parseMethods(row.methods),
    checkedAt: row.checked_at, exitedAt: row.exited_at, note: row.note,
  };
}

export const runTerminations = {
  get(runId: string): RunTermination | null {
    const row = db.query<Row, [string]>(`SELECT * FROM run_terminations WHERE run_id = ?`).get(runId);
    return row ? toTermination(row) : null;
  },

  forRuns(runIds: string[]): Map<string, RunTermination> {
    const out = new Map<string, RunTermination>();
    if (runIds.length === 0) return out;
    const marks = runIds.map(() => "?").join(",");
    for (const row of db.query<Row, string[]>(`SELECT * FROM run_terminations WHERE run_id IN (${marks})`).all(...runIds)) out.set(row.run_id, toTermination(row));
    return out;
  },

  /** Record the limit a run launched under. Nothing is requested yet. */
  arm(runId: string, limitSeconds: number, deadlineAt: number): void {
    db.run(
      `INSERT INTO run_terminations (run_id, limit_seconds, deadline_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET limit_seconds = excluded.limit_seconds, deadline_at = excluded.deadline_at`,
      [runId, limitSeconds, deadlineAt],
    );
  },

  /** The first request fixes the reason; a repeat only counts another attempt. */
  request(runId: string, reason: TerminationReason, now = Date.now()): RunTermination {
    db.run(
      `INSERT INTO run_terminations (run_id, reason, requested_at, attempts) VALUES (?, ?, ?, 1)
       ON CONFLICT(run_id) DO UPDATE SET
         reason = COALESCE(run_terminations.reason, excluded.reason),
         requested_at = COALESCE(run_terminations.requested_at, excluded.requested_at),
         attempts = run_terminations.attempts + 1`,
      [runId, reason, now],
    );
    return runTerminations.get(runId)!;
  },

  record(runId: string, input: { outcome: TerminationOutcome; processId?: number | null; processStarted?: string | null; methods?: RunTermination["methods"]; note?: string | null; checkedAt?: number }): void {
    const checkedAt = input.checkedAt ?? Date.now();
    const exited = input.outcome === "exited" || input.outcome === "no-process";
    db.run(
      `UPDATE run_terminations SET outcome = ?, process_id = COALESCE(?, process_id), process_started = COALESCE(?, process_started),
         methods = ?, checked_at = ?, exited_at = CASE WHEN ? THEN COALESCE(exited_at, ?) ELSE exited_at END, note = ?
       WHERE run_id = ?`,
      [input.outcome, input.processId ?? null, input.processStarted ?? null, JSON.stringify(input.methods ?? []), checkedAt, exited ? 1 : 0, checkedAt, input.note ?? null, runId],
    );
  },

  /** A process that was unconfirmed has since exited: the driver observed it, and the run is settling. */
  markExitedLate(runId: string, now = Date.now()): void {
    db.run(
      `UPDATE run_terminations SET outcome = 'exited', exited_at = COALESCE(exited_at, ?), checked_at = ?,
         note = COALESCE(note || ' ', '') || 'The process was later observed to exit.'
       WHERE run_id = ? AND outcome = 'unconfirmed'`,
      [now, now, runId],
    );
  },

  /** Runs still open that carry an armed limit or an unfinished stop, for boot recovery. */
  openForRecovery(): Array<{ termination: RunTermination; processStarted: string | null }> {
    const rows = db.query<Row, []>(
      `SELECT t.* FROM run_terminations t JOIN runs r ON r.id = t.run_id WHERE r.status = 'running'`,
    ).all();
    return rows.map((row) => ({ termination: toTermination(row), processStarted: row.process_started }));
  },

  /**
   * Runs of this task whose process was recorded and never observed gone: a stop that stayed unconfirmed, or one that a
   * restart found still running (or could not check). A refusal to start reads these; it never signals the process.
   */
  unresolvedProcessesForTask(taskId: string): Array<{ termination: RunTermination; processStarted: string | null }> {
    const rows = db.query<Row, [string]>(
      `SELECT t.* FROM run_terminations t JOIN runs r ON r.id = t.run_id
       WHERE r.task_id = ? AND t.process_id IS NOT NULL AND t.outcome IN ('unconfirmed', 'recovered-alive', 'recovered-unknown')`,
    ).all(taskId);
    return rows.map((row) => ({ termination: toTermination(row), processStarted: row.process_started }));
  },

  /** The same records for every task (a project's drain counts them; it never signals a process). */
  unresolvedProcesses(): Array<{ taskId: string; termination: RunTermination; processStarted: string | null }> {
    const rows = db.query<Row & { task_id: string }, []>(
      `SELECT t.*, r.task_id AS task_id FROM run_terminations t JOIN runs r ON r.id = t.run_id
       WHERE t.process_id IS NOT NULL AND t.outcome IN ('unconfirmed', 'recovered-alive', 'recovered-unknown')`,
    ).all();
    return rows.map((row) => ({ taskId: row.task_id, termination: toTermination(row), processStarted: row.process_started }));
  },

  /** Terminal runs whose stop never reached an outcome (the core stopped mid-stop). */
  unfinishedOnTerminalRuns(): Array<{ termination: RunTermination; processStarted: string | null; runStatus: string }> {
    const rows = db.query<Row & { run_status: string }, []>(
      `SELECT t.*, r.status AS run_status FROM run_terminations t JOIN runs r ON r.id = t.run_id
       WHERE r.status <> 'running' AND t.requested_at IS NOT NULL AND (t.outcome IS NULL OR t.outcome = 'unconfirmed')`,
    ).all();
    return rows.map((row) => ({ termination: toTermination(row), processStarted: row.process_started, runStatus: row.run_status }));
  },
};
