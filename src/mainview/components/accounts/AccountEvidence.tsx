import { codeLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import {
  accountError,
  observationFreshness,
  quantity,
  unitLabel,
  when,
} from "@/lib/accounts";
import { quotaFact } from "../../../shared/accounts/availability.ts";
import { exhaustedQuotaWindows, verifiedAccountQuotaWindows } from "../../../shared/accounts/resolve.ts";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { QuotaWindowLimit } from "@/components/ui/account-limit-notice";
import type { AccountResource } from "@/lib/account-api";
import { Button } from "@/components/ui/button";
import type { HistoryPage, LegacyMeter, LegacyTokens } from "@/lib/account-api";
import type {
  QuotaDefinition,
  QuotaObservation,
  QuotaState,
} from "../../../shared/accounts/types.ts";

export function AccountLimits({ row, now }: { row: AccountResource; now: number }) {
  const account = row.account;
  const seen = new Set<string>();
  const refusals = (row.providerRefusals ?? []).filter(refusal => {
    const scope = JSON.stringify([refusal.harnessId, refusal.modelId]);
    if (refusal.observedAt > now || seen.has(scope) || !row.bindings.some(binding => binding.harnessId === refusal.harnessId)) return false;
    seen.add(scope);
    return true;
  });
  const windows = exhaustedQuotaWindows(verifiedAccountQuotaWindows(row.quotas, account.id, account.provider, now), now);
  return <>
    {windows.map(window => <QuotaWindowLimit key={window.id} account={account.displayName} windows={[window]} resetAt={window.resetAt} now={now} />)}
    {refusals.map(refusal => <ProviderRefusalNotice key={refusal.id} refusal={refusal} accountLabel={account.displayName}
      now={now} waiting testId="account-provider-limit" className="space-y-1 rounded-md border border-border bg-muted/35 p-2.5 text-xs [overflow-wrap:anywhere]" />)}
  </>;
}

export function Facts({ values }: { values: [string, ReactNode][] }) {
  useUILocale();
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
      {values.map(([label, content]) => (
        <div key={label} className="min-w-0 [overflow-wrap:anywhere]">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{content}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Evidence({
  observation: o,
  now,
}: {
  observation: QuotaObservation;
  now: number;
}) {
  useUILocale();
  return (
    <Facts
      values={[
        [tr("common.observation_id"), o.id],
        [tr("accounts.limit"), quantity(o.limit)],
        [tr("accounts.used"), quantity(o.used)],
        [tr("accounts.remaining"), quantity(o.remaining)],
        [
          tr("common.percentage"),
          o.indicator
            ? `${quantity(o.indicator.value)}% ${o.indicator.kind === "percent-used" ? "used" : "remaining"}`
            : tr("common.unknown"),
        ],
        [tr("common.reset_time"), o.resetAt !== null && o.verification !== "verified"
          ? `${when(o.resetAt)} · ${tr("usage.unverified")}` : when(o.resetAt)],
        [tr("common.source"), o.source],
        [tr("accounts.observed_at"), when(o.observedAt)],
        [tr("common.expires_at"), when(o.expiresAt)],
        [tr("common.provenance"), o.provenance === "user-provided" ? tr("usage.ownerReported") : o.provenance],
        [tr("common.verification_status"), o.verification],
        [tr("common.freshness"), observationFreshness(o, now)],
        [tr("common.confidence"), o.confidence],
        [tr("common.account_attribution"), o.acquisition ? `${o.acquisition.method} · ${o.acquisition.accountId}` : tr("common.user_declared_provider_identity_unknown")],
        [tr("common.verified_source_received_at"), when(o.acquisition?.receivedAt)],
        [tr("common.shared_quota_pool"), o.acquisition?.sharedPool ? `${o.acquisition.provider} · ${o.acquisition.sharedPool.id} · ${o.acquisition.sharedPool.window}` : tr("common.unknown_shared_subscription_alone_is_insufficient")],
      ]}
    />
  );
}
export function QuotaCard({
  state,
  now,
  onObserve,
  onHistory,
  onArchive,
}: {
  state: QuotaState;
  now: number;
  onObserve?: () => void;
  onHistory: () => void;
  onArchive?: () => void;
}) {
  useUILocale();
  const d = state.definition;
  const fact = quotaFact(state, now);
  const verifiedRemaining = state.current?.verification === "verified" ? state.current.remaining : null;
  return (
    <article
      className="glass-column min-w-0 space-y-3 rounded-xl border p-3 [overflow-wrap:anywhere]"
      data-testid="account-quota"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="text-sm font-medium">
          {unitLabel(d.unit)} · {d.scope}
        </h4>
        <span className="rounded-md border px-2 py-1 text-xs">
          {codeLabel(state.status)}
        </span>
      </div>
      <Facts
        values={[
          [tr("common.quota_id_ef1c50"), d.id],
          [tr("accounts.window"), d.window],
          [tr("common.subscription_id"), d.subscriptionId ?? tr("common.none_dc937b")],
          [tr("d11.fact.title"), <span data-testid="account-quota-fact" data-fact={fact.kind}>{tr(`d11.fact.${fact.kind}` as "d11.fact.unknown")}</span>],
          [tr("accounts.remaining"), quantity(verifiedRemaining)],
          [tr("common.capacity_status"), state.status === "conflict" ? tr("common.conflict") : verifiedRemaining !== null ? tr("common.known") : tr("common.unknown")],
          [
            tr("common.conflict_status"),
            state.status === "conflict"
              ? tr("common.conflict_capacity_unknown")
              : tr("common.no_current_conflict_reported"),
          ],
        ]}
      />
      {state.current ? (
        <Evidence observation={state.current} now={now} />
      ) : (
        <p className="text-xs text-muted-foreground"><I18nText id="accounts.current_capacity_unknown_historical_values_do_not_establish" />{" "}</p>
      )}
      {state.warnings.map((w) => (
        <p key={w} className="text-xs text-muted-foreground">
          {w}
        </p>
      ))}
      {state.observations.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs"><I18nText id="accounts.supporting_latest_observations" />{state.observations.length})
          </summary>
          <div className="mt-2 space-y-3">
            {state.observations.map((o) => (
              <Evidence key={o.id} observation={o} now={now} />
            ))}
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {onObserve && (
          <Button size="sm" variant="outline" onClick={onObserve}><I18nText id="accounts.add_observation" />{" "}</Button>
        )}
        <Button size="sm" variant="outline" onClick={onHistory}><I18nText id="accounts.view_history" />{" "}</Button>
        {onArchive && (
          <Button size="sm" variant="ghost" onClick={onArchive}><I18nText id="accounts.archive_definition" />{" "}</Button>
        )}
      </div>
    </article>
  );
}

/** Append pages by the server cursor; equal observed times never become a client cursor. */
export function PagedEvidence<T extends { id: number | string }>({
  resourceKey,
  load,
  render,
  empty,
}: {
  resourceKey: string;
  load: (cursor?: number | null) => Promise<HistoryPage<T>>;
  render: (row: T) => ReactNode;
  empty: string;
}) {
  useUILocale();
  const [rows, setRows] = useState<T[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);
  const pending = useRef(false);
  const read = async (before?: number | null, seq = generation.current) => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await loader.current(before);
      if (seq !== generation.current) return;
      setRows((prior) =>
        before == null
          ? page.observations
          : [
              ...new Map(
                [...prior, ...page.observations].map((r) => [r.id, r]),
              ).values(),
            ],
      );
      setCursor(page.nextCursor);
    } catch (err) {
      if (seq === generation.current) setError(accountError(err));
    } finally {
      if (seq === generation.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    const seq = ++generation.current;
    pending.current = false;
    setRows([]);
    setCursor(null);
    void read(null, seq);
    return () => {
      generation.current++;
    };
  }, [resourceKey]);
  return (
    <div className="space-y-3" aria-busy={loading}>
      {rows.map((row) => (
        <article
          key={row.id}
          className="min-w-0 rounded-lg border p-3 [overflow-wrap:anywhere]"
          data-testid="evidence-row"
        >
          {render(row)}
        </article>
      ))}
      {loading && (
        <p role="status" className="text-xs"><I18nText id="common.loading_history" />{" "}</p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {(cursor !== null || error) && (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void read(cursor)}
        >
          {error ? tr("common.retry_history") : tr("common.load_older_observations")}
        </Button>
      )}
    </div>
  );
}
export function QuotaHistory({
  definition,
  now,
  version,
}: {
  definition: QuotaDefinition;
  now: number;
  version: number;
}) {
  useUILocale();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [definition.id]);
  return (
    <section className="space-y-3" aria-label={tr("accounts.usage_history")}>
      <h3
        ref={titleRef}
        tabIndex={-1}
        className="text-sm font-semibold outline-none"
      ><I18nText id="accounts.usage_history_2fca47" />{" "}{unitLabel(definition.unit)}
      </h3>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {definition.id} · {definition.scope} · {definition.window}
        {definition.archivedAt !== null ? tr("common.archived_definition") : ""}<I18nText id="accounts.observations_are_immutable" />{" "}</p>
      <PagedEvidence
        resourceKey={`${definition.id}:${version}`}
        load={(cursor) => api.accountCore.history(definition.id, cursor)}
        render={(o) => <Evidence observation={o} now={now} />}
        empty="No observations recorded."
      />
    </section>
  );
}
export function LegacyUsage({
  now,
  version,
}: {
  now: number;
  version: number;
}) {
  useUILocale();
  return (
    <section className="space-y-4" aria-label={tr("accounts.unassigned_usage")}>
      <h3 className="text-base font-semibold"><I18nText id="accounts.unassigned_usage" /></h3>
      <p className="text-xs text-muted-foreground"><I18nText id="accounts.saved_harness_meters_and_transcript_rollups_have_no" />{" "}</p>
      <h4 className="text-sm font-medium"><I18nText id="accounts.saved_usage_meters" /></h4>
      <PagedEvidence<LegacyMeter>
        resourceKey={`meters:${version}`}
        load={api.accountCore.legacyUsage}
        empty="No saved usage meters."
        render={(o) => (
          <div className="space-y-2">
            <Facts
              values={[
                [tr("common.harness"), o.harnessId],
                [tr("common.account_identity"), tr("common.unassigned")],
                [tr("common.source"), o.source ?? tr("common.unknown")],
                [tr("common.provenance"), o.provenance === "user-provided" ? tr("usage.ownerReported") : o.provenance],
                [tr("common.verification"), o.verification],
                [tr("accounts.observed_at"), when(o.observedAt)],
                [tr("common.expires_at"), when(o.expiresAt)],
              ]}
            />
            {o.meters.map((m) => (
              <p key={m.scope} className="text-xs">
                {m.scope}: {quantity(m.indicator.value)}<I18nText id="accounts.used_reset" />{" "}
                {when(m.resetAt)} ·{" "}
                {o.expiresAt <= now || (m.resetAt !== null && m.resetAt <= now)
                  ? tr("common.historical_expired")
                  : tr("common.stored_observation")}{" "}<I18nText id="accounts.remaining_unknown" />{" "}</p>
            ))}
            {o.warnings.map((w) => (
              <p key={w} className="text-xs text-muted-foreground">
                {w}
              </p>
            ))}
          </div>
        )}
      />
      <h4 className="text-sm font-medium"><I18nText id="accounts.saved_transcript_consumption" /></h4>
      <PagedEvidence<LegacyTokens>
        resourceKey={`tokens:${version}`}
        load={api.accountCore.legacyTokens}
        empty="No saved transcript consumption."
        render={(o) => (
          <Facts
            values={[
              [tr("common.account_identity"), tr("common.unassigned")],
              [tr("common.source"), o.source],
              [tr("common.day"), o.day],
              [tr("common.model"), o.model],
              [tr("accounts.observed_at"), tr("common.unknown_daily_aggregate")],
              [tr("common.input_tokens"), quantity(o.inputTokens)],
              [tr("common.output_tokens"), quantity(o.outputTokens)],
              [tr("common.cache_write_tokens"), quantity(o.cacheWriteTokens)],
              [tr("common.cache_read_tokens"), quantity(o.cacheReadTokens)],
              [tr("common.messages"), quantity(o.messageCount)],
              [tr("common.quota_capacity"), tr("common.unknown")],
            ]}
          />
        )}
      />
    </section>
  );
}
