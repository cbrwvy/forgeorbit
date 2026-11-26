import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { moneyLabel, when } from "@/lib/accounts";
import { Facts } from "./AccountEvidence";
import type { Subscription } from "../../../shared/accounts/types.ts";

export function SubscriptionFacts({
  subscription: s,
}: {
  subscription: Subscription;
}) {
  useUILocale();
  return (
    <Facts
      values={[
        [tr("common.subscription_id"), s.id],
        [tr("common.provider"), s.provider],
        [tr("common.currency"), s.currency ?? tr("common.unknown")],
        [tr("accounts.recurring_cost"), moneyLabel(s.recurringCostMinor, s.currency)],
        [tr("accounts.billing_period"), s.billingPeriod],
        [tr("accounts.renewal_time"), when(s.renewsAt)],
        [tr("accounts.known_reset_time"), when(s.resetsAt)],
        [tr("common.provenance"), s.provenance],
        [tr("common.source"), s.source],
        [tr("common.verification_status"), s.verification],
      ]}
    />
  );
}
export function SubscriptionCommitments({
  subscriptions,
}: {
  subscriptions: Subscription[];
}) {
  useUILocale();
  // BigInt prevents cross-subscription overflow; identity, currency AND billing period stay separate.
  const groups = new Map<
    string,
    { currency: string; period: string; minor: bigint }
  >();
  const unique = [...new Map(subscriptions.map((s) => [s.id, s])).values()];
  for (const s of unique) {
    if (
      s.currency === null ||
      s.recurringCostMinor === null ||
      s.billingPeriod === "unknown"
    )
      continue;
    const key = `${s.currency}:${s.billingPeriod}`;
    const group = groups.get(key) ?? {
      currency: s.currency,
      period: s.billingPeriod,
      minor: 0n,
    };
    group.minor += BigInt(s.recurringCostMinor);
    groups.set(key, group);
  }
  return (
    <div
      className="rounded-lg border p-3 text-xs"
      data-testid="subscription-commitments"
    >
      <p className="font-medium"><I18nText id="accounts.declared_commitments_deduplicated_by_subscription_id" />{" "}</p>
      {[...groups].map(([key, g]) => (
        <p key={key}>
          {g.minor <= BigInt(Number.MAX_SAFE_INTEGER)
            ? moneyLabel(Number(g.minor), g.currency)
            : tr("common.minor_units_cdf3e5", { p0: String(g.currency), p1: String(g.minor) })}{" "}
          / {g.period}
        </p>
      ))}
      <p><I18nText id="accounts.unknown_commitments" />{" "}
        {
          unique.filter(
            (s) =>
              s.currency === null ||
              s.recurringCostMinor === null ||
              s.billingPeriod === "unknown",
          ).length
        }
      </p>
    </div>
  );
}
