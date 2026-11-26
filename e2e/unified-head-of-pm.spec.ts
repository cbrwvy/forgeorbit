import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
import type { PortfolioManagerState } from "../src/shared/portfolio-manager.ts";
import type { Task } from "../src/shared/types.ts";

async function api(request: APIRequestContext, backend: E2EBackend, method: string, route: string, data?: unknown, status = 200) {
  const response = await request.fetch(backend.apiBase + route, {
    method, data, headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  const body = await response.text();
  expect(response.status(), `${method} ${route}: ${body}`).toBe(status);
  return body ? JSON.parse(body) : null;
}

test("one Head switches projects and delegates an Inbox task through separate Owner approvals", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(60_000);
  const call = (method: string, route: string, data?: unknown, status?: number) => api(request, backend, method, route, data, status);
  const state = (): Promise<PortfolioManagerState> => call("GET", "/portfolio-manager");
  const taskList = (): Promise<Task[]> => call("GET", "/tasks");
  const alpha = path.join(backend.dataDir, "Alpha");
  const beta = path.join(backend.dataDir, "Beta");
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  await call("POST", "/projects", { path: alpha, name: "Project Alpha" });
  await call("POST", "/projects", { path: beta, name: "Project Beta" });
  const cluster = await call("POST", "/clusters", { name: "Cluster Forge" }, 201);
  await call("POST", `/clusters/${cluster.id}/projects`, { projectPath: alpha }, 201);
  const worker = await call("POST", "/employees", { projectPath: alpha, name: "Ada", jobTitle: "QA Engineer" }, 201);
  const betaTask = await call("POST", "/tasks", { workdir: beta, title: "Beta-only marker", prompt: "Private beta prompt", isolation: "none" });
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey },
  });

  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (req.url().startsWith(backend.apiBase) && !["GET", "OPTIONS"].includes(req.method())) writes.push(new URL(req.url()).pathname);
  });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  const orb = page.getByTestId("head-pm-orb");
  await expect(orb).toHaveCount(1);
  await orb.click();
  const scope = page.getByTestId("head-pm-scope");
  const composer = page.getByTestId("head-pm-composer");
  const submit = async (text: string) => {
    const before = (await state()).messages.length;
    await composer.fill(text);
    await page.getByTestId("head-pm-send").click();
    await expect.poll(async () => (await state()).messages.length).toBe(before + 2);
    await expect(page.getByTestId("head-pm-message")).toHaveCount(before + 2);
  };
  const latestReply = page.getByTestId("head-pm-reply").last();
  const latestCard = page.getByTestId("head-pm-board-proposal").last();
  const propose = (value: object) => submit(`__fake_head_board__ ${JSON.stringify(value)}`);
  const approve = async () => {
    await expect(latestCard).toHaveAttribute("data-status", "pending");
    await latestCard.getByTestId("head-pm-board-approve").click();
    await expect(latestCard).toHaveAttribute("data-status", "applied");
  };

  await scope.selectOption(`cluster:${cluster.id}`);
  await submit("__fake_head_scope__ What is in Cluster Forge?");
  await expect(latestReply).toContainText("Cluster Forge");
  await expect(latestReply).toContainText("Project Alpha");
  await expect(latestReply).not.toContainText("Project Beta");

  await scope.selectOption({ label: "Project Alpha" });
  const alphaScope = await scope.inputValue();
  await propose({ kind: "create", title: "Verify Alpha navigation", description: "Exercise the navigation and record the result." });
  expect(await taskList()).toHaveLength(1);
  await approve();
  const created = (await taskList()).find((task) => task.title === "Verify Alpha navigation")!;
  expect(created).toMatchObject({ ownerProjectPath: alphaScope.slice("project:".length), column: "backlog" });

  await propose({ kind: "assign", taskId: created.id, employeeId: worker.id });
  await expect(page.getByTestId("head-pm-board-proposal")).toHaveCount(1);
  await propose({ kind: "admit", taskId: betaTask.id });
  await expect(page.getByTestId("head-pm-board-proposal")).toHaveCount(1);
  await propose({ kind: "admit", taskId: created.id });
  expect((await call("GET", `/tasks/${created.id}`)).column).toBe("backlog");
  await approve();
  expect((await call("GET", `/tasks/${created.id}`)).column).toBe("inbox");

  await propose({ kind: "assign", taskId: created.id, employeeId: worker.id });
  expect((await call("GET", `/task-assignments/task?taskId=${created.id}`)).assignment).toBeNull();
  await approve();
  expect((await call("GET", `/task-assignments/task?taskId=${created.id}`)).assignment.employeeId).toBe(worker.id);
  expect((await call("GET", `/employee-execution/attempts?taskId=${created.id}`)).attempts).toEqual([]);

  await latestCard.getByTestId("head-pm-board-open-task").click();
  await page.getByTestId("manager-task-primary").getByText("Ready for work", { exact: true }).click();
  await expect.poll(async () => (await call("GET", `/tasks/${created.id}`)).column).toBe("ready");
  await page.getByTestId("manager-task-details").click();
  const execution = page.getByTestId("employee-execution");
  await expect(execution).toBeVisible();
  await execution.locator("summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-worker")).toHaveText("Ada");
  await page.getByTestId("employee-run-confirm").click();
  await expect.poll(async () => (await call("GET", `/employee-execution/attempts?taskId=${created.id}`)).attempts[0]?.result,
    { timeout: 12_000 }).toBe("succeeded");

  await page.getByTestId("head-pm-close").click();
  await orb.click();
  await scope.selectOption(`task:${created.id}`);
  await submit("__fake_head_scope__ What happened to the assigned task?");
  await expect(latestReply).toContainText("result succeeded");
  await expect(latestReply).not.toContainText("Beta-only marker");

  await scope.selectOption({ label: "Project Beta" });
  await submit("__fake_head_scope__ What is on the Beta board?");
  await expect(latestReply).toContainText("Beta-only marker");
  await expect(latestReply).not.toContainText("Verify Alpha navigation");
  await expect(page.getByTestId("head-pm-message-scope").first()).toContainText("Cluster Forge");
  expect((await call("GET", `/tasks/${betaTask.id}`)).column).toBe("backlog");
  const persisted = await state();
  expect(persisted.boardProposals?.map((item) => item.status)).toEqual(["applied", "applied", "applied"]);
  expect(persisted.delegations).toEqual([]);
  expect(writes.filter((route) => route.startsWith("/project-manager/") || route.includes("deploy"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("a compact Head conversation shows the pending rename before its apply action", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(45_000);
  const call = (method: string, route: string, data?: unknown, status?: number) => api(request, backend, method, route, data, status);
  await call("POST", "/projects", { path: backend.dataDir, name: "Navigation project" });
  const original = await call("POST", "/tasks", {
    workdir: backend.dataDir, title: "Review release checklist", prompt: "Keep the checklist and record the result.", isolation: "none",
  });
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey },
  });

  await page.setViewportSize({ width: 1024, height: 720 });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("head-pm-orb").click();
  await page.getByTestId("head-pm-scope").selectOption({ label: "Navigation project" });
  const composer = page.getByTestId("head-pm-composer");
  await composer.fill(`__fake_head_board__ ${JSON.stringify({ kind: "edit", taskId: original.id, title: "Check release prerequisites" })}`);
  await page.getByTestId("head-pm-send").click();

  const proposal = page.getByTestId("head-pm-board-proposal");
  const status = proposal.getByTestId("head-pm-board-status");
  await expect(status).toHaveText("Needs your approval");
  await expect(status).toBeInViewport();
  await expect(proposal.getByTestId("head-pm-board-affected")).toContainText("Navigation project");
  await expect(proposal.getByTestId("head-pm-edit-title")).toContainText("Review release checklist → Check release prerequisites");
  await expect(proposal.getByTestId("head-pm-edit-description")).toHaveText(/Description:.*Unchanged/);
  expect(await call("GET", `/tasks/${original.id}`)).toMatchObject({ title: original.title, prompt: original.prompt, column: "backlog" });
  await proposal.getByRole("button", { name: "Apply task edit" }).click();
  await expect(proposal).toHaveAttribute("data-status", "applied");
  expect(await call("GET", `/tasks/${original.id}`)).toMatchObject({ title: "Check release prerequisites", prompt: original.prompt, column: "backlog" });
  expect(await call("GET", `/tasks/${original.id}/runs`)).toEqual([]);
});
