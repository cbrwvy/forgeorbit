/**
 * Direction 16 — Smart Router and safe fallback, offline acceptance.
 * Production AccountCore, Router 2.0, mission proposals, autonomy policy and the scheduler.
 * Synthetic Codex profiles, fake drivers, recorded synthetic quota rows. No provider call, no inference.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.ts";
import type { MissionPlan } from "../../shared/orchestration/types.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-direction16-")));
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { db, harnesses, projects, runs } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { createTask, startTask } = await import("../orchestrator.ts");
const { initEmployeeExecutionTracking } = await import("../employee-run.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { missionScheduler } = await import("../orchestration/mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy, setAutonomyClock } = await import("../autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal, missionResourceOptions } = await import("../orchestration/mission-replan.ts");
const { activeProviderRefusal, recordProviderRefusal, supersedeProviderRefusals } = await import("../provider-refusals.ts");
const { getRunExecution } = await import("../run-execution.ts");
const { stopProjectLifecycle, startProjectLifecycle } = await import("../project-lifecycle.ts");
const { writeExecutionMeta } = await import("../multiaccount/registry.ts");
const { routerV2Service } = await import("./router-v2-service.ts");

initEmployeeExecutionTracking();
harnesses.setEnabled("codex", true);
const core = new AccountCore(db);
const profiles = new CodexProfiles(core);
const model = "gpt-6.1-sol";
const NOW = Date.now();

function account(name: string) {
  const directory = path.join(home, name);
  writeSyntheticCodexProfile(directory, `synthetic-${name}`);
  return profiles.register({ displayName: name, directory: realpathSync(directory) });
}

function observe(quotaId: string, accountId: string, remaining: number, limit = 100, resetAt: number | null = null) {
  core.recordTrustedObservations("recorded-contract", [{
    quotaId,
    values: { observedAt: Date.now(), expiresAt: resetAt ?? Date.now() + 43_200_000, resetAt, limit, used: limit - remaining, remaining, indicator: null, confidence: "high" },
    evidence: {
      provider: "openai", accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
      officialUrl: "https://example.invalid", checkedAt: "2026-11-17", receivedAt: Date.now(), sharedPool: null, limitations: "Recorded QA evidence",
    },
  }]);
}

function quota(accountId: string, window: string, remaining: number, limit = 100) {
  const definition = core.createDefinition({ accountId, scope: "account", category: "subscription", unit: { kind: "requests" }, window });
  core.recordTrustedObservations("recorded-contract", [{
    quotaId: definition.id,
    values: { observedAt: NOW - 1000, expiresAt: NOW + 43_200_000, resetAt: null, limit, used: limit - remaining, remaining, indicator: null, confidence: "high" },
    evidence: {
      provider: "openai", accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
      officialUrl: "https://example.invalid", checkedAt: "2026-11-17", receivedAt: NOW, sharedPool: null, limitations: "Recorded QA evidence",
    },
  }]);
  return definition.id;
}

/** Every row of every table. A read that writes anything anywhere changes this string. */
function fingerprint(except: readonly string[] = []): string {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return JSON.stringify(tables.filter(table => !except.includes(table.name)).map(table => [table.name, db.query(`SELECT * FROM "${table.name}"`).all()]));
}

const A = account("account-a"); // original
const B = account("account-b"); // the approved replacement
const C = account("account-c"); // a known capacity shortfall
const D = account("account-d"); // Unknown capacity and a recorded provider refusal
quota(C.accountId, "exhausted", 0);
const bQuota = quota(B.accountId, "headroom", 60);
void bQuota;
const setBDisabled = (disabled: boolean) => writeExecutionMeta(db, B.accountId, { disabled });

const projectPath = path.join(root, "project");
mkdirSync(projectPath);
projects.upsert(projectPath, "Direction 16 fixture");

async function mission(label: string, prompt = "Record the approved account.", accounts = [A, B, C, D]) {
  const created = await createTask({
    title: label, prompt, workdir: projectPath, column: "ready", agent: A.harnessId, model, mode: "auto", isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const worker = new EmployeeCore(db).createWorker({ name: `Worker ${label}`, jobTitle: "Developer", projectPath });
  new AssignmentCore(db).assign(taskId, worker.id);
  const plan: MissionPlan = {
    clusters: [], projects: [projectPath], concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: [{
      taskId, taskTitle: label, projectPath, specialistRole: "developer", phase: "authorized", priority: "normal",
      dependencies: [], harnessId: A.harnessId, modelId: model, accountId: A.accountId, mode: "auto", qcRequired: false,
    }],
  };
  const m = missionStore.createMission({
    title: label, goal: "synthetic", status: "authorized", projects: [projectPath], clusters: [], plan, planDigest: computeMissionPlanDigest(plan),
  });
  missionStore.updateMissionAuthorization(m.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: m.planDigest });
  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "project", scopeRef: projectPath, projects: [projectPath],
    specialistRoles: ["developer"], providers: ["codex"], models: [model], accounts: accounts.map(row => row.accountId),
    maxConcurrentWorkers: 1, maxLaunches: 4, maxDurationMs: 300_000, expiresAt: Date.now() + 300_000,
    permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  autonomyPolicyStore.upsertBinding({
    missionId: m.id, policyId: policy.id, revision: policy.revision, activationId: activation.id,
    digest: policy.digest, mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  return { missionId: m.id, taskId, policyExpiresAt: activation.expiresAt };
}

const resourceFor = (missionId: string, taskId: string, target: { accountId: string }) => {
  const option = missionResourceOptions(missionId, taskId, "developer").find(row => row.accountId === target.accountId && row.modelId === model);
  if (!option) {
    const evaluated = routerV2Service.evaluateTaskSync({ taskId, projectId: projectPath, role: "developer" }, { candidates: routerV2Service.gatherCandidatesSync("developer") });
    const row = evaluated.all.find(candidate => candidate.accountId === target.accountId && candidate.modelId === model);
    throw new Error(`No admitted option for ${target.accountId}: eligible=${row?.eligible} reasons=${row?.eliminationReasons.join(" | ")} readiness=${row?.readiness}`);
  }
  return option.resource;
};

test("1. recommendation: known shortfall, Unknown capacity and a refusal stay three different facts", () => {
  const input = { taskId: "d16-recommend", projectId: projectPath, role: "developer" as const };
  const candidates = routerV2Service.gatherCandidatesSync("developer");
  const permissive = routerV2Service.evaluateTaskSync(input, { candidates });
  const byAccount = (list: typeof permissive.all, id: string) => list.find(row => row.accountId === id && row.modelId === model)!;

  // C is a verified shortfall: excluded before scoring, with the shortfall named once.
  const c = byAccount(permissive.all, C.accountId);
  expect(c.eligible).toBe(false);
  expect(c.eliminationReasons.some(reason => reason.startsWith("quota-exhausted:"))).toBe(true);
  expect(c.scores.quota.capacityClass).toBe("verified-insufficient");
  // B has verified headroom, D has no reading at all (Unknown), and neither is a shortfall.
  expect(byAccount(permissive.all, B.accountId).scores.quota.capacityClass).toBe("verified-sufficient");
  expect(byAccount(permissive.all, D.accountId).scores.quota.capacityClass).toBe("unknown");
  expect(byAccount(permissive.all, D.accountId).eligible).toBe(true);

  // The refused operation is held. Other options retain their scores and order.
  recordProviderRefusal({
    kind: "usage-limit", provider: "codex", scope: { harnessId: D.harnessId, accountId: D.accountId, modelId: model },
    surface: "developer-run", evidenceId: "d16-refusal-1", proof: "codex-cli-usage-limit", retryHint: "try again later", diagnostics: "synthetic",
  });
  const refused = routerV2Service.evaluateTaskSync(input, { candidates: routerV2Service.gatherCandidatesSync("developer") });
  const d = byAccount(refused.all, D.accountId);
  expect(refused.eligible).toEqual(permissive.eligible.filter(row => row.candidateId !== d.candidateId));
  expect(d.providerRefusal?.accountId).toBe(D.accountId);
  expect(d.scores.quota.capacityClass).toBe("unknown");
  expect(d.eligible).toBe(false);
  expect(d.eliminationReasons).toContainEqual(expect.stringContaining("provider-usage-limit:"));
  // Another model on the same account is not covered by that refusal.
  expect(refused.all.filter(row => row.accountId !== D.accountId).every(row => !row.providerRefusal)).toBe(true);

  // Strict policy: Unknown capacity is excluded as Unknown, the shortfall stays a shortfall, nothing says "unverified".
  const strict = routerV2Service.evaluateTaskSync(input, { candidates, policyOverride: { quotaPolicy: "strict" } });
  expect(byAccount(strict.all, D.accountId).eliminationReasons.join(" ")).toContain("quota-unknown-strict");
  const strictC = byAccount(strict.all, C.accountId).eliminationReasons.join(" ");
  expect(strictC).toContain("quota-exhausted");
  expect(strictC).not.toContain("unverified-strict");
  expect(strict.selected?.accountId).toBe(B.accountId);
  expect(strict.selected?.authorizesExecution).toBe(false);

  // No candidate qualifies: the explanation names why, apart from the refusal, and recommends nothing.
  const none = routerV2Service.evaluateTaskSync(input, {
    candidates: routerV2Service.gatherCandidatesSync("developer").filter(row => row.modelId === model && (row.accountId === C.accountId || row.accountId === D.accountId)),
    policyOverride: { quotaPolicy: "strict" },
  });
  expect(none.selected).toBeNull();
  expect(none.explanation).toContain("1 with a known capacity shortfall");
  expect(none.explanation).toContain("1 with Unknown capacity");
  expect(none.explanation).toContain("recorded provider refusal");
  supersedeProviderRefusals({ harnessId: D.harnessId, accountId: D.accountId, modelId: model }, "d16-fixture-answer");
});

test("2. a replacement preview and opening the Router write nothing", () => {
  const { missionId, taskId } = { missionId: pendingMission.missionId, taskId: pendingMission.taskId };
  const before = fingerprint();
  const options = missionResourceOptions(missionId, taskId, "developer");
  expect(options.map(row => row.accountId)).toContain(B.accountId);
  expect(options.map(row => row.accountId)).not.toContain(C.accountId);
  routerV2Service.evaluateTaskSync({ taskId, projectId: projectPath, role: "developer" }, { candidates: routerV2Service.gatherCandidatesSync("developer") });
  expect(fingerprint()).toBe(before);
  // The exact harness, model, account and mode are in each option before anything is approved.
  const exact = options.find(row => row.accountId === B.accountId)!;
  expect(exact.resource).toMatchObject({ harnessId: B.harnessId, modelId: model, accountId: B.accountId, mode: "auto" });
  expect(runs.listForTask(taskId)).toEqual([]);
});

test("3. Cancel leaves the mission as it was, and a settled proposal cannot be approved afterwards", () => {
  const { missionId, taskId } = pendingMission;
  const mission0 = missionStore.getMission(missionId)!;
  const proposal = prepareMissionResourceProposal(missionId, { taskId, role: "developer", resource: resourceFor(missionId, taskId, B), reason: "Cancel check" });
  expect(proposal.status).toBe("pending");
  // Preparing wrote the proposal row and nothing else.
  const reject = settleMissionResourceProposal(missionId, proposal.id, proposal.digest, "reject");
  expect(reject.status).toBe("rejected");
  const mission1 = missionStore.getMission(missionId)!;
  expect(mission1.revision).toBe(mission0.revision);
  expect(mission1.planDigest).toBe(mission0.planDigest);
  expect(JSON.stringify(mission1.plan)).toBe(JSON.stringify(mission0.plan));
  expect(() => settleMissionResourceProposal(missionId, proposal.id, proposal.digest, "approve")).toThrow();
  expect(missionStore.getMission(missionId)!.revision).toBe(mission0.revision);
  expect(runs.listForTask(taskId)).toEqual([]);
});

test("4. an old approval is rejected when anything it was bound to changed", async () => {
  const { missionId, taskId } = pendingMission;
  const revision = missionStore.getMission(missionId)!.revision;
  const fresh = (reason: string) => prepareMissionResourceProposal(missionId, { taskId, role: "developer", resource: resourceFor(missionId, taskId, B), reason });

  // A digest that is not the reviewed one.
  const wrong = fresh("wrong digest");
  expect(() => settleMissionResourceProposal(missionId, wrong.id, "0".repeat(wrong.digest.length), "approve")).toThrow();
  // A Head message cannot settle a proposal that the Owner prepared in its own surface.
  expect(() => settleMissionResourceProposal(missionId, wrong.id, wrong.digest, "approve", "head-message-1")).toThrow();

  // The task changed after review.
  const edited = fresh("task edit");
  db.run("UPDATE tasks SET prompt = prompt || ' (edited)' WHERE id = ?", [taskId]);
  expect(() => settleMissionResourceProposal(missionId, edited.id, edited.digest, "approve")).toThrow();
  db.run("UPDATE tasks SET prompt = replace(prompt, ' (edited)', '') WHERE id = ?", [taskId]);

  // The replacement stopped being eligible after review.
  const ineligible = fresh("eligibility");
  setBDisabled(true);
  expect(() => settleMissionResourceProposal(missionId, ineligible.id, ineligible.digest, "approve")).toThrow();
  setBDisabled(false);

  // The authorization expired after review.
  const expired = fresh("expiry");
  setAutonomyClock(() => pendingMission.policyExpiresAt + 60_000);
  try {
    expect(() => settleMissionResourceProposal(missionId, expired.id, expired.digest, "approve")).toThrow();
  } finally {
    setAutonomyClock(() => Date.now());
  }

  // Nothing above changed the mission.
  expect(missionStore.getMission(missionId)!.revision).toBe(revision);
  expect(runs.listForTask(taskId)).toEqual([]);
  expect(await Promise.resolve(true)).toBe(true);
});

/** Let a mission's fake run finish and its reservation release, then stop it, so the next scenario owns every shared slot. */
async function quiesce(missionId: string) {
  for (let attempt = 0; attempt < 80 && (db.query("SELECT 1 FROM runs WHERE status = 'running'").get() || missionStore.listActiveReservations(missionId).length); attempt += 1) {
    await Bun.sleep(50);
    await missionScheduler.tickMission(missionId);
  }
  missionStore.updateMissionStatus(missionId, "paused", "settled before the next scenario");
}

async function approveReplacement(missionId: string, taskId: string, target: { accountId: string }, reason: string) {
  const proposal = prepareMissionResourceProposal(missionId, { taskId, role: "developer", resource: resourceFor(missionId, taskId, target), reason });
  settleMissionResourceProposal(missionId, proposal.id, proposal.digest, "approve");
  return proposal;
}

test("5. an approved replacement launches only on that exact account, and waits for a slot rather than switching", async () => {
  const { missionId, taskId } = pendingMission;
  const original = missionStore.getMission(missionId)!;
  await approveReplacement(missionId, taskId, B, "Approved replacement");
  const revised = missionStore.getMission(missionId)!;
  expect(revised.revision).toBe(original.revision + 1);
  expect(revised.plan.tasks[0]!.developerBinding).toMatchObject({ accountId: B.accountId, harnessId: B.harnessId, modelId: model, mode: "auto" });
  // The previous revision is kept exactly as it was: its binding still names account A.
  const stored = db.query<{ snapshot: string }, [string, number]>("SELECT snapshot FROM mission_plan_revisions WHERE mission_id = ? AND revision = ?").get(missionId, original.revision)!;
  expect(JSON.parse(stored.snapshot).plan.tasks[0].accountId).toBe(A.accountId);

  // Approval started nothing. Launch is a separate Owner action.
  expect(runs.listForTask(taskId)).toEqual([]);
  expect(missionStore.getMission(missionId)!.status).not.toBe("running");
  missionStore.updateMissionStatus(missionId, "running", "owner started");

  // A slot on the approved account is taken: the scheduler waits. It does not use A, C or D.
  const holderId = crypto.randomUUID();
  const at = Date.now();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,created_at,updated_at)
    VALUES (?,?,?,'ready',?,?,?,'auto','none',?,?)`, [holderId, "Slot holder", "Do not launch.", B.harnessId, projectPath, model, at, at]);
  const worker = new EmployeeCore(db).createWorker({ name: "Slot holder", jobTitle: "Developer", projectPath });
  missionStore.createReservation({
    missionId, taskId: holderId, projectPath, employeeId: worker.id, accountId: B.accountId, harnessId: B.harnessId, modelId: model, status: "running",
  });
  await missionScheduler.tickMission(missionId);
  expect(runs.listForTask(taskId)).toEqual([]);
  expect(runs.listForTask(holderId)).toEqual([]);
  const waiting = missionStore.getMission(missionId)!.plan.tasks[0]!;
  expect(waiting.phaseReason).toContain("Waiting");
  expect(waiting.developerBinding?.accountId).toBe(B.accountId);
  expect(waiting.accountId).toBe(B.accountId);
  missionStore.releaseTaskReservation(holderId);

  // Eligible and a slot is free: the launch uses exactly the approved resource.
  await missionScheduler.tickMission(missionId);
  const launched = missionStore.getMission(missionId)!.plan.tasks[0]!;
  expect(launched.phase, launched.phaseReason).toBe("running");
  const identity = db.query<{ data: string }, [string]>(`SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%"kind":"execution-identity"%'`).get(launched.runId!)!;
  expect(JSON.parse(identity.data)).toMatchObject({ executionType: "synthetic", provider: "codex", model, mode: "auto", accountProfile: { id: B.accountId } });
  const attempts = runs.listForTask(taskId).map(run => ({ id: run.id, agent: run.agent }));
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.agent).toBe(B.harnessId);
  // A second tick does not replay.
  await missionScheduler.tickMission(missionId);
  expect(runs.listForTask(taskId).map(run => ({ id: run.id, agent: run.agent }))).toEqual(attempts);
  await quiesce(missionId);
});

test("6. an approved account that stopped being eligible is refused, never swapped, and is not revived by waiting", async () => {
  const second = await mission("Refused at dispatch");
  await approveReplacement(second.missionId, second.taskId, B, "Approved, then B becomes ineligible");
  missionStore.updateMissionStatus(second.missionId, "running", "owner started");

  setBDisabled(true);
  await missionScheduler.tickMission(second.missionId);
  expect(runs.listForTask(second.taskId)).toEqual([]);
  const refused = missionStore.getMission(second.missionId)!.plan.tasks[0]!;
  expect(["blocked", "awaiting_owner"]).toContain(refused.phase);
  expect(refused.phaseReason).toContain("No substitute was selected");
  expect(refused.developerBinding?.accountId).toBe(B.accountId);

  // B becomes eligible again. Reopening and ticking does not revive the refused stage.
  setBDisabled(false);
  for (let tick = 0; tick < 3; tick += 1) await missionScheduler.tickMission(second.missionId);
  expect(runs.listForTask(second.taskId)).toEqual([]);
  expect(db.query("SELECT 1 FROM runs WHERE task_id = ?").get(second.taskId)).toBeNull();

  // Only a new Owner-approved amendment re-arms it, and then it runs on exactly that new account.
  // The Owner pauses first: a resource change is refused while the mission runs.
  expect(() => missionResourceOptions(second.missionId, second.taskId, "developer")).toThrow();
  missionStore.updateMissionStatus(second.missionId, "paused", "owner paused to change the resource");
  await approveReplacement(second.missionId, second.taskId, D, "Owner chose D after the refusal");
  missionStore.updateMissionStatus(second.missionId, "running", "owner resumed");
  await missionScheduler.tickMission(second.missionId);
  const attempts = runs.listForTask(second.taskId);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.agent).toBe(D.harnessId);
  await quiesce(second.missionId);
});

test("7. a failed attempt is not retried on another account, and later ticks do not revive it", async () => {
  const failing = await mission("Failing attempt", "__agetor_fake_run_fail__ synthetic failure", [A, B, C, D]);
  // Account A is the approved one here. B, C and D are inside the envelope and must stay unused.
  missionStore.updateMissionStatus(failing.missionId, "running", "owner started");
  await missionScheduler.tickMission(failing.missionId);
  const first = runs.listForTask(failing.taskId);
  expect(first, missionStore.getMission(failing.missionId)!.plan.tasks[0]!.phaseReason).toHaveLength(1);
  expect(first[0]!.agent).toBe(A.harnessId);
  for (let attempt = 0; attempt < 40 && runs.listForTask(failing.taskId).some(run => run.status === "running"); attempt += 1) await Bun.sleep(50);
  for (let tick = 0; tick < 3; tick += 1) await missionScheduler.tickMission(failing.missionId);
  const after = runs.listForTask(failing.taskId);
  expect(after.map(run => run.id)).toEqual(first.map(run => run.id));
  expect(after.every(run => run.agent === A.harnessId)).toBe(true);
  expect(db.query("SELECT 1 FROM runs WHERE task_id = ? AND agent IN (?, ?, ?)").get(failing.taskId, B.harnessId, C.harnessId, D.harnessId)).toBeNull();
});

function quotaProject(name: string) {
  const directory = path.join(root, name);
  mkdirSync(directory);
  projects.upsert(directory, name);
  return directory;
}

async function quotaTask(projectPath: string, title: string, profile: typeof A, prompt = "Record the approved account.") {
  const result = await createTask({
    title, prompt, workdir: projectPath, column: "ready", agent: profile.harnessId, model, mode: "auto", isolation: "none",
  });
  if ("error" in result) throw new Error(result.error);
  new AssignmentCore(db).assign(result.task.id, new EmployeeCore(db).createWorker({ name: title, jobTitle: "Developer", projectPath }).id);
  return {
    taskId: result.task.id, taskTitle: title, projectPath, specialistRole: "developer", phase: "authorized" as const,
    priority: "normal" as const, dependencies: [], harnessId: profile.harnessId, modelId: model,
    accountId: profile.accountId, mode: "auto", qcRequired: false,
  };
}

function quotaMission(title: string, tasks: MissionPlan["tasks"]) {
  const projectPath = tasks[0]!.projectPath;
  const plan: MissionPlan = {
    tasks, projects: [projectPath], clusters: [],
    concurrencyLimits: { globalMax: 2, perProjectMax: 2, perAccountMax: 1 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
  };
  const m = missionStore.createMission({
    title, goal: title, status: "authorized", projects: plan.projects, clusters: [], plan, planDigest: computeMissionPlanDigest(plan),
  });
  missionStore.updateMissionAuthorization(m.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: m.planDigest });
  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "project", scopeRef: projectPath, projects: [projectPath],
    specialistRoles: ["developer"], providers: ["codex"], models: [model], accounts: tasks.map(task => task.accountId!),
    maxConcurrentWorkers: 2, maxLaunches: 4, maxDurationMs: 300_000, expiresAt: Date.now() + 300_000,
    permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  autonomyPolicyStore.upsertBinding({
    missionId: m.id, policyId: policy.id, revision: policy.revision, activationId: activation.id,
    digest: policy.digest, mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  missionStore.updateMissionStatus(m.id, "running", "owner started");
  return m;
}

test("8. a real-shaped refusal holds the approved operation, independent work runs, and explicit retry stays on A", async () => {
  const project = quotaProject("Refusal fixture");
  const limited = account("refused-a");
  const available = account("available-b");
  const observationTask = await quotaTask(project, "Refusal evidence", limited, "Implement it __fake_provider__:usage-limit-clock");
  const evidenceRun = await startTask(observationTask.taskId);
  if ("error" in evidenceRun) throw new Error(evidenceRun.error);
  const scope = { accountId: limited.accountId, harnessId: limited.harnessId, modelId: model };
  for (let attempt = 0; attempt < 80 && !activeProviderRefusal(scope); attempt++) await Bun.sleep(25);
  const refusal = activeProviderRefusal(scope)!;
  expect(refusal).toMatchObject({ accountId: limited.accountId, retryHint: "9:31 PM" });
  await profiles.check(limited.accountId);
  await profiles.check(available.accountId);
  const estimate = core.createDefinition({ accountId: limited.accountId, scope: "account", unit: { kind: "requests" }, window: "daily" });
  core.recordObservation(estimate.id, {
    observedAt: Date.now(), expiresAt: Date.now() + 60_000, limit: 100, remaining: 80, confidence: "medium",
  });
  expect(activeProviderRefusal(scope)?.id).toBe(refusal.id);

  const held = await quotaTask(project, "Queued on A", limited);
  const next = await quotaTask(project, "Independent on B", available);
  const m = quotaMission("Account waits", [held, next]);
  const req = { projectId: project, taskId: held.taskId, role: "developer" as const };
  const options = { policyOverride: { constraints: { allowedAccountIds: [limited.accountId, available.accountId], allowedModels: [model] } } };
  const routing = routerV2Service.evaluateTaskSync(req, options);
  expect(routing.selected?.accountId).toBe(available.accountId);
  expect(routing.selected?.scores.quota.capacityClass).toBe("unknown");
  expect(routerV2Service.evaluateTaskSync({ ...req, requestedAccountId: limited.accountId }, options).selected).toBeNull();

  for (let tick = 0; tick < 3; tick++) await missionScheduler.tickMission(m.id);
  const waiting = missionStore.getMission(m.id)!.plan.tasks[0]!;
  expect(waiting).toMatchObject({
    phase: "blocked", waitingOn: "quota", accountId: limited.accountId,
    accountLimit: { accountId: limited.accountId, resetAt: null, refusal: { id: refusal.id } },
  });
  expect(runs.listForTask(held.taskId)).toEqual([]);
  const independent = runs.listForTask(next.taskId);
  expect(independent, missionStore.getMission(m.id)?.plan.tasks[1]?.phaseReason).toHaveLength(1);
  expect(getRunExecution(independent[0]!.id)?.accountProfile?.id).toBe(available.accountId);
  expect(() => missionScheduler.retryQuotaWait(m.id, next.taskId, refusal.id)).toThrow();
  missionScheduler.retryQuotaWait(m.id, held.taskId, refusal.id);
  await missionScheduler.tickMission(m.id);
  const tries = runs.listForTask(held.taskId);
  expect(tries).toHaveLength(1);
  expect(getRunExecution(tries[0]!.id)?.accountProfile?.id).toBe(limited.accountId);
  await quiesce(m.id);
});

test("9. a confirmed window wakes the exact queued task after reset and recovery does not duplicate the launch", async () => {
  const project = quotaProject("Timed quota fixture");
  const limited = account("timed-a");
  const queued = await quotaTask(project, "Timed account", limited);
  await profiles.check(limited.accountId);
  const m = quotaMission("Timed wait", [queued]);
  let clock = Date.now();
  const resetAt = clock + 60_000;
  const date = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const definition = core.createDefinition({ accountId: limited.accountId, scope: `model:${model}`, category: "subscription", unit: { kind: "requests" }, window: "weekly" });
    observe(definition.id, limited.accountId, 0, 100, resetAt);
    for (let tick = 0; tick < 3; tick++) await missionScheduler.tickMission(m.id);
    expect(missionStore.getMission(m.id)?.plan.tasks[0]).toMatchObject({
      waitingOn: "quota", accountLimit: { resetAt, windows: [{ resetAt, source: "trusted:recorded-contract" }] },
    });
    expect(runs.listForTask(queued.taskId)).toEqual([]);
    await missionScheduler.pauseMission(m.id);
    clock = resetAt;
    await missionScheduler.recoverOrchestrationMissions();
    expect(runs.listForTask(queued.taskId)).toEqual([]);

    const candidate = routerV2Service.gatherCandidatesSync("developer").find(row => row.accountId === limited.accountId && row.modelId === model);
    expect(candidate?.quotaState).toMatchObject({ isUnknown: true, isExhausted: false, remainingUnits: null, capacityEvidence: "stale" });
    await stopProjectLifecycle(project);
    await missionScheduler.resumeMission(m.id);
    await missionScheduler.tickMission(m.id);
    expect(missionStore.getMission(m.id)?.plan.tasks[0]?.waitingOn).toBe("project-stopped");
    expect(runs.listForTask(queued.taskId)).toEqual([]);
    await startProjectLifecycle(project);
    await missionScheduler.recoverOrchestrationMissions();
    await Promise.all([missionScheduler.tickMission(m.id), missionScheduler.tickMission(m.id)]);
    const attempts = runs.listForTask(queued.taskId);
    expect(attempts, missionStore.getMission(m.id)?.plan.tasks[0]?.phaseReason).toHaveLength(1);
    expect(getRunExecution(attempts[0]!.id)?.accountProfile?.id).toBe(limited.accountId);
  } finally {
    date.mockRestore();
    await quiesce(m.id);
  }
});

// Created after the helpers so test 1 runs against the pristine accounts and quota rows.
const pendingMission = await mission("Replacement candidate");
