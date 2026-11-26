import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

async function openProjectAnalytics(page: Page, workdir: string) {
  await page.locator(`[data-testid="project-nav-item"][data-path="${workdir}"]`).click();
  await page.getByTestId("project-page-analytics").click();
  await expect(page.getByTestId("project-analytics")).toBeVisible();
  const details = page.getByTestId("project-analytics-details");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").first().click();
}

test("Owner estimates a Backlog task and inspects recorded actuals without running a model", async ({ page, request, freshBackend: backend }) => {
  const workdir = await mkdtemp(path.join(backend.dataDir, "usage-project-"));
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const registered = await request.post(`${backend.apiBase}/projects`, { headers, data: { path: workdir, name: "Usage fixture" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers, data: { title: "Recorded analytics task", prompt: "Add a parser. Acceptance criteria: verify it with tests.", workdir, isolation: "none", agent: "codex" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id } = await created.json() as { id: string };
  const dbFile = path.join(backend.dataDir, "agetor.sqlite");
  const seed = (write: (db: Database) => void) => {
    using db = new Database(dbFile);
    db.run("PRAGMA busy_timeout = 3000");
    db.transaction(() => write(db)).immediate();
  };
  seed(db => { db.run(`UPDATE tasks SET "column" = 'backlog' WHERE id = ?`, [id]); });

  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${workdir}"]`).click();
  await page.getByTestId("project-page-board").click();
  await page.getByTestId("task-estimate").click();
  const dialog = page.getByTestId("usage-task-dialog");
  await expect(dialog).toBeVisible();
  const estimate = dialog.getByTestId("usage-task-estimate").filter({ visible: true });
  await expect(estimate).toContainText("Revision #");
  await expect(estimate).toContainText("Optimistic");
  await expect(estimate).toContainText("Confidence Low");
  await expect(estimate).toContainText("Unknown");
  const firstRevision = await estimate.innerText();
  const firstId = /Revision #(\d+)/.exec(firstRevision)?.[1];
  await dialog.getByTestId("usage-task-scope").fill("Refactor authentication, concurrency and migrations. Add tests.");
  await dialog.getByTestId("usage-regenerate").click();
  await expect(estimate).toContainText("Revision #");
  await expect.poll(async () => /Revision #(\d+)/.exec(await estimate.innerText())?.[1]).not.toBe(firstId);
  const before = await request.get(`${backend.apiBase}/api/usage-analytics/task?taskId=${id}`, { headers });
  expect((await before.json()).actual.runs).toEqual([]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await openProjectAnalytics(page, workdir);
  await page.getByTestId("usage-tab-forecasts").click();
  await page.getByRole("checkbox", { name: "Assume Unknown capacity is available for planning" }).check();
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  const portfolio = page.getByTestId("usage-group-result");
  await expect(portfolio).toContainText("Conditional completion window");
  await expect(portfolio).toContainText("Recorded analytics task");
  await expect(portfolio.getByTestId("usage-capacity")).toContainText("Subscription demand is Unknown");
  await portfolio.getByRole("button", { name: "Recorded analytics task", exact: true }).click();
  await expect(portfolio.getByTestId("usage-task-estimate")).toContainText("forecast-v2");

  // Simulate one synthetic run in the disposable worker SQLite. The real
  // run-insert and Done triggers still execute. No harness is started.
  seed(db => {
    const at = Date.now();
    db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,usage_scope)
      VALUES (?,?,?,'succeeded',?,?,?)`,
      ["fixture-run", id, "codex", at, at + 250, JSON.stringify({ projectPath: workdir, clusterId: null, missionId: null, category: "task" })]);
    db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES ('fixture-run','status',?,?)",
      [JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model: "gpt-6.1-sol" }), at]);
    db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [id]);
    db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [at + 250, id]);
  });
  await openProjectAnalytics(page, workdir);
  await page.getByTestId("usage-tab-analytics").click();
  await expect(page.getByTestId("usage-analytics-results")).toBeVisible();
  await page.getByTestId("usage-analytics-results").getByRole("button", { name: "Recorded analytics task", exact: true }).click();
  const actual = dialog.getByTestId("usage-task-actual");
  await expect(actual).toContainText("Frozen at first run");
  await expect(actual).toContainText("Synthetic");
  await expect(actual).toContainText("0.25 sec");
  await expect(actual).toContainText("Unknown");
});

test("Owner records and corrects a quota reading without granting provider access", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const accountResponse = await request.post(`${backend.apiBase}/account-core/accounts`, {
    headers, data: { provider: "openai", displayName: "Quota reading fixture" },
  });
  expect(accountResponse.status()).toBe(201);
  const { id } = await accountResponse.json() as { id: string };
  const workdir = await mkdtemp(path.join(backend.dataDir, "quota-project-"));
  const registered = await request.post(`${backend.apiBase}/projects`, { headers, data: { path: workdir, name: "Quota project" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  await gotoApp(page, backend.bootBase);
  await openProjectAnalytics(page, workdir);
  await page.getByTestId("usage-tab-resources").click();
  const resources = page.getByTestId("usage-resources");
  const account = resources.locator("section").filter({ has: page.getByRole("heading", { name: "Quota reading fixture · openai" }) });
  await account.getByRole("button", { name: "Record Owner-reported quota" }).click();
  await account.locator('input[name="window"]').fill("Weekly window");
  await account.locator('input[name="usedPercent"]').fill("70");
  await account.locator('input[name="warning"]').fill("25");
  await account.locator('input[name="resetAt"]').fill("2035-01-01T10:00");
  await account.getByRole("button", { name: "Save observation" }).click();
  await expect(account.getByRole("status")).toContainText("Observation saved");
  await expect(account.getByRole("cell", { name: "70%", exact: true })).toBeVisible();
  await account.getByText("Correct observation", { exact: true }).click();
  await account.getByRole("button", { name: /account · Weekly window/ }).click();
  await account.locator('input[name="usedPercent"]').fill("82");
  await account.getByRole("button", { name: "Save observation" }).click();
  await expect(account.getByText(/Remaining capacity reached/)).toBeVisible();
  await expect(account.getByRole("cell", { name: "82%", exact: true })).toBeVisible();
  await expect(account.getByText("Superseded", { exact: true })).toBeVisible();
  await account.getByText("Quota sources and refresh", { exact: true }).click();
  await expect(account.getByText("Automatic refresh unavailable")).toBeVisible();
  await expect(account.getByRole("button", { name: "Refresh provider evidence" })).toHaveCount(0);
  await page.reload();
  await openProjectAnalytics(page, workdir);
  await page.getByTestId("usage-tab-resources").click();
  await expect(account.getByRole("cell", { name: "82%", exact: true })).toBeVisible();
  const payload = await request.get(`${backend.apiBase}/api/usage-analytics/resources`, { headers });
  const { accounts } = await payload.json();
  expect(accounts.find((a: { id: string }) => a.id === id).quota[0]).toMatchObject({
    current: null, ownerReported: { verification: "unverified", provenance: "user-provided", indicator: { value: 82 } },
  });
});

test("Owner reviews company analytics and exports the filtered report", async ({ page, request, freshBackend: backend }) => {
  const workdir = await mkdtemp(path.join(backend.dataDir, "company-project-"));
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const project = await request.post(`${backend.apiBase}/projects`, { headers, data: { path: workdir, name: "Company export" } });
  expect(project.ok(), await project.text()).toBeTruthy();
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers, data: { title: "Company export task", prompt: "Private acceptance criteria must stay out of the export.", workdir, isolation: "none", agent: "codex" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const task = await created.json() as { id: string };
  const otherDir = await mkdtemp(path.join(backend.dataDir, "other-project-"));
  const other = await request.post(`${backend.apiBase}/projects`, { headers, data: { path: otherDir, name: "Other export" } });
  expect(other.ok(), await other.text()).toBeTruthy();
  const otherTask = await request.post(`${backend.apiBase}/tasks`, {
    headers, data: { title: "Other project task", prompt: "Must stay out of the first project's export.", workdir: otherDir, isolation: "none", agent: "codex" },
  });
  expect(otherTask.ok(), await otherTask.text()).toBeTruthy();
  const otherId = (await otherTask.json() as { id: string }).id;
  using db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  const now = Date.now();
  db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,usage_scope)
    VALUES (?,?,?,'succeeded',?,?,?)`, ["company-export-run", task.id, "codex", now - 20_000, now - 10_000, JSON.stringify({ projectPath: workdir, clusterId: null, missionId: null, category: "task", technology: "TypeScript" })]);
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES ('company-export-run','status',?,?)",
    [JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model: "gpt-6.1-sol" }), now - 10_000]);
  db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [task.id]);
  db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,usage_scope)
    VALUES (?,?,?,'succeeded',?,?,?)`, ["other-export-run", otherId, "codex", now - 20_000, now - 10_000, JSON.stringify({ projectPath: otherDir, clusterId: null, missionId: null, category: "task", technology: "TypeScript" })]);
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES ('other-export-run','status',?,?)",
    [JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model: "gpt-6.1-sol" }), now - 10_000]);
  db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [otherId]);
  await gotoApp(page, backend.bootBase);
  await openProjectAnalytics(page, workdir);
  await expect(page.getByTestId("project-analytics-scope")).toContainText("Company export");
  await page.getByTestId("usage-tab-analytics").click();
  await page.getByTestId("usage-range-last7").click();
  await expect(page.getByTestId("usage-analytics-results").getByRole("button", { name: "Company export task" })).toBeVisible();
  await page.getByTestId("usage-view-time").click();
  await expect(page.getByTestId("usage-analytics-results")).toContainText("Developer time");
  await page.getByTestId("usage-view-costs").click();
  await expect(page.getByTestId("usage-analytics-results")).toContainText("Unknown");
  await page.getByTestId("usage-view-quota").click();
  await expect(page.getByTestId("usage-analytics-results")).toContainText("Per-task subscription quota consumption: Unknown");
  await page.getByTestId("usage-view-performance").click();
  await expect(page.getByTestId("usage-analytics-results")).toContainText("Synthetic runs are excluded from comparison.");
  const files = () => (existsSync(backend.downloadsDir) ? readdirSync(backend.downloadsDir) : []);
  const before = new Set(files());
  await page.getByTestId("usage-export-tasks").click();
  await expect.poll(() => files().filter(name => !before.has(name)).length, { timeout: 15_000 }).toBe(1);
  const csv = readFileSync(path.join(backend.downloadsDir, files().find(name => !before.has(name))!), "utf8");
  expect(csv).toContain("createdToDoneMs");
  expect(csv).toContain("Company export task");
  expect(csv).not.toContain("Other project task");
  expect(csv).not.toContain("Private acceptance criteria");
  await openProjectAnalytics(page, otherDir);
  await expect(page.getByTestId("project-analytics-scope")).toContainText("Other export");
  await expect(page.getByTestId("project-analytics")).toContainText("Other project task");
  await expect(page.getByTestId("project-analytics")).not.toContainText("Company export task");
  await page.keyboard.press("Alt+Shift+KeyL");
  await expect(page.getByTestId("usage-view-overview")).toContainText("Обзор");
});
