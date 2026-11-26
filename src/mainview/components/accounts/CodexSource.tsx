import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { when } from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Facts } from "./AccountEvidence";
import type { CodexSourceState } from "../../../shared/accounts/codex-source.ts";

export function CodexSource() {
  useUILocale();
  const [state, setState] = useState<CodexSourceState | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const seq = ++generation.current;
    void api.accountCore.codexSource().then(value => { if (seq === generation.current) setState(value); })
      .catch(() => { if (seq === generation.current) setError(tr("common.unable_to_read_connector_status")); });
    return () => { generation.current++; active.current?.abort(); };
  }, []);
  useEffect(() => {
    if (state?.expiresAt == null) return;
    const update = () => setNow(Date.now());
    const timer = setTimeout(update, Math.max(0, state.expiresAt - Date.now()));
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [state]);
  async function inspect() {
    if (!consent || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const seq = ++generation.current; setBusy(true); setError(null); setConsent(false); setState(null);
    try {
      const value = await api.accountCore.inspectCodex(controller.signal);
      if (seq === generation.current) { setState(value); setNow(Date.now()); }
    } catch (err) {
      if (seq === generation.current) setError((err as { status?: number }).status === 504
        ? tr("common.codex_inspection_timed_out_no_evidence_retained") : tr("common.codex_inspection_failed_or_was_cancelled_no_evidence"));
    } finally { if (seq === generation.current) setBusy(false); if (active.current === controller) active.current = null; }
  }
  async function disconnect() {
    const seq = ++generation.current; active.current?.abort(); setBusy(true); setState(null); setError(null);
    try { const value = await api.accountCore.disconnectCodex(); if (seq === generation.current) setState(value); }
    catch { if (seq === generation.current) setError(tr("common.unable_to_disconnect_reload_connector_status_before_another")); }
    finally { if (seq === generation.current) { setBusy(false); setConsent(false); } }
  }
  const stale = state?.expiresAt != null && now >= state.expiresAt;
  return <section className="space-y-2 border-t pt-3" aria-label={tr("accounts.codex_source")} data-testid="codex-connector">
    <h6 className="text-sm font-medium"><I18nText id="accounts.codex_source" /></h6>
    <p className="text-xs text-muted-foreground"><I18nText id="accounts.checking_starts_a_local_codex_app_server_using" /></p>
    {error && <p role="alert" className="text-xs">{error}</p>}
    <Facts values={[
      [tr("common.connector_status"), busy ? tr("common.inspecting_disconnecting") : stale ? "stale" : state?.status ?? tr("common.unknown")],
      [tr("common.authentication_evidence"), busy || stale ? tr("common.unknown") : state?.authentication ?? tr("common.unknown")],
      [tr("common.linked_account"), tr("common.unassigned_unverified")], [tr("common.actual_execution_account"), tr("common.unknown")],
      [tr("common.last_observation"), when(state?.observedAt)], [tr("common.expiry"), when(state?.expiresAt)],
      [tr("common.reset"), tr("common.unknown")], [tr("common.quota_status"), tr("common.unknown")], [tr("common.shared_pool_142fb9"), tr("common.unknown")],
      [tr("common.binding_limitation"), tr("common.no_documented_stable_provider_subject_email_plan_and")],
      [tr("common.availability"), state?.reason ?? tr("common.no_authentication_evidence_loaded")],
    ]} />
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} disabled={busy}
      onChange={event => setConsent(event.target.checked)} /><I18nText id="accounts.i_consent_to_start_a_local_codex_app" /></label>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!consent || busy} onClick={() => void inspect()}><I18nText id="accounts.verify_authentication" /></Button>
      <Button size="sm" variant="outline" disabled={!state && !busy} onClick={() => void disconnect()}><I18nText id="accounts.disconnect_cancel_check" /></Button>
      <Button size="sm" variant="outline" disabled title={tr("accounts.a_stable_documented_subject_is_required")}><I18nText id="accounts.confirm_link_unavailable" /></Button>
    </div>
  </section>;
}
