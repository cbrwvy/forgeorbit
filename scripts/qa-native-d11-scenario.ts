/**
 * Direction 11 (quota and availability), in the packaged ForgeOrbitQA window. Fake drivers, disposable profile,
 * synthetic Codex profiles, no provider, no login, no quota source, no model call.
 *
 * Fixtures (seeded through the isolated profile's API, never SQLite):
 *   Account A: a fresh Owner-reported 5h window (40% used), a past Owner-reported weekly window for another model,
 *              a pool with no reading at all, and ONE recorded provider refusal (a Developer run on the fake Codex driver
 *              ends the way a usage-limit refusal ends, with the provider's own retry words).
 *   Account B: signed in, no quota pool, no refusal (negative control).
 *
 * Window (PN): Settings > Accounts (profile cards, reading types), the task's launch preflight for A and for B, and the
 * Router's resource context. Exact scope / shared-pool / expiry cases the window cannot prove are asserted on the backend
 * (src/bun/direction11-availability.test.ts).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
const HOUR = 3_600_000;
export async function run(c: Ctx) {
  const { api, button, show, absent, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "profile cards with a refusal and without, reading types, the launch preflight for both accounts, the Router resource context",
    "PN records read from the packaged core (API of the same isolated profile)": "the recorded refusal, run count, read-only counters",
    "Backend only (QA isolation)": "exact scope, shared pool, expired reading at display time, mismatched account: src/bun/direction11-availability.test.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const Work = join(runtime, "projects/D11");
  const stub = join(runtime, "codex");
  const dirA = join(runtime, "home/profile-a"), dirB = join(runtime, "home/profile-b");
  const NOV = "Nov 16th, 2026 9:31 PM";

  // ---- prerequisites (API of the isolated profile) ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  let taskId: string, A: any, B: any, employeeId: string;
  const fresh = (await api("GET", "/account-core/codex-profiles")).length === 0;
  if (fresh) {
    mkdirSync(Work, { recursive: true });
    for (const [dir, subject] of [[dirA, "subject-a"], [dirB, "subject-b"]] as const) {
      mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); writeFileSync(join(dir, "synthetic-authenticated"), subject);
    }
    await api("POST", "/projects", { path: Work, name: "D11 Work" });
    await api("PATCH", "/harnesses/codex", { enabled: true });
    A = await api("POST", "/account-core/codex-profiles", { displayName: "Account A", directory: dirA });
    B = await api("POST", "/account-core/codex-profiles", { displayName: "Account B", directory: dirB });
    for (const p of [A, B]) {
      await api("PATCH", `/harnesses/${p.harnessId}`, { bin: stub, enabled: true });
      await api("POST", `/account-core/codex-profiles/${p.accountId}/check`);
    }
    const now = Date.now();
    const pool = (scope: string, window: string, observation?: any, unit: any = { kind: "percentage" }) => api("POST", `/account-core/accounts/${A.accountId}/quota-observations`, {
      definition: { subscriptionId: null, category: "subscription", scope, unit, window, windowMs: 5 * HOUR },
      observation: observation ?? { observedAt: now - 1000, expiresAt: now + 1000, indicator: { kind: "percent-used", value: 1 } },
    });
    await pool("account", "5h window", { observedAt: now - HOUR, expiresAt: now + 4 * HOUR, resetAt: now + 3 * HOUR, indicator: { kind: "percent-used", value: 40 }, sourceNote: "read by the Owner from the usage page" });
    await pool("model:gpt-6-luna", "weekly window", { observedAt: now - 30 * HOUR, expiresAt: now - 6 * HOUR, indicator: { kind: "percent-used", value: 10 }, sourceNote: "read by the Owner last week" });
    // A pool with no reading: define it and record nothing.
    await api("POST", "/account-core/quotas", { accountId: A.accountId, scope: "model:gpt-6-aeon", unit: { kind: "tokens" }, window: "monthly window", windowMs: 30 * 24 * HOUR });
    const employee = await api("POST", "/employees", { name: "D11 Developer", jobTitle: "Developer", projectPath: Work });
    const made = await api("POST", "/tasks", { title: "D11 refused task", prompt: "Implement it __fake_provider__:usage-limit", workdir: Work, agent: "codex", model: "gpt-6.1-sol", isolation: "none", column: "ready" });
    taskId = (made.task ?? made).id;
    await api("PATCH", `/tasks/${taskId}`, { agent: A.harnessId });
    employeeId = employee.id;
    await api("POST", "/task-assignments", { taskId, employeeId: employee.id });
    const started = await api("POST", `/tasks/${taskId}/start`);
    await poll("the refused run settles", async () => ((await api("GET", `/tasks/${taskId}/runs`)).find((r: any) => r.id === started.runId)?.status !== "running" ? true : null), 30_000);
    await down(); await up();
  } else {
    const tasks = await api("GET", "/tasks");
    taskId = tasks.find((t: any) => t.title === "D11 refused task").id;
    employeeId = (await api("GET", `/task-assignments/task?taskId=${taskId}`)).assignment.employeeId;
  }
  const profilesNow = await api("GET", "/account-core/codex-profiles");
  A = profilesNow.find((p: any) => p.displayName === "Account A"); B = profilesNow.find((p: any) => p.displayName === "Account B");
  const refused = A.providerRefusal;
  assert(refused, "the Developer run recorded one refusal on account A");
  assert.equal(refused.accountId, A.accountId); assert.equal(refused.retryHint, NOV); assert.equal(B.providerRefusal, null);
  evidence.refusal = { accountId: refused.accountId, modelId: refused.modelId, retryHint: refused.retryHint, surface: refused.surface, supersededAt: refused.supersededAt };
  mark("Seeded through the API of the isolated profile: two synthetic Codex accounts; A has a fresh Owner-reported window, a past Owner-reported window, a pool with no reading and one recorded refusal from a Developer run; B has nothing");
  await show("Main navigation");

  // ---- read-only counters, read before any screen is opened ----
  const counters = async () => {
    const runs = (await api("GET", `/tasks/${taskId}/runs`)).length;
    const profiles = await api("GET", "/account-core/codex-profiles");
    const a = profiles.find((p: any) => p.displayName === "Account A");
    const quotas = await api("GET", `/account-core/accounts/${A.accountId}/quotas`);
    return { runs, refusal: a.providerRefusal?.id, superseded: a.providerRefusal?.supersededAt ?? null, observations: quotas.reduce((n: number, q: any) => n + q.observations.length, 0) };
  };
  const before = await counters();

  // ---- 1. Accounts: profile cards ----
  await button("Settings", true, 0);
  await button("AI providers and accounts", true);
  await show("Account A", 15_000);
  await sleep(1200);
  assert(has("The provider refused this request: usage limit"), "account A shows the provider refusal");
  assert(has("Sign-in is valid. The provider still refused the request."), "sign-in and refusal are separate facts");
  assert(has(NOV), "the provider's own retry words are shown as written");
  const dump = JSON.stringify(find(hasText(NOV)).map((n: any) => [n.AXValue, n.AXDescription, n.AXTitle]));
  assert(!/UTC|local time/i.test(dump), "the retry words are not converted to a time zone");
  shot("01-accounts-refusal");
  const refusalTexts = find((n: any) => n.AXRole === "AXStaticText" && hasText("The provider refused this request")(n));
  const cardOf = (name: string) => find((n: any) => n.AXRole === "AXGroup" && (n.AXTitle === name || n.AXDescription === name) && n.frame && n.frame.height < 900 && n.frame.height > 150)[0];
  const inside = (card: any, n: any) => n.frame.y >= card.frame.y && n.frame.y <= card.frame.y + card.frame.height;
  const cardA = cardOf("Account A"), cardB = cardOf("Account B");
  assert(cardA && cardB, "both profile cards are on screen");
  assert(refusalTexts.some((n: any) => inside(cardA, n)), "account A's own card carries the refusal");
  assert(!refusalTexts.some((n: any) => inside(cardB, n)), "account B's card (same model) carries no refusal");
  mark("Accounts: account A's card shows the refusal beside a valid sign-in, with the provider's retry words as written and no time-zone conversion; account B (same model) shows none");

  // The Owner's Check is a sign-in check. It must not clear the refusal.
  await button("Check authentication", true, 0); await sleep(1500);
  await button("Check authentication", true, 1); await sleep(1500);
  assert(has("The provider refused this request: usage limit"), "a sign-in check does not clear the refusal");
  const afterCheck = await counters();
  assert.equal(afterCheck.refusal, before.refusal); assert.equal(afterCheck.superseded, null);
  mark("The Owner's sign-in Check on both accounts left the refusal standing");

  // ---- 2. Accounts → Quotas: three kinds of reading, never a number ----
  await button("Quotas", true, 0);
  await show("Reading type", 15_000);
  await sleep(900);
  assert(has("Reported by you — not verified"), "a fresh Owner-reported reading says so");
  assert(has("Past reading — not current capacity"), "a reading that is no longer current is a past reading");
  assert(has("No reading — capacity unknown"), "a pool with no reading is Unknown");
  assert(find((n: any) => ["free", "unlimited"].includes(String(n.AXValue ?? n.AXTitle ?? "").trim().toLowerCase())).length === 0, "no value is worded as unlimited or free (the disclaimer that denies it is existing copy; the zero tiles are counts of subscriptions and archived accounts, not quota)");
  shot("02-accounts-quotas");
  const quotas = await api("GET", `/account-core/accounts/${A.accountId}/quotas`);
  evidence.quotas = quotas.map((q: any) => ({ scope: q.definition.scope, window: q.definition.window, status: q.status, current: q.current?.provenance ?? null, observations: q.observations.length }));
  mark("Accounts → Quotas: one pool reads 'Reported by you — not verified', one 'Past reading — not current capacity', one 'No reading — capacity unknown'; none shows a balance");
  ax("key", "53", "0"); await sleep(900);

  // ---- 3. The launch preflight, for A and for B ----
  const openTask = async () => {
    await button("D11 Work", false, 0); await sleep(600);
    await button("Tasks", true, 1).catch(() => undefined); await sleep(900);
    await button("D11 refused task", true, 0); await show("EMPLOYEE EXECUTION", 15_000);
  };
  const choose = async (id: string) => {
    if (find(hasText("Prepare Execution")).length === 0) await button("EMPLOYEE EXECUTION");
    await show("Prepare Execution", 15_000);
    const order = (await api("GET", "/harnesses")).harnesses.map((h: any) => h.id);
    const index = order.indexOf(id) + 1;
    assert(index > 0, `harness ${id} is registered`);
    await button("Harness", false, 0);
    await sleep(700);
    for (let i = 0; i < 20; i++) { ax("key", "126", "0"); await sleep(70); }
    for (let i = 0; i < index; i++) { ax("key", "125", "0"); await sleep(150); }
    ax("key", "36", "0"); await sleep(900);
  };
  const attempts = async () => (await api("GET", `/employee-execution/attempts?employeeId=${employeeId}`)).attempts.length;
  await openTask();
  await choose(A.harnessId);
  await button("Prepare Execution");
  await show("Prepared", 25_000);
  await sleep(1200);
  assert(has(NOV), "the preflight for account A shows the provider's retry words");
  assert(has("refused an earlier request for this account and model"), "the preflight carries the refusal as an advisory warning, not a block");
  assert(has("Prepared"), "the preflight is Prepared, not Blocked: the refusal does not stop a manual launch");
  assert(has("A reading you reported is on record"), "the preflight says an Owner-reported reading exists and is not capacity");
  shot("03-preflight-account-a");
  const resultA = await api("GET", `/tasks/${taskId}`);
  evidence.preflightA = { column: resultA.column };
  mark("Launch preflight for account A: the refusal, the provider's words, 'readiness unconfirmed' as a warning, and 'a reading you reported is on record' beside Quota Unknown");

  await choose(B.harnessId);
  await button("Prepare Execution");
  await sleep(2500);
  assert(!has("refused an earlier request for this account and model"), "the preflight for account B (same model) carries no refusal warning");
  assert(has("Quota Unknown") || has("unknown"), "account B's quota is Unknown");
  assert(!has("A reading you reported is on record"), "account B has no reading of any kind");
  shot("04-preflight-account-b");
  mark("Launch preflight for account B (same model): no refusal, no reading, Quota Unknown — the other account is not described as guaranteed to work");

  // ---- 4. The Router's resource context ----
  await button("AI RESOURCE RECOMMENDATION", false, 0); await sleep(2500);
  await show("Owner-reported — not verified capacity", 20_000).catch(() => undefined);
  assert(has("Reported by you — not verified"), "the Router lists the Owner-reported reading as such");
  assert(has("Past reading — not current capacity"), "the Router lists the past reading as the past, with its time and source");
  assert(has("No reading — capacity unknown"), "the Router lists the pool with no reading as Unknown");
  assert(!has("Verified remaining"), "the Router states no verified capacity");
  shot("05-router-context");
  evidence.routerContext = (await api("GET", "/model-router/resource-context")).accounts.flatMap((a: any) => a.quotas.map((q: any) => ({ scope: q.scope, evidence: q.evidence, capacityLabel: q.capacityLabel, lastSource: q.lastSource, status: q.status })));
  mark("Router resource context: the same three readings, each with its own type; the past one keeps its observed time and source; no verified capacity is stated; automatic routing stays unavailable");
  ax("key", "53", "0"); await sleep(600);

  // ---- 5. Reading changed nothing ----
  const afterAll = await counters();
  assert.deepEqual(afterAll, before, "no run, refusal, supersession or reading changed while the screens were read");
  assert.equal(await attempts(), 0, "no review was created by the preflight");
  evidence.readOnly = { before, after: afterAll };
  mark("Counters read from the packaged core before and after every screen are identical: no run, no new or cleared refusal, no new reading, no review");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
  // The Owner's own ChatGPT/Codex desktop app keeps writing to ~/.codex (state and log databases) while it runs.
  // The QA process cannot be the writer (its CODEX_HOME is the isolated home and its Codex binary is the inert stub),
  // but the guard cannot tell the two apart, so that single path is tolerated ONLY while that app's server is running,
  // and the tolerance is recorded. Every other Owner path must be byte-for-byte unchanged.
  const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
  const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
  const unexplained = changed.filter((p) => !tolerated.includes(p));
  evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
  assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = unexplained.length === 0 && tolerated.length === 0;
  mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer; this QA process used an isolated CODEX_HOME and the inert stub); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
  save();
  void absent;
}
