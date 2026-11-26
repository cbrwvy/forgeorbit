import { t, type TranslationKey } from "@/i18n/core";
import type { prepareMissionResourceProposal } from "../../../bun/orchestration/mission-replan.ts";
import { CapacityView, reasonText } from "../usage/UsageForecast";
import { date, duration, money, unknown } from "../usage/presentation";

export function MissionResourceReview({ proposal }: { proposal: ReturnType<typeof prepareMissionResourceProposal> }) {
  const { original, replacement, before, after } = proposal;
  const describe = (resource: typeof original) => [resource.harnessId, resource.modelId, resource.accountId ?? unknown(), resource.mode ?? unknown()].join(" · ");
  const cost = (impact: typeof before) =>
    `${impact.cost.totals.map(row => money(row)).join(" · ") || unknown()} · ${t("usage.unknown")} ${impact.cost.unknown} · ${t("usage.subscription")} ${impact.cost.subscription}`;
  const limits = (value: typeof proposal.oldLimits) => [value.globalMax, value.perProjectMax, value.perAccountMax, value.perClusterMax ?? "—"].join(" / ");
  return <div className="space-y-2 break-words" data-testid="mission-resource-review">
    <p>{t("usage.replanAtomic")}</p>
    <p>{t(proposal.input.role === "developer" ? "usage.developer" : "usage.reviewer")} · {proposal.input.reason}</p>
    {proposal.amendments?.map(change => <div key={`${change.taskId}:${change.stage}`} data-testid="mission-replan-stage">
      <p>{change.taskId} · {t(change.stage === "developer" ? "usage.developer" : "usage.reviewer")}</p>
      <p>{t("usage.replanPrevious")} · {[change.previous.harnessId, change.previous.modelId, change.previous.accountId ?? unknown(), change.previousMode ?? unknown()].join(" · ")}</p>
      <p>{t("usage.replacementResource")} · {change.proposed.provider} · {describe(change.proposed)} · {change.proposed.sandbox === "read-only" ? t("usage.replanReadOnly") : t("usage.replanProjectBound")}</p>
      <p>{t("usage.replanCompatibility")} · {t(change.compatibility === "cross-provider" ? "usage.replanCrossProvider" : "usage.replanSameProvider")}</p>
      <p>{t("usage.remainingEstimate")} · {duration(change.expected.durationBefore)} → {duration(change.expected.durationAfter)}</p>
      <p>{t("usage.amendmentProvenance")} · {change.authorizationScope.policyDigest.slice(0, 12)} · {date(change.authorizationScope.expiresAt)}</p>
    </div>)}
    {proposal.allocation && <p>{t(`usage.allocation.${proposal.allocation.objective}` as TranslationKey)}{proposal.allocation.optimal ? "" : ` · ${t("usage.allocationUnproven")}`}</p>}
    <p>{t("usage.originalResource")} · {describe(original)}</p>
    <p>{t("usage.replacementResource")} · {replacement.provider} · {describe(replacement)} · {replacement.accountLabel ?? unknown()}</p>
    <p>{t("usage.replanEligibility")} · {t(replacement.simulated ? "usage.synthetic" : replacement.authenticated ? "usage.replanAuthenticated" : "usage.replanPreflight")}</p>
    <p>{t("usage.access")} · {t(replacement.sandbox === "read-only" ? "usage.replanReadOnly" : "usage.replanProjectBound")}</p>
    <p>{t("usage.remainingEstimate")} · {duration(before.taskRemaining?.expected)} → {duration(after.taskRemaining?.expected)}</p>
    <p>{t("usage.constrained")} · {duration(before.elapsed?.expected)} → {duration(after.elapsed?.expected)}</p>
    <p>{t("usage.cost")} · {cost(before)} → {cost(after)}</p>
    <p>{t("usage.replanLimits")} · {limits(proposal.oldLimits)} → {limits(proposal.newLimits)}</p>
    <p>{t("usage.replanAuthorization")} · #{proposal.revision} → #{proposal.revision + 1} · {date(proposal.policy.expiresAt)}</p>
    <p className="font-mono text-xs">{proposal.oldPlanDigest} → {proposal.newPlanDigest}</p>
    <p className="font-mono text-xs">{t("usage.replanDigest")} · {proposal.digest}</p>
    {proposal.implementationRunId && <p>{t("usage.replanPreserved")} · {proposal.implementationRunId}</p>}
    {after.blockers.map(key => <p key={key} className="text-warning">{reasonText(key)}</p>)}
    <details>
      <summary>{t("usage.replanBeforeQuota")}</summary>
      <CapacityView data={{ capacity: before.quota }} />
    </details>
    <details>
      <summary>{t("usage.replanAfterQuota")}</summary>
      <CapacityView data={{ capacity: after.quota }} />
    </details>
    <p className="text-muted-foreground">{t(`usage.replanStatus.${proposal.status}` as TranslationKey)}</p>
  </div>;
}
