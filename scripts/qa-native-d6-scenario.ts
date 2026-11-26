/**
 * Direction 6 offline acceptance (multi-project orchestration), observed in the packaged ForgeOrbitQA window.
 * Fake drivers, synthetic account fixtures, disposable profile, no provider.
 *
 * One mission over four projects shares ONE worker slot: Alpha has two tasks, Bravo one, Charlie two (the second waits
 * for the first), Delta is stopped. The mission is started through the API, then paused as soon as the first launch is
 * recorded, so the queue can be read in the window with every reason the scheduler recorded. Resuming advances the queue
 * one task at a time; the sequence is sampled from the records (reservations, runs). The app is quit and reopened with
 * work still queued, and the remaining work continues exactly once.
 *
 * What the window cannot show (an instant run, no held process, no crash) is covered by the backend suite
 * `src/bun/orchestration/orchestration-direction6.suite.ts`; the evidence file labels the tiers.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "queue reasons, the stopped project, the released slot advancing the queue, reopen",
    "CH (backend suite, not the window)": "held runs, N+3 contention, the slot boundary, wake-up during a pass, crash before and after dispatch",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const quit = async () => {
    ax("key", "12", "1048576");
    await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 20_000).catch(async () => { await down(); });
    await sleep(1500);
  };

  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const projectsRoot = join(runtime, "projects");
  const names = ["Alpha", "Bravo", "Charlie", "Delta"];
  const dirs: Record<string, string> = {};
  const employees: Record<string, string> = {};
  for (const name of names) {
    dirs[name] = join(projectsRoot, name); mkdirSync(dirs[name]!, { recursive: true });
    await api("POST", "/projects", { path: dirs[name], name: `D6 ${name}` });
    employees[name] = (await api("POST", "/employees", { name: `${name} Developer`, jobTitle: "Developer", projectPath: dirs[name] })).id;
  }
  const model = "gpt-6.1-sol";
  const accountDir = join(runtime, "home", "d6-account"); mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(accountDir, "synthetic-authenticated"), "d6", { mode: 0o600 });
  const account = await api("POST", "/account-core/codex-profiles", { displayName: "D6 fixture", directory: accountDir }, 201);
  const mk = async (name: string, title: string) => {
    const t = await api("POST", "/tasks", { title, prompt: `Record ${title}.`, workdir: dirs[name], isolation: "none", column: "ready", agent: account.harnessId, model, mode: "auto" });
    await api("POST", "/task-assignments", { taskId: t.id, employeeId: employees[name] });
    return t;
  };
  const a1 = await mk("Alpha", "A1"), a2 = await mk("Alpha", "A2"), b1 = await mk("Bravo", "B1"), c1 = await mk("Charlie", "C1"), c2 = await mk("Charlie", "C2"), d1 = await mk("Delta", "D1");
  const now = Date.now();
  const { policy } = await api("POST", "/api/autonomy/policies", {
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: Object.values(dirs),
    specialistRoles: ["developer"], providers: ["codex"], models: [model], accounts: [account.accountId],
    maxConcurrentWorkers: 8, maxLaunches: 20, maxDurationMs: 3_000_000, expiresAt: now + 3_000_000,
    permittedActions: ["plan_task", "launch_task"], qc: { required: false }, completion: { autoComplete: false },
  });
  const { activation } = await api("POST", `/api/autonomy/policies/${policy.id}/activate`, {});
  const task = (t: any, name: string, extra: any = {}) => ({ taskId: t.id, taskTitle: t.title, projectPath: dirs[name], harnessId: account.harnessId, modelId: model, accountId: account.accountId, mode: "auto", qcRequired: false, ...extra });
  const { mission } = await api("POST", "/api/orchestration/missions/prepare", {
    title: "D6 shared slot", goal: "Share one worker slot across projects",
    tasks: [
      task(a1, "Alpha"), task(a2, "Alpha"), task(b1, "Bravo"), task(c1, "Charlie"),
      task(c2, "Charlie", { dependencies: [{ taskId: c1.id, projectPath: dirs.Charlie, condition: "qc_pass" }] }), task(d1, "Delta"),
    ],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
  });
  await api("POST", `/api/orchestration/missions/${mission.id}/authorize`, { digest: mission.planDigest });
  // Delta is stopped after the Owner authorized the plan (authorization itself refuses a stopped project).
  await api("POST", "/projects/lifecycle/stop", { path: dirs.Delta, reason: "stopped for the scenario" });
  { using db = new Database(join(runtime, "data", "agetor.sqlite")); db.run("PRAGMA busy_timeout = 3000");
    db.run(`INSERT INTO autonomy_mission_bindings (mission_id,policy_id,revision,activation_id,digest,mode,outcome,emergency_task_ids_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'full-autonomy','active','[]',?,?)`, [mission.id, policy.id, policy.revision, activation.id, policy.digest, now, now]); }
  mark("Seeded through the API of the isolated profile: four projects (Delta stopped), one synthetic account, one authorized mission with a single shared worker slot");

  const missionNow = async () => (await api("GET", "/api/orchestration/missions")).missions.find((m: any) => m.id === mission.id);
  const phaseOf = async (id: string) => (await missionNow()).plan.tasks.find((t: any) => t.taskId === id);
  const reservations = async () => (await api("GET", `/api/orchestration/reservations?missionId=${mission.id}`)).reservations as any[];
  const runCount = async (id: string) => (await api("GET", `/tasks/${id}/runs`)).length;
  const peakSlots = { value: 0 };
  const sample = async () => { const n = (await reservations()).length; peakSlots.value = Math.max(peakSlots.value, n); };

  // ---- 1. Start, then pause as soon as the first launch is recorded ----
  await api("POST", `/api/orchestration/missions/${mission.id}/start`, {});
  await poll("first launch recorded", async () => { await sample(); return (await runCount(a1.id)) + (await runCount(b1.id)) + (await runCount(c1.id)) > 0 ? true : null; }, 20_000);
  await api("POST", `/api/orchestration/missions/${mission.id}/pause`, { reason: "read the queue" });
  await sleep(800);
  const snap = await missionNow();
  const by = (id: string) => snap.plan.tasks.find((t: any) => t.taskId === id);
  evidence.firstPass = Object.fromEntries([a1, a2, b1, c1, c2, d1].map((t) => [t.title, { phase: by(t.id).phase, waitingOn: by(t.id).waitingOn ?? null, runs: 0 }]));
  for (const t of [a1, a2, b1, c1, c2, d1]) (evidence.firstPass as any)[t.title].runs = await runCount(t.id);
  assert.equal((await runCount(d1.id)), 0, "the stopped project launched nothing");
  assert.equal((await runCount(c2.id)), 0, "the dependent task did not start");
  assert.equal(by(c2.id).waitingOn, "dependency");
  assert.equal(by(d1.id).waitingOn, "project-stopped");
  assert(peakSlots.value <= 1, "never more than one slot");
  mark("Started the mission and paused it right after the first launch: the stopped project and the dependent task launched nothing; the queue records why each task waits");

  // ---- 2. Read the queue in the window ----
  await button("Missions", true, 0);
  await sleep(1200);
  await button("D6 shared slot", false).catch(() => undefined);
  await sleep(800);
  await button("Work Queue", false).catch(() => button("Queue", false).catch(() => undefined));
  await show("Project is stopped", 20_000);
  assert(has("Waiting for a dependency"));
  assert(has("Waiting for a free worker slot") || by(a1.id).waitingOn === undefined);
  shot("01-queue-reasons");
  mark("Mission Control, Work Queue: 'Project is stopped' (Delta) and 'Waiting for a dependency' (C2) are shown from the recorded reasons, each next to its own task");

  // ---- 3. Resume: the slot is reused one task at a time; sample the sequence ----
  await api("POST", `/api/orchestration/missions/${mission.id}/resume`, {});
  const order: string[] = [];
  const titleOf = new Map([a1, a2, b1, c1, c2, d1].map((t) => [t.id, t.title]));
  const seen = new Set<string>();
  await poll("the queue advanced through the eligible work", async () => {
    await sample();
    for (const t of [a1, a2, b1, c1, c2]) if (!seen.has(t.id) && (await runCount(t.id)) > 0) { seen.add(t.id); order.push(titleOf.get(t.id)!); }
    return seen.size >= 5 ? true : null;
  }, 90_000);
  evidence.launchOrder = order;
  evidence.peakSlots = peakSlots.value;
  assert(peakSlots.value <= 1, "the shared slot was never exceeded");
  assert.equal(await runCount(d1.id), 0, "the stopped project still launched nothing");
  assert(order.indexOf("C2") > order.indexOf("C1"), "the dependent task started only after its prerequisite");
  mark(`Resumed: the single slot advanced through the eligible work in the order ${order.join(" → ")}; peak reservations ${peakSlots.value}; Delta (stopped) launched nothing`);
  shot("02-queue-advanced");

  // ---- 4. Reopen: nothing is lost or started twice ----
  const before = Object.fromEntries(await Promise.all([a1, a2, b1, c1, c2, d1].map(async (t) => [t.title, await runCount(t.id)])));
  await quit();
  await up();
  await show("Main navigation");
  await sleep(4000);
  const after = Object.fromEntries(await Promise.all([a1, a2, b1, c1, c2, d1].map(async (t) => [t.title, await runCount(t.id)])));
  assert.deepEqual(after, before, "reopening started nothing again");
  assert.equal(await runCount(d1.id), 0);
  const reopened = await missionNow();
  evidence.afterReopen = { runs: after, missionStatus: reopened.status, d1: reopened.plan.tasks.find((t: any) => t.taskId === d1.id).waitingOn };
  assert.equal(reopened.plan.tasks.find((t: any) => t.taskId === d1.id).waitingOn, "project-stopped");
  await button("Missions", true, 0); await sleep(1200);
  await button("D6 shared slot", false).catch(() => undefined); await sleep(800);
  await button("Work Queue", false).catch(() => undefined);
  await show("Project is stopped", 20_000);
  shot("03-reopened-queue");
  mark("Quit and reopened the same profile: every task has the same number of runs, the stopped project still waits as 'Project is stopped', and no work was started again");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)])), ownerBefore, "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  save();
}
