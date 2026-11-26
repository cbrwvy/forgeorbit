import type { CandidateEvaluation } from "./types.ts";

/**
 * Why no candidate qualified, grouped by what the evaluator already said (Direction 16).
 * Pure and presentation-only: it reads elimination reasons, never changes eligibility or ranking.
 *
 * A known capacity shortfall (verified exhausted) and Unknown capacity (strict policy cannot verify)
 * are different facts and stay in different groups. A provider refusal is evidence about one account
 * and model: it is counted apart and never becomes a capacity group.
 */
export type NoQualifierCategory =
  | "known-shortfall"
  | "unknown-capacity"
  | "blocked-provider"
  | "not-signed-in"
  | "concurrency"
  | "owner-policy"
  | "other";

export const NO_QUALIFIER_CATEGORIES: readonly NoQualifierCategory[] = [
  "known-shortfall", "unknown-capacity", "blocked-provider", "not-signed-in", "concurrency", "owner-policy", "other",
];

export function classifyEliminationReason(reason: string): NoQualifierCategory {
  const code = reason.split(":")[0]!.trim();
  if (code === "quota-exhausted" || code === "shared-pool-exhausted") return "known-shortfall";
  if (code === "quota-unknown-strict" || code === "quota-unverified-strict") return "unknown-capacity";
  if (code === "cursor-internal-sandbox-unavailable" || code === "deepseek-containment-blocked" || code === "active-block") return "blocked-provider";
  if (code === "account-unauthenticated" || code === "cli-not-installed" || code === "harness-disabled") return "not-signed-in";
  if (code === "concurrency-limit-reached") return "concurrency";
  if (code.startsWith("owner-") || code === "autonomy-envelope" || code.startsWith("cost-budget") || code === "quality-tier-insufficient" ||
    code.endsWith("-read-only-required") || code === "developer-write-required") return "owner-policy";
  return "other";
}

export interface NoQualifierSummary {
  total: number;
  /** Candidates that have at least one reason in the category. One candidate can be in several. */
  byCategory: Record<NoQualifierCategory, number>;
  /** Candidates with a recorded provider refusal. Never added to a capacity category. */
  refused: number;
}

export function summarizeNoQualifier(ineligible: ReadonlyArray<Pick<CandidateEvaluation, "eliminationReasons" | "providerRefusal">>): NoQualifierSummary {
  const byCategory = Object.fromEntries(NO_QUALIFIER_CATEGORIES.map(category => [category, 0])) as Record<NoQualifierCategory, number>;
  let refused = 0;
  for (const candidate of ineligible) {
    const seen = new Set(candidate.eliminationReasons.filter(reason => !reason.startsWith("provider-usage-limit:")).map(classifyEliminationReason));
    for (const category of seen) byCategory[category] += 1;
    if (candidate.providerRefusal) refused += 1;
  }
  return { total: ineligible.length, byCategory, refused };
}

const PHRASES: Record<NoQualifierCategory, string> = {
  "known-shortfall": "a known capacity shortfall",
  "unknown-capacity": "Unknown capacity that the quota policy cannot accept",
  "blocked-provider": "a blocked provider",
  "not-signed-in": "no usable sign-in, installation or enabled harness",
  concurrency: "all slots occupied",
  "owner-policy": "an Owner or role restriction",
  other: "another stated reason",
};

/** One English sentence for the server explanation. Empty when nothing was ruled out. */
export function describeNoQualifier(summary: NoQualifierSummary): string {
  if (summary.total === 0) return "";
  const parts = NO_QUALIFIER_CATEGORIES.filter(category => summary.byCategory[category] > 0)
    .map(category => `${summary.byCategory[category]} with ${PHRASES[category]}`);
  if (summary.refused > 0) parts.push(`${summary.refused} with a recorded provider refusal`);
  return `Ruled out before scoring: ${parts.join("; ")}.`;
}
