import { codeLabel } from "@/i18n/presentation";
import { getLocale, intlLocale, t as tr } from "@/i18n/core";

import type { AccountResource, AccountResources } from "./account-api.ts";
import type {
  QuotaObservation,
  QuotaState,
  QuotaUnit,
} from "../../shared/accounts/types.ts";
import type { AgentProfile } from "../../shared/types.ts";
import { resolveQuota } from "../../shared/accounts/resolve.ts";

export const UNKNOWN = "Unknown";
export const when = (value: number | null | undefined) =>
  value == null ? tr("common.unknown") : new Date(value).toLocaleString(intlLocale());
export const quantity = (value: number | null | undefined) =>
  value == null
    ? tr("common.unknown")
    : value.toLocaleString(intlLocale(), { maximumSignificantDigits: 21 });
export function unitLabel(unit: QuotaUnit): string {
  return unit.kind === "money"
    ? tr("common.minor_units", { p0: String(unit.currency) })
    : "name" in unit
      ? `${codeLabel(unit.kind)} (${unit.kind === "compute-time" ? codeLabel(unit.name) : unit.name})`
      : codeLabel(unit.kind);
}
export function currencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error(tr("common.enter_a_three_letter_currency_code"));
  return new Intl.NumberFormat(intlLocale(), {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits!;
}
/** Decimal string -> integer minor units, with no floating-point multiplication or rounding. */
export function parseMoney(raw: string, currency: string): number | null {
  if (!raw.trim()) return null;
  const digits = currencyDigits(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!match || (match[2]?.length ?? 0) > digits)
    throw new Error(
      tr("common.enter_a_non_negative_amount_with_at_most", { p0: String(digits) }),
    );
  const minor =
    BigInt(match[1]!) * 10n ** BigInt(digits) +
    BigInt((match[2] ?? "").padEnd(digits, "0") || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(tr("common.amount_exceeds_the_supported_safe_range"));
  return Number(minor);
}
export function moneyInput(
  minor: number | null,
  currency: string | null,
): string {
  if (minor === null || !currency) return "";
  const digits = currencyDigits(currency);
  const raw = BigInt(minor)
    .toString()
    .padStart(digits + 1, "0");
  return digits ? `${raw.slice(0, -digits)}.${raw.slice(-digits)}` : raw;
}
export function moneyLabel(
  minor: number | null,
  currency: string | null,
): string {
  if (minor === null || !currency) return tr("common.unknown");
  const exact = moneyInput(minor, currency);
  if (getLocale() === "en") return `${currency} ${exact}`;
  const [whole, fraction] = exact.split(".");
  // Format the integer as BigInt, retaining every minor unit even near MAX_SAFE_INTEGER.
  const integer = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }).format(BigInt(whole!));
  const separator = new Intl.NumberFormat(intlLocale()).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ",";
  return `${currency} ${integer}${fraction ? separator + fraction : ""}`;
}
export function nullableNumber(raw: string, integer = false): number | null {
  if (!raw.trim()) return null;
  if (integer && !/^\d+$/.test(raw.trim()))
    throw new Error(
      tr("common.enter_an_integer_count_monetary_values_use_whole"),
    );
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim()))
    throw new Error(
      tr("common.enter_a_non_negative_number_or_leave_it"),
    );
  const value = Number(raw);
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER)
    throw new Error(tr("common.value_exceeds_the_supported_safe_range"));
  return value;
}
export function dateInput(value: number | null | undefined): string {
  if (value == null) return "";
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace(/:00$/, "");
}
export function parseDate(raw: string): number | null {
  if (!raw) return null;
  const value = new Date(raw).getTime();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(tr("common.enter_a_valid_date_and_time"));
  return value;
}
export function currentQuotas(
  row: AccountResource,
  subscriptions: AccountResources["subscriptions"],
  now: number,
): QuotaState[] {
  return row.quotas.map((state) => {
    const next = resolveQuota(state.definition, state.observations, now);
    if (
      row.account.archivedAt !== null ||
      (state.definition.subscriptionId &&
        !subscriptions.some((s) => s.id === state.definition.subscriptionId))
    ) {
      return {
        ...next,
        status: "unknown",
        current: null,
        warnings: [...next.warnings, "Account or subscription is archived."],
      };
    }
    return next;
  });
}
export function profileWarning(
  row: AccountResource,
  profile: AgentProfile | undefined,
  harnessId: string,
): string | null {
  if (
    !profile ||
    profile.harness !== harnessId ||
    !row.bindings.some((b) => b.harnessId === harnessId)
  )
    return tr("common.unreliable_association_profile_harness_changed_or_binding_is");
  if (row.account.provenance === "unknown")
    return tr("common.associated_account_identity_is_unknown");
  return null;
}
export type ObservationFreshnessStatus = "freshness-unknown" | "expired" | "reset-passed" | "future" | "current";
export function observationFreshnessStatus(o: QuotaObservation, now: number): ObservationFreshnessStatus {
  if (o.expiresAt === null) return "freshness-unknown";
  if (o.expiresAt <= now) return "expired";
  if (o.resetAt !== null && o.resetAt <= now) return "reset-passed";
  return o.observedAt > now ? "future" : "current";
}
export function observationFreshness(o: QuotaObservation, now: number): string {
  const labels = {
    "freshness-unknown": "common.stale_freshness_unknown",
    expired: "common.expired",
    "reset-passed": "common.stale_reset_passed",
    future: "common.future_observation",
    current: "common.current",
  } as const;
  return tr(labels[observationFreshnessStatus(o, now)]);
}
export function accountMetrics(
  rows: AccountResource[],
  profiles: AgentProfile[],
  harnessCount: number,
  subscriptionCount: number,
  now: number,
) {
  const quotas = rows.flatMap((r) => r.quotas);
  return [
    [tr("common.accounts_registered"), rows.length],
    [tr("common.harnesses"), harnessCount],
    [tr("common.subscriptions"), subscriptionCount],
    [tr("common.current_quotas"), quotas.filter((q) => q.status === "current").length],
    [
      tr("common.unknown_quotas"),
      quotas.filter((q) => q.current?.remaining == null).length,
    ],
    [
      tr("common.stale_observations"),
      quotas.reduce(
        (sum, q) =>
          sum +
          q.observations.filter(
            (o) => observationFreshnessStatus(o, now) !== "current",
          ).length,
        0,
      ),
    ],
    [
      tr("common.resource_conflicts"),
      quotas.filter((q) => q.status === "conflict").length +
        rows.reduce(
          (sum, row) =>
            sum +
            row.profiles.filter((a) => {
              const profile = profiles.find((p) => p.id === a.profileId);
              return (
                !profile ||
                profile.harness !== a.harnessId ||
                !row.bindings.some((b) => b.harnessId === a.harnessId)
              );
            }).length,
          0,
        ),
    ],
  ] as const;
}
/** Do not display arbitrary transport/SQLite errors or request contents. */
export function accountError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403)
    return tr("common.authorization_failed_reopen_the_app_with_a_valid");
  if (status === 409)
    return tr("common.this_relationship_is_already_in_use_or_retained");
  if (status === 404)
    return tr("common.this_resource_is_no_longer_available_refresh_and");
  if (status === 400) {
    const messages: Record<string, string> = {
      "Bind the profile's harness explicitly first.":
        tr("common.bind_the_profile_s_current_harness_to_this"),
      "Subscription and account providers must match.":
        tr("common.the_subscription_and_account_must_have_the_same"),
      "Subscription must be explicitly linked first.":
        tr("common.link_the_subscription_to_this_account_before_creating"),
      "Invalid observation time range.":
        tr("common.observed_at_cannot_be_in_the_future_expiry"),
      "Remaining exceeds limit.": tr("common.remaining_cannot_exceed_the_declared_limit"),
      "Concurrency and monetary minor units require integer counts.":
        tr("common.concurrency_and_monetary_quotas_require_integer_values_enter"),
      "Quota definition is archived.":
        tr("common.this_quota_definition_is_archived_create_a_new"),
    };
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && Object.hasOwn(messages, message))
      return messages[message]!;
  }
  if (status === 400 || status === 413)
    return tr("common.check_the_fields_matching_providers_harness_binding_value");
  return tr("common.the_operation_could_not_be_confirmed_refresh_to");
}
