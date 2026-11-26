import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";

test("a compact Russian project keeps next steps and assignment reachable by keyboard", async ({ page, request, freshBackend: backend }) => {
  const call = async (method: string, path: string, data?: unknown) => {
    const response = await request.fetch(backend.apiBase + path, { method, headers: { authorization: `Bearer ${backend.apiToken}` }, data });
    expect(response.ok(), `${method} ${path}`).toBeTruthy();
    return response.status() === 204 ? null : await response.json();
  };
  const name = "Проверка готовности проекта и согласование всех материалов перед следующим выпуском";
  const title = "Проверить обновлённые инструкции и собрать результаты для окончательного согласования проекта";
  await call("PUT", "/preferences/locale", { value: "ru" });
  await call("POST", "/projects", { name, path: backend.dataDir });
  const employee = await call("POST", "/employees", { projectPath: backend.dataDir, name: "Анна Смирнова", jobTitle: "Developer" });
  const task = await call("POST", "/tasks", {
    title, prompt: "Проверить инструкции для нового сотрудника.", workdir: backend.dataDir, isolation: "none",
    column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "ask",
  });

  await page.setViewportSize({ width: 1024, height: 720 });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("project-nav-item").filter({ hasText: name }).click();
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("project-header-name")).toHaveText(name);
  await expect(page.getByTestId("project-breadcrumb-page")).toHaveAttribute("aria-current", "page");
  const open = page.getByRole("button", { name: title, exact: true });
  await open.focus();
  await page.keyboard.press("Enter");
  const taskPanel = page.getByRole("complementary", { name: title });
  await expect(taskPanel).toBeFocused();
  await expect(taskPanel.getByTestId("manager-task-primary")).toBeInViewport();
  await expect(taskPanel.getByTestId("manager-task-technical-details")).toBeHidden();
  await taskPanel.getByTestId("task-assignment-pick").selectOption(employee.id);
  await taskPanel.getByTestId("task-assignment-save").click();
  await expect(taskPanel.getByTestId("task-assignment-current")).toContainText(employee.name);
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await expect(page.getByTestId("task-card-assignee")).toHaveText(employee.name);
  expect(await call("GET", `/tasks/${task.id}/runs`)).toEqual([]);
});
