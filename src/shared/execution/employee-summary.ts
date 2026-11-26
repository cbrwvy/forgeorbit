/**
 * Employee work summary (Direction 2): a read-only roll-up of what the
 * records establish about one employee's supervised runs.
 *
 * It adds no authority and no new record. Every number is a count or a sum
 * over attempts whose identity was recorded at the Owner-confirmed start
 * (`employee_executions`). Unknown stays Unknown:
 *
 * - time is a sum only over runs with a recorded start and end, and says how
 *   many runs are missing from it;
 * - cost is grouped by evidence category and currency and is never added across
 *   either; a fixture run or a run with no billing evidence is "unknown", not 0;
 * - a QC PASS and the Owner's acceptance are separate counts;
 * - no quality score is produced. The recorded outcomes are the measure.
 */

import type { EmployeeRunPhase } from "./run.ts";

export type SummaryCostKind = "reported-api" | "calculated-api" | "subscription" | "internal" | "unknown";
export type SummaryExecution = "real-provider" | "synthetic" | "unknown";
export type SummaryVerdict = "PASS" | "CHANGES_REQUESTED" | "BLOCKED";

/** What the records say about the QC review of one attempt's own run. */
export interface SummaryAttemptReview {
  status: "pending" | "running" | "complete" | "cancelled";
  verdict: SummaryVerdict | null;
  /** This is the newest review round of the task. */
  latestRound: boolean;
}

export interface SummaryAttemptFact {
  attemptId: string;
  taskId: string;
  phase: EmployeeRunPhase;
  startedAt: number | null;
  finishedAt: number | null;
  /** Null when the attempt has no run, or the run has no recorded evidence of its execution type. */
  execution: SummaryExecution | null;
  cost: { kind: SummaryCostKind; money: { amount: number; currency: string } | null } | null;
  /** The newest review of this attempt's own implementation run, if any. */
  review: SummaryAttemptReview | null;
  /** The task is in Done and its newest review round is a PASS of this run. */
  ownerAccepted: boolean;
  /** QC passed this run, the task is not Done and the Owner has not yet accepted it. */
  awaitingOwner: boolean;
}

export interface SummaryReviewPerformed {
  status: "pending" | "running" | "complete" | "cancelled";
  verdict: SummaryVerdict | null;
}

export interface EmployeeWorkSummary {
  employeeId: string;
  /** Attempts the summary read (newest first), and whether older ones exist. */
  attemptsRead: number;
  truncated: boolean;
  /** Attempts the Owner confirmed that really reached the runtime. */
  runsStarted: number;
  outcomes: { completed: number; failed: number; cancelled: number; unknown: number; inProgress: number };
  /** Attempts reviewed but never started (declined, expired, withdrawn) are not runs. */
  notStarted: number;
  review: { passed: number; changesRequested: number; blocked: number; noVerdict: number; inProgress: number; notReviewed: number };
  /** QC PASS is not acceptance. */
  ownerAccepted: number;
  awaitingOwner: number;
  time: { totalMs: number | null; runsWithTime: number; runsWithoutTime: number };
  cost: {
    /** One line per evidence category and currency. Never summed across either. */
    lines: { kind: Exclude<SummaryCostKind, "unknown">; currency: string | null; amount: number | null; runs: number }[];
    unknownRuns: number;
    fixtureRuns: number;
  };
  /** Reviews this employee is recorded as having performed (a reviewer identity is rarely recorded). */
  reviewsPerformed: { total: number; passed: number; changesRequested: number; blocked: number; noVerdict: number; inProgress: number };
  /** Always null: no rating is computed from these records. */
  quality: null;
}

export function summarizeEmployeeWork(
  employeeId: string,
  attempts: SummaryAttemptFact[],
  performed: SummaryReviewPerformed[],
  truncated: boolean,
): EmployeeWorkSummary {
  const started = attempts.filter((a) => ["running", "starting", "completed", "failed", "cancelled", "unknown-outcome"].includes(a.phase));
  const outcomes = { completed: 0, failed: 0, cancelled: 0, unknown: 0, inProgress: 0 };
  const review = { passed: 0, changesRequested: 0, blocked: 0, noVerdict: 0, inProgress: 0, notReviewed: 0 };
  let ownerAccepted = 0;
  let awaitingOwner = 0;
  let totalMs = 0;
  let runsWithTime = 0;
  let runsWithoutTime = 0;
  const costLines = new Map<string, { kind: Exclude<SummaryCostKind, "unknown">; currency: string | null; amount: number | null; runs: number }>();
  let unknownRuns = 0;
  let fixtureRuns = 0;

  for (const a of started) {
    if (a.phase === "completed") outcomes.completed++;
    else if (a.phase === "failed") outcomes.failed++;
    else if (a.phase === "cancelled") outcomes.cancelled++;
    else if (a.phase === "unknown-outcome") outcomes.unknown++;
    else outcomes.inProgress++;

    if (a.startedAt != null && a.finishedAt != null && a.finishedAt >= a.startedAt) {
      totalMs += a.finishedAt - a.startedAt;
      runsWithTime++;
    } else runsWithoutTime++;

    const r = a.review;
    if (!r || r.status === "cancelled") review.notReviewed++;
    else if (r.status !== "complete") review.inProgress++;
    else if (r.verdict === "PASS") review.passed++;
    else if (r.verdict === "CHANGES_REQUESTED") review.changesRequested++;
    else if (r.verdict === "BLOCKED") review.blocked++;
    else review.noVerdict++;
    if (a.ownerAccepted) ownerAccepted++;
    if (a.awaitingOwner) awaitingOwner++;

    if (a.execution === "synthetic") fixtureRuns++;
    const cost = a.cost;
    if (!cost || cost.kind === "unknown" || (a.execution !== "real-provider")) {
      unknownRuns++;
      continue;
    }
    const currency = cost.money?.currency ?? null;
    const key = `${cost.kind}|${currency ?? ""}`;
    const line = costLines.get(key) ?? { kind: cost.kind, currency, amount: cost.money ? 0 : null, runs: 0 };
    line.runs++;
    if (cost.money && line.amount !== null) line.amount += cost.money.amount;
    costLines.set(key, line);
  }

  const performedTotals = { total: performed.length, passed: 0, changesRequested: 0, blocked: 0, noVerdict: 0, inProgress: 0 };
  for (const p of performed) {
    if (p.status !== "complete") { if (p.status !== "cancelled") performedTotals.inProgress++; continue; }
    if (p.verdict === "PASS") performedTotals.passed++;
    else if (p.verdict === "CHANGES_REQUESTED") performedTotals.changesRequested++;
    else if (p.verdict === "BLOCKED") performedTotals.blocked++;
    else performedTotals.noVerdict++;
  }

  return {
    employeeId,
    attemptsRead: attempts.length,
    truncated,
    runsStarted: started.length,
    outcomes,
    notStarted: attempts.length - started.length,
    review,
    ownerAccepted,
    awaitingOwner,
    time: { totalMs: runsWithTime > 0 ? totalMs : null, runsWithTime, runsWithoutTime },
    cost: { lines: [...costLines.values()], unknownRuns, fixtureRuns },
    reviewsPerformed: performedTotals,
    quality: null,
  };
}
