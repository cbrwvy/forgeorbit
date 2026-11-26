import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RunExecution } from "../../../shared/run-execution.ts";
import { t } from "@/i18n/core";

export function RunExecutionDetails({ runId, compact = false }: { runId?: string | null; compact?: boolean }) {
  const [view, setView] = useState<RunExecution | null>(null);
  useEffect(() => {
    let disposed = false;
    setView(null);
    if (!runId) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = () => api.getRunExecution(runId).then(v => { if (!disposed) { setView(v); if (v.outcome !== "running") clearInterval(timer); } }).catch(() => {});
    timer = setInterval(load, 2500);
    void load();
    return () => { disposed = true; clearInterval(timer); };
  }, [runId]);
  return <div className="space-y-1 text-[11px] text-muted-foreground" data-testid="run-execution" data-execution-type={view?.type ?? "unknown"}>
    <span>{t(`run_execution.${view?.type ?? "unknown"}`)}{view?.mode ? ` · ${view.mode}` : ""}</span>
    {view?.accountProfile && <p data-testid="run-account-profile">{t("codex_profiles.profile")}: {view.accountProfile.displayName}</p>}
    {!compact && <>
      <p>{view?.provider ?? t("common.unknown")} · {view?.model ?? t("common.unknown")} · {view?.outcome ?? t("common.unknown")}</p>
      <p>{t("run_execution.reported", { turns: String(view?.turns ?? "—"), cost: view?.reportedCostUsd == null ? "—" : String(view.reportedCostUsd) })}</p>
      {view?.configuredThresholdUsd != null && <p>{t("run_execution.threshold", { cost: String(view.configuredThresholdUsd), turns: String(view.configuredTurnLimit ?? "—") })}</p>}
      <p>{t("run_execution.quota")} · {t("run_execution.limit")}: {view?.limitTermination == null ? t("common.unknown") : view.limitTermination ? t("run_execution.yes") : t("common.no")}</p>
      {view?.termination && <p>{view.termination}</p>}
    </>}
  </div>;
}
