import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, queryBackendScalar } from "./helpers";

/**
 * FO-010C + FO-011D cross-feature acceptance. One isolated backend holds
 * projects, a cluster, employees, tasks and a declared infrastructure
 * resource at the same time. Assigning a task is an organizational record: it
 * must not start a run, ask the model router for anything, or change the task.
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api<T = any>(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, expected = 200): Promise<T> {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return (text ? JSON.parse(text) : null) as T;
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo010c-int-${name.replace(/\W+/g, "-")}-`));
  await api(request, backend, "post", "/projects", { path: dir, name });
  return dir;
}

const task = (request: APIRequestContext, backend: E2EBackend, title: string, workdir: string) =>
  api(request, backend, "post", "/tasks", {
    title,
    prompt: "organizational fixture, never run",
    isolation: "none",
    workdir,
    agent: "claude-code",
    taskType: "bug",
    model: "opus",
    mode: "auto",
  });

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

const count = (backend: E2EBackend, sql: string) => queryBackendScalar(backend, sql);

test("Company → Employee → Assigned Task → Project → Cluster → Infrastructure, without starting anything", async ({ page, request, freshBackend: backend }) => {
  const writes: string[] = [];
  page.on("request", (req) => {
    const method = req.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const url = new URL(req.url());
    if (url.pathname === "/preferences" || url.pathname.startsWith("/preferences/")) return;
    writes.push(`${method} ${url.pathname}`);
  });

  const alpha = await registerProject(request, backend, "Alpha Assign");
  const beta = await registerProject(request, backend, "Beta Assign");
  const forge = (await api(request, backend, "post", "/clusters", { name: "Forge Assign" }, 201)).id as string;
  await api(request, backend, "post", `/clusters/${forge}/projects`, { projectPath: alpha }, 201);
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Chain", jobTitle: "QA Engineer", projectPath: alpha }, 201);
  const bea = await api(request, backend, "post", "/employees", { name: "Bea Chain", jobTitle: "QA Engineer", projectPath: alpha }, 201);
  const own = await task(request, backend, "Chain task", alpha);
  const foreign = await task(request, backend, "Beta only task", beta);
  const host = await api(request, backend, "post", "/infrastructure/resources", {
    name: "Chain fixture host",
    resourceType: "vps",
    hostname: "chain.fixture.invalid",
    status: "unknown",
  }, 201);
  await api(request, backend, "post", `/infrastructure/resources/${host.id}/clusters`, { clusterId: forge }, 201);

  const runsBefore = count(backend, "SELECT COUNT(*) AS n FROM runs");
  expect(runsBefore).toBe(0);

  // Company → Staff → Employee → assign.
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-row").filter({ hasText: "Ada Chain" }).click();
  await expect(page.getByTestId("assigned-tasks-empty")).toBeVisible();
  const picker = page.getByTestId("assigned-task-pick");
  await expect(picker.locator("option", { hasText: "Beta only task" })).toHaveCount(0);
  await picker.selectOption({ label: "Chain task" });
  await page.getByTestId("assigned-task-assign").click();
  const row = page.getByTestId("assigned-task-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("assigned-task-title")).toHaveText("Chain task");

  // Assigned task → Kanban task details → back to the same employee card.
  await row.getByTestId("assigned-task-open").click();
  await expect(page.locator("aside").getByText("Chain task")).toBeVisible();
  await page.getByRole("button", { name: "Close task details" }).click();
  await expect(page.getByTestId("employee-card")).toHaveAttribute("data-employee-id", ada.id);

  // Employee → Project → Cluster → Infrastructure.
  await page.getByTestId("employee-open-project").click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
  await page.getByTestId("project-page-team").click();
  await expect(page.getByTestId("project-team").getByTestId("project-team-employee")).toHaveCount(2);
  await page.getByTestId("project-header-details-toggle").click();
  await page.getByTestId("project-cluster-link").click();
  await expect(page.getByTestId("cluster-dashboard-name")).toHaveText("Forge Assign");
  await page.getByTestId("cluster-tab-infrastructure").click();
  const card = page.getByTestId("resource-card").filter({ hasText: "Chain fixture host" });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("resource-status")).toHaveAttribute("data-status", "unknown");
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("Online");

  // Back to Company → the assignment is where we left it.
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-row").filter({ hasText: "Ada Chain" }).click();
  await expect(page.getByTestId("assigned-task-row")).toHaveCount(1);

  // A stale screen gets a sentence, not a silent overwrite: Bea takes the task through the API first.
  const current = await api(request, backend, "get", `/task-assignments?employeeId=${ada.id}`);
  const revision = current.assignments[0].revision as number;
  await api(request, backend, "post", "/task-assignments/reassign", { taskId: own.id, employeeId: bea.id, expectedRevision: revision });
  await page.getByTestId("assigned-task-unassign").click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Unassign this task?" });
  await dialog.getByRole("button", { name: "Unassign" }).click();
  await expect(page.getByTestId("assigned-tasks-error").or(page.getByTestId("assigned-tasks-status"))).toBeVisible();
  const afterStale = await api(request, backend, "get", `/task-assignments/project?projectPath=${encodeURIComponent(alpha)}`);
  expect(afterStale.assignments).toHaveLength(1);
  expect(afterStale.assignments[0].employeeId).toBe(bea.id);

  // A cluster move and an archive-refusal keep the record intact.
  const other = (await api(request, backend, "post", "/clusters", { name: "Other Assign" }, 201)).id as string;
  await api(request, backend, "post", `/clusters/${other}/projects/move`, { projectPath: alpha }, 200);
  const moved = await api(request, backend, "get", `/task-assignments/project?projectPath=${encodeURIComponent(alpha)}`);
  expect(moved.assignments.map((a: any) => [a.taskId, a.employeeId])).toEqual([[own.id, bea.id]]);
  await api(request, backend, "delete", `/employees/${bea.id}`, undefined, 409);
  await api(request, backend, "post", "/task-assignments", { taskId: foreign.id, employeeId: bea.id }, 409);

  // Light/dark and four widths on the surfaces the chain touched.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await noOverflow(page), `${scheme} ${width}`).toBe(true);
    }
  }

  // Nothing above started a run, changed the task, or touched the router.
  expect(count(backend, "SELECT COUNT(*) AS n FROM runs")).toBe(0);
  expect(count(backend, `SELECT COUNT(*) AS n FROM tasks WHERE "column" != 'backlog'`)).toBe(0);
  expect(count(backend, "SELECT COUNT(*) AS n FROM employee_task_assignment_events")).toBe(2); // assigned + reassigned; the stale unassign wrote nothing
  expect(writes.filter((line) => /\/start|model-router|account-core/.test(line))).toEqual([]);
});

test("empty and unregistered states stay honest", async ({ page, request, freshBackend: backend }) => {
  const ada = await api(request, backend, "post", "/employees", { name: "Free Agent", jobTitle: "QA Engineer" }, 201);
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-row").filter({ hasText: "Free Agent" }).click();
  await expect(page.getByTestId("employee-card")).toHaveAttribute("data-employee-id", ada.id);
  await expect(page.getByTestId("assigned-tasks-needs-project")).toBeVisible();
  await api(request, backend, "post", "/task-assignments", { taskId: "00000000-0000-4000-8000-000000000000", employeeId: ada.id }, 404);
  expect(count(backend, "SELECT COUNT(*) AS n FROM employee_task_assignments")).toBe(0);
});
