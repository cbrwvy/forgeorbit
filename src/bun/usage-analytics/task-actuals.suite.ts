import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_USAGE_STATUS_PREFIX } from "../../shared/usage-analytics.ts";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";

/**
 * FO-DIRECTION14. Task actuals reconciliation on one deterministic timeline, with exact figures. Every figure below is derived by
 * hand from the fixture, not from the code under test. The runs are recorded fixture rows, not provider telemetry.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-direction14-")));
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
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { taskActuals, summarizeRuns } = await import("./actuals.ts");
const { taskBreakdown, analytics } = await import("./analytics.ts");
const { usageAnalyticsHttp } = await import("./http.ts");
const { forecast, ensureBaselineEstimate } = await import("./forecast.ts");

const core = new AccountCore(db);
const profiles = new CodexProfiles(core);
const project = join(root, "alpha");
mkdirSync(project);
writeFileSync(join(project, "package.json"), "{}");
projects.upsert(project, "Alpha");
const directory = join(localHome, "Account A");
writeSyntheticCodexProfile(directory, "synthetic-account-a");
const a = profiles.register({ displayName: "Account A", directory });
const model = "gpt-6.1-sol";
const people = new EmployeeCore(db);
const ada = people.createWorker({ name: "Ada", jobTitle: "Developer", projectPath: project });
const grace = people.createWorker({ name: "Grace", jobTitle: "Reviewer", projectPath: project });
const linus = people.createWorker({ name: "Linus", jobTitle: "Developer", projectPath: project });
const S = 1000;
const T0 = Date.now() - 600 * S;

function task(title: string, createdAt = T0 - 70 * S) {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'backlog',?,?,?,'auto',?,?)`, [id, title, "Add an example. Acceptance: add tests.", a.harnessId, project, model, createdAt, createdAt]);
  return id;
}

type RunOptions = { qc?: string; status?: "succeeded" | "failed" | "orphaned" | "cancelled" | "running"; worker?: { id: string; name: string } | null;
  execution?: "real-provider" | "synthetic"; tokens?: boolean; endless?: boolean; };
/** A run at [from, to] seconds after T0. */
function run(taskId: string, from: number, to: number | null, options: RunOptions = {}) {
  const id = crypto.randomUUID();
  runs.insert({
    id, taskId, agent: a.harnessId, status: options.status ?? "succeeded", startedAt: T0 + from * S, endedAt: to === null ? null : T0 + to * S, exitCode: 0,
    qcReviewId: options.qc, tmuxSession: null, claudeSessionId: null, codexSessionId: id,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const event = (data: string) => db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [id, data, T0 + (to ?? from) * S]);
  event(JSON.stringify({ kind: "execution-identity", executionType: options.execution ?? "real-provider", provider: "codex", model, mode: "auto", accountProfile: { id: a.accountId } }));
  if (options.tokens) event(RUN_USAGE_STATUS_PREFIX + JSON.stringify({ input: 100_000, output: 50_000, cacheRead: 0, cacheWrite: 0 }));
  if (options.worker) {
    db.run(`INSERT INTO employee_executions(id,task_id,task_title,project_path,employee_id,employee_name,assignment_id,assignment_revision,status,
      requested_harness_id,requested_policy,requested_mode,inputs_key,task_fingerprint,config_json,review_json,run_id,actual_harness_id,actual_model,
      actual_account_id,actual_provenance,approval_provenance,created_at,updated_at,expires_at,approved_at,started_at)
      VALUES (?,?,?,?,?,?,?,1,'started',?,'p','auto','k','f','{}','{}',?,?,?,?,'runtime','owner',?,?,?,?,?)`,
      [crypto.randomUUID(), taskId, "t", project, options.worker.id, options.worker.name, crypto.randomUUID(), a.harnessId, id, a.harnessId, model, a.accountId,
        T0 + from * S, T0 + from * S, T0 + 9e6, T0 + from * S, T0 + from * S]);
  }
  return id;
}
function review(taskId: string, qc: string, round: number, verdict: string, from: number, to: number, implementationRun: string, reviewRun: string, reviewer: string | null) {
  db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,reviewer_employee_id,
    implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
    VALUES (?,?,?,?,'completed',?,?,?,?,?,?,'{}',?,?,?)`, [qc, taskId, project, round, verdict, a.harnessId, model, reviewer, implementationRun, reviewRun, T0 + from * S, T0 + from * S, T0 + to * S]);
}
const test_ = (taskId: string, status: "failed" | "passed", from: number, to: number | null) =>
  db.run(`INSERT INTO practical_test_attempts(id,task_id,project_path,workspace_path,rework_epoch,command,command_fingerprint,
    source_fingerprint,status,isolation,implementation_execution,started_at,finished_at)
    VALUES (?,?,?,?,0,'bun test','cmd','source',?,'offline','provider',?,?)`, [crypto.randomUUID(), taskId, project, project, status, T0 + from * S, to === null ? null : T0 + to * S]);
const transition = (taskId: string, destination: string, at: number) =>
  db.run("INSERT INTO usage_task_transitions(task_id,destination,at) VALUES (?,?,?)", [taskId, destination, T0 + at * S]);
const done = (taskId: string, at: number) => {
  tasks.update(taskId, { column: "done" });
  db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [T0 + at * S, taskId]);
};
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

// The reference timeline, in seconds after T0 (the task was created at -70, made Ready at -8, Done at +60):
//   Developer 1  [ 0,10]  cancelled by the Owner (Ada)
//   Developer 2  [12,30]  succeeded (Ada)
//   Reviewer 1   [28,40]  CHANGES_REQUESTED (Grace); overlaps Developer 2 by 2 s
//   Test         [30,33]  failed; sits wholly inside the Reviewer run
//   Developer 3  [42,50]  succeeded: the rework (Ada)
//   Reviewer 2   [51,55]  PASS (Grace)
let id = "";
let ids: Record<string, string> = {};
function reference() {
  id = task("Reference task");
  transition(id, "ready", -8);
  const d1 = run(id, 0, 10, { status: "cancelled", worker: ada, tokens: true });
  const d2 = run(id, 12, 30, { worker: ada, tokens: true });
  const q1 = crypto.randomUUID();
  const r1 = run(id, 28, 40, { qc: q1 });
  review(id, q1, 1, "CHANGES_REQUESTED", 28, 40, d2, r1, grace.id);
  test_(id, "failed", 30, 33);
  const d3 = run(id, 42, 50, { worker: ada, tokens: true });
  const q2 = crypto.randomUUID();
  const r2 = run(id, 51, 55, { qc: q2 });
  review(id, q2, 2, "PASS", 51, 55, d3, r2, grace.id);
  done(id, 60);
  ids = { d1, d2, r1, d3, r2 };
}
reference();
const read = () => ({ tables: ["runs", "run_events", "tasks", "usage_task_estimates", "employee_executions", "employee_task_assignments", "task_quality_reviews",
  "practical_test_attempts", "usage_task_transitions", "run_terminations"].map(table => [table, db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]),
  rows: db.query(`SELECT id, status, started_at, ended_at, usage_estimate_id FROM runs ORDER BY id`).all() });

test("cumulative agent time, the union of active intervals and overall elapsed time are three different, exact figures", () => {
  const actual = taskActuals(id)!;
  expect(actual.runs.map(r => [r.role, r.status, r.durationMs])).toEqual([
    ["developer", "cancelled", 10 * S], ["developer", "succeeded", 18 * S], ["reviewer", "succeeded", 12 * S],
    ["developer", "succeeded", 8 * S], ["reviewer", "succeeded", 4 * S],
  ]);
  expect(actual.workerMs).toBe(52 * S);          // 10 + 18 + 12 + 8 + 4: summed, so the 2 s overlap counts twice
  expect(actual.activeWallMs).toBe(50 * S);      // union [0,10] [12,40] [42,50] [51,55] = 10 + 28 + 8 + 4
  expect(actual.executionElapsedMs).toBe(60 * S); // first run to Done
  expect(actual.totalElapsedMs).toBe(130 * S);   // created (-70) to Done (+60)
  expect(new Set([actual.workerMs, actual.activeWallMs, actual.executionElapsedMs, actual.totalElapsedMs]).size).toBe(4);
  expect(actual.lifecycle).toMatchObject({ developerMs: 36 * S, reviewerMs: 16 * S, attempts: 5, completedRuns: 4, interruptions: 1, failures: 0, qcRounds: 2 });
  expect(actual.lifecycle.developerCoverage).toEqual({ ms: 36 * S, known: 3, missing: 0 });
  expect(actual.lifecycle.reviewerCoverage).toEqual({ ms: 16 * S, known: 2, missing: 0 });
  expect(actual.queueMs).toBe(8 * S);
});

test("observed tests, QC and rework are separate measures and a test inside a run is not counted twice", () => {
  const actual = taskActuals(id)!;
  expect(actual.testMs).toBe(3 * S);
  expect(actual.qcMs).toBe(16 * S);              // [28,40] review and its run are one interval, plus [51,55]
  expect(actual).toMatchObject({ reworks: 1, reworkMs: 8 * S, interrupted: 1, failed: 0 });
  expect(actual.firstVerdict).toBe("CHANGES_REQUESTED");
  // The partition of the observed span is exclusive: a test wholly inside a run adds no time of its own.
  const wait = actual.waiting;
  expect(wait.measured).toEqual({ "project-queue": 8 * S });
  expect(wait.runtimeInternalUnknownMs).toBe(50 * S); // time spent inside runs: not measurable as waiting, and not shown as zero
  expect(wait.testMs).toBeNull();                      // no test-only time: Unknown, never a made-up zero
  expect(wait.unknownMs).toBe(10 * S);                 // the gaps between attempts and after the last one: unclassified, not a wait
  expect(wait.measuredMs + wait.runtimeInternalUnknownMs! + wait.unknownMs!).toBe(wait.coverageMs!); // nothing counted twice or lost
  expect(wait.coverageMs).toBe(68 * S);
  expect(actual.humanMs).toBeNull();
  expect(wait.providerReportedMs).toBeNull();
});

test("a test that overlaps a run only in part is attributed once", () => {
  const other = task("Partial overlap");
  run(other, 0, 10);
  test_(other, "passed", 8, 14); // 2 s inside the run, 4 s after it
  done(other, 20);
  const actual = taskActuals(other)!;
  expect(actual.testMs).toBe(6 * S);                    // the observed test interval, whole
  expect(actual.waiting.testMs).toBe(4 * S);            // only the part no run already accounts for
  expect(actual.waiting.runtimeInternalUnknownMs).toBe(10 * S);
  expect(actual.waiting.measuredMs + actual.waiting.runtimeInternalUnknownMs! + actual.waiting.testMs! + actual.waiting.unknownMs!).toBe(actual.waiting.coverageMs!);
});

test("incomplete timing stays Unknown and is never summed as zero", () => {
  const partial = task("Missing end");
  run(partial, 0, 10);
  run(partial, 12, null, { status: "orphaned" });      // never recorded an end
  done(partial, 40);
  const actual = taskActuals(partial)!;
  expect(actual.runs.map(r => r.durationMs)).toEqual([10 * S, null]);
  expect(actual.workerMs).toBe(10 * S);                  // only what was recorded
  expect(actual.lifecycle.developerCoverage).toEqual({ ms: 10 * S, known: 1, missing: 1 }); // and the shortfall is carried, not hidden
  expect(actual.activeWallMs).toBe(10 * S);

  const none = task("No durations at all");
  run(none, 0, null, { status: "orphaned" });
  done(none, 30);
  const empty = taskActuals(none)!;
  expect(empty.workerMs).toBeNull();                     // not 0
  expect(empty.activeWallMs).toBeNull();
  expect(empty.testMs).toBeNull();
  expect(empty.qcMs).toBeNull();
  expect(empty.lifecycle.developerCoverage).toEqual({ ms: null, known: 0, missing: 1 });

  const reversed = task("End before start");
  run(reversed, 10, 5);
  done(reversed, 30);
  expect(taskActuals(reversed)!.runs[0]!.durationMs).toBeNull();

  const openTest = task("Unfinished test");
  run(openTest, 0, 10);
  test_(openTest, "failed", 12, null);
  done(openTest, 30);
  expect(taskActuals(openTest)!.testMs).toBeNull();      // a test with no recorded end has no duration
});

test("a run that ended after Done is clipped to Done and a run started after Done is not counted", () => {
  const clipped = task("Clipped");
  run(clipped, 0, 30);
  run(clipped, 50, 60);
  done(clipped, 20);
  const actual = taskActuals(clipped)!;
  expect(actual.runs.map(r => r.durationMs)).toEqual([20 * S]);
  expect(actual.workerMs).toBe(20 * S);
});

test("an old task with no recorded Done keeps its time Unknown, and reading it later does not change the figures", () => {
  const old = task("Old finished task", T0 - 500 * S);
  run(old, -400, -380);
  tasks.update(old, { column: "done" });
  db.run("DELETE FROM usage_task_transitions WHERE task_id = ? AND destination = 'done'", [old]);
  const early = taskActuals(old, T0 + 100 * S)!;
  const late = taskActuals(old, T0 + 100_000 * S)!;
  expect(early.doneAt).toBeNull();
  expect(early.totalElapsedMs).toBeNull();
  expect(early.executionElapsedMs).toBeNull();
  expect(early.workerMs).toBe(20 * S);
  // The clock must not leak into a finished task: nothing about it may grow because time passed.
  expect(late.lifecycle.partialCreatedMs).toBeNull();
  expect(late.lifecycle.partialExecutionMs).toBeNull();
  expect(late.waiting.unknownMs).toBe(early.waiting.unknownMs);
  expect(late.waiting.coverageMs).toBe(early.waiting.coverageMs);
  expect(JSON.stringify({ ...late, waiting: undefined, lifecycle: undefined })).toBe(JSON.stringify({ ...early, waiting: undefined, lifecycle: undefined }));
  // A task that is still open does report time so far.
  const open = task("Still open");
  run(open, -30, -10);
  const openLate = taskActuals(open, T0 + 100 * S)!;
  expect(openLate.lifecycle.partialCreatedMs).toBe(T0 + 100 * S - (T0 - 70 * S));
});

test("each attempt keeps its recorded role, run, status, project, worker and resource; reassignment and renames never rewrite it", () => {
  const before = taskBreakdown(id)!.comparison.attempts;
  const keyed = (attempts: typeof before) => attempts.map(item => [item.runId, item.role, item.attempt, item.status, item.accountId, item.model]);
  expect(keyed(before) as unknown[]).toEqual([
    [ids.d1, "developer", 1, "cancelled", a.accountId, model], [ids.d2, "developer", 2, "succeeded", a.accountId, model],
    [ids.r1, "reviewer", 1, "succeeded", a.accountId, model], [ids.d3, "developer", 3, "succeeded", a.accountId, model], [ids.r2, "reviewer", 2, "succeeded", a.accountId, model],
  ]);
  const who = (attempts: typeof before) => attempts.map(item => [item.runId, item.workerId, item.workerName, item.projectPath, item.harnessId, item.mode]);
  expect(who(before) as unknown[]).toEqual([
    [ids.d1, ada.id, "Ada", project, a.harnessId, "auto"], [ids.d2, ada.id, "Ada", project, a.harnessId, "auto"],
    [ids.r1, grace.id, "Grace", project, a.harnessId, "auto"], [ids.d3, ada.id, "Ada", project, a.harnessId, "auto"], [ids.r2, grace.id, "Grace", project, a.harnessId, "auto"],
  ]);
  // The Owner assigns the task to someone else, renames the worker and renames the account profile.
  const assignments = new AssignmentCore(db);
  assignments.assign(id, linus.id);
  db.run("UPDATE ai_employees SET name = 'Ada Lovelace' WHERE id = ?", [ada.id]);
  db.run("UPDATE resource_accounts SET data = json_set(data, '$.displayName', 'Renamed account') WHERE id = ?", [a.accountId]);
  const after = taskBreakdown(id)!.comparison.attempts;
  expect(keyed(after) as unknown[]).toEqual(keyed(before) as unknown[]);
  expect(after.map(item => item.workerId)).toEqual(before.map(item => item.workerId));
  expect(after.map(item => item.workerId)).not.toContain(linus.id);
  // The recorded name is what it was when the attempt ran; only the account label is a live, display-only label.
  expect(after.map(item => item.workerName)).toEqual(before.map(item => item.workerName));
  expect(after[0]!.accountLabel).toBe("Renamed account");
  expect(after[0]!.accountId).toBe(a.accountId);
  // A newer attempt is a new record and replaces nothing.
  const newer = run(id, 56, 58, { worker: linus });
  const withNewer = taskBreakdown(id)!.comparison.attempts;
  expect(withNewer.slice(0, 5).map(item => item.runId)).toEqual(before.map(item => item.runId));
  expect(withNewer.at(-1)).toMatchObject({ runId: newer, workerId: linus.id, attempt: 4, role: "developer" });
  db.run("DELETE FROM runs WHERE id = ?", [newer]);
});

test("a run started outside an employee execution has no worker, even while the task is assigned to someone", () => {
  const board = task("Board start");
  new AssignmentCore(db).assign(board, ada.id);
  const started = run(board, 0, 10);
  done(board, 20);
  const attempt = taskBreakdown(board)!.comparison.attempts.find(item => item.runId === started)!;
  expect(attempt.workerId).toBeNull();
  expect(attempt.workerName).toBeNull();
  expect(taskActuals(board)!.runs[0]!.specialist).toBeNull();
});

test("a Reviewer run is its own attempt and never Developer time", () => {
  const actual = taskActuals(id)!;
  expect(actual.runs.filter(r => r.role === "reviewer").map(r => r.qcId)).toHaveLength(2);
  expect(actual.lifecycle.developerMs! + actual.lifecycle.reviewerMs!).toBe(actual.workerMs!);
  const attempts = taskBreakdown(id)!.comparison.attempts;
  expect(attempts.filter(item => item.role === "reviewer").map(item => item.attempt)).toEqual([1, 2]);
  expect(attempts.filter(item => item.role === "developer").map(item => item.attempt)).toEqual([1, 2, 3]);
});

test("a stopped run shows how it ended, from the recorded stop, and is not counted as a success", () => {
  db.run("INSERT INTO run_terminations(run_id,reason,requested_at,attempts,outcome,methods,checked_at,exited_at) VALUES (?,?,?,?,?,?,?,?)",
    [ids.d1!, "manual", T0 + 10 * S, 1, "exited", "[]", T0 + 10 * S, T0 + 10 * S]);
  const stopped = taskBreakdown(id)!.comparison.attempts[0]!;
  expect(stopped).toMatchObject({ status: "cancelled", interrupted: true, stop: { reason: "manual", outcome: "exited" } });
  expect(taskBreakdown(id)!.comparison.attempts.slice(1).every(item => item.stop === null)).toBe(true);
  expect(taskActuals(id)!.lifecycle.completedRuns).toBe(4); // the stopped run is not among them
});

test("recorded fixture usage stays on the task and out of genuine totals", () => {
  const fixture = task("Fixture usage");
  run(fixture, 0, 10, { execution: "synthetic", tokens: true });
  done(fixture, 20);
  const actual = taskActuals(fixture)!;
  expect(actual.runs[0]!.execution).toBe("synthetic");
  expect(summarizeRuns(actual.runs).realRuns).toBe(0);
  expect(analytics({ taskIds: [fixture], from: T0 - 1000 * S, until: T0 + 1000 * S }).usage.realRuns).toBe(0);
});

test("reading the task history, the comparison and the Analytics detail writes nothing", async () => {
  const before = JSON.stringify(read());
  taskActuals(id); taskBreakdown(id);
  for (const url of [`/api/usage-analytics/task?taskId=${id}`, "/api/usage-analytics/analytics", `/api/usage-analytics/records`]) {
    const response = await usageAnalyticsHttp(new Request("http://localhost" + url), true);
    expect(response!.status).toBe(200);
    await response!.json();
  }
  expect(JSON.stringify(read())).toBe(before);
});

test("the comparison still uses the frozen first-run estimate and withholds differences for fixture runs", () => {
  const frozen = task("Frozen");
  const baseline = ensureBaselineEstimate(frozen, T0 - 5 * S)!;
  run(frozen, 0, 10, { execution: "synthetic" });
  done(frozen, 20);
  tasks.update(frozen, { column: "backlog" });
  forecast({ taskIds: [frozen], save: true });
  const comparison = taskBreakdown(frozen)!.comparison;
  expect(comparison.baseline?.estimateId).toBe(baseline);
  expect(comparison.rows.filter(row => row.kind !== "actual-only").every(row => (row as { delta: unknown }).delta === null)).toBe(true);
});
