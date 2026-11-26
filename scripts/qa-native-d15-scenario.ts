/**
 * Direction 15 (Financial and resource analytics), packaged ForgeOrbitQA window. Fake drivers, disposable profile, recorded
 * fixture rows only: no provider, no login, no billing or quota source, no model call. The runs are hand-written rows shaped
 * like recorded runs; they prove arithmetic and wording, not billing.
 *
 * Fixture A (2,009 run records in "Last 7 days", oldest -> newest, one price revision effective before every run):
 *   idx 0,1       provider-reported USD 0.80 each (a recorded billing receipt written by hand)       -> hidden by the 2,000 cap
 *   idx 2..5      calculated API EUR 0.57 each (4 runs)                                                -> hidden
 *   idx 6..8      calculated API USD 0.57 each                                                         -> hidden
 *   idx 9..2005   calculated API USD 0.57 each (1,997 runs)
 *   idx 2006      genuine run with no usage (Unknown cost)
 *   idx 2007      synthetic run (excluded)
 *   idx 2008      provider-reported USD 0.80
 * Whole scope: calculated USD 2,000 x 0.57 = $1,140.00; calculated EUR 4 x 0.57 = EUR 2.28; provider-reported USD 3 x 0.80 = $2.40;
 * Unknown 1; excluded 1; counted 2,008 of which 2,007 carry an amount. Listed (newest 2,000 of 2,009): the reported bucket lists 1 of 3 rows.
 * Fixture B adds 501 tasks of one USD 0.57 run each, 3 days back and less recently updated than A's tasks: the filter reaches
 * 504 tasks, 500 are read (A's 3 and the 497 most recently updated), so calculated USD becomes 1,140.00 + 497 x 0.57 = $1,423.29.
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { seedTracePricing, seedTraceRun, TRACE_RECEIPT, type TraceContext } from "./qa-analytics-trace-fixture.ts";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, ownerPaths, stamp } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "Overview and Costs coverage lines, amounts, the records panel with the cap explanation and the listed-versus-whole line, the task-scope floor note, the saved run export",
    "PN records read from the packaged core (files and API of the same isolated profile)": "exported run CSV rows and preamble, table counters before and after reading",
    "Backend only (QA isolation)": "full-scope buckets under the cap, period boundaries, export parity, no-write: src/bun/usage-analytics/analytics-limits.suite.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const Work = join(runtime, "projects/D15");
  const dbPath = join(runtime, "data/agetor.sqlite");
  const openDb = (readonly = false) => { const d = new Database(dbPath, readonly ? { readonly: true } : undefined); d.run("PRAGMA busy_timeout = 5000"); return d; };
  const DAY = 86_400_000;

  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  mkdirSync(Work, { recursive: true });
  writeFileSync(join(Work, "package.json"), "{}");
  await api("POST", "/projects", { path: Work, name: "D15 Work" });
  const usd = await api("POST", "/account-core/accounts", { provider: "openai", displayName: "D15 USD account" });
  const eur = await api("POST", "/account-core/accounts", { provider: "openai", displayName: "D15 EUR account" });
  const sub = await api("POST", "/account-core/accounts", { provider: "openai", displayName: "D15 subscription account" });
  const make = async (title: string) => (await api("POST", "/tasks", { title, prompt: "Add an example.", workdir: Work, agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none", column: "review" })).id as string;
  const tasks = [await make("D15 task one"), await make("D15 task two"), await make("D15 task three")];
  await down();

  const db = openDb();
  const now = Date.now();
  const scope = JSON.stringify({ projectPath: Work, clusterId: null, missionId: null, category: "task", technology: "unknown", complexity: "low" });
  const ctx: TraceContext = {
    db, projectOne: Work, projectTwo: Work, a1: { id: usd.id }, a2: { id: eur.id }, a3: { id: sub.id }, now,
    insertRun: (row) => db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,usage_scope) VALUES (?,?,?,'succeeded',?,?,0,?,?)`,
      [row.id, row.taskId, row.agent, row.startedAt, row.endedAt, row.id, scope]),
  };
  seedTracePricing(ctx);
  db.run("UPDATE usage_pricing SET created_at = ?", [now - 6 * DAY]); // effective before every run below
  const total = 2009;
  const start = now - 20 * 3_600_000;
  db.transaction(() => {
    for (let idx = 0; idx < total; idx++) {
      const taskId = tasks[idx % 3]!;
      const at = start + idx * 30_000 - now;
      if (idx <= 1 || idx === 2008) seedTraceRun(ctx, { taskId, account: ctx.a1, startOffsetMs: at, billed: TRACE_RECEIPT });
      else if (idx <= 5) seedTraceRun(ctx, { taskId, account: ctx.a2, startOffsetMs: at });
      else if (idx === 2006) seedTraceRun(ctx, { taskId, account: ctx.a1, startOffsetMs: at, usage: false });
      else if (idx === 2007) seedTraceRun(ctx, { taskId, account: ctx.a1, startOffsetMs: at, execution: "synthetic" });
      else seedTraceRun(ctx, { taskId, account: ctx.a1, startOffsetMs: at });
    }
  })();
  db.close();
  await up();
  await show("Main navigation");
  mark("Seeded 2,009 recorded run records (hand-written, shaped like genuine run records) over three tasks and three accounts, one price revision effective 6 days before the first run");

  const TABLES = ["runs", "run_events", "tasks", "usage_task_estimates", "usage_pricing", "usage_cost_adjustments", "quota_observations", "resource_accounts", "usage_group_forecasts", "allocation_plans"];
  const counters = () => { const r = openDb(true); try { return Object.fromEntries(TABLES.map((t) => [t, (r.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n])); } finally { r.close(); } };
  const before = counters();
  const textNear = (part: string) => find(hasText(part)).map((n: any) => [n.AXValue, n.AXTitle, n.AXDescription].find((x: any) => typeof x === "string" && x)).filter(Boolean);
  const downloads = join(runtime, "home/Downloads");
  const newestExport = (since: number) => {
    const files = existsSync(downloads) ? readdirSync(downloads).filter((f) => f.endsWith(".csv") && f.includes("runs")) : [];
    const fresh = files.map((f) => ({ f, t: Bun.file(join(downloads, f)).lastModified })).filter((x) => x.t >= since).sort((a, b) => b.t - a.t)[0];
    return fresh ? join(downloads, fresh.f) : null;
  };

  // ---- 1. Overview: a partial sum never reads as a full bill ----
  await button("Analytics", true, 0); await sleep(1200);
  await button("Usage", true, 0).catch(() => undefined); await sleep(1000);
  await button("Last 7 days", true); await sleep(2500);
  await show("These amounts cover 2007 of 2008 counted runs", 40_000);
  assert(has("1 have Unknown cost, 0 are subscription-covered, and 1 runs are excluded"), "coverage names Unknown, subscription and excluded runs");
  assert(!has("Showing a bounded selection"), "the old generic truncation text is gone");
  assert(!has("more than 500 tasks"), "no scope warning when 2,009 records come from only 3 tasks");
  shot("01-overview-coverage");
  evidence.overview = textNear("These amounts cover");
  mark("Overview: the coverage line sits beside the cost figure: 'These amounts cover 2007 of 2008 counted runs. 1 have Unknown cost, 0 subscription-covered, 1 excluded'");

  // ---- 2. Costs: amounts per category and currency, never added ----
  await button("Costs", true); await sleep(1500);
  await show("Calculated API cost $1,140.00", 30_000);
  assert(has("Calculated API cost €2.28"), "EUR kept apart from USD");
  assert(has("Provider-reported API charge $2.40"), "billed receipts kept apart from calculated cost");
  assert(!has("$1,142.28") && !has("1,142.28"), "no cross-currency sum");
  shot("02-costs-amounts");
  evidence.costs = textNear("Calculated API cost");
  mark("Costs: calculated API $1,140.00 (2,000 runs), calculated API €2.28 (4 runs), provider-reported $2.40 (3 runs), kept in separate buckets with the Unknown run and the excluded run counted, never merged");

  // ---- 3. Records behind the reported amount: the cap is explained, listed rows are a subset ----
  await button("Provider-reported API charge $2.40", false, 0); await sleep(2500);
  await show("Records behind this amount", 30_000);
  await show("Listing the 2000 most recent of 2009 records", 30_000);
  assert(has("The totals above cover all 2009"), "the screen says its totals cover every record");
  assert(has("The run export holds all 2009"), "the screen says the export holds all records");
  assert(has("The listed rows add up to $0.80, a part of the $2.40 shown above."), "listed subset is separated from the whole");
  assert(!has("add up to the amount shown above"), "no claim that the listed rows add up to the whole while the list is capped");
  assert(has("2008 runs count toward totals"), "coverage line describes the whole scope, not the listed slice");
  shot("03-records-capped");
  evidence.records = textNear("Listing the");
  mark("Records panel for the reported amount: 'Listing the 2000 most recent of 2009 records … totals above cover all 2009 … run export holds all 2009'; the one listed row adds up to $0.80 of the $2.40 shown above; coverage still counts 2008 runs over the whole scope");
  await button("Close", true).catch(() => undefined); await sleep(800);

  // ---- 4. The saved run export holds every record ----
  const t0 = Date.now() - 1000;
  await button("Export runs (CSV)", true); await sleep(6000);
  const csvPath = newestExport(t0);
  assert(csvPath, "the run export was saved to the profile's Downloads");
  const lines = readFileSync(csvPath!, "utf8").split("\n").filter(Boolean);
  assert(lines[0]!.includes("recordsQualifying=2009") && lines[0]!.includes("recordsExported=2009") && lines[0]!.includes("recordsTruncated=false"), lines[0]);
  assert.equal(lines.length - 2, 2009, "the file holds every record, not the 2,000 listed on screen");
  const header = lines[1]!.split(",");
  const col = (name: string) => header.indexOf(name);
  const sums = new Map<string, number>();
  let excluded = 0;
  for (const line of lines.slice(2)) {
    const cells = line.split(",");
    if (cells[col("counting")] === "excluded") { excluded++; continue; }
    if (/^\d/.test(cells[col("amount")]!)) sums.set(`${cells[col("costKind")]}/${cells[col("currency")]}`, (sums.get(`${cells[col("costKind")]}/${cells[col("currency")]}`) ?? 0) + Number(cells[col("amount")]));
  }
  assert.equal(excluded, 1);
  assert(Math.abs(sums.get("calculated-api/USD")! - 1140) < 1e-6, `calculated USD ${sums.get("calculated-api/USD")}`);
  assert(Math.abs(sums.get("calculated-api/EUR")! - 2.28) < 1e-6);
  assert(Math.abs(sums.get("reported-api/USD")! - 2.4) < 1e-6);
  evidence.exportA = { file: csvPath, rows: lines.length - 2, preamble: lines[0], sums: Object.fromEntries(sums) };
  shot("04-after-export");
  mark("Run export (CSV, saved by the packaged app): 2,009 data rows although the screen lists 2,000; its preamble states recordsQualifying=2009, recordsExported=2009, recordsTruncated=false; per category and currency the file adds up to $1,140.00 / €2.28 / $2.40, one excluded row");

  const afterA = counters();
  assert.deepEqual(afterA, before, "viewing, drilling down and exporting wrote no application record");
  evidence.readOnlyA = { before, after: afterA };

  // ---- 5. The task scope limit is a labelled floor ----
  ax("key", "53", "0"); await sleep(600);
  await down();
  const db2 = openDb();
  db2.transaction(() => {
    for (let idx = 0; idx < 501; idx++) {
      const id = crypto.randomUUID();
      db2.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at) VALUES (?,?,?,'review','codex',?,'gpt-6.1-sol','auto',?,?)`,
        [id, `D15 scope ${idx}`, "Add an example.", Work, now - 7 * DAY, now - 2 * DAY - idx * 1000]);
      seedTraceRun({ ...ctx, db: db2, insertRun: (row: any) => db2.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,usage_scope) VALUES (?,?,?,'succeeded',?,?,0,?,?)`,
        [row.id, row.taskId, row.agent, row.startedAt, row.endedAt, row.id, scope]) } as TraceContext,
      { taskId: id, account: ctx.a1, startOffsetMs: -3 * DAY + idx * 1000 - 0 });
    }
  })();
  db2.close();
  await up();
  await show("Main navigation");
  const beforeB = counters();
  await button("Analytics", true, 0); await sleep(1200);
  await button("Usage", true, 0).catch(() => undefined); await sleep(1000);
  await button("Last 7 days", true); await sleep(3000);
  await button("Costs", true); await sleep(1500);
  await show("This filter reached more than 500 tasks", 40_000);
  assert(has("Only the 500 most recently updated were read"), "the scope warning names the limit and what was read");
  await show("Calculated API cost $1,423.29", 20_000);
  assert(has("These amounts cover 2504 of 2505 counted runs"), "the totals cover the 500 tasks read, with the same coverage wording");
  assert(has("Showing 100 of the 500 most recently updated tasks read"), "the task list says it is a floor, not the number that qualify");
  shot("05-scope-floor");
  evidence.scope = textNear("500");
  mark("A scope reaching more than 500 tasks: warning 'This filter reached more than 500 tasks. Only the 500 most recently updated were read…'; calculated API $1,140.00 + 497 × 0.57 = $1,423.29; coverage 2,504 of 2,505 counted runs; the task list says 'Showing 100 of the 500 most recently updated tasks read (the filter reached more)'");
  const t1 = Date.now() - 1000;
  await button("Export runs (CSV)", true); await sleep(9000);
  const csvB = newestExport(t1);
  assert(csvB, "second export saved");
  const linesB = readFileSync(csvB!, "utf8").split("\n").filter(Boolean);
  assert(linesB[0]!.includes("recordsQualifying=2506") && linesB[0]!.includes("recordsExported=2506"), linesB[0]);
  assert(linesB[0]!.includes("tasksInScope=500+ scopeTruncated=true taskScopeLimit=500"), linesB[0]);
  assert.equal(linesB.length - 2, 2506);
  evidence.exportB = { file: csvB, rows: linesB.length - 2, preamble: linesB[0] };
  mark("Run export under the task floor: 2,506 data rows, preamble states recordsExported=2506 and tasksInScope=500+ scopeTruncated=true taskScopeLimit=500");
  const afterB = counters();
  assert.deepEqual(afterB, beforeB, "viewing and exporting under the floor wrote no application record");
  evidence.readOnlyB = { before: beforeB, after: afterB };

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
  const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
  const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
  const unexplained = changed.filter((p) => !tolerated.includes(p));
  evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
  assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = unexplained.length === 0 && tolerated.length === 0;
  save();
}
