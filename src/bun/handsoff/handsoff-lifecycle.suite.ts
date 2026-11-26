/**
 * Hands-off project execution, end to end, against disposable Git projects and the fake Codex driver.
 * Real services run: assignment, employee run, task working copy, offline Seatbelt test, QC review, publication
 * and Done. Only the model is a fixture. Runs in its own Bun process (see handsoff.test.ts).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../../shared/task-workspace.ts";
import { DEFAULT_HANDSOFF_POLICY, type HandsoffPolicy } from "../../shared/handsoff.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-handsoff-")));
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
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { emergencyStopAutonomy, clearEmergencyStop } = await import("../autonomy/coordinator.ts");

beforeAll(() => {
  store.harnesses.setEnabled("codex", true);
  employeeRun.initEmployeeExecutionTracking();
  driver.initHandsoff();
});
afterAll(() => {
  driver.stopHandsoffTimers();
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
  writeFileSync(path.join(dir, "src/profile.ts"), `export function displayName(name: string): string {\n  return name;\n}\n`);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]);
  store.projects.upsert(dir, name);
  return realpathSync(dir);
}

function team(projectPath: string) {
  const core = new EmployeeCore(store.db);
  return {
    developer: core.createWorker({ name: "Dana Developer", jobTitle: "Developer", projectPath }),
    reviewer: core.createWorker({ name: "Rae Reviewer", jobTitle: "Reviewer", projectPath }),
  };
}

const PASSING = {
  writes: [
    { path: "src/profile.ts", contents: `export function displayName(name: string): string {\n  const trimmed = name.trim();\n  if (!trimmed) throw new Error("empty name");\n  return trimmed;\n}\n` },
    { path: "src/profile.test.ts", contents: `import { expect, test } from "bun:test";\nimport { displayName } from "./profile.ts";\ntest("rejects an empty display name", () => {\n  expect(() => displayName("   ")).toThrow();\n  expect(displayName(" Ada ")).toBe("Ada");\n});\n` },
  ],
};
const FAILING = {
  writes: [
    { path: "src/profile.ts", contents: `export function displayName(name: string): string {\n  return name;\n}\n` },
    { path: "src/profile.test.ts", contents: `import { expect, test } from "bun:test";\nimport { displayName } from "./profile.ts";\ntest("rejects an empty display name", () => {\n  expect(() => displayName("   ")).toThrow();\n});\n` },
  ],
};

async function makeTask(projectPath: string, payload: unknown = PASSING, extra: Record<string, unknown> = {}, title = "Add validation for an empty display name") {
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
  return created.task.id;
}

function covered(overrides: Partial<HandsoffPolicy> = {}): HandsoffPolicy {
  const view = policyApi.readHandsoffPolicy(currentProject);
  const harnessIds = [...new Set(view.available.map((option) => option.harnessId))];
  const accountIds = [...new Set(view.available.map((option) => option.accountKey))];
  const { resources: _r, ...base } = DEFAULT_HANDSOFF_POLICY;
  return { ...base, enabled: true, autoApply: true, harnessIds, accountIds, ...overrides } as HandsoffPolicy;
}
let currentProject = "";
function enable(projectPath: string, overrides: Partial<HandsoffPolicy> = {}) {
  currentProject = projectPath;
  return policyApi.saveHandsoffPolicy(projectPath, covered(overrides));
}
function setVerdicts(...lines: string[]) { writeFileSync(verdictFile, `${lines.join("\n")}\n`); }

async function until<T>(read: () => T | null | undefined | false, timeoutMs = 20_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as T;
    await Bun.sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const runOf = (taskId: string) => handsoff.handsoffStore.latestRunForTask(taskId)!;
const settledRun = (taskId: string, timeoutMs = 30_000) =>
  until(() => { const run = handsoff.handsoffStore.latestRunForTask(taskId); return run && (run.finishedAt != null || run.status === "needs-owner" || run.status === "stopped" || run.status === "waiting") ? run : null; }, timeoutMs, `run of ${taskId} to settle`);

test("one submission carries an ordinary task to Done with zero later owner actions", async () => {
  const project = await makeProject();
  team(project);
  const view = await enable(project);
  expect(view.workingCopy).toBe(true);
  expect(view.available.length).toBeGreaterThan(0);
  setVerdicts("PASS|The change is correct and tested.");
  const taskId = await makeTask(project);

  const submitted = driver.submitTask(taskId);
  expect(submitted.status).toBe("active");
  const run = await settledRun(taskId);
  expect({ status: run.status, stage: run.stage, blocker: run.blocker?.message }).toEqual({ status: "done", stage: "finished", blocker: undefined });

  // The real diff reached the project folder; the working copy was the only place the Developer wrote.
  expect(readFileSync(path.join(project, "src/profile.ts"), "utf8")).toContain("empty name");
  expect(existsSync(path.join(project, "src/profile.test.ts"))).toBe(true);
  expect(store.tasks.get(taskId)!.column).toBe("done");

  // Honest evidence: the offline test, an independent review bound to the same bytes, the applied paths.
  expect(run.result!.delivery).toBe("applied");
  expect(run.result!.appliedPaths.sort()).toEqual(["src/profile.test.ts", "src/profile.ts"]);
  expect(run.result!.tests.state).toBe("passed");
  expect(run.result!.review).toMatchObject({ verdict: "PASS" });
  expect(run.result!.developer?.employeeName).toBe("Dana Developer");
  const reviews = store.taskQualityReviews.listForTask(taskId);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.implementationRunId).toBe(run.state.developerRunId);

  // Zero owner interactions: nothing pending anywhere for this task, and the history names the policy that acted.
  const events = handsoff.handsoffStore.listEvents({ runId: run.id });
  expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["submitted", "assigned", "developer-started", "developer-finished", "test-finished", "review-started", "review-finished", "applied", "done"]));
  expect(events.every((event) => event.detail.policyRevision === run.policyRevision)).toBe(true);
  expect(events.some((event) => event.kind === "needs-owner")).toBe(false);
  const permissions = await import("../project-permissions.ts");
  expect(permissions.listPendingPermissionRows().filter((row) => row.taskId === taskId)).toEqual([]);
}, 90_000);

const readProject = (project: string, rel: string) => readFileSync(path.join(project, rel), "utf8");
const BASELINE = `export function displayName(name: string): string {\n  return name;\n}\n`;
const runsOf = (taskId: string) => store.runs.listForTask(taskId).filter((run) => !run.qcReviewId);

test("submitting a Backlog task admits that one task and carries it to Done; the other Backlog tasks stay put", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  const submitted = await makeTask(project, PASSING, { column: "backlog" }, "Backlog task the Owner submits");
  const untouched = await makeTask(project, PASSING, { column: "backlog" }, "Other backlog task");
  driver.submitTask(submitted);
  const run = await until(() => { const r = runOf(submitted); return r.status === "done" ? r : null; }, 60_000, "the submitted Backlog task to finish");
  expect(run.status).toBe("done");
  expect(store.tasks.get(submitted)!.column).toBe("done");
  expect(store.tasks.get(untouched)!.column).toBe("backlog");
  expect(runsOf(untouched)).toEqual([]);
}, 120_000);

test("a Reviewer fix request runs one automatic correction; tests and review cover the final revision; nothing is applied early", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("CHANGES_REQUESTED|Also trim the input before validating.", "PASS|Both findings are fixed.");
  const taskId = await makeTask(project);
  const revised = { writes: [...PASSING.writes, { path: "src/extra.ts", contents: `export const REVISION = 2;\n` }] };
  let projectAtFix = null as string | null;
  driver.setHandsoffDepsForTest({
    onFix: (id) => {
      projectAtFix = readProject(project, "src/profile.ts");
      store.tasks.update(id, { prompt: `Add validation for an empty display name\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(revised)}` });
    },
  });
  try {
    driver.submitTask(taskId);
    const run = await settledRun(taskId);
    if (process.env.HANDSOFF_DEBUG) console.log(JSON.stringify({ blocker: run.blocker, round: run.round, events: handsoff.handsoffStore.listEvents({ runId: run.id }).map((e) => `${e.kind}: ${e.message}`) }, null, 1));
    expect(run.status).toBe("done");
    expect(run.round).toBe(1);
    // Round one was reviewed but never applied: the project still held the original bytes when the correction began.
    expect(projectAtFix).toBe(BASELINE);
    expect(existsSync(path.join(project, "src/extra.ts"))).toBe(true);
    // Two Developer runs, two reviews, and the second review judged the second run's bytes.
    const developerRuns = runsOf(taskId);
    expect(developerRuns).toHaveLength(2);
    const reviews = store.taskQualityReviews.listForTask(taskId);
    expect(reviews.map((review) => review.verdict)).toEqual(["CHANGES_REQUESTED", "PASS"]);
    // listForTask is newest first.
    expect(reviews[1]!.implementationRunId).toBe(developerRuns[0]!.id);
    expect(reviews[0]!.implementationRunId).toBe(developerRuns[1]!.id);
    expect(run.state.developerRunId).toBe(developerRuns[0]!.id);
    // The test ran against each revision with its own fingerprint, never a reused pass.
    const permissions = store.db.query<{ source_fingerprint: string; status: string }, [string]>(
      "SELECT source_fingerprint, status FROM project_permission_requests WHERE task_id = ? ORDER BY created_at",
    ).all(taskId);
    expect(permissions.map((row) => row.status)).toEqual(["completed", "completed"]);
    expect(new Set(permissions.map((row) => row.source_fingerprint)).size).toBe(2);
    expect(run.result!.appliedPaths).toContain("src/extra.ts");
    expect(handsoff.handsoffStore.listEvents({ runId: run.id }).filter((event) => event.kind === "fix-started")).toHaveLength(2); // the decision to send back, and the correction launch
  } finally {
    driver.setHandsoffDepsForTest(null);
  }
}, 120_000);

test("with automatic application off the reviewed result waits, the project stays unchanged, and it is not called Done", async () => {
  const project = await makeProject();
  team(project);
  await enable(project, { autoApply: false });
  setVerdicts("PASS|Looks right.");
  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settledRun(taskId);
  expect(run.status).toBe("ready-to-apply");
  expect(run.finishedAt).not.toBeNull();
  expect(readProject(project, "src/profile.ts")).toBe(BASELINE);
  expect(existsSync(path.join(project, "src/profile.test.ts"))).toBe(false);
  expect(run.result!.delivery).toBe("prepared");
  expect(run.result!.appliedPaths).toEqual([]);
  expect(run.result!.review.verdict).toBe("PASS");
  expect(store.tasks.get(taskId)!.column).not.toBe("done");
  // The reviewed working copy is intact for the Owner to inspect and apply with the existing panel.
  const { getTaskWorkspace } = await import("../task-workspace.ts");
  expect(getTaskWorkspace(taskId)!.status).toBe("settled");
  // It is a result, not a question: nothing is waiting on the Owner.
  expect(handsoff.handsoffStore.listOpenRuns(project)).toEqual([]);
}, 90_000);

test("enabling the policy sweeps nothing in; manual mode and refusals keep the existing behavior", async () => {
  const project = await makeProject();
  team(project);
  const earlyBacklog = await makeTask(project, PASSING, { column: "backlog" }, "Old backlog item");
  const earlyReady = await makeTask(project, PASSING, {}, "Old ready item");
  // No policy: a submit is refused and the task is untouched.
  expect(() => driver.submitTask(earlyReady)).toThrow(/off for this project/i);
  await enable(project);
  await Bun.sleep(300);
  for (const sweep of [1, 2]) { void sweep; for (const run of handsoff.handsoffStore.listOpenRuns()) await driver.wake(run.id); }
  expect(handsoff.handsoffStore.listOpenRuns(project)).toEqual([]);
  expect(store.runs.listForTask(earlyReady)).toEqual([]);
  expect(store.runs.listForTask(earlyBacklog)).toEqual([]);
  expect(store.tasks.get(earlyReady)!.column).toBe("ready");
  expect(store.tasks.get(earlyBacklog)!.column).toBe("backlog");
  // Only a task in Backlog or Ready can be submitted; a running or done one cannot.
  store.tasks.update(earlyReady, { column: "done" });
  expect(() => driver.submitTask(earlyReady)).toThrow(/Backlog or Ready/);
  // A second submit of an already submitted task is refused by the unique open-run guard.
  setVerdicts("PASS|ok");
  const first = driver.submitTask(earlyBacklog);
  expect(() => driver.submitTask(earlyBacklog)).toThrow(/already submitted/i);
  expect(handsoff.handsoffStore.listOpenRuns(project).map((run) => run.id)).toEqual([first.id]);
  await settledRun(earlyBacklog);
}, 90_000);

test("a dependent task waits for its prerequisite to be Done while an independent task keeps moving", async () => {
  const project = await makeProject();
  team(project);
  await enable(project, { maxParallel: 2 });
  setVerdicts("BLOCKED|The prerequisite cannot be approved.", "PASS|ok");
  const prerequisite = await makeTask(project, PASSING, {}, "Prerequisite");
  const dependent = await makeTask(project, { writes: [{ path: "src/dependent.ts", contents: "export const dependent = true;\n" }] }, {}, "Dependent");
  const independent = await makeTask(project, { writes: [{ path: "src/independent.ts", contents: "export const independent = true;\n" }] }, {}, "Independent");
  store.taskScheduling.replaceDependencies(dependent, [prerequisite]);
  driver.submitTask(prerequisite);
  driver.submitTask(dependent);
  await Bun.sleep(150);
  driver.submitTask(independent);
  // The prerequisite is blocked by its Reviewer; the independent task still reaches Done; the dependent never starts.
  const blocked = await until(() => { const run = runOf(prerequisite); return run.status === "needs-owner" ? run : null; }, 60_000, "the prerequisite to be blocked");
  expect(blocked.blocker!.code).toBe("review-blocked");
  const free = await until(() => { const run = runOf(independent); return run.status === "done" ? run : null; }, 60_000, "the independent task");
  expect(free.result!.delivery).toBe("applied");
  const waiting = runOf(dependent);
  expect(waiting.status).toBe("waiting");
  expect(waiting.state.waitReason).toMatch(/Prerequisite/);
  expect(store.runs.listForTask(dependent)).toEqual([]);
  expect(existsSync(path.join(project, "src/dependent.ts"))).toBe(false);
}, 120_000);

test("double submission, concurrent ticks and a restart never launch a second Developer or apply twice", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|ok");
  const taskId = await makeTask(project);
  const run = driver.submitTask(taskId);
  expect(() => driver.submitTask(taskId)).toThrow(/already submitted/i);
  // Hammer the driver from every direction while the work is in flight.
  const hammer = setInterval(() => { for (let i = 0; i < 5; i += 1) void driver.wake(run.id); }, 15);
  await until(() => runOf(taskId).stage !== "queued", 20_000, "the Developer to start");
  driver.recoverHandsoff();
  driver.recoverHandsoff();
  const final = await settledRun(taskId);
  clearInterval(hammer);
  expect(final.status).toBe("done");
  expect(runsOf(taskId)).toHaveLength(1);
  expect(store.taskQualityReviews.listForTask(taskId)).toHaveLength(1);
  const events = handsoff.handsoffStore.listEvents({ runId: run.id });
  expect(events.filter((event) => event.kind === "developer-started")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "applied")).toHaveLength(1);
  const { getTaskWorkspace } = await import("../task-workspace.ts");
  expect(getTaskWorkspace(taskId)!.publications).toHaveLength(1);
  expect(store.db.query("SELECT COUNT(*) AS n FROM employee_executions WHERE task_id = ?").get(taskId)).toEqual({ n: 1 });
}, 90_000);

test("a recorded launch intent is reconciled from real state: adopt the run that exists, otherwise start exactly one", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|ok");
  const taskId = await makeTask(project);
  const run = handsoff.handsoffStore.insertRun({ taskId, projectPath: project, policyRevision: policyApi.readHandsoffPolicy(project).revision, policy: policyApi.readHandsoffPolicy(project).policy });
  // The process died after writing the intent and before recording any run: nothing exists, so one launch is safe.
  handsoff.handsoffStore.updateRun(run.id, { state: { ...run.state, launchIntent: { kind: "developer", at: Date.now() }, launchAttempts: 1 } });
  driver.recoverHandsoff();
  const final = await settledRun(taskId);
  expect(final.status).toBe("done");
  expect(runsOf(taskId)).toHaveLength(1);
}, 90_000);

test("a local edit made after the review is never overwritten; the conflict is one visible blocker and a retry applies once the file is clean", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|ok");
  const taskId = await makeTask(project);
  const userEdit = `export function displayName(name: string): string {\n  return name.toUpperCase(); // my own edit\n}\n`;
  let edited = false;
  driver.setHandsoffDepsForTest({
    beforeApply: () => { if (!edited) { edited = true; writeFileSync(path.join(project, "src/profile.ts"), userEdit); } },
  });
  try {
    driver.submitTask(taskId);
    const blocked = await until(() => { const run = runOf(taskId); return run.status === "needs-owner" ? run : null; }, 60_000, "the conflict blocker");
    expect(blocked.blocker!.code).toBe("apply-conflict");
    expect(blocked.blocker!.message).toMatch(/Nothing was overwritten/);
    expect(readProject(project, "src/profile.ts")).toBe(userEdit);
    expect(existsSync(path.join(project, "src/profile.test.ts"))).toBe(false);
    expect(store.tasks.get(taskId)!.column).not.toBe("done");
    expect(handsoff.handsoffStore.listEvents({ runId: blocked.id }).some((event) => event.kind === "applied")).toBe(false);
    // The Owner restores the file; the one action is "look again". It applies exactly once.
    writeFileSync(path.join(project, "src/profile.ts"), BASELINE);
    driver.retryRun(blocked.id);
    const done = await settledRun(taskId);
    expect(done.status).toBe("done");
    expect(readProject(project, "src/profile.ts")).toContain("empty name");
  } finally {
    driver.setHandsoffDepsForTest(null);
  }
}, 120_000);

test("Emergency Stop mid-run starts nothing afterwards and nothing restarts by itself; an explicit resume continues", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|ok");
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "1500";
  try {
    const taskId = await makeTask(project);
    driver.submitTask(taskId);
    const started = await until(() => { const run = runOf(taskId); return run.state.developerRunId ? run : null; }, 20_000, "the Developer to start");
    await emergencyStopAutonomy("test stop");
    await driver.stopHandsoffForEmergency("test stop");
    const stopped = runOf(taskId);
    expect(stopped.status).toBe("stopped");
    expect(store.runs.get(started.state.developerRunId!)!.status).toBe("cancelled");
    // Wait past several sweeps and drive attempts: no follow-up agent, review, retry or application.
    for (let i = 0; i < 6; i += 1) { await driver.wake(stopped.id); await Bun.sleep(150); }
    expect(runsOf(taskId)).toHaveLength(1);
    expect(store.taskQualityReviews.listForTask(taskId)).toEqual([]);
    expect(existsSync(path.join(project, "src/profile.test.ts"))).toBe(false);
    // Lifting the stop does not resume it either.
    clearEmergencyStop();
    driver.recoverHandsoff();
    await Bun.sleep(400);
    expect(runOf(taskId).status).toBe("stopped");
    expect(runsOf(taskId)).toHaveLength(1);
    // Explicit resume is the only way back, and it starts a clean round.
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
    driver.resumeRun(stopped.id);
    const done = await settledRun(taskId, 60_000);
    expect(done.status).toBe("done");
    expect(runsOf(taskId)).toHaveLength(2);
  } finally {
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
    clearEmergencyStop();
  }
}, 120_000);

test("a refused account or an unknown reset is one specific blocker, not a retry loop; a known reset is a quiet wait", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|ok");
  const label = (resetAt: number | null) => ({ role: "developer" as const, accountId: "acct-x", accountLabel: "Work account", resetAt, windows: [] }) as never;
  let calls = 0;
  const unknown = await makeTask(project, PASSING, {}, "Unknown reset");
  driver.setHandsoffDepsForTest({ accountLimit: () => { calls += 1; return label(null); } });
  driver.submitTask(unknown);
  const blocked = await settledRun(unknown);
  expect(blocked.status).toBe("needs-owner");
  expect(blocked.blocker).toMatchObject({ code: "account-limit", action: "open-accounts" });
  const afterFirst = calls;
  for (let i = 0; i < 4; i += 1) { await driver.wake(blocked.id); await Bun.sleep(60); }
  expect(calls).toBe(afterFirst);
  expect(runsOf(unknown)).toEqual([]);
  const known = await makeTask(project, PASSING, {}, "Known reset");
  const resetAt = Date.now() + 90_000;
  driver.setHandsoffDepsForTest({ accountLimit: () => label(resetAt) });
  driver.submitTask(known);
  const waiting = await settledRun(known);
  expect(waiting.status).toBe("waiting");
  expect(waiting.state.waitUntil).toBe(resetAt);
  expect(waiting.blocker).toBeNull();
  expect(runsOf(known)).toEqual([]);
  driver.setHandsoffDepsForTest(null);
  // The Owner picks the unknown one up again: one retry, then it proceeds.
  driver.retryRun(blocked.id);
  expect((await settledRun(unknown, 60_000)).status).toBe("done");
}, 120_000);

test("failing tests are sent back within the bound, and the same failure twice stops with one clear reason", async () => {
  const project = await makeProject();
  team(project);
  await enable(project, { maxFixRounds: 2 });
  setVerdicts("PASS|never reached");
  const taskId = await makeTask(project, FAILING);
  driver.submitTask(taskId);
  const run = await settledRun(taskId, 90_000);
  if (process.env.HANDSOFF_DEBUG) console.log(JSON.stringify({ blocker: run.blocker, round: run.round, events: handsoff.handsoffStore.listEvents({ runId: run.id }).map((e) => `${e.kind}: ${e.message}`) }, null, 1));
  expect(run.status).toBe("needs-owner");
  expect(run.blocker!.code).toBe("no-progress");
  expect(run.blocker!.message).toMatch(/same findings/i);
  expect(run.round).toBe(1);
  expect(runsOf(taskId)).toHaveLength(2);
  expect(store.taskQualityReviews.listForTask(taskId)).toEqual([]);
  expect(readProject(project, "src/profile.ts")).toBe(BASELINE);
  expect(run.state.tests.state).toBe("failed");
  // Exactly one card for the whole blocker.
  expect(handsoff.handsoffStore.listEvents({ runId: run.id }).filter((event) => event.kind === "needs-owner")).toHaveLength(1);
}, 120_000);

test("an unavailable test is never a pass: reported honestly, and a required test stops with one explanation", async () => {
  const observed = await import("../autonomy/observed-test.ts");
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|reviewed without a test", "PASS|unused");
  observed.setPracticalBoundaryFactoryForTest(() => { throw new Error("The Seatbelt boundary could not be built."); });
  try {
    const optional = await makeTask(project, PASSING, {}, "Optional test");
    driver.submitTask(optional);
    const run = await settledRun(optional);
    expect(run.status).toBe("done");
    expect(run.result!.tests.state).toBe("unavailable");
    expect(run.result!.tests.state).not.toBe("passed");
    const strictProject = await makeProject();
    team(strictProject);
    await enable(strictProject, { requireTest: true });
    const required = await makeTask(strictProject, PASSING, {}, "Required test");
    driver.submitTask(required);
    const blocked = await settledRun(required);
    expect(blocked.status).toBe("needs-owner");
    expect(blocked.blocker).toMatchObject({ code: "test-blocked" });
    expect(store.taskQualityReviews.listForTask(required)).toEqual([]);
    expect(existsSync(path.join(strictProject, "src/profile.test.ts"))).toBe(false);
  } finally {
    observed.setPracticalBoundaryFactoryForTest(null);
  }
}, 120_000);

test("a covered-account requirement is enforced: an empty envelope refuses to enable, and an uncovered account is never substituted", async () => {
  const project = await makeProject();
  team(project);
  await expect(policyApi.saveHandsoffPolicy(project, { enabled: true })).rejects.toThrow(/at least one covered/i);
  currentProject = project;
  await policyApi.saveHandsoffPolicy(project, { ...covered(), accountIds: ["some-other-account"] });
  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settledRun(taskId);
  expect(run.status).toBe("needs-owner");
  expect(run.blocker!.code).toBe("no-resource");
  expect(runsOf(taskId)).toEqual([]);
  // Turning the policy off later stops further steps without an Owner card.
  await policyApi.saveHandsoffPolicy(project, { ...covered() });
  driver.retryRun(run.id);
  await policyApi.saveHandsoffPolicy(project, { enabled: false });
  await driver.wake(run.id);
  await Bun.sleep(100);
  expect(runOf(taskId).status).toBe("stopped");
}, 90_000);

test("a task that produces no file change is delivered and Done without a made-up apply step", async () => {
  const project = await makeProject();
  team(project);
  await enable(project);
  setVerdicts("PASS|The answer is correct.");
  const created = await orchestrator.createTask({
    title: "Explain the profile module", prompt: "Explain what src/profile.ts does.", workdir: project, column: "ready",
    agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "worktree", accessMode: "workspace",
  } as never);
  if ("error" in created) throw new Error(created.error);
  driver.submitTask(created.task.id);
  const run = await settledRun(created.task.id);
  expect(run.status).toBe("done");
  expect(run.result!.delivery).toBe("none");
  expect(run.result!.changedFiles).toEqual([]);
  expect(handsoff.handsoffStore.listEvents({ runId: run.id }).some((event) => event.kind === "applied")).toBe(false);
  expect(readProject(project, "src/profile.ts")).toBe(BASELINE);
}, 90_000);
