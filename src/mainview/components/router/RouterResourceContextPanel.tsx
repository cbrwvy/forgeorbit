import { codeLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import type { ModelRouterResourceContext } from "../../../shared/model-router/resource-context.ts";

export function RouterResourceContextPanel({ context, loading, error }: {
  context: ModelRouterResourceContext | null;
  loading: boolean;
  error: string | null;
}) {
  useUILocale();
  if (loading) return <p className="text-[11px] text-muted-foreground" data-testid="router-context-loading"><I18nText id="routing.loading" /></p>;
  if (error) return <p role="alert" className="text-[11px]" data-testid="router-context-error">{error}</p>;
  if (!context) return null;
  return (
    <section className="rounded-md border border-border/70 px-2 py-2 text-[11px]" data-testid="router-resource-context">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.resource_context" /></h3>
      <p className="mt-1" data-testid="router-automatic-policy">
        <span className="font-medium"><I18nText id="resources.automatic_routing" />{" "}</span>
        <I18nText id="resources.unavailable" />{" "}
        <span className="text-muted-foreground">{context.automaticRouting.reason}</span>
      </p>
      <p className="mt-1 text-muted-foreground" data-testid="router-manual-policy">
        <I18nText id="routing.no_verified" />
      </p>
      <div className="mt-2" data-testid="router-harness-status">
        <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="common.harnesses" /></h4>
        <ul className="mt-1 space-y-1">
          {context.harnesses.map((harness) => (
            <li key={harness.id} data-testid={`router-harness-row-${harness.id}`} data-enabled={harness.enabled ? "true" : "false"}>
              <span className="font-medium">{harness.label}</span>
              <span className="text-muted-foreground"> · {harness.id}</span>
              <span className="block text-muted-foreground">
                {harness.enabled ? tr("common.enabled") : tr("common.disabled_75081b")}
                {" · "}
                <I18nText id="resources.automatic" />{" "}
                {codeLabel(harness.automaticSelection)}
                {" · "}
                <I18nText id="resources.manual" />{" "}
                {codeLabel(harness.manualSelection)}
              </span>
              <span className="block break-words text-muted-foreground">{harness.manualReason}</span>
            </li>
          ))}
        </ul>
      </div>
      {context.accounts.length > 0 && (
        <div className="mt-2" data-testid="router-trusted-quota">
          <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="accounts.quota_sources" /></h4>
          <ul className="mt-1 space-y-2">
            {context.accounts.map((account) => (
              <li key={account.id} data-testid={`router-account-context-${account.id}`}>
                <span className="font-medium">{account.displayName}</span>
                <span className="text-muted-foreground"> · {account.provider}</span>
                {account.trustedSources.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5">
                    {account.trustedSources.map((source) => (
                      <li key={source.sourceId} className="break-words text-muted-foreground" data-testid={`router-trusted-source-${source.sourceId}`}>
                        {source.label}: {source.refreshAvailable ? tr("resources.refresh_ready") : tr("resources.refresh_unavailable")}
                        {" — "}
                        {source.reason}
                      </li>
                    ))}
                  </ul>
                )}
                {account.quotas.length > 0 ? (
                  <ul className="mt-0.5 space-y-0.5">
                    {account.quotas.map((quota) => (
                      <li key={quota.quotaId} className="break-words" data-testid={`router-quota-row-${quota.quotaId}`} data-quota-status={quota.status}>
                        {quota.quotaId}: {quota.capacityLabel}
                        <span className="block font-medium" data-testid={`router-quota-fact-${quota.quotaId}`} data-fact={quota.evidence}>{tr(`d11.fact.${quota.evidence}` as "d11.fact.unknown")}</span>
                        <span className="block text-muted-foreground">
                          {codeLabel(quota.status)} · {codeLabel(quota.verification)}
                          {" · "}
                          {quota.lastObservedAt == null
                            ? <>{tr("resources.observed")} {tr("common.unknown")}</>
                            : tr("d11.fact.last", { when: new Date(quota.lastObservedAt).toISOString(), source: quota.lastSource ?? tr("common.unknown") })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground"><I18nText id="resources.no_quota_definitions" /></p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted-foreground" data-testid="router-policy-notes">
        {context.policyNotes.map((note) => <li key={note}>{note}</li>)}
      </ul>
      <p className="mt-1 text-muted-foreground">
        <I18nText id="resources.snapshot" />{" "}
        {new Date(context.capturedAt).toISOString()}
      </p>
    </section>
  );
}
