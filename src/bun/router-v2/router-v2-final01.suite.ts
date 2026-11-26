/**
 * One disposable company for FO-ROUTER-FINAL01.
 * Real AccountCore, admission, scheduler, Router, proposals, and a second process.
 * Fake drivers only. No provider inference and no credential material.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { eliminateCandidate } from "../../shared/router-v2/evaluator.ts";
import { DEFAULT_ROUTER_POLICY } from "../../shared/router-v2/types.ts";
import { searchAllocation } from "../../shared/orchestration/allocation-search.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-router-final01-")));
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CURSOR_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { db, harnesses, projects, runs, tasks } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("../claude-profiles.ts");
const { createTask } = await import("../orchestrator.ts");
const { initEmployeeExecutionTracking } = await import("../employee-run.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { missionScheduler } = await import("../orchestration/mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy, revokeAutonomyPolicy } = await import("../autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal } = await import("../orchestration/mission-replan.ts");
const { stopProjectLifecycle } = await import("../project-lifecycle.ts");
const { routerV2Service } = await import("./router-v2-service.ts");
const { writeExecutionMeta } = await import("../multiaccount/registry.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { autonomyEnvelopeOverride } = await import("../orchestration/mission-resource.ts");

initEmployeeExecutionTracking();
harnesses.setEnabled("codex", true);
harnesses.setEnabled("claude-code", true);
__setClaudeAuthProbeForTest(async (directory) => ({ loggedIn: directory.endsWith("claude-a"), configDirectory: directory }));

const core = new AccountCore(db);
const codex = new CodexProfiles(core);
const claude = new ClaudeProfiles(core);
const model = "gpt-6.1-sol";

function projectAt(name: string) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  projects.upsert(dir, name);
  return dir;
}

function allRuns() {
  return db.query<{ id: string; agent: string; task_id: string; status: string }, []>("SELECT id, agent, task_id, status FROM runs ORDER BY id").all();
}

async function taskIn(title: string, workdir: string, agent: string, column: "backlog" | "ready", mode = "auto", modelId = model) {
  const created = await createTask({
    title, prompt: "Synthetic company work. Do not call a provider.", workdir, column, agent, model: modelId, mode, isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

test("the company uses production admission, shared capacity, pause, proposals, and a second process", async () => {
  const codexADir = path.join(home, "codex-a");
  const codexBDir = path.join(home, "codex-b");
  writeSyntheticCodexProfile(codexADir, "synthetic-codex-a");
  writeSyntheticCodexProfile(codexBDir, "synthetic-codex-b");
  const codexA = codex.register({ displayName: "Codex A", directory: realpathSync(codexADir) });
  const codexB = codex.register({ displayName: "Codex B", directory: realpathSync(codexBDir) });
  const claudeADir = path.join(home, "claude-a");
  const claudeBDir = path.join(home, "claude-b");
  mkdirSync(claudeADir, { recursive: true });
  mkdirSync(claudeBDir, { recursive: true });
  const claudeA = claude.register({ displayName: "Claude A", directory: realpathSync(claudeADir), homeAccessAccepted: true });
  const claudeB = claude.register({ displayName: "Claude B", directory: realpathSync(claudeBDir), homeAccessAccepted: true });
  expect(new Set([codexA.accountId, codexB.accountId, claudeA.accountId, claudeB.accountId]).size).toBe(4);
  expect(await codex.check(codexA.accountId)).toMatchObject({ authentication: "authenticated", quota: "unknown" });
  expect(await codex.check(codexB.accountId)).toMatchObject({ authentication: "authenticated" });
  expect((await claude.check(claudeA.accountId)).verifiedSubject).toBeNull();
  expect((await claude.check(claudeB.accountId)).availability).toBe("authentication-required");
  writeExecutionMeta(db, codexA.accountId, { concurrencyLimit: 1, providerSharedLimit: 1, configuredIdentity: "codex-a" });
  writeExecutionMeta(db, codexB.accountId, { concurrencyLimit: 1, configuredIdentity: "codex-b" });

  const now = Date.now();
  const shared = (accountId: string, window: string, remaining: number) => {
    const definition = core.createDefinition({ accountId, scope: "account", category: "api-credit", unit: { kind: "money", currency: "USD" }, window });
    core.recordTrustedObservations("recorded-contract", [{
      quotaId: definition.id,
      values: { observedAt: now - 1000, expiresAt: now + 43_200_000, resetAt: null, limit: 100, used: 100 - remaining, remaining, indicator: null, confidence: "high" },
      evidence: {
        provider: "openai", accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
        officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: now,
        sharedPool: { id: "shared-company", scope: "account", window, verified: true }, limitations: "Recorded QA evidence",
      },
    }]);
    return definition.id;
  };
  shared(codexA.accountId, "shared", 40);
  shared(codexB.accountId, "shared", 40);
  const independent = core.createDefinition({ accountId: codexB.accountId, scope: "account", category: "api-credit", unit: { kind: "money", currency: "USD" }, window: "independent" });
  core.recordTrustedObservations("recorded-contract", [{
    quotaId: independent.id,
    values: { observedAt: now - 1000, expiresAt: now + 43_200_000, resetAt: null, limit: 10, used: 7, remaining: 3, indicator: null, confidence: "high" },
    evidence: {
      provider: "openai", accountId: codexB.accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
      officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: now, sharedPool: null, limitations: "Recorded QA evidence",
    },
  }]);
  const exhausted = core.createDefinition({ accountId: claudeA.accountId, scope: "account", category: "api-credit", unit: { kind: "money", currency: "USD" }, window: "exhausted" });
  core.recordTrustedObservations("recorded-contract", [{
    quotaId: exhausted.id,
    values: { observedAt: now - 1000, expiresAt: now + 43_200_000, resetAt: now + 10_000, limit: 10, used: 10, remaining: 0, indicator: null, confidence: "high" },
    evidence: {
      provider: "anthropic", accountId: claudeA.accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
      officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: now, sharedPool: null, limitations: "Recorded QA evidence",
    },
  }]);
  const reported = core.createDefinition({ accountId: claudeA.accountId, scope: "account", category: "subscription", unit: { kind: "requests" }, window: "owner" });
  core.recordObservation(reported.id, { remaining: 90, limit: 100, used: 10, confidence: "low", expiresAt: now + 43_200_000 });
  core.createDefinition({ accountId: claudeB.accountId, scope: "account", category: "subscription", unit: { kind: "requests" }, window: "unknown" });

  for (const id of ["cluster-a", "cluster-b", "cluster-c"]) {
    db.run("INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [id, id, id, id, now, now]);
  }
  const paths = ["Project 1", "Project 2", "Project 3", "Project 4", "Project 5"].map(projectAt);
  paths.forEach((dir, index) => {
    db.run("INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)",
      [dir, ["cluster-a", "cluster-a", "cluster-b", "cluster-c", "cluster-b"][index]!, now, now]);
  });
  const employees = new EmployeeCore(db);
  const developer = employees.createWorker({ name: "Company developer", jobTitle: "Developer", projectPath: paths[0]! });
  const competitorDeveloper = employees.createWorker({ name: "Competing developer", jobTitle: "Developer", projectPath: paths[2]! });
  employees.createWorker({ name: "Company reviewer", jobTitle: "Reviewer", projectPath: paths[1]! });

  const pinned = await taskIn("Pinned Codex", paths[0]!, codexA.harnessId, "ready");
  const dependent = await taskIn("Dependent work", paths[1]!, codexA.harnessId, "ready");
  const competitor = await taskIn("Competing mission", paths[2]!, codexA.harnessId, "ready");
  const pausedTask = await taskIn("Paused project", paths[4]!, codexA.harnessId, "ready");
  const cursorTask = await taskIn("Blocked Cursor", paths[0]!, "cursor", "backlog");
  const deepseekTask = await taskIn("Blocked DeepSeek", paths[0]!, "claude-code", "backlog", "auto", "deepseek-chat");
  const bulk: string[] = [];
  for (let index = 0; index < 14; index++) {
    const claudeTask = index % 2 === 1;
    const row = await taskIn(
      `Company task ${index}`, paths[index % 5]!, claudeTask ? claudeA.harnessId : codexB.harnessId, "backlog", "auto", claudeTask ? "haiku-5.5" : model,
    );
    bulk.push(row.id);
  }
  expect(tasks.list().length).toBeGreaterThanOrEqual(20);
  const assignments = new AssignmentCore(db);
  assignments.assign(pinned.id, developer.id);
  assignments.assign(competitor.id, competitorDeveloper.id);

  const beforeRefusals = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orchestration_missions").get()!.n;
  await expect(missionScheduler.prepareMission({ title: "Cursor", goal: "Blocked", taskIds: [cursorTask.id] })).rejects.toThrow(/Cursor provider is not ready/);
  await expect(missionScheduler.prepareMission({ title: "DeepSeek", goal: "Blocked", taskIds: [deepseekTask.id] })).rejects.toThrow(/DeepSeek provider is not ready/);
  await expect(missionScheduler.prepareMission({
    title: "Reviewer write", goal: "Refuse", tasks: [{
      taskId: pinned.id, projectPath: paths[0]!, harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", specialistRole: "reviewer",
    }],
  })).rejects.toThrow(/No substitute was selected|refused/);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orchestration_missions").get()!.n).toBe(beforeRefusals);

  const gathered = routerV2Service.gatherCandidatesSync("developer");
  const pinnedCandidate = gathered.find(row => row.accountId === codexA.accountId && row.modelId === model && row.mode === "auto");
  const reportedCandidate = gathered.find(row => row.accountId === claudeA.accountId && row.modelId === "haiku-5.5");
  const unknownCandidate = gathered.find(row => row.accountId === claudeB.accountId);
  expect(pinnedCandidate?.harnessId).toBe(codexA.harnessId);
  expect(reportedCandidate?.quotaState.capacityEvidence === "owner-reported" || reportedCandidate?.quotaState.isUnknown).toBe(true);
  expect(unknownCandidate?.quotaState.isUnknown).toBe(true);
  const strict = { ...DEFAULT_ROUTER_POLICY, quotaPolicy: "strict" as const };
  if (reportedCandidate) expect(eliminateCandidate(reportedCandidate, { taskId: pinned.id, projectId: paths[0]!, role: "developer" }, strict).reasons.join(" ")).toMatch(/quota-unverified-strict|quota-unknown-strict/);
  if (unknownCandidate) expect(eliminateCandidate(unknownCandidate, { taskId: pinned.id, projectId: paths[0]!, role: "developer" }, strict).reasons.join(" ")).toContain("quota-unknown-strict");
  const empty = autonomyEnvelopeOverride({
    mode: "full-autonomy", scopeKind: "project", scopeRef: paths[0]!, projects: [paths[0]!],
    specialistRoles: ["developer"], providers: [], models: [], accounts: [], permittedActions: ["launch_task"],
    maxConcurrentWorkers: 1, maxLaunches: 1, maxDurationMs: 60_000, maxReworkAttempts: 0, expiresAt: now + 60_000,
    allowUnscopedAccount: false, spending: { requireEnforceableCap: false }, qc: { required: false }, completion: { autoComplete: false },
  } as never);
  const locked = routerV2Service.evaluateTaskSync({
    taskId: pinned.id, projectId: paths[0]!, role: "developer", requestedHarnessId: codexA.harnessId, requestedModelId: model, requestedAccountId: codexA.accountId, requestedMode: "auto",
  }, { policyOverride: empty });
  expect(locked.selected).toBeNull();
  expect(locked.explanation + locked.ineligible.flatMap(row => row.eliminationReasons).join(" ")).toMatch(/envelope|empty|not eligible/i);

  const admitted = await missionScheduler.prepareMission({
    title: "Pinned company mission", goal: "Keep the requested Codex account",
    tasks: [{
      taskId: pinned.id, projectPath: paths[0]!, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id,
      harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false,
    }, {
      taskId: dependent.id, projectPath: paths[1]!, clusterId: "cluster-a", specialistRole: "developer",
      dependencies: [{ taskId: pinned.id, projectPath: paths[0]!, condition: "done" }],
      harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false,
    }],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1, perClusterMax: 1 },
    policyOverride: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
  });
  expect(admitted.plan.tasks[0]).toMatchObject({ harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto" });
  expect(admitted.plan.tasks.some(row => row.harnessId.startsWith("claude"))).toBe(false);
  const catalog = await missionScheduler.prepareMission({
    title: "Company catalog", goal: "Admit without launching", taskIds: bulk,
    clusterIds: ["cluster-a", "cluster-b", "cluster-c"],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1, perClusterMax: 1 },
  });
  expect(catalog.plan.tasks).toHaveLength(14);
  expect(catalog.status).toBe("draft");
  expect(allRuns()).toHaveLength(0);

  const pausedMission = await missionScheduler.prepareMission({
    title: "Paused project mission", goal: "Do not launch",
    tasks: [{ taskId: pausedTask.id, projectPath: paths[4]!, harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false }],
    policyOverride: { qcRequired: false },
  });
  await missionScheduler.authorizeMission(pausedMission.id, pausedMission.planDigest);
  const stopped = await stopProjectLifecycle(paths[4]!, "Owner paused this project");
  expect(stopped.lifecycle.state).toBe("paused");
  missionStore.updateMissionStatus(pausedMission.id, "running", "owner started");
  await missionScheduler.tickMission(pausedMission.id);
  const pausedAfter = missionStore.getMission(pausedMission.id)!;
  expect(pausedAfter.plan.tasks[0]?.phase).toBe("blocked");
  expect(pausedAfter.plan.tasks[0]?.phaseReason ?? "").toMatch(/not running|paused/i);
  expect(runs.listForTask(pausedTask.id)).toEqual([]);

  const replanTask = await taskIn("Fallback subject", paths[3]!, codexA.harnessId, "ready");
  const replan = await missionScheduler.prepareMission({
    title: "Fallback mission", goal: "Owner settles the proposal",
    tasks: [{ taskId: replanTask.id, projectPath: paths[3]!, harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false }],
    policyOverride: { qcRequired: false },
  });

  const other = await missionScheduler.prepareMission({
    title: "Competing mission", goal: "Share the same account slot",
    tasks: [{ taskId: competitor.id, projectPath: paths[2]!, clusterId: "cluster-b", specialistRole: "developer", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false }],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1, perClusterMax: 1 },
    policyOverride: { qcRequired: false },
  });

  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: paths.slice(0, 4),
    specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: [model], accounts: [codexA.accountId, codexB.accountId],
    maxConcurrentWorkers: 1, maxLaunches: 4, maxDurationMs: 300_000, expiresAt: now + 300_000,
    permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  const bind = (missionId: string) => autonomyPolicyStore.upsertBinding({
    missionId, policyId: policy.id, revision: policy.revision, activationId: activation.id, digest: policy.digest,
    mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  await missionScheduler.authorizeMission(admitted.id, admitted.planDigest);
  await missionScheduler.authorizeMission(replan.id, replan.planDigest);
  bind(admitted.id);
  bind(replan.id);
  missionStore.updateMissionStatus(admitted.id, "running", "owner started");
  await missionScheduler.tickMission(admitted.id);
  const launched = missionStore.getMission(admitted.id)!;
  expect(launched.plan.tasks[0]?.phase, launched.plan.tasks[0]?.phaseReason).toBe("running");
  expect(launched.plan.tasks[1]?.runId ?? null).toBeNull();
  const firstRunId = launched.plan.tasks[0]!.runId!;
  const identity = db.query<{ data: string }, [string]>("SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%execution-identity%'").get(firstRunId);
  expect(JSON.parse(identity!.data)).toMatchObject({ executionType: "synthetic", accountProfile: { id: codexA.accountId }, model, mode: "auto" });
  expect(runs.listForTask(pinned.id)).toHaveLength(1);

  await missionScheduler.authorizeMission(other.id, other.planDigest);
  bind(other.id);
  missionStore.updateMissionStatus(other.id, "running", "owner started");
  await missionScheduler.tickMission(other.id);
  const waiting = missionStore.getMission(other.id)!;
  expect(waiting.plan.tasks[0]?.runId ?? null).toBeNull();
  expect(runs.listForTask(competitor.id)).toEqual([]);
  expect(`${waiting.plan.tasks[0]?.phaseReason ?? ""}`).toMatch(/slot|concurrency|capacity|Waiting/i);

  const replacement = routerV2Service.proposeFallback({
    requirements: { taskId: competitor.id, projectId: paths[2]!, role: "developer" },
    failed: { provider: "codex", runId: firstRunId, harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", reason: "provider-unavailable" },
    evidenceHash: "company-evidence",
    candidates: gathered.filter(row => row.accountId === codexB.accountId && row.modelId === model),
  });
  expect(replacement.authorizesExecution).toBe(false);
  expect(allRuns()).toHaveLength(1);

  const option = routerV2Service.gatherCandidatesSync("developer").find(row => row.accountId === codexB.accountId && row.modelId === model && row.mode === "auto");
  expect(option?.accountId).toBe(codexB.accountId);
  const rejected = prepareMissionResourceProposal(replan.id, {
    taskId: replanTask.id, role: "developer",
    resource: { harnessId: codexB.harnessId, modelId: model, accountId: codexB.accountId, mode: "auto" },
    reason: "Recorded resource failure. Reject this exact replacement.",
  });
  settleMissionResourceProposal(replan.id, rejected.id, rejected.digest, "reject");
  expect(missionStore.getMission(replan.id)!.revision).toBe(1);
  expect(missionStore.getMission(replan.id)!.plan.tasks[0]?.accountId).toBe(codexA.accountId);
  expect(() => settleMissionResourceProposal(replan.id, rejected.id, rejected.digest, "approve")).toThrow(/already settled/);
  const headProposal = prepareMissionResourceProposal(replan.id, {
    taskId: replanTask.id, role: "developer",
    resource: { harnessId: codexB.harnessId, modelId: model, accountId: codexB.accountId, mode: "auto" },
    reason: "Head prepared this and cannot approve it.",
  }, "head-message-1");
  expect(() => settleMissionResourceProposal(replan.id, headProposal.id, headProposal.digest, "approve", null)).toThrow(/Owner review/);
  settleMissionResourceProposal(replan.id, headProposal.id, headProposal.digest, "reject", "head-message-1");
  expect(missionStore.getMission(replan.id)!.revision).toBe(1);
  const approved = prepareMissionResourceProposal(replan.id, {
    taskId: replanTask.id, role: "developer",
    resource: { harnessId: codexB.harnessId, modelId: model, accountId: codexB.accountId, mode: "auto" },
    reason: "Owner approved this exact replacement.",
  });
  settleMissionResourceProposal(replan.id, approved.id, approved.digest, "approve");
  const revised = missionStore.getMission(replan.id)!;
  expect(revised.revision).toBe(2);
  expect(revised.plan.tasks[0]?.developerBinding).toMatchObject({ accountId: codexB.accountId, harnessId: codexB.harnessId, modelId: model });
  const prior = db.query<{ revision: number }, [string]>("SELECT revision FROM mission_plan_revisions WHERE mission_id = ?").get(replan.id);
  expect(prior?.revision).toBe(1);
  expect(runs.get(firstRunId)?.agent).toBe(codexA.harnessId);

  revokeAutonomyPolicy(policy.id);
  missionStore.updateMissionStatus(other.id, "paused", "held");
  const revokedPolicy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "project", scopeRef: paths[2]!, projects: [paths[2]!],
    specialistRoles: ["developer"], providers: ["codex"], models: [model], accounts: [codexA.accountId],
    maxConcurrentWorkers: 1, maxLaunches: 1, maxDurationMs: 300_000, expiresAt: now + 300_000,
    permittedActions: ["launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const revokedActivation = activateAutonomyPolicy(revokedPolicy.id);
  revokeAutonomyPolicy(revokedPolicy.id);
  autonomyPolicyStore.upsertBinding({
    missionId: other.id, policyId: revokedPolicy.id, revision: revokedPolicy.revision, activationId: revokedActivation.id,
    digest: revokedPolicy.digest, mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  missionStore.updateMissionStatus(other.id, "running", "revoked policy must not launch");
  await missionScheduler.tickMission(other.id);
  expect(runs.listForTask(competitor.id)).toEqual([]);

  const search = searchAllocation([
    { id: "one", dependsOn: [], projectId: paths[0], clusterId: "cluster-a", role: "developer", options: [{ id: "one-a", accountId: codexA.accountId, durationMs: 10, charge: 1, waitMs: 0, poolId: "shared-company", demand: 1, concurrency: 1, provider: "codex" }] },
    { id: "two", dependsOn: [], projectId: paths[2], clusterId: "cluster-b", role: "developer", options: [{ id: "two-a", accountId: codexA.accountId, durationMs: 10, charge: 1, waitMs: 0, poolId: "shared-company", demand: 1, concurrency: 1, provider: "codex" }] },
    { id: "held", dependsOn: [], projectId: paths[4], withheld: "Project is paused or draining.", options: [{ id: "held-a", accountId: codexB.accountId, durationMs: 10, charge: 1, waitMs: 0, poolId: null, demand: null, concurrency: 1 }] },
    { id: "cursor", dependsOn: [], options: [{ id: "cursor-a", accountId: "cursor", durationMs: 10, charge: 1, waitMs: 0, poolId: null, demand: null, concurrency: 1, provider: "cursor" }] },
  ], "fastest", [{ id: "shared-company", remaining: 1 }], true, 256, {
    globalMax: 1, perProjectMax: 1, perClusterMax: 1, perRoleMax: 1, blockedProviders: ["cursor", "deepseek"],
  });
  expect(search.feasible).toBe(false);
  expect(search.assignment).toEqual({});
  expect(search.withheld.held).toContain("paused");
  expect(search.reason).toMatch(/No feasible allocation/);
  expect(Object.values(search.assignment)).not.toContain("cursor-a");

  const settleBy = Date.now() + 5_000;
  while (Date.now() < settleBy && runs.get(firstRunId)?.status === "running") await Bun.sleep(20);
  expect(runs.get(firstRunId)?.status).not.toBe("running");
  await Bun.sleep(50);
  await missionScheduler.pauseMission(admitted.id, "Stop before recovery");
  try { await missionScheduler.pauseMission(other.id, "Stop before recovery"); } catch { missionStore.updateMissionStatus(other.id, "paused", "recovery"); }
  missionStore.updateMissionStatus(pausedMission.id, "paused", "recovery");
  const runIds = allRuns().map(run => run.id).sort();
  expect(runIds).toEqual([firstRunId]);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const child = spawnSync(process.execPath, ["--no-env-file", path.join(import.meta.dir, "router-v2-final01-recover.ts")], {
    env: {
      ...process.env,
      AGETOR_DATA_DIR: process.env.AGETOR_DATA_DIR,
      HOME: home,
      FO_ROUTER_FINAL_RUNS: runIds.join(","),
      FO_ROUTER_FINAL_MISSIONS: [admitted.id, other.id, pausedMission.id].join(","),
    },
    encoding: "utf8",
  });
  expect(child.status, child.stderr || child.stdout).toBe(0);
}, { timeout: 180_000 });
