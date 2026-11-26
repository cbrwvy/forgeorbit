import type { Database } from "bun:sqlite";
import type { Migration } from "../migrate.ts";
import m093 from "./093_task_dependency_tombstones.sql" with { type: "text" };

/**
 * Links a stored PM proposal named for a prerequisite that no longer exists.
 * The proposal is the durable record of "B waits for A"; deleting A used to
 * erase the only enforced copy. Nothing is recorded for a task the proposal
 * never linked.
 */
function backfillFromProposals(db: Database): void {
  const taskExists = db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE id = ?`);
  const insert = db.query(
    `INSERT OR IGNORE INTO task_dependency_tombstones (task_id, missing_id, missing_title, missing_column, deleted_at)
     VALUES (?, ?, ?, NULL, ?)`,
  );
  const now = Date.now();
  let rows: { data: string }[] = [];
  try {
    rows = db.query<{ data: string }, []>(`SELECT data FROM project_manager_proposals`).all();
  } catch {
    return;
  }
  for (const row of rows) {
    let proposal: { items?: unknown };
    try {
      proposal = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!Array.isArray(proposal.items)) continue;
    const items = proposal.items as {
      id?: string; title?: string;
      result?: { status?: string; taskId?: string } | null;
      dependsOn?: { kind?: string; itemId?: string; taskId?: string; title?: string }[];
    }[];
    const taskOf = (item: (typeof items)[number] | null | undefined): string | null =>
      item?.result && (item.result.status === "created" || item.result.status === "linked") && typeof item.result.taskId === "string"
        ? item.result.taskId : null;
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const item of items) {
      const dependent = taskOf(item);
      if (!dependent || taskExists.get(dependent)!.n === 0 || !Array.isArray(item.dependsOn)) continue;
      for (const dep of item.dependsOn) {
        const target = dep.kind === "item" ? byId.get(dep.itemId) : null;
        const missing = dep.kind === "item" ? taskOf(target) : typeof dep.taskId === "string" ? dep.taskId : null;
        if (!missing || missing === dependent || taskExists.get(missing)!.n > 0) continue;
        insert.run(dependent, missing, String(dep.kind === "item" ? target?.title ?? missing : dep.title ?? missing).slice(0, 200), now);
      }
    }
  }
}

export const taskDependencyTombstonesMigration: Migration = {
  id: "093_task_dependency_tombstones",
  sql: m093,
  apply(db) {
    // A trigger body contains `;`, which the statement splitter can't carry.
    db.run(`CREATE TRIGGER IF NOT EXISTS task_dependencies_remember_deleted BEFORE DELETE ON tasks
      BEGIN
        INSERT OR IGNORE INTO task_dependency_tombstones (task_id, missing_id, missing_title, missing_column, deleted_at)
        SELECT d.task_id, OLD.id, OLD.title, OLD."column", CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM task_dependencies d WHERE d.depends_on_id = OLD.id;
      END`);
    backfillFromProposals(db);
  },
};
