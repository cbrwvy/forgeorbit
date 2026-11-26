import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-011B cluster dashboard. Each test owns a fresh headless backend and temp
 * directories, so its registry cannot leak into another spec on a reused worker.
 * It does not start a harness, clone a repository, or call a model.
 */

test.describe.configure({ mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo011b-${name}-`));
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

async function openClusters(page: Page): Promise<void> {
  await page.getByTestId("workspace-workspaces").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
}

test("empty cluster list, keyboard, themes, and viewports", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  const nav = page.getByTestId("workspace-workspaces");
  await nav.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await expect(page.getByTestId("clusters-empty")).toBeVisible();
  await expect(page.getByTestId("clusters-unassigned-empty")).toBeVisible();
  await expect(page.getByTestId("clusters-comparison-note")).toContainText("not added together");

  await page.getByTestId("clusters-create").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("cluster-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  // Browser emulation of the media query, not a macOS setting. The native window is checked separately.
  expect(await page.getByTestId("clusters-create").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(false);
  await expect(page.getByTestId("clusters-page")).toBeVisible();

  for (const width of [390, 768, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId("clusters-page").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
  }
});

test("create, duplicate names, validation errors, and a stable id", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openClusters(page);

  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Twin");
  await page.getByTestId("cluster-description").fill("First copy");
  await page.getByTestId("cluster-slug").fill("twin-slug");
  await page.getByTestId("cluster-color").fill("#336699");
  await page.getByTestId("cluster-icon").fill("layers");
  await page.getByTestId("cluster-priority").fill("2");
  await page.getByTestId("cluster-save").click();
  await expect(page.getByTestId("cluster-dashboard")).toBeVisible();
  const id = await page.getByTestId("cluster-dashboard").getAttribute("data-cluster-id");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  await page.getByTestId("cluster-edit").click();
  await page.getByTestId("cluster-name").fill("Twin renamed");
  await page.getByTestId("cluster-color").fill("#abc");
  await page.getByTestId("cluster-icon").fill("orbit");
  await page.getByTestId("cluster-save").click();
  await expect(page.getByTestId("cluster-dashboard-name")).toHaveText("Twin renamed");
  await expect(page.getByTestId("cluster-dashboard")).toHaveAttribute("data-cluster-id", id!);
  await page.getByTestId("cluster-tab-overview").click();
  await expect(page.getByTestId("cluster-metric-icon")).toContainText("orbit");
  await expect(page.getByTestId("cluster-projects-empty")).toHaveCount(0);
  await page.getByTestId("cluster-tab-projects").click();
  await expect(page.getByTestId("cluster-projects-empty")).toBeVisible();
  await page.getByTestId("cluster-tab-knowledge").click();
  await expect(page.getByTestId("cluster-knowledge")).toContainText("Create note");
  await expect(page.getByTestId("cluster-knowledge")).not.toContainText("# ");
  await expect(page.getByTestId("knowledge-credential-warning")).toBeVisible();
  await page.getByTestId("cluster-tab-infrastructure").click();
  await expect(page.getByTestId("cluster-infrastructure-status")).toContainText("Not verified");
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("0 VPS");
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("All systems online");
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("Online");

  await page.getByTestId("cluster-breadcrumb-clusters").click();
  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Twin renamed");
  await page.getByTestId("cluster-slug").fill("twin-other");
  await page.getByTestId("cluster-save").click();
  await page.getByTestId("cluster-breadcrumb-clusters").click();
  const twins = page.getByTestId("cluster-card").filter({ hasText: "Twin renamed" });
  await expect(twins).toHaveCount(2);
  const ids = await twins.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-cluster-id")));
  expect(new Set(ids).size).toBe(2);

  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Slug clash");
  await page.getByTestId("cluster-slug").fill("twin-slug");
  await page.getByTestId("cluster-save").click();
  await expect(page.getByTestId("cluster-form-error")).toContainText("Slug is already in use.");

  await page.getByTestId("cluster-color").fill("not-a-color");
  await page.getByTestId("cluster-slug").fill("slug-clash-ok");
  await page.getByTestId("cluster-save").click();
  await expect(page.getByTestId("cluster-form-error")).toContainText("Invalid color.");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("assign, move, unassign, and navigation leave the project files alone", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Cluster");
  const beta = await registerProject(request, backend, "Beta Cluster");
  const marker = "leave-me-alone\n";
  await writeFile(path.join(alpha, "marker.txt"), marker);
  await writeFile(path.join(beta, "marker.txt"), marker);

  await gotoApp(page, backend.bootBase);
  await openClusters(page);
  await expect(page.getByTestId("cluster-unassigned-project").filter({ hasText: "Alpha Cluster" })).toBeVisible();
  await expect(page.getByTestId("cluster-unassigned-project").filter({ hasText: "Beta Cluster" })).toBeVisible();

  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Source Cluster");
  await page.getByTestId("cluster-save").click();
  await page.getByTestId("cluster-breadcrumb-clusters").click();
  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Dest Cluster");
  await page.getByTestId("cluster-save").click();
  await page.getByTestId("cluster-breadcrumb-clusters").click();

  await page.getByTestId("cluster-assign-target").selectOption({ label: "Source Cluster" });
  await page.getByTestId("cluster-unassigned-project").filter({ hasText: "Alpha Cluster" }).getByTestId("cluster-assign-unassigned").click();
  await expect(page.getByTestId("cluster-unassigned-project").filter({ hasText: "Alpha Cluster" })).toHaveCount(0);

  await page.getByTestId("cluster-card").filter({ hasText: "Dest Cluster" }).getByTestId("cluster-open").click();
  await page.getByTestId("cluster-tab-projects").click();
  await page.getByTestId("cluster-move-project").selectOption({ label: "Alpha Cluster — Source Cluster" });
  await page.getByTestId("cluster-move").click();
  const moveDialog = page.getByRole("dialog");
  await expect(moveDialog).toContainText("Source Cluster");
  await expect(moveDialog).toContainText("Dest Cluster");
  await expect(moveDialog).toContainText("Alpha Cluster");
  await expect(moveDialog).toContainText("organizational membership");
  await moveDialog.getByRole("button", { name: "Move project" }).click();
  await expect(page.getByTestId("cluster-project").filter({ hasText: "Alpha Cluster" })).toBeVisible();

  await page.getByTestId("cluster-project").filter({ hasText: "Alpha Cluster" }).getByTestId("cluster-open-overview").click();
  await expect(page.getByTestId("project-page-overview")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("project-header-details-toggle").click();
  await expect(page.getByTestId("project-cluster-link")).toContainText("Dest Cluster");
  await page.getByTestId("project-cluster-link").click();
  await expect(page.getByTestId("cluster-dashboard-name")).toHaveText("Dest Cluster");

  await page.getByTestId("cluster-tab-projects").click();
  await page.getByTestId("cluster-project").filter({ hasText: "Alpha Cluster" }).getByTestId("cluster-unassign").click();
  const removeDialog = page.getByRole("dialog");
  await expect(removeDialog).toContainText("organizational membership");
  await removeDialog.getByRole("button", { name: "Remove membership" }).click();
  await expect(page.getByTestId("cluster-projects-empty")).toBeVisible();

  await page.getByTestId("cluster-open-portfolio").click();
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  await expect(page.getByTestId("clusters-page")).toHaveCount(0);
  await page.getByTestId("portfolio-dashboard").getByRole("button", { name: "Accounts & Resources", exact: true }).click();
  await expect(page.getByTestId("accounts-dashboard")).toBeVisible();
  await page.getByTestId("accounts-dashboard").getByRole("button", { name: "Open Portfolio", exact: true }).click();
  await page.getByTestId("portfolio-tab-manager").click();
  await expect(page.getByRole("tabpanel", { name: "Head settings" })).toBeVisible();
  await page.getByTestId("portfolio-tab-overview").click();
  await page.getByTestId("workspace-overview").click();
  await page.getByTestId("global-open-board").click();
  await expect(page.getByTestId("all-tasks-bar")).toBeVisible();
  await page.getByTestId("project-nav-item").filter({ hasText: "Beta Cluster" }).click();
  await expect(page.getByTestId("project-header-name")).toContainText("Beta Cluster");
  await page.getByTestId("project-header-details-toggle").click();
  await expect(page.getByTestId("project-cluster-unassigned")).toBeVisible();

  expect(await readFile(path.join(alpha, "marker.txt"), "utf8")).toBe(marker);
  expect(await readFile(path.join(beta, "marker.txt"), "utf8")).toBe(marker);
  expect(await readdir(alpha)).toEqual(["marker.txt"]);
  expect(await readdir(beta)).toEqual(["marker.txt"]);
});

test("archive keeps projects and archived clusters use their own filter", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Archive Me");
  await gotoApp(page, backend.bootBase);
  await openClusters(page);
  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Archive Cluster");
  await page.getByTestId("cluster-save").click();
  await page.getByTestId("cluster-tab-projects").click();
  await page.getByTestId("cluster-assign-project").selectOption({ label: "Archive Me" });
  await page.getByTestId("cluster-assign").click();
  await expect(page.getByTestId("cluster-project").filter({ hasText: "Archive Me" })).toBeVisible();

  await page.getByTestId("cluster-archive").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 project");
  await expect(dialog).toContainText("does not change Git");
  await dialog.getByRole("button", { name: "Archive space" }).click();
  await expect(page.getByTestId("cluster-archived-note")).toBeVisible();
  await expect(page.getByRole("button", { name: /unarchive/i })).toHaveCount(0);
  await expect(page.getByTestId("cluster-assign")).toHaveCount(0);

  await page.getByTestId("cluster-breadcrumb-clusters").click();
  await expect(page.getByTestId("cluster-card").filter({ hasText: "Archive Cluster" })).toHaveCount(0);
  await page.getByTestId("clusters-filter-archived").click();
  await expect(page.getByTestId("cluster-card").filter({ hasText: "Archive Cluster" })).toBeVisible();
  await page.getByTestId("workspace-workspaces").click();
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-portfolio").click();
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  await expect(page.getByTestId("portfolio-project-card").filter({ hasText: "Archive Me" })).toBeVisible();

  expect(await readdir(dir)).toEqual([]);
});

test("cluster totals use recorded tasks and do not invent an environment", async ({ page, request, freshBackend: backend }) => {
  const reviewDir = await registerProject(request, backend, "Review Cluster");
  const blockedDir = await registerProject(request, backend, "Blocked Cluster");
  const reviewTitle = `review-${randomUUID().slice(0, 8)}`;
  const blockedTitle = `blocked-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, reviewTitle, reviewDir, "review");
  await createTask(request, backend, blockedTitle, blockedDir, "blocked");

  await gotoApp(page, backend.bootBase);
  await openClusters(page);
  await page.getByTestId("clusters-create").click();
  const longName = `Measured ${"Cluster ".repeat(12)}`;
  await page.getByTestId("cluster-name").fill(longName);
  await page.getByTestId("cluster-save").click();
  await page.getByTestId("cluster-tab-projects").click();
  await page.getByTestId("cluster-assign-project").selectOption({ label: "Review Cluster" });
  await page.getByTestId("cluster-assign").click();
  await expect(page.getByTestId("cluster-project").filter({ hasText: "Review Cluster" })).toBeVisible();
  await page.getByTestId("cluster-assign-project").selectOption({ label: "Blocked Cluster" });
  await expect(page.getByTestId("cluster-assign")).toBeEnabled();
  await page.getByTestId("cluster-assign").click();
  await expect(page.getByTestId("cluster-project")).toHaveCount(2);

  await page.getByTestId("cluster-tab-overview").click();
  await expect(page.getByTestId("cluster-metric-projects")).toContainText("2");
  await expect(page.getByTestId("cluster-metric-reviews")).toContainText("1");
  await expect(page.getByTestId("cluster-metric-blocked")).toContainText("1");
  await expect(page.getByTestId("cluster-environment")).toContainText("not shown as current");
  await expect(page.getByTestId("cluster-environment")).not.toContainText("All systems online");
  await expect(page.getByTestId("cluster-environment")).not.toContainText("0 VPS");
  await expect(page.getByTestId("cluster-metric-cost")).toContainText("Unknown");
  await expect(page.getByTestId("cluster-estimates")).toContainText("not treated as zero");
  await expect(page.getByTestId("cluster-resource-warnings")).toContainText("not treated as unlimited");
  await page.getByTestId("cluster-tab-organization").click();
  await expect(page.getByTestId("cluster-organization")).toContainText("Not assigned");
  await expect(page.getByTestId("cluster-organization")).toContainText("Review Cluster");

  await page.getByTestId("cluster-breadcrumb-clusters").click();
  const card = page.getByTestId("cluster-card").filter({ hasText: "Measured" });
  await expect(card).not.toContainText("No icon");
  await expect(card).not.toContainText("Unset");
  await expect(card.getByTestId("cluster-card-reviews")).toContainText("1");
  await expect(card.getByTestId("cluster-card-quality")).toBeVisible();
  await expect(page.getByTestId("cluster-comparison-row").filter({ hasText: "Measured" })).toBeVisible();
  await expect(page.getByTestId("clusters-comparison-note")).toContainText("Mixed currencies");

  await page.setViewportSize({ width: 390, height: 800 });
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(fits).toBe(true);
  await expect(card).toBeVisible();
});

test("Russian spaces at 900px stay on the page and omit empty icon labels", async ({ page, request, freshBackend: backend }) => {
  const pref = await request.put(`${backend.apiBase}/preferences/locale`, {
    headers: auth(backend),
    data: { value: "ru" },
  });
  expect(pref.ok()).toBeTruthy();
  await page.setViewportSize({ width: 900, height: 800 });
  await gotoApp(page, backend.bootBase);
  await openClusters(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Пространства");
  await expect(page.getByTestId("clusters-page")).not.toContainText("Кластер");
  await expect(page.getByTestId("clusters-page")).not.toContainText("Без значка");
  await expect(page.getByTestId("clusters-comparison-note")).toContainText("пространств");
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(fits).toBe(true);

  await page.getByTestId("clusters-create").click();
  await page.getByTestId("cluster-name").fill("Тихое");
  await page.getByTestId("cluster-save").click();
  await expect(page.getByTestId("cluster-dashboard-name")).toHaveText("Тихое");
  await expect(page.getByTestId("cluster-technical-id")).not.toHaveAttribute("open");
  await page.getByTestId("cluster-technical-id").locator("summary").click();
  await expect(page.getByTestId("cluster-id-value")).toBeVisible();
  await page.getByTestId("cluster-breadcrumb-clusters").click();
  const card = page.getByTestId("cluster-card").filter({ hasText: "Тихое" });
  await expect(card).not.toContainText("Без значка");
  await expect(card).not.toContainText("Не задано");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

test("a missing cluster shows the server error", async ({ page, freshBackend: backend }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agetor:workspace", JSON.stringify({
      scope: "cluster",
      id: "00000000-0000-4000-8000-000000000099",
      page: "clusters",
    }));
  });
  await gotoApp(page, backend.bootBase);
  await expect(page.getByTestId("cluster-dashboard-error")).toContainText("Cluster not found.");
  await page.getByTestId("cluster-back").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
});
