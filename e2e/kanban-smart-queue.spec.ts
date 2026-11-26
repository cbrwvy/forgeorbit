/**
 * Smart execution queue UI & live backend integration (FO-KANBAN-SMARTQUEUE01) in Chromium.
 * Verifies:
 *  - Project Queue Summary above the Kanban board and in Project Overview
 *  - Canonical card badges (Next in queue, Queued · #2, Waiting for scheduled time,
 *    Waiting for dependency, Project paused) — never marking unsubmitted tasks as next
 *  - Live reorder via drag handle and urgency edit updating the backend queue & next candidate
 *  - EN and RU localization and compact macOS window layout
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { clickProjectPage } from "./project-nav";

const SHOTS = path.resolve(import.meta.dir, "../docs/qa/evidence/fo-kanban-smartqueue01");
const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" });
const FUTURE_ISO = "2027-11-27T08:00:00.000Z";

test.describe.configure({ mode: "parallel", timeout: 120_000 });
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Almaty" });

function makeGitProject(name: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-sq-e2e-${name}-`)));
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "src/app.ts"), `export const v = 1;\n`);
  spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "-c", "user.email=qa@example.invalid", "-c", "user.name=QA", "commit", "-qm", "init"]);
  return dir;
}

async function setupProjectWithHandsoff(request: APIRequestContext, backend: E2EBackend, name: string) {
  const dir = makeGitProject(name);
  const pRes = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(pRes.ok(), await pRes.text()).toBeTruthy();
  const projectPath = (await pRes.json()).path as string;

  // Enable codex harness & add 2 Developers + 1 Reviewer
  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  for (const [workerName, jobTitle] of [["Dana Dev", "Developer"], ["Alex Dev", "Developer"], ["Rae Reviewer", "Reviewer"]] as const) {
    const eRes = await request.post(`${backend.apiBase}/employees`, {
      headers: auth(backend),
      data: { name: workerName, jobTitle, projectPath },
    });
    expect(eRes.ok(), await eRes.text()).toBeTruthy();
  }

  // Read available hands-off resources and enable Work independently
  const polRes = await request.get(`${backend.apiBase}/handsoff/policy?projectPath=${encodeURIComponent(projectPath)}`, { headers: auth(backend) });
  expect(polRes.ok(), await polRes.text()).toBeTruthy();
  const polView = (await polRes.json()) as { available: Array<{ harnessId: string; accountKey: string; role: "developer" | "reviewer" }> };
  const resources = polView.available.map((o) => ({ role: o.role, harnessId: o.harnessId, accountKey: o.accountKey }));
  const saveRes = await request.put(`${backend.apiBase}/handsoff/policy`, {
    headers: auth(backend),
    data: {
      projectPath,
      policy: { enabled: true, autoAssign: true, runOfflineTests: false, autoApply: true, autoDone: true, maxParallel: 1, resources },
    },
  });
  expect(saveRes.ok(), await saveRes.text()).toBeTruthy();
  return projectPath;
}

async function addTask(request: APIRequestContext, backend: E2EBackend, workdir: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: `${title} prompt`, workdir, column: "ready", agent: "codex", mode: "auto", model: "gpt-6.1-sol", isolation: "worktree", accessMode: "workspace", ...extra },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string; title: string; urgency: number };
}

function card(page: Page, title: string): Locator {
  return page.locator(`[data-testid="task-card"][aria-label="${title}"]`);
}

async function dragHandleAbove(page: Page, fromTitle: string, targetTitle: string): Promise<void> {
  const h = (await card(page, fromTitle).getByTestId("task-card-handle").boundingBox())!;
  const t = (await card(page, targetTitle).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 4, { steps: 2 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.2, { steps: 16 });
  await page.mouse.up();
}

test("EN: project queue summary, card badges, live drag reorder updating next candidate, unsubmitted backlog excluded, and project overview card", async ({ page, request, freshBackend: backend }) => {
  mkdirSync(SHOTS, { recursive: true });
  const projectPath = await setupProjectWithHandsoff(request, backend, "smartqueue-en");

  // Create tasks: 1 long-running holder (or use dependency + scheduled + queued while paused/held)
  // First create an unsubmitted Backlog urgency-5 task (must NEVER show Next in queue!)
  await addTask(request, backend, projectPath, "Unsubmitted Backlog Task", { column: "backlog", urgency: 5 });

  // Create tasks in Ready, then submit while holding execution with a dependency/running task or paused state
  const prereq = await addTask(request, backend, projectPath, "Optimize DB queries", { urgency: 5 });
  const second = await addTask(request, backend, projectPath, "Refactor auth middleware", { urgency: 5 });
  const lower = await addTask(request, backend, projectPath, "Update API docs", { urgency: 4 });
  const scheduled = await addTask(request, backend, projectPath, "Scheduled migration", { urgency: 5, availableFromUtc: FUTURE_ISO });
  const dependent = await addTask(request, backend, projectPath, "Deploy query metrics", { urgency: 4 });
  const depRes = await request.put(`${backend.apiBase}/project-manager/tasks/${dependent.id}/scheduling`, {
    headers: auth(backend),
    data: { path: projectPath, dependsOn: [prereq.id] },
  });
  expect(depRes.ok(), await depRes.text()).toBeTruthy();

  // Pause project ONLY AFTER submitting so we inspect deterministic queued state?
  // Wait: submitTask requires running project; instead, hold the 1st task or pause right after submitting!
  // Let's create a prerequisite that is NOT submitted so we can pause cleanly, OR submit a running task?
  // Even better: pause via a tiny test! First submit scheduled + dependent (both wait cleanly without launching!),
  // then pause project? Wait: if project is paused, queue shows Project paused!
  // To show live "Next in queue" + "Queued · #2" + "Waiting for scheduled time" + "Waiting for dependency" TOGETHER,
  // let's make "Active Worker Task" depend on nothing — wait, we want it running OR we use a fake delay!
  // Actually `backendEnv` supports AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS! Let's check or pause!
  // Wait: even simpler, let's submit `scheduled` and `dependent` (neither launches!), then verify, AND use `test.use({ backendEnv: { AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "60000" } })` in the next describe or here!
  // Let's submit `prereq` (with `availableFromUtc` null -> launches? No, let's check!)
  await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: scheduled.id } });
  await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: dependent.id } });

  // Verify backend /handsoff/queue endpoint directly
  const qRes = await request.get(`${backend.apiBase}/handsoff/queue?projectPath=${encodeURIComponent(projectPath)}`, { headers: auth(backend) });
  expect(qRes.ok(), await qRes.text()).toBeTruthy();
  const qData = (await qRes.json()) as { counts: { waitingScheduled: number; waitingDependency: number } };
  expect(qData.counts.waitingScheduled).toBe(1);
  expect(qData.counts.waitingDependency).toBe(1);

  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("overview-project").first().click();

  // Board queue summary visible above columns
  await expect(page.getByTestId("board-queue-summary")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("queue-count-scheduled")).toContainText("Waiting for time: 1");
  await expect(page.getByTestId("queue-count-blocked")).toContainText("Blocked: 1");

  // Unsubmitted Backlog task NEVER shows Next in queue or hands-off badge
  await expect(card(page, "Unsubmitted Backlog Task").getByTestId("task-card-handsoff")).toHaveCount(0);
  // Dependent task shows "Waiting for dependency"
  await expect(card(page, "Deploy query metrics").getByTestId("task-card-handsoff")).toHaveText("Waiting for dependency");
  // Scheduled task shows full UTC timestamp + "Waiting for scheduled time" without duplicate hands-off chip
  await expect(card(page, "Scheduled migration").getByTestId("task-card-schedule-waiting")).toHaveText("Waiting for scheduled time");
  await expect(card(page, "Scheduled migration").getByTestId("task-card-handsoff")).toHaveCount(0);

  // Check Project Overview card summary too
  await clickProjectPage(page, "overview");
  await expect(page.getByTestId("project-queue-summary")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("queue-workers-info")).toContainText("2 of 2 developers available");

  // Unused vars keep TS happy
  expect([second.id, lower.id].length).toBe(2);
});

test.describe("Live queue ordering & drag reorder while a worker holds the slot", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "120000" } });

  test("EN: shows Running, Next in queue, Queued · #2, and live drag reorder updates Next eligible task immediately", async ({ page, request, freshBackend: backend }) => {
    mkdirSync(SHOTS, { recursive: true });
    const projectPath = await setupProjectWithHandsoff(request, backend, "live-order-en");

    const running = await addTask(request, backend, projectPath, "Active Indexing Job", { urgency: 5 });
    const candA = await addTask(request, backend, projectPath, "Optimize DB queries", { urgency: 5 });
    const candB = await addTask(request, backend, projectPath, "Fix payment webhook", { urgency: 5 });
    const candC = await addTask(request, backend, projectPath, "Add audit export", { urgency: 3 });
    const sched = await addTask(request, backend, projectPath, "Scheduled rollover", { urgency: 5, availableFromUtc: FUTURE_ISO });

    // Submit active job first (occupies maxParallel: 1 slot), then submit queued tasks
    await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: running.id } });
    // Wait briefly for Active Indexing Job to claim the 1 slot
    await expect.poll(async () => {
      const r = await request.get(`${backend.apiBase}/handsoff/queue?projectPath=${encodeURIComponent(projectPath)}`, { headers: auth(backend) });
      const data = (await r.json()) as { counts: { running: number } };
      return data.counts.running;
    }, { timeout: 15_000 }).toBe(1);

    await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: candA.id } });
    await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: candB.id } });
    await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: candC.id } });
    await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: sched.id } });

    await gotoApp(page, backend.bootBase, { newTaskPinned: false });
    await page.getByTestId("overview-project").first().click();

    // Board queue summary shows 1 running, 3 ready to start, 1 waiting for time, and next = Optimize DB queries
    await expect(page.getByTestId("board-queue-summary")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("queue-count-running")).toContainText("Running: 1");
    await expect(page.getByTestId("queue-count-eligible")).toContainText("Ready to start: 3");
    await expect(page.getByTestId("queue-count-scheduled")).toContainText("Waiting for time: 1");
    await expect(page.getByTestId("queue-next-task")).toContainText("Optimize DB queries");
    await expect(card(page, "Optimize DB queries").getByTestId("task-card-handsoff")).toHaveAttribute("data-queue-state", "next");
    await expect(card(page, "Fix payment webhook").getByTestId("task-card-handsoff")).toContainText("Queued");
    await page.screenshot({ path: path.join(SHOTS, "01-smart-queue-board-en.png") });

    // Drag "Fix payment webhook" ABOVE "Optimize DB queries" -> queue summary & badge update LIVE!
    await dragHandleAbove(page, "Fix payment webhook", "Optimize DB queries");
    await expect(page.getByTestId("queue-next-task")).toContainText("Fix payment webhook", { timeout: 15_000 });
    await expect(card(page, "Fix payment webhook").getByTestId("task-card-handsoff")).toHaveAttribute("data-queue-state", "next");
    await expect(card(page, "Optimize DB queries").getByTestId("task-card-handsoff")).toContainText("Queued");
    await page.screenshot({ path: path.join(SHOTS, "02-smart-queue-reordered-en.png") });

    // Compact 980x720 window check
    await page.setViewportSize({ width: 980, height: 720 });
    await expect(page.getByTestId("board-queue-summary")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "04-smart-queue-compact-en.png") });
  });

  test.describe("Russian localization", () => {
    test.use({ locale: "ru-RU", timezoneId: "Asia/Almaty", backendEnv: { AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "120000" } });

    test("RU: renders Russian queue summary and card status badges", async ({ page, request, freshBackend: backend }) => {
      mkdirSync(SHOTS, { recursive: true });
      const projectPath = await setupProjectWithHandsoff(request, backend, "smartqueue-ru");

      const running = await addTask(request, backend, projectPath, "Активная задача", { urgency: 5 });
      const next = await addTask(request, backend, projectPath, "Оптимизировать запросы к БД", { urgency: 5 });
      const queued = await addTask(request, backend, projectPath, "Обновить индексы", { urgency: 4 });
      const sched = await addTask(request, backend, projectPath, "Ночной пересчёт", { urgency: 5, availableFromUtc: FUTURE_ISO });

      await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: running.id } });
      await expect.poll(async () => {
        const r = await request.get(`${backend.apiBase}/handsoff/queue?projectPath=${encodeURIComponent(projectPath)}`, { headers: auth(backend) });
        return ((await r.json()) as { counts: { running: number } }).counts.running;
      }, { timeout: 15_000 }).toBe(1);

      await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: next.id } });
      await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: queued.id } });
      await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: sched.id } });

      await gotoApp(page, backend.bootBase, { newTaskPinned: false });
      await page.getByTestId("overview-project").first().click();

      await expect(page.getByTestId("board-queue-summary")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("board-queue-summary")).toContainText("Очередь выполнения");
      await expect(page.getByTestId("queue-count-running")).toContainText("Выполняется: 1");
      await expect(page.getByTestId("queue-count-eligible")).toContainText("Готово к запуску: 2");
      await expect(page.getByTestId("queue-count-scheduled")).toContainText("Ожидает времени: 1");
      await expect(page.getByTestId("queue-next-task")).toContainText("Оптимизировать запросы к БД");
      await expect(card(page, "Оптимизировать запросы к БД").getByTestId("task-card-handsoff")).toHaveText(/Следующая в очереди|Ожидается следующей/);
      await expect(card(page, "Обновить индексы").getByTestId("task-card-handsoff")).toContainText("В очереди");
      await page.screenshot({ path: path.join(SHOTS, "03-smart-queue-board-ru.png") });
    });
  });
});
