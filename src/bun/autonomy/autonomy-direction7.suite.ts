/**
 * Direction 7 (Supervised / Autonomous / Full Autonomy), authority boundaries on the production dispatch path.
 * Synthetic Codex account fixtures, fake driver, no provider, no process. Runs in its own Bun process (see
 * `orchestration-direction6.test.ts`) because the mission store is process-wide.
 *
 * A fake Codex turn is held by `AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS`, read when a run is spawned: set it high before a
 * tick and every run that tick dispatches occupies its slot until it is stopped, which gives each case an exact,
 * repeatable "who holds a slot" state. Nothing here relies on timing of a natural completion except where stated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.ts";
import type { MissionPlan, MissionTaskPlan } from "../../shared/orchestration/types.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-auto-d7-")));
process.env.HOME = path.join(root, "home");
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
mkdirSync(process.env.HOME, { recursive: true });

const MODEL = "gpt-6.1-sol";
const HOLD = "600000";
const FAST = "30";

const { db, harnesses, projects, runs, tasks } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { createTask, cancelRun, isTaskRunLive, startTask } = await import("../orchestrator.ts");
const { acceptAuthorizedTaskDone } = await import("../task-quality-control.ts");
const { initEmployeeExecutionTracking } = await import("../employee-run.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { missionScheduler } = await import("../orchestration/mission-scheduler.ts");
const engine = await import("./policy-engine.ts");
const { createAutonomyPolicy, activateAutonomyPolicy, revokeAutonomyPolicy } = engine;
const coordinator = await import("./coordinator.ts");
const gate = await import("./gate.ts");
const { autonomyPolicyStore } = await import("./policy-store.ts");
const { stopProjectLifecycle, startProjectLifecycle } = await import("../project-lifecycle.ts");

initEmployeeExecutionTracking();
harnesses.setEnabled("codex", true);
const profiles = new CodexProfiles(new AccountCore(db));
const dirHome = process.env.HOME!;
const synthetic = (() => {
  const directory = path.join(dirHome, "account-main");
  writeSyntheticCodexProfile(directory, "synthetic-main");
  return profiles.register({ displayName: "Main", directory });
})();

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const workers = new Map<string, string>();
function project(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  projects.upsert(dir, name);
  workers.set(dir, new EmployeeCore(db).createWorker({ name: `Worker ${name}`, jobTitle: "Developer", projectPath: dir }).id);
  return dir;
}
async function task(dir: string, title: string): Promise<string> {
  const created = await createTask({
    title, prompt: `Record ${title}.`, workdir: dir, column: "ready", agent: synthetic.harnessId, model: MODEL, mode: "auto", isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  new AssignmentCore(db).assign(created.task.id, workers.get(dir)!);
  return created.task.id;
}

interface Spec { taskId: string; dir: string; priority?: "critical" | "high" | "normal" | "low"; dependsOn?: string }
function plan(specs: Spec[], limits: { globalMax: number; perProjectMax: number; perClusterMax?: number }): MissionPlan {
  const byId = new Map(specs.map((s) => [s.taskId, s]));
  return {
    clusters: [], projects: [...new Set(specs.map((s) => s.dir))],
    concurrencyLimits: { ...limits, perAccountMax: 99 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: specs.map((s): MissionTaskPlan => ({
      taskId: s.taskId, taskTitle: tasks.get(s.taskId)!.title, projectPath: s.dir, specialistRole: "developer", phase: "authorized",
      priority: s.priority ?? "normal",
      dependencies: s.dependsOn ? [{ taskId: s.dependsOn, projectPath: byId.get(s.dependsOn)!.dir, condition: "qc_pass" as const }] : [],
      harnessId: synthetic.harnessId, modelId: MODEL, accountId: synthetic.accountId, mode: "auto", qcRequired: false,
    })),
  };
}
const BASE = (dirs: string[]) => ({
  mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: dirs, specialistRoles: ["developer"], providers: ["codex"],
  models: [MODEL], accounts: [synthetic.accountId], maxConcurrentWorkers: 32, maxLaunches: 100, maxDurationMs: 36_000_000,
  expiresAt: Date.now() + 36_000_000, permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
});
function makePolicy(dirs: string[], overrides: Record<string, unknown> = {}) {
  const policy = createAutonomyPolicy({ ...BASE(dirs), ...overrides });
  const activation = activateAutonomyPolicy(policy.id);
  return { policy, activation };
}
function bind(missionId: string, p: ReturnType<typeof makePolicy>) {
  autonomyPolicyStore.upsertBinding({
    missionId, policyId: p.policy.id, revision: p.policy.revision, activationId: p.activation.id, digest: p.policy.digest,
    mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
}
function mission(specs: Spec[], limits: { globalMax: number; perProjectMax: number; perClusterMax?: number }, title: string) {
  const p = plan(specs, limits);
  const m = missionStore.createMission({ title, goal: title, status: "authorized", projects: p.projects, clusters: [], plan: p, planDigest: computeMissionPlanDigest(p) });
  missionStore.updateMissionAuthorization(m.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: m.planDigest });
  return m;
}
const phase = (missionId: string, taskId: string) => missionStore.getMission(missionId)!.plan.tasks.find((t) => t.taskId === taskId)!;
const runCount = (taskId: string) => runs.listForTask(taskId).length;
const slots = () => missionStore.listActiveReservations();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(40); }
  throw new Error("timed out waiting for the scheduler state");
}
const tick = (id: string) => missionScheduler.tickMission(id);
const hold = (ms: string) => { process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = ms; };
async function stopAllRuns() {
  for (const t of tasks.list()) if (isTaskRunLive(t.id)) { const r = runs.listForTask(t.id).at(-1); if (r) await cancelRun(r.id); }
}

const authRows = (taskId: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM autonomy_action_reservations WHERE task_id = ?").get(taskId)!.n;
const FAST_ENV = "30";

describe("Direction 7: a bound mission is held to its own activation", () => {
  for (const variant of ["revoked", "expired", "narrower"] as const) {
    test(`the mission's own policy is ${variant} while another active policy covers the project: nothing launches, nothing is reserved under the other policy`, async () => {
      const P = project(`bound-${variant}`), Other = project(`bound-${variant}-other`);
      const t = await task(P, `Unfrozen ${variant}`);
      const own = variant === "narrower"
        ? makePolicy([Other])                                   // approved for another project only
        : variant === "expired" ? makePolicy([P], { expiresAt: Date.now() + 3_600_000 }) : makePolicy([P]);
      const m = mission([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 }, `Bound ${variant}`);
      bind(m.id, own);
      const standing = makePolicy([P]);   // a second, active, broader policy that covers the project
      expect(standing.activation.status).toBe("active");
      if (variant === "revoked") revokeAutonomyPolicy(own.policy.id);
      if (variant === "expired") engine.setAutonomyClock(() => Date.now() + 7_200_000);
      missionStore.updateMissionStatus(m.id, "running", "owner started");
      hold(HOLD);
      try { await tick(m.id); await tick(m.id); } finally { engine.setAutonomyClock(() => Date.now()); }
      // Refused: no run, no slot, no grant consumed under the other policy, and the task is not running.
      expect(runCount(t)).toBe(0);
      expect(slots().length).toBe(0);
      expect(authRows(t)).toBe(0);
      expect(["running", "starting"]).not.toContain(phase(m.id, t).phase);
      expect(tasks.get(t)!.column).toBe("ready");
    }, 60000);
  }

  test("completion and rework are decided by the mission's own activation, not by any active policy", async () => {
    const P = project("exact-complete");
    const t = await task(P, "Complete exact");
    const own = makePolicy([P], { permittedActions: ["plan_task", "launch_task", "run_qc", "request_rework", "complete_task"], completion: { autoComplete: true, conditions: ["qc_pass"] }, qc: { required: true } });
    const m = mission([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 }, "Exact completion");
    bind(m.id, own);
    const standing = makePolicy([P], { permittedActions: ["plan_task", "launch_task", "run_qc", "request_rework", "complete_task"], completion: { autoComplete: true, conditions: ["qc_pass"] }, qc: { required: true } });
    expect(standing.activation.status).toBe("active");
    revokeAutonomyPolicy(own.policy.id);
    const loaded = missionStore.getMission(m.id)!;
    const taskPlan = loaded.plan.tasks[0]!;
    // The mission's policy is revoked: neither automatic completion nor an automatic rework may be granted by the standing policy.
    expect(gate.autonomyQcDecision(loaded, taskPlan, "PASS").kind).not.toBe("complete");
    expect(gate.autonomyReworkDecision(loaded, taskPlan).kind).not.toBe("rework");
    expect(tasks.get(t)!.column).toBe("ready");
  }, 60000);
});

describe("Direction 7: approval stays bound to what was approved", () => {
  test("a plan altered after approval is not launched, even to a resource inside the policy's envelope", async () => {
    const P = project("altered");
    const t = await task(P, "Altered plan");
    const own = makePolicy([P], { models: [MODEL, "gpt-6-sol"] });
    const m = mission([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 }, "Altered");
    bind(m.id, own);
    // After the Owner's approval the stored plan is changed to another allowed model (the digest was not recomputed).
    db.run(`UPDATE orchestration_missions SET plan_json = json_set(plan_json, '$.tasks[0].modelId', 'gpt-6-sol') WHERE id = ?`, [m.id]);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);
    expect(runCount(t)).toBe(0);
    expect(slots().length).toBe(0);
    expect(authRows(t)).toBe(0);
    expect(missionStore.getMission(m.id)!.status).toBe("paused");
  }, 60000);

  test("an expired grant does not come back when a stop is lifted or the app reopens", async () => {
    const P = project("expired-grant");
    const t = await task(P, "Expired grant");
    const own = makePolicy([P], { expiresAt: Date.now() + 3_600_000 });
    const m = mission([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 }, "Expired grant");
    bind(m.id, own);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    engine.setAutonomyClock(() => Date.now() + 7_200_000);
    try {
      hold(HOLD);
      await tick(m.id);
      expect(runCount(t)).toBe(0);
      // An emergency stop, lifting it, and a restart-style recovery: none of them renews an expired policy.
      await coordinator.emergencyStopAutonomy("test");
      coordinator.clearEmergencyStop();
      await coordinator.recoverAutonomy();
      await missionScheduler.recoverOrchestrationMissions();
      await tick(m.id);
      expect(runCount(t)).toBe(0);
      expect(autonomyPolicyStore.getActivation(own.activation.id)!.status).toBe("expired");
      expect(authRows(t)).toBe(0);
    } finally { engine.setAutonomyClock(() => Date.now()); }
  }, 60000);

  test("a consumed launch is not replayed: re-arming a task that already launched starts nothing", async () => {
    const P = project("consumed");
    const t = await task(P, "Consumed grant");
    const own = makePolicy([P]);
    const m = mission([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 }, "Consumed");
    bind(m.id, own);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);
    expect(runCount(t)).toBe(1);
    const reservation = autonomyPolicyStore.reservationByKey(own.activation.id, `launch_task:${t}:0`);
    expect(reservation?.status).toBe("consumed");
    await stopAllRuns();
    // Something puts the task back as ready work with the same epoch (a bad re-arm). The grant is already spent.
    const stored = missionStore.getMission(m.id)!;
    stored.plan.tasks[0]!.phase = "authorized";
    stored.plan.tasks[0]!.runId = undefined;
    missionStore.saveMissionPlanState(m.id, stored.plan, stored.state);
    missionStore.releaseTaskReservation(t);
    tasks.update(t, { column: "ready", runId: null });
    await tick(m.id); await tick(m.id);
    expect(runCount(t)).toBe(1);
    expect(phase(m.id, t).phase).toBe("failed");
    expect(phase(m.id, t).phaseReason).toMatch(/already consumed/i);
  }, 60000);

  test("an Emergency Stop cancels a launched task and lifting it does not start that task again", async () => {
    const P = project("emergency");
    const t = await task(P, "Emergency task");
    const own = makePolicy([P]);
    const m = mission([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 }, "Emergency");
    bind(m.id, own);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);
    expect(runCount(t)).toBe(1);
    await coordinator.emergencyStopAutonomy("test");
    await until(() => !isTaskRunLive(t));
    coordinator.clearEmergencyStop();
    await coordinator.recoverAutonomy();
    await missionScheduler.recoverOrchestrationMissions();
    await tick(m.id); await tick(m.id);
    expect(runCount(t)).toBe(1);
    expect(missionStore.getMission(m.id)!.status).not.toBe("running");
  }, 60000);

  test("a draft policy, an unactivated revision and a router recommendation confer no authority; an enforceable-cap requirement is refused, not estimated", async () => {
    const P = project("nopower"), Q = project("nopower-q");
    const target = (dir: string) => ({ action: "launch_task" as const, projectPath: dir, taskId: `x-${dir.length}`, role: "developer", provider: "codex", model: MODEL, accountId: synthetic.accountId });
    // Draft: created, never activated.
    const draft = createAutonomyPolicy(BASE([P]));
    expect(engine.authorizeAutonomyAction({ target: target(P), routerRecommended: true }).decision.allow).toBe(false);
    // Active for P only; a revision that adds Q exists but is not activated.
    activateAutonomyPolicy(draft.id);
    expect(engine.authorizeAutonomyAction({ target: { ...target(P), taskId: "ok-1" } }).decision.allow).toBe(true);
    engine.reviseAutonomyPolicy(draft.id, BASE([P, Q]));
    const unactivated = engine.authorizeAutonomyAction({ target: { ...target(Q), taskId: "q-1" } });
    expect(unactivated.decision.allow).toBe(false);
    // A policy that requires an enforceable spending cap cannot be activated (billing limits are not enforceable).
    const capped = createAutonomyPolicy({ ...BASE([P]), spending: { limitUsd: 5, requireEnforceableCap: true } });
    expect(() => activateAutonomyPolicy(capped.id)).toThrow(/not enforceable/);
  }, 60000);

  test("automatic completion needs a QC PASS for the latest output: new output withdraws the PASS, and without autoComplete the policy leaves Done to the Owner", async () => {
    const P = project("autocomplete");
    const created = await createTask({ title: "Stale pass", prompt: "Record.", workdir: P, column: "ready", agent: synthetic.harnessId, model: MODEL, mode: "auto", isolation: "none" });
    if ("error" in created) throw new Error(created.error);
    const id = created.task.id;
    const pass = { latestVerdict: "PASS" as const, awaitingOwnerApproval: true, activeReviewId: null, reworkCount: 0, roundCount: 1, maxRounds: 3 };
    tasks.update(id, { column: "review", qcState: pass });
    // The latest output has a PASS and the column is Review: automatic completion may proceed here.
    // New output arrives (a new run) before it is applied: the PASS is withdrawn and completion is refused.
    hold(FAST_ENV);
    const started = await startTask(id);
    if ("error" in started) throw new Error(started.error);
    await until(() => runs.get(started.runId)?.status === "succeeded");
    await until(() => tasks.get(id)!.column === "review");
    expect(tasks.get(id)!.qcState?.latestVerdict ?? null).toBeNull();
    const refused = acceptAuthorizedTaskDone(id);
    expect(refused.ok).toBe(false);
    expect(tasks.get(id)!.column).toBe("review");
    // Policy without autoComplete: the gate hands completion to the Owner even on a PASS.
    const own = makePolicy([P], { permittedActions: ["plan_task", "launch_task", "run_qc", "complete_task"], completion: { autoComplete: false, conditions: ["qc_pass"] }, qc: { required: true } });
    const m = mission([{ taskId: id, dir: P }], { globalMax: 5, perProjectMax: 5 }, "No auto complete");
    bind(m.id, own);
    const loaded = missionStore.getMission(m.id)!;
    expect(gate.autonomyQcDecision(loaded, loaded.plan.tasks[0]!, "PASS").kind).toBe("await-owner");
  }, 60000);
});

describe("Direction 7: the agent cannot change its own authority", () => {
  test("every policy route refuses a caller without the Owner's token, and nothing changes", async () => {
    const { autonomyHttp } = await import("./http.ts");
    const P = project("agent-edit");
    const own = makePolicy([P]);
    const before = JSON.stringify(autonomyPolicyStore.listPolicies().map((row) => [row.id, row.revision, row.status, row.digest]));
    const activationsBefore = autonomyPolicyStore.listActivations().length;
    const call = (method: string, route: string, body: unknown = {}) =>
      autonomyHttp(new Request(`http://127.0.0.1${route}`, { method, body: method === "GET" ? undefined : JSON.stringify(body) }), false);
    for (const [method, route, body] of [
      ["POST", "/api/autonomy/policies", BASE([P])],
      ["POST", `/api/autonomy/policies/${own.policy.id}/revise`, { ...BASE([P]), maxLaunches: 99, completion: { autoComplete: true } }],
      ["POST", `/api/autonomy/policies/${own.policy.id}/activate`, {}],
      ["POST", `/api/autonomy/policies/${own.policy.id}/revoke`, {}],
      ["POST", "/api/autonomy/emergency-stop/clear", {}],
      ["POST", "/api/autonomy/missions/prepare", {}],
    ] as Array<[string, string, unknown]>) {
      expect((await call(method, route, body)).status).toBe(401);
    }
    expect(JSON.stringify(autonomyPolicyStore.listPolicies().map((row) => [row.id, row.revision, row.status, row.digest]))).toBe(before);
    expect(autonomyPolicyStore.listActivations().length).toBe(activationsBefore);
    expect(own.activation.activatedBy).toBe("owner");
  });
});

describe("Direction 7, criterion 1: what a Full Autonomy mission refuses", () => {

  test("it refuses Done without an explicit policy, deployment, credential access, policy edits, a resource outside the list and a launch past its deadline; each refusal is journaled once", async () => {
    const P = project("boundary-full");
    makePolicy([P], { permittedActions: ["plan_task", "launch_task", "run_qc", "complete_task", "staging_deploy"], completion: { autoComplete: false, conditions: ["qc_pass"] } });
    const target = (over: Record<string, unknown>) => ({ action: "launch_task" as const, projectPath: P, taskId: "boundary-task", role: "developer", provider: "codex", model: MODEL, accountId: synthetic.accountId, ...over });
    const deny = (over: Record<string, unknown>, key: string) => engine.authorizeAutonomyAction({ target: target(over) as never, targetKey: key });

    expect(deny({ action: "complete_task", role: "reviewer" }, "complete_task:boundary-task").decision.allow).toBe(false);       // Done needs the policy's explicit permission
    for (const action of ["production_deploy", "credential_extraction", "edit_policy", "self_modify_policy", "unrestricted_filesystem"]) {
      const result = deny({ action }, `${action}:boundary-task`);
      expect(result.decision.allow).toBe(false);
      expect(result.decision.reason).toContain("security boundary");
    }
    expect(deny({ model: "gpt-9-unlisted" }, "launch_task:outside-model").decision.allow).toBe(false);   // a resource outside the allowed list
    expect(deny({ accountId: "another-account" }, "launch_task:outside-account").decision.allow).toBe(false);
    // The same refusal again is the same journal row, not a second one.
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events WHERE event_type = 'autonomy.action.denied'").get()!.n;
    const again = () => deny({ action: "production_deploy" }, "production_deploy:boundary-task");
    again(); again();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events WHERE event_type = 'autonomy.action.denied'").get()!.n).toBe(before);
    expect(before).toBeGreaterThan(0);
    // Past the authorized duration: refused even though the policy has not expired.
    engine.setAutonomyClock(() => Date.now() + 40_000_000);
    try { expect(deny({}, "launch_task:late").decision.reason).toMatch(/duration|expired/i); }
    finally { engine.setAutonomyClock(() => Date.now()); }
  }, 60000);

  test("a Full-access mode is not launched by a Full Autonomy mission", async () => {
    // Earlier cases leave held runs and reservations behind; this case counts slots, so start from none.
    await stopAllRuns();
    for (const r of slots()) missionStore.releaseTaskReservation(r.taskId);
    const P = project("fullaccess");
    const created = await createTask({ title: "Full access task", prompt: "Record.", workdir: P, column: "ready", agent: synthetic.harnessId, model: MODEL, mode: "full-access", isolation: "none" });
    if ("error" in created) throw new Error(created.error);
    const t = created.task.id;
    new AssignmentCore(db).assign(t, workers.get(P)!);
    const p = plan([{ taskId: t, dir: P }], { globalMax: 5, perProjectMax: 5 });
    p.tasks[0]!.mode = "full-access";
    const m = missionStore.createMission({ title: "Full access", goal: "x", status: "authorized", projects: p.projects, clusters: [], plan: p, planDigest: computeMissionPlanDigest(p) });
    missionStore.updateMissionAuthorization(m.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: m.planDigest });
    bind(m.id, makePolicy([P]));
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);
    expect(runCount(t)).toBe(0);
    expect(slots().length).toBe(0);
    expect(["running", "starting"]).not.toContain(phase(m.id, t).phase);
  }, 60000);
});
