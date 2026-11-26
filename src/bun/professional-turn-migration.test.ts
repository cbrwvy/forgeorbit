import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { professionalTurnsMigration } from "./migrations/091_professional_execution_turns.ts";
import { ProfessionalTurnCore, recordInitialProfessionalTurn, settleInitialProfessionalTurn } from "./professional-turn-core.ts";
import type { TurnContext } from "../shared/execution/turn.ts";
import type { EmployeeRunRow } from "./employee-run-core.ts";

const index = migrations.findIndex(m => m.id === "091_professional_execution_turns");
const sha = "a".repeat(64);
const binding = { kind: "professional" as const, employeeId: "employee", revisionId: "revision", revision: 1,
  promptSha256: sha, promptMarkdown: "Saved immutable professional Markdown", catalogRoleSlug: "engineer",
  professionalTitle: "Engineer", originalTemplateSha256: sha, sourceCommit: "fixture", boundAt: 1 };
function seed(db: Database) {
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at) VALUES('task','Task','Initial','running','codex','/fixture',1,1)`);
  db.run(`INSERT INTO runs(id,task_id,agent,status,started_at) VALUES('run','task','codex','running',1)`);
  db.run(`INSERT INTO employee_executions (id,task_id,task_title,project_path,employee_id,employee_name,assignment_id,assignment_revision,
    status,revision,requested_harness_id,requested_policy,requested_mode,inputs_key,task_fingerprint,config_json,review_json,
    created_at,updated_at,expires_at,approved_at,started_at,approval_provenance,run_id,professional_json)
    VALUES ('attempt','task','Task','/fixture','employee','Worker','assignment',1,'started',1,'codex','balanced','ask','key','fingerprint','{}','{}',1,1,1000,1,1,'owner','run',?)`, [JSON.stringify(binding)]);
  db.run("UPDATE employee_executions SET professional_snapshot_sha256 = ?", [createHash("sha256").update(JSON.stringify(binding)).digest("hex")]);
  const row = db.query<EmployeeRunRow, []>("SELECT * FROM employee_executions").get()!;
  recordInitialProfessionalTurn(db, row, binding, "run", "Initial payload");
  settleInitialProfessionalTurn(db, "run", true, "exact-session");
}
const context = (): TurnContext => ({ runId: "run", taskId: "task", employeeId: "employee", employeeName: "Worker", projectPath: "/fixture",
  attemptId: "attempt", revisionId: "revision", professionalRevision: 1, snapshotSha256: createHash("sha256").update(JSON.stringify(binding)).digest("hex"), sessionId: "exact-session",
  authorityKey: "permission-fingerprint", restrictions: { allowedHarnesses: ["codex"] }, mode: "ask" });

test("091 fresh install, populated 090 upgrade, repeat startup and WAL reopen retain audit", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo014e-migration-")), "fixture.sqlite");
  let db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL"); migrate(db, migrations.slice(0, index));
    expect(migrate(db, migrations)).toEqual(["091_professional_execution_turns", "092_company_activity_journal", "093_task_dependency_tombstones", "094_task_plan_queues", "095_task_queue_progression"]); seed(db);
    const core = new ProfessionalTurnCore(db, () => 10);
    const t = core.review(context, "New UTF-8 user message 😀", "key").turn;
    expect(core.claim(t.id, t.revision, "key", context).replayed).toBe(false);
    core.transition(t.id, "claimed", "prepared");
    expect(migrate(db, migrations)).toEqual([]); db.close(); db = new Database(file);
    const recovered = new ProfessionalTurnCore(db, () => 20);
    expect(recovered.recover()).toBe(1); expect(recovered.recover()).toBe(0);
    expect(recovered.get(t.id).status).toBe("indeterminate");
    expect(recovered.claim(t.id, t.revision, "key", context).replayed).toBe(true);
    expect(() => recovered.review(context, "Never auto resend", "other")).toThrow("Unknown");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query<{ professional_json: string }, []>("SELECT professional_json FROM employee_executions").get()!.professional_json).toBe(JSON.stringify(binding));
  } finally { db.close(); }
});

test("091 interrupted migration atomically rolls schema, triggers and ledger back", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations.slice(0, index));
    expect(() => migrate(db, [{ ...professionalTurnsMigration, apply(db) { professionalTurnsMigration.apply!(db); throw new Error("injected crash"); } }])).toThrow("injected crash");
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'employee_turn%' OR name = 'employee_execution_turns'").all()).toEqual([]);
    expect(db.query("SELECT id FROM _migrations WHERE id = '091_professional_execution_turns'").get()).toBeNull();
    expect(migrate(db, migrations)).toEqual(["091_professional_execution_turns", "092_company_activity_journal", "093_task_dependency_tombstones", "094_task_plan_queues", "095_task_queue_progression"]);
  } finally { db.close(); }
});

test("two independent WAL connections serialize review sequence and single-use CAS", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo014e-connections-")), "fixture.sqlite");
  const a = new Database(file); a.exec("PRAGMA journal_mode=WAL"); migrate(a, migrations); seed(a);
  const b = new Database(file);
  try {
    const one = new ProfessionalTurnCore(a, () => 10), two = new ProfessionalTurnCore(b, () => 10);
    const t = one.review(context, "One prompt", "key").turn;
    expect(two.review(context, "One prompt", "key").turn.id).toBe(t.id);
    expect(() => two.review(context, "Concurrent different review", "other")).toThrow("pending");
    expect(() => two.claim(t.id, 50, "key", context)).toThrow("Stale");
    expect(one.claim(t.id, 1, "key", context).replayed).toBe(false);
    expect(two.claim(t.id, 1, "key", context).replayed).toBe(true);
    expect(two.list("run").map(t => t.turn_number)).toEqual([1, 2]);
  } finally { b.close(); a.close(); }
});

test("two simultaneous independent SQLite processes cannot both win a Turn claim", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo014e-process-cas-")), file = path.join(dir, "fixture.sqlite");
  const db = new Database(file); db.exec("PRAGMA journal_mode=WAL"); migrate(db, migrations); seed(db);
  const t = new ProfessionalTurnCore(db, () => 10).review(context, "Race payload", "race").turn;
  const gate = path.join(dir, "go");
  const script = `import {Database} from 'bun:sqlite';import {existsSync,writeFileSync} from 'node:fs';
    import {ProfessionalTurnCore} from ${JSON.stringify(path.join(import.meta.dir, "professional-turn-core.ts"))};
    const [file,id,ready,gate]=process.argv.slice(-4);const db=new Database(file);db.exec('PRAGMA busy_timeout=5000');
    writeFileSync(ready,'ready');const until=Date.now()+3000;while(!existsSync(gate)&&Date.now()<until)await Bun.sleep(5);
    const result=new ProfessionalTurnCore(db,()=>10).claim(id,1,'race',()=>(${JSON.stringify(context())}));
    console.log(JSON.stringify({replayed:result.replayed}));db.close();`;
  const workers = [0, 1].map(i => Bun.spawn([process.execPath, "-e", script, file, t.id, path.join(dir, `ready-${i}`), gate],
    { env: { HOME: dir, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" }));
  try {
    const until = Date.now() + 3000;
    while (![0, 1].every(i => existsSync(path.join(dir, `ready-${i}`))) && Date.now() < until) await Bun.sleep(5);
    writeFileSync(gate, "go");
    const results = await Promise.all(workers.map(async p => {
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code, err).toBe(0); return JSON.parse(out).replayed as boolean;
    }));
    expect(results.sort()).toEqual([false, true]); expect(new ProfessionalTurnCore(db).get(t.id).status).toBe("claimed");
  } finally { db.close(); for (const p of workers) if (p.exitCode === null) p.kill(); }
});

test("expiry and changed authority fail CAS without submission; crash before prepare is confirmed unsent", () => {
  const db = new Database(":memory:"); migrate(db, migrations); seed(db);
  try {
    let time = 1;
    const core = new ProfessionalTurnCore(db, () => time);
    const t = core.review(context, "Review", "key").turn;
    expect(() => core.claim(t.id, 1, "key", () => ({ ...context(), authorityKey: "revoked" }))).toThrow("authority changed");
    time = t.expires_at;
    expect(() => core.claim(t.id, 1, "key", context)).toThrow("expired");
    const next = core.review(context, "Fresh review", "fresh").turn;
    expect(core.get(t.id).status).toBe("failed");
    core.claim(next.id, 1, "fresh", context); expect(core.recover()).toBe(1);
    expect(core.get(next.id)).toMatchObject({ status: "failed", submitted_at: null });
    expect(core.get(next.id).reason).toContain("No prompt submitted");
  } finally { db.close(); }
});

test("091 immutable payload, snapshot links, session, authorization and terminal evidence", () => {
  const db = new Database(":memory:"); migrate(db, migrations); seed(db);
  try {
    expect(() => db.run("UPDATE employee_executions SET professional_snapshot_sha256 = 'forged'")).toThrow("immutable");
    const core = new ProfessionalTurnCore(db, () => 10), t = core.review(context, "Saved prompt", "key").turn;
    for (const update of ["snapshot_sha256 = 'other'", "prompt = 'replaced'", "facts_json = '{}'", "session_id = 'latest'", "run_id = 'other'"]) expect(() => db.run(`UPDATE employee_execution_turns SET ${update} WHERE id = ?`, [t.id])).toThrow("immutable");
    expect(() => core.transition(t.id, "reviewed", "included")).toThrow("transition");
    core.claim(t.id, 1, "key", context); core.transition(t.id, "claimed", "prepared"); core.transition(t.id, "prepared", "included");
    db.run("UPDATE employee_execution_turns SET observed_run_status = 'succeeded', observed_run_ended_at = 12 WHERE id = ?", [t.id]);
    expect(() => db.run("UPDATE employee_execution_turns SET observed_run_status = 'failed' WHERE id = ?", [t.id])).toThrow("immutable");
    expect(() => db.run("UPDATE employee_execution_turns SET authorization_ref = 'forged' WHERE id = ?", [t.id])).toThrow("immutable");
    expect(() => db.run("DELETE FROM employee_execution_turns WHERE id = ?", [t.id])).toThrow("immutable");
    expect(() => db.run("INSERT OR REPLACE INTO employee_execution_turns SELECT * FROM employee_execution_turns WHERE id = ?", [t.id])).toThrow("immutable");
  } finally { db.close(); }
});

test("task deletion preserves immutable Turn and professional audit using the existing soft Run reference contract", () => {
  const db = new Database(":memory:"); migrate(db, migrations); db.exec("PRAGMA foreign_keys=ON"); seed(db);
  try {
    const core = new ProfessionalTurnCore(db), initial = core.initial("run")!;
    db.run("DELETE FROM tasks WHERE id = 'task'");
    expect(db.query("SELECT id FROM runs WHERE id = 'run'").get()).toBeNull();
    expect(core.initial("run")).toEqual(initial);
    expect(db.query("SELECT professional_json FROM employee_executions WHERE id = 'attempt'").get()).toEqual({ professional_json: JSON.stringify(binding) });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
