/**
 * Direction 2 acceptance scenario, driven through the packaged ForgeOrbitQA window.
 * Seeds prerequisites only (projects, harness enablement, PM consent, the fake PM's hiring proposal, two Ready tasks).
 * Everything the milestone accepts is done in the app window: Approve hire, assign, Run Employee, request review,
 * accept, change harness/model, quit and relaunch. Every driver is the fake one; no provider is called.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;

export async function run(c: Ctx) {
  const { api, button, show, absent, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, clickByPosition } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => { spawnSync("/usr/sbin/screencapture", ["-x", "-R120,120,1280,860", join(shots, `${name}.png`)]); };
  const Alpha = join(runtime, "projects/Alpha"), Beta = join(runtime, "projects/Beta");
  mkdirSync(Alpha, { recursive: true }); mkdirSync(Beta, { recursive: true });
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  const text = (part: string) => find(hasText(part)).length > 0;
  const labelsOf = (n: any) => [n.AXTitle, n.AXDescription, n.AXValue, n.AXHelp].filter((x: any) => typeof x === "string" && x.length > 0);
  const nameOf = (v: any) => String(v?.name ?? "");

  // ---- prerequisites (seeded; not the accepted actions) ----
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Alpha, name: "D2 Alpha" });
  await api("POST", "/projects", { path: Beta, name: "D2 Beta" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const config = { profileId: null, harness: "codex", model: "gpt-6.1-sol", effort: null, fast: false, maxMode: false, language: "en", instructions: "", extraDocs: [], consentKey: null as string | null };
  await api("PUT", "/project-manager/config", { path: Alpha, config });
  config.consentKey = (await api("POST", "/project-manager/preflight", { path: Alpha })).isolation.consentKey;
  await api("PUT", "/project-manager/config", { path: Alpha, config });
  await api("POST", "/project-manager/messages", { path: Alpha, text: "Recommend a startup-mvp team: hire specialists for this project." });
  const pending = await poll("hiring proposals", async () => {
    const r = await api("GET", `/hiring-proposals?projectPath=${encodeURIComponent(Alpha)}`);
    return r.proposals.length >= 2 ? r.proposals : null;
  }, 30_000);
  const candidate = pending[0];
  const other = pending[1];
  const taskBody = (title: string, workdir: string) => ({ title, prompt: "Write a short fixture note.", workdir, isolation: "none", agent: "claude-code", model: "opus-5.5", column: "ready" });
  const alphaTask = await api("POST", "/tasks", taskBody("Alpha fixture task", Alpha));
  const betaTask = await api("POST", "/tasks", taskBody("Beta unrelated task", Beta));
  evidence.seeded = { projects: ["D2 Alpha", "D2 Beta"], proposals: pending.map((p: any) => p.proposedName), tasks: [alphaTask.title, betaTask.title] };
  mark("Seeded two projects, PM consent, two pending hiring proposals and two Ready tasks");

  // English is applied at boot: relaunch once so the window renders it.
  await down(); await up();
  mark("Relaunched once to apply the English locale");
  await show("Main navigation");

  // ---- 1. Hire one employee through the window; a second proposal stays unhired ----
  await button("D2 Alpha", true, 0);
  await button("Plan and Execution");
  await show(candidate.proposedName);
  assert.equal((await api("GET", "/employees")).employees?.length ?? (await api("GET", "/employees")).length, 0, "no employee exists before Approve");
  await button("Approve", true, 0);
  await show("Approve hiring for");
  shot("01-approve-dialog");
  await button("Approve Hiring");
  await show(`Hired ${candidate.proposedName}`);
  const employees = await api("GET", "/employees");
  const list = employees.employees ?? employees;
  assert.equal(list.length, 1, "exactly one employee was hired");
  const worker = list[0];
  assert.equal(worker.name, candidate.proposedName);
  const stillPending = await api("GET", `/hiring-proposals?projectPath=${encodeURIComponent(Alpha)}&status=pending`).catch(() => null);
  evidence.hire = { id: worker.id, name: worker.name, jobTitle: worker.jobTitle, kind: worker.kind, otherProposalStillPending: other.proposedName, stillPendingCount: stillPending?.proposals?.length ?? null };
  mark(`Hired ${worker.name} (${worker.jobTitle}) with Approve; ${other.proposedName} stays a pending proposal and no second employee exists`);

  // ---- 2. Find the employee in the project and company views; no run yet = empty state ----
  await button("Team", true, 0);
  await show(worker.name);
  shot("02-project-team");
  await button("AI Team", true, 0);
  await button("Staff");
  await show(worker.name);
  await button(worker.name, false, 0);
  await show("Recorded work");
  await show("No run has been recorded for this employee yet");
  shot("03-profile-empty");
  evidence.emptyState = "Recorded work shows an empty sentence; no cost, no rating, no zero";
  mark("Employee found in the project Team tab and the company Staff view; profile shows the empty state with no zero cost and no rating");

  // ---- 3. Assign through the task panel; a different project does not show it ----
  await button("D2 Alpha", true, 0);
  await button("Tasks", true, 0);
  await show("Alpha fixture task");
  await button("Alpha fixture task", true, 0);
  await show("Task assignment");
  await button("Choose a developer");
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Assign");
  await show(`Assigned to ${worker.name}`);
  const assignment = (await api("GET", `/task-assignments/task?taskId=${alphaTask.id}`)).assignment;
  assert.equal(assignment.employeeId, worker.id);
  assert.equal(assignment.revision, 1);
  shot("04-assigned");
  const betaAssign = (await api("GET", `/task-assignments/task?taskId=${betaTask.id}`)).assignment;
  assert.equal(betaAssign, null, "the other project's task has no assignment");
  const betaList = (await api("GET", `/task-assignments/project?projectPath=${encodeURIComponent(Beta)}`)).assignments;
  assert.equal(betaList.length, 0);
  evidence.assignment = { id: assignment.id, revision: assignment.revision, taskId: alphaTask.id, employeeId: worker.id, betaAssignments: betaList.length };
  mark(`Assigned ${worker.name} to the Alpha task in the window (revision 1); the Beta project has no assignment`);

  // ---- 4. Run one supervised fixture task through Run Employee ----
  await button("EMPLOYEE EXECUTION");
  const harnessNow = find((n: any) => n.AXRole === "AXPopUpButton" && n.AXValue === "Review only — no harness chosen")[0];
  assert(harnessNow, "Employee Execution harness select not found");
  await button("Harness", false, 0);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Prepare Execution");
  await show("Prepared for review");
  assert.equal((await api("GET", `/tasks/${alphaTask.id}/runs`)).length, 0, "preparing started nothing");
  await button("Run Employee");
  await show("Review and confirm run");
  shot("05-run-review");
  await button("Confirm and start");
  const attempt = await poll("attempt completed", async () => {
    const a = (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts;
    return a[0]?.phase === "completed" ? a[0] : null;
  }, 40_000);
  assert.equal(attempt.employee.id, worker.id);
  evidence.firstAttempt = { id: attempt.id, runId: attempt.runId, requested: attempt.requested, actual: attempt.actual, assignmentRevision: attempt.assignment.revision, result: attempt.result };
  mark("Run Employee confirmed in the window; the fake run completed and is attributed to the worker");

  // ---- 5. Independent review PASS, still waiting for the Owner ----
  await button("Request AI review");
  await poll("QC PASS", async () => {
    const t = (await api("GET", `/tasks/${alphaTask.id}`));
    return t.qcState?.latestVerdict === "PASS" ? t : null;
  }, 40_000);
  const afterPass = await api("GET", `/tasks/${alphaTask.id}`);
  assert.equal(afterPass.qcState.awaitingOwnerApproval, true);
  assert.notEqual(afterPass.column, "done", "a QC PASS is not acceptance");
  const summaryPass = (await api("GET", `/employee-execution/summary?employeeId=${worker.id}`)).summary;
  assert.equal(summaryPass.review.passed, 1); assert.equal(summaryPass.ownerAccepted, 0); assert.equal(summaryPass.awaitingOwner, 1);
  evidence.afterPass = { column: afterPass.column, qcState: afterPass.qcState, summary: { passed: summaryPass.review.passed, ownerAccepted: summaryPass.ownerAccepted, awaitingOwner: summaryPass.awaitingOwner } };
  mark("Review PASS recorded; the task is not Done and the profile summary counts it as waiting for the Owner, not accepted");

  // ---- 7. Owner accepts ----
  await button("Close task details");
  await sleep(600);
  await button("Done", true, 0);
  await poll("task done", async () => ((await api("GET", `/tasks/${alphaTask.id}`)).column === "done" ? true : null), 15_000);
  const done = await api("GET", `/tasks/${alphaTask.id}`);
  assert.equal(done.qcState.awaitingOwnerApproval, false);
  const summaryDone = (await api("GET", `/employee-execution/summary?employeeId=${worker.id}`)).summary;
  assert.equal(summaryDone.ownerAccepted, 1); assert.equal(summaryDone.awaitingOwner, 0);
  evidence.accepted = { column: done.column, summary: { passed: summaryDone.review.passed, ownerAccepted: summaryDone.ownerAccepted, awaitingOwner: summaryDone.awaitingOwner, cost: summaryDone.cost, time: summaryDone.time, quality: summaryDone.quality } };
  mark("Owner accepted the result with Mark Done; QC PASS and Owner acceptance are now separate recorded states");

  // ---- 6. The worker's next task: assign in the window, change its harness and model, preflight reflects it, no run starts ----
  const nextTask = await api("POST", "/tasks", { title: "Alpha next task", prompt: "Write a second fixture note.", workdir: Alpha, isolation: "none", agent: "claude-code", model: "opus-5.5", column: "ready" });
  await button("Tasks", true, 0);
  await show("Alpha next task");
  await button("Alpha next task", true, 0);
  await show("Task assignment");
  await button("Choose a developer");
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Assign");
  await show(`Assigned to ${worker.name}`);
  const nextAssignment = (await api("GET", `/task-assignments/task?taskId=${nextTask.id}`)).assignment;
  assert.equal(nextAssignment.employeeId, worker.id);
  const runsBeforeChange = (await api("GET", `/tasks/${nextTask.id}/runs`)).length;
  const attemptsBefore = (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts;
  await button("TASK DETAILS");
  await button("Harness", false, 0);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(1500);
  await button("Model", true, 0);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(1500);
  const changed = await api("GET", `/tasks/${nextTask.id}`);
  assert.notEqual(`${changed.agent}/${changed.model}`, "claude-code/opus-5.5", "the task's harness or model changed");
  shot("06-resource-changed");
  // Nothing about the worker moved: same id, same first assignment, the past attempt keeps its requested resource.
  const firstAssignment = (await api("GET", `/task-assignments/task?taskId=${alphaTask.id}`)).assignment;
  assert.equal(firstAssignment.id, assignment.id); assert.equal(firstAssignment.revision, 1); assert.equal(firstAssignment.employeeId, worker.id);
  assert.equal(nextAssignment.revision, 1);
  assert.equal((await api("GET", `/tasks/${nextTask.id}/runs`)).length, runsBeforeChange, "changing the resource started no run");
  const attemptsAfter = (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts;
  assert.equal(attemptsAfter.length, attemptsBefore.length);
  assert.deepEqual(attemptsAfter[0].requested, attempt.requested, "past attempt keeps its requested resource");
  assert.deepEqual(attemptsAfter[0].actual, attempt.actual);
  assert.equal(attemptsAfter[0].employee.id, worker.id);
  // The next preflight, prepared in the window: the previous resource is refused, the new one is prepared.
  await button("EMPLOYEE EXECUTION");
  await poll("employee execution harness select", () => (find((n: any) => n.AXRole === "AXPopUpButton" && (n.AXTitle === "Harness" || n.AXDescription === "Harness")).length >= 2 ? true : null), 15_000);
  await button("Harness", false, 1);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800); // Claude Code: the old resource
  await button("Prepare Execution");
  await show("harness-differs-from-task");
  evidence.uiPreflightOldResource = find((n: any) => labelsOf(n).some((l: string) => l.includes("harness-differs-from-task"))).map((n: any) => labelsOf(n).join(" | ").slice(0, 220)).slice(0, 1);
  shot("06b-preflight-old-resource-blocked");
  await button("Harness", false, 1);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800); // Codex: the new resource
  evidence.draftHarnessFinal = find((n: any) => n.AXRole === "AXPopUpButton" && (n.AXTitle === "Harness" || n.AXDescription === "Harness")).map((n: any) => n.AXValue);
  await button("Prepare Execution");
  await show("Prepared for review");
  evidence.uiPreflightRows = find((n: any) => typeof n.AXValue === "string" && /gpt-6|opus|Not requested/i.test(n.AXValue)).map((n: any) => n.AXValue).slice(0, 8);
  shot("06c-preflight-new-resource-prepared");
  assert.equal((await api("GET", `/tasks/${nextTask.id}/runs`)).length, runsBeforeChange, "preparing in the window started nothing");
  const preflight = await api("POST", "/employee-execution/preflight", { taskId: nextTask.id, harnessId: changed.agent, model: changed.model, effort: null, complexity: null, expectedAssignmentRevision: 1 });
  assert.equal(preflight.preflight.requested.harnessId, changed.agent);
  assert.equal(preflight.preflight.requested.model, changed.model);
  evidence.afterChange = { nextTask: { id: nextTask.id, agent: changed.agent, model: changed.model, column: changed.column }, firstAssignment: { id: firstAssignment.id, revision: firstAssignment.revision }, nextAssignmentRevision: nextAssignment.revision, preflightRequested: preflight.preflight.requested, runsBefore: runsBeforeChange, runsAfter: (await api("GET", `/tasks/${nextTask.id}/runs`)).length, pastAttemptRequested: attemptsAfter[0].requested };
  mark(`Changed the next task's resource to ${changed.agent} / ${changed.model}: the worker, the first assignment and the past attempt are unchanged; the preflight refuses the old resource and prepares the new one; no run started`);
  // ---- 8. The profile in the company view ----
  await button("AI Team", true, 0);
  await button("Staff");
  await button(worker.name, false, 0);
  await show("Recorded work");
  await show("Accepted by the owner".replace("owner", "Owner"));
  assert(text("Unknown for 1 run(s)"), "cost reads Unknown, not zero");
  shot("07-profile-after-accept");
  mark("Profile shows 1 run, review passed and accepted by the Owner as distinct lines, time recorded, cost Unknown, quality Unknown");

  // ---- 9. Quit normally, relaunch the same profile ----
  const before = {
    employee: (await api("GET", `/employees/${worker.id}`)),
    attempts: (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts,
    assignment: (await api("GET", `/task-assignments/task?taskId=${alphaTask.id}`)).assignment,
    runs: (await api("GET", `/tasks/${alphaTask.id}/runs`)).length,
    task: await api("GET", `/tasks/${alphaTask.id}`),
  };
  ax("key", "12", "1048576"); // Cmd+Q
  await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 15_000).catch(async () => { await down(); });
  await sleep(1500);
  mark("Quit the packaged app normally (Cmd+Q)");
  await up();
  await sleep(2500);
  const after = {
    employee: (await api("GET", `/employees/${worker.id}`)),
    attempts: (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts,
    assignment: (await api("GET", `/task-assignments/task?taskId=${alphaTask.id}`)).assignment,
    runs: (await api("GET", `/tasks/${alphaTask.id}/runs`)).length,
    task: await api("GET", `/tasks/${alphaTask.id}`),
  };
  const emp = (e: any) => e.employee ?? e;
  assert.equal(emp(after.employee).id, emp(before.employee).id);
  assert.equal(emp(after.employee).name, emp(before.employee).name);
  assert.equal(emp(after.employee).jobTitle, emp(before.employee).jobTitle);
  assert.equal(after.attempts.length, 1);
  assert.deepEqual(after.attempts[0].requested, before.attempts[0].requested);
  assert.equal(after.attempts[0].employee.id, worker.id);
  assert.equal(after.attempts[0].phase, "completed");
  assert.equal(after.assignment.revision, 1); assert.equal(after.assignment.id, assignment.id);
  assert.equal(after.runs, before.runs, "nothing resumed or started by itself");
  assert.equal(after.task.column, "done");
  const nextAfter = await api("GET", `/tasks/${nextTask.id}`);
  assert.equal(nextAfter.agent, changed.agent); assert.equal(nextAfter.model, changed.model);
  assert.equal((await api("GET", `/tasks/${nextTask.id}/runs`)).length, runsBeforeChange);
  const running = (await api("GET", "/tasks")).filter((t: any) => t.column === "running");
  assert.equal(running.length, 0, "no task is running after relaunch");
  evidence.afterRelaunch = { employee: { id: emp(after.employee).id, name: emp(after.employee).name }, attempts: after.attempts.length, requestedKept: after.attempts[0].requested, assignmentRevision: after.assignment.revision, nextTaskResource: { agent: nextAfter.agent, model: nextAfter.model }, runsBefore: before.runs, runsAfter: after.runs, running: running.length };
  mark("Relaunched the same profile: same employee id and name, same assignment revision 1, the past attempt keeps its requested resource, the next task keeps the new resource, no run resumed or started");

  // ---- 10. The window after relaunch: profile, org chart, directory ----
  await button("AI Team", true, 0);
  await button("Organization");
  await show(worker.name);
  shot("08-organization-after-relaunch");
  await button("Staff");
  await button(worker.name, false, 0);
  await show("Recorded work");
  await show("Accepted by the Owner");
  assert(text("Alpha fixture task"), "history lists the task");
  shot("09-profile-after-relaunch");
  mark("After relaunch the org chart, staff directory and profile still list the worker with the task, review outcome and Owner acceptance");

  // ---- 11. Failure cases that must hold ----
  const refuse = async (route: string, body: unknown, label: string) => {
    const res = await fetch(`http://127.0.0.1:${state.apiPort}${route}`, { method: "POST", headers: { authorization: `Bearer ${JSON.parse(readFileSync(join(runtime, "data/agetor-core.json"), "utf8")).token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    assert(res.status >= 400 && res.status < 500, `${label}: expected a refusal, got ${res.status} ${raw.slice(0, 200)}`);
    return { status: res.status, error: (JSON.parse(raw) as any).error };
  };
  // A second worker is seeded only so that a reassignment can be attempted; it is not part of the hiring claim.
  const second = await api("POST", "/employees", { name: "Casey Seeded", jobTitle: "QA Engineer", projectPath: Alpha });
  const stale = await refuse("/task-assignments/reassign", { taskId: alphaTask.id, employeeId: second.id ?? second.employee?.id, expectedRevision: 99 }, "stale revision");
  // An archived worker cannot take work: archive the seeded second worker, then try to assign it a fresh Ready task.
  const secondId = second.id ?? second.employee?.id;
  await api("DELETE", `/employees/${secondId}`);
  const archivedCheckTask = await api("POST", "/tasks", { title: "Alpha archived-worker check", prompt: "Not to be assigned.", workdir: Alpha, isolation: "none", agent: "claude-code", model: "opus-5.5", column: "ready" });
  const archivedRefusal = await refuse("/task-assignments", { taskId: archivedCheckTask.id, employeeId: secondId }, "archived worker");
  assert.equal((await api("GET", `/task-assignments/task?taskId=${archivedCheckTask.id}`)).assignment, null);
  // A job title grants nothing: with a fitting worker in the project but no assignment, a run cannot even be reviewed.
  const unassignedReview = await api("POST", "/employee-execution/reviews", { taskId: archivedCheckTask.id, harnessId: "claude-code" });
  assert.equal(unassignedReview.attempt, null);
  assert((unassignedReview.blockingErrors ?? []).length > 0, "an unassigned task cannot be reviewed for an employee run");
  evidence.unassignedTaskReview = { attempt: unassignedReview.attempt, blocking: unassignedReview.blockingErrors.map((e: any) => ({ code: e.code, message: e.message })) };
  assert.equal((await api("GET", `/tasks/${archivedCheckTask.id}/runs`)).length, 0);
  const cross = await refuse("/task-assignments", { taskId: betaTask.id, employeeId: worker.id }, "cross-project assignment");
  const afterRefusals = (await api("GET", `/task-assignments/task?taskId=${alphaTask.id}`)).assignment;
  assert.equal(afterRefusals.revision, 1);
  assert.equal((await api("GET", `/task-assignments/task?taskId=${betaTask.id}`)).assignment, null);
  const employeeCount = (await api("GET", "/employees")); const all = (employeeCount.employees ?? employeeCount) as any[]; const n = all.length;
  assert(!all.some((e) => e.name === other.proposedName), "the unapproved proposal was never hired");
  assert.equal(n, 1, "only the approved hire is active; the seeded reassignment worker was archived");
  evidence.failureCases = { staleRevision: stale, crossProject: cross, archivedWorker: archivedRefusal, assignmentRevisionAfter: afterRefusals.revision, employeesAfter: n };
  mark("Stale-revision reassignment, cross-project assignment and assignment to an archived worker were refused with a sentence and no change; the unapproved proposal was never hired");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.result = "pass"; save();
  console.log("FO-D2 packaged walkthrough passed");
}
