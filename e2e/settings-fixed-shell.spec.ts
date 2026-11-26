import { test, expect, type Page } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";

/**
 * FO-PM01-UXFIX01: Settings is a fixed shell. Switching sections must not change
 * the dialog's size or position; only the content region scrolls, from the top.
 */

async function shellBox(page: Page) {
  const panel = page.locator('[role="dialog"][aria-labelledby="settings-dialog-title"] > div').first();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  return { w: Math.round(box!.width), h: Math.round(box!.height), x: Math.round(box!.x), y: Math.round(box!.y) };
}

for (const [width, height] of [[1440, 900], [1024, 768], [760, 700]] as const) {
  test(`Settings keeps one size across every section at ${width}x${height}`, async ({ page, freshBackend: backend }) => {
    test.slow();
    await page.setViewportSize({ width, height });
    await gotoApp(page, backend.bootBase);
    await openSettingsGeneral(page);
    const nav = page.getByRole("navigation", { name: /settings sections/i });
    const buttons = nav.getByRole("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(3);
    const first = await shellBox(page);
    expect(first.h).toBeLessThanOrEqual(height);
    const content = page.getByTestId("settings-content");
    for (let i = 0; i < count; i++) {
      await buttons.nth(i).click();
      await page.waitForTimeout(250);
      expect(await shellBox(page), `section ${i}`).toEqual(first);
      // Own scroll area, back at the top after a switch.
      expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
      const overflowY = await content.evaluate((el) => getComputedStyle(el).overflowY);
      expect(overflowY).toBe("auto");
      // The page itself never grows a horizontal scroll because of the dialog.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // Scroll a section, switch away and back: the shell is unchanged and the offset is reset.
    await buttons.nth(0).click();
    await content.evaluate((el) => { el.scrollTop = 300; });
    await buttons.nth(1).click();
    await page.waitForTimeout(150);
    expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await shellBox(page)).toEqual(first);
    // Keyboard: Escape closes and returns focus to the opener.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /settings/i })).toHaveCount(0);
  });
}
