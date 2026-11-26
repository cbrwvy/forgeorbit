/**
 * Employee work summary (Direction 2): read-only roll-up over existing records.
 * No write, no process, no CLI or provider call, no new table. Costs and time
 * come from the same task actuals the Analytics page reads; QC outcomes from
 * `task_quality_reviews`; attribution from the Owner-confirmed attempt row.
 */

import { db, tasks } from "./db.ts";
import { listEmployeeRuns, type EmployeeRunDeps } from "./employee-run.ts";
import { taskActuals } from "./usage-analytics/actuals.ts";
import type { EmployeeRunView } from "../shared/execution/run.ts";
import {
  summarizeEmployeeWork,
  type EmployeeWorkSummary,
  type SummaryAttemptFact,
  type SummaryAttemptReview,
  type SummaryReviewPerformed,
  type SummaryVerdict,
} from "../shared/execution/employee-summary.ts";

const PAGE = 100;
/** Bound the work: the newest attempts, and a flag saying older ones exist. */
export const SUMMARY_MAX_ATTEMPTS = 500;
const SUMMARY_MAX_TASKS = 100;

interface ReviewRow {
  id: string;
  task_id: string;
  round: number;
  status: SummaryAttemptReview["status"];
  verdict: SummaryVerdict | null;
  implementation_run_id: string | null;
}

export function employeeWorkSummary(employeeId: string, deps: EmployeeRunDeps = {}): EmployeeWorkSummary {
  const attempts: EmployeeRunView[] = [];
  let truncated = false;
  let before: string | undefined;
  for (;;) {
    const page = listEmployeeRuns({ employeeId, limit: PAGE, before }, deps);
    attempts.push(...page);
    if (page.length < PAGE) break;
    if (attempts.length >= SUMMARY_MAX_ATTEMPTS) { truncated = true; break; }
    before = page.at(-1)!.id;
  }

  const taskIds = [...new Set(attempts.filter((a) => a.runId).map((a) => a.taskId))].slice(0, SUMMARY_MAX_TASKS);
  const actualByRun = new Map<string, NonNullable<ReturnType<typeof taskActuals>>["runs"][number]>();
  const reviewsByTask = new Map<string, ReviewRow[]>();
  for (const taskId of taskIds) {
    const actual = taskActuals(taskId);
    for (const run of actual?.runs ?? []) actualByRun.set(run.id, run);
    reviewsByTask.set(taskId, db.query<ReviewRow, [string]>(
      `SELECT id, task_id, round, status, verdict, implementation_run_id FROM task_quality_reviews WHERE task_id = ? ORDER BY round`,
    ).all(taskId));
  }

  const facts: SummaryAttemptFact[] = attempts.map((attempt) => {
    const run = attempt.runId ? actualByRun.get(attempt.runId) : undefined;
    const reviews = reviewsByTask.get(attempt.taskId) ?? [];
    const own = attempt.runId ? reviews.filter((r) => r.implementation_run_id === attempt.runId).at(-1) : undefined;
    const newestRound = reviews.at(-1)?.round ?? 0;
    const task = tasks.get(attempt.taskId);
    const review: SummaryAttemptReview | null = own
      ? { status: own.status, verdict: own.verdict, latestRound: own.round === newestRound }
      : null;
    const passedLatest = !!review && review.status === "complete" && review.verdict === "PASS" && review.latestRound;
    return {
      attemptId: attempt.id,
      taskId: attempt.taskId,
      phase: attempt.phase,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      execution: (run?.execution as SummaryAttemptFact["execution"] | undefined) ?? null,
      cost: run ? { kind: run.cost.kind, money: run.cost.money } : null,
      review,
      ownerAccepted: passedLatest && task?.column === "done",
      awaitingOwner: passedLatest && !!task && task.column !== "done" && task.qcState?.awaitingOwnerApproval === true,
    };
  });

  const performed = db.query<{ status: SummaryReviewPerformed["status"]; verdict: SummaryVerdict | null }, [string]>(
    `SELECT status, verdict FROM task_quality_reviews WHERE reviewer_employee_id = ?`,
  ).all(employeeId);

  return summarizeEmployeeWork(employeeId, facts, performed, truncated);
}
