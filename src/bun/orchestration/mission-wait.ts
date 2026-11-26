import { db } from "../db.ts";

export type MissionWait = "project-queue" | "specialist-capacity" | "account-capacity" | "dependency" | "owner" | "quota";

export function recordMissionWait(missionId: string, taskId: string, category: MissionWait | null, at = Date.now()): void {
  const last = db.query<{ category: MissionWait | null }, [string, string]>(
    "SELECT category FROM mission_wait_transitions WHERE mission_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1",
  ).get(missionId, taskId);
  if ((last?.category ?? null) !== category) db.run(
    "INSERT INTO mission_wait_transitions (mission_id, task_id, category, at) VALUES (?, ?, ?, ?)",
    [missionId, taskId, category, at],
  );
}

export function closeMissionWaits(missionId: string): void {
  db.run(`INSERT INTO mission_wait_transitions (mission_id, task_id, category, at)
    SELECT mission_id, task_id, NULL, ? FROM mission_wait_transitions
    WHERE id IN (SELECT MAX(id) FROM mission_wait_transitions WHERE mission_id = ? GROUP BY task_id)
      AND category IS NOT NULL`, [Date.now(), missionId]);
}
