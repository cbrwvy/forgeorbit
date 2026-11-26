import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page, type E2EBackend, type APIRequestContext } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";
import { clickProjectPage, projectPageIsMore } from "./project-nav";

async function project(request: APIRequestContext, backend: E2EBackend, name: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "fo007a-project-"));
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: { authorization: `Bearer ${backend.apiToken}` }, data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}
async function openProject(page: Page, dir: string) {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
}

for (const width of [390, 768, 1024, 1440]) {
  test(`workspace remains usable at ${width}px with both panel preferences expanded`, async ({ page, request, backend }, testInfo) => {
    const dir = await project(request, backend, "A very long project name ".repeat(3));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await gotoApp(page, backend.bootBase);
    const main = page.locator("main");
    await expect.poll(async () => (await main.boundingBox())?.width ?? 0).toBeGreaterThan(250);
    if (width < 1024) await page.getByRole("button", { name: "Expand project sidebar", exact: true }).click();
    await openProject(page, dir);
    await expect.poll(async () => (await page.getByTestId("project-header-name").boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(120);
    if (width < 1024) await expect(page.getByRole("button", { name: "Expand project sidebar", exact: true })).toBeVisible();
    for (const tab of ["board", "environment", "manager", "overview"]) {
      await clickProjectPage(page, tab);
      const surface = tab === "board" ? "project-header" : tab === "overview" ? "project-overview" : `${tab}-page`;
      await expect(page.getByTestId(surface)).toBeVisible();
      const group = page.getByRole("group", { name: "Project pages" });
      const box = await group.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    if (width < 1024) {
      await page.getByRole("button", { name: "Expand new task panel", exact: true }).click();
      await page.getByPlaceholder("Short description").fill("Draft survives overlays");
      await page.getByRole("button", { name: "Collapse new task panel", exact: true }).click();
      await page.getByRole("button", { name: "Expand new task panel", exact: true }).click();
      await expect(page.getByPlaceholder("Short description")).toHaveValue("Draft survives overlays");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Expand new task panel", exact: true })).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`) });
  });
}

test("Manager keeps unsent drafts per project while tabs unmount, without sending or opening extra streams", async ({ page, request, backend }) => {
  const alpha = await project(request, backend, "Draft Alpha");
  const beta = await project(request, backend, "Draft Beta");
  let sends = 0;
  let streams = 0;
  page.on("request", req => {
    if (req.method() === "POST" && req.url().includes("/project-manager/messages")) sends++;
    if (["/events", "/app/events"].includes(new URL(req.url()).pathname)) streams++;
  });
  await gotoApp(page, backend.bootBase);
  await openProject(page, alpha);
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-composer")).toBeVisible();
  const initialStreams = streams;
  await page.getByTestId("manager-composer").fill("Unsent Alpha draft");
  await page.getByTestId("manager-decision-input").fill("Unconfirmed decision");
  for (let i = 0; i < 4; i++) {
    await page.getByTestId("project-page-board").click();
    await page.getByTestId("project-page-manager").click();
    await expect(page.getByTestId("manager-composer")).toHaveValue("Unsent Alpha draft");
    await expect(page.getByTestId("manager-page")).toHaveCount(1);
  }
  await openProject(page, beta);
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-composer")).toHaveValue("");
  await page.getByTestId("manager-composer").fill("Unsent Beta draft");
  await openProject(page, alpha);
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-composer")).toHaveValue("Unsent Alpha draft");
  await expect(page.getByTestId("manager-decision-input")).toHaveValue("Unconfirmed decision");
  expect(sends).toBe(0);
  expect(initialStreams).toBeGreaterThanOrEqual(2);
  expect(streams).toBe(initialStreams);
});

test("Settings traps keyboard focus across hidden sections, Escape restores the trigger", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  for (let cycle = 0; cycle < 3; cycle++) {
    const dialog = await openSettingsGeneral(page);
    const last = dialog.getByRole("button", { name: "Show getting started guide", exact: true });
    await last.focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  }
});

test("glass falls back to opaque surfaces and no motion when requested", async ({ page, backend }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-transparency", value: "reduce" },
    { name: "prefers-reduced-motion", value: "reduce" },
  ] });
  await gotoApp(page, backend.bootBase);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches)).toBe(true);
  const surface = page.getByTestId("project-sidebar");
  expect(await surface.evaluate(el => getComputedStyle(el).backdropFilter)).toBe("none");
  expect(await surface.evaluate(el => getComputedStyle(el).transitionProperty)).toBe("none");
});


test("Environment keeps a profile draft across tabs and clears it on Cancel without launching", async ({ page, request, backend }) => {
  const dir = await project(request, backend, "Environment draft");
  let launches = 0;
  page.on("request", req => {
    if (req.method() === "POST" && /environment.*\/(start|restart|stop)/.test(req.url())) launches++;
  });
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await page.getByTestId("environment-configure").click();
  await page.getByTestId("profile-name").fill("Unfinished profile");
  await page.getByTestId("profile-executable").fill("qa-do-not-run");
  await page.getByTestId("profile-args").fill("first\nsecond");
  await page.getByTestId("project-page-overview").click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Unfinished profile");
  await expect(page.getByTestId("profile-args")).toHaveValue("first\nsecond");
  await page.getByTestId("profile-cancel").click();
  await page.getByTestId("environment-configure").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Local");
  await expect(page.getByTestId("profile-executable")).toHaveValue("");
  expect(launches).toBe(0);
});

test("a long board remains navigable with 120 tasks and long titles", async ({ page, request, backend }) => {
  const dir = await project(request, backend, "Long list");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (let i = 0; i < 120; i++) {
    const response = await request.post(`${backend.apiBase}/tasks`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      data: { title: `QA ${String(i).padStart(3, "0")} ${"long task title ".repeat(12)}`, prompt: "Never run", workdir: dir, isolation: "none" },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await page.getByTestId("project-page-board").click();
  const cards = page.locator('[data-testid="task-card"]');
  await expect(cards).toHaveCount(120);
  await cards.last().scrollIntoViewIfNeeded();
  // The next-action button now sits right under the title, so open the card by its title.
  await cards.last().getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "Close task panel" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Close task panel" })).toBeHidden();
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-stat-total").getByRole("definition")).toHaveText("120");
  expect(errors).toEqual([]);
});

test("Settings leaves room for theme controls on a 390px window", async ({ page, backend }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  const light = dialog.getByRole("button", { name: "Light", exact: true });
  await expect.poll(async () => (await light.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(70);
  await light.click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  // The close glyph follows the theme's own foreground token (FO-UX-VISUAL01
  // retuned the neutrals, so compare with the live token, not a literal).
  const foreground = () => page.evaluate(() => getComputedStyle(document.body).color);
  const lightForeground = await foreground();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCSS("color", lightForeground);
  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect.poll(foreground).not.toBe(lightForeground);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCSS("color", await foreground());
  await page.screenshot({ path: testInfo.outputPath("settings-390.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("QA backend isolates every built-in account and uses only CLI probe stubs", async ({ request, freshBackend: backend }) => {
  const response = await request.get(`${backend.apiBase}/harnesses`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = await response.json();
  expect(payload.harnesses.length).toBeGreaterThan(0);
  for (const harness of payload.harnesses) {
    expect(harness.home).toBe(path.join(backend.dataDir, "test-accounts", harness.id));
  }
  expect(payload.statuses.length).toBe(payload.harnesses.length);
  for (const status of payload.statuses) {
    // Registry listing deliberately does not probe Codex's version. Its
    // unknown value is part of the read-only status contract, even in QA.
    expect(status.bin).toBe(status.kind === "fx" ? path.join(backend.dataDir, "fx-stub-bin", "fx") : "/bin/echo");
    expect(status.version).toBe(status.kind === "codex" ? null : status.kind === "fx" ? "0.0.4-fake" : "--version");
  }
});
