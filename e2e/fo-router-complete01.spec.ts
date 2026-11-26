import { expect, test } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";

test("Owner can inspect Smart Router evidence without starting a run", async ({ page, backend, request }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  await dialog.locator("#interface-language").selectOption("ru");
  await dialog.getByTestId("settings-nav-providers").click();
  await expect(dialog.getByTestId("router-recommendation-boundary")).toContainText("не разрешает исполнение");
  await dialog.getByTestId("settings-nav-general").click();
  await dialog.locator("#interface-language").selectOption("en");
  await dialog.getByTestId("settings-nav-providers").click();
  await expect(dialog.getByTestId("router-recommendation-boundary")).toContainText("does not authorize execution");
  await expect(dialog.getByTestId("router-quality-note")).toContainText("not measured benchmark");
  await dialog.getByTestId("policy-preset-quota-saver").click();
  await expect(dialog.getByTestId("policy-preset-quota-saver")).toHaveAttribute("data-selected", "true");
  const runs = await request.get(`${backend.apiBase}/tasks`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  expect(runs.ok()).toBeTruthy();
});
