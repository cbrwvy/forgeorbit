import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedTracePricing, seedTraceRun, traceProjectDirs, type TraceContext } from "../../../scripts/qa-analytics-trace-fixture.ts";

/**
 * Direction 15: what a filter, a period boundary and the result limits do to the figures, the records and
 * the exports. Every run is a disposable row in an isolated database shaped like the record a genuine run
 * leaves; nothing was executed by a provider, so this proves arithmetic and disclosure, not billing.
 *
 * Hand-derived: one fixture run is 100,000 input (30,000 of it cache read), 50,000 output at $2 / $8 / $1
 * per million, so 70,000 x $2/M + 50,000 x $8/M + 30,000 x $1/M = 0.14 + 0.40 + 0.03 = $0.57 USD,
 * and the EUR account prices the same usage at EUR 0.57.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-analytics-limits-")));
mkdirSync(join(root, "home"));
process.env.HOME = join(root, "home");
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_DOWNLOADS_DIR = join(root, "downloads");

const { db, projects, runs } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { analytics, MAX_TASKS } = await import("./analytics.ts");
const { analyticsRecords, RECORD_LIMIT } = await import("./records.ts");
const { usageAnalyticsHttp } = await import("./http.ts");

const core = new AccountCore(db);
const dirs = traceProjectDirs(root);
projects.upsert(dirs.one, "Limits one");
projects.upsert(dirs.two, "Limits two");
const usd = core.createAccount({ provider: "openai", displayName: "USD account" });
const eur = core.createAccount({ provider: "openai", displayName: "EUR account" });
const sub = core.createAccount({ provider: "openai", displayName: "Subscription account" });
const now = Date.now();
const DAY = 86_400_000;
const ctx: TraceContext = {
  db, projectOne: dirs.one, projectTwo: dirs.two, a1: usd, a2: eur, a3: sub, now,
  insertRun: row => runs.insert({ ...row, status: "succeeded", exitCode: 0, qcReviewId: undefined, tmuxSession: null, claudeSessionId: null,
    codexSessionId: row.id, cursorSessionId: null, geminiSessionId: null, fxSessionId: null } as never),
};
seedTracePricing({ ...ctx, now: now + DAY }); // price revisions effective before every run below
db.run("UPDATE usage_pricing SET created_at = ?", [now - 90 * DAY]);

let taskSeq = 0;
const task = (workdir: string, title = `Task ${++taskSeq}`, updatedAt = now - 90 * DAY + taskSeq) => {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'review','codex',?, 'gpt-6.1-sol','auto',?,?)`, [id, title, "Add an example.", workdir, now - 91 * DAY, updatedAt]);
  return id;
};
const seed = (taskId: string, account: { id: string }, at: number, extra: { usage?: boolean; execution?: "real-provider" | "synthetic" } = {}) =>
  seedTraceRun(ctx, { taskId, account, startOffsetMs: at - now, ...extra });

afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const bucket = (result: { buckets: Array<{ key: string; runs: number; amount: number | null }> }, key: string) => result.buckets.find(item => item.key === key);
const COUNTED = ["tasks", "runs", "run_events", "usage_task_estimates", "usage_group_forecasts", "usage_pricing", "usage_cost_adjustments",
  "quota_observations", "resource_accounts", "provider_refusal_observations", "allocation_plans", "autonomy_policies"];
const stored = () => Object.fromEntries(COUNTED.map(table => [table, db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]));

// ---- period boundaries: `from` is inclusive, `until` is exclusive, both on the run's recorded start ----
const B = now - 10 * DAY;
const bFrom = B, bUntil = B + 1000;
const tb = task(dirs.one);
const tbTwo = task(dirs.two);
const rBefore = seed(tb, usd, bFrom - 1);        // 1 ms before the period: out
const rAtFrom = seed(tb, usd, bFrom);            // exactly at from: in
const rLast = seed(tb, usd, bUntil - 1);         // last ms inside: in
const rAtUntil = seed(tb, usd, bUntil);          // exactly at until: out
const rOtherProject = seed(tbTwo, eur, bFrom + 5);

test("period boundaries: from is inclusive, until is exclusive, and the summary, records and export agree", async () => {
  const filter = { from: bFrom, until: bUntil };
  const records = analyticsRecords(filter, now);
  const ids = records.records.map(record => record.runId);
  expect(ids).toContain(rAtFrom);
  expect(ids).toContain(rLast);
  expect(ids).not.toContain(rBefore);
  expect(ids).not.toContain(rAtUntil);
  // Three in-period runs: two USD (0.57 each) and one EUR (0.57), never added across currencies.
  expect(records.counts.records).toBe(3);
  expect(bucket(records, "calculated-api/USD")).toMatchObject({ runs: 2 });
  expect(bucket(records, "calculated-api/USD")!.amount).toBeCloseTo(1.14, 9);
  expect(bucket(records, "calculated-api/EUR")!.amount).toBeCloseTo(0.57, 9);
  const summary = analytics(filter, now);
  expect(summary.usage.costTotals.map(total => `${total.kind}/${total.currency}/${total.amount.toFixed(2)}`).sort())
    .toEqual(["calculated-api/EUR/0.57", "calculated-api/USD/1.14"]);
  expect(records.reconciliation.matchesSummary).toBe(true);
  // A project scope keeps the same boundary rule.
  const one = analyticsRecords({ ...filter, projectPath: dirs.one }, now);
  expect(one.records.map(record => record.runId).sort()).toEqual([rAtFrom, rLast].sort());
  expect(analyticsRecords({ ...filter, projectPath: dirs.two }, now).records.map(record => record.runId)).toEqual([rOtherProject]);
  // The export reads the same set.
  const response = await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/export?from=${bFrom}&until=${bUntil}&report=runs&format=json`), true);
  const body = JSON.parse(await response!.text());
  expect(body.runs.map((run: { runId: string }) => run.runId).sort()).toEqual([rAtFrom, rLast, rOtherProject].sort());
  expect(body.coverage).toMatchObject({ recordsExported: 3, recordsQualifying: 3, recordsTruncated: false });
});

// ---- the record cap: a cap hides rows, never shrinks an amount ----
const C = now - 20 * DAY;
const capTasks = [task(dirs.one), task(dirs.one), task(dirs.two)];
const capUnknown = seed(capTasks[0]!, usd, C + 1, { usage: false });                 // genuine run with no usage: Unknown, never zero
const capEur = seed(capTasks[1]!, eur, C + 2);                                          // EUR 0.57
const capUsd = [3, 4, 5, 6, 7].map(offset => seed(capTasks[2]!, usd, C + offset));    // five USD 0.57
const capPeriod = { from: C, until: C + 100 };

test("a capped list keeps the newest records, totals still cover the whole scope, and Unknown stays Unknown", () => {
  const full = analyticsRecords(capPeriod, now);
  expect(full.counts).toMatchObject({ records: 7, listed: 7, included: 7, excluded: 0 });
  expect(full.recordsTruncated).toBe(false);
  const capped = analyticsRecords(capPeriod, now, undefined, 3);
  // Newest first: offsets 7, 6, 5.
  expect(capped.records.map(record => record.runId)).toEqual([capUsd[4]!, capUsd[3]!, capUsd[2]!]);
  expect(capped.listOrder).toBe("newest-first");
  expect(capped.counts).toMatchObject({ records: 7, listed: 3, included: 7, excluded: 0 });
  expect(capped.recordsTruncated).toBe(true);
  expect(capped.truncated).toBe(true);
  // Whole-scope amounts: USD 5 x 0.57 = 2.85, EUR 0.57, one Unknown. These do not move with the cap.
  expect(bucket(capped, "calculated-api/USD")).toMatchObject({ runs: 5 });
  expect(bucket(capped, "calculated-api/USD")!.amount).toBeCloseTo(2.85, 9);
  expect(bucket(capped, "calculated-api/EUR")!.amount).toBeCloseTo(0.57, 9);
  expect(bucket(capped, "unknown-cost")).toMatchObject({ runs: 1, amount: null });
  expect(capped.buckets).toEqual(full.buckets);
  // The listed rows are a subset: 3 x 0.57 = 1.71 USD, and it is reported separately.
  expect(capped.shownBuckets).toHaveLength(1);
  expect(capped.shownBuckets[0]).toMatchObject({ key: "calculated-api/USD", runs: 3 });
  expect(capped.shownBuckets[0]!.amount).toBeCloseTo(1.71, 9);
  // The cap does not break the check against the summary, which reads the whole scope.
  expect(capped.reconciliation.matchesSummary).toBe(true);
  const summary = analytics(capPeriod, now);
  expect(summary.usage.unknownCostRuns).toBe(1);
  expect(summary.usage.costTotals.find(total => total.currency === "USD")!.amount).toBeCloseTo(2.85, 9);
  // Unknown is never read as zero: a listing of only the Unknown run has no amount.
  const onlyUnknown = analyticsRecords({ ...capPeriod, from: C + 1, until: C + 2 }, now);
  expect(onlyUnknown.records.map(record => record.runId)).toEqual([capUnknown]);
  expect(onlyUnknown.buckets).toEqual([{ key: "unknown-cost", runs: 1, kind: null, currency: null, amount: null }]);
  expect(capEur).toBeTruthy();
});

// ---- the real caps: 2,000 listed records and 500 tasks ----
const R = now - 40 * DAY;
const bulk = [task(dirs.one, "Bulk one"), task(dirs.one, "Bulk two"), task(dirs.two, "Bulk three")];
const BULK_RUNS = RECORD_LIMIT + 7;
db.transaction(() => {
  for (let index = 0; index < BULK_RUNS; index++) seed(bulk[index % 3]!, index % 2 ? usd : eur, R + index);
})();
const bulkPeriod = { from: R, until: R + BULK_RUNS };

test("past the record limit the list is capped, the totals are not, and the run export holds every record", async () => {
  const result = analyticsRecords(bulkPeriod, now);
  expect(RECORD_LIMIT).toBe(2000);
  // 2,007 runs: indexes 0..2006; odd indexes are USD (1003), even are EUR (1004), each 0.57.
  expect(result.counts).toMatchObject({ records: 2007, listed: 2000, included: 2007, excluded: 0 });
  expect(result.recordsTruncated).toBe(true);
  expect(result.records).toHaveLength(2000);
  expect(bucket(result, "calculated-api/USD")).toMatchObject({ runs: 1003 });
  expect(bucket(result, "calculated-api/USD")!.amount).toBeCloseTo(1003 * 0.57, 6);
  expect(bucket(result, "calculated-api/EUR")).toMatchObject({ runs: 1004 });
  expect(bucket(result, "calculated-api/EUR")!.amount).toBeCloseTo(1004 * 0.57, 6);
  // The cap keeps the newest 2,000 (indexes 7..2006): 1000 odd = USD, 1000 even = EUR in the list.
  expect(result.shownBuckets.find(item => item.key === "calculated-api/USD")).toMatchObject({ runs: 1000 });
  expect(result.shownBuckets.find(item => item.key === "calculated-api/EUR")).toMatchObject({ runs: 1000 });
  expect(result.reconciliation.matchesSummary).toBe(true);
  const summary = analytics(bulkPeriod, now);
  expect(summary.usage.realRuns).toBe(2007);
  expect(summary.usage.costTotals.find(total => total.currency === "USD")!.amount).toBeCloseTo(1003 * 0.57, 6);

  const csv = await (await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/export?from=${R}&until=${R + BULK_RUNS}&report=runs&format=csv`), true))!.text();
  const lines = csv.split("\n").filter(Boolean);
  expect(lines[0]).toContain("recordsQualifying=2007");
  expect(lines[0]).toContain("recordsExported=2007");
  expect(lines[0]).toContain("recordsTruncated=false");
  expect(lines.length - 2).toBe(2007); // preamble + header + every record
  const json = JSON.parse(await (await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/export?from=${R}&until=${R + BULK_RUNS}&report=runs&format=json`), true))!.text());
  expect(json.runs).toHaveLength(2007);
  expect(json.coverage).toMatchObject({ recordsExported: 2007, recordsQualifying: 2007, recordsTruncated: false });
  // The task export states what qualified without claiming it holds the run rows.
  const tasks = JSON.parse(await (await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/export?from=${R}&until=${R + BULK_RUNS}&report=tasks&format=json`), true))!.text());
  expect(tasks.coverage).toMatchObject({ recordsExported: null, recordsQualifying: 2007, tasksInScope: 3, tasksInScopeIsLowerBound: false });
}, 60_000);

const S = now - 60 * DAY;
db.transaction(() => {
  for (let index = 0; index < MAX_TASKS + 1; index++) {
    // updated_at ascends with the index, so index 0 is the least recently updated task.
    seed(task(dirs.one, `Scope ${index}`, now - 59 * DAY + index), usd, S + index);
  }
})();
const scopePeriod = { from: S, until: S + MAX_TASKS + 1 };

test("past the task limit the scope is a labelled floor and the least recently updated task is the one left out", async () => {
  expect(MAX_TASKS).toBe(500);
  const summary = analytics(scopePeriod, now);
  expect(summary.truncated).toBe(true);
  expect(summary.tasksInScope).toBe(500);
  expect(summary.tasksInScopeIsLowerBound).toBe(true);
  expect(summary.taskScopeLimit).toBe(500);
  // 501 tasks matched, 500 were read: 500 x 0.57 = 285.00, not 501 x 0.57.
  expect(summary.usage.realRuns).toBe(500);
  expect(summary.usage.costTotals[0]!.amount).toBeCloseTo(285, 6);
  const records = analyticsRecords(scopePeriod, now);
  expect(records.scopeTruncated).toBe(true);
  expect(records.taskScopeLimit).toBe(500);
  expect(records.counts).toMatchObject({ records: 500, tasksInScope: 500, tasksInScopeIsLowerBound: true });
  expect(records.records.map(record => record.taskTitle)).not.toContain("Scope 0");
  expect(records.records.map(record => record.taskTitle)).toContain("Scope 500");
  expect(records.reconciliation.matchesSummary).toBe(true);
  const json = JSON.parse(await (await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/export?from=${scopePeriod.from}&until=${scopePeriod.until}&report=tasks&format=json`), true))!.text());
  expect(json.coverage.scopeNote).toContain("may leave out older matching tasks");
  expect(json.coverage).toMatchObject({ tasksInScope: 500, tasksInScopeIsLowerBound: true, taskScopeLimit: 500, tasksListed: 500 });
  const csv = await (await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/export?from=${scopePeriod.from}&until=${scopePeriod.until}&report=runs&format=csv`), true))!.text();
  expect(csv.split("\n")[0]).toContain("tasksInScope=500+ scopeTruncated=true taskScopeLimit=500");
}, 60_000);

test("viewing, filtering and exporting past the limits write nothing and spawn nothing", async () => {
  const before = stored();
  const spawned = spyOn(Bun, "spawn");
  const spawnedSync = spyOn(Bun, "spawnSync");
  for (const query of [`from=${R}&until=${R + BULK_RUNS}`, `from=${S}&until=${S + 501}`, `from=${bFrom}&until=${bUntil}&projectPath=${encodeURIComponent(dirs.one)}`]) {
    for (const path of ["/analytics", "/records", ...["tasks", "models", "runs"].flatMap(report => ["csv", "json"].map(format => `/export?report=${report}&format=${format}`))]) {
      const url = `http://localhost/api/usage-analytics${path}${path.includes("?") ? "&" : "?"}${query}`;
      expect((await usageAnalyticsHttp(new Request(url), true))!.status, url).toBe(200);
    }
  }
  expect(spawned).not.toHaveBeenCalled();
  expect(spawnedSync).not.toHaveBeenCalled();
  expect(stored()).toEqual(before);
}, 120_000);
