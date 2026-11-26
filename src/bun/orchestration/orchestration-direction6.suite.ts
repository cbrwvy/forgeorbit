/**
 * Direction 6 (multi-project orchestration), deterministic scheduler cases on the production dispatch path.
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

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-orch-d6-")));
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
const { createTask, cancelRun, isTaskRunLive } = await import("../orchestrator.ts");
const { initEmployeeExecutionTracking } = await import("../employee-run.ts");
const { missionStore } = await import("./mission-store.ts");
const { missionScheduler } = await import("./mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy, revokeAutonomyPolicy } = await import("../autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
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
function bindPolicy(missionId: string, dirs: string[]) {
  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: dirs, specialistRoles: ["developer"], providers: ["codex"],
    models: [MODEL], accounts: [synthetic.accountId], maxConcurrentWorkers: 32, maxLaunches: 100, maxDurationMs: 3_000_000,
    expiresAt: Date.now() + 3_000_000, permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  policyByMission.set(missionId, policy.id);
  autonomyPolicyStore.upsertBinding({
    missionId, policyId: policy.id, revision: policy.revision, activationId: activation.id, digest: policy.digest,
    mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
}
const policyByMission = new Map<string, string>();
const autonomyPolicyStoreFor = (missionId: string) => policyByMission.get(missionId)!;
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

describe("Direction 6: shared slots across projects", () => {
  test("N slots, N+3 ready tasks over three projects, a stopped project and a dependency-blocked task: never more than N, nothing blocked holds a slot, a freed slot goes to the project that has waited without a turn", async () => {
    const A = project("alpha"), B = project("bravo"), C = project("charlie"), D = project("delta");
    const a1 = await task(A, "A1"), a2 = await task(A, "A2"), a3 = await task(A, "A3");
    const b1 = await task(B, "B1"), b2 = await task(B, "B2");
    const c1 = await task(C, "C1"), c2 = await task(C, "C2");
    const d1 = await task(D, "D1");
    await stopProjectLifecycle(D, "stopped for the case");
    const m = mission([
      { taskId: a1, dir: A }, { taskId: a2, dir: A }, { taskId: a3, dir: A },
      { taskId: b1, dir: B }, { taskId: b2, dir: B },
      { taskId: c1, dir: C }, { taskId: c2, dir: C, dependsOn: c1 },
      { taskId: d1, dir: D },
    ], { globalMax: 2, perProjectMax: 1 }, "Shared slots");
    bindPolicy(m.id, [A, B, C, D]);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);

    // First pass: two slots, taken by two different projects, never three.
    expect(slots().length).toBe(2);
    expect([a1, b1, c1].filter((id) => runCount(id) > 0)).toEqual([a1, b1]);
    expect(phase(m.id, c1).phaseReason).toContain("slot");
    expect(phase(m.id, a2).phaseReason).toContain("slot");
    // The structured reason the UI reads, recorded at the decision (not inferred from the sentence).
    expect(phase(m.id, c1).waitingOn).toBe("slot");
    expect(phase(m.id, a2).waitingOn).toBe("slot");
    expect(phase(m.id, c2).waitingOn).toBe("dependency");
    expect(phase(m.id, d1).waitingOn).toBe("project-stopped");
    expect(phase(m.id, a1).waitingOn).toBeUndefined();
    // Who waits and why, from the records.
    expect(phase(m.id, c2).phase).toBe("blocked");
    expect(phase(m.id, c2).blockers?.some((b) => b.includes(c1))).toBe(true);
    expect(phase(m.id, d1).phase).toBe("blocked");
    expect(phase(m.id, d1).phaseReason).toMatch(/paused|stop/i);
    // The stopped project and the dependency-blocked task hold no slot and made no run.
    expect(runCount(d1)).toBe(0);
    expect(runCount(c2)).toBe(0);
    expect(slots().some((r) => r.projectPath === D || r.taskId === c2)).toBe(false);

    // Stop A's run: one slot frees. C has waited since the start and has had no turn; A has had one.
    await cancelRun(runs.listForTask(a1)[0]!.id);
    await tick(m.id);
    expect(slots().length).toBe(2);
    expect(runCount(c1)).toBe(1);
    expect(runCount(a2)).toBe(0);
    expect(slots().map((r) => r.taskId).sort()).toEqual([b1, c1].sort());
    expect(runCount(a1)).toBe(1);   // the stopped task is not relaunched
    expect(runCount(d1)).toBe(0);   // the stopped project launched nothing
    await stopAllRuns();
    await missionScheduler.cancelMission(m.id);
  }, 90000);

  test("inside one project the higher priority goes first when only one may run", async () => {
    const P = project("priority");
    const low = await task(P, "low"), norm = await task(P, "normal"), crit = await task(P, "critical");
    const m = mission([
      { taskId: low, dir: P, priority: "low" }, { taskId: norm, dir: P, priority: "normal" }, { taskId: crit, dir: P, priority: "critical" },
    ], { globalMax: 9, perProjectMax: 1 }, "Priority");
    bindPolicy(m.id, [P]);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);
    expect(runCount(crit)).toBe(1);
    expect(runCount(norm)).toBe(0);
    expect(runCount(low)).toBe(0);
    await stopAllRuns();
    await missionScheduler.cancelMission(m.id);
  }, 60000);

  test("the shared slot is decided at the reservation: a slot taken between the check and the write is refused, not overbooked", async () => {
    const P = project("boundary-p"), Q = project("boundary-q");
    const t1 = await task(P, "T1");
    const m = mission([{ taskId: t1, dir: P }], { globalMax: 1, perProjectMax: 1, perClusterMax: 99 }, "Boundary");
    bindPolicy(m.id, [P, Q]);
    const other = await task(Q, "Competitor");
    const competitor = mission([{ taskId: other, dir: Q }], { globalMax: 1, perProjectMax: 1 }, "Competitor");
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    // Another mission's tick takes the only slot exactly between this tick's capacity check and its reservation
    // (the window an await in between would open). The hook plays that other tick.
    const sched = missionScheduler as unknown as { capacityFor: (...a: unknown[]) => unknown };
    const original = sched.capacityFor;
    let intruded = false;
    sched.capacityFor = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (!intruded) {
        intruded = true;
        missionStore.createReservation({ missionId: competitor.id, taskId: other, projectPath: Q, employeeId: "competitor", harnessId: "codex", modelId: MODEL, status: "running" });
      }
      return result;
    };
    try {
      hold(HOLD);
      await tick(m.id);
    } finally { sched.capacityFor = original; }
    expect(intruded).toBe(true);
    expect(slots().map((r) => r.taskId)).toEqual([other]);
    expect(runCount(t1)).toBe(0);
    expect(phase(m.id, t1).phaseReason).toContain("slot");
    // The refused task is still queued, not failed, and starts once the slot is really free.
    missionStore.releaseTaskReservation(other);
    await tick(m.id);
    expect(runCount(t1)).toBe(1);
    expect(slots().length).toBe(1);
    await stopAllRuns();
    await missionScheduler.cancelMission(m.id);
  }, 60000);

  test("a wake-up that arrives during a scheduler pass schedules a follow-up pass, so a freed slot advances the queue", async () => {
    const P = project("wake-p"), Q = project("wake-q");
    const t1 = await task(P, "T1"), t2 = await task(P, "T2"), g1 = await task(Q, "G1");
    // G only has to be a running mission whose tick takes a while. Its project is stopped, so its tick launches nothing
    // and raises no run event of its own that could wake the scheduler by accident.
    await stopProjectLifecycle(Q, "keeps the gate mission quiet");
    const m = mission([{ taskId: t1, dir: P }, { taskId: t2, dir: P }], { globalMax: 2, perProjectMax: 1 }, "Wake M");
    const g = mission([{ taskId: g1, dir: Q }], { globalMax: 9, perProjectMax: 1 }, "Wake G");
    bindPolicy(m.id, [P, Q]); bindPolicy(g.id, [P, Q]);
    missionStore.updateMissionStatus(m.id, "running", "owner started");
    hold(HOLD);
    await tick(m.id);
    expect(runCount(t1)).toBe(1);
    expect(runCount(t2)).toBe(0);
    expect(phase(m.id, t2).phaseReason).toContain("slot");
    missionStore.updateMissionStatus(g.id, "running", "owner started");

    // A pass in progress: M (first in the list) has been ticked and G is held inside its tick.
    const internals = missionScheduler as unknown as { tickMissionBody: (id: string) => Promise<void> };
    const original = internals.tickMissionBody;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inGate = new Promise<void>((resolve) => { entered = resolve; });
    internals.tickMissionBody = async function (this: unknown, id: string) {
      if (id === g.id) { entered(); await gate; }
      return original.call(this, id);
    };
    try {
      const pass = missionScheduler.tickAllRunningMissions();
      await inGate;
      // The controlled event: T1's run ends while the pass is running. Its run-status wake-up arrives mid-pass.
      await cancelRun(runs.listForTask(t1)[0]!.id);
      await until(() => runs.get(runs.listForTask(t1)[0]!.id)?.status === "cancelled");
      expect(runCount(t2)).toBe(0);
      release();
      await pass;
    } finally { internals.tickMissionBody = original; release(); }
    // Without a follow-up pass nothing would tick M again and T2 would wait for an unrelated future event.
    await until(() => runCount(t2) === 1, 10000);
    expect(slots().some((r) => r.taskId === t2)).toBe(true);
    await stopAllRuns();
    await missionScheduler.cancelMission(m.id);
    await missionScheduler.cancelMission(g.id);
  }, 60000);

  test("two missions ticking at once share one slot: the shared limit is never exceeded", async () => {
    const P = project("race-p"), Q = project("race-q");
    const p1 = await task(P, "P1"), q1 = await task(Q, "Q1");
    const m1 = mission([{ taskId: p1, dir: P }], { globalMax: 1, perProjectMax: 1 }, "Race 1");
    const m2 = mission([{ taskId: q1, dir: Q }], { globalMax: 1, perProjectMax: 1 }, "Race 2");
    bindPolicy(m1.id, [P, Q]); bindPolicy(m2.id, [P, Q]);
    missionStore.updateMissionStatus(m1.id, "running", "owner started");
    missionStore.updateMissionStatus(m2.id, "running", "owner started");
    hold(HOLD);
    await Promise.all([tick(m1.id), tick(m2.id)]);
    await sleep(300);
    expect(slots().length).toBe(1);
    expect([p1, q1].filter((id) => runCount(id) > 0).length).toBe(1);
    await stopAllRuns();
    await missionScheduler.cancelMission(m1.id);
    await missionScheduler.cancelMission(m2.id);
  }, 60000);

  test("restart with finished, queued and interrupted work: finished is not rerun, queued continues within the limits, an interrupted launch is never silently dispatched again", async () => {
    const F = project("rec-finished"), Qp = project("rec-queued"), I1p = project("rec-before"), I2p = project("rec-after");
    const fin = await task(F, "Finished"), queued = await task(Qp, "Queued"), before = await task(I1p, "Interrupted before dispatch"), after = await task(I2p, "Interrupted after dispatch");
    const m = mission([
      { taskId: fin, dir: F }, { taskId: before, dir: I1p }, { taskId: after, dir: I2p }, { taskId: queued, dir: Qp },
    ], { globalMax: 2, perProjectMax: 1 }, "Recovery");
    bindPolicy(m.id, [F, Qp, I1p, I2p]);
    missionStore.updateMissionStatus(m.id, "running", "owner started");

    // 1. Finished: the first task runs to the end (no QC required) and is recorded completed. One run exists.
    //    Only it is eligible now: the others are held back by the Owner's own order (a dependency), so the sequence is exact.
    const gated = missionStore.getMission(m.id)!;
    void gated;
    hold(FAST);
    // Dispatch exactly the first task by pausing the others' eligibility with project stops, then reopen them.
    for (const dir of [Qp, I1p, I2p]) await stopProjectLifecycle(dir, "sequence the case");
    await tick(m.id);
    await until(() => runs.listForTask(fin).at(-1)?.status === "succeeded");
    for (let i = 0; i < 40 && phase(m.id, fin).phase !== "completed"; i++) { await sleep(50); await tick(m.id); }
    expect(phase(m.id, fin).phase).toBe("completed");
    expect(runCount(fin)).toBe(1);

    // 2. Reopen the other projects; hold runs; dispatch "after" for real so a run and a running reservation exist.
    for (const dir of [Qp, I1p]) await stopProjectLifecycle(dir, "keep them out of this step");
    await startProjectLifecycle(I2p);
    hold(HOLD);
    await tick(m.id);
    expect(runCount(after)).toBe(1);
    expect(slots().map((r) => r.taskId)).toEqual([after]);
    const afterRun = runs.listForTask(after)[0]!;

    // 3. Crash BEFORE dispatch for "before": the reservation is written, then the process dies. The plan on disk still says
    //    "authorized" (it is saved at the end of a tick) and no run exists.
    await startProjectLifecycle(I1p);
    const realTry = missionStore.tryCreateReservation.bind(missionStore);
    (missionStore as unknown as { tryCreateReservation: unknown }).tryCreateReservation = (params: Parameters<typeof realTry>[0], limits: Parameters<typeof realTry>[1]) => {
      const result = realTry(params, limits);
      if (result.ok && params.taskId === before) throw new Error("simulated crash after the reservation was written");
      return result;
    };
    try { await tick(m.id); } catch { /* the crash */ }
    finally { (missionStore as unknown as { tryCreateReservation: unknown }).tryCreateReservation = realTry; }
    expect(runCount(before)).toBe(0);
    expect(slots().some((r) => r.taskId === before && r.status === "starting")).toBe(true);

    // 4. Crash AFTER dispatch for "after": the process is gone, the run is recorded orphaned, the card went back to Ready,
    //    the reservation still says running. Whether it finished is unknown.
    await cancelRun(afterRun.id);
    await until(() => !isTaskRunLive(after));
    db.run("UPDATE runs SET status = 'orphaned' WHERE id = ?", [afterRun.id]);
    tasks.update(after, { column: "ready" });

    // 5. Restart: reconcile the missions from the records. Then tick several times, as the next minutes would.
    for (const dir of [Qp]) await startProjectLifecycle(dir);
    hold(HOLD);
    const runsBefore = { fin: runCount(fin), before: runCount(before), after: runCount(after) };
    await missionScheduler.recoverOrchestrationMissions();
    for (let i = 0; i < 4; i++) { await tick(m.id); await sleep(60); }

    // Finished work is not rerun; neither interrupted launch was dispatched again; the outcome of "after" is not treated as success.
    expect(runCount(fin)).toBe(runsBefore.fin);
    expect(runCount(before)).toBe(runsBefore.before);
    expect(runCount(after)).toBe(runsBefore.after);
    expect(phase(m.id, fin).phase).toBe("completed");
    expect(phase(m.id, before).phase).not.toBe("running");
    expect(phase(m.id, before).phaseReason).toMatch(/owner/i);
    expect(phase(m.id, before).phase).toBe("awaiting_owner");
    expect(phase(m.id, before).recovery).toBe("interrupted-launch");
    expect(phase(m.id, after).recovery).toBe("uncertain-outcome");
    expect(phase(m.id, before).waitingOn).toBe("recovery");
    expect(phase(m.id, after).waitingOn).toBe("recovery");
    expect(phase(m.id, fin).waitingOn).toBeUndefined();
    expect(["failed", "blocked", "awaiting_owner"]).toContain(phase(m.id, after).phase);
    expect(phase(m.id, after).phaseReason).toMatch(/not (retried|treated)|indeterminate|owner/i);
    // Queued work continued under the same authorization and the limits: it started once, and no slot is overbooked.
    expect(runCount(queued)).toBe(1);
    expect(slots().map((r) => r.taskId)).toEqual([queued]);
    expect(slots().length).toBeLessThanOrEqual(2);
    await stopAllRuns();
    await missionScheduler.cancelMission(m.id);
  }, 120000);

  test("a stopped project that resumes gets its eligible work back under the same authorization, but not an interrupted launch or a revoked grant", async () => {
    const R = project("resume-r"), S = project("resume-s");
    const r1 = await task(R, "R1 eligible"), r2 = await task(R, "R2 interrupted"), r3 = await task(S, "R3 grant revoked");
    await stopProjectLifecycle(R, "stopped"); await stopProjectLifecycle(S, "stopped");
    const ma = mission([{ taskId: r1, dir: R }, { taskId: r2, dir: R }], { globalMax: 5, perProjectMax: 5 }, "Resume A");
    bindPolicy(ma.id, [R]);
    // R2 was interrupted before dispatch earlier: the record says the Owner must review it.
    const stored = missionStore.getMission(ma.id)!;
    const interrupted = stored.plan.tasks.find((t) => t.taskId === r2)!;
    interrupted.phase = "awaiting_owner"; interrupted.blockedStage = "developer"; interrupted.recovery = "interrupted-launch";
    interrupted.phaseReason = "Developer preparation was interrupted before a run existed. Owner review is required.";
    missionStore.saveMissionPlanState(ma.id, stored.plan, stored.state);
    const mb = mission([{ taskId: r3, dir: S }], { globalMax: 5, perProjectMax: 5 }, "Resume B");
    bindPolicy(mb.id, [S]);
    revokeAutonomyPolicy(autonomyPolicyStoreFor(mb.id));
    missionStore.updateMissionStatus(ma.id, "running", "owner started");
    missionStore.updateMissionStatus(mb.id, "running", "owner started");
    hold(HOLD);
    await tick(ma.id); await tick(mb.id);
    expect(phase(ma.id, r1).phase).toBe("blocked");
    expect(phase(ma.id, r1).phaseReason).toMatch(/paused|stop/i);
    expect(runCount(r1) + runCount(r2) + runCount(r3)).toBe(0);

    await startProjectLifecycle(R); await startProjectLifecycle(S);
    await tick(ma.id); await tick(mb.id);
    // Eligibility returned: R1 starts, once, under the unchanged authorization.
    expect(runCount(r1)).toBe(1);
    // The interrupted launch and the revoked grant do not come back because admission reopened.
    expect(runCount(r2)).toBe(0);
    expect(phase(ma.id, r2).phase).toBe("awaiting_owner");
    expect(runCount(r3)).toBe(0);
    for (let i = 0; i < 3; i++) { await tick(ma.id); await tick(mb.id); await sleep(40); }
    expect(runCount(r1)).toBe(1);
    expect(runCount(r2)).toBe(0);
    expect(runCount(r3)).toBe(0);
    await stopAllRuns();
    await missionScheduler.cancelMission(ma.id); await missionScheduler.cancelMission(mb.id);
  }, 90000);
});
