import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedTracePricing, seedTraceRun, traceProjectDirs, TRACE_RECEIPT, type TraceContext } from "../../../scripts/qa-analytics-trace-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-analytics-trace-")));
mkdirSync(join(root, "home"));
process.env.HOME = join(root, "home");
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_DOWNLOADS_DIR = join(root, "downloads");

const { db, projects, runs } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { analytics } = await import("./analytics.ts");
const { analyticsRecords } = await import("./records.ts");
const { renderAnalyticsExport } = await import("./export.ts");
const { usageAnalyticsHttp } = await import("./http.ts");

const core = new AccountCore(db);
const dirs = traceProjectDirs(root);
projects.upsert(dirs.one, "Trace one");
projects.upsert(dirs.two, "Trace two");
const a1 = core.createAccount({ provider: "openai", displayName: "Account one" });
const a2 = core.createAccount({ provider: "openai", displayName: "Account two" });
const a3 = core.createAccount({ provider: "openai", displayName: "Account three" });
const now = Date.now();
const ctx: TraceContext = {
  db, projectOne: dirs.one, projectTwo: dirs.two, a1, a2, a3, now,
  insertRun: row => runs.insert({ ...row, status: "succeeded", exitCode: 0, qcReviewId: undefined, tmuxSession: null, claudeSessionId: null,
    codexSessionId: row.id, cursorSessionId: null, geminiSessionId: null, fxSessionId: null } as never),
};
const task = (title: string, workdir: string) => {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'review','codex',?, 'gpt-6.1-sol','auto',?,?)`, [id, title, "Add an example.", workdir, now - 7_200_000, now - 7_200_000]);
  return id;
};
seedTracePricing(ctx);
const t1 = task("T1 calculated USD", dirs.one);
const t2 = task("T2 calculated EUR", dirs.two);
const t3 = task("T3 billed receipt", dirs.one);
const t4 = task("T4 no usage", dirs.two);
const t5 = task("T5 subscription", dirs.one);
const t6 = task("T6 synthetic", dirs.one);
const t7 = task("T7 before period", dirs.one);
const loose = task("T8 no recorded project", join(root, "elsewhere"));
const r1 = seedTraceRun(ctx, { taskId: t1, account: a1, startOffsetMs: -600_000 });
const r2 = seedTraceRun(ctx, { taskId: t2, account: a2, startOffsetMs: -500_000 });
const r3 = seedTraceRun(ctx, { taskId: t3, account: a1, startOffsetMs: -400_000, billed: TRACE_RECEIPT });
const r4 = seedTraceRun(ctx, { taskId: t4, account: a1, startOffsetMs: -300_000, usage: false });
const r5 = seedTraceRun(ctx, { taskId: t5, account: a3, startOffsetMs: -200_000 });
const r6 = seedTraceRun(ctx, { taskId: t6, account: a1, startOffsetMs: -100_000, execution: "synthetic" });
const r7 = seedTraceRun(ctx, { taskId: t7, account: a1, startOffsetMs: -10_000_000 });
const r8 = seedTraceRun(ctx, { taskId: loose, account: a2, startOffsetMs: -50_000 });
db.run("UPDATE runs SET usage_scope = NULL WHERE id = ?", [r8]); // no recorded scope at all
const period = { from: now - 3_600_000, until: now + 60_000 };

afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const amount = (result: ReturnType<typeof analyticsRecords>, key: string) => result.buckets.find(bucket => bucket.key === key);
const COUNTED = ["task_dependencies", "tasks", "runs", "run_events", "usage_task_estimates", "usage_group_forecasts", "usage_pricing",
  "usage_cost_adjustments", "quota_observations", "resource_accounts", "provider_refusal_observations", "allocation_plans", "autonomy_policies"];
const stored = () => Object.fromEntries(COUNTED.map(table => [table, db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]));

test("records reconcile with the summary: one amount per category and currency, counts for the rest", () => {
  const result = analyticsRecords(period, now);
  const summary = analytics(period, now);
  expect(result.reconciliation.matchesSummary).toBe(true);
  expect(amount(result, "calculated-api/USD")).toMatchObject({ runs: 1 });
  expect(amount(result, "calculated-api/USD")!.amount).toBeCloseTo(0.57, 9);
  expect(amount(result, "calculated-api/EUR")).toMatchObject({ runs: 2, currency: "EUR" }); // T2 and the run with no recorded project
  expect(amount(result, "reported-api/USD")).toMatchObject({ runs: 1, amount: TRACE_RECEIPT.amount });
  expect(amount(result, "subscription")).toMatchObject({ runs: 1, amount: null });
  expect(amount(result, "unknown-cost")).toMatchObject({ runs: 1, amount: null });
  expect(amount(result, "excluded")).toMatchObject({ runs: 1 });
  // The listed records add up to exactly what the summary shows, per category and currency.
  for (const total of summary.usage.costTotals) expect(amount(result, `${total.kind}/${total.currency}`)!.amount).toBeCloseTo(total.amount, 9);
  expect(summary.usage.unknownCostRuns).toBe(1);
  expect(summary.usage.subscriptionRuns).toBe(1);
  // Currencies and categories are never merged into one amount.
  expect(result.buckets.filter(bucket => bucket.key.includes("/")).map(bucket => bucket.key).sort())
    .toEqual(["calculated-api/EUR", "calculated-api/USD", "reported-api/USD"]);
  // The run outside the selected period is not listed.
  expect(result.records.map(record => record.runId)).not.toContain(r7);
  expect(result.counts.tasksInScope).toBe(summary.tasksInScope);
});

test("excluded synthetic evidence is listed with its reason and never enters a genuine total", () => {
  const result = analyticsRecords(period, now);
  const synthetic = result.records.find(record => record.runId === r6)!;
  expect(synthetic).toMatchObject({ included: false, exclusion: "synthetic-evidence", bucket: "excluded", execution: "synthetic" });
  expect(synthetic.cost).toMatchObject({ kind: "unknown", amount: null });
  expect(result.counts).toMatchObject({ excludedSynthetic: 1 });
  const withoutIt = analytics({ ...period, taskId: t6 }, now);
  expect(withoutIt.usage.costTotals).toEqual([]);
  expect(withoutIt.usage.realRuns).toBe(0);
});

test("attribution is what each run recorded; a missing value stays Unknown", () => {
  const result = analyticsRecords(period, now);
  const byRun = new Map(result.records.map(record => [record.runId, record]));
  expect(byRun.get(r1)).toMatchObject({ projectPath: dirs.one, projectLabel: "Trace one", accountId: a1.id, accountLabel: "Account one", role: "developer" });
  expect(byRun.get(r2)).toMatchObject({ projectPath: dirs.two, accountId: a2.id });
  expect(byRun.get(r8)).toMatchObject({ projectPath: null, projectLabel: null });
  expect(result.byProject.find(group => group.id === "unknown")).toMatchObject({ label: null, runs: 1 });
  expect(analyticsRecords({ ...period, projectPath: dirs.one }, now).records.map(record => record.runId)).not.toContain(r8);
});

test("changing scope excludes the right records and each scope still reconciles", () => {
  const all = analyticsRecords(period, now);
  const one = analyticsRecords({ ...period, projectPath: dirs.one }, now);
  const two = analyticsRecords({ ...period, projectPath: dirs.two }, now);
  expect(new Set(one.records.map(record => record.runId))).toEqual(new Set([r1, r3, r5, r6]));
  expect(new Set(two.records.map(record => record.runId))).toEqual(new Set([r2, r4]));
  const account = analyticsRecords({ ...period, accountId: a2.id }, now);
  expect(account.records.map(record => record.runId).sort()).toEqual([r2, r8].sort());
  for (const scope of [one, two, account]) expect(scope.reconciliation.matchesSummary).toBe(true);
  // The two project scopes together hold every recorded-project run; a run with no recorded project is in neither.
  expect(one.records.length + two.records.length + 1).toBe(all.records.length);
  expect(amount(one, "calculated-api/EUR")).toBeUndefined();
  expect(amount(two, "calculated-api/USD")).toBeUndefined();
  expect(one.filter.projectPath).toBe(dirs.one);
});

test("a later task move, account rename or resource change never rewrites recorded attribution", () => {
  const before = analyticsRecords(period, now).records.find(record => record.runId === r1)!;
  db.run("UPDATE tasks SET workdir = ?, agent = 'claude-code', model = 'opus-5.5' WHERE id = ?", [dirs.two, t1]);
  core.updateAccount(a1.id, { displayName: "Renamed account one" });
  // A price revision effective after the run never reprices it.
  db.run("INSERT INTO usage_pricing(harness_id,account_id,model_id,created_at,terms) VALUES ('codex',?,?,?,?)", [a1.id, "gpt-6.1-sol", now,
    JSON.stringify({ billing: "api", currency: "USD", inputPerMillion: 999, outputPerMillion: 999, cacheReadPerMillion: 999, cacheWritePerMillion: 0 })]);
  const after = analyticsRecords(period, now).records.find(record => record.runId === r1)!;
  expect(after.projectPath).toBe(before.projectPath);
  expect(after.accountId).toBe(before.accountId);
  expect(after.harnessId).toBe(before.harnessId);
  expect(after.model).toBe(before.model);
  expect(after.cost).toEqual(before.cost);
  expect(after.accountLabel).toBe("Renamed account one"); // a display label, never a scope key
  expect(analyticsRecords({ ...period, projectPath: dirs.one }, now).records.map(record => record.runId)).toContain(r1);
  expect(analyticsRecords({ ...period, projectPath: dirs.two }, now).records.map(record => record.runId)).not.toContain(r1);
  expect(analyticsRecords({ ...period, accountId: a1.id }, now).records.map(record => record.runId)).toContain(r1);
});

test("the run export holds the same records and amounts as the screen, for the same filter", () => {
  const filter = { ...period, projectPath: dirs.one };
  const result = analytics(filter, now, undefined, { taskLimit: 500 });
  const records = analyticsRecords(filter, now);
  const csv = renderAnalyticsExport(result, "runs", "csv", { timeZone: "UTC", grain: "day", records });
  const lines = csv.body.split("\n");
  expect(lines[0]).toContain("report=runs");
  expect(lines[0]).toContain(`includedRuns=${records.counts.included}`);
  expect(lines[0]).toContain(`excludedRuns=${records.counts.excluded}`);
  expect(lines[0]).toContain(JSON.stringify({ ...filter }));
  const header = lines[1]!.split(",");
  const rows = lines.slice(2).filter(Boolean);
  expect(rows).toHaveLength(records.records.length);
  const col = (name: string) => header.indexOf(name);
  const exported = new Map<string, number>();
  for (const row of rows) {
    const cells = row.split(",");
    if (cells[col("counting")] === "counted" && /^\d/.test(cells[col("amount")]!)) {
      const key = `${cells[col("costKind")]}/${cells[col("currency")]}`;
      exported.set(key, (exported.get(key) ?? 0) + Number(cells[col("amount")]));
    }
  }
  for (const total of result.usage.costTotals) expect(exported.get(`${total.kind}/${total.currency}`)).toBeCloseTo(total.amount, 9);
  expect(rows.filter(row => row.includes("excluded")).length).toBe(records.counts.excluded);
  const json = JSON.parse(renderAnalyticsExport(result, "runs", "json", { timeZone: "UTC", grain: "day", records }).body);
  expect(json.runs).toHaveLength(records.records.length);
  expect(json.coverage.filter).toEqual(JSON.parse(JSON.stringify(filter)));
  expect(json.coverage.amountBuckets).toEqual(JSON.parse(JSON.stringify(records.buckets)));
  expect(json.coverage.eligibility.genuineOnly).toContain("excluded");
  // The task export of the same filter states the same filter, period and counts.
  const tasks = JSON.parse(renderAnalyticsExport(result, "tasks", "json", { timeZone: "UTC", grain: "day", records }).body);
  expect(tasks.coverage.runCounts).toEqual(json.coverage.runCounts);
  expect(tasks.coverage.tasksInScope).toBe(result.tasksInScope);
});

test("viewing, drilling down and exporting write nothing, spawn nothing and change no forecast", async () => {
  const before = stored();
  const spawned = spyOn(Bun, "spawn");
  const spawnedSync = spyOn(Bun, "spawnSync");
  const estimates = db.query("SELECT id, superseded FROM usage_task_estimates ORDER BY id").all();
  const headers = {};
  const get = async (path: string) => {
    const response = await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics${path}`, { headers }), true);
    expect(response!.status, path).toBe(200);
    return response!.text();
  };
  const q = `from=${period.from}&until=${period.until}`;
  await get(`/analytics?${q}`);
  await get(`/records?${q}&projectPath=${encodeURIComponent(dirs.one)}`);
  for (const report of ["tasks", "models", "runs"]) for (const format of ["csv", "json"]) await get(`/export?${q}&report=${report}&format=${format}`);
  await get(`/task?taskId=${t1}`);
  expect(spawned).not.toHaveBeenCalled();
  expect(spawnedSync).not.toHaveBeenCalled();
  spawned.mockRestore();
  spawnedSync.mockRestore();
  expect(stored()).toEqual(before);
  expect(db.query("SELECT id, superseded FROM usage_task_estimates ORDER BY id").all()).toEqual(estimates);
  expect((await usageAnalyticsHttp(new Request(`http://localhost/api/usage-analytics/records?${q}`), false))!.status).toBe(401);
});

test("the packaged app saves an export through the core: the file holds the same bytes as the download response", async () => {
  const q = `from=${period.from}&until=${period.until}&projectPath=${encodeURIComponent(dirs.one)}&report=runs&format=csv`;
  const base = "http://localhost/api/usage-analytics";
  const expected = await (await usageAnalyticsHttp(new Request(`${base}/export?${q}`), true))!.text();
  const before = existsSync(process.env.AGETOR_DOWNLOADS_DIR!) ? readdirSync(process.env.AGETOR_DOWNLOADS_DIR!) : [];
  expect(before).toEqual([]);
  const response = await usageAnalyticsHttp(new Request(`${base}/export/save?${q}`, { method: "POST" }), true);
  expect(response!.status).toBe(200);
  const saved = await response!.json() as { path: string; filename: string };
  expect(saved.path).toBe(join(process.env.AGETOR_DOWNLOADS_DIR!, saved.filename));
  expect(readFileSync(saved.path, "utf8")).toBe(expected);
  // A second save never overwrites the first.
  const again = await (await usageAnalyticsHttp(new Request(`${base}/export/save?${q}`, { method: "POST" }), true))!.json() as { path: string };
  expect(again.path).not.toBe(saved.path);
  expect(again.path.endsWith("forgeorbit-runs (2).csv")).toBe(true);
  expect(readdirSync(process.env.AGETOR_DOWNLOADS_DIR!).length).toBe(2);
  expect((await usageAnalyticsHttp(new Request(`${base}/export/save?${q}`, { method: "POST" }), false))!.status).toBe(401);
  expect((await usageAnalyticsHttp(new Request(`${base}/export/save?${q.replace("format=csv", "format=xml")}`, { method: "POST" }), true))!.status).toBe(400);
});
