import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";

/**
 * FO-004B environment page. Uses test-scoped headless backends (`freshBackend`,
 * each with its own SQLite under a dedicated dataDir) to ensure full test
 * isolation without cross-test or cross-spec project/preference leakage. It never
 * starts Docker or a project process — Start stays unclicked. Lifecycle is
 * covered by the fake-host unit tests.
 */

test.describe.configure({ mode: "parallel" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(backend.dataDir, `fo004b-${name}-`));
  await writeFile(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: example\n");
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function openProject(page: Page, projectPath: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
}

test("environment page configures a profile without starting it", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Orbit Env");
  const unauth = await request.get(`${backend.apiBase}/projects/environment?path=${encodeURIComponent(dir)}`);
  expect(unauth.status()).toBe(401);

  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await expect(page.getByTestId("environment-card-phase")).toHaveText("Not configured");
  await page.getByTestId("environment-card-open").click();
  await expect(page.getByTestId("environment-page")).toBeVisible();
  await expect(page.getByTestId("environment-phase")).toHaveText("Not configured");
  await expect(page.getByTestId("environment-empty")).toContainText("compose.yaml");

  await page.getByTestId("environment-configure").click();
  await page.getByTestId("environment-suggestion").click();
  await expect(page.getByTestId("profile-kind")).toHaveValue("docker-compose");
  await expect(page.getByTestId("profile-compose-file")).toHaveValue("compose.yaml");
  await page.getByTestId("profile-cancel").click();

  await page.getByTestId("environment-configure").click();
  await page.getByTestId("profile-kind").selectOption("local-process");
  await page.getByTestId("profile-name").fill("Dev server");
  await page.getByTestId("profile-executable").fill("/usr/bin/true");
  await page.getByTestId("profile-args").fill("ready");
  await page.getByTestId("profile-website").fill("http://127.0.0.1:4317/");
  await page.getByTestId("profile-save").click();

  await expect(page.getByTestId("environment-phase")).toHaveText("Stopped");
  await expect(page.getByTestId("environment-start")).toBeVisible();
  await expect(page.getByTestId("environment-stop")).toHaveCount(0);
  await expect(page.getByTestId("environment-open-website")).toBeVisible();
  await expect(page.getByTestId("environment-services")).toContainText("true");
  await expect(page.getByTestId("environment-urls")).toContainText("http://127.0.0.1:4317/");

  await page.getByTestId("environment-configure").click();
  await page.getByTestId("profile-name").fill("Dev server renamed");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("environment-page")).toContainText("Dev server renamed");

  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("environment-card-phase")).toHaveText("Stopped");
  await expect(page.getByTestId("project-overview")).toBeVisible();
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await page.getByTestId("profile-delete").click();
  await page.getByTestId("profile-delete-confirm").click();
  await expect(page.getByTestId("environment-phase")).toHaveText("Not configured");
});

test("environment page holds up in light, dark, reduced motion, and a narrow window", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Orbit Narrow");
  await putPreference(request, backend, "theme", "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await collapseChrome(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-page")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  const overflow = await page.getByTestId("environment-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
  expect(overflow).toBe(true);

  await putPreference(request, backend, "theme", "light");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await openProject(page, dir);
  await collapseChrome(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-page")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);

  await page.getByTestId("workspace-add-project").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // The worker's backend is shared with later specs: put the theme back to
  // "follow the system" so a spec that emulates dark mode isn't pinned light.
  await putPreference(request, backend, "theme", "auto");
});

async function collapseChrome(page: Page): Promise<void> {
  const sidebar = page.getByRole("button", { name: "Collapse project sidebar" });
  if (await sidebar.count()) await sidebar.click();
  const task = page.getByRole("button", { name: "Collapse new task panel" });
  if (await task.count()) await task.click();
}
