import type { Page } from "@playwright/test";

/** Project pages that moved under the project's More menu in M5 (same test ids as before). */
const MORE_PAGES = new Set(["recurring", "estimates", "environment", "knowledge", "brain", "settings"]);

/** Open a project workspace page by its pre-M5 id, through More where it now lives. */
export async function clickProjectPage(page: Page, id: string) {
  if (MORE_PAGES.has(id)) await page.getByTestId("project-more").click();
  await page.getByTestId(`project-page-${id}`).click();
}

/** The control that shows a project page as the current one: aria-pressed on a
 *  primary tab, aria-current on a More menu item (the menu is open when it is queried). */
export function projectPageIsMore(id: string) {
  return MORE_PAGES.has(id);
}
