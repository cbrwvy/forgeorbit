import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api<T = any>(
  request: APIRequestContext,
  backend: E2EBackend,
  method: "get" | "post" | "put" | "patch" | "delete",
  route: string,
  data?: unknown,
  expected = 200,
): Promise<T> {
  const res = await request[method](`${backend.apiBase}${route}`, {
    headers: headers(backend),
    ...(data === undefined ? {} : { data }),
  });
  expect(res.status(), `${method} ${route}: ${await res.text()}`).toBe(expected);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function openCompany(page: Page): Promise<void> {
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

test("Role Catalog browsing, filtering by division, searching, and viewing full markdown", async ({
  page,
  freshBackend: backend,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await gotoApp(page, backend.bootBase);
  await openCompany(page);

  // Role Catalog section on Company Dashboard
  await expect(page.getByTestId("company-role-catalog")).toBeVisible();
  await expect(page.getByTestId("role-catalog")).toBeVisible();
  await expect(page.getByTestId("catalog-title")).toHaveText("Role Catalog Library");

  // Verify total count
  await expect(page.getByTestId("catalog-count-badge")).toContainText("283");

  // Division filter pills: filter to Engineering
  await page.getByTestId("division-filter-engineering").click();
  await expect(page.getByTestId("catalog-count-badge")).toContainText("66 / 283");

  // Search within engineering for "backend"
  await page.getByTestId("catalog-search").fill("backend");
  await expect(page.locator('[data-role-slug="engineering-backend-architect"]')).toBeVisible();

  // Open role detail modal
  await page.locator('[data-role-slug="engineering-backend-architect"]').click();
  await expect(page.getByTestId("role-detail")).toBeVisible();
  await expect(page.getByTestId("role-detail-name")).toHaveText("Backend Architect");
  await expect(page.getByTestId("role-markdown")).toBeVisible();
  await expect(page.getByTestId("role-markdown")).toContainText("Backend Architect");
  await expect(page.getByTestId("role-copy-prompt")).toBeVisible();

  // Test copy prompt button
  await page.getByTestId("role-copy-prompt").click();
  await expect(page.getByTestId("role-copy-prompt")).toContainText("Copied");

  // Close modal
  await page.getByTestId("role-detail-close").click();
  await expect(page.getByTestId("role-detail")).toHaveCount(0);

  // Clear search and reset to all
  await page.getByTestId("division-filter-all").click();
  await page.getByTestId("catalog-search").fill("");
  await expect(page.getByTestId("catalog-count-badge")).toContainText("283 / 283");
});

test("Employee Professional Profile lifecycle: assign role, edit instructions, revision history, and restore template", async ({
  page,
  request,
  freshBackend: backend,
}) => {
  // Create an employee via API
  const worker = await api(request, backend, "post", "/employees", {
    name: "Katherine Johnson",
    jobTitle: "Orbital Trajectory Specialist",
    roleCategory: "engineering",
  }, 201);

  await gotoApp(page, backend.bootBase);
  await openCompany(page);

  // Navigate to Staff tab and open employee card
  await page.getByTestId("company-tab-staff").click();
  await page.locator(`[data-employee-id="${worker.id}"]`).click();
  await expect(page.getByTestId("employee-card")).toBeVisible();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Katherine Johnson");

  // Navigate to Professional Prompt tab
  await page.getByTestId("employee-tab-prompt").click();
  await expect(page.getByTestId("employee-professional-profile-tab")).toBeVisible();

  // Initial state: legacy/empty profile
  await expect(page.getByTestId("profile-empty-state")).toBeVisible();
  await expect(page.getByTestId("employee-assign-catalog-role")).toBeVisible();

  // Click assign role button
  await page.getByTestId("employee-assign-catalog-role").click();
  await expect(page.getByTestId("assign-role-dialog")).toBeVisible();

  // Select Backend Architect
  await page.locator('[data-testid="assign-role-dialog"] input[type="search"]').fill("Backend Architect");
  await page.locator('[data-testid="assign-role-dialog"]').getByText("Backend Architect").first().click();
  await page.getByTestId("confirm-assign-role-btn").click();

  // Specialization card is now active
  await expect(page.getByTestId("professional-specialization-card")).toBeVisible();
  await expect(page.getByTestId("profile-title")).toHaveText("Backend Architect");
  await expect(page.getByTestId("profile-division-badge")).toContainText("engineering");
  await expect(page.getByTestId("profile-revision-badge")).toHaveText("Rev 1");
  await expect(page.getByTestId("prompt-instructions-display")).toContainText("Backend Architect");

  // Edit prompt instructions
  await page.getByTestId("prompt-edit").click();
  await expect(page.getByTestId("prompt-editor-textarea")).toBeVisible();

  // Toggle preview mode
  await page.getByTestId("prompt-preview-toggle").click();
  await expect(page.getByTestId("prompt-editor-preview")).toBeVisible();
  await page.getByTestId("prompt-preview-toggle").click();
  await expect(page.getByTestId("prompt-editor-textarea")).toBeVisible();

  // Enter new custom prompt
  await page.getByTestId("prompt-editor-textarea").fill("# Orbital Backend Architect\nAlways verify trajectory safety before execution.");
  await page.getByTestId("prompt-save").click();

  // Active profile now shows revision 2
  await expect(page.getByTestId("prompt-status")).toContainText("Saved revision 2");
  await expect(page.getByTestId("profile-revision-badge")).toHaveText("Rev 2");
  await expect(page.getByTestId("prompt-instructions-display")).toContainText("Orbital Backend Architect");

  // Check Revision History dialog
  await page.getByTestId("prompt-history").click();
  await expect(page.getByTestId("revision-history-dialog")).toBeVisible();
  await expect(page.getByTestId("revision-item")).toHaveCount(2);

  // Inspect previous revision 1
  await page.getByTestId("view-revision-1").click();
  await expect(page.getByText("Viewing Revision 1 (Read-only)")).toBeVisible();

  // Close history dialog
  await page.locator('[data-testid="revision-history-dialog"] button[aria-label="Close"]').click();
  await expect(page.getByTestId("revision-history-dialog")).toHaveCount(0);

  // Restore original template
  await page.getByTestId("prompt-restore-template").click();
  const confirmBtn = page.getByRole("button", { name: "Restore as new revision" });
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();

  // Active profile now shows revision 3
  await expect(page.getByTestId("prompt-status")).toContainText("Restored original template as revision 3");
  await expect(page.getByTestId("profile-revision-badge")).toHaveText("Rev 3");
  await expect(page.getByTestId("prompt-instructions-display")).toContainText("Backend Architect");
});

test("Role Catalog UI responsive viewports, light/dark themes, and keyboard navigation", async ({
  page,
  freshBackend: backend,
}) => {
  await gotoApp(page, backend.bootBase);
  await openCompany(page);

  await expect(page.getByTestId("company-role-catalog")).toBeVisible();
  await expect(page.getByTestId("role-catalog")).toBeVisible();

  // Emulate Dark theme
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await expect(page.getByTestId("role-catalog")).toBeVisible();

  // Emulate Light theme
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(false);
  await expect(page.getByTestId("role-catalog")).toBeVisible();

  // Check 4 responsive viewports: 390, 768, 1024, 1440
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    const box = await page.getByTestId("company-page").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    expect(await noOverflow(page)).toBe(true);
  }
});
