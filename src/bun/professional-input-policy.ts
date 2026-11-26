import type { Database } from "bun:sqlite";

/** App-mediated raw terminal writes cannot bypass a professional Turn review. */
export function requiresProfessionalInputReview(db: Database, taskId: string): boolean {
  const assigned = db.query(`SELECT 1 FROM employee_task_assignments a JOIN ai_employee_professional_profiles p
    ON p.employee_id = a.employee_id WHERE a.task_id = ? AND a.status = 'active' LIMIT 1`).get(taskId);
  if (assigned) return true;
  const row = db.query<{ professional_json: string | null }, [string]>(`SELECT e.professional_json FROM runs r
    LEFT JOIN employee_executions e ON e.run_id = r.id WHERE r.task_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`).get(taskId);
  try { return !!row?.professional_json && JSON.parse(row.professional_json).kind === "professional"; }
  catch { return true; }
}
