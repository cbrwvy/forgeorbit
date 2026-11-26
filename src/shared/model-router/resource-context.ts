/**
 * FO-009F — read-only resource context for the Model Router UI.
 * Does not acquire quota, rank models, or grant execution authority.
 */

import type { QuotaRefreshAvailability } from "../accounts/quota-sources.ts";
import type { Account, QuotaState } from "../accounts/types.ts";
import { quotaFact, type QuotaFactKind } from "../accounts/availability.ts";

export interface HarnessResourceRow {
  id: string;
  label: string;
  enabled: boolean;
  /** Automatic selection never runs without verified router evidence. */
  automaticSelection: "blocked-disabled" | "blocked-unverified";
  automaticReason: string;
  manualSelection: "allowed-with-warning" | "blocked-disabled";
  manualReason: string;
}

export interface AccountQuotaRow {
  quotaId: string;
  scope: string;
  window: string;
  status: QuotaState["status"];
  verification: string;
  lastObservedAt: number | null;
  expiresAt: number | null;
  resetAt: number | null;
  /** Display label only — never invents remaining counts or reset guarantees. */
  capacityLabel: string;
  /** Direction 11: what kind of fact this row holds. Display grouping only; never capacity. */
  evidence: QuotaFactKind;
  /** The source of the reading the row describes (current, else the newest stored one). */
  lastSource: string | null;
}

export interface TrustedSourceRow {
  sourceId: string;
  label: string;
  provider: string;
  implemented: boolean;
  refreshAvailable: boolean;
  reason: string;
}

export interface AccountResourceRow {
  id: string;
  displayName: string;
  provider: string;
  quotas: AccountQuotaRow[];
  trustedSources: TrustedSourceRow[];
}

export interface ModelRouterResourceContext {
  readOnly: true;
  capturedAt: number;
  automaticRouting: {
    available: false;
    reason: string;
  };
  harnesses: HarnessResourceRow[];
  accounts: AccountResourceRow[];
  policyNotes: readonly string[];
}

const AUTOMATIC_BLOCKER =
  "Automatic selection requires verified eligibility under current policy. No production trusted quota adapter is registered, so capacity stays Unknown.";

const MANUAL_ALLOWED =
  "Manual harness and model selection remains available. Unknown or stale quota is not treated as available capacity.";

const MANUAL_DISABLED = "This harness is disabled in Settings. Enable it before starting a new run.";

/**
 * The capacity this quota can be relied on for right now. A reading that is no longer current gives no
 * capacity, so a re-resolved stale state says "Unknown"; that the past reading exists is a separate fact
 * (`AccountQuotaRow.evidence` = "historical", with its time and source), never a number.
 */
export function quotaCapacityLabel(state: QuotaState, now: number): string {
  const current = state.current;
  if (state.status === "conflict") return "Conflicting evidence";
  if (state.status === "unknown" || !current) return "Unknown";
  const expired =
    (current.expiresAt != null && current.expiresAt <= now)
    || (current.resetAt != null && current.resetAt <= now);
  if (state.status === "stale" || expired) return "Stale — not current capacity";
  if (current.verification !== "verified") {
    return current.provenance === "user-provided" ? "Owner-reported — not verified capacity" : "Unverified observation";
  }
  if (current.remaining != null) return `Verified remaining: ${current.remaining}`;
  if (current.indicator?.kind === "percent-used") {
    return `Verified used ${current.indicator.value}% (exact balance unknown)`;
  }
  if (current.indicator?.kind === "percent-remaining") {
    return `Verified remaining ${current.indicator.value}% (exact balance unknown)`;
  }
  return "Verified observation — remaining quantity unknown";
}

export function mapTrustedSource(source: QuotaRefreshAvailability): TrustedSourceRow {
  return {
    sourceId: source.id,
    label: source.label,
    provider: source.provider,
    implemented: source.implemented,
    refreshAvailable: source.refreshAvailable,
    reason: source.reason,
  };
}

export function mapQuotaState(state: QuotaState, now: number): AccountQuotaRow {
  const current = state.current;
  const fact = quotaFact(state, now);
  // The time and source belong to the reading the row describes. A stale or conflicting row keeps them,
  // so "when was this last read, and by whom" is never lost, while `verification` stays the CURRENT reading's.
  const shown = fact.reading;
  return {
    quotaId: state.definition.id,
    scope: state.definition.scope,
    window: state.definition.window,
    status: state.status,
    verification: current?.verification ?? "unknown",
    lastObservedAt: shown?.observedAt ?? null,
    expiresAt: shown?.expiresAt ?? null,
    resetAt: shown?.resetAt ?? null,
    capacityLabel: quotaCapacityLabel(state, now),
    evidence: fact.kind,
    lastSource: shown?.source ?? null,
  };
}

export function harnessResourceRow(input: { id: string; label: string; enabled: boolean }): HarnessResourceRow {
  if (!input.enabled) {
    return {
      ...input,
      automaticSelection: "blocked-disabled",
      automaticReason: MANUAL_DISABLED,
      manualSelection: "blocked-disabled",
      manualReason: MANUAL_DISABLED,
    };
  }
  return {
    ...input,
    automaticSelection: "blocked-unverified",
    automaticReason: AUTOMATIC_BLOCKER,
    manualSelection: "allowed-with-warning",
    manualReason: MANUAL_ALLOWED,
  };
}

export function buildModelRouterResourceContext(input: {
  capturedAt: number;
  harnesses: readonly { id: string; label: string; enabled: boolean }[];
  accounts: readonly Account[];
  quotasByAccount: ReadonlyMap<string, readonly QuotaState[]>;
  trustedSourcesByAccount: ReadonlyMap<string, readonly QuotaRefreshAvailability[]>;
  now: number;
}): ModelRouterResourceContext {
  return {
    readOnly: true,
    capturedAt: input.capturedAt,
    automaticRouting: { available: false, reason: AUTOMATIC_BLOCKER },
    harnesses: input.harnesses.map(harnessResourceRow),
    accounts: input.accounts.map((account) => ({
      id: account.id,
      displayName: account.displayName,
      provider: account.provider,
      quotas: (input.quotasByAccount.get(account.id) ?? []).map((state) => mapQuotaState(state, input.now)),
      trustedSources: (input.trustedSourcesByAccount.get(account.id) ?? []).map(mapTrustedSource),
    })),
    policyNotes: [
      AUTOMATIC_BLOCKER,
      MANUAL_ALLOWED,
      "Installed CLI binaries do not prove quota, login, or model entitlement.",
      "PM and Head of PM may read recommendations; they cannot bypass Owner routing policy or FO-AUTO01 grant limits.",
    ],
  };
}
