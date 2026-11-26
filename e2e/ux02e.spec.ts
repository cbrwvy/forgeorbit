import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks, openPortfolio, openWorkspaces } from "./helpers";

/**
 * FO-UX02-E: one page-header system for the global surfaces, secondary actions in a menu,
 * calmer Portfolio cards, no clipped controls in the Manager aside. Fake drivers, nothing runs.
 */

test.describe.configure({ mode: "serial" });
const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });
async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `ux02e-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}
async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, column = "backlog") {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir, column } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

const PAGES = ["overview", "all-tasks", "attention", "portfolio", "company", "clusters", "knowledge"] as const;
const TITLE: Record<(typeof PAGES)[number], string> = {
  overview: "Home", "all-tasks": "All tasks", attention: "Needs you", portfolio: "Portfolio", company: "AI Team", clusters: "Workspaces", knowledge: "Company knowledge",
};
async function openPage(page: Page, id: (typeof PAGES)[number]) {
  if (id === "overview") await page.getByTestId("workspace-overview").click();
  else if (id === "all-tasks") await openAllTasks(page);
  else if (id === "attention") {
    await page.getByTestId("workspace-overview").click();
    await page.getByTestId("workspace-attention").click();
  } else if (id === "portfolio") await openPortfolio(page);
  else if (id === "company") await page.getByTestId("workspace-company").click();
  else if (id === "clusters") await openWorkspaces(page);
  else await page.getByTestId("workspace-knowledge").click();
}

test("every global page has one h1 with the same size and left edge", async ({ page, request, freshBackend: b }) => {
  test.slow();
  const dir = await registerProject(request, b, "Headers");
  await createTask(request, b, "A task", dir, "blocked");
  await gotoApp(page, b.bootBase);
  const seen: { id: string; x: number; size: string; weight: string }[] = [];
  for (const id of PAGES) {
    await openPage(page, id);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1, id).toHaveCount(1);
    await expect(h1, id).toHaveText(TITLE[id]); // wait out the page transition before measuring
    seen.push(await h1.evaluate((el, name) => {
      const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
      return { id: name, x: Math.round(r.x), size: c.fontSize, weight: c.fontWeight };
    }, id));
  }
  expect(new Set(seen.map((s) => s.size)).size, JSON.stringify(seen)).toBe(1);
  expect(new Set(seen.map((s) => s.weight)).size, JSON.stringify(seen)).toBe(1);
  expect(new Set(seen.map((s) => s.x)).size, `left edges ${JSON.stringify(seen)}`).toBe(1);
});

test("Clusters keeps one primary action; secondary navigation is a keyboard-operable menu", async ({ page, freshBackend: b }) => {
  await gotoApp(page, b.bootBase);
  await openWorkspaces(page);
  await expect(page.getByTestId("clusters-create")).toBeVisible();
  await expect(page.getByTestId("clusters-open-inventory")).toHaveCount(0);
  const more = page.getByTestId("clusters-more");
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  // Activating an entry still reaches the page.
  await more.click();
  await page.getByTestId("clusters-more-menu-company-knowledge").click();
  await expect(page.getByTestId("knowledge-heading")).toHaveText("Company knowledge");
  // On the page-level Knowledge screen the primary action lives in the header, once.
  await expect(page.getByTestId("knowledge-create")).toHaveCount(1);
});

test("Portfolio cards lead with the numbers and fold the technical detail away; Manager aside controls are not clipped", async ({ page, request, freshBackend: b }) => {
  test.slow();
  const dir = await registerProject(request, b, "Cards");
  await createTask(request, b, "Review me", dir, "review");
  await gotoApp(page, b.bootBase);
  await openPortfolio(page);
  const card = page.getByTestId("portfolio-project-card").first();
  await expect(card.getByTestId("portfolio-card-stats")).toBeVisible();
  await expect(card.getByTestId("portfolio-card-details")).not.toHaveAttribute("open", "");
  await card.getByTestId("portfolio-card-details").locator("summary").click();
  await expect(card.getByTestId("portfolio-environment-phase")).toBeVisible();
  await expect(card.getByTestId("portfolio-open-board")).toBeVisible();
  // The path is the short form with the full one on hover.
  await expect(card.getByTestId("portfolio-project-path")).toHaveAttribute("title", dir);

  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  for (const tab of ["pending", "approved", "rejected", "withdrawn", "stale", "all"]) {
    const el = page.getByTestId(`filter-tab-${tab}`);
    await expect(el).toBeVisible();
    expect(await el.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${tab} label fits its button`).toBe(true);
    const box = (await el.boundingBox())!;
    expect(box.height, `${tab} is a single line`).toBeLessThan(40);
  }
});

test("headers, Needs you and cards fit at 760/1024/1440 in light and dark with no overflow", async ({ page, request, freshBackend: b }) => {
  test.slow();
  const dir = await registerProject(request, b, "Matrix Project With A Rather Long Name For Wrapping");
  await createTask(request, b, "Blocked thing", dir, "blocked");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1440, 1024, 900, 760]) {
      await page.setViewportSize({ width, height: 800 });
      await gotoApp(page, b.bootBase);
      for (const id of PAGES) {
        await openPage(page, id);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${scheme}/${width} ${id}: no horizontal overflow`).toBe(true);
      }
    }
  }
});
