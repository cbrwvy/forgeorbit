import { expect, test } from "bun:test";
import { resolveQuota } from "../accounts/resolve.ts";
import type { Account, QuotaDefinition, QuotaObservation, Subscription } from "../accounts/types.ts";
import type { TrustedQuotaEvidence } from "../accounts/quota-sources.ts";
import { analyzeTaskRequirements } from "./requirements.ts";
import { EMPTY_MODEL_EVIDENCE, UNKNOWN_OWNER_CONSTRAINTS, previewPortfolioRouting, quotaPoolKey, routeTask } from "./route.ts";
import type { OwnerRoutingConstraints, ResourceCandidate, RoutingPolicy, RoutingSnapshot, TaskRequirements, VerifiedFact } from "./types.ts";

const now = 1_000_000;
const fact = <T>(value: T, extra = {}): VerifiedFact<T> => ({ value, verification: "verified", source: "fake-driver", observedAt: now - 1, expiresAt: now + 1000, ...extra });
const owner = (extra = {}): OwnerRoutingConstraints => ({ ...UNKNOWN_OWNER_CONSTRAINTS, spending: "allow-paid", projectPriority: "normal", ...extra });
const task = (extra = {}): TaskRequirements => analyzeTaskRequirements({ taskId: "task", projectId: "project", complexity: "medium", quotaDemands: [{ quotaId: "q:a", amount: 1 }], ...extra });
const account = (id = "a"): Account => ({ id, provider: "fake", displayName: id, externalIdentity: null, availability: "available", provenance: "user-provided", verification: "unverified", source: "manual", createdAt: 1, updatedAt: 1, archivedAt: null });
function candidate(id = "c", accountId = "a", harnessId = "h"): ResourceCandidate {
  return { id, accountId, harnessId, modelId: "m", enabled: true, profileIds: ["profile:" + id],
    authorization: fact(true), availability: fact(true), billing: fact({ paidApi: "no", overage: "none", reasons: ["fake billing evidence"] }),
    support: { accountId, harnessId, modelId: "m", support: "supported", source: "fake-driver", provenance: "verified", verification: "verified", observedAt: now - 1, expiresAt: now + 1000 },
    evidence: { ...EMPTY_MODEL_EVIDENCE, efforts: fact(["small", "standard", "deep"]),
      quality: fact({ benchmark: "backend-fixture-v1", score: 80 }),
      expectedCost: fact({ taskId: "task", basis: "task-estimate-v1", money: { currency: "USD", minor: 10 } }),
      durationMs: fact({ taskId: "task", basis: "task-duration-v1", ms: 100 }) },
  };
}
function quota(id = "q:a", accountId = "a", values: Partial<QuotaObservation> = {}, definition: Partial<QuotaDefinition> = {}) {
  const d: QuotaDefinition = { id, accountId, subscriptionId: null, scope: "account", unit: { kind: "requests" }, window: "week", createdAt: 1, archivedAt: null, ...definition };
  const o: QuotaObservation = { id: "o:" + id, quotaId: id, source: "fake-driver", verification: "verified", provenance: "verified", observedAt: now - 1, expiresAt: now + 1000, resetAt: null, limit: 10, used: 0, remaining: 10, indicator: null, confidence: "high", ...values };
  return resolveQuota(d, [o], now);
}
function snapshot(candidates = [candidate()]): RoutingSnapshot {
  const ids = [...new Set(candidates.flatMap(c => c.accountId ? [c.accountId] : []))];
  return { capturedAt: now, candidates, accounts: ids.map(id => account(id)), bindings: candidates.flatMap(c => c.accountId ? [{ accountId: c.accountId, harnessId: c.harnessId, createdAt: 1, provenance: "user-provided" as const, verification: "unverified" as const, source: "manual" }] : []),
    subscriptions: [], subscriptionLinks: [], quotas: ids.map(id => quota("q:" + id, id)), occupancyComplete: true,
    limits: [{ id: "global", scope: { kind: "global" }, limit: fact(4), occupied: fact(0) },
      ...ids.map(id => ({ id: "account:" + id, scope: { kind: "account" as const, id }, limit: fact<number | "unbounded">(1), occupied: fact(0) }))] };
}
const route = (s = snapshot(), t = task(), p: RoutingPolicy = "balanced", o = owner()) => routeTask(t, s, p, o);
const only = (r: ReturnType<typeof route>) => r.recommendedCandidate ?? r.conditionalCandidates[0] ?? r.excludedCandidates[0]!;
test("simple vs complex use only confirmed model/harness effort vocabulary", () => {
  expect(only(route(snapshot(), task({ complexity: "low" }))).thinkingEffort.value).toBe("small");
  expect(only(route(snapshot(), task({ complexity: "very-high" }))).thinkingEffort.value).toBe("deep");
  expect(only(route(snapshot(), task({ complexity: "high" }))).thinkingEffort.value).toBe("standard");
});
test("unknown complexity is preserved without prompt/name/priority inference", () => {
  const t = analyzeTaskRequirements({ taskId: "very complex architecture", projectId: "p", priority: "critical" });
  expect(t.complexity).toBe("unknown");
  expect(route(snapshot(), t).status).toBe("no-verified-candidate");
  expect(only(route(snapshot(), t)).thinkingEffort.value).toBeNull();
});
test("multiple harnesses and accounts have independent verified model support", () => {
  const c = candidate("better", "b", "h2");
  c.evidence.quality = fact({ benchmark: "backend-fixture-v1", score: 90 });
  const s = snapshot([candidate(), c]);
  const t = task({ quotaDemands: [{ quotaId: "q:a", amount: 1 }, { quotaId: "q:b", amount: 1 }] });
  expect(route(s, t, "quality-first").recommendedCandidate?.candidate.id).toBe("better");
  expect(route(s,t,"quality-first").alternativeCandidates).toHaveLength(1);
});
test("declared capability cannot become supported; model names never imply quality", () => {
  const s = snapshot(); s.candidates[0]!.support!.verification = "unverified";
  s.candidates[0]!.modelId = "legendary-high-quality-ultra";
  expect(route(s).recommendedCandidate).toBeNull();
  expect(route(s).conditionalCandidates).toHaveLength(1);
});
test("verified vs declared required capability, tool, context and permissions", () => {
  const s = snapshot(), c = s.candidates[0]!;
  const t = task({ capabilities: ["backend"], tools: ["sqlite"], contextTokens: 8000, requiredPermissions: ["read"], allowedPermissions: ["read"] });
  c.evidence.capabilities = fact(["backend"], { verification: "unverified" });
  c.evidence.tools = fact(["sqlite"]); c.evidence.permissions = fact(["read"]); c.evidence.contextTokens = fact(16000);
  expect(route(s,t).conditionalCandidates).toHaveLength(1);
  c.evidence.capabilities = fact(["backend"]);
  expect(route(s,t).status).toBe("recommended");
  c.evidence.permissions = fact(["read", "shell"]);
  expect(route(s,t).excludedCandidates[0]!.reasons.join()).toContain("exceed");
});
test("unknown support, unsupported model and stale support have distinct results", () => {
  const s = snapshot(); s.candidates[0]!.support = null;
  expect(route(s).conditionalCandidates).toHaveLength(1);
  s.candidates[0]!.support = { ...candidate().support!, support: "unsupported" };
  expect(route(s).excludedCandidates).toHaveLength(1);
  s.candidates[0]!.support!.expiresAt = now;
  expect(route(s).conditionalCandidates).toHaveLength(1);
});
test("unsupported effort is never emitted; no-parameter models remain usable", () => {
  const s = snapshot(); s.candidates[0]!.evidence.efforts = null;
  expect(only(route(s)).thinkingEffort).toMatchObject({ value: null, status: "conditional" });
  s.candidates[0]!.evidence.efforts = fact([]);
  expect(only(route(s)).thinkingEffort).toMatchObject({ value: null, status: "not-applicable" });
  expect(route(s).status).toBe("recommended");
});
test("available, exhausted and insufficient demand quota", () => {
  expect(route().status).toBe("recommended");
  const s = snapshot(); s.quotas = [quota("q:a", "a", { remaining: 0 })];
  expect(route(s).excludedCandidates[0]!.reasons.join()).toContain("exhausted");
  s.quotas = [quota("q:a", "a", { remaining: 1 })];
  expect(route(s,task({ quotaDemands: [{ quotaId: "q:a", amount: 2 }] })).excludedCandidates).toHaveLength(1);
});
test("unknown quota, unknown demand and percent usage are not free capacity", () => {
  const s = snapshot(); s.quotas = [];
  expect(route(s).conditionalCandidates).toHaveLength(1);
  s.quotas = [quota("q:a", "a", { remaining: null, indicator: { kind: "percent-used", value: 0 } })];
  expect(route(s).conditionalCandidates).toHaveLength(1);
  expect(route(snapshot(),task({ quotaDemands: [] })).conditionalCandidates).toHaveLength(1);
});
test("stale and reset evidence cannot authorize a recommendation", () => {
  for (const values of [{ expiresAt: now }, { expiresAt: null }, { resetAt: now }, { observedAt: now + 1 }]) {
    const s = snapshot(); s.quotas = [quota("q:a", "a", values)];
    expect(route(s).status).toBe("no-verified-candidate");
  }
});
test("conflicting current quota sources do not silently overwrite one another", () => {
  const s = snapshot(), q = s.quotas[0]!;
  q.observations.push({ ...q.observations[0]!, id: "other", source: "second", remaining: 0 });
  expect(only(route(s)).quotaEvidence[0]!.status).toBe("conflict");
  expect(route(s).recommendedCandidate).toBeNull();
});
const sub: Subscription = { id: "sub", provider: "fake", planLabel: "same-label", currency: null, recurringCostMinor: null, billingPeriod: "unknown", renewsAt: null, resetsAt: null, source: "manual", provenance: "user-provided", verification: "unverified", createdAt: 1, updatedAt: 1, archivedAt: null };
function shared() {
  const s = snapshot([candidate("a","a"),candidate("b","b","h2")]);
  s.subscriptions = [sub]; s.subscriptionLinks = [{ accountId: "a", subscriptionId: "sub" }, { accountId: "b", subscriptionId: "sub" }];
  s.quotas.forEach(q => { q.definition.subscriptionId = "sub"; });
  return s;
}
function pool(accountId: string): TrustedQuotaEvidence {
  return { provider: "fake", accountId, subject: "fixture", method: "organization-member", sourceId: "fake", officialUrl: "https://example.invalid", checkedAt: "2026-10-24", receivedAt: now - 1, sharedPool: { id: "pool", scope: "account", window: "week", verified: true }, limitations: "fake" };
}
test("shared subscription alone is not proof of a shared quota pool", () => {
  const s = shared();
  expect(route(s).recommendedCandidate).toBeNull();
  expect(only(route(s)).unknowns.join()).toContain("pool identity");
});
test("verified shared pool reports conflict across accounts rather than multiplying capacity", () => {
  const s = shared();
  s.quotas = [quota("q:a","a",{ acquisition: pool("a") },{ subscriptionId:"sub" }),
    quota("q:b","b",{ acquisition: pool("b"), remaining: 0 },{ subscriptionId:"sub" })];
  const r = route(s);
  expect(r.recommendedCandidate).toBeNull();
  expect(r.conditionalCandidates.every(c => c.unknowns.some(x => x.includes("conflict")))).toBe(true);
  expect(quotaPoolKey(s.quotas[0]!)).toBe(quotaPoolKey(s.quotas[1]!));
});
test("pool identity includes provider, scope, window and exact units", () => {
  const a = quota("q:a","a",{ acquisition: pool("a") });
  const b = quota("q:b","b",{ acquisition: { ...pool("b"), provider: "other" } });
  expect(quotaPoolKey(a)).not.toBe(quotaPoolKey(b));
  b.current!.acquisition = pool("b"); b.definition.unit = { kind:"tokens" };
  expect(quotaPoolKey(a)).not.toBe(quotaPoolKey(b));
});
test("account concurrency is shared across harnesses and global capacity blocks every account", () => {
  const s = snapshot([candidate("a"), candidate("b","a","other")]);
  s.limits.find(l => l.id === "account:a")!.occupied = fact(1);
  expect(route(s).excludedCandidates).toHaveLength(2);
  s.limits.find(l => l.id === "account:a")!.occupied = fact(0);
  s.limits[0]!.occupied = fact(4);
  expect(route(s).excludedCandidates).toHaveLength(2);
});
test("unknown occupancy and missing caps stay conditional", () => {
  const s = snapshot(); s.occupancyComplete = false;
  expect(route(s).conditionalCandidates).toHaveLength(1);
  s.occupancyComplete = true; s.limits = [];
  expect(route(s).conditionalCandidates).toHaveLength(1);
});
test("Owner allowlists, spending, budget, approval and global limit are retained", () => {
  expect(route(snapshot(),task(),"balanced",owner({ allowedHarnesses: [] })).excludedCandidates).toHaveLength(1);
  expect(route(snapshot(),task(),"balanced",owner({ allowedAccounts: ["other"] })).excludedCandidates).toHaveLength(1);
  expect(route(snapshot(),task(),"balanced",owner({ spending:"no-extra" })).excludedCandidates).toHaveLength(1);
  expect(route(snapshot(),task(),"balanced",owner({ maxExpectedCost:{currency:"USD",minor:1} })).excludedCandidates).toHaveLength(1);
  expect(route(snapshot(),task(),"balanced",owner({ maxExpectedCost:{currency:"EUR",minor:100} })).conditionalCandidates).toHaveLength(1);
  expect(route(snapshot(),task(),"balanced",owner({ globalConcurrency:0 })).excludedCandidates).toHaveLength(1);
  expect(route(snapshot(),task(),"balanced",owner({ requiredApprovals:["budget-review"] })).requiredOwnerApproval).toEqual(["budget-review"]);
});
function ranked() {
  const a = candidate("best"), b = candidate("other");
  b.evidence.quality = fact({ benchmark:"backend-fixture-v1",score:70 });
  b.evidence.expectedCost = fact({taskId:"task",basis:"task-estimate-v1",money:{currency:"USD",minor:20}});
  b.evidence.durationMs = fact({taskId:"task",basis:"task-duration-v1",ms:200});
  return snapshot([a,b]);
}
for (const policy of ["quality-first","balanced","cost-efficient","fastest-eligible"] as const) test(policy + " compares supported characteristics", () => {
  expect(route(ranked(),task(),policy).recommendedCandidate?.candidate.id).toBe("best");
});
test("preserve-limited-resources compares observed reserve; no invented quality rating", () => {
  const s = snapshot([candidate("a","a"),candidate("b","b")]); s.quotas[0] = quota("q:a","a",{remaining:2});
  const t = task({quotaDemands:[{quotaId:"q:a",amount:1},{quotaId:"q:b",amount:1}]});
  expect(route(s,t,"preserve-limited-resources").recommendedCandidate?.candidate.id).toBe("b");
});
test("balanced tradeoffs, missing metrics and incomparable benchmarks never choose an ID arbitrarily", () => {
  const s = ranked(); s.candidates[1]!.evidence.expectedCost!.value.money.minor = 1;
  expect(route(s).recommendedCandidate).toBeNull();
  s.candidates[0]!.evidence.quality = null;
  expect(route(s,task(),"quality-first").recommendedCandidate).toBeNull();
  s.candidates[0]!.evidence.quality = fact({benchmark:"unrelated",score:999});
  expect(route(s,task(),"quality-first").recommendedCandidate).toBeNull();
});
test("fallback selects remaining verified candidate when the preferred one is exhausted", () => {
  const s = snapshot([candidate("primary","a"),candidate("fallback","b")]);
  s.quotas[0] = quota("q:a","a",{remaining:0});
  const r = route(s,task({quotaDemands:[{quotaId:"q:a",amount:1},{quotaId:"q:b",amount:1}]}));
  expect(r.recommendedCandidate?.candidate.id).toBe("fallback");
  expect(r.excludedCandidates[0]!.candidate.id).toBe("primary");
});
test("empty snapshot reports No Verified Candidate without a random resource", () => {
  expect(route(snapshot([]))).toMatchObject({status:"no-verified-candidate",recommendedCandidate:null});
});
test("portfolio preview honors project priority and simulates one shared account slot", () => {
  const s = snapshot(), original = structuredClone(s);
  const r = previewPortfolioRouting([
    {requirements:task({taskId:"low",projectId:"low"}),owner:owner({projectPriority:"low"}),policy:"balanced"},
    {requirements:task({taskId:"high",projectId:"high"}),owner:owner({projectPriority:"high"}),policy:"balanced"},
  ], s);
  expect(r.previews[0]!.requirements.taskId).toBe("high");
  expect(r.previews[0]!.status).toBe("recommended");
  expect(r.previews[1]!.excludedCandidates).toHaveLength(1);
  expect(s).toEqual(original);
});
test("portfolio unknown priority withholds a cross-project allocation", () => {
  const r = previewPortfolioRouting(["a","b"].map(taskId => ({requirements:task({taskId}),owner:owner({projectPriority:null}),policy:"balanced" as const})),snapshot());
  expect(r.previews.every(p => p.recommendedCandidate === null)).toBe(true);
});
test("preview never mutates snapshot, executes, switches accounts or reserves capacity", () => {
  const s = snapshot(), t = task(), o = owner(), original = structuredClone({s,t,o});
  const r = route(s,t,"balanced",o);
  expect({s,t,o}).toEqual(original);
  expect(r.execution).toBe("preview-only");
  expect(r.revalidation).toMatchObject({requiredBeforeExecution:true,reservesResources:false});
  expect(JSON.stringify(r)).not.toContain("employee");
});
test("billing restrictions reuse existing spending semantics rather than treating overage as paid API consent", () => {
  const s = snapshot();s.candidates[0]!.billing = fact({paidApi:"yes",overage:"none",reasons:["Fake paid API"]});
  expect(route(s,task(),"balanced",owner({spending:"allow-overage"})).excludedCandidates).toHaveLength(1);
  expect(route(s,task(),"balanced",owner({spending:"allow-paid"})).requiredOwnerApproval.join()).toContain("Fake paid API");
  s.candidates[0]!.billing = null;
  expect(route(s).conditionalCandidates).toHaveLength(1);
});
test("portfolio shared pool is consumed once across accounts, with no oversubscribed second recommendation", () => {
  const s = shared();
  s.quotas = [quota("q:a","a",{ acquisition:pool("a"),remaining:1 },{subscriptionId:"sub"}),
    quota("q:b","b",{ acquisition:pool("b"),remaining:1 },{subscriptionId:"sub"})];
  const requests = ["a","b"].map((id,i) => ({
    requirements:task({taskId:id,projectId:id,quotaDemands:[{quotaId:"q:"+id,amount:1}]}),
    owner:owner({projectPriority:i===0?"high":"low",allowedAccounts:[id]}),
    policy:"balanced" as const,
  }));
  const before = structuredClone(s);
  const result = previewPortfolioRouting(requests,s);
  expect(result.previews[0]!.recommendedCandidate?.candidate.accountId).toBe("a");
  expect(result.previews[1]!.recommendedCandidate).toBeNull();
  expect(result.previews[1]!.excludedCandidates.find(c=>c.candidate.accountId==="b")!.reasons.join()).toContain("exhausted");
  expect(s).toEqual(before);
});
test("irrelevant known model-specific quota cannot exclude another model", () => {
  const s = snapshot();
  s.quotas.push(quota("other","a",{remaining:0},{scope:"model:unrelated"}));
  expect(route(s).status).toBe("recommended");
});
test("invalid concurrency values cannot pass as free capacity", () => {
  for (const cap of [NaN,-1,1.5]) {
    const s = snapshot(); s.limits[0]!.limit=fact(cap);
    expect(route(s).status).toBe("no-verified-candidate");
  }
});

test("cost and duration estimates for another task cannot be reused as confirmed characteristics", () => {
  const s = snapshot();
  const r = route(s,task({taskId:"different-task"}));
  expect(only(r).expectedCost).toBeNull();
  expect(only(r).ranking.duration).toBeNull();
  expect(only(r).unknowns.join()).toContain("cost is unknown");
});
