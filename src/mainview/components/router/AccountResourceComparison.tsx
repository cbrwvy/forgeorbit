import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { t } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { OptionCard } from "../kanban/ExecutorSuggestions";
import type { ExecutorOption, RecommendationResponse } from "../../../shared/execution/executor-routing.ts";
import type { ResourceRole } from "../../../shared/model-router/account-eligibility.ts";

/** Existing task/resource recommendations in batch preparation. Choose only fills the draft. */
export function AccountResourceComparison({ taskId, role, harnessId, model, mode, kind, onChoose }: {
  taskId: string; role: ResourceRole; harnessId: string; model: string; mode: string; kind?: string;
  onChoose: (option: ExecutorOption) => void;
}) {
  useLocale();
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null); setError("");
    if (!open) return;
    const abort = new AbortController();
    void api.employeeExecutionRecommendations({ taskId, harnessId, model, role, mode, effort: null, complexity: null, expectedAssignmentRevision: null }, abort.signal)
      .then(r => { if (!abort.signal.aborted) setData(r); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => abort.abort();
  }, [taskId, role, harnessId, model, mode, open]);
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => { setData(null); setError(t("routing02.expired")); }, Math.max(0, data.recommendations.capturedAt + 30_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [data]);
  return <div className="w-full space-y-1 text-xs" data-testid={`resource-comparison-${role}`}>
    <Button type="button" size="sm" variant="outline" data-testid="resource-comparison-toggle" onClick={() => setOpen(v => !v)}>{t("routing02.compare")} · {t(`routing02.role.${role}`)}</Button>
    {open && <>
      <p>{t("routing02.advisory")}</p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>{t("common.loading")}</p>}
      {data && <ul className="space-y-1">{Object.values(data.recommendations.groups).flat().filter(o => (!kind || o.kind === kind) && o.modelId === model).map(o => <OptionCard key={o.id} option={o} chosen={o.harnessId === harnessId && o.modelId === model} onChoose={onChoose} />)}</ul>}
    </>}
  </div>;
}

export function ManagerResourceComparison({ role, harnessId, model, onChoose }: {
  role: "project-manager" | "head"; harnessId: string; model: string; onChoose: (option: ExecutorOption) => void;
}) {
  useLocale();
  const [open,setOpen] = useState(false);
  const [data,setData] = useState<RecommendationResponse["recommendations"] | null>(null);
  const [error,setError] = useState("");
  useEffect(() => {
    setData(null); setError("");
    if (!open) return;
    const abort = new AbortController();
    void api.modelRouter.managerRecommendations({role,harnessId,model},abort.signal).then(r=>{if (!abort.signal.aborted) setData(r);}).catch(e=>{if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));});
    return ()=>abort.abort();
  },[role,harnessId,model,open]);
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => { setData(null); setError(t("routing02.expired")); }, Math.max(0, data.capturedAt + 30_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [data]);
  return <section data-testid={`manager-resource-comparison-${role}`} className="space-y-1">
    <Button type="button" variant="outline" size="sm" data-testid="resource-comparison-toggle" onClick={()=>setOpen(v=>!v)}>{t("routing02.compare")}</Button>
    {open && <><p>{t("routing02.advisory")}</p>{error && <p role="alert">{error}</p>}{!data && !error && <p>{t("common.loading")}</p>}{data && <ul className="space-y-1">{Object.values(data.groups).flat().filter(o=>o.harnessId===harnessId || ["codex","cursor","antigravity"].includes(o.kind)).map(o=><OptionCard key={o.id} option={o} chosen={o.harnessId===harnessId && o.modelId===model} onChoose={onChoose} />)}</ul>}</>}
  </section>;
}
