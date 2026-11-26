import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { when } from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Facts } from "./AccountEvidence";
import type { EvidenceFreshness, ProviderEvidenceView } from "../../../shared/accounts/provider-evidence.ts";

const freshnessLabel = (f: EvidenceFreshness) => f === "fresh" ? tr("accounts.pe_fresh") : f === "stale" ? tr("accounts.pe_stale") : tr("common.unknown");
/** FO-ORCH03: diagnostic provider readings. Manual Refresh only; nothing here selects an executor. */
export function ProviderEvidence({ accountId, onUpdated }: { accountId: string; onUpdated?: () => Promise<void> }) {
  useUILocale();
  const [view, setView] = useState<ProviderEvidenceView | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const seq = ++generation.current;
    setView(null); setError(null); setNotice(null); setConsent(false);
    void api.accountCore.providerEvidence(accountId).then(value => { if (seq === generation.current) setView(value); })
      .catch(() => { if (seq === generation.current) setError(tr("accounts.pe_load_failed")); });
    return () => { generation.current++; active.current?.abort(); };
  }, [accountId]);
  async function refresh() {
    if (!consent || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const seq = ++generation.current; setBusy(true); setError(null); setNotice(null); setConsent(false);
    try {
      const value = await api.accountCore.refreshProviderEvidence(accountId, controller.signal);
      if (seq === generation.current) { setView(value); setNotice(tr("accounts.pe_refreshed")); }
      await onUpdated?.();
    } catch (err) {
      if (seq === generation.current) {
        const status = (err as { status?: number }).status;
        setError(status === 504 ? tr("accounts.pe_timeout") : status === 400 || status === 409 ? tr("accounts.pe_rejected") : tr("accounts.pe_failed"));
      }
    } finally { if (seq === generation.current) setBusy(false); if (active.current === controller) active.current = null; }
  }
  const session = view?.session ?? null;
  return <section className="space-y-2 border-t pt-3" aria-label={tr("accounts.pe_title")} data-testid="provider-evidence">
    <h6 className="text-sm font-medium"><I18nText id="accounts.pe_title" /></h6>
    <p className="text-xs text-muted-foreground"><I18nText id="accounts.pe_intro" /></p>
    <p className="text-xs" data-testid="provider-evidence-note"><I18nText id="accounts.pe_diagnostic_note" /></p>
    {error && <p role="alert" className="text-xs">{error}</p>}
    {notice && <p role="status" className="text-xs">{notice}</p>}
    {!view && !error && <p role="status" className="text-xs"><I18nText id="accounts.pe_loading" /></p>}
    {session && <Facts values={[[tr("accounts.pe_session"), tr("accounts.pe_session_value", { p0: session.authMode, p1: session.planType ?? tr("common.unknown"),
      p2: session.catalog?.count ?? tr("common.unknown"), p3: session.cliVersion ?? tr("common.unknown") })],
      [tr("common.last_observation"), `${when(session.collectedAt)} · ${freshnessLabel(session.freshness)}`], ...session.unknownReasons.map((r, i): [string, string] => [`${tr("common.unknown")} ${i + 1}`, r])]} />}
    {view && !view.items.length && <p className="text-xs"><I18nText id="accounts.pe_none" /></p>}
    {view?.items.map(item => <article key={`${item.quotaId}`} className="space-y-1 rounded-lg border p-2" data-testid="provider-evidence-item"
      data-bucket={item.evidence.bucketId} data-slot={item.evidence.slot} data-freshness={item.freshness}>
      <Facts values={[
        [tr("accounts.pe_bucket"), item.evidence.bucketName ? `${item.evidence.bucketId} (${item.evidence.bucketName})` : item.evidence.bucketId],
        [tr("accounts.pe_window"), `${item.evidence.slot} · ${item.evidence.windowMins ?? tr("common.unknown")} min`],
        [tr("accounts.pe_model_scope"), item.evidence.modelScope.kind === "confirmed" ? item.evidence.modelScope.slug : tr("accounts.pe_model_unconfirmed")],
        [tr("accounts.pe_used"), item.evidence.rawValue === null ? tr("common.unknown") : `${item.evidence.rawValue}%`],
        [tr("common.reset"), when(item.resetAt)],
        [tr("common.source"), `${item.evidence.source}${item.evidence.exhausted === "reported" ? ` · ${item.evidence.reachedType}` : ""}`],
        [tr("common.last_observation"), when(item.observedAt)],
        [tr("accounts.pe_freshness"), freshnessLabel(item.freshness)],
        [tr("accounts.pe_quality"), item.evidence.quality],
        [tr("accounts.pe_account_scope"), tr("accounts.pe_account_scope_value")],
      ]} />
      <details className="text-xs"><summary><I18nText id="accounts.pe_why_manual" /></summary>
        <ul className="list-disc pl-4">{item.autoSelectionBlockers.map(r => <li key={r}>{r}</li>)}</ul></details>
    </article>)}
    {view && <details className="text-xs"><summary><I18nText id="accounts.pe_other_providers" /></summary>
      <ul className="list-disc pl-4">{view.limitations.map(r => <li key={r}>{r}</li>)}</ul></details>}
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} disabled={busy}
      onChange={event => setConsent(event.target.checked)} /><I18nText id="accounts.pe_consent" /></label>
    <Button size="sm" variant="outline" disabled={!consent || busy} onClick={() => void refresh()}>
      <I18nText id={busy ? "accounts.pe_refreshing" : "accounts.pe_refresh"} /></Button>
  </section>;
}
