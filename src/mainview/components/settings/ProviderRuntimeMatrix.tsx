import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { RuntimeSafetyNotice } from "@/components/ui/runtime-safety-notice";
import { LaunchTarget } from "@/components/ui/launch-target";
import { TechnicalDetails } from "@/components/ui/technical-details";
import type { RuntimeReadiness } from "../../../shared/provider-runtime/readiness.ts";

function label(prefix: string, value: string): string {
  const key = `${prefix}.${value}` as TranslationKey;
  return tr(key);
}

export function ProviderRuntimeMatrix({ reports }: { reports: readonly RuntimeReadiness[] }) {
  useUILocale();
  if (reports.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="provider-runtime-matrix">
      <div>
        <h3 className="text-sm font-medium">{tr("runtime.title")}</h3>
        <p className="text-xs text-muted-foreground">{tr("runtime.intro")}</p>
        <RuntimeSafetyNotice liveTestId="provider-runtime-live-unavailable" channelTestId="provider-runtime-owner-channel" />
      </div>
      {reports.map((report) => (
        <article key={report.providerId} data-testid={`provider-runtime-${report.providerId}`} className="space-y-1 rounded-md border border-border/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{report.label}</span>
            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">{tr("runtime.execution.not-authorized")}</span>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">{tr("runtime.installed")}</dt>
            <dd>{label("runtime.installed", report.installed)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.authentication")}</dt>
            <dd>{label("runtime.auth", report.authentication)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.binding")}</dt>
            <dd>{label("runtime.binding", report.accountBinding)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.identity")}</dt>
            <dd>{tr("runtime.identity.unknown")}</dd>
            <dt className="text-muted-foreground">{tr("runtime.models")}</dt>
            <dd>{label("runtime.models", report.models)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.developer")}</dt>
            <dd>{label("runtime.eligibility", report.developer)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.reviewer")}</dt>
            <dd>{label("runtime.eligibility", report.reviewer)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.sandbox")}</dt>
            <dd>{label("runtime.sandbox", report.sandbox)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.quota")}</dt>
            <dd>{label("runtime.quota", report.quotaSource)}</dd>
            <dt className="text-muted-foreground">{tr("runtime.execution")}</dt>
            <dd>{tr("runtime.execution.not-authorized")}</dd>
            <dt className="text-muted-foreground">{tr("runtime.genuine")}</dt>
            <dd>{tr("runtime.genuine.not-verified")}</dd>
          </dl>
          {report.launchTarget && <LaunchTarget facts={report.launchTarget} testId={`provider-launch-target-${report.providerId}`} />}
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {report.blockerCodes.map((code) => <li key={code}>{tr(`runtime.blocker.${code}` as TranslationKey)}</li>)}
          </ul>
          <TechnicalDetails
            summary={tr("runtimeTech.summary")}
            testId={`provider-runtime-tech-${report.providerId}`}
            rows={[
              { label: tr("runtime.version"), value: report.cliVersion ?? tr("runtime.installed.unknown") },
              { label: tr("runtime.adapter"), value: report.adapterVersion },
              { label: tr("ownerTrust.provider"), value: report.providerId },
            ]}
          />
          {report.providerId === "cursor" && <p className="text-xs">{tr("runtime.escalation")}</p>}
        </article>
      ))}
    </section>
  );
}
