import { observationCurrent } from "./resolve.ts";
import type { QuotaObservation, QuotaState } from "./types.ts";

/**
 * Direction 11: what kind of quota fact a state actually holds, in one place, so every screen that
 * names a quota says the same thing. It is a classification of stored evidence. It never refreshes a
 * provider, never turns a percentage into an amount and never promotes a reading into capacity.
 *
 * - `verified`: a current reading from a trusted source bound to this account.
 * - `owner-reported`: a current reading the Owner typed in. Never verified, never used for automatic routing.
 * - `observed`: a current provider-reported diagnostic reading that no verified binding backs.
 * - `historical`: a reading exists but it is expired, past its reset or undated. It is the past, not capacity.
 * - `conflict`: current sources disagree. Capacity is unknown.
 * - `unknown`: no reading at all, or the account/subscription is archived.
 */
export type QuotaFactKind = "verified" | "owner-reported" | "observed" | "historical" | "conflict" | "unknown";

export interface QuotaFact {
  kind: QuotaFactKind;
  /** The reading the kind describes: the current one, else the newest stored one. Null only for `unknown`. */
  reading: QuotaObservation | null;
}

const newest = (o: readonly QuotaObservation[]) =>
  [...o].sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id))[0] ?? null;

export function quotaFact(state: QuotaState, now: number): QuotaFact {
  if (state.definition.archivedAt !== null) return { kind: "unknown", reading: null };
  const current = state.current;
  if (state.status === "conflict") return { kind: "conflict", reading: newest(state.observations) };
  // A snapshot captured earlier can still be `current` after its expiry: judge it at display time.
  if (state.status === "current" && current && observationCurrent(current, now)) {
    if (current.verification === "verified") return { kind: "verified", reading: current };
    return { kind: current.provenance === "user-provided" ? "owner-reported" : "observed", reading: current };
  }
  const past = newest(state.observations);
  return past ? { kind: "historical", reading: past } : { kind: "unknown", reading: null };
}
