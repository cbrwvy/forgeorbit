/**
 * Scheduled task availability & automatic execution gating (FO-KANBAN-SCHEDULE01).
 *
 * Uses a disposable data dir, disposable Git projects, deterministic clocks,
 * and the fake Codex driver — zero real provider calls or quota consumption.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";
import { DEFAULT_HANDSOFF_POLICY, type HandsoffPolicy } from "../shared/handsoff.ts";
import { sortBoardTasks } from "../shared/board-order.ts";
import { planTick, type BatchEntry } from "../shared/task-scheduling.ts";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-schedule-")));
const verdictFile = path.join(root, "qc-verdicts.txt");
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.HOME = root;
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_FAKE_QC_VERDICT_FILE = verdictFile;
process.env.FORGEORBIT_EMBEDDING_MODEL_ROOT = "/nonexistent/no-model-fixture";

const store = await import("./db.ts");
const orchestrator = await import("./orchestrator.ts");
const employeeRun = await import("./employee-run.ts");
const { prepareEmployeeExecution } = await import("./employee-execution.ts");
const driver = await import("./handsoff/driver.ts");
const handsoff = await import("./handsoff/store.ts");
const policyApi = await import("./handsoff/policy.ts");
const { reorderTask } = await import("./kanban-order.ts");
const { EmployeeCore } = await import("./employee-core.ts");
const { AssignmentCore } = await import("./assignment-core.ts");
const { stopProjectLifecycle, startProjectLifecycle } = await import("./project-lifecycle.ts");
const { emergencyStopAutonomy, clearEmergencyStop } = await import("./autonomy/coordinator.ts");
const { setTaskAvailabilityClockForTest, notifyTaskAvailabilityChanged } = await import("./task-availability.ts");
const { migrate } = await import("./migrate.ts");
const { migrations } = await import("./migrations/index.ts");
const { readOwnerActions } = await import("./owner-actions.ts");
const { BackupManager } = await import("./backup-manager.ts");
const { restoreBackupSnapshot } = await import("./backup-restore.ts");
const { missionStore } = await import("./orchestration/mission-store.ts");
const { missionScheduler } = await import("./orchestration/mission-scheduler.ts");
const { computeMissionPlanDigest } = await import("../shared/orchestration/plan-digest.ts");
const { createAutonomyPolicy, activateAutonomyPolicy } = await import("./autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("./autonomy/policy-store.ts");
const { AccountCore } = await import("./account-core.ts");
const { CodexProfiles } = await import("./codex-profiles.ts");
import type { MissionPlan } from "../shared/orchestration/types.ts";

// Deterministic clock: 2026-11-26T12:00:00.000Z
const BASE_NOW = Date.parse("2026-11-26T12:00:00.000Z");
const TARGET_ISO = "2026-11-27T08:00:00.000Z";
const TARGET_MS = Date.parse(TARGET_ISO);
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
  try { clearEmergencyStop(); } catch { /* already clear */ }
  writeFileSync(verdictFile, "PASS\nPASS\nPASS\nPASS\n");
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
async function makeProject(name = `proj${++projectCounter}`): Promise<string> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "src/util.ts"), `export const ok = true;\n`);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]);
  store.projects.upsert(dir, name);
  return realpathSync(dir);
}

function addTeam(projectPath: string) {
  const core = new EmployeeCore(store.db);
  return {
    developer: core.createWorker({ name: "Dana Developer", jobTitle: "Developer", projectPath }),
    reviewer: core.createWorker({ name: "Rae Reviewer", jobTitle: "Reviewer", projectPath }),
  };
}

const PASSING_PAYLOAD = {
  writes: [
    { path: "src/util.ts", contents: `export const ok = true;\nexport const scheduled = 1;\n` },
    { path: "src/util.test.ts", contents: `import { expect, test } from "bun:test";\nimport { scheduled } from "./util.ts";\ntest("works", () => { expect(scheduled).toBe(1); });\n` },
  ],
};

async function createCodexTask(projectPath: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await orchestrator.createTask({
    title,
    prompt: `${title}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(PASSING_PAYLOAD)}`,
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

async function until<T>(read: () => T | null | undefined | false, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Bun.sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("1. existing tasks migrate cleanly to immediate availability (migration 153)", () => {
  const dbPath = path.join(root, "migration-check.sqlite");
  const legacyDb = new Database(dbPath);
  const before153 = migrations.filter((m) => m.id !== "153_task_available_from");
  migrate(legacyDb, before153);
  legacyDb.run(
    `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, isolation, task_type, urgency, board_rank, created_at, updated_at)
     VALUES ('legacy-1', 'Legacy task', 'Do work', 'ready', 'codex', '/tmp', 'none', 'feature', 4, 1024, 1000, 1000)`,
  );
  const applied = migrate(legacyDb, migrations);
  expect(applied).toEqual(["153_task_available_from"]);
  const row = legacyDb.query<{ urgency: number; board_rank: number; available_from_utc: string | null }, []>(
    `SELECT urgency, board_rank, available_from_utc FROM tasks WHERE id = 'legacy-1'`,
  ).get()!;
  expect(row.urgency).toBe(4);
  expect(row.board_rank).toBe(1024);
  expect(row.available_from_utc).toBeNull();
  legacyDb.close();
});

test("2-5, 12-14. creation, validation, editing, clearing, urgency change, reorder, and column transitions preserve availableFromUtc", async () => {
  const project = await makeProject("crud");
  // No timestamp -> immediate (null)
  const immediate = await createCodexTask(project, "Immediate task");
  expect(immediate.availableFromUtc).toBeNull();

  // Valid future UTC timestamp
  const scheduled = await createCodexTask(project, "Scheduled task", { urgency: 4, availableFromUtc: TARGET_ISO });
  expect(scheduled.availableFromUtc).toBe(TARGET_ISO);
  expect(scheduled.urgency).toBe(4);

  // Invalid / ambiguous timestamps rejected at createTask
  const noTz = await orchestrator.createTask({
    title: "Bad", prompt: "Bad", workdir: project, isolation: "none", availableFromUtc: "2026-11-27T08:00:00",
  });
  expect("error" in noTz).toBe(true);
  const fakeDate = await orchestrator.createTask({
    title: "Bad2", prompt: "Bad2", workdir: project, isolation: "none", availableFromUtc: "2026-02-30T08:00:00Z",
  });
  expect("error" in fakeDate).toBe(true);

  // Changing urgency preserves availableFromUtc
  const afterUrgency = store.tasks.update(scheduled.id, { urgency: 5 })!;
  expect(afterUrgency.urgency).toBe(5);
  expect(afterUrgency.availableFromUtc).toBe(TARGET_ISO);

  // Reordering vertically preserves availableFromUtc
  const peer = await createCodexTask(project, "Peer high urgency", { urgency: 5 });
  reorderTask(scheduled.id, { expectedColumn: "ready", expectedUrgency: 5, placement: { after: peer.id } });
  expect(store.tasks.get(scheduled.id)!.availableFromUtc).toBe(TARGET_ISO);

  // Column transition preserves availableFromUtc
  const moved = store.tasks.update(scheduled.id, { column: "backlog" })!;
  expect(moved.column).toBe("backlog");
  expect(moved.availableFromUtc).toBe(TARGET_ISO);

  // Editing and clearing availableFromUtc preserves urgency and boardRank
  const rankBefore = store.tasks.get(scheduled.id)!.boardRank;
  const newIso = "2026-11-28T09:30:00.000Z";
  const edited = store.tasks.update(scheduled.id, { availableFromUtc: newIso })!;
  expect(edited.availableFromUtc).toBe(newIso);
  expect(edited.urgency).toBe(5);
  expect(edited.boardRank).toBe(rankBefore);

  const cleared = store.tasks.update(scheduled.id, { availableFromUtc: null })!;
  expect(cleared.availableFromUtc).toBeNull();
  expect(cleared.urgency).toBe(5);
  expect(cleared.boardRank).toBe(rankBefore);
});

test("7-10. before timestamp: submission waits without launching/slots/budget/attention; at exact timestamp it becomes eligible and runs", async () => {
  const project = await makeProject("handsoff-wait");
  addTeam(project);
  await enableHandsoff(project, { maxParallel: 1 });

  // Backlog task with future UTC schedule
  const task = await createCodexTask(project, "Scheduled feature", {
    column: "backlog",
    availableFromUtc: TARGET_ISO,
  });

  // Direct startTask is refused before timestamp
  const directRefused = await orchestrator.startTask(task.id);
  expect("error" in directRefused).toBe(true);
  if ("error" in directRefused) expect(directRefused.error).toContain(TARGET_ISO);

  // Submit before timestamp -> accepted, moved to ready, enters waiting/scheduled, zero runs spawned
  const submitted = driver.submitTask(task.id);
  await driver.settled(submitted.id);

  const waitingRun = handsoff.handsoffStore.getRun(submitted.id)!;
  expect(waitingRun.status).toBe("waiting");
  expect(waitingRun.stage).toBe("queued");
  expect(waitingRun.state.waitKind).toBe("scheduled");
  expect(waitingRun.state.waitUntil).toBe(TARGET_MS);
  expect(store.tasks.get(task.id)!.column).toBe("ready");
  expect(store.runs.listForTask(task.id)).toHaveLength(0);

  // Not an Owner attention item while waiting for scheduled time
  const actions = readOwnerActions();
  expect((actions.handsoffBlockers ?? []).some((b) => b.taskId === task.id)).toBe(false);

  // Even 1 ms before timestamp: still refused, still 0 runs
  fakeNow = TARGET_MS - 1;
  await driver.wake(submitted.id);
  await driver.settled(submitted.id);
  expect(handsoff.handsoffStore.getRun(submitted.id)!.status).toBe("waiting");
  expect(store.runs.listForTask(task.id)).toHaveLength(0);

  // Exactly at timestamp: becomes eligible and runs to completion without re-submission
  fakeNow = TARGET_MS;
  await driver.wake(submitted.id);
  const doneRun = await until(() => {
    const r = handsoff.handsoffStore.getRun(submitted.id);
    return r?.finishedAt != null ? r : null;
  }, 20_000, "scheduled task finishes at timestamp");
  expect(doneRun.status).toBe("done");
  expect(store.tasks.get(task.id)!.column).toBe("done");
  expect(store.runs.listForTask(task.id).length).toBeGreaterThanOrEqual(1);
}, 30_000);

test("11. an available lower-urgency task proceeds while a higher-urgency scheduled task waits (hands-off & approved batch)", async () => {
  const project = await makeProject("urgency-skip");
  addTeam(project);
  await enableHandsoff(project, { maxParallel: 1 });

  const highScheduled = await createCodexTask(project, "Task A High Future", { urgency: 5, availableFromUtc: TARGET_ISO });
  const lowImmediate = await createCodexTask(project, "Task C Normal Now", { urgency: 3, availableFromUtc: null });

  // Board order keeps A above C
  const ordered = sortBoardTasks([lowImmediate, highScheduled]);
  expect(ordered.map((t) => t.id)).toEqual([highScheduled.id, lowImmediate.id]);

  // Submit both under maxParallel: 1
  const runA = driver.submitTask(highScheduled.id);
  await driver.settled(runA.id);
  expect(handsoff.handsoffStore.getRun(runA.id)!.status).toBe("waiting");

  const runC = driver.submitTask(lowImmediate.id);
  const doneC = await until(() => {
    const r = handsoff.handsoffStore.getRun(runC.id);
    return r?.finishedAt != null ? r : null;
  }, 20_000, "lower urgency task C finishes while A waits");
  expect(doneC.status).toBe("done");
  // Task A still waited untouched with 0 runs
  expect(handsoff.handsoffStore.getRun(runA.id)!.status).toBe("waiting");
  expect(store.runs.listForTask(highScheduled.id)).toHaveLength(0);

  // Also verify approved-batch pure scheduler `planTick` skips time-blocked high-priority task
  const mkEntry = (taskId: string, order: number): BatchEntry => ({
    taskId, title: taskId, order,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", mode: "auto", fast: false, maxMode: false, profileId: null, pipelineId: null },
    approved: null, appliedFingerprint: null, attempts: [], launching: null, hold: null, failureSeen: 0, observed: null,
  });
  const decision = planTick({
    status: "running",
    policy: { maxParallel: 1, maxStarts: 10, maxRetriesPerTask: 0, maxDurationMinutes: null, spending: "no-extra", noOverageHarnessIds: [], reviewPolicy: "continue-independent", onFailure: "pause" },
    entries: [mkEntry("high-scheduled", 0), mkEntry("low-now", 1)],
    states: new Map([["high-scheduled", "pending"], ["low-now", "pending"]]),
    priorities: new Map([["high-scheduled", "critical"], ["low-now", "low"]]),
    readiness: new Map([["high-scheduled", { state: "ready" }], ["low-now", { state: "ready" }]]),
    scheduledWait: new Map([["high-scheduled", TARGET_MS]]),
    now: BASE_NOW,
    deadlineAt: null,
  });
  expect(decision.kind).toBe("start");
  if (decision.kind === "start") expect(decision.taskIds).toEqual(["low-now"]);
}, 30_000);

test("15-16. unsubmitted Backlog task stays untouched when timestamp arrives; submitted task resumes after restart", async () => {
  const project = await makeProject("restart-backlog");
  addTeam(project);
  await enableHandsoff(project);

  const backlogTask = await createCodexTask(project, "Unsubmitted backlog", { column: "backlog", availableFromUtc: TARGET_ISO });
  const submittedTask = await createCodexTask(project, "Submitted scheduled", { column: "backlog", availableFromUtc: TARGET_ISO });

  const run = driver.submitTask(submittedTask.id);
  await driver.settled(run.id);
  expect(handsoff.handsoffStore.getRun(run.id)!.status).toBe("waiting");

  // Simulate restart after scheduled time has passed
  driver.stopHandsoffTimers();
  fakeNow = TARGET_MS + 60_000;
  driver.initHandsoff();
  driver.recoverHandsoff();

  const finished = await until(() => {
    const r = handsoff.handsoffStore.getRun(run.id);
    return r?.finishedAt != null ? r : null;
  }, 20_000, "submitted task resumes after restart");
  expect(finished.status).toBe("done");

  // Unsubmitted Backlog task NEVER launched or moved out of Backlog
  expect(store.tasks.get(backlogTask.id)!.column).toBe("backlog");
  expect(store.runs.listForTask(backlogTask.id)).toHaveLength(0);
}, 30_000);

test("17-21. Emergency Stop, paused project, unavailable provider, and dependencies still enforce after timestamp arrives", async () => {
  const project = await makeProject("gates");
  addTeam(project);
  await enableHandsoff(project);

  // 17. Emergency Stop wins
  const emergencyTask = await createCodexTask(project, "Emergency gated", { availableFromUtc: TARGET_ISO });
  const eRun = driver.submitTask(emergencyTask.id);
  await driver.settled(eRun.id);
  await emergencyStopAutonomy("Test stop");
  fakeNow = TARGET_MS;
  await driver.wake(eRun.id);
  await driver.settled(eRun.id);
  expect(handsoff.handsoffStore.getRun(eRun.id)!.status).toBe("stopped");
  expect(store.runs.listForTask(emergencyTask.id)).toHaveLength(0);
  clearEmergencyStop();

  // 18. Paused project remains paused
  fakeNow = BASE_NOW;
  const pausedTask = await createCodexTask(project, "Paused project task", { availableFromUtc: TARGET_ISO });
  const pRun = driver.submitTask(pausedTask.id);
  await driver.settled(pRun.id);
  await stopProjectLifecycle(project, "Paused for test");
  fakeNow = TARGET_MS;
  await driver.wake(pRun.id);
  await driver.settled(pRun.id);
  expect(handsoff.handsoffStore.getRun(pRun.id)!.status).toBe("waiting");
  expect(handsoff.handsoffStore.getRun(pRun.id)!.state.waitKind).toBe("project-paused");
  expect(store.runs.listForTask(pausedTask.id)).toHaveLength(0);
  // Cancel before resuming so resuming does not immediately launch the test task
  await driver.cancelHandsoffRun(pRun.id);
  await startProjectLifecycle(project);

  // 20. Unavailable provider blocks execution after timestamp arrives
  fakeNow = BASE_NOW;
  const providerTask = await createCodexTask(project, "Provider blocked", { availableFromUtc: TARGET_ISO });
  const prRun = driver.submitTask(providerTask.id);
  await driver.settled(prRun.id);
  store.harnesses.setEnabled("codex", false);
  fakeNow = TARGET_MS;
  await driver.wake(prRun.id);
  await driver.settled(prRun.id);
  expect(handsoff.handsoffStore.getRun(prRun.id)!.status).toBe("needs-owner");
  expect(store.runs.listForTask(providerTask.id)).toHaveLength(0);
  store.harnesses.setEnabled("codex", true);
  await driver.cancelHandsoffRun(prRun.id);

  // 21. Unfinished dependency blocks execution after timestamp arrives
  fakeNow = BASE_NOW;
  const prereq = await createCodexTask(project, "Prerequisite");
  const depTask = await createCodexTask(project, "Dependent scheduled", { availableFromUtc: TARGET_ISO });
  store.taskScheduling.replaceDependencies(depTask.id, [prereq.id]);
  const dRun = driver.submitTask(depTask.id);
  await driver.settled(dRun.id);
  fakeNow = TARGET_MS;
  await driver.wake(dRun.id);
  await driver.settled(dRun.id);
  const dState = handsoff.handsoffStore.getRun(dRun.id)!;
  expect(dState.status).toBe("waiting");
  expect(dState.state.waitKind).toBe("dependency");
  expect(dState.state.waitReason).toContain("Prerequisite");
  expect(store.runs.listForTask(depTask.id)).toHaveLength(0);
  await driver.cancelHandsoffRun(dRun.id);
});

test("22-23. concurrent scheduler ticks cannot double-launch; schedule changed after reservation is rechecked before dispatch", async () => {
  const project = await makeProject("race-and-recheck");
  const { developer } = addTeam(project);
  await enableHandsoff(project);

  // 22. Concurrent wake calls at exact timestamp produce only ONE developer run
  const raceTask = await createCodexTask(project, "Concurrent wake task", { availableFromUtc: TARGET_ISO });
  const rRun = driver.submitTask(raceTask.id);
  await driver.settled(rRun.id);
  fakeNow = TARGET_MS;
  await Promise.all([driver.wake(rRun.id), driver.wake(rRun.id), driver.wake(rRun.id), driver.wake(rRun.id)]);
  const doneRace = await until(() => {
    const r = handsoff.handsoffStore.getRun(rRun.id);
    return r?.finishedAt != null ? r : null;
  }, 20_000, "concurrent wake finishes");
  expect(doneRace.status).toBe("done");
  const devRuns = store.runs.listForTask(raceTask.id).filter((r) => !r.qcReviewId);
  expect(devRuns).toHaveLength(1);

  // 23. Timestamp changed AFTER employee reservation/claim is rechecked before dispatch
  fakeNow = BASE_NOW;
  const recheckTask = await createCodexTask(project, "Post-reservation recheck", { availableFromUtc: null });
  new AssignmentCore(store.db).assign(recheckTask.id, developer.id);

  // Preflight passes while immediate
  const preflightOk = prepareEmployeeExecution({ taskId: recheckTask.id, harnessId: "codex", model: "gpt-6.1-sol" });
  expect(preflightOk.outcome).toBe("prepared");

  const review = await employeeRun.reviewEmployeeExecution({ taskId: recheckTask.id, harnessId: "codex", model: "gpt-6.1-sol" });
  expect(review.attempt).not.toBeNull();

  // Move availableFromUtc into the future AFTER claim, before launch dispatch!
  let caughtCode = "";
  try {
    await employeeRun.startEmployeeExecution(
      review.attempt!.id,
      { revision: review.attempt!.revision, confirm: true, acknowledgeUsage: true },
      {
        afterClaim: () => {
          store.tasks.update(recheckTask.id, { availableFromUtc: TARGET_ISO });
        },
      },
    );
  } catch (err) {
    caughtCode = (err as { code?: string })?.code ?? "";
  }
  expect(caughtCode).toBe("scheduled-not-yet-available");
  expect(store.runs.listForTask(recheckTask.id)).toHaveLength(0);

  // Also test clearing availableFromUtc notifies waiting hands-off run immediately
  const earlyTask = await createCodexTask(project, "Early clear task", { availableFromUtc: TARGET_ISO });
  const earlyRun = driver.submitTask(earlyTask.id);
  await driver.settled(earlyRun.id);
  expect(handsoff.handsoffStore.getRun(earlyRun.id)!.status).toBe("waiting");
  store.tasks.update(earlyTask.id, { availableFromUtc: null });
  notifyTaskAvailabilityChanged(earlyTask.id, null);
  const doneEarly = await until(() => {
    const r = handsoff.handsoffStore.getRun(earlyRun.id);
    return r?.finishedAt != null ? r : null;
  }, 20_000, "cleared schedule runs immediately");
  expect(doneEarly.status).toBe("done");
}, 30_000);

test("24-25. MissionScheduler skips scheduled tasks without reserving slots, runs available peers, and backup/restore preserves availableFromUtc", async () => {
  const projectA = await makeProject("mission-a");
  const projectB = await makeProject("mission-b");
  const teamA = addTeam(projectA);
  const teamB = addTeam(projectB);

  const syntheticDir = path.join(root, "mission-codex-account");
  writeSyntheticCodexProfile(syntheticDir, "synthetic-sched");
  const synthetic = new CodexProfiles(new AccountCore(store.db)).register({
    displayName: "Schedule Mission Account",
    directory: syntheticDir,
  });

  const scheduledTask = await createCodexTask(projectA, "Mission Future Task", {
    agent: synthetic.harnessId,
    isolation: "none",
    availableFromUtc: TARGET_ISO,
  });
  const immediateTask = await createCodexTask(projectB, "Mission Now Task", {
    agent: synthetic.harnessId,
    isolation: "none",
    availableFromUtc: null,
  });
  const assign = new AssignmentCore(store.db);
  assign.assign(scheduledTask.id, teamA.developer.id);
  assign.assign(immediateTask.id, teamB.developer.id);

  // Verify backup & restore preserves available_from_utc faithfully
  const backupDir = path.join(root, "backups");
  mkdirSync(backupDir, { recursive: true });
  const bm = new BackupManager({ db: store.db, dataDir: process.env.AGETOR_DATA_DIR! });
  const snap = await bm.createSnapshot({ destinationDir: backupDir, createDirectory: true });
  const restoredDir = path.join(root, "restored-profile");
  await restoreBackupSnapshot(snap.path, restoredDir);
  const restoredDb = new Database(path.join(restoredDir, "agetor.sqlite"), { readonly: true });
  const restoredSched = restoredDb.query<{ available_from_utc: string | null }, [string]>(
    "SELECT available_from_utc FROM tasks WHERE id = ?",
  ).get(scheduledTask.id)!;
  const restoredNow = restoredDb.query<{ available_from_utc: string | null }, [string]>(
    "SELECT available_from_utc FROM tasks WHERE id = ?",
  ).get(immediateTask.id)!;
  restoredDb.close();
  expect(restoredSched.available_from_utc).toBe(TARGET_ISO);
  expect(restoredNow.available_from_utc).toBeNull();

  // Cross-project mission with globalMax=1: scheduledTask has higher priority ("critical"), immediateTask has "low"
  const plan: MissionPlan = {
    clusters: [],
    projects: [projectA, projectB],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 4 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: [
      {
        taskId: scheduledTask.id,
        taskTitle: scheduledTask.title,
        projectPath: projectA,
        specialistRole: "developer",
        phase: "authorized",
        priority: "critical",
        dependencies: [],
        harnessId: synthetic.harnessId,
        modelId: "gpt-6.1-sol",
        accountId: synthetic.accountId,
        mode: "auto",
        qcRequired: false,
      },
      {
        taskId: immediateTask.id,
        taskTitle: immediateTask.title,
        projectPath: projectB,
        specialistRole: "developer",
        phase: "authorized",
        priority: "low",
        dependencies: [],
        harnessId: synthetic.harnessId,
        modelId: "gpt-6.1-sol",
        accountId: synthetic.accountId,
        mode: "auto",
        qcRequired: false,
      },
    ],
  };
  const m = missionStore.createMission({
    title: "Cross-Project Scheduled Mission",
    goal: "Skip scheduled critical task and run available low task",
    status: "running",
    projects: plan.projects,
    clusters: [],
    plan,
    planDigest: computeMissionPlanDigest(plan),
  });
  missionStore.updateMissionAuthorization(m.id, {
    authorizedAt: Date.now(),
    authorizedBy: "owner",
    digest: m.planDigest,
  });
  const policy = createAutonomyPolicy({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "company",
    projects: [projectA, projectB],
    specialistRoles: ["developer"],
    providers: ["codex"],
    models: ["gpt-6.1-sol"],
    accounts: [synthetic.accountId],
    maxConcurrentWorkers: 4,
    maxLaunches: 10,
    maxDurationMs: 3_000_000,
    expiresAt: Date.now() + 3_000_000,
    permittedActions: ["plan_task", "launch_task"],
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
  missionStore.updateMissionStatus(m.id, "running", "Started for scheduled availability test");

  await missionScheduler.tickMission(m.id);

  // Scheduled critical task is waitingOn "scheduled", holds 0 slot reservations, has 0 runs
  const afterTick = missionStore.getMission(m.id)!;
  const schedEntry = afterTick.plan.tasks.find((t) => t.taskId === scheduledTask.id)!;
  expect(schedEntry.waitingOn).toBe("scheduled");
  expect(store.runs.listForTask(scheduledTask.id)).toHaveLength(0);
  expect(missionStore.listActiveReservations().some((r) => r.taskId === scheduledTask.id)).toBe(false);

  // Immediate lower-priority task was NOT blocked behind scheduledTask and ran!
  await until(() => store.runs.listForTask(immediateTask.id).length > 0, 15_000, "immediate mission task launched");

  // Once the scheduled timestamp arrives, ticking launches the scheduled task too
  fakeNow = TARGET_MS;
  await missionScheduler.tickMission(m.id);
  await until(() => store.runs.listForTask(scheduledTask.id).length > 0, 15_000, "scheduled mission task launched at TARGET_MS");
}, 30_000);
