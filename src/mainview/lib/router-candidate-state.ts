import type { CandidateEvaluation } from "../../shared/router-v2/types.ts";

/**
 * How one Router 2.0 candidate reads to the Owner. Four states, kept apart on purpose:
 *   refused     an observed provider usage-limit refusal for this account and model;
 *   ineligible  excluded for a separate reason (the reasons are listed beside it);
 *   unverified  eligible, signed in or not, with capacity NOT verified (the usual case);
 *   verified    eligible with verified sufficient capacity.
 * Pure and presentation-only: it never changes eligibility, ranking or selection.
 */
export type CandidateAvailability = "refused" | "ineligible" | "unverified" | "verified";

export function candidateAvailability(c: Pick<CandidateEvaluation, "eligible" | "providerRefusal" | "scores">): CandidateAvailability {
  if (!c.eligible) return "ineligible";
  if (c.providerRefusal) return "refused";
  return c.scores.quota.capacityClass === "verified-sufficient" ? "verified" : "unverified";
}

/** `installed` is the Router's floor: the CLI is there but is not signed in (or not present at all). */
export function candidateSignedIn(c: Pick<CandidateEvaluation, "readiness">): boolean {
  return c.readiness !== "installed";
}

/**
 * Another eligible option to EXPLAIN beside a refused selection: the first eligible candidate, in the
 * Router's own order, that is a different account, has no refusal, and is not ineligible. It is only
 * named. Nothing selects, switches, retries or launches it.
 */
export function otherEligibleOption(selected: CandidateEvaluation | null, eligible: readonly CandidateEvaluation[]): CandidateEvaluation | null {
  if (!selected?.providerRefusal) return null;
  return eligible.find((c) => c.candidateId !== selected.candidateId && c.accountId !== selected.accountId && !c.providerRefusal) ?? null;
}

/**
 * The candidate's capacity as the Router read it, independent of any refusal:
 *   shortfall   verified exhausted (a known capacity shortfall);
 *   verified    verified sufficient;
 *   unverified  an Owner report, a stale reading or a configured limit (evidence, not verification);
 *   unknown     nothing usable, or no reading at all.
 * A recorded provider refusal is shown separately by `candidateAvailability` and never changes this.
 */
export type CapacityReading = "shortfall" | "verified" | "unverified" | "unknown";

export function capacityReading(c: Pick<CandidateEvaluation, "scores">): CapacityReading {
  switch (c.scores.quota.capacityClass) {
    case "verified-insufficient": return "shortfall";
    case "verified-sufficient": return "verified";
    case "owner-reported":
    case "stale":
    case "configured-unverified": return "unverified";
    default: return "unknown";
  }
}
