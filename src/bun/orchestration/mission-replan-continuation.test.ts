/**
 * Synthetic Developer continuation after an atomic amendment.
 * The Codex binary is the local profile fixture. The agent driver is fake.
 * No provider CLI and no inference run.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.ts";
import type { MissionPlan } from "../../shared/orchestration/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-replan-continue-")));
process.env.HOME = join(root, "home");
process.env.AGETOR_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { db, harnesses, projects, runs, tasks } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("../claude-profiles.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { createTask } = await import("../orchestrator.ts");
const { initEmployeeExecutionTracking } = await import("../employee-run.ts");
const { missionStore } = await import("./mission-store.ts");
const { missionScheduler } = await import("./mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy } = await import("../autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal, missionResourceOptions } = await import("./mission-replan.ts");
const { missionResourceBlock, verifyMissionStage } = await import("./mission-resource.ts");
const { explainBinding } = await import("../multiaccount/binding.ts");
const { preparationActual } = await import("./mission-preparation.ts");
const { mkdirSync } = await import("node:fs");

initEmployeeExecutionTracking();
harnesses.setEnabled("codex", true);
const profiles = new CodexProfiles(new AccountCore(db));

test("an approved Developer amendment launches only the new synthetic account and does not replay", async () => {
  const home = process.env.HOME!;
  mkdirSync(home, { recursive: true });
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  projects.upsert(projectPath, "Continuation fixture");
  const account = (name: string) => {
    const directory = join(home, name);
    writeSyntheticCodexProfile(directory, "synthetic-" + name);
    return profiles.register({ displayName: name, directory });
  };
  const original = account("original");
  const replacement = account("replacement");
  const model = "gpt-6.1-sol";
  const created = await createTask({
    title: "Remaining developer stage", prompt: "Record the approved account.", workdir: projectPath,
    column: "ready", agent: original.harnessId, model, mode: "auto", isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const worker = new EmployeeCore(db).createWorker({ name: "Continuation", jobTitle: "Developer", projectPath });
  new AssignmentCore(db).assign(taskId, worker.id);
  const plan: MissionPlan = {
    clusters: [], projects: [projectPath], concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: [{
      taskId, taskTitle: created.task.title, projectPath, specialistRole: "developer", phase: "authorized", priority: "normal",
      dependencies: [], harnessId: original.harnessId, modelId: model, accountId: original.accountId, mode: "auto", qcRequired: false,
    }],
  };
  const mission = missionStore.createMission({
    title: "Continuation", goal: "synthetic", status: "authorized", projects: [projectPath], clusters: [],
    plan, planDigest: computeMissionPlanDigest(plan),
  });
  missionStore.updateMissionAuthorization(mission.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: mission.planDigest });
  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "project", scopeRef: projectPath, projects: [projectPath],
    specialistRoles: ["developer"], providers: ["codex"], models: [model],
    accounts: [original.accountId, replacement.accountId], maxConcurrentWorkers: 1, maxLaunches: 2,
    maxDurationMs: 300_000, expiresAt: Date.now() + 300_000,
    permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  autonomyPolicyStore.upsertBinding({
    missionId: mission.id, policyId: policy.id, revision: policy.revision, activationId: activation.id,
    digest: policy.digest, mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  const option = missionResourceOptions(mission.id, taskId, "developer").find(row => row.accountId === replacement.accountId && row.modelId === model);
  expect(option?.resource.mode).toBe("auto");
  const proposal = prepareMissionResourceProposal(mission.id, {
    taskId, role: "developer", resource: option!.resource, reason: "Continue on the approved replacement account",
  });
  settleMissionResourceProposal(mission.id, proposal.id, proposal.digest, "approve");
  const revised = missionStore.getMission(mission.id)!;
  expect(revised.revision).toBe(2);
  expect(revised.plan.tasks[0]?.developerBinding).toMatchObject({
    accountId: replacement.accountId, harnessId: replacement.harnessId, modelId: model, mode: "auto",
  });
  expect(missionResourceBlock(revised, revised.plan.tasks[0]!, "developer", revised.plan.tasks[0]!.developerBinding!)).toBeNull();
  expect(verifyMissionStage({ ...revised, status: "running" }, revised.plan.tasks[0]!, "developer", {
    ...revised.plan.tasks[0]!.developerBinding!, harnessId: "cursor",
  })).toBeTruthy();
  missionStore.updateMissionStatus(mission.id, "running", "owner resumed");
  const running = missionStore.getMission(mission.id)!;
  expect(verifyMissionStage(running, running.plan.tasks[0]!, "developer", running.plan.tasks[0]!.developerBinding!)).toBeNull();
  await missionScheduler.tickMission(mission.id);
  const launched = missionStore.getMission(mission.id)!;
  expect(launched.plan.tasks[0]?.phase, launched.plan.tasks[0]?.phaseReason).toBe("running");
  const identity = db.query<{ data: string }, [string]>(
    `SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%"kind":"execution-identity"%'`,
  ).get(launched.plan.tasks[0]!.runId!)!;
  expect(JSON.parse(identity.data)).toMatchObject({
    executionType: "synthetic", provider: "codex", model, mode: "auto",
    accountProfile: { id: replacement.accountId },
  });
  expect(runs.listForTask(taskId)).toHaveLength(1);
  expect(preparationActual(taskId, Date.now()).status).toBe("completed");
  const before = runs.listForTask(taskId).map(run => run.id);
  await missionScheduler.tickMission(mission.id);
  expect(runs.listForTask(taskId).map(run => run.id)).toEqual(before);

  const otherId = crypto.randomUUID();
  const at = Date.now();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,created_at,updated_at)
    VALUES (?,?,?,'ready',?,?,?,'auto','none',?,?)`, [otherId, "Interrupted preparation", "Do not launch.", replacement.harnessId, projectPath, model, at, at]);
  missionStore.createReservation({
    missionId: mission.id, taskId: otherId, projectPath, employeeId: worker.id, accountId: replacement.accountId,
    harnessId: replacement.harnessId, modelId: model, status: "starting",
  });
  await missionScheduler.tickMission(mission.id);
  expect(preparationActual(otherId, Date.now())).toMatchObject({ status: "interrupted", durationMs: null });
  expect(runs.listForTask(otherId)).toEqual([]);
  expect(runs.listForTask(taskId).map(run => run.id)).toEqual(before);
});

test("Claude compatibility is validated and blocked providers stay blocked", async () => {
  __setClaudeAuthProbeForTest(async (directory) => ({ loggedIn: directory.endsWith("claude-compatible"), configDirectory: directory }));
  const directory = join(root, "home", "claude-compatible");
  mkdirSync(directory, { recursive: true });
  const claude = new ClaudeProfiles(new AccountCore(db)).register({
    displayName: "Claude compatible", directory: realpathSync(directory), homeAccessAccepted: true,
  });
  const projectPath = join(root, "claude-project");
  mkdirSync(projectPath);
  projects.upsert(projectPath, "Claude validation");
  const taskId = crypto.randomUUID();
  const now = Date.now();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'ready',?,?,'haiku-5.5','auto',?,?)`, [taskId, "Claude check", "Do not launch.", claude.harnessId, projectPath, now, now]);
  const model = "haiku-5.5";
  const plan: MissionPlan = {
    clusters: [], projects: [projectPath], concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
    executionPolicy: { qcRequired: true, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: [{
      taskId, taskTitle: "Claude check", projectPath, specialistRole: "developer", phase: "authorized", priority: "normal",
      dependencies: [], harnessId: claude.harnessId, modelId: model, accountId: claude.accountId, mode: "auto", qcRequired: true,
    }],
  };
  const mission = missionStore.createMission({
    title: "Claude validation", goal: "no execution", status: "authorized", projects: [projectPath], clusters: [],
    plan, planDigest: computeMissionPlanDigest(plan),
  });
  missionStore.updateMissionAuthorization(mission.id, { authorizedAt: now, authorizedBy: "owner", digest: mission.planDigest });
  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "project", scopeRef: projectPath, projects: [projectPath],
    specialistRoles: ["developer", "reviewer"], providers: ["codex", "claude-code"], models: [model, "gpt-6.1-sol"],
    accounts: [claude.accountId], maxConcurrentWorkers: 1, maxLaunches: 1, maxDurationMs: 300_000, expiresAt: now + 300_000,
    permittedActions: ["plan_task", "launch_task", "run_qc"], qc: { required: true }, completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  autonomyPolicyStore.upsertBinding({
    missionId: mission.id, policyId: policy.id, revision: policy.revision, activationId: activation.id,
    digest: policy.digest, mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  const stored = missionStore.getMission(mission.id)!;
  const frozen = (mode: string) => {
    const exact = explainBinding({ harnessId: claude.harnessId, modelId: model, accountId: claude.accountId, mode, provider: "claude-code" });
    if (!exact.ok || !exact.frozen) throw new Error(exact.ok ? "Claude binding was not frozen" : exact.reason);
    return { ...exact.frozen, revision: stored.revision };
  };
  const developer = frozen("auto");
  const reviewer = frozen("bounded-print");
  expect(missionResourceBlock(stored, stored.plan.tasks[0]!, "developer", developer)).toBeNull();
  expect(missionResourceBlock(stored, stored.plan.tasks[0]!, "reviewer", reviewer)).toBeNull();
  expect(missionResourceBlock(stored, stored.plan.tasks[0]!, "developer", { ...developer, harnessId: "cursor" })).toBeTruthy();
  expect(missionResourceBlock(stored, stored.plan.tasks[0]!, "developer", { ...developer, harnessId: "deepseek" })).toBeTruthy();
  expect(runs.listForTask(taskId)).toEqual([]);
});
