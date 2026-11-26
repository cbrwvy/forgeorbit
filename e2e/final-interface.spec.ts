import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, TestInfo, Locator } from "@playwright/test";
import { test, expect, api, registerProject, projectPage, managerMessage } from "./organization-acceptance-fixture";
import { gotoApp, openPortfolio } from "./helpers";

// The existing canonical backend fixture installs temporary HOME/SQLite,
// fake drivers and inert CLI binaries before its first import.
test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function expand(details: Locator) {
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
}
async function shot(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.locator("body")).not.toContainText("[i18n]");
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
async function projectNav(page: Page, dir: string, surface: string) {
  // The project rail item is always present since M3; `projectPage` waits for it. The old
  // "Expand project sidebar" fallback no longer exists, and `isVisible()` does not wait.
  await projectPage(page, dir, surface);
}
async function language(page: Page, locale: string) {
  if (await page.locator("html").getAttribute("lang") !== locale) await page.keyboard.press("Alt+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

async function contrast(page: Page, info: TestInfo) {
  const ratios = await page.evaluate(() => {
    const probe = document.createElement("span"); document.body.append(probe);
    const rgb = (token: string) => {
      probe.style.color = `hsl(var(--${token}))`;
      return getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255);
    };
    const luminance = (v: number[]) => v.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i]!, 0);
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
      return (hi! + .05) / (lo! + .05);
    };
    const fill = rgb("destructive"), card = rgb("card");
    const [hoverHi, hoverLo] = [luminance(rgb("destructive-foreground")), luminance(fill.map((c, i) => .9 * c + .1 * card[i]!))].sort((a, b) => b - a);
    const result = {
      mutedCard: ratio("muted-foreground", "card"), mutedAccent: ratio("muted-foreground", "accent"),
      errorCard: ratio("danger", "card"), errorAccent: ratio("danger", "accent"),
      destructiveButton: ratio("destructive-foreground", "destructive"),
      destructiveHover: (hoverHi! + .05) / (hoverLo! + .05),
    };
    probe.remove(); return result;
  });
  for (const value of Object.values(ratios)) expect(value).toBeGreaterThanOrEqual(4.5);
  await info.attach(`computed-token-contrast-${await page.locator("html").getAttribute("class")}`, { body: JSON.stringify(ratios, null, 2), contentType: "application/json" });
}

test("FO012C-P3-01 composer translates live, preserves drafts, slash commands and file mentions", async ({ page, request, companyBackend: b }, info) => {
  const dir = await registerProject(request, b, "Composer locale");
  await mkdir(path.join(dir, ".claude/commands"), { recursive: true });
  await writeFile(path.join(dir, ".claude/commands/review.md"), "Review the current code.");
  await writeFile(path.join(dir, "README.md"), "# Offline composer fixture");
  // Real registered non-Git discovery; no file-list projection or Git init.
  await gotoApp(page, b.bootBase);
  await projectNav(page, dir, "board");
  const prompt = page.getByTestId("prompt-textarea");
  // A non-Git folder already runs without isolation and shows a notice instead of the toggle.
  const isolate = page.getByTestId("isolate-toggle");
  if (await isolate.count()) await isolate.uncheck();
  await expect(prompt).toHaveAttribute("placeholder", "What should the agent do? Type / for commands, @ for files.");
  await page.getByPlaceholder("Short description").fill("Original draft · исходный текст");
  await prompt.fill("Draft / @README.md · пользовательский текст");
  await language(page, "ru");
  await expect(prompt).toHaveValue("Draft / @README.md · пользовательский текст");
  await expect(prompt).toHaveAttribute("placeholder", "Что поручить агенту? / — команды, @ — файлы.");
  await expect(page.getByLabel("Промпт", { exact: true })).toHaveValue("Draft / @README.md · пользовательский текст");
  await shot(page, info, "ru-draft");
  await prompt.fill("/");
  await expect(page.getByTestId("slash-autocomplete")).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Подсказки команд и промптов" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(prompt).toBeFocused();
  await prompt.fill("@READ");
  await expect(page.getByTestId("at-file-autocomplete-row").filter({ hasText: "README.md" })).toBeVisible();
  await language(page, "en");
  await expect(prompt).toHaveValue("@READ");
  await expect(page.getByRole("listbox", { name: "Project file suggestions" })).toBeVisible();
  await page.keyboard.press("Enter"); await expect(prompt).toHaveValue(/@README.md/);
  await expect(page.getByPlaceholder("Short description")).toHaveValue("Original draft · исходный текст");
  expect(await api(request, b, "GET", "/tasks")).toEqual([]);
  await shot(page, info, "en-file-mention");
});

test("FO-UI01 journal loading, empty and error states translate live without exposing diagnostics", async ({ page, companyBackend: b }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 900 });
  await gotoApp(page, b.bootBase);
  await page.getByTestId("workspace-company").click(); await page.getByTestId("company-tab-activity").click();
  await expect(page.getByTestId("activity-empty")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await language(page, "en");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
    await page.keyboard.press("Escape");
    await contrast(page, info);
  for (const locale of ["en", "ru"]) {
    await language(page, locale);
    await expect(page.getByTestId("activity-empty")).toHaveText(locale === "en" ? "No confirmed events match these filters." : "Нет подтверждённых событий по выбранным фильтрам.");
    await shot(page, info, `${theme}-${locale}-journal-empty`);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/activity?*", async route => { await gate; await route.continue(); });
    await page.getByTestId("activity-refresh").click();
    await expect(page.getByTestId("activity-loading")).toHaveText(locale === "en" ? "Loading journal…" : "Загрузка журнала…");
    await shot(page, info, `${theme}-${locale}-journal-loading`);
    release(); await expect(page.getByTestId("activity-loading")).toHaveText("");
    await page.unroute("**/activity?*");
    await page.route("**/activity?*", route => route.fulfill({ status: 503, json: { error: "PRIVATE_DIAGNOSTIC_DO_NOT_RENDER" } }));
    await page.getByTestId("activity-refresh").click();
    await expect(page.getByTestId("activity-error")).toContainText(locale === "en" ? "Could not load the journal" : "Не удалось загрузить журнал");
    await expect(page.getByTestId("activity-journal")).not.toContainText("PRIVATE_DIAGNOSTIC");
    // Compare the actual utility's rendered color with the semantic status
    // text token, not only the underlying variables.
    expect(await page.getByTestId("activity-error").evaluate(el => {
      const probe = document.createElement("span"); probe.style.color = "hsl(var(--danger))"; el.append(probe);
      const equal = getComputedStyle(el).color === getComputedStyle(probe).color; probe.remove(); return equal;
    })).toBe(true);
    await shot(page, info, `${theme}-${locale}-journal-error`);
    await page.unroute("**/activity?*"); await page.getByTestId("activity-refresh").click();
    await expect(page.getByTestId("activity-error")).toHaveCount(0);
  }
  }
});

for (const width of [390, 768, 1024, 1280, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`FO-UI01 ${width}px ${theme}: Company, managers, Team Builder, board, review, history and journal EN/RU`, async ({ page, request, companyBackend: b }, info) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const dir = await registerProject(request, b, "Проект с длинным названием для проверки интерфейса", true);
    await api(request, b, "PUT", "/employees/head", { name: "Morgan · Руководитель" }, 201);
    await api(request, b, "POST", "/employees/project-managers", { projectPath: dir }, 201);
    const employee = await api(request, b, "POST", "/employees", { name: "Ada · Разработчик", jobTitle: "Инженер программного обеспечения", projectPath: dir }, 201);
    await api(request, b, "POST", `/employees/${employee.id}/professional-profile`, { catalogRoleSlug: "engineering-frontend-developer", promptMarkdown: "# Offline professional\nKeep Owner approval boundaries." });
    const task = await api(request, b, "POST", "/tasks", { title: "Проверить длинные подписи и доступность элементов", prompt: "Offline UI acceptance", isolation: "none", workdir: dir, agent: "claude-code", model: "opus", mode: "auto", column: "ready" });
    await api(request, b, "POST", "/task-assignments", { taskId: task.id, employeeId: employee.id }, 201);
    await api(request, b, "PATCH", "/harnesses/codex", { enabled: true });
    const preflight = await api(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
    const config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
    await api(request, b, "PUT", "/portfolio-manager/config", { config });
    await api(request, b, "PUT", "/project-manager/config", { path: dir, config });
    await api(request, b, "PUT", "/preferences/theme", { value: theme }, 204);
    await gotoApp(page, b.bootBase);
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
    await contrast(page, info);

    // Full navigation inventory in each language at every requested size/theme.
    for (const locale of ["en", "ru"]) {
      await language(page, locale);
      await page.getByTestId("workspace-company").click();
      await expect(page.getByTestId("company-head-name")).toContainText("Morgan");
      expect((await page.getByTestId("company-head").boundingBox())!.width).toBeGreaterThanOrEqual(224);
      await expect(page.getByTestId("company-card")).toContainText(locale === "en" ? "Clusters: 0 · Projects: 1" : "Кластеры: 0 · Проекты: 1");
      await shot(page, info, `${locale}-company-dashboard`);
      await page.getByTestId("company-tab-dashboard").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("company-tab-chart")).toBeFocused();
      await expect(page.getByTestId("company-tab-chart")).toHaveAttribute("aria-selected", "true");
      await shot(page, info, `${locale}-organization`);
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("staff-directory")).toBeVisible();
      await expect(page.getByTestId("staff-count")).toContainText(locale === "en" ? "Employees shown:" : "Показано сотрудников:");
      await page.getByTestId("staff-row").filter({ hasText: "Ada" }).click();
      await expect(page.getByTestId("employee-card-name")).toContainText("Ada");
      await shot(page, info, `${locale}-employee`);
      await page.getByTestId("employee-edit").click();
      await expect(page.getByTestId("employee-form")).toBeVisible();
      await shot(page, info, `${locale}-employee-dialog`);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("employee-edit")).toBeFocused();
      await openPortfolio(page);
      await page.getByTestId("portfolio-tab-manager").click();
      await expect(page.getByTestId("portfolio-manager-composer")).toBeVisible();
      await shot(page, info, `${locale}-portfolio-manager`);
      await projectNav(page, dir, "manager");
      await expect(page.getByTestId("manager-composer")).toBeVisible();
      await shot(page, info, `${locale}-project-manager`);
      await page.getByTestId("manager-build-team").click();
      await expect(page.getByTestId("runbook-option-startup-mvp")).toBeVisible();
      await expect(page.getByTestId("use-runbook-button")).toBeEnabled();
      const runbooks = page.getByTestId("runbooks-dialog");
      const bounds = await runbooks.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await runbooks.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expect(page.getByTestId("use-runbook-button")).toBeInViewport();
      await shot(page, info, `${locale}-team-builder`);
      if (locale === "en") {
        await page.getByTestId("use-runbook-button").click();
        await page.getByTestId("manager-send").click();
        // Ada already has the frontend role: the fake PM proposes the missing
        // backend specialist, rather than duplicating an existing employee.
        await expect(page.getByTestId("hiring-proposal-card")).toHaveCount(1);
      } else {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("manager-build-team")).toBeFocused();
      }
      const hire = page.getByTestId("hiring-proposal-card").filter({ hasText: "Blake" });
      await hire.scrollIntoViewIfNeeded();
      await shot(page, info, `${locale}-hiring`);
      await hire.getByTestId("approve-proposal-button").click();
      await expect(page.getByRole("dialog").last()).toBeVisible();
      await shot(page, info, `${locale}-hiring-review`);
      await page.keyboard.press("Escape");
      await expect(hire.getByTestId("proposal-status")).toHaveText(locale === "en" ? "Pending Review" : "Ожидает проверки");
      await page.getByTestId("project-page-board").click();
      await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).scrollIntoViewIfNeeded();
      await shot(page, info, `${locale}-kanban`);
      await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
      const router = page.getByTestId("ai-resource-recommendation"), execution = page.getByTestId("employee-execution");
      await expand(router); await router.getByTestId("find-ai-resource").click();
      await expect(router.getByTestId("router-no-verified")).toBeVisible();
      await expand(execution);
      await expect(page.getByTestId("employee-execution-worker-name")).toContainText("Ada");
      await page.getByTestId("employee-execution-harness").selectOption("claude-code");
      const prepare = page.getByTestId("employee-execution-prepare");
      await prepare.scrollIntoViewIfNeeded(); await expect(prepare).toBeInViewport({ ratio: 1 });
      await prepare.focus(); await page.keyboard.press("Enter");
      await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
      await expect(router).toHaveAttribute("open", ""); await expect(execution).toHaveAttribute("open", "");
      await page.getByTestId("employee-execution-run").scrollIntoViewIfNeeded();
      await shot(page, info, `${locale}-router-execution`);
      await page.getByTestId("employee-execution-run").click();
      await expect(page.getByTestId("employee-run-isolation")).toContainText(locale === "en" ? "No Git worktree isolation" : "Без изоляции Git worktree");
      await expect(page.getByTestId("employee-run-cancel")).toBeFocused();
      await expect(page.getByTestId("employee-run-confirm")).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
      await expect(page.getByTestId("employee-run-cancel")).toBeFocused();
      await shot(page, info, `${locale}-execution-review`);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
      await expect(page.getByTestId("employee-execution-run")).toBeFocused();
      await page.getByRole("button", { name: /^(Close task details|Закрыть сведения о задаче)$/ }).click();
      await page.getByRole("button", { name: /^(Settings|Настройки)$/, exact: true }).click();
      await expect(page.getByTestId("language-setting")).toBeVisible();
      await shot(page, info, `${locale}-settings`);
      await page.keyboard.press("Escape");
      await page.getByTestId("workspace-company").click(); await page.getByTestId("company-tab-activity").click();
      await expect(page.getByTestId("activity-loading")).toHaveText("");
      await expect(page.getByTestId("activity-event").first()).toBeVisible();
      await shot(page, info, `${locale}-activity-journal`);
    }
    // Populate real fake-driver Run/Turn history through the visible Owner dialog.
    await projectNav(page, dir, "board");
    await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
    await expand(page.getByTestId("employee-execution"));
    await page.getByTestId("employee-execution-harness").selectOption("claude-code");
    await page.getByTestId("employee-execution-prepare").click();
    await page.getByTestId("employee-execution-run").click();
    await page.getByTestId("employee-run-confirm").click();
    await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
    await expect.poll(async () => (await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0]?.finishedAt).toBeTruthy();
    const turns = page.getByTestId("employee-run-status").getByTestId("professional-turns");
    await expand(turns);
    await expect(turns.getByTestId("professional-turn")).toHaveCount(1);
    await turns.scrollIntoViewIfNeeded();
    await shot(page, info, "ru-run-turn-history");
    await language(page, "en"); await shot(page, info, "en-run-turn-history");
    expect(errors).toEqual([]);
    expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toHaveLength(1);
  });
}
