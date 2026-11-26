import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openWorkspaces, openPortfolio } from "./helpers";

/**
 * FO-010B Company page. Every test owns a fresh headless backend with its own
 * HOME and SQLite, stubbed CLIs, and fake drivers. Nothing here starts an
 * agent, and the mutating-request guard below fails any test that makes a
 * write outside /employees (plus the cluster and project setup it does itself
 * through the API, not the page).
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo010b-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${backend.apiBase}/projects`, { headers: headers(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function api<T = any>(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, expected = 200): Promise<T> {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  expect(res.status(), `${method} ${route}: ${await res.text()}`).toBe(expected);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function openCompany(page: Page): Promise<void> {
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
}

/** Collects every non-GET request the page itself makes. */
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const url = new URL(request.url());
    if (url.pathname === "/preferences" || url.pathname.startsWith("/preferences/")) return;
    writes.push(`${method} ${url.pathname}`);
  });
  return writes;
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

test("an empty organization, the owner, keyboard entry, themes, and four viewports", async ({ page, freshBackend: backend }) => {
  const writes = watchWrites(page);
  await gotoApp(page, backend.bootBase);
  const nav = page.getByTestId("workspace-company");
  await nav.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("company-page")).toBeVisible();
  await expect(page.getByTestId("company-name")).toHaveText("ForgeOrbit");
  await expect(page.getByTestId("company-owner")).toContainText("Owner / CEO");
  await expect(page.getByTestId("company-owner-note")).toContainText("not an AI account");
  await expect(page.getByTestId("company-head-empty")).toHaveText("Not appointed");
  await expect(page.getByTestId("company-identity-note")).toContainText("not a measure of work done");
  for (const id of ["managers", "workers", "active", "paused", "archived", "with-manager", "without-manager", "unassigned", "detached", "projects"]) {
    await expect(page.getByTestId(`company-metric-${id}-value`)).toHaveText("0");
  }
  await expect(page.getByTestId("company-structure-empty")).toBeVisible();

  await page.getByTestId("company-tab-chart").click();
  await expect(page.getByTestId("org-chart-node")).toHaveCount(2);
  await expect(page.locator('[data-kind="missing-head"]')).toContainText("Head not appointed");
  await page.getByTestId("company-tab-staff").click();
  await expect(page.getByTestId("staff-empty")).toBeVisible();

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await expect(page.getByTestId("company-page")).toBeVisible();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(false);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId("company-page").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    expect(await noOverflow(page)).toBe(true);
  }
  expect(writes).toEqual([]);
});

test("the owner appoints and renames the Head, and the Head stays the Head", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await page.getByTestId("company-appoint-head").click();
  const dialog = page.getByRole("dialog");
  await expect(page.getByTestId("head-name")).toBeFocused();
  await expect(dialog).toContainText("It is not generated");
  await page.getByTestId("head-name").fill("   ");
  await page.getByTestId("head-save").click();
  await expect(page.getByTestId("head-form-error")).toContainText("not generated");
  expect((await api(request, backend, "get", "/employees/head")).head).toBeNull();
  await page.getByTestId("head-name").fill("Ilse Marek");
  await page.getByTestId("head-description").fill("Runs the portfolio");
  await page.getByTestId("head-save").click();
  await expect(page.getByTestId("company-head-name")).toHaveText("Ilse Marek");
  await expect(page.getByTestId("company-head-description")).toHaveText("Runs the portfolio");

  const before = (await api(request, backend, "get", "/employees/head")).head;
  expect(before).toMatchObject({ kind: "head", nameSource: "owner" });
  await page.getByTestId("company-head-edit").click();
  await page.getByTestId("head-name").fill("Ilse M.");
  await page.getByTestId("head-save").click();
  await expect(page.getByTestId("company-head-name")).toHaveText("Ilse M.");
  const after = (await api(request, backend, "get", "/employees/head")).head;
  expect(after.id).toBe(before.id);

  await page.getByTestId("company-head-open").click();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Ilse M.");
  await expect(page.getByTestId("employee-regenerate")).toHaveCount(0);
  await expect(page.getByTestId("head-name-note")).toContainText("never generated");
  await expect(page.getByTestId("employee-assign-section")).toHaveCount(0);
  await expect(page.getByTestId("employee-reports-to")).toContainText("Owner / CEO");
  await expect(page.getByTestId("employee-detail-role")).toContainText("Leadership");
  // The edit dialog for a Head has no job-title or role fields.
  await page.getByTestId("head-edit").click();
  await expect(page.getByTestId("employee-job-title")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await api(request, backend, "patch", `/employees/${before.id}`, { kind: "worker" }, 400);
  await api(request, backend, "patch", `/employees/${before.id}`, { projectPath: "/x" }, 400);
});

test("existing managers get identities only when the owner asks, and asking twice adds nothing", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Team");
  const beta = await registerProject(request, backend, "Beta Team");
  await registerProject(request, backend, "Gamma Team");
  for (const dir of [alpha, beta]) await api(request, backend, "put", "/project-manager/config", { path: dir, config: {} });
  const stateBefore = await Promise.all([alpha, beta].map((dir) => api(request, backend, "get", `/project-manager?path=${encodeURIComponent(dir)}`)));
  const writes = watchWrites(page);

  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await expect(page.getByTestId("manager-identities-count")).toContainText("2 projects have a configured manager without an identity");
  await expect(page.getByTestId("manager-identities-explain")).toContainText("only identity records");
  expect((await api(request, backend, "get", "/employees")).employees).toEqual([]);

  await page.getByTestId("initialize-managers").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 projects");
  await expect(dialog).toContainText("identity records");
  await expect(dialog).toContainText("no AI process starts");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await api(request, backend, "get", "/employees")).employees).toEqual([]);

  await page.getByTestId("initialize-managers").click();
  await page.getByRole("dialog").getByRole("button", { name: "Create identities" }).click();
  await expect(page.getByTestId("manager-identities-status")).toContainText("Created 2 identities");
  await expect(page.getByTestId("company-metric-managers-value")).toHaveText("2");
  await expect(page.getByTestId("company-metric-with-manager-value")).toHaveText("2");
  await expect(page.getByTestId("company-metric-without-manager-value")).toHaveText("1");
  const created = (await api(request, backend, "get", "/employees")).employees as { id: string; name: string }[];
  expect(created).toHaveLength(2);

  await page.getByTestId("initialize-managers").click();
  await page.getByRole("dialog").getByRole("button", { name: "Create identities" }).click();
  await expect(page.getByTestId("manager-identities-status")).toContainText("No new identities. 2 already had one.");
  const again = (await api(request, backend, "get", "/employees")).employees as { id: string; name: string }[];
  expect(again.map((e) => [e.id, e.name]).sort()).toEqual(created.map((e) => [e.id, e.name]).sort());

  const stateAfter = await Promise.all([alpha, beta].map((dir) => api(request, backend, "get", `/project-manager?path=${encodeURIComponent(dir)}`)));
  expect(stateAfter).toEqual(stateBefore);

  // Gamma has no manager. The identity is created only from its own button.
  const gamma = page.getByTestId("company-project-row").filter({ hasText: "Gamma Team" });
  await expect(gamma.getByTestId("company-project-no-manager")).toBeVisible();
  await gamma.getByTestId("company-ensure-manager").click();
  await expect(page.getByRole("dialog")).toContainText("random name is drawn once");
  await page.getByRole("dialog").getByRole("button", { name: "Create identity" }).click();
  await expect(gamma.getByTestId("company-project-manager")).toBeVisible();

  expect(writes.every((entry) => /^(POST|PUT) \/employees(\/|$)/.test(entry))).toBe(true);
  expect(writes.filter((entry) => entry.includes("initialize-existing"))).toHaveLength(2);
});

test("worker lifecycle: create, persistent name, rename, regenerate, edit, assign, archive, history", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Lab");
  await registerProject(request, backend, "Beta Lab");
  const writes = watchWrites(page);
  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-create").click();
  await expect(page.getByTestId("employee-name")).toBeFocused();
  await expect(page.getByRole("dialog")).toContainText("does not start an AI process");
  await page.getByTestId("employee-job-title").fill("Senior Backend Engineer");
  await page.getByTestId("employee-specializations").fill("APIs, SQL, apis");
  await page.getByTestId("employee-project").selectOption({ label: "Alpha Lab" });
  await page.getByTestId("employee-save").click();

  const card = page.getByTestId("employee-card");
  await expect(card).toBeVisible();
  const id = (await card.getAttribute("data-employee-id"))!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const drawn = (await page.getByTestId("employee-card-name").textContent())!.trim();
  expect(drawn.length).toBeGreaterThan(0);
  await expect(page.getByTestId("employee-card-title")).toHaveText("Senior Backend Engineer");
  await expect(page.getByTestId("employee-detail-specializations")).toContainText("APIs, SQL");
  await expect(page.getByTestId("employee-detail-name-source")).toContainText("Randomly generated");
  await expect(page.getByTestId("employee-detail-project")).toContainText("Alpha Lab");
  await expect(page.getByTestId("employee-detail-created")).not.toContainText("Unknown");
  await expect(page.getByTestId("employee-runtime-binding")).toContainText("None.");
  await expect(page.getByTestId("employee-reports-to")).toContainText("Head not appointed");
  await expect(page.getByTestId("employee-reports-to")).toContainText("No Project Manager");

  // The name is stored: a reload and a second page load show the same one.
  await page.reload();
  await expect(page.getByTestId("company-page")).toBeVisible();
  await page.getByTestId("company-tab-staff").click();
  await expect(page.getByTestId("staff-row").first()).toContainText(drawn);
  expect((await api(request, backend, "get", `/employees/${id}`)).name).toBe(drawn);

  await page.getByTestId("staff-row").first().click();
  await page.getByTestId("employee-card-rename").fill("Ada");
  await page.getByTestId("employee-card-rename-save").click();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Ada");
  await expect(page.getByTestId("employee-card")).toHaveAttribute("data-employee-id", id);
  await expect(page.getByTestId("employee-detail-name-source")).toContainText("Set by the owner");

  await page.getByTestId("employee-regenerate").click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("id, and their history stay the same");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Ada");
  await page.getByTestId("employee-regenerate").click();
  await page.getByRole("dialog").getByRole("button", { name: "Draw a new name" }).click();
  await expect(page.getByTestId("employee-card-name")).not.toHaveText("Ada");
  await expect(page.getByTestId("employee-detail-name-source")).toContainText("Randomly generated");

  await page.getByTestId("employee-edit").click();
  await page.getByTestId("employee-job-title").fill("Staff Engineer");
  await page.getByTestId("employee-specializations").fill("APIs");
  await page.getByTestId("employee-department").fill("Platform");
  await page.getByTestId("employee-description").fill("Owns the API layer");
  await page.getByTestId("employee-save").click();
  await expect(page.getByTestId("employee-card-title")).toHaveText("Staff Engineer");
  await expect(page.getByTestId("employee-detail-department")).toContainText("Platform");
  await expect(page.getByTestId("employee-detail-description")).toContainText("Owns the API layer");

  await page.getByTestId("employee-assign-project").selectOption({ label: "Beta Lab" });
  await page.getByTestId("employee-assign").click();
  await expect(page.getByRole("dialog")).toContainText("Their history is kept");
  await page.getByRole("dialog").getByRole("button", { name: "Move" }).click();
  await expect(page.getByTestId("employee-detail-project")).toContainText("Beta Lab");
  await page.getByTestId("employee-unassign").click();
  await expect(page.getByRole("dialog")).toContainText("Nothing is started or stopped");
  await page.getByRole("dialog").getByRole("button", { name: "Unassign" }).click();
  await expect(page.getByTestId("employee-detail-project")).toContainText("No project");
  await expect(page.getByTestId("employee-location")).toContainText("No project");

  await page.getByTestId("employee-archive").click();
  await expect(page.getByRole("dialog")).toContainText("Nothing is deleted");
  await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("employee-card").getByTestId("employee-status")).toHaveText("Archived");
  await expect(page.getByTestId("employee-assign-section")).toHaveCount(0);
  await expect(page.getByTestId("employee-edit")).toHaveCount(0);

  await page.getByTestId("employee-card-back").click();
  await expect(page.getByTestId("staff-empty").or(page.getByTestId("staff-no-match"))).toBeVisible();
  await page.getByTestId("staff-filter-status").selectOption("archived");
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await page.getByTestId("staff-row").click();
  await page.getByTestId("employee-unarchive").click();
  await expect(page.getByTestId("employee-card").getByTestId("employee-status")).toHaveText("Active");

  const actions = await page.getByTestId("employee-history-event").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-action")));
  expect(actions.reverse()).toEqual(["create", "rename", "regenerate-name", "update", "reassign", "unassign", "archive", "unarchive"]);
  expect(await api(request, backend, "get", `/employees/${id}`)).toMatchObject({ id, projectPath: null, status: "active" });

  // The page only wrote to /employees. No task, run, or agent route was called.
  expect(writes.length).toBeGreaterThan(5);
  expect(writes.every((entry) => /^(POST|PATCH|DELETE) \/employees(\/|$)/.test(entry))).toBe(true);
  expect(writes.some((entry) => /tasks|runs|agent|harness|account|terminal|start/.test(entry.replace(/\/employees\/[0-9a-f-]+/g, "")))).toBe(false);
  void alpha;
});

test("the organization chart shows every branch, missing links, loose people, and follows cluster moves", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Chart");
  const beta = await registerProject(request, backend, "Beta Chart");
  const gamma = await registerProject(request, backend, "Gamma Chart");
  await api(request, backend, "put", "/employees/head", { name: "Ilse" }, 201);
  const manager = (await api(request, backend, "post", "/employees/project-managers", { projectPath: alpha, name: "Robin" }, 201)).employee;
  const worker = await api(request, backend, "post", "/employees", { name: "Ada", jobTitle: "QA Engineer", projectPath: alpha }, 201);
  await api(request, backend, "post", "/employees", { name: "Betty", jobTitle: "Technical Writer", projectPath: beta }, 201);
  await api(request, backend, "post", "/employees", { name: "Drifter", jobTitle: "Data Engineer" }, 201);
  await api(request, backend, "post", "/employees", { name: "Ghost", jobTitle: "DevOps Engineer", projectPath: gamma }, 201);
  const c1 = await api(request, backend, "post", "/clusters", { name: "North" }, 201);
  const c2 = await api(request, backend, "post", "/clusters", { name: "South" }, 201);
  await api(request, backend, "post", `/clusters/${c1.id}/projects`, { projectPath: alpha }, 201);
  await request.delete(`${backend.apiBase}/projects`, { headers: headers(backend), data: { path: gamma } });

  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await expect(page.getByTestId("company-metric-detached-value")).toHaveText("1");
  await expect(page.getByTestId("company-metric-unassigned-value")).toHaveText("1");
  await expect(page.getByTestId("company-metric-without-manager-value")).toHaveText("1");
  await page.getByTestId("company-tab-chart").click();
  const kinds = await page.getByTestId("org-chart-node").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-kind")));
  expect(kinds).toEqual(expect.arrayContaining(["owner", "head", "cluster", "project", "manager", "worker", "no-cluster", "missing-manager", "unassigned", "detached"]));
  await expect(page.getByTestId("org-chart-note")).toContainText("Clusters only group projects");
  await expect(page.locator('[data-kind="cluster"]').first()).toContainText("grouping only");
  await expect(page.locator('[data-kind="no-cluster"]')).toContainText("Projects without a cluster");
  await expect(page.locator('[data-kind="missing-manager"]')).toContainText("No Project Manager");
  await expect(page.locator('[data-kind="detached"]')).toContainText("Project no longer registered");
  await expect(page.locator('[data-kind="unassigned"]')).toContainText("Employees without a project");

  // Expand / collapse with the mouse and with the keyboard.
  const north = page.locator('[data-node-id="cluster:' + c1.id + '"]');
  const rows = page.getByTestId("org-chart-node");
  const open = await rows.count();
  await north.getByTestId("org-chart-toggle").click();
  expect(await rows.count()).toBeLessThan(open);
  await north.focus();
  await page.keyboard.press("ArrowRight");
  await expect(rows).toHaveCount(open);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(`[data-node-id="project:${alpha}"]`)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(`[data-node-id="project:${alpha}"]`)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  await expect(page.locator('[data-node-id="owner"]')).toBeFocused();
  await expect(page.getByRole("tree", { name: "Organization" })).toBeVisible();
  await page.getByTestId("org-chart-toggle-all").click();
  // The Owner stays open: Head, loose people, and detached people remain listed.
  await expect(rows).toHaveCount(4);
  await page.getByTestId("org-chart-toggle-all").click();
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(8);

  // Selecting a person opens their card.
  await page.locator(`[data-employee-id="${worker.id}"]`).getByTestId("org-chart-open").click();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Ada");
  await expect(page.getByTestId("employee-reports-to")).toContainText("Robin");
  await expect(page.getByTestId("employee-location")).toContainText("North");
  await page.getByTestId("path-manager").click();
  await expect(page.getByTestId("employee-card")).toHaveAttribute("data-employee-id", manager.id);

  // Moving the project to another cluster changes the picture, not the people.
  const before = (await api(request, backend, "get", "/employees")).employees.map((e: any) => [e.id, e.name, e.jobTitle, e.projectPath]);
  await api(request, backend, "post", `/clusters/${c2.id}/projects/move`, { projectPath: alpha });
  await page.getByTestId("company-refresh").click();
  await page.getByTestId("company-tab-chart").click();
  await expect(page.locator(`[data-node-id="cluster:${c2.id}"]`)).toContainText("1 project");
  await expect(page.locator(`[data-node-id="cluster:${c1.id}"]`)).toContainText("0 projects");
  const after = (await api(request, backend, "get", "/employees")).employees.map((e: any) => [e.id, e.name, e.jobTitle, e.projectPath]);
  expect(after).toEqual(before);
  await page.getByTestId("company-tab-dashboard").click();
  await expect(page.getByTestId("company-project-row").filter({ hasText: "Alpha Chart" })).toContainText("South");

  // Mobile: the same tree, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByTestId("company-tab-chart").click();
  expect(await noOverflow(page)).toBe(true);
  void beta;
});

test("staff search and filters, many people, and long names", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Staff");
  const beta = await registerProject(request, backend, "Beta Staff");
  const cluster = await api(request, backend, "post", "/clusters", { name: "Filter Cluster" }, 201);
  await api(request, backend, "post", `/clusters/${cluster.id}/projects`, { projectPath: alpha }, 201);
  const longName = "Bartholomew-Maximilian-".repeat(3).slice(0, 79);
  await api(request, backend, "post", "/employees", { name: longName, jobTitle: "Software Architect ".repeat(6).trim(), roleCategory: "architecture", projectPath: alpha, specializations: ["Systems"] }, 201);
  await api(request, backend, "post", "/employees", { name: "Quinn", jobTitle: "QA Engineer", roleCategory: "quality", projectPath: beta, specializations: ["Testing"] }, 201);
  await api(request, backend, "post", "/employees", { name: "Free", jobTitle: "Technical Writer", roleCategory: "documentation" }, 201);
  const gone = await api(request, backend, "post", "/employees", { name: "Gone", jobTitle: "QA Engineer", roleCategory: "quality" }, 201);
  await api(request, backend, "delete", `/employees/${gone.id}`);
  for (let i = 0; i < 110; i++) await api(request, backend, "post", "/employees", { name: `Bulk${String(i).padStart(3, "0")}`, jobTitle: "Frontend Engineer", roleCategory: "engineering", projectPath: beta }, 201);

  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await page.getByTestId("company-tab-staff").click();
  await expect(page.getByTestId("staff-count")).toContainText("Employees shown: 100 of 113 (114 on record)");
  await expect(page.getByTestId("staff-row")).toHaveCount(100);
  await page.getByTestId("staff-show-more").click();
  await expect(page.getByTestId("staff-row")).toHaveCount(113);

  await page.getByTestId("staff-search").fill("systems");
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await expect(page.getByTestId("staff-row")).toContainText("Bartholomew");
  await page.getByTestId("staff-search").fill("");
  await page.getByTestId("staff-filter-role").selectOption("quality");
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await page.getByTestId("staff-filter-status").selectOption("archived");
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await expect(page.getByTestId("staff-row")).toContainText("Gone");
  await page.getByTestId("staff-clear-filters").click();
  await page.getByTestId("staff-filter-cluster").selectOption(cluster.id);
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await page.getByTestId("staff-filter-cluster").selectOption({ label: "No cluster" });
  await expect(page.getByTestId("staff-count")).toContainText("Employees shown: 100 of 112 (114 on record)");
  await page.getByTestId("staff-clear-filters").click();
  await page.getByTestId("staff-filter-assignment").selectOption("unassigned");
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await expect(page.getByTestId("staff-row")).toContainText("Free");
  await page.getByTestId("staff-clear-filters").click();
  await page.getByTestId("staff-filter-specialization").selectOption("Testing");
  await expect(page.getByTestId("staff-row")).toContainText("Quinn");
  await page.getByTestId("staff-clear-filters").click();
  await page.getByTestId("staff-search").fill("no one has this");
  await expect(page.getByTestId("staff-no-match")).toBeVisible();

  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await noOverflow(page)).toBe(true);
  }
  await page.getByTestId("staff-clear-filters").click();
  await page.getByTestId("staff-search").fill("Bartholomew");
  await page.getByTestId("staff-row").click();
  await expect(page.getByTestId("employee-card-name")).toContainText("Bartholomew");
  expect(await noOverflow(page)).toBe(true);
});

test("the project overview links to the team and back, without changing identities", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Link");
  const manager = (await api(request, backend, "post", "/employees/project-managers", { projectPath: alpha, name: "Robin" }, 201)).employee;
  const worker = await api(request, backend, "post", "/employees", { name: "Ada", jobTitle: "QA Engineer", projectPath: alpha }, 201);

  await gotoApp(page, backend.bootBase);
  await page.getByTestId("project-nav-item").filter({ hasText: "Alpha Link" }).click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
  const team = page.getByTestId("project-team");
  await expect(team.getByTestId("project-team-manager")).toContainText("Robin");
  await expect(team.getByTestId("project-team-employee")).toHaveCount(1);
  await team.getByTestId("project-team-employee").click();
  await expect(page.getByTestId("employee-card")).toHaveAttribute("data-employee-id", worker.id);
  await page.getByTestId("employee-open-project").click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
  await page.getByTestId("project-team-open").click();
  await expect(page.getByTestId("staff-directory")).toBeVisible();
  await expect(page.getByTestId("staff-filter-project")).toHaveValue(alpha);
  await expect(page.getByTestId("staff-row")).toHaveCount(2);
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-dashboard")).toBeVisible();
  void manager;
});

test("no runtime, no model or account, and no extra permissions come from a title", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Safe");
  const writes = watchWrites(page);
  const tasksBefore = await api(request, backend, "get", "/tasks");
  const worker = await api(request, backend, "post", "/employees", { name: "Sec", jobTitle: "Security Engineer", roleCategory: "security", projectPath: alpha }, 201);
  const managerBefore = await api(request, backend, "get", `/project-manager?path=${encodeURIComponent(alpha)}`);

  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-row").click();
  const card = page.getByTestId("employee-card");
  await expect(card).toHaveAttribute("data-employee-id", worker.id);
  await expect(page.getByTestId("employee-runtime-binding")).toContainText("None.");
  await expect(page.getByTestId("employee-runtime-binding")).toContainText("chosen per task");
  await expect(page.getByTestId("employee-authority-note")).toContainText("Job title and role category are labels");
  await expect(card).not.toContainText(/Harness:|Account:|Model:|Effort:|Session:|Running now/);
  await expect(card.getByRole("button", { name: /run|start|launch|execute|switch/i })).toHaveCount(0);
  await page.getByTestId("employee-edit").click();
  // The form's explanatory sentence may say "model"; no field may ask for one.
  await expect(page.getByRole("dialog").getByLabel(/harness|account|model|effort|profile/i)).toHaveCount(0);
  await page.keyboard.press("Escape");

  expect(await api(request, backend, "get", "/tasks")).toEqual(tasksBefore);
  expect(await api(request, backend, "get", `/project-manager?path=${encodeURIComponent(alpha)}`)).toEqual(managerBefore);
  expect(writes).toEqual([]);
  expect((await api(request, backend, "get", `/employees/${worker.id}`)).authority.grantsPermissions).toBe(false);
});

test("dialogs are accessible and neighbouring pages still work", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Pages");
  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  const tab = page.getByTestId("company-tab-dashboard");
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("company-tab-chart")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  // End goes to the LAST tab — the Activity Journal since 369227c; Staff is the one before it.
  await expect(page.getByTestId("company-tab-activity")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("company-tab-staff")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("staff-create").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("aria-labelledby", "employee-form-title");
  await expect(page.getByTestId("employee-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("staff-create")).toBeFocused();

  await openPortfolio(page);
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  await openWorkspaces(page);
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await page.getByTestId("workspace-overview").click();
  await page.getByTestId("project-nav-item").filter({ hasText: "Alpha Pages" }).click();
  await expect(page.getByTestId("project-header-name")).toContainText("Alpha Pages");
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-team")).toBeVisible();
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
  void alpha;
});

test("a server error is shown as a sentence, not as database text", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Err");
  await api(request, backend, "post", "/employees/project-managers", { projectPath: alpha }, 201);
  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await page.route("**/employees/project-managers", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "SQLITE_CONSTRAINT: UNIQUE constraint failed: ai_employees.project_path" }) }));
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("company-tab-dashboard").click();
  await api(request, backend, "put", "/employees/head", { name: "Ilse" }, 201);
  await page.getByTestId("company-refresh").click();
  await expect(page.getByTestId("company-head-name")).toHaveText("Ilse");
  await page.getByTestId("company-create-employee").click();
  await page.getByTestId("employee-job-title").fill("QA Engineer");
  await page.getByTestId("employee-project").selectOption({ label: "Alpha Err" });
  await page.route("**/employees", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "SQLITE_CONSTRAINT: UNIQUE constraint failed: ai_employees.kind" }) })
    : route.fallback());
  await page.getByTestId("employee-save").click();
  await expect(page.getByTestId("employee-form-error")).toHaveText("Couldn't complete the employee request.");
  await expect(page.getByTestId("employee-form-error")).not.toContainText(/SQL|constraint/i);
});
