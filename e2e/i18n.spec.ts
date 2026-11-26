import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page, type Locator } from "./fixtures";
import { openAllTasks, openPortfolio, openWorkspaces } from "./helpers";

async function call(request: APIRequestContext, backend: E2EBackend, method: string, route: string, data?: unknown, expected = 200): Promise<any> {
  const response = await request.fetch(`${backend.apiBase}${route}`, { method, headers: { authorization: `Bearer ${backend.apiToken}` }, data });
  expect(response.status(), await response.text()).toBe(expected);
  const text = await response.text(); return text ? JSON.parse(text) : null;
}
async function boot(page: Page, request: APIRequestContext, backend: E2EBackend, locale?: "en" | "ru") {
  await call(request, backend, "PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  if (locale) await call(request, backend, "PUT", "/preferences/locale", { value: locale }, 204);
  await page.route("**/*", route => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto(backend.bootBase);
  await expect(page.getByRole("button", { name: /^(Settings|Настройки)$/ })).toBeVisible();
  if (locale) await expect(page.locator("html")).toHaveAttribute("lang", locale);
}
async function toggle(page: Page, locale: "en" | "ru") {
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}
async function expand(details: Locator) { if (await details.getAttribute("open") === null) await details.locator("summary").first().click(); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true); }

// Browser locale and timezone are fixture inputs, never the owner's preferences.
test.describe("Russian system locale", () => {
  test.use({ locale: "ru-RU", timezoneId: "Europe/Berlin" });
  test("system detection, explicit override, accessible Settings picker and restart persistence", async ({ page, request, freshBackend: backend }) => {
    await boot(page, request, backend);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    const picker = page.getByLabel("Язык", { exact: true });
    await expect(picker).toHaveValue("ru");
    await picker.selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    await expect.poll(async () => (await call(request, backend, "GET", "/preferences")).locale).toBe("en");
    await page.reload();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Europe/Berlin");
  });
});

for (const locale of ["en", "ru"] as const) {
  test(`${locale}: main surfaces, Settings, light/dark desktop and mobile`, async ({ page, request, freshBackend: backend }, info) => {
    await boot(page, request, backend, locale);
    const surfaces: Array<{ en: string; ru: string; go: () => Promise<void> }> = [
      { en: "AI Team", ru: "AI-команда", go: () => page.getByTestId("workspace-company").click() },
      { en: "Portfolio", ru: "Портфель", go: () => openPortfolio(page) },
      { en: "Workspaces", ru: "Пространства", go: () => openWorkspaces(page) },
      { en: "Company knowledge", ru: "База знаний компании", go: () => page.getByTestId("workspace-knowledge").click() },
      { en: "All tasks", ru: "Все задачи", go: () => openAllTasks(page) },
    ];
    for (const surface of surfaces) {
      await surface.go();
      await expect(page.getByRole("heading", { name: locale === "ru" ? surface.ru : surface.en, exact: true, level: 1 })).toBeVisible();
      await noOverflow(page);
      await expect(page.locator("body")).not.toContainText("[i18n]");
    }
    await page.getByRole("button", { name: locale === "ru" ? "Настройки" : "Settings", exact: true }).click();
    await expect(page.getByTestId("language-setting")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      const name = theme === "dark" ? (locale === "ru" ? "Тёмная" : "Dark") : (locale === "ru" ? "Светлая" : "Light");
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await noOverflow(page);
        await expect(page.getByLabel(locale === "ru" ? "Язык" : "Language", { exact: true })).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`${locale}-${theme}-${width}-settings.png`), fullPage: true });
      }
    }
  });
}

test("Russian Employee Execution, frozen professional profile, Owner review and Turn History switch without losing approval", async ({ page, request, freshBackend: backend }, info) => {
  const directory = await mkdtemp(path.join(backend.dataDir, "i18n-professional-"));
  await call(request, backend, "POST", "/projects", { path: directory, name: "Untranslated Project" });
  const employee = await call(request, backend, "POST", "/employees", { name: "Ada Professional", jobTitle: "Backend Developer", projectPath: directory }, 201);
  const historical = "# Original English professional instructions\nHISTORICAL_PROFILE_MARKER <img src=x onerror=alert(1)>";
  await call(request, backend, "POST", `/employees/${employee.id}/professional-profile`, { catalogRoleSlug: "engineering-backend-architect", promptMarkdown: historical });
  const task = await call(request, backend, "POST", "/tasks", { title: "Untranslated Task", prompt: "Original AI prompt", workdir: directory, column: "ready", isolation: "none", agent: "claude-code", model: "opus", mode: "auto" });
  await call(request, backend, "POST", "/task-assignments", { taskId: task.id, employeeId: employee.id }, 201);
  await boot(page, request, backend, "ru");
  await openAllTasks(page);
  await page.getByRole("button", { name: "Untranslated Task" }).click();
  const execution = page.getByTestId("employee-execution"); await expand(execution);
  await expect(execution.locator("summary").first()).toContainText("Выполнение сотрудника");
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog).toContainText("Проверить и подтвердить запуск");
  await expand(dialog.getByTestId("professional-attribution"));
  await expect(dialog.getByTestId("professional-historical-prompt")).toHaveText(historical);
  await expect(dialog.getByTestId("professional-historical-prompt").locator("img")).toHaveCount(0);
  await toggle(page, "en"); await expect(dialog).toContainText("Review and confirm run");
  await toggle(page, "ru"); await expect(dialog.getByTestId("professional-historical-prompt")).toHaveText(historical);
  expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(0);
  await page.getByTestId("employee-run-confirm").click();
  await expect(dialog).toHaveCount(0);
  const attemptsPath = `/employee-execution/attempts?taskId=${task.id}`;
  await expect.poll(async () => (await call(request, backend, "GET", attemptsPath)).attempts[0]?.finishedAt).toBeTruthy();
  const attempt = (await call(request, backend, "GET", attemptsPath)).attempts[0];
  const turnsPath = `/employee-execution/runs/${attempt.runId}/turns`;
  const panel = page.getByTestId("employee-run-status").getByTestId("professional-turns"); await expand(panel);
  await expect(panel.locator("summary").first()).toContainText("можно продолжить");
  const prompt = "Owner authored follow-up · Привет {parameters} <b>unchanged</b>";
  await panel.getByRole("textbox", { name: "Следующее профессиональное сообщение" }).fill(prompt);
  await toggle(page, "en"); await expect(panel.getByRole("textbox", { name: "Professional follow-up message" })).toHaveValue(prompt);
  await toggle(page, "ru"); await panel.getByTestId("professional-follow-up").click();
  const review = panel.getByTestId("professional-turn-review");
  await expect(review).toContainText("Проверка Владельца");
  await expect(review).toContainText("Любое последующее выполнение требует одобрения Владельца.");
  await review.getByRole("checkbox").check();
  const before = await call(request, backend, "GET", turnsPath);
  await toggle(page, "en"); await expect(review.getByRole("checkbox")).toBeChecked();
  await toggle(page, "ru"); await expect(review.getByRole("checkbox")).toBeChecked();
  await expect(panel.getByTestId("professional-turn-reviewed-message")).toHaveText(prompt);
  expect(await call(request, backend, "GET", turnsPath)).toEqual(before);
  await page.setViewportSize({width:390,height:844}); await noOverflow(page);
  await review.getByRole("checkbox").scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("ru-owner-review-mobile.png"),fullPage:true});
  await panel.getByTestId("professional-turn-confirm").click();
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await call(request, backend, "GET", turnsPath)).turns.at(-1).status).toBe("included");
  const after = await call(request, backend, "GET", turnsPath);
  expect(after.turns[0]).toEqual(before.turns[0]); expect(after.turns.at(-1).prompt).toBe(prompt);
  expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(1);
  await expect.poll(async () => (await call(request, backend, "GET", turnsPath)).turns.at(-1).observed_run_ended_at).toBeTruthy();
  const durable = await call(request, backend, "GET", turnsPath);
  // UI projection only: demonstrate unsupported Gemini / indeterminate copy without starting Gemini or mutating audit data.
  const projection = structuredClone(durable);
  projection.session = { state: "unsupported", reason: "Gemini continuation is unsupported in this mode. ORIGINAL_DIAGNOSTIC" };
  projection.turns.at(-1).status = "indeterminate";
  await page.route(`**${turnsPath}`, route => route.fulfill({json:projection}));
  await panel.getByRole("button", {name:"Обновить историю сообщений",exact:true}).click();
  await expect(panel.getByTestId("professional-turn-unsupported")).toContainText("Продолжение сессии в этом режиме не поддерживается");
  await expect(panel.getByTestId("professional-turn-unsupported")).toContainText("Gemini");
  await expect(panel.getByTestId("professional-turn").last().locator("summary")).toContainText("Неизвестно / Неопределённо");
  await expect(panel.getByTestId("professional-follow-up")).toHaveCount(0);
  expect(await call(request, backend, "GET", turnsPath)).toEqual(durable);
});

test("Russian Project Team Builder and hiring Owner confirmation stay live without starting execution", async ({ page, request, freshBackend: backend }) => {
  await call(request, backend, "PATCH", "/harnesses/codex", { enabled: true });
  const directory = await mkdtemp(path.join(backend.dataDir, "i18n-team-"));
  await mkdir(path.join(directory, "docs"));
  await writeFile(path.join(directory, "docs/IDEA.md"), "# Synthetic Team Builder\n");
  await call(request, backend, "POST", "/projects", { path: directory, name: "Original Team Project" });
  await boot(page, request, backend, "ru");
  await page.locator(`[data-testid="project-nav-item"][data-path="${directory}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex");
  await page.getByTestId("manager-consent").check();
  await page.getByTestId("manager-build-team").click();
  await expect(page.getByTestId("runbooks-dialog")).toContainText("Локальные сценарии работы");
  await page.getByTestId("use-runbook-button").click();
  await page.getByTestId("manager-send").click();
  const proposal = page.getByTestId("hiring-proposal-card").filter({hasText:"Devon"});
  await expect(proposal).toBeVisible();
  await expect(proposal.getByTestId("proposal-status")).toHaveText("Ожидает проверки");
  await proposal.getByTestId("approve-proposal-button").click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toContainText("Одобрить найм");
  await toggle(page,"en"); await expect(dialog).toContainText("Approve hiring for Devon?");
  await toggle(page,"ru"); await expect(dialog).toContainText("Одобрить найм Devon?");
  await expect(dialog.getByRole("button",{name:"Одобрить найм",exact:true})).toBeEnabled();
  await dialog.getByRole("button",{name:"Отмена",exact:true}).click();
  await expect(proposal.getByTestId("proposal-status")).toHaveText("Ожидает проверки");
});
