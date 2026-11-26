import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * WKWebView skips buttons under the default macOS Tab preference. The page
 * walker puts the rail and Emergency Stop in the tab order. This is the
 * Chromium check; the packaged window is the native one.
 */
test("Tab reaches Workspaces and Emergency Stop, and Escape restores the Settings opener", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  const workspaces = page.getByTestId("workspace-workspaces");
  const stop = page.getByTestId("emergency-stop-button");
  const settings = page.getByTestId("open-settings");

  const focused = (locator: typeof workspaces) => locator.evaluate((el) => el === document.activeElement);
  const tabTo = async (locator: typeof workspaces) => {
    for (let i = 0; i < 120 && !(await focused(locator)); i++) await page.keyboard.press("Tab");
    await expect(locator).toBeFocused();
  };

  await tabTo(workspaces);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("clusters-page")).toBeVisible();

  await tabTo(stop);
  await expect(stop).toHaveAccessibleName(/emergency stop/i);

  await tabTo(settings);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});
