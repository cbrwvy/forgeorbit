import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, writeFxStubBin } from "../../e2e/isolated-env.ts";

import { Database } from "bun:sqlite";
test("FO-LIVE-READY01 offline bounded batch acceptance, grants, cancellation, restart and no fallback", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-live-ready01-"));
  const dataDir = path.join(root, "data"), project = path.join(root, "project");
  mkdirSync(project);
  const bin = path.join(root, "claude-fixture");
  writeFileSync(bin, `#!${process.execPath}\n${readFileSync(path.join(import.meta.dir, "claude-bounded-print.fixture.ts"), "utf8")}`, { mode: 0o700 });
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = portProbe.port!; portProbe.stop(true);
  const token = crypto.randomUUID(), base = `http://127.0.0.1:${port}`;
  // Synthetic persistent profile is a sibling of all disposable core data.
  const authHome = path.join(root, "synthetic-login-home");
  const qaProfile = path.join(authHome, "qa-profile"), temporary = path.join(root, "temporary");
  mkdirSync(qaProfile, {recursive:true}); mkdirSync(temporary);
  writeFileSync(path.join(qaProfile, "synthetic-marker"), "not credentials");
  const env = isolatedCoreEnv({ dataDir, apiPort: port, apiToken: token, fxBin: writeFxStubBin(dataDir), extra: {
    AGETOR_CLAUDE_DRIVER: "offline-executable-fixture", TMPDIR: temporary, FORGEORBIT_CLAUDE_QA_CONFIG_DIR: qaProfile,
    FORGEORBIT_CLAUDE_QA_AUTH_HOME: authHome, FORGEORBIT_CLAUDE_QA_AUTH_HOME_ACCEPTANCE: "allow-home-access",
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
  async function api(method: string, endpoint: string, body?: unknown, expectedStatus?: number): Promise<any> {
    const response = await fetch(base + endpoint, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (expectedStatus) { expect(response.status).toBe(expectedStatus); return result; }
    if (!response.ok) throw new Error(`${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  }
  const launches = () => existsSync(path.join(project, ".fixture-launches")) ? readFileSync(path.join(project, ".fixture-launches"), "utf8").trim().split("\n").map(s => JSON.parse(s)) : [];
  try {
    await start();
    await api("POST", "/projects", { path: project, name: "Bounded offline fixture" });
    await api("POST", "/harnesses", { id: "bounded-fixture", kind: "claude-code", label: "Offline executable fixture", home: path.join(root, "cli-config"), bin });
    const employee = await api("POST", "/employees", { name: "Fixture Developer", jobTitle: "Developer", projectPath: project });
    const projectB = path.join(root, "project-b"); mkdirSync(projectB);
    await api("POST", "/projects", {path:projectB, name:"Untouched Project B"});
    async function task(title: string, prompt = "fixture-case:success", dir = project) {
      const created = await api("POST", "/tasks", {title, prompt, workdir:dir, column:"backlog", agent:"bounded-fixture", model:"haiku-5.5", effort:"low", mode:"bounded-print", isolation:"none"});
      const t = created.task ?? created;
      await api("POST", `/tasks/${t.id}/admit-inbox`);
      await api("PATCH", `/tasks/${t.id}`, {column:"ready"});
      if (dir === project) await api("POST", "/task-assignments", {taskId:t.id,employeeId:employee.id});
      return t;
    }
    const baseBody = (maxLaunches = 2) => ({implementerEmployeeId:employee.id,implementerHarnessId:"bounded-fixture",implementerModel:"haiku-5.5",implementerEffort:"low",implementerMode:"bounded-print",reviewerHarness:"bounded-fixture",reviewerModel:"haiku-5.5",reviewerMode:"bounded-print",autoReviewAfterImplementation:true,autoReworkOnChanges:false,maxLaunches,maxReworkIterations:0});
    const batchPath = (id:string) => `/project-manager/orchestrated-batches/${id}`;
    const getBatch = (id:string) => api("GET", batchPath(id)+`?path=${encodeURIComponent(project)}`);
    async function batch(ids:string[], maxLaunches = 2) {
      const draft = await api("POST", "/project-manager/orchestrated-batches", {path:project,taskIds:ids});
      const countBeforeApproval = launches().length;
      await api("POST", batchPath(draft.batch.id)+"/start", {path:project}, 409);
      expect(launches()).toHaveLength(countBeforeApproval);
      const approved = await api("POST", batchPath(draft.batch.id)+"/approve", {path:project, revision:draft.batch.revision,defaults:baseBody(maxLaunches)});
      expect(approved.tasks.map((t:any)=>t.taskId)).toEqual(ids);
      expect(approved.tasks[0].execution).toMatchObject({implementerMode:"bounded-print",reviewerMode:"bounded-print",boundedPolicy:{maxTurns:6,maxBudgetUsd:0.25,developerTools:["Read","Glob","Grep","Edit","Write"],reviewerTools:["Read","Glob","Grep"]}});
      return draft.batch.id as string;
    }
    const action = (id:string, name:string, expected?:number) => api("POST", batchPath(id)+"/"+name,{path:project},expected);
    const runIds = async (id:string) => (await api("GET", `/tasks/${id}/runs`)).map((r:any)=>r.id);
    const other = await task("Project B remains untouched", "fixture-case:success", projectB);
    const originalB = await api("GET", `/tasks/${other.id}`);
    const a = await task("A"), b = await task("B", "fixture-case:changes"), c = await task("C");
    const id = await batch([a.id,b.id,c.id]);
    await action(id,"start");
    await poll(async()=> (await getBatch(id)).batch.status === "paused");
    const paused = await getBatch(id);
    expect(paused.batch.progress.pauseReason).toContain("Review requested changes");
    expect(paused.tasks.map((t:any)=>t.phase)).toEqual(["awaiting_owner","paused","queued"]);
    expect(paused.tasks.map((t:any)=>t.remainingLaunches)).toEqual([0,0,2]);
    expect((await api("GET", `/tasks/${a.id}`)).column).toBe("review");
    expect((await api("GET", `/tasks/${a.id}/qc`)).state.awaitingOwnerApproval).toBe(true);
    expect((await api("GET", `/tasks/${b.id}/qc`)).state.latestVerdict).toBe("CHANGES_REQUESTED");
    expect(await runIds(c.id)).toEqual([]);
    const before = [await runIds(a.id),await runIds(b.id)];
    expect(before.map(v=>v.length)).toEqual([2,2]);
    expect(paused.tasks[0].launchedRuns.map((r:any)=>r.role)).toEqual(["implementation","review"]);
    expect(new Set(paused.tasks[0].launchedRuns.map((r:any)=>r.runId))).toEqual(new Set(before[0]));
    expect(new Set(before.flat()).size).toBe(4);
    expect(launches()).toHaveLength(4);
    for (const [i,launch] of launches().entries()) {
      expect(launch.argv).toContain("--print");
      expect(launch.argv[launch.argv.indexOf("--tools")+1]).toBe(i%2===0 ? "Read,Glob,Grep,Edit,Write":"Read,Glob,Grep");
      expect(launch.argv).not.toContain("--resume");
      expect(launch.orchestrationTokenPresent).toBe(false);
      expect(launch.home).toBe(authHome);
      expect(launch.home).not.toBe(env.HOME);
      expect(launch.configDirectory).toBe(qaProfile);
    }
    const usage = await api("GET", `/runs/${before[0][0]}/execution`);
    expect(usage).toMatchObject({type:"fixture",mode:"bounded-print",provider:"claude-code",turns:2,reportedCostUsd:0.001,configuredThresholdUsd:0.25,limitTermination:false,quota:"unknown",outcome:"succeeded"});
    expect((await api("GET", `/tasks/${a.id}/supervised-workflow`)).usesFakeDriver).toBe(false); // unrelated Codex is fake
    await action(id,"resume",409); // exhausted grant cannot silently authorize rework
    await stop(); await start();
    expect([await runIds(a.id),await runIds(b.id)]).toEqual(before);
    expect((await getBatch(id)).tasks.map((t:any)=>t.phase)).toEqual(["awaiting_owner","paused","queued"]);
    await action(id,"cancel");
    await action(id,"resume",409);
    expect(await runIds(c.id)).toEqual([]);
    // Owner pause/resume preserves the same grant and consumed launches, then cancellation blocks pending QC.
    const d = await task("D", "fixture-case:delayed"), e = await task("E");
    const resumable = await batch([d.id,e.id]); await action(resumable,"start");
    await poll(async()=> launches().length===5);
    await action(resumable,"pause");
    await poll(async()=> (await api("GET", `/tasks/${d.id}`)).column === "review");
    const wfBefore = (await api("GET", `/tasks/${d.id}/orchestrated-workflow`)).workflow;
    expect(wfBefore.counters.launchesUsed).toBe(1);
    expect(launches()).toHaveLength(5);
    await stop(); await start();
    expect((await getBatch(resumable)).batch.status).toBe("paused");
    expect((await api("GET", `/tasks/${d.id}/orchestrated-workflow`)).workflow.counters.launchesUsed).toBe(1);
    await action(resumable,"resume");
    await poll(async()=> launches().length>=6);
    await action(resumable,"cancel");
    await Bun.sleep(300);
    expect(await runIds(e.id)).toEqual([]);
    expect((await api("GET", `/tasks/${d.id}/orchestrated-workflow`)).workflow.id).toBe(wfBefore.id);
    // Expiry is a test clock simulation of only the authorization, never fabricated run/QC outcomes.
    const expiredTask = await task("expired"), expired = await batch([expiredTask.id]);
    await stop();
    const sqlite = new Database(path.join(dataDir,"agetor.sqlite"));
    const tables = sqlite.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.some(t=>t.name==="pm_orchestrated_batches")).toBe(true);
    const row = sqlite.query<{data_json:string},[string]>("SELECT data_json FROM pm_orchestrated_batches WHERE id = ?").get(expired)!;
    const data = JSON.parse(row.data_json); data.policy.expiresAt=Date.now()-1;
    sqlite.run("UPDATE pm_orchestrated_batches SET data_json = ? WHERE id = ?",[JSON.stringify(data),expired]); sqlite.close();
    await start(); await action(expired,"start",409);
    expect(await runIds(expiredTask.id)).toEqual([]);
    // Approved resource removed/disabled after approval: stop, never interactive fallback.
    const unavailableTask = await task("unavailable"), unavailable = await batch([unavailableTask.id]);
    await api("PATCH", "/harnesses/bounded-fixture", {enabled:false});
    await action(unavailable,"start");
    await poll(async()=> (await getBatch(unavailable)).batch.status === "paused");
    expect((await getBatch(unavailable)).blocker).toMatch(/resource|unavailable/i);
    expect(await runIds(unavailableTask.id)).toEqual([]);
    await api("PATCH", "/harnesses/bounded-fixture", {enabled:true});
    // One permitted launch cannot authorize QC. Failed bounded output cannot schedule the next task.
    const limitedTask = await task("limited"), limited = await batch([limitedTask.id],1);
    await action(limited,"start");
    await poll(async()=> (await getBatch(limited)).batch.status === "paused");
    expect((await getBatch(limited)).tasks[0].remainingLaunches).toBe(0);
    expect(await runIds(limitedTask.id)).toHaveLength(1);
    const failure = await task("turn termination","fixture-case:turn-limit"), afterFailure = await task("never started");
    const failed = await batch([failure.id,afterFailure.id]); await action(failed,"start");
    await poll(async()=> (await getBatch(failed)).batch.status === "paused");
    const failedRuns = await runIds(failure.id);
    expect(failedRuns).toHaveLength(1);
    expect(await api("GET", `/runs/${failedRuns[0]}/execution`)).toMatchObject({type:"fixture",outcome:"failed",limitTermination:true,turns:2,reportedCostUsd:0.001});
    await stop(); await start();
    await Bun.sleep(200);
    expect(await runIds(failure.id)).toEqual(failedRuns);
    expect(await runIds(afterFailure.id)).toEqual([]);
    expect(await api("GET", `/tasks/${other.id}`)).toEqual(originalB);
    expect(await runIds(other.id)).toEqual([]);
    expect(launches().every(l=>l.argv.includes("--print"))).toBe(true);
    const interruptedTask = await task("interrupted", "fixture-case:timeout"), afterInterrupted = await task("after interrupted");
    const interrupted = await batch([interruptedTask.id, afterInterrupted.id]);
    const launchCount = launches().length;
    await action(interrupted,"start");
    await poll(async()=>launches().length===launchCount+1);
    const interruptedIds = await runIds(interruptedTask.id);
    await stop(); await start();
    try { await poll(async()=> (await getBatch(interrupted)).batch.status === "paused"); }
    catch (error) { console.error(JSON.stringify({batch:await getBatch(interrupted),workflow:await api("GET", `/tasks/${interruptedTask.id}/orchestrated-workflow`),task:await api("GET", `/tasks/${interruptedTask.id}`)},null,2)); throw error; }
    expect((await getBatch(interrupted)).blocker).toContain("orphaned");
    expect(await runIds(interruptedTask.id)).toEqual(interruptedIds);
    expect(await runIds(afterInterrupted.id)).toEqual([]);
    expect(launches()).toHaveLength(launchCount+1);
  } finally {
    await stop(); log.end();
    expect(readFileSync(path.join(qaProfile, "synthetic-marker"), "utf8")).toBe("not credentials");
    rmSync(root,{recursive:true,force:true}); // Entire root is synthetic test-owned data.
  }
}, 60_000);
