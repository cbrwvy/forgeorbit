import { db } from "../db.ts";
import { ownerProjectOf } from "../project-ownership.ts";
import { FX_PROVIDER_STATUS_PREFIX, FX_USAGE_STATUS_PREFIX } from "../../shared/types.ts";
import { isSyntheticEvidenceSource, providerBill, RUN_USAGE_STATUS_PREFIX, type AnalyticsFilter, type MoneyAmount, type RunCost, type TokenUsage } from "../../shared/usage-analytics.ts";
import { preparationActual } from "../orchestration/mission-preparation.ts";
import { taskWaiting } from "./waiting.ts";
import { costFor, pricingAt } from "./resources.ts";
import { providerName, type RunScope } from "./scope.ts";

const emptyTokens: TokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };
const unknownCost: RunCost = { kind: "unknown", money: null, pricingId: null, source: null };
type Interval = { start: number; end: number };
export function unionMs(intervals: Interval[]): number {
  let end = -Infinity;
  let total = 0;
  for (const part of intervals.slice().sort((a, b) => a.start - b.start)) {
    total += Math.max(0, part.end - Math.max(end, part.start));
    end = Math.max(end, part.end);
  }
  return total;
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  const position = (ordered.length - 1) * q;
  const left = Math.floor(position);
  return Math.round(ordered[left]! + (ordered[Math.ceil(position)]! - ordered[left]!) * (position - left));
}

interface RunRow {
  id: string;
  agent: string;
  task_id: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  qc_review_id: string | null;
  prior_codex_thread: number;
  origin: string | null;
  attributed_project: string | null;
  attributed_mission: string | null;
  category: string;
  usage_scope: string | null;
  usage_estimate_id: number | null;
  employee_id: string | null;
  employee_name: string | null;
  actual_harness_id: string | null;
  actual_model: string | null;
  actual_account_id: string | null;
}

interface RuntimeIdentity {
  executionType?: string;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  accountProfile?: { id?: string } | null;
}
interface QuotaReceipt {
  quotaId: string;
  amount: number;
  unit: string;
  source: "provider-reported-receipt";
}
interface RunUsage {
  identity: RuntimeIdentity | null;
  tokens: TokenUsage;
  usageSource: string | null;
  reported: MoneyAmount | null;
  reportedBill: MoneyAmount | null;
  fxProvider: string | null;
  quotaReceipt: QuotaReceipt | null;
}

function quotaReceipt(value: unknown): QuotaReceipt | null {
  const row = record(value);
  const quotaId = string(row?.quotaId);
  const unit = string(row?.unit);
  const amount = row?.amount;
  if (!quotaId || !unit || !/^[A-Za-z0-9_.:-]{1,80}$/.test(quotaId) || !/^[A-Za-z0-9_.:-]{1,40}$/.test(unit)) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e15) return null;
  return { quotaId, amount, unit, source: "provider-reported-receipt" };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function object(data: string): Record<string, unknown> | null {
  try { return record(JSON.parse(data)); }
  catch { return null; }
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function money(amount: unknown, currency: unknown): MoneyAmount | null {
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 &&
    typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? { amount, currency } : null;
}

function usageFor(runId: string, cutoff: number): RunUsage {
  const rows = db.query<{ data: string }, [string, number]>(`
    SELECT data FROM run_events INDEXED BY idx_run_events_run
    WHERE run_id = ? AND ts <= ? AND stream = 'status' AND subagent_id IS NULL
      AND (data LIKE '{"kind":"execution-identity"%' OR data LIKE '{"accountProfile":%"kind":"execution-identity"%'
        OR data LIKE '%"kind":"claude-bounded-result"}' OR data LIKE 'fx-usage: %' OR data LIKE 'fx-provider: %' OR data LIKE 'usage-accounting: %')
    ORDER BY id
  `).all(runId, cutoff);
  const result: RunUsage = { identity: null, tokens: emptyTokens, usageSource: null, reported: null, reportedBill: null, fxProvider: null, quotaReceipt: null };
  for (const { data } of rows) {
    if (data.startsWith(RUN_USAGE_STATUS_PREFIX)) {
      const item = object(data.slice(RUN_USAGE_STATUS_PREFIX.length));
      if (!item) continue;
      const billed = record(item.billed);
      if (billed) result.reportedBill = providerBill(billed) ?? result.reportedBill;
      result.quotaReceipt = quotaReceipt(item.quota) ?? result.quotaReceipt;
      const tokens = { input: count(item.input), output: count(item.output), cacheRead: count(item.cacheRead), cacheWrite: count(item.cacheWrite) };
      if (Object.values(tokens).some(v => v !== null)) {
        result.usageSource = string(item.source) ?? "codex-turn";
        result.tokens = tokens;
      }
    } else if (data.startsWith(FX_PROVIDER_STATUS_PREFIX)) {
      const provider = data.slice(FX_PROVIDER_STATUS_PREFIX.length);
      if (/^[a-z0-9_.-]{1,40}$/i.test(provider)) result.fxProvider = provider;
    } else if (data.startsWith(FX_USAGE_STATUS_PREFIX)) {
      const item = object(data.slice(FX_USAGE_STATUS_PREFIX.length));
      const turn = record(item?.turn);
      if (turn) {
        result.usageSource = "fx-turn";
        result.tokens = {
          input: count(turn.inputTokens), output: count(turn.outputTokens),
          cacheRead: count(turn.cacheReadTokens), cacheWrite: count(turn.cacheWriteTokens),
        };
      }
      const cost = record(item?.cost);
      if (cost) result.reported = money(cost.amount, cost.currency);
    } else {
      const item = object(data);
      if (item?.kind === "execution-identity" && !result.identity) {
        const accountProfile = record(item.accountProfile);
        result.identity = {
          executionType: string(item.executionType), provider: string(item.provider), model: string(item.model), mode: string(item.mode),
          accountProfile: { id: string(accountProfile?.id) },
        };
      }
      if (item?.kind === "claude-bounded-result") {
        const usage = record(item.usage);
        result.usageSource = "claude-bounded-result";
        result.tokens = {
          input: count(usage?.input_tokens), output: count(usage?.output_tokens),
          cacheRead: count(usage?.cache_read_input_tokens), cacheWrite: count(usage?.cache_creation_input_tokens),
        };
        result.reported = money(item.total_cost_usd, "USD");
      }
    }
  }
  return result;
}

function accountRun(row: RunRow, doneAt: number | null, now: number) {
  const cutoff = doneAt ?? now;
  const usage = usageFor(row.id, cutoff);
  const evidence = usage.identity;
  const execution = evidence?.executionType === "real-provider" ? "real-provider"
    : evidence?.executionType === "synthetic" || evidence?.executionType === "fixture" ? "synthetic" : "unknown";
  const harnessId = row.actual_harness_id ?? row.agent;
  const model = evidence?.model ?? row.actual_model ?? null;
  const accountId = evidence?.accountProfile?.id ?? row.actual_account_id ?? null;
  const kind = evidence?.provider ?? null;
  const provider = kind === "fx" ? usage.fxProvider ?? kind : kind ? providerName(kind) : null;
  const price = execution === "real-provider" && model ? pricingAt({ harnessId, accountId, modelId: model }, row.started_at) : null;
  const codex = usage.usageSource === "codex-turn" && kind === "codex";
  const claude = usage.usageSource === "claude-bounded-result" && kind === "claude-code";
  // Codex exec may report thread totals on resume. Avoid adding those to
  // earlier runs without a proven baseline for the resumed transport.
  const resumedCodex = codex && (row.prior_codex_thread === 1 || row.origin === "continuation");
  const recordedEvidence = isSyntheticEvidenceSource(usage.usageSource);
  const rawTokens = ((execution !== "real-provider" && !recordedEvidence) || resumedCodex) ? emptyTokens : usage.tokens;
  let tokens = rawTokens;
  if (claude) {
    const { input, cacheRead, cacheWrite } = rawTokens;
    tokens = { ...rawTokens, input: input !== null && cacheRead !== null && cacheWrite !== null ? input + cacheRead + cacheWrite : null };
  }
  if (usage.usageSource === "fx-turn") tokens = { ...rawTokens, input: null };
  const codexWrites = rawTokens.cacheWrite ?? (price?.terms.cacheWritePerMillion ? null : 0);
  const codexCharge = !resumedCodex && codex && codexWrites === 0;
  const charge = codexCharge
    ? costFor(price, { ...rawTokens, cacheWrite: 0 }, true)
    : costFor(price, claude ? rawTokens : emptyTokens, false);
  const cost: RunCost = execution === "real-provider" && !resumedCodex && usage.reportedBill && charge.kind !== "subscription"
    ? { kind: "reported-api", money: usage.reportedBill, pricingId: null, source: "provider-billing-event" }
    : execution === "real-provider" ? charge : unknownCost;
  const durationMs = row.ended_at === null || row.ended_at < row.started_at ? null : Math.min(row.ended_at, cutoff) - row.started_at;
  const scope: RunScope | null = row.usage_scope ? JSON.parse(row.usage_scope) as RunScope
    : row.attributed_project || row.attributed_mission ? {
      projectPath: row.attributed_project, clusterId: null, missionId: row.attributed_mission,
      category: row.category, technology: "unknown", complexity: null,
    } : null;
  return {
    id: row.id, taskId: row.task_id, mode: evidence?.mode ?? null, start: row.started_at, end: row.ended_at, durationMs, status: row.status,
    provider, model, harnessId, accountId, specialist: row.employee_id,
    // The name the worker had when the attempt ran (recorded with the execution); never the current one.
    workerName: row.employee_name,
    role: row.qc_review_id ? "reviewer" as const : "developer" as const,
    qcId: row.qc_review_id, execution, scope, estimateId: row.usage_estimate_id,
    tokens, rawTokens, tokenSource: (execution !== "real-provider" && !recordedEvidence) ? null : resumedCodex ? "codex-resumed-unattributable" : usage.usageSource,
    reportedTelemetry: execution === "real-provider" ? usage.reported : null,
    subscriptionUsage: execution === "real-provider" && !resumedCodex ? usage.quotaReceipt : null, cost,
  };
}

interface TaskRow { id: string; title: string; workdir: string; created_at: number; column: string; task_type: string }
type Review = {
  id: string; round: number; verdict: string | null; review_run_id: string | null; reviewer_employee_id: string | null;
  started_at: number | null; completed_at: number | null;
};
type Test = {
  id: string; status: string; rework_epoch: number; started_at: number; finished_at: number | null;
  mission_id: string | null;
};

export function taskActuals(taskId: string, now = Date.now()) {
  const task = db.query<TaskRow, [string]>(
    'SELECT id,title,workdir,created_at,"column",task_type FROM tasks WHERE id = ?',
  ).get(taskId);
  if (!task) return null;
  const transitions = db.query<{ destination: string; at: number }, [string]>(
    "SELECT destination, at FROM usage_task_transitions WHERE task_id = ? ORDER BY id",
  ).all(taskId);
  const doneAt = task.column === "done" ? transitions.findLast(t => t.destination === "done")?.at ?? null : null;
  // A finished task whose Done was never recorded (older tasks). Its end is unknown, so the clock must not stand in for it:
  // time is read only up to the last thing the records show, and nothing about the task grows as the days pass.
  const finishedUnrecorded = task.column === "done" && doneAt === null;
  const lastRecordedAt = finishedUnrecorded ? db.query<{ at: number }, [string, string, string, string, string, string]>(`
    SELECT MAX(at) AS at FROM (
      SELECT created_at AS at FROM tasks WHERE id = ?
      UNION ALL SELECT MAX(at) FROM usage_task_transitions WHERE task_id = ?
      UNION ALL SELECT MAX(MAX(started_at), COALESCE(MAX(ended_at), 0)) FROM runs WHERE task_id = ?
      UNION ALL SELECT MAX(MAX(started_at), COALESCE(MAX(finished_at), 0)) FROM practical_test_attempts WHERE task_id = ?
      UNION ALL SELECT MAX(MAX(requested_at), COALESCE(MAX(completed_at), 0)) FROM task_quality_reviews WHERE task_id = ?
      UNION ALL SELECT MAX(at) FROM mission_wait_transitions WHERE task_id = ?
    )`).get(taskId, taskId, taskId, taskId, taskId, taskId)?.at ?? null : null;
  const cutoff = doneAt ?? (lastRecordedAt !== null ? Math.min(now, lastRecordedAt) : now);
  const rows = db.query<RunRow, [string, string, number]>(`
    SELECT r.id, r.task_id, r.agent, r.status, r.started_at, r.ended_at, r.qc_review_id, r.usage_scope, r.usage_estimate_id, r.origin,
      e.employee_id, e.employee_name, e.actual_harness_id, e.actual_model, e.actual_account_id, task.task_type AS category,
      COALESCE(e.project_path, q.project_path, reservation.project_path) AS attributed_project,
      reservation.mission_id AS attributed_mission,
      EXISTS (SELECT 1 FROM runs prior WHERE prior.task_id = r.task_id AND prior.rowid < r.rowid
        AND prior.codex_session_id = r.codex_session_id) AS prior_codex_thread
    FROM runs r JOIN tasks task ON task.id = r.task_id
    LEFT JOIN employee_executions e ON e.run_id = r.id AND e.actual_provenance = 'runtime'
    LEFT JOIN task_quality_reviews q ON q.id = r.qc_review_id
    LEFT JOIN orchestration_reservations reservation ON reservation.task_id = r.task_id AND
      (reservation.run_id = r.id OR reservation.qc_review_id = r.qc_review_id)
    WHERE (r.task_id = ? OR task.pipeline_parent_id = ?) AND r.started_at <= ? ORDER BY r.started_at, r.rowid
  `).all(taskId, taskId, cutoff);
  const reviews = db.query<Review, [string, number]>(`
    SELECT id,round,verdict,review_run_id,reviewer_employee_id,started_at,completed_at FROM task_quality_reviews
    WHERE task_id = ? AND requested_at <= ? ORDER BY round
  `).all(taskId, cutoff).map(review => review.completed_at !== null && review.completed_at > cutoff ? { ...review, verdict: null } : review);
  const reviewers = new Map(reviews.map(q => [q.id, q.reviewer_employee_id]));
  // A Reviewer's name is not stored with the review, only its id: the registry's current name is shown, the id is the attribution.
  const reviewerIds = [...new Set([...reviewers.values()].filter((value): value is string => !!value))];
  const reviewerNames = new Map(reviewerIds.length ? db.query<{ id: string; name: string }, string[]>(
    `SELECT id, name FROM ai_employees WHERE id IN (${reviewerIds.map(() => "?").join(",")})`,
  ).all(...reviewerIds).map(person => [person.id, person.name]) : []);
  const runs = rows.map(row => {
    const run = accountRun(row, doneAt, now);
    const specialist = run.specialist ?? (run.qcId ? reviewers.get(run.qcId) ?? null : null);
    return { ...run, specialist, workerName: run.workerName ?? (run.qcId && specialist ? reviewerNames.get(specialist) ?? null : null) };
  });
  const tests = db.query<Test, [string, number]>(`
    SELECT id,status,rework_epoch,started_at,finished_at,mission_id FROM practical_test_attempts
    WHERE task_id = ? AND started_at <= ? ORDER BY started_at
  `).all(taskId, cutoff);
  const intervals = runs.flatMap(r => r.durationMs === null ? [] : [{ start: r.start, end: r.start + r.durationMs }]);
  const testIntervals = tests.flatMap(t => t.finished_at === null ? [] : [{ start: t.started_at, end: Math.min(t.finished_at, cutoff) }]);
  const firstRunAt = runs[0]?.start ?? null;
  const entry = transitions.findLast(t => t.destination !== "running" && firstRunAt !== null && t.at <= firstRunAt);
  const readyAt = entry?.destination === "ready" ? entry.at : null;
  const changeReviews = reviews.filter(q => q.verdict === "CHANGES_REQUESTED");
  const reworkTriggers = [
    ...changeReviews.flatMap(q => q.completed_at === null ? [] : [q.completed_at]),
    ...tests.flatMap(t => t.status === "failed" && t.finished_at !== null && t.finished_at <= cutoff ? [t.finished_at] : []),
  ];
  const reworkRuns = new Set(reworkTriggers.map(at => runs.find(r => r.role === "developer" && r.start >= at)?.id).filter(Boolean));
  const sum = (values: Array<number | null>): number | null => {
    const observed = values.filter(v => v !== null);
    return observed.length ? observed.reduce((a, b) => a + b, 0) : null;
  };
  const reviewRuns = runs.filter(r => r.role === "reviewer");
  const reviewIntervals = reviews.flatMap(q =>
    q.started_at === null || q.completed_at === null ? [] : [{ start: q.started_at, end: Math.min(q.completed_at, cutoff) }]);
  const qcIntervals = [...reviewIntervals, ...reviewRuns.flatMap(r =>
    r.durationMs === null ? [] : [{ start: r.start, end: r.start + r.durationMs }])];
  const firstReview = reviews.find(q => q.verdict !== null);
  const covered = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return { ms: known.length ? known.reduce((total, value) => total + value, 0) : null, known: known.length, missing: values.length - known.length };
  };
  const developer = covered(runs.filter(run => run.role === "developer").map(run => run.durationMs));
  const reviewer = covered(runs.filter(run => run.role === "reviewer").map(run => run.durationMs));
  const admission = (destination: string) => transitions.find(row => row.destination === destination)?.at ?? null;
  const receipts = runs.flatMap(run => run.subscriptionUsage ? [{ runId: run.id, ...run.subscriptionUsage }] : []);
  const preparation = preparationActual(taskId, cutoff);
  const waiting = taskWaiting(taskId, cutoff, [
    ...intervals, ...runs.flatMap(run => run.status === "running" && run.start <= cutoff ? [{ start: run.start, end: cutoff }] : []),
  ], testIntervals, firstRunAt !== null && readyAt !== null ? { start: readyAt, end: firstRunAt } : null);
  const activeWallMs = intervals.length ? unionMs(intervals) : null;
  return {
    id: task.id, title: task.title, column: task.column, category: task.task_type, createdAt: task.created_at,
    projectPath: runs[0]?.scope?.projectPath ?? ownerProjectOf(task.workdir),
    finishedUnrecorded, firstRunAt, doneAt, totalElapsedMs: doneAt !== null ? Math.max(0, doneAt - task.created_at) : null,
    executionElapsedMs: doneAt !== null && firstRunAt !== null ? Math.max(0, doneAt - firstRunAt) : null,
    queueMs: firstRunAt !== null && readyAt !== null ? firstRunAt - readyAt : null,
    waiting, activeWallMs,
    workerMs: sum(runs.map(r => r.durationMs)), testMs: testIntervals.length ? unionMs(testIntervals) : null,
    qcMs: qcIntervals.length ? unionMs(qcIntervals) : null,
    reworkMs: sum(runs.filter(r => reworkRuns.has(r.id)).map(r => r.durationMs)),
    reworks: reworkRuns.size, failed: runs.filter(r => r.status === "failed").length,
    interrupted: runs.filter(r => r.status === "orphaned" || r.status === "cancelled").length,
    firstVerdict: firstReview?.verdict ?? null, reviews, tests, runs,
    frozenEstimateId: runs.find(r => r.estimateId !== null)?.estimateId ?? null,
    humanMs: null,
    preparation,
    subscriptionQuota: receipts.length
      ? { status: "reported" as const, receipts, statement: null }
      : { status: "unknown" as const, receipts, statement: "Per-task subscription quota consumption: Unknown" },
    lifecycle: {
      complete: doneAt !== null,
      backlogAt: admission("backlog"),
      inboxAt: admission("inbox"),
      readyAt: admission("ready"),
      firstExecutionAt: firstRunAt,
      doneAt,
      createdToDoneMs: doneAt !== null ? Math.max(0, doneAt - task.created_at) : null,
      firstExecutionToDoneMs: doneAt !== null && firstRunAt !== null ? Math.max(0, doneAt - firstRunAt) : null,
      partialCreatedMs: doneAt === null && !finishedUnrecorded ? Math.max(0, now - task.created_at) : null,
      partialExecutionMs: doneAt === null && !finishedUnrecorded && firstRunAt !== null ? Math.max(0, cutoff - firstRunAt) : null,
      workerMs: sum(runs.map(run => run.durationMs)),
      activeWallMs,
      developerMs: developer.ms, developerCoverage: developer,
      reviewerMs: reviewer.ms, reviewerCoverage: reviewer,
      preparationMs: preparation.durationMs,
      testMs: testIntervals.length ? unionMs(testIntervals) : null,
      qcMs: qcIntervals.length ? unionMs(qcIntervals) : null,
      reworkMs: sum(runs.filter(run => reworkRuns.has(run.id)).map(run => run.durationMs)),
      waitingMs: waiting.measuredMs,
      unclassifiedMs: waiting.unknownMs,
      attempts: runs.length,
      completedRuns: runs.filter(run => run.status === "succeeded").length,
      failures: runs.filter(run => run.status === "failed").length,
      interruptions: runs.filter(run => run.status === "orphaned" || run.status === "cancelled").length,
      qcRounds: reviews.length,
      coverage: {
        done: doneAt !== null || task.column !== "done" ? doneAt !== null ? "recorded" as const : "open" as const : "unknown" as const,
        inbox: admission("inbox") !== null ? "recorded" as const : "unknown" as const,
        ready: admission("ready") !== null ? "recorded" as const : "unknown" as const,
        backlog: admission("backlog") !== null ? "recorded" as const : "unknown" as const,
      },
    },
  };
}

export type ActualTask = NonNullable<ReturnType<typeof taskActuals>>;
export type ActualRun = ActualTask["runs"][number];

export function summarizeRuns(runs: ActualRun[]) {
  const real = runs.filter(r => r.execution === "real-provider");
  const tokens = { ...emptyTokens };
  const tokenCoverage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const key of Object.keys(tokens) as Array<keyof TokenUsage>) {
    for (const run of real) {
      const value = run.tokens[key];
      if (value === null) continue;
      tokens[key] = (tokens[key] ?? 0) + value;
      tokenCoverage[key]++;
    }
  }
  const costTotals = new Map<string, { kind: RunCost["kind"]; currency: string; amount: number }>();
  for (const { cost } of real) {
    if (!cost.money) continue;
    const key = cost.kind + "/" + cost.money.currency;
    const prior = costTotals.get(key);
    costTotals.set(key, { kind: cost.kind, currency: cost.money.currency, amount: (prior?.amount ?? 0) + cost.money.amount });
  }
  const durations = real.flatMap(r => r.durationMs === null ? [] : [r.durationMs]);
  return {
    runs: runs.length, realRuns: real.length, syntheticRuns: runs.filter(r => r.execution === "synthetic").length,
    unknownRuns: runs.filter(r => r.execution === "unknown").length,
    workerMs: durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : null,
    tokens, tokenCoverage, costTotals: [...costTotals.values()],
    subscriptionRuns: real.filter(r => r.cost.kind === "subscription").length,
    unknownCostRuns: real.filter(r => r.cost.kind !== "subscription" && r.cost.money === null).length,
  };
}

export function matchesRun(run: ActualRun, filter: AnalyticsFilter): boolean {
  return (!filter.projectPath || run.scope?.projectPath === filter.projectPath) &&
    (!filter.clusterId || run.scope?.clusterId === filter.clusterId) &&
    (!filter.missionId || run.scope?.missionId === filter.missionId) &&
    (!filter.category || run.scope?.category === filter.category) &&
    (!filter.specialist || run.role === filter.specialist || run.specialist === filter.specialist) &&
    (!filter.provider || run.provider === filter.provider) &&
    (!filter.model || run.model === filter.model) &&
    (!filter.accountId || run.accountId === filter.accountId);
}
