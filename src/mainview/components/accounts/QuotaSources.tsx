import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { CodexSource } from "./CodexSource";
import { ProviderEvidence } from "./ProviderEvidence";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { when, observationFreshness } from "@/lib/accounts";
import { Facts } from "./AccountEvidence";
import type { QuotaRefreshAvailability } from "../../../shared/accounts/quota-sources.ts";
import type { QuotaState } from "../../../shared/accounts/types.ts";

export function QuotaSources({ accountId, quotas = [], version, now = Date.now(), onUpdated }: {
  accountId?: string; quotas?: QuotaState[]; version: number; now?: number; onUpdated?: () => Promise<void>;
}) {
  useUILocale();
  const [sources, setSources] = useState<QuotaRefreshAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshing = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setSources(null); setError(null); setNotice(null);
    const load = accountId ? api.accountCore.quotaSources(accountId) : api.accountCore.sources();
    void load.then(value => { if (active) setSources(value); }).catch(() => { if (active) setError(tr("common.unable_to_load_quota_source_capabilities")); });
    return () => { active = false; };
  }, [accountId, version, retry]);
  async function refresh(sourceId: string) {
    if (!accountId || refreshing.current) return;
    refreshing.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await api.accountCore.refreshQuota(accountId, sourceId);
      await onUpdated?.();
      setNotice("Quota observations refreshed. Account declarations and CLI authentication are unchanged.");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setError(status === 504 ? tr("common.quota_refresh_timed_out_previous_observations_were_retained")
        : status === 401 || status === 403 ? tr("common.quota_refresh_authorization_failed")
        : status === 409 ? tr("common.quota_refresh_is_unavailable_or_already_in_progress")
        : tr("common.quota_refresh_failed_previous_observations_were_retained"));
    } finally { refreshing.current = false; setBusy(false); }
  }
  return <section className="space-y-3" aria-label={tr("accounts.quota_sources")} data-testid="quota-sources">
    <h4 className="text-sm font-semibold"><I18nText id="accounts.quota_sources" /></h4>
    <p className="text-xs text-muted-foreground"><I18nText id="accounts.documented_api_availability_does_not_mean_a_connector" /></p>
    {error && <p role="alert" className="text-xs">{error}</p>}
    {notice && <p role="status" className="text-xs">{notice}</p>}
    {!sources && !error && <p role="status"><I18nText id="accounts.loading_source_capabilities" /></p>}
    {error && <Button variant="outline" size="sm" disabled={busy} onClick={() => setRetry(n => n + 1)}><I18nText id="accounts.reload_source_capabilities" /></Button>}
    {sources?.map(source => {
      const observations = quotas.flatMap(q => q.observations).filter(o => o.source === `trusted:${source.id}` && o.acquisition);
      const last = observations.sort((a,b) => b.observedAt - a.observedAt)[0];
      return <article key={source.id} className="space-y-2 rounded-lg border p-3" data-testid={`quota-source-${source.id}`}>
        <h5 className="text-sm font-medium">{source.label}</h5>
        <Facts values={[
          [tr("common.source_id"), source.id], [tr("common.provider"), source.provider], [tr("common.documentation"), source.documentation], [tr("common.acquisition_policy"), source.acquisition],
          [tr("common.quota_connector"), source.implemented ? tr("common.implemented") : tr("common.not_implemented")], [tr("common.metrics"), source.metrics],
          [tr("common.authorization"), source.authorization], [tr("common.account_identity"), source.identity], [tr("common.windows_reset"), source.windows],
          [tr("common.shared_pool_support"), source.sharedPool], [tr("common.documentation_checked"), source.checkedAt],
          [tr("common.last_verified_observation"), when(last?.observedAt)],
          [tr("common.verified_source_freshness"), last ? observationFreshness(last, now) : tr("common.unknown")],
          [tr("common.refresh_availability"), source.reason],
        ]} />
        {source.id === "codex-app-server" && <CodexSource />}
        {source.id === "codex-app-server" && accountId && <ProviderEvidence accountId={accountId} onUpdated={onUpdated} />}
        {source.officialUrl && <a className="text-xs underline" href={source.officialUrl} target="_blank" rel="noreferrer"><I18nText id="accounts.official_documentation" /></a>}
        <div><Button size="sm" variant="outline" disabled={!accountId || !source.refreshAvailable || busy} title={source.reason}
          onClick={() => void refresh(source.id)}><I18nText id="common.refresh" />{" "}{source.label}</Button></div>
      </article>;
    })}
  </section>;
}
