import { expect, test } from "./fixtures";
import { gotoApp } from "./helpers";

test("Owner can see self-improvement controls and enable the engine", async ({ page, backend }) => {
  test.setTimeout(90_000);
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-advanced").click();
  await expect(page.getByTestId("self-improvement-panel")).toBeVisible();
  await expect(page.getByTestId("self-improvement-status")).toContainText("Self-improvement is off until the Owner enables it.");
  await expect(page.getByTestId("self-improvement-budget")).toBeVisible();
  await page.getByTestId("self-improvement-enable").click();
  await expect(page.getByTestId("self-improvement-status")).toContainText("Self-improvement is enabled");
  await page.getByTestId("self-improvement-pause").click();
  await expect(page.getByTestId("self-improvement-status")).toContainText("paused");
  await page.getByTestId("self-improvement-stop").click();
  await expect(page.getByTestId("self-improvement-status")).toContainText("stopped");
});
