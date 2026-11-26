import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { assignmentProvenanceLabel } from "@/lib/task-assignments";
import { publishTaskAssignmentChanged } from "@/lib/task-assignment-events";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { Employee } from "../../../shared/employees/types.ts";
import type { Task } from "../../../shared/types.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

/**
 * Owner-facing task ↔ worker link. Uses the same `/task-assignments` API as
 * the company employee card; records responsibility only — no run starts.
 */
export function TaskAssignmentPanel({ task, compact = false }: { task: Task; compact?: boolean }) {
  useUILocale();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [provenance, setProvenance] = useState<string | null>(null);
  const [workerName, setWorkerName] = useState<string | null>(null);
  const [pickId, setPickId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const projectPath = task.workdir;
  const frozen = task.archivedAt != null || !!task.pipelineId || !!task.pipelineParentId;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [team, assignment] = await Promise.all([
        api.listEmployees({ projectPath }),
        api.getTaskAssignment(task.id),
      ]);
      setEmployees(team.employees.filter((e) => e.kind === "worker" && e.status === "active" && e.projectRegistered));
      const row = assignment.assignment;
      setEmployeeId(row?.employeeId ?? null);
      setRevision(row?.revision ?? null);
      setProvenance(row?.provenance ?? null);
      setWorkerName(row?.employeeName ?? null);
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath, task.id]);

  useEffect(() => {
    void load();
  }, [load, task.updatedAt]);

  const assign = async () => {
    if (!pickId || busy || frozen) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      if (employeeId && revision != null && pickId !== employeeId) {
        await api.reassignTask(task.id, pickId, revision);
      } else if (!employeeId) {
        await api.assignTaskToEmployee(task.id, pickId);
      } else {
        return;
      }
      const chosen = employees.find((e) => e.id === pickId)?.name ?? tr("common.the_selected_worker");
      setStatus(tr("task_assignment.assigned_ok", { name: chosen }));
      publishTaskAssignmentChanged(task.id);
      setPickId("");
      await load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (frozen) return null;

  return (
    <section
      className="mx-3 my-2 rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs"
      data-testid="task-assignment-panel"
      aria-label={tr("task_assignment.section_title")}
    >
      <h4 className="text-xs font-semibold"><I18nText id="task_assignment.section_title" /></h4>
      {!compact && <p className="mt-1 text-[length:var(--text-caption)] text-muted-foreground">
        <I18nText id="employees.assignment_records_who_is_responsible_it_does_not" />
      </p>}
      {loading && <p className="mt-2 text-muted-foreground" data-testid="task-assignment-loading"><I18nText id="common.loading_assignment" /></p>}
      {error && <p role="alert" className="mt-2 text-destructive" data-testid="task-assignment-error">{error}</p>}
      {status && <p role="status" className="mt-2 text-success" data-testid="task-assignment-status">{status}</p>}
      {!loading && !error && (
        <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground"><I18nText id="execution.assigned_worker" /></dt>
          <dd data-testid="task-assignment-current">
            {employeeId ? (
              <>
                <span className="font-medium">{workerName ?? tr("common.unknown")}</span>
                {provenance && (
                  <span className="ml-1 text-muted-foreground">· {assignmentProvenanceLabel(provenance)}</span>
                )}
              </>
            ) : (
              <span className="text-warning"><I18nText id="common.unassigned" /></span>
            )}
          </dd>
        </dl>
      )}
      {!loading && employees.length === 0 && (
        <p className="mt-2 text-muted-foreground" data-testid="task-assignment-no-workers">
          <I18nText id="task_assignment.no_workers_in_project" />
        </p>
      )}
      {!loading && employees.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`task-assignment-pick-${task.id}`}>
            <I18nText id="task_assignment.pick_worker" />
          </label>
          <div className="min-w-[12rem] flex-1">
            <Select
              id={`task-assignment-pick-${task.id}`}
              data-testid="task-assignment-pick"
              value={pickId}
              onChange={(e) => setPickId(e.target.value)}
            >
              <option value="">{employeeId ? tr("task_assignment.change_worker") : tr("task_assignment.pick_worker")}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id} disabled={e.id === employeeId}>
                  {e.name}{e.status !== "active" ? ` · ${e.status}` : ""}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="task-assignment-save"
            disabled={busy || !pickId || pickId === employeeId}
            onClick={() => void assign()}
          >
            <I18nText id="common.assign" />
          </Button>
        </div>
      )}
    </section>
  );
}
