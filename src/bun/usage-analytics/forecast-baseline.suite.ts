import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_USAGE_STATUS_PREFIX } from "../../shared/usage-analytics.ts";

/**
 * FO-DIRECTION12 (Backlog task forecasting), offline. One isolated profile and the fake Codex
 * driver behind a /bin/echo stub: no provider, CLI, account probe or inference runs.
 *
 * The "history" tasks below are recorded FIXTURE rows shaped like completed real-provider runs.
 * They exercise the calibration rules (three comparable outcomes, same scope and resource) and
 * prove nothing about how accurate a forecast is on real work.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-direction12-")));
process.env.HOME = root;
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/fo-direction12";

let store: typeof import("../db.ts");
let orchestrator: typeof import("../orchestrator.ts");
let employeeRun: typeof import("../employee-run.ts");
let forecastModule: typeof import("./forecast.ts");
let analyticsModule: typeof import("./analytics.ts");
let EmployeeCore: typeof import("../employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("../assignment-core.ts").AssignmentCore;
let project: string;
let counter = 0;
const model = "gpt-6.1-sol";
const otherModel = "gpt-6-sol";
const LOW = "Add one example function. Acceptance: it has a test.";

beforeAll(async () => {
  store = await import("../db.ts");
  orchestrator = await import("../orchestrator.ts");
  employeeRun = await import("../employee-run.ts");
  forecastModule = await import("./forecast.ts");
  analyticsModule = await import("./analytics.ts");
  ({ EmployeeCore } = await import("../employee-core.ts"));
  ({ AssignmentCore } = await import("../assignment-core.ts"));
  employeeRun.initEmployeeExecutionTracking();
  store.harnesses.setEnabled("codex", true);
  project = join(root, "sample");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), "{}");
  store.projects.upsert(project, "Direction 12");
});
afterAll(() => { store.db.close(); rmSync(root, { recursive: true, force: true }); });

async function newTask(prompt = LOW, column: "backlog" | "ready" = "backlog", fields: Record<string, unknown> = {}, workdir = project) {
  const created = await orchestrator.createTask({
    title: `Task ${++counter}`, prompt, workdir, column, agent: "codex", model, mode: "auto", isolation: "none", ...fields,
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}
const worker = (name = `Worker ${++counter}`) => new EmployeeCore(store.db).createWorker({ name, jobTitle: "Engineer", projectPath: project });
const assign = (taskId: string, employeeId: string) => new AssignmentCore(store.db).assign(taskId, employeeId).assignment;
const estimate = (taskId: string, now = Date.now()) => {
  const saved = forecastModule.forecast({ taskIds: [taskId], save: true }, now).estimates[0]!;
  if (saved.estimateId === null) throw new Error("the estimate was not saved");
  return { ...saved, estimateId: saved.estimateId };
};
const preview = (taskId: string) => forecastModule.forecast({ taskIds: [taskId] }).estimates[0]!;
const versions = (taskId: string) => forecastModule.estimateVersions(taskId);
const boundTo = (runId: string) => store.db.query<{ usage_estimate_id: number | null }, [string]>("SELECT usage_estimate_id FROM runs WHERE id = ?").get(runId)!.usage_estimate_id;
const count = (table: string) => store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

/** A completed fixture task: one real-provider-shaped Developer run and one passing Reviewer run. */
function fixtureHistory(prompt: string, durations: number[], options: { reviewer?: boolean; workdir?: string } = {}) {
  const dir = options.workdir ?? project;
  const base = Date.now() - 600_000;
  durations.forEach((duration, n) => {
    const id = crypto.randomUUID();
    const start = base + n * 60_000;
    store.db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
      VALUES (?,?,?,'backlog','codex',?,?,'auto',?,?)`, [id, `History ${prompt.length}-${n}`, prompt, dir, model, base - 1000, base - 1000]);
    const run = (qc: string | undefined, from: number, to: number) => {
      const runId = crypto.randomUUID();
      store.runs.insert({ id: runId, taskId: id, agent: "codex", status: "succeeded", startedAt: from, endedAt: to, exitCode: 0,
        qcReviewId: qc, tmuxSession: null, claudeSessionId: null, codexSessionId: runId,
        cursorSessionId: null, geminiSessionId: null, fxSessionId: null });
      const event = (data: string) => store.db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [runId, data, to]);
      // The Reviewer is routed to read-only mode; the Developer task pins auto.
      event(JSON.stringify({ kind: "execution-identity", executionType: "real-provider", provider: "codex", model, mode: qc ? "ask" : "auto" }));
      event(RUN_USAGE_STATUS_PREFIX + JSON.stringify({ input: 50_000, output: 10_000, cacheRead: 0, cacheWrite: 0 }));
      return runId;
    };
    const developer = run(undefined, start, start + duration);
    if (options.reviewer !== false) {
      const qc = crypto.randomUUID();
      const reviewerRun = run(qc, start + duration + 1000, start + duration + 6000);
      store.db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,
        implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
        VALUES (?,?,?,1,'completed','PASS','codex',?,?,?,'{}',?,?,?)`, [qc, id, dir, model, developer, reviewerRun, start, start, start + duration + 6000]);
    }
    store.tasks.update(id, { column: "done" });
    store.db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [start + duration + 7000, id]);
  });
}

test("with no comparable history the estimate is a labelled cold-start range, never a single point or a measurement", async () => {
  const id = await newTask();
  const runsBefore = count("runs");
  const result = estimate(id);
  expect(result.developer).toMatchObject({ basis: "heuristic", samples: 0 });
  expect(result.stageEvidence).toEqual({ developer: 0, reviewer: 0, test: 0, rework: 0, wall: 0 });
  expect(result.confidence).toBe("low");
  for (const range of [result.completion, result.worker, result.activeDeveloper!]) {
    expect(range.optimistic).toBeLessThan(range.expected);
    expect(range.expected).toBeLessThan(range.conservative);
  }
  // Nothing was measured: tokens, price and subscription use stay Unknown, never zero.
  expect(result.developer!.tokens).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null });
  expect(result.plannedUsage.totals).toEqual([]);
  expect(result.subscriptionUsage).toBeNull();
  expect(count("runs")).toBe(runsBefore);
});

test("three comparable recorded outcomes switch the basis to historical; the label never promises accuracy", async () => {
  fixtureHistory(LOW, [10_000, 15_000, 20_000]);
  const id = await newTask();
  const result = estimate(id);
  expect(result.developer).toMatchObject({ basis: "historical", samples: 3 });
  expect(result.reviewer).toMatchObject({ basis: "historical", samples: 3 });
  expect(result.developer!.duration).toMatchObject({ expected: 15_000 });
  expect(result.stageEvidence).toMatchObject({ developer: 3, reviewer: 3 });
  expect(result.confidence).toBe("medium");
  // A resource with no comparable outcomes stays a heuristic even in the same project.
  const luna = await newTask(LOW, "backlog", { model: otherModel });
  const other = estimate(luna);
  expect(other.developer).toMatchObject({ basis: "heuristic", samples: 0 });
  expect(other.confidence).toBe("low");
});

test("two comparable outcomes are not enough", async () => {
  // A separate Rust project keeps these fixtures out of the JavaScript project's cohort.
  const rust = join(root, "rust-sample");
  mkdirSync(rust);
  writeFileSync(join(rust, "Cargo.toml"), "[package]\nname = \"x\"\n");
  store.projects.upsert(rust, "Rust sample");
  fixtureHistory(LOW, [8000, 9000], { workdir: rust });
  const id = await newTask(LOW, "backlog", {}, rust);
  const result = estimate(id);
  // The two outcomes are counted and shown, but they are below the three the ranges need.
  expect(result.developer).toMatchObject({ basis: "heuristic", samples: 2 });
  expect(result.confidence).toBe("low");
  fixtureHistory(LOW, [7000], { workdir: rust }); // the third outcome calibrates it
  expect(preview(id).developer).toMatchObject({ basis: "historical", samples: 3 });
});

test("a changed acceptance scope moves the task out of its calibrated cohort and a new revision keeps the earlier one", async () => {
  const id = await newTask();
  const first = estimate(id);
  expect(first.developer).toMatchObject({ basis: "historical", samples: 3 });
  const criteria = Array.from({ length: 6 }, (_, n) => `- Criterion ${n + 1}: the importer rejects malformed row ${n + 1} with a clear message.`).join("\n");
  store.tasks.update(id, { prompt: `${LOW}\n${criteria}` });
  // The edit marks the earlier revision stale on its own: nobody has to remember to refresh.
  expect(versions(id)[0]!.stale).toBe(true);
  const second = estimate(id);
  expect(second.complexity).toBe("medium");
  expect(second.developer).toMatchObject({ basis: "heuristic", samples: 0 });
  expect(second.confidence).toBe("low");
  expect(second.estimateId).toBeGreaterThan(first.estimateId);
  expect(second.developer!.duration.expected).not.toBe(first.developer!.duration.expected);
  const all = versions(id);
  expect(all.map(v => [v.id, v.stale])).toEqual([[second.estimateId, false], [first.estimateId, true]]);
  // The earlier revision is unchanged and still says what it said.
  expect(all[1]!.estimate.developer).toMatchObject({ basis: "historical", samples: 3 });
  expect(forecastModule.originalEstimate(id)!.estimateId).toBe(first.estimateId);
});

test("a changed model and a newly assigned worker each mark the saved revision stale and produce their own revision", async () => {
  const id = await newTask();
  const first = estimate(id);
  expect(estimate(id).estimateId).toBe(first.estimateId); // unchanged inputs: no revision noise
  store.tasks.update(id, { model: otherModel });
  expect(versions(id)[0]!.stale).toBe(true);
  const changedModel = estimate(id);
  expect(changedModel.estimateId).toBeGreaterThan(first.estimateId);
  expect(changedModel.plannedResource).toMatchObject({ modelId: otherModel });
  expect(changedModel.developer).toMatchObject({ basis: "heuristic", samples: 0 });
  expect(versions(id).map(v => [v.id, v.stale])).toEqual([[changedModel.estimateId, false], [first.estimateId, true]]);

  const other = await newTask();
  const before = estimate(other);
  expect(before.workerId).toBeNull();
  const person = worker();
  assign(other, person.id);
  // Assignment is a named planning input: it marks the saved revision stale just like a scope edit.
  expect(versions(other)[0]).toMatchObject({ id: before.estimateId, stale: true });
  const assigned = estimate(other);
  expect(assigned.workerId).toBe(person.id);
  expect(assigned.estimateId).toBeGreaterThan(before.estimateId);
  expect(versions(other).map(v => v.stale)).toEqual([false, true]);
  // Reassigning, and removing, the worker do the same; the earlier revisions stay readable.
  const second = worker();
  const core = new AssignmentCore(store.db);
  const current = core.forTask(other)!;
  core.reassign(other, second.id, current.revision);
  expect(versions(other)[0]!.stale).toBe(true);
  const reassigned = estimate(other);
  expect(reassigned.workerId).toBe(second.id);
  core.unassign(other, core.forTask(other)!.revision);
  expect(versions(other)[0]!.stale).toBe(true);
  expect(estimate(other).workerId).toBeNull();
  expect(versions(other).map(v => v.estimate.workerId)).toEqual([null, second.id, person.id, null]);
});

test("an Estimate dispatches nothing and grants no authority; it only persists estimate revisions", async () => {
  const id = await newTask();
  const person = worker();
  assign(id, person.id);
  const tables = ["runs", "run_events", "employee_executions", "orchestration_missions", "orchestration_reservations", "allocation_plans",
    "autonomy_policies", "employee_task_assignments", "project_manager_executions", "quota_observations", "usage_cost_adjustments"];
  const read = () => Object.fromEntries(tables.map(table => [table, count(table)]));
  const before = read();
  const task = store.tasks.get(id)!;
  estimate(id);
  estimate(id);
  expect(read()).toEqual(before);
  const after = store.tasks.get(id)!;
  expect(after.column).toBe("backlog");
  expect(after.runId).toBe(task.runId);
  expect(after.agent).toBe(task.agent);
  expect(versions(id).length).toBe(1);
});

test("the baseline of a task estimated in Backlog and launched unchanged is the Backlog revision", async () => {
  const id = await newTask();
  const person = worker();
  assign(id, person.id);
  const saved = estimate(id);
  store.tasks.update(id, { column: "ready" });
  const started = await startSupervised(id);
  expect(boundTo(started.runId)).toBe(saved.estimateId);
  const detail = analyticsModule.taskBreakdown(id)!;
  expect(detail.comparison.baseline).toMatchObject({ estimateId: saved.estimateId, boundRunId: started.runId });
  expect(detail.comparison.baseline!.laterRevisions).toEqual([]);
  expect(forecastModule.originalEstimate(id)!.estimateId).toBe(saved.estimateId);
});

test("a plan changed after the Backlog estimate is re-estimated at Start; the first run binds the valid revision and the original stays readable", async () => {
  const id = await newTask();
  const original = estimate(id);
  const person = worker();
  assign(id, person.id); // the worker is chosen after the estimate: a material input change
  store.tasks.update(id, { column: "ready" });
  const started = await startSupervised(id, { model: otherModel });
  const bound = boundTo(started.runId);
  expect(bound).not.toBeNull();
  expect(bound).toBeGreaterThan(original.estimateId);
  const frozen = forecastModule.frozenEstimate(bound)!;
  expect(frozen.plannedResource).toMatchObject({ harnessId: "codex", modelId: otherModel });
  expect(frozen.workerId).toBe(person.id);
  // The Backlog revision is still there, unchanged, marked as no longer current, and is the "original".
  expect(forecastModule.originalEstimate(id)!.estimateId).toBe(original.estimateId);
  expect(versions(id).find(v => v.id === original.estimateId)).toMatchObject({ stale: true });
  expect(forecastModule.frozenEstimate(original.estimateId)!.plannedResource).toMatchObject({ modelId: model });
  const comparison = analyticsModule.taskBreakdown(id)!.comparison;
  expect(comparison.baseline).toMatchObject({ estimateId: bound, boundRunId: started.runId });
});

test("a Reviewer run, a rework run and a later estimate never replace the baseline", async () => {
  const id = await newTask();
  assign(id, worker().id);
  const saved = estimate(id);
  store.tasks.update(id, { column: "ready" });
  const started = await startSupervised(id);
  expect(boundTo(started.runId)).toBe(saved.estimateId);
  const reviewer = insertRun(id, { qc: crypto.randomUUID() });
  expect(boundTo(reviewer)).toBeNull();
  const rework = insertRun(id, {});
  expect(boundTo(rework)).toBeNull();
  store.db.run(`UPDATE tasks SET "column" = 'backlog' WHERE id = ?`, [id]);
  store.tasks.update(id, { prompt: "Refactor authentication and migrations across the importer. Acceptance: tests." });
  const later = estimate(id);
  expect(later.estimateId).toBeGreaterThan(saved.estimateId);
  expect(boundTo(started.runId)).toBe(saved.estimateId);
  expect(analyticsModule.taskBreakdown(id)!.comparison.baseline).toMatchObject({ estimateId: saved.estimateId });
  expect(analyticsModule.taskBreakdown(id)!.comparison.baseline!.laterRevisions.map(row => row.id)).toContain(later.estimateId);
});

test("a task already started with no estimate gets no baseline, now or later", async () => {
  const id = await newTask(LOW, "ready");
  const started = await orchestrator.startTask(id);
  if ("error" in started) throw new Error(started.error);
  expect(boundTo(started.runId)).toBeNull();
  expect(forecastModule.ensureBaselineEstimate(id)).toBeNull();
  store.db.run(`UPDATE tasks SET "column" = 'backlog' WHERE id = ?`, [id]);
  estimate(id); // an explicit Estimate after the work began is a revision, not a baseline
  expect(boundTo(started.runId)).toBeNull();
  expect(analyticsModule.taskBreakdown(id)!.comparison).toMatchObject({ state: "no-baseline", absence: "saved-after-start", baseline: null });
});

test("an estimate made stale by a worker change is not bound by a start that did not re-estimate", async () => {
  const id = await newTask();
  const saved = estimate(id);
  assign(id, worker().id);
  store.tasks.update(id, { column: "ready" });
  const started = await orchestrator.startTask(id); // a plain board Start never re-estimates
  if ("error" in started) throw new Error(started.error);
  expect(versions(id).find(v => v.id === saved.estimateId)!.stale).toBe(true);
  expect(boundTo(started.runId)).toBeNull();
});

function insertRun(taskId: string, options: { qc?: string }) {
  const runId = crypto.randomUUID();
  const at = Date.now();
  store.runs.insert({ id: runId, taskId, agent: "codex", status: "succeeded", startedAt: at, endedAt: at + 100, exitCode: 0,
    qcReviewId: options.qc, tmuxSession: null, claudeSessionId: null, codexSessionId: runId,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null });
  return runId;
}

/** The real supervised path: review, then the Owner's confirmed start through the existing runtime. */
async function startSupervised(taskId: string, extra: Record<string, unknown> = {}) {
  const out = await employeeRun.reviewEmployeeExecution({ taskId, harnessId: "codex", ...extra });
  expect(out.blockingErrors.map(e => e.code)).toEqual([]);
  const attempt = out.attempt!;
  const started = await employeeRun.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true });
  const runId = started.attempt.runId;
  if (!runId) throw new Error("no run was recorded");
  return { runId, attemptId: attempt.id };
}
