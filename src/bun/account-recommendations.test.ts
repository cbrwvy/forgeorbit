import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { makeTask } from "../cli/test-fixtures.ts";
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-routing02-unit-")));
process.env.HOME = path.join(root, "owner"); mkdirSync(process.env.HOME);
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_USAGE_OFFLINE = "1";
const { db, tasks, projects, harnesses } = await import("./db.ts");
const { CodexProfiles, cachedCodexAuthentication } = await import("./codex-profiles.ts");
const { AccountCore } = await import("./account-core.ts");
const { EmployeeCore } = await import("./employee-core.ts");
const { AssignmentCore } = await import("./assignment-core.ts");
const { recommendExecutors } = await import("./executor-recommendations.ts");
const { resourceKey, freezeWorkflowExecution, workflowResourceBlock } = await import("./orchestrated-resources.ts");
const { EMPTY_EXECUTOR_PREFERENCES } = await import("../shared/execution/executor-routing.ts");
const core = new AccountCore(db), profiles = new CodexProfiles(core);
const project = path.join(root, "project"); mkdirSync(project); projects.upsert(project, "Routing fixture");
const employee = new EmployeeCore(db).createWorker({ name: "Fixture Developer", jobTitle: "Developer", projectPath: project });
const task = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
new AssignmentCore(db).assign(task.id, employee.id);
let seq = 0;
function add(verifiedModel = true) { const directory = path.join(process.env.HOME!, `profile-${++seq}`); writeSyntheticCodexProfile(directory, `fixture-${seq}`); const p = profiles.register({ displayName: `Configured ${seq}`, directory });
  if (verifiedModel) db.run("INSERT INTO account_model_capabilities VALUES (?, ?, ?, ?)",[p.accountId,p.harnessId,"gpt-6.1-sol",JSON.stringify({accountId:p.accountId,harnessId:p.harnessId,modelId:"gpt-6.1-sol",support:"supported",verification:"verified",provenance:"verified",source:"offline:fo-routing02-model-catalog-fixture",observedAt:Date.now(),expiresAt:Date.now()+600_000})]);
  return p; }
const deps = { layout: async () => ({ layout: "non-git" as const, predicted: false }), cli: () => ({ available: true, loggedIn: null }) };
const options = (r: Awaited<ReturnType<typeof recommendExecutors>>) => Object.values(r.recommendations.groups).flat();
async function option(p: ReturnType<typeof add>, extra: object = {}) {
  return options(await recommendExecutors({ taskId: task.id, harnessId: p.harnessId, model: "gpt-6.1-sol", ...extra }, deps)).find(o => o.harnessId === p.harnessId && o.modelId === "gpt-6.1-sol")!;
}
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("two exact profiles become role eligible after own status; Unknown quota/cost never becomes capacity", async () => {
  const a = add(), b = add();
  for (const p of [a,b]) await profiles.check(p.accountId);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw Error("No probes in recommendation"); });
  try {
    const before = db.query("SELECT count(*) AS n FROM runs").get();
    const opts = await Promise.all([option(a),option(b)]);
    expect(opts.map(o => o.resource?.state)).toEqual(["eligible","eligible"]);
    expect(opts.map(o => o.resource?.evidence.account?.id)).toEqual([a.accountId,b.accountId]);
    expect(opts[0]!.id).not.toBe(opts[1]!.id);
    expect(opts[0]!.resource?.evidence.fingerprint).not.toBe(opts[1]!.resource?.evidence.fingerprint);
    for (const o of opts) { expect(o.quota).toEqual([]); expect(o.cost).toBeNull(); expect(o.requiresOwnerConfirmation).toBe(true); }
    expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual(before);
    expect(db.query("SELECT count(*) AS n FROM pm_orchestrated_workflows").get()).toEqual({ n: 0 });
    expect(tasks.get(task.id)?.agent).toBe("codex");
  } finally { spawn.mockRestore(); }
});
test("authentication is independent, recent and configuration-bound; missing authentication has no fallback", async () => {
  const a = add(), b = add(); await profiles.check(a.accountId);
  expect((await option(b)).resource?.state).toBe("unknown");
  const h = harnesses.get(a.harnessId)!;
  expect(cachedCodexAuthentication(h, Date.now()+31_000)).toBe("unknown");
  rmSync(path.join(b.directory,"synthetic-authenticated")); await profiles.check(b.accountId);
  expect((await option(b)).resource?.state).toBe("ineligible");
  harnesses.update(a.harnessId,{ env: { CODEX_HOME: b.directory } });
  expect(cachedCodexAuthentication(harnesses.get(a.harnessId)!)).toBe("unknown");
  expect((await option(a)).resource?.reasons.map(r => r.code)).toContain("resource-configuration-invalid");
});
test("model, mode, reviewer tools, removed registration and missing harness are explained", async () => {
  const a = add(); await profiles.check(a.accountId);
  for (const extra of [{ mode:"missing-mode" }, { role:"reviewer", mode:"auto" }, { role:"developer",mode:"ask" }]) expect((await option(a,extra)).selectable).toBe(false);
  expect((await option(a,{role:"reviewer",mode:"ask"})).resource?.state).toBe("eligible");
  const missing = options(await recommendExecutors({ taskId:task.id,harnessId:a.harnessId,model:"not-in-any-catalog" },deps)).find(o => o.modelId === "not-in-any-catalog");
  expect(missing?.resource?.state).toBe("ineligible");
  const noCli = options(await recommendExecutors({taskId:task.id}, {...deps,cli:()=>({available:false,loggedIn:null})}));
  expect(noCli.every(o => !o.selectable)).toBe(true);
  profiles.remove(a.accountId); expect((await option(a)).resource?.state).toBe("ineligible");
});
test("account preference orders advisory options; avoid-unverified never upgrades evidence", async () => {
  const a = add(), b = add(); await profiles.check(b.accountId);
  const response = await recommendExecutors({taskId:task.id}, {...deps,preflight:{preferences:()=>({...EMPTY_EXECUTOR_PREFERENCES,preferredAccountId:b.accountId,avoidUnverified:true})}});
  const all = options(response);
  expect(all.find(o=>o.harnessId===a.harnessId)?.selectable).toBe(false);
  expect(all.find(o=>o.harnessId===b.harnessId)?.why.map(r=>r.code)).toContain("owner-preferred-account");
  expect(response.recommendations.automaticSelection).toBe("none");
  expect(response.recommendations.groups["potential-unknown"][0]?.resource?.evidence.account?.id).toBe(b.accountId);
});
test("chosen profile/resource mutation invalidates frozen grant; no automatic replacement", async () => {
  const a = add(), b = add();
  const execution = freezeWorkflowExecution(task,{implementerEmployeeId:employee.id,implementerHarnessId:a.harnessId,implementerModel:"gpt-6.1-sol",implementerMode:"auto",reviewerHarness:b.harnessId,reviewerModel:"gpt-6.1-sol",reviewerMode:"ask"});
  const grant = {taskId:task.id,implementerHarnessId:a.harnessId,implementerModel:"gpt-6.1-sol",reviewerHarness:b.harnessId,reviewerModel:"gpt-6.1-sol",execution} as any;
  expect(execution.implementerHarnessKey).toBe(resourceKey(harnesses.get(a.harnessId)!));
  expect(execution.implementerAccountProfile?.id).toBe(a.accountId);
  profiles.remove(a.accountId);
  expect(workflowResourceBlock(grant)).toContain("unavailable");
  expect(grant.implementerHarnessId).toBe(a.harnessId);
});

test("Head two-project authorization preserves each batch's frozen account/model and rejects changed profile", async () => {
  const batches = await import("./pm-orchestrated-batch.ts"), initiatives = await import("./head-pm-initiative.ts"), head = await import("./head-pm-auto.ts");
  const accounts = [add(),add()], paths: string[] = [], batchIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const dir = path.join(root,`head-project-${i}`); mkdirSync(dir); projects.upsert(dir,`Head ${i}`); paths.push(dir);
    const dev = new EmployeeCore(db).createWorker({name:`Head Developer ${i}`,jobTitle:"Developer",projectPath:dir});
    const t = tasks.insert(makeTask({id:crypto.randomUUID(),workdir:dir,column:"ready",agent:accounts[i]!.harnessId,model:"gpt-6.1-sol",mode:"auto",isolation:"none"}));
    new AssignmentCore(db).assign(t.id,dev.id);
    const draft = batches.createOrchestratedBatchDraft(dir,{taskIds:[t.id]});
    await batches.approveOrchestratedBatch(dir,draft.batch.id,{revision:draft.batch.revision,defaults:{implementerEmployeeId:dev.id,implementerHarnessId:accounts[i]!.harnessId,implementerModel:"gpt-6.1-sol",implementerMode:"auto",reviewerHarness:accounts[0]!.harnessId,reviewerModel:"gpt-6.1-sol",reviewerMode:"ask",autoReviewAfterImplementation:true,autoReworkOnChanges:false,maxReworkIterations:0,maxLaunches:2}});
    batchIds.push(draft.batch.id);
  }
  const result = initiatives.createHeadPmInitiative({title:"Exact configured accounts",projectPaths:paths});
  if (!result.ok) throw Error(result.error);
  for (const dir of paths) {
    const prep = initiatives.prepareHeadPmDelegation(result.value.id,dir,{objective:"Synthetic plan",request:"Prepare tasks"});
    if (!prep.ok) throw Error(prep.error);
    const d = {...prep.value.delegation,status:"answered"};
    const { portfolioManagerStore } = await import("./db.ts");
    portfolioManagerStore.putDelegation(d.id,dir,d.messageId,d.status,JSON.stringify(d),d.createdAt);
  }
  const view = head.prepareHeadAuto(result.value.id,batchIds);
  const record = view.record!;
  expect(record.plan.projects.map(p=>p.tasks[0]!.execution?.implementerAccountProfile?.id)).toEqual(accounts.map(a=>a.accountId));
  expect(record.plan.maxLaunches).toBe(4);
  expect(record.plan.globalConcurrency).toBe(1);
  for (const p of record.plan.projects) expect(p.tasks).toEqual(batches.getOrchestratedBatch(p.projectPath,p.batchId)!.batch.tasks);
  head.authorizeHeadAuto(result.value.id,record.digest);
  profiles.remove(accounts[1]!.accountId);
  await expect(head.actHeadAuto(result.value.id,"start")).rejects.toThrow();
  expect(head.getHeadAuto(result.value.id).record?.plan).toEqual(record.plan);
  expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({n:0});
});

test("curated model vocabulary and diagnostic records do not verify account model access", async () => {
  const a = add(false); await profiles.check(a.accountId);
  expect((await option(a)).resource?.state).toBe("unknown");
  core.setModelCapability(a.accountId,a.harnessId,"gpt-6.1-sol",{support:"supported",expiresAt:Date.now()+60_000});
  expect((await option(a)).resource?.state).toBe("unknown");
});

test("manager/head picker uses existing manager adapters and never produces execution authority", async () => {
  const { recommendManagerResources } = await import("./executor-recommendations.ts");
  const a = add(); await profiles.check(a.accountId);
  for (const role of ["project-manager","head"]) {
    const r = recommendManagerResources({role,harnessId:a.harnessId,model:"gpt-6.1-sol"});
    const options = Object.values(r.groups).flat();
    const o = options.find(o=>o.harnessId===a.harnessId && o.modelId==="gpt-6.1-sol")!;
    expect(o.resource?.state).toBe("eligible"); expect(o.mode?.id).toBe("ask");
    expect(options.filter(o=>o.kind==="claude-code").every(o=>o.resource?.state==="ineligible")).toBe(true);
    expect(r.executionAvailable).toBe(false);
  }
  expect(()=>recommendManagerResources({role:"head",harnessId:a.harnessId,model:"gpt-6.1-sol",consent:true})).toThrow();
});

test("grant approval rejects a Codex Reviewer permission mismatch without creating a grant or Run", () => {
  const a = add();
  expect(()=>freezeWorkflowExecution(task,{implementerEmployeeId:employee.id,implementerHarnessId:a.harnessId,implementerModel:"gpt-6.1-sol",implementerMode:"auto",reviewerHarness:a.harnessId,reviewerModel:"gpt-6.1-sol",reviewerMode:"auto"})).toThrow("read-only");
  expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({n:0});
});

test("manager recommendation endpoint requires bearer authorization and rejects diagnostic/execution fields", async () => {
  const { modelRouterHttp } = await import("./model-router-http.ts");
  const request = (body: object) => new Request("http://localhost/model-router/manager-recommendations",{method:"POST",body:JSON.stringify(body)});
  expect((await modelRouterHttp(request({}),false)).status).toBe(401);
  expect((await modelRouterHttp(new Request("http://localhost/model-router/manager-recommendations"),true)).status).toBe(405);
  expect((await modelRouterHttp(request({role:"head",harnessId:"codex",model:"gpt-6.1-sol",authorization:true}),true)).status).toBe(400);
  const response = await modelRouterHttp(request({role:"head",harnessId:"codex",model:"gpt-6.1-sol"}),true);
  expect(response.status).toBe(200);
  expect((await response.json()).executionAvailable).toBe(false);
});

test("revoked verified model blocks frozen grants before dispatch with no substitute", () => {
  const a = add();
  const execution = freezeWorkflowExecution(task,{implementerEmployeeId:employee.id,implementerHarnessId:a.harnessId,implementerModel:"gpt-6.1-sol",implementerMode:"auto",reviewerHarness:a.harnessId,reviewerModel:"gpt-6.1-sol",reviewerMode:"ask"});
  const grant = {taskId:task.id,implementerHarnessId:a.harnessId,implementerModel:"gpt-6.1-sol",reviewerHarness:a.harnessId,reviewerModel:"gpt-6.1-sol",execution} as any;
  const c = core.modelCapabilities(a.accountId)[0]!;
  db.run("UPDATE account_model_capabilities SET data=? WHERE account_id=?",[JSON.stringify({...c,support:"unsupported"}),a.accountId]);
  expect(workflowResourceBlock(grant)).toContain("confirmed unsupported");
  expect(workflowResourceBlock(grant,true)).toContain("confirmed unsupported");
});

test("changing the resolved CLI invalidates cached authentication even when registration stays the same", async () => {
  const a = add(); await profiles.check(a.accountId);
  const h = harnesses.get(a.harnessId)!, saved = process.env.AGETOR_CODEX_BIN;
  expect(cachedCodexAuthentication(h)).toBe("authenticated");
  process.env.AGETOR_CODEX_BIN = "/bin/echo";
  try { expect(cachedCodexAuthentication(h)).toBe("unknown"); }
  finally { process.env.AGETOR_CODEX_BIN = saved; }
});
