/** The tmux-hosted stop against real processes: observed exit, escalation, and what is reported when nothing works. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-process-termination-")));
process.env.AGETOR_DATA_DIR = path.join(ROOT, "data");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const spawned: number[] = [];
let spawnCodexViaTmux: typeof import("./codex-tmux.ts").spawnCodexViaTmux;
let termination: typeof import("./process-termination.ts");

beforeAll(async () => {
  ({ spawnCodexViaTmux } = await import("./codex-tmux.ts"));
  termination = await import("./process-termination.ts");
  termination.__setTerminationTimingForTest({ graceMs: 1200, termMs: 800, killMs: 1200, pollMs: 40 });
});
afterAll(() => {
  termination.__setProcessControlForTest(null);
  termination.__setTerminationTimingForTest(null);
  for (const pid of spawned) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
});

async function launch(name: string, hup: "default" | "ignore") {
  const pidFile = path.join(ROOT, `${name}.pid`);
  const bin = path.join(ROOT, `${name}.sh`);
  writeFileSync(bin, `#!/bin/sh\necho $$ > "${pidFile}"\ncat >/dev/null\necho '{"type":"thread.started","thread_id":"t"}'\n${hup === "ignore" ? "trap '' HUP TERM\n" : ""}while :; do sleep 1; done\n`);
  chmodSync(bin, 0o755);
  const agent = await spawnCodexViaTmux({ taskId: `task-${name}`, runId: `run-${name}-${Date.now()}`, argv: [bin, "exec", "-"], env: {}, cwd: ROOT, promptText: "hi", onChunk: () => undefined });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  spawned.push(pid);
  return { agent, pid };
}
const settled = (agent: { done: Promise<number> }, ms = 6000) => Promise.race([agent.done.then(() => true), Bun.sleep(ms).then(() => false)]);

test("a process that accepts the hang-up is observed to exit before the run may settle", async () => {
  const { agent, pid } = await launch("plain", "default");
  const evidence = await agent.terminate!();
  expect(evidence.outcome).toBe("exited");
  expect(evidence.processId).toBe(pid);
  expect(evidence.methods).toEqual(["session-kill"]);
  expect(alive(pid)).toBe(false);
  expect(await settled(agent)).toBe(true);
});

test("a process that ignores the hang-up and SIGTERM is escalated to SIGKILL and only then reported exited", async () => {
  const { agent, pid } = await launch("stubborn", "ignore");
  const evidence = await agent.terminate!();
  expect(evidence.outcome).toBe("exited");
  expect(evidence.methods).toEqual(["session-kill", "sigterm", "sigkill"]);
  expect(alive(pid)).toBe(false);
  expect(await settled(agent)).toBe(true);
});

test("when nothing stops it the outcome is unconfirmed and done does not resolve until the process is gone", async () => {
  const { agent, pid } = await launch("unkillable", "ignore");
  termination.__setProcessControlForTest({ ...termination.systemProcessControl, signal: () => undefined });
  let evidence: Awaited<ReturnType<NonNullable<typeof agent.terminate>>>;
  try {
    evidence = await agent.terminate!();
  } finally {
    termination.__setProcessControlForTest(null);
  }
  expect(evidence.outcome).toBe("unconfirmed");
  expect(evidence.processId).toBe(pid);
  expect(alive(pid)).toBe(true);
  // The driver's own death watch does not mistake the closed session for an exit.
  expect(await settled(agent, 2500)).toBe(false);
  process.kill(-pid, "SIGKILL");
  expect(await settled(agent, 8000)).toBe(true);
  expect(alive(pid)).toBe(false);
}, 30_000);

test("a stop with no live session reports that nothing was found, not that something exited", async () => {
  const evidence = await termination.terminateTmuxHostedProcess("agetor-no-such-session");
  expect(evidence.outcome).toBe("no-process");
  expect(evidence.processId).toBeNull();
});

test("a recorded process is rechecked as gone, alive, or unknown, and a reused id never counts as alive", async () => {
  const sleeper = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(sleeper.pid);
  const started = await termination.processControl().startedAt(sleeper.pid);
  expect(started).toBeTruthy();
  expect(await termination.recheckRecordedProcess(sleeper.pid, started)).toBe("alive");
  expect(await termination.recheckRecordedProcess(sleeper.pid, "Thu Jan  1 00:00:00 1970")).toBe("gone");
  expect(await termination.recheckRecordedProcess(sleeper.pid, null)).toBe("unknown");
  expect(await termination.recheckRecordedProcess(null, null)).toBe("unknown");
  sleeper.kill();
  await sleeper.exited;
  expect(await termination.recheckRecordedProcess(sleeper.pid, started)).toBe("gone");
});
