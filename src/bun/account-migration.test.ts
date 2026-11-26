import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore } from "./account-core.ts";
import { LegacyUsageBridge } from "./account-usage-bridge.ts";

test("076 upgrades 075 without identities, lost usage or changes to existing profile/run tables", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys=ON");
    const quotaAt = migrations.findIndex((migration) => migration.id === "076_account_quota_core");
    const throughQuota = migrations.slice(0, quotaAt + 1);
    migrate(db, throughQuota.slice(0, -1));
    db.run("INSERT INTO harness_usage VALUES (?, ?, ?)", ["codex", JSON.stringify({ kind: "codex", fetchedAtMs: 1000, source: "api", status: "ok", reason: "Bearer SECRET", meters: [{ id: "weekly", usedPercent: 42, resetsAtMs: null, secret: "SECRET" }] }), 1000]);
    db.run("INSERT INTO harness_usage VALUES ('invalid','{bad',1000)");
    db.run("INSERT INTO harness_usage VALUES ('weird',?,1000)", [JSON.stringify({ meters: ["bad", null, 3] })]);
    db.run("INSERT INTO usage_daily VALUES ('/fake/home','2026-10-24','fake-model',1,2,3,4,1)");
    const before = ["harnesses", "agent_profiles", "tasks", "runs", "usage_daily", "harness_usage"].map(table => db.query(`SELECT * FROM ${table}`).all());
    expect(migrate(db, throughQuota)).toEqual(["076_account_quota_core"]);
    expect(migrate(db, throughQuota)).toEqual([]);
    expect(["harnesses", "agent_profiles", "tasks", "runs", "usage_daily", "harness_usage"].map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(new AccountCore(db).listAccounts()).toEqual([]);
    const history = new LegacyUsageBridge(db, () => 1001).history();
    expect(history.observations).toHaveLength(1);
    expect(history.observations[0]).toMatchObject({ accountId: null, observedAt: 1000 });
    expect(history.observations[0]!.meters[0]!.indicator.value).toBe(42);
    expect(JSON.stringify(db.query("SELECT * FROM harness_usage_history").all())).not.toContain("SECRET");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("fresh migration has real FKs and preserves history after binding/profile deletion", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys=ON"); migrate(db, migrations);
    const core = new AccountCore(db, () => 1000);
    const a = core.createAccount({ provider: "fixture", displayName: "Fixture" });
    core.bindHarness(a.id, "codex");
    db.run("INSERT INTO agent_profiles(id,name,name_key,harness_id,model,created_at,updated_at) VALUES ('p','p','p','codex','fake',1,1)");
    core.bindProfile(a.id, "p");
    db.run("INSERT INTO projects(path,name,added_at) VALUES ('/fixture','Fixture',1)");
    db.run("INSERT INTO tasks(id,title,prompt,column,agent,workdir,created_at,updated_at,agent_profile_id) VALUES ('t','Fixture','Fixture','done','codex','/fixture',1,1,'p')");
    db.run("INSERT INTO runs(id,task_id,agent,status,started_at,ended_at) VALUES ('r','t','codex','succeeded',1,2)");
    db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES ('r','system','fixture history',1)");
    const preserved = ["projects", "tasks", "runs", "run_events"].map(table => db.query(`SELECT * FROM ${table}`).all());
    const q = core.createDefinition({ accountId: a.id, scope: "account", unit: { kind: "tokens" }, window: "unknown" });
    core.recordObservation(q.id, { remaining: 1 });
    db.run("DELETE FROM agent_profiles WHERE id='p'");
    expect(core.associations()).toEqual([]);
    core.unbindHarness(a.id, "codex");
    expect(core.history(q.id)).toHaveLength(1);
    core.archiveAccount(a.id);
    expect(["projects", "tasks", "runs", "run_events"].map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(preserved);
    expect(() => db.run("DELETE FROM resource_accounts WHERE id=?", [a.id])).toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
