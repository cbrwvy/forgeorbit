import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

async function call(request: APIRequestContext, backend: E2EBackend, method: string, route: string, data?: unknown, expected = 200) {
  const res = await request.fetch(`${backend.apiBase}${route}`, { method, headers: { authorization: `Bearer ${backend.apiToken}` }, data });
  expect(res.status(), await res.text()).toBe(expected);
  return res.json();
}
async function setup(request: APIRequestContext, backend: E2EBackend) {
  const dir = await mkdtemp(path.join(backend.dataDir, "fo014d-browser-project-"));
  await call(request, backend, "POST", "/projects", { path: dir, name: "Professional fixture" });
  const employee = await call(request, backend, "POST", "/employees", { name: "Ada Professional", jobTitle: "Engineer", projectPath: dir }, 201);
  await call(request, backend, "POST", `/employees/${employee.id}/professional-profile`, { catalogRoleSlug: "engineering-backend-architect", promptMarkdown: "# Approved historical revision\nHISTORICAL_PROFILE_MARKER" });
  const task = await call(request, backend, "POST", "/tasks", { title: "Professional runtime task", prompt: "Do approved fixture work", workdir: dir, column: "ready", isolation: "none", agent: "claude-code", model: "opus", mode: "auto" });
  await call(request, backend, "POST", "/task-assignments", { taskId: task.id, employeeId: employee.id }, 201);
  return { employee, task };
}
async function openReview(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Professional runtime task" }).click();
  await page.getByTestId("employee-execution").locator("summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toBeVisible();
}

test("owner reviews exact professional prompt; employee card history retains revision 1 after profile edit", async ({ page, request, freshBackend: backend }, testInfo) => {
  const { employee, task } = await setup(request, backend);
  await openReview(page, backend);
  const binding = page.getByTestId("employee-run-dialog").getByTestId("professional-attribution");
  await expect(binding).toHaveAttribute("data-revision", "1");
  await binding.locator("summary").click();
  await expect(binding).toContainText("Backend Architect");
  await expect(binding.getByTestId("professional-historical-prompt")).toContainText("HISTORICAL_PROFILE_MARKER");
  expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(0);
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect.poll(async () => (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0].professional.payloadStatus).toBe("included");
  const attempt = (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0];
  await call(request, backend, "PUT", `/employees/${employee.id}/professional-profile`, { expectedRevision: 1, promptMarkdown: "# Active revision two\nLATER_PROFILE_MARKER" });
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  await page.locator(`[data-employee-id="${employee.id}"]`).click();
  await expect(page.getByTestId("employee-card-profession")).toContainText("active prompt revision 2");
  const history = page.getByTestId("execution-history-entry").first();
  await history.locator("summary").first().click();
  const historical = history.getByTestId("professional-attribution");
  await expect(historical).toHaveAttribute("data-revision", "1");
  await historical.locator("summary").click();
  await expect(historical).toContainText(attempt.professional.binding.promptSha256);
  await expect(historical.getByTestId("professional-historical-prompt")).toContainText("HISTORICAL_PROFILE_MARKER");
  await expect(historical.getByTestId("professional-historical-prompt")).not.toContainText("LATER_PROFILE_MARKER");
  await page.screenshot({ path: testInfo.outputPath("professional-history-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("professional-history-mobile.png"), fullPage: true });
});

test("profile edit while review is open requires reapproval and launches nothing", async ({ page, request, freshBackend: backend }) => {
  const { employee, task } = await setup(request, backend);
  await openReview(page, backend);
  await call(request, backend, "PUT", `/employees/${employee.id}/professional-profile`, { expectedRevision: 1, promptMarkdown: "# Changed before confirmation" });
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-error")).toContainText("Professional profile changed since review");
  await expect(page.getByTestId("employee-run-confirm")).toBeDisabled();
  expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(0);
});
