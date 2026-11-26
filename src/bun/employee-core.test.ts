import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ClusterCore } from "./cluster-core.ts";
import { EmployeeCore, EmployeeCoreError } from "./employee-core.ts";
import { EMPLOYEE_FIRST_NAMES } from "../shared/employees/names.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const A = "/registry/alpha";
const B = "/registry/beta";
const C = "/registry/gamma";

let db: Database;
let clock = 1_000;
let draws = 0;
let seed = 0;

function make(random?: () => number): EmployeeCore {
  return new EmployeeCore(db, {
    now: () => ++clock,
    random: random ?? (() => {
      draws += 1;
      seed = (seed + 0.137) % 1;
      return seed;
    }),
    pathExists: () => true,
    realpath: (path) => path,
  });
}

function code(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof EmployeeCoreError) return error.status;
    throw error;
  }
  throw new Error("expected EmployeeCoreError");
}

function project(path: string, name: string) {
  db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 5)`, [path, name]);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  clock = 1_000;
  draws = 0;
  seed = 0;
  project(A, "Alpha");
  project(B, "Beta");
  project(C, "Gamma");
});

afterEach(() => db.close());

test("an employee keeps one stable UUID through rename, retitle, reassignment, and archive", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "Senior Backend Engineer", projectPath: A });
  expect(worker.id).toMatch(UUID);
  core.update(worker.id, { name: "Morgan", jobTitle: "Staff Engineer" });
  core.assign(worker.id, B);
  core.archive(worker.id);
  core.unarchive(worker.id);
  expect(core.get(worker.id).id).toBe(worker.id);
  expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get()).toEqual({ n: 1 });
});

test("a generated name is drawn once, stored, and never redrawn by reads or restarts", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "QA Engineer" });
  expect(worker.nameSource).toBe("generated");
  expect(EMPLOYEE_FIRST_NAMES).toContain(worker.name as never);
  const drawsAfterCreate = draws;
  for (let i = 0; i < 5; i++) {
    core.get(worker.id);
    core.list();
    core.organization();
    core.projectTeam(A);
    core.history(worker.id);
  }
  expect(draws).toBe(drawsAfterCreate);
  const restarted = make();
  expect(restarted.get(worker.id).name).toBe(worker.name);
  expect(db.query(`SELECT name FROM ai_employees WHERE id = ?`).get(worker.id)).toEqual({ name: worker.name });
});

test("reading a project without a manager never creates one or draws a name", () => {
  const core = make();
  expect(core.projectManager(A)).toMatchObject({ projectPath: A, projectManager: null });
  expect(core.head()).toBeNull();
  expect(core.organization().head).toBeNull();
  expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get()).toEqual({ n: 0 });
  expect(draws).toBe(0);
});

test("name draws follow the random source and prefer names no active employee holds", () => {
  const core = make(() => 0);
  const first = core.createWorker({ jobTitle: "Frontend Engineer" });
  const second = core.createWorker({ jobTitle: "Frontend Engineer" });
  expect(first.name).toBe(EMPLOYEE_FIRST_NAMES[0]!);
  expect(second.name).toBe(EMPLOYEE_FIRST_NAMES[1]!);
  core.archive(first.id);
  expect(core.createWorker({ jobTitle: "Frontend Engineer" }).name).toBe(EMPLOYEE_FIRST_NAMES[0]!);
});

test("the owner can rename without changing the UUID or history, and regenerate for a new random name", () => {
  const core = make(() => 0.3);
  const worker = core.createWorker({ jobTitle: "DevOps Engineer", projectPath: A });
  const renamed = core.update(worker.id, { name: "  Ada  " });
  expect(renamed).toMatchObject({ id: worker.id, name: "Ada", nameSource: "owner", createdAt: worker.createdAt });
  const redrawn = core.regenerateName(worker.id);
  expect(redrawn).toMatchObject({ id: worker.id, nameSource: "generated" });
  expect(redrawn.name).not.toBe("Ada");
  const actions = core.get(worker.id).history.map((event) => event.action);
  expect(actions).toEqual(["create", "rename", "regenerate-name"]);
  expect(core.get(worker.id).history[1]!.changes.name).toEqual({ from: worker.name, to: "Ada" });
  const again = core.regenerateName(worker.id);
  expect(again.name).not.toBe(redrawn.name);
});

test("equal names never merge employees", () => {
  const core = make();
  const one = core.createWorker({ name: "Alex", jobTitle: "QA Engineer", projectPath: A });
  const two = core.createWorker({ name: "Alex", jobTitle: "QA Engineer", projectPath: A });
  const three = core.createWorker({ name: "alex", jobTitle: "Technical Writer", projectPath: B });
  expect(new Set([one.id, two.id, three.id]).size).toBe(3);
  expect(core.list().filter((employee) => employee.name.toLowerCase() === "alex")).toHaveLength(3);
  expect(core.projectTeam(A).employees.map((employee) => employee.id).sort()).toEqual([one.id, two.id].sort());
});

test("the Head is one global position named by the owner", () => {
  const core = make();
  expect(code(() => core.setHead({}))).toBe(400);
  expect(code(() => core.setHead({ displayName: "Boss" }))).toBe(400);
  expect(draws).toBe(0);
  const created = core.setHead({ name: "Ilse", description: "Runs the portfolio" });
  expect(created.created).toBe(true);
  expect(created.employee).toMatchObject({ kind: "head", name: "Ilse", nameSource: "owner", projectPath: null, jobTitle: "Head of Project Management", reportsTo: { kind: "owner" } });
  const updated = core.setHead({ name: "Ilse Marek" });
  expect(updated.created).toBe(false);
  expect(updated.employee.id).toBe(created.employee.id);
  expect(code(() => core.regenerateName(created.employee.id))).toBe(409);
  expect(code(() => core.assign(created.employee.id, A))).toBe(409);
  expect(() => db.run(
    `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at) VALUES ('x', 'head', 'Two', 'owner', 'Head', 'leadership', 'active', 1, 1)`,
  )).toThrow();
  core.archive(created.employee.id);
  expect(core.head()).toBeNull();
  const next = core.setHead({ name: "Noor" });
  expect(next.created).toBe(true);
  expect(next.employee.id).not.toBe(created.employee.id);
});

test("a project has exactly one active Project Manager and ensure is idempotent", () => {
  const core = make();
  const first = core.ensureProjectManager(A);
  expect(first.created).toBe(true);
  expect(first.employee).toMatchObject({ kind: "project-manager", projectPath: A, projectName: "Alpha", jobTitle: "Project Manager", roleCategory: "management", nameSource: "generated" });
  const drawn = draws;
  const second = core.ensureProjectManager(A, { name: "Ignored" });
  expect(second.created).toBe(false);
  expect(second.employee).toMatchObject({ id: first.employee.id, name: first.employee.name });
  expect(draws).toBe(drawn);
  expect(core.projectManager(A).projectManager?.id).toBe(first.employee.id);
  expect(() => db.run(
    `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, project_path, status, created_at, updated_at) VALUES ('y', 'project-manager', 'Dup', 'owner', 'PM', 'management', ?, 'active', 1, 1)`,
    [A],
  )).toThrow();
  expect(core.ensureProjectManager(B).employee.id).not.toBe(first.employee.id);
});

test("a Project Manager reports to the Head, a worker to the project manager", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "QA Engineer", projectPath: A });
  expect(core.get(worker.id).reportsTo).toBeNull();
  const manager = core.ensureProjectManager(A).employee;
  expect(core.get(manager.id).reportsTo).toBeNull();
  expect(core.get(worker.id).reportsTo).toEqual({ kind: "employee", id: manager.id });
  const head = core.setHead({ name: "Ilse" }).employee;
  expect(core.get(manager.id).reportsTo).toEqual({ kind: "employee", id: head.id });
});

test("identity for existing managers is initialized safely, once, without touching their data", () => {
  db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES (?, '{"language":"en"}', 3)`, [A]);
  db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES (?, '{}', 4)`, [B]);
  db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES ('/not/registered', '{}', 5)`);
  db.run(`INSERT INTO project_manager_messages (id, project_path, seq, data, created_at) VALUES ('m1', ?, 1, '{"text":"hi"}', 6)`, [A]);
  db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('t1', 'Keep', 'p', 'ready', 'codex', ?, 5, 5)`, [A]);
  const tables = ["project_managers", "project_manager_messages", "project_manager_proposals", "project_manager_decisions", "project_manager_executions", "tasks", "runs", "projects"];
  const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
  const core = make();
  const result = core.initializeExistingProjectManagers();
  expect(result.created.map((employee) => employee.projectPath).sort()).toEqual([A, B]);
  expect(result.alreadyInitialized).toBe(0);
  expect(core.get(result.created[0]!.id).history[0]!.action).toBe("initialize");
  expect(core.projectManager(C).projectManager).toBeNull();
  const names = result.created.map((employee) => employee.name);
  const again = make().initializeExistingProjectManagers();
  expect(again.created).toEqual([]);
  expect(again.alreadyInitialized).toBe(2);
  expect(core.list({ kind: "project-manager" }).map((employee) => employee.name).sort()).toEqual([...names].sort());
  expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
});

test("workers can be assigned, reassigned and unassigned; managers and the Head stay where they are", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "Data Engineer" });
  expect(worker.projectPath).toBeNull();
  expect(core.assign(worker.id, A).projectPath).toBe(A);
  expect(code(() => core.assign(worker.id, A))).toBe(409);
  expect(core.assign(worker.id, B)).toMatchObject({ projectPath: B, projectName: "Beta" });
  expect(core.get(worker.id).history.map((event) => event.action)).toEqual(["create", "assign", "reassign"]);
  expect(core.get(worker.id).history[2]!.changes.projectPath).toEqual({ from: A, to: B });
  expect(core.unassign(worker.id).projectPath).toBeNull();
  expect(code(() => core.unassign(worker.id))).toBe(409);
  const manager = core.ensureProjectManager(A).employee;
  expect(code(() => core.assign(manager.id, B))).toBe(409);
  expect(code(() => core.unassign(manager.id))).toBe(409);
  expect(code(() => core.assign(worker.id, "/registry/unknown"))).toBe(404);
  expect(code(() => core.assign(worker.id, "relative/path"))).toBe(400);
  expect(code(() => core.createWorker({ jobTitle: "QA Engineer", projectPath: "/registry/unknown" }))).toBe(404);
});

test("moving a project between clusters, or out of every cluster, does not change its people", () => {
  const core = make();
  const clusters = new ClusterCore(db, { now: () => ++clock, pathExists: () => true, realpath: (path) => path });
  const manager = core.ensureProjectManager(A).employee;
  const worker = core.createWorker({ jobTitle: "Frontend Engineer", projectPath: A });
  const peopleBefore = db.query(`SELECT * FROM ai_employees ORDER BY id`).all();
  const one = clusters.create({ name: "One" });
  const two = clusters.create({ name: "Two" });

  let tree = core.organization();
  expect(tree.clusters.map((entry) => entry.projects)).toEqual([[], []]);
  expect(tree.unclusteredProjects.find((team) => team.projectPath === A)).toMatchObject({ projectManager: { id: manager.id }, employees: [{ id: worker.id }] });

  clusters.assign(one.id, A);
  tree = core.organization();
  expect(tree.clusters.find((entry) => entry.cluster.id === one.id)!.projects[0]).toMatchObject({ projectPath: A, projectManager: { id: manager.id }, employees: [{ id: worker.id }] });
  expect(tree.unclusteredProjects.map((team) => team.projectPath)).not.toContain(A);

  clusters.move(two.id, A);
  tree = core.organization();
  expect(tree.clusters.find((entry) => entry.cluster.id === one.id)!.projects).toEqual([]);
  expect(tree.clusters.find((entry) => entry.cluster.id === two.id)!.projects[0]).toMatchObject({ projectManager: { id: manager.id } });

  clusters.unassign(two.id, A);
  expect(core.projectManager(A).projectManager?.id).toBe(manager.id);
  expect(core.organization().unclusteredProjects.find((team) => team.projectPath === A)!.employees.map((e) => e.id)).toEqual([worker.id]);
  expect(db.query(`SELECT * FROM ai_employees ORDER BY id`).all()).toEqual(peopleBefore);
  expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees WHERE job_title LIKE '%luster%'`).get()).toEqual({ n: 0 });
});

test("an archived employee keeps its row, history, tasks and runs but takes no more changes", () => {
  const core = make();
  const worker = core.createWorker({ name: "Sam", jobTitle: "QA Engineer", projectPath: A });
  db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('t1', 'Keep', 'p', 'done', 'codex', ?, 5, 5)`, [A]);
  db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, ended_at) VALUES ('r1', 't1', 'codex', 'succeeded', 1, 2)`);
  const tasks = db.query(`SELECT * FROM tasks`).all();
  const runs = db.query(`SELECT * FROM runs`).all();
  const archived = core.archive(worker.id);
  const archivedAt = archived.archivedAt;
  expect(typeof archivedAt).toBe("number");
  expect(archived).toMatchObject({ status: "archived", reportsTo: null });
  expect(core.archive(worker.id).archivedAt).toBe(archivedAt);
  expect(core.list().map((employee) => employee.id)).not.toContain(worker.id);
  expect(core.list({ includeArchived: true }).map((employee) => employee.id)).toContain(worker.id);
  expect(core.list({ status: "archived" }).map((employee) => employee.id)).toEqual([worker.id]);
  expect(core.projectTeam(A).employees).toEqual([]);
  expect(core.organization().unclusteredProjects.find((team) => team.projectPath === A)!.employees).toEqual([]);
  expect(code(() => core.update(worker.id, { name: "Other" }))).toBe(409);
  expect(code(() => core.assign(worker.id, B))).toBe(409);
  expect(code(() => core.regenerateName(worker.id))).toBe(409);
  expect(core.get(worker.id).history.map((event) => event.action)).toEqual(["create", "archive"]);
  expect(db.query(`SELECT * FROM tasks`).all()).toEqual(tasks);
  expect(db.query(`SELECT * FROM runs`).all()).toEqual(runs);
  expect(core.unarchive(worker.id)).toMatchObject({ status: "active", archivedAt: null });
  expect(code(() => core.unarchive(worker.id))).toBe(409);
});

test("archiving a manager lets the project get a new one, and the old one cannot come back beside it", () => {
  const core = make();
  const old = core.ensureProjectManager(A).employee;
  core.archive(old.id);
  expect(core.projectManager(A).projectManager).toBeNull();
  const next = core.ensureProjectManager(A);
  expect(next.created).toBe(true);
  expect(next.employee.id).not.toBe(old.id);
  expect(code(() => core.unarchive(old.id))).toBe(409);
  expect(core.get(old.id).archivedAt).not.toBeNull();
});

test("employees are not agent profiles, harnesses, accounts, models, or sessions", () => {
  const columns = (db.query(`PRAGMA table_info(ai_employees)`).all() as { name: string }[]).map((column) => column.name);
  for (const column of columns) expect(column).not.toMatch(/agent|harness|account|model|effort|profile|session|run|task|pipeline|token|key|secret/);
  const core = make();
  const worker = core.createWorker({ jobTitle: "Software Architect", projectPath: A });
  expect(Object.keys(worker).join(" ")).not.toMatch(/agent|harness|account|model|effort|profileId|session/i);
  expect(worker.runtimeBinding.status).toBe("none");
  expect(db.query(`SELECT sql FROM sqlite_master WHERE name = 'ai_employees'`).get()).not.toMatchObject({ sql: expect.stringContaining("REFERENCES") });
});

test("one employee stays one employee across tasks run through different harnesses, accounts, and models", () => {
  const core = make();
  const worker = core.createWorker({ name: "Alex", jobTitle: "Senior Backend Engineer", projectPath: A, specializations: ["APIs"] });
  const manager = core.ensureProjectManager(A).employee;
  const snapshot = JSON.stringify([core.get(worker.id), core.get(manager.id)]);
  const profileRows = db.query(`SELECT * FROM agent_profiles`).all();
  const rows: [string, string, string | null, string | null][] = [["t-a", "codex", "gpt-6.1-sol", "high"], ["t-b", "claude-code", "claude-opus-5-5", "max"], ["t-c", "cursor", "gemini-4-argon-high", null]];
  for (const [id, agent, model, effort] of rows) {
    db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, model, effort, workdir, created_at, updated_at) VALUES (?, ?, 'p', 'ready', ?, ?, ?, ?, 5, 5)`, [id, id, agent, model, effort, A]);
    db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, ended_at) VALUES (?, ?, ?, 'succeeded', 1, 2)`, [`r-${id}`, id, agent]);
  }
  expect(JSON.stringify([core.get(worker.id), core.get(manager.id)])).toBe(snapshot);
  expect(db.query(`SELECT * FROM agent_profiles`).all()).toEqual(profileRows);
  expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get()).toEqual({ n: 2 });
  expect(core.list({ projectPath: A })).toHaveLength(2);
});

test("a job title is a label: it does not change a position, a project, or any other table", () => {
  const core = make();
  const head = core.setHead({ name: "Ilse" }).employee;
  const manager = core.ensureProjectManager(A).employee;
  const worker = core.createWorker({ jobTitle: "Security Engineer", projectPath: B });
  db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES (?, '{}', 3)`, [A]);
  const managers = db.query(`SELECT * FROM project_managers`).all();
  const changed = core.update(manager.id, { jobTitle: "Head of Project Management", specializations: ["Everything"] });
  expect(changed).toMatchObject({ kind: "project-manager", projectPath: A, jobTitle: "Head of Project Management", roleCategory: "management" });
  expect(changed.authority.grantsPermissions).toBe(false);
  expect(core.head()?.id).toBe(head.id);
  expect(code(() => core.update(manager.id, { roleCategory: "leadership" }))).toBe(409);
  expect(code(() => core.update(head.id, { roleCategory: "engineering" }))).toBe(409);
  expect(core.update(worker.id, { roleCategory: "security" }).roleCategory).toBe("security");
  expect(core.projectTeam(B).projectManager).toBeNull();
  expect(db.query(`SELECT * FROM project_managers`).all()).toEqual(managers);
});

test("a patch cannot move an employee between projects or change its kind", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "QA Engineer", projectPath: A });
  for (const field of [{ projectPath: B }, { kind: "head" }, { id: "x" }, { archivedAt: 1 }, { agentProfileId: "p" }, { model: "m" }, { harness: "codex" }, { accountId: "a" }]) {
    expect(code(() => core.update(worker.id, field))).toBe(400);
  }
  expect(core.get(worker.id).projectPath).toBe(A);
});

test("job titles and specializations are editable free text, deduplicated and bounded", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "Ocean Cartographer", specializations: [" Maps ", "maps", "Tides"] });
  expect(worker).toMatchObject({ jobTitle: "Ocean Cartographer", specializations: ["Maps", "Tides"] });
  expect(core.update(worker.id, { jobTitle: "Technical Writer", specializations: [] })).toMatchObject({ jobTitle: "Technical Writer", specializations: [] });
  expect(code(() => core.update(worker.id, { specializations: ["x".repeat(61)] }))).toBe(400);
  expect(code(() => core.update(worker.id, { specializations: Array.from({ length: 21 }, (_, i) => `s${i}`) }))).toBe(400);
  expect(code(() => core.update(worker.id, { specializations: "x" }))).toBe(400);
  expect(code(() => core.update(worker.id, { jobTitle: "" }))).toBe(400);
  expect(code(() => core.update(worker.id, { jobTitle: "bad\u0000title" }))).toBe(400);
  expect(code(() => core.update(worker.id, { roleCategory: "wizard" }))).toBe(400);
  expect(code(() => core.update(worker.id, { name: "x".repeat(81) }))).toBe(400);
  expect(code(() => core.update(worker.id, { status: "archived" }))).toBe(400);
  expect(code(() => core.update(worker.id, {}))).toBe(400);
  expect(code(() => core.createWorker({ roleCategory: "engineering" }))).toBe(400);
  expect(core.update(worker.id, { status: "inactive" }).status).toBe("inactive");
  expect(core.update(worker.id, { notes: "  remember  ", department: "Platform", displayName: "Al" })).toMatchObject({ notes: "remember", department: "Platform", displayName: "Al" });
  expect(core.update(worker.id, { notes: null, department: "" })).toMatchObject({ notes: null, department: null });
});

test("an update that changes nothing writes no history and keeps the timestamp", () => {
  const core = make();
  const worker = core.createWorker({ name: "Sam", jobTitle: "QA Engineer" });
  const same = core.update(worker.id, { name: "Sam", jobTitle: "QA Engineer" });
  expect(same.updatedAt).toBe(worker.updatedAt);
  expect(core.get(worker.id).history).toHaveLength(1);
});

test("employees of one project never appear in another project's team", () => {
  const core = make();
  const a = core.createWorker({ jobTitle: "QA Engineer", projectPath: A });
  const b = core.createWorker({ jobTitle: "QA Engineer", projectPath: B });
  core.ensureProjectManager(A);
  expect(core.projectTeam(A).employees.map((employee) => employee.id)).toEqual([a.id]);
  expect(core.projectTeam(B).employees.map((employee) => employee.id)).toEqual([b.id]);
  expect(core.projectTeam(B).projectManager).toBeNull();
  expect(core.list({ projectPath: B }).map((employee) => employee.id)).toEqual([b.id]);
  expect(code(() => core.projectTeam("/registry/unknown"))).toBe(404);
  expect(code(() => core.list({ projectPath: "/registry/unknown" }))).toBe(404);
});

test("removing a project from the registry keeps its people, and re-adding it brings them back", () => {
  const core = make();
  const manager = core.ensureProjectManager(A).employee;
  const worker = core.createWorker({ jobTitle: "QA Engineer", projectPath: A });
  db.run(`DELETE FROM projects WHERE path = ?`, [A]);
  expect(core.get(manager.id)).toMatchObject({ projectPath: A, projectRegistered: false, projectName: null });
  const tree = core.organization();
  expect(tree.detachedEmployees.map((employee) => employee.id).sort()).toEqual([manager.id, worker.id].sort());
  expect(tree.unclusteredProjects.map((team) => team.projectPath)).not.toContain(A);
  project(A, "Alpha");
  expect(core.projectTeam(A)).toMatchObject({ projectManager: { id: manager.id }, employees: [{ id: worker.id }] });
  expect(core.organization().detachedEmployees).toEqual([]);
});

test("the organization tree lists the owner, the Head, clusters, projects, and unassigned workers", () => {
  const core = make();
  const clusters = new ClusterCore(db, { now: () => ++clock, pathExists: () => true, realpath: (path) => path });
  const cluster = clusters.create({ name: "Lunarian Forge" });
  clusters.assign(cluster.id, A);
  core.setHead({ name: "Ilse" });
  core.ensureProjectManager(A);
  const free = core.createWorker({ jobTitle: "Product Manager" });
  const tree = core.organization();
  expect(tree.company).toEqual({ id: "company:forgeorbit", name: "ForgeOrbit" });
  expect(tree.owner.kind).toBe("owner");
  expect(tree.head?.name).toBe("Ilse");
  expect(tree.clusters).toHaveLength(1);
  expect(tree.clusters[0]!.projects.map((team) => team.projectPath)).toEqual([A]);
  expect(tree.unclusteredProjects.map((team) => team.projectPath).sort()).toEqual([B, C]);
  expect(tree.unassignedEmployees.map((employee) => employee.id)).toEqual([free.id]);
  expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees WHERE kind NOT IN ('head', 'project-manager', 'worker')`).get()).toEqual({ n: 0 });
});

test("history is bounded and reports truncation", () => {
  const core = make();
  const worker = core.createWorker({ jobTitle: "QA Engineer" });
  for (let i = 0; i < 55; i++) core.update(worker.id, { description: `v${i}` });
  const details = core.get(worker.id);
  expect(details.history).toHaveLength(50);
  expect(details.historyTruncated).toBe(true);
  expect(details.history.at(-1)!.changes.description).toEqual({ from: "v53", to: "v54" });
});

test("invalid ids are 400 and unknown ids are 404", () => {
  const core = make();
  expect(code(() => core.get("nope"))).toBe(400);
  expect(code(() => core.get("00000000-0000-4000-8000-000000000001"))).toBe(404);
});

test("employee code never imports a runner and never spawns a process", () => {
  for (const file of ["employee-core.ts", "employee-http.ts", "../shared/employees/types.ts", "../shared/employees/names.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(orchestrator|agents|claude-tmux|codex-tmux|cursor-tmux|gemini-tmux|fx-acp|antigravity-tmux|project-manager|portfolio-manager|project-execution|model-router|account-core|isolated-agent-turn)/);
    expect(source).not.toMatch(/Bun\.spawn|child_process|execSync|fetch\(/);
  }
});
