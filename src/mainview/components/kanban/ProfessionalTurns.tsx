import { codeLabel, staticLabel } from "@/i18n/presentation";
import { antigravityAutoAcceptsFileEdits } from "@/lib/employee-execution";

import { intlLocale, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import type { OwnerRoutingConstraints } from "../../../shared/model-router/types.ts";
import { formatMoney } from "@/i18n/estimation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { watchProfessionalTurns } from "@/lib/professional-turn-watch";
import { Button } from "@/components/ui/button";
import type { ProfessionalTurn, TurnContext, TurnHistory } from "../../../shared/execution/turn.ts";

/** Run-local evidence. The historical professional Markdown is rendered by ProfessionalAttribution. */
export function ProfessionalTurns({ runId, harnessId = null, modeLabel }: { runId: string; harnessId?: string | null; modeLabel?: string }) {
  useUILocale();
  const [history, setHistory] = useState<TurnHistory | null>(null);
  const [prompt, setPrompt] = useState("");
  const [review, setReview] = useState<ProfessionalTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const watcher = useRef<ReturnType<typeof watchProfessionalTurns> | null>(null);
  useEffect(() => {
    setHistory(null); setReview(null); setPrompt(""); setBusy(false); setError(null); setAck(false);
    const current = watchProfessionalTurns(runId, signal => api.professionalTurns(runId, signal),
      h => { setHistory(h); setError(null); }, fail);
    watcher.current = current;
    return () => { current.stop(); watcher.current = null; };
  }, [runId]);
  const refresh = () => watcher.current?.refresh();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : tr("common.the_request_could_not_be_completed"));
  const openReview = async () => {
    const current = watcher.current;
    if (!current) return;
    setBusy(true); setError(null); setAck(false);
    try {
      const r = await api.professionalTurnReview(runId, { prompt, idempotencyKey: crypto.randomUUID() });
      if (current.signal.aborted) return;
      setReview(r.turn); await current.refresh();
    } catch (e) { if (!current.signal.aborted) fail(e); } finally { if (!current.signal.aborted) setBusy(false); }
  };
  const confirm = async () => {
    const current = watcher.current;
    if (!review || !current) return;
    setBusy(true); setError(null);
    try {
      await api.professionalTurnSubmit(review.id, { confirm: true, acknowledgeUsage: true, revision: review.revision, idempotencyKey: review.idempotency_key });
      if (current.signal.aborted) return;
      setReview(null); setPrompt(""); setAck(false); await current.refresh();
    } catch (e) { if (!current.signal.aborted) fail(e); } finally { if (!current.signal.aborted) setBusy(false); }
  };
  const cancel = async () => {
    const current = watcher.current;
    if (!review || !current) return;
    setBusy(true); setError(null);
    try {
      await api.professionalTurnCancel(review.id, review.revision);
      if (current.signal.aborted) return;
      setReview(null); await current.refresh();
    } catch (e) { if (!current.signal.aborted) fail(e); } finally { if (!current.signal.aborted) setBusy(false); }
  };
  const pending = history?.turns.find(t => t.turn_number > 1 && t.status === "reviewed");
  const blocked = history?.turns.some(t => ["approved", "claimed", "prepared", "indeterminate"].includes(t.status));
  const facts = review ? JSON.parse(review.facts_json) as TurnContext : null;
  const restrictions = facts?.restrictions as OwnerRoutingConstraints | undefined;
  return <details className="mt-2 min-w-0 rounded-md border border-border/70 px-2 py-1.5" data-testid="professional-turns"
    onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open) void refresh(); }}>
    <summary className="cursor-pointer"><I18nText id="turns.professional_turns" />{" "}{codeLabel(history?.session.state)}</summary>
    <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => void refresh()}><I18nText id="turns.refresh_turn_history" /></Button>
    {history?.session.reason && <p className="mt-2 break-words text-muted-foreground" data-testid="professional-turn-unsupported">{tr("turns.unsupported")}<small className="block break-words text-muted-foreground">{history.session.reason}</small></p>}
    <p className="mt-2 text-muted-foreground"><I18nText id="turns.included_confirms_adapter_submission_only_unknown_delivery_is" /></p>
    <ol className="mt-2 flex min-w-0 flex-col gap-2">
      {history?.turns.map(t => <li key={t.id} className="min-w-0 rounded border border-border/60 p-2" data-testid="professional-turn" data-status={t.status}>
        <details><summary className="break-words"><I18nText id="turns.turn" />{" "}{t.turn_number} · {t.status === "indeterminate" ? tr("common.unknown_indeterminate") : codeLabel(t.status)}</summary>
          <dl className="mt-1 grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt><I18nText id="turns.employee_attempt" /></dt><dd className="break-all">{t.employee_id} / {t.attempt_id}</dd>
            <dt><I18nText id="turns.revision_sha" /></dt><dd className="break-all">{t.snapshot_revision_id} / {t.snapshot_sha256}</dd>
            <dt><I18nText id="turns.session" /></dt><dd className="break-all">{t.session_id ?? tr("common.unknown")}</dd>
            <dt><I18nText id="common.payload_sha_256" /></dt><dd className="break-all">{t.prompt_sha256}</dd>
            <dt><I18nText id="turns.owner_authorization" /></dt><dd className="break-all">{t.authorization_ref ?? tr("common.awaiting_approval")}</dd>
            <dt><I18nText id="turns.observed_run_outcome" /></dt><dd>{codeLabel(t.observed_run_status)}{t.observed_run_ended_at ? ` · ${new Date(t.observed_run_ended_at).toLocaleString(intlLocale())}` : ""}</dd>
            <dt><I18nText id="turns.submitted" /></dt><dd>{t.submitted_at ? new Date(t.submitted_at).toLocaleString(intlLocale()) : tr("common.not_submitted")}</dd>
          </dl>
          {t.prompt && <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{t.prompt}</pre>}
          {t.reason && <p className="mt-2 text-warning">{t.reason}</p>}
        </details>
      </li>)}
    </ol>
    {!review && pending && <Button className="mt-2" size="sm" variant="outline" onClick={() => { setReview(pending); setAck(false); }}><I18nText id="turns.open_pending_owner_review" /></Button>}
    {!review && !pending && !blocked && history && history.session.state !== "unsupported" && <div className="mt-2 flex min-w-0 flex-col gap-2">
      <label><I18nText id="turns.new_message" /><textarea aria-label={tr("turns.professional_follow_up_message")} className="mt-1 min-h-20 w-full rounded border border-border bg-transparent p-2" value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      <Button size="sm" variant="outline" disabled={busy || !prompt.trim()} onClick={() => void openReview()} data-testid="professional-follow-up"><I18nText id="turns.review_follow_up" /></Button>
    </div>}
    {review && facts && <section role="dialog" aria-label={tr("turns.owner_follow_up_review")} className="mt-2 min-w-0 rounded-lg border border-border bg-background/80 p-3 backdrop-blur-xl" data-testid="professional-turn-review">
      <p className="font-medium"><I18nText id="turns.owner_review" />{" "}{facts.employeeName}{" "}<I18nText id="turns.professional_revision" />{" "}{facts.professionalRevision}</p>
      <p className="break-all"><I18nText id="common.project" />{" "}{facts.projectPath}</p><p className="break-all"><I18nText id="turns.run" />{" "}{facts.runId}{" "}<I18nText id="turns.session_56c2c8" />{" "}{facts.sessionId}</p>
      <p className="break-all"><I18nText id="turns.snapshot_sha_256" />{" "}{facts.snapshotSha256}</p>
      <p><I18nText id="turns.execution_mode" />{" "}{modeLabel ? staticLabel(modeLabel) : codeLabel(facts.mode)}
        {harnessId && antigravityAutoAcceptsFileEdits(harnessId, facts.mode) && (
          <span className="mt-1 block text-muted-foreground">{tr("models.auto_accept_file_edits_ask_before_executing_commands")}</span>
        )}
        <I18nText id="turns.this_approval_grants_no_additional_cli_permissions" /></p>
      {restrictions && <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground"><I18nText id="common.allowed_harnesses" /></dt><dd className="break-words">{restrictions.allowedHarnesses?.join(", ") ?? tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.allowed_accounts" /></dt><dd className="break-words">{restrictions.allowedAccounts?.join(", ") ?? tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="turns.spending_policy" /></dt><dd>{restrictions.spending?.replaceAll("-", " ") ?? tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="turns.maximum_cost" /></dt><dd>{restrictions.maxExpectedCost ? formatMoney(restrictions.maxExpectedCost) : tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="turns.concurrency_limit" /></dt><dd>{restrictions.globalConcurrency ?? tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.required_approvals" /></dt><dd className="break-words">{restrictions.requiredApprovals.map(staticLabel).join("; ") || tr("common.unknown")}</dd>
      </dl>}
      <pre className="mt-2 whitespace-pre-wrap break-words font-sans" data-testid="professional-turn-reviewed-message">{review.prompt}</pre>
      <p className="mt-2"><I18nText id="turns.review_expires" />{" "}{new Date(review.expires_at).toLocaleString(intlLocale())}.</p>
      <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><I18nText id="turns.i_approve_this_message_and_acknowledge_possible_usage" /></label>
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" disabled={busy || !ack || Date.now() >= review.expires_at} onClick={() => void confirm()} data-testid="professional-turn-confirm"><I18nText id="turns.confirm_follow_up" /></Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}><I18nText id="turns.withdraw_review" /></Button></div>
    </section>}
    {error && <p role="alert" className="mt-2 break-words text-danger" data-testid="professional-turn-error">{error}</p>}
  </details>;
}
