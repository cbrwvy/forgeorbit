import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const ID = "093_task_dependency_tombstones";

function seedTask(db: Database, id: string, title: string) {
  db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, 'p', 'ready', 'codex', '/p', 1, 1)`, [id, title]);
}

test("093 and 094 apply fresh, on upgrade and on rerun, and 093 keeps its place after 092", () => {
  const ids = migrations.map((m) => m.id);
  expect(ids.indexOf(ID)).toBe(ids.indexOf("092_company_activity_journal") + 1);
  expect(ids.indexOf("094_task_plan_queues")).toBe(ids.indexOf(ID) + 1);
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations.slice(0, ids.indexOf(ID)));
    expect(migrate(db, migrations)).toEqual(ids.slice(ids.indexOf(ID)));
    expect(migrate(db, migrations)).toEqual([]);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("deleting a prerequisite leaves a tombstone for each dependent; deleting a dependent removes its own", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    seedTask(db, "a", "Task A");
    seedTask(db, "b", "Task B");
    seedTask(db, "c", "Task C");
    db.run(`INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES ('b', 'a', 1), ('c', 'b', 1)`);
    db.run(`DELETE FROM tasks WHERE id = 'a'`);
    expect(db.query(`SELECT task_id, missing_id, missing_title, cleared_at FROM task_dependency_tombstones`).all())
      .toEqual([{ task_id: "b", missing_id: "a", missing_title: "Task A", cleared_at: null }]);
    expect(db.query(`SELECT COUNT(*) AS n FROM task_dependencies`).get()).toEqual({ n: 1 });
    // A task nobody depended on leaves nothing behind.
    db.run(`DELETE FROM tasks WHERE id = 'c'`);
    expect(db.query(`SELECT COUNT(*) AS n FROM task_dependency_tombstones`).get()).toEqual({ n: 1 });
    db.run(`DELETE FROM tasks WHERE id = 'b'`);
    expect(db.query(`SELECT COUNT(*) AS n FROM task_dependency_tombstones`).get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("upgrading records only the links a stored proposal named for a prerequisite that is already gone", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((m) => m.id === ID);
    migrate(db, migrations.slice(0, at));
    seedTask(db, "b", "Top");
    seedTask(db, "free", "Unrelated");
    seedTask(db, "alive", "Alive base");
    seedTask(db, "d", "Linked to alive");
    const item = (id: string, title: string, taskId: string | null, dependsOn: unknown[] = []) => ({
      id, title, dependsOn, result: taskId ? { status: "created", taskId } : null,
    });
    const proposal = {
      items: [
        item("i1", "Base", "gone-task"),
        item("i2", "Top", "b", [{ kind: "item", itemId: "i1" }, { kind: "task", taskId: "gone-existing", title: "Old task" }]),
        item("i3", "Alive base", "alive"),
        item("i4", "Linked to alive", "d", [{ kind: "item", itemId: "i3" }]),
        item("i5", "Unrelated", "free"),
        item("i6", "Never created", null, [{ kind: "item", itemId: "i1" }]),
      ],
    };
    db.run(`INSERT INTO project_manager_proposals (id, project_path, status, data, created_at, updated_at) VALUES ('p1', '/p', 'approved', ?, 1, 1)`, [JSON.stringify(proposal)]);
    db.run(`INSERT INTO project_manager_proposals (id, project_path, status, data, created_at, updated_at) VALUES ('p2', '/p', 'approved', 'not json', 2, 2)`);
    migrate(db, migrations);
    const rows = db.query<{ task_id: string; missing_id: string; missing_title: string }, []>(
      `SELECT task_id, missing_id, missing_title FROM task_dependency_tombstones ORDER BY missing_id`).all();
    expect(rows).toEqual([
      { task_id: "b", missing_id: "gone-existing", missing_title: "Old task" },
      { task_id: "b", missing_id: "gone-task", missing_title: "Base" },
    ]);
  } finally {
    db.close();
  }
});
