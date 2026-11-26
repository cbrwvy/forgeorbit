/**
 * Direction 10 — Reliable multi-account management: offline launch & resume binding verification.
 * Uses disposable Codex and Claude profile fixture directories and fake drivers only.
 * Never opens real accounts or provider homes, never runs inference, login, quota or billing calls.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { computeMissionPlanDigest } from "../shared/orchestration/plan-digest.ts";
import type { MissionPlan } from "../shared/orchestration/types.ts";
import { CLAUDE_PROFILE_LIMITATIONS } from "../shared/accounts/claude-profile.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-direction10-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome, { recursive: true });
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { db, harnesses, projects, runs, tasks } = await import("./db.ts");
const { AccountCore } = await import("./account-core.ts");
const { CodexProfiles } = await import("./codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("./claude-profiles.ts");
const { buildCommand, harnessEnv, spawnAgent } = await import("./agents.ts");
const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
const { getRunExecution } = await import("./run-execution.ts");
const { explainBinding, authenticateBinding } = await import("./multiaccount/binding.ts");
const { listExecutionProfiles, noteAuthenticationCheck, writeExecutionMeta } = await import("./multiaccount/registry.ts");
const { activeProviderRefusal } = await import("./provider-refusals.ts");
const { initEmployeeExecutionTracking } = await import("./employee-run.ts");
const { EmployeeCore } = await import("./employee-core.ts");
const { AssignmentCore } = await import("./assignment-core.ts");
const { missionStore } = await import("./orchestration/mission-store.ts");
const { missionScheduler } = await import("./orchestration/mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy } = await import("./autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("./autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal, missionResourceOptions } = await import("./orchestration/mission-replan.ts");

initEmployeeExecutionTracking();
harnesses.setEnabled("codex", true);
harnesses.setEnabled("claude-code", true);

const core = new AccountCore(db);
const codexProfiles = new CodexProfiles(core);
const claudeProfiles = new ClaudeProfiles(core);

const projectPath = path.join(root, "project-d10");
mkdirSync(projectPath, { recursive: true });
projects.upsert(projectPath, "Direction 10 Project");

function makeCodexDir(name: string, subject: string): string {
  const dir = path.join(ownerHome, name);
  writeSyntheticCodexProfile(dir, subject);
  return realpathSync(dir);
}

function makeClaudeDir(name: string): string {
  const dir = path.join(ownerHome, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

async function waitForRunSettled(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runs.get(runId);
    if (run && run.status !== "running") return run;
    await Bun.sleep(25);
  }
  throw new Error(`Run ${runId} did not settle within ${timeoutMs}ms`);
}

afterAll(() => {
  __setClaudeAuthProbeForTest(null);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("1. Two disposable Codex profiles bind exactly on launch and resume paths, and record the approved profile in history", async () => {
  const dirA = makeCodexDir("codex-alpha", "subject-alpha");
  const dirB = makeCodexDir("codex-beta", "subject-beta");

  const profileA = codexProfiles.register({ displayName: "Codex Alpha Long Profile Name", directory: dirA });
  const profileB = codexProfiles.register({ displayName: "Codex Beta Long Profile Name", directory: dirB });

  expect(profileA.accountId).not.toBe(profileB.accountId);
  expect(profileA.harnessId).not.toBe(profileB.harnessId);
  expect(profileA.directory).toBe(dirA);
  expect(profileB.directory).toBe(dirB);

  const checkA = await codexProfiles.check(profileA.accountId);
  const checkB = await codexProfiles.check(profileB.accountId);
  expect(checkA).toMatchObject({ authentication: "authenticated", availability: "ready", quota: "unknown" });
  expect(checkB).toMatchObject({ authentication: "authenticated", availability: "ready", quota: "unknown" });
  noteAuthenticationCheck(db, profileA.accountId, "authenticated", Date.now());
  noteAuthenticationCheck(db, profileB.accountId, "authenticated", Date.now());

  const harnessA = harnesses.get(profileA.harnessId)!;
  const harnessB = harnesses.get(profileB.harnessId)!;
  expect(harnessEnv(harnessA)).toMatchObject({ CODEX_HOME: dirA, FORGEORBIT_CODEX_PROFILE_FILE_AUTH: "1" });
  expect(harnessEnv(harnessB)).toMatchObject({ CODEX_HOME: dirB, FORGEORBIT_CODEX_PROFILE_FILE_AUTH: "1" });
  expect(buildCommand(harnessA, "init", { model: "gpt-6.1-sol", effort: "low", mode: "auto", codexWorkspaceLayout: "non-git" }).env?.CODEX_HOME).toBe(dirA);
  expect(buildCommand(harnessB, "init", { model: "gpt-6.1-sol", effort: "low", mode: "auto", codexWorkspaceLayout: "non-git" }).env?.CODEX_HOME).toBe(dirB);

  // Actual launch path (startTask) on Profile A.
  const createdA = await createTask({
    title: "Task on Profile A",
    prompt: "Initial turn on Profile A",
    workdir: projectPath,
    column: "ready",
    agent: profileA.harnessId,
    model: "gpt-6.1-sol",
    effort: "low",
    mode: "auto",
    isolation: "none",
  });
  if ("error" in createdA) throw new Error(createdA.error);
  const taskA = createdA.task;

  const launchedA = await startTask(taskA.id);
  if ("error" in launchedA) throw new Error(launchedA.error);
  const runA1 = await waitForRunSettled(launchedA.runId);
  expect(runA1.status).toBe("succeeded");
  expect(runA1.agent).toBe(profileA.harnessId);
  expect(runA1.codexSessionId).toBe(`fake-codex-thread-${taskA.id}`);

  const execA1 = getRunExecution(runA1.id)!;
  expect(execA1.accountProfile).toEqual({
    id: profileA.accountId,
    displayName: "Codex Alpha Long Profile Name",
    harnessId: profileA.harnessId,
  });

  // Actual resume path (sendInput -> spawnCodexTurnNow) on Profile A.
  const resumedA = await sendInput(runA1.id, "Follow-up resume on Profile A");
  expect(resumedA.delivered).toBe(true);
  if (!resumedA.delivered) throw new Error(resumedA.reason);
  expect(resumedA.runId).not.toBe(runA1.id);
  const runA2 = await waitForRunSettled(resumedA.runId);
  expect(runA2.status, JSON.stringify(runs.events(runA2.id))).toBe("succeeded");
  expect(runA2.agent).toBe(profileA.harnessId);
  expect(runA2.codexSessionId).toBe(runA1.codexSessionId);

  const execA2 = getRunExecution(runA2.id)!;
  expect(execA2.accountProfile).toEqual({
    id: profileA.accountId,
    displayName: "Codex Alpha Long Profile Name",
    harnessId: profileA.harnessId,
  });

  // Separate launch and resume on Profile B stays attributed to Profile B.
  const createdB = await createTask({
    title: "Task on Profile B",
    prompt: "Initial turn on Profile B",
    workdir: projectPath,
    column: "ready",
    agent: profileB.harnessId,
    model: "gpt-6.1-sol",
    effort: "low",
    mode: "auto",
    isolation: "none",
  });
  if ("error" in createdB) throw new Error(createdB.error);
  const launchedB = await startTask(createdB.task.id);
  if ("error" in launchedB) throw new Error(launchedB.error);
  const runB1 = await waitForRunSettled(launchedB.runId);
  expect(runB1.status).toBe("succeeded");
  expect(getRunExecution(runB1.id)!.accountProfile?.id).toBe(profileB.accountId);

  const resumedB = await sendInput(runB1.id, "Follow-up resume on Profile B");
  expect(resumedB.delivered).toBe(true);
  if (!resumedB.delivered) throw new Error(resumedB.reason);
  const runB2 = await waitForRunSettled(resumedB.runId);
  expect(runB2.status).toBe("succeeded");
  expect(getRunExecution(runB2.id)!.accountProfile?.id).toBe(profileB.accountId);
});

test("2. Disabled profile, replaced directory, failed status check, or mismatched account refuses launch and resume without fallback", async () => {
  const listed = codexProfiles.list();
  const profileA = listed.find((p) => p.displayName.includes("Alpha"))!;
  const profileB = listed.find((p) => p.displayName.includes("Beta"))!;
  const taskA = tasks.list().find((t) => t.title === "Task on Profile A")!;
  const lastRunA = runs.listForTask(taskA.id)[0]!;

  const countRuns = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;

  // (a) Disabled profile refuses both launch and resume.
  writeExecutionMeta(db, profileA.accountId, { disabled: true });
  const beforeDisabled = countRuns();
  expect(explainBinding({ harnessId: profileA.harnessId, accountId: profileA.accountId, modelId: "gpt-6.1-sol", mode: "auto" }).ok).toBe(false);
  const disabledLaunch = await startTask(taskA.id);
  expect("error" in disabledLaunch).toBe(true);
  if ("error" in disabledLaunch) expect(disabledLaunch.error).toMatch(/disabled/i);
  const disabledResume = await sendInput(lastRunA.id, "Attempt resume while disabled");
  expect(disabledResume.delivered).toBe(false);
  if (!disabledResume.delivered) expect(disabledResume.reason).toMatch(/disabled/i);
  expect(countRuns()).toBe(beforeDisabled);
  writeExecutionMeta(db, profileA.accountId, { disabled: false });
  await codexProfiles.check(profileA.accountId);

  // (b) Replaced directory (changed inode dev:ino) refuses both launch and resume.
  const replacedBackup = `${profileA.directory}-backup`;
  rmSync(replacedBackup, { recursive: true, force: true });
  rmSync(profileA.directory, { recursive: true, force: true });
  // Create an extra directory first so the recreated profileA.directory gets a distinct inode.
  mkdirSync(replacedBackup, { recursive: true, mode: 0o700 });
  writeSyntheticCodexProfile(profileA.directory, "subject-alpha-replaced");

  const beforeReplaced = countRuns();
  expect(codexProfiles.view(profileA.accountId).availability).toBe("unavailable");
  const replacedBinding = explainBinding({ harnessId: profileA.harnessId, accountId: profileA.accountId, modelId: "gpt-6.1-sol", mode: "auto" });
  expect(replacedBinding.ok).toBe(false);
  if (!replacedBinding.ok) expect(replacedBinding.reason).toMatch(/replaced/i);

  const replacedLaunch = await startTask(taskA.id);
  expect("error" in replacedLaunch).toBe(true);
  if ("error" in replacedLaunch) expect(replacedLaunch.error).toMatch(/no default fallback|replaced/i);
  const replacedResume = await sendInput(lastRunA.id, "Attempt resume after directory replacement");
  expect(replacedResume.delivered).toBe(false);
  if (!replacedResume.delivered) expect(replacedResume.reason).toMatch(/replaced|no fallback/i);
  expect(countRuns()).toBe(beforeReplaced);
  rmSync(replacedBackup, { recursive: true, force: true });

  // Re-registering the directory through the Owner path restores readiness after explicit Check.
  codexProfiles.register({ displayName: profileA.displayName, directory: profileA.directory }, profileA.accountId);
  expect((await codexProfiles.check(profileA.accountId)).availability).toBe("ready");

  // (c) Failed status check (missing authentication marker) refuses both launch and resume.
  const markerPath = path.join(profileA.directory, "synthetic-authenticated");
  unlinkSync(markerPath);
  const beforeUnauthed = countRuns();
  const failedCheck = await codexProfiles.check(profileA.accountId);
  expect(failedCheck.availability).toBe("authentication-required");
  const unauthedLaunch = await startTask(taskA.id);
  expect("error" in unauthedLaunch).toBe(true);
  if ("error" in unauthedLaunch) expect(unauthedLaunch.error).toMatch(/unavailable|no default fallback/i);
  const unauthedResume = await sendInput(lastRunA.id, "Attempt resume with failed status check");
  expect(unauthedResume.delivered).toBe(false);
  if (!unauthedResume.delivered) expect(unauthedResume.reason).toMatch(/unavailable|no default fallback/i);
  expect(countRuns()).toBe(beforeUnauthed);

  // Restore authentication marker and re-check.
  writeFileSync(markerPath, "subject-alpha", { mode: 0o600 });
  expect((await codexProfiles.check(profileA.accountId)).availability).toBe("ready");

  // (d) Mismatched account refuses structural binding, authentication binding, cross-profile resume, and ambient resume.
  const mismatchBinding = explainBinding({ harnessId: profileA.harnessId, accountId: profileB.accountId, modelId: "gpt-6.1-sol", mode: "auto" });
  expect(mismatchBinding.ok).toBe(false);
  if (!mismatchBinding.ok) expect(mismatchBinding.reason).toMatch(/mismatch/i);
  const ambientOnManaged = explainBinding({ harnessId: profileA.harnessId, accountId: null, modelId: "gpt-6.1-sol", mode: "auto" });
  expect(ambientOnManaged.ok).toBe(false);
  if (!ambientOnManaged.ok) expect(ambientOnManaged.reason).toMatch(/ambient default was not used/i);

  const beforeMismatch = countRuns();
  // Switch task.agent to Profile B and attempt to resume Profile A's run.
  tasks.update(taskA.id, { agent: profileB.harnessId });
  const crossProfileResume = await sendInput(lastRunA.id, "Attempt cross-profile resume on Profile B");
  expect(crossProfileResume.delivered).toBe(false);
  if (!crossProfileResume.delivered) expect(crossProfileResume.reason).toMatch(/Account mismatch/i);

  // Switch task.agent to ambient "codex" and attempt to resume Profile A's run.
  tasks.update(taskA.id, { agent: "codex" });
  const ambientResume = await sendInput(lastRunA.id, "Attempt ambient resume on default codex");
  expect(ambientResume.delivered).toBe(false);
  if (!ambientResume.delivered) expect(ambientResume.reason).toMatch(/Account mismatch/i);

  // Direct spawnAgent with Profile A's session id on Profile B or ambient "codex" also throws.
  await expect(
    spawnAgent({
      taskId: taskA.id,
      runId: "mismatch-direct-b",
      harness: harnesses.get(profileB.harnessId)!,
      prompt: "resume",
      cwd: projectPath,
      onChunk: () => {},
      opts: { model: "gpt-6.1-sol", effort: "low", mode: "auto", resumeSessionId: lastRunA.codexSessionId },
    }),
  ).rejects.toThrow(/Account mismatch/i);

  await expect(
    spawnAgent({
      taskId: taskA.id,
      runId: "mismatch-direct-ambient",
      harness: harnesses.get("codex")!,
      prompt: "resume",
      cwd: projectPath,
      onChunk: () => {},
      opts: { model: "gpt-6.1-sol", effort: "low", mode: "auto", resumeSessionId: lastRunA.codexSessionId },
    }),
  ).rejects.toThrow(/Account mismatch/i);

  expect(countRuns()).toBe(beforeMismatch);
  tasks.update(taskA.id, { agent: profileA.harnessId });
});

test("3. Quota refusal stays attributed to the correct account, never retries or switches automatically, and a fallback requires explicit approval", async () => {
  const listed = codexProfiles.list();
  const profileA = listed.find((p) => p.displayName.includes("Alpha"))!;
  const profileB = listed.find((p) => p.displayName.includes("Beta"))!;
  await codexProfiles.check(profileA.accountId);
  await codexProfiles.check(profileB.accountId);
  noteAuthenticationCheck(db, profileA.accountId, "authenticated", Date.now());
  noteAuthenticationCheck(db, profileB.accountId, "authenticated", Date.now());

  const created = await createTask({
    title: "Refused task on Profile A",
    prompt: "Trigger refusal __fake_provider__:usage-limit",
    workdir: projectPath,
    column: "ready",
    agent: profileA.harnessId,
    model: "gpt-6.1-sol",
    effort: "low",
    mode: "auto",
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const refusedTask = created.task;

  const runsBefore = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  const started = await startTask(refusedTask.id);
  if ("error" in started) throw new Error(started.error);
  const settled = await waitForRunSettled(started.runId);
  expect(settled.status).toBe("failed");

  // Exactly 1 run was created (no automatic retry on Profile A, Profile B, or ambient codex).
  const runsAfter = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  expect(runsAfter).toBe(runsBefore + 1);
  expect(getRunExecution(settled.id)!.accountProfile?.id).toBe(profileA.accountId);

  // Refusal is attributed strictly to Profile A; Profile B has no refusal.
  const viewA = codexProfiles.view(profileA.accountId);
  const viewB = codexProfiles.view(profileB.accountId);
  expect(viewA.providerRefusal).not.toBeNull();
  expect(viewA.providerRefusal?.accountId).toBe(profileA.accountId);
  expect(viewA.providerRefusal?.harnessId).toBe(profileA.harnessId);
  expect(viewA.providerRefusal?.kind).toBe("usage-limit");
  expect(viewB.providerRefusal).toBeNull();
  expect(activeProviderRefusal({ harnessId: profileB.harnessId, accountId: profileB.accountId, modelId: "gpt-6.1-sol" })).toBeNull();

  // An already-supported fallback in a mission requires explicit Owner approval bound to the proposal digest.
  const missionTaskRes = await createTask({
    title: "Mission fallback task",
    prompt: "Run on approved fallback",
    workdir: projectPath,
    column: "ready",
    agent: profileA.harnessId,
    model: "gpt-6.1-sol",
    effort: "low",
    mode: "auto",
    isolation: "none",
  });
  if ("error" in missionTaskRes) throw new Error(missionTaskRes.error);
  const missionTask = missionTaskRes.task;
  const worker = new EmployeeCore(db).createWorker({ name: "D10 Worker", jobTitle: "Developer", projectPath });
  new AssignmentCore(db).assign(missionTask.id, worker.id);

  const plan: MissionPlan = {
    clusters: [],
    projects: [projectPath],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: [{
      taskId: missionTask.id,
      taskTitle: missionTask.title,
      projectPath,
      specialistRole: "developer",
      phase: "authorized",
      priority: "normal",
      dependencies: [],
      harnessId: profileA.harnessId,
      modelId: "gpt-6.1-sol",
      accountId: profileA.accountId,
      mode: "auto",
      qcRequired: false,
    }],
  };
  const m = missionStore.createMission({
    title: "D10 Mission",
    goal: "Verify explicit fallback approval",
    status: "authorized",
    projects: [projectPath],
    clusters: [],
    plan,
    planDigest: computeMissionPlanDigest(plan),
  });
  missionStore.updateMissionAuthorization(m.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: m.planDigest });
  const policy = createAutonomyPolicy({
    mode: "full-autonomy",
    scopeKind: "project",
    scopeRef: projectPath,
    projects: [projectPath],
    specialistRoles: ["developer"],
    providers: ["codex", "openai"],
    models: ["gpt-6.1-sol"],
    accounts: [profileA.accountId, profileB.accountId],
    allowUnscopedAccount: false,
    permittedActions: ["plan_task", "launch_task", "select_model"],
    maxConcurrentWorkers: 1,
    maxLaunches: 4,
    maxDurationMs: 300_000,
    expiresAt: Date.now() + 300_000,
    qc: { required: false },
    completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  autonomyPolicyStore.upsertBinding({
    missionId: m.id,
    policyId: policy.id,
    revision: policy.revision,
    activationId: activation.id,
    digest: policy.digest,
    mode: "full-autonomy",
    outcome: "active",
    summary: null,
    emergencyTaskIds: [],
  });

  // Prepare a fallback proposal from Profile A to Profile B. Preparing starts nothing and changes no binding.
  const RunsBeforeProposal = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  const optionB = missionResourceOptions(m.id, missionTask.id, "developer").find((row) => row.accountId === profileB.accountId && row.modelId === "gpt-6.1-sol")!;
  expect(optionB).toBeDefined();
  const proposal = prepareMissionResourceProposal(m.id, {
    taskId: missionTask.id,
    role: "developer",
    resource: optionB.resource,
    reason: "Switch from refused Profile A to Profile B",
  });
  expect(proposal.status).toBe("pending");
  expect(missionStore.getMission(m.id)!.plan.tasks[0]!.accountId).toBe(profileA.accountId);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(RunsBeforeProposal);

  // A wrong digest is refused and leaves the stage on Profile A.
  expect(() => settleMissionResourceProposal(m.id, proposal.id, "0".repeat(proposal.digest.length), "approve")).toThrow();
  expect(missionStore.getMission(m.id)!.plan.tasks[0]!.accountId).toBe(profileA.accountId);

  // Explicit Owner approval updates the mission binding to Profile B and still starts no run on its own.
  const settledProposal = settleMissionResourceProposal(m.id, proposal.id, proposal.digest, "approve");
  expect(settledProposal.status).toBe("approved");
  const updatedMission = missionStore.getMission(m.id)!;
  expect(updatedMission.revision).toBe(2);
  expect(updatedMission.plan.tasks[0]!.accountId).toBe(profileB.accountId);
  expect(updatedMission.plan.tasks[0]!.harnessId).toBe(profileB.harnessId);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(RunsBeforeProposal);

  // Separate mission dispatch now launches on the approved Profile B and records Profile B in history.
  await codexProfiles.check(profileB.accountId);
  noteAuthenticationCheck(db, profileB.accountId, "authenticated", Date.now());
  missionStore.updateMissionStatus(m.id, "running", "owner started");
  await missionScheduler.tickMission(m.id);
  const launchedStage = missionStore.getMission(m.id)!.plan.tasks[0]!;
  expect(launchedStage.accountId).toBe(profileB.accountId);
  expect(launchedStage.harnessId).toBe(profileB.harnessId);
  expect(launchedStage.runId).toBeTruthy();
  const fallbackRun = await waitForRunSettled(launchedStage.runId!);
  expect(getRunExecution(fallbackRun.id)!.accountProfile?.id).toBe(profileB.accountId);
  expect(fallbackRun.agent).toBe(profileB.harnessId);
});

test("4. Claude profile path keeps HOME and Keychain limitations visible, requires HOME acceptance, and binds CLAUDE_CONFIG_DIR on launch and resume without fallback", async () => {
  const claudeDirA = makeClaudeDir("claude-profile-alpha");
  const claudeDirB = makeClaudeDir("claude-profile-beta");
  let allowClaudeA = true;
  __setClaudeAuthProbeForTest(async (directory) => ({
    loggedIn: directory === claudeDirA && allowClaudeA,
    configDirectory: directory,
  }));

  // Without HOME-access acceptance, launch is blocked on every path and never falls back to default claude-code.
  const unaccepted = claudeProfiles.register({
    displayName: "Claude Alpha Unaccepted",
    directory: claudeDirA,
    homeAccessAccepted: false,
  });
  expect(unaccepted.support).toBe("partial");
  expect(unaccepted.verifiedSubject).toBeNull();
  expect(unaccepted.availability).toBe("acceptance-required");
  expect(unaccepted.limitations).toEqual([...CLAUDE_PROFILE_LIMITATIONS]);
  expect(unaccepted.limitations.join(" ")).toContain("macOS Keychain and ~/.claude.json are not isolated by CLAUDE_CONFIG_DIR alone");
  expect(unaccepted.limitations.join(" ")).toContain("HOME-access disclosure");

  const unacceptedBinding = explainBinding({
    harnessId: unaccepted.harnessId,
    accountId: unaccepted.accountId,
    modelId: "haiku-5.5",
    mode: "ask",
  });
  expect(unacceptedBinding.ok).toBe(false);
  if (!unacceptedBinding.ok) expect(unacceptedBinding.reason).toMatch(/HOME-access disclosure/i);

  const claudeTaskRes = await createTask({
    title: "Task on Claude Profile A",
    prompt: "Initial turn on Claude Profile A",
    workdir: projectPath,
    column: "ready",
    agent: unaccepted.harnessId,
    model: "haiku-5.5",
    effort: "low",
    mode: "ask",
    isolation: "none",
  });
  if ("error" in claudeTaskRes) throw new Error(claudeTaskRes.error);
  const claudeTask = claudeTaskRes.task;

  const runsBeforeUnaccepted = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  const refusedUnacceptedLaunch = await startTask(claudeTask.id);
  expect("error" in refusedUnacceptedLaunch).toBe(true);
  if ("error" in refusedUnacceptedLaunch) expect(refusedUnacceptedLaunch.error).toMatch(/HOME-access disclosure/i);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(runsBeforeUnaccepted);

  // Accept HOME-access disclosure for Claude A and register Claude B.
  const claudeA = claudeProfiles.register({
    displayName: "Claude Alpha Profile",
    directory: claudeDirA,
    homeAccessAccepted: true,
  }, unaccepted.accountId);
  const claudeB = claudeProfiles.register({
    displayName: "Claude Beta Profile",
    directory: claudeDirB,
    homeAccessAccepted: true,
  });

  const checkedClaudeA = await claudeProfiles.check(claudeA.accountId);
  const checkedClaudeB = await claudeProfiles.check(claudeB.accountId);
  expect(checkedClaudeA.availability).toBe("ready");
  expect(checkedClaudeA.verifiedSubject).toBeNull();
  expect(checkedClaudeB.availability).toBe("authentication-required");
  noteAuthenticationCheck(db, claudeA.accountId, "authenticated", Date.now());
  noteAuthenticationCheck(db, claudeB.accountId, "required", Date.now());

  const execProfiles = listExecutionProfiles(db);
  const execClaudeA = execProfiles.find((p) => p.accountId === claudeA.accountId)!;
  expect(execClaudeA.support).toBe("partial");
  expect(execClaudeA.verifiedSubject).toBeNull();
  expect(execClaudeA.limitations.join(" ")).toContain("macOS Keychain and ~/.claude.json are not isolated by CLAUDE_CONFIG_DIR alone");

  // Environment binds CLAUDE_CONFIG_DIR and never overrides HOME.
  const harnessClaudeA = harnesses.get(claudeA.harnessId)!;
  const envClaudeA = harnessEnv(harnessClaudeA);
  expect(envClaudeA.CLAUDE_CONFIG_DIR).toBe(claudeDirA);
  expect(envClaudeA.HOME).toBeUndefined();
  const builtClaudeA = buildCommand(harnessClaudeA, "hello", { model: "haiku-5.5", effort: "low", mode: "ask" });
  expect(builtClaudeA.env?.CLAUDE_CONFIG_DIR).toBe(claudeDirA);
  expect(builtClaudeA.env?.HOME).toBeUndefined();

  // Launch on Claude A records Claude A in history.
  const launchedClaude = await startTask(claudeTask.id);
  if ("error" in launchedClaude) throw new Error(launchedClaude.error);
  const claudeRun1 = await waitForRunSettled(launchedClaude.runId);
  expect(claudeRun1.status).toBe("succeeded");
  expect(claudeRun1.agent).toBe(claudeA.harnessId);
  expect(claudeRun1.claudeSessionId).toBe(`fake-claude-session-${claudeTask.id}`);
  expect(getRunExecution(claudeRun1.id)!.accountProfile).toEqual({
    id: claudeA.accountId,
    displayName: "Claude Alpha Profile",
    harnessId: claudeA.harnessId,
  });

  // Resume on Claude A (sendInput -> spawnResumedSession) preserves session and records Claude A.
  const resumedClaude = await sendInput(claudeRun1.id, "Follow-up on Claude A");
  expect(resumedClaude.delivered).toBe(true);
  if (!resumedClaude.delivered) throw new Error(resumedClaude.reason);
  const claudeRun2 = await waitForRunSettled(resumedClaude.runId);
  expect(claudeRun2.status).toBe("succeeded");
  expect(claudeRun2.agent).toBe(claudeA.harnessId);
  expect(claudeRun2.claudeSessionId).toBe(claudeRun1.claudeSessionId);
  expect(getRunExecution(claudeRun2.id)!.accountProfile?.id).toBe(claudeA.accountId);

  // Disabled Claude profile refuses launch and resume without fallback.
  writeExecutionMeta(db, claudeA.accountId, { disabled: true });
  const runsBeforeDisabledClaude = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  const disabledClaudeLaunch = await startTask(claudeTask.id);
  expect("error" in disabledClaudeLaunch).toBe(true);
  const disabledClaudeResume = await sendInput(claudeRun2.id, "Attempt resume when Claude profile disabled");
  expect(disabledClaudeResume.delivered).toBe(false);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(runsBeforeDisabledClaude);
  writeExecutionMeta(db, claudeA.accountId, { disabled: false });
  await claudeProfiles.check(claudeA.accountId);

  // Replaced Claude directory refuses launch and resume without fallback.
  const claudeBackup = `${claudeDirA}-backup`;
  rmSync(claudeBackup, { recursive: true, force: true });
  rmSync(claudeDirA, { recursive: true, force: true });
  mkdirSync(claudeBackup, { recursive: true, mode: 0o700 });
  mkdirSync(claudeDirA, { recursive: true, mode: 0o700 });
  const replacedClaudeLaunch = await startTask(claudeTask.id);
  expect("error" in replacedClaudeLaunch).toBe(true);
  if ("error" in replacedClaudeLaunch) expect(replacedClaudeLaunch.error).toMatch(/replaced|no default fallback/i);
  const replacedClaudeResume = await sendInput(claudeRun2.id, "Attempt resume when Claude directory replaced");
  expect(replacedClaudeResume.delivered).toBe(false);
  if (!replacedClaudeResume.delivered) expect(replacedClaudeResume.reason).toMatch(/replaced|no fallback/i);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(runsBeforeDisabledClaude);
  rmSync(claudeBackup, { recursive: true, force: true });
  claudeProfiles.register({ displayName: "Claude Alpha Profile", directory: claudeDirA, homeAccessAccepted: true }, claudeA.accountId);
  await claudeProfiles.check(claudeA.accountId);

  // Failed Claude status check refuses launch and resume without falling back to default claude-code.
  allowClaudeA = false;
  const runsBeforeFailedClaude = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
  const failedClaudeLaunch = await startTask(claudeTask.id);
  expect("error" in failedClaudeLaunch).toBe(true);
  const failedClaudeResume = await sendInput(claudeRun2.id, "Attempt resume when Claude auth fails");
  expect(failedClaudeResume.delivered).toBe(false);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(runsBeforeFailedClaude);
  allowClaudeA = true;
  await claudeProfiles.check(claudeA.accountId);

  // Cross-profile / ambient Claude resume is refused.
  tasks.update(claudeTask.id, { agent: claudeB.harnessId });
  const crossClaudeResume = await sendInput(claudeRun2.id, "Attempt resume on Claude B");
  expect(crossClaudeResume.delivered).toBe(false);
  if (!crossClaudeResume.delivered) expect(crossClaudeResume.reason).toMatch(/Account mismatch/i);

  tasks.update(claudeTask.id, { agent: "claude-code" });
  const ambientClaudeResume = await sendInput(claudeRun2.id, "Attempt resume on ambient claude-code");
  expect(ambientClaudeResume.delivered).toBe(false);
  if (!ambientClaudeResume.delivered) expect(ambientClaudeResume.reason).toMatch(/Account mismatch/i);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(runsBeforeFailedClaude);
  tasks.update(claudeTask.id, { agent: claudeA.harnessId });
});
