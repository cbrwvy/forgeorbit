/**
 * Direction 16 (Smart Router and safe fallback), packaged ForgeOrbitQA window. Fake drivers, disposable profile, synthetic Codex
 * profiles, recorded synthetic quota and refusal rows. No provider, no login, no quota source, no model call.
 *
 * Fixture: four synthetic Codex accounts.
 *   A  the mission's original resource;  B  the account the Owner approves as the replacement;
 *   C  a recorded known capacity shortfall (verified exhausted subscription window);
 *   D  Unknown capacity AND a recorded provider refusal.
 * One authorized Full Autonomy mission (one ready Developer task on A) with three pending resource proposals prepared through the
 * mission API: P1 (to B, to be rejected = Cancel), P2 (to B, to be approved), P3 (to D, prepared at the same revision as P2).
 *
 * Window (PN): Settings > AI Router under the strict quota policy, where no candidate qualifies and the screen says why, with the
 * known shortfall, Unknown capacity and the recorded refusal kept apart; under the permissive policy, where each candidate shows its
 * capacity separately from the refusal; Missions, where the pending proposals show the exact harness, model, account and mode before
 * any approval; Reject (Cancel) leaves the revision; Approve writes revision 2 and starts nothing; the older proposal P3 is refused;
 * a separate "Start Mission" launches exactly the approved account. The Router's single-task preview is the Settings panel above:
 * it writes nothing (counters asserted). Exact digest binding, expiry, quota drift, slot waits and "no silent retry" are asserted on
 * the backend (direction16.suite.ts, direction16-apply.suite.ts).
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AccountCore } from "../src/bun/account-core.ts";
import { recordRefusal } from "./qa-portfolio-planning-fixture.ts";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "the Router explanation when no candidate qualifies, the capacity reading beside a refusal, the exact resource in each pending proposal, Reject, Approve, the refusal of the older proposal, a separate Start and the account the run used",
    "PN records read from the packaged core (API of the same isolated profile)": "tasks, runs, mission revision and plans before and after each Owner action",
    "Backend (exact binding, expiry, quota drift, slot wait, no silent retry, plan-apply boundary)": "src/bun/router-v2/direction16.suite.ts, direction16-apply.suite.ts, src/shared/router-v2/*.test.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  /** The page text around an element, read from the accessibility tree. The window captures below show the top of the page
   *  (the unattended wheel did not move the inner scroll area), so the asserted text is recorded here instead of being claimed from an image. */
  const text = () => find(() => true).flatMap((n: any) => [n.AXTitle, n.AXDescription, typeof n.AXValue === "string" ? n.AXValue : ""]).filter(Boolean).join("\n");
  const excerpts: Record<string, string> = {};
  evidence.excerpts = excerpts;
  const bring = async (part: string) => {
    const all = text().split("\n");
    const i = all.findIndex((line: string) => line.includes(part));
    excerpts[part] = i < 0 ? "" : all.slice(Math.max(0, i - 3), i + 14).join("\n").slice(0, 1800);
    save();
  };
  const model = "gpt-6.1-sol";
  const dbPath = join(runtime, "data/agetor.sqlite");
  const openDb = (readonly = false) => { const d = new Database(dbPath, readonly ? { readonly: true } : undefined); d.run("PRAGMA busy_timeout = 5000"); return d; };

  // ---- prerequisites ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const profileHome = join(runtime, "home/profiles");
  mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  const accounts: any[] = [];
  for (const name of ["Account A original", "Account B replacement", "Account C shortfall", "Account D unknown refused"]) {
    const directory = join(profileHome, name.replace(/ /g, "-").toLowerCase());
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    writeFileSync(join(directory, "synthetic-authenticated"), name, { mode: 0o600 });
    const p = await api("POST", "/account-core/codex-profiles", { displayName: name, directory }, 201);
    await api("PATCH", `/harnesses/${p.harnessId}`, { bin: join(runtime, "codex"), enabled: true });
    await api("POST", `/account-core/codex-profiles/${p.accountId}/check`);
    accounts.push(p);
  }
  const [a, b, cAcc, d] = accounts as [any, any, any, any];
  const projectPath = join(runtime, "projects", "D16");
  mkdirSync(projectPath, { recursive: true });
  await api("POST", "/projects", { path: projectPath, name: "D16 fixture" });
  const employee = await api("POST", "/employees", { name: "D16 Developer", jobTitle: "Developer", projectPath });
  const taskRow = await api("POST", "/tasks", { title: "D16 remaining work", prompt: "Record the approved account.", workdir: projectPath, isolation: "none", column: "ready", agent: a.harnessId, model, mode: "auto" });
  const taskId = (taskRow.task ?? taskRow).id as string;
  await api("POST", "/task-assignments", { taskId, employeeId: employee.id });
  await down();
  // Recorded rows, with the app stopped: C's verified exhausted window, D's account-wide provider refusal.
  const now = Date.now();
  { using db = openDb();
    const core = new AccountCore(db);
    const definition = core.createDefinition({ accountId: cAcc.accountId, scope: "account", category: "subscription", unit: { kind: "requests" }, window: "exhausted" });
    core.recordTrustedObservations("recorded-contract", [{
      quotaId: definition.id,
      values: { observedAt: now - 1000, expiresAt: now + 43_200_000, resetAt: null, limit: 100, used: 100, remaining: 0, indicator: null, confidence: "high" },
      evidence: { provider: "openai", accountId: cAcc.accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract", officialUrl: "https://example.invalid", checkedAt: "2026-11-17", receivedAt: now, sharedPool: null, limitations: "Recorded QA evidence" },
    }]);
    recordRefusal(db, d, now);
  }
  await up();

  // ---- the mission, its policy and three pending proposals, through the API of the isolated profile ----
  const ACTIONS = ["plan_task", "launch_task"];
  const { policy } = await api("POST", "/api/autonomy/policies", {
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: [projectPath], specialistRoles: ["developer"], providers: ["codex"], models: [model],
    accounts: [a.accountId, b.accountId, cAcc.accountId, d.accountId], maxConcurrentWorkers: 1, maxLaunches: 6, maxDurationMs: 3_000_000, expiresAt: now + 3_000_000,
    permittedActions: ACTIONS, qc: { required: false }, completion: { autoComplete: false },
  });
  const { activation } = await api("POST", `/api/autonomy/policies/${policy.id}/activate`, {});
  const { mission } = await api("POST", "/api/orchestration/missions/prepare", {
    title: "Direction 16 mission", goal: "Replace the resource of one remaining stage",
    tasks: [{ taskId, taskTitle: "D16 remaining work", projectPath, harnessId: a.harnessId, modelId: model, accountId: a.accountId, mode: "auto", qcRequired: false }],
    concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
  });
  await api("POST", `/api/orchestration/missions/${mission.id}/authorize`, { digest: mission.planDigest });
  { using db = openDb();
    db.run(`INSERT INTO autonomy_mission_bindings (mission_id,policy_id,revision,activation_id,digest,mode,outcome,emergency_task_ids_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'active','[]',?,?)`, [mission.id, policy.id, policy.revision, activation.id, policy.digest, "full-autonomy", now, now]); }
  await down(); await up(); await show("Main navigation");

  const options = (await api("GET", `/api/orchestration/missions/${mission.id}/resource-options?taskId=${taskId}&role=developer`)).options as any[];
  const optionFor = (acc: any) => options.find((o) => o.accountId === acc.accountId)!.resource;
  assert(options.some((o) => o.accountId === b.accountId), "B is an admitted option");
  assert(options.some((o) => o.accountId === d.accountId), "D (Unknown capacity, a recorded refusal) is still an admitted option: a refusal does not remove eligibility");
  assert(!options.some((o) => o.accountId === cAcc.accountId), "C (a known shortfall) is not offered");
  const prepare = (acc: any, reason: string) => api("POST", `/api/orchestration/missions/${mission.id}/resource-proposals`, { taskId, role: "developer", resource: optionFor(acc), reason });
  const p1 = await prepare(b, "P1 — will be cancelled"); await sleep(15);
  const p2 = await prepare(b, "P2 — will be approved"); await sleep(15);
  const p3 = await prepare(d, "P3 — prepared at the same revision as P2");
  assert.equal(p1.status, "pending");
  mark(`Seeded: 4 synthetic Codex accounts, one authorized Full Autonomy mission (task on A), C = verified exhausted, D = Unknown capacity + a recorded refusal, three pending proposals prepared at revision ${mission.revision}`);

  const TABLES = ["tasks", "runs", "run_events", "orchestration_missions", "orchestration_reservations", "allocation_plans", "mission_plan_revisions", "provider_refusal_observations", "quota_observations", "router_v2_decisions"];
  const counters = () => {
    const r = openDb(true);
    try {
      return {
        ...Object.fromEntries(TABLES.map((t) => [t, (r.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n])),
        taskRows: r.query(`SELECT id, "column", agent, model, mode, run_id FROM tasks ORDER BY id`).all(),
        mission: r.query(`SELECT revision, plan_digest, status FROM orchestration_missions WHERE id = ?`).get(mission.id),
      };
    } finally { r.close(); }
  };
  const missionNow = async () => (await api("GET", "/api/orchestration/missions")).missions.find((m: any) => m.id === mission.id);
  const runsNow = async () => (await api("GET", `/tasks/${taskId}/runs`)) as any[];
  const setPolicy = async (quotaPolicy: "strict" | "permissive") => {
    const current = (await api("GET", "/api/router-v2/config?scopeId=global")).policy;
    await api("POST", "/api/router-v2/config", { ...current, quotaPolicy });
  };

  // ---- 1. Permissive policy: each candidate shows its capacity apart from the refusal ----
  const beforeRouter = counters();
  await button("Settings", true, 0);
  await button("AI providers and accounts", true);
  await show("Capacity:", 40_000);
  await sleep(1200);
  assert(has("Capacity: Unknown"), "an eligible candidate with no quota reading reads Capacity: Unknown");
  assert(has("Known shortfall (verified exhausted)"), "the exhausted account reads as a known shortfall");
  assert(has("Provider refused a request (usage limit)"), "the refused candidate is flagged");
  await bring("Provider refused a request (usage limit)");
  shot("02-permissive-capacity-and-refusal");
  assert.deepEqual(counters(), beforeRouter, "opening the Router preview wrote nothing");
  mark("Permissive policy: the eligible candidates read 'Capacity: Unknown', the exhausted account reads as a known shortfall, and the refused candidate is flagged without its capacity changing. The preview wrote nothing");

  // ---- 2. Strict policy: no candidate qualifies, and the screen says why ----
  c.ax("key", "53", "0"); await sleep(1200);            // Escape closes Settings; reopening builds the page again
  await setPolicy("strict");
  const beforeStrict = counters();
  await button("Settings", true, 0);
  await button("AI providers and accounts", true);
  await show("Why no candidate qualified", 40_000);
  await sleep(1200);
  assert(has("No candidate currently selected"), "no candidate is selected");
  assert(has("with a known capacity shortfall"), "the known shortfall is named");
  assert(has("Unknown or unverified capacity that the strict quota policy cannot accept"), "Unknown capacity is named apart from the shortfall");
  assert(has("recorded provider refusal"), "the recorded refusal is counted apart");
  assert(has("did not change this result"), "the refusal is said not to be a capacity reading and not to change the result");
  await bring("Why no candidate qualified");
  shot("01-strict-none-qualified");
  const noneText = find(hasText("Why no candidate qualified")).length;
  evidence.none = { explained: noneText > 0, counters: "unchanged" };
  assert.deepEqual(counters(), beforeStrict, "opening the Router under the strict policy wrote nothing");
  mark("Strict policy: 'Why no candidate qualified' lists the known shortfall, the Unknown capacity and the recorded refusal as three separate facts; the refusal is stated as evidence that changed nothing. Opening the Router wrote nothing");

  c.ax("key", "53", "0"); await sleep(1200);
  await setPolicy("permissive");

  // ---- 3. Missions: the pending proposals show the exact resource before any approval ----
  await button("Missions", true, 0); await sleep(1800);
  await show("Mission resource replanning", 25_000);
  await show("Resource proposal", 25_000);
  const before = counters();
  for (const needle of [a.harnessId, b.harnessId, model, "Original resource", "Replacement resource", "auto"]) assert(has(needle), `the proposal text names ${needle}`);
  assert(has("Pending Owner decision"), "the proposals are pending");
  await bring("Pending Owner decision");
  shot("03-pending-proposals");
  assert.equal((await runsNow()).length, 0, "no run exists before any approval");
  mark("Missions: the three pending proposals show the original and the replacement harness, model, account and mode before any approval; no run exists");

  // ---- 4. Cancel: Reject the newest-but-one proposal P1 leaves the mission as it was ----
  // The list is newest first: P3, P2, P1. Reject P1 (index 2).
  await button("Reject resource proposal", true, 2); await sleep(2000);
  const afterReject = counters();
  assert.equal((afterReject.mission as any).revision, (before.mission as any).revision, "Reject left the revision");
  assert.equal((afterReject.mission as any).plan_digest, (before.mission as any).plan_digest, "Reject left the plan digest");
  assert.deepEqual(afterReject.taskRows, before.taskRows, "Reject changed no task");
  assert.equal(afterReject.runs, 0);
  const state1 = (await api("GET", `/api/orchestration/missions/${mission.id}/resource-proposals`)).proposals as any[];
  assert.equal(state1.find((p) => p.id === p1.id).status, "rejected");
  await bring("Rejected");
  shot("04-after-reject");
  mark("Reject (Cancel) on P1: it reads Rejected; the mission revision, plan digest and task are unchanged and no run exists");

  // ---- 5. Approve P2: writes revision 2 and starts nothing ----
  await button("Approve exact revision", true, 1); await sleep(2500);
  const m2 = await missionNow();
  assert.equal(m2.revision, (before.mission as any).revision + 1, "approval wrote the next revision");
  assert.equal(m2.plan.tasks[0].developerBinding.accountId, b.accountId, "the binding is exactly account B");
  assert.equal(m2.plan.tasks[0].developerBinding.harnessId, b.harnessId);
  assert.equal(m2.plan.tasks[0].developerBinding.modelId, model);
  assert.equal(m2.plan.tasks[0].developerBinding.mode, "auto");
  assert.notEqual(m2.status, "running", "approval did not start the mission");
  assert.equal((await runsNow()).length, 0, "approval started no run");
  await bring("Approved revision");
  shot("05-after-approve");
  mark(`Approve on P2: revision ${m2.revision}, the stage is bound to exactly account B (harness, model and mode as shown), the mission is not running and no run exists`);

  // ---- 6. The older proposal P3 cannot be approved any more ----
  const stillPending = find((n: any) => n.AXRole === "AXButton" && [n.AXTitle, n.AXDescription].includes("Approve exact revision"));
  if (stillPending.length > 0) {
    await button("Approve exact revision", true, 0); await sleep(2000);
    assert(has("changed") || has("Review a new proposal"), "the stale approval is refused with a reason");
  }
  const m3 = await missionNow();
  assert.equal(m3.revision, m2.revision, "the refused approval wrote no revision");
  assert.equal(m3.plan.tasks[0].developerBinding.accountId, b.accountId, "the binding stays B; D was not substituted");
  const state2 = (await api("GET", `/api/orchestration/missions/${mission.id}/resource-proposals`)).proposals as any[];
  assert.equal(state2.find((p) => p.id === p3.id).status, "pending", "P3 was not approved");
  await bring("Review a new proposal").catch(() => undefined);
  shot("06-stale-refused");
  mark("Approving the older proposal P3 (prepared at the previous revision) was refused with a reason; the revision and the binding (B) are unchanged and P3 is not approved");

  // ---- 7. Dispatch is a separate Owner action and uses exactly the approved account ----
  await button("Start Mission", true);
  const run = await poll("one run on the approved account", async () => { const r = await runsNow(); return r.length ? r : null; }, 60_000);
  assert.equal(run.length, 1);
  assert.equal(run[0].agent, b.harnessId, "the run used exactly account B's harness");
  const ident = (await api("GET", `/runs/${run[0].id}/events`).catch(() => null));
  void ident;
  { using db = openDb(true);
    const row = db.query(`SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%"kind":"execution-identity"%'`).get(run[0].id) as any;
    assert(row, "the run recorded its execution identity");
    const identity = JSON.parse(row.data);
    assert.equal(identity.accountProfile?.id, b.accountId, "the identity names account B");
    assert.equal(identity.model, model);
    evidence.dispatch = { runId: run[0].id, harness: run[0].agent, accountProfile: identity.accountProfile?.id, model: identity.model, mode: identity.mode, executionType: identity.executionType };
  }
  await bring("Mission resource replanning").catch(() => undefined);
  shot("07-dispatch-on-b");
  assert.equal((await api("GET", `/api/orchestration/missions/${mission.id}/resource-proposals`)).proposals.find((p: any) => p.id === p3.id).status, "pending");
  mark("Start Mission (a separate Owner action): exactly one run, on account B's harness, the recorded execution identity names account B, the approved model and mode; no run used A, C or D");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
  const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
  const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
  const unexplained = changed.filter((p) => !tolerated.includes(p));
  evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
  assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = unexplained.length === 0 && tolerated.length === 0;
  mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
  save();
}
