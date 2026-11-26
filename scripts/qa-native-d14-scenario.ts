/**
 * Direction 14 (Task actuals), packaged ForgeOrbitQA window. Fake drivers, disposable profile, recorded fixture rows only: no
 * provider, no login, no quota source, no model call. The runs are hand-written rows shaped like recorded runs; they prove the
 * arithmetic and the wording, not provider telemetry.
 *
 * Fixture (seconds after T0; every figure the window shows is derived by hand from this list):
 *   Reference task  created -70, Ready -8, Done +60
 *     Developer 1 [ 0,10] cancelled by the Owner (Ada)      Developer 2 [12,30] succeeded (Ada)
 *     Reviewer 1  [28,40] CHANGES_REQUESTED (Grace), overlaps Developer 2 by 2 s
 *     Test        [30,33] failed, wholly inside Reviewer 1
 *     Developer 3 [42,50] succeeded, the rework (Ada)        Reviewer 2 [51,55] PASS (Grace)
 *   Missing-duration task: one run [0,10], one orphaned run starting at 12 with no recorded end; Done at +40.
 *   Old finished task: one run, Done column, NO recorded Done transition.
 * Expected on the reference task: cumulative agent time 52 s (summed), active wall-clock 50 s (union), first run to Done 60 s,
 * created to Done 130 s, Developer 36 s, Reviewer 16 s, tests 3 s, QC 16 s, rework 1 round / 8 s, queue 8 s, measured waiting 8 s,
 * runtime 50 s, unclassified 10 s, observed timeline 68 s, human effort Unknown.
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, activate } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "Analytics task table, the task's Actual execution dialog (totals, coverage notes, unrecorded Done), the Forecast versus actual attempts with their recorded workers",
    "PN records read from the packaged core (API of the same isolated profile)": "the task breakdown the window renders, table counters before and after reading",
    "Backend only (QA isolation)": "exact interval arithmetic, incomplete data, clipping at Done, attribution after reassignment and rename: src/bun/usage-analytics/task-actuals.suite.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const S = 1000;
  const T0 = Date.now() - 600 * S;
  const Work = join(runtime, "projects/D14");
  const dbPath = join(runtime, "data/agetor.sqlite");
  const openDb = (readonly = false) => { const d = new Database(dbPath, readonly ? { readonly: true } : undefined); d.run("PRAGMA busy_timeout = 5000"); return d; };

  // ---- prerequisites (API of the isolated profile, then recorded rows with the app stopped) ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  mkdirSync(Work, { recursive: true });
  writeFileSync(join(Work, "package.json"), "{}");
  await api("POST", "/projects", { path: Work, name: "D14 Work" });
  const ada = await api("POST", "/employees", { name: "Ada", jobTitle: "Developer", projectPath: Work });
  const grace = await api("POST", "/employees", { name: "Grace", jobTitle: "Reviewer", projectPath: Work });
  const make = async (title: string) => { const m = await api("POST", "/tasks", { title, prompt: "Add an example. Acceptance: add tests.", workdir: Work, agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none", column: "backlog" }); return (m.task ?? m).id as string; };
  const ref = await make("D14 reference task");
  const missing = await make("D14 missing duration task");
  const old = await make("D14 old finished task");
  await down();
  const db = openDb();
  const scope = JSON.stringify({ projectPath: Work, clusterId: null, missionId: null, category: "task", technology: "JavaScript/TypeScript", complexity: "low" });
  const at = (s: number) => T0 + s * S;
  const insertRun = (taskId: string, from: number, to: number | null, status: string, options: { qc?: string; worker?: any } = {}) => {
    const id = crypto.randomUUID();
    db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,qc_review_id,usage_scope) VALUES (?,?,?,?,?,?,0,?,?,?)`,
      [id, taskId, "codex", status, at(from), to === null ? null : at(to), id, options.qc ?? null, scope]);
    db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [id,
      JSON.stringify({ kind: "execution-identity", executionType: "real-provider", provider: "codex", model: "gpt-6.1-sol", mode: "auto" }), at(to ?? from)]);
    if (options.worker) {
      db.run(`INSERT INTO employee_executions(id,task_id,task_title,project_path,employee_id,employee_name,assignment_id,assignment_revision,status,
        requested_harness_id,requested_policy,requested_mode,inputs_key,task_fingerprint,config_json,review_json,run_id,actual_harness_id,actual_model,
        actual_provenance,approval_provenance,created_at,updated_at,expires_at,approved_at,started_at)
        VALUES (?,?,?,?,?,?,?,1,'started','codex','p','auto','k','f','{}','{}',?,'codex','gpt-6.1-sol','runtime','owner',?,?,?,?,?)`,
        [crypto.randomUUID(), taskId, "t", Work, options.worker.id, options.worker.name, crypto.randomUUID(), id, at(from), at(from), at(from) + 9e6, at(from), at(from)]);
    }
    return id;
  };
  const insertReview = (taskId: string, round: number, verdict: string, from: number, to: number, impl: string, reviewRun: string, reviewer: string) => {
    const id = crypto.randomUUID();
    db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,reviewer_employee_id,implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
      VALUES (?,?,?,?,'completed',?,'codex','gpt-6.1-sol',?,?,?,'{}',?,?,?)`, [id, taskId, Work, round, verdict, reviewer, impl, reviewRun, at(from), at(from), at(to)]);
    return id;
  };
  const finish = (taskId: string, doneAtSeconds: number | null) => {
    db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [taskId]);
    if (doneAtSeconds === null) db.run("DELETE FROM usage_task_transitions WHERE task_id = ? AND destination = 'done'", [taskId]);
    else db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [at(doneAtSeconds), taskId]);
  };
  db.run("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?", [at(-70), at(-70), ref]);
  db.run("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?", [at(-70), at(-70), missing]);
  db.run("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?", [at(-500), at(-500), old]);
  db.run("INSERT INTO usage_task_transitions(task_id,destination,at) VALUES (?,'ready',?)", [ref, at(-8)]);
  const d1 = insertRun(ref, 0, 10, "cancelled", { worker: ada });
  db.run("INSERT INTO run_terminations(run_id,reason,requested_at,attempts,outcome,methods,checked_at,exited_at) VALUES (?,?,?,?,?,?,?,?)",
    [d1, "manual", at(10), 1, "exited", "[]", at(10), at(10)]);
  const d2 = insertRun(ref, 12, 30, "succeeded", { worker: ada });
  const r1 = insertRun(ref, 28, 40, "succeeded");
  const rev1 = insertReview(ref, 1, "CHANGES_REQUESTED", 28, 40, d2, r1, grace.id);
  db.run("UPDATE runs SET qc_review_id = ? WHERE id = ?", [rev1, r1]);
  db.run(`INSERT INTO practical_test_attempts(id,task_id,project_path,workspace_path,rework_epoch,command,command_fingerprint,source_fingerprint,status,isolation,implementation_execution,started_at,finished_at)
    VALUES (?,?,?,?,0,'bun test','cmd','source','failed','offline','provider',?,?)`, [crypto.randomUUID(), ref, Work, Work, at(30), at(33)]);
  const d3 = insertRun(ref, 42, 50, "succeeded", { worker: ada });
  const r2 = insertRun(ref, 51, 55, "succeeded");
  const rev2 = insertReview(ref, 2, "PASS", 51, 55, d3, r2, grace.id);
  db.run("UPDATE runs SET qc_review_id = ? WHERE id = ?", [rev2, r2]);
  finish(ref, 60);
  insertRun(missing, 0, 10, "succeeded", { worker: ada });
  insertRun(missing, 12, null, "orphaned", { worker: ada });
  finish(missing, 40);
  insertRun(old, -400, -380, "succeeded");
  finish(old, null);
  db.close();
  await up();
  await show("Main navigation");
  mark("Seeded recorded fixture rows (reference task with two Reviewer rounds, rework, a Stop and a test; a task with one run that has no recorded end; an old Done task with no recorded Done). Two employees, Ada and Grace");

  const TABLES = ["runs", "run_events", "tasks", "usage_task_estimates", "employee_executions", "employee_task_assignments", "task_quality_reviews", "practical_test_attempts", "usage_task_transitions", "run_terminations", "usage_group_forecasts", "allocation_plans"];
  const counters = () => { const r = openDb(true); try { return Object.fromEntries(TABLES.map((t) => [t, (r.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n])); } finally { r.close(); } };
  const before = counters();

  // Value shown under a label inside the dialog: the nearest text directly beneath it.
  const valueOf = (label: string) => {
    const nodes = find((n: any) => n.AXRole === "AXStaticText" && !!n.frame) as any[];
    const text = (n: any) => [n.AXValue, n.AXTitle, n.AXDescription].find((x: any) => typeof x === "string" && x) as string | undefined;
    const labels = nodes.filter((n) => text(n) === label);
    assert(labels.length > 0, `label "${label}" is shown`);
    const l = labels[0];
    const below = nodes.filter((n) => n !== l && Math.abs(n.frame.x - l.frame.x) < 6 && n.frame.y > l.frame.y && n.frame.y - l.frame.y < 60 && text(n))
      .sort((p, q) => p.frame.y - q.frame.y)[0];
    return below ? text(below)! : "";
  };

  // ---- 1. Analytics → Usage → the reference task ----
  await button("Analytics", true, 0); await sleep(1200);
  await button("Usage", true, 0).catch(() => undefined); await sleep(1200);
  await show("D14 reference task", 30_000);
  shot("01-tasks-table");
  await button("D14 reference task", true); await sleep(1500);
  await show("Actual execution", 20_000);
  await sleep(1200);
  const figures: Record<string, string> = {};
  for (const [label, expected] of [
    ["Developer time", "36 sec"], ["Reviewer time", "16 sec"], ["Cumulative agent time", "52 sec"], ["Active wall-clock time", "50 sec"],
    ["Observed tests", "3 sec"], ["Quality control", "16 sec"], ["Ready to first run", "8 sec"], ["Created to Done", "2.17 min"],
    ["Elapsed first run to last Done", "1 min"], ["Measured waiting", "8 sec"], ["Observed timeline", "1.13 min"],
    ["Runtime interval with unknown internal waiting", "50 sec"], ["Human effort", "Unknown"], ["Provider-reported waiting", "Unknown"],
    ["Execution attempts", "5"], ["Completed runs", "4"], ["Interruptions", "1"],
  ] as const) {
    const got = valueOf(label);
    figures[label] = got;
    assert.equal(got, expected, `${label}: shown ${got}, expected ${expected} from the fixture`);
  }
  assert.equal(valueOf("Rework"), "1 · 8 sec", "Rework: one round, 8 s");
  assert.equal(valueOf("Unclassified time"), "10 sec", "Unclassified time: the gaps between attempts");
  figures["Rework"] = "1 · 8 sec"; figures["Unclassified time"] = "10 sec";
  assert(!has("Developer time covers"), "a complete task carries no lower-bound note");
  assert(!has("moment it was finished was not recorded"), "a task with a recorded Done carries no unrecorded-Done note");
  shot("02-reference-totals");
  evidence.reference = figures;
  mark("Reference task in the Actual execution dialog: Developer 36 s + Reviewer 16 s = cumulative agent time 52 s; the union of active intervals is 50 s (the 2 s Developer/Reviewer overlap counts once); first run to Done 1 min; created to Done 2.17 min. Tests 3 s and QC 16 s are separate measures; rework 1 round, 8 s; measured waiting 8 s (queue), 50 s inside runs with unknown internal waiting, 10 s unclassified. Human effort and provider-reported waiting are Unknown, not zero");

  // ---- 2. The attempts, with their recorded workers, in the same task's history ----
  await button("Open task", true, 0); await sleep(2500);
  await show("Forecast versus actual", 25_000);
  await button("Details: provenance", false, 0).catch(() => undefined); await sleep(900);
  assert(has("Developer attempt 1") && has("Developer attempt 3") && has("Reviewer attempt 2"), "every attempt is its own numbered row");
  assert(has("stopped by you") && has("process exit observed"), "the Stop the core recorded is shown with what it observed");
  assert(find(hasText("worker Ada")).length >= 3, "the three Developer attempts name their recorded worker");
  assert(find(hasText("worker Grace")).length >= 2, "the two Reviewer attempts name their reviewer");
  assert(has("cancelled") && has("interrupted"), "the Owner-stopped attempt reads as interrupted, not as a success");
  shot("03-attempts");
  const attemptText = find(hasText("attempt")).map((n: any) => [n.AXValue, n.AXTitle, n.AXDescription].find((x: any) => typeof x === "string" && x)).filter(Boolean).slice(0, 24);
  evidence.attempts = attemptText;
  mark("Task history, Forecast versus actual → Details: five attempts, each with its role, status, duration, recorded worker (Ada for the three Developer attempts, Grace for the two Reviewer attempts), resource, account and project; the cancelled attempt is marked interrupted and is not among the four completed runs");

  // ---- 3. Incomplete timing and an old Done with no recorded Done ----
  ax("key", "53", "0"); await sleep(1000);
  await button("Analytics", true, 0); await sleep(1200);
  await show("D14 missing duration task", 20_000);
  await button("D14 missing duration task", true); await sleep(1500);
  await show("Actual execution", 20_000); await sleep(1000);
  assert.equal(valueOf("Developer time"), "10 sec");
  assert(has("Developer time covers 1 of 2 attempts"), "a total with an attempt of no recorded duration says it is a lower bound");
  shot("04-missing-duration");
  mark("Task with one run that has no recorded end: Developer time 10 s with 'covers 1 of 2 attempts … a lower bound', not a silent total");
  ax("key", "53", "0"); await sleep(900);
  await button("D14 old finished task", true); await sleep(1500);
  await show("Actual execution", 20_000); await sleep(1000);
  assert(has("the moment it was finished was not recorded"), "the task says its Done was not recorded");
  assert.equal(valueOf("Created to Done"), "Unknown");
  assert.equal(valueOf("Elapsed so far"), "Unknown", "a finished task does not report elapsed time against the clock");
  shot("05-old-done-unrecorded");
  mark("Old Done task with no recorded Done: 'created to Done' and 'elapsed so far' are Unknown, with the reason shown; unclassified time no longer grows with the clock");
  ax("key", "53", "0"); await sleep(900);

  // ---- 4. Reading changed nothing ----
  const after = counters();
  assert.deepEqual(after, before, "reading the table, the dialog and the task history wrote nothing");
  evidence.readOnly = { before, after };
  mark("Row counts of runs, events, tasks, estimates, employee executions, assignments, reviews, tests, transitions and stop records are identical before and after every view");

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
  mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
  save();
  void activate;
}
