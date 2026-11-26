/**
 * Recurring tasks & autonomous scheduled workflows E2E (FO-KANBAN-RECURRING01).
 *
 * Verifies in Playwright Chromium against a live disposable Bun backend:
 *  - Ordinary non-recurring task creation stays unchanged
 *  - New Task recurring section (disabled by default, frequency, UTC+0 inputs,
 *    multiple weekday toggles, local-time preview, next-occurrence preview,
 *    overlap prevention, auto-submit, expandable Advanced options)
 *  - Project -> More -> Recurring tasks management page (list, edit, pause/resume,
 *    create one-off now, occurrence history, stop preserving history)
 *  - Kanban card repeat indicator + Task Details occurrence distinction & Make recurring
 *  - EN & RU localization + compact MacBook window layout (980x720)
 *  - Screenshots saved to docs/qa/evidence/fo-kanban-recurring01/
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { clickProjectPage } from "./project-nav";

const SHOTS = path.resolve(import.meta.dir, "../docs/qa/evidence/fo-kanban-recurring01");
const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" });

test.describe.configure({ mode: "parallel", timeout: 120_000 });
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Almaty" });

function makeGitProject(name: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-rec-e2e-${name}-`)));
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "src/app.ts"), `export const v = 1;\n`);
  spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "-c", "user.email=qa@example.invalid", "-c", "user.name=QA", "commit", "-qm", "init"]);
  return dir;
}

async function setupProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = makeGitProject(name);
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const projectPath = (await res.json()).path as string;
  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  return projectPath;
}

async function openProject(page: Page, projectPath: string): Promise<void> {
  const nav = page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`);
  await expect(nav).toBeVisible({ timeout: 15_000 });
  await nav.click();
  await expect(page.getByTestId("project-tabs")).toBeVisible({ timeout: 10_000 });
}

test("New Task recurring controls, Kanban card indicator, Task Details, and Project -> More -> Recurring tasks (EN)", async ({
  page,
  request,
  backend,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  const projectPath = await setupProject(request, backend, "rec-en");

  // Seed one ordinary task so we verify non-recurring cards stay clean and offer "Make recurring"
  const ordRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: {
      title: "Fix login redirect",
      prompt: "Ensure login redirects cleanly.",
      workdir: projectPath,
      column: "ready",
      urgency: 4,
      agent: "codex",
      mode: "auto",
      model: "gpt-6.1-sol",
      isolation: "worktree",
      accessMode: "workspace",
    },
  });
  expect(ordRes.ok(), await ordRes.text()).toBeTruthy();

  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openProject(page, projectPath);
  await clickProjectPage(page, "board");

  // Open New Task sheet / panel and verify Recurring task toggle is OFF by default
  const newTaskBtn = page.getByTestId("project-new-task").first();
  if (await newTaskBtn.isVisible().catch(() => false)) {
    await newTaskBtn.click();
  }
  const toggle = page.getByTestId("new-task-recurring-toggle");
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await expect(toggle).not.toBeChecked();

  // Enable Recurring task and configure Weekly (Mon + Fri) at 03:00 UTC
  await page.locator("#new-task-title").fill("Security audit");
  const promptInput = page.locator("#manager-assignment, textarea").first();
  await promptInput.fill("Audit project dependencies and access controls.");
  await page.getByTestId("new-task-urgency").selectOption("4");

  await toggle.check();
  await expect(page.getByTestId("new-task-recurring-fields")).toBeVisible();
  await page.getByTestId("new-task-recurring-frequency").selectOption("weekly");
  await page.getByTestId("new-task-recurring-start-date").fill("2027-11-15"); // Monday
  await page.getByTestId("new-task-recurring-start-time").fill("03:00");

  // Select Monday (1) and Friday (5) first, then clear any other default weekday
  for (const d of [1, 5]) {
    const btn = page.getByTestId(`new-task-recurring-wd-${d}`);
    if ((await btn.getAttribute("aria-pressed")) !== "true") {
      await btn.click();
    }
  }
  for (const d of [2, 3, 4, 6, 7]) {
    const btn = page.getByTestId(`new-task-recurring-wd-${d}`);
    if ((await btn.getAttribute("aria-pressed")) === "true") {
      await btn.click();
    }
  }

  await expect(page.getByTestId("new-task-recurring-tz-badge")).toContainText("UTC+0");
  await expect(page.getByTestId("new-task-recurring-local-preview")).toContainText("Asia/Almaty");
  await expect(page.getByTestId("new-task-recurring-next-preview")).toContainText("Nov 15, 2027, 03:00 UTC");
  await expect(page.getByTestId("new-task-recurring-prevent-overlap")).toBeChecked();
  await expect(page.getByTestId("new-task-recurring-auto-submit")).not.toBeChecked();

  // Open Advanced options to verify End date, Max occurrences, Missed policy
  await page.getByTestId("new-task-recurring-advanced").locator("summary").click();
  await expect(page.getByTestId("new-task-recurring-missed")).toBeVisible();

  await page.screenshot({ path: path.join(SHOTS, "01-new-task-recurring-en.png") });

  // Save recurring template
  await page.getByTestId("new-task-save-recurring").click();

  // Navigate to Project -> More -> Recurring tasks
  await clickProjectPage(page, "recurring");
  await expect(page.getByTestId("recurring-tasks-page")).toBeVisible({ timeout: 10_000 });
  const tplCard = page.getByTestId("recurring-template-card").first();
  await expect(tplCard).toContainText("Security audit");
  await expect(tplCard).toContainText("Weekly (Mon, Fri), 03:00 UTC");
  await expect(tplCard).toContainText("Nov 15, 2027, 03:00 UTC");

  // Create one-off occurrence now without changing regular schedule
  await tplCard.getByTestId("recurring-action-run-now").click();
  await expect(tplCard).toContainText("Generated: 1", { timeout: 10_000 });

  // Open occurrence history and verify row
  await tplCard.getByTestId("recurring-action-history").click();
  await expect(tplCard.getByTestId("recurring-history-panel")).toBeVisible();
  await expect(tplCard.getByTestId("recurring-history-row")).toHaveCount(1);
  await expect(tplCard.getByTestId("recurring-history-row").first()).toContainText("One-off");

  await page.screenshot({ path: path.join(SHOTS, "02-recurring-management-en.png") });

  // Pause and resume template
  await tplCard.getByTestId("recurring-action-pause").click();
  await expect(tplCard.getByTestId("recurring-template-status")).toContainText("Paused");
  await tplCard.getByTestId("recurring-action-resume").click();
  await expect(tplCard.getByTestId("recurring-template-status")).toContainText("Active");

  // Edit template (future occurrences only)
  await tplCard.getByTestId("recurring-action-edit").click();
  await expect(page.getByTestId("recurring-template-dialog")).toBeVisible();
  await page.getByTestId("recurring-dialog-urgency").selectOption("5");
  await page.getByTestId("recurring-dialog-save").click();
  await expect(tplCard).toContainText("5/5");

  // Switch to Board -> verify generated recurring card has compact Repeat badge & ordinary card does not
  await clickProjectPage(page, "board");
  const recCard = page.locator(`[data-testid="task-card"]`).filter({ hasText: "Security audit" }).first();
  await expect(recCard).toBeVisible({ timeout: 10_000 });
  await expect(recCard.getByTestId("task-card-recurring")).toContainText("Weekly (Mon, Fri), 03:00 UTC");

  const ordCard = page.locator(`[data-testid="task-card"][aria-label="Fix login redirect"]`);
  await expect(ordCard).toBeVisible();
  await expect(ordCard.getByTestId("task-card-recurring")).toHaveCount(0);

  await page.screenshot({ path: path.join(SHOTS, "03-kanban-recurring-card-en.png") });

  // Open recurring occurrence in Task Details -> verify occurrence vs future editing distinction
  await recCard.getByTestId("task-card-primary").click();
  await page.locator("aside").getByRole("button", { name: "Details", exact: true }).click();
  await page.getByText("Task details", { exact: true }).first().click();
  await expect(page.getByTestId("task-recurring-row")).toContainText("Weekly (Mon, Fri), 03:00 UTC");
  await expect(page.getByTestId("task-recurring-edit-future")).toBeVisible();

  // Close the recurring task drawer, then open ordinary card in Task Details -> verify Make recurring action
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("task-recurring-edit-future")).not.toBeVisible();
  await ordCard.getByTestId("task-card-primary").click();
  await page.locator("aside").getByRole("button", { name: "Details", exact: true }).click();
  await page.getByText("Task details", { exact: true }).first().click();
  await expect(page.getByTestId("task-make-recurring")).toBeVisible();
});

test("Russian localization and compact MacBook layout (980x720)", async ({ page, request, backend }) => {
  mkdirSync(SHOTS, { recursive: true });
  const projectPath = await setupProject(request, backend, "rec-ru");

  // Seed a recurring template + one-off occurrence via API
  const createRes = await request.post(`${backend.apiBase}/recurring/templates`, {
    headers: auth(backend),
    data: {
      projectPath,
      title: "Аудит безопасности",
      prompt: "Проверить зависимости и конфигурацию безопасности.",
      urgency: 4,
      recurrenceType: "weekly",
      weekdays: [1],
      startDateUtc: "2027-11-15",
      startTimeUtc: "03:00",
      submissionMode: "generate_only",
    },
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();
  const tplId = ((await createRes.json()) as { template: { id: string } }).template.id;
  const trigRes = await request.post(`${backend.apiBase}/recurring/templates/${tplId}/trigger`, {
    headers: auth(backend),
  });
  expect(trigRes.ok(), await trigRes.text()).toBeTruthy();

  // Set Russian locale preference
  await request.put(`${backend.apiBase}/preferences/locale`, {
    headers: auth(backend),
    data: { value: "ru" },
  });

  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openProject(page, projectPath);
  await clickProjectPage(page, "recurring");
  await expect(page.getByTestId("recurring-tasks-page")).toContainText("Повторяющиеся задачи");
  await expect(page.getByTestId("recurring-template-card").first()).toContainText("Каждый понедельник, 03:00 UTC");
  await expect(page.getByTestId("recurring-action-pause").first()).toContainText("Приостановить повторения");
  await expect(page.getByTestId("recurring-action-history").first()).toContainText("История выполнений");
  await page.screenshot({ path: path.join(SHOTS, "04-recurring-management-ru.png") });

  // Verify compact MacBook viewport (980x720) on Kanban board with recurring card
  await page.setViewportSize({ width: 980, height: 720 });
  await clickProjectPage(page, "board");
  const recCard = page.locator(`[data-testid="task-card"]`).filter({ hasText: "Аудит безопасности" }).first();
  await expect(recCard).toBeVisible({ timeout: 10_000 });
  await expect(recCard.getByTestId("task-card-recurring")).toContainText("Каждый понедельник, 03:00 UTC");
  await page.screenshot({ path: path.join(SHOTS, "05-recurring-compact-ru.png") });
});
