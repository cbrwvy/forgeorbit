/**
 * Direction 7 offline acceptance (Supervised / Autonomous / Full Autonomy), observed in the packaged ForgeOrbitQA window.
 * Fake drivers, synthetic account fixture, disposable profile, no provider.
 *
 * Three missions, one per authority, each over one project:
 *   - REVOKED   the mission's own policy is revoked while a broader policy is still active: the Owner presses Start in
 *               the window and nothing launches (the refusal is shown in the Work Queue); it survives a reopen.
 *   - AUTONOMOUS an active Autonomous policy: Start advances the task by itself through QC; the policy does not allow
 *               automatic completion, so the task stops at "QC PASS, waiting for you" and only the Owner's Done in the
 *               window completes it.
 *   - FULL      an active Full Autonomy policy that explicitly allows automatic completion: after QC PASS the task reaches
 *               Done by itself, with no Owner action.
 * The effective authority line in Mission Control is read for each mission. Races, expiry and persisted-state boundaries are
 * backend cases (`src/bun/autonomy/autonomy-direction7.suite.ts`); the evidence file labels the tiers.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, qcVerdictFile } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "effective authority per mission, Start by the Owner, a refusal in the Work Queue, a step that advances under an active policy, completion that waits for the Owner, completion that is automatic under an explicit policy, reopen",
    "CH (backend suite, not the window)": "expired and revoked grants, an altered plan, a consumed grant, Emergency Stop and recovery, draft and unactivated policies, the enforceable-cap refusal, a stale PASS",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const quit = async () => {
    ax("key", "12", "1048576");
    await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 20_000).catch(async () => { await down(); });
    await sleep(1500);
  };

  writeFileSync(qcVerdictFile, "PASS\n");
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const model = "gpt-6.1-sol";
  const accountDir = join(runtime, "home", "d7-account"); mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(accountDir, "synthetic-authenticated"), "d7", { mode: 0o600 });
  const account = await api("POST", "/account-core/codex-profiles", { displayName: "D7 fixture", directory: accountDir }, 201);
  const now = Date.now();
  const ACTIONS = ["plan_task", "launch_task", "run_qc", "request_rework", "complete_task"];
  const names = ["Revoked", "Autonomous", "Full"] as const;
  const dirs: Record<string, string> = {}; const tasks: Record<string, any> = {}; const missions: Record<string, any> = {}; const policies: Record<string, any> = {};
  const policyBody = (mode: string, project: string, autoComplete: boolean) => ({
    mode, scopeKind: "workspace", scopeRef: "company", projects: [project], specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: [model],
    accounts: [account.accountId], maxConcurrentWorkers: 4, maxLaunches: 20, maxDurationMs: 3_000_000, expiresAt: now + 3_000_000,
    permittedActions: ACTIONS, qc: { required: true }, completion: { autoComplete, conditions: ["qc_pass"] },
  });
  for (const name of names) {
    dirs[name] = join(runtime, "projects", name); mkdirSync(dirs[name]!, { recursive: true });
    await api("POST", "/projects", { path: dirs[name], name: `D7 ${name}` });
    const employee = await api("POST", "/employees", { name: `${name} Developer`, jobTitle: "Developer", projectPath: dirs[name] });
    tasks[name] = await api("POST", "/tasks", { title: `${name} task`, prompt: `Record the ${name} note.`, workdir: dirs[name], isolation: "none", column: "ready", agent: account.harnessId, model, mode: "auto" });
    await api("POST", "/task-assignments", { taskId: tasks[name].id, employeeId: employee.id });
  }
  const makeMission = async (name: typeof names[number], mode: string, autoComplete: boolean) => {
    const { policy } = await api("POST", "/api/autonomy/policies", policyBody(mode, dirs[name]!, autoComplete));
    const { activation } = await api("POST", `/api/autonomy/policies/${policy.id}/activate`, {});
    const { mission } = await api("POST", "/api/orchestration/missions/prepare", {
      title: `Mission ${name}`, goal: `${mode} mission for ${name}`,
      tasks: [{ taskId: tasks[name].id, taskTitle: tasks[name].title, projectPath: dirs[name], harnessId: account.harnessId, modelId: model, accountId: account.accountId, mode: "auto", qcRequired: true }],
      concurrencyLimits: { globalMax: 3, perProjectMax: 1, perAccountMax: 3 },
    });
    await api("POST", `/api/orchestration/missions/${mission.id}/authorize`, { digest: mission.planDigest });
    { using db = new Database(join(runtime, "data", "agetor.sqlite")); db.run("PRAGMA busy_timeout = 3000");
      db.run(`INSERT INTO autonomy_mission_bindings (mission_id,policy_id,revision,activation_id,digest,mode,outcome,emergency_task_ids_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'active','[]',?,?)`, [mission.id, policy.id, policy.revision, activation.id, policy.digest, mode, now, now]); }
    missions[name] = mission; policies[name] = policy;
    return mission;
  };
  await down(); await up(); await show("Main navigation");
  mark("Seeded through the API of the isolated profile: three projects with one ready task each and one synthetic account. Each mission is authorized and bound just before its phase, so the newest mission is the one Mission Control opens (Revoked: own policy revoked while a broader policy stays active; Autonomous: no automatic completion; Full Autonomy: automatic completion allowed)");

  const missionNow = async (name: string) => (await api("GET", "/api/orchestration/missions")).missions.find((m: any) => m.id === missions[name].id);
  const taskNow = async (name: string) => await api("GET", `/tasks/${tasks[name].id}`);
  const runCount = async (name: string) => (await api("GET", `/tasks/${tasks[name].id}/runs`)).length;
  const openMission = async (name: string) => {
    await button("Tasks", true, 0); await sleep(800);          // leave and re-enter so the newest mission is the one shown
    await button("Missions", true, 0); await sleep(1500);
    await poll(`mission ${name} shown`, () => (find((n: any) => n.AXRole === "AXPopUpButton" && n.AXValue === `Mission ${name}`).length ? true : null), 15_000);
  };

  await makeMission("Revoked", "full-autonomy", false);
  // A broader policy that covers the Revoked project stays active: it must not stand in for the mission's own revoked one.
  await api("POST", `/api/autonomy/policies/${policies.Revoked.id}/revoke`, {});
  { const standing = await api("POST", "/api/autonomy/policies", policyBody("full-autonomy", dirs.Revoked!, true));
    await api("POST", `/api/autonomy/policies/${standing.policy.id}/activate`, {}); }
  // ---- 1. Revoked: the Owner presses Start; the refusal is visible; nothing launches ----
  await openMission("Revoked");
  await show("Authorized", 15_000).catch(() => undefined);
  await button("Start Mission", true);
  await sleep(2500);
  assert.equal(await runCount("Revoked"), 0, "a revoked mission policy launched nothing");
  const refused = (await missionNow("Revoked")).plan.tasks[0];
  evidence.revoked = { runs: 0, phase: refused.phase, reason: refused.phaseReason ?? null };
  await button("Work Queue", false).catch(() => undefined);
  await show("activation is no longer active", 20_000);
  assert(has("This mission's policy is revoked"), "the effective authority names the revoked policy");
  shot("01-revoked-refusal");
  mark("REVOKED: Start in the window launched nothing. Mission Control says the mission's policy is revoked and the task shows the refusal; the broader active policy did not stand in for it");

  await makeMission("Autonomous", "autonomous", false);
  // ---- 2. Autonomous: Start advances by itself through QC; completion waits for the Owner ----
  await openMission("Autonomous");
  assert(has("Autonomous under an active policy"));
  shot("02-autonomous-authority");
  await button("Start Mission", true);
  await poll("autonomous task reached QC PASS awaiting the Owner", async () => { const t = await taskNow("Autonomous"); return t.column === "review" && t.qcState?.latestVerdict === "PASS" ? t : null; }, 90_000);
  const auto1 = await taskNow("Autonomous");
  assert.notEqual(auto1.column, "done", "no automatic Done without the policy's permission");
  evidence.autonomous = { column: auto1.column, qc: auto1.qcState?.latestVerdict, awaitingOwnerApproval: auto1.qcState?.awaitingOwnerApproval, runs: await runCount("Autonomous") };
  mark("AUTONOMOUS: Start launched the task and its independent review by themselves; it stopped at QC PASS in Review, waiting for the Owner (not Done)");

  await makeMission("Full", "full-autonomy", true);
  // ---- 3. Full Autonomy with explicit automatic completion: Done without an Owner action ----
  await openMission("Full");
  assert(has("Full Autonomy under an active policy"));
  await button("Start Mission", true);
  await poll("full-autonomy task completed by the policy", async () => { const t = await taskNow("Full"); return t.column === "done" ? t : null; }, 90_000);
  const full = await taskNow("Full");
  evidence.full = { column: full.column, qc: full.qcState?.latestVerdict, runs: await runCount("Full") };
  shot("03-full-done-by-policy");
  mark("FULL AUTONOMY (automatic completion explicitly allowed): after QC PASS the task reached Done with no Owner action");

  // ---- 4. The Owner completes the Autonomous task in the window (its card's Done) ----
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
    c.activate(node); await sleep(800);
  };
  await button("D7 Autonomous", false, 0); await sleep(1000);
  await button("Tasks", true, 1).catch(() => undefined); await sleep(1000);
  await cardButton("Autonomous task", "Done");
  await poll("Owner Done", async () => (await taskNow("Autonomous")).column === "done" ? true : null, 20_000);
  evidence.ownerDoneViaWindow = true;
  shot("03b-owner-done");
  mark("The Owner completed the Autonomous task with Done on its card in the window; nothing else moved it");

  // ---- 5. Reopen: nothing launches again, the revoked mission is still refused ----
  const before = { Revoked: await runCount("Revoked"), Autonomous: await runCount("Autonomous"), Full: await runCount("Full") };
  await quit(); await up(); await show("Main navigation"); await sleep(5000);
  const after = { Revoked: await runCount("Revoked"), Autonomous: await runCount("Autonomous"), Full: await runCount("Full") };
  assert.deepEqual(after, before, "reopening launched nothing");
  assert.equal(after.Revoked, 0);
  await openMission("Revoked"); await button("Work Queue", false).catch(() => undefined);
  await show("activation is no longer active", 20_000);
  shot("04-reopened-revoked-still-refused");
  evidence.afterReopen = { runs: after };
  mark("Quit and reopened: no mission launched anything again; the revoked mission is still refused with the same reason");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)])), ownerBefore, "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  save();
}
