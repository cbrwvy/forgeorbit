import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { employeeErrorText, formatEmployeeTime, isCurrentRequest } from "@/lib/employees";
import {
  assignmentColumnLabel,
  assignmentHistoryDetail,
  assignmentProvenanceLabel,
  assignmentVisibilityNote,
  unassignTaskConfirmCopy,
} from "@/lib/task-assignments";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { publishTaskAssignmentChanged } from "@/lib/task-assignment-events";
import type { AssignmentCandidate, TaskAssignment, TaskAssignmentEvent } from "../../../../shared/assignments/types.ts";
import type { Employee } from "../../../../shared/employees/types.ts";

interface Props {
  employee: Employee;
  coworkers: Employee[];
  refreshToken: number;
  onOpenTask: (taskId: string) => void;
}

/**
 * Tasks currently assigned to one worker. The data comes from the assignment
 * API. Assigning, reassigning, and unassigning change that link only.
 */
export function AssignedTasksSection({ employee, coworkers, refreshToken, onOpenTask }: Props) {
  useUILocale();
  const confirm = useConfirm();
  const [assignments, setAssignments] = useState<TaskAssignment[]>([]);
  const [candidates, setCandidates] = useState<AssignmentCandidate[]>([]);
  const [candidatesTruncated, setCandidatesTruncated] = useState(false);
  const [history, setHistory] = useState<TaskAssignmentEvent[]>([]);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [reassignTo, setReassignTo] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const archived = employee.status === "archived";
  const canAssign = employee.kind === "worker" && !archived && employee.status === "active" && employee.projectRegistered && !!employee.projectPath;

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    void Promise.all([
      api.listEmployeeTaskAssignments(employee.id),
      api.taskAssignmentHistory({ employeeId: employee.id }),
      canAssign ? api.taskAssignmentCandidates(employee.id) : Promise.resolve({ tasks: [], truncated: false }),
    ]).then(
      ([list, events, open]) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setAssignments(list.assignments);
        setHistory(events.events);
        setHistoryTruncated(events.truncated);
        setCandidates(open.tasks);
        setCandidatesTruncated(open.truncated);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setError(employeeErrorText(err));
        setLoading(false);
      },
    );
  }, [employee.id, canAssign]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  useEffect(() => {
    setTaskId("");
    setReassignTo({});
    setStatus(null);
  }, [employee.id]);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      setStatus({ tone: "ok", text: success });
      load();
    } catch (err) {
      setStatus({ tone: "error", text: employeeErrorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const assign = () => {
    if (!taskId) return;
    const chosen = candidates.find((task) => task.id === taskId);
    void run(async () => {
      await api.assignTaskToEmployee(taskId, employee.id);
      publishTaskAssignmentChanged(taskId);
      setTaskId("");
    }, `Assigned ${chosen?.title ?? tr("common.the_task")}. Nothing was started.`);
  };

  const reassign = (assignment: TaskAssignment) => {
    const next = reassignTo[assignment.id];
    if (!next) return;
    const coworker = coworkers.find((person) => person.id === next);
    void run(async () => {
      await api.reassignTask(assignment.taskId, next, assignment.revision);
      publishTaskAssignmentChanged(assignment.taskId);
      setReassignTo((current) => ({ ...current, [assignment.id]: "" }));
    }, `Reassigned to ${coworker?.name ?? tr("common.the_selected_worker")}. Nothing was started.`);
  };

  const unassign = async (assignment: TaskAssignment) => {
    const copy = unassignTaskConfirmCopy(assignment.task.title ?? "");
    if (!(await confirm(() => ({ title: copy.title, description: copy.description, confirmLabel: copy.confirmLabel, variant: "destructive" })))) return;
    await run(() => api.unassignTask(assignment.taskId, assignment.revision).then(() => {
      publishTaskAssignmentChanged(assignment.taskId);
    }), "Assignment removed. History is kept.");
  };

  return (
    <section aria-label={tr("employees.assigned_tasks")} className="flex min-w-0 flex-col gap-3 rounded-xl border p-3" data-testid="assigned-tasks">
      <div className="min-w-0">
        <h3 className="text-sm font-medium"><I18nText id="employees.assigned_tasks" /></h3>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="assigned-tasks-note"><I18nText id="employees.assignment_records_who_is_responsible_it_does_not" />{" "}</p>
      </div>

      {error && <p role="alert" data-testid="assigned-tasks-error" className="text-sm text-destructive">{error}</p>}
      <p role="status" aria-live="polite" data-testid="assigned-tasks-status" className={status?.tone === "error" ? "text-sm text-destructive" : "text-sm text-success"}>
        {status?.text ?? ""}
      </p>
      {loading && assignments.length === 0 && !error && <p data-testid="assigned-tasks-loading" className="text-sm text-muted-foreground"><I18nText id="employees.loading_assigned_tasks" /></p>}

      {!loading && assignments.length === 0 && !error && (
        <p data-testid="assigned-tasks-empty" className="text-sm text-muted-foreground"><I18nText id="employees.no_tasks_assigned" /></p>
      )}

      {assignments.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="assigned-task-list">
          {assignments.map((assignment) => {
            const title = assignment.task.title ?? (assignment.task.visibility === "missing" ? tr("common.task_no_longer_in_the_registry") : tr("common.task_4bc74b"));
            const note = assignmentVisibilityNote(assignment.task.visibility);
            const target = reassignTo[assignment.id] ?? "";
            return (
              <li key={assignment.id} className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2" data-testid="assigned-task-row" data-task-id={assignment.taskId}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium" data-testid="assigned-task-title">{title}</p>
                    <p className="break-words text-xs text-muted-foreground" data-testid="assigned-task-meta">
                      {assignment.projectName ?? tr("common.project_not_registered")}
                      {" · "}
                      {assignmentColumnLabel(assignment.task.column, assignment.task.archived)}
                      {" · "}
                      {formatEmployeeTime(assignment.assignedAt)}
                      {" · "}
                      <span data-testid="assigned-task-provenance">{assignmentProvenanceLabel(assignment.provenance)}</span>
                    </p>
                    {note && <p className="mt-1 break-words text-xs text-warning" data-testid="assigned-task-visibility">{note}</p>}
                  </div>
                  {assignment.task.visibility !== "missing" && (
                    <Button type="button" variant="outline" size="sm" data-testid="assigned-task-open" onClick={() => onOpenTask(assignment.taskId)}><I18nText id="common.open_task" />{" "}</Button>
                  )}
                </div>
                {canAssign && (
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    {coworkers.length > 0 ? (
                      <>
                        <label className="sr-only" htmlFor={`reassign-${assignment.id}`}><I18nText id="employees.reassign_to" /></label>
                        <div className="w-full sm:w-56">
                          <Select
                            id={`reassign-${assignment.id}`}
                            data-testid="assigned-task-reassign"
                            value={target}
                            onChange={(event) => setReassignTo((current) => ({ ...current, [assignment.id]: event.target.value }))}
                          >
                            <option value=""><I18nText id="employees.choose_a_worker" /></option>
                            {coworkers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                          </Select>
                        </div>
                        <Button type="button" size="sm" data-testid="assigned-task-reassign-save" disabled={busy || !target} onClick={() => reassign(assignment)}><I18nText id="employees.reassign" />{" "}</Button>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground"><I18nText id="employees.no_other_active_worker_in_this_project" /></p>
                    )}
                    <Button type="button" variant="outline" size="sm" data-testid="assigned-task-unassign" disabled={busy} onClick={() => void unassign(assignment)}><I18nText id="common.unassign" />{" "}</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canAssign && (
        <div className="flex min-w-0 flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap sm:items-center">
          <label className="sr-only" htmlFor="assigned-task-pick"><I18nText id="employees.task_to_assign" /></label>
          <div className="w-full sm:w-72">
            <Select id="assigned-task-pick" data-testid="assigned-task-pick" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">{candidates.length === 0 ? tr("common.no_unassigned_tasks_in_this_project") : tr("common.choose_a_task")}</option>
              {candidates.map((task) => (
                <option key={task.id} value={task.id}>{task.title}</option>
              ))}
            </Select>
          </div>
          <Button type="button" size="sm" data-testid="assigned-task-assign" disabled={busy || !taskId} onClick={assign}><I18nText id="common.assign" />{" "}</Button>
          {candidates.length === 0 && <p className="text-xs text-muted-foreground" data-testid="assigned-task-no-candidates"><I18nText id="employees.no_unassigned_tasks_in_this_project" /></p>}
          {candidatesTruncated && <p className="text-xs text-muted-foreground"><I18nText id="employees.some_tasks_are_not_listed" /></p>}
        </div>
      )}

      {!canAssign && !archived && employee.kind === "worker" && (
        <p className="text-xs text-muted-foreground" data-testid="assigned-tasks-needs-project">
          {employee.projectPath && !employee.projectRegistered
            ? tr("common.this_project_is_no_longer_registered_existing_assignments")
            : tr("common.assign_this_employee_to_a_project_before_assigning")}
        </p>
      )}

      {history.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="assigned-task-history">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="employees.assignment_history" /></h4>
          <ol className="flex flex-col gap-1.5">
            {[...history].reverse().map((event) => (
              <li key={event.id} className="rounded-lg border px-3 py-1.5" data-testid="assigned-task-history-event" data-action={event.action}>
                <p className="break-words text-sm">
                  <span className="font-medium">{assignmentHistoryDetail(event)}</span>{" "}
                  <span className="text-xs text-muted-foreground">{formatEmployeeTime(event.at)}</span>
                </p>
              </li>
            ))}
          </ol>
          {historyTruncated && <p className="text-xs text-muted-foreground"><I18nText id="employees.older_assignment_history_is_not_shown" /></p>}
        </div>
      )}
    </section>
  );
}
