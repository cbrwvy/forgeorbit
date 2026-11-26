import { db } from "../db.ts";
import { bucketKey, comparisonLabel, type TrendGrain } from "../../shared/company-analytics.ts";
import type { AnalyticsFilter } from "../../shared/usage-analytics.ts";
import { currentAdjustmentTotals } from "./adjustments.ts";
import { type ActualRun, type ActualTask, quantile, summarizeRuns } from "./actuals.ts";
import { quotaConsumption, type QuotaReceipt } from "./quota-consumption.ts";

interface Measured {
  task: ActualTask;
  runs: ActualRun[];
  periodRuns: ActualRun[];
}

interface AccuracyRow {
  taskId: string;
  workerDeltaMs: number | null;
  completionDeltaMs: number | null;
  costDelta: { currency: string; amount: number } | null;
}

function median(values: number[]): number | null {
  return quantile(values, .5);
}

function receiptsFrom(runs: ActualRun[]): QuotaReceipt[] {
  return runs.flatMap(run => run.subscriptionUsage ? [{
    runId: run.id, taskId: run.taskId, quotaId: run.subscriptionUsage.quotaId, amount: run.subscriptionUsage.amount,
    unit: run.subscriptionUsage.unit, at: run.end ?? run.start, source: "provider-reported-receipt" as const,
  }] : []);
}

function registryCounts(filter: AnalyticsFilter, from: number, until: number) {
  if (filter.specialist || filter.provider || filter.model || filter.accountId) return null;
  const where = [`t.pipeline_parent_id IS NULL`];
  const args: Array<string | number> = [];
  const add = (sql: string, value?: string) => { if (value === undefined) return; where.push(sql); args.push(value); };
  add("t.workdir = ?", filter.projectPath);
  add("t.id = ?", filter.taskId);
  add("t.task_type = ?", filter.category);
  if (filter.clusterId) {
    where.push("t.workdir IN (SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ?)");
    args.push(filter.clusterId);
  }
  if (filter.taskIds?.length) {
    where.push(`t.id IN (${filter.taskIds.map(() => "?").join(",")})`);
    args.push(...filter.taskIds);
  }
  if (filter.missionId) {
    where.push(`(EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND json_extract(r.usage_scope, '$.missionId') = ?)
      OR EXISTS (SELECT 1 FROM orchestration_reservations reservation WHERE reservation.task_id = t.id AND reservation.mission_id = ?))`);
    args.push(filter.missionId, filter.missionId);
  }
  const scope = where.join(" AND ");
  const one = (sql: string, extra: Array<string | number> = []) =>
    db.query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM tasks t WHERE ${scope} AND ${sql}`).get(...args, ...extra)?.n ?? 0;
  const childRun = `(SELECT MIN(r.started_at) FROM runs r JOIN tasks child ON child.id = r.task_id
    WHERE child.id = t.id OR child.pipeline_parent_id = t.id) >= ?
    AND (SELECT MIN(r.started_at) FROM runs r JOIN tasks child ON child.id = r.task_id
    WHERE child.id = t.id OR child.pipeline_parent_id = t.id) < ?`;
  return {
    source: "registry" as const,
    created: one("t.created_at >= ? AND t.created_at < ?", [from, until]),
    started: one(childRun, [from, until]),
    completed: one(`t."column" = 'done' AND (SELECT MAX(at) FROM usage_task_transitions x WHERE x.task_id = t.id AND x.destination = 'done') >= ?
      AND (SELECT MAX(at) FROM usage_task_transitions x WHERE x.task_id = t.id AND x.destination = 'done') < ?`, [from, until]),
    running: one(`t."column" = 'running'`),
    blocked: one(`t."column" = 'blocked'`),
    legacyDone: one(`t."column" = 'done' AND NOT EXISTS (SELECT 1 FROM usage_task_transitions x WHERE x.task_id = t.id AND x.destination = 'done')`),
  };
}

interface PersonRow { id: string; name: string; role_category: string; kind: string }

function peopleById(): Map<string, PersonRow> {
  return new Map(db.query<PersonRow, []>("SELECT id, name, role_category, kind FROM ai_employees").all().map(row => [row.id, row]));
}

function categoriesOf(runs: ActualRun[]): string[] {
  return [...new Set(runs.map(run => run.scope?.category || "unknown"))];
}

export function buildCompany(input: {
  filter: AnalyticsFilter;
  now: number;
  timeZone: string;
  grain: TrendGrain;
  truncated: boolean;
  measured: Measured[];
  completed: Measured[];
  periodRuns: ActualRun[];
  durations: number[];
  accuracy: AccuracyRow[];
}) {
  const { measured, completed, periodRuns, durations, accuracy, timeZone, grain } = input;
  const from = input.filter.from ?? 0;
  const until = input.filter.until ?? input.now + 1;
  const sumMs = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  const activeTasks = measured.filter(item => item.task.column === "running").length;
  const blockedTasks = measured.filter(item => item.task.column === "blocked").length;
  const created = measured.filter(item => item.task.createdAt >= from && item.task.createdAt < until).length;
  const started = measured.filter(item => item.task.firstRunAt !== null && item.task.firstRunAt >= from && item.task.firstRunAt < until).length;
  const usage = summarizeRuns(periodRuns);
  const genuine = periodRuns.filter(run => run.execution === "real-provider");
  const byKey = <T>(rows: T[], key: (row: T) => string) => {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const id = key(row);
      const list = groups.get(id);
      if (list) list.push(row);
      else groups.set(id, [row]);
    }
    return groups;
  };
  const projectGroups = byKey(genuine, run => run.scope?.projectPath ?? "unknown");
  const projects = [...projectGroups].map(([projectPath, runs]) => ({ projectPath, ...summarizeRuns(runs) }))
    .sort((a, b) => (b.tokens.input ?? -1) - (a.tokens.input ?? -1));
  const people = peopleById();
  const employees = [...byKey(periodRuns, run => run.specialist ?? "unattributed")].map(([id, runs]) => {
    const person = people.get(id);
    const real = runs.filter(run => run.execution === "real-provider");
    const developerTasks = [...new Set(real.filter(run => run.role === "developer").map(run => run.taskId))];
    const completedDeveloper = developerTasks.filter(taskId => measured.find(item => item.task.id === taskId)?.task.doneAt != null);
    const reviewed = completed.flatMap(item => {
      const first = item.task.reviews.find(review => review.verdict !== null);
      return first?.reviewer_employee_id === id ? [item.task] : [];
    });
    const developerReviewed = completedDeveloper.flatMap(taskId => {
      const task = measured.find(item => item.task.id === taskId)?.task;
      return task?.firstVerdict ? [task] : [];
    });
    const cats = categoriesOf(real);
    const summary = summarizeRuns(real);
    return {
      id, name: person?.name ?? (id === "unattributed" ? "Unattributed" : id),
      role: person?.role_category ?? "unattributed", kind: person?.kind ?? null,
      participatedTasks: new Set(runs.map(run => run.taskId)).size,
      developerCompletedTasks: completedDeveloper.length,
      reviewerParticipations: new Set(real.filter(run => run.role === "reviewer").map(run => run.taskId)).size,
      genuineAttempts: real.length,
      syntheticAttempts: runs.filter(run => run.execution === "synthetic").length,
      succeeded: real.filter(run => run.status === "succeeded").length,
      failed: real.filter(run => run.status === "failed").length,
      interrupted: real.filter(run => run.status === "orphaned" || run.status === "cancelled").length,
      successRate: real.length ? real.filter(run => run.status === "succeeded").length / real.length : null,
      developerFirstPass: {
        rate: developerReviewed.length ? developerReviewed.filter(task => task.firstVerdict === "PASS").length / developerReviewed.length : null,
        samples: developerReviewed.length,
        comparison: comparisonLabel(developerReviewed.length, cats),
      },
      reviewerFirstPass: {
        rate: reviewed.length ? reviewed.filter(task => task.firstVerdict === "PASS").length / reviewed.length : null,
        samples: reviewed.length,
        comparison: comparisonLabel(reviewed.length, categoriesOf(real.filter(run => run.role === "reviewer"))),
      },
      reworkTasks: completedDeveloper.filter(taskId => (measured.find(item => item.task.id === taskId)?.task.reworks ?? 0) > 0).length,
      workerMs: summary.workerMs,
      medianDurationMs: median(real.flatMap(run => run.durationMs === null ? [] : [run.durationMs])),
      tokens: summary.tokens, tokenCoverage: summary.tokenCoverage, costs: summary.costTotals,
      projects: [...new Set(real.flatMap(run => run.scope?.projectPath ? [run.scope.projectPath] : []))].slice(0, 12),
      models: [...new Set(real.flatMap(run => run.model ? [run.model] : []))].slice(0, 12),
      accounts: [...new Set(real.flatMap(run => run.accountId ? [run.accountId] : []))].slice(0, 12),
      categories: cats,
      comparison: comparisonLabel(real.length, cats),
    };
  });
  const modelGroups = byKey(genuine, run => [run.role, run.provider ?? "unknown", run.model ?? "unknown", run.accountId ?? ""].join("\t"));
  const models = [...modelGroups].map(([, runs]) => {
    const sample = runs[0]!;
    const cats = categoriesOf(runs);
    const matched = completed.filter(item => {
      const roleRuns = item.task.runs.filter(run => run.role === sample.role && run.execution === "real-provider");
      return roleRuns.length > 0 && roleRuns.every(run => run.provider === sample.provider && run.model === sample.model && run.accountId === sample.accountId);
    });
    const charges = matched.map(item => summarizeRuns(item.task.runs.filter(run => run.role === sample.role && run.execution === "real-provider")));
    const sameMoney = charges.length > 0 && charges.every(row => row.unknownCostRuns === 0 && row.costTotals.length === 1 &&
      row.costTotals[0]!.currency === charges[0]!.costTotals[0]?.currency && row.costTotals[0]!.kind === charges[0]!.costTotals[0]?.kind);
    const errors = accuracy.filter(row => matched.some(item => item.task.id === row.taskId) && row.workerDeltaMs !== null);
    const summary = summarizeRuns(runs);
    return {
      role: sample.role, provider: sample.provider, model: sample.model, accountId: sample.accountId,
      accountAttributed: sample.accountId !== null,
      genuineRuns: runs.length,
      categories: cats,
      successRate: runs.length ? runs.filter(run => run.status === "succeeded").length / runs.length : null,
      medianDurationMs: median(runs.flatMap(run => run.durationMs === null ? [] : [run.durationMs])),
      reworkTasks: matched.filter(item => item.task.reworks > 0).length,
      tokens: summary.tokens, costs: summary.costTotals,
      averageCharge: sameMoney ? {
        amount: charges.reduce((sum, row) => sum + row.costTotals[0]!.amount, 0) / charges.length,
        currency: charges[0]!.costTotals[0]!.currency, kind: charges[0]!.costTotals[0]!.kind, tasks: charges.length,
      } : null,
      forecast: {
        samples: errors.length,
        medianWorkerDeltaMs: median(errors.map(row => row.workerDeltaMs!)),
        capped: input.completed.length > accuracy.length,
      },
      technologies: [...new Set(runs.flatMap(run => run.scope?.technology ? [run.scope.technology] : []))].slice(0, 8),
      comparison: comparisonLabel(runs.length, cats),
      syntheticExcluded: true,
    };
  });
  const days = new Map<string, { tasks: ActualTask[]; runs: ActualRun[] }>();
  const bucket = (at: number) => {
    const key = bucketKey(at, grain, timeZone);
    if (!days.has(key)) days.set(key, { tasks: [], runs: [] });
    return days.get(key)!;
  };
  for (const item of completed) if (item.task.doneAt !== null) bucket(item.task.doneAt).tasks.push(item.task);
  for (const run of periodRuns) bucket(run.start).runs.push(run);
  const trends = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, entry]) => ({
    date, completed: entry.tasks.length,
    medianMs: median(entry.tasks.flatMap(task => task.totalElapsedMs === null ? [] : [task.totalElapsedMs])),
    p85Ms: quantile(entry.tasks.flatMap(task => task.totalElapsedMs === null ? [] : [task.totalElapsedMs]), .85),
    ...summarizeRuns(entry.runs),
  }));
  const workerDeltas = accuracy.flatMap(row => row.workerDeltaMs === null ? [] : [row.workerDeltaMs]);
  const completionDeltas = accuracy.flatMap(row => row.completionDeltaMs === null ? [] : [row.completionDeltaMs]);
  return {
    timezone: timeZone, grain,
    range: { from: input.filter.from ?? null, until: input.filter.until ?? null },
    aggregation: "Each run is counted once inside one report. Project, cluster, mission and company views are alternate filters, not additive layers. Historical run scope is kept when a task moves.",
    truncated: input.truncated,
    counts: registryCounts(input.filter, from, until) ?? {
      source: "selection" as const, created, started, completed: completed.length, running: activeTasks, blocked: blockedTasks,
      legacyDone: measured.filter(item => item.task.column === "done" && item.task.doneAt === null).length,
    },
    durations: {
      averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
      medianMs: median(durations), p85Ms: quantile(durations, .85), samples: durations.length,
    },
    time: {
      workerMs: usage.workerMs,
      activeWallMs: sumMs(measured.map(item => item.task.activeWallMs)),
      waitingMs: sumMs(measured.map(item => item.task.waiting.measuredMs)),
      unclassifiedMs: sumMs(measured.map(item => item.task.waiting.unknownMs)),
      developerMs: summarizeRuns(periodRuns.filter(run => run.role === "developer")).workerMs,
      reviewerMs: summarizeRuns(periodRuns.filter(run => run.role === "reviewer")).workerMs,
      preparationMs: sumMs(measured.map(item => item.task.lifecycle.preparationMs)),
      testMs: sumMs(measured.map(item => item.task.testMs)),
      qcMs: sumMs(measured.map(item => item.task.qcMs)),
      reworkMs: sumMs(measured.map(item => item.task.reworkMs)),
      activeWallRule: "Sum of each task's active wall-clock union. Concurrent work on different tasks is added. Overlapping runs on one task are not.",
    },
    costs: {
      totals: usage.costTotals,
      unknownCostRuns: usage.unknownCostRuns,
      subscriptionRuns: usage.subscriptionRuns,
      ownerAdjustments: currentAdjustmentTotals(measured.map(item => item.task.id)),
      currencyPolicy: "Currencies stay separate. No foreign-exchange conversion is stored.",
    },
    quota: quotaConsumption(input.filter, input.now, receiptsFrom(periodRuns)),
    forecast: {
      samples: workerDeltas.length,
      capped: completed.length > accuracy.length,
      medianWorkerDeltaMs: median(workerDeltas),
      medianCompletionDeltaMs: median(completionDeltas),
      longerThanFrozen: completionDeltas.filter(value => value > 0).length,
      training: "Running tasks are not forecast-accuracy samples.",
    },
    projects, employees, models, trends,
    tokens: usage.tokens,
  };
}
