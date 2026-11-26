import { ActivityJournalCore } from "../activity-journal-core.ts";
import { db } from "../db.ts";
import type { MoneyAmount } from "../../shared/usage-analytics.ts";

export interface CostAdjustment {
  id: number;
  taskId: string;
  runId: string | null;
  amount: number;
  currency: string;
  note: string;
  createdAt: number;
  supersedes: number | null;
  current: boolean;
  label: "owner-reported";
}

interface Row {
  id: number;
  task_id: string;
  run_id: string | null;
  amount: number;
  currency: string;
  note: string;
  created_at: number;
  supersedes: number | null;
}

function view(row: Row, current: boolean): CostAdjustment {
  return {
    id: row.id, taskId: row.task_id, runId: row.run_id, amount: row.amount, currency: row.currency,
    note: row.note, createdAt: row.created_at, supersedes: row.supersedes, current, label: "owner-reported",
  };
}

export function listAdjustments(taskId: string): { current: CostAdjustment[]; history: CostAdjustment[] } {
  const rows = db.query<Row, [string]>(
    "SELECT * FROM usage_cost_adjustments WHERE task_id = ? ORDER BY id",
  ).all(taskId);
  const replaced = new Set(rows.flatMap(row => row.supersedes === null ? [] : [row.supersedes]));
  const history = rows.map(row => view(row, !replaced.has(row.id)));
  return { current: history.filter(row => row.current), history };
}

export function currentAdjustmentTotals(taskIds: readonly string[]): MoneyAmount[] {
  if (!taskIds.length) return [];
  const totals = new Map<string, number>();
  for (const taskId of taskIds) {
    for (const row of listAdjustments(taskId).current) {
      totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
    }
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

export function recordAdjustment(input: {
  taskId: string;
  runId?: string | null;
  amount: number;
  currency: string;
  note: string;
  supersedes?: number | null;
}): CostAdjustment {
  const task = db.query<{ id: string }, [string]>("SELECT id FROM tasks WHERE id = ?").get(input.taskId);
  if (!task) throw new Error("Task was not found.");
  const amount = typeof input.amount === "number" && Number.isFinite(input.amount) ? Math.round(input.amount * 1e8) / 1e8 : NaN;
  if (amount < 0 || amount > 1_000_000_000) throw new Error("Enter an adjustment amount from 0 through 1 billion.");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Use a three-letter currency code.");
  const note = input.note.trim();
  if (note.length < 1 || note.length > 400 || note.includes("\0")) throw new Error("Enter an adjustment note of 1–400 characters.");
  const runId = input.runId ?? null;
  if (runId !== null) {
    const run = db.query<{ id: string }, [string, string, string]>(`
      SELECT r.id FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.id = ? AND (t.id = ? OR t.pipeline_parent_id = ?)
    `).get(runId, input.taskId, input.taskId);
    if (!run) throw new Error("That run is not part of this task.");
  }
  const supersedes = input.supersedes ?? null;
  if (supersedes !== null) {
    const prior = listAdjustments(input.taskId).current.find(row => row.id === supersedes);
    if (!prior) throw new Error("Choose a current adjustment on this task to revise.");
    if (prior.currency !== input.currency) throw new Error("A revision keeps the earlier adjustment's currency.");
  }
  return db.transaction(() => {
    const row = db.query<Row, [string, string | null, number, string, string, number, number | null]>(
      `INSERT INTO usage_cost_adjustments(task_id,run_id,amount,currency,note,created_at,supersedes)
       VALUES (?,?,?,?,?,?,?) RETURNING *`,
    ).get(input.taskId, runId, amount, input.currency, note, Date.now(), supersedes)!;
    new ActivityJournalCore(db).record({
      eventType: "usage.adjustment.recorded", actorType: "owner", actorId: "owner",
      targetType: "task", targetId: input.taskId, taskId: input.taskId, runId,
      idempotencyKey: `usage-adjustment:${row.id}`,
      payload: { revision: row.id, currency: input.currency, supersedes, label: "owner-reported" },
    });
    return view(row, true);
  })();
}
