import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, writeFxStubBin } from "../../e2e/isolated-env.ts";

test("bounded fixture reuses employee/QC persistence and real backend recovery without relaunch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-bounded-workflow-"));
  const dataDir = path.join(root, "data"), project = path.join(root, "project");
  mkdirSync(project);
  const bin = path.join(root, "claude-fixture");
  writeFileSync(bin, `#!${process.execPath}\n${readFileSync(path.join(import.meta.dir, "claude-bounded-print.fixture.ts"), "utf8")}`, { mode: 0o700 });
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = portProbe.port!; portProbe.stop(true);
  const token = crypto.randomUUID(), base = `http://127.0.0.1:${port}`;
  const env = isolatedCoreEnv({ dataDir, apiPort: port, apiToken: token, fxBin: writeFxStubBin(dataDir), extra: {
    AGETOR_CLAUDE_DRIVER: "offline-executable-fixture", TMPDIR: root,
  } });
  let child: ChildProcess | undefined;
  const log = createWriteStream(path.join(root, "backend.log"));
  const poll = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(25); }
    throw new Error(`Timed out; ${readFileSync(path.join(root, "backend.log"), "utf8").slice(-1000)}`);
  };
  async function start() {
    child = spawn(process.execPath, ["--no-env-file", "src/bun/headless.ts"], { cwd: path.resolve(import.meta.dir, "../.."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
    await poll(async () => { if (child!.exitCode !== null) throw new Error("Backend exited"); return fetch(`${base}/health`).then(r => r.ok, () => false); });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const owned = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { owned.kill("SIGKILL"); reject(new Error("Owned backend shutdown timed out")); }, 5000);
      owned.once("exit", () => { clearTimeout(timer); resolve(); }); owned.kill("SIGTERM");
    });
  }
  async function api(method: string, endpoint: string, body?: unknown): Promise<any> {
    const response = await fetch(base + endpoint, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  }
  const launches = () => existsSync(path.join(project, ".fixture-launches")) ? readFileSync(path.join(project, ".fixture-launches"), "utf8").trim().split("\n").map(s => JSON.parse(s)) : [];
  try {
    await start();
    await api("POST", "/projects", { path: project, name: "Bounded offline fixture" });
    await api("POST", "/harnesses", { id: "bounded-fixture", kind: "claude-code", label: "Offline executable fixture", home: path.join(root, "cli-config"), bin });
    const employee = await api("POST", "/employees", { name: "Fixture Developer", jobTitle: "Developer", projectPath: project });
    async function prepare(prompt: string) {
      const created = await api("POST", "/tasks", { title: "Offline bounded task", prompt, workdir: project, column: "backlog", agent: "bounded-fixture", model: "haiku-5.5", effort: "low", mode: "bounded-print", isolation: "none" });
      const task = created.task ?? created;
      await api("POST", `/tasks/${task.id}/admit-inbox`);
      await api("PATCH", `/tasks/${task.id}`, { column: "ready" });
      await api("POST", "/task-assignments", { taskId: task.id, employeeId: employee.id });
      const review = await api("POST", "/employee-execution/reviews", { taskId: task.id, harnessId: "bounded-fixture", model: "haiku-5.5", effort: "low" });
      expect(review.blockingErrors).toEqual([]);
      expect(JSON.stringify(review)).toContain("bounded-print-policy");
      const started = await api("POST", `/employee-execution/attempts/${review.attempt.id}/start`, { revision: review.attempt.revision, confirm: true, acknowledgeUsage: true });
      return { task, started, attempt: review.attempt };
    }
    const { task, attempt } = await prepare("fixture-case:success");
    await poll(async () => (await api("GET", `/tasks/${task.id}`)).column === "review");
    const implementationRuns = await api("GET", `/tasks/${task.id}/runs`);
    expect(implementationRuns).toHaveLength(1);
    expect(implementationRuns[0]).toMatchObject({ status: "succeeded", tmuxSession: null, claudeSessionId: null });
    expect((await api("GET", `/employee-execution/attempts/${attempt.id}`)).attempt.result).toBe("succeeded");
    const prepared = await api("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "bounded-fixture", reviewerModel: "haiku-5.5" });
    await api("POST", `/tasks/${task.id}/qc/reviews/${prepared.review.id}/start`);
    await poll(async () => (await api("GET", `/tasks/${task.id}/qc`)).state.latestVerdict === "PASS");
    const before = await api("GET", `/tasks/${task.id}/runs`);
    expect(before).toHaveLength(2);
    expect(new Set(before.map((r: any) => r.id)).size).toBe(2);
    expect(launches()).toHaveLength(2);
    const reviewerArgs = launches()[1].argv as string[];
    expect(reviewerArgs[reviewerArgs.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
    await stop(); await start();
    expect((await api("GET", `/tasks/${task.id}`)).column).toBe("review");
    expect((await api("GET", `/tasks/${task.id}/qc`)).state.awaitingOwnerApproval).toBe(true);
    expect((await api("GET", `/tasks/${task.id}/runs`)).map((r: any) => r.id)).toEqual(before.map((r: any) => r.id));
    expect(launches()).toHaveLength(2);
    // Offline API acknowledgement only; this is not live/UI Owner acceptance.
    expect((await api("PATCH", `/tasks/${task.id}`, { column: "done" })).qcState.awaitingOwnerApproval).toBe(false);
    const failed = await prepare("fixture-case:exit-failure");
    await poll(async () => (await api("GET", `/tasks/${failed.task.id}`)).column === "ready");
    expect((await api("GET", `/tasks/${failed.task.id}/runs`))[0].status).toBe("failed");
    expect((await api("GET", `/employee-execution/attempts/${failed.attempt.id}`)).attempt.result).toBe("failed");
    const cancelled = await prepare("fixture-case:timeout");
    await poll(async () => launches().length === 4);
    const cancelledRun = (await api("GET", `/tasks/${cancelled.task.id}/runs`))[0];
    await api("POST", `/runs/${cancelledRun.id}/cancel`);
    await poll(async () => (await api("GET", `/tasks/${cancelled.task.id}/runs`))[0].status === "cancelled");
    expect((await api("GET", `/tasks/${cancelled.task.id}`)).column).toBe("ready");
    const interrupted = await prepare("fixture-case:timeout");
    await poll(async () => launches().length === 5);
    await stop(); await start();
    const recovered = await api("GET", `/tasks/${interrupted.task.id}/runs`);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe("orphaned");
    expect((await api("GET", `/tasks/${interrupted.task.id}`)).column).toBe("ready");
    await Bun.sleep(150);
    expect(launches()).toHaveLength(5);
  } finally { await stop(); log.end(); }
}, 60_000);
