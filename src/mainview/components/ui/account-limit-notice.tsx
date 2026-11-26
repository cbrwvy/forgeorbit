import { t } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import { when } from "@/lib/accounts";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useState } from "react";
import type { ExhaustedQuotaWindow } from "../../../shared/accounts/resolve.ts";
import type { MissionRecord, MissionTaskPlan } from "../../../shared/orchestration/types.ts";

export function QuotaWindowLimit({ account, windows, resetAt, now = Date.now() }: {
  account: string;
  windows: ExhaustedQuotaWindow[];
  resetAt: number | null;
  now?: number;
}) {
  useLocale();
  return <div className="space-y-1 rounded-md border border-border bg-muted/35 p-2.5 text-xs [overflow-wrap:anywhere]" data-testid="quota-window-limit" data-reset={resetAt === null ? "unknown" : "confirmed"}>
    <p className="font-medium">{resetAt === null ? t("account_limit.reset_unknown", { account }) : t("account_limit.wait_until", { account, time: when(resetAt) })}</p>
    {windows.map(window => <TechnicalDetails key={window.id} summary={t("refusal.details")} rows={[
      { label: t("common.source"), value: window.source },
      { label: t("accounts.observed_at"), value: when(window.observedAt) },
      { label: t("common.freshness"), value: t(window.expiresAt !== null && window.expiresAt > now ? "account_limit.fresh" : "account_limit.stale") },
      { label: t("accounts.window"), value: `${window.scope} · ${window.window}` },
      { label: t("common.reset_time"), value: when(window.resetAt) },
    ]} />)}
  </div>;
}

export function MissionAccountLimitNotice({ mission, task, onChanged }: { mission: MissionRecord; task: MissionTaskPlan; onChanged: () => void }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const limit = task.accountLimit;
  if (!limit) return null;
  if (!("refusal" in limit)) return <QuotaWindowLimit account={limit.accountLabel} windows={limit.windows} resetAt={limit.resetAt} />;
  const waiting = task.waitingOn === "quota";
  const retry = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.retryMissionQuotaWait(mission.id, task.taskId, limit.refusal.id);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return <div className="space-y-1">
    <ProviderRefusalNotice refusal={limit.refusal} accountLabel={limit.accountLabel} waiting={waiting}
      testId="mission-account-limit" className="space-y-1 rounded-md border border-border bg-muted/35 p-2.5 text-xs [overflow-wrap:anywhere]" />
    {waiting && mission.status === "running" && (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("account_limit.retry_scope")}</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>{t("account_limit.retry")}</Button>
      </div>
    )}
    {failed && <p role="alert" className="text-xs text-destructive">{t("account_limit.retry_failed")}</p>}
  </div>;
}
