/**
 * FO-AUTO03-GATES01. Opening the Owner queue panel must not start a process.
 * Fake drivers and an isolated backend only.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";

test.describe.configure({ timeout: 90_000 });

function auth(backend: E2EBackend) {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

test("the queue panel shows the next Owner authorization and does not launch", async ({ page, request, freshBackend: backend }) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-auto03-ui-")));
  const registered = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name: "Gated queue" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const workdir = (await registered.json()).path as string;
  await request.patch(`${backend.apiBase}/harnesses/claude-code`, { headers: auth(backend), data: { enabled: true } });
  const task = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title: "Synthetic gate", prompt: "Wait for authorization.", workdir, column: "ready", agent: "claude-code", mode: "auto", model: "opus-5.5", effort: "low", isolation: "none" },
  });
  expect(task.ok(), await task.text()).toBeTruthy();
  const taskId = (await task.json()).id as string;
  const employee = await request.post(`${backend.apiBase}/employees`, { headers: auth(backend), data: { name: "Gate Dev", jobTitle: "Eng", projectPath: workdir } });
  expect(employee.ok(), await employee.text()).toBeTruthy();
  const employeeId = (await employee.json()).id as string;
  expect((await request.post(`${backend.apiBase}/task-assignments`, { headers: auth(backend), data: { taskId, employeeId } })).ok()).toBeTruthy();
  const draft = await request.post(`${backend.apiBase}/project-manager/orchestrated-batches`, { headers: auth(backend), data: { path: workdir, taskIds: [taskId], title: "Gated" } });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const batch = (await draft.json()).batch as { id: string; revision: number };
  const approved = await request.post(`${backend.apiBase}/project-manager/orchestrated-batches/${batch.id}/approve`, {
    headers: auth(backend),
    data: {
      path: workdir,
      revision: batch.revision,
      defaults: {
        implementerEmployeeId: employeeId,
        implementerHarnessId: "claude-code",
        implementerModel: "opus-5.5",
        implementerMode: "auto",
        implementerEffort: "low",
        reviewerHarness: "claude-code",
        reviewerModel: "haiku-5.5",
        reviewerMode: "auto",
        autoReviewAfterImplementation: true,
        autoReworkOnChanges: false,
        maxLaunches: 4,
        maxReworkIterations: 0,
        evidencePolicy: "observed-test",
        completionGate: "owner-done",
        requireTaskWorkspace: true,
      },
    },
  });
  expect(approved.ok(), await approved.text()).toBeTruthy();
  const started = await request.post(`${backend.apiBase}/project-manager/orchestrated-batches/${batch.id}/start`, { headers: auth(backend), data: { path: workdir } });
  expect(started.ok(), await started.text()).toBeTruthy();

  const launches: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (/\/tasks\/[^/]+\/start$|phase-grants|orchestrated-batches\/[^/]+\/start/.test(req.url())) launches.push(req.url());
  });

  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${workdir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-tab-autonomy").click();
  await page.locator(`[data-testid="orchestrated-batch-row"][data-batch-id="${batch.id}"]`).click();
  const gate = page.getByTestId("orchestrated-queue-gate");
  await expect(gate).toBeVisible();
  await expect(page.getByTestId("orchestrated-queue-disposition")).toHaveText("Waiting");
  await expect(page.getByTestId("orchestrated-queue-next")).toContainText("task-owned workspace");
  await expect(page.getByTestId("orchestrated-queue-developer")).toContainText("claude-code");
  await expect(page.getByTestId("orchestrated-queue-reviewer")).toContainText("claude-code");
  await expect(page.getByTestId("orchestrated-queue-quota")).toContainText("unknown");
  await expect(page.getByTestId("orchestrated-queue-next-task")).toHaveText("The next task cannot start yet.");
  await expect(page.getByTestId("orchestrated-queue-authorize")).toHaveCount(0);
  const runs = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: auth(backend) });
  expect(await runs.json()).toEqual([]);
  expect(launches).toEqual([]);
});
