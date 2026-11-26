import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { t } from "@/i18n/core";
import { Button } from "@/components/ui/button";
import type { HeadPmInitiativeView } from "../../../shared/head-pm-initiative.ts";
import type { HeadAutoView } from "../../../shared/head-pm-auto.ts";
import type { OrchestratedBatchView } from "../../../shared/pm-orchestrated-batch.ts";

export function HeadAutoPanel({ initiative, onOpenManager }: { initiative: HeadPmInitiativeView; onOpenManager: (path: string, view?: "chat" | "inbox" | "plan" | "runs") => void }) {
  const [view, setView] = useState<HeadAutoView>({record: null, batches: []});
  const [choices, setChoices] = useState<OrchestratedBatchView[][]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const [v, options] = await Promise.all([api.getHeadAuto(initiative.id), Promise.all(initiative.contributions.map(c => api.listOrchestratedBatches(c.projectPath)))]);
        if (live) { setView(v); setChoices(options); setLoadError(null); }
      } catch (e) { if (live) setLoadError(String(e)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [initiative.id]);
  const c = view.record;
  const canPrepare = !c || ["draft", "cancelled", "completed"].includes(c.status);
  const selected = initiative.contributions.map((_, n) => ids[n] ?? choices[n]?.find(b => b.batch.status === "approved")?.batch.id ?? "");
  async function act(action: string) {
    setBusy(true); setError(null);
    try { setView(action === "prepare" ? await api.prepareHeadAuto(initiative.id, selected) : await api.actHeadAuto(initiative.id, action, c?.digest)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (initiative.contributions.length !== 2) return null;
  return <section className="space-y-2 rounded border border-border p-2" data-testid="head-auto-panel" data-status={c?.status ?? "none"}>
    <h4 className="font-semibold">{t("headAuto.title")}</h4>
    <p className="text-muted-foreground">{t("headAuto.policy")}</p>
    {(error || loadError) && <p role="alert" className="text-danger">{error || loadError}</p>}
    {canPrepare && initiative.contributions.map((p,n) => <label key={p.projectPath} className="block">
      {n+1}. {p.projectName} · {p.pmName}
      <select className="block w-full rounded border border-input bg-background" value={selected[n]} data-testid={`head-auto-batch-${n}`} onChange={e => setIds(() => { const next = [...selected]; next[n] = e.target.value; return next; })}>
        <option value="">{t("headAuto.pick")}</option>
        {choices[n]?.filter(b => b.batch.status === "approved").map(b => <option key={b.batch.id} value={b.batch.id}>{b.batch.title} · {b.batch.tasks.length} · {b.batch.id}</option>)}
      </select>
    </label>)}
    {canPrepare && <Button size="sm" variant="outline" data-testid="head-auto-prepare" disabled={busy || selected.some(id => !id)} onClick={() => void act("prepare")}>{t("headAuto.prepare")}</Button>}
    {view.batches.some(b => b.usesFakeDriver) && <p data-testid="head-auto-fake" className="text-muted-foreground">{t("headAuto.fake")}</p>}
    {c && <>
      <p data-testid="head-auto-status">{t(`headAuto.status.${c.status}`)} · {c.completedBatchIds.length}/2</p>
      <p>{t("headAuto.current")}: {c.plan.projects[c.currentIndex]?.projectName ?? t("headAuto.awaitingOwner")}</p>
      {c.blocker && <p className="text-warning" data-testid="head-auto-blocker">{c.blocker}</p>}
      <div className="space-y-2 break-words" data-testid="head-auto-plan">
        <p>{c.plan.title} · {t("headAuto.launches")}: {c.plan.maxLaunches} · {t("headAuto.expiry")}: {new Date(c.plan.expiresAt).toLocaleString()}</p>
        <p>{t("headAuto.quota")}</p>
        <p className="font-mono text-[9px]" data-testid="head-auto-digest">{c.digest}</p>
        {c.plan.projects.map((p,n) => {
          const batch = view.batches.find(b => b.batch.id === p.batchId);
          return <div key={p.batchId} data-testid="head-auto-project" data-project={p.projectPath} data-status={batch?.batch.status} className="rounded border border-border/60 p-1">
            <p>{n+1}. {p.projectName} {t("m0.pmName", { name: p.pmName ?? "—" })} · {p.batchId} · {t("headAuto.batchStatus")}: {batch?.batch.status}</p>
            <p>{t("headAuto.launches")}: {p.policy.maxLaunchesPerTask} × {p.tasks.length} · {t("headAuto.expiry")}: {new Date(p.policy.expiresAt!).toLocaleString()}</p>
            {p.tasks.map(task => <p key={task.taskId} data-testid="head-auto-task">
              {task.order+1}. {task.title} · {t("headAuto.developer")}: {p.assignments.find(a => a.taskId === task.taskId)?.employeeName ?? task.implementerEmployeeId} · {task.implementerHarnessId}/{task.implementerModel}/{task.execution?.implementerMode} · {task.execution?.implementerAccountProfile?.displayName ?? t("headAuto.defaultAccount")}
              <br/>{t("headAuto.reviewer")}: {task.reviewerHarness}/{task.reviewerModel}/{task.execution?.reviewerMode} · {task.execution?.reviewerAccountProfile?.displayName ?? t("headAuto.defaultAccount")} · {batch?.tasks.find(x => x.taskId === task.taskId)?.phase}
            </p>)}
            <Button variant="ghost" size="sm" onClick={() => onOpenManager(p.projectPath, "runs")}>{t("headAuto.openBatch")}</Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenManager(p.projectPath, "runs")}>{t("headAuto.openRuns")}</Button>
          </div>;
        })}
      </div>
      <div className="flex flex-wrap gap-1">
        {([...(c.status === "draft" ? ["authorize"] : []), ...(c.status === "approved" ? ["start"] : []), ...(["running", "approved"].includes(c.status) ? ["pause"] : []), ...(c.status === "paused" ? ["resume"] : []), ...(!["cancelled", "completed"].includes(c.status) ? ["cancel"] : [])]).map(action => <Button key={action} size="sm" variant="outline" disabled={busy} data-testid={`head-auto-${action}`} onClick={() => void act(action)}>{t(`headAuto.${action}` as "headAuto.start")}</Button>)}
      </div>
      <details><summary>{t("headAuto.history")}</summary>{c.history.map((e,n) => <p key={n}>{new Date(e.at).toLocaleTimeString()} · {e.text}</p>)}</details>
    </>}
  </section>;
}
