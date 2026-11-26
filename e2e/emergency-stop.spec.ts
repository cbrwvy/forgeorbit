import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp, putPreference, queryBackendScalar } from "./helpers";

/**
 * FO-UX-SIMPLIFY02-M1: the title-bar Emergency Stop and the "Needs you" indicator.
 * Fake drivers only. Nothing here starts an agent.
 */
test.describe.configure({ mode: "serial" });

async function openAutonomySettings(page: import("@playwright/test").Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-autonomy").click();
}

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });
const emergency = async (request: APIRequestContext, b: E2EBackend) =>
  (await (await request.get(`${b.apiBase}/api/autonomy/status`, { headers: auth(b) })).json()).emergency as { active: boolean; outstanding: string[] };

async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "m1-estop-"));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}
async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, column: string) {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir, column } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string };
}

test("one click stops from any page, the state survives a reload, and resuming asks first", async ({ page, request, freshBackend: backend }) => {
  // Twelve page navigations plus a full page reload: the 30 s default budget is
  // too tight when the shared Vite server is compiling under parallel workers,
  // and a timeout there kills the fresh backend mid-request (ECONNREFUSED),
  // which hides the real cause. No waits or retries are added — only budget.
  test.slow();
  const runsBefore = queryBackendScalar(backend, "SELECT COUNT(*) FROM runs");
  await gotoApp(page, backend.bootBase);
  const control = page.getByTestId("emergency-stop");
  await expect(control).toHaveAttribute("data-phase", "clear");

  // Visible on every main page.
  for (const nav of ["workspace-overview", "workspace-attention", "workspace-workspaces", "workspace-company", "workspace-knowledge", "workspace-brain"]) {
    await page.getByTestId(nav).click();
    await expect(page.getByTestId("emergency-stop-button")).toBeVisible();
    await expect(page.getByTestId("header-attention")).toBeVisible();
  }
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-plans").click();
  await expect(page.getByTestId("mission-control-page")).toBeVisible();
  await expect(page.getByTestId("emergency-stop-button")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("topbar-more-actions").click();
  await page.getByTestId("pipelines-button").click();
  await expect(page.getByTestId("emergency-stop-button")).toBeVisible();

  // One click, from the Pipelines page, no confirmation dialog.
  await page.getByTestId("emergency-stop-button").click();
  await expect(control).toHaveAttribute("data-phase", "active");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("emergency-stop-active")).toContainText("Stopped");
  await expect(page.getByTestId("emergency-stop-status")).toContainText("The core reported no autonomous run still alive");
  expect((await emergency(request, backend)).active).toBe(true);

  // Settings → Autonomy and safety (where the autonomy panel lives since M4) shows the same stored state.
  await openAutonomySettings(page);
  await expect(page.getByTestId("autonomy-emergency-active")).toBeVisible();
  await page.keyboard.press("Escape");

  // "Restart": a fresh page load reads the stored flag.
  await page.reload();
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "active");

  // Resume asks; Cancel (and Escape) keep the stop.
  await page.getByTestId("emergency-stop-resume").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Lift the emergency stop?");
  await expect(dialog).toContainText("Nothing restarts on its own");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await emergency(request, backend)).active).toBe(true);
  await expect(page.getByTestId("emergency-stop-active")).toBeVisible();

  // Confirming lifts it.
  await page.getByTestId("emergency-stop-resume").click();
  await page.getByRole("dialog").getByRole("button", { name: "Lift emergency stop" }).click();
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "clear");
  expect((await emergency(request, backend)).active).toBe(false);

  // Nothing was launched by any of this.
  expect(queryBackendScalar(backend, "SELECT COUNT(*) FROM runs")).toBe(runsBefore);
});

test("keyboard: the stop is reachable and activates with Enter; the autonomy panel's clear also asks", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  const button = page.getByTestId("emergency-stop-button");
  await expect(button).toHaveAccessibleName("Emergency stop");
  await expect(button).toHaveAccessibleDescription(/Tasks you started yourself keep running/);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "active");
  expect((await emergency(request, backend)).active).toBe(true);

  await openAutonomySettings(page);
  await page.getByTestId("autonomy-clear-emergency").click();
  await expect(page.getByRole("dialog").last()).toContainText("Lift the emergency stop?");
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel" }).click();
  expect((await emergency(request, backend)).active).toBe(true);
  await page.getByTestId("autonomy-clear-emergency").click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Lift emergency stop" }).click();
  await expect(page.getByTestId("autonomy-emergency-active")).toHaveCount(0);
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "clear");
});

test("a failed stop request is shown as not confirmed, never as stopped", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "clear");
  await page.route("**/api/autonomy/emergency-stop", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
  await page.getByTestId("emergency-stop-button").click();
  await expect(page.getByTestId("emergency-stop-failed")).toBeVisible();
  await expect(page.getByTestId("emergency-stop-active")).toHaveCount(0);
  await expect(page.getByTestId("emergency-stop-status")).toContainText("NOT confirmed");
  expect((await emergency(request, backend)).active).toBe(false);
  await page.unroute("**/api/autonomy/emergency-stop");
  await page.getByTestId("emergency-stop-button").click();
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "active");
  await request.post(`${backend.apiBase}/api/autonomy/emergency-stop/clear`, { headers: auth(backend), data: {} });
});

test("the attention indicator shows the same count as the page, opens it, and follows changes", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Attention Orbit");
  const review = await createTask(request, backend, "Check the result", dir, "review");
  await createTask(request, backend, "Stuck task", dir, "blocked");
  await createTask(request, backend, "Just a draft", dir, "backlog");
  await gotoApp(page, backend.bootBase);

  const indicator = page.getByTestId("header-attention");
  await expect(indicator).toHaveAttribute("data-count", "2");
  await expect(indicator).toHaveAccessibleName("Needs you: 2");
  await expect(page.getByTestId("workspace-attention")).toHaveAccessibleName("Needs you, 2");

  // Opens the existing list, from another page.
  await page.getByTestId("workspace-company").click();
  await indicator.click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
  await expect(page.getByTestId("attention-count")).toHaveText("2 waiting");
  await expect(page.getByTestId("attention-row")).toHaveCount(2);
  await expect(indicator).toHaveAttribute("aria-current", "page");

  // The Owner accepts one result: every surface drops to 1 without a reload.
  const done = await request.patch(`${backend.apiBase}/tasks/${review.id}`, { headers: auth(backend), data: { column: "done" } });
  expect(done.ok(), await done.text()).toBeTruthy();
  await expect(indicator).toHaveAttribute("data-count", "1", { timeout: 10_000 });
  await expect(page.getByTestId("attention-count")).toHaveText("1 waiting");

  // After a reload ("restart") and on another page the number is the same.
  await page.reload();
  await page.getByTestId("workspace-knowledge").click();
  await expect(page.getByTestId("header-attention")).toHaveAttribute("data-count", "1");
});

test("Russian: stop, stopped state, confirmation and the indicator are localized", async ({ page, request, freshBackend: backend }) => {
  await putPreference(request, backend, "locale", "ru");
  await gotoApp(page, backend.bootBase);
  await expect(page.getByTestId("emergency-stop-button")).toHaveAccessibleName("Экстренная остановка");
  await expect(page.getByTestId("header-attention")).toHaveAccessibleName("Нужно вам: ничего не ждёт");
  await page.getByTestId("emergency-stop-button").click();
  await expect(page.getByTestId("emergency-stop-active")).toContainText("Остановлено");
  await page.getByTestId("emergency-stop-resume").click();
  await expect(page.getByRole("dialog")).toContainText("Снять экстренную остановку?");
  await page.getByRole("dialog").getByRole("button", { name: "Снять остановку" }).click();
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "clear");
});

// The fake monitor marker keeps a claude task live ("held") after its turn: a running task without a process.
const HOLD = "__agetor_fake_claude_monitor__:600000";

test("the stopped state names the running task it did not stop, and stopping that run clears the count", async ({ page, request, freshBackend: backend }) => {
  const project = await registerProject(request, backend, "Manual hold");
  const task = await createTask(request, backend, `Hold open ${HOLD}`, project, "ready");
  const started = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend), data: {} });
  expect(started.ok(), await started.text()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) })).json()).column).toBe("running");

  await gotoApp(page, backend.bootBase);
  await page.getByTestId("emergency-stop-button").click();
  await expect(page.getByTestId("emergency-stop")).toHaveAttribute("data-phase", "active");
  // The Emergency Stop does not stop what the Owner started: the title bar says so with the live number.
  await expect(page.getByTestId("emergency-stop-left-running")).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("emergency-stop-status")).toContainText("Not stopped: 1 running task(s) you started yourself.");
  expect((await (await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) })).json()).column).toBe("running");

  // Stopping that run is a separate control; the count follows.
  const runs = (await (await request.get(`${backend.apiBase}/tasks/${task.id}/runs`, { headers: auth(backend) })).json()) as Array<{ id: string }>;
  const stopped = await request.post(`${backend.apiBase}/runs/${runs[0]!.id}/cancel`, { headers: auth(backend), data: {} });
  expect(stopped.ok(), await stopped.text()).toBeTruthy();
  await expect(page.getByTestId("emergency-stop-left-running")).toHaveCount(0, { timeout: 20_000 });
  expect((await emergency(request, backend)).active).toBe(true);
});
