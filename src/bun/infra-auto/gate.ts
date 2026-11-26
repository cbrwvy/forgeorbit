import type { Database } from "bun:sqlite";

/** Mission-scheduler gate. An empty table blocks nothing. */
export function deploymentGateForTask(db: Database, taskId: string): string | null {
  const table = db.query<{ name: string }, [string]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("infra_task_gates");
  if (!table) return null;
  const row = db.query<{ reason: string }, [string]>(
    "SELECT reason FROM infra_task_gates WHERE task_id = ?",
  ).get(taskId);
  return row?.reason ?? null;
}
