import { toCsv } from "../../shared/company-analytics.ts";
import type { analytics } from "./analytics.ts";
import type { analyticsRecords } from "./records.ts";

type Report = ReturnType<typeof analytics>;
type Records = ReturnType<typeof analyticsRecords>;
export type ExportReport = "tasks" | "models" | "runs";

export function renderAnalyticsExport(result: Report, report: ExportReport, format: "csv" | "json", meta: { timeZone: string; grain: string; records?: Records }) {
  const coverage = {
    truncated: result.truncated, taskListTruncated: result.taskListTruncated, timezone: meta.timeZone, grain: meta.grain,
    currencyPolicy: result.company.costs.currencyPolicy,
    unknownPolicy: "Null and the CSV word Unknown mean missing evidence, not zero.",
    syntheticPolicy: "Synthetic runs stay visible and are excluded from employee and model comparison labels.",
    quotaPolicy: result.company.quota.note,
    ...(meta.records ? {
      // The same filter, period and eligibility the screen used, and the amounts the run records add up to.
      filter: meta.records.filter, period: meta.records.period, eligibility: meta.records.eligibility, runCounts: meta.records.counts,
      amountBuckets: meta.records.buckets, reconciliation: meta.records.reconciliation, recordsTruncated: meta.records.recordsTruncated,
      // What this file holds against what qualified, so a cap is never read as completeness.
      recordsExported: report === "runs" ? meta.records.records.length : null, recordsQualifying: meta.records.counts.records,
      tasksListed: result.tasks.length, tasksInScope: result.tasksInScope, tasksInScopeIsLowerBound: result.tasksInScopeIsLowerBound,
      taskScopeLimit: result.taskScopeLimit,
      scopeNote: result.tasksInScopeIsLowerBound
        ? `The filter reached more than ${result.taskScopeLimit} tasks. Only the ${result.taskScopeLimit} most recently updated were read, so totals and records may leave out older matching tasks.`
        : "Totals and records cover every task that matched.",
    } : {}),
    baselinePolicy: "baselineEstimateId is the estimate revision frozen to the first Developer run. Unknown means no estimate was saved before work started; older tasks are not back-filled.",
  };
  if (format === "json") {
    return {
      type: "application/json; charset=utf-8", filename: `forgeorbit-${report}.json`,
      body: JSON.stringify({
        source: "forgeorbit-analytics", generatedAt: new Date().toISOString(), coverage,
        company: result.company, tasks: report === "tasks" ? result.tasks : undefined, models: report === "models" ? result.company.models : undefined,
        runs: report === "runs" ? meta.records?.records : undefined, byProject: report === "runs" ? meta.records?.byProject : undefined,
        byAccount: report === "runs" ? meta.records?.byAccount : undefined,
      }, null, 2),
    };
  }
  const scope = meta.records
    ? ` filter=${JSON.stringify(meta.records.filter)} includedRuns=${meta.records.counts.included} excludedRuns=${meta.records.counts.excluded} recordsTruncated=${meta.records.recordsTruncated}` +
      ` recordsQualifying=${meta.records.counts.records}${report === "runs" ? ` recordsExported=${meta.records.records.length}` : ""}` +
      ` tasksInScope=${result.tasksInScope}${result.tasksInScopeIsLowerBound ? `+ scopeTruncated=true taskScopeLimit=${result.taskScopeLimit}` : ""}`
    : "";
  const preamble = `# forgeorbit-analytics report=${report} timezone=${meta.timeZone} grain=${meta.grain} truncated=${result.truncated} unknown=Unknown${scope}`;
  if (report === "runs") {
    const rows = (meta.records?.records ?? []).map(record => [
      record.runId, record.taskId, record.taskTitle, record.projectPath, record.projectLabel, record.accountId, record.accountLabel, record.role,
      record.status, new Date(record.startedAt).toISOString(), record.included ? "counted" : "excluded", record.exclusion, record.execution,
      record.provider, record.model, record.mode, record.tokens.input, record.tokens.output, record.tokens.cacheRead, record.tokens.cacheWrite,
      record.cost.kind, record.cost.amount, record.cost.currency, record.cost.source, record.cost.pricingId, record.bucket,
      record.reportedTelemetry?.amount ?? null, record.reportedTelemetry?.currency ?? null,
    ]);
    return {
      type: "text/csv; charset=utf-8", filename: "forgeorbit-runs.csv",
      body: `${preamble}\n${toCsv([
        "runId", "taskId", "taskTitle", "project", "projectLabel", "accountId", "accountLabel", "role", "status", "startedAtUtc", "counting",
        "exclusionReason", "execution", "provider", "model", "mode", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
        "costKind", "amount", "currency", "costSource", "pricingId", "bucket", "cliTelemetryAmount", "cliTelemetryCurrency",
      ], rows)}`,
    };
  }
  if (report === "models") {
    const rows = result.company.models.map(row => [
      row.role, row.provider, row.model, row.accountId, row.genuineRuns, row.categories.join("|"), row.successRate,
      row.medianDurationMs, row.comparison, row.averageCharge?.amount ?? null, row.averageCharge?.currency ?? null, row.averageCharge?.kind ?? null,
    ]);
    return {
      type: "text/csv; charset=utf-8", filename: "forgeorbit-models.csv",
      body: `${preamble}\n${toCsv(["role", "provider", "model", "accountId", "genuineRuns", "categories", "successRate", "medianDurationMs", "comparison", "averageCharge", "currency", "costKind"], rows)}`,
    };
  }
  const rows = result.tasks.map(task => {
    const life = task.lifecycle;
    const cost = task.usage.costTotals.map(item => `${item.kind} ${item.amount} ${item.currency}`).join("; ");
    return [
      task.id, task.title, task.projectPath, task.column, task.category, life.createdToDoneMs, life.firstExecutionToDoneMs,
      life.workerMs, life.activeWallMs, life.developerMs, life.reviewerMs, life.preparationMs, life.testMs, life.qcMs, life.reworkMs,
      life.waitingMs, life.unclassifiedMs, life.attempts, life.completedRuns, life.failures, life.interruptions, life.qcRounds,
      task.usage.tokens.input, task.usage.tokens.output, task.usage.tokens.cacheRead, task.usage.tokens.cacheWrite,
      task.subscriptionQuota, cost || null, task.baselineEstimateId,
    ];
  });
  return {
    type: "text/csv; charset=utf-8", filename: "forgeorbit-tasks.csv",
    body: `${preamble}\n${toCsv([
      "id", "title", "project", "column", "category", "createdToDoneMs", "firstExecutionToDoneMs", "workerMs", "activeWallMs",
      "developerMs", "reviewerMs", "preparationMs", "testMs", "qcMs", "reworkMs", "waitingMs", "unclassifiedMs", "attempts",
      "completedRuns", "failures", "interruptions", "qcRounds", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
      "subscriptionQuota", "cost", "baselineEstimateId",
    ], rows)}`,
  };
}
