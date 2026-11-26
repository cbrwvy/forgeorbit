import { db, projects } from "../db.ts";
import { missionStore } from "../orchestration/mission-store.ts";
import { AccountCore } from "../account-core.ts";
import { isTimeZone, type TrendGrain } from "../../shared/company-analytics.ts";
import type { AnalyticsFilter } from "../../shared/usage-analytics.ts";
import { listAdjustments } from "./adjustments.ts";
import { type ActualRun, type ActualTask, matchesRun, quantile, summarizeRuns, taskActuals } from "./actuals.ts";
import { buildCompany } from "./company.ts";
import { forecastCost, frozenEstimate, originalEstimate } from "./forecast.ts";
import { buildForecastComparison } from "./comparison.ts";
import { quotaFor } from "./resources.ts";

export interface AnalyticsView {
  timeZone?: string;
  grain?: TrendGrain;
  taskLimit?: number;
}

const DAY = 86_400_000;
/** The most tasks one scope reads. Beyond it the totals describe the most recently updated MAX_TASKS and say so. */
export const MAX_TASKS = 500;

export function taskBreakdown(taskId: string) {
  const actual = taskActuals(taskId);
  if (!actual) return null;
  const estimate = frozenEstimate(actual.frozenEstimateId);
  const actualUsage = summarizeRuns(actual.runs);
  const forecastUsage = estimate ? forecastCost([estimate]) : null;
  const sameResources = estimate !== null && actual.runs.length > 0 && actual.runs.every(run => {
    const resource = estimate[run.role];
    return resource && run.harnessId === resource.harnessId && run.model === resource.modelId && run.accountId === resource.accountId;
  });
  const comparable = sameResources && actual.runs.every(run => run.execution === "real-provider");
  const workMs = comparable && actual.workerMs !== null && actual.runs.every(r => r.durationMs !== null) && actual.doneAt !== null
    ? actual.workerMs - estimate!.worker.expected : null;
  const priced = forecastUsage?.totals.length === 1 ? forecastUsage.totals[0] : null;
  const charged = actualUsage.costTotals.length === 1 ? actualUsage.costTotals[0] : null;
  const completionDeltaMs = comparable && actual.executionElapsedMs !== null
    ? actual.executionElapsedMs - estimate!.completion.expected : null;
  const costDelta = comparable && actual.doneAt !== null && priced && charged && priced.kind === charged.kind &&
    priced.currency === charged.currency && forecastUsage?.unknown === 0 && forecastUsage.subscription === 0 &&
    actualUsage.unknownCostRuns === 0 && actualUsage.subscriptionRuns === 0
    ? { currency: priced.currency, amount: charged.amount - priced.amount } : null;
  const original = originalEstimate(taskId);
  const remaining = actual.doneAt === null && actual.column !== "done" && estimate ? {
    // Elapsed time on a live run has no reliable relationship to completion.
    // Credit only a successful development stage while it is in Review.
    duration: actual.column === "review" && actual.runs.some(run => run.role === "developer" && run.status === "succeeded")
      ? estimate.qc : estimate.completion,
    basis: "frozen-scenario" as const,
  } : null;
  const deviation = {
    differentResources: estimate !== null && actual.runs.length > 0 && !sameResources,
    failed: actual.failed, interrupted: actual.interrupted, reworks: actual.reworks, queueMs: actual.queueMs,
  };
  type ResourceRevision = {
    missionId: string; revision: number; at: number; role: string; reason: string;
    expectedBefore: number | null; expectedAfter: number | null; elapsedAfterApproval: number | null;
    previous: { harnessId: string; modelId: string; accountId: string | null; mode: string | null } | null;
    resource: { harnessId: string; accountId: string; modelId: string; mode: string };
    authorization: { activationId: string; policyDigest: string; expiresAt: number } | null;
    compatibility: string | null;
    allocation: { objective: string; optimal: boolean } | null;
  };
  const resourceRevisions: ResourceRevision[] = [];
  for (const row of db.query<{ mission_id: string; revision: number; snapshot: string; settled_at: number }, [string, string]>(
    `SELECT mission_id, revision, snapshot, settled_at FROM mission_resource_proposals
     WHERE status = 'approved' AND (json_extract(snapshot, '$.input.taskId') = ? OR snapshot LIKE ?) ORDER BY settled_at`,
  ).all(taskId, `%${taskId}%`)) {
    const s = JSON.parse(row.snapshot) as {
      input: { taskId?: string; role?: string; reason: string };
      before: { taskRemaining?: { expected: number } | null };
      after: { taskRemaining?: { expected: number } | null };
      replacement: { harnessId: string; accountId: string; modelId: string; mode: string };
      amendments?: Array<{
        taskId: string; stage: string; previous: { harnessId: string; modelId: string; accountId: string | null; mode: string | null };
        proposed: { harnessId: string; accountId: string; modelId: string; mode: string; provider: string; sandbox: string };
        expected: { durationBefore: number | null; durationAfter: number | null };
        authorizationScope: { activationId: string; policyDigest: string; expiresAt: number };
        compatibility: string;
      }>;
      allocation?: { objective: string; optimal: boolean } | null;
    };
    const elapsedAfterApproval = actual.doneAt !== null && actual.doneAt >= row.settled_at ? actual.doneAt - row.settled_at : null;
    if (s.amendments) {
      for (const item of s.amendments) {
        if (item.taskId !== taskId) continue;
        resourceRevisions.push({
          missionId: row.mission_id, revision: row.revision + 1, at: row.settled_at, role: item.stage, reason: s.input.reason,
          expectedBefore: item.expected.durationBefore, expectedAfter: item.expected.durationAfter, elapsedAfterApproval,
          previous: item.previous, resource: item.proposed, authorization: item.authorizationScope, compatibility: item.compatibility,
          allocation: s.allocation ?? null,
        });
      }
      continue;
    }
    if (s.input.taskId !== taskId || !s.input.role) continue;
    resourceRevisions.push({
      missionId: row.mission_id, revision: row.revision + 1, at: row.settled_at, role: s.input.role, reason: s.input.reason,
      expectedBefore: s.before.taskRemaining?.expected ?? null, expectedAfter: s.after.taskRemaining?.expected ?? null, elapsedAfterApproval,
      previous: null, resource: s.replacement, authorization: null, compatibility: null, allocation: null,
    });
  }
  const adjustments = listAdjustments(taskId);
  const forecastComparison = {
    originalId: original?.estimateId ?? null,
    frozenId: estimate?.estimateId ?? null,
    revisions: resourceRevisions,
    remaining,
    actual: {
      createdToDoneMs: actual.lifecycle.createdToDoneMs,
      firstExecutionToDoneMs: actual.lifecycle.firstExecutionToDoneMs,
      workerMs: actual.workerMs,
      developerMs: actual.lifecycle.developerMs,
      reviewerMs: actual.lifecycle.reviewerMs,
      preparationMs: actual.lifecycle.preparationMs,
      testMs: actual.testMs,
      reworkMs: actual.reworkMs,
      waitingMs: actual.lifecycle.waitingMs,
    },
    errors: {
      durationMs: completionDeltaMs,
      workerMs: workMs,
      runCount: comparable && actual.doneAt !== null && estimate ? actual.runs.filter(run => run.execution === "real-provider").length - estimate.runs.expected : null,
      cost: costDelta,
      quotaDemand: null,
      quotaDemandReason: "No trustworthy per-task subscription conversion is stored.",
    },
    delayEvidence: {
      recordedWaitMs: actual.waiting.measuredMs,
      ownerWaitMs: actual.waiting.measured.owner ?? null,
      resourceRevisions: resourceRevisions.length,
      reworkMs: actual.reworkMs,
      unclassifiedMs: actual.waiting.unknownMs,
      note: "Recorded waits, rework and resource revisions are shown beside the frozen error. They are not rewritten into the original estimate.",
    },
    trainingSample: comparable && actual.doneAt !== null,
    interim: actual.doneAt === null,
  };
  const runCountDelta = comparable && actual.doneAt !== null && estimate
    ? actual.runs.filter(run => run.execution === "real-provider").length - estimate.runs.expected : null;
  const comparison = buildForecastComparison({
    actual, estimate, forecastUsage, actualUsage, sameResources, comparable, workMs, completionDeltaMs, costDelta, runCountDelta,
  });
  return {
    actual, actualUsage, original, estimate, forecastUsage, sameResources, workMs, completionDeltaMs, costDelta, remaining, deviation,
    resourceRevisions, preparation: actual.preparation, adjustments, reauthorizations: resourceRevisions.length, forecastComparison, comparison,
  };
}

function elapsed(tasks: ActualTask[], runs: ActualRun[]): number | null {
  const ends = tasks.flatMap(t => t.doneAt === null ? [] : [t.doneAt]);
  if (!ends.length || !runs.length) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...runs.map(r => r.start)));
}

const filterRequiresRun = (filter: AnalyticsFilter) =>
  !!(filter.clusterId || filter.projectPath || filter.missionId || filter.specialist || filter.provider || filter.model || filter.accountId);

/**
 * The one place that decides which tasks and runs a filter selects. The summary, the breakdown,
 * the records behind an amount and every export read this, so they always describe the same set.
 */
export function collectScope(
  filter: AnalyticsFilter, now: number, allowProject?: (path: string) => boolean,
) {
  const clauses = ["t.pipeline_parent_id IS NULL"];
  const args: Array<string | number> = [];
  const add = (sql: string, value: string | number | undefined) => {
    if (value === undefined) return;
    clauses.push(sql);
    args.push(value);
  };
  const from = filter.from ?? 0;
  const until = filter.until ?? now + 1;
  add("t.id = ?", filter.taskId);
  if (filter.taskIds?.length) {
    clauses.push(`t.id IN (${filter.taskIds.map(() => "?").join(",")})`);
    args.push(...filter.taskIds);
  }
  if (filter.projectPath || filter.clusterId || filter.missionId) {
    const scope: string[] = [];
    const match = (key: string, value?: string) => {
      if (!value) return;
      const raw = `json_extract(r.usage_scope, '$.${key}')`;
      const legacy = key === "projectPath" ? "COALESCE(e.project_path, q.project_path, reservation.project_path)"
        : key === "missionId" ? "reservation.mission_id" : "NULL";
      scope.push(`CASE WHEN r.usage_scope IS NULL THEN ${legacy} ELSE ${raw} END = ?`);
      args.push(value);
    };
    match("projectPath", filter.projectPath);
    match("clusterId", filter.clusterId);
    match("missionId", filter.missionId);
    clauses.push(`EXISTS (
      SELECT 1 FROM runs r
      LEFT JOIN employee_executions e ON e.run_id = r.id AND e.actual_provenance = 'runtime'
      LEFT JOIN task_quality_reviews q ON q.id = r.qc_review_id
      LEFT JOIN orchestration_reservations reservation ON reservation.task_id = r.task_id AND
        (reservation.run_id = r.id OR reservation.qc_review_id = r.qc_review_id)
      WHERE r.task_id IN (SELECT child.id FROM tasks child WHERE child.id = t.id OR child.pipeline_parent_id = t.id)
        AND ${scope.join(" AND ")}
    )`);
  }
  // Take a bounded, explicitly labelled recent slice. Date filters narrow the
  // candidates by recorded Done or run start before the limit is applied.
  if (filter.from !== undefined || filter.until !== undefined) {
    clauses.push(`(EXISTS (SELECT 1 FROM runs r WHERE r.task_id IN (SELECT child.id FROM tasks child WHERE child.id = t.id OR child.pipeline_parent_id = t.id) AND r.started_at >= ? AND r.started_at < ?)
      OR EXISTS (SELECT 1 FROM usage_task_transitions x WHERE x.task_id = t.id AND x.destination = 'done' AND x.at >= ? AND x.at < ?))`);
    args.push(from, until, from, until);
  }
  const ids = db.query<{ id: string }, Array<string | number>>(
    `SELECT t.id FROM tasks t WHERE ${clauses.join(" AND ")} ORDER BY t.updated_at DESC, t.id LIMIT ${MAX_TASKS + 1}`,
  ).all(...args);
  const measured: Array<{ task: ActualTask; runs: ActualRun[]; periodRuns: ActualRun[] }> = [];
  const requiresRun = filterRequiresRun(filter);
  for (const { id } of ids.slice(0, MAX_TASKS)) {
    const task = taskActuals(id, now);
    if (!task || allowProject && (!task.projectPath || !allowProject(task.projectPath))) continue;
    const runs = task.runs.filter(run => matchesRun(run, filter) &&
      (!allowProject || !!run.scope?.projectPath && allowProject(run.scope.projectPath)));
    if ((requiresRun || filter.category && task.category !== filter.category) && !runs.length) continue;
    const periodRuns = runs.filter(run => run.start >= from && run.start < until);
    measured.push({ task, runs, periodRuns });
  }
  return { measured, from, until, truncated: ids.length > MAX_TASKS, tasksInScope: measured.length };
}

export function analytics(
  filter: AnalyticsFilter, now = Date.now(), allowProject?: (path: string) => boolean, view: AnalyticsView = {},
) {
  const { measured, from, until, truncated: scopeTruncated, tasksInScope } = collectScope(filter, now, allowProject);
  const completed = measured.filter(({ task }) => task.doneAt !== null && task.doneAt >= from && task.doneAt < until);
  const durations = completed.map(({ task }) => task.totalElapsedMs).filter(ms => ms !== null);
  const completeTasks = completed.map(item => item.task);
  const periodRuns = measured.flatMap(item => item.periodRuns);
  const qcRuns = new Set(completed.flatMap(item => item.runs.filter(r => r.execution === "real-provider" && r.role === "reviewer").map(r => r.id)));
  const reviewed = completed.filter(({ task }) => {
    const first = task.reviews.find(q => q.verdict !== null);
    return first?.review_run_id && qcRuns.has(first.review_run_id);
  });
  const stages = (role: ActualRun["role"]) => summarizeRuns(periodRuns.filter(run => run.role === role));
  const accuracy = completed.slice(0, 100).flatMap(({ task }) => {
    const comparison = taskBreakdown(task.id);
    return comparison?.workMs == null ? [] : [{ taskId: task.id, workerDeltaMs: comparison.workMs, completionDeltaMs: comparison.completionDeltaMs, costDelta: comparison.costDelta }];
  });
  const buckets = [15, 60, 240].map(n => n * 60_000);
  const distribution = [0, 0, 0, 0];
  for (const value of durations) {
    const index = buckets.findIndex(ms => value < ms);
    distribution[index < 0 ? 3 : index]!++;
  }

  const days = new Map<string, { tasks: ActualTask[]; runs: ActualRun[] }>();
  const day = (at: number) => {
    const key = new Date(at).toISOString().slice(0, 10);
    if (!days.has(key)) days.set(key, { tasks: [], runs: [] });
    return days.get(key)!;
  };
  for (const { task } of completed) day(task.doneAt!).tasks.push(task);
  for (const run of periodRuns) day(run.start).runs.push(run);
  const trends = [...days].sort(([a], [b]) => b.localeCompare(a)).slice(0, 90).map(([date, entry]) => ({
    date, completed: entry.tasks.length,
    medianMs: quantile(entry.tasks.flatMap(t => t.totalElapsedMs === null ? [] : [t.totalElapsedMs]), .5),
    ...summarizeRuns(entry.runs),
  }));

  const accounts = new AccountCore(db).listAccounts();
  const idsInScope = new Set(periodRuns.map(r => r.accountId));
  const scopedAccounts = accounts.filter(a => (!filter.accountId || a.id === filter.accountId) &&
    (!filter.provider || a.provider === filter.provider) && (!filterRequiresRun(filter) || filter.accountId || idsInScope.has(a.id)));
  return {
    completed: completeTasks.length,
    legacyDoneWithoutTimestamp: measured.filter(({ task }) => task.column === "done" && task.doneAt === null).length,
    averageMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    medianMs: quantile(durations, .5), distribution,
    elapsedMs: filter.projectPath || filter.missionId ? elapsed(completeTasks, completed.flatMap(item => item.runs)) : null,
    firstPass: reviewed.length ? reviewed.filter(({ task }) => task.firstVerdict === "PASS").length / reviewed.length : null,
    firstPassSamples: reviewed.length,
    tasksWithRework: completeTasks.filter(task => task.reworks > 0).length,
    usage: summarizeRuns(periodRuns), developer: stages("developer"), reviewer: stages("reviewer"),
    accuracy, trends, truncated: scopeTruncated, tasksInScope,
    /** True when `tasksInScope` is a floor: more tasks matched than the scope reads. */
    tasksInScopeIsLowerBound: scopeTruncated, taskScopeLimit: MAX_TASKS,
    quotas: scopedAccounts.map(a => ({ id: a.id, label: a.displayName, quota: quotaFor(a.id, undefined, true).map(q => ({
      ...q,
      current: q.current && q.current.observedAt >= from && q.current.observedAt < until ? q.current : null,
      observations: q.observations.filter(o => o.observedAt >= from && o.observedAt < until),
    })) })),
    tasks: measured.slice(0, Math.min(500, view.taskLimit ?? 100)).map(({ task, periodRuns: runs }) => ({
      id: task.id, title: task.title, projectPath: task.projectPath, doneAt: task.doneAt, column: task.column,
      category: task.category, firstRunAt: task.firstRunAt, elapsedMs: task.totalElapsedMs, executionElapsedMs: task.executionElapsedMs,
      activeWallMs: task.activeWallMs, workerMs: task.workerMs, reworks: task.reworks, lifecycle: task.lifecycle,
      subscriptionQuota: task.subscriptionQuota.status, usage: summarizeRuns(runs),
      baselineEstimateId: task.frozenEstimateId,
    })),
    taskListTruncated: measured.length > Math.min(500, view.taskLimit ?? 100),
    company: buildCompany({
      filter, now, timeZone: view.timeZone && isTimeZone(view.timeZone) ? view.timeZone : "UTC", grain: view.grain ?? "day",
      truncated: scopeTruncated, measured, completed, periodRuns, durations, accuracy,
    }),
  };
}

export function usageSelectors() {
  return {
    projects: projects.list().map(p => ({ id: p.path, label: p.name })),
    clusters: db.query<{ id: string; name: string }, []>("SELECT id,name FROM clusters ORDER BY name").all()
      .map(c => ({ id: c.id, label: c.name })),
    missions: missionStore.listMissions().map(m => ({ id: m.id, label: m.title, approved: m.authorization?.digest === m.planDigest })),
    backlog: db.query<{ id: string; title: string; workdir: string }, []>(
      `SELECT id,title,workdir FROM tasks WHERE "column" = 'backlog' AND archived_at IS NULL
        AND pipeline_id IS NULL AND pipeline_parent_id IS NULL ORDER BY updated_at DESC LIMIT 500`,
    ).all().map(t => ({ id: t.id, label: t.title })),
    specialists: db.query<{ id: string; name: string }, []>("SELECT id,name FROM ai_employees ORDER BY name LIMIT 500").all()
      .map(e => ({ id: e.id, label: e.name })),
  };
}

export const lastSevenDays = (now: number) => now - 7 * DAY;
