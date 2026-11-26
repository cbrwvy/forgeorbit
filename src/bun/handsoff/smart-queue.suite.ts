/**
 * FO-KANBAN-SMARTQUEUE01 — Smart execution queue driven by Kanban urgency,
 * persistent vertical ordering (`board_rank`), and UTC availability (`available_from_utc`).
 *
 * Uses disposable Git repos, deterministic clocks, and the fake Codex driver
 * (zero real provider calls or quota usage). Exercises the ACTUAL hands-off
 * scheduler (`driver.ts` + `queue.ts`), not standalone sorting helpers.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../../shared/task-workspace.ts";
import { DEFAULT_HANDSOFF_POLICY, type HandsoffPolicy } from "../../shared/handsoff.ts";
import { planTick, type BatchEntry } from "../../shared/task-scheduling.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-smartqueue-")));
const verdictFile = path.join(root, "qc-verdicts.txt");
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.HOME = root;
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_FAKE_QC_VERDICT_FILE = verdictFile;
process.env.FORGEORBIT_EMBEDDING_MODEL_ROOT = "/nonexistent/no-model-fixture";

const store = await import("../db.ts");
const orchestrator = await import("../orchestrator.ts");
const employeeRun = await import("../employee-run.ts");
const driver = await import("./driver.ts");
const handsoff = await import("./store.ts");
const policyApi = await import("./policy.ts");
const { reorderTask } = await import("../kanban-order.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { stopProjectLifecycle, startProjectLifecycle } = await import("../project-lifecycle.ts");
const { emergencyStopAutonomy, clearEmergencyStop } = await import("../autonomy/coordinator.ts");
const { setTaskAvailabilityClockForTest } = await import("../task-availability.ts");
const { notifySmartQueueChanged } = await import("./queue-events.ts");

const BASE_NOW = Date.parse("2026-11-26T12:00:00.000Z");
const FUTURE_ISO = "2026-11-27T08:00:00.000Z";
const FUTURE_MS = Date.parse(FUTURE_ISO);
let fakeNow = BASE_NOW;

beforeAll(() => {
  store.harnesses.setEnabled("codex", true);
  setTaskAvailabilityClockForTest(() => fakeNow);
  driver.setHandsoffDepsForTest({ now: () => fakeNow });
  employeeRun.initEmployeeExecutionTracking();
  driver.initHandsoff();
});

beforeEach(() => {
  fakeNow = BASE_NOW;
  setTaskAvailabilityClockForTest(() => fakeNow);
  driver.setHandsoffDepsForTest({ now: () => fakeNow });
  store.harnesses.setEnabled("codex", true);
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "30";
  try { clearEmergencyStop(); } catch { /* already clear */ }
  // Cancel any leftover open runs from prior tests so verdictFile consumption stays isolated per test.
  for (const open of handsoff.handsoffStore.listOpenRuns()) {
    handsoff.handsoffStore.updateRun(open.id, { stage: "finished", status: "cancelled", finishedAt: BASE_NOW });
  }
  writeFileSync(verdictFile, Array.from({ length: 30 }, () => "PASS").join("\n") + "\n");
});

afterAll(() => {
  driver.stopHandsoffTimers();
  driver.setHandsoffDepsForTest(null);
  setTaskAvailabilityClockForTest(null);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

let projectCounter = 0;
async function makeProject(name = `sq${++projectCounter}`): Promise<string> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "src/base.ts"), `export const base = 1;\n`);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]);
  store.projects.upsert(dir, name);
  return realpathSync(dir);
}

function addTeam(projectPath: string, devCount = 1) {
  const core = new EmployeeCore(store.db);
  const developers = Array.from({ length: devCount }, (_, i) =>
    core.createWorker({ name: `Dev ${i + 1}`, jobTitle: "Developer", projectPath }),
  );
  const reviewer = core.createWorker({ name: "Rae Reviewer", jobTitle: "Reviewer", projectPath });
  return { developers, reviewer };
}

let fileCounter = 0;
async function createTask(projectPath: string, title: string, extra: Record<string, unknown> = {}) {
  const n = ++fileCounter;
  const payload = {
    writes: [{ path: `src/f${n}.ts`, contents: `export const f${n} = ${n};\n` }],
  };
  const created = await orchestrator.createTask({
    title,
    prompt: `${title}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(payload)}`,
    workdir: projectPath,
    column: "ready",
    agent: "codex",
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    isolation: "worktree",
    accessMode: "workspace",
    ...extra,
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

async function enableHandsoff(projectPath: string, overrides: Partial<HandsoffPolicy> = {}) {
  const view = policyApi.readHandsoffPolicy(projectPath);
  const harnessIds = [...new Set(view.available.map((o) => o.harnessId))];
  const accountIds = [...new Set(view.available.map((o) => o.accountKey))];
  const { resources: _r, ...base } = DEFAULT_HANDSOFF_POLICY;
  return policyApi.saveHandsoffPolicy(projectPath, {
    ...base,
    enabled: true,
    autoApply: true,
    autoDone: true,
    runOfflineTests: false,
    harnessIds,
    accountIds,
    ...overrides,
  });
}

async function until<T>(read: () => T | null | undefined | false, timeoutMs = 25_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = read();
    if (v) return v;
    await Bun.sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Return tasks in the exact chronological order their Developer runs started. */
function dispatchTraceOf(taskIds: string[]): Array<{ taskId: string; title: string; employeeName: string | null; startedAt: number }> {
  const rows: Array<{ taskId: string; title: string; employeeName: string | null; startedAt: number }> = [];
  for (const taskId of taskIds) {
    const devRun = store.runs.listForTask(taskId).find((r) => !r.qcReviewId);
    if (!devRun) continue;
    const hRun = handsoff.handsoffStore.latestRunForTask(taskId);
    rows.push({
      taskId,
      title: store.tasks.get(taskId)!.title,
      employeeName: hRun?.state.developer?.employeeName ?? null,
      startedAt: devRun.startedAt,
    });
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt);
}

test("1-4, 8, 17, 19, 24. urgency descending -> board_rank ascending, dynamic reorder & urgency edit without interrupting active run, Backlog untouched, task_priorities preserved", async () => {
  const project = await makeProject("order-dynamic");
  addTeam(project, 1);
  await enableHandsoff(project, { maxParallel: 1 });

  // Unsubmitted Backlog task must NEVER start just because queue/policy is enabled
  const unsubmittedBacklog = await createTask(project, "Backlog Untouched", { column: "backlog", urgency: 5 });

  // Hold the first active run briefly so we can queue and reorder behind it
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "500";
  const runningLow = await createTask(project, "Running Low (u2)", { urgency: 2 });
  const rLow = driver.submitTask(runningLow.id);
  await until(() => handsoff.handsoffStore.getRun(rLow.id)?.stage === "developing", 10_000, "low task starts developing");

  // While runningLow is active, submit 4 tasks with mixed urgencies & same-urgency ranks
  const tD = await createTask(project, "Task D (u3)", { urgency: 3 });
  const tC = await createTask(project, "Task C (u4)", { urgency: 4 });
  const tB = await createTask(project, "Task B (u5 rank2)", { urgency: 5 });
  const tA = await createTask(project, "Task A (u5 rank1)", { urgency: 5 });

  // Record historical 4-level task_priority on tB so we verify Kanban reorder never touches it
  store.taskScheduling.setPriority(tB.id, "low");

  // Drag tA above tB inside urgency 5 so board order is A -> B -> C -> D
  reorderTask(tA.id, { expectedColumn: "ready", expectedUrgency: 5, placement: { before: tB.id } });
  expect(store.taskScheduling.priorityOf(tB.id)).toBe("low");

  // Submit in intentionally scrambled order (D, C, B, A)
  const rD = driver.submitTask(tD.id);
  const rC = driver.submitTask(tC.id);
  const rB = driver.submitTask(tB.id);
  const rA = driver.submitTask(tA.id);
  await driver.settledProject(project);

  // Non-preemption: runningLow is STILL developing and was NOT cancelled!
  expect(handsoff.handsoffStore.getRun(rLow.id)?.stage).toBe("developing");
  expect(handsoff.handsoffStore.getRun(rLow.id)?.status).toBe("active");

  // Backend queue summary matches canonical order: expectedNext === tA!
  const q1 = driver.projectQueueView(project);
  expect(q1.counts.running).toBe(1);
  expect(q1.counts.eligible).toBe(4);
  expect(q1.expectedNext?.taskId).toBe(tA.id);

  // Dynamically reorder queued cards: drag tB ABOVE tA AND raise tD's urgency to 5 (appends after B, A)
  reorderTask(tB.id, { expectedColumn: "ready", expectedUrgency: 5, placement: { before: tA.id } });
  store.tasks.update(tD.id, { urgency: 5 });
  notifySmartQueueChanged(project, "urgency");

  // Queue summary immediately reflects new #1 candidate: tB -> tA -> tD -> tC!
  const q2 = driver.projectQueueView(project);
  expect(q2.expectedNext?.taskId).toBe(tB.id);
  const eligibleIds = q2.items
    .filter((i) => i.category === "next" || i.category === "queued")
    .map((i) => i.taskId);
  expect(eligibleIds).toEqual([tB.id, tA.id, tD.id, tC.id]);
  expect(store.taskScheduling.priorityOf(tB.id)).toBe("low");

  // Let all runs finish fast
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "30";
  for (const run of [rLow, rB, rA, rD, rC]) {
    const done = await until(() => {
      const r = handsoff.handsoffStore.getRun(run.id);
      return r?.finishedAt != null ? r : null;
    }, 25_000, `run ${run.taskId} finishes`);
    expect(done.status).toBe("done");
  }

  // Verify ACTUAL dispatch trace matches: Running Low -> B -> A -> D -> C!
  const trace = dispatchTraceOf([runningLow.id, tA.id, tB.id, tC.id, tD.id]);
  expect(trace.map((x) => x.taskId)).toEqual([runningLow.id, tB.id, tA.id, tD.id, tC.id]);

  // Unsubmitted Backlog task was NEVER touched or started
  expect(store.tasks.get(unsubmittedBacklog.id)!.column).toBe("backlog");
  expect(store.runs.listForTask(unsubmittedBacklog.id)).toHaveLength(0);
}, 60_000);

test("5-7, 9-11, 24, 27-28. representative 2-worker parallel scenario: skips scheduled, dependency, and busy-pinned-worker tasks; dispatches distinct idle workers in Kanban order", async () => {
  const project = await makeProject("multi-worker");
  const { developers } = addTeam(project, 2);
  const dev1 = developers[0]!;
  const dev2 = developers[1]!;
  await enableHandsoff(project, { maxParallel: 2 });

  // Pause project while we stage the whole queue cleanly so all 6 tasks are evaluated together
  await stopProjectLifecycle(project, "staging scenario");

  const scheduledUrg5 = await createTask(project, "S1 Scheduled Urg5", { urgency: 5, availableFromUtc: FUTURE_ISO });
  const prereqUrg4 = await createTask(project, "P1 Prereq Urg4 (Dev1)", { urgency: 4 });
  const depUrg5 = await createTask(project, "D1 Dependent Urg5", { urgency: 5 });
  const pinnedDev1Urg5 = await createTask(project, "W1 Pinned Dev1 Urg5", { urgency: 5 });
  const freeUrg4 = await createTask(project, "F1 Free Urg4", { urgency: 4 });
  const freeUrg3 = await createTask(project, "F2 Free Urg3", { urgency: 3 });

  // D1 depends on P1
  store.taskScheduling.replaceDependencies(depUrg5.id, [prereqUrg4.id]);
  // Pin P1 and W1 both to Dev 1; P1 starts first, then W1 must wait on Dev 1 while Dev 2 takes F1!
  const assign = new AssignmentCore(store.db);
  assign.assign(prereqUrg4.id, dev1.id);
  assign.assign(pinnedDev1Urg5.id, dev1.id);
  // Make P1 urgency 5 and place it above W1 so P1 grabs Dev 1 first
  store.tasks.update(prereqUrg4.id, { urgency: 5 });
  reorderTask(prereqUrg4.id, { expectedColumn: "ready", expectedUrgency: 5, placement: { before: pinnedDev1Urg5.id } });

  // Unpause to submit, or hold via fake delay — submit while running with slow delay on P1
  await startProjectLifecycle(project);
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "350";

  // Submit all 6 in one turn -> coalesced into a single canonical smart-queue pass!
  const rSched = driver.submitTask(scheduledUrg5.id);
  const rDep = driver.submitTask(depUrg5.id);
  const rPrereq = driver.submitTask(prereqUrg4.id);
  const rPinned = driver.submitTask(pinnedDev1Urg5.id);
  const rFree4 = driver.submitTask(freeUrg4.id);
  const rFree3 = driver.submitTask(freeUrg3.id);

  // Immediately verify P1 (on Dev 1) and F1 (on Dev 2) start IN PARALLEL while:
  // - S1 waits for scheduled time (0 runs)
  // - D1 waits for dependency P1 (0 runs)
  // - W1 waits for busy Dev 1 (0 runs) — skipped so idle Dev 2 took F1!
  await until(
    () =>
      handsoff.handsoffStore.getRun(rPrereq.id)?.stage === "developing" &&
      handsoff.handsoffStore.getRun(rFree4.id)?.stage === "developing",
    15_000,
    "Dev 1 (P1) and Dev 2 (F1) running in parallel",
  );
  const devOfP1 = handsoff.handsoffStore.getRun(rPrereq.id)!.state.developer?.employeeId;
  const devOfF1 = handsoff.handsoffStore.getRun(rFree4.id)!.state.developer?.employeeId;
  expect(devOfP1).toBe(dev1.id);
  expect(devOfF1).toBe(dev2.id);
  expect(devOfP1).not.toBe(devOfF1);

  // Verify blocked tasks did not launch early
  expect(store.runs.listForTask(scheduledUrg5.id)).toHaveLength(0);
  expect(store.runs.listForTask(depUrg5.id)).toHaveLength(0);
  expect(store.runs.listForTask(pinnedDev1Urg5.id)).toHaveLength(0);

  // Wait for P1, F1, W1, D1, F2 to finish while S1 is STILL waiting for FUTURE_ISO
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "30";
  for (const r of [rPrereq, rFree4, rPinned, rDep, rFree3]) {
    const done = await until(() => {
      const cur = handsoff.handsoffStore.getRun(r.id);
      return cur?.finishedAt != null ? cur : null;
    }, 30_000, `task ${r.taskId} finishes`);
    expect(done.status).toBe("done");
  }
  // S1 STILL has 0 runs before FUTURE_MS
  expect(store.runs.listForTask(scheduledUrg5.id)).toHaveLength(0);
  expect(handsoff.handsoffStore.getRun(rSched.id)!.state.waitKind).toBe("scheduled");

  // Advance clock to FUTURE_MS -> S1 automatically becomes eligible and finishes!
  fakeNow = FUTURE_MS;
  await driver.scheduleProject(project);
  const doneSched = await until(() => {
    const cur = handsoff.handsoffStore.getRun(rSched.id);
    return cur?.finishedAt != null ? cur : null;
  }, 20_000, "scheduled task finishes at FUTURE_MS");
  expect(doneSched.status).toBe("done");

  const trace = dispatchTraceOf([prereqUrg4.id, freeUrg4.id, pinnedDev1Urg5.id, depUrg5.id, freeUrg3.id, scheduledUrg5.id]);
  // First two dispatched are P1 (Dev 1) and F1 (Dev 2); S1 is strictly last (after clock reached FUTURE_MS).
  expect(new Set(trace.slice(0, 2).map((x) => x.taskId))).toEqual(new Set([prereqUrg4.id, freeUrg4.id]));
  expect(trace.at(-1)!.taskId).toBe(scheduledUrg5.id);
}, 60_000);

test("15-16, 21-22. pause/resume reconsiders latest persisted order, Emergency Stop holds, restart restores order without replaying done tasks, concurrent ticks never double-launch", async () => {
  const project = await makeProject("pause-restart-race");
  addTeam(project, 1);
  await enableHandsoff(project, { maxParallel: 1 });

  const t1 = await createTask(project, "Paused First (u4)", { urgency: 4 });
  const t2 = await createTask(project, "Paused Second (u4)", { urgency: 4 });

  // Pause project -> submit requires running, so pause right after submitting under slow hold
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "300";
  const blocker = await createTask(project, "Initial Done Task", { urgency: 5 });
  const rBlocker = driver.submitTask(blocker.id);
  const r1 = driver.submitTask(t1.id);
  const r2 = driver.submitTask(t2.id);
  await until(() => handsoff.handsoffStore.getRun(rBlocker.id)?.stage === "developing", 10_000, "blocker starts");

  // Pause project while t1 and t2 are queued; blocker finishes its active Developer run and drains to paused
  await stopProjectLifecycle(project, "pause queue test");
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
  await until(() => driver.projectQueueView(project).lifecycleState === "paused", 20_000, "project drains to paused");
  await driver.scheduleProject(project);
  await driver.settledProject(project);

  // While paused: neither t1 nor t2 launched!
  expect(store.runs.listForTask(t1.id)).toHaveLength(0);
  expect(store.runs.listForTask(t2.id)).toHaveLength(0);
  expect(driver.projectQueueView(project).lifecycleState).toBe("paused");

  // Reorder while paused: drag t2 above t1!
  reorderTask(t2.id, { expectedColumn: "ready", expectedUrgency: 4, placement: { before: t1.id } });

  // Simulate restart while paused -> still paused, nothing launches -> then resume -> concurrent ticks cannot double-launch,
  // blocker finishes its review/done WITHOUT replaying Developer, and t2 launches BEFORE t1!
  driver.stopHandsoffTimers();
  driver.initHandsoff();
  driver.recoverHandsoff();
  expect(store.runs.listForTask(t1.id)).toHaveLength(0);
  expect(store.runs.listForTask(t2.id)).toHaveLength(0);

  await startProjectLifecycle(project);
  // Hammer concurrent scheduler ticks simultaneously
  await Promise.all([
    driver.scheduleProject(project),
    driver.scheduleProject(project),
    driver.scheduleProject(project),
    driver.wake(r1.id),
    driver.wake(r2.id),
  ]);

  for (const r of [rBlocker, r2, r1]) {
    const done = await until(() => {
      const cur = handsoff.handsoffStore.getRun(r.id);
      if (cur?.status === "needs-owner") throw new Error(`Unexpected blocker on ${store.tasks.get(r.taskId)?.title}: ${cur.blocker?.code} — ${cur.blocker?.message}`);
      return cur?.finishedAt != null ? cur : null;
    }, 25_000, `resumed task ${store.tasks.get(r.taskId)?.title ?? r.taskId}`);
    expect(done.status).toBe("done");
  }

  // Blocker was NOT replayed (still exactly 1 developer run); t2 dispatched strictly before t1; each has exactly 1 dev run
  expect(store.runs.listForTask(blocker.id).filter((r) => !r.qcReviewId)).toHaveLength(1);
  expect(store.runs.listForTask(t2.id).filter((r) => !r.qcReviewId)).toHaveLength(1);
  expect(store.runs.listForTask(t1.id).filter((r) => !r.qcReviewId)).toHaveLength(1);
  const trace = dispatchTraceOf([t1.id, t2.id]);
  expect(trace.map((x) => x.taskId)).toEqual([t2.id, t1.id]);

  // Emergency Stop prevents launches even for urgency 5 and clearing does not auto-resume stopped runs
  const tStop = await createTask(project, "Emergency Urg5", { urgency: 5 });
  await emergencyStopAutonomy("test estop");
  expect(() => driver.submitTask(tStop.id)).toThrow(/Emergency Stop/);
  clearEmergencyStop();
  expect(store.runs.listForTask(tStop.id)).toHaveLength(0);
}, 60_000);

test("23. review and rework stages are never starved by newly submitted urgency-5 tasks", async () => {
  const project = await makeProject("rework-priority");
  addTeam(project, 1);
  await enableHandsoff(project, { maxParallel: 1, maxFixRounds: 2 });

  // First review asks for changes; second review passes; third passes for the new urg-5 task
  writeFileSync(verdictFile, "CHANGES_REQUESTED|Fix naming\nPASS\nPASS\n");
  const activeTask = await createTask(project, "Active Rework Task (u2)", { urgency: 2 });
  const newUrgent = await createTask(project, "New Urgent Task (u5)", { urgency: 5 });

  let urgentSubmittedAtFix = false;
  driver.setHandsoffDepsForTest({
    now: () => fakeNow,
    onFix: (taskId) => {
      if (taskId === activeTask.id && !urgentSubmittedAtFix) {
        urgentSubmittedAtFix = true;
        // Right when activeTask enters bounded rework (`fixing`), submit a brand-new urgency-5 task!
        driver.submitTask(newUrgent.id);
      }
    },
  });

  const rActive = driver.submitTask(activeTask.id);
  const doneActive = await until(() => {
    const r = handsoff.handsoffStore.getRun(rActive.id);
    return r?.finishedAt != null ? r : null;
  }, 30_000, "active rework task completes");
  expect(doneActive.status).toBe("done");
  expect(doneActive.round).toBe(1);
  expect(urgentSubmittedAtFix).toBe(true);

  // New urgency-5 task completes afterwards (it waited for activeTask's rework & final review to finish!)
  const doneUrgent = await until(() => {
    const r = handsoff.handsoffStore.latestRunForTask(newUrgent.id);
    return r?.finishedAt != null ? r : null;
  }, 30_000, "new urgent task completes after rework");
  expect(doneUrgent.status).toBe("done");

  const activeDevRuns = store.runs.listForTask(activeTask.id).filter((r) => !r.qcReviewId).sort((a, b) => a.startedAt - b.startedAt);
  const urgentDevRun = store.runs.listForTask(newUrgent.id).find((r) => !r.qcReviewId)!;
  expect(activeDevRuns).toHaveLength(2);
  // Active task's rework run (2nd dev run) started BEFORE the newly submitted urgency-5 task!
  expect(activeDevRuns[1]!.startedAt).toBeLessThanOrEqual(urgentDevRun.startedAt);
}, 60_000);

test("12, 18, 20. cross-project fairness (no global board_rank comparison), uncovered account never substituted, approved batch frozen priority contract preserved", async () => {
  const projA = await makeProject("fair-a");
  const projB = await makeProject("fair-b");
  addTeam(projA, 1);
  addTeam(projB, 1);
  await enableHandsoff(projA, { maxParallel: 1 });
  await enableHandsoff(projB, { maxParallel: 1 });

  // Project A has urgency-5 tasks; Project B has urgency-1 task — Project B must NOT be starved by Project A!
  const a1 = await createTask(projA, "ProjA Critical 1", { urgency: 5 });
  const a2 = await createTask(projA, "ProjA Critical 2", { urgency: 5 });
  const b1 = await createTask(projB, "ProjB Minimal 1", { urgency: 1 });

  const rA1 = driver.submitTask(a1.id);
  const rA2 = driver.submitTask(a2.id);
  const rB1 = driver.submitTask(b1.id);

  await driver.scheduleAllProjects();
  for (const r of [rA1, rA2, rB1]) {
    const done = await until(() => {
      const cur = handsoff.handsoffStore.getRun(r.id);
      return cur?.finishedAt != null ? cur : null;
    }, 30_000, `cross-project task ${r.taskId} finishes`);
    expect(done.status).toBe("done");
  }

  // Uncovered account request is NEVER substituted even for urgency 5
  const badAcct = await createTask(projA, "Uncovered Account Urg5", { urgency: 5 });
  const rBad = driver.submitTask(badAcct.id, { accountId: "nonexistent-account" });
  const blocked = await until(() => {
    const cur = handsoff.handsoffStore.getRun(rBad.id);
    return cur?.status === "needs-owner" ? cur : null;
  }, 10_000, "uncovered account blocked");
  expect(blocked.blocker?.code).toBe("no-resource");
  expect(store.runs.listForTask(badAcct.id)).toHaveLength(0);

  // Approved execution batch retains frozen 4-level `task_priorities` ordering independent of Kanban urgency
  const mkEntry = (taskId: string, order: number): BatchEntry => ({
    taskId, title: taskId, order,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", mode: "auto", fast: false, maxMode: false, profileId: null, pipelineId: null },
    approved: null, appliedFingerprint: null, attempts: [], launching: null, hold: null, failureSeen: 0, observed: null,
  });
  const decision = planTick({
    status: "running",
    policy: { maxParallel: 1, maxStarts: 10, maxRetriesPerTask: 0, maxDurationMinutes: null, spending: "no-extra", noOverageHarnessIds: [], reviewPolicy: "continue-independent", onFailure: "pause" },
    entries: [mkEntry("batch-low", 0), mkEntry("batch-critical", 1)],
    states: new Map([["batch-low", "pending"], ["batch-critical", "pending"]]),
    priorities: new Map([["batch-low", "low"], ["batch-critical", "critical"]]),
    readiness: new Map([["batch-low", { state: "ready" }], ["batch-critical", { state: "ready" }]]),
    now: BASE_NOW,
    deadlineAt: null,
  });
  expect(decision.kind).toBe("start");
  if (decision.kind === "start") expect(decision.taskIds).toEqual(["batch-critical"]);
}, 60_000);
