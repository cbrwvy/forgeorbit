import { describe, expect, test } from "bun:test";
import {
  calculateCandidateScores,
  eliminateCandidate,
  evaluateCandidates,
  type EvaluatorCandidateInput,
} from "./evaluator.ts";
import {
  type ProjectRouterPolicyConfig,
  type TaskRequirementsInput,
  DEFAULT_PRESET_WEIGHTS,
  DEFAULT_ROUTER_POLICY,
} from "./types.ts";

function createCandidate(overrides: Partial<EvaluatorCandidateInput> = {}): EvaluatorCandidateInput {
  return {
    id: JSON.stringify([overrides.harnessId ?? "codex", overrides.accountId ?? "acct-1", overrides.modelId ?? "gpt-6.1-sol", overrides.mode ?? "auto"]),
    harnessId: "codex",
    harnessLabel: "Codex Primary",
    kind: "codex",
    enabled: true,
    cliInstalled: true,
    cliLoggedIn: true,
    accountId: "acct-1",
    accountLabel: "Work Profile",
    provider: "openai",
    supportsRealMultiAccount: true,
    isolationType: "child-home",
    modelId: "gpt-6.1-sol",
    modelLabel: "GPT-6.1 Sol",
    mode: "auto",
    modeLabel: "Auto (sandboxed)",
    access: "workspace-write",
    qualityTier: "advanced",
    costMinor: 20,
    currency: "USD",
    measuredLatencyMs: 3500,
    latencySampleCount: 10,
    quotaState: {
      isUnknown: false,
      remainingPercent: 75,
      remainingUnits: 750,
      unitKind: "requests",
      isExhausted: false,
    },
    historyStats: {
      runCount: 12,
      successRate: 0.9,
      qcPassRate: 0.85,
      isSyntheticTest: false,
    },
    concurrency: {
      occupied: 0,
      limit: 2,
    },
    ...overrides,
  };
}

describe("Router 2.0 Evaluator — Candidate Elimination", () => {
  const basePolicy: ProjectRouterPolicyConfig = { ...DEFAULT_ROUTER_POLICY };
  const devTask: TaskRequirementsInput = {
    taskId: "t-1",
    projectId: "proj-alpha",
    role: "developer",
    complexity: "medium",
  };

  test("rejects Cursor due to internal sandbox/socket failure", () => {
    const cursor = createCandidate({
      harnessId: "cursor",
      kind: "cursor",
      modelId: "grok-4.7",
      isolationType: "ambient-keychain",
      supportsRealMultiAccount: false,
    });
    const res = eliminateCandidate(cursor, devTask, basePolicy);
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("cursor-internal-sandbox-unavailable"))).toBe(true);
  });

  test("rejects DeepSeek pending security integration", () => {
    const dsh = createCandidate({
      harnessId: "deepseek",
      kind: "deepseek-dsh",
      modelId: "deepseek-coder",
    });
    const res = eliminateCandidate(dsh, devTask, basePolicy);
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("deepseek-containment-blocked"))).toBe(true);
  });

  test("rejects Reviewer candidate if mode is not read-only", () => {
    const writeCand = createCandidate({ access: "workspace-write", mode: "auto" });
    const reviewerTask: TaskRequirementsInput = { ...devTask, role: "reviewer" };
    const res = eliminateCandidate(writeCand, reviewerTask, basePolicy);
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("reviewer-read-only-required"))).toBe(true);

    const readOnlyCand = createCandidate({ access: "read-only", mode: "ask" });
    const resReadOnly = eliminateCandidate(readOnlyCand, reviewerTask, basePolicy);
    expect(resReadOnly.eligible).toBe(true);
  });

  test("rejects Developer candidate if mode is not workspace-write", () => {
    const readOnlyCand = createCandidate({ access: "read-only", mode: "ask" });
    const res = eliminateCandidate(readOnlyCand, devTask, basePolicy);
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("developer-write-required"))).toBe(true);
  });

  test("rejects uninstalled or unauthenticated harness", () => {
    const uninstalled = createCandidate({ cliInstalled: false });
    expect(eliminateCandidate(uninstalled, devTask, basePolicy).eligible).toBe(false);

    const unauthed = createCandidate({ cliLoggedIn: false });
    expect(eliminateCandidate(unauthed, devTask, basePolicy).eligible).toBe(false);

    const disabled = createCandidate({ enabled: false });
    expect(eliminateCandidate(disabled, devTask, basePolicy).eligible).toBe(false);
  });

  test("rejects exhausted quota", () => {
    const exhausted = createCandidate({
      quotaState: { isUnknown: false, remainingPercent: 0, isExhausted: true },
    });
    const res = eliminateCandidate(exhausted, devTask, basePolicy);
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("quota-exhausted"))).toBe(true);
  });

  test("strict quota policy rejects unknown quota; permissive policy allows it", () => {
    const unknownQuota = createCandidate({
      quotaState: { isUnknown: true, remainingPercent: null },
    });

    const strictPolicy: ProjectRouterPolicyConfig = { ...basePolicy, quotaPolicy: "strict" };
    const resStrict = eliminateCandidate(unknownQuota, devTask, strictPolicy);
    expect(resStrict.eligible).toBe(false);
    expect(resStrict.reasons.some((r) => r.includes("quota-unknown-strict"))).toBe(true);

    const permissivePolicy: ProjectRouterPolicyConfig = { ...basePolicy, quotaPolicy: "permissive" };
    const resPermissive = eliminateCandidate(unknownQuota, devTask, permissivePolicy);
    expect(resPermissive.eligible).toBe(true);
  });
});

describe("Router 2.0 Evaluator — Scoring and Policies", () => {
  const basePolicy: ProjectRouterPolicyConfig = { ...DEFAULT_ROUTER_POLICY };

  test("Best Quality policy favors high quality flagship models for complex tasks", () => {
    const flagship = createCandidate({
      modelId: "gpt-6-astra",
      qualityTier: "flagship",
      costMinor: 80,
      measuredLatencyMs: 8000,
    });
    const economy = createCandidate({
      modelId: "gpt-6-luna",
      qualityTier: "economy",
      costMinor: 1,
      measuredLatencyMs: 1500,
    });

    const policy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      preset: "best-quality",
      weights: DEFAULT_PRESET_WEIGHTS["best-quality"],
    };

    const complexTask: TaskRequirementsInput = {
      taskId: "t-complex",
      projectId: "proj-alpha",
      role: "developer",
      complexity: "high",
      type: "architecture",
    };

    const res = evaluateCandidates([flagship, economy], complexTask, policy);
    expect(res.selected?.modelId).toBe("gpt-6-astra");
  });

  test("Lowest Cost policy favors cheap or economy models for simple tasks", () => {
    const flagship = createCandidate({
      modelId: "gpt-6-astra",
      qualityTier: "flagship",
      costMinor: 80,
      measuredLatencyMs: 8000,
    });
    const economy = createCandidate({
      modelId: "gpt-6-luna",
      qualityTier: "economy",
      costMinor: 1,
      measuredLatencyMs: 1500,
    });

    const policy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      preset: "lowest-cost",
      weights: DEFAULT_PRESET_WEIGHTS["lowest-cost"],
    };

    const simpleTask: TaskRequirementsInput = {
      taskId: "t-simple",
      projectId: "proj-alpha",
      role: "developer",
      complexity: "low",
      type: "documentation",
    };

    const res = evaluateCandidates([flagship, economy], simpleTask, policy);
    expect(res.selected?.modelId).toBe("gpt-6-luna");
  });

  test("Fastest policy prefers lowest measured latency", () => {
    const fast = createCandidate({
      modelId: "fast-model",
      measuredLatencyMs: 900,
      qualityTier: "standard",
    });
    const slow = createCandidate({
      modelId: "slow-model",
      measuredLatencyMs: 12000,
      qualityTier: "flagship",
    });

    const policy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      preset: "fastest",
      weights: DEFAULT_PRESET_WEIGHTS["fastest"],
    };

    const task: TaskRequirementsInput = {
      taskId: "t-fast",
      projectId: "proj-alpha",
      role: "developer",
    };

    const res = evaluateCandidates([slow, fast], task, policy);
    expect(res.selected?.modelId).toBe("fast-model");
  });

  test("Quota Saver policy prioritizes remaining quota allowance", () => {
    const lowQuota = createCandidate({
      modelId: "model-low-quota",
      quotaState: { isUnknown: false, remainingPercent: 10, remainingUnits: 5, unitKind: "req" },
      qualityTier: "flagship",
    });
    const healthyQuota = createCandidate({
      modelId: "model-healthy-quota",
      quotaState: { isUnknown: false, remainingPercent: 90, remainingUnits: 900, unitKind: "req" },
      qualityTier: "advanced",
    });

    const policy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      preset: "quota-saver",
      weights: DEFAULT_PRESET_WEIGHTS["quota-saver"],
    };

    const task: TaskRequirementsInput = {
      taskId: "t-quota",
      projectId: "proj-alpha",
      role: "developer",
    };

    const res = evaluateCandidates([lowQuota, healthyQuota], task, policy);
    expect(res.selected?.modelId).toBe("model-healthy-quota");
  });

  test("Custom weights adjust priority deterministically", () => {
    const candidateA = createCandidate({
      modelId: "cand-a",
      qualityTier: "flagship", // quality high
      costMinor: 100, // cost bad
    });
    const candidateB = createCandidate({
      modelId: "cand-b",
      qualityTier: "economy", // quality low
      costMinor: 0, // cost free
    });

    const customCostHeavy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      preset: "custom",
      weights: { quality: 5, cost: 90, latency: 5, quota: 0, history: 0 },
    };

    const task: TaskRequirementsInput = { taskId: "t-custom", projectId: "p", role: "developer" };
    expect(evaluateCandidates([candidateA, candidateB], task, customCostHeavy).selected?.modelId).toBe("cand-b");

    const customQualityHeavy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      preset: "custom",
      weights: { quality: 90, cost: 5, latency: 5, quota: 0, history: 0 },
    };
    expect(evaluateCandidates([candidateA, candidateB], task, customQualityHeavy).selected?.modelId).toBe("cand-a");
  });

  test("Manual override is preserved when eligible", () => {
    const candidateA = createCandidate({
      harnessId: "codex",
      modelId: "gpt-6-astra",
      qualityTier: "flagship",
    });
    const candidateB = createCandidate({
      harnessId: "claude-code",
      modelId: "opus-5.5",
      qualityTier: "flagship",
    });

    const taskWithOverride: TaskRequirementsInput = {
      taskId: "t-override",
      projectId: "p",
      role: "developer",
      requestedHarnessId: "claude-code",
      requestedModelId: "opus-5.5",
    };

    const res = evaluateCandidates([candidateA, candidateB], taskWithOverride, basePolicy);
    expect(res.selected?.harnessId).toBe("claude-code");
    expect(res.selected?.modelId).toBe("opus-5.5");
    expect(res.selected?.isManualOverride).toBe(true);
  });

  test("a requested account is not replaced when it is ineligible", () => {
    const wanted = createCandidate({ accountId: "acct-wanted", cliLoggedIn: false, accountLabel: "Wanted" });
    const other = createCandidate({ accountId: "acct-other", accountLabel: "Other", harnessId: "codex-profile-other" });
    const task: TaskRequirementsInput = {
      taskId: "t-pin",
      projectId: "p",
      role: "developer",
      requestedAccountId: "acct-wanted",
    };
    const res = evaluateCandidates([wanted, other], task, basePolicy);
    expect(res.selected).toBeNull();
    expect(res.accountPin).toEqual({ requestedAccountId: "acct-wanted", honored: false });
    expect(res.eligible.some((row) => row.accountId === "acct-other")).toBe(true);
  });
});

describe("Direction 16 — why nothing qualified, and what a refusal does not change", () => {
  const task: TaskRequirementsInput = { taskId: "t-d16", projectId: "p", role: "developer" };
  const strict: ProjectRouterPolicyConfig = { ...DEFAULT_ROUTER_POLICY, quotaPolicy: "strict" };
  const shortfall = (accountId: string) => createCandidate({
    accountId, harnessId: `h-${accountId}`,
    quotaState: { isUnknown: false, remainingPercent: 0, isExhausted: true, capacityEvidence: "verified-exhausted", unitKind: "requests" },
  });
  const unknownCapacity = (accountId: string) => createCandidate({
    accountId, harnessId: `h-${accountId}`,
    quotaState: { isUnknown: true, capacityEvidence: "unknown", unitKind: "requests" },
  });

  test("the explanation says a known shortfall and Unknown capacity apart, and never recommends", () => {
    const res = evaluateCandidates([shortfall("a"), unknownCapacity("b")], task, strict);
    expect(res.selected).toBeNull();
    expect(res.explanation).toContain("1 with a known capacity shortfall");
    expect(res.explanation).toContain("1 with Unknown capacity");
    expect(res.explanation).toContain("No eligible resource.");
    expect(res.authorizesExecution).toBe(false);
  });

  test("a refusal holds only its exact operation while capacity remains independent", () => {
    const refusal = { id: "r", kind: "usage-limit" as const, provider: "codex", harnessId: "h-a", accountId: "a", modelId: "gpt-6.1-sol", observedAt: 1, surface: "developer-run", proof: "codex-cli-usage-limit" as const, retryHint: null, supersededAt: null, diagnostics: "" };
    const plain = [createCandidate({ accountId: "a", harnessId: "h-a" }), createCandidate({ accountId: "b", harnessId: "h-b", costMinor: 40 }), unknownCapacity("c")];
    const refused = plain.map((candidate) => candidate.accountId === "a" ? { ...candidate, providerRefusal: refusal } : candidate);
    const without = evaluateCandidates(plain, task, DEFAULT_ROUTER_POLICY);
    const withIt = evaluateCandidates(refused, task, DEFAULT_ROUTER_POLICY);
    const ranking = (rows: typeof withIt.eligible) => rows.map(row => [row.candidateId, row.scores.totalScore]);
    expect(ranking(withIt.eligible)).toEqual(ranking(without.eligible.filter(row => row.accountId !== "a")));
    expect(withIt.selected?.accountId).not.toBe("a");
    expect(withIt.ineligible[0]?.eliminationReasons.join(" ")).toContain("provider-usage-limit:");
    expect(evaluateCandidates(refused, { ...task, requestedAccountId: "a" }, DEFAULT_ROUTER_POLICY).selected).toBeNull();
    // A refused account with Unknown capacity is still Unknown capacity, not a shortfall.
    const refusedUnknown = evaluateCandidates([{ ...unknownCapacity("a"), providerRefusal: refusal }], task, strict);
    expect(refusedUnknown.ineligible[0]!.eliminationReasons.join(" ")).toContain("quota-unknown-strict");
    expect(refusedUnknown.ineligible[0]!.eliminationReasons.join(" ")).not.toContain("quota-exhausted");
  });
});
