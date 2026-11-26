/**
 * Supervised run control against a REAL local process: the real Codex tmux driver, the real startTask and QC code,
 * and a stub `codex` that stays alive until it is stopped. Process exit is checked with kill(pid, 0), not through the
 * app. No provider is called.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-")));
const STUB = path.join(ROOT, "codex-stub.sh");
const PIDS = path.join(ROOT, "pids");
const BEHAVIOR = path.join(ROOT, "behavior");
const ARGV = path.join(ROOT, "argv.log");
mkdirSync(PIDS);
writeFileSync(BEHAVIOR, "");
// Each `exec` turn records its pid and takes the next behavior line: hold, hold-ignore (ignores HUP and TERM), or finish.
writeFileSync(STUB, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.200.0"; exit 0;;
  --help) echo "codex stub"; exit 0;;
esac
if [ "$1" = "exec" ]; then
  n=$(ls "${PIDS}" | wc -l | tr -d ' ')
  echo $$ > "${PIDS}/$((n + 1)).pid"
  echo "$@" >> "${ARGV}"
  behavior=$(head -n 1 "${BEHAVIOR}")
  tail -n +2 "${BEHAVIOR}" > "${BEHAVIOR}.tmp" && mv "${BEHAVIOR}.tmp" "${BEHAVIOR}"
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"stub-thread"}'
  case "$behavior" in
    hold) while :; do sleep 1; done;;
    write-hold) mkdir -p src && printf 'export const partial = 1;\n' > src/clamp.ts; while :; do sleep 1; done;;
    hold-ignore) trap '' HUP TERM; while :; do sleep 1; done;;
    finish-slow) sleep 0.4;;
  esac
  echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"<qc_verdict>PASS</qc_verdict><qc_summary>ok</qc_summary><qc_findings>[]</qc_findings><qc_feedback>none</qc_feedback>"}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
fi
exit 0
`);
chmodSync(STUB, 0o755);
process.env.AGETOR_DATA_DIR = path.join(ROOT, "data");
process.env.AGETOR_CODEX_BIN = STUB;
process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
delete process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS;

type Store = typeof import("./db.ts");
let store: Store;
let orchestrator: typeof import("./orchestrator.ts");
let qc: typeof import("./task-quality-control.ts");
let termination: typeof import("./process-termination.ts");
let reconcileDb: typeof import("./run-terminations.ts");
const spawned: number[] = [];

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  qc = await import("./task-quality-control.ts");
  termination = await import("./process-termination.ts");
  reconcileDb = await import("./run-terminations.ts");
  store.harnesses.setEnabled("codex", true);
  termination.__setTerminationTimingForTest({ graceMs: 1500, termMs: 1000, killMs: 1500, pollMs: 50 });
});

afterAll(() => {
  termination.__setProcessControlForTest(null);
  termination.__setTerminationTimingForTest(null);
  delete process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS;
  for (const pid of spawned) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const behavior = (...lines: string[]) => writeFileSync(BEHAVIOR, lines.map((line) => `${line}\n`).join(""));
async function until(check: () => boolean, ms = 25_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await Bun.sleep(40);
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}
const pidFiles = () => readdirSync(PIDS).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
async function nextPid(known: number): Promise<number> {
  await until(() => pidFiles().length > known, 20_000, "the stub process to start");
  const pid = Number(readFileSync(path.join(PIDS, pidFiles()[known]!), "utf8").trim());
  spawned.push(pid);
  return pid;
}

async function newTask(title: string): Promise<{ id: string; workdir: string }> {
  const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-proj-")));
  store.projects.upsert(workdir, title);
  const created = await orchestrator.createTask({
    title, prompt: `Do ${title}`, workdir, column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return { id: created.task.id, workdir };
}

const task = (id: string) => store.tasks.get(id)!;
const statusLines = (runId: string) => store.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);

test("a manual Developer stop targets that run, observes the process exit, and leaves no success, QC or Done behind", async () => {
  const a = await newTask("stop developer A");
  const b = await newTask("bystander B");
  behavior("hold", "hold");
  const startedA = await orchestrator.startTask(a.id);
  if ("error" in startedA) throw new Error(startedA.error);
  const pidA = await nextPid(0);
  const startedB = await orchestrator.startTask(b.id);
  if ("error" in startedB) throw new Error(startedB.error);
  const pidB = await nextPid(1);
  expect(task(a.id).runId).toBe(startedA.runId);

  const result = await orchestrator.stopRun(startedA.runId, "manual");
  expect(result.cancelled).toBe(true);
  expect(result.termination?.outcome).toBe("exited");
  expect(result.termination?.reason).toBe("manual");
  expect(result.termination?.processId).toBe(pidA);
  // The core said the process exited; verify that without the app.
  expect(alive(pidA)).toBe(false);

  await until(() => store.runs.get(startedA.runId)?.status === "cancelled", 10_000, "the run to settle");
  expect(task(a.id).column).toBe("ready");
  expect(store.runs.get(startedA.runId)?.status).not.toBe("succeeded");
  expect(store.taskQualityReviews.listForTask(a.id)).toHaveLength(0);
  expect(task(a.id).column).not.toBe("done");
  expect(statusLines(startedA.runId).some((line) => line.startsWith("process exit confirmed"))).toBe(true);
  // The other active task is untouched: still running, its process alive.
  expect(alive(pidB)).toBe(true);
  expect(store.runs.get(startedB.runId)?.status).toBe("running");
  expect(task(b.id).column).toBe("running");
  const stopB = await orchestrator.stopRun(startedB.runId, "manual");
  expect(stopB.termination?.outcome).toBe("exited");
  expect(alive(pidB)).toBe(false);
}, 90_000);

test("a repeated Stop shares one attempt and settles once; a Stop after the run settled changes nothing", async () => {
  const t = await newTask("duplicate stop");
  const known = pidFiles().length;
  behavior("hold");
  const started = await orchestrator.startTask(t.id);
  if ("error" in started) throw new Error(started.error);
  const pid = await nextPid(known);
  const [first, second, third] = await Promise.all([
    orchestrator.stopRun(started.runId), orchestrator.stopRun(started.runId), orchestrator.cancelRun(started.runId),
  ]);
  expect(first.cancelled && second.cancelled && third).toBe(true);
  expect(first.termination?.outcome).toBe("exited");
  expect(first.termination?.attempts).toBe(1);
  await until(() => store.runs.get(started.runId)?.status === "cancelled", 10_000, "the run to settle");
  const endedAt = store.runs.get(started.runId)!.endedAt;
  expect(alive(pid)).toBe(false);

  const late = await orchestrator.stopRun(started.runId);
  expect(late.cancelled).toBe(false);
  await Bun.sleep(300);
  expect(store.runs.get(started.runId)!.endedAt).toBe(endedAt);
  expect(store.runs.get(started.runId)!.status).toBe("cancelled");
  // One launch, one run row, one stop request line.
  expect(pidFiles().length).toBe(known + 1);
  expect(store.runs.listForTask(t.id)).toHaveLength(1);
  expect(statusLines(started.runId).filter((line) => line === "stop requested by the Owner")).toHaveLength(1);
}, 60_000);

test("a natural exit racing with Stop settles exactly once, with one outcome", async () => {
  for (const delay of [60, 250, 420]) {
    const t = await newTask(`race ${delay}`);
    const known = pidFiles().length;
    behavior("finish-slow");
    const started = await orchestrator.startTask(t.id);
    if ("error" in started) throw new Error(started.error);
    await nextPid(known);
    await Bun.sleep(delay);
    const results = await Promise.all([orchestrator.stopRun(started.runId), orchestrator.stopRun(started.runId)]);
    await until(() => store.runs.get(started.runId)?.status !== "running", 15_000, "the run to settle");
    await Bun.sleep(400);
    const run = store.runs.get(started.runId)!;
    const row = reconcileDb.runTerminations.get(started.runId);
    expect(store.runs.listForTask(t.id)).toHaveLength(1);
    expect(pidFiles().length).toBe(known + 1);
    if (run.status === "succeeded") {
      // The process finished first: nothing was flagged cancelled and no stop is on record.
      expect(results.every((r) => !r.cancelled || r.termination === null || r.termination.outcome !== null)).toBe(true);
      expect(task(t.id).column).toBe("review");
    } else {
      expect(run.status).toBe("cancelled");
      expect(row?.requestedAt).not.toBeNull();
      expect(task(t.id).column).toBe("ready");
    }
    expect(statusLines(started.runId).filter((line) => line.startsWith("exit:") || line.startsWith("cancelled")).length).toBeLessThanOrEqual(1);
  }
}, 120_000);

test("a Reviewer stop targets the Reviewer's own run, records no verdict, restores the Developer's settings and never reaches Done", async () => {
  const t = await newTask("stop reviewer");
  behavior("finish");
  const dev = await orchestrator.startTask(t.id);
  if ("error" in dev) throw new Error(dev.error);
  await until(() => task(t.id).column === "review", 20_000, "the Developer run to finish");
  const before = task(t.id);
  const known = pidFiles().length;
  const prepared = qc.prepareQcReview({ taskId: t.id, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  behavior("hold");
  const review = await qc.startQcReview(prepared.review.id);
  if ("error" in review) throw new Error(review.error);
  const pid = await nextPid(known);

  const live = task(t.id);
  expect(live.runId).toBe(review.runId);
  expect(live.runId).not.toBe(dev.runId);
  expect(store.runs.get(review.runId)?.qcReviewId).toBe(prepared.review.id);
  expect(store.taskQualityReviews.get(prepared.review.id)?.status).toBe("running");

  const result = await orchestrator.stopRun(live.runId!, "manual");
  expect(result.termination?.outcome).toBe("exited");
  expect(alive(pid)).toBe(false);
  await until(() => store.taskQualityReviews.get(prepared.review.id)?.status === "complete", 10_000, "the review to settle");

  const settled = store.taskQualityReviews.get(prepared.review.id)!;
  expect(settled.verdict).toBeNull();
  expect(settled.summary).toContain("stopped by the Owner");
  expect(settled.summary).toContain("observed to exit");
  expect(settled.summary).not.toContain("failed");
  expect(store.runs.get(review.runId)?.status).toBe("cancelled");
  // The Developer's run is untouched and still the successful implementation.
  expect(store.runs.get(dev.runId)?.status).toBe("succeeded");
  const after = task(t.id);
  expect(after.column).toBe("blocked");
  expect(after.column).not.toBe("done");
  expect([after.agent, after.mode, after.model, after.prompt]).toEqual([before.agent, before.mode, before.model, before.prompt]);
  expect(after.qcState?.activeReviewId).toBeNull();
  expect(after.qcState?.latestVerdict).toBeNull();
  expect(after.qcState?.awaitingOwnerApproval).toBe(false);
}, 90_000);

test("without the opt-in there is no time limit; a malformed value is refused; a plain start never gets one", async () => {
  const t = await newTask("no limit");
  const known = pidFiles().length;
  behavior("hold");
  const started = await orchestrator.startTask(t.id, { supervisedRun: true });
  if ("error" in started) throw new Error(started.error);
  await nextPid(known);
  await Bun.sleep(2500);
  expect(store.runs.get(started.runId)?.status).toBe("running");
  expect(reconcileDb.runTerminations.get(started.runId)).toBeNull();
  await orchestrator.stopRun(started.runId);
  await until(() => store.runs.get(started.runId)?.status === "cancelled", 10_000, "the run to settle");

  process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS = "soon";
  const refused = await orchestrator.startTask(t.id, { supervisedRun: true });
  expect("error" in refused && refused.error).toContain("whole number of seconds");
  expect(store.runs.listForTask(t.id)).toHaveLength(1);
  // The same value does not touch a plain, non-supervised start.
  process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS = "2";
  const plain = await newTask("plain start with a limit set");
  const plainKnown = pidFiles().length;
  behavior("hold");
  const plainStarted = await orchestrator.startTask(plain.id);
  if ("error" in plainStarted) throw new Error(plainStarted.error);
  await nextPid(plainKnown);
  await Bun.sleep(3500);
  expect(store.runs.get(plainStarted.runId)?.status).toBe("running");
  expect(reconcileDb.runTerminations.get(plainStarted.runId)).toBeNull();
  await orchestrator.stopRun(plainStarted.runId);
  delete process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS;
}, 90_000);

test("an opt-in time limit stops a supervised Developer run through the same path, and says it was the limit", async () => {
  process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS = "2";
  const t = await newTask("time limit developer");
  const known = pidFiles().length;
  behavior("hold");
  const started = await orchestrator.startTask(t.id, { supervisedRun: true });
  if ("error" in started) throw new Error(started.error);
  const pid = await nextPid(known);
  expect(reconcileDb.runTerminations.get(started.runId)?.limitSeconds).toBe(2);
  expect(reconcileDb.runTerminations.get(started.runId)?.requestedAt).toBeNull();

  await until(() => store.runs.get(started.runId)?.status === "cancelled", 15_000, "the time limit to stop the run");
  const row = reconcileDb.runTerminations.get(started.runId)!;
  expect(row.reason).toBe("time-limit");
  expect(row.outcome).toBe("exited");
  expect(alive(pid)).toBe(false);
  expect(task(t.id).column).toBe("ready");
  expect(store.taskQualityReviews.listForTask(t.id)).toHaveLength(0);
  const lines = statusLines(started.runId);
  expect(lines.some((line) => line.startsWith("time limit: this run is stopped after 2 s"))).toBe(true);
  expect(lines.some((line) => line.startsWith("time limit of 2 s reached"))).toBe(true);
  delete process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS;
}, 60_000);

test("an opt-in time limit stops a Reviewer, which records no verdict and names the limit", async () => {
  const t = await newTask("time limit reviewer");
  behavior("finish");
  const dev = await orchestrator.startTask(t.id);
  if ("error" in dev) throw new Error(dev.error);
  await until(() => task(t.id).column === "review", 20_000, "the Developer run to finish");
  process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS = "2";
  const known = pidFiles().length;
  const prepared = qc.prepareQcReview({ taskId: t.id, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  behavior("hold");
  const review = await qc.startQcReview(prepared.review.id);
  if ("error" in review) throw new Error(review.error);
  const pid = await nextPid(known);
  await until(() => store.taskQualityReviews.get(prepared.review.id)?.status === "complete", 15_000, "the time limit to settle the review");
  const settled = store.taskQualityReviews.get(prepared.review.id)!;
  expect(settled.verdict).toBeNull();
  expect(settled.summary).toContain("time limit of 2 s");
  expect(alive(pid)).toBe(false);
  expect(reconcileDb.runTerminations.get(review.runId)?.reason).toBe("time-limit");
  expect(task(t.id).column).toBe("blocked");
  delete process.env.FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS;
}, 60_000);

test("a process that survives every signal is reported as unconfirmed and keeps the run, the slot and the task occupied", async () => {
  const t = await newTask("unconfirmed stop");
  const known = pidFiles().length;
  behavior("hold-ignore");
  const started = await orchestrator.startTask(t.id);
  if ("error" in started) throw new Error(started.error);
  const pid = await nextPid(known);
  // SIGTERM and SIGKILL do not reach the process: the hang-up is ignored and nothing else stops it.
  termination.__setProcessControlForTest({ ...termination.systemProcessControl, signal: () => undefined });
  try {
    const first = await orchestrator.stopRun(started.runId);
    expect(first.cancelled).toBe(true);
    expect(first.termination?.outcome).toBe("unconfirmed");
    expect(first.termination?.processId).toBe(pid);
    expect(alive(pid)).toBe(true);
    // The request is not treated as an exit: the run is open, the task is occupied, nothing else can start.
    await Bun.sleep(600);
    expect(store.runs.get(started.runId)?.status).toBe("running");
    expect(task(t.id).column).toBe("running");
    expect(orchestrator.isTaskRunLive(t.id)).toBe(true);
    const again = await orchestrator.startTask(t.id);
    expect("error" in again && again.error).toBe("task already running");
    expect(store.runs.listForTask(t.id)).toHaveLength(1);
    expect(statusLines(started.runId).some((line) => line.startsWith("stop not confirmed"))).toBe(true);

    // A repeated Stop tries again, and the attempt is counted.
    const retry = await orchestrator.stopRun(started.runId);
    expect(retry.termination?.attempts).toBe(2);
    expect(retry.termination?.outcome).toBe("unconfirmed");
    expect(store.runs.get(started.runId)?.status).toBe("running");
  } finally {
    termination.__setProcessControlForTest(null);
  }
  // With signals working again, Stop completes: exit is observed, then the run settles.
  const final = await orchestrator.stopRun(started.runId);
  expect(final.termination?.outcome).toBe("exited");
  expect(alive(pid)).toBe(false);
  await until(() => store.runs.get(started.runId)?.status === "cancelled", 10_000, "the run to settle");
  expect(orchestrator.isTaskRunLive(t.id)).toBe(false);
  expect(task(t.id).column).toBe("ready");
}, 90_000);

test("an unconfirmed process that later exits on its own settles the run and the record says so", async () => {
  const t = await newTask("late exit");
  const known = pidFiles().length;
  behavior("hold-ignore");
  const started = await orchestrator.startTask(t.id);
  if ("error" in started) throw new Error(started.error);
  const pid = await nextPid(known);
  termination.__setProcessControlForTest({ ...termination.systemProcessControl, signal: () => undefined });
  try {
    const result = await orchestrator.stopRun(started.runId);
    expect(result.termination?.outcome).toBe("unconfirmed");
    expect(store.runs.get(started.runId)?.status).toBe("running");
  } finally {
    termination.__setProcessControlForTest(null);
  }
  process.kill(-pid, "SIGKILL");
  await until(() => store.runs.get(started.runId)?.status === "cancelled", 15_000, "the late exit to settle the run");
  const row = reconcileDb.runTerminations.get(started.runId)!;
  expect(row.outcome).toBe("exited");
  expect(row.note).toContain("later observed to exit");
  expect(alive(pid)).toBe(false);
  expect(orchestrator.isTaskRunLive(t.id)).toBe(false);
}, 90_000);

test("a stopped Developer run's staged files are kept for inspection but can never be published", async () => {
  const workspace = await import("./task-workspace.ts");
  const dir = path.join(ROOT, "staged-project");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  for (const args of [["init", "-b", "main"], ["add", "README.md"], ["-c", "user.email=fo@example.com", "-c", "user.name=FO", "commit", "-m", "seed"]]) {
    const proc = Bun.spawn(["git", "--no-optional-locks", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  }
  store.projects.upsert(dir, "staged stop");
  const created = await orchestrator.createTask({ title: "staged stop", prompt: "Add src/clamp.ts", workdir: dir, column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const prepared = await workspace.prepareTaskWorkspace(id, { outputPaths: ["src/clamp.ts"] });
  const known = pidFiles().length;
  behavior("write-hold");
  const started = await orchestrator.startTask(id);
  if ("error" in started) throw new Error(started.error);
  const pid = await nextPid(known);
  await until(() => existsSync(path.join(prepared.stagingPath, "src/clamp.ts")), 15_000, "the Developer to write into staging");

  const stopped = await orchestrator.stopRun(started.runId);
  expect(stopped.termination?.outcome).toBe("exited");
  expect(alive(pid)).toBe(false);
  await until(() => workspace.getTaskWorkspace(id)?.status === "settled", 15_000, "the workspace to settle");
  const view = workspace.getTaskWorkspace(id)!;
  expect(view.interruption).toEqual({ reason: "manual", limitSeconds: null });
  expect(view.changes.find((entry) => entry.path === "src/clamp.ts")?.scope).toBe("output");
  // The partial file stays in staging for inspection; publication is refused and nothing reaches the project.
  await expect(workspace.publishTaskWorkspace(id, { approve: true, paths: ["src/clamp.ts"] })).rejects.toThrow(/stopped by the Owner before it finished/);
  expect(existsSync(path.join(dir, "src/clamp.ts"))).toBe(false);
  expect(store.runs.get(started.runId)?.status).toBe("cancelled");
  expect(task(id).column).toBe("ready");
}, 90_000);

test("after a restart nothing is relaunched, a stop's process is rechecked once, and an orphaned review is settled", async () => {
  const t = await newTask("restart recovery");
  behavior("finish");
  const dev = await orchestrator.startTask(t.id);
  if ("error" in dev) throw new Error(dev.error);
  await until(() => task(t.id).column === "review", 20_000, "the Developer run to finish");
  const before = task(t.id);
  const prepared = qc.prepareQcReview({ taskId: t.id, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  // A Reviewer run that was live when the app stopped: its row is `running`, its tmux session is gone.
  const reviewRunId = `restart-review-${Date.now()}`;
  const swapped = store.tasks.update(t.id, { agent: "codex", prompt: "REVIEWER PROMPT" });
  expect(swapped?.prompt).toBe("REVIEWER PROMPT");
  store.db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, tmux_session, qc_review_id) VALUES (?, ?, 'codex', 'running', ?, 'agetor-gone-session', ?)`, [reviewRunId, t.id, Date.now(), prepared.review.id]);
  store.taskQualityReviews.markRunning(prepared.review.id, Date.now());
  store.db.run(`UPDATE task_quality_reviews SET review_run_id = ? WHERE id = ?`, [reviewRunId, prepared.review.id]);
  store.db.run(`UPDATE tasks SET "column" = 'running', run_id = ? WHERE id = ?`, [reviewRunId, t.id]);
  // The owner had asked for a stop before the restart; the recorded process is a live, unrelated sleeper.
  const sleeper = Bun.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(sleeper.pid);
  const started = await termination.processControl().startedAt(sleeper.pid);
  reconcileDb.runTerminations.request(reviewRunId, "manual");
  reconcileDb.runTerminations.record(reviewRunId, { outcome: "unconfirmed", processId: sleeper.pid, processStarted: started, methods: ["session-kill", "sigterm", "sigkill"], note: "still running" });
  const runsBefore = store.runs.listForTask(t.id).length;
  const pidsBefore = pidFiles().length;

  await orchestrator.reconcileOrphans();

  expect(store.runs.get(reviewRunId)?.status).toBe("orphaned");
  const row = reconcileDb.runTerminations.get(reviewRunId)!;
  expect(row.outcome).toBe("recovered-alive");
  expect(row.note).toContain("was not stopped again");
  expect(alive(sleeper.pid)).toBe(true);
  // The review is settled without a verdict, the Developer's settings are back, and no work was relaunched.
  const settled = store.taskQualityReviews.get(prepared.review.id)!;
  expect(settled.status).toBe("complete");
  expect(settled.verdict).toBeNull();
  expect(settled.summary).toContain("still running");
  const after = task(t.id);
  expect(after.prompt).toBe(before.prompt);
  expect(after.column).toBe("blocked");
  expect(after.qcState?.activeReviewId).toBeNull();
  expect(store.runs.listForTask(t.id)).toHaveLength(runsBefore);
  expect(pidFiles().length).toBe(pidsBefore);

  // A recorded process that is gone is reported as not found, never as "exited".
  const goneRun = `restart-gone-${Date.now()}`;
  const dead = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
  await dead.exited;
  store.db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, tmux_session) VALUES (?, ?, 'codex', 'running', ?, 'agetor-gone-session-2')`, [goneRun, t.id, Date.now()]);
  reconcileDb.runTerminations.request(goneRun, "time-limit");
  reconcileDb.runTerminations.record(goneRun, { outcome: "unconfirmed", processId: dead.pid, processStarted: "Thu Jan  1 00:00:00 1970", note: "x" });
  await orchestrator.reconcileOrphans();
  const gone = reconcileDb.runTerminations.get(goneRun)!;
  expect(gone.outcome).toBe("recovered-gone");
  expect(gone.note).toContain("no process with the recorded id was found");
  expect(gone.outcome).not.toBe("exited");
  sleeper.kill();
}, 90_000);
