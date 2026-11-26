import { expect, test } from "bun:test";
import type { CandidateAssessment } from "../model-router/types.ts";
import { describePermissions, codexSandboxFor, layoutNeedsExternalGit, permissionSummary, WORKSPACE_LAYOUTS } from "./permissions.ts";
import {
  EMPTY_EXECUTOR_PREFERENCES,
  buildExecutorRecommendations,
  parseExecutorPreferences,
  readStoredExecutorPreferences,
  type BuildRecommendationsInput,
  type ExecutorHarnessSource,
} from "./executor-routing.ts";

const NOW = 5_000;
const assessment = (modelId: string, status: CandidateAssessment["status"], extra: Partial<CandidateAssessment> = {}): CandidateAssessment => ({
  candidate: { id: modelId, harnessId: "h", accountId: null, modelId, profileIds: [] },
  status, reasons: [], unknowns: [], provenance: [], expectedCost: null,
  thinkingEffort: { value: null, status: "conditional", reason: "" }, quotaEvidence: [], conflicts: [], requiredOwnerApproval: [],
  ranking: { quality: null, duration: null, reserve: null }, ...extra,
});
function source(id: string, over: Partial<ExecutorHarnessSource> = {}): ExecutorHarnessSource {
  return {
    harness: { id, kind: id === "codex" ? "codex" : "claude-code", label: id.toUpperCase(), enabled: true },
    cli: { available: true, loggedIn: null },
    models: [{ id: "m1", label: "M1" }],
    assessments: [], candidates: [],
    modesFor: () => [{ id: "ask", label: "Read-only" }, { id: "auto", label: "Auto" }],
    effortsFor: () => ["low", "high"],
    launchMode: () => "auto",
    permissionFor: () => null,
    ...over,
  };
}
const input = (sources: ExecutorHarnessSource[], over: Partial<BuildRecommendationsInput> = {}): BuildRecommendationsInput => ({
  now: NOW, preferences: EMPTY_EXECUTOR_PREFERENCES, task: { harnessId: "none", model: null }, requestedEffort: null,
  sources, routerPick: { harnessId: null, modelId: null }, selection: null, ...over,
});
const only = (r: ReturnType<typeof buildExecutorRecommendations>) => Object.values(r.groups).flat();

test("no evidence at all: every enabled option is potential with Unknown availability, never verified", () => {
  const r = buildExecutorRecommendations(input([source("a"), source("b")]));
  expect(r.groups["verified-eligible"]).toEqual([]);
  expect(r.groups["potential-unknown"].map((o) => o.harnessId)).toEqual(["A", "B"].map((x) => x.toLowerCase()));
  for (const o of r.groups["potential-unknown"]) {
    expect(o.availability).toBe("unknown");
    expect(o.requiresOwnerConfirmation).toBe(true);
    expect(o.selectable).toBe(true);
    expect(o.limitations.map((l) => l.code)).toEqual(expect.arrayContaining(["availability-unknown", "no-resource-evidence"]));
  }
  expect(r.automaticSelection).toBe("none");
  expect(r.automaticRouter.status).toBe("no-verified-candidate");
  expect(r.executionAvailable).toBe(false);
  expect(JSON.stringify(r)).not.toMatch(/"availability":"verified-available"/);
});

test("a verified router assessment is the only way into the verified class", () => {
  const r = buildExecutorRecommendations(input([source("a", { assessments: [assessment("m1", "verified")] }), source("b", { assessments: [assessment("m1", "conditional", { unknowns: ["Quota availability is unknown."] })] })],
    { routerPick: { harnessId: "a", modelId: "m1" } }));
  expect(r.groups["verified-eligible"].map((o) => o.harnessId)).toEqual(["a"]);
  expect(r.groups["verified-eligible"][0]!.availability).toBe("verified-available");
  expect(r.groups["potential-unknown"].map((o) => o.harnessId)).toEqual(["b"]);
  expect(r.automaticSelection).toBe("router-verified-only");
});

test("disabled, missing CLI, logged-out CLI and verified exhaustion are blocked, with the right availability", () => {
  const exhausted = assessment("m1", "excluded", {
    reasons: ["Quota is exhausted or insufficient: q"],
    quotaEvidence: [{ current: { verification: "verified", remaining: 0 } } as never],
    conflicts: ["Quota is exhausted or insufficient: q"],
  });
  const r = buildExecutorRecommendations(input([
    source("off", { harness: { id: "off", kind: "claude-code", label: "OFF", enabled: false } }),
    source("nocli", { cli: { available: false, loggedIn: null } }),
    source("out", { cli: { available: true, loggedIn: false } }),
    source("ex", { assessments: [exhausted] }),
  ]));
  const by = Object.fromEntries(r.groups.blocked.map((o) => [o.harnessId, o]));
  expect(Object.keys(by).sort()).toEqual(["ex", "nocli", "off", "out"]);
  expect(by.off!.availability).toBe("disabled");
  expect(by.nocli!.availability).toBe("not-installed");
  expect(by.out!.limitations[0]!.code).toBe("cli-logged-out");
  expect(by.ex!.availability).toBe("exhausted");
  expect(by.ex!.limitations[0]!.code).toBe("quota-exhausted");
  expect(only(r).filter((o) => !o.selectable).length).toBe(4);
});

test("a model excluded for one account stays potential when another account is only Unknown", () => {
  const r = buildExecutorRecommendations(input([source("a", { assessments: [assessment("m1", "excluded", { reasons: ["Account is archived or unavailable."] }), assessment("m1", "conditional")] })]));
  expect(r.groups.blocked).toEqual([]);
  expect(r.groups["potential-unknown"]).toHaveLength(1);
});

test("owner preferences: allow-list and forbidden models block, a missing required mode is unsupported, preferred options sort first", () => {
  const prefs = { ...EMPTY_EXECUTOR_PREFERENCES, allowedHarnessIds: ["a", "b"], forbiddenModels: ["bad"], requiredMode: "ask", preferredHarnessId: "b", preferredModel: "m2" };
  const r = buildExecutorRecommendations(input([
    source("a", { models: [{ id: "m1", label: "M1" }, { id: "bad", label: "Bad" }] }),
    source("b", { models: [{ id: "m1", label: "M1" }, { id: "m2", label: "M2" }] }),
    source("c"),
    source("noask", { modesFor: () => [{ id: "auto", label: "Auto" }] }),
  ], { preferences: prefs }));
  expect(r.groups.blocked.map((o) => `${o.harnessId}/${o.modelId}`).sort()).toEqual(["a/bad", "c/m1"].sort());
  expect(r.groups.blocked.find((o) => o.modelId === "bad")!.limitations.map((l) => l.code)).toContain("owner-model-forbidden");
  expect(r.groups.blocked.find((o) => o.harnessId === "c")!.limitations.map((l) => l.code)).toContain("owner-harness-not-allowed");
  expect(r.groups.unsupported.map((o) => o.harnessId)).toContain("noask");
  expect(r.groups.unsupported.find((o) => o.harnessId === "noask")!.limitations[0]!.code).toBe("required-mode-unsupported");
  const potential = r.groups["potential-unknown"];
  expect(`${potential[0]!.harnessId}/${potential[0]!.modelId}`).toBe("b/m2");
  expect(potential[0]!.preferred).toEqual({ harness: true, model: true });
  expect(potential[0]!.why.map((w) => w.code)).toEqual(expect.arrayContaining(["owner-preferred-harness", "owner-preferred-model"]));
});

test("an unsupported effort is unsupported, and structural problems win over Unknown", () => {
  const r = buildExecutorRecommendations(input([source("a")], { requestedEffort: "ultra" }));
  expect(r.groups.unsupported).toHaveLength(1);
  expect(r.groups.unsupported[0]!.availability).toBe("not-offered");
  expect(r.groups["potential-unknown"]).toEqual([]);
});

test("priority policy never invents an ordering: without comparable metrics it says so", () => {
  const r = buildExecutorRecommendations(input([source("a"), source("b")], { preferences: { ...EMPTY_EXECUTOR_PREFERENCES, policy: "quality-first" } }));
  expect(r.ordering.rankedByQualityOrCost).toBe(false);
  expect(r.ordering.note).toMatch(/did not change the order/);
  const balanced = buildExecutorRecommendations(input([source("a")]));
  expect(balanced.ordering.note).toMatch(/No model-quality, price or speed data is assumed/);
});

test("a blocked selection gets alternatives; they are suggestions only and never selected for the Owner", () => {
  const r = buildExecutorRecommendations(input([
    source("off", { harness: { id: "off", kind: "claude-code", label: "OFF", enabled: false } }),
    source("a"), source("b"),
  ], { selection: { harnessId: "off", model: "m1" } }));
  expect(r.selection!.classification).toBe("blocked");
  expect(r.selection!.alternatives.map((o) => o.harnessId)).toEqual(["a", "b"]);
  expect(r.automaticSelection).toBe("none");
  const fine = buildExecutorRecommendations(input([source("a")], { selection: { harnessId: "a", model: "m1" } }));
  expect(fine.selection!.alternatives).toEqual([]);
});

test("preferences parser is strict, and unreadable stored data reads as no preferences", () => {
  expect(parseExecutorPreferences({ forbiddenModels: ["b", "a", "a"], policy: "cost-efficient" })).toMatchObject({ forbiddenModels: ["a", "b"], policy: "cost-efficient", allowedHarnessIds: null });
  for (const bad of [null, [], { extra: 1 }, { policy: "cheap" }, { allowedHarnessIds: [] }, { preferredModel: "x\u0000" }, { forbiddenModels: "x" }, { requiredMode: "" }]) {
    expect(() => parseExecutorPreferences(bad)).toThrow();
  }
  expect(readStoredExecutorPreferences("{nope")).toEqual(EMPTY_EXECUTOR_PREFERENCES);
  expect(readStoredExecutorPreferences(null)).toEqual(EMPTY_EXECUTOR_PREFERENCES);
});

test("Codex decisions never silently escalate and fail closed for Unknown", () => {
  for (const layout of WORKSPACE_LAYOUTS) {
    const auto = describePermissions({ kind: "codex", mode: "auto", layout })!;
    expect(auto.sandbox).toBe("workspace-write");
    expect(auto.escalated).toBe(false);
    expect(auto.launchAllowed).toBe(layout !== "unknown" && !layoutNeedsExternalGit(layout));
    expect(auto.approval).toBe("never-asked");
    expect(auto.network).toBe("sandbox-disabled");
    const full = describePermissions({ kind: "codex", mode: "full-access", layout })!;
    expect(full.sandbox).toBe("danger-full-access");
    expect(full.network).toBe("unrestricted");
    expect(full.launchAllowed).toBe(layout !== "unknown");
  }
  expect(codexSandboxFor("auto", "linked-worktree")).toBe("workspace-write");
  expect(() => codexSandboxFor("unknown-mode", "repo-root")).toThrow();
  expect(describePermissions({ kind: "codex", mode: "unknown-mode", layout: "repo-root" })!.launchAllowed).toBe(false);
  expect(describePermissions({ kind: "claude-code", mode: "auto", layout: "repo-root" })).toBeNull();
  expect(permissionSummary(describePermissions({ kind: "codex", mode: "auto", layout: "repo-root" })!)).toContain("Network policy: disabled");
});

test("permission-blocked router pick cannot become automatic even when another verified executor exists", () => {
  const blocked = source("codex", {
    assessments: [assessment("m1", "verified")],
    permissionFor: () => describePermissions({ kind: "codex", mode: "auto", layout: "linked-worktree" }),
  });
  const other = source("other", { assessments: [assessment("m1", "verified")] });
  const out = buildExecutorRecommendations(input([blocked, other], { routerPick: { harnessId: "codex", modelId: "m1" } }));
  expect(out.groups.blocked[0]!.limitations.map((r) => r.code)).toContain("permission-owner-decision");
  expect(out.groups["verified-eligible"]).toHaveLength(1);
  expect(out.automaticSelection).toBe("none");
  expect(out.automaticRouter.harnessId).toBeNull();
});
