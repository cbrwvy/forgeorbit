import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-010E1 employee execution preflight. Each test has its own backend, HOME
 * and SQLite, and every harness is a fake driver. Preflight only: the spec
 * proves no run is created and nothing but the read-only calculation is sent.
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
  const dir = await mkdtemp(path.join(tmpdir(), "fo010e1-e2e-"));
  await api(request, backend, "post", "/projects", { path: dir, name: "Gate" });
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Preflight", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const bea = await api(request, backend, "post", "/employees", { name: "Bea Preflight", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, backend, "post", "/tasks", {
    title: "Repair the gate", prompt: "inspect the gate", isolation: "none", workdir: dir, agent: "claude-code", model: "opus", mode: "auto", column: "ready",
  });
  await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
  return { dir, ada, bea, task };
}

async function openSection(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Repair the gate" }).click();
  const section = page.getByTestId("employee-execution");
  await expect(section).toBeVisible();
  await section.locator("summary").click();
  await expect(page.getByTestId("employee-execution-banner")).toHaveText("Preflight only — no agent started.");
  return section;
}

test("prepare, choose a harness, review warnings, detect a stale assignment, and start nothing", async ({ page, request, freshBackend: backend }) => {
  const writes: string[] = [];
  page.on("request", (req) => {
    const method = req.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const url = new URL(req.url());
    if (url.pathname === "/preferences" || url.pathname.startsWith("/preferences/") || url.pathname.endsWith("/seen") || url.pathname === "/launch-diagnostics" || url.pathname === "/projects/discover") return;
    writes.push(`${method} ${url.pathname}`);
  });
  const { bea, task } = await setup(request, backend);
  await openSection(page, backend);

  // The worker comes from the existing assignment.
  await expect(page.getByTestId("employee-execution-worker-name")).toHaveText("Ada Preflight");
  await expect(page.getByTestId("employee-execution-revision")).toHaveText("1");
  await expect(page.getByTestId("employee-execution-start-note")).toContainText("Nothing starts until you confirm");
  await expect(page.getByRole("button", { name: /run employee/i })).toHaveCount(0);

  // 1. Prepare with no harness: the worker is checked, a harness is still needed.
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "selection-needed");
  await expect(page.getByTestId("employee-execution-result-worker")).toContainText("Ada Preflight · QA Engineer · revision 1");
  await expect(page.getByTestId("employee-execution-errors")).toHaveCount(0);

  // 2. Choosing a harness makes the shown result stale until prepared again.
  const harness = page.getByTestId("employee-execution-harness");
  await harness.selectOption("claude-code");
  await expect(page.getByTestId("employee-execution-stale")).toBeVisible();
  await expect(page.getByTestId("employee-execution-result")).toHaveAttribute("data-stale", "true");

  // 3. Keyboard: harness → model → effort → complexity → Prepare.
  await harness.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  await expect(page.getByTestId("employee-execution-prepare")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("employee-execution-result")).toHaveAttribute("data-stale", "false");
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(page.getByTestId("employee-execution-selected")).toHaveText("Claude Code");
  await expect(page.getByTestId("employee-execution-requested-model")).toHaveText("Not requested");

  // Unknown evidence is never presented as ready or available.
  await expect(page.getByTestId("employee-execution-evidence").first()).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("employee-execution-account")).toContainText("Account Unknown");
  await expect(page.getByTestId("employee-execution-account")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("employee-execution-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-execution-model-evidence")).toContainText("Unknown");
  await expect(page.getByTestId("employee-execution-warnings")).toContainText("Unknown evidence");
  await expect(page.getByTestId("employee-execution-result")).not.toContainText(/\bReady\b|\bAvailable\b/);
  await expect(page.getByTestId("employee-execution-recommendation")).toContainText("not permission to run");
  await expect(page.getByTestId("employee-execution-next")).toContainText("nothing starts until you confirm");

  // 4. A disabled harness stays inspectable but explicitly blocked.
  await harness.selectOption("codex");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "blocked");
  await expect(page.getByTestId("employee-execution-errors")).toContainText("disabled");
  await expect(page.getByTestId("employee-execution-evidence").first()).toHaveAttribute("data-state", "blocked");

  // 5. The assignment changes elsewhere (another tab). The next prepare reports it.
  await api(request, backend, "post", "/task-assignments/reassign", { taskId: task.id, employeeId: bea.id, expectedRevision: 1 });
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-errors").locator('[data-code="stale-assignment"]')).toContainText("revision 1 → 2");
  await expect(page.getByTestId("employee-execution-result-worker")).toContainText("Bea Preflight");
  await expect(page.getByTestId("employee-execution-worker-name")).toHaveText("Bea Preflight");
  await expect(page.getByTestId("employee-execution-revision")).toHaveText("2");
  // The fresh worker is now on screen, so the next prepare proceeds.
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-errors").locator('[data-code="stale-assignment"]')).toHaveCount(0);

  // 6. Nothing ran and nothing but the read-only calculation was sent.
  const runs = await api(request, backend, "get", `/tasks/${task.id}/runs`);
  expect(runs).toEqual([]);
  const stored = await api(request, backend, "get", `/tasks/${task.id}`);
  expect(stored).toMatchObject({ agent: "claude-code", column: "ready", model: "opus" });
  expect([...new Set(writes)]).toEqual(["POST /employee-execution/preflight"]);
});

test("an unassigned task is shown and not assigned automatically", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  const state = await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`);
  await api(request, backend, "post", "/task-assignments/unassign", { taskId: task.id, expectedRevision: state.assignment.revision });
  await openSection(page, backend);
  await expect(page.getByTestId("employee-execution-worker")).toContainText("No employee is assigned");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-errors")).toContainText("No worker is assigned");
  await expect(page.getByTestId("employee-execution-next")).toContainText("Assign a worker");
  const after = await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`);
  expect(after.assignment).toBeNull();
});

test("light, dark and responsive layouts keep the section readable", async ({ page, request, freshBackend: backend }) => {
  await setup(request, backend);
  const section = await openSection(page, backend);
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await expect(section).toBeVisible();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(false);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await section.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    expect(await noOverflow(page)).toBe(true);
    await expect(page.getByTestId("employee-execution-prepare")).toBeVisible();
  }
});
