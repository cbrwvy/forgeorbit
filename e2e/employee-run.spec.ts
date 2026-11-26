import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-010E2 employee supervised execution. Each test has its own backend, HOME
 * and SQLite; every harness is a fake driver behind a stub binary, so no real
 * AI CLI runs. The spec proves the owner's confirmation is the only way a run
 * starts, that the run is attributed to the assigned worker, and that unknown
 * resources stay Unknown.
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api(request: APIRequestContext, backend: E2EBackend, method: "get" | "post", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function setup(request: APIRequestContext, backend: E2EBackend) {
  const dir = await mkdtemp(path.join(tmpdir(), "fo010e2-e2e-"));
  await api(request, backend, "post", "/projects", { path: dir, name: "Gate" });
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Runner", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const bea = await api(request, backend, "post", "/employees", { name: "Bea Runner", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, backend, "post", "/tasks", {
    title: "Repair the gate", prompt: "inspect the gate", isolation: "none", workdir: dir, agent: "claude-code", model: "opus", mode: "auto", column: "ready",
  });
  await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
  return { dir, ada, bea, task };
}

async function openPrepared(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Repair the gate" }).click();
  const section = page.getByTestId("employee-execution");
  await expect(section).toBeVisible();
  await section.locator("summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  return section;
}

const attemptsFor = async (request: APIRequestContext, backend: E2EBackend, taskId: string) =>
  (await api(request, backend, "get", `/employee-execution/attempts?taskId=${taskId}`)).attempts as any[];
const runsFor = (request: APIRequestContext, backend: E2EBackend, taskId: string) => api(request, backend, "get", `/tasks/${taskId}/runs`);

test("prepare, review, cancel, then confirm: one run attributed to the worker, Unknown stays Unknown", async ({ page, request, freshBackend: backend }) => {
  const { ada, task } = await setup(request, backend);
  await openPrepared(page, backend);

  // Preparing alone never starts anything, and Run Employee only opens a review.
  expect(await runsFor(request, backend, task.id)).toEqual([]);
  await expect(page.getByTestId("employee-execution-run")).toBeVisible();
  await page.getByTestId("employee-execution-run").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("employee-run-banner")).toContainText("Nothing runs until you confirm");
  await expect(page.getByTestId("employee-run-task")).toHaveText("Repair the gate");
  await expect(page.getByTestId("employee-run-worker")).toHaveText("Ada Runner");
  await expect(page.getByTestId("employee-run-revision")).toHaveText("1");
  await expect(page.getByTestId("employee-run-harness")).toContainText("claude-code");
  await expect(page.getByTestId("employee-run-permissions")).toContainText("without asking");
  await expect(page.getByTestId("employee-run-account")).toContainText("Account Unknown");
  await expect(page.getByTestId("employee-run-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-run-unverified")).toContainText("Unknown means unknown");
  await expect(dialog).not.toContainText(/\bReady\b|\bAvailable\b/);
  expect(await runsFor(request, backend, task.id)).toEqual([]);
  expect((await attemptsFor(request, backend, task.id)).map((a) => a.status)).toEqual(["awaiting-approval"]);

  // Native WKWebView can skip buttons for default Tab navigation. The modal
  // owns every step, including intermediate controls, independently of that
  // preference. Disabled/hidden controls must never receive focus.
  const cancel = page.getByTestId("employee-run-cancel");
  const confirm = page.getByTestId("employee-run-confirm");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();

  // Cancel: nothing starts and the review is withdrawn.
  await page.getByTestId("employee-run-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await attemptsFor(request, backend, task.id))[0].status).toBe("cancelled");
  expect(await runsFor(request, backend, task.id)).toEqual([]);

  // Review again and confirm.
  await page.getByTestId("employee-execution-run").click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("employee-run-confirm").click();
  await expect(dialog).toHaveCount(0);
  const status = page.getByTestId("employee-run-status");
  await expect(status).toBeVisible();
  await expect(status.getByTestId("employee-run-actual")).toContainText("model Unknown");
  await expect(status.getByTestId("employee-run-actual")).toContainText("account Unknown");
  await expect.poll(async () => (await attemptsFor(request, backend, task.id))[0].status).toBe("started");
  await expect(status.getByTestId("employee-run-open-runs")).toBeVisible();

  // Exactly one run, attributed to the assigned worker at the assignment revision the owner saw.
  const runs = await runsFor(request, backend, task.id);
  expect(runs).toHaveLength(1);
  const attempts = await attemptsFor(request, backend, task.id);
  const started = attempts.find((a) => a.status === "started");
  expect(started).toMatchObject({
    employee: { id: ada.id, name: "Ada Runner" },
    assignment: { revision: 1 },
    runId: runs[0].id,
    taskId: task.id,
    actual: { model: null, accountId: null },
    provenance: { approval: "owner" },
    requested: { harnessId: "claude-code" },
  });
  const byEmployee = (await api(request, backend, "get", `/employee-execution/attempts?employeeId=${ada.id}`)).attempts;
  expect(byEmployee.map((a: any) => a.id)).toContain(started.id);
  // The cancelled review stays in history; it is not a run.
  expect(attempts.filter((a) => a.status === "cancelled")).toHaveLength(1);

  // The fake runtime finishes; the status follows the run, never ahead of it.
  await expect.poll(async () => (await attemptsFor(request, backend, task.id)).find((a) => a.id === started.id).phase, { timeout: 20_000 })
    .not.toBe("starting");
  const phase = await page.getByTestId("employee-run-phase").first().getAttribute("data-phase");
  expect(["running", "completed", "failed", "cancelled", "unknown-outcome"]).toContain(phase);
});

test("a stale preflight and a stale review start nothing", async ({ page, request, freshBackend: backend }) => {
  const { bea, task } = await setup(request, backend);
  await openPrepared(page, backend);

  // The assignment changes in another tab before Run Employee: the review is refused with the fresh worker.
  await api(request, backend, "post", "/task-assignments/reassign", { taskId: task.id, employeeId: bea.id, expectedRevision: 1 });
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect(page.getByTestId("employee-execution-errors").locator('[data-code="stale-assignment"]')).toBeVisible();
  expect(await runsFor(request, backend, task.id)).toEqual([]);

  // Prepare again for the new worker, open the review, then the assignment changes underneath it.
  await page.getByTestId("employee-execution-prepare").click();
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-worker")).toHaveText("Bea Runner");
  const state = await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`);
  await api(request, backend, "post", "/task-assignments/unassign", { taskId: task.id, expectedRevision: state.assignment.revision });
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-error")).toContainText("Nothing was started");
  await expect(page.getByTestId("employee-run-confirm")).toBeDisabled();
  expect(await runsFor(request, backend, task.id)).toEqual([]);
  expect((await attemptsFor(request, backend, task.id))[0].status).toBe("rejected");
});

test("two confirmations at once start exactly one run", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  await openPrepared(page, backend);
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toBeVisible();
  const [attempt] = await attemptsFor(request, backend, task.id);
  const body = { revision: attempt.revision, confirm: true };
  const route = `/employee-execution/attempts/${attempt.id}/start`;
  const [a, b] = await Promise.all([
    request.post(`${backend.apiBase}${route}`, { headers: headers(backend), data: body }),
    request.post(`${backend.apiBase}${route}`, { headers: headers(backend), data: body }),
  ]);
  expect([a.status(), b.status()]).toEqual([200, 200]);
  const replays = [(await a.json()).replayed, (await b.json()).replayed].sort();
  expect(replays).toEqual([false, true]);
  expect(await runsFor(request, backend, task.id)).toHaveLength(1);
  // The open dialog's own late click is a replay too: still one run.
  await page.getByTestId("employee-run-confirm").click().catch(() => undefined);
  expect(await runsFor(request, backend, task.id)).toHaveLength(1);
});

test("keyboard, light/dark and responsive layouts", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  await openPrepared(page, backend);

  // Keyboard: Enter on Run Employee opens the review with focus on the safe choice; Escape withdraws.
  await page.getByTestId("employee-execution-run").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("employee-run-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await attemptsFor(request, backend, task.id))[0].status).toBe("cancelled");
  expect(await runsFor(request, backend, task.id)).toEqual([]);

  // Layouts with the review open.
  await page.getByTestId("employee-execution-run").click();
  await expect(dialog).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await expect(dialog).toBeVisible();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(false);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await dialog.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    expect(await noOverflow(page)).toBe(true);
    await expect(page.getByTestId("employee-run-confirm")).toBeVisible();
    await expect(page.getByTestId("employee-run-cancel")).toBeVisible();
  }

  // Keyboard confirm: Tab from the safe choice to Confirm, Enter starts the run.
  await page.getByTestId("employee-run-cancel").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("employee-run-confirm")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await runsFor(request, backend, task.id)).length).toBe(1);
});
