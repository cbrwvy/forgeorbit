/**
 * Child process for run-stop-orphan.test.ts: it stands in for an app that is stopped while a Stop it issued
 * is still unconfirmed. It starts a run (a Developer, or a Reviewer after a finished Developer), makes SIGTERM and
 * SIGKILL ineffective, issues Stop, prints the run id, and waits to be killed without cleanup.
 */
const [, , taskId, mode] = process.argv;
const orchestrator = await import("./orchestrator.ts");
const termination = await import("./process-termination.ts");
const store = await import("./db.ts");
termination.__setTerminationTimingForTest({ graceMs: 600, termMs: 400, killMs: 600, pollMs: 40 });

async function until(check: () => boolean, label: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await Bun.sleep(50);
  if (!check()) { console.error(`timed out waiting (${label})`); process.exit(3); }
}

let runId: string;
if (mode === "reviewer") {
  const dev = await orchestrator.startTask(taskId!);
  if ("error" in dev) { console.error(dev.error); process.exit(2); }
  await until(() => store.tasks.get(taskId!)?.column === "review", "the Developer run to finish");
  const qc = await import("./task-quality-control.ts");
  const prepared = qc.prepareQcReview({ taskId, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  const review = await qc.startQcReview(prepared.review.id);
  if ("error" in review) { console.error(review.error); process.exit(2); }
  runId = review.runId;
} else {
  const started = await orchestrator.startTask(taskId!);
  if ("error" in started) { console.error(started.error); process.exit(2); }
  runId = started.runId;
}
await until(() => !!store.runs.get(runId)?.codexSessionId, "the run to report its session id");
termination.__setProcessControlForTest({ ...termination.systemProcessControl, signal: () => undefined });
const result = await orchestrator.stopRun(runId);
console.log(`unconfirmed ${runId} ${result.termination?.outcome}`);
setInterval(() => undefined, 1000);
