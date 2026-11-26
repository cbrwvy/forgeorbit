import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import {
  DEFAULT_HANDSOFF_POLICY,
  EMPTY_HANDSOFF_STATE,
  HANDSOFF_BLOCKER_CODES,
  HANDSOFF_EVENT_KINDS,
  HANDSOFF_STAGES,
  HANDSOFF_STATUSES,
  parseHandsoffPolicy,
  type HandsoffBlocker,
  type HandsoffEvent,
  type HandsoffEventKind,
  type HandsoffPolicy,
  type HandsoffResult,
  type HandsoffRun,
  type HandsoffStage,
  type HandsoffState,
  type HandsoffStatus,
  type StoredHandsoffPolicy,
} from "../../shared/handsoff.ts";

interface PolicyRow { project_path: string; policy_json: string; revision: number; activated_at: number | null; updated_at: number }
interface RunRow {
  id: string; task_id: string; project_path: string; policy_revision: number; policy_json: string; stage: string; status: string;
  round: number; state_json: string; blocker_json: string | null; result_json: string | null;
  created_at: number; updated_at: number; finished_at: number | null;
}
interface EventRow { id: number; run_id: string; task_id: string; ts: number; kind: string; stage: string; message: string; detail_json: string }

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function policyOf(raw: string): HandsoffPolicy {
  const parsed = parseHandsoffPolicy(json<unknown>(raw, null));
  // A stored policy that no longer parses is read as OFF, never as a looser default.
  return parsed.ok ? parsed.policy : { ...DEFAULT_HANDSOFF_POLICY, enabled: false };
}

const asPolicy = (row: PolicyRow): StoredHandsoffPolicy => ({
  projectPath: row.project_path, policy: policyOf(row.policy_json), revision: row.revision, activatedAt: row.activated_at, updatedAt: row.updated_at,
});

function blockerOf(raw: string | null): HandsoffBlocker | null {
  const value = json<HandsoffBlocker | null>(raw, null);
  if (!value || !(HANDSOFF_BLOCKER_CODES as readonly string[]).includes(value.code)) return null;
  return value;
}

const asRun = (row: RunRow): HandsoffRun => ({
  id: row.id,
  taskId: row.task_id,
  projectPath: row.project_path,
  policyRevision: row.policy_revision,
  policy: policyOf(row.policy_json),
  stage: ((HANDSOFF_STAGES as readonly string[]).includes(row.stage) ? row.stage : "queued") as HandsoffStage,
  status: ((HANDSOFF_STATUSES as readonly string[]).includes(row.status) ? row.status : "needs-owner") as HandsoffStatus,
  round: row.round,
  state: { ...EMPTY_HANDSOFF_STATE, ...json<Partial<HandsoffState>>(row.state_json, {}) },
  blocker: blockerOf(row.blocker_json),
  result: json<HandsoffResult | null>(row.result_json, null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
});

export const handsoffStore = {
  getPolicy(projectPath: string): StoredHandsoffPolicy | null {
    const row = db.query<PolicyRow, [string]>("SELECT * FROM project_handsoff_policies WHERE project_path = ?").get(projectPath);
    return row ? asPolicy(row) : null;
  },

  listPolicies(): StoredHandsoffPolicy[] {
    return db.query<PolicyRow, []>("SELECT * FROM project_handsoff_policies").all().map(asPolicy);
  },

  /** The revision grows on every write. `activatedAt` is the moment the policy was last turned on. */
  savePolicy(projectPath: string, policy: HandsoffPolicy, now = Date.now()): StoredHandsoffPolicy {
    const before = db.query<PolicyRow, [string]>("SELECT * FROM project_handsoff_policies WHERE project_path = ?").get(projectPath);
    const wasOn = before ? policyOf(before.policy_json).enabled : false;
    const activatedAt = policy.enabled ? (wasOn && before?.activated_at ? before.activated_at : now) : (before?.activated_at ?? null);
    db.run(
      `INSERT INTO project_handsoff_policies (project_path, policy_json, revision, activated_at, updated_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(project_path) DO UPDATE SET policy_json = excluded.policy_json, revision = revision + 1, activated_at = excluded.activated_at, updated_at = excluded.updated_at`,
      [projectPath, JSON.stringify(policy), activatedAt, now],
    );
    return handsoffStore.getPolicy(projectPath)!;
  },

  insertRun(input: { taskId: string; projectPath: string; policyRevision: number; policy: HandsoffPolicy; requested?: Partial<HandsoffState["requested"]>; now?: number }): HandsoffRun {
    const now = input.now ?? Date.now();
    const id = randomUUID();
    const state: HandsoffState = { ...EMPTY_HANDSOFF_STATE, requested: { ...EMPTY_HANDSOFF_STATE.requested, ...input.requested } };
    // The unique partial index rejects a second unfinished run for the same task.
    db.run(
      `INSERT INTO handsoff_runs (id, task_id, project_path, policy_revision, policy_json, stage, status, round, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 'active', 0, ?, ?, ?)`,
      [id, input.taskId, input.projectPath, input.policyRevision, JSON.stringify(input.policy), JSON.stringify(state), now, now],
    );
    return handsoffStore.getRun(id)!;
  },

  getRun(id: string): HandsoffRun | null {
    const row = db.query<RunRow, [string]>("SELECT * FROM handsoff_runs WHERE id = ?").get(id);
    return row ? asRun(row) : null;
  },

  openRunForTask(taskId: string): HandsoffRun | null {
    const row = db.query<RunRow, [string]>("SELECT * FROM handsoff_runs WHERE task_id = ? AND finished_at IS NULL").get(taskId);
    return row ? asRun(row) : null;
  },

  latestRunForTask(taskId: string): HandsoffRun | null {
    const row = db.query<RunRow, [string]>("SELECT * FROM handsoff_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId);
    return row ? asRun(row) : null;
  },

  listOpenRuns(projectPath?: string): HandsoffRun[] {
    const rows = projectPath
      ? db.query<RunRow, [string]>("SELECT * FROM handsoff_runs WHERE finished_at IS NULL AND project_path = ? ORDER BY created_at, rowid").all(projectPath)
      : db.query<RunRow, []>("SELECT * FROM handsoff_runs WHERE finished_at IS NULL ORDER BY created_at, rowid").all();
    return rows.map(asRun);
  },

  /** Open runs plus the newest run of every task finished since `since`. Feeds board chips and the result summary. */
  listRecent(since: number, limit = 300): HandsoffRun[] {
    return db.query<RunRow, [number, number]>(
      `SELECT r.* FROM handsoff_runs r
       WHERE r.finished_at IS NULL OR (r.finished_at >= ? AND r.rowid = (SELECT MAX(x.rowid) FROM handsoff_runs x WHERE x.task_id = r.task_id))
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
    ).all(since, limit).map(asRun);
  },

  listRunsForProject(projectPath: string, limit = 50): HandsoffRun[] {
    return db.query<RunRow, [string, number]>("SELECT * FROM handsoff_runs WHERE project_path = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(projectPath, limit).map(asRun);
  },

  /** Persists a patch. `finishedAt` is stamped by the caller that closes the run. */
  updateRun(id: string, patch: {
    stage?: HandsoffStage; status?: HandsoffStatus; round?: number; state?: HandsoffState;
    blocker?: HandsoffBlocker | null; result?: HandsoffResult | null; finishedAt?: number | null; now?: number;
  }): HandsoffRun {
    const current = handsoffStore.getRun(id);
    if (!current) throw new Error("Hands-off run not found.");
    const now = patch.now ?? Date.now();
    db.run(
      `UPDATE handsoff_runs SET stage = ?, status = ?, round = ?, state_json = ?, blocker_json = ?, result_json = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      [
        patch.stage ?? current.stage,
        patch.status ?? current.status,
        patch.round ?? current.round,
        JSON.stringify(patch.state ?? current.state),
        patch.blocker === undefined ? (current.blocker ? JSON.stringify(current.blocker) : null) : patch.blocker ? JSON.stringify(patch.blocker) : null,
        patch.result === undefined ? (current.result ? JSON.stringify(current.result) : null) : patch.result ? JSON.stringify(patch.result) : null,
        patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
        now,
        id,
      ],
    );
    return handsoffStore.getRun(id)!;
  },

  appendEvent(run: Pick<HandsoffRun, "id" | "taskId" | "stage" | "policyRevision">, kind: HandsoffEventKind, message: string, detail: Record<string, unknown> = {}, now = Date.now()): void {
    db.run(
      `INSERT INTO handsoff_events (run_id, task_id, ts, kind, stage, message, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [run.id, run.taskId, now, kind, run.stage, message.slice(0, 600), JSON.stringify({ policyRevision: run.policyRevision, ...detail })],
    );
  },

  listEvents(filter: { runId?: string; taskId?: string }, limit = 200): HandsoffEvent[] {
    const rows = filter.runId
      ? db.query<EventRow, [string, number]>("SELECT * FROM handsoff_events WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(filter.runId, limit)
      : db.query<EventRow, [string, number]>("SELECT * FROM handsoff_events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(filter.taskId ?? "", limit);
    return rows.reverse().flatMap((row) => {
      if (!(HANDSOFF_EVENT_KINDS as readonly string[]).includes(row.kind)) return [];
      return [{
        id: row.id, runId: row.run_id, taskId: row.task_id, ts: row.ts, kind: row.kind as HandsoffEventKind,
        stage: ((HANDSOFF_STAGES as readonly string[]).includes(row.stage) ? row.stage : "queued") as HandsoffStage,
        message: row.message, detail: json(row.detail_json, { policyRevision: 0 }),
      }];
    });
  },
};
