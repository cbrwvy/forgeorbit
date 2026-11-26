import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  archiveConfirmCopy,
  employeeErrorText,
  formatEmployeeTime,
  historyDetail,
  historyLabel,
  isCurrentRequest,
  nameSourceLabel,
  organizationPath,
  projectEntries,
  reassignConfirmCopy,
  regenerateConfirmCopy,
  roleCategoryLabel,
  unassignConfirmCopy,
  type PathSegment,
} from "@/lib/employees";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { Employee, EmployeeDetails } from "../../../../shared/employees/types.ts";
import { KindBadge, StatusBadge } from "./bits";
import type { CompanyData } from "./useCompanyData";
import { ExecutionHistory } from "./ExecutionHistory";
import { EmployeeWorkSummary } from "./EmployeeWorkSummary";
import { AssignedTasksSection } from "./AssignedTasksSection";
import { EmployeeFormDialog } from "./EmployeeFormDialog";
import { HeadFormDialog } from "./HeadFormDialog";
import { EmployeeProfessionalProfileTab } from "./EmployeeProfessionalProfileTab";

export type EmployeeCardTab = "overview" | "prompt" | "assignments" | "history";

const CARD_TABS: { id: EmployeeCardTab; label: string }[] = [
  { id: "overview", get label() { return tr("common.overview"); } },
  { id: "prompt", get label() { return tr("common.professional_prompt"); } },
  { id: "assignments", get label() { return tr("common.assignments"); } },
  { id: "history", get label() { return tr("employees.execution_history"); } },
];

interface Props {
  employeeId: string;
  data: CompanyData;
  onBack: () => void;
  onChanged: () => void;
  onOpenEmployee: (id: string) => void;
  onOpenProject: (path: string) => void;
  onOpenCluster: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenRoleCatalog?: () => void;
  initialTab?: EmployeeCardTab;
}

/**
 * One employee's card. Every action here is an identity or assignment change
 * through the employee API. Nothing starts an AI process, picks a harness,
 * account or model, or changes what the employee may do.
 */
export function EmployeeCard({
  employeeId,
  data,
  onBack,
  onChanged,
  onOpenEmployee,
  onOpenProject,
  onOpenCluster,
  onOpenTask,
  onOpenRoleCatalog,
  initialTab = "overview",
}: Props) {
  useUILocale();
  const confirm = useConfirm();
  const [profession, setProfession] = useState<import("../../../../shared/employees/profile-types.ts").EmployeeProfessionalProfile | null>(null);
  const [professionError, setProfessionError] = useState<string | null>(null);
  const [details, setDetails] = useState<EmployeeDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [editing, setEditing] = useState(false);
  const [cardTab, setCardTab] = useState<EmployeeCardTab>(initialTab);
  const requestRef = useRef(0);
  const { tree } = data;

  useEffect(() => {
    const requestId = ++requestRef.current;
    void api.getEmployee(employeeId).then(
      (loaded) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setDetails(loaded);
        setLoadError(null);
      },
      (err: unknown) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setLoadError(employeeErrorText(err));
      },
    );
  }, [employeeId, data.version]);

  useEffect(() => {
    let active = true;
    setProfession(null);
    setProfessionError(null);
    void api.getEmployeeProfessionalProfile(employeeId).then((r) => {
      if (active) setProfession(r.profile);
    }).catch((err) => { if (active) setProfessionError(employeeErrorText(err)); });
    return () => { active = false; };
  }, [employeeId, data.version]);

  useEffect(() => {
    setStatus(null);
    setAssignTo("");
  }, [employeeId]);

  // Follow the stored name, but never overwrite what the owner is typing when
  // a background reload brings the same name back.
  const syncedName = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!details || details.id !== employeeId) return;
    const last = syncedName.current;
    if (last && last.id === details.id && last.name === details.name) return;
    syncedName.current = { id: details.id, name: details.name };
    setRenameValue(details.name);
  }, [details, employeeId]);

  const run = useCallback(async (action: () => Promise<Employee>, success: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      setStatus({ tone: "ok", text: success });
      onChanged();
    } catch (err) {
      setStatus({ tone: "error", text: employeeErrorText(err) });
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  if (loadError && (!details || details.id !== employeeId)) {
    return (
      <div className="flex flex-col gap-3" data-testid="employee-card-error">
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}><ArrowLeft className="size-3.5" aria-hidden /><I18nText id="common.back" /></Button>
        <p role="alert" className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
      </div>
    );
  }
  if (!details || details.id !== employeeId || !tree) {
    return <p data-testid="employee-card-loading" className="text-sm text-muted-foreground"><I18nText id="employees.loading_employee" /></p>;
  }

  const employee = details;
  const archived = employee.status === "archived";
  const path = organizationPath(employee, tree);
  const projects = projectEntries(tree).map((entry) => entry.team);

  const rename = () => {
    const name = renameValue.trim();
    if (!name || name === employee.name) return;
    void run(() => api.updateEmployee(employee.id, { name }), "Renamed. The id and history are unchanged.");
  };

  const regenerate = async () => {
    const copy = regenerateConfirmCopy(employee);
    if (!(await confirm(() => ({ title: copy.title, description: copy.description, confirmLabel: copy.confirmLabel })))) return;
    await run(() => api.regenerateEmployeeName(employee.id), "A new random name was drawn and saved.");
  };

  const assign = async () => {
    if (!assignTo) return;
    const target = projects.find((project) => project.projectPath === assignTo);
    if (!target) return;
    if (employee.projectPath && employee.projectPath !== assignTo) {
      const copy = reassignConfirmCopy(employee, target.projectName);
      if (!(await confirm(() => ({ title: copy.title, description: copy.description, confirmLabel: copy.confirmLabel })))) return;
    }
    await run(() => api.assignEmployee(employee.id, assignTo), `Assigned to ${target.projectName}. Nothing was started.`);
    setAssignTo("");
  };

  const unassign = async () => {
    const copy = unassignConfirmCopy(employee);
    if (!(await confirm(() => ({ title: copy.title, description: copy.description, confirmLabel: copy.confirmLabel })))) return;
    await run(() => api.unassignEmployee(employee.id), "Removed from the project.");
  };

  const archive = async () => {
    const copy = archiveConfirmCopy(employee);
    if (!(await confirm(() => ({ title: copy.title, description: copy.description, confirmLabel: copy.confirmLabel, variant: "destructive" })))) return;
    await run(() => api.archiveEmployee(employee.id), "Archived. History is kept.");
  };

  const segment = (item: PathSegment, index: number) => {
    const open = item.employeeId && item.employeeId !== employee.id
      ? () => onOpenEmployee(item.employeeId!)
      : item.kind === "project" && item.projectPath
        ? () => onOpenProject(item.projectPath!)
        : item.kind === "cluster" && item.clusterId
          ? () => onOpenCluster(item.clusterId!)
          : null;
    return (
      <li key={`${item.kind}-${index}`} className="flex min-w-0 items-center gap-1.5">
        {index > 0 && <span aria-hidden className="text-muted-foreground">›</span>}
        {open ? (
          <button type="button" className="glass-nav-item max-w-[16rem] truncate rounded px-1 text-sm underline-offset-2 hover:underline" title={item.label} onClick={open} data-testid={`path-${item.kind}`}>
            {item.label}
          </button>
        ) : (
          <span className={item.kind === "missing" ? "text-sm italic text-warning" : "max-w-[16rem] truncate text-sm"} title={item.label} data-testid={`path-${item.kind}`}>{item.label}</span>
        )}
      </li>
    );
  };

  return (
    <article className="flex min-w-0 flex-col gap-5" data-testid="employee-card" data-employee-id={employee.id} aria-labelledby="employee-card-name">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-1" data-testid="employee-card-back" onClick={onBack}>
            <ArrowLeft className="size-3.5" aria-hidden /><I18nText id="common.back" />{" "}</Button>
          <h2 id="employee-card-name" className="break-words text-xl font-semibold tracking-tight" data-testid="employee-card-name">{employee.name}</h2>
          {employee.displayName && <p className="break-words text-sm text-muted-foreground" data-testid="employee-card-display-name">{employee.displayName}</p>}
          <p className="mt-0.5 break-words text-sm" data-testid="employee-card-title">{employee.jobTitle}</p>
          {profession && <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="employee-card-profession">
            {profession.professionalTitle}{" "}<I18nText id="employees.active_prompt_revision" />{" "}{profession.currentRevision} · <code title={profession.activePrompt.promptSha256}><I18nText id="employees.sha_eba1d4" />{" "}{profession.activePrompt.promptSha256.slice(0, 12)}…</code>
          </p>}
          {professionError && <p className="text-xs text-warning"><I18nText id="employees.professional_profile_unavailable" />{" "}{professionError}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5"><KindBadge employee={employee} /><StatusBadge employee={employee} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!archived && <Button type="button" variant="outline" size="sm" data-testid="employee-edit" disabled={busy} onClick={() => setEditing(true)}><I18nText id="common.edit" /></Button>}
          {archived
            ? <Button type="button" variant="outline" size="sm" data-testid="employee-unarchive" disabled={busy} onClick={() => void run(() => api.unarchiveEmployee(employee.id), "Unarchived.")}><I18nText id="common.unarchive" /></Button>
            : <Button type="button" variant="outline" size="sm" data-testid="employee-archive" disabled={busy} onClick={() => void archive()}><I18nText id="common.archive" /></Button>}
        </div>
      </div>

      <p role="status" aria-live="polite" data-testid="employee-card-status" className={status?.tone === "error" ? "text-sm text-destructive" : "text-sm text-success"}>
        {status?.text ?? ""}
      </p>

      <div
        role="tablist"
        aria-label={tr("employees.employee_card_views")}
        data-testid="employee-card-tabs"
        className="flex rounded-lg border border-[hsl(var(--glass-border)/var(--glass-border-alpha))] p-0.5 self-start overflow-x-auto max-w-full"
      >
        {CARD_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`employee-tab-${item.id}`}
            data-testid={`employee-tab-${item.id}`}
            aria-selected={cardTab === item.id}
            className={cn("glass-nav-item rounded-md px-3 py-1 text-xs whitespace-nowrap", cardTab === item.id && "glass-selected")}
            onClick={() => setCardTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {cardTab === "prompt" && (
        <EmployeeProfessionalProfileTab
          employee={employee}
          onChanged={onChanged}
          onOpenRoleCatalog={onOpenRoleCatalog}
        />
      )}

      {(cardTab === "overview" || cardTab === "assignments" || cardTab === "history") && (
        <>
          {cardTab === "overview" && (
            <>
              {!archived && (
                <section aria-label={tr("common.name")} className="flex flex-col gap-2 rounded-xl border p-3" data-testid="employee-name-section">
                  <h3 className="text-sm font-medium"><I18nText id="common.name" /></h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="employee-card-rename"><I18nText id="common.name" /></label>
                    <Input id="employee-card-rename" data-testid="employee-card-rename" className="max-w-xs" value={renameValue} maxLength={80} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") rename(); }} />
                    <Button type="button" size="sm" data-testid="employee-card-rename-save" disabled={busy || !renameValue.trim() || renameValue.trim() === employee.name} onClick={rename}><I18nText id="employees.rename" /></Button>
                    {employee.kind === "head"
                      ? <span className="text-xs text-muted-foreground" data-testid="head-name-note"><I18nText id="employees.the_owner_names_the_head_it_is_never" /></span>
                      : <Button type="button" variant="outline" size="sm" data-testid="employee-regenerate" disabled={busy} onClick={() => void regenerate()}><I18nText id="employees.draw_a_new_random_name" /></Button>}
                  </div>
                  <p className="text-xs text-muted-foreground"><I18nText id="employees.renaming_keeps_the_id_and_history_names_may" /></p>
                </section>
              )}

              {employee.kind === "head" && !archived && (
                <div>
                  <Button type="button" variant="outline" size="sm" data-testid="head-edit" onClick={() => setEditing(true)}><I18nText id="employees.edit_name_and_description" /></Button>
                </div>
              )}

              <section aria-label={tr("employees.organization_path")} className="flex flex-col gap-2 rounded-xl border p-3" data-testid="employee-org-path">
                <h3 className="text-sm font-medium"><I18nText id="employees.organization_path" /></h3>
                <ol aria-label={tr("employees.reports_to")} className="flex flex-wrap items-center gap-1.5" data-testid="employee-reports-to">{path.chain.map(segment)}</ol>
                <ol aria-label={tr("employees.location")} className="flex flex-wrap items-center gap-1.5 text-muted-foreground" data-testid="employee-location">{path.location.map(segment)}</ol>
                {archived && <p className="text-xs text-muted-foreground"><I18nText id="employees.archived_employees_are_not_part_of_the_current" /></p>}
              </section>

              {employee.kind === "worker" && (
                <EmployeeWorkSummary key={`work-summary-${employeeId}`} employeeId={employeeId} refreshToken={data.version} />
              )}

              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="employee-details">
                <Detail label={tr("employees.role_category")} value={roleCategoryLabel(employee.roleCategory)} id="role" />
                <Detail label={tr("employees.specializations")} id="specializations" value={employee.specializations.length ? employee.specializations.join(", ") : tr("common.none_dc937b")} />
                <Detail label={tr("common.project_985959")} id="project" value={employee.projectPath ? (employee.projectName ?? "Project not registered") : tr("common.no_project")} />
                <Detail label={tr("employees.department")} id="department" value={employee.department ?? tr("common.none_dc937b")} />
                <Detail label={tr("employees.name_source")} id="name-source" value={nameSourceLabel(employee.nameSource)} />
                <Detail label={tr("common.created")} id="created" value={formatEmployeeTime(employee.createdAt)} />
                <Detail label={tr("common.updated")} id="updated" value={formatEmployeeTime(employee.updatedAt)} />
                {archived && <Detail label={tr("common.archived_bdb865")} id="archived" value={formatEmployeeTime(employee.archivedAt)} />}
                <Detail label={tr("common.description")} id="description" value={employee.description || tr("common.none_dc937b")} wide />
                {employee.notes && <Detail label={tr("common.notes")} id="notes" value={employee.notes} wide />}
                <Detail label={tr("employees.employee_id")} id="id" value={employee.id} mono wide />
              </dl>

              {employee.projectPath && (
                <div className="flex flex-wrap gap-2">
                  {employee.projectRegistered
                    ? <Button type="button" variant="outline" size="sm" data-testid="employee-open-project" onClick={() => onOpenProject(employee.projectPath!)}><I18nText id="employees.open_project" /></Button>
                    : <p className="text-xs text-warning" data-testid="employee-project-detached"><I18nText id="employees.this_project_is_no_longer_in_the_registry" /></p>}
                </div>
              )}

              {employee.kind === "worker" && !archived && (
                <section aria-label={tr("employees.project_assignment")} className="flex flex-col gap-2 rounded-xl border p-3" data-testid="employee-assign-section">
                  <h3 className="text-sm font-medium"><I18nText id="employees.project_assignment" /></h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="employee-assign-project"><I18nText id="common.project_985959" /></label>
                    <div className="w-64 max-w-full">
                      <Select id="employee-assign-project" data-testid="employee-assign-project" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                        <option value=""><I18nText id="common.choose_a_project" /></option>
                        {projects.filter((project) => project.projectPath !== employee.projectPath).map((project) => <option key={project.projectPath} value={project.projectPath}>{project.projectName}</option>)}
                      </Select>
                    </div>
                    <Button type="button" size="sm" data-testid="employee-assign" disabled={busy || !assignTo} onClick={() => void assign()}>{employee.projectPath ? tr("common.move_6ecc3d") : tr("common.assign")}</Button>
                    {employee.projectPath && <Button type="button" variant="outline" size="sm" data-testid="employee-unassign" disabled={busy} onClick={() => void unassign()}><I18nText id="common.unassign" /></Button>}
                  </div>
                  <p className="text-xs text-muted-foreground"><I18nText id="employees.assigning_records_where_the_employee_belongs_it_does" /></p>
                </section>
              )}
            </>
          )}

          {(cardTab === "overview" || cardTab === "assignments") && employee.kind === "worker" && (
            <AssignedTasksSection
              employee={employee}
              refreshToken={data.version}
              onOpenTask={onOpenTask}
              coworkers={data.all.filter((person) =>
                person.kind === "worker"
                && person.status === "active"
                && person.id !== employee.id
                && person.projectPath === employee.projectPath
                && person.projectRegistered,
              )}
            />
          )}

          {cardTab === "history" && employee.kind === "worker" && (
            <EmployeeWorkSummary key={`work-summary-history-${employeeId}`} employeeId={employeeId} refreshToken={data.version} />
          )}

          {(cardTab === "overview" || cardTab === "history") && (
            <ExecutionHistory key={employeeId} employeeId={employeeId} onOpenTask={onOpenTask} />
          )}

          {cardTab === "overview" && (
            <>
              <section aria-label={tr("employees.runtime_binding")} className="rounded-xl border p-3" data-testid="employee-runtime-binding">
                <h3 className="text-sm font-medium"><I18nText id="employees.runtime_binding" /></h3>
                <p className="mt-1 text-sm text-muted-foreground" data-testid="employee-runtime-note"><I18nText id="employees.none" />{" "}{employee.runtimeBinding.note}
                </p>
                <p className="mt-2 text-xs text-muted-foreground" data-testid="employee-authority-note">{employee.authority.note}</p>
              </section>

              <section aria-label={tr("common.history")} className="flex flex-col gap-2" data-testid="employee-history">
                <h3 className="text-sm font-medium"><I18nText id="common.history" /></h3>
                {employee.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground"><I18nText id="employees.no_recorded_changes" /></p>
                ) : (
                  <ol className="flex flex-col gap-1.5">
                    {[...employee.history].reverse().map((event) => (
                      <li key={event.id} className="rounded-lg border px-3 py-1.5" data-testid="employee-history-event" data-action={event.action}>
                        <p className="text-sm"><span className="font-medium">{historyLabel(event.action)}</span> <span className="text-xs text-muted-foreground">{formatEmployeeTime(event.at)}</span></p>
                        {historyDetail(event) && <p className="break-words text-xs text-muted-foreground">{historyDetail(event)}</p>}
                      </li>
                    ))}
                  </ol>
                )}
                {employee.historyTruncated && <p className="text-xs text-muted-foreground"><I18nText id="employees.older_changes_are_not_shown" /></p>}
              </section>
            </>
          )}
        </>
      )}

      {employee.kind === "head" ? (
        <HeadFormDialog open={editing} head={employee} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setStatus({ tone: "ok", text: "Saved." }); onChanged(); }} />
      ) : (
        <EmployeeFormDialog open={editing} employee={employee} projects={projects} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setStatus({ tone: "ok", text: "Saved." }); onChanged(); }} />
      )}
    </article>
  );
}

function Detail({ label, value, id, wide, mono }: { label: string; value: string; id: string; wide?: boolean; mono?: boolean }) {
  useUILocale();
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"} data-testid={`employee-detail-${id}`}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words text-sm"}>{value}</dd>
    </div>
  );
}
