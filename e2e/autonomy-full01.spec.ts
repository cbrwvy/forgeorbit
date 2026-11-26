import { expect, test } from "./fixtures";
import { gotoApp } from "./helpers";

test("Owner can see that Full Autonomy is inactive until a policy is enforced", async ({ page, backend }) => {
  test.setTimeout(90_000);
  await gotoApp(page, backend.bootBase);
  // FO-UX-SIMPLIFY02-M4: the policy lives in Settings → Autonomy and safety.
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-autonomy").click();
  await expect(page.getByTestId("autonomy-control-panel")).toBeVisible();
  await expect(page.getByTestId("autonomy-enforcement-status")).toContainText("Supervised execution is in force");
  await page.getByTestId("autonomy-mode-full-autonomy").click();
  await expect(page.getByTestId("autonomy-full-not-active")).toBeVisible();
  await expect(page.getByTestId("autonomy-enforcement-status")).toContainText("Supervised execution is in force");
  await page.getByTestId("autonomy-emergency").click();
  await expect(page.getByTestId("autonomy-emergency-active")).toBeVisible();
  await page.getByTestId("autonomy-clear-emergency").click();
  // FO-UX-SIMPLIFY02-M1: lifting the stop needs the Owner's explicit confirmation.
  await page.getByRole("dialog").getByRole("button", { name: "Lift emergency stop" }).click();
  await expect(page.getByTestId("autonomy-emergency-active")).toHaveCount(0);
  await expect(page.getByTestId("autonomy-enforcement-status")).toContainText("Supervised execution is in force");
});
