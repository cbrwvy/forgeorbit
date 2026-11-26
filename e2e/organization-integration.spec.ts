import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, queryBackendScalar, openAllTasks } from "./helpers";

/**
 * Cross-feature acceptance (FO-010D integration): assignment proposals
 * (FO-010D) on top of the assignment core (FO-010C), next to the model-router
 * preview (FO-009E) and the Codex source (FO-009F). Approving a proposal
 * assigns a person; it never starts a run, previews a resource, probes a CLI or
 * touches an account. Fake codex driver, own SQLite/HOME, no real CLI.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "200",
  },
});

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function call(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "patch", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: auth(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

async function sendToManager(page: Page, text: string): Promise<void> {
  await page.getByTestId("manager-composer").fill(text);
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);
}

test("proposal → approve → explicit reassign → router preview → codex source: nothing runs", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const dir = await mkdtemp(path.join(tmpdir(), "fo010d-integration-"));
  await call(request, backend, "post", "/projects", { path: dir, name: "Org Integration" });
  await call(request, backend, "patch", "/harnesses/codex", { enabled: true });
  const ada = await call(request, backend, "post", "/employees", { name: "Ada Worker", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const bea = await call(request, backend, "post", "/employees", { name: "Bea Worker", jobTitle: "Backend Engineer", projectPath: dir }, 201);
  const task = await call(request, backend, "post", "/tasks", {
    title: "Integration task", prompt: "Assignment only.", isolation: "none", workdir: dir, column: "backlog",
  });

  const requests: string[] = [];
  const forbidden: string[] = [];
  page.on("request", (req) => {
    const p = new URL(req.url()).pathname;
    if (/\.(tsx?|jsx?|css|svg|png|woff2?)$/.test(p) || p.startsWith("/@") || p.startsWith("/node_modules/")) return; // Vite assets, not API calls
    requests.push(`${req.method()} ${p}`);
    if (
      /\/tasks\/[^/]+\/(start|cancel)$/.test(p) ||
      (/\/runs\//.test(p) && req.method() !== "GET") ||
      (p.startsWith("/account-core/codex-source") && req.method() !== "GET") ||
      /usage\/refresh|quota-refresh|switch|open-terminal/.test(p)
    ) forbidden.push(`${req.method()} ${p}`);
  });
  const countRuns = () => queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM runs");
  const assignmentOf = async () => (await call(request, backend, "get", `/task-assignments/task?taskId=${task.id}`)).assignment;
  const employeeBefore = await call(request, backend, "get", `/employees/${ada.id}`);

  // 3-4. Project manager (fake driver) suggests a worker.
  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
  await sendToManager(page, "Please assign the open task");

  // 5. Pending in the project and in the Company; the manager did not assign anything itself.
  await expect(page.getByTestId("assignment-proposal")).toHaveCount(1);
  await expect(page.getByTestId("assignment-proposal-author")).toContainText("Project Manager");
  expect(await assignmentOf()).toBeNull();
  const pending = (await call(request, backend, "get", `/assignment-proposals?projectPath=${encodeURIComponent(dir)}`)).proposals;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ status: "pending", taskId: task.id });
  const firstWorker = pending[0].worker.id as string;
  expect([ada.id, bea.id]).toContain(firstWorker);

  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
  await expect(page.getByTestId("assignment-proposals")).toHaveAttribute("data-scope", "company");
  await expect(page.getByTestId("assignment-proposal")).toHaveCount(1);
  await page.getByTestId("assignment-proposal-project").click();
  await expect(page.getByTestId("project-header-name")).toContainText("Org Integration");

  // 6-7. The owner approves; FO-010C creates the assignment.
  await expect(page.getByTestId("assignment-proposal")).toHaveCount(1);
  await page.getByTestId("assignment-proposal").getByTestId("assignment-proposal-approve").click();
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was started");
  expect(await assignmentOf()).toMatchObject({ employeeId: firstWorker, provenance: "owner", revision: 1 });

  // 8-9. The manager suggests the other worker; replacing needs explicit consent.
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await sendToManager(page, "Please assign differently __fake_pm_assign_reassign__");
  const row = page.getByTestId("assignment-proposal");
  await expect(row).toHaveCount(1);
  const approve = row.getByTestId("assignment-proposal-approve");
  await expect(approve).toHaveText("Approve and replace");
  await expect(approve).toBeDisabled();
  expect(await assignmentOf()).toMatchObject({ employeeId: firstWorker, revision: 1 });
  await row.getByTestId("assignment-proposal-consent").check();
  await approve.click();
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was started");

  // 10. Revision and history.
  const otherWorker = firstWorker === ada.id ? bea.id : ada.id;
  const assignment = await assignmentOf();
  expect(assignment).toMatchObject({ employeeId: otherWorker, revision: 2, provenance: "owner" });
  const history = (await call(request, backend, "get", `/task-assignments/history?taskId=${task.id}`)).events;
  expect(history.map((event: { action: string }) => event.action)).toEqual(["assigned", "reassigned"]);
  const proposals = (await call(request, backend, "get", `/assignment-proposals?projectPath=${encodeURIComponent(dir)}&status=approved`)).proposals;
  expect(proposals.map((p: { status: string }) => p.status).sort()).toEqual(["approved", "approved"]);

  // 11-12. Model Router Preview does not change the assignment.
  await openAllTasks(page);
  await page.getByRole("button", { name: "Integration task" }).click();
  const section = page.getByTestId("ai-resource-recommendation");
  await expect(section).toBeVisible();
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-employee")).toContainText(otherWorker === ada.id ? "Ada Worker" : "Bea Worker");
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-result")).toBeVisible();
  await expect(section.getByTestId("router-verified")).toHaveCount(0);
  expect(await assignmentOf()).toEqual(assignment);
  const employeeAfter = await call(request, backend, "get", `/employees/${ada.id}`);
  expect(employeeAfter.runtimeBinding).toEqual(employeeBefore.runtimeBinding);
  expect(employeeAfter.runtimeBinding.status).toBe("none");
  await page.getByRole("button", { name: "Close task details" }).click();

  // 13-14. Accounts & Resources: Codex source stays Unassigned / Unverified, read-only.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI providers and accounts", exact: true }).click();
  await page.getByTestId("accounts-dashboard").getByRole("button", { name: "Quota Sources", exact: true }).click();
  const connector = page.getByTestId("codex-connector");
  await expect(connector).toBeVisible();
  await expect(connector.getByRole("button", { name: "Verify Authentication", exact: true })).toBeDisabled();
  await expect(connector.getByRole("button", { name: "Confirm Link — Unavailable" })).toBeDisabled();
  await expect(page.getByTestId("quota-source-codex-app-server").getByRole("button", { name: "Refresh Codex app-server rate limits", exact: true })).toBeDisabled();
  const source = await call(request, backend, "get", "/account-core/codex-source");
  expect(source).toMatchObject({ linkedAccountId: null, observedAt: null, refreshAvailable: false, binding: "unverified" });

  // 15-16. No run, no start/cancel, no CLI-ish or quota/account mutation from the UI.
  expect(await countRuns()).toBe(0);
  expect((await call(request, backend, "get", `/tasks/${task.id}`)).column).toBe("backlog");
  expect(forbidden).toEqual([]);
  expect(requests.filter((r) => r.startsWith("POST /account-core"))).toEqual([]);
});
