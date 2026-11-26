import { db } from "../db.ts";

export type PreparationStatus = "started" | "completed" | "failed" | "interrupted";
export type PreparationRole = "developer" | "reviewer";

export function recordPreparation(input: {
  missionId: string; taskId: string; revision: number; role: PreparationRole;
  status: PreparationStatus; at?: number; detail?: string | null;
}): void {
  const at = input.at ?? Date.now();
  const last = db.query<{ status: PreparationStatus }, [string, string, string]>(
    "SELECT status FROM mission_preparation_events WHERE mission_id = ? AND task_id = ? AND role = ? ORDER BY id DESC LIMIT 1",
  ).get(input.missionId, input.taskId, input.role);
  if (input.status === "started") {
    if (last?.status === "started") return;
  } else if (last?.status !== "started" && input.status !== "interrupted") return;
  else if (last?.status === input.status) return;
  db.run(
    "INSERT INTO mission_preparation_events (mission_id, task_id, revision, role, status, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [input.missionId, input.taskId, input.revision, input.role, input.status, at, input.detail ?? null],
  );
}

type EventRow = { id: number; role: PreparationRole; status: PreparationStatus; at: number };

export function preparationActual(taskId: string, cutoff: number) {
  const rows = db.query<EventRow, [string, number]>(
    "SELECT id, role, status, at FROM mission_preparation_events WHERE task_id = ? AND at <= ? ORDER BY id",
  ).all(taskId, cutoff);
  const open = new Map<PreparationRole, EventRow>();
  let durationMs = 0;
  let closed = 0;
  let waitingMs = 0;
  let latest: PreparationStatus | null = null;
  const waits = db.query<{ category: string | null; at: number }, [string, number]>(
    "SELECT category, at FROM mission_wait_transitions WHERE task_id = ? AND at <= ? ORDER BY at, id",
  ).all(taskId, cutoff);
  const overlap = (start: number, end: number) => {
    let cursor: { category: string | null; at: number } | null = null;
    for (const row of waits) {
      if (cursor?.category && row.at > start) waitingMs += Math.max(0, Math.min(row.at, end) - Math.max(cursor.at, start));
      cursor = row;
    }
    if (cursor?.category && cursor.at < end) waitingMs += Math.max(0, end - Math.max(cursor.at, start));
  };
  for (const row of rows) {
    latest = row.status;
    if (row.status === "started") {
      open.set(row.role, row);
      continue;
    }
    const started = open.get(row.role);
    open.delete(row.role);
    if (!started || row.at < started.at) continue;
    durationMs += row.at - started.at;
    closed += 1;
    overlap(started.at, row.at);
  }
  if (!rows.length) return { status: "unknown" as const, durationMs: null, waitingMs: null, samples: 0 };
  if (open.size) return { status: "started" as const, durationMs: null, waitingMs: null, samples: closed };
  return { status: latest ?? "unknown", durationMs: closed ? durationMs : null, waitingMs: closed ? waitingMs : null, samples: closed };
}

/** Completed Developer preparation intervals for one project. Failed and interrupted intervals are not reused as estimates. */
export function completedPreparationSamples(projectPath: string): number[] {
  const rows = db.query<{ task_id: string; status: PreparationStatus; at: number }, [string]>(`
    SELECT e.task_id, e.status, e.at FROM mission_preparation_events e
    JOIN tasks t ON t.id = e.task_id
    WHERE e.role = 'developer' AND t.workdir = ? AND e.status IN ('started', 'completed')
    ORDER BY e.id
  `,).all(projectPath);
  const open = new Map<string, number>();
  const samples: number[] = [];
  for (const row of rows) {
    if (row.status === "started") open.set(row.task_id, row.at);
    else {
      const started = open.get(row.task_id);
      open.delete(row.task_id);
      if (started !== undefined && row.at >= started) samples.push(row.at - started);
    }
  }
  return samples;
}
