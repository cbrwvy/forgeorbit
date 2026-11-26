import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-DIRECTION12: the Backlog estimate says what it rests on and what it cannot know, a changed planning
 * input produces a new revision without losing the earlier one, and estimating dispatches nothing.
 * Fake drivers, an empty history: there is no measured history here, so the basis must read as a cold-start
 * heuristic. No provider, quota or CLI is used.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });
async function call<T>(request: APIRequestContext, b: E2EBackend, method: string, route: string, data?: unknown): Promise<T> {
  const response = await request.fetch(b.apiBase + route, { method, data, headers: auth(b) });
  const body = await response.text();
  expect(response.ok(), `${method} ${route}: ${body}`).toBeTruthy();
  return (body ? JSON.parse(body) : null) as T;
}
const revisionOf = async (scope: { innerText(): Promise<string> }) => Number(/Revision #(\d+)/.exec(await scope.innerText())?.[1]);

test("a cold-start estimate names its basis; a changed input adds a revision and keeps the earlier one; nothing is dispatched", async ({ page, request, freshBackend: b }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "d12-"));
  await writeFile(path.join(dir, "package.json"), "{}");
  await call(request, b, "POST", "/projects", { path: dir, name: "D12" });
  const taskId = (await call<{ id: string }>(request, b, "POST", "/tasks", {
    title: "Add a health endpoint", prompt: "Add GET /health returning ok. Acceptance: it answers 200.",
    workdir: dir, agent: "claude-code", model: "opus-5.5", isolation: "none", column: "backlog",
  })).id;
  const counts = async () => ({
    runs: (await call<unknown[]>(request, b, "GET", `/tasks/${taskId}/runs`)).length,
    column: (await call<{ column: string }>(request, b, "GET", `/tasks/${taskId}`)).column,
    attempts: (await call<{ attempts: unknown[] }>(request, b, "GET", `/employee-execution/attempts`).catch(() => ({ attempts: [] }))).attempts.length,
  });
  const before = await counts();
  expect(before).toMatchObject({ runs: 0, column: "backlog" });

  await gotoApp(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-board").click();
  await page.getByTestId("task-estimate").click();
  const dialog = page.getByTestId("usage-task-dialog");
  const estimate = dialog.getByTestId("usage-task-estimate").filter({ visible: true });
  await expect(estimate).toContainText("Revision #");
  const first = await revisionOf(estimate);

  // 1. No history: a labelled cold-start range, with the shortfall and the unknowns named.
  const basis = estimate.getByTestId("estimate-basis");
  await expect(basis).toHaveAttribute("data-basis", "heuristic");
  await expect(basis).toContainText("Cold-start range");
  await expect(basis).toContainText("rule of thumb for low-complexity work");
  await expect(basis).toContainText("not from measured history");
  await expect(basis).toContainText("uncertainty, not accuracy");
  const stages = basis.getByTestId("estimate-basis-stages").locator("li");
  await expect(stages).toHaveCount(2);
  await expect(stages.nth(0)).toHaveAttribute("data-samples", "0");
  await expect(stages.nth(0)).toContainText("Developer: 0 of 3 comparable outcomes");
  await expect(stages.nth(1)).toContainText("Reviewer: 0 of 3 comparable outcomes");
  await expect(basis.getByTestId("estimate-basis-inputs")).toContainText("low complexity");
  const unknowns = basis.getByTestId("estimate-basis-unknowns");
  for (const item of ["subscription use", "price", "human wait"]) await expect(unknowns).toContainText(item);
  const original = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`);
  const range = original.revisions[0].estimate.completion;
  expect(range.optimistic).toBeLessThan(range.expected);
  expect(range.expected).toBeLessThan(range.conservative);
  expect(original.revisions[0].estimate.subscriptionUsage).toBeNull();

  // 2. A material scope change (acceptance criteria) gives a new estimate and keeps the first one readable.
  const criteria = Array.from({ length: 6 }, (_, n) => `- Criterion ${n + 1}: the endpoint reports degraded dependency ${n + 1} with a clear status.`).join("\n");
  await dialog.getByTestId("usage-task-scope").fill(`Add GET /health returning ok.\n${criteria}`);
  await dialog.getByTestId("usage-regenerate").click();
  await expect.poll(async () => revisionOf(estimate)).toBeGreaterThan(first);
  const second = await revisionOf(estimate);
  await expect(basis.getByTestId("estimate-basis-inputs")).toContainText("medium complexity");
  await dialog.getByText("Saved estimate revisions").click();
  const earlierSummary = dialog.locator("summary", { hasText: `#${first} ·` });
  await expect(earlierSummary).toContainText("Superseded");
  await earlierSummary.click();
  const earlier = earlierSummary.locator("xpath=..");
  await expect(earlier.getByTestId("estimate-basis").first()).toContainText("low complexity");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // 3. Assigning a worker is a planning input too: the earlier revision is marked superseded, a new one names the worker.
  const worker = await call<{ id: string }>(request, b, "POST", "/employees", { projectPath: dir, name: "Ada", jobTitle: "Backend Engineer" });
  await call(request, b, "POST", "/task-assignments", { taskId, employeeId: worker.id });
  const afterAssign = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`);
  expect(afterAssign.revisions[0]).toMatchObject({ id: second, stale: true });
  await page.getByTestId("task-estimate").click();
  await expect.poll(async () => revisionOf(estimate)).toBeGreaterThan(second);
  await expect(basis.getByTestId("estimate-basis-inputs")).toContainText("assigned worker");
  const ids = (await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`)).revisions.map((r: any) => [r.id, r.stale]);
  expect(ids.map((x: any[]) => x[1])).toEqual([false, true, true]);
  expect(ids.map((x: any[]) => x[0]).slice(-1)[0]).toBe(first);

  // 4. Estimating started nothing, moved nothing and left the worker as assigned.
  expect(await counts()).toMatchObject({ runs: 0, column: "backlog" });
  expect((await call<any>(request, b, "GET", `/task-assignments/task?taskId=${taskId}`)).assignment.employeeId).toBe(worker.id);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // 5. Russian.
  await call(request, b, "PUT", "/preferences/locale", { value: "ru" });
  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-board").click();
  await page.getByTestId("task-estimate").click();
  await expect(estimate.getByTestId("estimate-basis")).toContainText("На чём основана оценка");
  await expect(estimate.getByTestId("estimate-basis")).toContainText("не из измеренной истории");
  await expect(estimate.getByTestId("estimate-basis")).toContainText("сложностью «средняя»");
  expect(await counts()).toMatchObject({ runs: 0, column: "backlog" });
});
