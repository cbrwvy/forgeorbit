import { expect, test } from "./fixtures";
import { gotoApp, openSettingsGeneral, openExecutionPlans } from "./helpers";

test("Owner inspects Router policy and fallback boundary without starting a run", async ({ page, backend, request }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  await dialog.locator("#interface-language").selectOption("ru");
  await dialog.getByTestId("settings-nav-providers").click();
  await expect(dialog.getByTestId("router-recommendation-boundary")).toContainText("не разрешает исполнение");
  await expect(dialog.getByTestId("router-fallback-boundary")).toContainText("не дает права на исполнение");
  await dialog.getByTestId("settings-nav-general").click();
  await dialog.locator("#interface-language").selectOption("en");
  await dialog.getByTestId("settings-nav-providers").click();
  await expect(dialog.getByTestId("router-recommendation-boundary")).toContainText("does not authorize execution");
  await expect(dialog.getByTestId("router-fallback-boundary")).toContainText("not execution authority");
  await dialog.getByTestId("policy-preset-fastest").click();
  await expect(dialog.getByTestId("policy-preset-fastest")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Escape");
  await openExecutionPlans(page);
  await expect(page.getByTestId("mission-control-page")).toBeVisible();
  const tasks = await request.get(`${backend.apiBase}/tasks`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  expect(tasks.ok()).toBeTruthy();
  const body = await tasks.json();
  const rows = Array.isArray(body) ? body : body.tasks ?? [];
  expect(rows.every((task: { runId?: string | null }) => !task.runId)).toBe(true);
});
