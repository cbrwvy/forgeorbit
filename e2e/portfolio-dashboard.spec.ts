import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-008B portfolio dashboard. Each test owns a fresh headless backend and
 * temp directories, so its state cannot leak into another test on a reused
 * worker. It does not start a harness.
 */

test.describe.configure({ mode: "parallel" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(backend.dataDir, `fo008b-${name}-`));
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  workdir: string,
  column: string,
): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: title, isolation: "none", workdir, column },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function openPortfolio(page: Page): Promise<void> {
  await page.getByTestId("workspace-workspaces").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-portfolio").click();
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
}

test("empty portfolio, project cards, metrics, and navigation", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  await expect(page.getByTestId("portfolio-empty")).toBeVisible();
  await expect(page.getByTestId("portfolio-metric-projects")).toContainText("0");
  await expect(page.getByTestId("portfolio-metric-tasks")).toContainText("0");

  const alpha = await registerProject(request, backend, "Alpha Portfolio");
  const beta = await registerProject(request, backend, "Beta Portfolio");
  const alphaTitle = `alpha-${randomUUID().slice(0, 8)}`;
  const betaTitle = `beta-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, alphaTitle, alpha, "review");
  await createTask(request, backend, betaTitle, beta, "blocked");
  await page.getByTestId("portfolio-refresh").click();
  await expect(page.getByTestId("portfolio-project-card").filter({ hasText: "Alpha Portfolio" })).toBeVisible();
  await expect(page.getByTestId("portfolio-project-card").filter({ hasText: "Beta Portfolio" })).toBeVisible();
  await expect(page.getByTestId("portfolio-metric-projects")).toContainText("2");
  await expect(page.getByTestId("portfolio-metric-review")).toContainText("1");
  await expect(page.getByTestId("portfolio-metric-blocked")).toContainText("1");

  const alphaCard = page.getByTestId("portfolio-project-card").filter({ hasText: "Alpha Portfolio" });
  await expect(alphaCard).not.toContainText(betaTitle);
  await alphaCard.getByTestId("portfolio-open-overview").click();
  await expect(page.getByTestId("project-page-overview")).toHaveAttribute("aria-pressed", "true");
  await openPortfolio(page);
  await page.getByTestId("portfolio-project-card").filter({ hasText: "Alpha Portfolio" }).getByTestId("portfolio-open-board").click();
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: alphaTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: betaTitle })).toHaveCount(0);

  await openPortfolio(page);
  await page.getByTestId("portfolio-project-card").filter({ hasText: "Alpha Portfolio" }).getByTestId("portfolio-open-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await openPortfolio(page);
  await page.getByTestId("portfolio-project-card").filter({ hasText: "Alpha Portfolio" }).getByTestId("portfolio-open-estimates").click();
  await expect(page.getByTestId("project-estimates")).toBeVisible();
  await openPortfolio(page);
  await page.getByTestId("portfolio-project-card").filter({ hasText: "Alpha Portfolio" }).getByTestId("portfolio-open-environment").click();
  await expect(page.getByTestId("environment-page")).toBeVisible();

  await openAllTasks(page);
  await expect(page.getByRole("button", { name: alphaTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: betaTitle })).toBeVisible();
  await page.getByTestId("workspace-overview").click();
  await expect(page.getByTestId("portfolio-dashboard")).toHaveCount(0);
});

test("what-if exclusion is local and comparison sorting does not refetch", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Portfolio");
  const beta = await registerProject(request, backend, "Beta Portfolio");
  const alphaTitle = `alpha-${randomUUID().slice(0, 8)}`;
  const betaTitle = `beta-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, alphaTitle, alpha, "review");
  await createTask(request, backend, betaTitle, beta, "blocked");

  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  const before = await page.getByTestId("portfolio-captured").getAttribute("data-captured");
  await page.getByTestId("portfolio-sort").selectOption("tasks");
  await page.getByTestId("portfolio-filter").selectOption("blocked");
  await expect(page.getByTestId("portfolio-comparison-row")).toHaveCount(1);
  expect(await page.getByTestId("portfolio-captured").getAttribute("data-captured")).toBe(before);
  await page.getByTestId("portfolio-filter").selectOption("all");
  const excludes = page.getByTestId("portfolio-exclude");
  await excludes.first().click();
  await expect(page.getByTestId("portfolio-what-if-note")).toBeVisible();
  await expect(page.getByTestId("portfolio-metric-projects")).toContainText("1");
  await page.getByTestId("portfolio-what-if-reset").click();
  await expect(page.getByTestId("portfolio-metric-projects")).toContainText("2");
  await expect(page.getByTestId("portfolio-recommendations")).toBeVisible();
  await expect(page.getByRole("button", { name: /execute|apply recommendation/i })).toHaveCount(0);
});

test("keyboard reaches portfolio and the layout fits the viewport", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-workspaces").click();
  const more = page.getByTestId("clusters-more");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId("portfolio-dashboard").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(overflow).toBe(true);
  }
});

test("focus and refresh reread the snapshot", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  const first = await page.getByTestId("portfolio-captured").getAttribute("data-captured");
  await registerProject(request, backend, "Late Portfolio");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => page.getByTestId("portfolio-project-card").filter({ hasText: "Late Portfolio" }).count()).toBe(1);
  const second = await page.getByTestId("portfolio-captured").getAttribute("data-captured");
  expect(second).not.toBe(first);
});
