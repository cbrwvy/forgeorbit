import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ClusterCore } from "./cluster-core.ts";
import { EmployeeCore, EmployeeCoreError } from "./employee-core.ts";
import { ACTIVE_TASK_ASSIGNMENT_GUARD } from "../shared/assignments/types.ts";

const isolated = mkdtempSync(path.join(tmpdir(), "fo010c-assign-db-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";

let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AssignmentCoreError: typeof import("./assignment-core.ts").AssignmentCoreError;
let classifyWorkdir: typeof import("./project-ownership.ts").classifyWorkdir;

beforeAll(async () => {
  ({ AssignmentCore, AssignmentCoreError } = await import("./assignment-core.ts"));
  ({ classifyWorkdir } = await import("./project-ownership.ts"));
});

const A = "/registry/alpha";
const B = "/registry/beta";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: Database;
let clock = 1_000;
let employees: EmployeeCore;

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssignmentCoreError || error instanceof EmployeeCoreError) return error.status;
    throw error;
  }
  throw new Error("expected a rejection");
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssignmentCoreError || error instanceof EmployeeCoreError) return error.message;
    throw error;
  }
  throw new Error("expected a rejection");
}

function project(projectPath: string, name: string) {
  db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 5)`, [projectPath, name]);
}

function addTask(workdir: string, title = "Fix the gate", column = "ready"): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO tasks (id, title, prompt, "column", agent, model, workdir, created_at, updated_at)
     VALUES (?, ?, 'prompt', ?, 'codex', 'gpt-6', ?, 5, 5)`,
    [id, title, column, workdir],
  );
  return id;
}

function assignments(options: { beforeWrite?: () => void; database?: Database } = {}) {
  const database = options.database ?? db;
  return new AssignmentCore(database, {
    now: () => ++clock,
    classify: (workdir) => classifyWorkdir(database.query<{ path: string }, []>(`SELECT path FROM projects`).all().map((row) => row.path), workdir),
    beforeWrite: options.beforeWrite,
  });
}

function worker(projectPath: string | null, name: string, jobTitle = "QA Engineer") {
  return employees.createWorker({ name, jobTitle, ...(projectPath ? { projectPath } : {}) });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  clock = 1_000;
  project(A, "Alpha");
  project(B, "Beta");
  employees = new EmployeeCore(db, {
    now: () => ++clock,
    random: () => 0.2,
    pathExists: () => true,
    realpath: (value) => value,
  });
});

afterEach(() => db.close());

test("assigns an active worker and keeps the task, employee, and runtime tables unchanged", () => {
  const person = worker(A, "Ada");
  const taskId = addTask(A);
  const beforeTask = db.query(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  const beforeRuns = db.query(`SELECT COUNT(*) AS n FROM runs`).get();
  const beforeProfiles = db.query(`SELECT COUNT(*) AS n FROM agent_profiles`).get();
  const beforeAccounts = db.query(`SELECT COUNT(*) AS n FROM resource_accounts`).get();
  const beforeManagers = db.query(`SELECT * FROM project_managers`).all();
  const core = assignments();
  const result = core.assign(taskId, person.id);
  expect(result.created).toBe(true);
  expect(result.assignment).toMatchObject({
    taskId,
    employeeId: person.id,
    employeeName: "Ada",
    projectPath: A,
    projectName: "Alpha",
    status: "active",
    provenance: "owner",
    revision: 1,
    routerHandoff: { status: "not-invoked", previewPath: "/model-router/preview" },
    task: { title: "Fix the gate", column: "ready", archived: false, visibility: "in-project" },
  });
  expect(result.assignment.id).toMatch(UUID);
  expect(db.query(`SELECT * FROM tasks WHERE id = ?`).get(taskId)).toEqual(beforeTask);
  expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual(beforeRuns);
  expect(db.query(`SELECT COUNT(*) AS n FROM agent_profiles`).get()).toEqual(beforeProfiles);
  expect(db.query(`SELECT COUNT(*) AS n FROM resource_accounts`).get()).toEqual(beforeAccounts);
  expect(db.query(`SELECT * FROM project_managers`).all()).toEqual(beforeManagers);
  expect(db.query(`SELECT agent, model FROM tasks WHERE id = ?`).get(taskId)).toEqual({ agent: "codex", model: "gpt-6" });
  const columns = (db.query(`PRAGMA table_info(employee_task_assignments)`).all() as { name: string }[]).map((column) => column.name).join(",");
  expect(columns).not.toMatch(/model|account|harness|profile|session|effort/);
});

test("one worker can hold many tasks, and a task keeps one primary worker", () => {
  const ada = worker(A, "Ada");
  const bea = worker(A, "Bea");
  const first = addTask(A, "First");
  const second = addTask(A, "Second");
  const core = assignments();
  core.assign(first, ada.id);
  core.assign(second, ada.id);
  expect(core.forEmployee(ada.id).map((row) => row.task.title)).toEqual(["First", "Second"]);
  expect(statusOf(() => core.assign(first, bea.id))).toBe(409);
  expect(core.forTask(first)?.employeeId).toBe(ada.id);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments WHERE task_id = ? AND status = 'active'`).get(first)).toEqual({ n: 1 });
});

test("assigning the same worker again is idempotent and does not append history", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const core = assignments();
  const first = core.assign(taskId, ada.id);
  const second = core.assign(taskId, ada.id);
  expect(second.created).toBe(false);
  expect(second.assignment.id).toBe(first.assignment.id);
  expect(second.assignment.revision).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignment_events`).get()).toEqual({ n: 1 });
});

test("reassignment is explicit and unassign keeps append-only history", () => {
  const ada = worker(A, "Ada");
  const bea = worker(A, "Bea");
  const taskId = addTask(A);
  const core = assignments();
  const created = core.assign(taskId, ada.id);
  expect(statusOf(() => core.reassign(taskId, ada.id, created.assignment.revision))).toBe(409);
  const moved = core.reassign(taskId, bea.id, created.assignment.revision);
  expect(moved.id).toBe(created.assignment.id);
  expect(moved.employeeId).toBe(bea.id);
  expect(moved.revision).toBe(2);
  expect(statusOf(() => core.reassign(taskId, ada.id, created.assignment.revision))).toBe(409);
  expect(core.forTask(taskId)?.employeeId).toBe(bea.id);
  const cleared = core.unassign(taskId, moved.revision);
  expect(cleared.status).toBe("unassigned");
  expect(typeof cleared.unassignedAt).toBe("number");
  expect(cleared.employeeId).toBe(bea.id);
  expect(core.forTask(taskId)).toBeNull();
  expect(statusOf(() => core.unassign(taskId, cleared.revision))).toBe(409);
  const history = core.history({ taskId }).events;
  expect(history.map((event) => event.action)).toEqual(["assigned", "reassigned", "unassigned"]);
  expect(history[1]).toMatchObject({ employeeId: bea.id, previousEmployeeId: ada.id, revision: 2, provenance: "owner" });
  expect(history[0]!.id).toBeLessThan(history[1]!.id);
  expect(db.query(`SELECT action FROM employee_task_assignment_events ORDER BY id`).all()).toEqual([
    { action: "assigned" },
    { action: "reassigned" },
    { action: "unassigned" },
  ]);
});

test("a second connection that commits first wins, and the loser does not overwrite it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo010c-race-"));
  const file = path.join(dir, "assignments.sqlite");
  const db1 = new Database(file);
  const db2 = new Database(file);
  try {
    db1.exec("PRAGMA journal_mode = WAL");
    db1.exec("PRAGMA busy_timeout = 1000");
    db2.exec("PRAGMA busy_timeout = 1000");
    migrate(db1, migrations);
    db1.run(`INSERT INTO projects (path, name, added_at) VALUES (?, 'Alpha', 5)`, [A]);
    const people = new EmployeeCore(db1, { now: () => 10, random: () => 0.2, pathExists: () => true, realpath: (value) => value });
    const ada = people.createWorker({ name: "Ada", jobTitle: "QA Engineer", projectPath: A });
    const bea = people.createWorker({ name: "Bea", jobTitle: "QA Engineer", projectPath: A });
    const taskId = randomUUID();
    db1.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, 'Race', 'prompt', 'ready', 'codex', ?, 5, 5)`,
      [taskId, A],
    );
    const racing = new AssignmentCore(db1, {
      now: () => 20,
      classify: (workdir) => classifyWorkdir([A], workdir),
      beforeWrite() {
        const id = randomUUID();
        db2.run(
          `INSERT INTO employee_task_assignments (
             id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at
           ) VALUES (?, ?, ?, ?, 'active', 'owner', 1, 1, 1, 1)`,
          [id, taskId, A, bea.id],
        );
        db2.run(
          `INSERT INTO employee_task_assignment_events (
             assignment_id, task_id, project_path, employee_id, action, provenance, revision, created_at
           ) VALUES (?, ?, ?, ?, 'assigned', 'owner', 1, 1)`,
          [id, taskId, A, bea.id],
        );
      },
    });
    expect(statusOf(() => racing.assign(taskId, ada.id))).toBe(409);
    expect(db1.query(`SELECT employee_id FROM employee_task_assignments WHERE status = 'active'`).all()).toEqual([{ employee_id: bea.id }]);
    expect(db1.query(`SELECT COUNT(*) AS n FROM employee_task_assignment_events`).get()).toEqual({ n: 1 });
  } finally {
    db1.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the active-assignment index rejects a second primary row", () => {
  const taskId = addTask(A);
  db.run(
    `INSERT INTO employee_task_assignments (
       id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at
     ) VALUES ('a', ?, ?, ?, 'active', 'owner', 1, 1, 1, 1)`,
    [taskId, A, randomUUID()],
  );
  expect(() => db.run(
    `INSERT INTO employee_task_assignments (
       id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at
     ) VALUES ('b', ?, ?, ?, 'active', 'owner', 1, 1, 1, 1)`,
    [taskId, A, randomUUID()],
  )).toThrow();
});

test("rename, a new random name, and a new job title keep the assignment and its history bytes", () => {
  const ada = worker(A, "Ada", "QA Engineer");
  const taskId = addTask(A);
  const core = assignments();
  core.assign(taskId, ada.id);
  const assignmentBefore = db.query(`SELECT * FROM employee_task_assignments`).all();
  const historyBefore = db.query(`SELECT * FROM employee_task_assignment_events`).all();
  employees.update(ada.id, { name: "Ada Lovelace" });
  employees.update(ada.id, { jobTitle: "Senior QA Engineer" });
  employees.regenerateName(ada.id);
  expect(db.query(`SELECT * FROM employee_task_assignments`).all()).toEqual(assignmentBefore);
  expect(db.query(`SELECT * FROM employee_task_assignment_events`).all()).toEqual(historyBefore);
  expect(core.forTask(taskId)?.employeeId).toBe(ada.id);
  expect(core.forTask(taskId)?.employeeName).toBe(employees.get(ada.id).name);
  expect(employees.get(ada.id).jobTitle).toBe("Senior QA Engineer");
});

test("archive and a project move are refused until the tasks are unassigned", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const core = assignments();
  const created = core.assign(taskId, ada.id);
  expect(messageOf(() => employees.archive(ada.id))).toBe(ACTIVE_TASK_ASSIGNMENT_GUARD);
  expect(messageOf(() => employees.assign(ada.id, B))).toBe(ACTIVE_TASK_ASSIGNMENT_GUARD);
  expect(messageOf(() => employees.unassign(ada.id))).toBe(ACTIVE_TASK_ASSIGNMENT_GUARD);
  expect(messageOf(() => employees.update(ada.id, { status: "inactive" }))).toBe(ACTIVE_TASK_ASSIGNMENT_GUARD);
  expect(employees.get(ada.id)).toMatchObject({ projectPath: A, status: "active", name: "Ada" });
  const historyBefore = db.query(`SELECT * FROM employee_task_assignment_events`).all();
  core.unassign(taskId, created.assignment.revision);
  employees.archive(ada.id);
  expect(employees.get(ada.id).status).toBe("archived");
  expect(db.query(`SELECT * FROM employee_task_assignment_events WHERE action = 'assigned'`).all()).toEqual(historyBefore);
  expect(db.query(`SELECT project_path, status FROM employee_task_assignments`).get()).toEqual({ project_path: A, status: "unassigned" });
});

test("moving the employee to another project does not take the old task along", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const core = assignments();
  const created = core.assign(taskId, ada.id);
  core.unassign(taskId, created.assignment.revision);
  employees.assign(ada.id, B);
  expect(employees.get(ada.id).projectPath).toBe(B);
  expect(db.query(`SELECT project_path FROM employee_task_assignments`).get()).toEqual({ project_path: A });
  expect(core.forProject(B)).toEqual([]);
  expect(statusOf(() => core.assign(taskId, ada.id))).toBe(409);
});

test("a worker cannot take a task from another project", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(B, "Beta only");
  const core = assignments();
  expect(statusOf(() => core.assign(taskId, ada.id))).toBe(409);
  expect(core.forProject(A)).toEqual([]);
  expect(JSON.stringify(core.forProject(B))).not.toContain(taskId);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 0 });
});

test("a nested registered project owns its own tasks", () => {
  const outer = "/registry/repo";
  const inner = "/registry/repo/pkg";
  project(outer, "Repo");
  project(inner, "Package");
  const outerWorker = worker(outer, "Otto");
  const innerWorker = worker(inner, "Ines");
  const taskId = addTask(`${inner}/src`, "Inner task");
  const core = assignments();
  expect(statusOf(() => core.assign(taskId, outerWorker.id))).toBe(409);
  const assigned = core.assign(taskId, innerWorker.id);
  expect(assigned.assignment.projectPath).toBe(inner);
  expect(core.forProject(outer).map((row) => row.taskId)).not.toContain(taskId);
  expect(core.forProject(inner).map((row) => row.taskId)).toEqual([taskId]);
});

test("a linked git worktree belongs to the main project's worker", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo010c-wt-")));
  try {
    const main = path.join(root, "main");
    const wt = path.join(root, "wt");
    mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(path.join(wt, "web"), { recursive: true });
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`);
    writeFileSync(path.join(main, ".git", "worktrees", "feature", "gitdir"), `${path.join(wt, ".git")}\n`);
    project(main, "Main");
    const owner = worker(main, "Willa");
    const stranger = worker(B, "Sid");
    const taskId = addTask(path.join(wt, "web"), "Worktree task");
    const core = assignments();
    expect(statusOf(() => core.assign(taskId, stranger.id))).toBe(409);
    expect(core.assign(taskId, owner.id).assignment).toMatchObject({ projectPath: main, task: { visibility: "in-project" } });
    expect(core.forProject(main).map((row) => row.taskId)).toEqual([taskId]);
    expect(core.forProject(B).map((row) => row.taskId)).not.toContain(taskId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown tasks, missing projects, and an unregistered employee project are rejected", () => {
  const ada = worker(A, "Ada");
  const core = assignments();
  expect(statusOf(() => core.assign(randomUUID(), ada.id))).toBe(404);
  expect(statusOf(() => core.forTask(randomUUID()))).toBe(404);
  expect(statusOf(() => core.assign("not a uuid", ada.id))).toBe(400);
  const outside = addTask("/somewhere/else", "Outside");
  expect(messageOf(() => core.assign(outside, ada.id))).toContain("no registered project");
  expect(statusOf(() => core.forProject("/not/registered"))).toBe(404);
  db.run(`UPDATE ai_employees SET project_path = '/not/registered' WHERE id = ?`, [ada.id]);
  const inside = addTask(A);
  expect(messageOf(() => core.assign(inside, ada.id))).toContain("no longer registered");
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 0 });
});

test("removing a project keeps the assignment where it was and does not expose it through another project", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A, "Stay");
  const core = assignments();
  core.assign(taskId, ada.id);
  db.run(`DELETE FROM projects WHERE path = ?`, [A]);
  expect(statusOf(() => core.forProject(A))).toBe(404);
  expect(core.forEmployee(ada.id)[0]).toMatchObject({ projectPath: A, projectRegistered: false, task: { visibility: "unattributed", title: "Stay" } });
  expect(JSON.stringify(core.forProject(B))).not.toContain(taskId);
  expect(JSON.stringify(core.history({ projectPath: B }))).not.toContain(taskId);
});

test("a task whose folder moves to another project is not reassigned and is hidden from both project lists", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A, "Drift");
  const core = assignments();
  const created = core.assign(taskId, ada.id);
  db.run(`UPDATE tasks SET workdir = ? WHERE id = ?`, [B, taskId]);
  expect(core.forEmployee(ada.id)[0]?.task.visibility).toBe("diverged");
  expect(core.forProject(A).map((row) => row.taskId)).not.toContain(taskId);
  expect(core.forProject(B).map((row) => row.taskId)).not.toContain(taskId);
  expect(JSON.stringify(core.history({ projectPath: B }))).not.toContain(taskId);
  expect(core.history({ taskId }).events).toHaveLength(1);
  expect(JSON.stringify(core.forEmployee(ada.id))).not.toContain(B);
  expect(statusOf(() => core.reassign(taskId, worker(B, "Bea").id, created.assignment.revision))).toBe(409);
  expect(db.query(`SELECT project_path, employee_id FROM employee_task_assignments`).get()).toEqual({ project_path: A, employee_id: ada.id });
});

test("a cluster move keeps assignments, employees, and history", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  assignments().assign(taskId, ada.id);
  const clusters = new ClusterCore(db, { now: () => ++clock, pathExists: () => true, realpath: (value) => value });
  const one = clusters.create({ name: "One" });
  const two = clusters.create({ name: "Two" });
  clusters.assign(one.id, A);
  const before = {
    assignments: db.query(`SELECT * FROM employee_task_assignments`).all(),
    events: db.query(`SELECT * FROM employee_task_assignment_events`).all(),
    people: db.query(`SELECT * FROM ai_employees`).all(),
  };
  clusters.move(two.id, A);
  expect(db.query(`SELECT * FROM employee_task_assignments`).all()).toEqual(before.assignments);
  expect(db.query(`SELECT * FROM employee_task_assignment_events`).all()).toEqual(before.events);
  expect(db.query(`SELECT * FROM ai_employees`).all()).toEqual(before.people);
});

test("archived tasks, pipeline steps, managers, and inactive workers cannot be newly assigned", () => {
  const ada = worker(A, "Ada");
  const archived = addTask(A, "Old");
  db.run(`UPDATE tasks SET archived_at = 9 WHERE id = ?`, [archived]);
  const step = addTask(A, "Step");
  db.run(`UPDATE tasks SET pipeline_parent_id = ? WHERE id = ?`, [randomUUID(), step]);
  const core = assignments();
  expect(messageOf(() => core.assign(archived, ada.id))).toContain("archived");
  expect(messageOf(() => core.assign(step, ada.id))).toContain("pipeline step");
  const manager = employees.ensureProjectManager(A).employee;
  const open = addTask(A, "Open");
  expect(statusOf(() => core.assign(open, manager.id))).toBe(409);
  employees.update(ada.id, { status: "inactive" });
  expect(statusOf(() => core.assign(open, ada.id))).toBe(409);
  expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });
});

test("assignment code does not import a runner, the model router, or a process spawn", () => {
  for (const file of ["assignment-core.ts", "assignment-http.ts", "../shared/assignments/types.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(orchestrator|agents|claude-tmux|codex-tmux|cursor-tmux|gemini-tmux|fx-acp|model-router|account-core|project-execution|project-manager)/);
    expect(source).not.toMatch(/Bun\.spawn|child_process|execSync|spawnAgent/);
  }
});
