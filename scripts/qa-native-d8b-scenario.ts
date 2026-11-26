/**
 * Direction 8, second milestone: the Owner's one additional review round after the five-round limit.
 * Packaged ForgeOrbitQA, fake drivers, disposable profile, FIXTURE Reviewer (verdicts seeded in a file; not a model).
 * In the window: five rounds to the limit, the Owner's confirmed authorization, quit and reopen, the new
 * implementation attempt (a message in the task panel), the additional review, and the separate Owner Done.
 * A second task ends its additional round without a PASS. The journal is read in the window (AI Team > Activity) and
 * from the core. Duplicate/concurrent/replay/stale-output cases are backend tests (qc-extension-direction8.test.ts).
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

  // ---- prerequisites (seeded, not accepted actions): fixture verdicts, one project, two Ready tasks ----
  // Task 1: five CHANGES_REQUESTED, then the additional round passes. Task 2: five, then the additional round does not.
  writeFileSync(qcVerdictFile, ["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "PASS",
    "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED"].join("\n") + "\n");
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile; fixture Reviewer verdicts seeded: task 1 = 5x CHANGES_REQUESTED then PASS; task 2 = 6x CHANGES_REQUESTED");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Work, name: "D8 Work" });
  await api("POST", "/tasks", { title: "Extra-round task", prompt: "Write the extra-round fixture note.", workdir: Work, isolation: "none", column: "ready" });
  await api("POST", "/tasks", { title: "Spent-round task", prompt: "Write the spent-round fixture note.", workdir: Work, isolation: "none", column: "ready" });
  await down(); await up();
  await show("Main navigation");

  const tasksNow = async () => await api("GET", "/tasks");
  const byTitle = async (title: string) => (await tasksNow()).find((t: any) => t.title === title);
  const runs = async (id: string) => (await api("GET", `/tasks/${id}/runs`)).length;
  const qc = async (id: string) => (await api("GET", `/tasks/${id}/qc`));
  const cardButtons = (title: string) => {
    const nodes = find(() => true);
    const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names(n).includes(title) && n.frame && n.frame.width < 400);
    if (!card) return null;
    const f = card.frame;
    return nodes.filter((n: any) => n.AXRole === "AXButton" && n.frame && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height);
  };
  const cardButton = async (title: string, label: string) => {
    const node = await poll(`"${label}" on the "${title}" card`, () => cardButtons(title)?.find((n: any) => names(n).includes(label)) ?? null, 15_000);
    activate(node); await sleep(500);
  };
  const openTask = async (title: string) => {
    await poll(`card "${title}"`, () => find((n: any) => n.AXRole === "AXButton" && names(n).includes(title)).at(0) ?? null, 15_000);
    await button(title, true, 0); await show("Task assignment", 15_000).catch(() => undefined); await sleep(800);
  };
  const closePanel = async () => { await button("Close task details"); await sleep(600); };
  const sendMessage = async (title: string, text: string) => {
    await openTask(title);
    ax("focus-name", "AXTextArea", "Prompt"); await sleep(400);
    ax("text", text); await sleep(500);
    ax("key", "36", "0"); await sleep(800);
  };
  const settle = async (id: string, column: string) => poll(`${id} reaches ${column}`, async () => ((await tasksNow()).find((t: any) => t.id === id)?.column === column ? true : null), 40_000);
  const reviewRound = async (title: string, id: string, round: number, expected: string) => {
    await openTask(title);
    await button("Request AI review");
    await poll(`round ${round} settled`, async () => { const t = await byTitle(title); return t.qcState?.activeReviewId == null && t.column !== "running" && t.qcState?.roundCount === round ? true : null; }, 40_000);
    await settle(id, expected);
    await sleep(800);
  };
  const journalRows = async (taskId: string, type: string) => {
    const out = await api("GET", `/activity?taskId=${taskId}&eventType=${type}&limit=50`);
    return (out.events ?? out.items ?? out) as any[];
  };
  /** Rounds 1..5 of CHANGES_REQUESTED, each followed by a rework message, ending Blocked at the limit. */
  const toTheLimit = async (title: string, id: string) => {
    await cardButton(title, "Run");
    await settle(id, "review");
    for (let round = 1; round <= 5; round++) {
      await reviewRound(title, id, round, round < 5 ? "ready" : "blocked");
      if (round < 5) { await closePanel(); await sendMessage(title, `Please address review round ${round}.`); await settle(id, "review"); }
    }
    const t = await byTitle(title);
    assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.roundCount, t.qcState.maxRounds], ["blocked", "CHANGES_REQUESTED", 5, 5]);
  };

  await button("D8 Work", true, 0);
  await button("Tasks", true, 0);

  // ================= Task 1: authorization, reopen, new implementation, additional review PASS, Owner Done =================
  const t1 = await byTitle("Extra-round task");
  await toTheLimit("Extra-round task", t1.id);
  await show("review rounds are used");
  await show("Authorize one more review round");
  assert.equal((await byTitle("Extra-round task")).qcState.extension ?? null, null, "no extension before the Owner acts");
  shot("01-limit-offer");
  const before = await qc(t1.id);
  const runsAtLimit = await runs(t1.id);
  assert.equal(before.reviews.length, 5);
  mark("Extra-round task: five CHANGES_REQUESTED rounds, Blocked; the panel offers 'Authorize one more review round' and says what it does");

  await button("Authorize one more review round", true);
  await show("Authorize one more review round?");
  await show("It starts nothing", 10_000).catch(() => show("starts nothing"));
  shot("02-confirm-dialog");
  const midState = await byTitle("Extra-round task");
  assert.equal(midState.qcState.extension ?? null, null, "opening the dialog authorizes nothing");
  await button("Authorize one more round", true);
  await poll("extension recorded", async () => ((await byTitle("Extra-round task")).qcState.extension ? true : null), 15_000);
  await show("One more review round is authorized");
  let t = await byTitle("Extra-round task");
  assert.deepEqual([t.column, t.qcState.roundCount, t.qcState.maxRounds, t.qcState.latestVerdict, t.qcState.extension.reviewId], ["blocked", 5, 6, "CHANGES_REQUESTED", null]);
  assert.equal(await runs(t1.id), runsAtLimit, "authorizing started nothing");
  assert.equal((await qc(t1.id)).reviews.length, 5, "authorizing created no review");
  assert(!has("Request AI review"), "no review can be requested while the task is still Blocked");
  assert(!(cardButtons("Extra-round task") ?? []).flatMap(names).includes("Done"), "authorizing is not acceptance");
  shot("03-authorized");
  const authRows = await journalRows(t1.id, "qc.extension.authorized");
  assert.equal(authRows.length, 1);
  evidence.journal = { authorizedRows: authRows.length, actor: authRows[0].actorType ?? authRows[0].actor_type, task: authRows[0].taskId ?? authRows[0].task_id, createdAt: authRows[0].createdAt ?? authRows[0].created_at };
  mark("The Owner confirmed in the dialog: one extension recorded, the task is still Blocked, no run and no review was created, no Done is offered; one journal row");
  await closePanel();

  // The journal in the window.
  await button("AI Team", true, 0);
  await sleep(1200);
  const activityTab = find((n: any) => n.AXRole === "AXButton" && names(n).some((x: string) => /^Activity/.test(x))).at(0)
    ?? find((n: any) => ["AXTab", "AXRadioButton"].includes(n.AXRole) && names(n).some((x: string) => /^Activity/.test(x))).at(0);
  if (activityTab) { activate(activityTab); await sleep(1500); }
  const journalShown = await show("one additional review round", 10_000).then(() => true).catch(() => false);
  evidence.journal.shownInWindow = journalShown;
  shot("04-journal");
  await button("Tasks", true, 0);

  // ---- quit and reopen with the extension authorized but unused ----
  await quit();
  await up(); await sleep(3000);
  t = await byTitle("Extra-round task");
  assert.deepEqual([t.column, t.qcState.roundCount, t.qcState.maxRounds, t.qcState.extension.reviewId], ["blocked", 5, 6, null]);
  assert.equal(await runs(t1.id), runsAtLimit, "reopening created no run");
  assert.equal((await tasksNow()).filter((x: any) => x.column === "running").length, 0);
  assert.equal((await journalRows(t1.id, "qc.extension.authorized")).length, 1);
  await button("D8 Work", false, 0); await button("Tasks", true, 0);
  await openTask("Extra-round task");
  await show("One more review round is authorized");
  shot("05-reopened-authorized");
  mark("Reopened with the extension authorized and unused: still Blocked, the authorization and journal intact, nothing started");

  // ---- the new implementation attempt (the Owner's message), then the additional review ----
  ax("focus-name", "AXTextArea", "Prompt"); await sleep(400);
  ax("text", "New implementation attempt after the authorization."); await sleep(500);
  ax("key", "36", "0"); await sleep(800);
  await settle(t1.id, "review");
  assert.equal(await runs(t1.id), runsAtLimit + 1, "one new implementation run, nothing else");
  await closePanel();
  await reviewRound("Extra-round task", t1.id, 6, "review");
  t = await byTitle("Extra-round task");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval, t.qcState.roundCount, t.qcState.maxRounds, t.qcState.extension.outcome], ["review", "PASS", true, 6, 6, "PASS"]);
  const after = await qc(t1.id);
  assert.deepEqual(after.reviews.slice(0, 5).map((r: any) => [r.round, r.verdict, r.implementationAttempt]), before.reviews.map((r: any) => [r.round, r.verdict, r.implementationAttempt]), "the five earlier rounds are unchanged");
  assert.deepEqual(after.reviews.map((r: any) => [r.round, r.coversLatestOutput]), [[1, false], [2, false], [3, false], [4, false], [5, false], [6, true]]);
  assert.equal((await journalRows(t1.id, "qc.extension.used")).length, 1);
  await show("your acceptance required");
  assert.notEqual(t.column, "done");
  shot("06-extra-round-pass-awaiting-owner");
  await closePanel();
  mark("New implementation attempt, then the additional review (fixture PASS, round 6): it waits in Review for the Owner, not Done; rounds 1-5 are unchanged; the journal records the extension's use");
  await cardButton("Extra-round task", "Done");
  await settle(t1.id, "done");
  assert.equal((await byTitle("Extra-round task")).qcState.awaitingOwnerApproval, false);
  shot("07-done-by-owner");
  mark("The Owner pressed Done: the separate acceptance step");

  // ================= Task 2: the additional round does not pass =================
  const t2 = await byTitle("Spent-round task");
  await toTheLimit("Spent-round task", t2.id);
  await button("Authorize one more review round", true);
  await show("Authorize one more review round?");
  await button("Authorize one more round", true);
  await poll("task 2 extension recorded", async () => ((await byTitle("Spent-round task")).qcState.extension ? true : null), 15_000);
  await show("One more review round is authorized");
  await sendMessage("Spent-round task", "New implementation attempt after the authorization.").catch(async () => {
    ax("focus-name", "AXTextArea", "Prompt"); await sleep(400); ax("text", "New implementation attempt after the authorization."); await sleep(500); ax("key", "36", "0"); await sleep(800);
  });
  await settle(t2.id, "review");
  await closePanel();
  await reviewRound("Spent-round task", t2.id, 6, "blocked");
  t = await byTitle("Spent-round task");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.roundCount, t.qcState.maxRounds, t.qcState.extension.outcome], ["blocked", "CHANGES_REQUESTED", 6, 6, "CHANGES_REQUESTED"]);
  await show("No further extension is available");
  assert(!has("Authorize one more review round"), "no second extension is offered");
  assert(!has("Request AI review"), "no further review can be requested");
  shot("08-extra-round-failed-blocked");
  await closePanel();
  assert(!(cardButtons("Spent-round task") ?? []).flatMap(names).includes("Done"), "no Done is offered");
  const runsT2 = await runs(t2.id);
  const token = JSON.parse(readFileSync(join(runtime, "data/agetor-core.json"), "utf8")).token;
  const probe = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${state.apiPort}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const second = await probe("POST", `/tasks/${t2.id}/qc/extension`, { confirm: true, expectedRound: 6 });
  const seventh = await probe("POST", `/tasks/${t2.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  const doneTry = await probe("PATCH", `/tasks/${t2.id}`, { column: "done" });
  assert.deepEqual([second.status, second.body.code, seventh.status, doneTry.status], [409, "extension-used", 409, 409]);
  assert.equal(await runs(t2.id), runsT2, "the refused requests created no run");
  assert.equal((await qc(t2.id)).reviews.length, 6);
  evidence.spentRound = { column: t.column, secondExtension: second.status, seventhReview: seventh.status, done: doneTry.status, doneMessage: doneTry.body?.error };
  mark("Spent-round task: the additional round ended CHANGES_REQUESTED, the task stays Blocked, no extension or review or Done is offered; a second extension, a seventh review and Done (API probes, labelled) were each refused with 409 and created nothing");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.result = "pass"; save();
  console.log("FO-D8B packaged walkthrough passed");
}
