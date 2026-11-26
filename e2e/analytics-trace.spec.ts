import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "./fixtures";
import { gotoApp, openProjectAnalytics } from "./helpers";
import { seedTracePricing, seedTraceRun, TRACE_RECEIPT, type TraceContext } from "../scripts/qa-analytics-trace-fixture";

/**
 * FO-ANALYTICS-TRACE01: start at a displayed amount, inspect the runs behind it, open the task, and
 * export the same scope. All data is a disposable fixture written into an isolated database. The rows
 * are shaped like the records a genuine run leaves, so this proves attribution, reconciliation and
 * export parity. It is not evidence of real provider billing. The Codex binary is a logging stub: no
 * provider is called, and its log shows whether anything spawned a CLI.
 */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "fo-trace-e2e-")));
const stub = join(scratch, "codex-stub");
writeFileSync(stub, "#!/bin/sh\nexit 1\n");
chmodSync(stub, 0o755);
test.use({ backendEnv: { AGETOR_CODEX_BIN: stub } });
test.describe.configure({ timeout: 150_000 });

type Call = (method: string, route: string, data?: unknown) => Promise<any>;

async function seed(call: Call, dataDir: string) {
  const home = mkdtempSync(join(scratch, "case-"));
  const one = join(home, "Trace one");
  const two = join(home, "Trace two");
  mkdirSync(one);
  mkdirSync(two);
  await call("POST", "/projects", { path: one, name: "Trace one" });
  await call("POST", "/projects", { path: two, name: "Trace two" });
  const account = (displayName: string) => call("POST", "/account-core/accounts", { provider: "openai", displayName });
  const a1 = await account("Account one");
  const a2 = await account("Account two");
  const a3 = await account("Account three");
  const task = async (title: string, workdir: string) => (await call("POST", "/tasks", {
    title, prompt: "Add an example.", workdir, agent: "codex", model: "gpt-6.1-sol", isolation: "none", column: "review",
  })).id as string;
  const t = {
    t1: await task("T1 calculated USD", one), t2: await task("T2 calculated EUR", two), t3: await task("T3 billed receipt", one),
    t4: await task("T4 no usage", two), t5: await task("T5 subscription", one), t6: await task("T6 synthetic", one),
    t7: await task("T7 before period", one), t8: await task("T8 no recorded project", join(home, "elsewhere")),
  };
  const now = Date.now();
  const db = new Database(join(dataDir, "agetor.sqlite"));
  db.run("PRAGMA busy_timeout = 5000");
  const ctx: TraceContext = {
    db, projectOne: one, projectTwo: two, a1, a2, a3, now,
    insertRun: row => {
      const scopeOf = (taskId: string) => db.query<{ workdir: string }, [string]>("SELECT workdir FROM tasks WHERE id = ?").get(taskId)!.workdir;
      db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,usage_scope) VALUES (?,?,?,'succeeded',?,?,0,?,?)`,
        [row.id, row.taskId, row.agent, row.startedAt, row.endedAt, row.id, JSON.stringify({
          projectPath: [one, two].includes(scopeOf(row.taskId)) ? scopeOf(row.taskId) : null, clusterId: null, missionId: null, category: "task", technology: "unknown", complexity: "low",
        })]);
    },
  };
  seedTracePricing(ctx);
  const run = {
    r1: seedTraceRun(ctx, { taskId: t.t1, account: a1, startOffsetMs: -600_000 }),
    r2: seedTraceRun(ctx, { taskId: t.t2, account: a2, startOffsetMs: -500_000 }),
    r3: seedTraceRun(ctx, { taskId: t.t3, account: a1, startOffsetMs: -400_000, billed: TRACE_RECEIPT }),
    r4: seedTraceRun(ctx, { taskId: t.t4, account: a1, startOffsetMs: -300_000, usage: false }),
    r5: seedTraceRun(ctx, { taskId: t.t5, account: a3, startOffsetMs: -200_000 }),
    r6: seedTraceRun(ctx, { taskId: t.t6, account: a1, startOffsetMs: -100_000, execution: "synthetic" }),
    r7: seedTraceRun(ctx, { taskId: t.t7, account: a1, startOffsetMs: -10 * 86_400_000 }),
    r8: seedTraceRun(ctx, { taskId: t.t8, account: a2, startOffsetMs: -50_000 }),
  };
  db.run("UPDATE runs SET usage_scope = NULL WHERE id = ?", [run.r8]);
  db.close();
  return { one, two, a1, a2, a3, t, run };
}

const TABLES = ["tasks", "runs", "run_events", "usage_task_estimates", "usage_group_forecasts", "usage_pricing", "usage_cost_adjustments",
  "quota_observations", "resource_accounts", "provider_refusal_observations", "allocation_plans", "autonomy_policies", "orchestration_missions"];
function stored(dataDir: string) {
  using db = new Database(join(dataDir, "agetor.sqlite"), { readonly: true });
  return Object.fromEntries(TABLES.map(table => [table, db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]));
}

function writes(page: Page) {
  const seen: string[] = [];
  page.on("request", request => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    const url = new URL(request.url());
    if (url.pathname.startsWith("/preferences/") || url.pathname === "/api/usage-analytics/export/save" || url.pathname === "/api/usage-analytics/forecast" || url.pathname === "/launch-diagnostics" || /^\/tasks\/[^/]+\/seen$/.test(url.pathname) || url.pathname === "/projects/discover") return;
    seen.push(`${request.method()} ${url.pathname}`);
  });
  return seen;
}

/** The export is written by the core into the Downloads seam (a blob download does nothing in the packaged WKWebView). */
let downloadsDir = "";
async function download(page: Page, button: Locator) {
  const names = () => (existsSync(downloadsDir) ? readdirSync(downloadsDir) : []);
  const before = new Set(names());
  await button.click();
  await expect.poll(() => names().filter(name => !before.has(name)).length, { timeout: 15_000 }).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: downloadsDir })).toBeVisible();
  return readFileSync(join(downloadsDir, names().find(name => !before.has(name))!), "utf8");
}
const csvRows = (text: string) => {
  const lines = text.split("\n").filter(Boolean);
  const header = lines[1]!.split(",");
  return { preamble: lines[0]!, header, rows: lines.slice(2).map(line => Object.fromEntries(line.split(",").map((cell, i) => [header[i]!, cell]))) };
};

test("the Owner traces an amount to its runs and the export reconciles for the same scope", async ({ page, request, freshBackend: backend }, info) => {
  downloadsDir = backend.downloadsDir;
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const call: Call = async (method, route, data) => {
    const response = await request.fetch(backend.apiBase + route, { method, headers, data });
    expect(response.ok(), `${method} ${route}: ${await response.text()}`).toBe(true);
    return response.status() === 204 ? null : await response.json();
  };
  await call("PUT", "/preferences/locale", { value: "en" });
  const f = await seed(call, backend.dataDir);
  const sent = writes(page);

  // 1. Analytics is Trace one's page. The other project's EUR and the unregistered run are not on it.
  await gotoApp(page, backend.bootBase);
  await openProjectAnalytics(page, f.one);
  await expect(page.getByTestId("project-analytics-scope")).toContainText("Trace one");
  await page.getByTestId("usage-range-last7").click();
  await page.getByTestId("usage-view-costs").click();
  const results = page.getByTestId("usage-analytics-results");
  await expect(results).toBeVisible();
  const amount = (bucket: string) => results.locator(`[data-testid="usage-amount"][data-bucket="${bucket}"]`).first();
  await expect(amount("calculated-api/USD")).toContainText("$0.57");
  await expect(results.locator('[data-testid="usage-amount"][data-bucket="calculated-api/EUR"]')).toHaveCount(0);
  await expect(amount("reported-api/USD")).toContainText("$0.80");
  await expect(amount("subscription")).toHaveText("1");
  await expect(amount("excluded")).toHaveText("1");
  await expect(results.getByTestId("usage-cost-coverage")).toContainText("subscription-covered");
  await expect(results.getByTestId("usage-cost-coverage")).toContainText("excluded");
  await expect(page.getByTestId("usage-task-list-note")).not.toContainText("T2 calculated EUR");

  const before = stored(backend.dataDir);
  const mark = sent.length;

  // 2. Start at an amount: the USD calculated amount opens exactly one record, and it reconciles.
  await amount("calculated-api/USD").click();
  const panel = page.getByTestId("usage-records");
  await expect(panel).toHaveAttribute("data-reconciled", "true");
  await expect(panel.getByTestId("usage-records-reconciles")).toContainText("$0.57");
  const records = panel.getByTestId("usage-record");
  await expect(records).toHaveCount(1);
  await expect(records.first()).toHaveAttribute("data-run-id", f.run.r1);
  await expect(records.first().getByTestId("usage-record-project")).toHaveText("Trace one");
  await expect(records.first().getByTestId("usage-record-account")).toContainText("Account one");
  await expect(records.first()).toContainText("Developer");
  await expect(records.first().getByTestId("usage-record-amount")).toContainText("$0.57");
  await expect(records.first().getByTestId("usage-record-evidence")).toHaveText("Counted");
  // The run outside the period and the synthetic run are not in this amount; the synthetic one is listed for context.
  await expect(panel.locator(`[data-run-id="${f.run.r7}"]`)).toHaveCount(0);
  await panel.getByTestId("usage-records-context").locator("summary").click();
  const context = panel.getByTestId("usage-records-context").locator(`[data-run-id="${f.run.r6}"]`);
  await expect(context).toContainText("Excluded: synthetic evidence");
  await expect(context.getByTestId("usage-record-amount")).toHaveText("Unknown");

  // 3. Trace one's page does not contain the other project's runs.
  await expect(panel.locator(`[data-run-id="${f.run.r2}"]`)).toHaveCount(0);
  await expect(panel.locator(`[data-run-id="${f.run.r8}"]`)).toHaveCount(0);

  // 4. Subscription and excluded each open their own records, with their reason.
  await amount("subscription").click();
  await expect(panel.locator(`[data-run-id="${f.run.r5}"]`).getByTestId("usage-record-amount")).toHaveText("Subscription-covered");
  await amount("excluded").click();
  await expect(panel.locator(`[data-run-id="${f.run.r6}"]`).getByTestId("usage-record-evidence")).toHaveText("Excluded: synthetic evidence");
  await amount("reported-api/USD").click();
  await expect(panel.getByTestId("usage-records-reconciles")).toContainText("$0.80");

  // 5. Open the contributing task: its run is highlighted with the same identity.
  await amount("calculated-api/USD").click();
  await panel.getByTestId("usage-record-open").first().click();
  const dialog = page.getByTestId("usage-task-dialog");
  await expect(dialog.getByTestId("usage-task-run").first()).toHaveAttribute("data-run-id", f.run.r1);
  await expect(dialog.locator('[data-testid="usage-task-run"][data-highlight="true"]')).toHaveCount(1);
  // The run table is below the summary tiles; opening from a record must scroll the highlighted run into view.
  await expect(dialog.locator('[data-testid="usage-task-run"][data-highlight="true"]')).toBeInViewport();
  await expect(dialog.getByTestId("usage-task-run-project").first()).toHaveText(f.one);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // 6. Export the whole scope: rows, categories and currencies match what the screen showed.
  const runsCsv = csvRows(await download(page, page.getByTestId("usage-export-runs-csv")));
  expect(runsCsv.preamble).toContain("report=runs");
  expect(runsCsv.rows.map(row => row.runId)).toContain(f.run.r1);
  expect(runsCsv.rows.map(row => row.runId)).not.toContain(f.run.r2);
  expect(runsCsv.rows.map(row => row.runId)).not.toContain(f.run.r7);
  expect(runsCsv.rows.map(row => row.runId)).not.toContain(f.run.r8);
  const sum = (kind: string, currency: string) => runsCsv.rows.filter(row => row.counting === "counted" && row.costKind === kind && row.currency === currency)
    .reduce((total, row) => total + Number(row.amount), 0);
  expect(sum("calculated-api", "USD")).toBeCloseTo(0.57, 9);
  expect(sum("reported-api", "USD")).toBeCloseTo(0.8, 9);
  const synthetic = runsCsv.rows.find(row => row.runId === f.run.r6)!;
  expect(synthetic).toMatchObject({ counting: "excluded", exclusionReason: "synthetic-evidence", amount: "Unknown" });
  const runsJson = JSON.parse(await download(page, page.getByTestId("usage-export-runs-json")));
  expect(runsJson.coverage.reconciliation.matchesSummary).toBe(true);
  expect(runsJson.coverage.filter.projectPath).toBe(f.one);
  const tasksJson = JSON.parse(await download(page, page.getByTestId("usage-export-json")));
  expect(tasksJson.coverage.runCounts).toEqual(runsJson.coverage.runCounts);
  expect(tasksJson.coverage.filter).toEqual(runsJson.coverage.filter);

  // 7. Trace two's page shows its own EUR and omits Trace one's USD.
  await openProjectAnalytics(page, f.two);
  await page.getByTestId("usage-range-last7").click();
  await page.getByTestId("usage-view-costs").click();
  const two = page.getByTestId("usage-analytics-results");
  await expect(two.locator('[data-testid="usage-amount"][data-bucket="calculated-api/USD"]')).toHaveCount(0);
  await expect(two.locator('[data-testid="usage-amount"][data-bucket="calculated-api/EUR"]').first()).toContainText("€0.57");
  await two.locator('[data-testid="usage-amount"][data-bucket="calculated-api/EUR"]').first().click();
  await expect(page.getByTestId("usage-records").getByTestId("usage-record")).toHaveCount(1);
  await expect(page.getByTestId("usage-records").getByTestId("usage-record").first()).toHaveAttribute("data-run-id", f.run.r2);
  const scoped = csvRows(await download(page, page.getByTestId("usage-export-runs-csv")));
  expect(scoped.rows.map(row => row.runId)).toContain(f.run.r2);
  expect(scoped.rows.map(row => row.runId)).not.toContain(f.run.r1);
  const exportedFilter = JSON.parse(scoped.preamble.split(" filter=")[1]!.split(" includedRuns=")[0]!);
  expect(exportedFilter.projectPath).toBe(f.two);
  const api = await call("GET", `/api/usage-analytics/records?projectPath=${encodeURIComponent(f.two)}&from=${exportedFilter.from}&until=${exportedFilter.until}`);
  expect(api.records.map((record: any) => record.runId).sort()).toEqual(scoped.rows.map(row => row.runId).sort());
  await page.screenshot({ path: info.outputPath("analytics-trace-scope.png") });

  // 8. Viewing, drilling down and exporting changed nothing, wrote nothing, and made no write request. (That no CLI is spawned is asserted in the service suite with a spawn spy; this backend's own background status poll would make a stub-call count meaningless here.)
  expect(stored(backend.dataDir)).toEqual(before);
  expect(sent.slice(mark)).toEqual([]);

  // 9. A later task move and account rename do not rewrite recorded attribution.
  await call("PATCH", `/tasks/${f.t.t1}`, { workdir: f.two });
  await call("PATCH", `/account-core/accounts/${f.a1.id}`, { displayName: "Renamed account one" });
  const after = await call("GET", "/api/usage-analytics/records");
  const moved = after.records.find((record: any) => record.runId === f.run.r1);
  expect(moved).toMatchObject({ projectPath: f.one, projectLabel: "Trace one", accountId: f.a1.id, accountLabel: "Renamed account one" });
  const inTwo = await call("GET", `/api/usage-analytics/records?projectPath=${encodeURIComponent(f.two)}`);
  expect(inTwo.records.map((record: any) => record.runId)).not.toContain(f.run.r1);
  const byAccount = await call("GET", `/api/usage-analytics/records?accountId=${f.a1.id}`);
  expect(byAccount.records.map((record: any) => record.runId)).toContain(f.run.r1);
  expect(after.reconciliation.matchesSummary).toBe(true);
});

test("the records and amounts read in Russian at a compact width", async ({ page, request, freshBackend: backend }, info) => {
  downloadsDir = backend.downloadsDir;
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const call: Call = async (method, route, data) => {
    const response = await request.fetch(backend.apiBase + route, { method, headers, data });
    expect(response.ok(), `${method} ${route}: ${await response.text()}`).toBe(true);
    return response.status() === 204 ? null : await response.json();
  };
  await call("PUT", "/preferences/locale", { value: "ru" });
  const f = await seed(call, backend.dataDir);
  await page.setViewportSize({ width: 900, height: 844 });
  await gotoApp(page, backend.bootBase);
  await openProjectAnalytics(page, f.two);
  await page.getByTestId("usage-range-last7").click();
  await page.getByTestId("usage-view-costs").click();
  const results = page.getByTestId("usage-analytics-results");
  await expect(page.getByTestId("project-analytics-scope")).toContainText("Trace two");
  await results.locator('[data-testid="usage-amount"][data-bucket="calculated-api/EUR"]').first().click();
  const panel = page.getByTestId("usage-records");
  await expect(panel).toContainText("Записи, из которых складывается сумма");
  await expect(panel.getByTestId("usage-records-reconciles")).toContainText("в сумме дают показанную выше сумму");
  await expect(panel.getByTestId("usage-record")).toHaveCount(1);
  await expect(panel.getByTestId("usage-record-project").first()).toContainText("Trace");
  await openProjectAnalytics(page, f.one);
  await page.getByTestId("usage-range-last7").click();
  await page.getByTestId("usage-view-costs").click();
  const one = page.getByTestId("usage-analytics-results");
  await one.locator('[data-testid="usage-amount"][data-bucket="excluded"]').first().click();
  await expect(page.getByTestId("usage-records").locator(`[data-run-id="${f.run.r6}"]`).getByTestId("usage-record-evidence")).toContainText("Исключён: синтетические данные");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  for (const section of [page.getByTestId("usage-records"), one]) {
    expect(await section.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
  }
  await panel.screenshot({ path: info.outputPath("analytics-trace-compact-ru.png") });
});
