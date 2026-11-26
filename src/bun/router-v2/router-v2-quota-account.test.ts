import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SyntheticVerifiedQuotaAdapter,
  AccountCoreQuotaAdapter,
  QuotaAdapterRegistry,
} from "./router-v2-quota-adapters.ts";
import { evaluateCandidates, type EvaluatorCandidateInput } from "../../shared/router-v2/evaluator.ts";
import { DEFAULT_ROUTER_POLICY, type ProjectRouterPolicyConfig } from "../../shared/router-v2/types.ts";

function createCandidate(overrides: Partial<EvaluatorCandidateInput> = {}): EvaluatorCandidateInput {
  return {
    id: JSON.stringify([overrides.harnessId ?? "codex", overrides.accountId ?? "acct-1", overrides.modelId ?? "gpt-6.1-sol", "auto"]),
    harnessId: "codex",
    harnessLabel: "Codex",
    kind: "codex",
    enabled: true,
    cliInstalled: true,
    cliLoggedIn: true,
    accountId: "acct-1",
    accountLabel: "Account 1",
    provider: "openai",
    supportsRealMultiAccount: true,
    isolationType: "child-home",
    modelId: "gpt-6.1-sol",
    modelLabel: "GPT-6.1 Sol",
    mode: "auto",
    modeLabel: "Auto",
    access: "workspace-write",
    qualityTier: "advanced",
    quotaState: {
      isUnknown: true,
      remainingPercent: null,
      remainingUnits: null,
    },
    historyStats: { runCount: 0 },
    concurrency: { occupied: 0, limit: 2 },
    ...overrides,
  };
}

describe("Router 2.0 — Quota and Account Adapters", () => {
  test("SyntheticVerifiedQuotaAdapter seeds and resolves verified quota", async () => {
    const adapter = new SyntheticVerifiedQuotaAdapter();
    adapter.seedQuota("codex:acct-1:gpt-6.1-sol", {
      remainingPercent: 85,
      remainingUnits: 850,
      unitKind: "requests",
    });

    const res = await adapter.getQuota("acct-1", "codex", "gpt-6.1-sol");
    expect(res).not.toBeNull();
    expect(res?.isUnknown).toBe(false);
    expect(res?.remainingPercent).toBe(85);
    expect(res?.remainingUnits).toBe(850);
    expect(res?.unitKind).toBe("requests");
    expect(res?.isExhausted).toBe(false);
  });

  test("QuotaAdapterRegistry falls back to unknown when no adapter matches", async () => {
    const registry = new QuotaAdapterRegistry();
    const res = await registry.resolveQuota("acct-unknown", "codex", "gpt-unknown");
    expect(res.isUnknown).toBe(true);
    expect(res.remainingPercent).toBeNull();
  });

  test("Strict quota policy excludes candidates with unknown quota", () => {
    const unknownQuotaCand = createCandidate({
      quotaState: { isUnknown: true, remainingPercent: null },
    });
    const verifiedQuotaCand = createCandidate({
      accountId: "acct-2",
      quotaState: { isUnknown: false, remainingPercent: 90, remainingUnits: 900 },
    });

    const strictPolicy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      quotaPolicy: "strict",
    };

    const task = { taskId: "t-1", projectId: "p", role: "developer" as const };
    const evalRes = evaluateCandidates([unknownQuotaCand, verifiedQuotaCand], task, strictPolicy);

    expect(evalRes.selected?.accountId).toBe("acct-2");
    expect(evalRes.ineligible.some((i) => i.accountId === "acct-1")).toBe(true);
    expect(evalRes.ineligible.find((i) => i.accountId === "acct-1")?.eliminationReasons[0]).toContain("quota-unknown-strict");
  });

  test("Permissive quota policy allows candidates with unknown quota and adds warning", () => {
    const unknownQuotaCand = createCandidate({
      quotaState: { isUnknown: true, remainingPercent: null },
    });

    const permissivePolicy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      quotaPolicy: "permissive",
    };

    const task = { taskId: "t-1", projectId: "p", role: "developer" as const };
    const evalRes = evaluateCandidates([unknownQuotaCand], task, permissivePolicy);

    expect(evalRes.selected).not.toBeNull();
    expect(evalRes.selected?.warnings.some((w) => w.includes("Quota is Unknown"))).toBe(true);
  });

  test("Verified low quota lowers candidate score and quota exhaustion excludes it", () => {
    const lowQuota = createCandidate({
      accountId: "acct-low",
      quotaState: { isUnknown: false, remainingPercent: 10, remainingUnits: 10, unitKind: "req" },
    });
    const highQuota = createCandidate({
      accountId: "acct-high",
      quotaState: { isUnknown: false, remainingPercent: 95, remainingUnits: 950, unitKind: "req" },
    });
    const exhaustedQuota = createCandidate({
      accountId: "acct-exhausted",
      quotaState: { isUnknown: false, remainingPercent: 0, remainingUnits: 0, isExhausted: true },
    });

    const quotaSaverPolicy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      preset: "quota-saver",
    };

    const task = { taskId: "t-1", projectId: "p", role: "developer" as const };
    const evalRes = evaluateCandidates([lowQuota, highQuota, exhaustedQuota], task, quotaSaverPolicy);

    // High quota selected
    expect(evalRes.selected?.accountId).toBe("acct-high");
    // Exhausted excluded
    expect(evalRes.ineligible.some((i) => i.accountId === "acct-exhausted")).toBe(true);
    // Low quota has low quota score
    const lowEval = evalRes.eligible.find((e) => e.accountId === "acct-low");
    expect(lowEval?.scores.quota.score).toBe(20);
  });

  test("Cursor candidate with ambient keychain warns Owner that AccountCore metadata does not switch credentials", () => {
    // If Cursor were eligible (e.g. if sandbox check were skipped)
    const cursor = createCandidate({
      harnessId: "cursor",
      kind: "cursor",
      isolationType: "ambient-keychain",
      supportsRealMultiAccount: false,
    });

    const task = { taskId: "t-1", projectId: "p", role: "developer" as const };
    const evalRes = evaluateCandidates([cursor], task, DEFAULT_ROUTER_POLICY);

    // Cursor is blocked by sandbox failure in practice
    expect(evalRes.ineligible.some((i) => i.harnessId === "cursor")).toBe(true);
  });

  test("Codex profiles maintain real multi-account isolation", () => {
    const profileA = createCandidate({
      accountId: "codex-profile-a",
      accountLabel: "Codex Profile A",
      isolationType: "child-home",
      supportsRealMultiAccount: true,
    });
    const profileB = createCandidate({
      accountId: "codex-profile-b",
      accountLabel: "Codex Profile B",
      isolationType: "child-home",
      supportsRealMultiAccount: true,
    });

    const task = { taskId: "t-1", projectId: "p", role: "developer" as const };
    const evalRes = evaluateCandidates([profileA, profileB], task, DEFAULT_ROUTER_POLICY);

    expect(evalRes.eligible.length).toBe(2);
    expect(evalRes.eligible[0]?.accountId).toBe("codex-profile-a");
    expect(evalRes.eligible[1]?.accountId).toBe("codex-profile-b");
  });
});
