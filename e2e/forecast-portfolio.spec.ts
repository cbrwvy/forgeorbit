import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { gotoApp, openProjectAnalytics } from "./helpers";
import { writeCodexProfileFixture } from "./codex-profile-fixture";
import { AccountCore } from "../src/bun/account-core";
import {
  observePool, PLANNING_PROMPT, recordPool, recordRefusal, seedPlanningHistory, writeProjectManifest, type PlanningContext,
} from "../scripts/qa-portfolio-planning-fixture";

/**
 * FO-FORECAST-PORTFOLIO01: the real Forecasts page over a cross-project Backlog selection. Two projects
 * share one evidenced USD pool; each fits it alone, together they do not. A dependency separates a task
 * waiting on another task from the task the pool cannot fund. Every agent and account is synthetic and
 * no provider is called. The Estimate button saves unstarted estimate revisions (existing behaviour);
 * everything after it must leave stored state unchanged.
 */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "fo-portfolio-e2e-")));
const profileHome = join(scratch, "home");
mkdirSync(profileHome);
// AGETOR_CODEX_DRIVER is cleared only so the Router stops labelling Codex candidates "Simulated"; the
// binary is the synthetic profile fixture, and no task is ever started in this journey (asserted below).
test.use({ backendEnv: { HOME: profileHome, AGETOR_CODEX_DRIVER: "off", AGETOR_CODEX_BIN: writeCodexProfileFixture(scratch, process.execPath) } });
test.describe.configure({ timeout: 150_000 });

type Call = (method: string, route: string, data?: unknown, status?: number) => Promise<any>;

async function seed(call: Call, dataDir: string) {
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const accounts = [];
  for (const name of ["Alpha account", "Beta account", "Unknown capacity account", "Independent account"]) {
    const directory = join(profileHome, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "synthetic-authenticated"), name, { mode: 0o600 });
    const profile = await call("POST", "/account-core/codex-profiles", { displayName: name, directory }, 201);
    // The local login-status check runs the synthetic profile binary; it is what marks the account signed in for the Router.
    expect((await call("POST", `/account-core/codex-profiles/${profile.accountId}/check`)).availability).toBe("ready");
    accounts.push(profile);
  }
  const [a, b, c, d] = accounts;
  const alphaPath = join(scratch, "Alpha");
  const betaPath = join(scratch, "Beta");
  for (const path of [alphaPath, betaPath]) writeProjectManifest(path);
  await call("POST", "/projects", { path: alphaPath, name: "Alpha" });
  await call("POST", "/projects", { path: betaPath, name: "Beta" });
  const model = "gpt-6.1-sol";
  const make = async (title: string, harnessId: string, workdir: string) => (await call("POST", "/tasks", {
    title, prompt: PLANNING_PROMPT, workdir, agent: harnessId, model, isolation: "none", column: "backlog",
  })).id as string;
  const t1 = await make("Alpha parser", a.harnessId, alphaPath);
  const t3 = await make("Alpha parser tests", a.harnessId, alphaPath);
  const t2 = await make("Beta importer", b.harnessId, betaPath);
  const now = Date.now();
  const ctx: PlanningContext = { a, b, c, d, alphaPath, betaPath, model, now };
  const db = new Database(join(dataDir, "agetor.sqlite"));
  db.run("PRAGMA busy_timeout = 5000");
  const core = new AccountCore(db);
  seedPlanningHistory(db, ctx);
  db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [t3, t1, now]);
  const sharedA = recordPool(core, a.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
  const sharedB = recordPool(core, b.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
  recordPool(core, d.accountId, "independent", 100_000_000, null, now);
  recordRefusal(db, c, now);
  // Read-only calculations (save:false) tell how much demand each side carries; the balance is then set between them.
  const sharedDemand = async (taskIds: string[]) =>
    (await call("POST", "/api/usage-analytics/forecast", { taskIds, save: false })).capacity.rows.find((row: any) => row.shared).knownDemand as number;
  const total = await sharedDemand([t1, t3, t2]);
  const alphaOnly = await sharedDemand([t1, t3]);
  const betaOnly = await sharedDemand([t2]);
  const high = Math.max(alphaOnly, betaOnly);
  const balance = high + Math.floor((total - high) / 2);
  observePool(core, sharedA.id, a.accountId, "shared", balance, "shared-credit", now);
  observePool(core, sharedB.id, b.accountId, "shared", balance, "shared-credit", now);
  db.close();
  return { t1, t2, t3, a, b, c, d, total, alphaOnly, betaOnly, balance, alphaPath, betaPath };
}

/** The Router trusts a local login check for only 30 s, so each forecast follows a fresh check (a local synthetic-binary run, not a provider call). */
const checkSignIn = async (call: Call, accounts: Array<{ accountId: string }>) => {
  for (const account of accounts) await call("POST", `/account-core/codex-profiles/${account.accountId}/check`);
};

const STATE_TABLES = [
  "tasks", "runs", "usage_task_estimates", "usage_group_forecasts", "allocation_plans", "project_account_preferences",
  "orchestration_missions", "provider_refusal_observations", "quota_observations", "task_dependencies", "autonomy_policies",
];
function state(dataDir: string) {
  using db = new Database(join(dataDir, "agetor.sqlite"), { readonly: true });
  const rows = Object.fromEntries(STATE_TABLES.map(table => [table, db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]));
  return {
    rows,
    tasks: db.query(`SELECT id, "column", agent, model, mode, run_id, prompt FROM tasks ORDER BY id`).all(),
    estimates: db.query("SELECT id, superseded FROM usage_task_estimates ORDER BY id").all(),
  };
}

/** Records every non-GET request so a calculation is told apart from a mutation. */
function writes(page: Page) {
  const seen: Array<{ method: string; path: string; body: any }> = [];
  page.on("request", request => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    const url = new URL(request.url());
    if (url.pathname.startsWith("/preferences/") || /^\/tasks\/[^/]+\/seen$/.test(url.pathname) || url.pathname === "/projects/discover") return;
    let body: any = null;
    try { body = JSON.parse(request.postData() ?? "null"); } catch { /* not JSON */ }
    seen.push({ method: request.method(), path: url.pathname, body });
  });
  return seen;
}

async function select(page: Page, projectPath: string, titles: string[]) {
  await openProjectAnalytics(page, projectPath);
  await page.getByTestId("usage-tab-forecasts").click();
  await expect(page.getByTestId("usage-forecast-project")).toBeVisible();
  await page.locator("summary", { hasText: /^Backlog tasks|^Задачи бэклога/ }).click();
  for (const title of titles) await page.getByRole("checkbox", { name: title, exact: true }).check();
}

test("the Owner finds the first constraint across projects and previews one alternative without changing anything", async ({ page, request, freshBackend: backend }, info) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const call: Call = async (method, route, data, status = 200) => {
    const response = await request.fetch(backend.apiBase + route, { method, headers, data });
    expect(response.status(), `${method} ${route}: ${await response.text()}`).toBe(status);
    return status === 204 ? null : await response.json();
  };
  await call("PUT", "/preferences/locale", { value: "en" }, 204);
  const f = await seed(call, backend.dataDir);
  expect(f.alphaOnly).toBeLessThan(f.balance);
  expect(f.betaOnly).toBeLessThan(f.balance);
  expect(f.total).toBeGreaterThan(f.balance);
  const sent = writes(page);

  // The combined shortfall is still calculated by the service. The page no longer
  // offers a company-wide selector: each project's Analytics lists only its tasks.
  const combined = await call("POST", "/api/usage-analytics/forecast", { taskIds: [f.t1, f.t3, f.t2], save: false });
  expect(combined.capacity.rows.find((row: { shared?: boolean }) => row.shared).knownDemand).toBe(f.total);

  await gotoApp(page, backend.bootBase);
  await openProjectAnalytics(page, f.alphaPath);
  await page.getByTestId("usage-tab-forecasts").click();
  await expect(page.getByTestId("usage-forecast-project")).toContainText("Alpha");
  await page.locator("summary", { hasText: /^Backlog tasks/ }).click();
  await expect(page.getByRole("checkbox", { name: "Alpha parser", exact: true })).toBeVisible();

  // 1. Estimate Beta on its own page. The forecast stays on Beta even though the backlog list is shared.
  await select(page, f.betaPath, ["Beta importer"]);
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  const result = page.getByTestId("usage-group-result");
  await expect(result).toBeVisible();

  // 2. Beta's page does not mix in Alpha's tasks. Beta alone fits the shared pool.
  const constraints = result.getByTestId("forecast-constraints");
  await expect(constraints.getByTestId("forecast-boundary")).toContainText("not a launch authorization");
  await expect(constraints.locator(`[data-task-id="${f.t1}"]`)).toHaveCount(0);
  await expect(constraints.locator(`[data-task-id="${f.t3}"]`)).toHaveCount(0);
  const betaRow = constraints.locator(`[data-testid="forecast-constraint-row"][data-task-id="${f.t2}"]`);
  await expect(betaRow).toBeVisible();
  await expect(betaRow).not.toHaveAttribute("data-kind", "quota-shortfall");
  await expect(result.getByTestId("usage-group-result")).toHaveCount(0);
  await expect(result).toContainText("A start time requires separate launch approval");

  const capacity = result.getByTestId("usage-capacity").first();
  const pools = capacity.locator("tbody tr");
  await expect(pools).toHaveCount(1);
  await expect(pools.first()).toContainText("Fits the observed balance");
  await expect(pools.first()).not.toContainText("Known shortfall");
  await expect(pools.first()).toContainText("Shared pool");
  const cells = pools.first().locator("td");
  const num = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  await expect(cells.nth(2)).toHaveText(num(f.balance));
  await expect(cells.nth(3)).toHaveText(num(f.betaOnly));
  await constraints.screenshot({ path: info.outputPath("portfolio-constraints.png") });

  // 4. Preview the independent alternative for the task the pool cannot fund.
  await result.getByRole("button", { name: "Beta importer", exact: true }).click();
  const estimate = result.getByTestId("usage-task-estimate");
  const independent = estimate.getByRole("row").filter({ hasText: "Independent account" }).filter({ hasText: "gpt-6.1-sol" }).first();
  await expect(independent.getByTestId("usage-option-refusal")).toHaveCount(0);
  const before = state(backend.dataDir);
  const mark = sent.length;
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await independent.getByRole("button", { name: "Preview alternative schedule" }).click();
  const comparison = estimate.getByTestId("alternative-comparison");
  await expect(comparison).toBeVisible();
  await expect(comparison.getByTestId("alternative-current-resource")).toContainText("Beta account");
  await expect(comparison.getByTestId("alternative-proposed-resource")).toContainText("Independent account");
  await expect(comparison.getByTestId("alternative-changed")).toContainText("account");
  const sharedRow = comparison.locator('[data-testid^="alternative-row-pool-"]').filter({ hasText: "Shared pool" });
  await expect(sharedRow).toHaveCount(1);
  await expect(sharedRow.locator('[data-testid$="-current"]')).toContainText("Fits the observed balance");
  await expect(sharedRow.locator('[data-testid$="-proposed"]')).not.toContainText("Known shortfall");
  const affected = comparison.getByTestId("alternative-affected-task").filter({ hasText: "Beta importer" });
  await expect(affected).not.toContainText("Known pool shortfall");
  await expect(comparison.getByTestId("alternative-affected-task").filter({ hasText: "Alpha parser tests" })).toHaveCount(0);
  await expect(comparison.getByTestId("alternative-cost-difference")).not.toContainText("Unknown");
  await expect(comparison).toContainText("This is a preview");
  await comparison.screenshot({ path: info.outputPath("portfolio-alternative.png") });

  // The preview was a read-only calculation: its POSTs say save:false, and nothing stored moved.
  const preview = sent.slice(mark);
  expect(preview.length).toBeGreaterThan(0);
  expect(preview.every(item => item.path === "/api/usage-analytics/forecast" && item.body?.save === false)).toBe(true);
  expect(state(backend.dataDir)).toEqual(before);

  // 5. An alternative that is eligible but whose capacity is Unknown is not a known shortfall.
  const unknownCapacity = estimate.getByRole("row").filter({ hasText: "Unknown capacity account" }).filter({ hasText: "gpt-6.1-sol" }).first();
  const refusal = unknownCapacity.getByTestId("usage-option-refusal");
  await expect(refusal).toBeVisible();
  await refusal.locator("summary").first().click();
  await expect(unknownCapacity.getByTestId("usage-option-refusal-notice-unconfirmed")).toBeVisible();
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await unknownCapacity.getByRole("button", { name: "Preview alternative schedule" }).click();
  await expect(comparison.getByTestId("alternative-proposed-resource")).toContainText("Unknown capacity account");
  const unknownAffected = comparison.getByTestId("alternative-affected-task").filter({ hasText: "Beta importer" });
  await expect(unknownAffected).toContainText("Capacity is Unknown");
  await expect(comparison.getByTestId("alternative-assumptions")).toHaveCount(0);
  expect(state(backend.dataDir)).toEqual(before);

  // 6. An Owner assumption is shown as an assumption, never as a measured fact.
  await page.getByRole("checkbox", { name: "Assume Unknown capacity is available for planning" }).check();
  await page.getByRole("checkbox", { name: "Assume separate launch approvals are ready now" }).check();
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  await expect(result).toBeVisible();
  await result.getByRole("button", { name: "Beta importer", exact: true }).click();
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await estimate.getByRole("row").filter({ hasText: "Unknown capacity account" }).filter({ hasText: "gpt-6.1-sol" }).first()
    .getByRole("button", { name: "Preview alternative schedule" }).click();
  await expect(comparison.getByTestId("alternative-assumptions")).toContainText("Owner assumptions, not measured facts");
  await expect(comparison.getByTestId("alternative-assumptions")).toContainText("Assume Unknown capacity is available for planning");
  await page.getByRole("checkbox", { name: "Assume Unknown capacity is available for planning" }).uncheck();
  await page.getByRole("checkbox", { name: "Assume separate launch approvals are ready now" }).uncheck();
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  await result.getByRole("button", { name: "Beta importer", exact: true }).click();

  // 7. Applying the alternative stays a separate, digest-bound proposal.
  const afterEstimates = state(backend.dataDir);
  expect(afterEstimates.rows.allocation_plans).toEqual({ n: 0 });
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await estimate.getByRole("row").filter({ hasText: "Independent account" }).filter({ hasText: "gpt-6.1-sol" }).first()
    .getByRole("button", { name: "Preview alternative schedule" }).click();
  const alternative = estimate.getByTestId("usage-alternative");
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await alternative.getByRole("button", { name: "Review resource change" }).click();
  await expect(alternative).toContainText("Execution requires separate authorization");
  const proposed = state(backend.dataDir);
  expect(proposed.rows.allocation_plans).toEqual({ n: 1 });
  expect(proposed.tasks).toEqual(afterEstimates.tasks); // reviewing selected nothing
  await alternative.getByRole("button", { name: "Approve resource selection" }).click();
  await expect(alternative.getByRole("button", { name: "Apply approved selection" })).toBeVisible();
  expect(state(backend.dataDir).tasks).toEqual(afterEstimates.tasks); // approval selected nothing either
  // The task changes after approval: the approved digest does not carry over to the changed plan.
  await call("PATCH", `/tasks/${f.t2}`, { prompt: `${PLANNING_PROMPT} Also support CSV.` });
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await alternative.getByRole("button", { name: "Apply approved selection" }).click();
  await expect(estimate.getByRole("alert")).toBeVisible(); // the existing refusal, shown beside the proposal
  const final = state(backend.dataDir);
  const t2 = final.tasks.find((task: any) => task.id === f.t2) as any;
  expect(t2.agent).toBe(f.b.harnessId);
  expect(t2.run_id).toBeNull();
  expect(final.rows.runs).toEqual(before.rows.runs);
  expect(sent.filter(item => /\/tasks\/[^/]+\/start$/.test(item.path))).toEqual([]);
});

test("the portfolio view reads in Russian at a compact width", async ({ page, request, freshBackend: backend }, info) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const call: Call = async (method, route, data, status = 200) => {
    const response = await request.fetch(backend.apiBase + route, { method, headers, data });
    expect(response.status(), `${method} ${route}: ${await response.text()}`).toBe(status);
    return status === 204 ? null : await response.json();
  };
  await call("PUT", "/preferences/locale", { value: "ru" }, 204);
  const f = await seed(call, backend.dataDir);
  await page.setViewportSize({ width: 900, height: 844 });
  await gotoApp(page, backend.bootBase);
  await select(page, f.betaPath, ["Beta importer"]);
  await expect(page.getByTestId("usage-forecast-project")).toContainText("Показан только");
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await page.getByRole("button", { name: "Оценить", exact: true }).click();
  const result = page.getByTestId("usage-group-result");
  const constraints = result.getByTestId("forecast-constraints");
  await expect(constraints.getByTestId("forecast-boundary")).toContainText("Прогноз не разрешает запуск");
  await expect(constraints.locator(`[data-task-id="${f.t3}"]`)).toHaveCount(0);
  const pool = result.getByTestId("usage-capacity").first().locator("tbody tr").first();
  await expect(pool).toContainText("Укладывается в наблюдаемый остаток");
  await expect(pool).not.toContainText("Недостаточно данных");
  await result.getByRole("button", { name: "Beta importer", exact: true }).click();
  const estimate = result.getByTestId("usage-task-estimate");
  await checkSignIn(call, [f.a, f.b, f.c, f.d]);
  await estimate.getByRole("row").filter({ hasText: "Independent account" }).filter({ hasText: "gpt-6.1-sol" }).first()
    .getByRole("button", { name: "Посмотреть альтернативный график" }).click();
  const comparison = estimate.getByTestId("alternative-comparison");
  await expect(comparison).toContainText("Текущее распределение");
  await expect(comparison).toContainText("Это предпросмотр");
  // 900 pt and a narrower window: wide tables scroll inside their own boxes.
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const section of [constraints, comparison]) {
      expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `width ${width}`).toBe(true);
      expect(await section.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth + 1), `width ${width}`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `page ${width}`).toBe(true);
  }
  await constraints.screenshot({ path: info.outputPath("portfolio-compact-ru-constraints.png") });
  await comparison.screenshot({ path: info.outputPath("portfolio-compact-ru-alternative.png") });
});
