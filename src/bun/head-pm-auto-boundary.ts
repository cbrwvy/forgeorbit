/** Shared enforcement boundary. Never grants Owner authority to an internal caller. */
import { createHash } from "node:crypto";
import { launchFingerprint } from "../shared/task-scheduling.ts";
import type { OrchestratedBatchRecord } from "../shared/pm-orchestrated-batch.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { db, headPmInitiatives, portfolioManagerStore, tasks } from "./db.ts";
import type { HeadAutoRecord } from "../shared/head-pm-auto.ts";
export interface HeadBatchAuthority { coordinationId: string; digest: string }
export function loadHeadAuto(id: string): HeadAutoRecord | null {
  const row = db.query<{data_json: string}, [string]>("SELECT data_json FROM head_pm_auto WHERE id = ?").get(id);
  return row ? JSON.parse(row.data_json) : null;
}
export function headBatchBlock(batchId: string, authority?: HeadBatchAuthority, dispatch = false): string | null {
  const reservation = db.query<{coordination_id: string}, [string]>("SELECT coordination_id FROM head_pm_auto_reservations WHERE batch_id = ?").get(batchId);
  const running = db.query<{id: string}, []>("SELECT id FROM head_pm_auto WHERE status = 'running'").get();
  if (!reservation) return running || activeBatchConflict(batchId, true)
    ? "Head coordination holds global project-batch concurrency (1), including unsettled Runs." : null;
  const c = loadHeadAuto(reservation.coordination_id);
  if (!c) return "Coordination reservation is unavailable.";
  const a = c.authorization;
  // Preserve FO-AUTO01's resumable parent-pause semantics. An already running
  // step may settle, but cannot dispatch QC/the next task until Owner resumes.
  if (c.status === "paused" && a?.digest === c.digest && a.expiresAt > Date.now()) return "Parent batch coordination is paused by Owner.";
  if (c.status !== "running" || !a || a.digest !== c.digest || a.expiresAt <= Date.now()) return "Head coordination is paused, blocked, cancelled or expired.";
  const planDigest = createHash("sha256").update(JSON.stringify(c.plan)).digest("hex");
  if (planDigest !== a.digest) return "Frozen coordination plan changed.";
  const initiative = JSON.parse(headPmInitiatives.get(c.initiativeId) ?? "null");
  if (!initiative || initiative.cancelledAt != null) return "Head initiative is cancelled or unavailable.";
  const p = c.plan.projects[c.currentIndex];
  if (p) {
    const contribution = initiative.contributions.find((x: {projectPath: string}) => x.projectPath === p.projectPath);
    const delegation = JSON.parse(portfolioManagerStore.getDelegation(p.delegationId) ?? "null");
    if (contribution?.delegationId !== p.delegationId || contribution.manuallyClosed || !["sent", "answered"].includes(delegation?.status)) return "Initiative delegation approval changed.";
    const row = db.query<{data_json: string}, [string]>("SELECT data_json FROM pm_orchestrated_batches WHERE id = ?").get(batchId);
    const b: OrchestratedBatchRecord | null = row ? JSON.parse(row.data_json) : null;
    if (!b || b.projectPath !== p.projectPath || b.revision !== p.revision || JSON.stringify(b.tasks) !== JSON.stringify(p.tasks) || JSON.stringify(b.policy) !== JSON.stringify(p.policy)) return "Project batch plan or grant changed.";
    if (!b.policy?.expiresAt || b.policy.expiresAt <= Date.now()) return "Project batch grant expired.";
    for (const plan of b.tasks) {
      const task = tasks.get(plan.taskId);
      const assignment = new AssignmentCore(db).forTask(plan.taskId);
      const frozen = p.assignments.find(x => x.taskId === plan.taskId);
      if (!assignment || assignment.employeeId !== plan.implementerEmployeeId || assignment.revision !== frozen?.revision) return `“${plan.title}”: Developer assignment changed.`;
      if (task?.workdir !== p.projectPath) return "Task project changed.";
      if (b.progress.byTask[plan.taskId]?.phase === "queued" && (task.column !== "ready" || launchFingerprint(task) !== plan.fingerprint)) return `“${plan.title}”: task changed since approval.`;
    }
  }
  if (c.plan.projects[c.currentIndex]?.batchId !== batchId) return "Project batch is outside the authorized dispatch position.";
  if (dispatch && (authority?.coordinationId !== c.id || authority.digest !== a.digest)) return "Batch start is reserved for the explicitly authorized Head coordination.";
  return null;
}

/** Pausing/cancelling a batch does not erase its already launched Run. */
export function activeBatchConflict(exceptId: string | null = null, coordinatedOnly = false): string | null {
  const rows = db.query<{batch_id: string}, []>(`
    SELECT DISTINCT json_extract(w.grant_json, '$.orchestratedBatchId') AS batch_id
    FROM pm_orchestrated_workflows w
    WHERE json_extract(w.grant_json, '$.orchestratedBatchId') IS NOT NULL
      AND (EXISTS (SELECT 1 FROM runs r WHERE r.task_id = w.task_id AND r.status IN ('starting', 'running'))
        OR EXISTS (SELECT 1 FROM employee_executions e WHERE e.task_id = w.task_id AND e.status = 'starting'))
  `).all();
  for (const row of rows) {
    if (row.batch_id === exceptId) continue;
    if (!coordinatedOnly || db.query(`SELECT 1 FROM head_pm_auto c, json_each(c.data_json, '$.plan.projects') p
      WHERE json_extract(p.value, '$.batchId') = ? LIMIT 1`).get(row.batch_id)) return row.batch_id;
  }
  return null;
}
