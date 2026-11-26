import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = mkdtempSync(path.join(tmpdir(), "fo009d-http-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4699";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE","CODEX","CURSOR","GEMINI","FX","ANTIGRAVITY"]) process.env["AGETOR_"+kind+"_BIN"] = "/nonexistent/fo009d";
let backend: typeof import("./server.ts");
let store: typeof import("./db.ts");
let server: ReturnType<typeof import("./server.ts")["startApiServer"]>;
let spawn: ReturnType<typeof spyOn>, sync: ReturnType<typeof spyOn>, fetchGuard: ReturnType<typeof spyOn>;
let externalCalls = 0;
const base = "http://127.0.0.1:4699";
const a = mkdtempSync(path.join(isolated,"project-a-")), b = mkdtempSync(path.join(isolated,"project-b-"));
beforeAll(async () => {
  spawn = spyOn(Bun,"spawn").mockImplementation(()=>{ throw new Error("Unexpected process"); });
  sync = spyOn(Bun,"spawnSync").mockImplementation(()=>{ throw new Error("Unexpected process"); });
  const realFetch = globalThis.fetch;
  fetchGuard = spyOn(globalThis,"fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base+"/")) { externalCalls++; throw new Error("External calls forbidden"); }
    return realFetch(input,init);
  }) as typeof fetch);
  store = await import("./db.ts");
  backend = await import("./server.ts"); server = backend.startApiServer();
  store.projects.upsert(a,"A");store.projects.upsert(b,"B");
  for (const [id,dir] of [["task-a",a],["task-b",b]]) store.db.run('INSERT INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',[id!,"Complex backend","SECRET_PROMPT_MARKER","backlog","codex",dir!]);
});
afterAll(()=>{server?.stop(true);spawn?.mockRestore();sync?.mockRestore();fetchGuard?.mockRestore();});
async function call(route = "/preview", body: unknown = {path:a,taskId:"task-a"}, auth: string | null = "Bearer "+backend.API_TOKEN, method = "POST") {
  const r = await fetch(base+"/model-router"+route,{method, headers:{...(auth ? {authorization:auth}:{}),"content-type":"application/json"},body: method === "GET" ? undefined : JSON.stringify(body)});
  return {status:r.status, body:await r.json() as any, cache:r.headers.get("cache-control")};
}
test("both preview endpoints require exact bearer authorization; query tokens are rejected", async () => {
  for (const route of ["/preview","/portfolio-preview"]) for (const auth of [null,"Bearer wrong","bearer "+backend.API_TOKEN,"Bearer "+backend.API_TOKEN+"x"]) {
    expect((await call(route,{},auth)).status).toBe(401);
  }
  expect((await call("/preview?token="+backend.API_TOKEN,{},null)).status).toBe(401);
});
test("project manager preview is read-only, preserves Unknown and never returns prompts or harness configuration", async () => {
  const before = store.db.serialize();
  const r = await call();
  expect(r.status).toBe(200); expect(r.cache).toBe("no-store");
  expect(r.body.preview).toMatchObject({status:"no-verified-candidate",readOnly:true,execution:"preview-only",requirements:{complexity:"unknown",priority:null}});
  const serialized = JSON.stringify(r.body);
  expect(serialized).not.toContain("SECRET_PROMPT_MARKER"); expect(serialized).not.toContain('"env"');expect(serialized).not.toContain('"bin"');
  expect(store.db.serialize()).toEqual(before);
});
test("registration and project ownership gate every request before routing", async () => {
  expect((await call("/preview",{path:"/private/not-registered",taskId:"task-a"})).status).toBe(404);
  expect((await call("/preview",{path:a,taskId:"task-b"})).status).toBe(404);
  expect((await call("/preview",{path:b,taskId:"task-a"})).status).toBe(404);
});
test("structured requirements and all five policies reach preview without inventing support", async () => {
  for (const policy of ["quality-first","balanced","cost-efficient","fastest-eligible","preserve-limited-resources"]) {
    const r = await call("/preview",{path:a,taskId:"task-a",policy,requirements:{type:"backend",complexity:"high",capabilities:["backend"],tools:["sqlite"],allowedPermissions:["read"],requiredPermissions:["read"],contextTokens:8000},ownerConstraints:{allowedHarnesses:["codex"],allowedAccounts:[],globalConcurrency:1,requiredApprovals:["owner-review"]}});
    expect(r.status).toBe(200); expect(r.body.preview.requirements.complexity).toBe("high");
    expect(r.body.preview.policy).toBe(policy); expect(r.body.preview.recommendedCandidate).toBeNull();
    expect(r.body.preview.ownerConstraints.requiredApprovals).toContain("owner-review");
  }
});
test("portfolio manager can compare registered projects and incomplete priorities remain Unknown", async () => {
  const before = store.db.serialize();
  const r = await call("/portfolio-preview",{requests:[{path:a,taskId:"task-a",ownerConstraints:{projectPriority:"low"}},{path:b,taskId:"task-b",ownerConstraints:{projectPriority:"high"}}]});
  expect(r.status).toBe(200);expect(r.body.previews[0].requirements.taskId).toBe("task-b");
  expect(r.body.previews).toHaveLength(2); expect(store.db.serialize()).toEqual(before);
  expect((await call("/portfolio-preview",{requests:[{path:a,taskId:"task-a"},{path:a,taskId:"task-a"}]})).status).toBe(400);
});
test("GET resource-context is read-only and fail-closed for automatic routing", async () => {
  const before = store.db.serialize();
  const r = await fetch(base + "/model-router/resource-context", { headers: { authorization: "Bearer " + backend.API_TOKEN } });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const body = await r.json() as { readOnly: boolean; automaticRouting: { available: boolean; reason: string }; harnesses: { enabled: boolean }[] };
  expect(body.readOnly).toBe(true);
  expect(body.automaticRouting.available).toBe(false);
  expect(body.automaticRouting.reason).toContain("verified");
  expect(body.harnesses.length).toBeGreaterThan(0);
  expect(store.db.serialize()).toEqual(before);
  expect((await fetch(base + "/model-router/resource-context?token=" + backend.API_TOKEN)).status).toBe(401);
});
test("saved estimation spending ceiling cannot be loosened by a preview", async () => {
  const {emptyEstimationSettings} = await import("../shared/estimation/settings.ts");
  const settings = emptyEstimationSettings();settings.budgetMode="overage-off";settings.maxAdditionalSpend={currency:"USD",minor:5};
  store.projectEstimation.set(a,JSON.stringify(settings),"fixture");
  const before = store.db.serialize();
  const r = await call("/preview",{path:a,taskId:"task-a",ownerConstraints:{spending:"allow-paid",maxExpectedCost:{currency:"USD",minor:100}}});
  expect(r.status).toBe(200); expect(r.body.preview.ownerConstraints.spending).toBe("no-extra");
  expect(r.body.preview.ownerConstraints.maxExpectedCost.minor).toBe(5);
  expect(r.body.planningEstimate).not.toBeNull(); expect(store.db.serialize()).toEqual(before);
  expect((await call("/preview",{path:a,taskId:"task-a",ownerConstraints:{maxExpectedCost:{currency:"EUR",minor:1}}})).status).toBe(400);
});
test("forged verification, unknown fields, malformed enums and oversized inputs are rejected", async () => {
  for (const extra of [{authorization:{verification:"verified"}},{requirements:{complexity:["high"]}},{requirements:{type:["backend"]}},{ownerConstraints:{spending:["allow-paid"]}},{ownerConstraints:{projectPriority:["high"]}},{requirements:{capabilities:"backend"}},{requirements:{quotaDemands:[{quotaId:"q",amount:-1}]}},{requirements:{complexity:"extreme"}},{policy:"magic"},{requirements:{provenance:["verified"]}}]) {
    expect((await call("/preview",{path:a,taskId:"task-a",...extra})).status).toBe(400);
  }
  expect((await call("/preview",{padding:"x".repeat(70_000)})).status).toBe(413);
});
test("no shell/account switch/launch endpoints, no external calls or processes", async () => {
  const before = store.db.serialize();
  for (const route of ["/execute","/switch-account","/shell"]) expect((await call(route,{})).status).toBe(404);
  expect((await call("/preview",{},undefined,"GET")).status).toBe(405);
  expect(store.db.serialize()).toEqual(before);
  expect(externalCalls).toBe(0);expect(spawn).not.toHaveBeenCalled();expect(sync).not.toHaveBeenCalled();
});
