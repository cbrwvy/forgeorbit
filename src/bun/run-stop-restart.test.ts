/**
 * An app restart while a supervised run is live: the run's tmux session and process survive, the next boot reattaches
 * to it, and the time limit that was armed before the restart is still enforced. Nothing is relaunched. A child process
 * plays the app that stopped; it is killed without cleanup.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-restart-")));
const STUB = path.join(ROOT, "codex-stub.sh");
const PIDS = path.join(ROOT, "pids");
mkdirSync(PIDS);
writeFileSync(STUB, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.200.0"; exit 0;;
  --help) echo "codex stub"; exit 0;;
esac
if [ "$1" = "exec" ]; then
  n=$(ls "${PIDS}" | wc -l | tr -d ' ')
  echo $$ > "${PIDS}/$((n + 1)).pid"
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"stub-thread"}'
  while :; do sleep 1; done
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
  FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS: "6",
};
Object.assign(process.env, env);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
let stubPid = 0;
afterAll(() => { if (stubPid) { try { process.kill(-stubPid, "SIGKILL"); } catch { /* gone */ } } });

test("a limit armed before a restart is enforced after the run is reattached, and nothing is relaunched", async () => {
  const store = await import("./db.ts");
  const orchestrator = await import("./orchestrator.ts");
  store.harnesses.setEnabled("codex", true);
  const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-restart-proj-")));
  store.projects.upsert(workdir, "restart");
  const created = await orchestrator.createTask({ title: "restart limit", prompt: "Do it", workdir, column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // The "previous app": starts the run under the 6 s limit, then is killed with no cleanup.
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "run-stop-restart.child.ts"), taskId], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
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
  const until = Date.now() + 30_000;
  while (!out.includes("started ") && Date.now() < until) await Bun.sleep(100);
  if (!out.includes("started ")) child.kill("SIGKILL");
  expect(out.includes("started ") ? out : await new Response(child.stderr).text()).toContain("started ");
  const runId = out.trim().split(" ")[1]!;
  const armedAt = Date.now();
  stubPid = Number(readFileSync(path.join(PIDS, readdirSync(PIDS)[0]!), "utf8").trim());
  child.kill("SIGKILL");
  await child.exited;
  expect(alive(stubPid)).toBe(true);

  // Still running in the database, with the deadline recorded and nothing requested yet.
  const { runTerminations } = await import("./run-terminations.ts");
  expect(store.runs.get(runId)?.status).toBe("running");
  const armed = runTerminations.get(runId)!;
  expect(armed.limitSeconds).toBe(6);
  expect(armed.requestedAt).toBeNull();
  const launches = readdirSync(PIDS).length;

  // The next boot: reattach, never relaunch.
  await orchestrator.reconcileOrphans();
  expect(store.runs.get(runId)?.status).toBe("running");
  expect(orchestrator.isTaskRunLive(taskId)).toBe(true);
  expect(readdirSync(PIDS).length).toBe(launches);

  // The limit that was armed before the restart still fires, through the same stop path.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && store.runs.get(runId)?.status === "running") await Bun.sleep(100);
  expect(store.runs.get(runId)?.status).toBe("cancelled");
  expect(Date.now() - armedAt).toBeGreaterThan(3000);
  const row = runTerminations.get(runId)!;
  expect(row.reason).toBe("time-limit");
  expect(row.outcome).toBe("exited");
  expect(alive(stubPid)).toBe(false);
  expect(store.tasks.get(taskId)?.column).toBe("ready");
  expect(store.runs.listForTask(taskId)).toHaveLength(1);
  expect(readdirSync(PIDS).length).toBe(launches);
}, 120_000);
