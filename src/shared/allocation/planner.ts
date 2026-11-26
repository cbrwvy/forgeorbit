/**
 * Deterministic allocation selection on top of existing executor recommendations.
 * No inference, scoring, or quota claims.
 */
import type { ExecutorOption } from "../execution/executor-routing.ts";
import { pickProposedExecutor } from "../execution/executor-routing.ts";
import type { AllocationPlanPolicy, AllocationResourcePick } from "./types.ts";

function reasonCodes(option: ExecutorOption): Set<string> {
  return new Set([...option.limitations, ...option.why].map((r) => r.code));
}

function unknownFacts(option: ExecutorOption): string[] {
  const facts: string[] = [];
  if (option.availability === "unknown") facts.push("availability-unknown");
  if (reasonCodes(option).has("quota-unknown")) facts.push("quota-unknown");
  if (reasonCodes(option).has("authentication-unknown")) facts.push("authentication-unknown");
  if (reasonCodes(option).has("model-support-unverified")) facts.push("model-support-unverified");
  if (option.cost === null && option.classification !== "blocked") facts.push("cost-unknown");
  return facts;
}

function blockers(option: ExecutorOption, role: "developer" | "reviewer"): string[] {
  const out: string[] = [];
  if (!option.selectable) out.push("not-selectable");
  if (option.resource?.state === "ineligible") out.push("ineligible");
  if (role === "reviewer" && reasonCodes(option).has("reviewer-read-only-required")) out.push("reviewer-read-only-required");
  if (role === "developer" && reasonCodes(option).has("developer-write-required")) out.push("developer-write-required");
  return out;
}

export function executorOptionToPick(option: ExecutorOption, role: "developer" | "reviewer"): AllocationResourcePick {
  const eligibility = option.resource?.state ?? "unknown";
  return {
    optionId: option.id,
    harnessId: option.harnessId,
    harnessLabel: option.harnessLabel,
    kind: option.kind,
    modelId: option.modelId,
    modelLabel: option.modelLabel,
    modeId: option.mode?.id ?? "",
    modeLabel: option.mode?.label ?? "",
    accountId: option.resource?.evidence.account?.id ?? null,
    accountLabel: option.resource?.evidence.account?.label ?? null,
    resourceFingerprint: option.resource?.evidence.fingerprint ?? null,
    eligibility,
    eligibilityReasons: (option.resource?.reasons ?? []).map((r) => ({ code: r.code, message: r.code })),
    limitations: option.limitations,
    unknownFacts: unknownFacts(option),
    blockers: blockers(option, role),
    selectable: option.selectable && eligibility !== "ineligible",
  };
}

function policyAllows(option: ExecutorOption, policy: AllocationPlanPolicy): boolean {
  if (policy.allowedHarnessIds && !policy.allowedHarnessIds.includes(option.harnessId)) return false;
  const accountId = option.resource?.evidence.account?.id ?? null;
  if (policy.allowedAccountIds && accountId && !policy.allowedAccountIds.includes(accountId)) return false;
  if (policy.allowedAccountIds && !accountId) return false;
  return true;
}

function preferenceRank(option: ExecutorOption, policy: AllocationPlanPolicy): number {
  if (option.why.some((w) => w.code === "owner-preferred-account")) return 0;
  const accountId = option.resource?.evidence.account?.id ?? null;
  if (policy.preferredAccountIds?.includes(accountId ?? "")) return 0;
  if (policy.preferredHarnessIds?.includes(option.harnessId)) return 1;
  if (option.preferred.harness && option.preferred.model) return 2;
  if (option.preferred.model) return 3;
  if (option.preferred.harness) return 4;
  return 5;
}

/** Rank selectable options; never admits ineligible or policy-blocked rows. */
export function rankAllocationOptions(
  options: ExecutorOption[],
  policy: AllocationPlanPolicy,
  role: "developer" | "reviewer",
): ExecutorOption[] {
  return options
    .filter((o) => o.selectable && o.resource?.state !== "ineligible" && policyAllows(o, policy))
    .sort(
      (a, b) =>
        preferenceRank(a, policy) - preferenceRank(b, policy) ||
        (a.resource?.state === "eligible" ? 0 : 1) - (b.resource?.state === "eligible" ? 0 : 1) ||
        a.harnessLabel.localeCompare(b.harnessLabel) ||
        a.modelId.localeCompare(b.modelId) ||
        (a.resource?.evidence.account?.id ?? "").localeCompare(b.resource?.evidence.account?.id ?? ""),
    );
}

export function pickAllocationResource(
  groups: Parameters<typeof pickProposedExecutor>[0],
  policy: AllocationPlanPolicy,
  role: "developer" | "reviewer",
  harnessId?: string | null,
  preferredModelId?: string | null,
): { pick: AllocationResourcePick | null; blockingReason: string | null } {
  const filterHarness = (options: ExecutorOption[]) =>
    harnessId ? options.filter((o) => o.harnessId === harnessId) : options;
  const eligible = filterHarness([...groups.groups["verified-eligible"], ...groups.groups["potential-unknown"]]);
  const ranked = rankAllocationOptions(eligible, policy, role);
  const requested = preferredModelId ? ranked.filter((o) => o.modelId === preferredModelId) : ranked;
  if (preferredModelId && requested.length === 0) {
    return {
      pick: null,
      blockingReason: `Requested model ${preferredModelId} is not selectable for this harness. No substitute was chosen.`,
    };
  }
  const first = requested[0] ?? null;
  if (!first) {
    const blocked = groups.groups.blocked[0] ?? groups.groups.unsupported[0];
    return {
      pick: null,
      blockingReason: blocked?.limitations[0]?.message ?? blocked?.why[0]?.message ?? "No acceptable resource for this role.",
    };
  }
  if (first.resource?.state === "unknown" && policy.unknownQuotaRequiresAcknowledgement) {
    // Still propose, but surface unknown facts — Owner must review; never claim quota capacity.
  }
  return { pick: executorOptionToPick(first, role), blockingReason: null };
}

export function findOptionById(options: ExecutorOption[], optionId: string): ExecutorOption | null {
  return options.find((o) => o.id === optionId) ?? null;
}
