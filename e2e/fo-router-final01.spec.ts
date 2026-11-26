import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { gotoApp } from "./helpers";

test("Owner estimates a Backlog task, compares a resource, and approves no execution", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(120_000);
  const workdir = await mkdtemp(path.join(backend.dataDir, "router-backlog-"));
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const registered = await request.post(`${backend.apiBase}/projects`, { headers, data: { path: workdir, name: "Router backlog" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers,
    data: {
      title: "Router backlog fixture", prompt: "Estimate only. Do not launch.", workdir, isolation: "none",
      column: "backlog", agent: "codex", model: "gpt-6.1-sol", mode: "auto",
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const task = await created.json() as { id: string; column?: string; runId?: string | null };
  expect(task.runId ?? null).toBeNull();

  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${workdir}"]`).click();
  await page.getByTestId("project-page-board").click();
  await page.getByTestId("task-estimate").click();
  const dialog = page.getByTestId("usage-task-dialog");
  const estimate = dialog.getByTestId("usage-task-estimate").filter({ visible: true });
  await expect(estimate).toContainText("Confidence");
  await expect(estimate).toContainText("Unknown");
  const compare = estimate.getByRole("button", { name: "Preview alternative schedule" });
  if (await compare.count()) {
    await compare.first().click();
    const alternative = estimate.getByTestId("usage-alternative");
    await expect(alternative).toBeVisible();
    await alternative.getByRole("button", { name: "Review resource change" }).click();
    await expect(alternative).toContainText("Execution requires separate authorization");
    await alternative.getByRole("button", { name: "Approve resource selection" }).click();
    await expect(alternative.getByRole("button", { name: "Apply approved selection" })).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Router backlog fixture", exact: true }).click();
  const recommendation = page.getByTestId("ai-resource-recommendation");
  await recommendation.locator("> summary").click();
  await expect(page.getByTestId("router-preview-banner")).toContainText("no agents started");
  await expect(page.getByTestId("router-policy")).toBeVisible();
  await page.getByTestId("find-ai-resource").click();
  await expect(page.getByTestId("router-result").or(page.getByTestId("router-error"))).toBeVisible();
  await expect(page.getByTestId("router-preview-banner")).toContainText("no agents started");
  await page.getByRole("button", { name: "Close task details" }).click();

  await page.getByTestId("open-settings").click();
  const dialogRu = page.getByRole("dialog");
  await expect(dialogRu.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialogRu.locator("#interface-language").selectOption("ru");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("task-estimate")).toHaveText("Оценить");
  await page.getByRole("button", { name: "Router backlog fixture", exact: true }).click();
  await expect(page.getByTestId("ai-resource-recommendation").locator("> summary")).toContainText("Рекомендация ресурса ИИ");

  const after = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers });
  expect(after.ok()).toBeTruthy();
  const saved = await after.json() as { column: string; runId?: string | null };
  expect(saved.column).toBe("backlog");
  expect(saved.runId ?? null).toBeNull();
});
