import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-ORCH01 executor recommendations, Owner preferences and Codex permission disclosure.
 * Fake drivers behind stub binaries: no real AI CLI or provider runs. Every test has its own backend.
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });
async function api(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "put", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}
async function setup(request: APIRequestContext, backend: E2EBackend, agent = "claude-code") {
  const dir = await mkdtemp(path.join(tmpdir(), "foorch01-e2e-"));
  await api(request, backend, "post", "/projects", { path: dir, name: "Router" });
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Router", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, backend, "post", "/tasks", {
    title: "Route this", prompt: "inspect", isolation: "none", workdir: dir, agent, model: agent === "codex" ? "gpt-6.1-sol" : "opus-5.5", mode: "auto", column: "ready",
  });
  await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
  return { dir, task };
}
async function openSection(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Route this" }).click();
  const section = page.getByTestId("employee-execution");
  await expect(section).toBeVisible();
  await section.locator("summary").click();
  return section;
}
const runsFor = (request: APIRequestContext, backend: E2EBackend, taskId: string) => api(request, backend, "get", `/tasks/${taskId}/runs`);
const attemptsFor = async (request: APIRequestContext, backend: E2EBackend, taskId: string) =>
  (await api(request, backend, "get", `/employee-execution/attempts?taskId=${taskId}`)).attempts as any[];

test("suggestions are grouped and honest, choosing one only fills the form, and nothing starts", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  await openSection(page, backend);

  await page.getByTestId("executor-suggest").click();
  const groups = page.getByTestId("executor-groups");
  await expect(groups).toBeVisible();
  // No verified evidence exists on a fresh machine: the automatic router chooses nothing.
  await expect(page.getByTestId("executor-no-verified")).toBeVisible();
  await expect(groups).toHaveAttribute("data-automatic", "none");
  await expect(page.getByTestId("executor-group-verified-eligible")).toContainText("None");
  const potential = page.getByTestId("executor-group-potential-unknown").getByTestId("executor-option");
  await expect(potential.first()).toBeVisible();
  await expect(potential.first().getByTestId("executor-availability")).toContainText("Unknown");
  await expect(potential.first().getByTestId("executor-limitations")).toBeVisible();
  await expect(potential.first()).toContainText("Owner review and confirmation required");
  await expect(page.getByTestId("executor-suggestions")).not.toContainText(/\bReady\b|Verified available/);

  // Pick a potential executor by hand: it fills the harness select only.
  const target = page.locator('[data-testid="executor-option"][data-class="potential-unknown"]').first();
  const harnessId = await target.getAttribute("data-harness");
  await target.getByTestId("executor-use").click();
  await expect(page.getByTestId("employee-execution-harness")).toHaveValue(harnessId!);
  expect(await runsFor(request, backend, task.id)).toEqual([]);
  expect(await attemptsFor(request, backend, task.id)).toEqual([]);
});

test("Owner preferences: a forbidden model is blocked in the list and cannot be waived by choosing it", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  await openSection(page, backend);
  await page.getByTestId("executor-prefs-toggle").click();
  await page.getByTestId("executor-prefs-forbidden").fill("opus-5.5");
  await page.getByTestId("executor-prefs-save").click();
  await expect(page.getByTestId("executor-prefs-status")).toContainText("Preferences saved");

  await page.getByTestId("executor-suggest").click();
  const blocked = page.locator('[data-testid="executor-option"][data-class="blocked"][data-model="opus-5.5"]');
  await expect(blocked.first()).toBeVisible();
  await expect(blocked.first().locator('[data-code="owner-model-forbidden"]')).toBeVisible();
  await expect(blocked.first().getByTestId("executor-use")).toHaveCount(0);

  // Choosing the harness by hand still cannot waive the preference.
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("opus-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "blocked");
  await expect(page.getByTestId("employee-execution-errors").locator('[data-code="owner-model-forbidden"]')).toBeVisible();
  await expect(page.getByTestId("employee-execution-run")).toHaveCount(0);
  expect(await runsFor(request, backend, task.id)).toEqual([]);
});

test("Owner Review states separate sandbox, approval and sandbox network policies", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend, "codex");
  // Codex ships disabled; the Owner enables it in Settings.
  const enabled = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: headers(backend), data: { enabled: true } });
  expect(enabled.status()).toBe(200);
  await openSection(page, backend);
  await page.getByTestId("employee-execution-harness").selectOption("codex");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog).toBeVisible();
  const permissions = page.getByTestId("employee-run-permissions");
  const disclosure = permissions.getByTestId("permission-disclosure");
  await expect(disclosure).toBeVisible();
  // Not a git repository here: the workspace sandbox applies, not full access.
  await expect(disclosure).toHaveAttribute("data-sandbox", "workspace-write");
  await expect(disclosure).toContainText("Workspace-write sandbox");
  await expect(disclosure).toContainText("Network policy: disabled for sandboxed commands");
  await expect(disclosure).toContainText("Provider and control-plane traffic is separate");
  await expect(permissions).not.toContainText("without asking, with your user's permissions");
  // Nothing started by reviewing.
  expect(await runsFor(request, backend, task.id)).toEqual([]);
  await page.getByTestId("employee-run-cancel").click();
  await expect(dialog).toHaveCount(0);
});

test("full access has a separate unchecked Owner gate before the fake run", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend, "codex");
  expect((await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: headers(backend), data: { enabled: true } })).status()).toBe(200);
  expect((await request.patch(`${backend.apiBase}/tasks/${task.id}`, { headers: headers(backend), data: { mode: "full-access" } })).status()).toBe(200);
  await openSection(page, backend);
  await page.getByTestId("employee-execution-harness").selectOption("codex");
  await page.getByTestId("employee-execution-prepare").click();
  await page.getByTestId("employee-execution-run").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog.getByTestId("permission-disclosure")).toHaveAttribute("data-sandbox", "danger-full-access");
  const consent = page.getByTestId("employee-run-full-access").getByRole("checkbox");
  await expect(consent).not.toBeChecked();
  await expect(page.getByTestId("employee-run-confirm")).toBeDisabled();
  expect(await runsFor(request, backend, task.id)).toEqual([]);
  await consent.check();
  await expect(page.getByTestId("employee-run-confirm")).toBeEnabled();
  await page.getByTestId("employee-run-confirm").click();
  await expect(dialog).toHaveCount(0);
  expect(await runsFor(request, backend, task.id)).toHaveLength(1);
});
