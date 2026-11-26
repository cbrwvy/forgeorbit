import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks, openPortfolio } from "./helpers";

/**
 * FO-PM01-UXFIX01 overlay layering. The top-bar usage popovers used to live
 * inside `<header class="overflow-x-auto">`, which clipped them to the 40px bar
 * (overflow-y computes to auto). They are now portaled to <body> on the
 * `z-popover` layer, so on every page they must be fully visible, inside the
 * viewport and the topmost thing at every point of their box.
 */

test.describe.configure({ mode: "serial" });
const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function expectPopoverOnTop(page: Page, label: string, viaScript = false): Promise<void> {
  const chip = page.locator('header button[aria-haspopup="dialog"]').first();
  if (viaScript) await chip.evaluate((el) => (el as HTMLButtonElement).click());
  else await chip.click();
  const popover = page.getByRole("dialog", { name: /usage$/i }).first();
  await expect(popover, label).toBeVisible();
  const info = await popover.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const points: [number, number][] = [[r.x + 6, r.y + 6], [r.x + r.width / 2, r.y + r.height / 2], [r.x + r.width - 6, r.y + r.height - 6]];
    return {
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      onBody: el.parentElement === document.body,
      zIndex: getComputedStyle(el).zIndex,
      covered: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return !!hit && !el.contains(hit); }),
      height: r.height,
    };
  });
  expect(info.onBody, `${label}: portaled to body`).toBe(true);
  expect(info.inside, `${label}: inside viewport`).toBe(true);
  expect(info.covered, `${label}: topmost at every sampled point`).toEqual([false, false, false]);
  expect(Number(info.zIndex), `${label}: popover layer`).toBeGreaterThanOrEqual(60);
  expect(info.height, `${label}: not clipped to the 40px bar`).toBeGreaterThan(60);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
}

test("top-bar usage popovers are topmost and unclipped on every main page, with the dock panel and with a RunPanel", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const dir = await mkdtemp(path.join(tmpdir(), "uxfix-layer-"));
  await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name: "Layer Project" } });
  await request.post(`${backend.apiBase}/tasks`, { headers: auth(backend), data: { title: "Layer card", prompt: "Layer card", isolation: "none", workdir: dir } });
  await gotoApp(page, backend.bootBase);

  const pages: [string, () => Promise<void>][] = [
    ["Overview", async () => { await page.getByTestId("workspace-overview").click(); }],
    ["All tasks", async () => { await openAllTasks(page); }],
    ["Portfolio", async () => { await openPortfolio(page); }],
    ["Company", async () => { await page.getByTestId("workspace-company").click(); }],
    ["Project board", async () => { await page.locator('[data-testid="project-nav-item"]').first().click(); await page.getByTestId("project-page-board").click(); }],
    ["Project manager", async () => { await page.getByTestId("project-page-manager").click(); }],
  ];
  for (const [name, go] of pages) {
    await go();
    await page.waitForTimeout(500);
    await expectPopoverOnTop(page, name);
  }

  // With the Head of PM panel open (it sits on the dock layer, below popovers).
  await page.getByTestId("head-pm-orb").click();
  await expect(page.getByTestId("head-pm-panel")).toBeVisible();
  await expectPopoverOnTop(page, "with Head of PM open");
  await page.getByTestId("head-pm-close").click();

  // With a RunPanel open (the scrim covers the bar, so open the popover by script).
  await page.getByTestId("project-page-board").click();
  await page.getByText("Layer card", { exact: true }).first().click();
  await expect(page.locator("aside").last()).toHaveClass(/translate-x-0/);
  await expectPopoverOnTop(page, "with RunPanel open", true);
});

test("popovers stay inside the window at 760/1024/1440", async ({ page, freshBackend: backend }) => {
  for (const width of [760, 1024, 1440]) {
    await page.setViewportSize({ width, height: 700 });
    await gotoApp(page, backend.bootBase);
    await expectPopoverOnTop(page, `width ${width}`);
  }
});
