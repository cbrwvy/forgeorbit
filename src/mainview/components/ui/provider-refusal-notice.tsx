import { getLocale, t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { providerRefusalFreshness, type ProviderRefusalSummary } from "../../../shared/provider-refusal.ts";

/**
 * One provider refusal, told the same way in the Head chat, the account view and the router
 * explanation. It states what the provider said about ONE request and what ForgeOrbit does not
 * know. It never turns the provider's retry words into a time, a balance or a promise.
 */
export function ProviderRefusalNotice({ refusal, accountLabel, modelLabel, testId = "provider-refusal", className, onOpenAccount, now = Date.now(), waiting = false }: {
  refusal: ProviderRefusalSummary;
  /** The account's display name when the caller has it. */
  accountLabel?: string | null;
  modelLabel?: string | null;
  testId?: string;
  className?: string;
  /** Where an existing route supports it: opens the account's own panel. A link; it changes nothing. */
  onOpenAccount?: () => void;
  now?: number;
  waiting?: boolean;
}) {
  useUILocale();
  const when = new Date(refusal.observedAt).toLocaleString(getLocale() === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" });
  const account = accountLabel ?? refusal.accountLabel ?? (refusal.accountId ? refusal.accountId.slice(0, 8) : tr("refusal.account_unknown"));
  const model = modelLabel ?? refusal.modelId ?? tr("refusal.model_any");
  return (
    <div className={className ?? "space-y-1"} data-testid={testId} data-kind={refusal.kind} data-account={refusal.accountId ?? ""} data-superseded={refusal.supersededAt === null ? "false" : "true"}>
      <p className="font-medium" data-testid={`${testId}-title`}>{waiting ? tr("account_limit.wait_unknown", { account }) : tr("refusal.title.usage-limit")}</p>
      {!waiting && <p data-testid={`${testId}-scope`}>{tr("refusal.scope", { when, account, model })}</p>}
      {(refusal.retryHint || !waiting) && <p data-testid={`${testId}-hint`}>
        {refusal.retryHint ? tr(waiting ? "account_limit.hint" : "refusal.hint", { hint: refusal.retryHint }) : tr("refusal.no_hint")}
      </p>}
      {!waiting && <p data-testid={`${testId}-unconfirmed`}>{tr("refusal.unconfirmed")}</p>}
      {refusal.accountId && onOpenAccount && (
        <button type="button" className="text-primary underline underline-offset-2" onClick={onOpenAccount} data-testid={`${testId}-open-account`}>{tr("refusal.open_account")}</button>
      )}
      <TechnicalDetails testId={`${testId}-details`} summary={tr("refusal.details")} rows={[
        { label: tr("refusal.detail.account"), value: refusal.accountId ?? "—" },
        { label: tr("refusal.detail.harness"), value: refusal.harnessId },
        { label: tr("refusal.detail.model"), value: refusal.modelId ?? "—" },
        { label: tr("refusal.detail.observed"), value: when },
        { label: tr("common.freshness"), value: tr(providerRefusalFreshness(refusal, now) === "fresh" ? "account_limit.fresh" : "account_limit.stale") },
        { label: tr("common.source"), value: refusal.surface === "developer-run" ? tr("refusal.source.developer-run") :
          refusal.surface === "reviewer-run" ? tr("refusal.source.reviewer-run") : tr("account_limit.provider_response"), testId: `${testId}-source` },
        { label: tr("refusal.detail.proof"), value: tr(`refusal.detail.proof.${refusal.proof}` as "refusal.detail.proof.usage_limit_exceeded") },
        { label: tr("refusal.detail.diagnostics"), value: refusal.diagnostics, testId: `${testId}-diagnostics` },
      ]} />
    </div>
  );
}
