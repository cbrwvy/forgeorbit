/**
 * Direction 18 (evidence-based agent self-improvement): one connected flow in the packaged ForgeOrbitQA window
 * (fake drivers, disposable profile, no provider, no network, no login).
 *
 *   1. Off by default. Settings -> Advanced shows "off until the Owner enables it"; Look for candidates is disabled.
 *   2. Evidence to proposal. FIXTURE-reviewer QC rounds (production QC path, reviewer text seeded) become verified
 *      observations. One finding is isolated: no candidate. A second qualifies: one candidate that names its source
 *      reviews. Looking again does not duplicate it. Prepare draft shows the diff.
 *   3. Fair comparison. "Evaluate on authorized test" runs the existing harness comparison (fake driver, real offline
 *      Seatbelt bun test) on the same frozen tasks. A second project with no fixtures: "Evaluate on registered fixtures"
 *      is inconclusive and cannot be activated.
 *   4. Owner activation, use, keep. Nothing activates until the Owner presses Activate; one project changes; a later
 *      launch carries exactly that revision and records it; Keep this version.
 *   5. A regressing candidate (Owner-supplied weaker text, seeded through the API) fails on the same frozen tasks, is
 *      rejected and cannot be activated.
 *   6. Rollback restores the earlier state; earlier launches keep their recorded revision; quit and reopen: the same
 *      state, nothing restarted.
 * Seeded (prerequisites, not accepted actions): projects, the Full Autonomy policy with one authorized test, the QC
 * rounds (fixture reviewer), the weaker Owner-supplied text. Bounded automatic activation is backend-only (no window).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
const TEST_SRC = `import { expect, test } from "bun:test";\nimport { add } from "./add.ts";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n`;

export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, root, runtime, up, down, sleep, poll, ownerPaths, stamp, qcVerdictFile, activate, seek, matching } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed and pressed in the packaged window)": "Settings -> Advanced self-improvement panel: Enable, Look for candidates, Prepare draft, Evaluate on authorized test, Evaluate on registered fixtures, Activate (also refused), Keep this version, Roll back; quit and reopen",
    "PN records read from the packaged core (API of the same isolated profile)": "candidate, evaluation, version, activation and provenance records; the prompt each launch actually received",
    "Seeded through the API": "projects, the Full Autonomy policy with one authorized test, FIXTURE-reviewer QC rounds (production QC path, reviewer text from a fixture file), the weaker Owner-supplied text for the regressing candidate",
    "Backend only (not in the window)": "bounded automatic activation (policy-covered low-risk, denied cases, other projects), the Owner boundary table, two-generation rollback (src/bun/self-improve/direction18.suite.ts)",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const Alpha = join(runtime, "projects/D18Alpha"), Beta = join(runtime, "projects/D18Beta"), Gamma = join(runtime, "projects/D18Gamma");
  for (const dir of [Alpha, Beta, Gamma]) mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(Alpha, "src/add.test.ts"), TEST_SRC);
  writeFileSync(join(Alpha, "README.md"), "D18 fixture project\n");

  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Alpha, name: "D18 Alpha" });
  await api("POST", "/projects", { path: Beta, name: "D18 Beta" });
  await api("POST", "/projects", { path: Gamma, name: "D18 Gamma" });
  const policy = await api("POST", "/api/autonomy/policies", {
    mode: "full-autonomy", scopeKind: "project", scopeRef: Alpha, projects: [Alpha], clusters: [],
    specialistRoles: ["developer", "reviewer", "head"], providers: ["claude-code"], models: ["haiku-4.5", "opus-5.5"], allowUnscopedAccount: true,
    maxConcurrentWorkers: 1, maxLaunches: 20, maxDurationMs: 60 * 60 * 1000, maxReworkAttempts: 1,
    permittedActions: ["launch_task", "run_qc", "plan_task", "save_observation", "run_observed_test"],
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
    completion: { autoComplete: false, conditions: ["qc_pass"] }, memory: { approval: "owner" }, routerPreset: "balanced",
    spending: { limitUsd: null, requireEnforceableCap: false },
    selfImprovement: { enabled: true, lowRiskActivation: false },
    authorizedTests: [{ projectPath: Alpha, command: "bun test ./src/add.test.ts", outputPaths: ["src/add.ts"] }],
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
  });
  await api("POST", `/api/autonomy/policies/${policy.policy.id}/activate`, {});
  mark("Seeded through the API: three projects (Alpha has a Full Autonomy policy with one authorized fixed test and self-improvement permitted, low-risk activation NOT permitted; Beta and Gamma have no policy)");

  // ---- fixture QC rounds through the production QC path (reviewer text seeded, not a model) ----
  const qcRound = async (project: string, title: string, summary: string) => {
    writeFileSync(qcVerdictFile, `CHANGES_REQUESTED|${summary}\n`);
    const made = await api("POST", "/tasks", { title, prompt: "Write the fixture note.", workdir: project, isolation: "none", column: "ready" });
    const id = (made.id ?? made.task?.id) as string;
    await api("POST", `/tasks/${id}/start`);
    await poll(`${title} reaches review`, async () => ((await api("GET", `/tasks/${id}`)).column === "review" ? true : null), 40_000);
    const prepared = await api("POST", `/tasks/${id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
    await api("POST", `/tasks/${id}/qc/reviews/${prepared.review.id}/start`);
    await poll(`${title} review settled`, async () => { const t = await api("GET", `/tasks/${id}`); return t.qcState?.roundCount === 1 && !t.qcState.activeReviewId && t.column !== "running" ? true : null; }, 40_000);
    return { taskId: id, reviewId: prepared.review.id as string };
  };
  const status = async () => await api("GET", "/api/self-improvement/status");
  const counts = async () => {
    const tasks = await api("GET", "/tasks");
    const s = await status();
    return { runs: tasks.reduce((n: number, t: any) => n + (t.runId ? 1 : 0), 0), tasks: tasks.length, candidates: s.candidates.length, activeVersions: s.activeVersions.length, launches: s.launches.length };
  };

  // ---- 1. off by default ----
  const open = async () => {
    await button("Settings", true, 0); await sleep(700);
    await button("Advanced", true, 0); await show("Self-improvement", 15_000); await sleep(600);
  };
  await show("Main navigation");
  await open();
  await show("Self-improvement is off until the Owner enables it.");
  shot("01-off-by-default");
  assert.equal((await status()).control.enabled, false);
  const lookButtons = find((n: any) => n.AXRole === "AXButton" && [n.AXTitle, n.AXDescription].includes("Look for candidates"));
  assert(lookButtons.length > 0 && lookButtons.every((n: any) => n.AXEnabled === false), "Look for candidates is disabled while the engine is off");
  evidence.offByDefault = { enabled: false, lookForCandidatesDisabled: true };
  mark("The panel opened with the engine OFF (\"off until the Owner enables it\"); Look for candidates is disabled; nothing ran");
  await button("Enable", true, 0);
  await show("Self-improvement is enabled");
  assert.equal((await status()).control.enabled, true);
  mark("Enable was pressed in the window: the engine is on; no candidate exists and nothing activates by itself");

  // ---- 2. evidence to proposal ----
  const WEAK = "Developer missed a required validation step";
  const r1 = await qcRound(Alpha, "D18 task one", WEAK);
  const rBeta = await qcRound(Beta, "D18 beta task one", WEAK);
  await button("Look for candidates", true, 0); await sleep(1200);
  assert.equal((await status()).candidates.length, 0, "one finding per project is isolated noise: no candidate");
  shot("02-isolated-no-candidate");
  evidence.isolated = { alphaFindings: 1, betaFindings: 1, candidates: 0 };
  mark("Look for candidates was pressed with ONE verified finding in each of two projects: no candidate (an isolated finding is not a pattern)");
  const r2 = await qcRound(Alpha, "D18 task two", WEAK);
  const rBeta2 = await qcRound(Beta, "D18 beta task two", WEAK);
  await button("Look for candidates", true, 0);
  const cands = await poll("candidates appear", async () => { const s = await status(); return s.candidates.length >= 2 ? s : null; }, 20_000);
  const alphaC = cands.candidates.find((x: any) => x.projectPath === Alpha);
  const betaC = cands.candidates.find((x: any) => x.projectPath === Beta);
  assert(alphaC && betaC);
  const sources = (alphaC.evidence as any[]).map((e) => ({ source: e.source, sourceId: e.sourceId }));
  assert.equal(sources.length, 2);
  assert(sources.every((s) => s.source === "qc-review"));
  assert.deepEqual(sources.map((s) => s.sourceId).sort(), [r1.reviewId, r2.reviewId].sort(), "the candidate cites the two QC reviews");
  assert.equal(alphaC.status, "observed");
  await button("Look for candidates", true, 0); await sleep(1200);
  assert.equal((await status()).candidates.length, 2, "looking again does not duplicate a candidate");
  shot("03-candidates");
  evidence.candidate = { id: alphaC.id, status: alphaC.status, evidence: sources, fixtureReviewer: true, duplicatesAfterSecondLook: 0 };
  mark(`With a second verified finding per project, Look for candidates produced one candidate each; Alpha's cites its two QC reviews (${sources.map((s) => s.sourceId.slice(0, 8)).join(", ")}) as source; pressing it again created no duplicate`);
  void rBeta; void rBeta2;

  const isRow = (n: any) => n.AXRole === "AXButton" && [n.AXTitle, n.AXDescription].some((x: any) => typeof x === "string" && x.startsWith("developer · "));
  const selectCandidate = async (projectLabel: string, id: string, wantStatus: string) => {
    // The list rows show role and status; the detail pane names the project. Scroll each row into view, press it, and
    // keep the one whose detail names the wanted project.
    const labels = find(isRow).map((n: any) => [n.AXTitle, n.AXDescription].find((x: any) => typeof x === "string" && x.startsWith("developer · ")) as string);
    const seen = new Map<string, number>();
    for (const label of labels) {
      if (!label.endsWith(` · ${wantStatus}`)) continue;
      const occurrence = seen.get(label) ?? 0; seen.set(label, occurrence + 1);
      try { ax("focus-name", "AXButton", label); } catch { /* the scroll happens before the focus attempt */ }
      await sleep(500);
      await button(label, true, occurrence); await sleep(700);
      if (has(`developer · ${projectLabel}`)) return;
    }
    throw new Error(`candidate ${id} could not be selected`);
  };
  await selectCandidate(Alpha, alphaC.id, "observed");
  await button("Prepare draft", true, 0);
  await poll("draft prepared", async () => { const s = await status(); return s.candidates.find((x: any) => x.id === alphaC.id)?.status === "proposed" ? s : null; }, 20_000);
  await show("+ Required validation step:");
  shot("04-draft-diff");
  const proposed = (await status()).candidates.find((x: any) => x.id === alphaC.id);
  evidence.draft = { status: proposed.status, risk: proposed.risk, hypothesis: proposed.hypothesis, diffHead: proposed.diffText.split("\n").slice(0, 3) };
  mark("Prepare draft was pressed: the candidate is proposed; the window shows the instruction diff and a hypothesis labelled as not an established fact");

  // ---- 3. fair comparison ----
  assert.deepEqual((await status()).activeVersions, [], "nothing is active before the Owner acts");
  await button("Evaluate on authorized test", true, 0);
  const evaluated = await poll("evaluation finished", async () => { const s = await status(); const x = s.candidates.find((y: any) => y.id === alphaC.id); return x?.decision ? x : null; }, 240_000);
  assert.equal(evaluated.decision, "pass");
  assert.equal(evaluated.metrics.execution, "synthetic-driver");
  assert.equal(evaluated.metrics.inferenceCompleted, false);
  assert.deepEqual(evaluated.metrics.sampleSize, { fixtures: 2, training: 1, heldOut: 1 });
  assert.equal(evaluated.metrics.baselineVersion, 1);
  assert.equal(evaluated.metrics.candidateVersion, 2);
  await show("Fixture evaluation: 2 fixtures", 20_000);
  await show("Synthetic driver. This is not a provider pass.");
  await show("revision 1 compared with revision 2");
  shot("05-evaluated");
  evidence.evaluation = { decision: evaluated.decision, execution: evaluated.metrics.execution, inferenceCompleted: evaluated.metrics.inferenceCompleted, sampleSize: evaluated.metrics.sampleSize, baselineErrors: evaluated.metrics.baselineErrors, candidateErrors: evaluated.metrics.candidateErrors, revisions: [1, 2], quota: evaluated.metrics.quota };
  assert.deepEqual((await status()).activeVersions, [], "a passing evaluation activates nothing");
  mark("Evaluate on authorized test was pressed: the existing harness comparison ran the SAME two frozen tasks on revision 1 and revision 2 (fake driver, real offline Seatbelt bun test). Decision pass, 2 fixtures (1 training, 1 held-out), labelled \"Synthetic driver. This is not a provider pass.\" Still nothing active");

  // Missing evidence is not a win: Beta has no registered fixtures.
  await selectCandidate(Beta, betaC.id, "observed");
  await button("Prepare draft", true, 0);
  await poll("beta draft", async () => ((await status()).candidates.find((x: any) => x.id === betaC.id)?.status === "proposed" ? true : null), 20_000);
  await button("Evaluate on registered fixtures", true, 0);
  const inconclusive = await poll("beta evaluated", async () => { const x = (await status()).candidates.find((y: any) => y.id === betaC.id); return x?.decision ? x : null; }, 20_000);
  assert.equal(inconclusive.decision, "inconclusive");
  await button("Activate", true, 0); await sleep(1200);
  await show("did not pass", 10_000);
  assert.deepEqual((await status()).activeVersions, [], "an inconclusive candidate cannot activate");
  shot("06-inconclusive-refused");
  evidence.missingEvidence = { project: "Beta", decision: inconclusive.decision, sample: inconclusive.metrics?.sampleSize ?? null, activationRefusedInWindow: true };
  mark("Beta had no registered fixtures: Evaluate on registered fixtures was INCONCLUSIVE and Activate was refused in the window (\"did not pass\"); nothing is active");

  // ---- 4. Owner activation, use, keep ----
  await selectCandidate(Alpha, alphaC.id, "evaluated");
  await button("Activate", true, 0);
  const activeStatus = await poll("alpha active", async () => { const s = await status(); return s.activeVersions.length === 1 ? s : null; }, 20_000);
  assert.equal(activeStatus.activeVersions[0].projectPath, Alpha);
  assert.equal(activeStatus.activeVersions[0].version, 2);
  await show("D18Alpha", 10_000);
  shot("07-activated");
  mark("Activate was pressed by the Owner (policy: Full Autonomy without low-risk activation, so nothing could activate without this press): exactly one active version, revision 2, for Alpha only");

  const launch = async (project: string, title: string) => {
    const made = await api("POST", "/tasks", { title, prompt: "Add the missing check.", workdir: project, isolation: "none", column: "ready" });
    const id = (made.id ?? made.task?.id) as string;
    const started = await api("POST", `/tasks/${id}/start`);
    const runId = started.runId ?? (await api("GET", `/tasks/${id}`)).runId;
    await poll(`${title} user event`, async () => { const page = await api("GET", `/tasks/${id}/events/page?beforeId=999999999&limit=40`); return (page.events ?? page).some((e: any) => e.stream === "user") ? page : null; }, 30_000);
    const page = await api("GET", `/tasks/${id}/events/page?beforeId=999999999&limit=40`);
    const user = (page.events ?? page).find((e: any) => e.stream === "user");
    const prompt = typeof user.data === "string" ? user.data : JSON.stringify(user.data);
    return { id, runId, prompt, stored: (await api("GET", `/tasks/${id}`)).prompt };
  };
  const alphaRun = await launch(Alpha, "D18 launch after activation");
  const guidanceLine = alphaRun.prompt.split("\n").find((l: string) => l.startsWith('{"sha256"'));
  assert(guidanceLine, "the Alpha launch prompt carries the instruction snapshot");
  const guidance = JSON.parse(guidanceLine!);
  const versionRow = guidance.versions[0];
  assert.equal(versionRow.version, 2);
  assert.equal(versionRow.projectPath, Alpha);
  assert.equal(versionRow.content, proposed.proposedContent, "the prompt carries exactly the evaluated text");
  assert.equal(alphaRun.stored, "Add the missing check.", "the stored task prompt is unchanged");
  const gammaRun = await launch(Gamma, "D18 launch in an unrelated project");
  assert(!gammaRun.prompt.includes("Owner-approved instruction versions"), "another project receives nothing");
  const afterLaunch = await status();
  const launchRow = afterLaunch.launches.find((l: any) => l.runId === alphaRun.runId);
  assert(launchRow && launchRow.versions.some((v: any) => v.version === 2), "the run's provenance records revision 2");
  await show("Launches that received a skill snapshot");
  shot("08-launch-recorded");
  evidence.use = { runId: alphaRun.runId, snapshotSha: guidance.sha256, versionInPrompt: versionRow.version, promptCarriesEvaluatedTextExactly: true, storedPromptUnchanged: true, unrelatedProjectHasNoGuidance: true, provenance: launchRow };
  mark(`A later Alpha launch (run ${String(alphaRun.runId).slice(0, 8)}) received exactly revision 2 in its actual prompt (snapshot ${guidance.sha256.slice(0, 12)}…) and recorded it; the stored task prompt is unchanged; the launch in Gamma received nothing`);

  await button("Keep this version", true, 0);
  await poll("retained", async () => ((await status()).candidates.find((x: any) => x.id === alphaC.id)?.status === "retained" ? true : null), 20_000);
  mark("Keep this version was pressed: the candidate is retained and revision 2 stays active");

  // ---- 5. a regressing candidate on top of revision 2 ----
  const r3 = await qcRound(Alpha, "D18 task three", "Developer skipped the validation again");
  const r4 = await qcRound(Alpha, "D18 task four", "Developer skipped the validation again");
  await button("Look for candidates", true, 0);
  const second = await poll("second candidate", async () => { const s = await status(); return s.candidates.find((x: any) => x.projectPath === Alpha && x.id !== alphaC.id) ?? null; }, 20_000);
  assert.equal(second.currentVersion, 2, "the new candidate builds on the active revision, not on the baseline");
  assert.equal(second.currentContent, proposed.proposedContent);
  assert.deepEqual((second.evidence as any[]).map((e) => e.sourceId).sort(), [r3.reviewId, r4.reviewId].sort());
  const weaker = String(proposed.proposedContent).replace("Required validation step:", "Validation note:");
  const sup = await api("POST", `/api/self-improvement/candidates/${second.id}/propose`, { content: weaker });
  assert.equal(sup.candidate.status, "proposed");
  assert.equal(sup.candidate.risk, "high");
  mark("Seeded: two more fixture QC rounds produced a second candidate on top of revision 2, and the Owner-supplied weaker text (the validation heading renamed) was proposed through the API");
  await button("Look for candidates", true, 0); await sleep(1200); // reloads the panel after the API-seeded proposal
  await selectCandidate(Alpha, second.id, "proposed");
  await button("Evaluate on authorized test", true, 0);
  const regressed = await poll("regression evaluated", async () => { const x = (await status()).candidates.find((y: any) => y.id === second.id); return x?.decision ? x : null; }, 240_000);
  assert.equal(regressed.decision, "fail");
  assert.equal(regressed.status, "rejected");
  assert(regressed.metrics.candidateErrors > regressed.metrics.baselineErrors);
  await button("Activate", true, 0); await sleep(1200);
  await show("did not pass", 10_000);
  const stillV2 = await status();
  assert.deepEqual(stillV2.activeVersions.map((v: any) => v.version), [2]);
  shot("09-regression-rejected");
  evidence.regression = { decision: regressed.decision, status: regressed.status, baselineErrors: regressed.metrics.baselineErrors, candidateErrors: regressed.metrics.candidateErrors, sampleSize: regressed.metrics.sampleSize, revisions: [regressed.metrics.baselineVersion, regressed.metrics.candidateVersion], activationRefusedInWindow: true, activeAfter: stillV2.activeVersions };
  mark("Evaluate on authorized test was pressed for the weaker text: the same frozen tasks passed on revision 2 and FAILED on revision 3 (decision fail, rejected); Activate was refused in the window; revision 2 is still the only active version");

  // ---- 6. rollback, history, quit and reopen ----
  await selectCandidate(Alpha, alphaC.id, "retained");
  await button("Roll back", true, 0);
  await poll("rolled back", async () => { const s = await status(); const x = s.candidates.find((y: any) => y.id === alphaC.id); return x?.status === "rolled_back" && s.activeVersions.length === 0 ? s : null; }, 20_000);
  const afterRoll = await launch(Alpha, "D18 launch after rollback");
  assert(!afterRoll.prompt.includes("Owner-approved instruction versions"), "after rolling back the only activation the next run receives no instruction text");
  assert(!afterRoll.prompt.includes("Implement the requested change and describe the result."), "the never-approved baseline text is not injected");
  const rollStatus = await status();
  const oldLaunch = rollStatus.launches.find((l: any) => l.runId === alphaRun.runId);
  assert.deepEqual(oldLaunch.versions, launchRow.versions, "the earlier run keeps its recorded revision");
  await show("Regression warnings");
  shot("10-rolled-back");
  evidence.rollback = { candidate: "rolled_back", activeAfter: rollStatus.activeVersions, nextRunHasGuidance: false, earlierRunProvenanceUnchanged: true, versionsKept: true };
  mark("Roll back was pressed in the window: no version is active; the next Alpha run received no instruction text and not the never-approved baseline; the earlier run still records revision 2");

  const before = await counts();
  const beforeStatus = await status();
  await down(); await up(); await show("Main navigation");
  await open();
  await show("Self-improvement is enabled");
  await show("Regression warnings");
  shot("11-after-restart");
  const reopened = await status();
  const after = await counts();
  assert.deepEqual(after, before, "nothing ran by itself across the restart");
  assert.deepEqual(reopened.candidates.map((x: any) => [x.id, x.status, x.decision]), beforeStatus.candidates.map((x: any) => [x.id, x.status, x.decision]));
  assert.deepEqual(reopened.activeVersions, []);
  assert.deepEqual(reopened.launches.map((l: any) => [l.runId, l.snapshotSha]), beforeStatus.launches.map((l: any) => [l.runId, l.snapshotSha]));
  assert.equal(reopened.control.enabled, true);
  evidence.restart = { before, after, candidates: reopened.candidates.map((x: any) => ({ id: x.id.slice(0, 8), status: x.status, decision: x.decision })), launches: reopened.launches.length };
  mark("Quit and reopen: the same candidates, statuses, decisions and launch records; counts of tasks, runs, candidates and launches are unchanged; nothing restarted by itself");

  // ---- owner paths ----
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  evidence.ownerPaths = { unchanged: Object.keys(ownerBefore).filter((k) => ownerBefore[k] === ownerAfter[k]).length, changed: Object.keys(ownerBefore).filter((k) => ownerBefore[k] !== ownerAfter[k]) };
  evidence.result = "pass";
  c.save();
  void seek; void matching;
}
