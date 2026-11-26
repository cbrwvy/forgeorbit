/**
 * Direction 7, criterion 2: one linked flow in the packaged ForgeOrbitQA window (fake drivers, disposable profile).
 *
 *   1. Grant memory to a project-scoped Head turn through the Brain picker and send it. The fake driver reports, from the
 *      prompt it actually received, which memory records reached it. A second project's memory must not.
 *   2. The next Head turn (a plan cannot ride on a turn with attached memory) proposes a task; it is pending and starts
 *      nothing; Approve in the window creates the Backlog task in the named project.
 *   3. The same task goes through the employee path in the window: admit, Ready, assign, Prepare, Run Employee review.
 *      The review is cancelled; no run exists. Neither the memory grant nor the plan approval is an execution
 *      authorization.
 * Seeded (prerequisites, not accepted actions): two projects, a distinctive Brain memory in each, the Head's consent and
 * one Developer employee for the target project.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, activate, clickByPosition } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "the Brain grant, the Head turns, the plan Approve, admit/Ready/assign/Prepare/Run Employee review, Cancel",
    "PN records read from the packaged core (API of the same isolated profile)": "what the fake driver received (computed by it from the prompt), the grant's record, the proposal, task, assignment, attempt and run records",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const Alpha = join(runtime, "projects/Alpha"), Beta = join(runtime, "projects/Beta");
  mkdirSync(Alpha, { recursive: true }); mkdirSync(Beta, { recursive: true });
  const TOKEN_ALPHA = "SYNTH-ALPHA-7Q4", TOKEN_BETA = "SYNTH-BETA-9Z2";

  // ---- prerequisites (API of the isolated profile) ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Alpha, name: "D7b Alpha" });
  await api("POST", "/projects", { path: Beta, name: "D7b Beta" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const consent = (await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" })).isolation.consentKey;
  await api("PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent } });
  const memAlpha = await api("POST", "/brain/memories", { scopeKind: "project", projectPath: Alpha, title: "Alpha release note", kind: "decision", content: `Distinctive note ${TOKEN_ALPHA} for the target project.` }, 201);
  const memBeta = await api("POST", "/brain/memories", { scopeKind: "project", projectPath: Beta, title: "Beta release note", kind: "decision", content: `Different note ${TOKEN_BETA} for another project.` }, 201);
  const worker = await api("POST", "/employees", { name: "Alpha Developer", jobTitle: "Developer", projectPath: Alpha });
  await down(); await up(); await show("Main navigation");
  mark("Seeded through the API of the isolated profile: two projects, one distinctive Brain memory in each, the Head's consent and one Developer employee in D7b Alpha");

  const head = async () => { const s = await api("GET", "/portfolio-manager"); return s.value ?? s; };
  const counts = async () => {
    const tasks = await api("GET", "/tasks");
    const runs = (await Promise.all(tasks.map((t: any) => api("GET", `/tasks/${t.id}/runs`)))).flat().length;
    return { tasks: tasks.length, runs };
  };
  const baseline = await counts();
  const typeAndSend = async (text: string) => {
    const before = (await head()).messages.length;
    ax("focus-name", "AXTextArea", "Message to Head of PM"); await sleep(400);
    ax("text", text); await sleep(500);
    await button("Send");
    await poll("Head turn settled", async () => { const h = await head(); return h.messages.length >= before + 2 && h.activeTurn == null ? true : null; }, 30_000);
    await sleep(800);
  };
  const lastReply = async () => (await head()).messages.filter((m: any) => m.role === "manager").at(-1);

  // ---- 1. Head scoped to D7b Alpha ----
  await button("Open Head of PM");
  await show("Message to Head of PM");
  await button("Context", true, 0);
  await sleep(700); ax("text", "D7b Alpha"); await sleep(500); ax("key", "36", "0"); await sleep(900);
  await show("D7b Alpha");
  shot("01-head-project-scope");
  mark("Opened the Head and scoped it to D7b Alpha; opening sent nothing");

  // ---- 2. Brain grant in the window ----
  await button("Brain for the next message", false);
  await show("Alpha release note", 20_000);
  assert(!has("Beta release note"), "the picker offers only the scoped project's memory");
  shot("02-brain-picker");
  c.evidence.pickerOffered = ["Alpha release note"];
  const checkbox = find((n: any) => n.AXRole === "AXCheckBox" && [n.AXTitle, n.AXDescription].includes("Alpha release note"))[0];
  if (checkbox) { activate(checkbox); await sleep(600); }
  else await clickByPosition((n: any) => [n.AXTitle, n.AXDescription, n.AXValue].includes("Alpha release note"));
  await sleep(500);
  await button("Preview context", true);
  await show("Memory", 10_000).catch(() => undefined);
  await sleep(800);
  shot("03-brain-preview");
  await button("Use these memories on the next message", true);
  await show("approved for the next message", 15_000);
  shot("04-brain-approved");
  const grantRow = (await api("GET", "/brain/context/transmissions?managerKind=portfolio")).transmissions.at(0);
  evidence.grantBeforeSend = { status: grantRow.status, used: grantRow.used, items: grantRow.items.map((i: any) => i.title) };
  assert.equal(grantRow.status, "approved"); assert.equal(grantRow.used, false);
  mark("Brain picker: previewed and approved exactly D7b Alpha's memory for the next message (nothing sent yet)");

  // ---- 3. Send the granted turn; read what the driver actually received ----
  await typeAndSend("__fake_head_context__ Which records did you receive?");
  const probe = await lastReply();
  assert(probe.text.includes("Brain records received: 1."), probe.text);
  assert(probe.text.includes(`Tokens in those records: ${TOKEN_ALPHA}.`), probe.text);
  assert(!probe.text.includes(TOKEN_BETA), "the other project's memory did not reach the driver");
  assert(probe.text.includes(`Tokens anywhere in the prompt: ${TOKEN_ALPHA}.`), "no other synthetic token anywhere in the prompt");
  assert.deepEqual(await counts(), baseline, "the memory grant created and started nothing");
  const spent = (await api("GET", "/brain/context/transmissions?managerKind=portfolio")).transmissions.at(0);
  assert.equal(spent.status, "consumed"); assert.equal(spent.used, true);
  assert.deepEqual(spent.items.map((i: any) => i.id), [memAlpha.id]);
  assert(!spent.items.some((i: any) => i.id === memBeta.id));
  await show("Brain records received: 1.", 10_000);
  shot("05-head-reply-context");
  evidence.granted = { driverReply: probe.text, grant: { status: spent.status, used: spent.used, items: spent.items.map((i: any) => i.title), digest: spent.digest.slice(0, 12), turnId: spent.turnId }, sources: probe.sources ?? null };
  mark(`The granted turn was sent from the window. The fake driver's own report from the prompt it received: one Brain record, token ${TOKEN_ALPHA} only; ${TOKEN_BETA} appears nowhere in the prompt. The grant is now consumed (used once) and nothing was created or started`);

  // ---- 4. The plan: the next turn (no memory attached) proposes a task; pending; Approve in the window ----
  const proposalsBefore = (await head()).boardProposals?.length ?? 0;
  const action = JSON.stringify({ kind: "create", project: "D7b Alpha", title: "Alpha release checklist", description: "Proposed by the Head after the memory turn." });
  await typeAndSend(`__fake_head_board__ ${action}`);
  await show("Changes project: D7b Alpha", 15_000);
  const pending = (await head()).boardProposals.at(-1);
  assert.equal((await head()).boardProposals.length, proposalsBefore + 1);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.affectedProjects.map((p: any) => p.name), ["D7b Alpha"]);
  assert.deepEqual(await counts(), baseline, "receiving and reading the plan created and started nothing");
  shot("06-plan-pending");
  evidence.plan = { id: pending.id, status: pending.status, affectedProjects: pending.affectedProjects.map((p: any) => p.name), createdTasksBeforeApprove: 0 };
  mark("The next Head turn proposed the task: the card names D7b Alpha, it is pending, and receiving it created no task and no run");
  await button("Approve", true, 0);
  const approved = await poll("proposal approved", async () => { const p = (await head()).boardProposals.find((x: any) => x.id === pending.id); return p && p.status !== "pending" ? p : null; }, 20_000);
  const created = (await api("GET", "/tasks")).find((t: any) => t.title === "Alpha release checklist");
  assert(created, "the approved proposal created the task");
  assert.equal(created.column, "backlog"); assert.equal(created.workdir, Alpha);
  assert.equal((await api("GET", `/tasks/${created.id}/runs`)).length, 0, "approving the plan started no run");
  assert.equal((await counts()).runs, 0);
  evidence.approved = { status: approved.status, taskId: created.id, column: created.column, workdir: created.workdir, runs: 0 };
  shot("07-plan-approved");
  mark("Approve in the window created exactly one Backlog task in D7b Alpha from that proposal; no run exists");

  // ---- 5. The same task through the employee path ----
  ax("key", "53", "0"); await sleep(800);                 // Escape closes the Head
  await button("D7b Alpha", false, 0); await sleep(900);
  await button("Tasks", true, 1).catch(() => undefined); await sleep(900);
  const names2 = (n: any) => [n.AXTitle, n.AXDescription].filter((x: any) => typeof x === "string" && x);
  const cardButton = async (title: string, label: string) => {
    const node = await poll(`"${label}" on the "${title}" card`, () => {
      const nodes = find(() => true);
      const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names2(n).includes(title) && n.frame && n.frame.width < 400);
      if (!card) return null;
      const f = card.frame;
      return nodes.find((n: any) => n.AXRole === "AXButton" && names2(n).includes(label) && n.frame
        && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height) ?? null;
    }, 20_000);
    activate(node); await sleep(700);
  };
  await cardButton("Alpha release checklist", "Admit to project inbox");
  await poll("inbox", async () => ((await api("GET", `/tasks/${created.id}`)).column === "inbox" ? true : null), 15_000);
  await button("Alpha release checklist", true, 0); await show("Task assignment", 15_000); await sleep(800);
  await button("Move to Ready");
  await poll("ready", async () => ((await api("GET", `/tasks/${created.id}`)).column === "ready" ? true : null), 15_000);
  await button("Choose a developer");
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Assign");
  await show("Assigned to Alpha Developer", 15_000);
  const assignment = (await api("GET", `/task-assignments/task?taskId=${created.id}`)).assignment;
  assert.equal(assignment.employeeId, worker.id); assert.equal(assignment.taskId, created.id);
  assert.equal((await api("GET", `/tasks/${created.id}/runs`)).length, 0);
  mark("Admit, Move to Ready and Assign were done in the window on that same task; the assignment names Alpha Developer; no run exists");

  await button("EMPLOYEE EXECUTION");
  await button("Harness", false, 0);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Prepare Execution");
  await show("Prepared for review", 20_000);
  assert.equal((await api("GET", `/tasks/${created.id}/runs`)).length, 0, "preparing started nothing");
  await button("Run Employee");
  await show("Review and confirm run", 20_000);
  await sleep(800);
  shot("08-run-review");
  const attempts = (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts;
  const attempt = attempts.find((a: any) => a.taskId === created.id) ?? attempts[0];
  assert.equal(attempt.taskId, created.id);
  assert.equal(attempt.employee.id, worker.id);
  assert.equal(attempt.runId ?? null, null, "no run before the Owner's confirmation");
  assert.equal(attempt.phase === "awaiting-approval" || attempt.phase === "pending" || attempt.status === "awaiting-approval" || !attempt.runId, true);
  assert(has("Alpha release checklist"), "the review names the task");
  assert(has("Alpha Developer"), "the review names the employee");
  assert(has("Confirm and start"), "a separate confirmation is still required");
  assert(has(Alpha), "the review shows the task's own workspace");
  assert(!has(Beta), "the review shows nothing from the other project");
  evidence.review = {
    taskId: created.id, taskTitle: "Alpha release checklist", employee: attempt.employee.name, workspace: Alpha, workspaceShownInReview: true,
    requested: attempt.requested ?? null, phase: attempt.phase ?? attempt.status ?? null, runId: attempt.runId ?? null, confirmationRemaining: true,
  };
  mark("Run Employee opened the review for that task and that employee, with the exact resource and workspace, and still asks for its own confirmation");

  await button("Cancel — start nothing", true);
  await sleep(1200);
  const finalAttempts = (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts;
  assert.equal((await api("GET", `/tasks/${created.id}/runs`)).length, 0, "cancelling the review left no run");
  assert.equal((await counts()).runs, 0);
  assert(finalAttempts.every((a: any) => !a.runId), "no attempt launched");
  evidence.afterCancel = { runs: 0, attempts: finalAttempts.map((a: any) => ({ phase: a.phase ?? a.status, runId: a.runId ?? null })), column: (await api("GET", `/tasks/${created.id}`)).column };
  shot("09-review-cancelled");
  mark("Cancel at the launch review: no run exists and the task is still Ready. Neither the memory grant nor the plan approval started or replaced the execution authorization");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)])), ownerBefore, "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  save();
}
