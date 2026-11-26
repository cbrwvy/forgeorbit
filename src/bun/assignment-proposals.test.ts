import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ClusterCore } from "./cluster-core.ts";
import { EmployeeCore } from "./employee-core.ts";
import { PROPOSAL_EXECUTION_NOTE, STALE_REASONS } from "../shared/assignments/proposals.ts";

const isolated = mkdtempSync(path.join(tmpdir(), "fo010d-proposals-db-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";

let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AssignmentProposalCore: typeof import("./assignment-proposals.ts").AssignmentProposalCore;
let AssignmentProposalError: typeof import("./assignment-proposals.ts").AssignmentProposalError;
let teamForPrompt: typeof import("./assignment-proposals.ts").teamForPrompt;
let classifyWorkdir: typeof import("./project-ownership.ts").classifyWorkdir;

beforeAll(async () => {
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ AssignmentProposalCore, AssignmentProposalError, teamForPrompt } = await import("./assignment-proposals.ts"));
  ({ classifyWorkdir } = await import("./project-ownership.ts"));
});

const A = "/registry/alpha";
const B = "/registry/beta";

let db: Database;
let clock = 1_000;
let employees: EmployeeCore;

function projectPaths(database: Database): string[] {
  return database.query<{ path: string }, []>(`SELECT path FROM projects`).all().map((row) => row.path);
}

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssignmentProposalError) return error.status;
    throw error;
  }
  throw new Error("expected a rejection");
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssignmentProposalError) return error.message;
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

function worker(projectPath: string | null, name: string, jobTitle = "QA Engineer") {
  return employees.createWorker({ name, jobTitle, ...(projectPath ? { projectPath } : {}) });
}

function cores(database: Database = db, paths?: () => string[]) {
  const classify = (workdir: string) => classifyWorkdir(paths ? paths() : projectPaths(database), workdir);
  const assignments = new AssignmentCore(database, { now: () => ++clock, classify });
  const proposals = new AssignmentProposalCore(database, assignments, { now: () => ++clock, classify });
  return { assignments, proposals };
}

function approveBody(proposal: { revision: number; currentAssignment: { revision: number } | null }, allowReassign = false) {
  return {
    expectedRevision: proposal.revision,
    expectedAssignmentRevision: proposal.currentAssignment?.revision ?? null,
    allowReassign,
  };
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

test("a valid proposal is stored as pending and is not an assignment", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const { proposals, assignments } = cores();
  const proposal = proposals.create(taskId, ada.id, "  Fits the QA work. ");
  expect(proposal).toMatchObject({
    taskId,
    projectPath: A,
    projectName: "Alpha",
    status: "pending",
    revision: 1,
    rationale: "Fits the QA work.",
    needsReassign: false,
    conflicts: [],
    result: null,
    currentAssignment: null,
    baseAssignment: null,
    proposedBy: { kind: "owner", employeeId: null, delegationId: null },
    worker: { id: ada.id, name: "Ada", jobTitle: "QA Engineer" },
    task: { title: "Fix the gate", column: "ready", visibility: "in-project" },
    execution: PROPOSAL_EXECUTION_NOTE,
  });
  expect(assignments.forTask(taskId)).toBeNull();
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 0 });
  expect(proposals.history(proposal.id).events.map((event) => [event.action, event.actor])).toEqual([["created", "owner"]]);
});

test("the project comes from the task, never from the caller", () => {
  const ada = worker(A, "Ada");
  const { proposals } = cores();
  const taskId = addTask(B);
  // Ada belongs to Alpha; the task is in Beta. There is no field to override that.
  expect(status(() => proposals.create(taskId, ada.id, "Wrong project"))).toBe(409);
  expect(status(() => (proposals.create as (...args: unknown[]) => unknown)(taskId, ada.id, "x", { projectPath: A }))).toBe(409);
});

test("rejects invalid ids, a missing task, a missing employee, and a missing reason", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const { proposals } = cores();
  expect(status(() => proposals.create("nope", ada.id, "x"))).toBe(400);
  expect(status(() => proposals.create(taskId, "nope", "x"))).toBe(400);
  expect(status(() => proposals.create(randomUUID(), ada.id, "x"))).toBe(404);
  expect(status(() => proposals.create(taskId, randomUUID(), "x"))).toBe(404);
  expect(status(() => proposals.create(taskId, ada.id, ""))).toBe(400);
  expect(status(() => proposals.create(taskId, ada.id, "   "))).toBe(400);
  expect(status(() => proposals.create(taskId, ada.id, 7))).toBe(400);
  expect(status(() => proposals.create(taskId, ada.id, "x".repeat(601)))).toBe(400);
  expect(db.query(`SELECT COUNT(*) AS n FROM assignment_proposals`).get()).toEqual({ n: 0 });
});

test("only an active, unarchived worker of the task's own project can be proposed", () => {
  const { proposals } = cores();
  const taskId = addTask(A);
  const head = employees.setHead({ name: "Hedda" }).employee;
  const manager = employees.ensureProjectManager(A).employee;
  const foreign = worker(B, "Bea");
  const loose = worker(null, "Lou");
  const archived = worker(A, "Archie");
  employees.archive(archived.id);
  const inactive = worker(A, "Ina");
  employees.update(inactive.id, { status: "inactive" });
  for (const person of [head, manager, foreign, loose, archived, inactive]) {
    expect(status(() => proposals.create(taskId, person.id, "Not eligible"))).toBe(409);
  }
  expect(db.query(`SELECT COUNT(*) AS n FROM assignment_proposals`).get()).toEqual({ n: 0 });
});

test("archived tasks, finished tasks, pipeline steps, and tasks outside every project are not eligible", () => {
  const ada = worker(A, "Ada");
  const { proposals } = cores();
  const archived = addTask(A, "Old");
  db.run(`UPDATE tasks SET archived_at = 9 WHERE id = ?`, [archived]);
  const done = addTask(A, "Done", "done");
  const step = addTask(A, "Step");
  db.run(`UPDATE tasks SET pipeline_parent_id = ? WHERE id = ?`, [addTask(A, "Parent"), step]);
  const outside = addTask("/somewhere/else");
  for (const id of [archived, done, step, outside]) {
    expect(status(() => proposals.create(id, ada.id, "Not eligible"))).toBe(409);
  }
});

test("a task from a foreign project cannot be proposed, listed, or read through another project", () => {
  const ada = worker(A, "Ada");
  const bea = worker(B, "Bea");
  const { proposals } = cores();
  const betaTask = addTask(B, "Beta secret title");
  expect(status(() => proposals.create(betaTask, ada.id, "Cross project"))).toBe(409);
  const own = proposals.create(betaTask, bea.id, "Beta work");
  expect(proposals.list({ projectPath: A }).proposals).toEqual([]);
  expect(proposals.list({ projectPath: B }).proposals.map((item) => item.id)).toEqual([own.id]);
  expect(status(() => proposals.list({ projectPath: "/registry/unknown" }))).toBe(404);
  expect(status(() => proposals.list({ projectPath: "relative/path" }))).toBe(400);
});

test("a nested project owns its own tasks; the parent project does not", () => {
  const nested = `${A}/web`;
  project(nested, "Web");
  const ada = worker(A, "Ada");
  const wes = worker(nested, "Wes");
  const { proposals } = cores();
  const webTask = addTask(`${nested}/src`, "Web task");
  const rootTask = addTask(`${A}/docs`, "Docs task");
  expect(status(() => proposals.create(webTask, ada.id, "Parent worker for nested task"))).toBe(409);
  expect(proposals.create(webTask, wes.id, "Nested worker").projectPath).toBe(nested);
  expect(proposals.create(rootTask, ada.id, "Parent worker for parent task").projectPath).toBe(A);
  expect(status(() => proposals.create(addTask(`${A}/docs`, "Other"), wes.id, "Nested worker for parent task"))).toBe(409);
});

test("a linked git worktree is attributed to its main checkout", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo010d-wt-")));
  const main = path.join(root, "main");
  const wt = path.join(root, "elsewhere", "feature");
  mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`);
  writeFileSync(path.join(main, ".git", "worktrees", "feature", "gitdir"), `${path.join(wt, ".git")}\n`);
  project(main, "Main");
  const mia = worker(main, "Mia");
  const ada = worker(A, "Ada");
  const { proposals } = cores();
  const taskId = addTask(wt, "Worktree task");
  expect(status(() => proposals.create(taskId, ada.id, "Wrong project"))).toBe(409);
  const proposal = proposals.create(taskId, mia.id, "Worktree belongs to Main");
  expect(proposal.projectPath).toBe(main);
});

test("an ambiguous folder cannot be proposed", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo010d-amb-")));
  const real = path.join(root, "real");
  mkdirSync(real);
  const alias = path.join(root, "alias");
  require("node:fs").symlinkSync(real, alias);
  project(real, "Real");
  project(alias, "Alias");
  const ray = worker(real, "Ray");
  const { proposals } = cores();
  const taskId = addTask(path.join(real, "x"));
  expect(status(() => proposals.create(taskId, ray.id, "Ambiguous"))).toBe(409);
});

test("an existing assignment is recorded as the base and needs explicit consent to replace", () => {
  const ada = worker(A, "Ada");
  const bea = worker(A, "Bea");
  const taskId = addTask(A);
  const { proposals, assignments } = cores();
  assignments.assign(taskId, ada.id);
  expect(status(() => proposals.create(taskId, ada.id, "Already theirs"))).toBe(409);
  const proposal = proposals.create(taskId, bea.id, "Bea has capacity");
  expect(proposal).toMatchObject({
    needsReassign: true,
    baseAssignment: { employeeId: ada.id, employeeName: "Ada", revision: 1 },
    currentAssignment: { employeeId: ada.id, revision: 1 },
  });
  expect(proposal.conflicts[0]).toContain("explicit consent");
  // No consent: nothing changes, and the proposal stays pending.
  expect(status(() => proposals.approve(proposal.id, approveBody(proposal, false)))).toBe(409);
  expect(assignments.forTask(taskId)).toMatchObject({ employeeId: ada.id, revision: 1 });
  expect(proposals.get(proposal.id).status).toBe("pending");
  // With consent: reassigned through the FO-010C core, history preserved.
  const approved = proposals.approve(proposal.id, approveBody(proposal, true));
  expect(approved.alreadyApplied).toBe(false);
  expect(approved.proposal).toMatchObject({ status: "approved", revision: 2, result: { reassigned: true, assignmentRevision: 2 } });
  expect(assignments.forTask(taskId)).toMatchObject({ employeeId: bea.id, revision: 2 });
  expect(assignments.history({ taskId }).events.map((event) => event.action)).toEqual(["assigned", "reassigned"]);
});

test("owner approval assigns through the assignment core and records the result", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const { proposals, assignments } = cores();
  const proposal = proposals.create(taskId, ada.id, "Ada owns QA");
  const result = proposals.approve(proposal.id, approveBody(proposal));
  expect(result.alreadyApplied).toBe(false);
  expect(result.proposal).toMatchObject({
    status: "approved",
    revision: 2,
    decidedFromRevision: 1,
    result: { reassigned: false, assignmentRevision: 1 },
  });
  const assignment = assignments.forTask(taskId);
  expect(assignment).toMatchObject({ employeeId: ada.id, provenance: "owner" });
  expect(result.proposal.result?.assignmentId).toBe(assignment?.id);
  expect(proposals.history(proposal.id).events.map((event) => [event.action, event.actor, event.reassign])).toEqual([
    ["created", "owner", null],
    ["approved", "owner", false],
  ]);
});

test("owner rejection and cancellation change only the proposal", () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const rejectedTask = addTask(A, "One");
  const cancelledTask = addTask(A, "Two");
  const first = proposals.create(rejectedTask, ada.id, "Maybe");
  const second = proposals.create(cancelledTask, ada.id, "Maybe too");
  expect(proposals.reject(first.id, first.revision).proposal).toMatchObject({ status: "rejected", revision: 2, result: null });
  expect(proposals.cancel(second.id, second.revision).proposal).toMatchObject({ status: "cancelled", revision: 2 });
  expect(assignments.forTask(rejectedTask)).toBeNull();
  expect(assignments.forTask(cancelledTask)).toBeNull();
  expect(status(() => proposals.approve(first.id, { expectedRevision: 2, expectedAssignmentRevision: null, allowReassign: false }))).toBe(409);
  // A decided task can be proposed again.
  expect(proposals.create(rejectedTask, ada.id, "Second try").status).toBe("pending");
});

test("only one pending proposal exists per task", () => {
  const ada = worker(A, "Ada");
  const bea = worker(A, "Bea");
  const taskId = addTask(A);
  const { proposals } = cores();
  proposals.create(taskId, ada.id, "First");
  expect(message(() => proposals.create(taskId, bea.id, "Second"))).toContain("pending proposal");
  expect(db.query(`SELECT COUNT(*) AS n FROM assignment_proposals`).get()).toEqual({ n: 1 });
});

test("approve, reject and cancel are idempotent for the revision they were decided at", () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  const proposal = proposals.create(taskId, ada.id, "Ada");
  const body = approveBody(proposal);
  const first = proposals.approve(proposal.id, body);
  const events = db.query(`SELECT COUNT(*) AS n FROM employee_task_assignment_events`).get();
  const again = proposals.approve(proposal.id, body);
  expect(first.alreadyApplied).toBe(false);
  expect(again.alreadyApplied).toBe(true);
  expect(again.proposal).toEqual(first.proposal);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignment_events`).get()).toEqual(events);
  expect(assignments.history({ taskId }).events).toHaveLength(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM assignment_proposal_events WHERE action = 'approved'`).get()).toEqual({ n: 1 });
  // A different revision is not a replay.
  expect(status(() => proposals.approve(proposal.id, { ...body, expectedRevision: 5 }))).toBe(409);

  const other = proposals.create(addTask(A, "Two"), ada.id, "Maybe");
  expect(proposals.reject(other.id, other.revision).alreadyApplied).toBe(false);
  expect(proposals.reject(other.id, other.revision).alreadyApplied).toBe(true);
  expect(status(() => proposals.cancel(other.id, other.revision))).toBe(409);
});

test("two concurrent approvals create exactly one assignment", async () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  const proposal = proposals.create(taskId, ada.id, "Ada");
  const body = approveBody(proposal);
  const results = await Promise.all([
    Promise.resolve().then(() => proposals.approve(proposal.id, body)),
    Promise.resolve().then(() => proposals.approve(proposal.id, body)),
  ]);
  expect(results.map((item) => item.alreadyApplied).sort()).toEqual([false, true]);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 1 });
  expect(assignments.history({ taskId }).events).toHaveLength(1);
});

test("a second connection that approves first wins; the loser replays instead of assigning twice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo010d-race-"));
  const file = path.join(dir, "proposals.sqlite");
  const db1 = new Database(file);
  const db2 = new Database(file);
  try {
    db1.exec("PRAGMA journal_mode = WAL");
    db1.exec("PRAGMA busy_timeout = 0");
    db2.exec("PRAGMA busy_timeout = 0");
    migrate(db1, migrations);
    db1.run(`INSERT INTO projects (path, name, added_at) VALUES (?, 'Alpha', 5)`, [A]);
    const people = new EmployeeCore(db1, { now: () => 10, random: () => 0.2, pathExists: () => true, realpath: (value) => value });
    const ada = people.createWorker({ name: "Ada", jobTitle: "QA Engineer", projectPath: A });
    const taskId = randomUUID();
    db1.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, 'Race', 'prompt', 'ready', 'codex', ?, 5, 5)`,
      [taskId, A],
    );
    const one = cores(db1, () => [A]);
    const two = cores(db2, () => [A]);
    const proposal = one.proposals.create(taskId, ada.id, "Ada");
    const body = approveBody(proposal);
    expect(two.proposals.approve(proposal.id, body).alreadyApplied).toBe(false);
    expect(one.proposals.approve(proposal.id, body).alreadyApplied).toBe(true);
    expect(db1.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 1 });
    expect(db1.query(`SELECT COUNT(*) AS n FROM employee_task_assignment_events`).get()).toEqual({ n: 1 });

    // A writer holding the lock makes the other one fail closed.
    const lockedTask = randomUUID();
    db1.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, 'Locked', 'prompt', 'ready', 'codex', ?, 5, 5)`,
      [lockedTask, A],
    );
    const locked = one.proposals.create(lockedTask, ada.id, "Locked");
    db2.exec("BEGIN IMMEDIATE");
    try {
      expect(status(() => one.proposals.approve(locked.id, approveBody(locked)))).toBe(409);
    } finally {
      db2.exec("ROLLBACK");
    }
    expect(db1.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 1 });
    expect(one.proposals.get(locked.id).status).toBe("pending");
  } finally {
    db1.close();
    db2.close();
  }
});

test("a stale proposal revision is refused and changes nothing", () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  const proposal = proposals.create(taskId, ada.id, "Ada");
  expect(status(() => proposals.approve(proposal.id, { ...approveBody(proposal), expectedRevision: 9 }))).toBe(409);
  expect(status(() => proposals.approve(proposal.id, { ...approveBody(proposal), expectedAssignmentRevision: 4 }))).toBe(409);
  expect(status(() => proposals.reject(proposal.id, 9))).toBe(409);
  expect(status(() => proposals.approve(proposal.id, { ...approveBody(proposal), allowReassign: "yes" }))).toBe(400);
  expect(status(() => proposals.approve(proposal.id, { ...approveBody(proposal), expectedRevision: 0 }))).toBe(400);
  expect(status(() => proposals.approve(proposal.id, { ...approveBody(proposal), expectedAssignmentRevision: undefined }))).toBe(400);
  expect(assignments.forTask(taskId)).toBeNull();
  expect(proposals.get(proposal.id)).toMatchObject({ status: "pending", revision: 1 });
});

test("a changed assignment makes the proposal stale instead of replacing it silently", () => {
  const ada = worker(A, "Ada");
  const bea = worker(A, "Bea");
  const cal = worker(A, "Cal");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  assignments.assign(taskId, ada.id);
  const proposal = proposals.create(taskId, bea.id, "Bea");
  // Someone reassigns the task after the proposal was written.
  assignments.reassign(taskId, cal.id, 1);
  const refused = (() => {
    try {
      proposals.approve(proposal.id, { expectedRevision: 1, expectedAssignmentRevision: 1, allowReassign: true });
    } catch (error) {
      return error as InstanceType<typeof AssignmentProposalError>;
    }
    throw new Error("expected a rejection");
  })();
  expect(refused.status).toBe(409);
  expect(refused.message).toBe(STALE_REASONS.assignmentChanged);
  expect(refused.proposal).toMatchObject({ status: "stale", staleReason: STALE_REASONS.assignmentChanged });
  expect(assignments.forTask(taskId)).toMatchObject({ employeeId: cal.id, revision: 2 });
  expect(assignments.history({ taskId }).events.map((event) => event.action)).toEqual(["assigned", "reassigned"]);
  expect(proposals.history(proposal.id).events.map((event) => [event.action, event.actor])).toEqual([
    ["created", "owner"],
    ["stale", "system"],
  ]);
});

test("a task assigned or unassigned by someone else after proposing goes stale", () => {
  const ada = worker(A, "Ada");
  const bea = worker(A, "Bea");
  const { proposals, assignments } = cores();
  const free = addTask(A, "Free");
  const held = addTask(A, "Held");
  assignments.assign(held, ada.id);
  const onFree = proposals.create(free, ada.id, "Ada");
  const onHeld = proposals.create(held, bea.id, "Bea");
  assignments.assign(free, bea.id);
  assignments.unassign(held, 1);
  expect(proposals.get(onFree.id).staleReason).toBe(STALE_REASONS.assignmentChanged);
  expect(proposals.get(onHeld.id).staleReason).toBe(STALE_REASONS.assignmentChanged);
  const direct = addTask(A, "Direct");
  const same = proposals.create(direct, ada.id, "Ada");
  assignments.assign(direct, ada.id);
  expect(proposals.get(same.id).staleReason).toBe(STALE_REASONS.alreadyAssigned);
});

test("proposals go stale when the task is archived, finished, moved, or deleted", () => {
  const ada = worker(A, "Ada");
  const { proposals } = cores();
  const archived = proposals.create(addTask(A, "a"), ada.id, "x");
  const done = proposals.create(addTask(A, "b"), ada.id, "x");
  const moved = proposals.create(addTask(A, "c"), ada.id, "x");
  const gone = proposals.create(addTask(A, "d"), ada.id, "x");
  db.run(`UPDATE tasks SET archived_at = 9 WHERE id = ?`, [archived.taskId]);
  db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [done.taskId]);
  db.run(`UPDATE tasks SET workdir = ? WHERE id = ?`, [B, moved.taskId]);
  db.run(`DELETE FROM tasks WHERE id = ?`, [gone.taskId]);
  const byId = Object.fromEntries(proposals.list({ projectPath: A }).proposals.map((item) => [item.id, item]));
  expect(byId[archived.id]).toMatchObject({ status: "stale", staleReason: STALE_REASONS.taskArchived });
  expect(byId[done.id]).toMatchObject({ status: "stale", staleReason: STALE_REASONS.taskDone });
  expect(byId[moved.id]).toMatchObject({ status: "stale", staleReason: STALE_REASONS.taskMoved });
  expect(byId[gone.id]).toMatchObject({ status: "stale", staleReason: STALE_REASONS.taskMissing, task: { title: null, visibility: "missing" } });
  // A moved task's title is not shown through the old project.
  expect(byId[moved.id]?.task).toMatchObject({ title: null, visibility: "diverged" });
});

test("a removed project makes its proposals stale and approval refuses", () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  const proposal = proposals.create(taskId, ada.id, "Ada");
  db.run(`DELETE FROM projects WHERE path = ?`, [A]);
  expect(status(() => proposals.approve(proposal.id, approveBody(proposal)))).toBe(409);
  expect(proposals.get(proposal.id)).toMatchObject({ status: "stale", staleReason: STALE_REASONS.projectRemoved, projectRegistered: false });
  expect(assignments.forTask(taskId)).toBeNull();
  expect(status(() => proposals.list({ projectPath: A }))).toBe(404);
  expect(proposals.list({}).proposals.map((item) => item.id)).toContain(proposal.id);
});

test("a worker who is archived, paused, or moved makes the proposal stale", () => {
  const { proposals } = cores();
  const archived = worker(A, "Archie");
  const paused = worker(A, "Pam");
  const moved = worker(A, "Max");
  const a = proposals.create(addTask(A, "a"), archived.id, "x");
  const p = proposals.create(addTask(A, "b"), paused.id, "x");
  const m = proposals.create(addTask(A, "c"), moved.id, "x");
  employees.archive(archived.id);
  employees.update(paused.id, { status: "inactive" });
  employees.assign(moved.id, B);
  expect(proposals.get(a.id).staleReason).toBe(STALE_REASONS.workerArchived);
  expect(proposals.get(p.id).staleReason).toBe(STALE_REASONS.workerInactive);
  expect(proposals.get(m.id).staleReason).toBe(STALE_REASONS.workerMoved);
  const still = (id: string) => status(() => proposals.approve(id, { expectedRevision: 2, expectedAssignmentRevision: null, allowReassign: false }));
  expect(still(a.id)).toBe(409);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 0 });
});

test("a project moving between clusters keeps its proposals valid", () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  const proposal = proposals.create(taskId, ada.id, "Ada");
  const clusters = new ClusterCore(db, { now: () => ++clock, pathExists: () => true, realpath: (value) => value });
  const one = clusters.create({ name: "One" });
  const two = clusters.create({ name: "Two" });
  clusters.assign(one.id, A);
  expect(proposals.get(proposal.id)).toMatchObject({ status: "pending", conflicts: [] });
  clusters.move(two.id, A);
  const after = proposals.get(proposal.id);
  expect(after).toMatchObject({ status: "pending", revision: 1, conflicts: [], projectPath: A });
  expect(proposals.approve(proposal.id, approveBody(after)).proposal.status).toBe("approved");
  expect(assignments.forTask(taskId)?.employeeId).toBe(ada.id);
});

test("refresh only ever moves pending to stale and never touches assignments", () => {
  const ada = worker(A, "Ada");
  const { proposals, assignments } = cores();
  const taskId = addTask(A);
  assignments.assign(taskId, ada.id);
  const bea = worker(A, "Bea");
  const proposal = proposals.create(taskId, bea.id, "Bea");
  employees.archive(bea.id);
  const before = db.query(`SELECT * FROM employee_task_assignments`).all();
  const events = db.query(`SELECT * FROM employee_task_assignment_events`).all();
  expect(proposals.refresh()).toBe(1);
  expect(proposals.refresh()).toBe(0);
  expect(proposals.get(proposal.id).status).toBe("stale");
  expect(db.query(`SELECT * FROM employee_task_assignments`).all()).toEqual(before);
  expect(db.query(`SELECT * FROM employee_task_assignment_events`).all()).toEqual(events);
});

test("the proposal audit trail is append-only and survives deleted tasks and employees", () => {
  const ada = worker(A, "Ada");
  const { proposals } = cores();
  const taskId = addTask(A);
  const proposal = proposals.create(taskId, ada.id, "Ada");
  proposals.reject(proposal.id, 1);
  const rows = db.query<{ id: number; action: string }, []>(`SELECT id, action FROM assignment_proposal_events ORDER BY id`).all();
  expect(rows.map((row) => row.action)).toEqual(["created", "rejected"]);
  db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  employees.archive(ada.id);
  expect(db.query<{ id: number }, []>(`SELECT id FROM assignment_proposal_events ORDER BY id`).all().map((row) => row.id)).toEqual(rows.map((row) => row.id));
  expect(proposals.history(proposal.id).events).toHaveLength(2);
  expect(proposals.get(proposal.id)).toMatchObject({ status: "rejected", task: { visibility: "missing" } });
  // The module never updates or deletes an event row.
  const source = require("node:fs").readFileSync(path.join(import.meta.dir, "assignment-proposals.ts"), "utf8") as string;
  expect(source).not.toMatch(/UPDATE\s+assignment_proposal_events/i);
  expect(source).not.toMatch(/DELETE\s+FROM\s+assignment_proposal_events/i);
});

test("proposals touch no runs, accounts, quota, profiles, harnesses, or the tasks and employees they name", () => {
  const ada = worker(A, "Ada");
  const taskId = addTask(A);
  const { proposals } = cores();
  const snapshot = () => ({
    task: db.query(`SELECT * FROM tasks WHERE id = ?`).get(taskId),
    employee: db.query(`SELECT * FROM ai_employees WHERE id = ?`).get(ada.id),
    runs: db.query(`SELECT COUNT(*) AS n FROM runs`).get(),
    accounts: db.query(`SELECT COUNT(*) AS n FROM resource_accounts`).get(),
    profiles: db.query(`SELECT COUNT(*) AS n FROM agent_profiles`).get(),
    harnesses: db.query(`SELECT * FROM harnesses`).all(),
    managers: db.query(`SELECT * FROM project_managers`).all(),
    projects: db.query(`SELECT * FROM projects`).all(),
  });
  const before = snapshot();
  const proposal = proposals.create(taskId, ada.id, "Ada");
  proposals.approve(proposal.id, approveBody(proposal));
  expect(snapshot()).toEqual(before);
  const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'router%'`).all();
  for (const table of tables) expect(db.query(`SELECT COUNT(*) AS n FROM ${table.name}`).get()).toEqual({ n: 0 });
});

test("proposals from a project manager are resolved server-side and invalid ones are dropped", () => {
  const ada = worker(A, "Ada");
  const bea = worker(B, "Bea");
  const pm = employees.ensureProjectManager(A).employee;
  const good = addTask(A, "Good");
  const taken = addTask(A, "Taken");
  new AssignmentCore(db, { now: () => ++clock, classify: (w) => classifyWorkdir([A, B], w) }).assign(taken, ada.id);
  const foreignTask = addTask(B, "Foreign");
  const { proposals } = cores();
  const ref = (id: string) => id.replace(/-/g, "").slice(0, 8);
  const result = proposals.createFromManager(A, [
    { taskRef: good.slice(0, 8), workerRef: ref(ada.id), rationale: "Ada fits." },
    { taskRef: "deadbeef", workerRef: ref(ada.id), rationale: "No such task." },
    { taskRef: good.slice(0, 8), workerRef: "deadbeef", rationale: "No such worker." },
    { taskRef: foreignTask.slice(0, 8), workerRef: ref(ada.id), rationale: "Foreign task." },
    { taskRef: good.slice(0, 8), workerRef: ref(bea.id), rationale: "Foreign worker." },
    { taskRef: taken.slice(0, 8), workerRef: ref(ada.id), rationale: "Already theirs." },
  ], { messageId: "m1", delegationId: "d1" });
  expect(result.created).toHaveLength(1);
  expect(result.dropped).toHaveLength(5);
  expect(result.created[0]).toMatchObject({
    taskId: good,
    status: "pending",
    proposedBy: { kind: "project-manager", employeeId: pm.id, employeeName: pm.name, delegationId: "d1" },
  });
  expect(db.query(`SELECT source_message_id FROM assignment_proposals`).get()).toEqual({ source_message_id: "m1" });
  expect(proposals.history(result.created[0]!.id).events[0]).toMatchObject({ action: "created", actor: "project-manager" });
  // A manager proposal still needs the owner: nothing was assigned.
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments WHERE task_id = ?`).get(good)).toEqual({ n: 0 });
  // Manager output can only target its own registered project.
  expect(proposals.createFromManager("/registry/unknown", [{ taskRef: good.slice(0, 8), workerRef: ref(ada.id), rationale: "x" }], { messageId: null, delegationId: null }).created).toEqual([]);
});

test("a manager reply cannot flood the owner's review queue", () => {
  const ada = worker(A, "Ada");
  const { proposals } = cores();
  const ref = (id: string) => id.replace(/-/g, "").slice(0, 8);
  const drafts = Array.from({ length: 60 }, (_, index) => ({
    taskRef: addTask(A, `Task ${index}`).slice(0, 8),
    workerRef: ref(ada.id),
    rationale: "Fits",
  }));
  let created = 0;
  for (let index = 0; index < drafts.length; index += 10) {
    created += proposals.createFromManager(A, drafts.slice(index, index + 10), { messageId: null, delegationId: null }).created.length;
  }
  expect(created).toBe(50);
});

test("the summary counts pending proposals per registered project only", () => {
  const ada = worker(A, "Ada");
  const bea = worker(B, "Bea");
  const { proposals } = cores();
  proposals.create(addTask(A, "a1"), ada.id, "x");
  proposals.create(addTask(A, "a2"), ada.id, "x");
  const b1 = proposals.create(addTask(B, "b1"), bea.id, "x");
  proposals.reject(b1.id, 1);
  expect(proposals.summary()).toMatchObject({ pendingTotal: 2, projects: [{ projectPath: A, projectName: "Alpha", pending: 2 }] });
  db.run(`DELETE FROM projects WHERE path = ?`, [A]);
  expect(proposals.summary()).toEqual({ pendingTotal: 0, projects: [] });
});

test("the manager prompt team lists only active workers of the project and who holds which task", () => {
  const ada = worker(A, "Ada", "Backend Engineer");
  const archived = worker(A, "Archie");
  employees.archive(archived.id);
  worker(B, "Bea");
  employees.ensureProjectManager(A);
  const { assignments } = cores();
  const taskId = addTask(A);
  assignments.assign(taskId, ada.id);
  const { team, assignees } = teamForPrompt(db, A);
  expect(team.map((member) => [member.name, member.jobTitle, member.openAssignments])).toEqual([["Ada", "Backend Engineer", 1]]);
  expect(assignees.get(taskId)).toBe("Ada");
});
