/**
 * Scheduled task availability (FO-KANBAN-SCHEDULE01) in Chromium against a disposable Bun backend.
 * Covers creation, editing, clearing, Kanban card UTC display, EN/RU localization,
 * local-time preview across IANA timezones, drag/urgency preservation, dashboards,
 * API validation, and compact macOS window layout.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";
import { clickProjectPage } from "./project-nav";

const SHOTS = path.resolve(import.meta.dir, "../docs/qa/evidence/fo-kanban-schedule01");
const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" });
const FUTURE_ISO = "2027-11-27T08:00:00.000Z";
const UPDATED_ISO = "2027-12-01T14:30:00.000Z";

test.describe.configure({ mode: "parallel", timeout: 120_000 });
test.use({ viewport: { width: 1500, height: 1100 }, timezoneId: "Asia/Almaty" });

function makeProject(name: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-schedule-e2e-${name}-`)));
  const project = path.join(root, name);
  mkdirSync(project, { recursive: true });
  return project;
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = makeProject(name);
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function addTask(
  request: APIRequestContext,
  backend: E2EBackend,
  workdir: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; availableFromUtc: string | null; urgency: number }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: `${title} prompt`, workdir, column: "ready", isolation: "none", ...extra },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as never;
}

function card(page: Page, title: string): Locator {
  return page.locator(`[data-testid="task-card"][aria-label="${title}"]`);
}

async function openTaskDetailsSection(page: Page, title: string): Promise<void> {
  await card(page, title).getByTestId("task-card-primary").click();
  await page.locator("aside").getByRole("button", { name: "Details", exact: true }).click();
  await page.getByText("Task details", { exact: true }).first().click();
}

async function dragHandleAbove(page: Page, fromTitle: string, targetTitle: string): Promise<void> {
  const handleBox = (await card(page, fromTitle).getByTestId("task-card-handle").boundingBox())!;
  const targetBox = (await card(page, targetTitle).boundingBox())!;
  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height * 0.2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 4, { steps: 2 });
  await page.mouse.move(end.x, end.y, { steps: 16 });
  await page.mouse.up();
}

test("create scheduled task in New Task form (EN + UTC+5 local preview), verify card, edit and clear in Task Details, preserve across reload/urgency/drag", async ({ page, request, freshBackend: backend }) => {
  mkdirSync(SHOTS, { recursive: true });
  const workdir = await registerProject(request, backend, "schedule-en");

  // API rejects malformed & timezone-less timestamps
  for (const bad of ["2027-11-27T08:00:00", "2027-11-27", "2027-02-30T08:00:00Z", "not-a-date", ""]) {
    const res = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: { title: "Bad", prompt: "Bad", workdir, isolation: "none", availableFromUtc: bad },
    });
    expect(res.status(), `expected 400 for ${bad}`).toBe(400);
  }

  // Create an immediate task (should NOT show any date label), a peer urgency-5 task, and a scheduled ready task
  await addTask(request, backend, workdir, "Immediate Ready Task", { urgency: 3 });
  await addTask(request, backend, workdir, "Urgent Immediate Peer", { urgency: 5 });
  const sched = await addTask(request, backend, workdir, "Scheduled Ready Task", { urgency: 5, availableFromUtc: FUTURE_ISO });
  expect(sched.availableFromUtc).toBe(FUTURE_ISO);

  // Direct start API refuses scheduled task before timestamp
  const startRes = await request.post(`${backend.apiBase}/tasks/${sched.id}/start`, { headers: auth(backend) });
  expect(startRes.status()).toBe(400);
  expect(await startRes.text()).toContain(FUTURE_ISO);

  await gotoApp(page, backend.bootBase, { newTaskPinned: true });
  await openAllTasks(page);
  await expect(card(page, "Scheduled Ready Task")).toBeVisible({ timeout: 20_000 });

  // Immediate card has no schedule badge
  await expect(card(page, "Immediate Ready Task").getByTestId("task-card-schedule")).toHaveCount(0);

  // Scheduled Ready card shows exact EN UTC time + waiting status
  const schedCard = card(page, "Scheduled Ready Task");
  await expect(schedCard.getByTestId("task-card-schedule-time")).toHaveText("Available from Nov 27, 2027, 08:00 UTC");
  await expect(schedCard.getByTestId("task-card-schedule-waiting")).toHaveText("Waiting for scheduled time");

  // Fill New Task form with scheduled time 2027-11-27 08:00 UTC and verify local preview shows 13:00 (Asia/Almaty UTC+5)
  await page.locator("#new-task-title").fill("Planned Release Prep");
  await page.locator("#manager-assignment").fill("Prepare release notes after freeze.");
  await page.getByTestId("new-task-urgency").selectOption("4");
  await page.getByTestId("new-task-schedule-mode-scheduled").click();
  await page.getByTestId("new-task-schedule-date").fill("2027-11-27");
  await page.getByTestId("new-task-schedule-time").fill("08:00");
  await expect(page.getByTestId("new-task-schedule-tz-badge")).toHaveText("UTC+0");
  await expect(page.getByTestId("new-task-schedule-local-preview")).toContainText("13:00");
  await page.screenshot({ path: path.join(SHOTS, "01-new-task-scheduled-en.png") });

  await page.getByTestId("manager-create-assignment").click();
  const createdCard = card(page, "Planned Release Prep");
  await expect(createdCard).toBeVisible({ timeout: 15_000 });
  await expect(createdCard.getByTestId("task-card-schedule-time")).toHaveText("Available from Nov 27, 2027, 08:00 UTC");
  // Backlog task is not submitted yet -> no "Waiting for scheduled time"
  await expect(createdCard.getByTestId("task-card-schedule-waiting")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, "02-kanban-scheduled-cards-en.png") });

  // Open Task Details, edit timestamp, save, verify persistence across reload
  await openTaskDetailsSection(page, "Scheduled Ready Task");
  await expect(page.getByTestId("task-schedule-date")).toHaveValue("2027-11-27");
  await expect(page.getByTestId("task-schedule-time")).toHaveValue("08:00");
  await page.getByTestId("task-schedule-date").fill("2027-12-01");
  await page.getByTestId("task-schedule-time").fill("14:30");
  await expect(page.getByTestId("task-schedule-local-preview")).toContainText("19:30");
  await page.getByTestId("task-schedule-save").click();
  await expect(schedCard.getByTestId("task-card-schedule-time")).toHaveText("Available from Dec 1, 2027, 14:30 UTC");
  await page.screenshot({ path: path.join(SHOTS, "03-task-details-edit-en.png") });

  // Close panel and vertically drag Scheduled Ready Task above Urgent Immediate Peer -> preserves schedule timestamp!
  await page.keyboard.press("Escape");
  await dragHandleAbove(page, "Scheduled Ready Task", "Urgent Immediate Peer");
  await expect(schedCard.getByTestId("task-card-schedule-time")).toHaveText("Available from Dec 1, 2027, 14:30 UTC");

  // Re-open Task Details and change urgency -> preserves schedule timestamp!
  await openTaskDetailsSection(page, "Scheduled Ready Task");
  await page.getByTestId("task-urgency-select").selectOption("4");
  await expect(schedCard).toHaveAttribute("data-urgency", "4");
  await expect(schedCard.getByTestId("task-card-schedule-time")).toHaveText("Available from Dec 1, 2027, 14:30 UTC");

  // Reload page -> edited timestamp and urgency persist
  await page.reload();
  await expect(card(page, "Scheduled Ready Task").getByTestId("task-card-schedule-time")).toHaveText("Available from Dec 1, 2027, 14:30 UTC");

  // Verify backend has exact canonical UTC timestamp
  const fetched = (await (await request.get(`${backend.apiBase}/tasks/${sched.id}`, { headers: auth(backend) })).json()) as { availableFromUtc: string | null; urgency: number };
  expect(fetched.availableFromUtc).toBe(UPDATED_ISO);
  expect(fetched.urgency).toBe(4);

  // Clear restriction ("Make available now") -> removes badge immediately
  await openTaskDetailsSection(page, "Scheduled Ready Task");
  await page.getByTestId("task-schedule-clear").click();
  await expect(card(page, "Scheduled Ready Task").getByTestId("task-card-schedule")).toHaveCount(0);
  const cleared = (await (await request.get(`${backend.apiBase}/tasks/${sched.id}`, { headers: auth(backend) })).json()) as { availableFromUtc: string | null };
  expect(cleared.availableFromUtc).toBeNull();
});

test.describe("Russian localization", () => {
  test.use({ locale: "ru-RU", timezoneId: "Asia/Almaty" });

  test("renders Russian labels, UTC date format, local preview, and waiting status", async ({ page, request, freshBackend: backend }) => {
    mkdirSync(SHOTS, { recursive: true });
    const workdir = await registerProject(request, backend, "schedule-ru");
    await addTask(request, backend, workdir, "Запланированная задача", { urgency: 5, availableFromUtc: FUTURE_ISO });

    await gotoApp(page, backend.bootBase, { newTaskPinned: true });
    await openAllTasks(page);
    const ruCard = card(page, "Запланированная задача");
    await expect(ruCard).toBeVisible({ timeout: 20_000 });
    await expect(ruCard.getByTestId("task-card-schedule-time")).toHaveText("Доступна с 27.11.2027, 08:00 UTC");
    await expect(ruCard.getByTestId("task-card-schedule-waiting")).toHaveText("Ожидает назначенного времени");

    await expect(page.getByTestId("new-task-schedule-field")).toContainText("Начало выполнения");
    await expect(page.getByTestId("new-task-schedule-mode-immediate")).toHaveText("Доступна сразу");
    await expect(page.getByTestId("new-task-schedule-mode-scheduled")).toHaveText("Не раньше указанного времени");
    await page.getByTestId("new-task-schedule-mode-scheduled").click();
    await page.getByTestId("new-task-schedule-date").fill("2027-11-27");
    await page.getByTestId("new-task-schedule-time").fill("08:00");
    await expect(page.getByTestId("new-task-schedule-local-preview")).toContainText("13:00");
    await page.screenshot({ path: path.join(SHOTS, "04-kanban-schedule-ru.png") });
  });
});

test.describe("Different timezone (America/New_York)", () => {
  test.use({ locale: "en-US", timezoneId: "America/New_York" });

  test("local time preview adapts to America/New_York (UTC-5)", async ({ page, request, freshBackend: backend }) => {
    const workdir = await registerProject(request, backend, "schedule-ny");
    await addTask(request, backend, workdir, "NY Scheduled", { availableFromUtc: FUTURE_ISO });
    await gotoApp(page, backend.bootBase, { newTaskPinned: true });
    await openAllTasks(page);
    await expect(card(page, "NY Scheduled").getByTestId("task-card-schedule-time")).toHaveText("Available from Nov 27, 2027, 08:00 UTC");
    await page.getByTestId("new-task-schedule-mode-scheduled").click();
    await page.getByTestId("new-task-schedule-date").fill("2027-11-27");
    await page.getByTestId("new-task-schedule-time").fill("08:00");
    await expect(page.getByTestId("new-task-schedule-local-preview")).toContainText("03:00");
    await expect(page.getByTestId("new-task-schedule-local-preview")).toContainText("America/New_York");
  });
});

test("compact macOS window usability and project/home dashboard summaries (not attention items)", async ({ page, request, freshBackend: backend }) => {
  mkdirSync(SHOTS, { recursive: true });
  const workdir = await registerProject(request, backend, "compact-dash");
  await addTask(request, backend, workdir, "High Urgency Scheduled Task With A Very Long Title That Must Wrap Cleanly", {
    urgency: 5,
    availableFromUtc: FUTURE_ISO,
  });
  await addTask(request, backend, workdir, "Second Ready Task", { urgency: 5, availableFromUtc: UPDATED_ISO });

  // Home dashboard shows scheduled waiting summary & does NOT treat it as an attention item
  await page.setViewportSize({ width: 1200, height: 820 });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await expect(page.getByTestId("home-scheduled-waiting")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("home-scheduled-waiting")).toContainText("2 submitted waiting for scheduled time");
  await expect(page.getByTestId("home-scheduled-waiting")).toContainText("Nov 27, 2027, 08:00 UTC");
  await expect(page.getByTestId("home-attention-empty")).toBeVisible();

  // Project Overview shows compact scheduled summary
  await page.getByTestId("overview-project").first().click();
  await clickProjectPage(page, "overview");
  await expect(page.getByTestId("project-scheduled-summary")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("project-scheduled-next")).toContainText("Nov 27, 2027, 08:00 UTC");

  // Compact board view remains usable and horizontally scrollable
  await page.setViewportSize({ width: 920, height: 700 });
  await clickProjectPage(page, "board");
  await expect(card(page, "Second Ready Task")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(SHOTS, "05-compact-board-en.png") });
});
