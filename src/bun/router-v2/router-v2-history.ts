/**
 * FO-ROUTING04: AI Router 2.0 — Execution History Learning Engine
 *
 * Extracts historical execution signals from SQLite:
 * - Genuine runs only (checks executionType === "real-provider")
 * - Fake drivers and synthetic tests strictly excluded from production statistics
 * - Latency, token usage, cost, QC PASS/BLOCKED/CHANGES_REQUESTED rates
 * - Bounded sampling and cold-start behavior
 */

import type { Database } from "bun:sqlite";
import { db } from "../db.ts";
import { countsAsGenuineProviderUsage } from "../../shared/provider-runtime/receipts.ts";
import { providerBill, RUN_USAGE_STATUS_PREFIX } from "../../shared/usage-analytics.ts";

export interface ModelExecutionMetrics {
  harnessId: string;
  modelId: string;
  accountId: string | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  successRate: number | null; // 0..1
  qcPassCount: number;
  qcReworkCount: number;
  qcBlockedCount: number;
  qcPassRate: number | null; // 0..1
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  forecastErrorMs: number | null;
  confidence: "high" | "low" | "none";
  comparable: boolean;
  role: "developer" | "reviewer" | null;
  isColdStart: boolean;
}

function executionIdentity(database: Database, runId: string): { executionType?: string; usageSource?: string | null; source?: string | null; accountProfile?: { id?: string } | null; model?: string; provider?: string } | null {
  const row = database.query<{ data: string }, [string]>(
    `SELECT data FROM run_events INDEXED BY idx_run_events_run
     WHERE run_id = ? AND stream = 'status' AND subagent_id IS NULL
       AND CASE WHEN json_valid(data) THEN json_extract(data, '$.kind') = 'execution-identity' ELSE 0 END
     ORDER BY id LIMIT 1`,
  ).get(runId);
  return row ? JSON.parse(row.data) : null;
}

export function isRealProviderRun(database: Database, runId: string): boolean {
  const identity = executionIdentity(database, runId);
  return countsAsGenuineProviderUsage({ executionType: identity?.executionType, usageSource: identity?.usageSource, source: identity?.source });
}

export function queryModelExecutionMetrics(
  database: Database = db,
  filter: {
    harnessId: string;
    modelId: string;
    accountId?: string | null;
    role?: "developer" | "reviewer";
    category?: string;
    complexity?: string;
    technology?: string;
    mode?: string;
    limitSamples?: number;
    allowSyntheticForTesting?: boolean;
  },
): ModelExecutionMetrics {
  const sampleLimit = filter.limitSamples ?? 50;

  // Query employee executions with actual attribution
  const execRows = database
    .query<
      {
        id: string;
        run_id: string | null;
        actual_harness_id: string | null;
        actual_model: string | null;
        actual_account_id: string | null;
        result: string | null;
        started_at: number | null;
        finished_at: number | null;
        task_id: string;
        requested_complexity: string | null;
        requested_mode: string | null;
      },
      [string, string]
    >(
      `SELECT id, run_id, task_id, actual_harness_id, actual_model, actual_account_id, result, started_at, finished_at,
              requested_complexity, requested_mode
       FROM employee_executions
       WHERE actual_harness_id = ? AND actual_model = ?
       ORDER BY started_at DESC
       LIMIT 100`,
    )
    .all(filter.harnessId, filter.modelId);

  // Filter for genuine runs only
  const validExecs = execRows.filter((e) => {
    if (filter.accountId !== undefined && e.actual_account_id !== filter.accountId) return false;
    if (filter.complexity && e.requested_complexity !== filter.complexity) return false;
    if (filter.mode && e.requested_mode !== filter.mode) return false;
    if (filter.category) {
      const task = database.query<{ task_type: string }, [string]>("SELECT task_type FROM tasks WHERE id = ?").get(e.task_id);
      if (task?.task_type !== filter.category) return false;
    }
    if (filter.technology && e.run_id) {
      const scope = database.query<{ usage_scope: string | null }, [string]>("SELECT usage_scope FROM runs WHERE id = ?").get(e.run_id);
      let technology: string | null = null;
      try { technology = scope?.usage_scope ? JSON.parse(scope.usage_scope).technology ?? null : null; } catch { technology = null; }
      if (technology !== filter.technology) return false;
    } else if (filter.technology) return false;
    if (filter.role === "reviewer") return false;
    if (filter.allowSyntheticForTesting) return true;
    if (!e.run_id) return false;
    return isRealProviderRun(database, e.run_id);
  }).slice(0, sampleLimit);

  // Use only exact real-provider USD billing receipts. Do not repurpose CLI
  // cost telemetry or apply today's rates to historical runs.
  const charged = database.query<{ data: string }, [string, string, number]>(`
    SELECT data FROM run_events INDEXED BY idx_run_events_run
    WHERE run_id = ? AND stream = 'status' AND subagent_id IS NULL AND data LIKE ? AND ts <= ? ORDER BY id DESC
  `);
  const costs = filter.accountId ? validExecs.flatMap(e => {
    if (!e.run_id || e.finished_at === null) return [];
    const identity = executionIdentity(database, e.run_id);
    if (!countsAsGenuineProviderUsage(identity ?? {}) || identity?.model !== filter.modelId || identity.accountProfile?.id !== filter.accountId) return [];
    const run = database.query<{ started_at: number; origin: string | null; resumed: number }, [string]>(`
      SELECT r.started_at, r.origin, EXISTS (
        SELECT 1 FROM runs p WHERE p.task_id = r.task_id AND p.rowid < r.rowid AND p.codex_session_id = r.codex_session_id
      ) AS resumed FROM runs r WHERE r.id = ?
    `).get(e.run_id);
    if (!run || identity.provider === "codex" && (run.resumed || run.origin === "continuation")) return [];
    const price = database.query<{ billing: string }, [string, string, string, number]>(`
      SELECT json_extract(terms,'$.billing') AS billing FROM usage_pricing
      WHERE harness_id = ? AND model_id = ? AND account_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(filter.harnessId, filter.modelId, filter.accountId!, run.started_at);
    if (price?.billing === "subscription") return [];
    for (const row of charged.all(e.run_id, RUN_USAGE_STATUS_PREFIX + "%", e.finished_at)) {
      try {
        const bill = providerBill(JSON.parse(row.data.slice(RUN_USAGE_STATUS_PREFIX.length))?.billed);
        if (bill) return bill.currency === "USD" ? [bill.amount] : [];
      } catch { /* malformed status is not billing evidence */ }
    }
    return [];
  }) : [];

  let successCount = 0;
  let failureCount = 0;
  let totalLatency = 0;
  let latencySamples = 0;

  for (const e of validExecs) {
    if (e.result === "succeeded") successCount++;
    else if (e.result === "failed") failureCount++;

    if (e.started_at && e.finished_at && e.finished_at > e.started_at) {
      totalLatency += e.finished_at - e.started_at;
      latencySamples++;
    }
  }

  const avgLatencyMs = latencySamples > 0 ? Math.round(totalLatency / latencySamples) : null;

  // Query QC reviews for this model
  const qcRows = database
    .query<
      {
        id: string;
        verdict: string | null;
        review_run_id: string | null;
      },
      [string, string]
    >(
      `SELECT id, verdict, review_run_id FROM task_quality_reviews
       WHERE reviewer_harness = ? AND reviewer_model = ?
       ORDER BY requested_at DESC
       LIMIT 50`,
    )
    .all(filter.harnessId, filter.modelId);

  let qcPass = 0;
  let qcRework = 0;
  let qcBlocked = 0;
  let qcConsidered = 0;

  for (const qc of qcRows) {
    if (!filter.allowSyntheticForTesting) {
      const evidence = qc.review_run_id ? executionIdentity(database, qc.review_run_id) : null;
      if (!evidence || !countsAsGenuineProviderUsage(evidence) ||
          filter.accountId !== undefined && (evidence.accountProfile?.id ?? null) !== filter.accountId) continue;
    }
    qcConsidered++;
    if (qc.verdict === "PASS") qcPass++;
    else if (qc.verdict === "CHANGES_REQUESTED") qcRework++;
    else if (qc.verdict === "BLOCKED") qcBlocked++;
  }

  const qcPassRate = qcConsidered >= 3 ? qcPass / qcConsidered : null;
  const developerCount = filter.role === "reviewer" ? 0 : validExecs.length;
  const runCount = filter.role === "reviewer" ? qcConsidered : developerCount;
  const successRate = runCount >= 3
    ? (filter.role === "reviewer" ? qcPass / runCount : successCount / runCount)
    : null;

  const forecastErrors: number[] = [];
  if (filter.role !== "reviewer") {
    for (const execution of validExecs) {
      if (!execution.run_id || execution.started_at == null || execution.finished_at == null || execution.finished_at <= execution.started_at) continue;
      try {
        const estimate = database.query<{ snapshot: string }, [string]>(`
          SELECT e.snapshot FROM runs r JOIN usage_task_estimates e ON e.id = r.usage_estimate_id WHERE r.id = ?
        `).get(execution.run_id);
        const expected = estimate ? JSON.parse(estimate.snapshot)?.worker?.expected : null;
        if (typeof expected === "number" && Number.isFinite(expected)) {
          forecastErrors.push(Math.abs(execution.finished_at - execution.started_at - expected));
        }
      } catch { /* an estimate that cannot be read is not forecast error */ }
    }
  }

  return {
    harnessId: filter.harnessId,
    modelId: filter.modelId,
    accountId: filter.accountId ?? null,
    runCount,
    successCount: filter.role === "reviewer" ? qcPass : successCount,
    failureCount: filter.role === "reviewer" ? qcBlocked : failureCount,
    successRate,
    qcPassCount: qcPass,
    qcReworkCount: qcRework,
    qcBlockedCount: qcBlocked,
    qcPassRate,
    avgLatencyMs,
    avgCostUsd: costs.length >= 3 ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null,
    forecastErrorMs: forecastErrors.length >= 3 ? Math.round(forecastErrors.reduce((sum, value) => sum + value, 0) / forecastErrors.length) : null,
    confidence: runCount >= 8 ? "high" : runCount >= 3 ? "low" : "none",
    comparable: runCount >= 3,
    role: filter.role ?? null,
    isColdStart: runCount < 3,
  };
}

export const routerV2HistoryCore = {
  isRealProviderRun,
  queryMetrics: queryModelExecutionMetrics,
};
