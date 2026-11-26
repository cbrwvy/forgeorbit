import { expect, test } from "./fixtures";
import { gotoApp } from "./helpers";
import type { Page, Request } from "@playwright/test";

// FO-UX-SIMPLIFY02-M4: six Settings sections, a search/jump list, and the autonomy and
// Owner controls moved out of Missions. Selectors are test ids and roles, never classes.

const SECTIONS = ["general", "providers", "autonomy", "plans", "tools", "library", "advanced"] as const;
const PANELS: Record<(typeof SECTIONS)[number], string[]> = {
  general: ["appearance", "preferences"],
  providers: ["harnesses", "accounts", "ai_router"],
  autonomy: ["autonomy_layers", "autonomy_policy", "owner_trust"],
  plans: ["execution_plans"],
  tools: ["tools", "git", "tool_links"],
  library: ["prompts", "agents", "pipelines"],
  advanced: ["backup", "runtime", "data", "self_improvement", "diagnostics"],
};

async function openSettings(page: Page) {
  await page.getByTestId("open-settings").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("settings-nav-general")).toBeVisible();
  return dialog;
}

/** Everything that could change state on the autonomy, Owner, mission or self-improvement routes. */
function watchWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    // The Router dashboard's read-only preview evaluation is a POST that stores nothing.
    if (request.url().includes("/api/router-v2/evaluate")) return;
    if (/\/api\/(autonomy|owner-trust|self-improvement|missions|execution|usage|router)/.test(request.url())) writes.push(request);
  });
  return writes;
}

test("Settings shows its sections and every previous panel is reachable", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettings(page);
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button")).toHaveText(["General", "AI providers and accounts", "Autonomy and safety", "Execution plans", "Tools and access", "Library", "Advanced"]);
  for (const section of SECTIONS) {
    await dialog.getByTestId(`settings-nav-${section}`).click();
    await expect(dialog.getByTestId(`settings-nav-${section}`)).toHaveAttribute("aria-current", "page");
    for (const panel of PANELS[section]) await expect(dialog.getByTestId(`settings-sub-${panel}`)).toBeVisible();
  }
});

test("moved controls keep their test ids: technical details in Advanced, Browser and Native in Tools", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettings(page);
  await dialog.getByTestId("settings-nav-advanced").click();
  await expect(dialog.locator("#show-technical-details")).toBeVisible();
  await expect(dialog.getByTestId("technical-details-setting")).toBeVisible();
  await expect(dialog.getByTestId("settings-fx-auto-resume")).toBeVisible();
  await expect(dialog.getByTestId("settings-db-compact")).toBeVisible();
  await dialog.getByTestId("settings-nav-general").click();
  await expect(dialog.locator("#show-technical-details")).toHaveCount(0);
  await expect(dialog.locator("#interface-language")).toBeVisible();
  await dialog.getByTestId("settings-nav-tools").click();
  await expect(dialog.getByTestId("workspace-browser")).toBeVisible();
  await expect(dialog.getByTestId("workspace-native-computer")).toBeVisible();
});

test("search jumps to the matching control, in English and Russian, and never writes", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const writes = watchWrites(page);
  const dialog = await openSettings(page);
  const input = dialog.getByTestId("settings-search-input");

  await input.fill("technical");
  await dialog.getByTestId("settings-search-result-technical_details").click();
  await expect(dialog.getByTestId("settings-nav-advanced")).toHaveAttribute("aria-current", "page");
  await expect(dialog.locator("#show-technical-details")).toBeFocused();

  await input.fill("emergency");
  await expect(dialog.getByTestId("settings-search-results")).toBeVisible();
  await input.press("Enter");
  await expect(dialog.getByTestId("settings-nav-autonomy")).toHaveAttribute("aria-current", "page");
  await expect(dialog.getByTestId("autonomy-emergency")).toBeFocused();

  await input.fill("zzzz-nothing");
  await expect(dialog.getByTestId("settings-search-empty")).toBeVisible();
  await input.press("Escape");
  await expect(dialog.getByTestId("settings-search-results")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await dialog.getByTestId("settings-nav-general").click();
  await dialog.locator("#interface-language").selectOption("ru");
  await input.fill("тема");
  await dialog.getByTestId("settings-search-result-theme").click();
  await expect(dialog.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "page");
  await expect(dialog.getByTestId("theme-picker").getByRole("button").first()).toBeFocused();
  expect(writes).toHaveLength(0);
  // The language is a per-worker preference; leave it as other specs expect it.
  await dialog.locator("#interface-language").selectOption("en");
});

test("opening sections and following links saves, activates and starts nothing", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const writes = watchWrites(page);
  const dialog = await openSettings(page);
  for (const section of SECTIONS) {
    await dialog.getByTestId(`settings-nav-${section}`).click();
    await expect(dialog.getByTestId(`settings-nav-${section}`)).toHaveAttribute("aria-current", "page");
  }
  await dialog.getByTestId("settings-nav-autonomy").click();
  await expect(dialog.getByTestId("layer-router-value")).toBeVisible();
  await expect(dialog.getByTestId("layer-enforced-value")).toContainText("Supervised");
  await dialog.getByTestId("layer-router-open").click();
  await expect(dialog.getByTestId("settings-nav-providers")).toHaveAttribute("aria-current", "page");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-plans").click();
  await page.getByTestId("missions-open-policy").click();
  await expect(page.getByTestId("settings-nav-autonomy")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("autonomy-control-panel")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-plans").click();
  await page.getByTestId("missions-open-owner").click();
  await expect(page.getByTestId("owner-trust-panel")).toBeVisible();
  // No mission context was given, so the panel shows the same status it always did.
  await expect(page.getByTestId("owner-trust-context")).toHaveCount(0);
  expect(writes.map((r) => `${r.method()} ${r.url()}`)).toEqual([]);
});

test("Save draft sends the same policy request as before; nothing activates", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettings(page);
  await dialog.getByTestId("settings-nav-autonomy").click();
  await dialog.getByTestId("autonomy-mode-autonomous").click();
  await dialog.getByTestId("autonomy-projects").fill("/tmp/m4-project");
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" || !/\/api\/autonomy/.test(request.url())) return;
    requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() as Record<string, unknown> | null });
  });
  await dialog.getByTestId("autonomy-save-draft").click();
  await expect(dialog.getByTestId("autonomy-digest")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: "POST", path: "/api/autonomy/policies" });
  expect(requests[0]!.body).toMatchObject({ mode: "autonomous" });
  expect(JSON.stringify(requests[0]!.body)).toContain("/tmp/m4-project");
  expect(requests.some((r) => r.path.endsWith("/activate"))).toBe(false);
});

test("an unsaved policy draft survives section switches; closing asks before discarding it", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettings(page);
  await dialog.getByTestId("settings-nav-autonomy").click();
  await dialog.getByTestId("autonomy-projects").fill("/tmp/unsaved-draft");
  await dialog.getByTestId("settings-nav-general").click();
  await dialog.getByTestId("settings-nav-advanced").click();
  await dialog.getByTestId("settings-nav-autonomy").click();
  await expect(dialog.getByTestId("autonomy-projects")).toHaveValue("/tmp/unsaved-draft");

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "Discard the unsaved policy draft?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByTestId("autonomy-projects")).toHaveValue("/tmp/unsaved-draft");

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog").filter({ hasText: "Discard the unsaved policy draft?" }).getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("settings-nav-general")).toHaveCount(0);
  // Reopening starts from a clean form.
  const reopened = await openSettings(page);
  await reopened.getByTestId("settings-nav-autonomy").click();
  await expect(reopened.getByTestId("autonomy-projects")).toHaveValue("");
});

test("Execution plans keep start and review; policy, Owner confirmation and self-improvement stay in their own sections", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-plans").click();
  const controls = page.getByTestId("mission-controls");
  await expect(controls.getByTestId("autonomy-mission-form")).toBeVisible();
  await expect(controls.getByTestId("missions-setup-in-settings")).toBeVisible();
  for (const id of ["autonomy-control-panel", "owner-trust-panel", "self-improvement-panel", "autonomy-emergency"]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  // Starting needs a policy; the page says so and links to the policy, which only opens it.
  await expect(page.getByTestId("autonomy-mission-start")).toBeDisabled();
  await expect(page.getByTestId("autonomy-mission-needs-policy")).toBeVisible();
  // The title-bar stop is untouched.
  await expect(page.getByTestId("emergency-stop")).toBeVisible();
});

test.describe("layout", () => {
  for (const locale of ["en", "ru"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1024, 800]) {
        test(`${locale} ${scheme} ${width}px: nothing is clipped and every section fits`, async ({ page, backend }, testInfo) => {
          test.setTimeout(90_000);
          await page.setViewportSize({ width, height: 800 });
          await gotoApp(page, backend.bootBase);
          const dialog = await openSettings(page);
          if (locale === "ru") await dialog.locator("#interface-language").selectOption("ru");
          const theme = dialog.getByTestId(`theme-${scheme}`);
          await theme.click();
          await expect(theme).toHaveAttribute("aria-pressed", "true");
          for (const section of SECTIONS) {
            await dialog.getByTestId(`settings-nav-${section}`).click();
            await expect(dialog.getByTestId(`settings-section-${section}`)).toBeVisible();
            const overflow = await page.evaluate(() => {
              const content = document.querySelector<HTMLElement>('[data-testid="settings-content"]');
              const nav = document.querySelector<HTMLElement>('[aria-label][data-testid="settings-nav-general"]')?.parentElement;
              return {
                contentX: content ? content.scrollWidth - content.clientWidth : -1,
                pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                navVisible: !!nav,
              };
            });
            expect(overflow.contentX).toBeLessThanOrEqual(1);
            expect(overflow.pageX).toBeLessThanOrEqual(1);
            await page.screenshot({ path: testInfo.outputPath(`settings-${section}-${locale}-${scheme}-${width}.png`) });
          }
        });
      }
    }
  }
});
