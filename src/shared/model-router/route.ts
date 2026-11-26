import { resolveQuota } from "../accounts/resolve.ts";
import type { QuotaState } from "../accounts/types.ts";
import { priorityRank, spendingChecks } from "../task-scheduling.ts";
import type {
  CandidateAssessment, ModelEvidence, OwnerRoutingConstraints, ResourceCandidate,
  ResourceLimit, RoutingPolicy, RoutingPreview, RoutingSnapshot, TaskRequirements, VerifiedFact,
} from "./types.ts";

export const EMPTY_MODEL_EVIDENCE: ModelEvidence = {
  capabilities: null, tools: null, permissions: null, contextTokens: null,
  efforts: null, quality: null, durationMs: null, expectedCost: null,
};
export const UNKNOWN_OWNER_CONSTRAINTS: OwnerRoutingConstraints = {
  allowedHarnesses: null, allowedAccounts: null, spending: null, maxExpectedCost: null,
  globalConcurrency: null, projectPriority: null, requiredApprovals: ["Owner must approve any future execution."],
};
export function currentFact<T>(fact: VerifiedFact<T> | null, now: number): fact is VerifiedFact<T> {
  return fact !== null && fact.verification === "verified" && !!fact.source
    && fact.observedAt <= now && fact.expiresAt !== null && fact.expiresAt > now;
}
const unique = (items: string[]) => [...new Set(items)].sort();
function subscriptions(s: RoutingSnapshot, accountId: string | null): string[] {
  return s.subscriptionLinks.filter(l => l.accountId === accountId && s.subscriptions.some(x => x.id === l.subscriptionId && x.archivedAt === null)).map(l => l.subscriptionId);
}
function freshState(state: QuotaState, now: number): QuotaState {
  return resolveQuota(state.definition, state.observations, now);
}
/** Shared pool equality requires provider + verified pool identity + scope + window + unit.
 * Equal subscription labels/IDs alone never merge quota counts. */
export function quotaPoolKey(state: QuotaState): string | null {
  const o = state.current;
  const p = o?.acquisition?.sharedPool;
  return o?.verification === "verified" && p?.verified === true
    && p.scope === state.definition.scope && p.window === state.definition.window
    ? JSON.stringify([o.acquisition!.provider, p.id, p.scope, p.window, state.definition.unit]) : null;
}
function relevantQuotas(s: RoutingSnapshot, c: ResourceCandidate, now: number): QuotaState[] {
  const states = s.quotas.map(q => freshState(q, now)).filter(q => q.definition.archivedAt === null);
  const subIds = subscriptions(s, c.accountId);
  const applicable = states.filter(q => (!q.definition.scope.startsWith("model:") || q.definition.scope === "model:" + c.modelId)
    && (!q.definition.scope.startsWith("harness:") || q.definition.scope === "harness:" + c.harnessId));
  const direct = applicable.filter(q => q.definition.accountId === c.accountId
    || q.definition.subscriptionId !== null && subIds.includes(q.definition.subscriptionId));
  const keys = new Set(direct.map(quotaPoolKey).filter(x => x !== null));
  return states.filter(q => direct.includes(q) || keys.has(quotaPoolKey(q) ?? ""));
}
export function limitApplies(limit: ResourceLimit, c: ResourceCandidate, s: RoutingSnapshot): boolean {
  const scope = limit.scope;
  switch (scope.kind) {
    case "global": return true;
    case "harness": return scope.id === c.harnessId;
    case "account": return scope.id === c.accountId;
    case "subscription": return subscriptions(s, c.accountId).includes(scope.id);
    case "pool": return relevantQuotas(s, c, s.capturedAt).some(q => quotaPoolKey(q) === scope.id);
  }
}
function effort(c: ResourceCandidate, task: TaskRequirements, now: number): CandidateAssessment["thinkingEffort"] {
  const f = c.evidence.efforts;
  if (!currentFact(f, now)) return { value: null, status: "conditional", reason: "Supported effort vocabulary is unverified." };
  if (f.value.length === 0) return { value: null, status: "not-applicable", reason: "This harness/model has no effort parameter." };
  if (task.complexity === "unknown") return { value: null, status: "conditional", reason: "Task complexity is unknown." };
  const fraction = { low: 0, medium: 1 / 3, high: 2 / 3, "very-high": 1 }[task.complexity];
  return { value: f.value[Math.round(fraction * (f.value.length - 1))]!, status: "verified", reason: "Selected within the confirmed ordered harness/model vocabulary." };
}
function assess(c: ResourceCandidate, task: TaskRequirements, s: RoutingSnapshot, owner: OwnerRoutingConstraints): CandidateAssessment {
  const now = s.capturedAt;
  const { id, harnessId, accountId, modelId, profileIds } = c;
  const a: CandidateAssessment = {
    candidate: { id, harnessId, accountId, modelId, profileIds: [...profileIds].sort() },
    status: "verified", reasons: [], unknowns: [], provenance: [...task.provenance],
    expectedCost: null, thinkingEffort: effort(c, task, now), quotaEvidence: [], conflicts: [],
    requiredOwnerApproval: [...owner.requiredApprovals], ranking: { quality: null, duration: null, reserve: null },
  };
  const exclude = (why: string) => { a.status = "excluded"; a.reasons.push(why); };
  const unknown = (why: string) => { if (a.status !== "excluded") a.status = "conditional"; a.unknowns.push(why); };
  const check = <T>(f: VerifiedFact<T> | null, label: string): f is VerifiedFact<T> => {
    if (!currentFact(f, now)) { unknown(label); return false; }
    a.provenance.push(f.source); return true;
  };
  if (!c.enabled) exclude("Harness is disabled.");
  if (owner.allowedHarnesses && !owner.allowedHarnesses.includes(c.harnessId)) exclude("Owner disallows this harness.");
  if (owner.allowedAccounts && (!c.accountId || !owner.allowedAccounts.includes(c.accountId))) exclude("Owner disallows this account.");
  const account = s.accounts.find(x => x.id === c.accountId);
  if (!account) unknown("No registered account is explicitly selected.");
  else {
    a.provenance.push(account.source);
    if (account.archivedAt !== null || account.availability === "unavailable") exclude("Account is archived or unavailable.");
    if (!s.bindings.some(b => b.harnessId === c.harnessId && b.accountId === account.id)) exclude("Explicit harness/account binding is absent.");
  }
  if (check(c.authorization, "CLI authorization for this exact harness/account is unknown.") && !c.authorization.value) exclude("CLI authorization is unavailable.");
  if (check(c.availability, "Current execution availability is unknown.") && !c.availability.value) exclude("Execution resource is unavailable.");
  const support = c.support;
  if (!c.modelId) unknown("Model is unknown.");
  if (!support || support.accountId !== accountId || support.harnessId !== harnessId || support.modelId !== modelId
    || support.verification !== "verified" || support.observedAt > now || support.expiresAt === null || support.expiresAt <= now) unknown("Model support is unknown, declared or stale.");
  else {
    a.provenance.push(support.source);
    if (support.support === "unsupported") exclude("Model is confirmed unsupported.");
    else if (support.support !== "supported") unknown("Model support is unknown.");
  }
  for (const [required, fact, label] of [
    [task.capabilities, c.evidence.capabilities, "capabilities"], [task.tools, c.evidence.tools, "tools"],
    [task.requiredPermissions, c.evidence.permissions, "permissions"],
  ] as const) {
    if (required.length && check(fact, "Required " + label + " are unverified.") && required.some(x => !fact.value.includes(x))) exclude("Required " + label + " are unsupported.");
  }
  if (task.allowedPermissions !== null) {
    if (check(c.evidence.permissions, "Effective permissions are unverified.") && c.evidence.permissions.value.some(x => !task.allowedPermissions!.includes(x))) exclude("Resource permissions exceed task permissions.");
  }
  if (task.contextTokens !== null && check(c.evidence.contextTokens, "Context capacity is unknown.") && c.evidence.contextTokens.value < task.contextTokens) exclude("Context capacity is insufficient.");
  if (task.complexity === "unknown") unknown("Task complexity is unknown.");
  if (a.thinkingEffort.status === "conditional") unknown(a.thinkingEffort.reason);
  else if (c.evidence.efforts) a.provenance.push(c.evidence.efforts.source);

  const cost = c.evidence.expectedCost;
  if (currentFact(cost, now) && cost.value.taskId === task.taskId && cost.value.money.minor >= 0 && Number.isSafeInteger(cost.value.money.minor)) {
    a.expectedCost = { ...cost.value, source: cost.source }; a.provenance.push(cost.source);
  }
  if (owner.spending === null) unknown("Owner spending policy is unknown.");
  else if (check(c.billing, "Billing route and overage controls are unverified.")) {
    for (const entry of spendingChecks(owner.spending, [], { id: c.harnessId, label: c.harnessId, cost: c.billing.value })) {
      if (entry.level === "error") exclude(entry.message);
      else if (entry.level === "warning") a.requiredOwnerApproval.push(entry.message);
    }
  }
  if (!a.expectedCost) a.unknowns.push("Expected additional cost is unknown.");
  if (owner.spending === "no-extra") {
    if (!a.expectedCost) unknown("Additional spend cannot be verified as zero.");
    else if (a.expectedCost.money.minor > 0) exclude("Owner forbids additional spending.");
  }
  if (owner.maxExpectedCost) {
    if (!a.expectedCost || a.expectedCost.money.currency !== owner.maxExpectedCost.currency) unknown("Cost is unknown or its currency cannot be compared to the budget.");
    else if (a.expectedCost.money.minor > owner.maxExpectedCost.minor) exclude("Expected additional cost exceeds Owner budget.");
  }
  const quality = c.evidence.quality, duration = c.evidence.durationMs;
  if (currentFact(quality, now) && Number.isFinite(quality.value.score)) { a.ranking.quality = quality.value; a.provenance.push(quality.source); }
  if (currentFact(duration, now) && duration.value.taskId === task.taskId && Number.isFinite(duration.value.ms) && duration.value.ms >= 0) { a.ranking.duration = duration.value; a.provenance.push(duration.source); }
  a.quotaEvidence = relevantQuotas(s, c, now);
  if (!a.quotaEvidence.length) unknown("Quota availability is unknown.");
  const groups = new Map<string, QuotaState[]>();
  for (const state of a.quotaEvidence) {
    const key = quotaPoolKey(state) ?? state.definition.id;
    groups.set(key, [...(groups.get(key) ?? []), state]);
  }
  const reserves: number[] = [];
  for (const states of groups.values()) {
    const first = states[0]!;
    // Resolve all pool reports together; per-account reports cannot hide conflicting shared evidence.
    const merged = resolveQuota(first.definition, states.flatMap(q => q.observations.map(o => ({ ...o, quotaId: first.definition.id }))), now);
    if (!merged.current || merged.current.verification !== "verified") {
      if (merged.status === "conflict") a.conflicts.push("Quota sources conflict: " + first.definition.id);
      unknown("Quota " + first.definition.id + " is " + merged.status + " or unverified."); continue;
    }
    const o = merged.current;
    a.provenance.push(...merged.observations.map(x => x.source));
    const sharedSubscription = first.definition.subscriptionId !== null && s.subscriptionLinks.filter(l => l.subscriptionId === first.definition.subscriptionId).length > 1;
    if (sharedSubscription && !quotaPoolKey(first)) unknown("Shared subscription has no verified quota pool identity.");
    const scope = first.definition.scope;
    if (scope !== "account" && scope !== "model:" + modelId && scope !== "harness:" + harnessId && !quotaPoolKey(first)) {
      unknown("Quota scope is not proven applicable to this candidate."); continue;
    }
    const demand = task.quotaDemands.find(d => states.some(q => q.definition.id === d.quotaId));
    if (o.remaining === null) unknown("Remaining capacity is unknown; percentage/limit alone is insufficient.");
    else if (o.remaining <= 0 || demand && demand.amount > o.remaining) {
      const reason = "Quota is exhausted or insufficient: " + first.definition.id;
      a.conflicts.push(reason); exclude(reason);
    }
    else {
      if (first.definition.unit.kind !== "concurrency" && !demand) unknown("Task demand for quota " + first.definition.id + " is unknown.");
      if (o.limit !== null && o.limit > 0) reserves.push(o.remaining / o.limit);
    }
    if (first.definition.unit.kind === "concurrency" && first.definition.window !== "instant") unknown("Concurrency evidence has no instantaneous window.");
  }
  if (reserves.length) a.ranking.reserve = Math.min(...reserves);
  const limits = s.limits.filter(l => limitApplies(l, c, s));
  if (!limits.some(l => l.scope.kind === "account")) unknown("Account-wide concurrency limit is unknown.");
  if (!limits.some(l => l.scope.kind === "global")) unknown("Global concurrency limit is unknown.");
  if (!s.occupancyComplete) unknown("Global run occupancy coverage is incomplete.");
  for (const limit of limits) {
    if (!currentFact(limit.limit, now) || !currentFact(limit.occupied, now)) { unknown("Concurrency limit or occupancy is unknown: " + limit.id); continue; }
    a.provenance.push(limit.limit.source, limit.occupied.source);
    const cap = limit.scope.kind === "global" && owner.globalConcurrency !== null
      ? limit.limit.value === "unbounded" ? owner.globalConcurrency : Math.min(limit.limit.value, owner.globalConcurrency)
      : limit.limit.value;
    if ((cap !== "unbounded" && (!Number.isSafeInteger(cap) || cap < 0))
      || !Number.isSafeInteger(limit.occupied.value) || limit.occupied.value < 0) {
      unknown("Concurrency values are invalid: " + limit.id); continue;
    }
    if (cap !== "unbounded" && limit.occupied.value >= cap) {
      const reason = "Concurrency capacity is occupied: " + limit.id;
      a.conflicts.push(reason); exclude(reason);
    }
  }
  if (a.status === "verified") a.reasons.push("All required eligibility, quota and concurrency checks have current verified evidence.");
  a.unknowns = unique(a.unknowns); a.provenance = unique(a.provenance);
  return a;
}

/** Pairwise preference only for comparable, confirmed metrics. No missing values become zero. */
function compare(a: CandidateAssessment, b: CandidateAssessment, policy: RoutingPolicy): number | null {
  const qa = a.ranking.quality, qb = b.ranking.quality;
  const ca = a.expectedCost, cb = b.expectedCost;
  const da = a.ranking.duration, db = b.ranking.duration;
  const q = qa && qb && qa.benchmark === qb.benchmark ? qb.score - qa.score : null;
  const c = ca && cb && ca.basis === cb.basis && ca.money.currency === cb.money.currency ? ca.money.minor - cb.money.minor : null;
  const d = da && db && da.basis === db.basis ? da.ms - db.ms : null;
  const r = a.ranking.reserve !== null && b.ranking.reserve !== null ? b.ranking.reserve - a.ranking.reserve : null;
  if (policy === "balanced") {
    // Pareto dominance across quality, incremental cost and duration, without invented weights.
    if (q === null || c === null || d === null) return null;
    if ([q,c,d].every(x => x <= 0) && [q,c,d].some(x => x < 0)) return -1;
    if ([q,c,d].every(x => x >= 0) && [q,c,d].some(x => x > 0)) return 1;
    return null;
  }
  return policy === "quality-first" ? q : policy === "cost-efficient" ? c : policy === "fastest-eligible" ? d : r;
}
export function routeTask(task: TaskRequirements, snapshot: RoutingSnapshot, policy: RoutingPolicy = "balanced", owner: OwnerRoutingConstraints = UNKNOWN_OWNER_CONSTRAINTS): RoutingPreview {
  const all = snapshot.candidates.map(c => assess(c, task, snapshot, owner)).sort((a,b) => a.candidate.id.localeCompare(b.candidate.id));
  const verified = all.filter(a => a.status === "verified");
  verified.sort((a,b) => compare(a,b,policy) ?? a.candidate.id.localeCompare(b.candidate.id));
  const best = verified.length === 1 ? verified[0]! : verified.find(a => verified.every(b => a === b || (compare(a,b,policy) ?? 0) < 0)) ?? null;
  const unknownInformation = unique(all.flatMap(a => a.unknowns));
  if (!all.length) unknownInformation.push("No configured resource candidates were supplied.");
  if (task.complexity === "unknown" && !unknownInformation.includes("Task complexity is unknown.")) unknownInformation.push("Task complexity is unknown.");
  if (verified.length > 1 && !best) unknownInformation.push("Policy cannot establish a unique winner from comparable verified characteristics.");
  return {
    status: best ? "recommended" : "no-verified-candidate", requirements: task, policy, ownerConstraints: owner,
    recommendedCandidate: best, conditionalCandidates: all.filter(a => a.status === "conditional"),
    excludedCandidates: all.filter(a => a.status === "excluded"), alternativeCandidates: verified.filter(a => a !== best),
    unknownInformation, requiredOwnerApproval: unique(all.flatMap(a => a.requiredOwnerApproval)),
    capturedAt: snapshot.capturedAt, readOnly: true, execution: "preview-only",
    revalidation: { requiredBeforeExecution: true, reservesResources: false,
      checks: ["Refresh authorization, bindings and model/effort support.", "Re-read quotas and shared pool identity after locks.", "Atomically recheck global/account/pool occupancy, Owner policy and approvals."] },
  };
}
/** Simulate competition without reservations/writes. Missing project priorities are not defaulted.
 * The provisional occupancy exists only within this call, never in Task Runtime. */
export function previewPortfolioRouting(requests: { requirements: TaskRequirements; owner: OwnerRoutingConstraints; policy: RoutingPolicy }[], snapshot: RoutingSnapshot) {
  const ordered = [...requests].sort((a,b) => {
    const ap = a.owner.projectPriority, bp = b.owner.projectPriority;
    return (ap === null ? 4 : priorityRank(ap)) - (bp === null ? 4 : priorityRank(bp)) || (a.requirements.priority && b.requirements.priority
      ? priorityRank(a.requirements.priority) - priorityRank(b.requirements.priority) : 0)
      || a.requirements.taskId.localeCompare(b.requirements.taskId);
  });
  const simulation: RoutingSnapshot = structuredClone(snapshot);
  const results: RoutingPreview[] = [];
  const unknownPriority = requests.some(r => r.owner.projectPriority === null);
  for (const request of ordered) {
    const preview = routeTask(request.requirements, simulation, request.policy, request.owner);
    if (unknownPriority && requests.length > 1) {
      preview.unknownInformation.push("Project priorities are incomplete; no cross-project allocation is recommended.");
      if (preview.recommendedCandidate) preview.alternativeCandidates.unshift(preview.recommendedCandidate);
      preview.recommendedCandidate = null; preview.status = "no-verified-candidate";
    }
    results.push(preview);
    const picked = simulation.candidates.find(c => c.id === preview.recommendedCandidate?.candidate.id);
    if (!picked) continue;
    for (const l of simulation.limits.filter(l => limitApplies(l, picked, simulation))) if (currentFact(l.occupied, simulation.capturedAt)) l.occupied.value++;
    const affected = relevantQuotas(simulation, picked, simulation.capturedAt);
    const pools = new Set(affected.map(quotaPoolKey).filter(x => x !== null));
    for (const q of simulation.quotas) {
      const direct = affected.some(x => x.definition.id === q.definition.id);
      if (!direct && !pools.has(quotaPoolKey(freshState(q, simulation.capturedAt)) ?? "")) continue;
      const demand = request.requirements.quotaDemands.find(d => d.quotaId === q.definition.id
        || affected.some(x => x.definition.id === d.quotaId && quotaPoolKey(x) !== null && quotaPoolKey(x) === quotaPoolKey(freshState(q, simulation.capturedAt))));
      const amount = q.definition.unit.kind === "concurrency" ? 1 : demand?.amount;
      if (amount === undefined) continue;
      q.observations = q.observations.map(o => ({ ...o, remaining: o.remaining === null ? null : Math.max(0, o.remaining - amount), used: o.used === null ? null : o.used + amount }));
    }
  }
  return { readOnly: true as const, execution: "preview-only" as const, previews: results };
}
