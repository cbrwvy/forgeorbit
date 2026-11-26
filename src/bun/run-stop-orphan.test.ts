/**
 * The restart case where a run is orphaned but its original process is still alive: the Stop that was issued before the
 * restart was never confirmed, the tmux session is gone, and the next boot can identify the process by its recorded id.
 * A child process plays the app that stopped. The task must not start another process while that one lives, and must
 * return to its normal manual flow once it is confirmed gone. Nothing here signals the old process.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-orphan-")));
const STUB = path.join(ROOT, "codex-stub.sh");
const PIDS = path.join(ROOT, "pids");
const BEHAVIOR = path.join(ROOT, "behavior");
mkdirSync(PIDS);
writeFileSync(BEHAVIOR, "");
writeFileSync(STUB, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.200.0"; exit 0;;
  --help) echo "codex stub"; exit 0;;
esac
if [ "$1" = "exec" ]; then
  n=$(ls "${PIDS}" | wc -l | tr -d ' ')
  echo $$ > "${PIDS}/$((n + 1)).pid"
  behavior=$(head -n 1 "${BEHAVIOR}")
  tail -n +2 "${BEHAVIOR}" > "${BEHAVIOR}.tmp" && mv "${BEHAVIOR}.tmp" "${BEHAVIOR}"
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"stub-thread"}'
  case "$behavior" in
    hold) while :; do sleep 1; done;;
    hold-ignore) trap '' HUP TERM; while :; do sleep 1; done;;
  esac
  echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
fi
exit 0
`);
chmodSync(STUB, 0o755);
const env = {
  AGETOR_DATA_DIR: path.join(ROOT, "data"),
  AGETOR_CODEX_BIN: STUB,
  AGETOR_SKIP_CLI_VERSION_FLOOR: "1",
  AGETOR_USAGE_OFFLINE: "1",
  AGETOR_DISABLE_UPDATES: "1",
};
Object.assign(process.env, env);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const spawned: number[] = [];
let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let qc: typeof import("./task-quality-control.ts");
let terminations: typeof import("./run-terminations.ts");

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  qc = await import("./task-quality-control.ts");
  terminations = await import("./run-terminations.ts");
  store.harnesses.setEnabled("codex", true);
});
afterAll(() => { for (const pid of spawned) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });

async function newTask(title: string): Promise<string> {
  const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-orphan-proj-")));
  store.projects.upsert(workdir, title);
  const created = await orchestrator.createTask({ title, prompt: `Do ${title}`, workdir, column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

/** Run the "previous app" child to the point of an unconfirmed Stop, kill it, and return the live stub's pid. */
async function previousApp(taskId: string, mode: "developer" | "reviewer", lines: string[]): Promise<{ runId: string; pid: number }> {
  writeFileSync(BEHAVIOR, lines.map((line) => `${line}\n`).join(""));
  const before = readdirSync(PIDS).length;
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "run-stop-orphan.child.ts"), taskId, mode], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  let out = "";
  void (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      out += decoder.decode(chunk.value);
    }
  })();
  const deadline = Date.now() + 60_000;
  while (!out.includes("unconfirmed ") && Date.now() < deadline) await Bun.sleep(100);
  if (!out.includes("unconfirmed ")) { child.kill("SIGKILL"); throw new Error(`child did not reach an unconfirmed stop: ${await new Response(child.stderr).text()}`); }
  child.kill("SIGKILL");
  await child.exited;
  const [, runId, outcome] = out.trim().split(" ");
  expect(outcome).toBe("unconfirmed");
  const pid = Number(readFileSync(path.join(PIDS, readdirSync(PIDS).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]))[before + (mode === "reviewer" ? 1 : 0)]!), "utf8").trim());
  spawned.push(pid);
  return { runId: runId!, pid };
}

test("an orphaned Developer run whose process is still alive blocks every start until that process is confirmed gone", async () => {
  const taskId = await newTask("orphan developer");
  const { runId, pid } = await previousApp(taskId, "developer", ["hold-ignore", "hold"]);
  expect(alive(pid)).toBe(true);

  await orchestrator.reconcileOrphans();
  expect(store.runs.get(runId)?.status).toBe("orphaned");
  const recovered = terminations.runTerminations.get(runId)!;
  expect(recovered.outcome).toBe("recovered-alive");
  expect(recovered.processId).toBe(pid);
  expect(store.tasks.get(taskId)?.column).toBe("ready");
  expect(orchestrator.isTaskRunLive(taskId)).toBe(false);

  const runsBefore = store.runs.listForTask(taskId).length;
  const launchesBefore = readdirSync(PIDS).length;
  // Run again, from the card or from a supervised launch: refused, and nothing is launched or signalled.
  const again = await orchestrator.startTask(taskId);
  expect("error" in again && again.error).toContain(`process ${pid}`);
  const supervised = await orchestrator.startTask(taskId, { supervisedRun: true });
  expect("error" in supervised).toBe(true);
  // A follow-up message to the orphaned run is refused the same way.
  const followUp = await orchestrator.sendInput(runId, "keep going");
  expect(followUp.delivered).toBe(false);
  expect(!followUp.delivered && followUp.reason).toContain(`process ${pid}`);
  expect(store.runs.listForTask(taskId)).toHaveLength(runsBefore);
  expect(readdirSync(PIDS).length).toBe(launchesBefore);
  expect(alive(pid)).toBe(true);
  expect(store.tasks.get(taskId)?.column).toBe("ready");
  // The record still says the process was not stopped; it is never reworded as an exit.
  expect(terminations.runTerminations.get(runId)?.outcome).toBe("recovered-alive");

  // Once the original process is confirmed gone (here: killed from outside), the same task starts normally again.
  process.kill(-pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
  expect(alive(pid)).toBe(false);
  const restarted = await orchestrator.startTask(taskId);
  if ("error" in restarted) throw new Error(restarted.error);
  for (let i = 0; i < 100 && readdirSync(PIDS).length === launchesBefore; i++) await Bun.sleep(50);
  const second = Number(readFileSync(path.join(PIDS, readdirSync(PIDS).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0])).at(-1)!), "utf8").trim());
  spawned.push(second);
  expect(readdirSync(PIDS).length).toBe(launchesBefore + 1);
  expect(terminations.runTerminations.get(runId)?.outcome).toBe("recovered-gone");
  await orchestrator.stopRun(restarted.runId);
}, 150_000);

test("an orphaned Reviewer run whose process is still alive blocks a new review and a re-run, and releases both once it is gone", async () => {
  const taskId = await newTask("orphan reviewer");
  const { runId, pid } = await previousApp(taskId, "reviewer", ["finish", "hold-ignore", "hold"]);
  expect(alive(pid)).toBe(true);

  await orchestrator.reconcileOrphans();
  const review = store.taskQualityReviews.listForTask(taskId)[0]!;
  expect(store.runs.get(runId)?.status).toBe("orphaned");
  expect(store.runs.get(runId)?.qcReviewId).toBe(review.id);
  // The review is settled without a verdict and the task is blocked, as for any other failed review.
  expect(review.status).toBe("complete");
  expect(review.verdict).toBeNull();
  expect(store.tasks.get(taskId)?.column).toBe("blocked");
  expect(terminations.runTerminations.get(runId)?.outcome).toBe("recovered-alive");
  // The Reviewer run, not the finished implementation, is the one that was left behind.
  expect(store.runs.get(runId)?.qcReviewId).not.toBeNull();

  const runsBefore = store.runs.listForTask(taskId).length;
  const launchesBefore = readdirSync(PIDS).length;
  const before = store.tasks.get(taskId)!;
  // The Owner moves the blocked task back to Review and asks for another review: refused while the process lives.
  store.tasks.update(taskId, { column: "review" });
  const implementationRunId = store.runs.listForTask(taskId).find((r) => !r.qcReviewId && r.status === "succeeded")!.id;
  const prepared = qc.prepareQcReview({ taskId, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" }, { implementationRunId });
  const started = await qc.startQcReview(prepared.review.id);
  expect("error" in started && started.error).toContain(`process ${pid}`);
  expect((await orchestrator.startTask(taskId)) && "error").toBeTruthy();
  expect(store.runs.listForTask(taskId)).toHaveLength(runsBefore);
  expect(readdirSync(PIDS).length).toBe(launchesBefore);
  expect(alive(pid)).toBe(true);
  const after = store.tasks.get(taskId)!;
  expect([after.agent, after.prompt, after.mode, after.model]).toEqual([before.agent, before.prompt, before.mode, before.model]);
  expect(after.qcState?.activeReviewId).toBeNull();
  expect(store.taskQualityReviews.get(prepared.review.id)?.status).toBe("cancelled");

  process.kill(-pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
  const next = qc.prepareQcReview({ taskId, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" }, { implementationRunId });
  const relaunched = await qc.startQcReview(next.review.id);
  if ("error" in relaunched) throw new Error(relaunched.error);
  spawned.push(Number(readFileSync(path.join(PIDS, readdirSync(PIDS).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0])).at(-1)!), "utf8").trim()));
  expect(terminations.runTerminations.get(runId)?.outcome).toBe("recovered-gone");
  await orchestrator.stopRun(relaunched.runId);
}, 180_000);

test("a stop that left no recorded process, or one that was confirmed, never blocks a start", async () => {
  const taskId = await newTask("clean orphan");
  const launches = readdirSync(PIDS).length;
  writeFileSync(BEHAVIOR, "hold\n");
  const first = await orchestrator.startTask(taskId);
  if ("error" in first) throw new Error(first.error);
  for (let i = 0; i < 100 && readdirSync(PIDS).length === launches; i++) await Bun.sleep(50);
  const stopped = await orchestrator.stopRun(first.runId);
  expect(stopped.termination?.outcome).toBe("exited");
  for (let i = 0; i < 100 && store.runs.get(first.runId)?.status === "running"; i++) await Bun.sleep(50);
  writeFileSync(BEHAVIOR, "hold\n");
  const second = await orchestrator.startTask(taskId);
  expect("error" in second).toBe(false);
  if (!("error" in second)) await orchestrator.stopRun(second.runId);
}, 90_000);

test("a project that was stopped stays Draining while a stopped run's process is not confirmed gone, across a restart, and settles only when it is", async () => {
  const taskId = await newTask("drain with orphan");
  const workdir = store.tasks.get(taskId)!.workdir;
  const lifecycle = await import("./project-lifecycle.ts");
  const { runId, pid } = await previousApp(taskId, "developer", ["hold-ignore", "hold"]);
  expect(alive(pid)).toBe(true);

  // The restart: the run is orphaned, its process is recorded as still running.
  await orchestrator.reconcileOrphans();
  expect(terminations.runTerminations.get(runId)?.outcome).toBe("recovered-alive");
  expect(orchestrator.isTaskRunLive(taskId)).toBe(false);

  // Owner stops the project. Nothing is "running" by the run table, but a process may be: it must read as Draining.
  const stopped = await lifecycle.stopProjectLifecycle(workdir, "test stop");
  expect(stopped.lifecycle.state).toBe("draining");
  expect(stopped.lifecycle.activeExecutions).toBe(1);
  expect(stopped.lifecycle.activeBreakdown.unconfirmedProcesses).toBe(1);
  expect(stopped.lifecycle.canStart).toBe(false);

  // A second restart does not settle it, and Start is refused while the process lives.
  lifecycle.reconcileProjectLifecyclesOnBoot();
  expect(lifecycle.getProjectLifecycle(workdir)?.state).toBe("draining");
  await expect(lifecycle.startProjectLifecycle(workdir)).rejects.toThrow();
  const refused = await orchestrator.startTask(taskId);
  expect("error" in refused).toBe(true);
  expect(alive(pid)).toBe(true);

  // Repeated Stop is idempotent: no new state, still draining.
  const again = await lifecycle.stopProjectLifecycle(workdir);
  expect(again.changed).toBe(false);
  expect(again.lifecycle.state).toBe("draining");

  // The process is observed gone: the watch (or the next read) settles the project to Paused. Never before.
  process.kill(-pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
  expect(alive(pid)).toBe(false);
  for (let i = 0; i < 140 && store.projects.getLifecycleRaw(workdir)?.lifecycleState !== "paused"; i++) await Bun.sleep(100);
  expect(store.projects.getLifecycleRaw(workdir)?.lifecycleState).toBe("paused");
  // Paused is not Running: the Owner must still Start, and Start creates no run.
  const runsBefore = store.runs.listForTask(taskId).length;
  const started = await lifecycle.startProjectLifecycle(workdir);
  expect(started.lifecycle.state).toBe("running");
  expect(store.runs.listForTask(taskId)).toHaveLength(runsBefore);
  expect(store.tasks.get(taskId)?.column).toBe("ready");
}, 150_000);
