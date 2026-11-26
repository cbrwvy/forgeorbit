import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { employeeErrorText, formatEmployeeTime } from "@/lib/employees";
import { phaseLabel } from "@/lib/employee-execution";
import { Button } from "@/components/ui/button";
import { EmployeeRunStatus } from "@/components/kanban/EmployeeRunPanel";
import type { EmployeeRunView } from "../../../../shared/execution/run.ts";

const PAGE_SIZE = 20;

/** The existing attempts API is the only employee history. No background poll. */
export function ExecutionHistory({ employeeId, onOpenTask }: { employeeId: string; onOpenTask: (id: string) => void }) {
  useUILocale();
  const [attempts, setAttempts] = useState<EmployeeRunView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api.employeeExecutionAttempts({ employeeId, limit: PAGE_SIZE + 1, before: cursor }, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      const page = response.attempts.slice(0, PAGE_SIZE);
      setAttempts((previous) => cursor ? [...previous, ...page.filter((a) => !previous.some((p) => p.id === a.id))] : page);
      setMore(response.attempts.length > PAGE_SIZE);
    }).catch((caught) => { if (!controller.signal.aborted) setError(employeeErrorText(caught)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [employeeId, cursor, reload]);

  const refresh = () => { setCursor(undefined); setReload((r) => r + 1); };
  return (
    <section aria-label={tr("employees.execution_history")} className="flex min-w-0 flex-col gap-2" data-testid="employee-execution-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium"><I18nText id="employees.execution_history" /></h3>
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={refresh} data-testid="execution-history-refresh"><I18nText id="employees.refresh_history" /></Button>
      </div>
      <p className="text-xs text-muted-foreground"><I18nText id="employees.newest_first_names_and_assignments_reflect_the_review" /></p>
      {loading && <p role="status" data-testid="execution-history-loading" className="text-xs text-muted-foreground"><I18nText id="employees.loading_execution_history" /></p>}
      {error && <div role="alert" className="text-xs text-destructive" data-testid="execution-history-error">{error} <Button type="button" variant="outline" size="sm" onClick={() => setReload((r) => r + 1)}><I18nText id="common.retry" /></Button></div>}
      {!loading && !error && attempts.length === 0 && <p className="text-sm text-muted-foreground" data-testid="execution-history-empty"><I18nText id="employees.no_execution_attempts_recorded" /></p>}
      <ol className="flex max-h-[36rem] min-w-0 flex-col gap-2 overflow-y-auto" aria-label={tr("employees.recorded_execution_attempts")}>
        {attempts.map((attempt) => (
          <li key={attempt.id} className="min-w-0 shrink-0 rounded-xl border p-3" data-testid="execution-history-entry" data-attempt={attempt.id}>
            <details>
              <summary className="cursor-pointer break-words text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                {attempt.taskTitle} · {phaseLabel(attempt.phase)} · {formatEmployeeTime(attempt.createdAt)}
              </summary>
              <dl className="my-2 flex flex-col gap-1 break-all text-xs">
                <dt className="text-muted-foreground"><I18nText id="common.project_985959" /></dt><dd>{attempt.projectPath}</dd>
                <dt className="text-muted-foreground"><I18nText id="employees.assignment_uuid_revision" /></dt><dd>{attempt.assignment.id} / {attempt.assignment.revision}</dd>
              </dl>
              <EmployeeRunStatus attempt={attempt} testId="execution-history-status" onOpenRuns={() => onOpenTask(attempt.taskId)} onUpdated={(updated) => setAttempts((list) => list.map((a) => a.id === updated.id ? updated : a))} />
              <Button type="button" size="sm" variant="outline" className="mt-2" data-testid="execution-history-open-task" onClick={() => onOpenTask(attempt.taskId)}><I18nText id="employees.open_task_run_details" /></Button>
            </details>
          </li>
        ))}
      </ol>
      {more && <Button type="button" size="sm" variant="outline" disabled={loading} data-testid="execution-history-more" onClick={() => setCursor(attempts.at(-1)?.id)}><I18nText id="employees.load_older_attempts" /></Button>}
    </section>
  );
}
