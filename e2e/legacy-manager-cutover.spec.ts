import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";

test("new projects use scoped Head; historical PM proposals remain actionable", async ({ page, request, freshBackend: backend }) => {
  const api = async (method: string, route: string, data?: unknown, status = 200) => {
    const response = await request.fetch(backend.apiBase + route, {
      method, data, headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    const text = await response.text();
    expect(response.status(), `${method} ${route}: ${text}`).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const legacyDir = path.join(backend.dataDir, "historical-project");
  await mkdir(legacyDir);
  const historical = await api("POST", "/projects", { path: legacyDir, name: "Historical Project" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const agent = { harness: "codex", model: "gpt-6.1-sol", effort: "low" };
  const preflight = await api("POST", "/project-interviews/preflight", agent);
  const config = { ...agent, consentKey: preflight.isolation.consentKey };
  await api("PUT", "/project-manager/config", { path: historical.path, config });
  await api("PUT", "/portfolio-manager/config", { config });
  // Create a previously recorded PM conversation and proposal before observing
  // any UI traffic. The e2e backend only uses fake drivers.
  const legacyRequest = "Break user authentication into tasks";
  const previous = await api("POST", "/project-manager/messages", { path: historical.path, text: legacyRequest }, 202);
  await expect.poll(async () => (await api("GET", `/project-manager/turns/${previous.turn.id}`)).status).toBe("succeeded");
  const legacyRoute = `/project-manager?path=${encodeURIComponent(historical.path)}`;
  const legacy = await api("GET", legacyRoute);
  expect(legacy.proposals).toHaveLength(1);
  const legacyIds = legacy.messages.map((item: { id: string }) => item.id);
  const writes: { route: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (!req.url().startsWith(backend.apiBase) || ["GET", "OPTIONS"].includes(req.method())) return;
    writes.push({ route: new URL(req.url()).pathname, body: req.postDataJSON() });
  });

  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("workspace-add-project").click();
  await page.getByTestId("wizard-mode-create").click();
  await page.getByTestId("wizard-name").fill("New Head Project");
  await page.getByTestId("wizard-directory").fill(backend.dataDir);
  await page.getByTestId("wizard-placement-new-folder").click();
  await page.getByTestId("wizard-folder-name").fill("new-head-project");
  for (let i = 0; i < 5; i++) await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("New Head Project");
  const project = (await api("GET", "/projects")).find((item: { name: string }) => item.name === "New Head Project");
  const projectRoute = `/project-manager?path=${encodeURIComponent(project.path)}`;
  const teamRoute = `/employees/project-team?projectPath=${encodeURIComponent(project.path)}`;
  expect((await api("GET", teamRoute)).projectManager).toBeNull();
  expect((await api("GET", projectRoute)).config.harness).toBeNull();

  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-settings").click();
  await expect(page.getByTestId("project-more")).toHaveAttribute("data-current", "true");
  await page.getByTestId("project-open-head-pm").click();
  await expect(page.getByTestId("head-pm-scope")).toHaveValue(`project:${project.path}`);
  await page.getByTestId("head-pm-composer").fill("__fake_head_scope__ Show the new project");
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-reply").last()).toContainText("New Head Project");
  await page.getByTestId("head-pm-scope").selectOption({ label: "Historical Project" });
  await page.getByTestId("head-pm-composer").fill("__fake_head_scope__ Show the historical project's board");
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-reply").last()).toContainText("Historical Project");
  await expect(page.getByTestId("head-pm-reply")).toHaveCount(2);
  await page.getByTestId("head-pm-open-full").click();
  await expect(page.getByTestId("portfolio-manager")).toBeVisible();
  await expect(page.getByTestId("portfolio-manager-composer")).toHaveCount(0);
  await expect(page.getByTestId("portfolio-manager-agent")).toBeVisible();
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-dashboard")).toBeVisible();
  await expect(page.getByTestId("company-ensure-manager")).toHaveCount(0);
  await expect(page.getByTestId("initialize-managers")).toHaveCount(0);
  await page.getByTestId("company-project-row").filter({ hasText: "Historical Project" }).getByTestId("company-project-open").click();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-log")).toContainText(legacyRequest);
  await expect(page.getByTestId("manager-composer")).toHaveCount(0);
  await expect(page.getByTestId("manager-retry")).toHaveCount(0);
  expect((await api("GET", legacyRoute)).messages.map((item: { id: string }) => item.id)).toEqual(legacyIds);

  const proposal = page.getByTestId("manager-proposal");
  await expect(proposal).toHaveAttribute("data-status", "pending");
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  const settled = await api("GET", legacyRoute);
  expect(settled.proposals[0].id).toBe(legacy.proposals[0].id);
  expect(settled.proposals[0].items.some((item: { result?: { status: string } }) => item.result?.status === "created")).toBe(true);
  expect((await api("GET", projectRoute)).messages).toEqual([]);
  expect(writes.filter((entry) => entry.route.endsWith("/messages"))).toEqual([
    { route: "/portfolio-manager/messages", body: expect.objectContaining({ scope: { kind: "project", path: project.path } }) },
    { route: "/portfolio-manager/messages", body: expect.objectContaining({ scope: { kind: "project", path: historical.path } }) },
  ]);
  expect(writes.filter((entry) => /\/employees\/project-managers|\/project-manager\/config|\/deploy/.test(entry.route))).toEqual([]);
  expect(errors).toEqual([]);
});
