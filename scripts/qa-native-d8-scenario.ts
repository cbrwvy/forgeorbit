/**
 * Direction 8 offline acceptance (advanced QC), driven through the packaged ForgeOrbitQA window.
 * Fake drivers, disposable profile, fixture Reviewer. The Reviewer's verdicts are seeded in a file (PASS, then
 * five CHANGES_REQUESTED); they stand in for a Reviewer and are NOT a model's judgement. Nothing here runs a real
 * test: an observed test and `run_project_test` are backend evidence (the QA app runs under an outer sandbox, so the
 * runner's own offline sandbox cannot nest; see docs/qa/fo-perm03-results.md).
 * In the window: Run, Request AI review, rework messages, the separate Done, the review limit, quit and reopen.
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
  writeFileSync(qcVerdictFile, "PASS\nCHANGES_REQUESTED\nCHANGES_REQUESTED\nCHANGES_REQUESTED\nCHANGES_REQUESTED\nCHANGES_REQUESTED\n");
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile; fixture Reviewer verdicts seeded: PASS, then five CHANGES_REQUESTED");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Work, name: "D8 Work" });
  await api("POST", "/tasks", { title: "Passing task", prompt: "Write the passing fixture note.", workdir: Work, isolation: "none", column: "ready" });
  await api("POST", "/tasks", { title: "Looping task", prompt: "Write the looping fixture note.", workdir: Work, isolation: "none", column: "ready" });
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
  const settle = async (id: string, column: string) => poll(`${id} reaches ${column}`, async () => ((await tasksNow()).find((t: any) => t.id === id)?.column === column ? true : null), 30_000);
  const reviewRound = async (title: string, id: string, round: number, expected: string) => {
    await openTask(title);
    await button("Request AI review");
    await poll(`round ${round} settled`, async () => { const t = await byTitle(title); return t.qcState?.activeReviewId == null && t.column !== "running" && t.qcState?.roundCount === round ? true : null; }, 40_000);
    await settle(id, expected);
    await sleep(800);
  };

  await button("D8 Work", true, 0);
  await button("Tasks", true, 0);

  // ---- 1. Passing task: Run -> review PASS -> waits for the Owner -> the separate Done ----
  const passing = await byTitle("Passing task");
  await cardButton("Passing task", "Run");
  await settle(passing.id, "review");
  await reviewRound("Passing task", passing.id, 1, "review");
  let t = await byTitle("Passing task");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval], ["review", "PASS", true]);
  assert.notEqual(t.column, "done", "a PASS is not acceptance");
  const q1 = await qc(passing.id);
  const reviewRunId = q1.reviews[0].reviewRunId;
  const sent = (await api("GET", `/tasks/${passing.id}/events/page?beforeId=999999999&limit=2000`)).events.filter((e: any) => e.runId === reviewRunId && e.stream === "user").map((e: any) => e.data).join("\n");
  evidence.reviewerEvidence = {
    note: "What the fixture Reviewer was sent for the passing task (no real test was observed here, so evidence is a stated limitation, not a pass).",
    mentionsEvidenceLimitation: sent.includes("## Evidence limitation"),
    mentionsObservedTest: sent.includes("### ForgeOrbit-observed test"),
    mentionsBundle: sent.includes("## Review evidence bundle"),
  };
  assert.equal(evidence.reviewerEvidence.mentionsObservedTest, false, "no test was observed in this fixture, so none may be claimed");
  await show("your acceptance required");
  shot("01-pass-awaiting-owner");
  await closePanel();
  mark("Passing task: Run, Request AI review (fixture PASS): it waits in Review for the Owner, not Done; the Reviewer was sent no observed test (stated as a limitation)");

  await cardButton("Passing task", "Done");
  await settle(passing.id, "done");
  t = await byTitle("Passing task");
  assert.equal(t.qcState.awaitingOwnerApproval, false);
  shot("02-done-by-owner");
  mark("The Owner pressed Done on the passing task: the only transition to Done");

  // ---- 2. Looping task: five rounds of CHANGES_REQUESTED; the loop ends BLOCKED for the Owner ----
  const looping = await byTitle("Looping task");
  await cardButton("Looping task", "Run");
  await settle(looping.id, "review");
  for (let round = 1; round <= 5; round++) {
    await reviewRound("Looping task", looping.id, round, round < 5 ? "ready" : "blocked");
    t = await byTitle("Looping task");
    assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.roundCount, t.qcState.reworkCount], [round < 5 ? "ready" : "blocked", "CHANGES_REQUESTED", round, round]);
    if (round < 5) {
      await closePanel();
      await sendMessage("Looping task", `Please address review round ${round}.`);
      await settle(looping.id, "review");
    }
  }
  const finalRuns = await runs(looping.id);
  await show("review rounds are used");
  assert(!has("Request AI review"), "no review can be requested at the limit");
  shot("03-round5-limit");
  const qcLimit = await qc(looping.id);
  assert.deepEqual(qcLimit.reviews.map((r: any) => [r.round, r.verdict]), [[1, "CHANGES_REQUESTED"], [2, "CHANGES_REQUESTED"], [3, "CHANGES_REQUESTED"], [4, "CHANGES_REQUESTED"], [5, "CHANGES_REQUESTED"]]);
  await closePanel();
  const buttons = (cardButtons("Looping task") ?? []).flatMap(names);
  evidence.limit = { column: t.column, rounds: qcLimit.reviews.length, cardButtons: buttons };
  assert(!buttons.includes("Done"), "the card offers no Done at the limit");
  // Backend probes of the same state: the window offers neither action, so these are API calls, labelled as such.
  const sixth = await fetch(`http://127.0.0.1:${state.apiPort}/tasks/${looping.id}/qc/reviews`, { method: "POST", headers: { authorization: `Bearer ${JSON.parse(readFileSync(join(runtime, "data/agetor-core.json"), "utf8")).token}`, "content-type": "application/json" }, body: JSON.stringify({ reviewerHarness: "claude-code", reviewerModel: "opus-5.5" }) });
  assert.equal(sixth.status, 409);
  assert.equal(await runs(looping.id), finalRuns, "the refused sixth review created no run");
  mark("Looping task: five CHANGES_REQUESTED rounds; the fifth moved it to Blocked, the panel says all rounds are used, no review can be requested and the card offers no Done; a sixth review (API probe) was refused and created no run");

  // ---- 3. Quit and reopen at the limit ----
  await quit();
  await up(); await sleep(3000);
  t = await byTitle("Looping task");
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.roundCount], ["blocked", "CHANGES_REQUESTED", 5]);
  assert.equal(await runs(looping.id), finalRuns, "reopening created no run");
  assert.equal((await tasksNow()).filter((x: any) => x.column === "running").length, 0);
  await button("D8 Work", false, 0); await button("Tasks", true, 0);   // the sidebar entry now carries a "1 blocked" badge
  await openTask("Looping task");
  await show("review rounds are used");
  shot("04-reopened-at-limit");
  await closePanel();
  evidence.reopenAtLimit = { column: t.column, runs: finalRuns };
  mark("Reopened at the limit: still Blocked, the same five rounds and message, nothing resumed or started");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.result = "pass"; save();
  console.log("FO-D8 packaged walkthrough passed");
}
