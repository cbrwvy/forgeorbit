import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "300",
  },
});

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

test("Project Manager Team Builder, Hiring Proposals, Owner Review, and Employee Creation", async ({
  page,
  request,
  freshBackend: backend,
}) => {
  test.slow();

  // 1. Pre-enable codex harness for manager test
  await api(request, backend, "patch", "/harnesses/codex", { enabled: true });

  // 2. Register project
  const dir = await mkdtemp(path.join(backend.dataDir, "fo014c-team-"));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Team Builder App\n\nAI Team building application.\n");
  await writeFile(path.join(dir, "docs/PRD.md"), "# PRD\n\nRequirements for team building.\n");
  const proj = await api<{ path: string }>(request, backend, "post", "/projects", { path: dir, name: "Team Builder App" });
  expect(proj.path).toBe(dir);

  // 3. Open app and go to project manager
  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();

  // 4. Set up manager consent
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");

  // 5. Build Team button opens Runbooks Dialog
  await expect(page.getByTestId("manager-build-team")).toBeVisible();
  await page.getByTestId("manager-build-team").click();

  await expect(page.getByTestId("runbooks-dialog")).toBeVisible();
  await expect(page.getByTestId("runbook-option-startup-mvp")).toBeVisible();

  // Select Startup MVP and click "Use Blueprint in PM"
  await page.getByTestId("use-runbook-button").click();
  await expect(page.getByTestId("runbooks-dialog")).toHaveCount(0);

  // Composer now has team blueprint recommendation request
  await expect(page.getByTestId("manager-composer")).toContainText("Startup MVP");

  // 6. Send message to PM
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0, { timeout: 30_000 });

  // 7. Manager reply contains hiring proposal banner
  await expect(page.getByTestId("message-hiring-proposals-banner")).toBeVisible();

  // 8. Hiring Proposals panel displays the pending specialists
  await expect(page.getByTestId("hiring-proposals-container")).toBeVisible();
  await expect(page.getByTestId("hiring-proposal-card")).toHaveCount(2);

  // Inspect first proposal card (Devon - Frontend Developer)
  const devonCard = page.getByTestId("hiring-proposal-card").filter({ hasText: "Devon" });
  await expect(devonCard.getByTestId("proposal-name")).toHaveText("Devon");
  await expect(devonCard.getByTestId("proposal-title")).toHaveText("Senior Frontend Engineer");
  await expect(devonCard.getByTestId("proposal-slug")).toHaveText("engineering-frontend-developer");
  await expect(devonCard.getByTestId("proposal-status")).toHaveText("Pending Review");
  await expect(devonCard.getByTestId("proposal-justification")).toContainText("user interface with React");

  // 9. Inspect Prompt & Diff modal
  await devonCard.getByTestId("inspect-prompt-button").click();
  await expect(page.getByText("Comparison (Diff)")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // 10. Approve Devon directly
  await devonCard.getByTestId("approve-proposal-button").click();
  await page.getByRole("button", { name: "Approve Hiring" }).click();
  await expect(page.getByTestId("hiring-action-status")).toContainText("Hired Devon");

  // Verify NO automatic task or run was started
  const tasks = await api<any[]>(request, backend, "get", "/tasks");
  expect(tasks.length).toBe(0);

  // 11. Reject second proposal (Blake)
  const blakeCard = page.getByTestId("hiring-proposal-card").filter({ hasText: "Blake" });
  await blakeCard.getByTestId("reject-proposal-button").click();
  await page.getByRole("button", { name: "Reject Proposal" }).click();
  await expect(page.getByTestId("hiring-action-status")).toContainText("Rejected proposal for Blake");

  // 12. Switch to Approved tab and verify Devon is marked Approved with View Employee
  await page.getByTestId("filter-tab-approved").click();
  const approvedDevonCard = page.getByTestId("hiring-proposal-card").filter({ hasText: "Devon" });
  await expect(approvedDevonCard.getByTestId("proposal-status")).toHaveText("Approved");

  // 13. Go to Company Page and verify Devon is now listed as an Employee with Professional Profile
  await openCompany(page);
  await expect(page.getByTestId("company-page")).toBeVisible();

  // Navigate to Staff tab
  await page.getByTestId("company-tab-staff").click();
  const devonStaffRow = page.locator('[data-testid="staff-row"]').filter({ hasText: "Devon" });
  await expect(devonStaffRow).toBeVisible();

  // Click Devon to open Employee Card
  await devonStaffRow.click();
  await expect(page.getByTestId("employee-card")).toBeVisible();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Devon");

  // Check Professional Prompt tab
  await page.getByTestId("employee-tab-prompt").click();
  await expect(page.getByTestId("employee-professional-profile-tab")).toBeVisible();
  await expect(page.getByTestId("profile-title")).toHaveText("Senior Frontend Engineer");
  await expect(page.getByTestId("profile-revision-badge")).toHaveText("Rev 1");
  await expect(page.getByTestId("prompt-instructions-display")).toBeVisible();

  // 14. Responsive layout test at 390px mobile viewport
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("employee-card")).toBeVisible();

  // 15. Tablet viewport at 768px
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByTestId("employee-card")).toBeVisible();

  // 16. Desktop viewport at 1440px
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("employee-card")).toBeVisible();
});
