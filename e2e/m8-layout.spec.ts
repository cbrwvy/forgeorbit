import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator } from "./fixtures";
import { gotoApp, openSettingsGeneral, openAllTasks } from "./helpers";

/**
 * FO-UX-SIMPLIFY02-M8: layout defects found in the packaged app (WKWebView, 1200x800 window).
 * Each one is checked here by geometry in Chromium at the same size; the native observation is in
 * docs/qa/fo-ux-simplify02-m8-results.md. Fake drivers only.
 */

test.use({ viewport: { width: 1200, height: 800 }, backendEnv: { AGETOR_FAKE_PORTFOLIO_DELAY_MS: "200" } });
test.describe.configure({ timeout: 90_000 });

const headers = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function call<T>(request: APIRequestContext, b: E2EBackend, method: string, route: string, data?: unknown): Promise<T> {
  const response = await request.fetch(b.apiBase + route, { method, data, headers: headers(b) });
  const body = await response.text();
  expect(response.ok(), `${method} ${route}: ${body}`).toBeTruthy();
  return (body ? JSON.parse(body) : null) as T;
}

async function within(inner: Locator, outer: Locator, label: string) {
  const a = await inner.boundingBox();
  const o = await outer.boundingBox();
  expect(a, `${label}: box`).not.toBeNull();
  expect(o, `${label}: outer box`).not.toBeNull();
  expect(a!.y, `${label}: top inside`).toBeGreaterThanOrEqual(o!.y - 1);
  expect(a!.y + a!.height, `${label}: bottom inside`).toBeLessThanOrEqual(o!.y + o!.height + 1);
}

test("Settings jumped to a panel keeps its title, search and close button in view", async ({ page, freshBackend: b }) => {
  await gotoApp(page, b.bootBase);
  const dialog = await openSettingsGeneral(page);
  const panel = dialog.locator("> div").first();
  const search = dialog.getByTestId("settings-search-input");
  // macOS WebKit autocorrect capitalised a typed query and swallowed the Return that picks a hit.
  await expect(search).toHaveAttribute("autocorrect", "off");
  await expect(search).toHaveAttribute("autocapitalize", "off");
  await expect(search).toHaveAttribute("spellcheck", "false");

  await search.fill("автоном");
  await search.fill("autonomy policy");
  await search.press("Enter");
  await expect(dialog.getByTestId("settings-section-autonomy")).toBeVisible();
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBe(0);
  await within(dialog.locator("#settings-dialog-title"), panel, "title");
  await within(search, panel, "search");
  await within(dialog.getByRole("button", { name: "Close", exact: true }), panel, "close");
});

test("an open task panel leaves Emergency Stop reachable in the title bar", async ({ page, request, freshBackend: b }) => {
  const dir = path.join(b.dataDir, "Alpha");
  await mkdir(dir);
  await call(request, b, "POST", "/projects", { path: dir, name: "Project Alpha" });
  await call(request, b, "POST", "/tasks", { title: "Panel under the title bar", prompt: "x", workdir: dir, column: "backlog", agent: "claude-code", model: "opus-5.5", isolation: "none" });
  await gotoApp(page, b.bootBase);
  await openAllTasks(page);
  await page.getByText("Panel under the title bar").first().click();
  await expect(page.getByTestId("run-panel-resize")).toBeVisible();
  const stop = page.getByTestId("emergency-stop-button");
  await expect(stop).toBeVisible();
  // `trial` runs the real actionability check, including "nothing else receives the click".
  await stop.click({ trial: true });
  const header = await page.locator("header.shell-titlebar").boundingBox();
  const aside = await page.locator("aside").filter({ has: page.getByTestId("run-panel-resize") }).boundingBox();
  expect(aside!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
});

test("the Head of PM panel keeps the composer and Send in view after a reply, and the long safety text is one click away", async ({ page, request, freshBackend: b }) => {
  const alpha = path.join(b.dataDir, "Alpha");
  await mkdir(alpha);
  await call(request, b, "POST", "/projects", { path: alpha, name: "Project Alpha" });
  await call(request, b, "PATCH", "/harnesses/codex", { enabled: true });
  const preflight = await call<{ isolation: { consentKey: string } }>(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call(request, b, "PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey } });
  await gotoApp(page, b.bootBase);
  await page.getByTestId("home-goal-target").selectOption({ label: "Project Alpha" });
  await page.getByTestId("home-ask-head").click();
  const panel = page.getByTestId("head-pm-panel");
  await expect(panel).toBeVisible();

  const channel = page.getByTestId("head-pm-owner-channel");
  await expect(channel).toBeHidden();
  await page.getByTestId("head-pm-owner-channel-details").locator("summary").click();
  await expect(channel).toBeVisible();
  await expect(channel).toContainText("cannot approve");
  await page.getByTestId("head-pm-owner-channel-details").locator("summary").click();

  const goal = { kind: "create", title: "Add a health endpoint", description: "Add GET /health that answers ok." };
  await page.getByTestId("head-pm-composer").fill(`__fake_head_board__ ${JSON.stringify(goal)}`);
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-board-proposal").last()).toHaveAttribute("data-status", "pending", { timeout: 20_000 });

  await within(page.getByTestId("head-pm-composer"), panel, "composer");
  await within(page.getByTestId("head-pm-send"), panel, "send");
  // The conversation still has room to read the answer.
  const log = await page.getByTestId("head-pm-log").boundingBox();
  expect(log!.height).toBeGreaterThan(110);
});
