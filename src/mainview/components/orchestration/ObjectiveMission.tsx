import { useEffect, useState, type FormEvent } from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { t, type TranslationKey } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import { api } from "@/lib/api";
import type { MissionRecord, ObjectiveBlocker } from "../../../shared/orchestration/types.ts";
import type { Project } from "../../../shared/types.ts";

const setupBlockers = new Set<ObjectiveBlocker>(["project", "developer", "reviewer", "developer-account", "reviewer-account"]);

export function ObjectiveMissionForm({ projects, onDraft }: { projects: Project[]; onDraft: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [scope, setScope] = useState(["", ""]);
  const [starting, setStarting] = useState(false);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = starting || Boolean(turnId);

  useEffect(() => {
    if (!turnId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id: string) {
      try {
        const result = await api.getPortfolioTurn(id);
        if (cancelled) return;
        if (result.status === "running") {
          timer = setTimeout(() => void poll(id), 500);
          return;
        }
        if (result.status !== "succeeded" || !result.missionId) throw new Error(result.error ?? "");
        setTurnId(null);
        setOpen(false);
        onDraft(result.missionId);
      } catch (problem) {
        if (!cancelled) {
          setError((problem as Error).message);
          setTurnId(null);
        }
      }
    }
    void poll(turnId);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [turnId, onDraft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const { turn } = await api.sendPortfolioMessage({ text: goal.trim(), objectiveProjectPaths: scope });
      setTurnId(turn.id);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setStarting(false);
    }
  }

  if (!open) return <Button className="w-fit" data-testid="new-objective-mission" onClick={() => setOpen(true)}>{t("objective.new")}</Button>;
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="objective-mission-form">
      <label className="block space-y-1 text-sm font-medium">
        <span>{t("objective.goal")}</span>
        <textarea className="block min-h-20 w-full rounded border border-border bg-background p-2 font-normal"
          value={goal} maxLength={4000} disabled={busy} onChange={event => setGoal(event.target.value)} required />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {scope.map((value, index) => (
          <label key={index} className="block min-w-0 space-y-1 text-sm font-medium">
            <span>{t(index === 0 ? "objective.projectA" : "objective.projectB")}</span>
            <select className="block w-full rounded border border-border bg-background p-2 font-normal" value={value}
              required disabled={busy} onChange={event => setScope(previous => previous.map((item, i) => i === index ? event.target.value : item))}>
              <option value="">{t("objective.chooseProject")}</option>
              {projects.map(project => <option key={project.path} value={project.path} disabled={scope[1 - index] === project.path}>{project.name}</option>)}
            </select>
          </label>
        ))}
      </div>
      {error !== null && <ObjectiveError text={t("objective.planError")} detail={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !goal.trim() || scope.some(path => !path) || scope[0] === scope[1]}>
          {t(busy ? "objective.planning" : "objective.propose")}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t("mc.cancel")}</Button>
      </div>
    </form>
  );
}

function ObjectiveError({ text, detail }: { text: string; detail: string }) {
  return <div role="alert" className="space-y-1 text-sm text-danger">
    <p>{text}</p>
    <TechnicalDetails rows={[{ label: t("objective.reason"), value: detail }]} />
  </div>;
}

export function ObjectiveMissionTasks({ mission, projects, onChanged, onOpenTask }: {
  mission: MissionRecord; projects: Project[]; onChanged: () => void; onOpenTask?: (id: string) => void;
}) {
  const { locale } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Set<string>>(() => new Set());
  const draft = mission.status === "draft";
  const setupMissing = mission.plan.tasks.some(task => task.objectiveBlockers?.some(blocker => setupBlockers.has(blocker)));
  const projectName = (path: string) => projects.find(project => project.path === path)?.name ?? path.split("/").at(-1) ?? path;
  const byId = new Map(mission.plan.tasks.map(task => [task.taskId, task]));

  async function action(key: string, execute: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await execute();
      setSubmitted(previous => new Set(previous).add(key));
      onChanged();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="min-w-0 space-y-4" data-testid="objective-mission-tasks">
      {draft && <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <h3 className="font-semibold">{t("objective.reviewPlan")}</h3>
        <p>{t("objective.reviewHint")}</p>
        <p>{t(mission.plan.objective?.activationId ? "objective.autonomous" : "objective.supervised")}</p>
      </div>}
      {error !== null && <ObjectiveError text={t("objective.actionError")} detail={error} />}
      {mission.projects.map(path => (
        <section key={path} className="min-w-0 space-y-2" aria-label={projectName(path)}>
          <h3 className="text-sm font-semibold">{projectName(path)}</h3>
          {mission.plan.tasks.filter(task => task.projectPath === path).map(task => {
            const spec = task.objectiveTask!;
            const pending = task.pendingLaunch;
            const dependencyWait = task.waitingOn === "dependency";
            const dependencies = task.dependencies.map(dep => byId.get(dep.taskId)).filter(item => item !== undefined);
            const list = dependencies.map(source => `${projectName(source.projectPath)} / ${source.taskTitle}`).join(", ");
            const waiting = task.waitingOn;
            const state = waiting ? t(`objective.waiting.${waiting}`) : t(`mc.phase.${task.phase}` as TranslationKey);
            const tone: BadgeProps["variant"] = waiting
              ? waiting === "owner" || waiting === "quota" || waiting === "project-stopped" || waiting === "recovery" ? "warning" : "secondary"
              : task.phase === "running" || task.phase === "qc_running" || task.phase === "starting" ? "info"
                : task.phase === "completed" ? "success"
                  : task.phase === "failed" || task.phase === "blocked" ? "destructive"
                    : task.phase === "awaiting_owner" ? "warning" : "secondary";
            return (
              <article key={task.taskId} data-testid={`objective-task-${task.taskId}`} data-phase={task.phase}
                className="ds-panel min-w-0 space-y-2 p-3 text-sm [overflow-wrap:anywhere]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="min-w-0 font-semibold">{task.taskTitle}</h4>
                  {!draft && <Badge variant={tone} data-testid={`objective-state-${task.taskId}`}>{state}</Badge>}
                </div>
                {draft && <p className="whitespace-pre-wrap text-muted-foreground">{spec.description}</p>}
                <p>{t(task.phase === "completed" ? "objective.delivered" : "objective.deliverable", { value: spec.deliverable })}</p>
                {task.phase === "completed" && task.resultSummary && <p className="whitespace-pre-wrap text-muted-foreground">{task.resultSummary}</p>}
                {spec.artifactPath && <p className="text-muted-foreground">{t("objective.artifact", { path: spec.artifactPath })}</p>}
                {draft && <p className="text-xs text-muted-foreground">
                  {t("objective.team", { developer: spec.developerName ?? t("m0.notSet"), reviewer: spec.reviewerName ?? t("m0.notSet") })}
                </p>}
                {(draft || dependencyWait) && <p className="text-muted-foreground">
                  {dependencyWait
                    ? t(dependencies.some(source => ["failed", "cancelled"].includes(source.phase)) ? "objective.failedDependency" : "objective.waitDependency", { list })
                    : list ? t("objective.dependency", { list }) : t("objective.independent")}
                </p>}
                {task.waitingOn === "project-stopped" && <p className="text-warning">{t("objective.block.stopped")}</p>}
                {task.accountLimit && <MissionAccountLimitNotice mission={mission} task={task} onChanged={onChanged} />}
                {task.objectiveBlockers?.map(blocker => <p className="text-warning" key={blocker}>{t(`objective.block.${blocker}` as TranslationKey)}</p>)}
                {task.recovery && <p className="text-warning">{t("objective.recovery")}</p>}
                {pending && mission.status === "running" && task.waitingOn !== "quota" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button data-testid={`objective-confirm-${task.taskId}`} size="sm"
                      disabled={busy !== null || task.objectiveBlockers?.includes("stopped")}
                      onClick={() => void action(pending.operationId, () => api.confirmObjectiveLaunch(mission.id, task.taskId, pending.operationId, locale))}>
                      {t(pending.role === "developer" ? "objective.launchDeveloper" : "objective.launchReviewer")}
                    </Button>
                    {pending.usageNotice && <span className="text-xs text-muted-foreground">{t("objective.usage")}</span>}
                  </div>
                )}
                {!draft && onOpenTask && <Button size="sm" variant="outline" onClick={() => onOpenTask(task.taskId)}>{t("objective.openTask")}</Button>}
                <TechnicalDetails rows={[
                  { label: t("objective.reason"), value: task.phaseReason },
                  { label: t("objective.developerResource"), value: task.developerBinding && [task.harnessId, task.modelId, task.accountId, task.mode].join(" / ") },
                  { label: t("objective.reviewerResource"), value: task.reviewerBinding && [task.reviewerBinding.harnessId, task.reviewerBinding.modelId, task.reviewerBinding.accountId, task.reviewerBinding.mode].join(" / ") },
                  { label: t("mc.runLabel"), value: task.runId },
                  { label: t("mcDep.task"), value: task.taskId },
                ]} />
              </article>
            );
          })}
        </section>
      ))}
      {draft && <div className="space-y-2">
        {setupMissing && <p className="text-sm text-muted-foreground" id="objective-setup-needed">{t("objective.setupNeeded")}</p>}
        <Button data-testid="approve-objective-mission" aria-describedby={setupMissing ? "objective-setup-needed" : undefined}
          disabled={setupMissing || busy !== null || submitted.has(mission.id)}
          onClick={() => void action(mission.id, () => api.approveObjectiveMission(mission.id, mission.planDigest))}>{t("objective.approve")}</Button>
      </div>}
    </section>
  );
}
import { MissionAccountLimitNotice } from "@/components/ui/account-limit-notice";
