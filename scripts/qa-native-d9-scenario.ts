/**
 * Direction 9 (Provider integrations): what a launch will actually run, in the packaged ForgeOrbitQA window.
 * Fake drivers, disposable profile, no provider, no login, no model call.
 *
 * QA isolation limit (stated, not worked around): the packaged QA guard accepts only the inert QA stub or /bin/echo as an
 * executable, and the inert stub is exempt from the version floor. So in the window the executables differ by PATH and by
 * SOURCE, a no-version executable (/bin/echo) shows the unreadable-version state as a fixture warning, a removed executable
 * and a moved profile directory block, and Cursor shows its contract block. A version that parses BELOW the minimum, and an
 * unreadable version under a real driver, cannot be reproduced here; they are asserted on the backend (src/bun/launch-target.test.ts).
 *
 * Window (PN): Settings matrix, Accounts card (Check, stale registration), launch review for three executables.
 * Seeded through the API of the isolated profile (prerequisites): the project, three alias harnesses, one registered profile,
 * one Developer employee, one Ready task assigned to them.
 */
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, absent, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, clickByPosition } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "Settings matrix, Accounts card with Check and a stale registration, the launch review for three executables",
    "PN records read from the packaged core (API of the same isolated profile)": "attempts and runs (none created), the profile and harness rows",
    "Not reproducible in the window (QA guard)": "a version below the minimum, an unreadable version under a real driver; asserted in src/bun/launch-target.test.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const Work = join(runtime, "projects/D9");
  const stub = join(runtime, "codex");
  const alt = join(runtime, "codex-alt"), gone = join(runtime, "codex-gone");
  const profileDir = join(runtime, "home/profile-a");

  // ---- prerequisites (API of the isolated profile) ----
  await up();
  const fresh = (await api("GET", "/harnesses")).harnesses.every((h: any) => h.id !== "codex-alt");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  let employeeId: string, taskId: string, accountId: string;
  if (fresh) {
    mkdirSync(Work, { recursive: true }); mkdirSync(profileDir, { recursive: true, mode: 0o700 }); chmodSync(profileDir, 0o700);
    writeFileSync(join(profileDir, "synthetic-authenticated"), "subject-a");
    for (const f of [alt, gone]) { copyFileSync(stub, f); chmodSync(f, 0o755); }
    await api("POST", "/projects", { path: Work, name: "D9 Work" });
    await api("PATCH", "/harnesses/codex", { enabled: true });
    for (const [id, label, bin] of [["codex-alt", "Codex (alternate executable)", alt], ["codex-echo", "Codex (no version output)", "/bin/echo"], ["codex-gone", "Codex (executable removed)", gone]]) {
      await api("POST", "/harnesses", { id, kind: "codex", label, bin });
      await api("PATCH", `/harnesses/${id}`, { enabled: true });
    }
    const profile = await api("POST", "/account-core/codex-profiles", { displayName: "Profile A", directory: profileDir });
    accountId = profile.accountId;
    await api("PATCH", `/harnesses/${profile.harnessId}`, { bin: alt });
    employeeId = (await api("POST", "/employees", { name: "D9 Developer", jobTitle: "Developer", projectPath: Work })).id;
    const made = await api("POST", "/tasks", { title: "D9 launch target task", prompt: "Write the note.", workdir: Work, agent: "codex", model: "gpt-6.1-sol", isolation: "none", column: "backlog" });
    taskId = (made.task ?? made).id;
    await api("POST", `/tasks/${taskId}/admit-inbox`);
    await api("PATCH", `/tasks/${taskId}`, { column: "ready" });
    await api("POST", "/task-assignments", { taskId, employeeId });
    await down(); await up();
  } else {
    const tasks = await api("GET", "/tasks");
    taskId = tasks.find((t: any) => t.title === "D9 launch target task").id;
    accountId = (await api("GET", "/account-core/codex-profiles"))[0].accountId;
    employeeId = (await api("GET", `/task-assignments/task?taskId=${taskId}`)).assignment.employeeId;
  }
  await show("Main navigation");
  const runsOf = async () => (await api("GET", `/tasks/${taskId}/runs`)).length;
  const attemptsOf = async () => (await api("GET", `/employee-execution/attempts?employeeId=${employeeId}`)).attempts.length;
  assert.equal(await runsOf(), 0);
  mark("Seeded through the API of the isolated profile: one project, three alias harnesses (alternate stub, /bin/echo, a stub that is removed later), one registered Codex profile, one Developer, one Ready assigned task. No run exists");

  // ---- 1. Settings: the matrix, read passively ----
  await button("Settings", true, 0);
  await button("AI providers and accounts", true);
  await show("What would run", 15_000);
  await sleep(800);
  assert(has("Blocked by the provider contract"), "Cursor is shown as blocked by the provider contract");
  assert(has("environment override of the app"), "the built-in harness shows where its executable name came from");
  assert(has("not checked yet"), "an unread version is 'not checked', not a number");
  assert(has("It does not show that you are signed in"), "a compatible result says what it does not prove");
  shot("01-settings-matrix");
  const matrix = (await api("GET", "/harnesses")).runtimeReadiness;
  evidence.matrix = matrix.map((r: any) => ({ provider: r.providerId, code: r.launchTarget?.code ?? null, verdict: r.launchTarget?.verdict ?? null, path: r.launchTarget?.executable.path ?? null, source: r.launchTarget?.executable.source ?? null, version: r.launchTarget?.version.state ?? null, minimumEnforced: r.launchTarget?.minimumEnforced ?? null }));
  assert.equal(matrix.find((r: any) => r.providerId === "cursor").launchTarget.code, "contract-blocked");
  assert.equal(matrix.find((r: any) => r.providerId === "claude-code").launchTarget.minimumEnforced, false);
  mark("Settings → AI providers: the matrix names the executable and where it came from, the version as 'not checked yet' (opening it starts nothing), Cursor as blocked by the provider contract; no minimum is enforced for Claude Code");

  // ---- 2. Accounts: the profile card, Check, stale registration ----
  await show("Profile A", 15_000);
  try { ax("focus-name", "AXButton", "Check authentication"); } catch { /* scrolls first */ }
  await sleep(600);
  assert(has("set on this harness"), "the profile's own executable is shown with its source");
  assert(has(alt), "the profile's executable path is the alternate stub, not the first binary on the machine");
  shot("02-profile-card");
  const before = (await api("GET", "/account-core/codex-profiles"))[0].launchTarget;
  assert.equal(before.version.state, "not-checked"); assert.equal(before.executable.path, alt); assert.equal(before.executable.source, "harness-executable");
  await button("Check authentication", true, 0);
  await poll("version read by the Owner's Check", async () => ((await api("GET", "/account-core/codex-profiles"))[0].launchTarget.version.state === "read" ? true : null), 20_000);
  await sleep(800);
  const after = (await api("GET", "/account-core/codex-profiles"))[0].launchTarget;
  evidence.profileCheck = { before: before.version.state, after: after.version.state, version: after.version.parsed, code: after.code };
  shot("03-profile-checked");
  mark(`The Owner's Check on the profile read the version of that profile's own executable (${after.version.parsed}); before it the card said "not checked"`);
  renameSync(profileDir, `${profileDir}-moved`); mkdirSync(profileDir, { recursive: true, mode: 0o700 }); chmodSync(profileDir, 0o700);
  await button("Check authentication", true, 0);
  await show("Registration is out of date", 15_000);
  assert(!has("Update this tool"), "a stale registration is not worded as an upgrade");
  shot("04-profile-stale");
  const stale = (await api("GET", "/account-core/codex-profiles"))[0].launchTarget;
  evidence.profileStale = { code: stale.code, verdict: stale.verdict };
  assert.equal(stale.code, "registration-stale");
  rmSync(profileDir, { recursive: true, force: true }); renameSync(`${profileDir}-moved`, profileDir);
  mark("The profile directory was replaced: the card says the registration is out of date and offers re-registration, not an upgrade. The directory was then restored");
  ax("key", "53", "0"); await sleep(800);

  // ---- 3. The launch review for three executables ----
  const openTask = async () => {
    await button("D9 Work", false, 0); await sleep(600);
    await button("Tasks", true, 1).catch(() => undefined); await sleep(900);
    await button("D9 launch target task", true, 0); await show("EMPLOYEE EXECUTION", 15_000);
  };
  const choose = async (id: string) => {
    if (find(hasText("Prepare Execution")).length === 0) await button("EMPLOYEE EXECUTION");
    await show("Prepare Execution", 15_000);
    const order = (await api("GET", "/harnesses")).harnesses.map((h: any) => h.id);
    const index = order.indexOf(id) + 1;
    assert(index > 0, `harness ${id} is registered`);
    await button("Harness", false, 0);
    await sleep(700);
    for (let i = 0; i < 14; i++) { ax("key", "126", "0"); await sleep(70); }   // the menu opens on the current choice; go to the top first
    for (let i = 0; i < index; i++) { ax("key", "125", "0"); await sleep(150); }
    ax("key", "36", "0"); await sleep(900);
  };
  await openTask();

  // 3a. compatible fixture (alternate stub; source: set on the harness)
  await choose("codex-alt");
  await button("Prepare Execution");
  await show("Prepared for review", 25_000);
  await button("Run Employee");
  await show("Review and confirm run", 25_000);
  await sleep(900);
  assert(has("What would run"), "the review names what would run");
  assert(has(alt), "the review shows the alternate executable the harness will run");
  assert(has("set on this harness"));
  assert(has("Confirm and start"), "the start still needs its own confirmation");
  shot("05-review-compatible");
  const attempts1 = (await api("GET", `/employee-execution/attempts?employeeId=${employeeId}`)).attempts;
  evidence.reviewCompatible = { path: attempts1[0].review.launchTarget.executable.path, source: attempts1[0].review.launchTarget.executable.source, code: attempts1[0].review.launchTarget.code, runId: attempts1[0].runId ?? null };
  assert.equal(await runsOf(), 0);
  mark("Launch review, compatible fixture: the review names the alternate executable and its source and still asks for its own confirmation; no run exists");
  await button("Cancel — start nothing", true); await sleep(1000);

  // 3b. no-version executable (/bin/echo), fixture driver: shown, not a pass
  await choose("codex-echo");
  await button("Prepare Execution");
  await show("Prepared for review", 25_000);
  await button("Run Employee");
  await show("Review and confirm run", 25_000);
  await sleep(900);
  assert(has("Version could not be read"), "an unreadable version is named");
  assert(has("recorded fixture"), "under the fixture driver it is a warning that says nothing queried the CLI");
  shot("06-review-unreadable-fixture");
  const attempts2 = (await api("GET", `/employee-execution/attempts?employeeId=${employeeId}`)).attempts;
  const echoReview = attempts2.find((a: any) => a.review.launchTarget?.executable.path === "/bin/echo");
  evidence.reviewUnreadable = { code: echoReview?.review.launchTarget.code, verdict: echoReview?.review.launchTarget.verdict };
  assert.equal(echoReview.review.launchTarget.code, "version-unreadable");
  mark("Launch review, executable that prints no version: the review states it as unverified with a fixture warning, not as a pass");
  await button("Cancel — start nothing", true); await sleep(1000);

  // 3c. removed executable: refused before any review, any process
  rmSync(gone);
  const reviewsBefore = await attemptsOf();
  await choose("codex-gone");
  await button("Prepare Execution");
  await sleep(2500);
  await button("Run Employee").catch(() => undefined);
  await sleep(2500);
  assert(!has("Review and confirm run"), "no review opens for a removed executable");
  assert(has("is not available") && has("not found"), "the window says the executable was not found");
  shot("07-removed-executable-refused");
  const pendingAfter = (await api("GET", `/employee-execution/attempts?employeeId=${employeeId}`)).attempts.filter((a: any) => a.status === "awaiting-approval").length;
  assert.equal(pendingAfter, 0, "no pending review was created for the removed executable");
  assert.equal(await runsOf(), 0, "no run exists");
  evidence.removed = { reviewsBefore, runs: 0, pendingReviews: pendingAfter, windowTextHasNotAvailable: has("not available") || has("not found") };
  mark("Launch review, removed executable: the window opens no review and the core holds no pending review and no run");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)])), ownerBefore, "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  save();
  void absent; void existsSync;
}
