import { expect, test } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";

test("Owner inspects provider runtime readiness without starting a run", async ({ page, backend, request }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  await dialog.getByTestId("settings-nav-providers").click();
  const matrix = dialog.getByTestId("provider-runtime-matrix");
  await expect(matrix).toBeVisible();
  await expect(matrix.getByTestId("provider-runtime-codex")).toContainText("Not authorized");
  await expect(matrix.getByTestId("provider-runtime-cursor")).toContainText("Blocked");
  await expect(matrix.getByTestId("provider-runtime-deepseek-dsh")).toContainText("Blocked");
  await expect(matrix.getByTestId("provider-runtime-fx")).toContainText("Gateway account");
  await expect(matrix).not.toContainText("Connected");
  await dialog.getByTestId("settings-nav-general").click();
  await dialog.locator("#interface-language").selectOption("ru");
  await dialog.getByTestId("settings-nav-providers").click();
  await expect(matrix.getByTestId("provider-runtime-codex")).toContainText("Не разрешено");
  await expect(matrix.getByTestId("provider-runtime-cursor")).toContainText("Заблокировано");
  const tasks = await request.get(`${backend.apiBase}/tasks`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  expect(tasks.ok()).toBeTruthy();
  const body = await tasks.json();
  const rows = Array.isArray(body) ? body : body.tasks ?? [];
  expect(rows.every((task: { runId?: string | null }) => !task.runId)).toBe(true);
  const harnesses = await request.get(`${backend.apiBase}/harnesses`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  expect(harnesses.ok()).toBeTruthy();
  const payload = await harnesses.json() as { runtimeReadiness?: { providerId: string; executableNow: boolean; authorizedExecution: string }[] };
  expect(payload.runtimeReadiness?.every((row) => row.executableNow === false && row.authorizedExecution === "not-authorized")).toBe(true);
  expect(payload.runtimeReadiness?.map((row) => row.providerId).sort()).toEqual([
    "antigravity", "claude-code", "codex", "cursor", "deepseek-dsh", "fx", "gemini",
  ]);
});
