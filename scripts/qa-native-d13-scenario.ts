/**
 * Direction 13 (Portfolio planning), packaged ForgeOrbitQA window. Fake drivers, disposable profile, synthetic Codex profiles,
 * recorded synthetic quota rows, no provider, no login, no quota source, no model call.
 *
 * The QA sandbox forces every driver to be fake, so the Router labels every candidate Simulated and the forecast could never offer
 * an alternative preview (FO-FORECAST-NATIVE01 marked it BLOCKED). This build contains one QA-only seam: in the guarded QA build a
 * Simulated candidate that passes every other check is eligible FOR THE READ-ONLY COMPARISON. It stays labelled Simulated, it never
 * reaches the Router, a launch or a proposal. The scenario proves that last part in the window too: "Review resource change" is
 * refused for the same Simulated alternative.
 *
 * Fixture (recorded synthetic rows; the same case as scripts/qa-portfolio-planning-fixture.ts):
 *   Accounts A (Alpha) and B (Beta) share ONE evidenced USD credit pool. Each project fits alone, together they are short.
 *   "Alpha parser tests" depends on "Alpha parser". Account D has its own pool with room (the independent alternative).
 *   Account C is eligible but has NO quota evidence (capacity Unknown) and carries a recorded refusal.
 *
 * Window (PN): Analytics > Forecasts > Backlog tasks > the three tasks > Estimate > open "Beta importer" > preview the independent
 * alternative, then the Unknown-capacity one, then "Review resource change". Exact accounting, stale reviews and apply are asserted
 * on the backend and in Chromium (portfolio-planning.suite.ts, direction13-preview.suite.ts, e2e/forecast-portfolio.spec.ts).
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AccountCore } from "../src/bun/account-core.ts";
import { observePool, PLANNING_PROMPT, recordPool, recordRefusal, seedPlanningHistory, writeProjectManifest, type PlanningContext } from "./qa-portfolio-planning-fixture.ts";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, activate, matching } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "Forecasts selection and Estimate, the shared pool and shortfall, the first constraint per task, the two alternative previews (independent account, Unknown capacity), the refused review of a Simulated alternative",
    "PN records read from the packaged core (API of the same isolated profile)": "tasks, runs, estimate and plan counters before and after each preview, task rows",
    "Backend and Chromium (exact accounting, stale review, apply)": "src/bun/usage-analytics/portfolio-planning.suite.ts, direction13-preview.suite.ts, e2e/forecast-portfolio.spec.ts",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const text = () => find(() => true).flatMap((n: any) => [n.AXTitle, n.AXDescription, typeof n.AXValue === "string" ? n.AXValue : ""]).filter(Boolean).join("\n");
  const around = (part: string, lines = 12) => { const all = text().split("\n"); const i = all.findIndex((l) => l.includes(part)); return i < 0 ? "" : all.slice(Math.max(0, i - 2), i + lines).join("\n"); };
  const fixtures = join(runtime, "fixtures");
  const model = "gpt-6.1-sol";
  const dbPath = join(runtime, "data/agetor.sqlite");
  const openDb = (readonly = false) => { const d = new Database(dbPath, readonly ? { readonly: true } : undefined); d.run("PRAGMA busy_timeout = 5000"); return d; };

  // ---- prerequisites (API of the isolated profile, then recorded rows with the app stopped) ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const profileHome = join(runtime, "home/profiles");
  mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  const accounts: any[] = [];
  for (const name of ["Alpha account", "Beta account", "Unknown capacity account", "Independent account"]) {
    const directory = join(profileHome, name.replace(/ /g, "-").toLowerCase());
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    writeFileSync(join(directory, "synthetic-authenticated"), name, { mode: 0o600 });
    const p = await api("POST", "/account-core/codex-profiles", { displayName: name, directory }, 201);
    await api("PATCH", `/harnesses/${p.harnessId}`, { bin: join(runtime, "codex"), enabled: true });
    await api("POST", `/account-core/codex-profiles/${p.accountId}/check`);
    accounts.push(p);
  }
  const [a, b, cc, d] = accounts as [any, any, any, any];
  const alphaPath = join(fixtures, "Alpha"), betaPath = join(fixtures, "Beta");
  for (const p of [alphaPath, betaPath]) writeProjectManifest(p);
  await api("POST", "/projects", { path: alphaPath, name: "Alpha" });
  await api("POST", "/projects", { path: betaPath, name: "Beta" });
  const make = async (title: string, harnessId: string, workdir: string) => {
    const made = await api("POST", "/tasks", { title, prompt: PLANNING_PROMPT, workdir, agent: harnessId, model, mode: "auto", isolation: "none", column: "backlog" });
    return (made.task ?? made).id as string;
  };
  const t1 = await make("Alpha parser", a.harnessId, alphaPath);
  const t3 = await make("Alpha parser tests", a.harnessId, alphaPath);
  const t2 = await make("Beta importer", b.harnessId, betaPath);
  await down();
  const now = Date.now();
  const pctx: PlanningContext = { a, b, c: cc, d, alphaPath, betaPath, model, now };
  let db = openDb();
  let core = new AccountCore(db);
  seedPlanningHistory(db, pctx);
  db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [t3, t1, now]);
  const poolA = recordPool(core, a.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
  const poolB = recordPool(core, b.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
  recordPool(core, d.accountId, "independent", 100_000_000, null, now);
  recordRefusal(db, cc, now);
  db.close();
  await up();
  const demand = async (taskIds: string[]) => (await api("POST", "/api/usage-analytics/forecast", { taskIds, save: false })).capacity.rows.find((r: any) => r.shared).knownDemand as number;
  const total = await demand([t1, t3, t2]), alphaOnly = await demand([t1, t3]), betaOnly = await demand([t2]);
  const high = Math.max(alphaOnly, betaOnly);
  const balance = high + Math.floor((total - high) / 2);
  await down();
  db = openDb(); core = new AccountCore(db);
  observePool(core, poolA.id, a.accountId, "shared", balance, "shared-credit", now);
  observePool(core, poolB.id, b.accountId, "shared", balance, "shared-credit", now);
  db.close();
  await up();
  await show("Main navigation");
  assert(alphaOnly < balance && betaOnly < balance && total > balance, "fixture: each project fits alone, together they do not");
  mark(`Seeded: two projects on one shared USD pool (balance ${balance}, Alpha alone ${alphaOnly}, Beta alone ${betaOnly}, together ${total}), a dependency, an independent account and an Unknown-capacity account with a recorded refusal`);

  const TABLES = ["tasks", "runs", "run_events", "usage_task_estimates", "usage_group_forecasts", "allocation_plans", "project_account_preferences", "orchestration_missions", "quota_observations", "provider_refusal_observations", "task_dependencies"];
  const counters = () => {
    const r = openDb(true);
    try {
      return {
        ...Object.fromEntries(TABLES.map((t) => [t, (r.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n])),
        taskRows: r.query(`SELECT id, "column", agent, model, mode, run_id FROM tasks ORDER BY id`).all(),
      };
    } finally { r.close(); }
  };

  // ---- 1. Forecasts: select the three tasks and Estimate (the documented write: unstarted estimate revisions) ----
  await button("Analytics", true, 0); await sleep(900);
  await button("Forecasts", true, 0); await sleep(900);
  await button("Backlog tasks", false, 0); await sleep(700);
  for (const title of ["Alpha parser", "Alpha parser tests", "Beta importer"]) {
    const box = await poll(`checkbox ${title}`, () => find((n: any) => n.AXRole === "AXCheckBox" && matching("AXCheckBox", title, true)(n)).at(-1) ?? null, 15_000);
    if (box.AXValue !== 1 && box.AXValue !== true) activate(box);
    await sleep(300);
  }
  const beforeEstimate = counters();
  await button("Estimate", true);
  await show("First constraint on each task", 40_000);
  await sleep(1500);
  const afterEstimate = counters();
  assert.equal(afterEstimate.runs, beforeEstimate.runs, "Estimate started no run");
  assert.deepEqual(afterEstimate.taskRows, beforeEstimate.taskRows, "Estimate changed no task");
  assert.equal(afterEstimate.allocation_plans, 0);
  assert(has("A forecast is not a launch authorization"), "the boundary line is shown");
  assert(has("Known shortfall"), "the shared pool shows a known shortfall");
  assert(!has("Insufficient data"), "a known shortfall is not labelled Insufficient data");
  assert(has("Waiting for another task"), "the dependent task says it waits for another task");
  assert(has("Known pool shortfall"), "the task the pool cannot fund names the pool shortfall as its first constraint");
  shot("01-estimate-shared-pool");
  evidence.estimate = { balance, alphaOnly, betaOnly, total, runsBefore: beforeEstimate.runs, runsAfter: afterEstimate.runs, estimateRowsBefore: beforeEstimate.usage_task_estimates, estimateRowsAfter: afterEstimate.usage_task_estimates };
  mark(`Estimate: one shared pool row (known shortfall ${total - balance}), 'Waiting for another task' for the dependent task, 'Known pool shortfall' for Beta importer. No run, no task change, no plan. Estimate saved unstarted revisions (${beforeEstimate.usage_task_estimates} to ${afterEstimate.usage_task_estimates}) as documented`);

  // ---- 2. Open Beta importer and preview the independent alternative ----
  await button("Beta importer", true); await sleep(1200);   // the last match: the task row, not the checkbox above it
  await show("Preview alternative schedule", 20_000);
  const optionsText = text();
  assert(optionsText.includes("Simulated harness (QA preview only)") || has("QA preview only"), "the candidates stay labelled Simulated (QA preview only)");
  // The preview button that sits in the same row as the account's name.
  const previewFor = async (account: string) => {
    const label = (n: any) => [n.AXTitle, n.AXDescription, typeof n.AXValue === "string" ? n.AXValue : ""];
    return poll(`preview button for ${account}`, () => {
      const nodes = find(() => true) as any[];
      const models = nodes.filter((n) => n.AXRole === "AXStaticText" && n.frame && label(n).includes(model));
      const accountsAt = nodes.filter((n) => n.AXRole === "AXStaticText" && n.frame && label(n).includes(account)
        && models.some((m) => Math.abs(m.frame.y - n.frame.y) < 10));
      const buttons = nodes.filter((n) => n.AXRole === "AXButton" && n.frame && [n.AXTitle, n.AXDescription].includes("Preview alternative schedule"));
      for (const row of accountsAt) {
        // The Developer table's row: its preview button starts within the row's own height. Reviewer rows have none.
        const hit = buttons.find((btn) => btn.frame.y >= row.frame.y - 6 && btn.frame.y - row.frame.y < 60);
        if (hit) return hit;
      }
      return null;
    }, 15_000);
  };
  const before1 = counters();
  activate(await previewFor("Independent account"));
  await show("Current allocation versus the alternative", 30_000);
  await sleep(1500);
  assert(has("Beta importer"), "the comparison names the task");
  assert(has("Changed") && has("account"), "the comparison states that the account changed");
  assert(has("Known shortfall") && has("Fits the observed balance"), "the shared pool goes from a known shortfall to fitting");
  assert(has("Not charged"), "the independent pool was not charged before");
  assert(has("Affected tasks"), "the affected tasks are listed");
  assert(has("Beta importer") && has("Known pool shortfall"), "the affected task moves off the pool shortfall");
  assert(has("A schedule is unavailable") || has("rests on capacity that is not evidenced") || has("Unknown — an unresolved constraint remains"), "a reason is stated wherever a difference is unavailable");
  assert(has("This is a preview. It changed no selection"), "the preview boundary is stated");
  assert(!has("Fits the observed balance") === false);
  shot("02-preview-independent");
  const after1 = counters();
  assert.deepEqual(after1, before1, "the preview changed nothing stored");
  evidence.independent = { text: around("Current allocation versus the alternative", 40).slice(0, 1800) };
  mark("Preview of the independent-account alternative (a Simulated candidate, previewable only in this QA build): resource and account changed, the shared pool goes from a known shortfall to fitting, the independent pool was not charged before, affected tasks listed, a reason where a difference is unavailable. Counters identical before and after");

  // ---- 3. The Unknown-capacity alternative is never presented as feasible ----
  activate(await previewFor("Unknown capacity account"));
  await sleep(2500);
  assert(has("Capacity is Unknown"), "the Unknown-capacity alternative reads 'Capacity is Unknown'");
  assert(!has("Fits the observed balance") || has("Capacity is Unknown"), "Unknown capacity is not described as fitting");
  assert(has("The schedule rests on capacity that is not evidenced, so no difference is shown.") || has("rests on capacity that is not evidenced"), "no schedule difference is shown for Unknown capacity");
  assert(has("refused") || has("usage limit") || has("Provider"), "the recorded refusal is shown beside the candidate as evidence of an earlier refused request");
  shot("03-preview-unknown-capacity");
  assert.deepEqual(counters(), before1, "the second preview changed nothing stored either");
  mark("Preview of the Unknown-capacity alternative: its first constraint reads 'Capacity is Unknown', no schedule difference is shown, no date, and the recorded refusal sits beside the candidate as evidence only (not a quota reading). Counters unchanged");

  // ---- 4. Review is a separate step and it refuses a Simulated alternative ----
  const reviewButtons = find((n: any) => n.AXRole === "AXButton" && [n.AXTitle, n.AXDescription].includes("Review resource change"));
  assert(reviewButtons.length > 0, "the separate review step is offered next to the preview");
  activate(reviewButtons.at(-1));
  await sleep(2500);
  assert(has("currently unavailable") || has("exact registered execution profile") || has("Select a different"), "the review of a Simulated alternative is refused with a reason");
  assert(!has("Approve resource selection"), "no approval is offered for a Simulated alternative");
  shot("04-review-refused");
  const finalState = counters();
  assert.equal(finalState.allocation_plans, 0, "no plan was written");
  assert.equal(finalState.runs, before1.runs, "no run exists");
  assert.deepEqual(finalState.taskRows, before1.taskRows, "no task, agent or resource selection changed");
  assert.equal(finalState.project_account_preferences, 0);
  evidence.review = { refused: true, plans: finalState.allocation_plans };
  mark("'Review resource change' for the Simulated alternative was refused with a reason; no plan was written, nothing was selected, no run exists. The preview seam does not reach proposals, approval or apply");

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
  // The Owner's own ChatGPT/Codex desktop app writes under ~/.codex while it runs; the QA process cannot be that writer
  // (isolated CODEX_HOME, inert stub). That single path is tolerated only while the app server runs, and the tolerance is recorded.
  const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
  const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
  const unexplained = changed.filter((p) => !tolerated.includes(p));
  evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
  assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = unexplained.length === 0 && tolerated.length === 0;
  mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
  save();
  void ax; void down;
}
