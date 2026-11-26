import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, queryBackendScalar, openWorkspaces } from "./helpers";

/**
 * FO-011D cross-feature acceptance. One isolated backend holds employees, two
 * registered projects, two clusters, project knowledge and one infrastructure
 * resource at the same time. Nothing here starts an agent: the fake drivers and
 * stubbed binaries come from the fixture, and every record is a declaration.
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api<T = any>(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, expected = 200): Promise<T> {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  expect(res.status(), `${method} ${route}: ${await res.text()}`).toBe(expected);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo011d-int-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${backend.apiBase}/projects`, { headers: headers(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

const count = (backend: E2EBackend, table: string) => queryBackendScalar(backend, `SELECT COUNT(*) AS n FROM ${table}`);

test("employees, projects, clusters, knowledge and infrastructure coexist and navigate", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Int");
  const beta = await registerProject(request, backend, "Beta Int");
  const forge = (await api(request, backend, "post", "/clusters", { name: "Forge Int" }, 201)).id as string;
  const other = (await api(request, backend, "post", "/clusters", { name: "Other Int" }, 201)).id as string;
  await api(request, backend, "post", `/clusters/${forge}/projects`, { projectPath: alpha }, 201);

  await api(request, backend, "put", "/employees/head", { name: "Ilse" }, 201);
  const manager = (await api(request, backend, "post", "/employees/project-managers", { projectPath: alpha, name: "Robin" }, 201)).employee;
  const worker = await api(request, backend, "post", "/employees", { name: "Ada", jobTitle: "QA Engineer", projectPath: alpha }, 201);

  const note = await api(request, backend, "post", "/knowledge/documents", {
    ownerKind: "project",
    ownerId: alpha,
    title: "Alpha runbook",
    category: "deployment",
    content: "declared only",
  }, 201);

  // One VPS-like declaration shared by two clusters, one project, two environments.
  const resource = await api(request, backend, "post", "/infrastructure/resources", {
    name: "Shared fixture host",
    resourceType: "vps",
    provider: "Fixture",
    hostname: "shared.fixture.invalid",
    status: "unknown",
  }, 201);
  await api(request, backend, "post", `/infrastructure/resources/${resource.id}/clusters`, { clusterId: forge }, 201);
  await api(request, backend, "post", `/infrastructure/resources/${resource.id}/clusters`, { clusterId: other }, 201);
  await api(request, backend, "post", `/infrastructure/resources/${resource.id}/projects`, { projectPath: alpha }, 201);
  const second = await api(request, backend, "post", "/infrastructure/resources", { name: "Alpha domain", resourceType: "domain", hostname: "alpha.fixture.invalid" }, 201);
  await api(request, backend, "post", `/infrastructure/resources/${second.id}/projects`, { projectPath: alpha }, 201);

  // Declaring infrastructure creates no run-time or environment records.
  const tasksBefore = count(backend, "tasks");
  const runsBefore = count(backend, "runs");
  expect(count(backend, "environment_profiles")).toBe(0);
  expect(count(backend, "infrastructure_resources")).toBe(2);
  expect(resource.status).toBe("unknown");
  expect(resource.verification).toBe("absent");

  // Company → Project → Team → Employee.
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
  await page.getByTestId("company-tab-staff").click();
  await expect(page.getByTestId("staff-row")).toHaveCount(3);
  await page.getByTestId("project-nav-item").filter({ hasText: "Alpha Int" }).click();
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
  await page.getByTestId("project-page-team").click();
  const team = page.getByTestId("project-team");
  await expect(team.getByTestId("project-team-manager")).toContainText("Robin");
  await team.getByTestId("project-team-employee").click();
  await expect(page.getByTestId("employee-card")).toHaveAttribute("data-employee-id", worker.id);
  await expect(page.getByTestId("employee-runtime-binding")).toBeVisible();

  // Clusters → Cluster → Infrastructure (declared, unverified, shared).
  await openWorkspaces(page);
  await page.getByTestId("cluster-card").filter({ hasText: "Forge Int" }).getByTestId("cluster-open").click();
  await page.getByTestId("cluster-tab-infrastructure").click();
  await expect(page.getByTestId("cluster-infrastructure-status")).toContainText("Not verified");
  const shared = page.getByTestId("resource-card").filter({ hasText: "Shared fixture host" });
  await expect(shared).toHaveCount(1);
  await expect(shared.getByTestId("resource-status")).toHaveAttribute("data-status", "unknown");
  await expect(shared.getByTestId("resource-cluster-chip")).toHaveCount(2);
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("Online");

  // Cluster → Project → Knowledge.
  await page.getByTestId("cluster-tab-projects").click();
  await page.getByTestId("cluster-project").filter({ hasText: "Alpha Int" }).getByTestId("cluster-open-overview").click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
  await page.getByTestId("project-page-team").click();
  await expect(page.getByTestId("project-team").getByTestId("project-team-manager")).toContainText("Robin");

  // Clusters → Global Infrastructure Inventory, and back to the directory.
  await openWorkspaces(page);
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-infrastructure").click();
  await expect(page.getByTestId("infrastructure-inventory")).toBeVisible();
  await expect(page.getByTestId("resource-card")).toHaveCount(2);
  await page.getByTestId("infrastructure-back").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();

  // The Company page and Staff directory still open after the inventory was used.
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
  await expect(page.getByTestId("company-head-name")).toContainText("Ilse");

  // Moving the project to another cluster changes membership only.
  const employeesBefore = await api(request, backend, "get", `/employees?projectPath=${encodeURIComponent(alpha)}`);
  await api(request, backend, "post", `/clusters/${other}/projects/move`, { projectPath: alpha }, 200);
  const employeesAfter = await api(request, backend, "get", `/employees?projectPath=${encodeURIComponent(alpha)}`);
  expect(employeesAfter.employees.map((e: any) => [e.id, e.name, e.projectPath])).toEqual(
    employeesBefore.employees.map((e: any) => [e.id, e.name, e.projectPath]),
  );
  const notes = await api(request, backend, "get", `/knowledge/documents?ownerKind=project&ownerId=${encodeURIComponent(alpha)}`);
  expect(notes.documents.map((d: any) => d.id)).toEqual([note.id]);
  const moved = await api(request, backend, "get", `/infrastructure/resources/${resource.id}`);
  expect(moved.projects.map((p: any) => p.path ?? p.projectPath)).toEqual([alpha]);
  expect(moved.clusters).toHaveLength(2);

  // Archiving a resource never removes a project, an employee, or a note.
  await api(request, backend, "post", `/infrastructure/resources/${resource.id}/archive`, undefined, 200);
  const projects = await api(request, backend, "get", "/projects");
  expect(JSON.stringify(projects)).toContain(alpha);
  expect(JSON.stringify(projects)).toContain(beta);
  expect(count(backend, "ai_employees")).toBe(3);
  expect(count(backend, "knowledge_documents")).toBe(1);
  await api(request, backend, "post", `/infrastructure/resources/${resource.id}/restore`, undefined, 200);

  // An employee is an identity: no field points at a harness, account, or model.
  const detail = await api(request, backend, "get", `/employees/${worker.id}`);
  const keys = Object.keys(detail).join(" ").toLowerCase();
  expect(keys).not.toMatch(/harness|account|model|agentprofile/);

  // Nothing above started a run or created an environment profile.
  expect(count(backend, "tasks")).toBe(tasksBefore);
  expect(count(backend, "runs")).toBe(runsBefore);
  expect(count(backend, "environment_profiles")).toBe(0);

  // Light and dark, four widths, on the surfaces that share the sidebar.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await noOverflow(page), `${scheme} ${width}`).toBe(true);
    }
  }
});

test("empty states stay honest", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openWorkspaces(page);
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-infrastructure").click();
  await expect(page.getByTestId("infrastructure-empty")).toBeVisible();
  await expect(page.getByTestId("infrastructure-inventory")).not.toContainText("Online");
  await page.getByTestId("infrastructure-back").click();
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-head-empty")).toHaveText("Not appointed");
  await page.getByTestId("company-tab-staff").click();
  await expect(page.getByTestId("staff-empty")).toBeVisible();
});
