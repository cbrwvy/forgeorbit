import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";

test("Backup & Recovery restore tab exposes profile activation panel", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  await page.getByRole("button", { name: /settings/i }).click();
  await page.getByRole("button", { name: /backup & recovery/i }).click();
  await page.getByRole("tab", { name: /restore/i }).click();
  await expect(page.getByTestId("profile-activation-panel")).toBeVisible();
  await expect(page.getByTestId("profile-activation-active")).toBeVisible();
});
