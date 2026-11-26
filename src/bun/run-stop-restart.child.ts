/**
 * Child process for run-stop-restart.test.ts: it starts one supervised run under a time limit, prints its ids, and
 * then waits to be killed, standing in for an app that stops while the run's tmux session stays alive.
 */
const [, , taskId] = process.argv;
const orchestrator = await import("./orchestrator.ts");
const { runs, tasks } = await import("./db.ts");
const started = await orchestrator.startTask(taskId!, { supervisedRun: true });
if ("error" in started) { console.error(started.error); process.exit(2); }
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !runs.get(started.runId)?.codexSessionId) await Bun.sleep(50);
console.log(`started ${started.runId} ${tasks.get(taskId!)?.runId}`);
setInterval(() => undefined, 1000);
