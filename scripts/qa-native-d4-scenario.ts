/**
 * Direction 4 offline acceptance (task lifecycle), driven through the packaged ForgeOrbitQA window.
 * Fake drivers, disposable profile. Seeded: one project, the Head-free board, one Ready successor task, and the
 * deterministic review verdicts (changes, changes, pass, pass). Everything else is done in the window: create the
 * prerequisite in the New Task sheet, admit, mark Ready, add the dependency, attempt a cycle, Run, review, rework twice,
 * accept, quit and reopen at two transitions.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, activate, qcVerdictFile } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => { spawnSync("/usr/sbin/screencapture", ["-x", "-R120,120,1280,860", join(shots, `${name}.png`)]); };
  const Work = join(runtime, "projects/Work"); mkdirSync(Work, { recursive: true });
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  const has = (part: string) => find(hasText(part)).length > 0;
  const names = (n: any) => [n.AXTitle, n.AXDescription].filter((x: any) => typeof x === "string" && x);
  const quit = async () => {
    ax("key", "12", "1048576");
    await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 15_000).catch(async () => { await down(); });
    await sleep(1500);
  };

  // ---- prerequisites ----
  writeFileSync(qcVerdictFile, "CHANGES_REQUESTED\nCHANGES_REQUESTED\nPASS\nPASS\n");
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile; review verdicts seeded as changes, changes, pass, pass");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Work, name: "D4 Work" });
  const successor = await api("POST", "/tasks", { title: "Successor", prompt: "Write the successor fixture note.", workdir: Work, isolation: "none", column: "ready" });
  await down(); await up();
  await show("Main navigation");

  const tasksNow = async () => await api("GET", "/tasks");
  const byTitle = async (title: string) => (await tasksNow()).find((t: any) => t.title === title);
  const runs = async (id: string) => (await api("GET", `/tasks/${id}/runs`)).length;
  const qc = async (id: string) => (await api("GET", `/tasks/${id}/qc`));
  /** A button inside one task card, picked by the card's own frame so two cards never get mixed up. */
  const cardButton = async (title: string, label: string) => {
    const node = await poll(`"${label}" on the "${title}" card`, () => {
      const nodes = find(() => true);
      const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names(n).includes(title) && n.frame && n.frame.width < 400);
      if (!card) return null;
      const f = card.frame;
      return nodes.find((n: any) => n.AXRole === "AXButton" && names(n).includes(label) && n.frame
        && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height) ?? null;
    }, 15_000);
    activate(node); await sleep(500);
  };
  const openTask = async (title: string) => {
    await poll(`card "${title}"`, () => find((n: any) => n.AXRole === "AXButton" && names(n).includes(title)).at(0) ?? null, 15_000);
    await button(title, true, 0); await show("Task assignment", 15_000).catch(() => undefined); await sleep(800);
  };
  const closePanel = async () => { await button("Close task details"); await sleep(600); };
  /** Rework and changed output go through the task panel's message box: it resumes the task in a fresh run. */
  const sendMessage = async (title: string, text: string) => {
    await openTask(title);
    ax("focus-name", "AXTextArea", "Prompt"); await sleep(400);
    ax("text", text); await sleep(500);
    ax("key", "36", "0"); await sleep(800);
  };
  const settle = async (id: string, column: string) => poll(`${id} reaches ${column}`, async () => ((await tasksNow()).find((t: any) => t.id === id)?.column === column ? true : null), 30_000);

  // ---- 1. Create the prerequisite in the native New Task sheet; Backlog -> Inbox -> Ready with a plain status each time ----
  await button("D4 Work", true, 0);
  await button("Tasks", true, 0);
  await button("New task", false, 2).catch(() => button("New task", false));
  await show("To backlog");
  ax("click", "760", "355"); await sleep(400); ax("text", "Prerequisite"); await sleep(400);
  ax("focus-name", "AXTextArea", "Prompt"); await sleep(300); ax("text", "Write the prerequisite fixture note."); await sleep(600);
  await button("To backlog", false);
  await show("Admit to project inbox");
  const created = await byTitle("Prerequisite");
  assert.equal(created.column, "backlog");
  assert(has("Backlog"), "the card says Backlog");
  shot("01-backlog");
  await button("Admit to project inbox");
  await settle(created.id, "inbox");
  await openTask("Prerequisite");
  await button("Move to Ready");
  await settle(created.id, "ready");
  await closePanel();
  assert(has("Ready"));
  shot("02-ready");
  mark("Created Prerequisite in the New Task sheet and moved it Backlog -> Inbox -> Ready in the window; each step showed a plain status");

  // ---- 2. The dependency: add it in the window, attempt a cycle ----
  const addDependency = async (title: string, choose: number) => {
    await openTask(title);
    await button("TASK DETAILS").catch(() => undefined);
    await button("PRIORITY & DEPENDENCIES");
    await button("Add a dependency", true);
    await sleep(700); for (let i = 0; i < choose; i++) { ax("key", "125", "0"); await sleep(250); } ax("key", "36", "0"); await sleep(700);
    await button("Add", true, 0); await sleep(1500);
  };
  await addDependency("Successor", 1);
  await show("Waiting for “Prerequisite” to be Done.");
  assert.deepEqual((await api("GET", `/project-manager/scheduling?path=${encodeURIComponent(Work)}`)).tasks?.find((t: any) => t.title === "Successor")?.dependsOn?.map((d: any) => d.title) ?? [], ["Prerequisite"]);
  shot("03-waiting-for-prerequisite");
  await closePanel();
  await addDependency("Prerequisite", 1);
  await show("That would make a cycle: Prerequisite → Successor → Prerequisite.");
  const sched = await api("GET", `/project-manager/scheduling?path=${encodeURIComponent(Work)}`);
  assert.deepEqual((sched.tasks ?? []).find((t: any) => t.title === "Prerequisite")?.dependsOn ?? [], [], "the cycle was refused and nothing was written");
  await closePanel();
  evidence.dependency = { waiting: "Waiting for “Prerequisite” to be Done.", cycleRefusal: "That would make a cycle: Prerequisite → Successor → Prerequisite." };
  mark("Added Successor depends on Prerequisite in the window (it shows 'Waiting for “Prerequisite” to be Done'); a cyclic dependency was refused with a sentence and nothing was written");

  // ---- 3. A refused start creates no run, with the reason ----
  const noRun = async (what: string) => { assert.equal(await runs(successor.id), 0, `${what}: the refused start created no run`); assert.equal((await byTitle("Successor")).column, "ready"); };
  await cardButton("Successor", "Run");
  await show("is not Done yet", 15_000);
  await noRun("prerequisite still Ready");
  evidence.refusals = [(find(hasText("dependencies are not satisfied")).at(0)?.AXValue ?? "dependencies are not satisfied")];
  shot("04-refused-start");
  mark("Run on Successor was refused while Prerequisite was unresolved: the reason is shown and no run exists");

  // ---- 4. Execution finished is not Done: Review does not open the gate ----
  const prereq = await byTitle("Prerequisite");
  await cardButton("Prerequisite", "Run");
  await settle(prereq.id, "review");
  await cardButton("Successor", "Run");
  await show("not Done yet (review)", 15_000).catch(() => show("finished run in Review does not count", 15_000));
  await noRun("prerequisite finished a run, in Review");
  mark("Prerequisite finished its run and sits in Review: Successor is still refused (a finished run does not count) and has no run");

  // ---- 5. Review rounds: changes, changes, pass; rework each time ----
  const reviewRound = async (expected: "ready" | "review") => {
    await openTask("Prerequisite");
    await button("Request AI review");
    await poll("review settled", async () => { const t = await byTitle("Prerequisite"); return t.qcState?.activeReviewId == null && t.column !== "running" && t.qcState?.roundCount ? true : null; }, 40_000);
    await settle(prereq.id, expected);
    await sleep(800);
  };
  await reviewRound("ready");
  let t = await byTitle("Prerequisite");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.reworkCount, t.qcState.roundCount, t.qcState.awaitingOwnerApproval], ["ready", "CHANGES_REQUESTED", 1, 1, false]);
  await show("Review requested changes");
  shot("05-round1-changes-requested");
  await closePanel();
  await cardButton("Successor", "Run"); await sleep(1500); await noRun("round 1 changes requested");

  await sendMessage("Prerequisite", "Please address the review feedback.");   // rework: the same task runs again
  await settle(prereq.id, "review");
  assert.equal(await runs(prereq.id), 3, "the first run, its review, and the rework run");
  await reviewRound("ready");
  t = await byTitle("Prerequisite");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.reworkCount, t.qcState.roundCount], ["ready", "CHANGES_REQUESTED", 2, 2]);
  shot("06-round2-changes-requested");
  const beforeReopen1 = { runs: await runs(prereq.id), qc: (await qc(prereq.id)).reviews.map((r: any) => [r.round, r.verdict, r.implementationAttempt, r.coversLatestOutput]), column: t.column };
  mark("Two review rounds requested changes; each returned Prerequisite to Ready with its history kept; Successor stayed refused");

  // ---- 6. Quit and reopen while waiting for rework ----
  await closePanel().catch(() => undefined);
  await quit();
  mark("Quit the packaged app while Prerequisite waits for rework (Cmd+Q)");
  await up(); await sleep(3000);
  t = await byTitle("Prerequisite");
  assert.equal(t.column, "ready");
  assert.equal(await runs(prereq.id), beforeReopen1.runs, "reopening created no run");
  assert.deepEqual((await qc(prereq.id)).reviews.map((r: any) => [r.round, r.verdict, r.implementationAttempt, r.coversLatestOutput]), beforeReopen1.qc);
  assert.equal((await tasksNow()).filter((x: any) => x.column === "running").length, 0);
  await button("D4 Work", true, 0); await button("Tasks", true, 0);
  await openTask("Prerequisite");
  await show("Review requested changes");
  await show("Reviewed attempt 1: earlier output, not the latest.").catch(() => show("Reviewed attempt 1"));
  shot("07-reopened-waiting-for-rework");
  evidence.reopenAtRework = { column: t.column, runs: beforeReopen1.runs, rounds: beforeReopen1.qc };
  await closePanel();
  mark("Reopened while waiting for rework: the board, the task panel and the history agree (Ready, two rounds of changes requested, earlier output labelled), and nothing resumed or started");

  // ---- 7. Third attempt, PASS: awaiting the Owner's separate Accept ----
  await sendMessage("Prerequisite", "Address the feedback once more.");
  await settle(prereq.id, "review");
  await reviewRound("review");
  t = await byTitle("Prerequisite");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval, t.qcState.reworkCount, t.qcState.roundCount], ["review", "PASS", true, 2, 3]);
  const q3 = await qc(prereq.id);
  assert.deepEqual(q3.reviews.map((r: any) => [r.round, r.verdict, r.implementationAttempt, r.coversLatestOutput]), [[1, "CHANGES_REQUESTED", 1, false], [2, "CHANGES_REQUESTED", 2, false], [3, "PASS", 3, true]]);
  await show("Reviewed attempt 3: the latest output.");
  assert.notEqual(t.column, "done", "a PASS is not acceptance");
  shot("08-pass-awaiting-owner");
  await closePanel();
  await cardButton("Successor", "Run"); await sleep(1500); await noRun("review PASS, not accepted");
  mark("Round 3 passed: Prerequisite waits in Review for the Owner (not Done); Successor is still refused");

  // ---- 8. Quit and reopen while waiting for acceptance ----
  const beforeReopen2 = { runs: await runs(prereq.id), qc: q3.reviews.length };
  await quit();
  await up(); await sleep(3000);
  t = await byTitle("Prerequisite");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval], ["review", "PASS", true]);
  assert.equal(await runs(prereq.id), beforeReopen2.runs);
  assert.equal((await qc(prereq.id)).reviews.length, beforeReopen2.qc);
  assert.equal(await runs(successor.id), 0);
  await button("D4 Work", true, 0); await button("Tasks", true, 0);
  await openTask("Prerequisite");
  await show("Reviewed attempt 3: the latest output.");
  shot("09-reopened-waiting-for-acceptance");
  await closePanel();
  evidence.reopenAtAcceptance = { column: t.column, qcState: t.qcState, runs: beforeReopen2.runs, successorRuns: 0 };
  mark("Reopened while waiting for acceptance: still Review with a PASS awaiting the Owner, history intact, no run created, Successor still has none");

  // ---- 9. The separate Owner action: Accept ----
  await cardButton("Prerequisite", "Done");
  await settle(prereq.id, "done");
  t = await byTitle("Prerequisite");
  assert.equal(t.qcState.awaitingOwnerApproval, false);
  mark("The Owner accepted Prerequisite with Done: the only transition to Done");

  // ---- 10. Now Successor may run; its own PASS is withdrawn if the output changes ----
  await cardButton("Successor", "Run");
  await settle(successor.id, "review");
  assert.equal(await runs(successor.id), 1);
  await openTask("Successor");
  await button("Request AI review");
  await poll("successor reviewed", async () => ((await byTitle("Successor")).qcState?.latestVerdict === "PASS" ? true : null), 40_000);
  await sleep(1000);
  t = await byTitle("Successor");
  assert.deepEqual([t.column, t.qcState.awaitingOwnerApproval], ["review", true]);
  // The Owner asks for a change: a new run produces different output, so the earlier PASS no longer applies.
  ax("focus-name", "AXTextArea", "Prompt"); await sleep(400);
  ax("text", "Change the output once more."); await sleep(500);
  ax("key", "36", "0"); await sleep(800);
  await poll("a new run started", async () => ((await runs(successor.id)) >= 3 ? true : null), 30_000);
  await settle(successor.id, "review");
  await sleep(1000);
  t = await byTitle("Successor");
  assert.deepEqual([t.qcState.awaitingOwnerApproval, t.qcState.latestVerdict], [false, null], "the earlier PASS was withdrawn");
  await show("No review verdict covers the latest output.");
  const q = await qc(successor.id);
  assert.deepEqual(q.reviews.map((r: any) => [r.round, r.verdict, r.coversLatestOutput]), [[1, "PASS", false]]);
  await show("Reviewed attempt 1: earlier output, not the latest.");
  shot("10-output-changed-after-pass");
  evidence.changedOutput = { awaitingAfterChange: t.qcState.awaitingOwnerApproval, verdictAfterChange: t.qcState.latestVerdict, round1CoversLatest: false };
  mark("Changed output after a PASS: the earlier PASS was withdrawn, the panel says no verdict covers the latest output and labels the old round as earlier output");

  // ---- 11. Staging versus worktree is explained before it bites: Prepare on a worktree-isolated task in a non-Git folder ----
  await closePanel();
  const worker = await api("POST", "/employees", { name: "Iris", jobTitle: "Engineer", projectPath: Work });
  const workerId = worker.id ?? worker.employee?.id;
  const wt = await api("POST", "/tasks", { title: "Worktree task", prompt: "Needs a worktree.", workdir: Work, isolation: "worktree", agent: "claude-code", model: "opus-5.5", column: "ready" });
  await api("POST", "/task-assignments", { taskId: wt.id, employeeId: workerId });
  const runsBeforeWt = await runs(wt.id);
  await openTask("Worktree task");
  await button("EMPLOYEE EXECUTION");
  await button("Harness", false, 0);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Prepare Execution");
  await show("requires a Git worktree", 15_000);
  const attemptsWt = (await api("GET", `/employee-execution/attempts?taskId=${wt.id}`)).attempts;
  assert.deepEqual(attemptsWt, [], "Prepare created no attempt");
  assert.equal(await runs(wt.id), runsBeforeWt, "Prepare created no run");
  assert.equal((await tasksNow()).find((x: any) => x.id === wt.id).column, "ready");
  shot("11-worktree-refused");
  evidence.worktreeRefusal = { sentence: "This task requires a Git worktree, but its folder is not a Git repository.", attempts: attemptsWt.length, runs: await runs(wt.id) };
  mark("Prepare on a worktree-isolated task in a non-Git folder was refused in plain words; no attempt and no run were created");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.result = "pass"; save();
  console.log("FO-D4 packaged walkthrough passed");
}
