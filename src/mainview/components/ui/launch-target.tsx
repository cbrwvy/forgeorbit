import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";
import type { LaunchTargetFacts } from "../../../shared/provider-launch-target.ts";

/**
 * Direction 9: the executable, its version and the mode a launch would use, with the state in words and the
 * one next step. Facts come from the core, which resolves them with the same function the launch uses; this
 * component only words them. It never says "ready", and a compatible result says what it does not prove.
 */
export function LaunchTarget({ facts, className, testId = "launch-target" }: { facts: LaunchTargetFacts; className?: string; testId?: string }) {
  useUILocale();
  const tone = facts.verdict === "blocked" ? "border-danger/40 bg-danger/10" : facts.verdict === "unverified" ? "border-warning/40 bg-warning/10" : "border-border/60 bg-muted/20";
  const label = (key: string) => tr(key as TranslationKey);
  const versionText = facts.version.state === "read" ? (facts.version.parsed ?? facts.version.raw ?? "") : label(`d9.target.version.${facts.version.state}`);
  return (
    <section className={cn("space-y-1 rounded-md border px-2 py-1.5 text-xs", tone, className)} data-testid={testId} data-code={facts.code} data-verdict={facts.verdict} aria-label={tr("d9.target.title")}>
      <p className="font-medium" data-testid={`${testId}-state`}>{label(`d9.target.state.${facts.code}`)}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">{tr("d9.target.executable")}</dt>
        <dd className="break-all" data-testid={`${testId}-path`}>
          {facts.executable.path ?? tr("d9.target.executable.none")}
          <span className="text-muted-foreground"> · {label(`d9.target.source.${facts.executable.source}`)}</span>
        </dd>
        <dt className="text-muted-foreground">{tr("d9.target.version")}</dt>
        <dd data-testid={`${testId}-version`} data-state={facts.version.state}>{versionText}</dd>
        {facts.floor ? (
          <>
            <dt className="text-muted-foreground">{tr("d9.target.minimum", { model: facts.floor.model })}</dt>
            <dd data-testid={`${testId}-minimum`}>{tr("d9.target.minimum.value", { min: facts.floor.min })}</dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">{tr("d9.target.minimum.generic")}</dt>
            <dd data-testid={`${testId}-minimum`}>{tr("d9.target.minimum.none")}</dd>
          </>
        )}
        {facts.mode.id !== null && facts.mode.supported !== null && (
          <>
            <dt className="text-muted-foreground">{tr("d9.target.mode")}</dt>
            <dd data-testid={`${testId}-mode`}>{tr(facts.mode.supported ? "d9.target.mode.supported" : "d9.target.mode.unsupported", { mode: facts.mode.id })}</dd>
          </>
        )}
      </dl>
      <p className="text-muted-foreground" data-testid={`${testId}-next`}>{label(`d9.target.next.${facts.code}`)}</p>
    </section>
  );
}
