import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const ID = "085_employee_execution_attribution";

test("085 follows 084, leaves 083 free, and applies fresh, on upgrade from 084, and on rerun", () => {
  const ids = migrations.map((migration) => migration.id);
  const atId = ids.indexOf(ID);
  const at084 = ids.indexOf("084_organization_assignment_proposals");
  const at086 = ids.indexOf("086_head_portfolio_binding");
  expect(atId).toBe(at084 + 1);
  expect(at086).toBe(atId + 1);
  expect(ids.some((id) => id.startsWith("083_"))).toBe(false);
  expect(new Set(ids).size).toBe(ids.length);

  const fresh = new Database(":memory:");
  const upgraded = new Database(":memory:");
  try {
    fresh.run("PRAGMA foreign_keys = ON");
    expect(migrate(fresh, migrations)).toContain(ID);
    expect(migrate(fresh, migrations)).toEqual([]);
    expect(fresh.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(fresh.query<{ integrity_check: string }, []>(`PRAGMA integrity_check`).get()?.integrity_check).toBe("ok");

    upgraded.run("PRAGMA foreign_keys = ON");
    migrate(upgraded, migrations.slice(0, atId));
    expect(upgraded.query(`SELECT name FROM sqlite_master WHERE name LIKE 'employee_execution%'`).all()).toEqual([]);
    expect(migrate(upgraded, migrations)).toEqual(ids.slice(atId));
    expect(migrate(upgraded, migrations)).toEqual([]);
    expect(upgraded.query<{ integrity_check: string }, []>(`PRAGMA integrity_check`).get()?.integrity_check).toBe("ok");
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("085 adds only its own table and keeps runs, employees, assignments, proposals, grants and tasks untouched", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations.slice(0, migrations.findIndex((migration) => migration.id === ID)));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('task-1', 'Keep', 'prompt', 'ready', 'codex', '/registry/app', 5, 5)`);
    db.run(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('run-1', 'task-1', 'codex', 'succeeded', 6)`);
    db.run(`INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at) VALUES ('worker-1', 'worker', 'Ada', 'owner', 'QA Engineer', 'quality', 'active', 1, 1)`);
    db.run(
      `INSERT INTO employee_task_assignments (id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at)
       VALUES ('assign-1', 'task-1', '/registry/app', 'worker-1', 'active', 'owner', 1, 1, 1, 1)`,
    );
    db.run(
      `INSERT INTO assignment_proposals (id, task_id, project_path, employee_id, proposed_by_kind, rationale, status, revision, created_at, updated_at)
       VALUES ('prop-1', 'task-1', '/registry/app', 'worker-1', 'owner', 'why', 'pending', 1, 1, 1)`,
    );
    const names = () => db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name`).all().map((row) => row.name);
    const snapshot = () => ({
      runs: db.query(`SELECT * FROM runs`).all(),
      employees: db.query(`SELECT * FROM ai_employees`).all(),
      assignments: db.query(`SELECT * FROM employee_task_assignments`).all(),
      proposals: db.query(`SELECT * FROM assignment_proposals`).all(),
      tasks: db.query(`SELECT * FROM tasks`).all(),
      projects: db.query(`SELECT * FROM projects`).all(),
      runColumns: db.query(`PRAGMA table_info(runs)`).all(),
    });
    const before = snapshot();
    const namesBefore = names();
    expect(migrate(db, migrations.slice(0, migrations.findIndex(m => m.id === "086_head_portfolio_binding")))).toEqual([ID]);
    expect(snapshot()).toEqual(before);
    const added = names().filter((name) => !namesBefore.includes(name));
    expect(added.every((name) => name.startsWith("employee_executions") || name.startsWith("sqlite_autoindex_employee_executions"))).toBe(true);
    expect(added).toContain("employee_executions");
    // Existing runs are never back-filled.
    expect(db.query(`SELECT COUNT(*) AS n FROM employee_executions`).get()).toEqual({ n: 0 });
    // Soft references only: deleting a task or employee never rewrites this history.
    expect(db.query(`PRAGMA foreign_key_list(employee_executions)`).all()).toEqual([]);
    // No account or credential column; actual_* exist and default to Unknown.
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(employee_executions)`).all().map((row) => row.name).join(" ");
    expect(columns).not.toMatch(/token|password|secret|credential|email|cost|score|performance/);
    expect(columns).toContain("actual_model");
  } finally {
    db.close();
  }
});

test("085 constraints keep attempts consistent: one open claim per task, one attempt per run", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations);
    const insert = (over: Record<string, unknown> = {}) => {
      const row = {
        id: crypto.randomUUID(), task_id: "t", task_title: "T", project_path: "/p", employee_id: "e", employee_name: "N",
        assignment_id: "a", assignment_revision: 1, status: "awaiting-approval", requested_harness_id: "codex",
        requested_policy: "balanced", requested_mode: "auto", inputs_key: "k", task_fingerprint: "f", config_json: "{}",
        review_json: "{}", created_at: 1, updated_at: 1, expires_at: 9, ...over,
      };
      const keys = Object.keys(row);
      db.run(`INSERT INTO employee_executions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, Object.values(row) as never[]);
    };
    insert({ task_id: "t1" });
    expect(() => insert({ task_id: "t1" })).toThrow(/UNIQUE/);
    expect(() => insert({ task_id: "t1", status: "starting", approved_at: 2 })).toThrow(/UNIQUE/);
    insert({ task_id: "t1", status: "rejected" });
    insert({ task_id: "t1", status: "indeterminate", approved_at: 2 });
    expect(() => insert({ task_id: "t2", status: "banana" })).toThrow();
    expect(() => insert({ task_id: "t2", status: "starting" })).toThrow(); // starting needs an approval time
    expect(() => insert({ task_id: "t2", status: "started", approved_at: 2 })).toThrow(); // started needs started_at
    expect(() => insert({ task_id: "t2", actual_provenance: "guess" })).toThrow();
    expect(() => insert({ task_id: "t2", finished_at: 3 })).toThrow(); // finish needs a result
    insert({ task_id: "t3", status: "started", approved_at: 2, started_at: 3, run_id: "run-x" });
    expect(() => insert({ task_id: "t4", status: "started", approved_at: 2, started_at: 3, run_id: "run-x" })).toThrow(/UNIQUE/);
    // Actual resources default to Unknown.
    const row = db.query<any, []>(`SELECT * FROM employee_executions WHERE task_id = 't3'`).get();
    expect(row).toMatchObject({ actual_harness_id: null, actual_model: null, actual_account_id: null, actual_provenance: "unknown" });
  } finally {
    db.close();
  }
});

test("the runner modules add no second runtime: no spawn, no shell, no provider call", () => {
  for (const file of ["employee-run.ts", "employee-run-core.ts", "employee-execution-http.ts", "../shared/execution/run.ts"]) {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    expect(source).not.toMatch(/Bun\.spawn|child_process|spawnAgent|execSync|\bfetch\(|buildCommand|tmux/);
    expect(source).not.toMatch(/from "[^"]*(account-core|knowledge)[^"]*"|new AccountCore|knowledge_context/);
  }
  // The one path to a run is the existing supervised launcher.
  expect(readFileSync(path.join(import.meta.dir, "employee-run.ts"), "utf8")).toContain("launchEmployeeTask");
});
