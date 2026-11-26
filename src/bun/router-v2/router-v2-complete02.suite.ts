/**
 * One disposable company for FO-ROUTER-COMPLETE02.
 * Fake drivers and in-memory routing stubs only. No provider inference.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eliminateCandidate, evaluateCandidates, type EvaluatorCandidateInput } from "../../shared/router-v2/evaluator.ts";
import { DEFAULT_PRESET_WEIGHTS, DEFAULT_ROUTER_POLICY, type ProjectRouterPolicyConfig, type RouterPolicyPreset } from "../../shared/router-v2/types.ts";
import { fallbackDigest, type FallbackProposal } from "../../shared/router-v2/resource-decision.ts";
import { searchAllocation, type AllocationStage } from "../../shared/orchestration/allocation-search.ts";
import { evaluateApplicablePolicies, normalizePolicyBody } from "../../shared/autonomy-policy.ts";
import { makeTask } from "../../cli/test-fixtures.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-router-complete02-")));
process.env.AGETOR_DATA_DIR = root;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_API_PORT = "0";

let db: typeof import("../db.ts");
let scheduler: typeof import("../orchestration/mission-scheduler.ts");
let head: typeof import("../orchestration/head-pm-integration.ts");
let router: typeof import("./router-v2-service.ts");
const projects: string[] = [];
const taskIds: string[] = [];

function candidate(overrides: Partial<EvaluatorCandidateInput>): EvaluatorCandidateInput {
  return {
    id: overrides.id ?? "candidate",
    harnessId: overrides.harnessId ?? "codex",
    harnessLabel: overrides.harnessLabel ?? "Codex",
    kind: overrides.kind ?? "codex",
    enabled: true,
    cliInstalled: true,
    cliLoggedIn: true,
    accountId: overrides.accountId === undefined ? "acct-a" : overrides.accountId,
    accountLabel: "Account",
    provider: overrides.provider ?? "openai",
    supportsRealMultiAccount: true,
    isolationType: "child-home",
    modelId: overrides.modelId ?? "gpt-6.1-sol",
    modelLabel: overrides.modelLabel ?? "Sol",
    mode: overrides.mode ?? "auto",
    modeLabel: "Auto",
    access: overrides.access ?? "workspace-write",
    qualityTier: overrides.qualityTier ?? "advanced",
    costMinor: overrides.costMinor === undefined ? 20 : overrides.costMinor,
    currency: "USD",
    billing: "api",
    quotaState: overrides.quotaState ?? { isUnknown: false, capacityEvidence: "verified-headroom", remainingPercent: 80 },
    historyStats: overrides.historyStats ?? { runCount: 0, isSyntheticTest: false, comparable: false },
    concurrency: { occupied: 0, limit: 2 },
    ...overrides,
  };
}

beforeAll(async () => {
  db = await import("../db.ts");
  scheduler = await import("../orchestration/mission-scheduler.ts");
  head = await import("../orchestration/head-pm-integration.ts");
  router = await import("./router-v2-service.ts");
  for (const id of ["cluster-a", "cluster-b", "cluster-c"]) {
    db.db.run(
      "INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, id, id, id, Date.now(), Date.now()],
    );
  }
  for (let index = 1; index <= 5; index++) {
    const dir = path.join(root, `project-${index}`);
    mkdirSync(dir, { recursive: true });
    db.projects.upsert(dir, `Project ${index}`);
    projects.push(dir);
    db.db.run(
      "INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)",
      [dir, ["cluster-a", "cluster-b", "cluster-c"][(index - 1) % 3]!, Date.now(), Date.now()],
    );
  }
  for (let index = 0; index < 20; index++) {
    const id = `company-task-${index}`;
    const project = projects[index % 5]!;
    db.tasks.insert(makeTask({
      id, title: `Company task ${index}`, prompt: "synthetic", workdir: project, column: "backlog",
      agent: index % 2 === 0 ? "codex" : "claude-code", model: index % 2 === 0 ? "gpt-6.1-sol" : "haiku-4.5", mode: "auto",
    }));
    taskIds.push(id);
  }
});

afterAll(() => {
  router?.routerV2Service && (router.routerV2Service.evaluateTaskSync = router.routerV2Service.evaluateTaskSync);
});

test("all six policies rank eligible candidates and never authorize execution", () => {
  const presets: RouterPolicyPreset[] = ["best-quality", "lowest-cost", "balanced", "fastest", "quota-saver", "custom"];
  const rows = [
    candidate({ id: "flagship", qualityTier: "flagship", costMinor: 90, modelId: "flagship", measuredLatencyMs: 9_000 }),
    candidate({ id: "economy", qualityTier: "economy", costMinor: 2, modelId: "economy", accountId: "acct-b", measuredLatencyMs: 500 }),
  ];
  for (const preset of presets) {
    const policy: ProjectRouterPolicyConfig = { ...DEFAULT_ROUTER_POLICY, preset, weights: DEFAULT_PRESET_WEIGHTS[preset] };
    const ranked = evaluateCandidates(rows, { taskId: "t", projectId: projects[0] ?? "/p", role: "developer" }, policy);
    expect(ranked.authorizesExecution).toBe(false);
    expect(ranked.eligible.length).toBe(2);
    expect(ranked.selected?.authorizesExecution).toBe(false);
    expect(ranked.explanation).toContain("does not authorize execution");
  }
  const synthetic = evaluateCandidates([
    candidate({ historyStats: { runCount: 8, measuredQuality: 99, isSyntheticTest: true, comparable: true, role: "developer" } }),
  ], { taskId: "t", projectId: "/p", role: "developer" }, DEFAULT_ROUTER_POLICY);
  expect(synthetic.selected?.scores.quality.evidence).toBe("configured");
});

test("strict quota keeps Unknown and Owner-reported capacity out of admission", () => {
  const strict = { ...DEFAULT_ROUTER_POLICY, quotaPolicy: "strict" as const };
  const unknown = eliminateCandidate(candidate({
    quotaState: { isUnknown: true, capacityEvidence: "unknown" },
  }), { taskId: "t", projectId: "/p" }, strict);
  expect(unknown.reasons.join(" ")).toContain("quota-unknown-strict");
  const reported = eliminateCandidate(candidate({
    quotaState: { isUnknown: false, capacityEvidence: "owner-reported", remainingPercent: 90 },
  }), { taskId: "t", projectId: "/p" }, strict);
  expect(reported.reasons.join(" ")).toContain("quota-unverified-strict");
  const reviewer = eliminateCandidate(candidate({ access: "workspace-write" }), { taskId: "t", projectId: "/p", role: "reviewer" }, DEFAULT_ROUTER_POLICY);
  expect(reviewer.eligible).toBe(false);
  expect(reviewer.reasons.join(" ")).toContain("reviewer-read-only-required");
});

test("an empty autonomy envelope admits nothing and an unscoped envelope does not name an account", () => {
  const locked = { ...DEFAULT_ROUTER_POLICY, envelopeLocked: true, constraints: { ...DEFAULT_ROUTER_POLICY.constraints, allowedHarnessIds: [], allowedAccountIds: [], allowedModels: [] } };
  expect(eliminateCandidate(candidate({}), { taskId: "t", projectId: "/p" }, locked).reasons.join(" ")).toContain("autonomy-envelope");
  const unscoped = {
    ...DEFAULT_ROUTER_POLICY,
    envelopeLocked: true,
    envelopeAllowUnscopedAccount: true,
    constraints: { ...DEFAULT_ROUTER_POLICY.constraints, allowedHarnessIds: ["codex"], allowedAccountIds: [], allowedModels: ["gpt-6.1-sol"] },
  };
  expect(eliminateCandidate(candidate({ accountId: null }), { taskId: "t", projectId: "/p" }, unscoped).eligible).toBe(true);
  expect(eliminateCandidate(candidate({ accountId: "acct-a" }), { taskId: "t", projectId: "/p" }, unscoped).eligible).toBe(false);
});

test("revoked and expired policies fail closed", () => {
  const body = normalizePolicyBody({
    mode: "full-autonomy", scopeKind: "project", scopeRef: projects[0], projects: [projects[0]],
    specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: ["gpt-6.1-sol"], accounts: ["acct-a"],
    permittedActions: ["launch_task"], maxConcurrentWorkers: 1, maxLaunches: 1, maxDurationMs: 60_000, maxReworkAttempts: 0,
    expiresAt: Date.now() + 60_000,
  });
  const policy = { id: "policy", revision: 1, digest: "digest", body };
  const target = { action: "launch_task" as const, projectPath: projects[0]!, role: "developer", provider: "codex", model: "gpt-6.1-sol", accountId: "acct-a" };
  const counters = {
    launchesUsed: 0, launchesInFlight: 0, reworkUsedForTask: 0, now: Date.now(), activatedAt: Date.now(),
    lifecycleAllowed: true, emergencyStopped: false, paused: false, revoked: false, expired: false,
  };
  expect(evaluateApplicablePolicies([policy], target, { ...counters, revoked: true }).allow).toBe(false);
  expect(evaluateApplicablePolicies([policy], target, { ...counters, expired: true }).allow).toBe(false);
  expect(evaluateApplicablePolicies([policy], { ...target, provider: "cursor" }, counters).allow).toBe(false);
});

test("task-id admission fails closed for Cursor, DeepSeek, evaluation errors, and pinned mismatches", async () => {
  const original = router.routerV2Service.evaluateTaskSync.bind(router.routerV2Service);
  const cursorId = "cursor-task";
  const deepseekId = "deepseek-task";
  const boomId = "boom-task";
  const pinId = "pin-task";
  db.tasks.insert(makeTask({ id: cursorId, title: "Cursor", workdir: projects[0]!, agent: "cursor", model: "gpt-6.1-sol", mode: "auto", column: "backlog" }));
  db.tasks.insert(makeTask({ id: deepseekId, title: "DeepSeek", workdir: projects[0]!, agent: "claude-code", model: "deepseek-chat", mode: "auto", column: "backlog" }));
  db.tasks.insert(makeTask({ id: boomId, title: "Boom", workdir: projects[0]!, agent: "codex", model: "gpt-6.1-sol", mode: "auto", column: "backlog" }));
  db.tasks.insert(makeTask({ id: pinId, title: "Pinned", workdir: projects[0]!, agent: "codex", model: "gpt-6.1-sol", mode: "auto", column: "backlog" }));
  router.routerV2Service.evaluateTaskSync = ((req: { taskId: string; requestedHarnessId?: string | null; requestedModelId?: string | null; requestedMode?: string | null; requestedAccountId?: string | null }) => {
    if (req.taskId === boomId) throw new Error("catalog offline");
    if (req.taskId === pinId) {
      return {
        selected: { harnessId: "claude-code", modelId: "sonnet-5.5", mode: "auto", accountId: null },
        eligible: [], ineligible: [], all: [], explanation: "would have substituted", authorizesExecution: false,
      };
    }
    return {
      selected: { harnessId: req.requestedHarnessId, modelId: req.requestedModelId, mode: req.requestedMode, accountId: req.requestedAccountId ?? null },
      eligible: [], ineligible: [], all: [], explanation: "exact", authorizesExecution: false,
    };
  }) as unknown as typeof router.routerV2Service.evaluateTaskSync;
  try {
    const before = db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orchestration_missions").get()!.n;
    await expect(scheduler.missionScheduler.prepareMission({ title: "Cursor", goal: "Blocked", taskIds: [cursorId] })).rejects.toThrow("Cursor provider is not ready");
    await expect(scheduler.missionScheduler.prepareMission({ title: "DeepSeek", goal: "Blocked", taskIds: [deepseekId] })).rejects.toThrow("DeepSeek provider is not ready");
    await expect(scheduler.missionScheduler.prepareMission({ title: "Boom", goal: "Exception", taskIds: [boomId] })).rejects.toThrow(/No substitute resource was selected/);
    await expect(scheduler.missionScheduler.prepareMission({ title: "Pin", goal: "Pinned", taskIds: [pinId] })).rejects.toThrow(/No substitute was selected/);
    const mission = await scheduler.missionScheduler.prepareMission({
      title: "Company mission", goal: "Exact resources", taskIds, clusterIds: ["cluster-a", "cluster-b", "cluster-c"],
    });
    expect(mission.plan.tasks).toHaveLength(20);
    expect(mission.plan.tasks.every(task => task.modelId !== "sonnet-5.5" || task.harnessId === "claude-code")).toBe(true);
    expect(mission.plan.tasks.some(task => task.harnessId === "codex" && task.modelId === "gpt-6.1-sol")).toBe(true);
    expect(mission.plan.tasks.some(task => task.harnessId === "cursor" || task.modelId.includes("deepseek"))).toBe(false);
    const after = db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orchestration_missions").get()!.n;
    expect(after).toBe(before + 1);
  } finally {
    router.routerV2Service.evaluateTaskSync = original;
  }
});

test("the company search enforces shared caps and labels an unfinished search", () => {
  const stages: AllocationStage[] = taskIds.map((id, index) => ({
    id,
    dependsOn: index === 4 ? [taskIds[0]!] : [],
    projectId: projects[index % 5],
    clusterId: ["cluster-a", "cluster-b", "cluster-c"][index % 3],
    role: index % 7 === 0 ? "reviewer" : "developer",
    withheld: index === 19 ? "Project is paused or draining." : null,
    options: [{
      id: `${id}-opt`, accountId: index % 2 === 0 ? "codex-a" : "claude-a", durationMs: 10, charge: 1, waitMs: 0,
      poolId: "shared-company", demand: 1, concurrency: 1, provider: index % 2 === 0 ? "codex" : "claude-code",
    }],
  }));
  const wide = searchAllocation(stages, "fastest", [{ id: "shared-company", remaining: 100 }], true, 256, {
    globalMax: 2, perProjectMax: 1, perClusterMax: 1, perRoleMax: 2,
  });
  expect(wide.optimal).toBe(false);
  expect(wide.reason).toContain("bounded allocation search");
  const paused = stages.find(stage => stage.id === taskIds[19]);
  expect(paused?.withheld).toContain("paused");
  const slice = searchAllocation(stages.slice(0, 4), "fastest", [{ id: "shared-company", remaining: 2 }], true, 256, {
    globalMax: 1, perProjectMax: 1, perClusterMax: 1, perRoleMax: 1, occupied: [{ accountId: "codex-a", poolId: "shared-company", demand: 2, untilMs: 50 }],
  });
  expect(slice.feasible).toBe(false);
});

test("a fallback proposal is read-only and a changed digest does not match", () => {
  const failed: FallbackProposal["failed"] = { provider: "codex", runId: "run-1", harnessId: "codex", modelId: "gpt-6.1-sol", accountId: "acct-a", mode: "auto", reason: "provider-unavailable" };
  const proposal: FallbackProposal = {
    failed,
    replacement: { provider: "claude-code", harnessId: "claude-code", modelId: "haiku-4.5", accountId: "acct-b", mode: "auto" },
    evidenceHash: "evidence-1",
    authorizesExecution: false,
    explanation: "Eligible alternative.",
  };
  const digest = fallbackDigest(proposal);
  expect(proposal.authorizesExecution).toBe(false);
  expect(fallbackDigest({ ...proposal, evidenceHash: "evidence-2" })).not.toBe(digest);
  expect(router.routerV2Service.proposeFallback({
    requirements: { taskId: taskIds[0]!, projectId: projects[0]!, role: "developer" },
    failed, evidenceHash: "evidence-1",
    candidates: [candidate({ id: "alt", harnessId: "claude-code", kind: "claude-code", modelId: "haiku-4.5", accountId: "acct-b", mode: "auto" })],
  }).authorizesExecution).toBe(false);
});

test("Head resource answers do not authorize a launch", async () => {
  const pinned = await head.tryAnswerOrchestrationQuestion("Do not change the model I selected.", {
    scope: { scope: { kind: "task", id: taskIds[0]! }, label: "task", projectPath: projects[0]!, projectAddedAt: null, clusterId: null },
  } as never);
  expect(pinned).toContain("gpt-6.1-sol");
  expect(pinned).toContain("not execution authority");
  const fallback = await head.tryAnswerOrchestrationQuestion("Prepare a fallback for the failed Reviewer.");
  expect(fallback).toContain("Nothing was invented");
  const runs = db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  expect(runs).toBe(0);
});
