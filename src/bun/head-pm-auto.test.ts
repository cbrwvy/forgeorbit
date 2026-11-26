import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeTask } from "../cli/test-fixtures.ts";

const root = mkdtempSync(path.join(tmpdir(), "fo-head-auto01-unit-"));
process.env.AGETOR_DATA_DIR = root;
process.env.AGETOR_API_PORT = "4499";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "1";
let store: typeof import("./db.ts"), head: typeof import("./head-pm-auto.ts"), initiatives: typeof import("./head-pm-initiative.ts"), batch: typeof import("./pm-orchestrated-batch.ts");
let server: {stop(): void}, token: string;
async function call(route: string, data?: unknown) {
  const r = await fetch(`http://127.0.0.1:4499${route}`, {method: data ? "POST" : "GET", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, body: data ? JSON.stringify(data) : undefined});
  const json = await r.json(); expect(r.ok, JSON.stringify(json)).toBe(true); return json as any;
}
beforeAll(async () => {
  store = await import("./db.ts"); head = await import("./head-pm-auto.ts"); initiatives = await import("./head-pm-initiative.ts"); batch = await import("./pm-orchestrated-batch.ts");
  const api = await import("./server.ts"); token = api.API_TOKEN; server = api.startApiServer() as any;
  (await import("./pm-orchestrated-workflow.ts")).initOrchestratedWorkflows(); head.initHeadAuto();
});
afterAll(() => { server?.stop(); rmSync(root, {recursive: true, force: true}); });
async function fixture(approved = true, delegated = true, firstPrompt = "Implement feature") {
  const paths: string[] = [], taskIds: string[] = [], ids: string[] = [];
  for (const name of ["Alpha", "Beta"]) {
    const dir = path.join(root, randomUUID());
    const git = Bun.spawnSync(["git", "init", "-q", dir]); expect(git.exitCode).toBe(0);
    writeFileSync(path.join(dir, "README.md"), name);
    store.projects.upsert(dir, name); paths.push(dir);
    const dev = await call("/employees", {name: `${name} Developer`, jobTitle: "Engineer", projectPath: dir});
    const t = store.tasks.insert(makeTask({id: randomUUID(), title: `${name} task`, prompt: name === "Alpha" ? firstPrompt : "Implement feature", workdir: dir, column: "ready", model: "opus-5.5", mode: "auto", isolation: "none"}));
    taskIds.push(t.id); await call("/task-assignments", {taskId: t.id, employeeId: dev.id});
    const d = batch.createOrchestratedBatchDraft(dir, {taskIds: [t.id]}); ids.push(d.batch.id);
    if (approved) await batch.approveOrchestratedBatch(dir, d.batch.id, {revision: d.batch.revision, queuePolicySchema: "legacy-auto02", defaults: {implementerEmployeeId: dev.id, implementerHarnessId: "claude-code", implementerModel: "opus-5.5", reviewerHarness: "claude-code", reviewerModel: "haiku-5.5", autoReworkOnChanges: false, maxReworkIterations: 0, maxLaunches: 2}});
  }
  const created = initiatives.createHeadPmInitiative({title: "Two projects", projectPaths: paths}); if (!created.ok) throw Error(created.error);
  const id = created.value.id;
  if (delegated) for (const dir of paths) {
    const prep = initiatives.prepareHeadPmDelegation(id, dir, {objective: "Work", request: "Prepare tasks"}); if (!prep.ok) throw Error(prep.error);
    // Unit fixture models independently approved/delivered delegation; E2E uses actual Owner controls.
    const d = {...prep.value.delegation, status: "answered"};
    store.portfolioManagerStore.putDelegation(d.id, dir, d.messageId, d.status, JSON.stringify(d), d.createdAt);
  }
  return {id, paths, taskIds, ids};
}
async function authorized() {
  const f = await fixture(); const v = head.prepareHeadAuto(f.id, f.ids); head.authorizeHeadAuto(f.id, v.record!.digest); return f;
}
async function until(fn: () => boolean, timeout = 45000) { const start = Date.now(); while (!fn() && Date.now()-start < timeout) await Bun.sleep(50); expect(fn()).toBe(true); }
function mutate(c: import("../shared/head-pm-auto.ts").HeadAutoRecord) { store.db.run("UPDATE head_pm_auto SET status = ?, data_json = ? WHERE id = ?", [c.status, JSON.stringify(c), c.id]); }
function mutateBatch(dir: string, id: string, fn: (b: import("../shared/pm-orchestrated-batch.ts").OrchestratedBatchRecord) => void) { const b = batch.getOrchestratedBatch(dir,id)!.batch; fn(b); store.db.run("UPDATE pm_orchestrated_batches SET status = ?, data_json = ? WHERE id = ?", [b.status,JSON.stringify(b),id]); }

test("requires initiative, delivered delegations and two independently approved project grants", async () => {
  expect(() => head.prepareHeadAuto("rejected-or-missing", ["a","b"])).toThrow("unavailable");
  const noDelegation = await fixture(true, false); expect(() => head.prepareHeadAuto(noDelegation.id, noDelegation.ids)).toThrow("delegation");
  const noApproval = await fixture(false); expect(() => head.prepareHeadAuto(noApproval.id, noApproval.ids)).toThrow("Owner approval");
  const f = await fixture(); expect(() => head.prepareHeadAuto(f.id, [f.ids[0], f.ids[0]])).toThrow("distinct");
  const v = head.prepareHeadAuto(f.id, f.ids); expect(v.record?.authorization).toBeNull();
  await expect(head.actHeadAuto(f.id,"start")).rejects.toThrow();
  expect(() => head.authorizeHeadAuto(f.id,"stale-digest")).toThrow("digest");
  initiatives.cancelHeadPmInitiative(f.id); expect(() => head.authorizeHeadAuto(f.id,v.record!.digest)).toThrow("cancelled");
});

test("task, assignment, model, resource and grant changes invalidate the exact plan", async () => {
  for (const kind of ["task", "assignment", "model", "resource", "grant", "expired"]) {
    const f = await authorized();
    if (kind === "task") store.tasks.update(f.taskIds[1]!, {prompt: "Changed"});
    if (kind === "assignment") {
      const dev = await call("/employees", {name: "Other", jobTitle:"Engineer", projectPath: f.paths[1]});
      const core = new (await import("./assignment-core.ts")).AssignmentCore(store.db);
      core.reassign(f.taskIds[1],dev.id,core.forTask(f.taskIds[1])!.revision);
    }
    if (kind === "model") mutateBatch(f.paths[1]!,f.ids[1]!,b => {b.tasks[0]!.reviewerModel="opus-5.5";});
    if (kind === "grant") mutateBatch(f.paths[1]!,f.ids[1]!,b => {b.policy!.maxLaunchesPerTask++;});
    if (kind === "expired") {const c = head.getHeadAuto(f.id).record!; c.authorization!.expiresAt=Date.now()-1; mutate(c);}
    if (kind === "resource") store.harnesses.setEnabled("claude-code",false);
    await expect(head.actHeadAuto(f.id,"start")).rejects.toThrow();
    expect(store.tasks.get(f.taskIds[0]!)?.column).toBe("ready");
    if (kind === "resource") store.harnesses.setEnabled("claude-code",true);
    await head.actHeadAuto(f.id,"cancel");
  }
});

test("pause/resume/cancel preserve finished work and batch independence; Owner API cannot bypass reservation", async () => {
  const f = await authorized();
  await expect(batch.startOrchestratedBatch(f.paths[0]!,f.ids[0]!)).rejects.toThrow("paused");
  await head.actHeadAuto(f.id,"pause"); expect(head.getHeadAuto(f.id).record?.status).toBe("paused");
  await head.actHeadAuto(f.id,"cancel");
  expect(store.tasks.get(f.taskIds[0]!)?.column).toBe("ready");
  // Unstarted existing FO-AUTO02 grants are usable independently after release.
  expect((await import("./head-pm-auto-boundary.ts")).headBatchBlock(f.ids[0]!)).toBeNull();
});

test("approved A → QC PASS → B with no Owner Done; recovery does not duplicate runs or history", async () => {
  const f = await authorized();
  await head.actHeadAuto(f.id,"pause");
  await head.actHeadAuto(f.id,"resume");
  await until(() => head.getHeadAuto(f.id).record?.status === "completed");
  const c = head.getHeadAuto(f.id).record!;
  expect(c.completedBatchIds).toEqual(f.ids);
  const counts = f.taskIds.map(id => store.db.query<{n:number},[string]>("SELECT count(*) AS n FROM runs WHERE task_id = ?").get(id)!.n);
  expect(counts).toEqual([2,2]);
  for (const [n,id] of f.taskIds.entries()) {
    const t = store.tasks.get(id)!; expect(t.column).toBe("review"); expect(t.workdir).toBe(f.paths[n]!); expect(t.qcState?.latestVerdict).toBe("PASS");
    expect(t.qcState?.awaitingOwnerApproval).toBe(true);
  }
  const i = initiatives.getHeadPmInitiative(f.id)!; expect(i.status).toBe("needs_owner"); expect(i.tasks).toHaveLength(2);
  for (let n=0;n<3;n++) {head.recoverHeadAuto(); await head.tickHeadAuto(c.id);}
  expect(head.getHeadAuto(f.id).record?.history).toEqual(c.history);
  expect(f.taskIds.map(id => store.db.query<{n:number},[string]>("SELECT count(*) AS n FROM runs WHERE task_id = ?").get(id)!.n)).toEqual(counts);
  for (const id of f.taskIds) store.tasks.update(id,{column:"done",qcState:{...store.tasks.get(id)!.qcState!,awaitingOwnerApproval:false}});
  expect(initiatives.getHeadPmInitiative(f.id)?.status).toBe("completed");
},60000);

test("QC CHANGES_REQUESTED in A stops B without mutating its tasks", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT="CHANGES_REQUESTED";
  const f = await authorized();
  try {
    await head.actHeadAuto(f.id,"start"); await until(() => head.getHeadAuto(f.id).record?.status === "blocked");
    expect(store.tasks.get(f.taskIds[0]!)?.qcState?.latestVerdict).toBe("CHANGES_REQUESTED");
    expect(store.tasks.get(f.taskIds[1]!)?.column).toBe("ready");
    expect(batch.getOrchestratedBatch(f.paths[1]!,f.ids[1]!)?.batch.status).toBe("approved");
    expect(head.getHeadAuto(f.id).record?.blocker).toContain("Review requested changes");
  } finally {await head.actHeadAuto(f.id,"cancel");process.env.AGETOR_FAKE_QC_VERDICT="PASS";}
},60000);

test("global concurrency and crash reservation recovery fail closed", async () => {
  const f = await authorized();
  const other = await authorized();
  const c = head.getHeadAuto(f.id).record!; c.status="running"; c.reservations[0]!.state="dispatched"; mutate(c); await expect(head.actHeadAuto(other.id,"start")).rejects.toThrow("Another Head");
  head.recoverHeadAuto(); expect(head.getHeadAuto(f.id).record?.status).toBe("blocked");
  expect(head.getHeadAuto(f.id).record?.blocker).toContain("reservation");
  expect(store.tasks.get(f.taskIds[0]!)?.column).toBe("ready");
  await head.actHeadAuto(f.id,"cancel"); await head.actHeadAuto(other.id,"cancel");
});

test("implementation failure in A stops dispatch and preserves B and historical Run", async () => {
  const f = await fixture(true,true,"Implement __agetor_fake_run_fail__");
  const draft=head.prepareHeadAuto(f.id,f.ids); head.authorizeHeadAuto(f.id,draft.record!.digest);
  await head.actHeadAuto(f.id,"start"); await until(()=>head.getHeadAuto(f.id).record?.status==="blocked");
  expect(head.getHeadAuto(f.id).record?.blocker).toContain("failed");
  expect(store.tasks.get(f.taskIds[1]!)?.column).toBe("ready");
  expect((await call(`/tasks/${f.taskIds[0]}/runs`))).toHaveLength(1);
  await head.actHeadAuto(f.id,"cancel");
  expect((await call(`/tasks/${f.taskIds[0]}/runs`))).toHaveLength(1);
});

test("active pause prevents later QC/project dispatch; expired authorization cannot revive on recovery", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS="800";
  const f=await fixture(true,true,"Do work __agetor_fake_claude_handoff__:done");
  const d=head.prepareHeadAuto(f.id,f.ids); head.authorizeHeadAuto(f.id,d.record!.digest);
  const other=await authorized();
  try {
    await head.actHeadAuto(f.id,"start");
    await until(()=>store.tasks.get(f.taskIds[0]!)?.column==="running");
    await head.actHeadAuto(f.id,"pause");
    await expect(head.actHeadAuto(other.id,"start")).rejects.toThrow("unsettled Runs");
    await head.actHeadAuto(other.id,"cancel");
    await Bun.sleep(1100);
    expect(head.getHeadAuto(f.id).record?.status).toBe("paused");
    expect((await call(`/tasks/${f.taskIds[1]}/runs`))).toHaveLength(0);
    const c=head.getHeadAuto(f.id).record!;c.authorization!.expiresAt=Date.now()-1;mutate(c);
    head.recoverHeadAuto(); await expect(head.actHeadAuto(f.id,"resume")).rejects.toThrow("expired");
    expect(store.tasks.get(f.taskIds[1]!)?.column).toBe("ready");
    await head.actHeadAuto(f.id,"cancel");
    expect((await call(`/tasks/${f.taskIds[0]}/runs`))).toHaveLength(1);
  } finally {delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;}
});

test("recovery between A QC and B dispatch adopts A without replay, then runs B exactly once", async () => {
  const f=await authorized();
  const {subscribeAppEvents}=await import("./quit-guard.ts");
  // Simulated process cut immediately after A's persisted terminal write.
  const unsub=subscribeAppEvents(e=>{
    if(e.type==="execution_batch" && e.batchId===f.ids[0] && e.status==="completed") {
      const c=head.getHeadAuto(f.id).record!;c.status="paused";mutate(c);
    }
  });
  await head.actHeadAuto(f.id,"start");
  await until(()=>batch.getOrchestratedBatch(f.paths[0]!,f.ids[0]!)?.batch.status==="completed");
  unsub();
  expect((await call(`/tasks/${f.taskIds[1]}/runs`))).toHaveLength(0);
  const c=head.getHeadAuto(f.id).record!;c.status="running";mutate(c);head.recoverHeadAuto();
  await until(()=>head.getHeadAuto(f.id).record?.status==="completed");
  expect((await call(`/tasks/${f.taskIds[0]}/runs`))).toHaveLength(2);
  expect((await call(`/tasks/${f.taskIds[1]}/runs`))).toHaveLength(2);
}, 60000);

test("cancelled initiative stops its coordination without deleting tasks or grants for unstarted projects", async () => {
  const f=await authorized();
  initiatives.cancelHeadPmInitiative(f.id);
  await until(()=>head.getHeadAuto(f.id).record?.status==="cancelled");
  expect(initiatives.getHeadPmInitiative(f.id)?.status).toBe("cancelled");
  for (const id of f.taskIds) expect(store.tasks.get(id)?.column).toBe("ready");
  expect(batch.getOrchestratedBatch(f.paths[1]!,f.ids[1]!)?.batch.status).toBe("approved");
  expect((await import("./head-pm-auto-boundary.ts")).headBatchBlock(f.ids[1]!)).toBeNull();
});

test("fresh Owner plan after cancellation preserves the prior immutable authorization and history", async () => {
  const f=await authorized();
  await head.actHeadAuto(f.id,"cancel");
  const prior=head.getHeadAuto(f.id).record!;
  const next=head.prepareHeadAuto(f.id,f.ids).record!;
  expect(next.id).not.toBe(prior.id); expect(next.authorization).toBeNull();
  const saved=JSON.parse(store.db.query<{data_json:string},[string]>("SELECT data_json FROM head_pm_auto WHERE id = ?").get(prior.id)!.data_json);
  expect(saved).toEqual(prior);
  head.authorizeHeadAuto(f.id,next.digest); await head.actHeadAuto(f.id,"cancel");
});

test("Owner can resume an active pause under unchanged valid grants without replaying the settled implementation", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS="700";
  const f=await fixture(true,true,"Do work __agetor_fake_claude_handoff__:done");
  const d=head.prepareHeadAuto(f.id,f.ids);head.authorizeHeadAuto(f.id,d.record!.digest);
  try {
    await head.actHeadAuto(f.id,"start");await until(()=>store.tasks.get(f.taskIds[0]!)?.column==="running");
    await head.actHeadAuto(f.id,"pause");await Bun.sleep(1000);
    expect(head.getHeadAuto(f.id).record?.status).toBe("paused");
    expect((await call(`/tasks/${f.taskIds[0]}/runs`))).toHaveLength(1);
    expect((await call(`/tasks/${f.taskIds[1]}/runs`))).toHaveLength(0);
    await head.actHeadAuto(f.id,"resume");await until(()=>head.getHeadAuto(f.id).record?.status==="completed");
    expect((await call(`/tasks/${f.taskIds[0]}/runs`))).toHaveLength(2);
    expect((await call(`/tasks/${f.taskIds[1]}/runs`))).toHaveLength(2);
  } finally {delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;}
},60000);

test("a stopped project refuses the whole two-project coordination, names it and fails it closed; starting the project does not revive the coordination", async () => {
  const lifecycle = await import("./project-lifecycle.ts");
  const f = await authorized();
  const runCount = (id: string) => store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM runs WHERE task_id = ?").get(id)!.n;

  // Project B is stopped while the Owner's authorization for the A → B sequence is still valid.
  const stopped = await lifecycle.stopProjectLifecycle(f.paths[1]!, "test stop");
  expect(stopped.lifecycle.state).toBe("paused");
  await expect(head.actHeadAuto(f.id, "start")).rejects.toThrow("Beta");
  // All or nothing: A (a running project) did not start either, no run exists, and the refusal is recorded as the blocker.
  expect(f.taskIds.map(runCount)).toEqual([0, 0]);
  const blocked = head.getHeadAuto(f.id).record!;
  expect(blocked.status).toBe("blocked");
  expect(blocked.blocker).toContain("Beta");
  expect(lifecycle.getProjectLifecycle(f.paths[0]!)?.state).toBe("running");

  // A repeated attempt is the same refusal, not a new state or a run.
  await expect(head.actHeadAuto(f.id, "start")).rejects.toThrow();
  expect(f.taskIds.map(runCount)).toEqual([0, 0]);

  // Starting B reopens admission for B only. It does not revive the blocked coordination or start anything.
  const resumed = await lifecycle.startProjectLifecycle(f.paths[1]!);
  expect(resumed.lifecycle.state).toBe("running");
  await Bun.sleep(300);
  expect(f.taskIds.map(runCount)).toEqual([0, 0]);
  expect(head.getHeadAuto(f.id).record?.status).toBe("blocked");
  await expect(head.actHeadAuto(f.id, "resume")).rejects.toThrow("cannot start/resume");
  expect(f.taskIds.map(runCount)).toEqual([0, 0]);
  await head.actHeadAuto(f.id, "cancel");
}, 60000);
