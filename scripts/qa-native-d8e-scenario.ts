/**
 * Direction 8, third milestone: one focused packaged check of the common acceptance rule.
 * The Reviewer fails at the fifth round and produces NO verdict; the task must stay Blocked, explain that no verdict was
 * obtained, offer the existing one-time extension, and reach Done only through a fresh PASS and the Owner's own action.
 * Packaged ForgeOrbitQA, fake drivers, disposable profile, FIXTURE Reviewer (verdicts seeded in a file; not a model).
 * Rounds 1-4 are seeded through the isolated profile's API (the same production path the window uses; prerequisites,
 * labelled as such). In the window: the fifth review that fails, the state and available actions, the Owner's
 * confirmed extension, the new implementation, the extra review (fixture PASS), and the separate Done.
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

  // Fixture verdicts in the order they are consumed: rounds 1-4 CHANGES_REQUESTED (seeded), round 5 the Reviewer FAILS (no verdict),
  // then the additional round PASSes.
  writeFileSync(qcVerdictFile, ["CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "CHANGES_REQUESTED", "MODEL_NOT_FOUND", "PASS"].join("\n") + "\n");
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile; fixture Reviewer outcomes seeded: 4x CHANGES_REQUESTED, then a failed Reviewer (no verdict), then PASS");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Work, name: "D8 Work" });
  const made = await api("POST", "/tasks", { title: "Failed-reviewer task", prompt: "Write the fixture note.", workdir: Work, isolation: "none", column: "ready" });
  const id = made.id ?? made.task?.id;
  const col = async () => (await api("GET", `/tasks/${id}`)).column;
  const settle = async (column: string) => poll(`${id} reaches ${column}`, async () => ((await col()) === column ? true : null), 40_000);
  const qc = async () => await api("GET", `/tasks/${id}/qc`);
  const runs = async () => (await api("GET", `/tasks/${id}/runs`)).length;

  // ---- prerequisites: rounds 1-4 through the API (production path), each followed by a rework message ----
  await api("POST", `/tasks/${id}/start`); await settle("review");
  for (let round = 1; round <= 4; round++) {
    const prepared = await api("POST", `/tasks/${id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
    await api("POST", `/tasks/${id}/qc/reviews/${prepared.review.id}/start`);
    await poll(`round ${round} settled`, async () => { const t = await api("GET", `/tasks/${id}`); return t.qcState?.roundCount === round && !t.qcState.activeReviewId && t.column !== "running" ? true : null; }, 40_000);
    await settle("ready");
    const runId = (await api("GET", `/tasks/${id}`)).runId;
    await api("POST", `/runs/${runId}/input`, { line: `Please address review round ${round}.` });
    await sleep(800); await settle("review");
  }
  assert.equal((await api("GET", `/tasks/${id}`)).qcState.roundCount, 4);
  mark("Seeded through the API: rounds 1-4 (CHANGES_REQUESTED), each followed by a rework run; the task is in Review for the fifth round");
  await down(); await up();
  await show("Main navigation");

  const cardButtons = (title: string) => {
    const nodes = find(() => true);
    const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names(n).includes(title) && n.frame && n.frame.width < 400);
    if (!card) return null;
    const f = card.frame;
    return nodes.filter((n: any) => n.AXRole === "AXButton" && n.frame && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height);
  };
  const openTask = async () => {
    await poll("task card", () => find((n: any) => n.AXRole === "AXButton" && names(n).includes("Failed-reviewer task")).at(0) ?? null, 15_000);
    await button("Failed-reviewer task", true, 0); await show("Quality control", 15_000); await sleep(800);
  };
  const closePanel = async () => { await button("Close task details"); await sleep(600); };
  const bringQc = async () => { try { ax("focus-name", "AXHeading", "Quality control"); } catch { /* the scroll happens before the focus attempt */ } await sleep(600); };
  const token = JSON.parse(readFileSync(join(runtime, "data/agetor-core.json"), "utf8")).token;
  const probe = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${state.apiPort}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ---- the fifth round: the Reviewer fails and produces no verdict ----
  await button("D8 Work", true, 0); await button("Tasks", true, 0);
  await openTask();
  await button("Request AI review");
  await poll("round 5 settled", async () => { const t = await api("GET", `/tasks/${id}`); return t.qcState?.roundCount === 5 && !t.qcState.activeReviewId && t.column !== "running" ? t : null; }, 40_000);
  await settle("blocked");
  let t = await api("GET", `/tasks/${id}`);
  const q5 = await qc();
  assert.deepEqual([t.column, t.qcState.roundCount, t.qcState.maxRounds, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval], ["blocked", 5, 5, null, false]);
  assert.equal(q5.reviews.length, 5);
  assert.equal(q5.reviews[4].verdict, null, "no verdict was obtained and none was invented");
  await show("no verdict was obtained", 15_000);
  await show("Authorize one more review round", 15_000);
  assert(!has("Request AI review"), "no review can be requested at the limit");
  await bringQc();
  shot("01-no-verdict-blocked");
  await closePanel();
  const buttons = (cardButtons("Failed-reviewer task") ?? []).flatMap(names);
  assert(!buttons.includes("Done"), "the card offers no Done");
  const runsAt5 = await runs();
  const doneTry = await probe("PATCH", `/tasks/${id}`, { column: "done" });
  assert.equal(doneTry.status, 409);
  assert.match(doneTry.body.error, /no verdict/);
  assert.equal((await api("GET", `/tasks/${id}`)).column, "blocked");
  evidence.noVerdict = { column: t.column, qcState: { roundCount: t.qcState.roundCount, latestVerdict: t.qcState.latestVerdict }, cardButtons: buttons, doneProbe: { status: doneTry.status, message: doneTry.body.error } };
  mark("Round 5 (window): the Reviewer failed with no verdict. The task is Blocked, the panel says no verdict was obtained, no review can be requested and the card offers no Done; Done by API probe (labelled) is refused 409 with the reason; the one-time extension is offered");

  // ---- the one-time extension, confirmed in the window ----
  await openTask();
  await button("Authorize one more review round", true);
  await show("Authorize one more review round?");
  await button("Authorize one more round", true);
  await poll("extension recorded", async () => ((await api("GET", `/tasks/${id}`)).qcState.extension ? true : null), 15_000);
  await show("One more review round is authorized");
  t = await api("GET", `/tasks/${id}`);
  assert.deepEqual([t.column, t.qcState.roundCount, t.qcState.maxRounds, t.qcState.latestVerdict, t.qcState.extension.reviewId], ["blocked", 5, 6, null, null]);
  assert.equal(await runs(), runsAt5, "authorizing started nothing");
  assert.equal((await qc()).reviews.length, 5, "all prior records are preserved");
  assert.equal((await probe("PATCH", `/tasks/${id}`, { column: "done" })).status, 409);
  await bringQc();
  shot("02-extension-authorized");
  mark("The Owner confirmed the one-time extension: still Blocked, no run and no review created, the five earlier rounds preserved, Done still refused");

  // ---- new implementation, the extra review (fixture PASS), the separate Done ----
  ax("focus-name", "AXTextArea", "Prompt"); await sleep(400);
  ax("text", "New implementation attempt after the authorization."); await sleep(500);
  ax("key", "36", "0"); await sleep(800);
  await settle("review");
  assert.equal(await runs(), runsAt5 + 1, "one new implementation run, nothing else");
  await button("Request AI review");
  await poll("round 6 settled", async () => { const x = await api("GET", `/tasks/${id}`); return x.qcState?.roundCount === 6 && !x.qcState.activeReviewId && x.column !== "running" ? x : null; }, 40_000);
  t = await api("GET", `/tasks/${id}`);
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval, t.qcState.extension.outcome], ["review", "PASS", true, "PASS"]);
  await show("your acceptance required");
  assert.notEqual(t.column, "done");
  await bringQc();
  shot("03-fresh-pass-awaiting-owner");
  await closePanel();
  mark("New implementation, then the additional review (fixture PASS): it waits in Review for the Owner, not Done");
  const doneBtn = await poll("Done on the card", () => cardButtons("Failed-reviewer task")?.find((n: any) => names(n).includes("Done")) ?? null, 15_000);
  activate(doneBtn); await sleep(500);
  await poll("Done", async () => ((await col()) === "done" ? true : null), 20_000);
  shot("04-done-by-owner");
  mark("The Owner pressed Done after the fresh PASS: the only transition to Done");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.outcome = "pass"; save();
  console.log("FO-D8E packaged check passed");
}
