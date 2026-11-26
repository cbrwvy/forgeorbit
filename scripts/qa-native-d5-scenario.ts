/**
 * Direction 5 offline acceptance (project Stop, Emergency Stop, Stop on a run, recovery), driven through the packaged
 * ForgeOrbitQA window. Fake drivers, disposable profile, no provider, no real process.
 *
 * Seeded through the API of the isolated profile: two projects (Alpha, Beta) and their tasks. A task whose prompt carries
 * the fake monitor marker stays live ("held") after its turn, which is how a run is kept in flight without a process.
 * Done in the window: run a task, stop the project while it is live, try to start more work in the stopped project, run
 * work in the other project, press the title-bar Emergency Stop, stop one live run on its own, quit with the stop
 * conditions on, reopen the same profile, resume the project, lift the Emergency Stop (cancel first).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, absent, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, activate } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  // The app window only (by window id): a region capture would include whatever else is on the screen.
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  const Alpha = join(runtime, "projects/Alpha"); mkdirSync(Alpha, { recursive: true });
  const Beta = join(runtime, "projects/Beta"); mkdirSync(Beta, { recursive: true });
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  const has = (part: string) => find(hasText(part)).length > 0;
  const names = (n: any) => [n.AXTitle, n.AXDescription].filter((x: any) => typeof x === "string" && x);
  const HOLD = "__agetor_fake_claude_monitor__:600000";

  const quit = async () => {
    ax("key", "12", "1048576");
    // With work in flight the app asks first; "Quit anyway" is the Owner's own confirmation.
    const asked = await poll("quit question or exit", () => {
      try { process.kill(state.launcherPid, 0); } catch { return "exited"; }
      return find(hasText("Quit ForgeOrbit?")).length ? "asked" : null;
    }, 10_000).catch(() => "none");
    if (asked === "asked") { evidence.quitAsked = true; await button("Quit anyway", true); }
    await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 20_000).catch(async () => { await down(); });
    await sleep(1500);
  };

  // ---- prerequisites (API of the isolated profile) ----
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Alpha, name: "D5 Alpha" });
  await api("POST", "/projects", { path: Beta, name: "D5 Beta" });
  const mk = (title: string, workdir: string, prompt: string) => api("POST", "/tasks", { title, prompt, workdir, isolation: "none", column: "ready" });
  const alphaLive = await mk("Alpha live", Alpha, `Keep a background monitor open. ${HOLD}`);
  const alphaQueued = await mk("Alpha queued", Alpha, "Write the queued fixture note.");
  const betaLive = await mk("Beta live", Beta, `Keep a background monitor open. ${HOLD}`);
  const betaQueued = await mk("Beta queued", Beta, "Write the second fixture note.");
  await down(); await up();
  await show("Main navigation");

  const taskById = async (id: string) => (await api("GET", `/tasks/${id}`));
  const runCount = async (id: string) => (await api("GET", `/tasks/${id}/runs`)).length;
  const lifecycle = async (dir: string) => (await api("GET", `/projects/lifecycle?path=${encodeURIComponent(dir)}`)).lifecycle;
  const emergency = async () => (await api("GET", "/api/autonomy/status")).emergency;
  const counts = async () => ({ alphaLive: await runCount(alphaLive.id), alphaQueued: await runCount(alphaQueued.id), betaLive: await runCount(betaLive.id), betaQueued: await runCount(betaQueued.id) });
  const cardButton = async (title: string, label: string) => {
    const node = await poll(`"${label}" on the "${title}" card`, () => {
      const nodes = find(() => true);
      const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names(n).includes(title) && n.frame && n.frame.width < 400);
      if (!card) return null;
      const f = card.frame;
      return nodes.find((n: any) => n.AXRole === "AXButton" && names(n).includes(label) && n.frame
        && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height) ?? null;
    }, 15_000);
    activate(node); await sleep(600);
  };
  const openProject = async (name: string) => { await button(name, false, 0); await sleep(800); await button("Tasks", true, 1).catch(() => undefined); await sleep(800); };
  const heldLive = (id: string) => poll(`${id} is live`, async () => { const t = await taskById(id); return t.column === "running" ? t : null; }, 20_000);

  // ---- 1. Alpha: run a task that stays live ----
  await openProject("D5 Alpha");
  await show("Open for work");
  await cardButton("Alpha live", "Run");
  await heldLive(alphaLive.id);
  const running0 = await lifecycle(Alpha);
  assert.equal(running0.state, "running");
  assert.equal(running0.launchesBlocked, false);
  mark("Alpha: ran 'Alpha live' from its card; it stays live (a held background monitor), project reads Open for work");

  // ---- 2. Stop Alpha while the task is live: Stopping, not Paused ----
  await button("Stop new work", false);
  await show("Stopping — 1 still finishing", 15_000);
  const draining = await lifecycle(Alpha);
  assert.equal(draining.state, "draining");
  assert.equal(draining.activeExecutions, 1);
  assert.equal(draining.launchesBlocked, true);
  assert.equal((await taskById(alphaLive.id)).column, "running", "Stop does not stop the live task");
  assert(!has("Paused — no new AI runs start"), "a draining project is never shown as Paused");
  shot("01-alpha-stopping");
  evidence.alphaDraining = { state: draining.state, activeExecutions: draining.activeExecutions, shown: "Stopping — 1 still finishing" };
  mark("Alpha: 'Stop new work' shows 'Stopping — 1 still finishing' (never Paused); the live task keeps running and is not cancelled");

  // ---- 3. New work in Alpha is refused with the reason and creates no run ----
  await cardButton("Alpha queued", "Run");
  await show("Project Stop was requested", 15_000);
  assert.equal(await runCount(alphaQueued.id), 0, "the refused start created no run");
  assert.equal((await taskById(alphaQueued.id)).column, "ready");
  shot("02-alpha-start-refused");
  mark("Alpha: Run on 'Alpha queued' was refused with the project-stop reason; no run exists and the task is still Ready");

  // ---- 4. Beta is not affected ----
  await openProject("D5 Beta");
  await show("Open for work");
  assert.equal((await lifecycle(Beta)).state, "running");
  await cardButton("Beta live", "Run");
  await heldLive(betaLive.id);
  mark("Beta: still Open for work and 'Beta live' ran normally while Alpha was stopping");

  // ---- 5. Emergency Stop (company level): it does not stop what the Owner started ----
  await button("Emergency stop", true, 0);
  await show("Stopped", 15_000);
  const e1 = await poll("emergency reports left running", async () => { const e = await emergency(); return e.active && e.leftRunning === 2 ? e : null; }, 15_000);
  assert.equal((await taskById(alphaLive.id)).column, "running");
  assert.equal((await taskById(betaLive.id)).column, "running");
  assert.equal((await lifecycle(Alpha)).state, "draining");
  assert.equal((await lifecycle(Beta)).state, "running");
  await poll("the title bar names what was not stopped", () => find((n: any) => n.AXRole && names(n).concat([n.AXValue]).some((x: any) => typeof x === "string" && x.includes("Not stopped: 2 running task"))).length ? true : null, 15_000);
  shot("03-emergency-stop-left-running");
  evidence.emergency = { active: e1.active, leftRunning: e1.leftRunning, outstanding: e1.outstanding };
  mark("Emergency Stop: one click; the title bar says 2 running tasks you started yourself were not stopped; both tasks keep running; Alpha stays Stopping and Beta stays Open — the controls are separate");

  // ---- 6. Stop one live run on its own ----
  await cardButton("Beta live", "Stop: Beta live");
  await poll("Beta live no longer running", async () => ((await taskById(betaLive.id)).column !== "running" ? true : null), 20_000);
  await poll("the not-stopped count follows", async () => ((await emergency()).leftRunning === 1 ? true : null), 20_000);
  assert.equal((await taskById(alphaLive.id)).column, "running", "Stop on one run touches only that run");
  assert.equal((await lifecycle(Beta)).state, "running", "stopping a run does not stop the project");
  mark("Stop on 'Beta live': only that run stopped, the count of not-stopped tasks fell to 1, Alpha's task is untouched, Beta stays Open");

  // ---- 7. Quit with every stop condition on, reopen the same profile ----
  const beforeQuit = { counts: await counts(), alpha: await lifecycle(Alpha), emergency: await emergency() };
  evidence.beforeQuit = { counts: beforeQuit.counts, alphaState: beforeQuit.alpha.state, emergencyActive: beforeQuit.emergency.active };
  await quit();
  mark(`Quit (Cmd+Q) while Alpha was Stopping, its task live, and the Emergency Stop on (${evidence.quitAsked ? "the app asked first; the Owner confirmed" : "no confirmation dialog appeared in this build"})`);
  await up();
  await show("Main navigation");
  const after = { counts: await counts(), alpha: await lifecycle(Alpha), beta: await lifecycle(Beta), emergency: await emergency() };
  assert.deepEqual(after.counts, beforeQuit.counts, "nothing resumed, relaunched or duplicated across the restart");
  assert.equal(after.emergency.active, true, "the Emergency Stop survived the restart");
  assert.equal(after.beta.state, "running");
  assert.equal((await taskById(alphaQueued.id)).column, "ready");
  // The QA package's tmux stub answers "present" for every session, so boot reconciliation re-arms the held task and it
  // is genuinely still live: the project must keep reading Stopping, exactly as persisted. (The path where the session is
  // gone and the drain settles on its own is the backend test, `run-stop-orphan.test.ts`.)
  assert.equal(after.alpha.state, "draining");
  assert.equal(after.alpha.activeExecutions, 1);
  await openProject("D5 Alpha");
  await show("Stopping — 1 still finishing", 20_000);
  assert(!has("Paused — no new AI runs start"), "a draining project is not shown as Paused after a restart");
  assert(!has("Resume work"), "Resume is not offered while the project is still stopping");
  await show("Stopped", 10_000);
  shot("04-reopened-still-stopping-emergency-on");
  evidence.afterReopen = { counts: after.counts, alphaState: after.alpha.state, alphaActive: after.alpha.activeExecutions, betaState: after.beta.state, emergencyActive: after.emergency.active };
  mark("Reopened the same profile: Alpha still shows 'Stopping — 1 still finishing' (its persisted state, with its task re-attached and live), Beta is Open, the Emergency Stop is still on, Resume is not offered, and no run was created");

  // ---- 7b. The Owner stops the last live run: the drain settles to Paused, and only then is Resume offered ----
  await cardButton("Alpha live", "Stop: Alpha live");
  await show("Paused — no new AI runs start", 30_000);
  assert.equal((await lifecycle(Alpha)).state, "paused");
  assert.equal((await lifecycle(Alpha)).activeExecutions, 0);
  assert.equal((await runCount(alphaQueued.id)), 0);
  shot("04b-alpha-paused-after-last-run-stopped");
  mark("Alpha: stopping its last live run settled the drain to 'Paused — no new AI runs start'; Resume work is now offered");
  after.counts = await counts();

  // ---- 8. Resume Alpha: admission reopens, nothing starts, the Emergency Stop stays ----
  await button("Resume work", false);
  await show("Open for work", 15_000);
  assert.equal((await lifecycle(Alpha)).state, "running");
  assert.equal((await emergency()).active, true, "resuming a project does not lift the Emergency Stop");
  await sleep(1500);
  assert.deepEqual(await counts(), after.counts, "resuming a project starts nothing");
  mark("Alpha: 'Resume work' reopens admission only; the Emergency Stop is still on and no run was created");

  // ---- 9. Lift the Emergency Stop: ask first, Cancel keeps it, then lift; nothing starts ----
  await button("Resume…", false);
  await show("Lift the emergency stop?", 10_000);
  await button("Cancel", true);
  await sleep(600);
  assert.equal((await emergency()).active, true, "Cancel kept the Emergency Stop on");
  await button("Resume…", false);
  await show("Lift the emergency stop?", 10_000);
  await button("Lift emergency stop", true);
  await poll("emergency lifted", async () => ((await emergency()).active === false ? true : null), 10_000);
  await sleep(1500);
  assert.deepEqual(await counts(), after.counts, "lifting the Emergency Stop starts nothing");
  assert.equal((await lifecycle(Alpha)).state, "running");
  assert.equal((await taskById(alphaQueued.id)).column, "ready");
  shot("05-emergency-lifted-nothing-started");
  mark("Lifting the Emergency Stop asked first (Cancel kept it), then cleared it; no run was created and the queued tasks are still Ready");

  evidence.result = "pass";
  const before = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)])), before, "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  save();
}
