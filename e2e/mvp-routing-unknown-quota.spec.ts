import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-MVP-ROUTING01. Synthetic project, fake drivers, no provider calls.
 * Automatic routing abstains. An explicit Owner harness choice may proceed
 * while quota stays Unknown. Assignment does not invoke that exception.
 */

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api(request: APIRequestContext, backend: E2EBackend, method: "get" | "post", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

async function setup(request: APIRequestContext, backend: E2EBackend) {
  const dir = await mkdtemp(path.join(tmpdir(), "fo-mvp-routing-"));
  await api(request, backend, "post", "/projects", { path: dir, name: "Routing gate" });
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Routing", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, backend, "post", "/tasks", {
    title: "Route without a verified quota", prompt: "inspect the gate", isolation: "none", workdir: dir, agent: "claude-code", model: "opus", mode: "auto", column: "ready",
  });
  const assigned = await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
  return { dir, ada, task, assigned };
}

async function openTask(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Route without a verified quota" }).click();
}

test("unknown quota abstains automatically and still allows an explicit owner choice", async ({ page, request, freshBackend: backend }) => {
  const writes: string[] = [];
  let refreshes = 0;
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (/quota-refresh|usage\/refresh/.test(url.pathname)) refreshes++;
    if (req.method() === "GET" || req.method() === "HEAD" || req.method() === "OPTIONS") return;
    if (url.pathname === "/preferences" || url.pathname.startsWith("/preferences/") || url.pathname.endsWith("/seen")) return;
    writes.push(`${req.method()} ${url.pathname}`);
  });
  const { task, assigned } = await setup(request, backend);
  expect(assigned.routerHandoff).toMatchObject({ status: "not-invoked", previewPath: "/model-router/preview" });
  expect(assigned.assignment?.routerHandoff?.status ?? assigned.routerHandoff.status).toBe("not-invoked");

  await openTask(page, backend);
  const router = page.getByTestId("ai-resource-recommendation");
  await router.locator(":scope > summary").click();
  await router.getByTestId("find-ai-resource").click();
  await expect(router.getByTestId("router-no-verified")).toBeVisible();
  await expect(router.getByTestId("router-no-verified")).toContainText("No verified candidate");
  await expect(router.getByTestId("router-verified")).toHaveCount(0);
  await expect(router).not.toContainText(/\bAvailable\b/);

  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await expect(execution).toContainText("explicit Owner choice");
  await expect(execution).toContainText("Unknown quota is not available");
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(page.getByTestId("employee-execution-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-execution-quota")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("employee-execution-recommendation")).toContainText("no verified recommendation");
  await expect(page.getByTestId("employee-execution-result")).not.toContainText(/\bReady\b|\bAvailable\b/);
  await expect(page.getByTestId("employee-execution-run")).toBeVisible();
  await expect(page.getByTestId("employee-execution-errors")).toHaveCount(0);

  const attempts = await api(request, backend, "get", `/employee-execution/attempts?taskId=${task.id}`);
  expect(attempts.attempts).toEqual([]);
  const runs = await api(request, backend, "get", `/tasks/${task.id}/runs`);
  expect(runs).toEqual([]);
  expect(refreshes).toBe(0);
  expect(writes.some((line) => line.includes("/employee-execution/reviews") || line.includes("/start"))).toBe(false);
  expect(writes).toContain("POST /model-router/preview");
  expect(writes).toContain("POST /employee-execution/preflight");
});
