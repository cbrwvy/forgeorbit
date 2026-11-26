import { AccountCore } from "../account-core.ts";
import { db, projects } from "../db.ts";
import type { AnalyticsFilter, RunCost } from "../../shared/usage-analytics.ts";
import { collectScope, MAX_TASKS } from "./analytics.ts";
import { type ActualRun, summarizeRuns } from "./actuals.ts";

/**
 * The records behind every amount Analytics displays (FO-ANALYTICS-TRACE01). One row per run, read from
 * the same scope `analytics()` summarizes (`collectScope`), so the on-screen figures, this list and the
 * run export always describe the same set. Read-only: nothing here refreshes a provider, runs a CLI,
 * writes a record or changes a forecast.
 *
 * Attribution is what the run recorded: the project from the scope captured when the run started and
 * the account from the identity captured for that run. A later task move, account rename or resource
 * selection does not change it, and a missing value stays Unknown (null). Labels (project name,
 * account name) are looked up for display only.
 */
export const RECORD_LIMIT = 2000;

export type RecordExclusion = "synthetic-evidence" | "unknown-execution";

/** An amount bucket: one evidence category in its own currency, or a count-only bucket. Never mixed. */
export type BucketKey = `${Exclude<RunCost["kind"], "unknown" | "subscription">}/${string}` | "subscription" | "unknown-cost" | "excluded";

export interface AnalyticsRecord {
  runId: string;
  taskId: string;
  taskTitle: string;
  role: "developer" | "reviewer";
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  /** The recorded project, from the scope captured at run start. Null when none was recorded. */
  projectPath: string | null;
  projectLabel: string | null;
  /** The account identity captured for this run. Null when none was recorded. */
  accountId: string | null;
  /** Display only. A rename changes this label and never the attribution above. */
  accountLabel: string | null;
  harnessId: string;
  provider: string | null;
  model: string | null;
  mode: string | null;
  specialist: string | null;
  execution: ActualRun["execution"];
  /** True when the run counts toward genuine totals. Excluded runs stay visible for context. */
  included: boolean;
  exclusion: RecordExclusion | null;
  tokens: ActualRun["tokens"];
  tokenSource: string | null;
  cost: { kind: RunCost["kind"]; amount: number | null; currency: string | null; source: string | null; pricingId: number | null };
  reportedTelemetry: { amount: number; currency: string } | null;
  subscriptionReceipt: { amount: number; unit: string } | null;
  bucket: BucketKey;
}

export interface BucketTotal {
  key: BucketKey;
  /** Number of runs in the bucket. */
  runs: number;
  kind: string | null;
  currency: string | null;
  /** The summed amount, in the bucket's own currency. Null for count-only buckets. */
  amount: number | null;
}

const bucketOf = (run: ActualRun): BucketKey => {
  if (run.execution !== "real-provider") return "excluded";
  if (run.cost.kind === "subscription") return "subscription";
  if (!run.cost.money) return "unknown-cost";
  return `${run.cost.kind}/${run.cost.money.currency}` as BucketKey;
};

function totalsOf(records: AnalyticsRecord[]): BucketTotal[] {
  const groups = new Map<BucketKey, BucketTotal>();
  for (const record of records) {
    const prior = groups.get(record.bucket);
    const amount = record.cost.amount;
    groups.set(record.bucket, {
      key: record.bucket, runs: (prior?.runs ?? 0) + 1,
      kind: record.bucket.includes("/") ? record.cost.kind : null, currency: record.bucket.includes("/") ? record.cost.currency : null,
      amount: record.bucket.includes("/") ? (prior?.amount ?? 0) + (amount ?? 0) : null,
    });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function analyticsRecords(
  filter: AnalyticsFilter, now = Date.now(), allowProject?: (path: string) => boolean, limit = RECORD_LIMIT,
) {
  const { measured, from, until, truncated: scopeTruncated, tasksInScope } = collectScope(filter, now, allowProject);
  const accounts = new Map(new AccountCore(db).listAccounts().map(account => [account.id, account.displayName]));
  const periodRuns = measured.flatMap(item => item.periodRuns);
  const titleOf = new Map(measured.map(item => [item.task.id, item.task.title]));
  const all: AnalyticsRecord[] = [];
  for (const { task, periodRuns: runs } of measured) {
    for (const run of runs) {
      const projectPath = run.scope?.projectPath ?? null;
      const included = run.execution === "real-provider";
      all.push({
        runId: run.id, taskId: run.taskId, taskTitle: titleOf.get(run.taskId) ?? task.title,
        role: run.role, status: run.status, startedAt: run.start, endedAt: run.end, durationMs: run.durationMs,
        projectPath, projectLabel: projectPath ? projects.get(projectPath)?.name ?? null : null,
        accountId: run.accountId, accountLabel: run.accountId ? accounts.get(run.accountId) ?? null : null,
        harnessId: run.harnessId, provider: run.provider, model: run.model, mode: run.mode, specialist: run.specialist,
        execution: run.execution, included,
        exclusion: included ? null : run.execution === "synthetic" ? "synthetic-evidence" : "unknown-execution",
        tokens: run.tokens, tokenSource: run.tokenSource,
        cost: { kind: run.cost.kind, amount: run.cost.money?.amount ?? null, currency: run.cost.money?.currency ?? null,
          source: run.cost.source, pricingId: run.cost.pricingId },
        reportedTelemetry: run.reportedTelemetry ? { amount: run.reportedTelemetry.amount, currency: run.reportedTelemetry.currency } : null,
        subscriptionReceipt: run.subscriptionUsage ? { amount: run.subscriptionUsage.amount, unit: run.subscriptionUsage.unit } : null,
        bucket: bucketOf(run),
      });
    }
  }
  // Most recent first, so a capped list keeps the newest runs and says so. Every total below is taken over
  // the whole scope (`all`), never over the listed slice, so a cap can hide rows but never shrinks an amount.
  all.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId));
  const records = all.slice(0, limit);
  const included = all.filter(record => record.included);
  const buckets = totalsOf(all);
  const shownBuckets = totalsOf(records);
  const summary = summarizeRuns(periodRuns);
  // The amounts the Analytics summary shows, derived independently from the records of the same scope.
  const reconciles = summary.costTotals.every(total => {
    const bucket = buckets.find(item => item.key === `${total.kind}/${total.currency}`);
    return !!bucket && Math.abs((bucket.amount ?? NaN) - total.amount) < 1e-9;
  }) && buckets.filter(item => item.key.includes("/")).length === summary.costTotals.length &&
    (buckets.find(item => item.key === "unknown-cost")?.runs ?? 0) === summary.unknownCostRuns &&
    (buckets.find(item => item.key === "subscription")?.runs ?? 0) === summary.subscriptionRuns;
  const group = (key: (record: AnalyticsRecord) => string | null, label: (record: AnalyticsRecord) => string | null) => {
    const groups = new Map<string, AnalyticsRecord[]>();
    for (const record of records) {
      const id = key(record) ?? "unknown";
      groups.set(id, [...(groups.get(id) ?? []), record]);
    }
    return [...groups].map(([id, items]) => ({
      id, label: id === "unknown" ? null : label(items[0]!), runs: items.length, excludedRuns: items.filter(item => !item.included).length,
      buckets: totalsOf(items),
    })).sort((a, b) => a.id.localeCompare(b.id));
  };
  return {
    filter, period: { from, until: Math.min(until, now + 1) },
    /** The rules that decide what counts, stated once for the screen and for the export. */
    eligibility: {
      genuineOnly: "Only runs recorded as genuine provider executions count toward amounts. Synthetic and unknown-evidence runs are listed for context and excluded.",
      attribution: "Project and account are the values recorded for each run. A later task move, account rename or resource change does not reassign them. A missing value is Unknown.",
      currencies: "Each evidence category stays in its own currency. Nothing is converted or added across categories.",
      unknown: "A run with no usable usage or price evidence has an Unknown cost. Subscription-covered runs carry no per-task money value.",
    },
    counts: {
      /** Every run record in the scope, whether or not it is listed. */
      records: all.length, listed: records.length, included: included.length, excluded: all.length - included.length,
      excludedSynthetic: all.filter(record => record.exclusion === "synthetic-evidence").length,
      excludedUnknown: all.filter(record => record.exclusion === "unknown-execution").length,
      tasksInScope,
      /** True when more tasks matched than the scope reads: `tasksInScope` is then a floor, not the number that qualify. */
      tasksInScopeIsLowerBound: scopeTruncated,
    },
    /** Amounts over the whole scope. They match the Analytics summary. */
    buckets,
    /** Amounts over the listed records only. Differs from `buckets` exactly when the list is capped. */
    shownBuckets, byProject: group(record => record.projectPath, record => record.projectLabel), byAccount: group(record => record.accountId, record => record.accountLabel),
    reconciliation: { matchesSummary: reconciles, checkedAgainst: "usage.costTotals, usage.unknownCostRuns, usage.subscriptionRuns" },
    truncated: scopeTruncated || all.length > limit, recordsTruncated: all.length > limit, scopeTruncated, taskScopeLimit: MAX_TASKS, recordLimit: limit,
    /** What the cap keeps when it applies. */
    listOrder: "newest-first" as const, records,
  };
}
