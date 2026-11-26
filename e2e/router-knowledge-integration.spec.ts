import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, queryBackendScalar, openAllTasks } from "./helpers";

/**
 * Cross-feature acceptance: Employee assignment (FO-010C), model-router preview
 * (FO-009E) and the owner's one-message knowledge grant (FO-011E) next to each
 * other. The three are separate permissions: assigning a person, previewing a
 * resource and handing a note to a manager never start a run, and a preview
 * never spends a grant. Fake codex driver, own SQLite/HOME, no real CLI.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "300",
  },
});

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function call(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "patch", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: auth(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

const grantsFor = async (request: APIRequestContext, backend: E2EBackend, dir: string): Promise<any[]> =>
  (await call(request, backend, "get", `/knowledge/context/transmissions?managerKind=project&projectPath=${encodeURIComponent(dir)}`)).transmissions;

async function readTask(page: Page, title: string): Promise<void> {
  await openAllTasks(page);
  await page.getByRole("button", { name: title }).click();
  await expect(page.getByTestId("ai-resource-recommendation")).toBeVisible();
}

test("assigned task: router preview and knowledge grant stay independent and start nothing", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const dir = await mkdtemp(path.join(tmpdir(), "fo009e-integration-"));
  await call(request, backend, "post", "/projects", { path: dir, name: "Integration" });
  await call(request, backend, "patch", "/harnesses/codex", { enabled: true });

  const worker = await call(request, backend, "post", "/employees", { name: "Ada Worker", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await call(request, backend, "post", "/tasks", {
    title: "Router integration task",
    prompt: "Preview only.",
    isolation: "none",
    workdir: dir,
    column: "backlog",
  });
  await call(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: worker.id }, 201);

  const note = await call(request, backend, "post", "/knowledge/documents", {
    ownerKind: "project", ownerId: dir, title: "Integration notes", content: "Prefer small steps.", sensitive: false,
  }, 201);
  const note2 = await call(request, backend, "post", "/knowledge/documents", {
    ownerKind: "project", ownerId: dir, title: "Second notes", content: "Keep logs short.", sensitive: false,
  }, 201);

  const snapshot = async () => ({
    task: await call(request, backend, "get", `/tasks/${task.id}`),
    employee: await call(request, backend, "get", `/employees/${worker.id}`),
    assignment: await call(request, backend, "get", `/task-assignments/task?taskId=${task.id}`),
  });
  const before = await snapshot();
  const routerLaunches: string[] = [];
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const p = new URL(req.url()).pathname;
    posts.push(p);
    if (/\/start|usage\/refresh|quota-refresh|open-terminal|switch/.test(p)) routerLaunches.push(p);
  });
  const grantPosts = () => posts.filter((p) => p === "/knowledge/context/grants").length;

  // 1. Task Details: router preview with the assigned worker shown, no start.
  await gotoApp(page, backend.bootBase);
  await readTask(page, "Router integration task");
  const section = page.getByTestId("ai-resource-recommendation");
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-employee")).toContainText("Ada Worker");
  await expect(section.getByTestId("router-employee")).toContainText("Assignment revision");
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-result")).toBeVisible();
  // No verified evidence in a fresh isolated core: nothing may read as verified.
  await expect(section.getByTestId("router-verified")).toHaveCount(0);
  await expect(section.getByRole("button", { name: /start|launch|switch account/i })).toHaveCount(0);

  const afterPreview = await snapshot();
  expect(afterPreview.task).toEqual(before.task);
  expect(afterPreview.employee).toEqual(before.employee);
  expect(afterPreview.assignment).toEqual(before.assignment);
  // The employee still has no resource binding; the recommendation is not stored on it.
  expect(afterPreview.employee.runtimeBinding.status).toBe("none");
  expect(afterPreview.employee.id).toBe(worker.id);
  expect(afterPreview.assignment.assignment.revision).toBe(before.assignment.assignment.revision);
  expect(queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM runs")).toBe(0);

  // 2. Project Manager: confirm a one-message grant; the manager turn is a fake driver.
  await page.getByRole("button", { name: "Close task details" }).click();
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");

  await page.getByTestId("manager-knowledge-toggle").click();
  const row = page.getByTestId("manager-knowledge").getByTestId("manager-knowledge-row").filter({ hasText: "Integration notes" });
  await row.getByTestId("manager-knowledge-check").check();
  await page.getByTestId("manager-knowledge-preview-button").click();
  await expect(page.getByTestId("manager-knowledge-preview")).toContainText("rev 1");
  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toContainText("1 note approved");
  expect(await grantsFor(request, backend, dir)).toMatchObject([{ status: "approved" }]);

  await page.getByTestId("manager-composer").fill("Summarize the plan.");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);
  const consumed = await grantsFor(request, backend, dir);
  expect(consumed).toHaveLength(1);
  expect(consumed[0]).toMatchObject({ status: "consumed" });
  expect(grantPosts()).toBe(1);

  // 3. A second approved grant stays untouched by a router preview.
  await page.getByTestId("manager-knowledge-toggle").click();
  await page.getByTestId("manager-knowledge").getByTestId("manager-knowledge-row").filter({ hasText: "Second notes" }).getByTestId("manager-knowledge-check").check();
  await page.getByTestId("manager-knowledge-preview-button").click();
  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toContainText("1 note approved");
  expect((await grantsFor(request, backend, dir)).map((g) => g.status).sort()).toEqual(["approved", "consumed"]);

  // A router preview from Task Details must not touch the pending grant.
  await openAllTasks(page);
  await page.getByRole("button", { name: "Router integration task" }).click();
  await expect(section).toBeVisible();
  if (!(await section.evaluate((node) => (node as HTMLDetailsElement).open))) await section.locator("> summary").click();
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-result")).toBeVisible();

  expect((await grantsFor(request, backend, dir)).map((g) => g.status).sort()).toEqual(["approved", "consumed"]);
  expect(grantPosts()).toBe(2);
  expect(await snapshot()).toEqual(before);

  // 4. Nothing ran anywhere.
  expect(routerLaunches).toEqual([]);
  expect(queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM runs")).toBe(0);
  expect(note.id).not.toBe(note2.id);
});
