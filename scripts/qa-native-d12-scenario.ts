/**
 * Direction 12 (Backlog task forecasting), packaged ForgeOrbitQA window. Fake drivers, disposable profile, no provider,
 * no login, no quota source, no model call. There is NO measured history in this profile: the fake runs are synthetic
 * and excluded from calibration, so every range here is a cold-start heuristic and the window must say so.
 *
 * One coherent scenario through the existing UI:
 *   1. Open a Backlog task and Estimate it: a range (not a point), the cold-start basis, the unknowns named.
 *   2. Change a material planning input in the window (the scope text): a new estimate appears, the first stays readable
 *      as superseded. Estimating started nothing.
 *   3. Assign a worker in the window (a third planning input). The saved estimate is superseded.
 *   4. One supervised fake run (Prepare, Run Employee, Confirm and start): the first Developer run freezes the revision that
 *      was valid at Start; the task's "Forecast versus actual" names that estimate and the original stays distinguishable.
 * Backend-only (stated, not worked around): calibration eligibility, a Reviewer run never replacing the baseline, a task
 * that started with no estimate, and an unsupervised Start: src/bun/usage-analytics/forecast-baseline.suite.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, activate } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "Estimate on a Backlog card, the basis block, a scope edit and its new revision, the superseded earlier revision, worker assignment, Prepare / Run Employee / Confirm and start, the task's Forecast versus actual",
    "PN records read from the packaged core (API of the same isolated profile)": "estimate revisions and their stale flags, run and task counters, the run's frozen estimate id",
    "Backend only (QA isolation)": "calibration eligibility, Reviewer or later runs never replacing the baseline, a task already started with no estimate, an unsupervised Start: src/bun/usage-analytics/forecast-baseline.suite.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const Work = join(runtime, "projects/D12");
  const SCOPE_A = "Add a health endpoint. Acceptance: it answers 200.";
  const SCOPE_B = "Refactor the authentication flow and add a database migration. Acceptance: tests pass.";

  // ---- prerequisites (API of the isolated profile) ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  mkdirSync(Work, { recursive: true });
  writeFileSync(join(Work, "package.json"), "{}");
  await api("POST", "/projects", { path: Work, name: "D12 Work" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const worker = await api("POST", "/employees", { name: "D12 Developer", jobTitle: "Developer", projectPath: Work });
  const made = await api("POST", "/tasks", { title: "D12 forecast task", prompt: SCOPE_A, workdir: Work, agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none", column: "backlog" });
  const taskId = (made.task ?? made).id;
  await down(); await up(); await show("Main navigation");
  mark("Seeded through the API of the isolated profile: one project with a package.json, one Developer employee and one Backlog task. No history exists");

  const detail = async () => api("GET", `/api/usage-analytics/task?taskId=${taskId}`);
  const counters = async () => ({
    runs: (await api("GET", `/tasks/${taskId}/runs`)).length,
    column: (await api("GET", `/tasks/${taskId}`)).column,
    attempts: (await api("GET", `/employee-execution/attempts?employeeId=${worker.id}`)).attempts.length,
  });
  const c0 = await counters();
  assert.deepEqual(c0, { runs: 0, column: "backlog", attempts: 0 });

  // ---- 1. Estimate ----
  const names = (n: any) => [n.AXTitle, n.AXDescription].filter((x: any) => typeof x === "string" && x);
  const cardButton = async (title: string, label: string) => {
    const node = await poll(`"${label}" on the "${title}" card`, () => {
      const nodes = find(() => true);
      const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names(n).includes(title) && n.frame && n.frame.width < 400);
      if (!card) return null;
      const f = card.frame;
      return nodes.find((n: any) => n.AXRole === "AXButton" && names(n).includes(label) && n.frame
        && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height) ?? null;
    }, 20_000);
    activate(node); await sleep(700);
  };
  await button("D12 Work", false, 0); await sleep(900);
  await button("Tasks", true, 1).catch(() => undefined); await sleep(900);
  await cardButton("D12 forecast task", "Estimate");
  await show("What this estimate rests on", 25_000);
  await sleep(1200);
  assert(has("Cold-start range"), "the basis says this is a cold-start range");
  assert(has("not from measured history"), "the basis says it is not measured history");
  assert(has("uncertainty, not accuracy"), "the spread is described as uncertainty, not accuracy");
  assert(has("Developer: 0 of 3 comparable outcomes"), "the Developer shortfall is named");
  assert(has("Reviewer: 0 of 3 comparable outcomes"), "the Reviewer shortfall is named");
  assert(has("Not known: subscription use, price, account, human wait"), "the unknowns are named");
  assert(has("low complexity"), "the scope that informed it is named");
  shot("01-estimate-cold-start");
  const first = await detail();
  const r1 = first.revisions[0];
  const range1 = r1.estimate.completion;
  assert(range1.optimistic < range1.expected && range1.expected < range1.conservative, "a range, not a single point");
  assert.equal(r1.estimate.subscriptionUsage, null);
  assert.equal(r1.estimate.developer.basis, "heuristic");
  assert.equal(r1.estimate.developer.samples, 0);
  assert.equal(first.revisions.length, 1);
  evidence.first = { revision: r1.id, basis: r1.estimate.developer.basis, samples: r1.estimate.developer.samples, confidence: r1.estimate.confidence, completion: range1, complexity: r1.estimate.complexity };
  mark(`Estimate on the Backlog card: revision #${r1.id}; a cold-start range (${range1.optimistic} / ${range1.expected} / ${range1.conservative} ms), '0 of 3 comparable outcomes' for Developer and Reviewer, and the unknowns named (subscription use, price, account, human wait). It does not claim accuracy`);

  // ---- 2. A material scope change ----
  ax("focus-name", "AXTextArea", "Scope"); await sleep(500);
  ax("key", "0", "1048576"); await sleep(300);          // Cmd+A
  ax("text", SCOPE_B); await sleep(600);
  await button("Save scope and regenerate");
  const second = await poll("a second revision exists", async () => { const d = await detail(); return d.revisions.length === 2 ? d : null; }, 30_000);
  await sleep(1500);
  const r2 = second.revisions[0];
  assert(r2.id > r1.id);
  assert.equal(second.revisions[1].id, r1.id);
  assert.equal(second.revisions[1].stale, true, "the first revision is now superseded");
  assert.equal(r2.stale, false);
  assert.equal(r2.estimate.complexity, "high");
  assert(r2.estimate.completion.expected > range1.expected, "the larger scope gives a larger expected range");
  assert.equal(r2.estimate.developer.basis, "heuristic", "no history for this scope either: still a labelled heuristic");
  assert(has(`Revision #${r2.id}`), "the new revision is shown");
  assert(has("high complexity"), "the new scope is named in what informed it");
  await button("Saved estimate revisions");
  await sleep(900);
  assert(has("Superseded"), "the earlier revision is kept and marked superseded");
  shot("02-scope-changed-new-revision");
  evidence.second = { revision: r2.id, complexity: r2.estimate.complexity, completion: r2.estimate.completion, firstStale: second.revisions[1].stale, basis: r2.estimate.developer.basis };
  mark(`Scope edited in the window: revision #${r2.id} (high complexity, a larger expected range, still a labelled heuristic); revision #${r1.id} is kept and marked Superseded, readable in 'Saved estimate revisions'`);
  ax("key", "53", "0"); await sleep(900);
  const c1 = await counters();
  assert.deepEqual(c1, c0, "estimating started nothing and moved nothing");
  mark("After two estimates: no run, no execution attempt, and the task is still in Backlog");

  // ---- 3. Assign a worker in the window ----
  await cardButton("D12 forecast task", "Admit to project inbox");
  await poll("inbox", async () => ((await api("GET", `/tasks/${taskId}`)).column === "inbox" ? true : null), 15_000);
  await button("D12 forecast task", true, 0); await show("Task assignment", 15_000); await sleep(800);
  await button("Move to Ready");
  await poll("ready", async () => ((await api("GET", `/tasks/${taskId}`)).column === "ready" ? true : null), 15_000);
  await button("Choose a developer");
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Assign");
  await show("Assigned to D12 Developer", 15_000);
  const assigned = await detail();
  assert.equal(assigned.revisions[0].id, r2.id);
  assert.equal(assigned.revisions[0].stale, true, "assigning the worker supersedes the saved estimate");
  assert.equal((await api("GET", `/tasks/${taskId}/runs`)).length, 0);
  evidence.afterAssign = { latestRevision: assigned.revisions[0].id, latestStale: assigned.revisions[0].stale };
  mark(`Worker assigned in the window: revision #${r2.id} is marked Superseded because the worker is a planning input; no run exists`);

  // ---- 4. One supervised fake run ----
  await button("EMPLOYEE EXECUTION");
  await button("Harness", false, 0);
  await sleep(700); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  await button("Prepare Execution");
  await show("Prepared for review", 20_000);
  assert.equal((await api("GET", `/tasks/${taskId}/runs`)).length, 0, "preparing started nothing");
  await button("Run Employee");
  await show("Review and confirm run", 20_000);
  await sleep(800);
  assert.equal((await api("GET", `/tasks/${taskId}/runs`)).length, 0, "the review started nothing");
  await button("Confirm and start");
  const ran = await poll("one run exists", async () => { const r = await api("GET", `/tasks/${taskId}/runs`); return r.length === 1 && r[0].status !== "running" ? r : null; }, 60_000);
  await sleep(1500);
  const frozen = await detail();
  const baseline = frozen.comparison.baseline;
  assert(baseline, "the first Developer run froze a baseline");
  assert.equal(baseline.boundRunId, ran[0].id);
  assert(baseline.estimateId > r2.id, "Start re-estimated because the worker was assigned after the last estimate");
  const bound = frozen.revisions.find((r: any) => r.id === baseline.estimateId);
  assert.equal(bound.estimate.workerId, worker.id, "the frozen revision names the assigned worker");
  assert.equal(bound.estimate.complexity, "high");
  // The Harness picker in the review chose the first listed harness, so Start changed the plan from the Backlog estimate's
  // codex to what was actually launched. The baseline must describe the launch, not the Backlog guess.
  assert.equal(bound.estimate.plannedResource.harnessId, ran[0].agent, "the baseline describes the harness that actually ran");
  assert.notEqual(r2.estimate.plannedResource.harnessId, ran[0].agent, "the harness changed between the Backlog estimate and Start");
  assert.equal(frozen.original.estimateId, r1.id, "the original estimate stays distinguishable from the baseline");
  assert.notEqual(frozen.original.estimateId, baseline.estimateId);
  assert.deepEqual(baseline.laterRevisions, []);
  assert.equal(frozen.revisions.length, 3);
  assert.deepEqual(frozen.revisions.map((r: any) => r.stale), [false, true, true]);
  evidence.baseline = { launchedHarness: ran[0].agent, backlogPlannedHarness: r2.estimate.plannedResource.harnessId, estimateId: baseline.estimateId, boundRunId: baseline.boundRunId, original: frozen.original.estimateId, revisions: frozen.revisions.map((r: any) => ({ id: r.id, stale: r.stale })), workerNamed: bound.estimate.workerId === worker.id };

  // The task's own comparison names that estimate.
  await sleep(800);
  await show("Forecast versus actual", 25_000);
  await sleep(1000);
  assert(has(`Estimate #${baseline.estimateId}`), "the task's comparison names the baseline estimate");
  shot("03-baseline-after-supervised-run");
  mark(`Run Employee > Confirm and start: one fake run. The first Developer run froze revision #${baseline.estimateId} (re-estimated at Start: the worker was assigned after revision #${r2.id} and the launch used ${ran[0].agent}, where the Backlog estimate planned ${r2.estimate.plannedResource.harnessId}); the original, #${r1.id}, remains the first saved forecast; the task's 'Forecast versus actual' names Estimate #${baseline.estimateId}`);

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
  // The Owner's own ChatGPT/Codex desktop app writes under ~/.codex while it runs. The QA process cannot be the writer
  // (isolated CODEX_HOME, inert stub), but the guard cannot tell the two apart, so that single path is tolerated only
  // while that app's server runs, and the tolerance is recorded. Every other Owner path must be unchanged.
  const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
  const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
  const unexplained = changed.filter((p) => !tolerated.includes(p));
  evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
  assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = unexplained.length === 0 && tolerated.length === 0;
  mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
  save();
}
