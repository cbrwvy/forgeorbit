import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore } from "./account-core.ts";

// Must precede dynamic import: importing the production DB never opens the real data directory.
const isolated = mkdtempSync(path.join(tmpdir(),"fo009d-adapter-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";
const { buildRoutingSnapshot } = await import("./model-router.ts");
let db: Database;
let core: AccountCore;
beforeEach(() => { db = new Database(":memory:"); migrate(db,migrations); core = new AccountCore(db,()=>1000); });
afterEach(() => db.close());
test("adapter only reads canonical registry and never interprets stored profiles as authorization/support", () => {
  const a = core.createAccount({provider:"fake",displayName:"Fixture",availability:"available"});
  core.bindHarness(a.id,"codex");
  db.run("INSERT INTO agent_profiles(id,name,name_key,harness_id,model,effort,created_at,updated_at) VALUES ('p','p','p','codex','fake-model','ultra',1,1)");
  core.bindProfile(a.id,"p"); core.setModelCapability(a.id,"codex","fake-model",{support:"supported"});
  const before = db.serialize();
  const spawn = spyOn(Bun,"spawn").mockImplementation(()=>{throw new Error("CLI forbidden");});
  const sync = spyOn(Bun,"spawnSync").mockImplementation(()=>{throw new Error("CLI forbidden");});
  const fetch = spyOn(globalThis,"fetch").mockImplementation((()=>{throw new Error("Network forbidden");}) as unknown as typeof globalThis.fetch);
  try {
    const s = buildRoutingSnapshot(db,1000);
    const c = s.candidates.find(c=>c.accountId===a.id && c.modelId==="fake-model")!;
    expect(c.profileIds).toEqual(["p"]);
    expect(c.authorization).toBeNull(); expect(c.availability).toBeNull();
    expect(c.evidence.efforts).toBeNull(); expect(c.support?.verification).toBe("unverified");
    expect(s.limits.find(l=>l.id==="account:"+a.id)?.occupied).toBeNull();
    expect(db.serialize()).toEqual(before);
    expect(spawn).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { spawn.mockRestore();sync.mockRestore();fetch.mockRestore(); }
});
test("multiple harnesses never multiply account concurrency; no capacity seeded from registration", () => {
  const a = core.createAccount({provider:"fake",displayName:"A"});
  core.bindHarness(a.id,"codex");core.bindHarness(a.id,"cursor");
  const q = core.createDefinition({accountId:a.id,scope:"account",unit:{kind:"concurrency"},window:"instant"});
  core.recordObservation(q.id,{limit:1,remaining:1,used:0,expiresAt:2000});
  const s = buildRoutingSnapshot(db,1000);
  expect(s.candidates.filter(c=>c.accountId===a.id)).toHaveLength(2);
  expect(s.limits.filter(l=>l.scope.kind==="account")).toHaveLength(1);
  expect(s.limits.find(l=>l.scope.kind==="account")?.limit).toBeNull();
  expect(s.limits.find(l=>l.scope.kind==="global")?.limit).toBeNull();
});
test("unbound profiles never select an account through matching model or harness names", () => {
  const a = core.createAccount({provider:"fake",displayName:"A"}); core.bindHarness(a.id,"codex");
  db.run("INSERT INTO agent_profiles(id,name,name_key,harness_id,model,created_at,updated_at) VALUES ('p','p','p','codex','private-model',1,1)");
  expect(buildRoutingSnapshot(db,1000).candidates.find(c=>c.accountId===a.id)?.modelId).toBeNull();
});

test("global occupancy includes unregistered project runs without attributing their accounts from current profiles", () => {
  const a = core.createAccount({provider:"fake",displayName:"A"}); core.bindHarness(a.id,"codex");
  db.run('INSERT INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at) VALUES (\'t\',\'t\',\'\',\'running\',\'codex\',\'/not-registered\',1,1)');
  db.run("INSERT INTO runs(id,task_id,agent,status,started_at) VALUES ('r','t','codex','running',1)");
  const s = buildRoutingSnapshot(db,1000);
  expect(s.limits[0]!.occupied?.value).toBe(1);
  expect(s.limits.find(l=>l.scope.kind==="account")?.occupied).toBeNull();
});
