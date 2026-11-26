import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { EmployeeCore } from "./employee-core.ts";
import { HeadPortfolioBindingCore } from "./head-portfolio-binding.ts";

let db: Database;
let employees: EmployeeCore;
let binding: HeadPortfolioBindingCore;
let busy = false;
beforeEach(() => {
  db = new Database(":memory:"); migrate(db, migrations);
  employees = new EmployeeCore(db, { pathExists: () => true, realpath: p => p });
  busy = false; binding = new HeadPortfolioBindingCore(db, () => busy);
});
afterEach(() => db.close());
const change = (id: string | null, revision = binding.get().revision) => binding.change({ employeeId: id, revision, confirm: true });
const appoint = () => employees.setHead({ name: "Morgan" }).employee;

test("empty and appointed but unbound preserve legacy behavior; capture never creates employees", () => {
  expect(binding.get().status).toBe("unbound");
  expect(binding.capture("turn", []).head).toBeNull();
  expect(employees.head()).toBeNull(); appoint(); expect(binding.get().status).toBe("unbound");
});
test("valid Head UUID binds to global and duplicate bind creates one audit event", () => {
  const h = appoint(); const first = change(h.id);
  expect(first).toMatchObject({ sessionId: "global", status: "bound", employeeId: h.id, revision: 1 });
  expect(change(h.id)).toEqual(first);
  expect(db.query("SELECT COUNT(*) AS n FROM head_portfolio_binding_events").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM portfolio_manager").get()).toEqual({ n: 0 });
});
test.each(["worker", "project-manager"])("reject %s", kind => {
  db.run("INSERT INTO projects(path,name,added_at) VALUES ('/p','P',1)");
  const e = kind === "worker" ? employees.createWorker({ name: "Ada", jobTitle: "Engineer" }) : employees.ensureProjectManager("/p").employee;
  expect(() => change(e.id)).toThrow("active, unarchived Head");
});
test("missing, inactive, archived Head rejected", () => {
  expect(() => change(crypto.randomUUID())).toThrow("not found");
  const h = appoint(); employees.update(h.id, { status: "inactive" });
  expect(() => change(h.id)).toThrow("active, unarchived");
  employees.archive(h.id); expect(() => change(h.id)).toThrow("active, unarchived");
});
test("rename keeps binding and UUID; immutable turn snapshot keeps original name", () => {
  const h = appoint(); change(h.id); const turn = binding.capture("t1", ["/p"]);
  employees.update(h.id, { name: "New name" });
  expect(binding.get()).toMatchObject({ status: "bound", head: { employeeId: h.id, name: "New name" } });
  expect(turn.head?.name).toBe("Morgan"); expect(turn.head?.employeeId).toBe(h.id);
});
test.each(["jobTitle", "status"])("%s change invalidates even after restoring position; explicit confirmation renews", field => {
  const h = appoint(); change(h.id);
  employees.update(h.id, { [field]: field === "jobTitle" ? "Advisor" : "inactive" });
  expect(binding.get().status).toBe("invalid");
  employees.update(h.id, { [field]: field === "jobTitle" ? h.jobTitle : "active" });
  expect(binding.get().status).toBe("invalid");
  expect(change(h.id)).toMatchObject({ status: "bound", revision: 2 });
});
test("archive during a turn invalidates new attribution; change and unbind refuse busy; no silent replacement", () => {
  const h = appoint(); change(h.id); const old = binding.capture("t1", []); busy = true;
  expect(() => change(null)).toThrow("Wait for"); employees.archive(h.id);
  expect(binding.get().status).toBe("invalid"); expect(binding.capture("t2", []).head).toBeNull();
  const next = employees.setHead({ name: "Taylor" }).employee;
  expect(() => change(next.id)).toThrow("Wait for"); busy = false;
  expect(change(next.id).head?.employeeId).toBe(next.id); expect(old.head?.employeeId).toBe(h.id);
  change(null); expect(binding.get().status).toBe("unbound");
});
test("unarchive cannot silently reactivate archived binding", () => {
  const h = appoint(); change(h.id); employees.archive(h.id); employees.unarchive(h.id);
  expect(binding.get().status).toBe("invalid"); expect(change(h.id).status).toBe("bound");
});
test("missing or role-corrupted employee makes a stored binding Invalid", () => {
  const h = appoint(); change(h.id); db.run("UPDATE ai_employees SET kind = 'worker' WHERE id = ?", [h.id]);
  expect(binding.get().status).toBe("invalid"); db.run("DELETE FROM ai_employees WHERE id = ?", [h.id]);
  expect(binding.get()).toMatchObject({ status: "invalid", head: null });
});
test("strict confirmation rejects paths, resources, employee kinds and hidden fields", () => {
  const id = appoint().id;
  for (const body of [null, [], {}, { employeeId: id, revision: 0 }, { employeeId: id, revision: 0, confirm: false },
    ...["path", "harnessId", "accountId", "kind", "model"].map(k => ({ employeeId: id, revision: 0, confirm: true, [k]: "x" }))]) {
    expect(() => binding.change(body)).toThrow();
  }
});
test("two SQLite connections serialize different binds / unbind; stale request cannot add history; restart durable", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo012b-cas-")), "test.sqlite");
  const a = new Database(file); migrate(a, migrations);
  const b = new Database(file);
  try {
    const e = new EmployeeCore(a); const first = e.setHead({ name: "First" }).employee;
    const x = new HeadPortfolioBindingCore(a); const y = new HeadPortfolioBindingCore(b);
    expect(x.change({ employeeId: first.id, revision: 0, confirm: true }).revision).toBe(1);
    e.archive(first.id); const second = e.setHead({ name: "Second" }).employee;
    expect(() => y.change({ employeeId: second.id, revision: 0, confirm: true })).toThrow("revision");
    expect(y.change({ employeeId: second.id, revision: 1, confirm: true }).revision).toBe(2);
    x.change({ employeeId: null, revision: 2, confirm: true });
    expect(() => y.change({ employeeId: null, revision: 2, confirm: true })).toThrow("revision");
    expect(y.get()).toMatchObject({ revision: 3, status: "unbound" });
    y.change({ employeeId: second.id, revision: 3, confirm: true });
    a.close(); b.close();
    const reopened = new Database(file);
    try { expect(new HeadPortfolioBindingCore(reopened).get()).toMatchObject({ revision: 4, status: "bound", employeeId: second.id }); }
    finally { reopened.close(); }
  } finally { try { a.close(); } catch {} try { b.close(); } catch {} }
});
test("086 fresh/upgrade/rerun does not modify existing chat/config/delegation/knowledge/approval data", () => {
  const base = new Database(":memory:");
  try {
    const at086 = migrations.findIndex((m) => m.id === "086_head_portfolio_binding");
    migrate(base, migrations.slice(0, at086));
    base.run("INSERT INTO portfolio_manager VALUES ('global','{\"harness\":\"kept\"}',1,1)");
    base.run("INSERT INTO portfolio_manager_messages VALUES ('old',1,'{\"old\":true}',1)");
    const tables = ["portfolio_manager", "portfolio_manager_messages", "portfolio_manager_delegations", "knowledge_context_grants", "assignment_proposals", "employee_task_assignments"];
    const before = tables.map(t => base.query(`SELECT * FROM ${t}`).all());
    expect(migrations[at086]?.id).toBe("086_head_portfolio_binding");
    expect(migrate(base, migrations.slice(0, at086 + 1))).toEqual(["086_head_portfolio_binding"]);
    expect(migrate(base, migrations.slice(0, at086 + 1))).toEqual([]);
    expect(tables.map(t => base.query(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(base.query("SELECT * FROM portfolio_manager_turn_attributions").all()).toEqual([]);
  } finally { base.close(); }
});
