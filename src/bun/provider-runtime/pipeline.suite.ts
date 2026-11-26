/**
 * FO-PROVIDERS-PIPELINE01 disposable company.
 * Production AccountCore, tasks, Router, mission scheduler, employee launch,
 * QC, and analytics. Fake transports only. No provider process.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-providers-pipeline01-")));
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
process.env.AGETOR_FAKE_QC_VERDICT = "CHANGES_REQUESTED";
delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;

const { db, harnesses, projects, runs, tasks, taskQualityReviews } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("../claude-profiles.ts");
const { cancelRun, createTask } = await import("../orchestrator.ts");
const { initEmployeeExecutionTracking } = await import("../employee-run.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { missionScheduler } = await import("../orchestration/mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy } = await import("../autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal } = await import("../orchestration/mission-replan.ts");
const { stopProjectLifecycle } = await import("../project-lifecycle.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { acceptAuthorizedTaskDone } = await import("../task-quality-control.ts");
const { noteProviderFixture } = await import("./lease.ts");
const { gateMissionProviderLaunch, invokeAuthorizedLiveLauncher, productionCodexLauncher, productionClaudeLauncher } = await import("./pipeline.ts");
const { spawnCodexViaTmux } = await import("../codex-tmux.ts");
const { spawnClaudeViaTmux } = await import("../claude-tmux.ts");
const { selectProductionTransport } = await import("../../shared/provider-runtime/dispatch.ts");
const { taskActuals } = await import("../usage-analytics/actuals.ts");
const { analytics } = await import("../usage-analytics/analytics.ts");

initEmployeeExecutionTracking();
harnesses.setEnabled("codex", true);
harnesses.setEnabled("claude-code", true);
__setClaudeAuthProbeForTest(async (directory) => ({ loggedIn: directory.endsWith("claude-a"), configDirectory: directory }));

const core = new AccountCore(db);
const codex = new CodexProfiles(core);
const claude = new ClaudeProfiles(core);
const model = "gpt-6.1-sol";
const reviewerModel = "haiku-5.5";

function projectAt(name: string) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  projects.upsert(dir, name);
  return dir;
}

async function taskIn(title: string, workdir: string, agent: string, column: "backlog" | "ready", mode = "auto", modelId = model) {
  const created = await createTask({
    title, prompt: "Synthetic company work. Do not call a provider.", workdir, column, agent, model: modelId, mode, isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

test("the production coordinator runs a recorded company pipeline without a provider process", async () => {
  expect(productionCodexLauncher).toBe(spawnCodexViaTmux);
  expect(productionClaudeLauncher).toBe(spawnClaudeViaTmux);
  process.env.AGETOR_PROVIDER_LIVE_SPAWN = "authorized";
  const refused = await invokeAuthorizedLiveLauncher({ transport: "codex-live" });
  expect(refused).toMatchObject({ processStarted: false, launched: false, launcher: "spawnCodexViaTmux", launcherBound: true, code: "application-identity-unestablished" });
  delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;

  const codexADir = path.join(home, "codex-a");
  const codexBDir = path.join(home, "codex-b");
  writeSyntheticCodexProfile(codexADir, "synthetic-codex-a");
  writeSyntheticCodexProfile(codexBDir, "synthetic-codex-b");
  const codexA = codex.register({ displayName: "Codex A", directory: realpathSync(codexADir) });
  const codexB = codex.register({ displayName: "Codex B", directory: realpathSync(codexBDir) });
  const claudeADir = path.join(home, "claude-a");
  mkdirSync(claudeADir, { recursive: true });
  const claudeA = claude.register({ displayName: "Claude A", directory: realpathSync(claudeADir), homeAccessAccepted: true });
  expect(new Set([codexA.accountId, codexB.accountId, claudeA.accountId]).size).toBe(3);

  const now = Date.now();
  const definition = core.createDefinition({ accountId: codexA.accountId, scope: "account", category: "api-credit", unit: { kind: "money", currency: "USD" }, window: "shared" });
  core.recordTrustedObservations("recorded-contract", [{
    quotaId: definition.id,
    values: { observedAt: now - 1000, expiresAt: now + 43_200_000, resetAt: null, limit: 100, used: 60, remaining: 40, indicator: null, confidence: "high" },
    evidence: {
      provider: "openai", accountId: codexA.accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
      officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: now, sharedPool: null, limitations: "Recorded QA evidence",
    },
  }]);
  core.createDefinition({ accountId: claudeA.accountId, scope: "account", category: "subscription", unit: { kind: "requests" }, window: "unknown" });

  const paths = ["Project 1", "Project 2"].map(projectAt);
  db.run("INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["cluster-a", "Cluster A", "cluster-a", "Pipeline cluster", now, now]);
  for (const dir of paths) {
    db.run("INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)", [dir, "cluster-a", now, now]);
  }
  const employees = new EmployeeCore(db);
  const developer = employees.createWorker({ name: "Pipeline developer", jobTitle: "Developer", projectPath: paths[0]! });
  const assignments = new AssignmentCore(db);

  const life = await taskIn("Lifecycle", paths[0]!, codexA.harnessId, "ready");
  const failed = await taskIn("Provider failure", paths[0]!, codexA.harnessId, "ready");
  const cancelled = await taskIn("Cancellation", paths[0]!, codexA.harnessId, "ready");
  const pausedTask = await taskIn("Paused project", paths[1]!, codexA.harnessId, "ready");
  const cursorTask = await taskIn("Blocked Cursor", paths[0]!, "cursor", "backlog");
  const deepseekTask = await taskIn("Blocked DeepSeek", paths[0]!, "claude-code", "backlog", "auto", "deepseek-chat");
  for (const row of [life, failed, cancelled]) assignments.assign(row.id, developer.id);
  noteProviderFixture(failed.id, "developer", { outcome: "provider-error", tokens: null });
  noteProviderFixture(cancelled.id, "developer", { outcome: "hold", tokens: null });

  process.env.AGETOR_PROVIDER_LIVE_SPAWN = "authorized";
  const liveRefused = gateMissionProviderLaunch({
    missionId: "mission-probe", taskId: life.id, taskTitle: life.title, projectPath: paths[0]!, workspace: paths[0]!,
    role: "developer", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto",
    reservationId: "live-probe", employeeId: developer.id,
    live: {
      id: "forged", projectPath: paths[0]!, taskId: life.id, missionId: "mission-probe", role: "developer",
      providerId: "codex", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto",
      workspace: paths[0]!, filesystem: "workspace-write", terminal: false, envelopeId: null,
      runId: "live-probe", attemptId: "live-probe", scope: "developer:codex:auto",
      expiresAt: Date.now() + 60_000, grantedBy: "owner-live-acceptance",
    },
  });
  expect(liveRefused).toMatchObject({ ok: false, code: "application-identity-unestablished", processStarted: false });
  delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;
  expect(runs.listForTask(life.id)).toEqual([]);

  const mismatch = gateMissionProviderLaunch({
    missionId: "mission-probe", taskId: life.id, taskTitle: life.title, projectPath: paths[0]!, workspace: paths[0]!,
    role: "developer", harnessId: codexA.harnessId, modelId: model, accountId: codexB.accountId, mode: "auto",
    reservationId: "probe-reservation", employeeId: developer.id,
  });
  expect(mismatch).toMatchObject({ ok: false, processStarted: false });
  expect(runs.listForTask(life.id)).toEqual([]);

  await expect(missionScheduler.prepareMission({ title: "Cursor", goal: "Blocked", taskIds: [cursorTask.id] })).rejects.toThrow(/Cursor provider is not ready/);
  await expect(missionScheduler.prepareMission({ title: "DeepSeek", goal: "Blocked", taskIds: [deepseekTask.id] })).rejects.toThrow(/DeepSeek provider is not ready/);

  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: paths,
    specialistRoles: ["developer", "reviewer"], providers: ["codex", "claude-code"], models: [model, reviewerModel],
    accounts: [codexA.accountId, codexB.accountId, claudeA.accountId],
    maxConcurrentWorkers: 1, maxLaunches: 8, maxDurationMs: 300_000, maxReworkAttempts: 1, expiresAt: now + 300_000,
    permittedActions: ["plan_task", "launch_task", "run_qc", "request_rework"],
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
    completion: { autoComplete: false, conditions: ["qc_pass"] },
  });
  const activation = activateAutonomyPolicy(policy.id);
  const mission = await missionScheduler.prepareMission({
    title: "Pipeline company",
    goal: "Run the recorded provider path through QC",
    tasks: [
      { taskId: life.id, projectPath: paths[0]!, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "critical", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: true },
      { taskId: failed.id, projectPath: paths[0]!, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "high", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: true },
      { taskId: cancelled.id, projectPath: paths[0]!, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "normal", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false },
      { taskId: pausedTask.id, projectPath: paths[1]!, clusterId: "cluster-a", specialistRole: "developer", priority: "low", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false },
    ],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1, perClusterMax: 1 },
    policyOverride: { qcRequired: true, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
  });
  expect(mission.plan.tasks[0]).toMatchObject({ harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model });
  await missionScheduler.authorizeMission(mission.id, mission.planDigest);
  autonomyPolicyStore.upsertBinding({
    missionId: mission.id, policyId: policy.id, revision: policy.revision, activationId: activation.id, digest: policy.digest,
    mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  const proposal = prepareMissionResourceProposal(mission.id, {
    taskId: life.id, role: "reviewer",
    resource: { harnessId: claudeA.harnessId, modelId: reviewerModel, accountId: claudeA.accountId, mode: "bounded-print" },
    reason: "Owner approved a separate read-only reviewer account.",
  });
  settleMissionResourceProposal(mission.id, proposal.id, proposal.digest, "approve");
  const revised = missionStore.getMission(mission.id)!;
  expect(revised.plan.tasks.find(row => row.taskId === life.id)?.reviewerBinding).toMatchObject({
    accountId: claudeA.accountId, harnessId: claudeA.harnessId, mode: "bounded-print",
  });
  const stopped = await stopProjectLifecycle(paths[1]!, "Owner paused this project");
  expect(stopped.lifecycle.state).toBe("paused");
  missionStore.updateMissionStatus(mission.id, "running", "owner started");

  const planOf = () => missionStore.getMission(mission.id)!.plan.tasks;
  const rowOf = (id: string) => planOf().find(row => row.taskId === id)!;
  const until = async (ready: () => boolean, budget = 20_000) => {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await missionScheduler.tickMission(mission.id);
      if (ready()) return;
      await Bun.sleep(40);
    }
    throw new Error(`Timed out. Lifecycle ${rowOf(life.id).phase} ${rowOf(life.id).phaseReason ?? ""} / fail ${rowOf(failed.id).phase} ${rowOf(failed.id).phaseReason ?? ""} / cancel ${rowOf(cancelled.id).phase} ${rowOf(cancelled.id).phaseReason ?? ""}`);
  };

  await until(() => (rowOf(life.id).reworkEpoch ?? 0) >= 1);
  expect(tasks.get(life.id)?.column).not.toBe("done");
  expect(acceptAuthorizedTaskDone(life.id).ok).toBe(false);
  const firstReviews = taskQualityReviews.listForTask(life.id);
  expect(firstReviews.some(review => review.verdict === "CHANGES_REQUESTED")).toBe(true);
  expect(runs.listForTask(life.id).length).toBeGreaterThanOrEqual(2);

  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  await until(() => rowOf(life.id).phase === "awaiting_owner" || tasks.get(life.id)?.qcState?.latestVerdict === "PASS");
  expect(tasks.get(life.id)?.column).not.toBe("done");
  const accepted = acceptAuthorizedTaskDone(life.id);
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(accepted.task.column).toBe("done");

  let cancelRequested = false;
  await until(() => {
    const cancelRow = rowOf(cancelled.id);
    if (cancelRow.runId && !cancelRequested) {
      const live = runs.get(cancelRow.runId);
      if (live?.status === "running") {
        cancelRequested = true;
        void cancelRun(cancelRow.runId);
      }
    }
    return rowOf(life.id).phase === "completed" && rowOf(failed.id).phase === "failed" && rowOf(cancelled.id).phase === "cancelled" && rowOf(pausedTask.id).phase === "blocked";
  });

  expect(rowOf(pausedTask.id).phaseReason ?? "").toMatch(/paused|not running/i);
  expect(runs.listForTask(pausedTask.id)).toEqual([]);
  expect(runs.listForTask(failed.id)).toHaveLength(1);
  expect(runs.get(runs.listForTask(failed.id)[0]!.id)?.status).toBe("failed");
  expect(runs.listForTask(cancelled.id)).toHaveLength(1);
  expect(runs.get(runs.listForTask(cancelled.id)[0]!.id)?.status).toBe("cancelled");

  const lifeRuns = runs.listForTask(life.id);
  expect(lifeRuns.length).toBeGreaterThanOrEqual(4);
  const dispatch = db.query<{ data: string }, [string]>(
    "SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%\"kind\":\"provider-dispatch\"%'",
  );
  const developerDispatch = lifeRuns.flatMap(run => dispatch.all(run.id).map(row => JSON.parse(row.data) as { accountId: string; readOnly: boolean; processStarted: boolean; role: string; argv: string[] }));
  expect(developerDispatch.some(row => row.role === "developer" && row.accountId === codexA.accountId && row.readOnly === false && row.processStarted === false && row.argv.includes("workspace-write"))).toBe(true);
  expect(developerDispatch.some(row => row.role === "reviewer" && row.accountId === claudeA.accountId && row.readOnly === true && row.processStarted === false && row.argv.join(",").includes("Read,Glob,Grep") && !row.argv.join(",").includes("Edit"))).toBe(true);
  expect(developerDispatch.every(row => row.accountId !== codexB.accountId)).toBe(true);

  const actual = taskActuals(life.id);
  expect(actual).not.toBeNull();
  const developerRun = actual!.runs.find(run => run.role === "developer" && run.status === "succeeded");
  expect(developerRun?.tokens).toMatchObject({ input: 20, output: 5, cacheRead: 4, cacheWrite: 1 });
  expect(developerRun?.execution).toBe("synthetic");
  expect(developerRun?.accountId).toBe(codexA.accountId);
  expect(developerRun?.cost).toMatchObject({ kind: "unknown", money: null });
  expect(actual!.subscriptionQuota.status).toBe("unknown");
  expect(actual!.subscriptionQuota.statement).toContain("Unknown");
  const report = analytics({ taskId: life.id });
  expect(report.usage.realRuns).toBe(0);
  expect(report.usage.syntheticRuns).toBeGreaterThan(0);
  expect(report.usage.tokens.input).toBeNull();
  expect(report.company.models).toEqual([]);
  expect(report.tasks.some(item => item.id === life.id)).toBe(true);

  const before = db.query<{ id: string }, []>("SELECT id FROM runs ORDER BY id").all().map(run => run.id).sort();
  const receiptCount = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM run_events WHERE data LIKE 'usage-accounting: %' AND data LIKE '%recorded-fixture%'",
  ).get()!.n;
  expect(receiptCount).toBeGreaterThan(0);
  await missionScheduler.pauseMission(mission.id, "Checkpoint before recovery");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const child = spawnSync(process.execPath, ["--no-env-file", path.join(import.meta.dir, "pipeline-recover.ts")], {
    env: {
      ...process.env,
      AGETOR_DATA_DIR: process.env.AGETOR_DATA_DIR,
      HOME: home,
      FO_PIPELINE_RUNS: before.join(","),
      FO_PIPELINE_MISSIONS: mission.id,
      FO_PIPELINE_RECEIPTS: String(receiptCount),
    },
    encoding: "utf8",
  });
  expect(child.status, child.stderr || child.stdout).toBe(0);
  expect(selectProductionTransport({
    request: {
      providerId: "codex", harnessId: codexA.harnessId, accountId: codexA.accountId, boundAccountId: codexA.accountId,
      modelId: model, role: "developer", permissionMode: "auto", projectPath: paths[0]!, taskId: life.id, missionId: mission.id,
      runId: before[0]!, attemptId: before[0]!, profileDirectory: codexADir, homeAccessAccepted: false, transport: "recorded-fixture",
      installed: false, completedRunIds: before,
    },
    live: null, now: Date.now(), workspace: paths[0]!, filesystem: "workspace-write", terminal: false, envelopeId: null, scope: "developer:codex:auto",
  })).toMatchObject({ code: "duplicate-run", processStarted: false });
}, { timeout: 180_000 });
