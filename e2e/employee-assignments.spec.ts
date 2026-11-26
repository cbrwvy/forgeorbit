import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-010C assigned tasks on the company card. Each test has its own backend,
 * HOME, and SQLite. Nothing starts an agent or asks the model router to run.
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api(request: APIRequestContext, backend: E2EBackend, method: "get" | "post", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo010c-${name.replace(/\W+/g, "-")}-`));
  await api(request, backend, "post", "/projects", { path: dir, name });
  return dir;
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

test("assign, reassign, unassign, and history stay inside the company card", async ({ page, request, freshBackend: backend }) => {
  const writes: string[] = [];
  page.on("request", (req) => {
    const method = req.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const url = new URL(req.url());
    if (url.pathname === "/preferences" || url.pathname.startsWith("/preferences/")) return;
    writes.push(`${method} ${url.pathname}`);
  });

  const alpha = await registerProject(request, backend, "alpha");
  const beta = await registerProject(request, backend, "beta");
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Assign", jobTitle: "QA Engineer", projectPath: alpha }, 201);
  const bea = await api(request, backend, "post", "/employees", { name: "Bea Assign", jobTitle: "QA Engineer", projectPath: alpha }, 201);
  const task = await api(request, backend, "post", "/tasks", {
    title: "Repair the gate",
    prompt: "inspect the gate and leave a note",
    isolation: "none",
    workdir: alpha,
    agent: "claude-code",
    taskType: "bug",
    model: "opus",
    mode: "auto",
  });
  const foreign = await api(request, backend, "post", "/tasks", {
    title: "Foreign only",
    prompt: "do not assign this from alpha",
    isolation: "none",
    workdir: beta,
    agent: "claude-code",
    taskType: "bug",
    model: "opus",
    mode: "auto",
  });
  expect(task.id).not.toBe(foreign.id);
  expect(ada.id).not.toBe(bea.id);

  expect((await request.get(`${backend.apiBase}/task-assignments?employeeId=${ada.id}`)).status()).toBe(401);
  expect((await request.get(`${backend.apiBase}/task-assignments/project?projectPath=${encodeURIComponent(alpha)}&token=${backend.apiToken}`)).status()).toBe(401);
  const crossed = await request.post(`${backend.apiBase}/task-assignments`, {
    headers: headers(backend),
    data: { taskId: foreign.id, employeeId: ada.id },
  });
  expect(crossed.status()).toBe(409);

  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-row").filter({ hasText: "Ada Assign" }).click();
  await expect(page.getByTestId("assigned-tasks-empty")).toHaveText("No tasks assigned.");
  await expect(page.getByTestId("assigned-tasks-note")).toContainText("does not start an agent");
  await expect(page.getByTestId("assigned-task-pick").locator("option", { hasText: "Foreign only" })).toHaveCount(0);
  await expect(page.getByTestId("assigned-task-pick").locator("option", { hasText: "Repair the gate" })).toHaveCount(1);

  const picker = page.getByTestId("assigned-task-pick");
  await picker.focus();
  await picker.selectOption({ label: "Repair the gate" });
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("assigned-task-assign")).toBeFocused();
  await page.keyboard.press("Enter");
  const row = page.getByTestId("assigned-task-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("assigned-task-title")).toHaveText("Repair the gate");
  await expect(row.getByTestId("assigned-task-meta")).toContainText("Backlog");
  await expect(row.getByTestId("assigned-task-provenance")).toHaveText("Owner");
  await expect(page.getByTestId("assigned-task-history-event").first()).toContainText("Assigned to Ada Assign");

  await page.getByTestId("assigned-task-open").click();
  await expect(page.locator("aside").getByText("Repair the gate")).toBeVisible();
  await page.getByRole("button", { name: "Close task details" }).click();
  await expect(page.getByTestId("assigned-tasks")).toBeVisible();

  await page.getByTestId("assigned-task-reassign").selectOption({ label: "Bea Assign" });
  await page.getByTestId("assigned-task-reassign-save").click();
  await expect(page.getByTestId("assigned-tasks-status")).toContainText("Bea Assign");
  await expect(page.getByTestId("employee-card-name")).toHaveText("Ada Assign");
  await page.getByTestId("employee-card-back").click();
  await page.getByTestId("staff-row").filter({ hasText: "Bea Assign" }).click();
  await expect(page.getByTestId("assigned-task-title")).toHaveText("Repair the gate");
  await expect(page.getByTestId("assigned-task-history")).toContainText("Reassigned from Ada Assign to Bea Assign");

  await page.getByTestId("assigned-task-unassign").click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Unassign this task?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("assigned-task-row")).toHaveCount(1);
  await page.getByTestId("assigned-task-unassign").click();
  await dialog.getByRole("button", { name: "Unassign" }).click();
  await expect(page.getByTestId("assigned-tasks-empty")).toBeVisible();
  await expect(page.getByTestId("assigned-task-history")).toContainText("Unassigned from Bea Assign");

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await expect(page.getByTestId("assigned-tasks")).toBeVisible();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(false);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId("assigned-tasks").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    expect(await noOverflow(page)).toBe(true);
  }

  expect(writes.filter((line) => /\/start|model-router|account-core/.test(line))).toEqual([]);
  expect(writes.some((line) => line.startsWith("POST /task-assignments"))).toBe(true);
  const projectList = await api(request, backend, "get", `/task-assignments/project?projectPath=${encodeURIComponent(alpha)}`);
  expect(JSON.stringify(projectList)).not.toContain(foreign.id);
  expect(JSON.stringify(projectList)).not.toContain("Foreign only");
  await expect(row).toHaveCount(0);
});
