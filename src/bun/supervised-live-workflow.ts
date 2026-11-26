/**
 * FO-LIVE01 — read models for the supervised live workflow API.
 */
import { getRunExecution } from "./run-execution.ts";
import type { SupervisedLiveView } from "../shared/supervised-live-workflow.ts";
import {
  buildSupervisedLiveView,
} from "../shared/supervised-live-workflow.ts";
import type { EmployeeRunPhase } from "../shared/execution/run.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { db, tasks } from "./db.ts";
import { listEmployeeRuns } from "./employee-run.ts";
import { isRunLive, isRunStarting } from "./orchestrator.ts";
import { getTaskQcBundle } from "./task-quality-control.ts";

export interface TaskSupervisedLivePayload extends SupervisedLiveView {
  taskId: string;
  implementer: { employeeId: string; name: string } | null;
  implementation: { harness: string; model: string | null };
  latestEmployeeRunPhase: EmployeeRunPhase | null;
  qc: ReturnType<typeof getTaskQcBundle>;
  usesFakeDriver: boolean;
}

function latestRunPhase(taskId: string): EmployeeRunPhase | null {
  const attempts = listEmployeeRuns({ taskId, limit: 1 });
  return attempts[0]?.phase ?? null;
}

function assignmentFor(taskId: string): { employeeId: string; name: string } | null {
  const row = new AssignmentCore(db).forTask(taskId);
  if (!row) return null;
  return { employeeId: row.employeeId, name: row.employeeName ?? row.employeeId.slice(0, 8) };
}

export function getTaskSupervisedLive(taskId: string): TaskSupervisedLivePayload | { error: string; status: number } {
  const task = tasks.get(taskId);
  if (!task) return { error: "Task not found.", status: 404 };
  const runId = task.runId;
  const runLive = runId ? isRunLive(runId) : false;
  const runStarting = runId ? isRunStarting(runId) : false;
  const employeeRunPhase = latestRunPhase(taskId);
  const assignment = assignmentFor(taskId);
  const view = buildSupervisedLiveView({
    task,
    hasAssignment: assignment != null,
    employeeRunPhase,
    runLive,
    runStarting,
  });
  return {
    ...view,
    taskId,
    implementer: assignment,
    implementation: { harness: task.agent, model: task.model ?? null },
    latestEmployeeRunPhase: employeeRunPhase,
    qc: getTaskQcBundle(taskId),
    usesFakeDriver: !!task.runId && getRunExecution(task.runId)?.type === "synthetic",
  };
}

/** Preflight for live harness invocation — no secrets in the reason string. */
export async function harnessUnavailableReason(harnessId: string): Promise<string | null> {
  const { checkAllHarnesses } = await import("./agent-status.ts");
  const statuses = await checkAllHarnesses();
  const row = statuses.find((s) => s.harnessId === harnessId) ?? statuses.find((s) => s.kind === harnessId);
  if (!row) return `Unknown harness "${harnessId}".`;
  if (row.available) return null;
  return row.reason ?? `${row.kind} is not available.`;
}
