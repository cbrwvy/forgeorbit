import { codeLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import type { CandidateAssessment, RoutingPreview } from "../../../shared/model-router/types.ts";
import {
  abstentionReasons,
  accountLabel,
  effortPresentation,
  formatEvidenceTime,
  groupedCandidates,
  concurrencyNotes,
  hasExpiredQuota,
  presentQuota,
  type CandidateGroups,
} from "@/lib/model-router-preview";
import { formatMoney } from "@/i18n/estimation";
import { useEvidenceClock } from "./useEvidenceClock";

function Lines({ items, empty, testId }: { items: string[]; empty: string; testId: string }) {
  useUILocale();
  if (items.length === 0) return <p className="text-[11px] text-muted-foreground" data-testid={testId}>{empty}</p>;
  return (
    <ul className="space-y-0.5 text-[11px]" data-testid={testId}>
      {items.map((item) => <li key={item} className="break-words">{item}</li>)}
    </ul>
  );
}

export function CandidateCard({
  card,
  now,
  accounts,
  recommended = false,
}: {
  card: CandidateAssessment;
  now: number;
  accounts: readonly { id: string; displayName: string }[];
  recommended?: boolean;
}) {
  useUILocale();
  const effort = effortPresentation(card.thinkingEffort);
  const quotas = card.quotaEvidence.map((state) => ({ ...presentQuota(state, now), state }));
  const { candidate } = card;
  return (
    <details className="min-w-0 rounded-md border border-border/70 px-2 py-1.5" data-testid="router-candidate" data-status={card.status} data-recommended={recommended ? "true" : "false"}>
      <summary className="cursor-pointer break-all text-xs">
        <span className="font-medium">{candidate.harnessId}</span>
        <span className="text-muted-foreground"> · {candidate.modelId ?? tr("common.model_unknown_05e536")} · {codeLabel(card.status)}</span>
      </summary>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground"><I18nText id="common.harness" /></dt>
        <dd className="min-w-0 break-all">{candidate.harnessId}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.account" /></dt>
        <dd className="min-w-0 break-all" data-testid="router-candidate-account">{accountLabel(candidate.accountId, accounts)}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.model" /></dt>
        <dd className="min-w-0 break-all">{candidate.modelId ?? tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="resources.thinking_effort" /></dt>
        <dd data-testid="router-effort">
          <span className="font-medium">{effort.label}</span>
          {effort.detail ? <span className="mt-0.5 block text-muted-foreground">{effort.detail}</span> : null}
        </dd>
        <dt className="text-muted-foreground"><I18nText id="resources.eligibility" /></dt>
        <dd>{codeLabel(card.status)}{" "}<I18nText id="resources.at_snapshot" />{hasExpiredQuota(card, now) ? tr("common.quota_evidence_expired_recalculate") : ""}</dd>
        <dt className="text-muted-foreground"><I18nText id="resources.verification_status" /></dt>
        <dd><I18nText id="resources.backend_assessment" />{" "}{codeLabel(card.status)}<I18nText id="resources.registration_and_subscription_declarations_do_not_verify_cli" /></dd>
        <dt className="text-muted-foreground"><I18nText id="resources.cost_evidence" /></dt>
        <dd className="break-words">{card.expectedCost ? `${formatMoney(card.expectedCost.money)} · ${card.expectedCost.basis} · ${card.expectedCost.source}` : tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="resources.duration_evidence" /></dt>
        <dd className="break-words">{card.ranking.duration ? tr("common.ms", { p0: String(card.ranking.duration.ms), p1: String(card.ranking.duration.basis) }) : tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="resources.quality_evidence" /></dt>
        <dd className="break-words">{card.ranking.quality ? `${card.ranking.quality.benchmark}: ${card.ranking.quality.score}` : tr("common.unknown")}</dd>
        <dt className="text-muted-foreground"><I18nText id="resources.quota_evidence" /></dt>
        <dd data-testid="router-quota">
          {quotas.length === 0 ? <span><I18nText id="common.unknown" /></span> : (
            <ul className="space-y-1">
              {quotas.map((quota) => (
                <li key={quota.quotaId} className="break-words" data-quota-label={quota.label}>
                  <span className="font-medium">{quota.label}</span>
                  <span className="block text-muted-foreground">
                    {quota.quotaId}{" "}<I18nText id="resources.verification" />{" "}{codeLabel(quota.verification)}{" "}<I18nText id="resources.observed" />{" "}{formatEvidenceTime(quota.observedAt)}{" "}<I18nText id="resources.expires" />{" "}{formatEvidenceTime(quota.expiresAt)} · {codeLabel(quota.provenance)}
                    {tr("common.reset_32aa7d", { p0: String(formatEvidenceTime(quota.resetAt)) })}
                    {quota.conflict ? tr("common.conflict_79449b") : ""}
                  </span>
                  <span className="block text-muted-foreground"><I18nText id="common.scope" />{" "}{quota.state.definition.scope}{" "}<I18nText id="resources.window" />{" "}{quota.state.definition.window}{" "}<I18nText id="resources.unit" />{" "}{JSON.stringify(quota.state.definition.unit)}
                  </span>
                  <ul className="mt-1 space-y-1" aria-label={tr("resources.quota_observations")}>
                    {quota.state.observations.map(observation => (
                      <li key={observation.id} className="break-all text-muted-foreground"><I18nText id="resources.evidence" />{" "}{observation.id}: {codeLabel(observation.verification)}{" "}<I18nText id="resources.source" />{" "}{observation.source}{" "}<I18nText id="resources.provenance" />{" "}{codeLabel(observation.provenance)}{" "}<I18nText id="resources.observed" />{" "}{formatEvidenceTime(observation.observedAt)}{" "}<I18nText id="resources.expires" />{" "}{formatEvidenceTime(observation.expiresAt)}{" "}<I18nText id="resources.reset" />{" "}{formatEvidenceTime(observation.resetAt)}
                        {observation.acquisition?.sharedPool ? tr("common.shared_pool", { p0: String(observation.acquisition.sharedPool.id), p1: String(observation.acquisition.sharedPool.verified ? "verified" : "unverified") }) : tr("common.shared_pool_unknown")}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-muted-foreground"><I18nText id="resources.known_concurrency" /></dt>
        <dd><Lines items={concurrencyNotes([...card.reasons, ...card.unknowns, ...card.conflicts])} empty="Unknown — numeric occupancy and capacity are not included in this response." testId="router-concurrency" /></dd>
        <dt className="text-muted-foreground"><I18nText id="resources.quota_reserve_fraction" /></dt>
        <dd>{card.ranking.reserve == null ? tr("common.unknown") : tr("common.at_snapshot_this_is_not_concurrency_or_a", { p0: String(card.ranking.reserve) })}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.required_approvals" /></dt>
        <dd><Lines items={card.requiredOwnerApproval} empty="None returned" testId="router-candidate-approvals" /></dd>
        <dt className="text-muted-foreground"><I18nText id="resources.reasons" /></dt>
        <dd><Lines items={card.reasons} empty="None returned" testId="router-candidate-reasons" /></dd>
        <dt className="text-muted-foreground"><I18nText id="resources.unknown_information" /></dt>
        <dd><Lines items={card.unknowns} empty="None returned" testId="router-candidate-unknowns" /></dd>
        <dt className="text-muted-foreground"><I18nText id="common.conflicts" /></dt>
        <dd><Lines items={card.conflicts} empty="None returned" testId="router-candidate-conflicts" /></dd>
        <dt className="text-muted-foreground"><I18nText id="common.provenance" /></dt>
        <dd><Lines items={card.provenance} empty="None returned" testId="router-candidate-provenance" /></dd>
      </dl>
    </details>
  );
}

function Group({
  title,
  testId,
  cards,
  now,
  accounts,
  recommendedId,
  empty,
}: {
  title: string;
  testId: string;
  cards: CandidateAssessment[];
  now: number;
  accounts: readonly { id: string; displayName: string }[];
  recommendedId?: string;
  empty: string;
}) {
  useUILocale();
  return (
    <section className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</h3>
      {cards.length === 0 ? <p className="text-[11px] text-muted-foreground">{empty}</p> : (
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {cards.map((card) => (
            <CandidateCard key={card.candidate.id} card={card} now={now} accounts={accounts} recommended={card.candidate.id === recommendedId} />
          ))}
        </div>
      )}
    </section>
  );
}

export function CandidateGroupsView({
  preview,
  accounts,
}: {
  preview: RoutingPreview;
  accounts: readonly { id: string; displayName: string }[];
}) {
  useUILocale();
  const now = useEvidenceClock(preview);
  const groups: CandidateGroups = groupedCandidates(preview);
  const reasons = abstentionReasons(preview);
  const expiredRecommendation = groups.recommended && hasExpiredQuota(groups.recommended, now);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {groups.recommended ? (
        <Group title={expiredRecommendation ? tr("common.snapshot_recommendation_quota_evidence_expired_recalculate") : tr("common.verified_recommendation_at_snapshot")} testId={expiredRecommendation ? "router-expired-recommendation" : "router-verified"} cards={[groups.recommended]} now={now} accounts={accounts} recommendedId={expiredRecommendation ? undefined : groups.recommended.candidate.id} empty="" />
      ) : (
        <section data-testid="router-no-verified" className="rounded-md border border-border/70 px-2 py-2">
          <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="resources.no_verified_candidate" /></h3>
          <p className="mt-1 text-[11px]"><I18nText id="resources.the_preview_did_not_select_a_verified_resource" /></p>
          <Lines items={reasons} empty={tr("common.the_preview_did_not_list_a_reason")} testId="router-unknown-reasons" />
        </section>
      )}
      {groups.alternatives.length > 0 && (
        <Group
          title={groups.recommended ? tr("common.other_verified_candidates") : tr("common.verified_alternatives_not_a_recommendation")}
          testId="router-verified-alternatives"
          cards={groups.alternatives}
          now={now}
          accounts={accounts}
          empty=""
        />
      )}
      <Group title={tr("resources.conditional_alternatives")} testId="router-conditional" cards={groups.conditional} now={now} accounts={accounts} empty="No conditional candidates." />
      <Group title={tr("resources.excluded_resources")} testId="router-excluded" cards={groups.excluded} now={now} accounts={accounts} empty="No excluded candidates." />
    </div>
  );
}
