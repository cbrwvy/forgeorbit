import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-006B estimation dashboard. Uses test-scoped headless backends (`freshBackend`,
 * each with its own SQLite under a dedicated dataDir) to ensure full test
 * isolation without cross-test or cross-spec project leakage. Tasks are created
 * through the API and never started, so no harness, shell, or paid API runs.
 */

test.describe.configure({ mode: "parallel" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(backend.dataDir, `fo006b-${name}-`));
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function createTask(request: APIRequestContext, backend: E2EBackend, title: string, workdir: string): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: `${title} depends on the other task and takes 40 hours`, isolation: "none", workdir },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { id: string };
  return body.id;
}

function projectButton(page: Page, projectPath: string) {
  return page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`);
}

test("an empty project opens Estimates without inventing effort", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Empty");
  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  await expect(page.getByTestId("project-estimates")).toBeVisible();
  await expect(page.getByTestId("estimates-empty")).toBeVisible();
  await expect(page.getByTestId("estimates-scope-group")).toBeDisabled();
  await expect(page.getByTestId("estimates-summary-agent-value")).toHaveText("0m");
  await expect(page.getByTestId("estimates-summary-agent")).toContainText("no work items");
  await expect(page.getByTestId("project-page-board")).toBeVisible();
});

test("tasks, scenarios, money, what-if, save, and project isolation", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(120_000);
  const alpha = await registerProject(request, backend, "Alpha Estimate");
  const beta = await registerProject(request, backend, "Beta Estimate");
  const first = `orbit-${randomUUID().slice(0, 8)}`;
  const second = `dock-${randomUUID().slice(0, 8)}`;
  const renamed = `${first}-renamed`;
  const firstId = await createTask(request, backend, first, alpha);
  await createTask(request, backend, second, alpha);

  await gotoApp(page, backend.bootBase);
  await projectButton(page, alpha).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  await expect(page.getByTestId("project-estimates")).toBeVisible();
  await expect(page.getByTestId("estimates-task-row").filter({ hasText: first })).toBeVisible();
  await expect(page.getByTestId("estimates-task-row").filter({ hasText: second })).toBeVisible();
  await expect(page.getByTestId("estimates-summary-agent-value")).toHaveText("Unknown");
  await expect(page.getByTestId("estimates-summary-cash-value")).toHaveText("Unknown");
  await expect(page.getByTestId("estimates-chart")).toContainText("unknown");
  await expect(page.getByTestId("estimates-scope-group")).toBeDisabled();
  await expect(page.getByTestId("estimates-budget-verdict")).toHaveText("insufficient-data");

  await page.getByTestId("estimates-task-row").filter({ hasText: first }).getByRole("button").click();
  await page.getByTestId("estimates-duration-optimistic").fill("60");
  await page.getByTestId("estimates-duration-expected").fill("90");
  await page.getByTestId("estimates-duration-conservative").fill("120");
  await page.getByRole("checkbox", { name: "Use the task model" }).uncheck();
  await page.getByTestId("estimates-model").fill("opus-e2e");
  await page.getByTestId("estimates-duration-apply").click();

  await expect(page.getByTestId("estimates-task-row").filter({ hasText: first })).toContainText("entered by you");
  await expect(page.getByTestId("estimates-task-row").filter({ hasText: second })).toContainText("None confirmed");
  await expect(page.getByTestId("estimates-summary-agent-value")).toHaveText("Incomplete");
  await expect(page.getByTestId("estimates-summary-agent")).toContainText("not the total");
  await expect(page.getByTestId("estimates-chart")).toContainText("unknown");

  await page.getByTestId("estimates-scope-selected").check();
  await page.getByRole("checkbox", { name: second, exact: true }).uncheck();
  await expect(page.getByTestId("estimates-scenario-optimistic")).toContainText("1h");
  await expect(page.getByTestId("estimates-scenario-expected")).toContainText("1h 30m");
  await expect(page.getByTestId("estimates-scenario-conservative")).toContainText("2h");
  await expect(page.getByTestId("estimates-chart").locator("span.h-2")).toHaveCount(3);

  await page.getByTestId("estimates-budget-overage-off").check();
  await expect(page.getByTestId("estimates-summary-cash-value")).toHaveText("0 (policy)");
  await expect(page.getByTestId("estimates-policy-note")).toContainText("not proof");
  await page.getByTestId("estimates-budget-unset").check();
  await expect(page.getByTestId("estimates-summary-cash-value")).toHaveText("Unknown");

  await page.getByTestId("estimates-currency").fill("EUR");
  await page.getByTestId("estimates-api-request").check();
  await page.getByTestId("estimates-rate-model").fill("opus-e2e");
  await page.getByTestId("estimates-rate-currency").fill("USD");
  await page.getByTestId("estimates-rate-amount").fill("1.50");
  await page.getByTestId("estimates-add-rate").click();
  await expect(page.getByTestId("estimates-summary-api-value")).toHaveText("Mixed currencies");

  await page.getByTestId("estimates-spend-limit").fill("10");
  await page.getByTestId("estimates-spend-limit").blur();
  await expect(page.getByTestId("estimates-budget")).toContainText("Additional cash is unknown");

  await page.getByTestId("estimates-whatif-parallelism").selectOption("number");
  await page.getByTestId("estimates-whatif-cap").fill("4");
  await expect(page.getByTestId("estimates-whatif-delta")).toContainText("not a guarantee");
  await expect(page.getByTestId("estimates-whatif-expected")).toContainText("1h 30m");

  await page.getByTestId("estimates-save").click();
  await expect(page.getByTestId("estimates-saved")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("estimates-scenario-expected")).toContainText("1h 30m");
  await expect(page.getByTestId("estimates-summary-api-value")).toHaveText("Mixed currencies");
  await expect(page.getByTestId("estimates-currency")).toHaveValue("EUR");

  await projectButton(page, beta).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  await expect(page.getByTestId("estimates-empty")).toBeVisible();
  await expect(page.getByTestId("estimates-currency")).toHaveValue("");
  await expect(page.getByText("Mixed currencies")).toHaveCount(0);
  await expect(page.getByText(first)).toHaveCount(0);

  await projectButton(page, alpha).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  const patched = await request.patch(`${backend.apiBase}/tasks/${firstId}`, {
    headers: auth(backend),
    data: { title: renamed },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  await expect(page.getByTestId("estimates-stale")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("project-page-board").click();
  await expect(page.getByRole("button", { name: renamed })).toBeVisible();
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-overview")).toBeVisible();

  await page.getByTestId("project-sidebar-toggle").click();
  await page.getByRole("button", { name: "Collapse new task panel" }).click();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  await expect(page.getByTestId("project-estimates")).toBeVisible();
  await expect.poll(async () => page.getByTestId("project-estimates").evaluate((node) => node.clientWidth)).toBeGreaterThan(240);
  const metrics = await page.getByTestId("project-estimates").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth + 24);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 5_000 });
  await expect(page.getByTestId("estimates-summary-agent-value")).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/, { timeout: 5_000 });
  await expect(page.getByTestId("estimates-scenario-expected")).toContainText("1h 30m");
});

test("structured dependencies from the board drive Estimates and its stale notice", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(90_000);
  const gamma = await registerProject(request, backend, "Gamma Deps");
  const delta = await registerProject(request, backend, "Delta Deps");
  const upstream = `up-${randomUUID().slice(0, 8)}`;
  const downstream = `down-${randomUUID().slice(0, 8)}`;
  const upstreamId = await createTask(request, backend, upstream, gamma);
  const downstreamId = await createTask(request, backend, downstream, gamma);
  await createTask(request, backend, `other-${randomUUID().slice(0, 8)}`, delta);
  const schedule = async (dependsOn: string[], priority?: string) => {
    const res = await request.put(`${backend.apiBase}/project-manager/tasks/${downstreamId}/scheduling`, {
      headers: auth(backend),
      data: { path: gamma, dependsOn, ...(priority ? { priority } : {}) },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  await schedule([upstreamId], "critical");

  await gotoApp(page, backend.bootBase);
  await projectButton(page, gamma).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  const rowOf = (id: string) => page.locator(`[data-testid="estimates-task-row"][data-task-id="${id}"]`);
  const downRow = rowOf(downstreamId);
  await expect(downRow.getByTestId("estimates-task-deps")).toHaveText(`${upstream} (board)`);
  await expect(rowOf(upstreamId).getByTestId("estimates-task-deps")).toHaveText("None confirmed");
  // Priority is not effort: durations stay unknown.
  await expect(downRow).toContainText("Unknown");

  // The board link is shown ticked and locked; Apply with no manual edges keeps it.
  await downRow.getByRole("button").click();
  const option = page.getByTestId("estimates-stage-editor").locator('[data-testid="estimates-dependency-option"][data-board]');
  await expect(option).toBeChecked();
  await expect(option).toBeDisabled();
  await page.getByTestId("estimates-duration-apply").click();
  await expect(downRow.getByTestId("estimates-task-deps")).toHaveText(`${upstream} (board)`);

  await page.getByTestId("estimates-save").click();
  await expect(page.getByTestId("estimates-saved")).toBeVisible();
  await expect(page.getByTestId("estimates-stale")).toHaveCount(0);

  // A link edit does not touch the task rows; the task_dependencies event
  // on /app/events tells the page to re-read the links.
  await schedule([]);
  await expect(page.getByTestId("estimates-stale")).toBeVisible();
  await expect(downRow.getByTestId("estimates-task-deps")).toHaveText("None confirmed");
  await schedule([upstreamId]);
  await expect(page.getByTestId("estimates-stale")).toHaveCount(0);

  // A change made while the tab is not mounted is read when it opens again.
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("project-estimates")).toHaveCount(0);
  await schedule([]);
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  await expect(page.getByTestId("estimates-stale")).toBeVisible();
  await expect(downRow.getByTestId("estimates-task-deps")).toHaveText("None confirmed");
  await schedule([upstreamId]);
  await expect(page.getByTestId("estimates-stale")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(downRow.getByTestId("estimates-task-deps")).toHaveText(`${upstream} (board)`);
  await expect(page.getByTestId("estimates-stale")).toHaveCount(0);

  await projectButton(page, delta).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-estimates").click();
  await expect(page.getByText(upstream)).toHaveCount(0);
  await expect(page.getByText("(board)")).toHaveCount(0);
});
