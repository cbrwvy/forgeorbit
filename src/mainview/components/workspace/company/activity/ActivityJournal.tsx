import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t, formatDate } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import { api } from "@/lib/api";
import { EVENT_STATUS, activityDateRange, groupActivity } from "@/lib/activity-journal";
import { Button } from "@/components/ui/button";
import type { ProjectSurfacePage } from "@/lib/workspace";
import { ACTIVITY_EVENT_TYPES, type ActivityActorType, type ActivityEvent, type ActivityQueryFilter } from "../../../../../shared/activity/types.ts";
import type { Employee, ProjectTeam } from "../../../../../shared/employees/types.ts";
import { useActivityJournal } from "./useActivityJournal";

interface Props {
  projectPath?: string;
  employees: Employee[];
  projects: ProjectTeam[];
  onOpenEmployee: (id: string) => void;
  onOpenProject: (path: string, page: ProjectSurfacePage) => void;
  onOpenTask: (id: string) => void;
}
const controlClass = "[color-scheme:light] dark:[color-scheme:dark] w-full min-w-0 rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
// Canonical backend role markers identify actors, never Employee records.
const syntheticActorIds = new Set(["owner", "runtime", "project-manager"]);
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">{label}{children}</label>;
}

export function ActivityJournal(props: Props) {
  useLocale();
  const [project, setProject] = useState(props.projectPath ?? "");
  const [actor, setActor] = useState("");
  const [actorId, setActorId] = useState("");
  const [employee, setEmployee] = useState("");
  const [eventType, setEventType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filter = useMemo<ActivityQueryFilter | null>(() => {
    try {
      return { projectPath: props.projectPath || project || undefined, actorType: actor as ActivityActorType || undefined, actorId: actorId.trim() || undefined, employeeId: employee || undefined, eventType: eventType || undefined, ...activityDateRange(from, to) };
    } catch { return null; }
  }, [props.projectPath, project, actor, actorId, employee, eventType, from, to]);
  const journal = useActivityJournal(filter);
  const groups = groupActivity(journal.events);
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="activity-journal" aria-label={t("activity.title")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-base font-semibold">{t("activity.title")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("activity.note")}</p></div>
        <Button type="button" variant="outline" size="sm" disabled={!filter || journal.loading} onClick={journal.refresh} data-testid="activity-refresh">{t("activity.refresh")}</Button>
      </div>
      {props.projectPath && <p className="break-all text-xs" data-testid="activity-project-scope">{t("activity.lockedProject")} {props.projectPath}</p>}
      <fieldset className="grid min-w-0 gap-3 rounded-xl border p-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }} aria-label={t("activity.all")}>
        <Field label={t("activity.project")}><select className={controlClass} value={props.projectPath ?? project} disabled={!!props.projectPath} onChange={e => setProject(e.target.value)} data-testid="activity-filter-project"><option value="">{t("activity.all")}</option>{props.projectPath && !props.projects.some(p => p.projectPath === props.projectPath) && <option value={props.projectPath}>{props.projectPath}</option>}{props.projects.map(p => <option key={p.projectPath} value={p.projectPath}>{p.projectName}</option>)}</select></Field>
        <Field label={t("activity.actor")}><select className={controlClass} value={actor} onChange={e => setActor(e.target.value)} data-testid="activity-filter-actor"><option value="">{t("activity.all")}</option>{(["owner", "project-manager", "employee", "system"] as const).map(a => <option key={a} value={a}>{t(`activity.actor.${a}`)}</option>)}</select></Field>
        <Field label={t("activity.actorId")}><input className={controlClass} value={actorId} onChange={e => setActorId(e.target.value)} data-testid="activity-filter-actor-id" /></Field>
        <Field label={t("activity.employee")}><select className={controlClass} value={employee} onChange={e => setEmployee(e.target.value)} data-testid="activity-filter-employee"><option value="">{t("activity.all")}</option>{props.employees.map(e => <option key={e.id} value={e.id}>{e.displayName || e.name}</option>)}</select></Field>
        <Field label={t("activity.type")}><select className={controlClass} value={eventType} onChange={e => setEventType(e.target.value)} data-testid="activity-filter-type"><option value="">{t("activity.all")}</option>{ACTIVITY_EVENT_TYPES.map(type => <option key={type} value={type}>{t(`activity.event.${type}`)}</option>)}</select></Field>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("activity.from")}><input className={controlClass} type="date" value={from} onChange={e => setFrom(e.target.value)} data-testid="activity-filter-from" /></Field>
          <Field label={t("activity.to")}><input className={controlClass} type="date" value={to} onChange={e => setTo(e.target.value)} data-testid="activity-filter-to" /></Field>
        </div>
      </fieldset>
      {!filter && <p role="alert">{t("activity.invalidDates")}</p>}
      {journal.offline && <p role="status" className="rounded-lg border border-warning/40 p-3 text-sm" data-testid="activity-offline">{t("activity.offline")}</p>}
      {journal.error && <div role="alert" className="text-sm text-destructive" data-testid="activity-error">{t("activity.error")} <Button type="button" variant="outline" size="sm" disabled={journal.loading} onClick={journal.refresh}>{t("common.retry")}</Button></div>}
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="activity-loading">{journal.loading ? t("activity.loading") : ""}</p>
      {!journal.loading && !journal.error && filter && !journal.events.length && <p data-testid="activity-empty" className="py-6 text-sm text-muted-foreground">{t("activity.empty")}</p>}
      <p className="text-xs text-muted-foreground">{t("activity.currentNames")}</p>
      <div aria-busy={journal.loading} className="flex min-w-0 flex-col gap-4">
        {groups.map(group => <section key={group.key} aria-label={formatDate(group.at, { dateStyle: "long" })} data-testid="activity-day">
          <h3 className="mb-2 text-sm font-medium">{formatDate(group.at, { dateStyle: "long" })}</h3>
          <ol className="flex min-w-0 flex-col divide-y rounded-xl border">{group.events.map(event => <ActivityRow key={event.id} event={event} {...props} />)}</ol>
        </section>)}
      </div>
      {journal.more && <Button type="button" variant="outline" className="self-start" disabled={journal.loading} onClick={journal.loadMore} data-testid="activity-more">{t("activity.more")}</Button>}
    </section>
  );
}

export function ActivityRow({ event, ...props }: Props & { event: ActivityEvent }) {
  useLocale();
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const employeeName = (id: string) => props.employees.find(e => e.id === id)?.displayName || props.employees.find(e => e.id === id)?.name || (id === event.employeeId && typeof event.payload.employeeName === "string" ? event.payload.employeeName : id);
  const project = props.projects.find(p => p.projectPath === event.projectPath);
  // Display only these explicitly named, backend-allowlisted user titles. Never render a raw payload.
  const taskTitle = typeof event.payload.taskTitle === "string" ? event.payload.taskTitle : event.taskId;
  const target = event.targetType === "employee" ? employeeName(event.targetId) : event.targetType === "task" ? taskTitle || event.targetId : event.targetType === "project" ? project?.projectName || event.targetId : event.eventType === "task.proposal.created" && typeof event.payload.title === "string" ? event.payload.title : event.targetId;
  const actorEmployeeId = (event.actorType === "employee" || event.actorType === "project-manager") && event.actorId && !syntheticActorIds.has(event.actorId) ? event.actorId : null;
  const actorName = event.actorId ? syntheticActorIds.has(event.actorId) ? null : employeeName(event.actorId) : (event.actorType === "employee" || event.actorType === "project-manager") ? t("activity.unknown") : null;
  const open = async (kind: "employee" | "project" | "task" | "runs" | "proposal", id: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setUnavailable(false);
    try {
      // Verify the canonical source still exists; the SSE notification never supplies it.
      await api.getActivity(event.id, controller.signal);
      if (controller.signal.aborted) return;
      if (kind === "employee") {
        await api.getEmployee(id, controller.signal);
        if (!controller.signal.aborted) props.onOpenEmployee(id);
      } else if (kind === "project" || kind === "proposal") {
        const projects = await api.listProjects(controller.signal);
        if (!projects.some(p => p.path === id)) throw new Error("unavailable");
        let page: ProjectSurfacePage = "overview";
        if (kind === "proposal") {
          const proposalId = typeof event.payload.proposalId === "string" ? event.payload.proposalId : event.targetId;
          if (event.eventType === "task.proposal.created") {
            const state = await api.getManager(id, controller.signal);
            if (!state.proposals.some(p => p.id === proposalId)) throw new Error("unavailable");
            page = "manager";
          } else {
            const result = await api.listAssignmentProposals({projectPath:id}, controller.signal);
            if (!result.proposals.some(p => p.id === proposalId)) throw new Error("unavailable");
          }
        }
        if (!controller.signal.aborted) props.onOpenProject(id, page);
      } else {
        const task = await api.getTask(id, controller.signal);
        if (task.id !== id || (event.projectPath && task.workdir !== event.projectPath)) throw new Error("unavailable");
        if (kind === "runs") {
          const runs = await api.listRuns(id, controller.signal);
          if (!runs.some(r => r.id === event.runId)) throw new Error("unavailable");
        }
        if (!controller.signal.aborted) props.onOpenTask(id);
      }
    } catch { if (!controller.signal.aborted) setUnavailable(true); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const employeeIds = [...new Set([event.employeeId, event.targetType === "employee" ? event.targetId : null, actorEmployeeId].filter((id): id is string => !!id))];
  const status = EVENT_STATUS[event.eventType];
  return <li className="min-w-0 p-3 [overflow-wrap:anywhere]" data-testid="activity-event" data-id={event.id} data-sequence={event.sequenceId} data-event-type={event.eventType}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h4 className="min-w-0 flex-1 text-sm font-medium">{t(`activity.event.${event.eventType}`)}</h4>
      <span className={`rounded-full border px-2 py-0.5 text-xs ${status === "failed" || status === "indeterminate" ? "border-warning/50 text-warning" : "text-muted-foreground"}`} data-testid="activity-status" data-status={status}>{t(`activity.status.${status}`)}</span>
    </div>
    <time className="mt-1 block text-xs text-muted-foreground" dateTime={new Date(event.createdAt).toISOString()}>{formatDate(event.createdAt, { dateStyle: "medium", timeStyle: "medium" })}</time>
    <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">{t("activity.actor")}</dt><dd>{t(`activity.actor.${event.actorType}`)}{actorName ? ` · ${actorName}` : ""}</dd>
      <dt className="text-muted-foreground">{t("activity.target")}</dt><dd>{target}</dd>
      {event.employeeId && <><dt className="text-muted-foreground">{t("activity.employee")}</dt><dd>{employeeName(event.employeeId)}</dd></>}
      {event.taskId && event.targetType !== "task" && <><dt className="text-muted-foreground">{t("activity.task")}</dt><dd>{taskTitle}</dd></>}
      <dt className="text-muted-foreground">{t("activity.project")}</dt><dd>{project?.projectName || event.projectPath || t("activity.unscoped")}</dd>
    </dl>
    <details className="mt-2 text-xs"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{t("activity.details")}</summary>
      <div className="mt-2 flex flex-wrap gap-2">
        {employeeIds.map(id => <Button key={id} type="button" variant="outline" size="sm" className="h-auto max-w-full whitespace-normal text-left" disabled={busy} onClick={() => void open("employee", id)}>{t("activity.openEmployee")} · {employeeName(id)}</Button>)}
        {event.projectPath && <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal" disabled={busy} onClick={() => void open("project", event.projectPath!)}>{t("activity.openProject")}</Button>}
        {event.taskId && <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal" disabled={busy} onClick={() => void open("task", event.taskId!)}>{t("activity.openTask")}</Button>}
        {event.runId && event.taskId && <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal" disabled={busy} onClick={() => void open("runs", event.taskId!)}>{t("activity.openRuns")}</Button>}
        {(event.eventType.startsWith("task.assignment.") || event.eventType === "task.proposal.created") && event.projectPath && <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal" disabled={busy} onClick={() => void open("proposal", event.projectPath!)}>{t("activity.openProposal")}</Button>}
        {!event.projectPath && !event.taskId && !employeeIds.length && <p>{t("activity.noRoute")}</p>}
      </div>
      {event.runId && <p className="mt-2">{t("activity.run")}: {event.runId}</p>}
      {unavailable && <p role="alert" className="mt-2 text-warning" data-testid="activity-unavailable">{t("activity.unavailable")}</p>}
    </details>
  </li>;
}
