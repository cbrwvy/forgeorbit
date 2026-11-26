import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { gotoApp, openExecutionPlans, openProjectAnalytics, openSettingsGeneral } from "./helpers";

test("Owner navigation shows why live launch is unavailable and starts no provider", async ({ page, backend, request }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  await dialog.getByTestId("settings-nav-providers").click();
  const matrix = dialog.getByTestId("provider-runtime-matrix");
  await expect(matrix.getByTestId("provider-runtime-live-unavailable")).toContainText("Live provider launch is unavailable");
  await expect(matrix.getByTestId("provider-runtime-owner-channel")).toContainText("This screen cannot approve it");
  await expect(matrix.getByTestId("provider-runtime-codex")).toContainText("Not authorized");
  await expect(matrix.getByTestId("provider-runtime-claude-code")).toContainText("Not authorized");
  await expect(matrix.getByTestId("provider-runtime-cursor")).toContainText("Blocked");
  await expect(matrix.getByTestId("provider-runtime-deepseek-dsh")).toContainText("Blocked");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  const dir = await mkdtemp(path.join(tmpdir(), "fo-providers-nav-"));
  const registered = await request.post(`${backend.apiBase}/projects`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { path: dir, name: "Providers" },
  });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  await openProjectAnalytics(page, dir);
  await expect(page.getByTestId("usage-page")).toBeVisible();
  await expect(page.getByTestId("usage-live-launch")).toContainText("does not start a process");
  await page.getByTestId("usage-tab-analytics").click();
  await expect(page.getByTestId("usage-live-launch")).toBeVisible();
  await openExecutionPlans(page);
  await expect(page.getByTestId("mission-control-page")).toBeVisible();
  await page.keyboard.press("Escape");

  const tasks = await request.get(`${backend.apiBase}/tasks`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  expect(tasks.ok()).toBeTruthy();
  const body = await tasks.json();
  const rows = Array.isArray(body) ? body : body.tasks ?? [];
  expect(rows.every((task: { runId?: string | null }) => !task.runId)).toBe(true);
  const harnesses = await request.get(`${backend.apiBase}/harnesses`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  const payload = await harnesses.json() as { runtimeReadiness?: { executableNow: boolean; authorizedExecution: string }[] };
  expect(payload.runtimeReadiness?.every((row) => row.executableNow === false && row.authorizedExecution === "not-authorized")).toBe(true);

  const settings = await openSettingsGeneral(page);
  await settings.locator("#interface-language").selectOption("ru");
  await settings.getByTestId("settings-nav-providers").click();
  await expect(matrix.getByTestId("provider-runtime-live-unavailable")).toContainText("Живой запуск провайдера недоступен");
  await expect(matrix.getByTestId("provider-runtime-owner-channel")).toContainText("не может её одобрить");
  await expect(matrix.getByTestId("provider-runtime-codex")).toContainText("Не разрешено");
});
