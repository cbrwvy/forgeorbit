import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, api, registerProject, projectPage } from "./organization-acceptance-fixture";
import { gotoApp, openAllTasks } from "./helpers";
import type { Page, TestInfo } from "@playwright/test";
import { clickProjectPage, projectPageIsMore } from "./project-nav";

const stage = process.env.UX01_STAGE === "before" ? "before" : "after";
async function shot(page: Page, info: TestInfo, name: string) {
  const dir = path.resolve("docs/qa/evidence/fo-mvp-ux01", stage);
  await mkdir(dir, { recursive: true });
  const png = await page.screenshot({ path: path.join(dir, `${name}.png`) });
  await writeFile(path.join(dir, `${name}.aria.yml`), await page.locator("body").ariaSnapshot());
  await info.attach(name, { body: png, contentType: "image/png" });
}
test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("UX01 inventory: first run, global pages, project pages and settings", async ({ page, companyBackend: b, request }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, info, "first-run");
  await page.keyboard.press("Escape");
  await shot(page, info, "overview-empty");
  const dir = await registerProject(request, b, "UX01 synthetic project", true);
  await gotoApp(page, b.bootBase);
  for (const surface of ["company", "portfolio", "clusters", "knowledge", "all-tasks"]) {
    await page.getByTestId(`workspace-${surface}`).click();
    await shot(page, info, `global-${surface}`);
  }
  for (const surface of ["overview", "board", "estimates", "environment", "manager", "knowledge"]) {
    await projectPage(page, dir, surface);
    if (projectPageIsMore(surface)) await expect(page.getByTestId("project-more")).toHaveAttribute("data-current", "true");
    else await expect(page.getByTestId(`project-page-${surface}`)).toHaveAttribute("aria-pressed", "true");
    await shot(page, info, `project-${surface}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog");
  for (const section of ["General", "Harnesses", "Accounts & Resources", "Agents", "Pipelines", "Git Integration", "Saved Prompts"]) {
    const button = settings.getByRole("button", { name: section, exact: true });
    await button.click();
    await shot(page, info, `settings-${section.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`);
  }
});

test("UX01 Kanban cards open with Enter and Space without starting a Run", async ({ page, companyBackend: b, request }, info) => {
  const dir = await registerProject(request, b, "Keyboard board");
  const task = await api(request, b, "POST", "/tasks", { title: "Review keyboard task", prompt: "Do not execute", workdir: dir, isolation: "none", column: "ready" });
  await gotoApp(page, b.bootBase); await projectPage(page, dir, "board");
  const card = page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) });
  const open = card.getByRole("button", { name: task.title, exact: true });
  await open.focus();
  await shot(page, info, "kanban-keyboard");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close task details" })).toBeVisible();
  await page.getByRole("button", { name: "Close task details" }).click();
  await open.focus(); await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Close task details" })).toBeVisible();
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toHaveLength(0);
});

test("UX01 project picker supports arrows, Enter and restores focus on Escape", async ({ page, companyBackend: b, request }, info) => {
  const dir = await registerProject(request, b, "Picker keyboard");
  await gotoApp(page, b.bootBase); await projectPage(page, dir, "board");
  // The New task panel's Project picker (the breadcrumb and sidebar also carry the project name).
  const trigger = page.getByTestId("new-task-panel").getByRole("button", { name: path.basename(dir), exact: true });
  await trigger.click();
  const search = page.getByPlaceholder("Search projects…");
  await expect(search).toBeFocused();
  await shot(page, info, "project-picker-open");
  await page.keyboard.press("Escape");
  await shot(page, info, "project-picker-escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("UX01 agent editor exposes field names and selection to assistive technology", async ({ page, companyBackend: b }, info) => {
  await gotoApp(page, b.bootBase);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Library", exact: true }).click();
  await dialog.getByRole("button", { name: /Add agent/ }).click();
  await expect(page.getByTestId("agent-profile-name")).toBeVisible();
  await shot(page, info, "agent-editor");
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Mode", exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
  const selected = dialog.getByRole("button", { name: /Claude Code/ }).first();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
});

test("UX01 agent picker restores focus when dismissed", async ({ page, companyBackend: b }, info) => {
  await gotoApp(page, b.bootBase);
  const trigger = page.getByTestId("agent-profile-picker-trigger");
  await trigger.click();
  await expect(page.getByTestId("agent-profile-picker-search")).toBeFocused();
  await page.keyboard.press("Escape");
  await shot(page, info, "agent-picker-escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("UX01 board filter restores focus and announces multiple selection", async ({ page, companyBackend: b }, info) => {
  await gotoApp(page, b.bootBase); await openAllTasks(page);
  const trigger = page.getByRole("button", { name: "All types", exact: true });
  await trigger.click();
  await page.keyboard.press("Escape");
  await shot(page, info, "board-filter-escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox").getByRole("option", { selected: true })).toHaveCount(1);
});

test("UX01 filter popup is visible outside its toolbar", async ({ page, companyBackend: b }, info) => {
  await gotoApp(page, b.bootBase); await openAllTasks(page);
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
    await page.getByRole("button", { name: "All types", exact: true }).click();
    await shot(page, info, width === 1280 ? "board-filter-popup" : `board-filter-popup-${width}`);
    const list = page.getByRole("listbox");
    await expect(list).toBeInViewport({ ratio: 1 });
    const bug = list.getByRole("option").filter({ hasText: "Bug" });
    await bug.click(); await expect(bug).toHaveAttribute("aria-selected", "true");
    await bug.click(); await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test("UX01 wide chat tables stay readable with local keyboard scrolling", async ({ page, companyBackend: b, request }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const dir = await registerProject(request, b, "Wide table chat");
  const cells = Array.from({ length: 8 }, (_, i) => `column_${i}_long_identifier`);
  const prompt = `| ${cells.join(" | ")} |\n| ${cells.map(() => "---").join(" | ")} |\n| ${cells.map((_, i) => `value_${i}`).join(" | ")} |`;
  const task = await api(request, b, "POST", "/tasks", { title: "Review wide results", prompt, workdir: dir, isolation: "none" });
  await api(request, b, "POST", `/tasks/${task.id}/start`);
  await gotoApp(page, b.bootBase); await projectPage(page, dir, "board");
  await page.getByText(task.title, { exact: true }).click();
  const table = page.locator(".agetor-md table");
  await expect(table).toBeVisible();
  await shot(page, info, "chat-wide-table");
  const scroll = table.locator("..");
  expect(await scroll.evaluate(el => ["auto", "scroll"].includes(getComputedStyle(el).overflowX))).toBe(true);
  await expect(scroll).toHaveAttribute("tabindex", "0");
  await scroll.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

for (const theme of ["light", "dark"]) test(`UX01 ${theme} agent save errors remain readable and announce failure`, async ({ page, companyBackend: b, request }, info) => {
  await api(request, b, "PUT", "/preferences/theme", { value: theme }, 204);
  await gotoApp(page, b.bootBase);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Library", exact: true }).click();
  await dialog.getByTestId("agent-profile-add").click();
  await page.getByTestId("agent-profile-name").fill("Contrast fixture");
  await page.route("**/agent-profiles", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { error: "Could not save this agent. Try again." } }) : route.continue());
  await page.getByTestId("agent-profile-save").click();
  const error = page.getByTestId("agent-profile-form-error");
  await expect(error).toContainText("Could not save this agent");
  await shot(page, info, `agent-error-${theme}`);
  const ratio = await error.evaluate(el => {
    const rgba = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    let background = [255, 255, 255];
    const ancestors = []; for (let node: Element | null = el; node; node = node.parentElement) ancestors.unshift(node);
    for (const node of ancestors) {
      const color = rgba(getComputedStyle(node).backgroundColor), alpha = color[3] ?? 1;
      background = background.map((c, i) => (color[i] ?? 0) * alpha + c * (1 - alpha));
    }
    const luminance = (v: number[]) => v.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i]!, 0);
    const [hi, lo] = [luminance(rgba(getComputedStyle(el).color)), luminance(background)].sort((a, b) => b - a);
    return (hi! + .05) / (lo! + .05);
  });
  await info.attach("rendered-error-contrast", { body: JSON.stringify({ theme, ratio }), contentType: "application/json" });
  await writeFile(path.resolve("docs/qa/evidence/fo-mvp-ux01", stage, `agent-error-${theme}.json`), JSON.stringify({ theme, ratio, required: 4.5 }, null, 2) + "\n");
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await expect(error).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("agent-profile-name")).toHaveValue("Contrast fixture");
});
