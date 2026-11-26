import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks, openExecutionPlans, openPortfolio, openProjectAnalytics } from "./helpers";

/**
 * FO-UX-SIMPLIFY02-M7: empty screens say what is missing and offer one next action. Genuinely empty,
 * filtered-to-empty, loading and unavailable are different states and read differently. Chromium,
 * fake drivers, a virgin profile per test; nothing here starts a provider.
 */

test.describe.configure({ timeout: 90_000 });

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function put(request: APIRequestContext, b: E2EBackend, key: string, value: string) {
  const res = await request.put(`${b.apiBase}/preferences/${key}`, { headers: auth(b), data: { value } });
  expect(res.ok()).toBeTruthy();
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test("a fresh profile: every destination names what is missing and offers one next step", async ({ page, request, freshBackend: b }) => {
  await gotoApp(page, b.bootBase);
  await page.setViewportSize({ width: 800, height: 900 });

  // Home: the projects list is empty and says how to add one.
  await expect(page.getByTestId("global-overview")).toBeVisible();
  const homeEmpty = page.getByTestId("home-projects").getByTestId("projects-empty");
  await expect(homeEmpty).toContainText("No projects yet");
  await expect(homeEmpty).toContainText("A project is a folder");
  await expect(homeEmpty.getByTestId("overview-add-project")).toBeVisible();

  // All projects is a tab of Portfolio, reached from Workspaces. Same empty state, same action.
  await openPortfolio(page);
  await page.getByTestId("projects-tab-directory").click();
  await expect(page.getByTestId("projects-directory").getByTestId("projects-empty")).toBeVisible();

  // Tasks: nothing exists and there is no project to put a task in, so the action is Add a project.
  await page.getByTestId("workspace-overview").click();
  await openAllTasks(page);
  const board = page.getByTestId("board-empty");
  await expect(board).toHaveAttribute("data-kind", "no-project");
  await expect(page.getByTestId("board-empty-add-project")).toBeVisible();
  await page.getByTestId("board-empty-add-project").click();
  await expect(page.getByTestId("project-wizard")).toBeVisible();
  await page.keyboard.press("Escape");

  // Execution plans: genuinely empty, and the action goes to the controls on the same page.
  await openExecutionPlans(page);
  await expect(page.getByTestId("missions-empty")).toContainText("No missions yet");
  await page.getByTestId("missions-empty-controls").click();
  await expect(page.getByTestId("mission-controls")).toBeFocused();
  await expect(page.getByTestId("missions-unavailable")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // AI Team: no employees.
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  await expect(page.getByTestId("staff-empty")).toContainText("No employees yet");
  await expect(page.getByTestId("staff-empty-create")).toBeVisible();

  // Knowledge: no notes; a search that finds nothing is a different state from having no notes.
  await page.getByTestId("workspace-knowledge").click();
  await expect(page.getByTestId("knowledge-empty")).toContainText("No notes yet");
  await expect(page.getByTestId("knowledge-empty-create")).toBeVisible();
  await page.getByTestId("knowledge-search").fill("zzz-nothing");
  await expect(page.getByTestId("knowledge-no-match")).toContainText("No notes match these filters");
  await expect(page.getByTestId("knowledge-empty")).toHaveCount(0);
  await page.getByTestId("knowledge-clear-filters").click();
  await expect(page.getByTestId("knowledge-empty")).toBeVisible();

  // Analytics is a project tab. An empty project says nothing is recorded, which is not zero usage.
  const analyticsDir = await realpath(await mkdtemp(path.join(tmpdir(), "m7-analytics-")));
  const added = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: analyticsDir, name: "Empty Analytics" } });
  expect(added.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("open-settings")).toBeVisible();
  await openProjectAnalytics(page, analyticsDir);
  await expect(page.getByTestId("project-analytics-nothing-recorded")).toContainText("not zero usage");
  await page.getByTestId("usage-tab-analytics").click();
  await expect(page.getByTestId("usage-empty")).toContainText("not zero usage");
  await expect(page.getByTestId("usage-analytics-results")).toHaveCount(0);
  await page.getByTestId("usage-range-today").click();
  await expect(page.getByTestId("usage-empty-filtered")).toBeVisible();
  await expect(page.getByTestId("usage-analytics-results")).toHaveCount(0);
  await page.getByTestId("usage-empty-reset").click();
  await expect(page.getByTestId("usage-empty")).toBeVisible();
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");

  await noOverflow(page);
});

test("the Tasks board tells nothing-yet from filtered-to-empty", async ({ page, request, freshBackend: b }) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "m7-board-")));
  const added = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name: "Board Orbit" } });
  expect(added.ok()).toBeTruthy();
  await gotoApp(page, b.bootBase);
  await openAllTasks(page);

  // A project exists, no task does: the action is Create a task.
  await expect(page.getByTestId("board-empty")).toHaveAttribute("data-kind", "empty");
  await expect(page.getByTestId("board-empty-create-task")).toBeVisible();

  const created = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title: "Visible task", prompt: "x", isolation: "none", workdir: dir } });
  expect(created.ok()).toBeTruthy();
  await expect(page.getByTestId("board-empty")).toHaveCount(0);

  // Tasks exist, the search hides them all: a different message with a Clear filters action.
  await page.getByLabel(/search tasks/i).fill("zzz-nothing");
  await expect(page.getByTestId("board-empty")).toHaveAttribute("data-kind", "filtered");
  await page.getByTestId("board-empty-clear-filters").click();
  await expect(page.getByTestId("board-empty")).toHaveCount(0);
});

test("a failed missions request is unavailable, not an empty list", async ({ page, freshBackend: b }) => {
  await page.route("**/api/orchestration/missions**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "core is busy" }) }));
  await gotoApp(page, b.bootBase);
  await openExecutionPlans(page);
  await expect(page.getByTestId("missions-unavailable")).toContainText("could not be loaded");
  await expect(page.getByTestId("missions-empty")).toHaveCount(0);
  await page.unroute("**/api/orchestration/missions**");
  await page.getByTestId("missions-retry").click();
  await expect(page.getByTestId("missions-empty")).toBeVisible();
  await expect(page.getByTestId("missions-unavailable")).toHaveCount(0);
});

test.describe("Russian copy, 800 px, light and dark", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`ru ${scheme}: empty states read in Russian and do not overflow`, async ({ page, request, freshBackend: b }) => {
      await put(request, b, "locale", "ru");
      await put(request, b, "theme", scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await gotoApp(page, b.bootBase);
      await page.setViewportSize({ width: 800, height: 900 });
      await expect(page.locator("html")).toHaveAttribute("lang", "ru");

      await expect(page.getByTestId("home-projects").getByTestId("projects-empty")).toContainText("Проектов пока нет");
      await openAllTasks(page);
      await expect(page.getByTestId("board-empty")).toContainText("Задач пока нет");
      await openExecutionPlans(page);
      await expect(page.getByTestId("missions-empty")).toContainText("Миссий пока нет");
      await expect(page.getByTestId("missions-empty")).toContainText("руководителю проектов");
      await page.keyboard.press("Escape");
      await page.getByTestId("workspace-knowledge").click();
      await expect(page.getByTestId("knowledge-empty")).toContainText("Заметок пока нет");
      const ruDir = await realpath(await mkdtemp(path.join(tmpdir(), "m7-ru-analytics-")));
      const ruProject = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: ruDir, name: "Пустая аналитика" } });
      expect(ruProject.ok()).toBeTruthy();
      await page.reload();
      await expect(page.getByTestId("open-settings")).toBeVisible();
      await openProjectAnalytics(page, ruDir);
      await expect(page.getByTestId("project-analytics-nothing-recorded")).toContainText("не нулев");
      await page.getByTestId("usage-tab-analytics").click();
      await expect(page.getByTestId("usage-empty")).toContainText("не нулевое использование");
      await noOverflow(page);
      // The Latin product term must not leak into Russian copy.
      expect(await page.locator("body").innerText()).not.toContain("Head of PM");
    });
  }

  test("ru: the getting-started block", async ({ page, request, freshBackend: b }) => {
    await put(request, b, "locale", "ru");
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.getByTestId("getting-started")).toContainText("Начало работы");
    await expect(page.getByTestId("getting-started")).toContainText("Поставьте цель руководителю проектов");
    await noOverflow(page);
  });
});
