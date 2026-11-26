import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
import type { PortfolioManagerState } from "../src/shared/portfolio-manager.ts";
import type { Task } from "../src/shared/types.ts";

/**
 * Direction 3 (offline): one Head, two scopes. A company-scoped proposal names its project before approval,
 * Reject changes nothing, an out-of-scope proposal never becomes a card, and reloading the app starts nothing.
 * Fake driver, disposable backend, 1280x720.
 */
test.use({ viewport: { width: 1280, height: 720 } });

async function api(request: APIRequestContext, backend: E2EBackend, method: string, route: string, data?: unknown, status = 200) {
  const response = await request.fetch(backend.apiBase + route, { method, data, headers: { authorization: `Bearer ${backend.apiToken}` } });
  const body = await response.text();
  expect(response.status(), `${method} ${route}: ${body}`).toBe(status);
  return body ? JSON.parse(body) : null;
}

test("company scope names the affected project; reject and reload change nothing; approval applies only that proposal", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(90_000);
  const call = (method: string, route: string, data?: unknown, status?: number) => api(request, backend, method, route, data, status);
  const state = (): Promise<PortfolioManagerState> => call("GET", "/portfolio-manager");
  const taskList = (): Promise<Task[]> => call("GET", "/tasks");
  const alpha = path.join(backend.dataDir, "Alpha");
  const beta = path.join(backend.dataDir, "Beta");
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  await call("POST", "/projects", { path: alpha, name: "Project Alpha" });
  await call("POST", "/projects", { path: beta, name: "Project Beta" });
  const alphaTask = await call("POST", "/tasks", { workdir: alpha, title: "Alpha-only marker", prompt: "Alpha prompt", isolation: "none" });
  const betaTask = await call("POST", "/tasks", { workdir: beta, title: "Beta-only marker", prompt: "Beta prompt", isolation: "none" });
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call("PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey } });

  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith(backend.apiBase) && !["GET", "OPTIONS"].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  const orb = page.getByTestId("head-pm-orb");
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
  const propose = (value: object) => submit(`__fake_head_board__ ${JSON.stringify(value)}`);
  const baseline = (await taskList()).length;

  // Company scope: the displayed scope, and a context with no task titles.
  await scope.selectOption("workspace");
  await submit("__fake_head_scope__ What is in the company?");
  await expect(page.getByTestId("head-pm-message-scope").last()).toContainText(/Workspace|Всё рабочее пространство|рабоч/i);
  await expect(latestReply).toContainText("Project Alpha");
  await expect(latestReply).toContainText("Project Beta");
  await expect(latestReply).not.toContainText("Alpha-only marker");
  await expect(latestReply).not.toContainText("Beta-only marker");

  // A company-scoped proposal for one project: the card names that project before the Owner decides.
  await propose({ kind: "create", project: "Project Beta", title: "Company-scoped task", description: "Proposed from the company scope." });
  const card = page.getByTestId("head-pm-board-proposal").last();
  await expect(card).toHaveAttribute("data-status", "pending");
  await expect(card.getByTestId("head-pm-board-affected")).toContainText("Project Beta");
  await expect(card.getByTestId("head-pm-board-affected")).toHaveAttribute("data-projects", beta);
  expect(await taskList()).toHaveLength(baseline);

  // Reject: nothing is created, nothing started.
  await card.getByTestId("head-pm-board-reject").click();
  await expect(card).toHaveAttribute("data-status", "rejected");
  expect(await taskList()).toHaveLength(baseline);

  // A company turn cannot edit a task it was never shown; the refusal is on the reply, with no card.
  const cards = await page.getByTestId("head-pm-board-proposal").count();
  await propose({ kind: "edit", taskId: betaTask.id, project: "Project Beta", title: "Hijacked" });
  await expect(page.getByTestId("head-pm-board-proposal")).toHaveCount(cards);
  await expect(page.getByRole("alert").filter({ hasText: /not in this turn's context/i }).last()).toBeVisible();

  // Project scope: only that project's board, even right after a company turn.
  await scope.selectOption({ label: "Project Alpha" });
  await submit("__fake_head_scope__ What is on the Alpha board?");
  await expect(latestReply).toContainText("Alpha-only marker");
  await expect(latestReply).not.toContainText("Beta-only marker");
  await propose({ kind: "edit", taskId: betaTask.id, title: "Cross-project hijack" });
  await expect(page.getByTestId("head-pm-board-proposal")).toHaveCount(cards);
  await propose({ kind: "edit", taskId: alphaTask.id, title: "Alpha-only marker (revised)" });
  const editCard = page.getByTestId("head-pm-board-proposal").last();
  await expect(editCard).toHaveAttribute("data-status", "pending");
  await expect(editCard.getByTestId("head-pm-board-affected")).toContainText("Project Alpha");

  // Reopen the app: the pending proposal and every message's scope are read back, and nothing starts.
  const writesBefore = writes.length;
  await page.reload();
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("head-pm-orb").click();
  const reopened = page.getByTestId("head-pm-board-proposal").last();
  await expect(reopened).toHaveAttribute("data-status", "pending");
  await expect(reopened.getByTestId("head-pm-board-affected")).toContainText("Project Alpha");
  expect(writes.slice(writesBefore).filter((w) => /\/(start|approve|reject)\b/.test(w))).toEqual([]);
  expect((await taskList()).find((task) => task.id === alphaTask.id)!.title).toBe("Alpha-only marker");

  // Approve applies exactly the reviewed edit to exactly that task.
  await reopened.getByTestId("head-pm-board-approve").click();
  await expect(reopened).toHaveAttribute("data-status", "applied");
  const after = await taskList();
  expect(after.find((task) => task.id === alphaTask.id)!.title).toBe("Alpha-only marker (revised)");
  expect(after.find((task) => task.id === betaTask.id)!.title).toBe("Beta-only marker");
  expect(after).toHaveLength(baseline);
  expect(after.every((task) => task.column === "backlog")).toBe(true);
  expect((await state()).boardProposals?.map((item) => item.status)).toEqual(["rejected", "applied"]);
});
