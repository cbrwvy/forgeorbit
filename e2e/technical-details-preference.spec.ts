import { expect, test } from "./fixtures";
import { gotoApp } from "./helpers";

// FO-UX-SIMPLIFY02-M2: one global, presentation-only "Show technical details" preference.
test("technical details are closed by default, open on request, and the global setting persists", async ({ page, backend }) => {
  test.setTimeout(90_000);
  await gotoApp(page, backend.bootBase);
  // FO-UX-SIMPLIFY02-M4: Owner authorization lives in Settings → Autonomy and safety.
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-autonomy").click();
  const panel = page.getByTestId("owner-trust-panel");
  await expect(panel).toBeVisible();

  // Everyday view: plain status, the safety line and the review button; no protocol code on screen.
  await expect(page.getByTestId("owner-trust-state")).toBeVisible();
  await expect(page.getByTestId("owner-trust-execution")).toBeVisible();
  await expect(page.getByTestId("owner-trust-action")).toBeVisible();
  await expect(page.getByTestId("owner-trust-no-process")).toBeVisible();
  await expect(page.getByTestId("owner-trust-review")).toBeVisible();
  const details = page.getByTestId("owner-trust-details");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("owner-trust-code")).toBeHidden();
  await expect(page.getByTestId("owner-trust-intro")).toBeHidden();

  // A single block opens from the keyboard while the global setting is off.
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("owner-trust-code")).toBeVisible();
  await expect(page.getByTestId("owner-trust-code")).toContainText("application-identity-unestablished");
  await expect(page.getByTestId("owner-trust-how")).not.toHaveAttribute("open", "");

  // Turn the global setting on in Settings → Advanced → Diagnostics (same stored key as before).
  await page.evaluate(() => window.localStorage.getItem("agetor:technical-details")).then((value) => expect(value).toBeNull());
  await page.getByTestId("settings-nav-advanced").click();
  const toggle = page.locator("#show-technical-details");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => window.localStorage.getItem("agetor:technical-details"))).toBe("on");
  await page.getByTestId("settings-nav-autonomy").click();

  // Every diagnostic block on the page is now open.
  await expect(page.getByTestId("owner-trust-details")).toHaveAttribute("open", "");
  await expect(page.getByTestId("owner-trust-how")).toHaveAttribute("open", "");
  await expect(page.getByTestId("owner-trust-intro")).toBeVisible();
  await expect(page.getByTestId("owner-trust-bundle")).toBeVisible();

  // The choice survives a reload; the Owner controls are unchanged.
  await page.reload();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-autonomy").click();
  await expect(page.getByTestId("owner-trust-details")).toHaveAttribute("open", "");
  await expect(page.getByTestId("owner-trust-review")).toBeVisible();
  await expect(page.getByTestId("emergency-stop")).toBeVisible();
});
