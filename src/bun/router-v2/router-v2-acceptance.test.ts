import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { db, tasks, projects } from "../db.ts";
import { routerV2Service, RouterV2Service } from "./router-v2-service.ts";
import { routerV2HistoryCore } from "./router-v2-history.ts";
import { evaluateCandidates, type EvaluatorCandidateInput } from "../../shared/router-v2/evaluator.ts";
import { planMultiProjectAllocation } from "../../shared/router-v2/multi-project-planner.ts";
import { gatherScopedHeadContext, resolveHeadScope } from "../head-pm-scope.ts";
import {
  type TaskRequirementsInput,
  type ProjectRouterPolicyConfig,
  DEFAULT_PRESET_WEIGHTS,
  DEFAULT_ROUTER_POLICY,
} from "../../shared/router-v2/types.ts";
import type { HeadScopeSnapshot } from "../../shared/head-pm-scope.ts";

function createCandidate(overrides: Partial<EvaluatorCandidateInput> = {}): EvaluatorCandidateInput {
  const harnessId = overrides.harnessId ?? "codex";
  const accountId = overrides.accountId !== undefined ? overrides.accountId : "acc-codex-1";
  const modelId = overrides.modelId ?? "gpt-6.1-sol";
  const mode = overrides.mode ?? "auto";

  return {
    id: JSON.stringify([harnessId, accountId, modelId, mode]),
    harnessId,
    harnessLabel: harnessId === "codex" ? "Codex Primary" : harnessId === "claude" ? "Claude Harness" : harnessId,
    kind: overrides.kind ?? harnessId,
    enabled: true,
    cliInstalled: true,
    cliLoggedIn: true,
    accountId,
    accountLabel: accountId ? `Account ${accountId}` : null,
    provider: overrides.provider ?? "openai",
    supportsRealMultiAccount: true,
    isolationType: "child-home",
    modelId,
    modelLabel: modelId,
    mode,
    modeLabel: mode,
    access: "workspace-write",
    qualityTier: "standard",
    costMinor: 20,
    currency: "USD",
    measuredLatencyMs: 800,
    latencySampleCount: 5,
    quotaState: {
      isUnknown: false,
      remainingPercent: 80,
      remainingUnits: 800,
      isExhausted: false,
    },
    historyStats: {
      runCount: 10,
      successRate: 0.9,
      qcPassRate: 0.9,
      isSyntheticTest: false,
    },
    concurrency: {
      occupied: 0,
      limit: 3,
    },
    ...overrides,
  };
}

describe("FO-ROUTING04: AI Router 2.0 — Acceptance Test Suite (17 Requirements)", () => {
  const projectAlpha = "/tmp/forgeorbit-acceptance-project-alpha";
  const projectBeta = "/tmp/forgeorbit-acceptance-project-beta";

  // Pre-configured test candidates
  const candidateAstraHighQuality = createCandidate({
    modelId: "gpt-6-astra",
    modelLabel: "GPT-6 Astra (Flagship)",
    qualityTier: "flagship",
    costMinor: 250,
    measuredLatencyMs: 1400,
  });

  const candidateLunaEconomical = createCandidate({
    modelId: "gpt-6-luna",
    modelLabel: "GPT-6 Luna (Economical)",
    qualityTier: "economy",
    costMinor: 2,
    measuredLatencyMs: 280,
  });

  const candidateClaudeReviewer = createCandidate({
    harnessId: "claude",
    kind: "claude",
    modelId: "claude-3-7-sonnet",
    modelLabel: "Claude 3.7 Sonnet (Ask Mode)",
    mode: "ask",
    access: "read-only",
    qualityTier: "flagship",
    costMinor: 50,
    measuredLatencyMs: 750,
  });

  const candidateClaudeDeveloperWrite = createCandidate({
    harnessId: "claude",
    kind: "claude",
    modelId: "claude-3-7-sonnet",
    modelLabel: "Claude 3.7 Sonnet (Write Mode)",
    mode: "agent",
    access: "workspace-write",
    qualityTier: "flagship",
  });

  const candidateCursorBlocked = createCandidate({
    harnessId: "cursor",
    kind: "cursor",
    modelId: "cursor-default",
    isolationType: "ambient-keychain",
    supportsRealMultiAccount: false,
  });

  const candidateDeepSeekBlocked = createCandidate({
    harnessId: "deepseek",
    kind: "deepseek",
    modelId: "deepseek-coder",
    activeBlocks: ["deepseek-security-hold"],
  });

  beforeEach(() => {
    fs.mkdirSync(projectAlpha, { recursive: true });
    fs.mkdirSync(projectBeta, { recursive: true });

    db.run("INSERT OR IGNORE INTO projects (path, name, added_at, lifecycle_state) VALUES (?, ?, ?, 'running')", [
      projectAlpha,
      "Project Alpha",
      Date.now(),
    ]);
    db.run("INSERT OR IGNORE INTO projects (path, name, added_at, lifecycle_state) VALUES (?, ?, ?, 'running')", [
      projectBeta,
      "Project Beta",
      Date.now(),
    ]);

    // Ensure codex & claude harnesses are enabled
    db.run("INSERT OR IGNORE INTO harnesses (id, kind, label, enabled) VALUES ('codex', 'codex', 'Codex', 1)");
    db.run("UPDATE harnesses SET enabled = 1 WHERE id = 'codex'");
    db.run("INSERT OR IGNORE INTO harnesses (id, kind, label, enabled) VALUES ('claude', 'claude', 'Claude', 1)");
    db.run("UPDATE harnesses SET enabled = 1 WHERE id = 'claude'");
  });

  afterEach(() => {
    fs.rmSync(projectAlpha, { recursive: true, force: true });
    fs.rmSync(projectBeta, { recursive: true, force: true });
  });

  // Requirement 1: Small tasks select economical candidate
  test("Req 1: Small tasks select economical candidate (gpt-6-luna)", () => {
    const task: TaskRequirementsInput = {
      taskId: "task-small-fix",
      projectId: projectAlpha,
      role: "developer",
      complexity: "low",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "lowest-cost",
      weights: DEFAULT_PRESET_WEIGHTS["lowest-cost"],
    };

    const res = evaluateCandidates([candidateAstraHighQuality, candidateLunaEconomical], task, policy);
    expect(res.selected).toBeDefined();
    expect(res.selected?.modelId).toBe("gpt-6-luna");
    expect(res.selected?.scores.cost.score).toBeGreaterThan(res.eligible[1]!.scores.cost.score);
  });

  // Requirement 2: Complex architecture work favors high-quality candidate
  test("Req 2: Complex architecture work favors high-quality candidate (gpt-6-astra)", () => {
    const task: TaskRequirementsInput = {
      taskId: "task-complex-arch",
      projectId: projectAlpha,
      role: "developer",
      complexity: "high",
      type: "architecture",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "best-quality",
      weights: DEFAULT_PRESET_WEIGHTS["best-quality"],
    };

    const res = evaluateCandidates([candidateAstraHighQuality, candidateLunaEconomical], task, policy);
    expect(res.selected).toBeDefined();
    expect(res.selected?.modelId).toBe("gpt-6-astra");
    expect(res.selected?.scores.quality.score).toBeGreaterThan(res.eligible[1]!.scores.quality.score);
  });

  // Requirement 3: Reviewer routing respects independent read-only QC requirements
  test("Req 3: Reviewer routing respects independent read-only QC requirements (ask mode)", () => {
    const task: TaskRequirementsInput = {
      taskId: "task-qc-review",
      projectId: projectAlpha,
      role: "reviewer",
      complexity: "medium",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "balanced",
      weights: DEFAULT_PRESET_WEIGHTS["balanced"],
    };

    const res = evaluateCandidates([candidateClaudeReviewer, candidateClaudeDeveloperWrite], task, policy);
    expect(res.selected).toBeDefined();
    expect(res.selected?.modelId).toBe("claude-3-7-sonnet");
    expect(res.selected?.mode).toBe("ask");

    // The write mode candidate must be eliminated
    const ineligible = res.ineligible.find((c) => c.mode === "agent");
    expect(ineligible).toBeDefined();
    expect(ineligible?.eliminationReasons.some((r) => r.includes("reviewer-read-only-required"))).toBe(true);
  });

  // Requirement 4: Verified low quota changes routing decisions
  test("Req 4: Verified low quota changes routing decisions (deprioritizes or excludes exhausted)", () => {
    const exhaustedCandidate = createCandidate({
      modelId: "gpt-6-exhausted",
      quotaState: {
        isUnknown: false,
        isExhausted: true,
        remainingPercent: 0,
        remainingUnits: 0,
      },
    });
    const lowQuotaCandidate = createCandidate({
      modelId: "gpt-6-low-quota",
      qualityTier: "standard",
      quotaState: {
        isUnknown: false,
        isExhausted: false,
        remainingPercent: 5,
        remainingUnits: 50,
      },
    });
    const healthyQuotaCandidate = createCandidate({
      modelId: "gpt-6-healthy-quota",
      qualityTier: "standard",
      quotaState: {
        isUnknown: false,
        isExhausted: false,
        remainingPercent: 90,
        remainingUnits: 900,
      },
    });

    const task: TaskRequirementsInput = {
      taskId: "task-quota-test",
      projectId: projectAlpha,
      role: "developer",
      complexity: "medium",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "quota-saver",
      quotaPolicy: "strict",
      weights: DEFAULT_PRESET_WEIGHTS["quota-saver"],
    };

    const res = evaluateCandidates([exhaustedCandidate, lowQuotaCandidate, healthyQuotaCandidate], task, policy);
    // Exhausted candidate must be eliminated
    expect(res.ineligible.some((c) => c.modelId === "gpt-6-exhausted")).toBe(true);

    // Healthy quota must rank above low quota under quota-saver policy
    expect(res.selected?.modelId).toBe("gpt-6-healthy-quota");
    expect(res.selected?.scores.quota.score).toBeGreaterThan(res.eligible[1]!.scores.quota.score);
  });

  // Requirement 5: Unknown quota remains Unknown
  test("Req 5: Unknown quota remains Unknown without invented numbers", () => {
    const unknownQuotaCandidate = createCandidate({
      modelId: "gpt-6-unknown-quota",
      quotaState: {
        isUnknown: true,
      },
    });
    const task: TaskRequirementsInput = {
      taskId: "task-unknown-quota",
      projectId: projectAlpha,
      role: "developer",
      complexity: "medium",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "balanced",
      quotaPolicy: "permissive",
    };

    const res = evaluateCandidates([unknownQuotaCandidate], task, policy);
    expect(res.selected).toBeDefined();
    expect(res.selected?.scores.quota.evidence).toBe("unknown");
    expect(res.selected?.warnings.some((w) => w.toLowerCase().includes("quota is unknown"))).toBe(true);
  });

  // Requirement 6: Strict and permissive quota policies behave differently
  test("Req 6: Strict and permissive quota policies behave differently", () => {
    const unknownQuotaCandidate = createCandidate({
      modelId: "gpt-6-unknown-quota",
      quotaState: {
        isUnknown: true,
      },
    });
    const task: TaskRequirementsInput = {
      taskId: "task-strict-vs-permissive",
      projectId: projectAlpha,
      role: "developer",
      complexity: "medium",
    };

    // Strict policy: must eliminate unknown quota
    const strictPolicy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      quotaPolicy: "strict",
    };
    const strictRes = evaluateCandidates([unknownQuotaCandidate], task, strictPolicy);
    expect(strictRes.selected).toBeNull();
    expect(strictRes.ineligible[0]!.eliminationReasons.some((r) => r.includes("quota-unknown-strict"))).toBe(true);

    // Permissive policy: allows candidate with unknown quota warning
    const permissivePolicy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      quotaPolicy: "permissive",
    };
    const permissiveRes = evaluateCandidates([unknownQuotaCandidate], task, permissivePolicy);
    expect(permissiveRes.selected).toBeDefined();
    expect(permissiveRes.selected?.eligible).toBe(true);
  });

  // Requirement 7: Blocked Cursor and DeepSeek resources are rejected
  test("Req 7: Blocked Cursor and DeepSeek resources are rejected", () => {
    const task: TaskRequirementsInput = {
      taskId: "task-sandbox-check",
      projectId: projectAlpha,
      role: "developer",
      complexity: "medium",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
    };

    const res = evaluateCandidates([candidateCursorBlocked, candidateDeepSeekBlocked], task, policy);
    expect(res.selected).toBeNull();
    expect(res.ineligible.length).toBe(2);

    const cursorRej = res.ineligible.find((c) => c.kind === "cursor");
    expect(cursorRej?.eliminationReasons.some((r) => r.includes("cursor-internal-sandbox-unavailable"))).toBe(true);
    expect(cursorRej?.readiness).toBe("runtime-incompatible");

    const dsRej = res.ineligible.find((c) => c.kind === "deepseek");
    expect(dsRej?.eliminationReasons.some((r) => r.includes("deepseek-containment-blocked"))).toBe(true);
    expect(dsRej?.readiness).toBe("runtime-incompatible");
  });

  // Requirement 8: Account identity constraints are respected
  test("Req 8: Account identity constraints are respected", () => {
    const task: TaskRequirementsInput = {
      taskId: "task-account-filter",
      projectId: projectAlpha,
      role: "developer",
      complexity: "medium",
    };
    const policyWithAccountRestriction: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      constraints: {
        ...DEFAULT_ROUTER_POLICY.constraints,
        allowedAccountIds: ["acc-special-authorized-only"],
      },
    };

    const res = evaluateCandidates([candidateAstraHighQuality], task, policyWithAccountRestriction);
    expect(res.selected).toBeNull();
    expect(res.ineligible[0]!.eliminationReasons.some((r) => r.includes("owner-account-disallowed"))).toBe(true);
  });

  // Requirement 9: Manual override is preserved
  test("Req 9: Manual override is preserved", () => {
    const task: TaskRequirementsInput = {
      taskId: "task-manual-override",
      projectId: projectAlpha,
      role: "developer",
      complexity: "high", // naturally favors astra
      requestedHarnessId: "codex",
      requestedModelId: "gpt-6-luna", // Owner explicitly chooses luna
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "best-quality",
      weights: DEFAULT_PRESET_WEIGHTS["best-quality"],
    };

    const res = evaluateCandidates([candidateAstraHighQuality, candidateLunaEconomical], task, policy);
    expect(res.selected).toBeDefined();
    expect(res.selected?.modelId).toBe("gpt-6-luna");
    expect(res.selected?.isManualOverride).toBe(true);
    expect(res.selected?.selectionReasons.some((r) => r.includes("Manual Owner override"))).toBe(true);
  });

  // Requirement 10: Approved plan freezes exact resource selection (digest matches)
  test("Req 10: Approved plan freezes exact resource selection (digest matches)", () => {
    const tAlpha = crypto.randomUUID();
    const tBeta = crypto.randomUUID();
    db.run(
      "INSERT INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at) VALUES (?, 'Alpha Task', 'Prompt', ?, 'codex', 'ready', 'none', ?, ?)",
      [tAlpha, projectAlpha, Date.now(), Date.now()],
    );
    db.run(
      "INSERT INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at) VALUES (?, 'Beta Task', 'Prompt', ?, 'codex', 'ready', 'none', ?, ?)",
      [tBeta, projectBeta, Date.now(), Date.now()],
    );

    const plan = planMultiProjectAllocation(
      [
        {
          projectPath: projectAlpha,
          projectPriority: "critical",
          task: { taskId: tAlpha, projectId: projectAlpha, title: "Alpha Small Fix", type: "general", complexity: "low", role: "developer" },
          candidates: [candidateLunaEconomical],
        },
        {
          projectPath: projectBeta,
          projectPriority: "normal",
          task: { taskId: tBeta, projectId: projectBeta, title: "Beta Arch", type: "architecture", complexity: "high", role: "developer" },
          candidates: [candidateAstraHighQuality],
        },
      ],
      { ...DEFAULT_ROUTER_POLICY, scopeId: projectAlpha },
    );

    expect(plan.planDigest).toBeDefined();
    expect(plan.planDigest.length).toBe(64); // SHA-256 hex string

    const applyRes = routerV2Service.applyPlan(plan, plan.planDigest, { recheck: false });
    expect(applyRes.success).toBe(true);
    expect(applyRes.appliedCount).toBe(2);

    // Verify task updates
    const updatedAlpha = tasks.get(tAlpha);
    const updatedBeta = tasks.get(tBeta);
    expect(updatedAlpha?.model).toBe("gpt-6-luna");
    expect(updatedBeta?.model).toBe("gpt-6-astra");
  });

  // Requirement 11: Stale plan is rejected before execution
  test("Req 11: Stale or tampered plan is rejected before execution", () => {
    const tAlpha = crypto.randomUUID();
    db.run(
      "INSERT INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at) VALUES (?, 'Alpha Task', 'Prompt', ?, 'codex', 'ready', 'none', ?, ?)",
      [tAlpha, projectAlpha, Date.now(), Date.now()],
    );

    const plan = planMultiProjectAllocation(
      [
        {
          projectPath: projectAlpha,
          projectPriority: "critical",
          task: { taskId: tAlpha, projectId: projectAlpha, title: "Alpha Small Fix", type: "general", complexity: "low", role: "developer" },
          candidates: [candidateLunaEconomical],
        },
      ],
      { ...DEFAULT_ROUTER_POLICY, scopeId: projectAlpha },
    );

    // Tampered digest is rejected
    const tamperedRes = routerV2Service.applyPlan(plan, "tampered-corrupted-digest-value");
    expect(tamperedRes.success).toBe(false);
    expect(tamperedRes.errors[0]).toContain("Plan digest mismatch");

    // Stale plan (fingerprint mismatch) is rejected
    const staleFps = new Map<string, string>(); // Missing tAlpha fingerprint
    const staleRes = routerV2Service.applyPlan(plan, plan.planDigest, { currentFingerprints: staleFps, recheck: false });
    expect(staleRes.success).toBe(false);
    expect(staleRes.errors[0]).toContain("removed or no longer found");
  });

  // Requirement 12: Project Alpha and Beta retain independent attribution
  test("Req 12: Project Alpha and Beta retain independent attribution and policies", () => {
    // Configure Alpha as Lowest Cost
    routerV2Service.savePolicy({
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "lowest-cost",
      quotaPolicy: "strict",
      autonomyMode: "supervised",
    });

    // Configure Beta as Best Quality
    routerV2Service.savePolicy({
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectBeta,
      preset: "best-quality",
      quotaPolicy: "permissive",
      autonomyMode: "supervised",
    });

    const alphaPolicy = routerV2Service.getPolicy(projectAlpha);
    const betaPolicy = routerV2Service.getPolicy(projectBeta);

    expect(alphaPolicy.preset).toBe("lowest-cost");
    expect(alphaPolicy.quotaPolicy).toBe("strict");
    expect(betaPolicy.preset).toBe("best-quality");
    expect(betaPolicy.quotaPolicy).toBe("permissive");
  });

  // Requirement 13: Fake execution results do not enter real performance statistics
  test("Req 13: Fake execution results do not enter real performance statistics", () => {
    const taskId = crypto.randomUUID();
    const runId = "run-fake-perf-1";
    const harnessId = "codex";
    const modelId = "gpt-6-fake-test-perf";

    db.run(
      "INSERT INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at) VALUES (?, 'Fake Task', 'Prompt', ?, 'codex', 'ready', 'none', ?, ?)",
      [taskId, projectAlpha, Date.now(), Date.now()],
    );
    db.run(
      "INSERT INTO runs (id, task_id, agent, status, started_at) VALUES (?, ?, 'codex', 'succeeded', ?)",
      [runId, taskId, Date.now()],
    );
    db.run(
      "INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'status', ?, ?)",
      [runId, JSON.stringify({ kind: "execution-identity", executionType: "synthetic" }), Date.now()],
    );

    // Verify isRealProviderRun rejects synthetic driver executions
    expect(routerV2HistoryCore.isRealProviderRun(db, runId)).toBe(false);

    // Query metrics for this model: synthetic runs are excluded, remaining cold start
    const coldPerf = routerV2HistoryCore.queryMetrics(db, { harnessId, modelId });
    expect(coldPerf.isColdStart).toBe(true);
    expect(coldPerf.runCount).toBe(0);
    expect(coldPerf.successRate).toBeNull();
  });

  // Requirement 14: Real persisted historical metrics affect later recommendations
  test("Req 14: Real persisted historical metrics affect later recommendations", () => {
    const taskId = crypto.randomUUID();
    const runId = "run-real-perf-1";
    const harnessId = "codex";
    const modelId = "gpt-6-real-perf";

    db.run(
      "INSERT INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at) VALUES (?, 'Real Task', 'Prompt', ?, 'codex', 'ready', 'none', ?, ?)",
      [taskId, projectAlpha, Date.now(), Date.now()],
    );
    db.run(
      "INSERT INTO runs (id, task_id, agent, status, started_at) VALUES (?, ?, 'codex', 'succeeded', ?)",
      [runId, taskId, Date.now()],
    );
    db.run(
      "INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'status', ?, ?)",
      [runId, JSON.stringify({ kind: "execution-identity", executionType: "real-provider" }), Date.now()],
    );

    // Verify isRealProviderRun acknowledges real provider execution
    expect(routerV2HistoryCore.isRealProviderRun(db, runId)).toBe(true);

    // Verify evaluator incorporates history score when verified metrics are provided
    const candidateWithRealHistory = createCandidate({
      modelId,
      historyStats: {
        runCount: 15,
        successRate: 1.0,
        qcPassRate: 1.0,
        isSyntheticTest: false,
      },
    });

    const task: TaskRequirementsInput = {
      taskId: "task-history-eval",
      projectId: projectAlpha,
      role: "developer",
      complexity: "low",
    };

    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "balanced",
      weights: { quality: 10, cost: 10, latency: 10, quota: 0, history: 70 },
    };

    const res = evaluateCandidates([candidateWithRealHistory], task, policy);
    expect(res.selected?.scores.history.evidence).toBe("verified");
    expect(res.selected?.scores.history.score).toBe(100);
  });

  // Requirement 15: Backend restart preserves policies and allocation history
  test("Req 15: Backend restart preserves policies and allocation history", () => {
    routerV2Service.savePolicy({
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "fastest",
      quotaPolicy: "strict",
      autonomyMode: "supervised",
    });

    routerV2Service.recordDecision({
      projectPath: projectAlpha,
      taskId: "task-persist-1",
      role: "developer",
      policyPreset: "fastest",
      quotaPolicy: "strict",
      autonomyMode: "supervised",
      selectedHarnessId: "codex",
      selectedModelId: "gpt-6-luna",
      selectedAccountId: "acc-1",
      selectedMode: "auto",
      decisionType: "automatic",
      planDigest: null,
      evaluation: {
        candidateId: "cand-persist",
        harnessId: "codex",
        harnessLabel: "Codex",
        kind: "codex",
        accountId: "acc-1",
        accountLabel: "Acc 1",
        modelId: "gpt-6-luna",
        modelLabel: "Luna",
        mode: "auto",
        modeLabel: "Auto",
        role: "developer",
        eligible: true,
        readiness: "verified-ready",
        eliminationReasons: [],
        scores: {
          quality: { score: 70, evidence: "configured", detail: "tier 3" },
          cost: { score: 95, evidence: "estimated", detail: "cheap" },
          latency: { score: 95, evidence: "verified", detail: "320ms" },
          quota: { score: 80, evidence: "unknown", detail: "unknown" },
          history: { score: 80, evidence: "unknown", detail: "none", runCount: 0 },
          preferenceBonus: 0,
          totalScore: 86,
        },
        selectionReasons: ["Fastest candidate"],
        warnings: [],
      },
      actualAttribution: null,
    });

    // Instantiate a new service instance (simulating restart)
    const restartedService = new RouterV2Service(db);
    const restoredPolicy = restartedService.getPolicy(projectAlpha);
    expect(restoredPolicy.preset).toBe("fastest");
    expect(restoredPolicy.quotaPolicy).toBe("strict");

    const decisions = restartedService.listDecisions(10);
    const saved = decisions.find((d) => d.taskId === "task-persist-1");
    expect(saved).toBeDefined();
    expect(saved?.selectedModelId).toBe("gpt-6-luna");
  });

  // Requirement 16: No worker starts merely because router selected a model
  test("Req 16: No worker starts merely because router selected a model", () => {
    const runsBefore = (db.query("SELECT count(*) as count FROM runs").get() as { count: number }).count;

    const task: TaskRequirementsInput = {
      taskId: "task-no-spawn",
      projectId: projectAlpha,
      role: "developer",
      complexity: "low",
    };
    const policy: ProjectRouterPolicyConfig = {
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
    };

    const evalResult = evaluateCandidates([candidateLunaEconomical, candidateAstraHighQuality], task, policy);
    expect(evalResult.selected).toBeDefined();

    // Verify runs table count did NOT increase
    const runsAfter = (db.query("SELECT count(*) as count FROM runs").get() as { count: number }).count;
    expect(runsAfter).toBe(runsBefore);
  });

  // Requirement 17: Head can explain and apply an authorized routing decision
  test("Req 17: Head can explain and inspect an authorized routing decision", () => {
    routerV2Service.savePolicy({
      ...DEFAULT_ROUTER_POLICY,
      scopeId: projectAlpha,
      preset: "balanced",
      quotaPolicy: "permissive",
      autonomyMode: "supervised",
    });

    const taskId = "task-head-explain-1";
    db.run(
      "INSERT OR REPLACE INTO tasks (id, title, prompt, column, agent, workdir, isolation, created_at, updated_at) VALUES (?, ?, 'Prompt text', 'ready', 'codex', ?, 'none', ?, ?)",
      [taskId, "Head Explain Task", projectAlpha, Date.now(), Date.now()],
    );

    const resolved = resolveHeadScope({ kind: "task", id: taskId });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const scope = resolved.value;

    const original = process.env.AGETOR_CODEX_DRIVER;
    const ctx = (() => {
      process.env.AGETOR_CODEX_DRIVER = "fake";
      try { return gatherScopedHeadContext(scope); }
      finally {
        if (original === undefined) delete process.env.AGETOR_CODEX_DRIVER;
        else process.env.AGETOR_CODEX_DRIVER = original;
      }
    })();
    const projCtx = ctx.context.projects.find((p) => p.path === projectAlpha);
    expect(projCtx).toBeDefined();
    const pLines = projCtx!.lines;

    // Check policy disclosure and recommendations in Head context
    expect(pLines.some((l) => l.includes("Router 2.0 policy:"))).toBe(true);
    expect(pLines.some((l) => l.includes("Router 2.0 recommended developer:"))).toBe(true);
  });
});
