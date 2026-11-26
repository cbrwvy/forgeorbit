import { db } from "../db.ts";
import { ownerProjectOf } from "../project-ownership.ts";
import { providerName } from "./scope.ts";
import { AccountCore } from "../account-core.ts";

export function projectClusters(projectPath: string): string[] {
  return db.query<{ cluster_id: string }, [string]>(
    "SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ? ORDER BY cluster_id",
  ).all(projectPath).map(row => row.cluster_id);
}

export function existingWork() {
  const reservations = db.query<{
    taskId: string; projectPath: string; accountId: string | null; employeeId: string | null;
    missionId: string; harnessId: string; modelId: string | null; qcId: string | null;
  }, []>(`
    SELECT task_id AS taskId, project_path AS projectPath, account_id AS accountId,
      employee_id AS employeeId, mission_id AS missionId, harness_id AS harnessId, model_id AS modelId, qc_review_id AS qcId
    FROM orchestration_reservations WHERE status IN ('reserved','starting','running','awaiting_qc','qc_running')
  `).all();
  const reserved = new Map(reservations.map(row => [row.taskId, row]));
  const running = db.query<{
    taskId: string; workdir: string; projectPath: string | null; accountId: string | null; employeeId: string | null;
    harnessId: string; modelId: string | null; qcId: string | null;
  }, []>(`
    SELECT COALESCE(t.pipeline_parent_id, t.id) AS taskId, t.workdir, e.project_path AS projectPath,
      COALESCE(e.actual_account_id, CASE WHEN json_valid(identity.data) THEN json_extract(identity.data, '$.accountProfile.id') END) AS accountId,
      e.employee_id AS employeeId, r.agent AS harnessId,
      COALESCE(e.actual_model, CASE WHEN json_valid(identity.data) THEN json_extract(identity.data, '$.model') END) AS modelId, r.qc_review_id AS qcId
    FROM runs r JOIN tasks t ON t.id = r.task_id
    LEFT JOIN employee_executions e ON e.run_id = r.id AND e.actual_provenance = 'runtime'
    LEFT JOIN run_events identity ON identity.id = (
      SELECT id FROM run_events event WHERE event.run_id = r.id AND event.stream = 'status'
        AND event.data LIKE '%"kind":"execution-identity"%' ORDER BY id DESC LIMIT 1
    )
    WHERE r.status = 'running'
  `).all().map(row => {
    const reservation = reserved.get(row.taskId);
    const accountId = row.accountId ?? (!row.qcId && reservation?.harnessId === row.harnessId ? reservation.accountId : null);
    return { ...row, accountId, projectPath: row.projectPath ?? reservation?.projectPath ?? ownerProjectOf(row.workdir),
      employeeId: row.employeeId ?? (!row.qcId ? reservation?.employeeId ?? null : null),
      missionId: reservation?.missionId ?? null, modelId: row.modelId ?? reservation?.modelId ?? null };
  });
  const runningIds = new Set(running.map(row => row.taskId));
  const core = new AccountCore(db);
  return [...running, ...reservations.filter(row => !runningIds.has(row.taskId))].map(row => {
    const keys = ["project/" + (row.projectPath ?? "unknown"), row.accountId ? "account/" + row.accountId : "unknown-account"];
    if (row.employeeId) keys.push("specialist/" + row.employeeId);
    if (row.projectPath) keys.push(...projectClusters(row.projectPath).map(id => "cluster/" + id));
    if (row.accountId) {
      const account = core.getAccount(row.accountId);
      if (account) keys.push("provider/" + providerName(account.provider));
    }
    return { ...row, keys };
  });
}
