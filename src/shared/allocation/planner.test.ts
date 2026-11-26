import { describe, expect, test } from "bun:test";
import type { ExecutorOption, ExecutorRecommendations } from "../execution/executor-routing.ts";
import { DEFAULT_ALLOCATION_PLAN_POLICY } from "./types.ts";
import { pickAllocationResource, rankAllocationOptions } from "./planner.ts";

function option(partial: Partial<ExecutorOption> & Pick<ExecutorOption, "id" | "harnessId" | "modelId">): ExecutorOption {
  return {
    harnessLabel: partial.harnessId,
    kind: "codex",
    modelLabel: partial.modelId,
    classification: partial.classification ?? "verified-eligible",
    availability: partial.availability ?? "verified-available",
    evidence: "verified",
    why: partial.why ?? [],
    limitations: partial.limitations ?? [],
    evidenceSources: [],
    mode: partial.mode ?? { id: "auto", label: "Auto" },
    permission: null,
    preferred: partial.preferred ?? { harness: false, model: false },
    requiresOwnerConfirmation: true,
    selectable: partial.selectable ?? true,
    resource: partial.resource,
    ...partial,
  };
}

function rec(options: ExecutorOption[]): ExecutorRecommendations {
  const groups = { "verified-eligible": [], "potential-unknown": [], blocked: [], unsupported: [] } as ExecutorRecommendations["groups"];
  for (const o of options) groups[o.classification].push(o);
  return {
    readOnly: true,
    executionAvailable: false,
    groups,
    automaticRouter: { status: "no-verified-candidate", harnessId: null, modelId: null },
    automaticSelection: "none",
    ordering: { policy: "balanced", basis: "owner-preference-then-verified-evidence", rankedByQualityOrCost: false, note: "" },
    selection: null,
    preferences: { preferredHarnessId: null, preferredModel: null, allowedHarnessIds: null, forbiddenModels: [], requiredMode: null, policy: null },
    capturedAt: 1,
  };
}

test("ranking prefers owner-preferred-account reason first", () => {
  const a = option({ id: "a", harnessId: "h-b", modelId: "m1", why: [{ code: "owner-preferred-account", message: "pref" }] });
  const b = option({ id: "b", harnessId: "h-a", modelId: "m1" });
  const ranked = rankAllocationOptions([a, b], DEFAULT_ALLOCATION_PLAN_POLICY, "developer");
  expect(ranked[0]?.id).toBe("a");
});

test("unknown quota is disclosed and does not manufacture eligibility", () => {
  const unknown = option({
    id: "u",
    harnessId: "codex",
    modelId: "m1",
    classification: "potential-unknown",
    availability: "unknown",
    limitations: [{ code: "quota-unknown", message: "Quota is Unknown." }],
  });
  const { pick } = pickAllocationResource(rec([unknown]), DEFAULT_ALLOCATION_PLAN_POLICY, "developer", "codex");
  expect(pick?.unknownFacts).toContain("quota-unknown");
});

test("an explicit model is selected and a missing model is not replaced", () => {
  const gpt5 = option({ id: "gpt-5", harnessId: "codex-b", modelId: "gpt-5" });
  const sol = option({ id: "sol", harnessId: "codex-b", modelId: "gpt-6.1-sol" });
  const other = option({ id: "other", harnessId: "codex-a", modelId: "gpt-6.1-sol" });
  const picked = pickAllocationResource(rec([gpt5, sol, other]), DEFAULT_ALLOCATION_PLAN_POLICY, "reviewer", "codex-b", "gpt-6.1-sol");
  expect(picked.pick?.modelId).toBe("gpt-6.1-sol");
  expect(picked.pick?.harnessId).toBe("codex-b");
  const missing = pickAllocationResource(rec([gpt5]), DEFAULT_ALLOCATION_PLAN_POLICY, "reviewer", "codex-b", "gpt-6.1-sol");
  expect(missing.pick).toBeNull();
  expect(missing.blockingReason).toContain("gpt-6.1-sol");
  expect(missing.blockingReason).toContain("No substitute");
});

test("pickAllocationResource refuses when every option is blocked", () => {
  const blocked = option({ id: "x", harnessId: "codex", modelId: "m1", classification: "blocked", selectable: false, limitations: [{ code: "harness-disabled", message: "Disabled." }] });
  const { pick, blockingReason } = pickAllocationResource(rec([blocked]), DEFAULT_ALLOCATION_PLAN_POLICY, "developer");
  expect(pick).toBeNull();
  expect(blockingReason).toContain("Disabled");
});
