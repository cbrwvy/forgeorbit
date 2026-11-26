import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "../migrations/index.ts";
import { migrate } from "../migrate.ts";
import { RouterV2Service } from "./router-v2-service.ts";
import { queryModelExecutionMetrics } from "./router-v2-history.ts";
import { headRouterEvidence } from "./router-v2-head.ts";
import { evaluateCandidates, type EvaluatorCandidateInput } from "../../shared/router-v2/evaluator.ts";
import { planCapacityAwareAllocation } from "../../shared/router-v2/multi-project-planner.ts";
import { fallbackDigest, fallbackIsStale, RECOMMENDATION_BOUNDARY } from "../../shared/router-v2/resource-decision.ts";
import { DEFAULT_PRESET_WEIGHTS, DEFAULT_ROUTER_POLICY, type ProjectRouterPolicyConfig, type RouterPolicyPreset } from "../../shared/router-v2/types.ts";

function candidate(overrides: Partial<EvaluatorCandidateInput> = {}): EvaluatorCandidateInput {
  const harnessId = overrides.harnessId ?? "codex";
  const accountId = overrides.accountId === undefined ? "acct-codex-a" : overrides.accountId;
  const modelId = overrides.modelId ?? "gpt-6.1-sol";
  const mode = overrides.mode ?? "auto";
  return {
    id: JSON.stringify([harnessId, accountId, modelId, mode]),
    harnessId, harnessLabel: harnessId, kind: overrides.kind ?? "codex", enabled: true,
    cliInstalled: true, cliLoggedIn: true, simulated: true, accountId, accountLabel: accountId,
    provider: "openai", providerIdentity: null, supportsRealMultiAccount: true, isolationType: "child-home",
    modelId, modelLabel: modelId, mode, modeLabel: mode, access: "workspace-write", qualityTier: "advanced",
    billing: "api", costMinor: 20, currency: "USD", measuredLatencyMs: 4_000, latencySampleCount: 8,
    quotaState: { isUnknown: false, capacityEvidence: "verified-headroom", remainingPercent: 70, remainingUnits: 70, isExhausted: false },
    historyStats: { runCount: 8, successRate: 0.9, qcPassRate: 0.8, comparable: true, role: "developer" },
    concurrency: { occupied: 0, limit: 2 },
    ...overrides,
  };
}

function policy(preset: RouterPolicyPreset, extra: Partial<ProjectRouterPolicyConfig> = {}): ProjectRouterPolicyConfig {
  return { ...DEFAULT_ROUTER_POLICY, preset, weights: DEFAULT_PRESET_WEIGHTS[preset], ...extra };
}

describe("FO-ROUTER-COMPLETE01 resource decisions", () => {
  const dev = { taskId: "t", projectId: "p", role: "developer" as const, complexity: "high" as const, type: "architecture" as const };

  test("elimination precedes score, and blocked providers stay ineligible", () => {
    const cursor = candidate({ harnessId: "cursor", kind: "cursor", modelId: "grok-4.7", qualityTier: "flagship", costMinor: 1, measuredLatencyMs: 100 });
    const deepseek = candidate({ harnessId: "deepseek", kind: "deepseek-dsh", modelId: "deepseek-coder", qualityTier: "flagship" });
    const ready = candidate({ modelId: "gpt-6-luna", qualityTier: "economy" });
    const result = evaluateCandidates([cursor, deepseek, ready], dev, policy("best-quality"));
    expect(result.selected?.modelId).toBe("gpt-6-luna");
    expect(result.ineligible.map(row => row.kind).sort()).toEqual(["cursor", "deepseek-dsh"]);
    expect(result.authorizesExecution).toBe(false);
    expect(result.explanation).toContain(RECOMMENDATION_BOUNDARY);
    expect(cursor.qualityTier).toBe("flagship");
  });

  test("reviewer stays read-only and a pinned ineligible account is not replaced", () => {
    const write = candidate({ mode: "auto", access: "workspace-write" });
    const read = candidate({ mode: "ask", access: "read-only", modelId: "gpt-6-luna" });
    const reviewer = evaluateCandidates([write, read], { ...dev, role: "reviewer" }, policy("balanced"));
    expect(reviewer.selected?.mode).toBe("ask");
    expect(reviewer.ineligible.some(row => row.eliminationReasons.some(reason => reason.includes("reviewer-read-only-required")))).toBe(true);
    const pinned = evaluateCandidates(
      [candidate({ accountId: "wanted", cliLoggedIn: false }), candidate({ accountId: "other", modelId: "gpt-6-luna" })],
      { ...dev, requestedAccountId: "wanted" }, policy("balanced"),
    );
    expect(pinned.selected).toBeNull();
    expect(pinned.accountPin).toEqual({ requestedAccountId: "wanted", honored: false });
    expect(pinned.explanation).toContain("not replaced");
  });

  test("all six policies rank eligible resources from evidence", () => {
    const flagship = candidate({ modelId: "flagship", qualityTier: "flagship", costMinor: 90, measuredLatencyMs: 12_000, quotaState: { isUnknown: false, capacityEvidence: "verified-headroom", remainingPercent: 20, remainingUnits: 2, isExhausted: false } });
    const economy = candidate({ modelId: "economy", qualityTier: "economy", costMinor: 1, measuredLatencyMs: 1_000, quotaState: { isUnknown: false, capacityEvidence: "verified-headroom", remainingPercent: 95, remainingUnits: 90, isExhausted: false } });
    expect(evaluateCandidates([economy, flagship], dev, policy("best-quality")).selected?.modelId).toBe("flagship");
    expect(evaluateCandidates([flagship, economy], { ...dev, complexity: "low", type: "documentation" }, policy("lowest-cost")).selected?.modelId).toBe("economy");
    expect(evaluateCandidates([flagship, economy], dev, policy("fastest")).selected?.modelId).toBe("economy");
    expect(evaluateCandidates([flagship, economy], dev, policy("quota-saver")).selected?.modelId).toBe("economy");
    expect(evaluateCandidates([flagship, economy], dev, policy("balanced")).selected?.modelId).toBeTruthy();
    const custom = policy("custom", { weights: { quality: 90, cost: 5, latency: 5, quota: 0, history: 0 } });
    expect(evaluateCandidates([economy, flagship], dev, custom).selected?.modelId).toBe("flagship");
    expect(evaluateCandidates([economy, flagship], dev, policy("custom", { weights: { quality: 5, cost: 90, latency: 5, quota: 0, history: 0 } })).selected?.modelId).toBe("economy");
  });

  test("subscription, currency, owner reports, stale evidence, and small samples stay honest", () => {
    const subscription = candidate({ modelId: "sub", billing: "subscription", costMinor: 0 });
    const api = candidate({ modelId: "api", billing: "api", costMinor: 25 });
    const cost = evaluateCandidates([subscription, api], dev, policy("lowest-cost"));
    expect(cost.selected?.modelId).toBe("api");
    expect(cost.all.find(row => row.modelId === "sub")?.scores.cost.comparable).toBe(false);
    const foreign = candidate({ modelId: "eur", currency: "EUR", costMinor: 1 });
    expect(evaluateCandidates([foreign, api], dev, policy("lowest-cost")).all.find(row => row.modelId === "eur")?.scores.cost.evidence).toBe("unknown");
    const reported = candidate({ modelId: "manual", quotaState: { isUnknown: false, capacityEvidence: "owner-reported", remainingPercent: 99, isExhausted: false } });
    expect(evaluateCandidates([reported], dev, policy("quota-saver", { quotaPolicy: "strict" })).selected).toBeNull();
    expect(evaluateCandidates([reported], dev, policy("balanced")).selected?.scores.quota.evidence).toBe("unknown");
    const stale = candidate({ modelId: "stale", quotaState: { isUnknown: true, capacityEvidence: "stale", remainingPercent: null } });
    expect(evaluateCandidates([stale], dev, policy("balanced", { quotaPolicy: "strict" })).selected).toBeNull();
    const unknown = candidate({ modelId: "unknown", quotaState: { isUnknown: true, capacityEvidence: "unknown", remainingPercent: null } });
    expect(evaluateCandidates([unknown], dev, policy("balanced")).selected?.scores.quota.capacityClass).toBe("unknown");
    const small = candidate({ modelId: "small", historyStats: { runCount: 2, successRate: 1, qcPassRate: 1, comparable: true, role: "developer" } });
    expect(evaluateCandidates([small], dev, policy("best-quality")).selected?.scores.history.confidence).toBe("none");
    expect(evaluateCandidates([small], dev, policy("best-quality")).selected?.scores.quality.evidence).toBe("configured");
    const otherRole = candidate({ historyStats: { runCount: 12, successRate: 1, qcPassRate: 1, comparable: true, role: "reviewer", measuredQuality: 99 } });
    expect(evaluateCandidates([otherRole], dev, policy("best-quality")).selected?.scores.history.comparable).toBe(false);
    expect(evaluateCandidates([otherRole], dev, policy("best-quality")).selected?.scores.quality.evidence).toBe("configured");
  });

  test("an occupied account is not treated as the fastest completion", () => {
    const busy = candidate({ modelId: "busy", measuredLatencyMs: 500, queueWaitMs: 30_000 });
    const free = candidate({ modelId: "free", measuredLatencyMs: 8_000, queueWaitMs: 0 });
    expect(evaluateCandidates([busy, free], dev, policy("fastest")).selected?.modelId).toBe("free");
  });

  test("full autonomy stays inside the envelope and an unknown hard cost is refused", () => {
    const outside = candidate({ accountId: "outside", modelId: "gpt-6-astra", qualityTier: "flagship" });
    const locked = policy("best-quality", { autonomyMode: "full-autonomy", envelopeLocked: true, constraints: { ...DEFAULT_ROUTER_POLICY.constraints, allowedHarnessIds: [], allowedAccountIds: [], allowedModels: [] } });
    expect(evaluateCandidates([outside], dev, locked).selected).toBeNull();
    expect(evaluateCandidates([outside], dev, locked).ineligible[0]?.eliminationReasons.some(reason => reason.startsWith("autonomy-envelope"))).toBe(true);
    const unpriced = candidate({ costMinor: null, billing: "unknown" });
    const budget = policy("lowest-cost", { constraints: { ...DEFAULT_ROUTER_POLICY.constraints, maxCostMinor: 10 } });
    expect(evaluateCandidates([unpriced], dev, budget).selected).toBeNull();
  });

  test("shared pools, account concurrency, dependencies, and fairness use the bounded search", () => {
    const projects = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const clusters = ["cluster-a", "cluster-b", "cluster-c"];
    const items = projects.flatMap((projectPath, projectIndex) => Array.from({ length: 4 }, (_, index) => {
      const fast = candidate({ accountId: "acct-fast", modelId: "fast", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } });
      const slow = candidate({ accountId: "acct-slow", modelId: "slow", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } });
      return {
        projectPath, projectPriority: "normal" as const, clusterId: clusters[projectIndex % clusters.length],
        task: { taskId: `${projectPath}-${index}`, projectId: projectPath, title: `${projectPath} ${index}`, role: "developer" as const, dependsOn: index === 3 ? [`${projectPath}-0`] : [] },
        candidates: [fast, slow],
      };
    }));
    expect(items).toHaveLength(20);
    const tooWide = planCapacityAwareAllocation(items, policy("fastest"));
    expect(tooWide.allocation?.optimal).toBe(false);
    expect(tooWide.authorizesExecution).toBe(false);

    const shared = (accountId: string) => candidate({
      accountId, modelId: "shared-model", poolId: "pool-shared", quotaDemand: 1,
      quotaState: { isUnknown: false, capacityEvidence: "verified-headroom", remainingPercent: 10, remainingUnits: 1, isExhausted: false },
    });
    const pooled = planCapacityAwareAllocation([
      { projectPath: "alpha", projectPriority: "normal", task: { taskId: "one", projectId: "alpha", role: "developer" }, candidates: [shared("acct-a")] },
      { projectPath: "beta", projectPriority: "normal", task: { taskId: "two", projectId: "beta", role: "developer" }, candidates: [shared("acct-b")] },
    ], policy("quota-saver", { quotaPolicy: "strict" }));
    expect(pooled.allocation?.feasible).toBe(false);
    expect(pooled.slots.every(slot => slot.selectedCandidate)).toBe(false);

    const unknownPool = candidate({ modelId: "unknown-pool", poolId: "pool-unknown", quotaDemand: null, quotaState: { isUnknown: true, capacityEvidence: "unknown", remainingPercent: null } });
    const strictUnknown = planCapacityAwareAllocation([
      { projectPath: "alpha", projectPriority: "normal", task: { taskId: "u", projectId: "alpha", role: "developer" }, candidates: [unknownPool] },
    ], policy("quota-saver", { quotaPolicy: "strict" }));
    expect(strictUnknown.slots[0]?.selectedCandidate).toBeNull();

    const fair = planCapacityAwareAllocation([
      { projectPath: "large", projectPriority: "normal", task: { taskId: "L1", projectId: "large", role: "developer" }, candidates: [candidate({ accountId: "a", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } }), candidate({ accountId: "b", modelId: "b", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } })] },
      { projectPath: "large", projectPriority: "normal", task: { taskId: "L2", projectId: "large", role: "developer" }, candidates: [candidate({ accountId: "a", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } }), candidate({ accountId: "b", modelId: "b", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } })] },
      { projectPath: "small", projectPriority: "normal", task: { taskId: "S1", projectId: "small", role: "developer" }, candidates: [candidate({ accountId: "a", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } }), candidate({ accountId: "b", modelId: "b", measuredLatencyMs: 1_000, concurrency: { occupied: 0, limit: 1 } })] },
    ], policy("fastest"));
    expect(fair.allocation?.feasible).toBe(true);
    const accounts = new Set(fair.slots.map(slot => slot.selectedCandidate?.accountId));
    expect(accounts.size).toBe(2);
    const limited = planCapacityAwareAllocation([
      { projectPath: "alpha", projectPriority: "normal", task: { taskId: "only", projectId: "alpha", role: "developer" }, candidates: [candidate(), candidate({ modelId: "other" })] },
    ], policy("balanced"), { limit: 1 });
    expect(limited.allocation?.optimal).toBe(false);
  });

  test("fallback proposals keep the failed run and refuse a stale digest", () => {
    const failed = { provider: "openai", harnessId: "codex", modelId: "gpt-6-astra", accountId: "acct-down", mode: "auto", runId: "run-old", reason: "account authorization lost" };
    const replacement = { provider: "openai", harnessId: "codex", modelId: "gpt-6-luna", accountId: "acct-up", mode: "auto" };
    const proposal = { failed, replacement, evidenceHash: "evidence-1" };
    const digest = fallbackDigest(proposal);
    expect(digest).toHaveLength(64);
    expect(fallbackDigest({ ...proposal, replacement: { ...replacement, accountId: "other" } })).not.toBe(digest);
    expect(fallbackIsStale(proposal, "evidence-2")).toBe(true);
    expect(fallbackIsStale(proposal, "evidence-1")).toBe(false);
  });

  test("service recommendations survive restart and do not apply themselves", () => {
    const database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    migrate(database, migrations);
    const first = new RouterV2Service(database, () => 1_700_000_000_000);
    first.savePolicy({ ...policy("lowest-cost"), scopeId: "global", quotaPolicy: "strict" });
    expect(() => first.savePolicy({ ...policy("custom"), scopeId: "global", weights: { quality: -1, cost: 0, latency: 0, quota: 0, history: 0 } })).toThrow(/0 to 100/);
    const restarted = new RouterV2Service(database, () => 1_700_000_000_000);
    expect(restarted.getPolicy("global").preset).toBe("lowest-cost");
    expect(restarted.getPolicy("global").quotaPolicy).toBe("strict");
    const recorded = restarted.recordRecommendation({ taskId: "task-1", projectId: "global", role: "developer" }, { preset: "balanced" });
    expect(recorded.authorizesExecution).toBe(false);
    const rows = database.query<{ authority: string; n: number }, []>("SELECT authority, COUNT(*) AS n FROM router_v2_decisions GROUP BY authority").all();
    expect(rows.every(row => row.authority === "recommendation" || row.n === 0)).toBe(true);
    const plan = restarted.proposeCapacityPlan([
      { projectPath: "alpha", projectPriority: "normal", task: { taskId: "t-1", projectId: "alpha", role: "developer" }, candidates: [candidate()] },
    ], policy("balanced"));
    const applied = restarted.applyPlan(plan, "not-the-digest");
    expect(applied.success).toBe(false);
    expect(database.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()?.n).toBe(0);
    database.close();
  });

  test("historical metrics ignore synthetic runs and keep forecast error unknown below the sample minimum", () => {
    const database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    migrate(database, migrations);
    const now = 1_700_000_000_000;
    database.run("INSERT INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at, task_type) VALUES ('task-real', 'Real', 'prompt', '/tmp/real', 'codex', 'ready', 'none', ?, ?, 'bug')", [now, now]);
    database.run("INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('run-synthetic', 'task-real', 'codex', 'succeeded', ?)", [now]);
    database.run("INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('run-real', 'task-real', 'codex', 'succeeded', ?)", [now + 1]);
    database.run("INSERT INTO run_events (run_id, stream, data, ts) VALUES ('run-synthetic', 'status', ?, ?)", [JSON.stringify({ kind: "execution-identity", executionType: "synthetic" }), now]);
    database.run("INSERT INTO run_events (run_id, stream, data, ts) VALUES ('run-real', 'status', ?, ?)", [JSON.stringify({ kind: "execution-identity", executionType: "real-provider", model: "gpt-real", accountProfile: { id: "acct-1" } }), now]);
    const insertExecution = (id: string, runId: string) => database.run(
      `INSERT INTO employee_executions (id, task_id, task_title, project_path, employee_id, employee_name, assignment_id, assignment_revision, status, requested_harness_id, requested_model, requested_complexity, requested_policy, requested_mode, inputs_key, task_fingerprint, config_json, review_json, created_at, updated_at, expires_at, approved_at, run_id, actual_harness_id, actual_model, actual_account_id, result, started_at, finished_at)
       VALUES (?, 'task-real', 'Real', '/tmp/real', 'employee', 'Employee', 'assignment', 1, 'started', 'codex', 'gpt-real', 'high', 'balanced', 'auto', 'k', 'f', '{}', '{}', ?, ?, ?, ?, ?, 'codex', 'gpt-real', 'acct-1', 'succeeded', ?, ?)`,
      [id, now, now, now + 10, now, runId, now, now + 5_000],
    );
    insertExecution("exec-synthetic", "run-synthetic");
    insertExecution("exec-real", "run-real");
    const metrics = queryModelExecutionMetrics(database, { harnessId: "codex", modelId: "gpt-real", accountId: "acct-1", role: "developer", category: "bug", complexity: "high" });
    expect(metrics.runCount).toBe(1);
    expect(metrics.isColdStart).toBe(true);
    expect(metrics.forecastErrorMs).toBeNull();
    expect(metrics.confidence).toBe("none");
    const reviewer = queryModelExecutionMetrics(database, { harnessId: "codex", modelId: "gpt-real", role: "reviewer" });
    expect(reviewer.runCount).toBe(0);
    database.close();
  });

  test("Head reads the router boundary and does not turn a question into approval", () => {
    const lines = headRouterEvidence("Why did you choose this model?", {
      scope: { kind: "task", id: "missing-task" }, label: "Missing", projectPath: null, projectAddedAt: null, clusterId: null,
    });
    expect(lines.some(line => line.includes(RECOMMENDATION_BOUNDARY))).toBe(true);
    expect(lines.some(line => line.includes("not found") || line.includes("No eligible") || line.includes("Recommended"))).toBe(true);
    expect(lines.join("\n")).not.toContain("authorized execution");
  });
});
