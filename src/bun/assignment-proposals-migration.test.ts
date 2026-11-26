import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const ID = "084_organization_assignment_proposals";

test("084 follows 082, leaves 083 free for FO-009F, and applies fresh, on upgrade, and on rerun", () => {
  const ids = migrations.map((migration) => migration.id);
  const atId = ids.indexOf(ID);
  const at082 = ids.indexOf("082_knowledge_context");
  expect(atId).toBe(at082 + 1);
  expect(ids[at082]).toBe("082_knowledge_context");
  expect(ids.some((id) => id.startsWith("083_"))).toBe(false);
  expect(new Set(ids).size).toBe(ids.length);

  const fresh = new Database(":memory:");
  const upgraded = new Database(":memory:");
  try {
    fresh.run("PRAGMA foreign_keys = ON");
    expect(migrate(fresh, migrations)).toContain(ID);
    expect(migrate(fresh, migrations)).toEqual([]);
    expect(fresh.query(`PRAGMA foreign_key_check`).all()).toEqual([]);

    upgraded.run("PRAGMA foreign_keys = ON");
    migrate(upgraded, migrations.slice(0, atId));
    expect(upgraded.query(`SELECT name FROM sqlite_master WHERE name LIKE 'assignment_proposal%'`).all()).toEqual([]);
    expect(migrate(upgraded, migrations)).toEqual(ids.slice(atId));
    expect(migrate(upgraded, migrations)).toEqual([]);
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("084 adds only its own tables and does not rewrite employees, assignments, tasks, runs, or projects", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations.slice(0, migrations.findIndex((migration) => migration.id === ID)));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('task-1', 'Keep', 'prompt', 'ready', 'codex', '/registry/app', 5, 5)`);
    db.run(`INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at) VALUES ('worker-1', 'worker', 'Ada', 'owner', 'QA Engineer', 'quality', 'active', 1, 1)`);
    db.run(
      `INSERT INTO employee_task_assignments (id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at)
       VALUES ('assign-1', 'task-1', '/registry/app', 'worker-1', 'active', 'owner', 1, 1, 1, 1)`,
    );
    const names = () => db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name`).all().map((row) => row.name);
    const before = {
      names: names(),
      employees: db.query(`SELECT * FROM ai_employees`).all(),
      assignments: db.query(`SELECT * FROM employee_task_assignments`).all(),
      tasks: db.query(`SELECT * FROM tasks`).all(),
      projects: db.query(`SELECT * FROM projects`).all(),
      columns: db.query(`PRAGMA table_info(employee_task_assignments)`).all(),
    };
    expect(migrate(db, migrations.slice(0, migrations.findIndex(m => m.id === "086_head_portfolio_binding")))).toEqual([ID, "085_employee_execution_attribution"]);
    const added = names().filter((name) => !before.names.includes(name));
    expect(added.every((name) => name.startsWith("assignment_proposal") || name.startsWith("sqlite_autoindex_assignment_proposal") || name === "sqlite_sequence" || name.startsWith("employee_executions") || name.startsWith("sqlite_autoindex_employee_executions"))).toBe(true);
    expect(added).toContain("assignment_proposals");
    expect(added).toContain("assignment_proposal_events");
    expect(db.query(`SELECT * FROM ai_employees`).all()).toEqual(before.employees);
    expect(db.query(`SELECT * FROM employee_task_assignments`).all()).toEqual(before.assignments);
    expect(db.query(`SELECT * FROM tasks`).all()).toEqual(before.tasks);
    expect(db.query(`SELECT * FROM projects`).all()).toEqual(before.projects);
    expect(db.query(`PRAGMA table_info(employee_task_assignments)`).all()).toEqual(before.columns);
    // Proposals carry no foreign keys, so deleting a task, employee, or project never cascades into them.
    expect(db.query(`PRAGMA foreign_key_list(assignment_proposals)`).all()).toEqual([]);
    expect(db.query(`PRAGMA foreign_key_list(assignment_proposal_events)`).all()).toEqual([]);
    // No harness, account, model, or profile column: a proposal names a worker only.
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(assignment_proposals)`).all().map((row) => row.name).join(" ");
    expect(columns).not.toMatch(/harness|account|model|profile|effort|quota|score|performance/);
  } finally {
    db.close();
  }
});

test("084 constraints keep proposals consistent", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations);
    const insert = (over: Record<string, unknown> = {}) => {
      const row = {
        id: crypto.randomUUID(), task_id: "t", project_path: "/p", employee_id: "e", proposed_by_kind: "owner",
        rationale: "why", status: "pending", revision: 1, created_at: 1, updated_at: 1, decided_at: null,
        assignment_id: null, stale_reason: null, base_assignee_id: null, base_assignment_revision: null, ...over,
      };
      const keys = Object.keys(row);
      db.run(`INSERT INTO assignment_proposals (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, Object.values(row) as never[]);
    };
    insert({ task_id: "t1" });
    expect(() => insert({ task_id: "t1" })).toThrow(/UNIQUE/);
    insert({ task_id: "t1", status: "rejected", decided_at: 2 });
    expect(() => insert({ task_id: "t2", status: "banana" })).toThrow();
    expect(() => insert({ task_id: "t2", proposed_by_kind: "head" })).toThrow();
    expect(() => insert({ task_id: "t2", rationale: "   " })).toThrow();
    expect(() => insert({ task_id: "t2", status: "approved", decided_at: 2 })).toThrow();
    expect(() => insert({ task_id: "t2", status: "stale", decided_at: 2 })).toThrow();
    expect(() => insert({ task_id: "t2", base_assignee_id: "e2" })).toThrow();
  } finally {
    db.close();
  }
});

test("the proposal modules never run an agent, call the router, or spawn a process", () => {
  for (const file of ["assignment-proposals.ts", "assignment-proposal-http.ts", "../shared/assignments/proposals.ts"]) {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    expect(source).not.toMatch(/from "\.\/(orchestrator|agents|isolated-agent-turn|project-execution|execution-batches)/);
    expect(source).not.toMatch(/model-router|account-core|quota|Bun\.spawn|child_process|spawnAgent|startTask/);
    expect(source).not.toMatch(/\bfetch\(/);
  }
});
