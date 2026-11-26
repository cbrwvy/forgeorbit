import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_USAGE_STATUS_PREFIX } from "../../shared/usage-analytics.ts";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-forecast-actual-")));
const localHome = join(root, "home");
mkdirSync(localHome);
process.env.HOME = localHome;
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_DISABLE_UPDATES = "1";

const { db, projects, runs, tasks } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { taskActuals, summarizeRuns } = await import("./actuals.ts");
const { taskBreakdown, analytics } = await import("./analytics.ts");
const { buildForecastComparison } = await import("./comparison.ts");
const { renderAnalyticsExport } = await import("./export.ts");
const { forecast, ensureBaselineEstimate, frozenEstimate } = await import("./forecast.ts");

const core = new AccountCore(db);
const profiles = new CodexProfiles(core);
const projectA = join(root, "alpha");
const projectB = join(root, "beta");
for (const dir of [projectA, projectB]) { mkdirSync(dir); writeFileSync(join(dir, "package.json"), "{}"); }
projects.upsert(projectA, "Alpha");
projects.upsert(projectB, "Beta");
const model = "gpt-6.1-sol";
const directory = join(localHome, "Account A");
writeSyntheticCodexProfile(directory, "synthetic-account-a");
const a = profiles.register({ displayName: "Account A", directory });
const createdAt = Date.now() - 3_600_000;

function task(title: string, workdir = projectA, prompt = "Add an example. Acceptance: add tests.") {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'backlog',?,?,?,'auto',?,?)`, [id, title, prompt, a.harnessId, workdir, model, createdAt, createdAt]);
  return id;
}

function record(taskId: string, start: number, end: number | null, options: {
  qc?: string; execution?: "real-provider" | "synthetic"; tokens?: boolean; status?: "succeeded" | "failed" | "orphaned";
} = {}) {
  const id = crypto.randomUUID();
  runs.insert({
    id, taskId, agent: a.harnessId, status: options.status ?? "succeeded", startedAt: start, endedAt: end, exitCode: 0,
    qcReviewId: options.qc, tmuxSession: null, claudeSessionId: null, codexSessionId: id,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const project = db.query<{ workdir: string }, [string]>("SELECT workdir FROM tasks WHERE id = ?").get(taskId)!.workdir;
  db.run("UPDATE runs SET usage_scope = ? WHERE id = ? AND usage_scope IS NULL", [
    JSON.stringify({ projectPath: project, clusterId: null, missionId: null, category: "task" }), id]);
  const event = (payload: string) => db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [id, payload, end ?? start]);
  event(JSON.stringify({ kind: "execution-identity", executionType: options.execution ?? "real-provider",
    provider: "codex", model, mode: "auto", accountProfile: { id: a.accountId } }));
  if (options.tokens) event(RUN_USAGE_STATUS_PREFIX + JSON.stringify({ input: 100_000, output: 50_000, cacheRead: 0, cacheWrite: 0 }));
  return id;
}

const complete = (id: string, at: number) => {
  tasks.update(id, { column: "done" });
  db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [at, id]);
};
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("the baseline is the estimate frozen to the first Developer run and later edits never replace it", () => {
  const id = task("Frozen baseline");
  const base = Date.now() - 50_000;
  const baselineId = ensureBaselineEstimate(id, base - 5000);
  expect(baselineId).not.toBeNull();
  const dev = record(id, base, base + 10_000);
  const qid = crypto.randomUUID();
  const reviewer = record(id, base + 12_000, base + 20_000, { qc: qid });
  db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,
    implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
    VALUES (?,?,?,1,'completed','PASS',?,?,?,?,'{}',?,?,?)`, [qid, id, projectA, a.harnessId, model, dev, reviewer, base + 12_000, base + 12_000, base + 20_000]);
  complete(id, base + 25_000);
  const before = taskBreakdown(id)!.comparison;
  expect(before.state).toBe("complete");
  expect(before.baseline).toMatchObject({ estimateId: baselineId, boundRunId: dev });
  expect(before.baseline!.savedAt!).toBeLessThanOrEqual(before.baseline!.boundAt!);
  const frozen = JSON.stringify(frozenEstimate(baselineId));

  // The Owner edits the scope and saves a newer estimate after the run.
  tasks.update(id, { prompt: "Refactor authentication, concurrency and migrations. Add tests." });
  db.run(`UPDATE tasks SET "column" = 'backlog' WHERE id = ?`, [id]);
  const later = forecast({ taskIds: [id], save: true }).estimates[0]!.estimateId!;
  complete(id, base + 25_000);
  expect(later).toBeGreaterThan(baselineId!);
  const after = taskBreakdown(id)!.comparison;
  expect(after.baseline!.estimateId).toBe(baselineId!);
  expect(after.baseline!.laterRevisions.map(row => row.id)).toContain(later);
  expect(JSON.stringify(frozenEstimate(baselineId))).toBe(frozen);
  expect(after.rows.find(row => row.key === "developer")).toMatchObject({ planned: expect.any(Object) });
  // Developer and Reviewer stay attributable to their own run records.
  expect(after.attempts.map(item => [item.runId, item.role, item.attempt])).toEqual([[dev, "developer", 1], [reviewer, "reviewer", 1]]);
  expect(after.attempts[0]!.boundToBaseline).toBe(true);
  expect(after.attempts[1]!.boundToBaseline).toBe(false);
  const developerRow = after.rows.find(row => row.key === "developer")!;
  expect(developerRow).toMatchObject({ actual: 10_000 });
  expect(after.rows.find(row => row.key === "reviewer")).toMatchObject({ actual: 8000 });
});

test("a comparable task gets numeric differences and an unavailable one explains why", () => {
  const id = task("Delta rules");
  const base = Date.now() - 40_000;
  ensureBaselineEstimate(id, base - 5000);
  record(id, base, base + 10_000);
  complete(id, base + 12_000);
  const actual = taskActuals(id)!;
  const estimate = frozenEstimate(actual.frozenEstimateId)!;
  const usage = summarizeRuns(actual.runs);
  const input = { actual, estimate, forecastUsage: null, actualUsage: usage, sameResources: true, comparable: true,
    workMs: actual.workerMs! - estimate.worker.expected, completionDeltaMs: 0, costDelta: null, runCountDelta: 0 };
  const comparable = buildForecastComparison(input);
  const developer = comparable.rows.find(row => row.key === "developer") as { planned: { expected: number }; delta: number; reason: null };
  expect(developer.reason).toBeNull();
  expect(developer.delta).toBe(10_000 - developer.planned.expected);
  // A Reviewer phase that never ran is Unknown, not zero.
  const reviewer = comparable.rows.find(row => row.key === "reviewer") as { actual: number | null; delta: number | null; reason: string | null };
  expect(reviewer.actual).toBeNull();
  expect(reviewer.delta).toBeNull();
  // The same task on other resources or with synthetic runs reports no difference and says why.
  const other = buildForecastComparison({ ...input, sameResources: false, comparable: false });
  expect(other.rows.find(row => row.key === "developer")).toMatchObject({ delta: null, reason: "different-resources" });
  expect(other.rows.find(row => row.key === "worker")).toMatchObject({ delta: null, reason: "different-resources" });
});

test("a task started with no estimate has no baseline and none is invented afterwards", () => {
  const unstarted = task("Not started");
  expect(taskBreakdown(unstarted)!.comparison).toMatchObject({ state: "no-baseline", absence: "not-started", baseline: null });

  const older = task("Older task");
  const base = Date.now() - 30_000;
  record(older, base, base + 5000);
  complete(older, base + 6000);
  const comparison = taskBreakdown(older)!.comparison;
  expect(comparison).toMatchObject({ state: "no-baseline", absence: "none-before-start", baseline: null });
  for (const row of comparison.rows) {
    if (row.kind === "actual-only") continue;
    expect(row).toMatchObject({ delta: null, reason: "no-baseline" });
  }
  expect(ensureBaselineEstimate(older)).toBeNull(); // a started task is never given a baseline

  // An estimate saved after work started is not a baseline either.
  db.run(`UPDATE tasks SET "column" = 'backlog' WHERE id = ?`, [older]);
  forecast({ taskIds: [older], save: true });
  complete(older, base + 6000);
  expect(taskBreakdown(older)!.comparison).toMatchObject({ state: "no-baseline", absence: "saved-after-start", baseline: null });
});

test("missing usage and cost stay Unknown and never become zero", () => {
  const id = task("Missing usage");
  const base = Date.now() - 20_000;
  ensureBaselineEstimate(id, base - 5000);
  record(id, base, base + 4000, { tokens: false });
  complete(id, base + 5000);
  const cost = taskBreakdown(id)!.comparison.rows.find(row => row.key === "cost") as {
    actual: { totals: unknown[]; unknownCostRuns: number; subscriptionRuns: number }; delta: unknown; reason: string | null };
  expect(cost.actual.totals).toEqual([]);
  expect(cost.delta).toBeNull();
  expect(cost.reason).not.toBeNull();
  expect(cost.actual.unknownCostRuns + cost.actual.subscriptionRuns).toBeGreaterThan(0);
});

test("a repeated and an interrupted attempt keep their own records and partial coverage", () => {
  const id = task("Interrupted and repeated");
  const base = Date.now() - 60_000;
  ensureBaselineEstimate(id, base - 5000);
  const first = record(id, base, null, { status: "orphaned" });
  const second = record(id, base + 10_000, base + 20_000);
  complete(id, base + 22_000);
  const comparison = taskBreakdown(id)!.comparison;
  expect(comparison.attempts.map(item => [item.runId, item.attempt, item.interrupted, item.durationMs])).toEqual([
    [first, 1, true, null], [second, 2, false, 10_000],
  ]);
  expect(comparison.runCounts).toMatchObject({ total: 2, interrupted: 1 });
  const developer = comparison.rows.find(row => row.key === "developer") as { coverage: { known: number; missing: number }; delta: unknown; reason: string | null };
  expect(developer.coverage).toEqual({ known: 1, missing: 1 });
  expect(developer.delta).toBeNull();
  expect(developer.reason).not.toBeNull();
  expect(comparison.baseline?.boundRunId).toBe(first);
});

test("tasks and projects are isolated and the export carries the baseline with Unknown semantics", () => {
  const one = task("Alpha task", projectA);
  const two = task("Beta task", projectB);
  const noBaseline = task("Beta older", projectB);
  const base = Date.now() - 15_000;
  const baselineOne = ensureBaselineEstimate(one, base - 5000);
  const baselineTwo = ensureBaselineEstimate(two, base - 5000);
  const runOne = record(one, base, base + 3000);
  const runTwo = record(two, base, base + 4000);
  record(noBaseline, base, base + 2000);
  for (const id of [one, two, noBaseline]) complete(id, base + 5000);
  expect(baselineOne).not.toBe(baselineTwo);
  const a1 = taskBreakdown(one)!.comparison;
  const a2 = taskBreakdown(two)!.comparison;
  expect(a1.attempts.map(item => item.runId)).toEqual([runOne]);
  expect(a2.attempts.map(item => item.runId)).toEqual([runTwo]);
  expect(a1.baseline!.estimateId).toBe(baselineOne!);
  expect(a2.baseline!.estimateId).toBe(baselineTwo!);

  const beta = analytics({ projectPath: projectB, from: base - 1, until: base + 10_000 });
  const rows = new Map(beta.tasks.map(row => [row.id, row.baselineEstimateId]));
  expect(rows.has(one)).toBe(false);
  expect(rows.get(two)).toBe(baselineTwo!);
  expect(rows.get(noBaseline)).toBeNull();
  const csv = renderAnalyticsExport(beta, "tasks", "csv", { timeZone: "UTC", grain: "day" }).body.split("\n");
  const header = csv[1]!.split(",");
  const column = header.indexOf("baselineEstimateId");
  expect(column).toBeGreaterThan(-1);
  expect(csv.find(line => line.includes("Beta older"))!.split(",")[column]).toBe("Unknown");
  expect(csv.find(line => line.includes("Beta task"))!.split(",")[column]).toBe(String(baselineTwo));
  const json = JSON.parse(renderAnalyticsExport(beta, "tasks", "json", { timeZone: "UTC", grain: "day" }).body);
  expect(json.coverage.baselinePolicy).toContain("Unknown");
  expect(json.tasks.find((row: { id: string }) => row.id === noBaseline).baselineEstimateId).toBeNull();
});

test("a supervised Start freezes an estimate for an unstarted Ready task, never for a started or finished one", () => {
  const ready = task("Ready at Start");
  db.run(`UPDATE tasks SET "column" = 'ready' WHERE id = ?`, [ready]);
  const first = ensureBaselineEstimate(ready, Date.now() - 20_000);
  expect(first).not.toBeNull();
  // Unchanged inputs keep the same revision.
  expect(ensureBaselineEstimate(ready, Date.now() - 19_000)).toBe(first);
  const base = Date.now() - 10_000;
  const run = record(ready, base, base + 2000);
  expect(taskActuals(ready)!.frozenEstimateId).toBe(first);
  expect(ensureBaselineEstimate(ready)).toBeNull();
  complete(ready, base + 3000);
  expect(taskBreakdown(ready)!.comparison.baseline).toMatchObject({ estimateId: first, boundRunId: run });
  const finished = task("Finished before");
  complete(finished, Date.now() - 5000);
  expect(ensureBaselineEstimate(finished)).toBeNull();
});
