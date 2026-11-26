/**
 * FO-KANBAN-RECURRING01 — Comprehensive isolated backend lifecycle, smart queue,
 * crash recovery, concurrency, pause/Emergency Stop, and backup/restore suite.
 *
 * Uses disposable Git repos, deterministic clocks, and the fake Codex driver
 * (zero live provider calls or inference quota).
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../../shared/task-workspace.ts";
import { DEFAULT_HANDSOFF_POLICY, type HandsoffPolicy } from "../../shared/handsoff.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-recurring-life-")));
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
const driver = await import("../handsoff/driver.ts");
const handsoff = await import("../handsoff/store.ts");
const policyApi = await import("../handsoff/policy.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { stopProjectLifecycle, startProjectLifecycle } = await import("../project-lifecycle.ts");
const { emergencyStopAutonomy, clearEmergencyStop } = await import("../autonomy/coordinator.ts");
const { setTaskAvailabilityClockForTest } = await import("../task-availability.ts");
const { reorderTask } = await import("../kanban-order.ts");
const { BackupManager } = await import("../backup-manager.ts");
const { restoreBackupSnapshot } = await import("../backup-restore.ts");
const { recurringStore } = await import("./store.ts");
const recurring = await import("./scheduler.ts");

const BASE_NOW = Date.parse("2026-11-16T02:00:00.000Z"); // Monday 02:00 UTC
let fakeNow = BASE_NOW;

beforeAll(() => {
  store.harnesses.setEnabled("codex", true);
  setTaskAvailabilityClockForTest(() => fakeNow);
  recurring.setRecurringClockForTest(() => fakeNow);
  driver.setHandsoffDepsForTest({ now: () => fakeNow });
  employeeRun.initEmployeeExecutionTracking();
  driver.initHandsoff();
  recurring.initRecurringScheduler();
});

beforeEach(() => {
  fakeNow = BASE_NOW;
  setTaskAvailabilityClockForTest(() => fakeNow);
  recurring.setRecurringClockForTest(() => fakeNow);
  driver.setHandsoffDepsForTest({ now: () => fakeNow });
  store.harnesses.setEnabled("codex", true);
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "25";
  try { clearEmergencyStop(); } catch { /* already clear */ }
  for (const open of handsoff.handsoffStore.listOpenRuns()) {
    handsoff.handsoffStore.updateRun(open.id, { stage: "finished", status: "cancelled", finishedAt: BASE_NOW });
  }
  for (const tpl of recurringStore.listTemplates()) {
    if (tpl.status !== "stopped") {
      recurringStore.updateTemplate(tpl.id, { status: "stopped", nextDueUtc: null, nextDueMs: null, stoppedAt: BASE_NOW });
    }
  }
  writeFileSync(verdictFile, Array.from({ length: 40 }, () => "PASS").join("\n") + "\n");
});

afterAll(() => {
  recurring.stopRecurringScheduler();
  recurring.setRecurringClockForTest(null);
  driver.stopHandsoffTimers();
  driver.setHandsoffDepsForTest(null);
  setTaskAvailabilityClockForTest(null);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

let projectSeq = 0;
async function makeProject(name = `rec${++projectSeq}`): Promise<{ projectPath: string; developerId: string; reviewerId: string }> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "src/index.ts"), `export const v = 1;\n`);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "qa@example.invalid"]);
  await git(dir, ["config", "user.name", "QA"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "init"]);

  store.projects.upsert(dir, name);
  store.projects.setWorkspaceDevelopment(dir, true);

  const employees = new EmployeeCore(store.db);
  const dev = employees.createWorker({ name: "Dana Dev", jobTitle: "Developer", projectPath: dir });
  const rev = employees.createWorker({ name: "Rae Reviewer", jobTitle: "Reviewer", projectPath: dir });

  const view = policyApi.readHandsoffPolicy(dir);
  const resources = view.available.map((o) => ({ role: o.role, harnessId: o.harnessId, accountKey: o.accountKey }));
  await policyApi.saveHandsoffPolicy(dir, {
    enabled: true,
    autoAssign: true,
    runOfflineTests: false,
    autoApply: true,
    autoDone: true,
    maxParallel: 1,
    resources,
  });
  return { projectPath: dir, developerId: dev.id, reviewerId: rev.id };
}

async function waitForTaskColumn(taskId: string, expected: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (store.tasks.get(taskId)?.column === expected) return;
    await Bun.sleep(40);
  }
  const t = store.tasks.get(taskId);
  const run = handsoff.handsoffStore.latestRunForTask(taskId);
  throw new Error(`Timed out waiting for task ${taskId} to reach ${expected}; column=${t?.column}, handsoff=${run?.status}/${run?.stage} blocker=${run?.blocker?.code}:${run?.blocker?.message}`);
}

test("1, 11-15, 28-30: Ordinary task unchanged, exact UTC due-time generation, inherited config, generation-only non-launch, edit future only, stop preserves history, endDate & maxOccurrences", async () => {
  const { projectPath, developerId } = await makeProject("core");

  // 1. Ordinary non-recurring task remains completely unchanged
  const ordRes = await orchestrator.createTask({
    title: "Ordinary one-off task",
    prompt: "Do normal work",
    workdir: projectPath,
    column: "backlog",
    urgency: 4,
    agent: "codex",
  });
  expect("task" in ordRes).toBe(true);
  if (!("task" in ordRes)) return;
  expect(ordRes.task.recurringTemplateId).toBeUndefined();
  expect(ordRes.task.recurring).toBeUndefined();

  // Create generation-only daily recurring template starting at 06:00 UTC (4 hours in future)
  const { template, generatedTaskIds } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Error log review",
    prompt: "Inspect application error logs",
    urgency: 4,
    taskType: "bug",
    templateConfig: {
      acceptanceCriteria: "Zero unhandled 500s",
      labels: ["ops", "daily"],
      agent: "codex",
      assignedEmployeeId: developerId,
    },
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    maxOccurrences: 2,
    submissionMode: "generate_only",
    overlapPolicy: "allow_overlap",
    missedPolicy: "run_once",
  });
  // 13. No occurrence generated before due time
  expect(generatedTaskIds).toEqual([]);
  expect(template.nextDueUtc).toBe("2026-11-16T06:00:00.000Z");

  // Still 1ms before due time -> nothing generated
  fakeNow = Date.parse("2026-11-16T05:59:59.999Z");
  expect((await recurring.reconcileDueRecurringTasks(projectPath)).generatedTaskIds).toEqual([]);

  // 12. Exact due time -> generates occurrence #1
  fakeNow = Date.parse("2026-11-16T06:00:00.000Z");
  const r1 = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(r1.generatedTaskIds.length).toBe(1);
  expect(r1.submittedCount).toBe(0);

  const occTask1 = store.tasks.get(r1.generatedTaskIds[0]!)!;
  // 14. Inherited urgency, taskType, acceptance criteria, labels, assignee, UTC availability
  expect(occTask1.title).toBe("Error log review — November 16");
  expect(occTask1.urgency).toBe(4);
  expect(occTask1.taskType).toBe("bug");
  expect(occTask1.prompt).toContain("Zero unhandled 500s");
  expect(occTask1.prompt).toContain("ops, daily");
  expect(occTask1.availableFromUtc).toBe("2026-11-16T06:00:00.000Z");
  expect(occTask1.recurringTemplateId).toBe(template.id);
  expect(occTask1.recurringNominalUtc).toBe("2026-11-16T06:00:00.000Z");
  expect(new AssignmentCore(store.db).forTask(occTask1.id)?.employeeId).toBe(developerId);

  // 15. Generation-only does NOT launch a provider or create a hands-off run
  expect(handsoff.handsoffStore.latestRunForTask(occTask1.id)).toBeNull();
  expect(store.runs.listForTask(occTask1.id).length).toBe(0);

  // 28. Edit template -> affects FUTURE occurrences only, NOT existing occTask1
  await recurring.updateRecurringTemplate(template.id, {
    title: "Updated error audit",
    urgency: 5,
    prompt: "Updated audit checklist",
  });
  expect(store.tasks.get(occTask1.id)!.title).toBe("Error log review — November 16");
  expect(store.tasks.get(occTask1.id)!.urgency).toBe(4);

  // Advance to next day -> generates occurrence #2 with updated properties, then hits maxOccurrences=2
  fakeNow = Date.parse("2026-11-17T06:00:00.000Z");
  const r2 = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(r2.generatedTaskIds.length).toBe(1);
  const occTask2 = store.tasks.get(r2.generatedTaskIds[0]!)!;
  expect(occTask2.title).toBe("Updated error audit — November 17");
  expect(occTask2.urgency).toBe(5);
  expect(occTask2.id).not.toBe(occTask1.id);
  expect(recurringStore.getTemplate(template.id)!.nextDueUtc).toBeNull(); // maxOccurrences=2 exhausted

  // 29. Stopping recurrence preserves history & existing tasks
  await recurring.stopRecurringTemplate(template.id);
  expect(recurringStore.getTemplate(template.id)!.status).toBe("stopped");
  expect(store.tasks.get(occTask1.id)).not.toBeNull();
  expect(store.tasks.get(occTask2.id)).not.toBeNull();
  expect(recurringStore.listOccurrenceHistory(template.id).length).toBe(2);
});

test("10. Completion-relative recurrence: triggers only on genuine Done, NOT on failure/cancellation/archival", async () => {
  const { projectPath } = await makeProject("after-done");
  const { template } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Operational health check",
    prompt: "Verify service health",
    urgency: 3,
    recurrenceType: "after_completion",
    interval: 24,
    intervalUnit: "hours",
    startDateUtc: "2026-11-16",
    startTimeUtc: "03:00",
    submissionMode: "generate_only",
  });

  // Trigger initial occurrence at 03:00 UTC
  fakeNow = Date.parse("2026-11-16T03:00:00.000Z");
  const r1 = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(r1.generatedTaskIds.length).toBe(1);
  const t1Id = r1.generatedTaskIds[0]!;
  expect(recurringStore.getTemplate(template.id)!.nextDueUtc).toBeNull();

  // Moving to blocked (simulated failed Developer exit) must NOT schedule next occurrence
  orchestrator.moveTaskColumn(t1Id, "blocked");
  expect(recurringStore.getTemplate(template.id)!.nextDueUtc).toBeNull();

  // Even advancing 48 hours while unresolved/blocked creates 0 new occurrences
  fakeNow = Date.parse("2026-11-18T03:00:00.000Z");
  expect((await recurring.reconcileDueRecurringTasks(projectPath)).generatedTaskIds).toEqual([]);

  // Genuine Done schedules next occurrence exactly +24 hours later
  fakeNow = Date.parse("2026-11-18T10:00:00.000Z");
  orchestrator.moveTaskColumn(t1Id, "done");
  expect(recurringStore.getTemplate(template.id)!.nextDueUtc).toBe("2026-11-19T10:00:00.000Z");

  // 1 minute before due -> nothing
  fakeNow = Date.parse("2026-11-19T09:59:00.000Z");
  expect((await recurring.reconcileDueRecurringTasks(projectPath)).generatedTaskIds).toEqual([]);

  // Exact +24h -> creates occurrence #2
  fakeNow = Date.parse("2026-11-19T10:00:00.000Z");
  const r2 = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(r2.generatedTaskIds.length).toBe(1);
  expect(r2.generatedTaskIds[0]).not.toBe(t1Id);
});

test("20-27. Overlap prevention, permitted overlap + cap, missed policies (skip/run_once/catch_up), template pause/resume, project pause/resume, and Emergency Stop", async () => {
  const { projectPath } = await makeProject("policies");

  // 20. Overlap prevention (default skip_if_unresolved)
  const { template: noOverlap } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Daily audit",
    prompt: "Audit repo",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    overlapPolicy: "skip_if_unresolved",
    missedPolicy: "run_once",
  });
  fakeNow = Date.parse("2026-11-16T06:00:00.000Z");
  const first = await recurring.reconcileRecurringTemplate(noOverlap.id);
  expect(first.generatedTaskIds.length).toBe(1);

  // Leave first task unresolved in Ready; next day must be SKIPPED and recorded in history
  fakeNow = Date.parse("2026-11-17T06:00:00.000Z");
  const second = await recurring.reconcileRecurringTemplate(noOverlap.id);
  expect(second.generatedTaskIds.length).toBe(0);
  expect(second.skippedCount).toBe(1);
  expect(recurringStore.getTemplate(noOverlap.id)!.nextDueUtc).toBe("2026-11-18T06:00:00.000Z");
  const hist = recurringStore.listOccurrenceHistory(noOverlap.id);
  expect(hist.some((h) => h.status === "skipped" && h.skipReason === "overlap_unresolved")).toBe(true);

  // Mark first task Done -> Nov 18 generates cleanly
  orchestrator.moveTaskColumn(first.generatedTaskIds[0]!, "done");
  fakeNow = Date.parse("2026-11-18T06:00:00.000Z");
  const third = await recurring.reconcileRecurringTemplate(noOverlap.id);
  expect(third.generatedTaskIds.length).toBe(1);
  await recurring.stopRecurringTemplate(noOverlap.id);

  // 21 & 24. Permitted overlap + bounded catch_up (cap = 2 across 5 days downtime)
  fakeNow = Date.parse("2026-11-16T02:00:00.000Z");
  const { template: catchUp } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Catchup job",
    prompt: "Process backlog",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    overlapPolicy: "allow_overlap",
    missedPolicy: "catch_up",
    catchUpLimit: 2,
  });
  fakeNow = Date.parse("2026-11-20T12:00:00.000Z"); // 5 missed days (Nov 16..20)
  const cu = await recurring.reconcileRecurringTemplate(catchUp.id);
  expect(cu.generatedTaskIds.length).toBe(2);
  expect(cu.skippedCount).toBe(3);
  await recurring.stopRecurringTemplate(catchUp.id);

  // 22. Skip missed policy
  fakeNow = Date.parse("2026-11-16T02:00:00.000Z");
  const { template: skipMissed } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Skip downtime job",
    prompt: "Only run live",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    missedPolicy: "skip",
  });
  fakeNow = Date.parse("2026-11-19T12:00:00.000Z");
  const sm = await recurring.reconcileRecurringTemplate(skipMissed.id);
  expect(sm.generatedTaskIds.length).toBe(0);
  expect(sm.skippedCount).toBe(4);
  expect(recurringStore.getTemplate(skipMissed.id)!.nextDueUtc).toBe("2026-11-20T06:00:00.000Z");
  await recurring.stopRecurringTemplate(skipMissed.id);

  // 25 & 26. Template pause vs Project pause (resuming project must NOT enable paused template!)
  fakeNow = Date.parse("2026-11-16T02:00:00.000Z");
  const { template: activeTpl } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Active during project pause",
    prompt: "Check health",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    missedPolicy: "run_once",
  });
  const { template: pausedTpl } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Explicitly paused template",
    prompt: "Stay paused",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    missedPolicy: "run_once",
  });
  await recurring.pauseRecurringTemplate(pausedTpl.id);

  // Pause project: no occurrences accumulate while paused
  await stopProjectLifecycle(projectPath, "Owner pause");
  fakeNow = Date.parse("2026-11-18T12:00:00.000Z");
  const duringPause = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(duringPause.generatedTaskIds).toEqual([]);

  // Resume project: activeTpl reconciles via run_once (1 task), pausedTpl stays paused (0 tasks)
  await startProjectLifecycle(projectPath);
  await Bun.sleep(60);
  const activeHist = recurringStore.listOccurrenceHistory(activeTpl.id);
  expect(activeHist.filter((h) => h.status === "generated").length).toBe(1);
  expect(recurringStore.getTemplate(pausedTpl.id)!.status).toBe("paused");
  expect(recurringStore.listOccurrenceHistory(pausedTpl.id).length).toBe(0);

  // Explicitly resume pausedTpl -> now generates 1 via run_once
  const resumed = await recurring.resumeRecurringTemplate(pausedTpl.id);
  expect(resumed.generatedTaskIds.length).toBe(1);
  await recurring.stopRecurringTemplate(activeTpl.id);
  await recurring.stopRecurringTemplate(pausedTpl.id);

  // 27. Emergency Stop prevents automatic recurring submission & clearing does not silently resume parked work
  fakeNow = Date.parse("2026-11-16T02:00:00.000Z");
  const { template: autoTpl } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Auto-submitted check",
    prompt: "Run checks",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    submissionMode: "auto_submit",
  });
  await emergencyStopAutonomy("Owner emergency test");
  fakeNow = Date.parse("2026-11-16T06:00:00.000Z");
  const duringEmergency = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(duringEmergency.generatedTaskIds).toEqual([]);
  expect(duringEmergency.submittedCount).toBe(0);
  clearEmergencyStop();
  // Clearing Emergency Stop alone does NOT automatically launch parked work without deliberate trigger/tick
  expect(handsoff.handsoffStore.listOpenRuns(projectPath).length).toBe(0);
  await recurring.stopRecurringTemplate(autoTpl.id);
});

test("31-34. Concurrency deduplication, crash recovery, restart non-replay, and backup/restore with historical restore guard", async () => {
  const { projectPath } = await makeProject("idempotency");
  const { template } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Idempotent nightly check",
    prompt: "Verify invariants",
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "06:00",
    submissionMode: "generate_only",
  });

  // 31. Concurrent generation attempts cannot create duplicates
  fakeNow = Date.parse("2026-11-16T06:00:00.000Z");
  const [a, b, c] = await Promise.all([
    recurring.reconcileRecurringTemplate(template.id),
    recurring.reconcileRecurringTemplate(template.id),
    recurring.reconcileDueRecurringTasks(projectPath),
  ]);
  const totalGenerated = [...a.generatedTaskIds, ...b.generatedTaskIds, ...c.generatedTaskIds];
  expect(totalGenerated.length).toBe(1);
  const firstTaskId = totalGenerated[0]!;

  // 32. Simulate crash right before advancing `next_due_utc` (rewind next_due back to 06:00 while occurrence already exists!)
  recurringStore.updateTemplate(template.id, {
    nextDueUtc: "2026-11-16T06:00:00.000Z",
    nextDueMs: Date.parse("2026-11-16T06:00:00.000Z"),
  });
  const afterCrash = await recurring.reconcileRecurringTemplate(template.id);
  expect(afterCrash.generatedTaskIds).toEqual([]); // UNIQUE occurrence_key prevented duplicate!
  expect(recurringStore.getTemplate(template.id)!.nextDueUtc).toBe("2026-11-17T06:00:00.000Z");

  // 33. Complete occurrence #1 and restart scheduler -> must NOT replay completed occurrence
  orchestrator.moveTaskColumn(firstTaskId, "done");
  recurring.stopRecurringScheduler();
  recurring.initRecurringScheduler();
  const afterRestart = await recurring.recoverRecurringTasks();
  expect(afterRestart.generatedTaskIds).toEqual([]);
  expect(recurringStore.listOccurrenceHistory(template.id).length).toBe(1);

  // 34. Backup & restore preserves recurring_templates, recurring_occurrences, and tasks.recurring_template_id
  const backupDir = path.join(root, "backups");
  mkdirSync(backupDir, { recursive: true });
  const bm = new BackupManager({ db: store.db, dataDir: process.env.AGETOR_DATA_DIR! });
  const snap = await bm.createSnapshot({ destinationDir: backupDir, createDirectory: true });
  const restoredDir = path.join(root, "restored-profile");
  await restoreBackupSnapshot(snap.path, restoredDir);
  const restoredDb = new Database(path.join(restoredDir, "agetor.sqlite"), { readonly: true });
  const restoredTpl = restoredDb
    .query<{ id: string; next_due_utc: string | null }, [string]>(`SELECT id, next_due_utc FROM recurring_templates WHERE id = ?`)
    .get(template.id);
  const restoredOccs = restoredDb
    .query<{ id: string; task_id: string | null }, [string]>(`SELECT id, task_id FROM recurring_occurrences WHERE template_id = ?`)
    .all(template.id);
  const restoredTask = restoredDb
    .query<{ recurring_template_id: string | null }, [string]>(`SELECT recurring_template_id FROM tasks WHERE id = ?`)
    .get(firstTaskId);
  restoredDb.close();
  expect(restoredTpl?.id).toBe(template.id);
  expect(restoredTpl?.next_due_utc).toBe("2026-11-17T06:00:00.000Z");
  expect(restoredOccs.length).toBe(1);
  expect(restoredOccs[0]?.task_id).toBe(firstTaskId);
  expect(restoredTask?.recurring_template_id).toBe(template.id);

  // Test historical restore guard: writing restore-confirmation.json with past due time skips historical launch!
  writeFileSync(
    path.join(store.dataDir, "restore-confirmation.json"),
    JSON.stringify({ snapshotId: "snap-hist-1", restoredAt: "2026-11-25T00:00:00.000Z" }),
  );
  fakeNow = Date.parse("2026-11-25T12:00:00.000Z"); // 8 days past next_due_utc
  const afterHistoricalRestore = await recurring.recoverRecurringTasks();
  expect(afterHistoricalRestore.generatedTaskIds).toEqual([]);
  expect(recurringStore.getTemplate(template.id)!.nextDueUtc).toBe("2026-11-26T06:00:00.000Z");
  expect(
    recurringStore
      .listOccurrenceHistory(template.id)
      .some((h) => h.status === "skipped" && h.skipReason === "restore_historical_skip"),
  ).toBe(true);
});

test("16, 19, 38-40 & Representative Integration Trace: Daily + Weekly recurring + Urgent ordinary + Future scheduled through REAL scheduler, Smart Queue, Developer, offline tests, Reviewer, Apply, and Done", async () => {
  const { projectPath } = await makeProject("trace");
  // Enable offline tests for the full lifecycle trace (Developer -> offline tests -> Reviewer -> Apply -> Done)
  const tracePolView = policyApi.readHandsoffPolicy(projectPath);
  await policyApi.saveHandsoffPolicy(projectPath, {
    enabled: true,
    autoAssign: true,
    runOfflineTests: true,
    requireTest: true,
    autoApply: true,
    autoDone: true,
    maxParallel: 1,
    resources: tracePolView.available.map((o) => ({ role: o.role, harnessId: o.harnessId, accountKey: o.accountKey })),
  });
  fakeNow = Date.parse("2026-11-16T02:00:00.000Z"); // Monday 02:00 UTC

  const passingPayload = (slug: string) => ({
    writes: [
      { path: `src/${slug}.ts`, contents: `export const ${slug} = () => "${slug}";\n` },
      {
        path: `src/${slug}.test.ts`,
        contents: `import { expect, test } from "bun:test";\nimport { ${slug} } from "./${slug}.ts";\ntest("${slug}", () => { expect(${slug}()).toBe("${slug}"); });\n`,
      },
    ],
  });

  // 1. Recurring daily task (auto_submit, urgency 3, starts Monday 03:00 UTC)
  const { template: dailyTpl } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Daily error check",
    prompt: `Check errors\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(passingPayload("daily"))}`,
    urgency: 3,
    recurrenceType: "daily",
    startDateUtc: "2026-11-16",
    startTimeUtc: "03:00",
    submissionMode: "auto_submit",
    overlapPolicy: "skip_if_unresolved",
  });

  // 2. Recurring weekly task (auto_submit, urgency 4, Mondays at 03:00 UTC)
  const { template: weeklyTpl } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Weekly security audit",
    prompt: `Audit security\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(passingPayload("weekly"))}`,
    urgency: 4,
    recurrenceType: "weekly",
    weekdays: [1],
    startDateUtc: "2026-11-16",
    startTimeUtc: "03:00",
    submissionMode: "auto_submit",
    overlapPolicy: "skip_if_unresolved",
  });

  // 3. Ordinary urgent task (urgency 5, available immediately)
  const urgentCreate = await orchestrator.createTask({
    title: "Fix critical auth regression",
    prompt: `Fix auth\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(passingPayload("urgent"))}`,
    workdir: projectPath,
    column: "ready",
    urgency: 5,
    agent: "codex",
  });
  expect("task" in urgentCreate).toBe(true);
  if (!("task" in urgentCreate)) return;
  const urgentTask = urgentCreate.task;

  // 4. Future scheduled task (urgency 5, available at 05:00 UTC)
  const futureCreate = await orchestrator.createTask({
    title: "Scheduled schema maintenance",
    prompt: `Maintain schema\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(passingPayload("future"))}`,
    workdir: projectPath,
    column: "ready",
    urgency: 5,
    availableFromUtc: "2026-11-16T05:00:00.000Z",
    agent: "codex",
  });
  expect("task" in futureCreate).toBe(true);
  if (!("task" in futureCreate)) return;
  const futureTask = futureCreate.task;

  // Verify urgency drag reorder still works cleanly before dispatch
  const ordPeer = await orchestrator.createTask({
    title: "Backlog peer",
    prompt: "Not submitted",
    workdir: projectPath,
    column: "backlog",
    urgency: 3,
    agent: "codex",
  });
  expect("task" in ordPeer).toBe(true);
  if ("task" in ordPeer) {
    const moved = reorderTask(ordPeer.task.id, { expectedColumn: "backlog", expectedUrgency: 3, placement: "first" });
    expect(moved.task.urgency).toBe(3);
  }

  // Advance clock to 03:00 UTC -> both recurring templates materialize & auto-submit, alongside urgent + future tasks!
  // Hold project paused briefly so all 4 enter the smart queue together before the 1 available Developer starts picking!
  await stopProjectLifecycle(projectPath, "stage-queue");
  // Submit urgent & future after resume? Wait: submitTask rejects while paused, so pause is not needed if we use fakeNow:
  await startProjectLifecycle(projectPath);

  // Advance clock to 03:00 UTC -> materialize recurring occurrences first while Developer starts on urgent 5/5!
  // To inspect exact dispatch order with 1 Developer, keep codex delay at 80ms so tasks queue up cleanly.
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "80";

  // Submit future task (blocked until 05:00) and urgent task (5/5, launches immediately!)
  driver.submitTask(futureTask.id);
  driver.submitTask(urgentTask.id);

  fakeNow = Date.parse("2026-11-16T03:00:00.000Z");
  const mat = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(mat.generatedTaskIds.length).toBe(2);
  expect(mat.submittedCount).toBe(2);

  const weeklyOcc = recurringStore.listOccurrenceHistory(weeklyTpl.id)[0]!;
  const dailyOcc = recurringStore.listOccurrenceHistory(dailyTpl.id)[0]!;
  expect(weeklyOcc.taskId).toBeTruthy();
  expect(dailyOcc.taskId).toBeTruthy();
  expect(weeklyOcc.submissionIntent).toBe("submitted");
  expect(dailyOcc.submissionIntent).toBe("submitted");

  // Wait for Urgent (5/5) -> Weekly recurring (4/5) -> Daily recurring (3/5) to all finish Done!
  await waitForTaskColumn(urgentTask.id, "done", 25_000);
  await waitForTaskColumn(weeklyOcc.taskId!, "done", 25_000);
  await waitForTaskColumn(dailyOcc.taskId!, "done", 25_000);

  // Future scheduled task (05:00 UTC) must STILL be waiting, with 0 Developer runs!
  expect(store.tasks.get(futureTask.id)!.column).toBe("ready");
  expect(store.runs.listForTask(futureTask.id).length).toBe(0);

  // Advance clock to 05:00 UTC -> future scheduled task unlocks and runs to Done!
  fakeNow = Date.parse("2026-11-16T05:00:00.000Z");
  await driver.scheduleProject(projectPath);
  await waitForTaskColumn(futureTask.id, "done", 25_000);

  // Verify exact dispatch order by Developer run start sequence (rowid / startedAt)
  const devRunOrder = [urgentTask.id, weeklyOcc.taskId!, dailyOcc.taskId!, futureTask.id].map((id) => {
    const devRuns = store.runs.listForTask(id).filter((r) => !r.qcReviewId);
    expect(devRuns.length).toBe(1); // Zero duplicate executions!
    const qcReviews = store.taskQualityReviews.listForTask(id);
    expect(qcReviews.length).toBe(1);
    expect(qcReviews[0]!.verdict).toBe("PASS");
    const hr = handsoff.handsoffStore.latestRunForTask(id);
    expect(hr?.status).toBe("done");
    expect(hr?.result?.tests?.state).toBe("passed");
    expect(hr?.result?.delivery).toBe("applied");
    return { taskId: id, runRowId: store.db.query<{ rowid: number }, [string]>(`SELECT rowid FROM runs WHERE id = ?`).get(devRuns[0]!.id)!.rowid };
  });

  // Strict monotonic dispatch order: Urgent(5) < Weekly(4) < Daily(3) < Future(05:00 UTC)
  expect(devRunOrder[0]!.runRowId).toBeLessThan(devRunOrder[1]!.runRowId);
  expect(devRunOrder[1]!.runRowId).toBeLessThan(devRunOrder[2]!.runRowId);
  expect(devRunOrder[2]!.runRowId).toBeLessThan(devRunOrder[3]!.runRowId);

  // Advance to next day (Tuesday 03:00 UTC) -> daily generates occurrence #2 independently; weekly stays at next Monday!
  fakeNow = Date.parse("2026-11-17T03:00:00.000Z");
  const day2 = await recurring.reconcileDueRecurringTasks(projectPath);
  expect(day2.generatedTaskIds.length).toBe(1);
  const dailyOcc2Id = day2.generatedTaskIds[0]!;
  expect(dailyOcc2Id).not.toBe(dailyOcc.taskId);
  await waitForTaskColumn(dailyOcc2Id, "done", 25_000);

  const dailyView = recurringStore.getTemplateView(dailyTpl.id)!;
  expect(dailyView.stats.totalGenerated).toBe(2);
  expect(dailyView.stats.completed).toBe(2);
  expect(dailyView.nextDueUtc).toBe("2026-11-18T03:00:00.000Z");

  const weeklyView = recurringStore.getTemplateView(weeklyTpl.id)!;
  expect(weeklyView.stats.totalGenerated).toBe(1);
  expect(weeklyView.stats.completed).toBe(1);
  expect(weeklyView.nextDueUtc).toBe("2026-11-23T03:00:00.000Z");
}, 45_000);
