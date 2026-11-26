/**
 * FO-AUTO03-RECOVERY-LAUNCH-FIX03 — durable phase-grant claim and consumption.
 * A claim reserves the grant for one scheduler worker. Consumption is a later
 * write that names the Run that was actually created. Historical consumed
 * grants are never rewritten.
 */
import { db } from "./db.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import type { OrchestratedBatchRecord, QueuePhaseGrant, QueuePhaseGrantPrelaunchFailure } from "../shared/pm-orchestrated-batch.ts";

function load(batchId: string): OrchestratedBatchRecord | null {
  const row = db.query<{ data_json: string; status: string }, [string]>(
    `SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ?`,
  ).get(batchId);
  if (!row) return null;
  try {
    const record = JSON.parse(row.data_json) as OrchestratedBatchRecord;
    record.status = row.status as OrchestratedBatchRecord["status"];
    return record;
  } catch {
    return null;
  }
}

function save(record: OrchestratedBatchRecord): void {
  record.updatedAt = Date.now();
  db.run(
    `UPDATE pm_orchestrated_batches SET status = ?, data_json = ?, updated_at = ? WHERE id = ?`,
    [record.status, JSON.stringify(record), record.updatedAt, record.id],
  );
  broadcastAppEvent({
    type: "execution_batch",
    projectPath: record.projectPath,
    batchId: record.id,
    status: record.status,
    ts: record.updatedAt,
  });
}

function appendEvent(batchId: string, kind: string, text: string, taskId: string | null): void {
  db.run(
    `INSERT INTO pm_orchestrated_batch_events (batch_id, at, kind, task_id, text) VALUES (?, ?, ?, ?, ?)`,
    [batchId, Date.now(), kind, taskId, text.slice(0, 400)],
  );
}

function grantOf(record: OrchestratedBatchRecord, grantId: string): QueuePhaseGrant | null {
  return record.phaseGrants?.find((item) => item.id === grantId) ?? null;
}

/**
 * Bind a claimed grant to the Run that was just recorded.
 * No-op when the grant is not claimed, so historical consumed rows stay put.
 */
export function commitClaimedPhaseGrant(batchId: string, taskId: string, phase: "developer" | "reviewer", runId: string): void {
  if (!runId) return;
  db.transaction(() => {
    const record = load(batchId);
    if (!record) return;
    const grant = (record.phaseGrants ?? []).find((item) =>
      item.taskId === taskId && item.phase === phase && item.status === "claimed",
    );
    if (!grant) return;
    grant.status = "consumed";
    grant.consumedRunId = runId;
    save(record);
    appendEvent(record.id, "phase-grant-consumed", `${phase} launch recorded for run ${runId}.`, taskId);
  })();
}

/**
 * Move an active or claimed grant to prelaunch-failed. Does not touch a grant
 * that already names a Run, and does not return it to active.
 */
export function failPhaseGrantPrelaunch(
  batchId: string,
  grantId: string,
  failure: Omit<QueuePhaseGrantPrelaunchFailure, "at">,
  from: Array<"active" | "claimed">,
): boolean {
  let marked = false;
  db.transaction(() => {
    const record = load(batchId);
    if (!record) return;
    const grant = grantOf(record, grantId);
    if (!grant || grant.consumedRunId) return;
    if (!from.includes(grant.status as "active" | "claimed")) return;
    grant.status = "prelaunch-failed";
    grant.prelaunchFailure = { ...failure, at: Date.now() };
    save(record);
    appendEvent(
      record.id,
      "prelaunch-failed",
      `Reviewer preparation failed before launch: ${failure.message}`.slice(0, 400),
      grant.taskId,
    );
    marked = true;
  })();
  return marked;
}
