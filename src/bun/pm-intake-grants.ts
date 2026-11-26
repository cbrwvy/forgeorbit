import { db } from "./db.ts";

const GRANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIntakeGrantId(value: unknown): value is string {
  return typeof value === "string" && GRANT_ID_RE.test(value);
}

type Row = {
  id: string;
  project_path: string;
  task_ids: string;
  status: string;
  message_id: string | null;
};

function parseTaskIds(raw: string): string[] | null {
  if (raw === "*") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

export const pmIntakeGrants = {
  create(projectPath: string, taskIds: string[] | null): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.run(
      `INSERT INTO pm_intake_grants (id, project_path, task_ids, status, message_id, created_at, consumed_at)
       VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      [id, projectPath, taskIds ? JSON.stringify(taskIds) : "*", now],
    );
    return id;
  },

  bindMessage(projectPath: string, grantId: string, messageId: string): { ok: true } | { ok: false; error: string } {
    const row = db.query<Row, [string]>(`SELECT * FROM pm_intake_grants WHERE id = ?`).get(grantId);
    if (!row || row.project_path !== projectPath) return { ok: false, error: "That intake grant was not found for this project." };
    if (row.status !== "pending") return { ok: false, error: "That intake grant was already used." };
    if (row.message_id != null) return { ok: false, error: "That intake grant is already tied to another message." };
    db.run(`UPDATE pm_intake_grants SET message_id = ? WHERE id = ? AND status = 'pending'`, [messageId, grantId]);
    return { ok: true };
  },

  consume(
    projectPath: string,
    grantId: string,
    messageId: string,
  ): { ok: true; allowedTaskIds: string[] | null } | { ok: false; error: string } {
    const row = db.query<Row, [string]>(`SELECT * FROM pm_intake_grants WHERE id = ?`).get(grantId);
    if (!row || row.project_path !== projectPath) return { ok: false, error: "That intake grant was not found for this project." };
    if (row.status !== "pending") return { ok: false, error: "That intake grant was already used." };
    if (row.message_id !== messageId) return { ok: false, error: "That intake grant is not for this message." };
    const now = Date.now();
    const changed = db.run(
      `UPDATE pm_intake_grants SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending' AND message_id = ?`,
      [now, grantId, messageId],
    ).changes;
    if (!changed) return { ok: false, error: "That intake grant could not be applied." };
    return { ok: true, allowedTaskIds: parseTaskIds(row.task_ids) };
  },
};
