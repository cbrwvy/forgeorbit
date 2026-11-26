import { Database } from "bun:sqlite";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";
import { EMPTY_QC_STATE } from "../src/shared/task-quality-control";

test.describe.configure({ timeout: 90_000 });

test("Direction 31 acceptance fixture", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  await request.put(`${backend.apiBase}/preferences/locale`, { headers, data: { value: "ru" } });
  const res = await request.post(`${backend.apiBase}/tasks`, { headers, data: {
    title: "Direction 31 — clamp (UX fixture)", prompt: "Реализовать clamp и проверить граничные значения.",
    workdir: backend.dataDir, isolation: "none", column: "review", agent: "claude-code", model: "opus",
  } });
  expect(res.ok()).toBeTruthy();
  const task = await res.json();
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.run("UPDATE tasks SET qc_state = ? WHERE id = ?", [JSON.stringify({ ...EMPTY_QC_STATE, latestVerdict: "PASS", roundCount: 3, awaitingOwnerApproval: true }), task.id]);
  db.close();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openAllTasks(page);
  await expect(page.getByTestId("board-technical-filters")).not.toHaveAttribute("open", "");
  const card = page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) });
  await card.getByRole("button", { name: task.title, exact: true }).click();
  const panel = page.getByRole("complementary").filter({ has: page.getByText(task.title, { exact: true }) });
  await expect(panel).toBeVisible();
  const summary = panel.getByTestId("manager-task-summary");
  await expect(summary).toContainText("Результат готов к приёмке");
  await expect(summary.getByTestId("manager-task-primary")).toHaveText("Принять результат");
  await expect(summary.getByTestId("manager-task-return")).toHaveText("Вернуть на доработку");
  await expect(panel.getByTestId("task-assignment-panel")).toHaveCount(0);
  await expect(panel.getByTestId("employee-execution")).toHaveCount(0);
  await expect(panel.getByTestId("manager-task-technical-details")).not.toBeVisible();
  await expect(panel.getByRole("button", { name: "Показать изменения", exact: true })).not.toBeVisible();
  await panel.screenshot({ path: "docs/qa/evidence/fo-manager-first/after-task-detail-ru.png" });
  // Capture the card after closing the overlay, so its own pixels are unobstructed.
  await panel.getByRole("button", { name: "Закрыть сведения о задаче", exact: true }).click();
  await card.screenshot({ path: "docs/qa/evidence/fo-manager-first/after-board-card-ru.png" });
  await card.getByRole("button", { name: task.title, exact: true }).click();
  await panel.getByTestId("manager-task-details").click();
  await expect(panel.getByTestId("task-quality-control")).toBeVisible();
  await expect(panel.getByTestId("run-panel-launch-diagnostics")).toBeAttached();
  await expect(panel.getByTestId("task-details-scroll")).toBeVisible();
  // Scroll expanded diagnostics; the current acceptance action stays outside that scroll area.
  await panel.getByTestId("task-details-scroll").evaluate((element) => {
    element.querySelectorAll("details").forEach((details) => { details.open = true; });
    element.scrollTop = element.scrollHeight;
  });
  await expect(summary.getByTestId("manager-task-primary")).toBeInViewport();
  await panel.screenshot({ path: "docs/qa/evidence/fo-manager-first/after-expanded-details-ru.png" });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(summary.getByTestId("manager-task-primary")).toBeInViewport();
  await summary.getByTestId("manager-task-return").click();
  await expect(summary).toHaveAttribute("data-stage", "returned");
  await expect(summary.getByTestId("manager-task-primary")).not.toHaveText("Принять результат");
  const returnedTask = await (await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers })).json();
  expect(returnedTask.column).toBe("ready");
  expect(returnedTask.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: false });
  // Restore a PASS-awaiting-acceptance fixture, then exercise the existing Owner acceptance endpoint.
  setState(backend, task.id, "review", { ...EMPTY_QC_STATE, latestVerdict: "PASS", roundCount: 3, awaitingOwnerApproval: true });
  await request.put(`${backend.apiBase}/preferences/locale`, { headers, data: { value: "en" } });
  await page.reload();
  await openAllTasks(page);
  await card.getByRole("button", { name: task.title, exact: true }).click();
  await expect(panel.getByTestId("manager-task-primary")).toHaveText("Accept result");
  await panel.getByTestId("manager-task-primary").click();
  await expect(panel.getByTestId("manager-task-summary")).toHaveAttribute("data-stage", "accepted");
  await expect(panel.getByTestId("manager-task-primary")).toHaveCount(0);
  const accepted = await (await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers })).json();
  expect(accepted.column).toBe("done");
  expect(accepted.qcState.awaitingOwnerApproval).toBe(false);
  expect((await (await request.get(`${backend.apiBase}/tasks/${task.id}/runs`, { headers })).json())).toEqual([]);
});


function setState(backend: E2EBackend, taskId: string, column: string, qcState: object | null) {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.run('UPDATE tasks SET "column" = ?, qc_state = ?, updated_at = ? WHERE id = ?', [column, JSON.stringify(qcState), Date.now(), taskId]);
  } finally { db.close(); }
}

test("current states and decision filter use fixture state, without starting work", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const fixtures = [
    { title: "Running fixture", column: "running", stage: "running", qc: null, stop: true },
    { title: "Blocked fixture", column: "blocked", stage: "blocked", qc: null },
    { title: "Returned fixture", column: "ready", stage: "returned", qc: { ...EMPTY_QC_STATE, latestVerdict: "CHANGES_REQUESTED", roundCount: 1 } },
    { title: "Accepted fixture", column: "done", stage: "accepted", qc: { ...EMPTY_QC_STATE, latestVerdict: "PASS", roundCount: 1 } },
    { title: "Execution succeeded fixture", column: "review", stage: "needs-review", qc: null },
    { title: "Reviewing fixture", column: "review", stage: "reviewing", qc: { ...EMPTY_QC_STATE, activeReviewId: "fixture-review", roundCount: 1 }, stop: true },
  ];
  for (const fixture of fixtures) {
    const response = await request.post(`${backend.apiBase}/tasks`, { headers, data: { title: fixture.title, prompt: "Fixture assignment", workdir: backend.dataDir, isolation: "none" } });
    expect(response.ok()).toBeTruthy();
    setState(backend, (await response.json()).id, fixture.column, fixture.qc);
  }
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openAllTasks(page);
  for (const fixture of fixtures) {
    const card = page.locator('[data-testid="task-card"]').filter({ has: page.getByText(fixture.title, { exact: true }) });
    await card.getByRole("button", { name: fixture.title, exact: true }).click();
    const panel = page.getByRole("complementary").filter({ has: page.getByTestId("manager-task-summary") });
    await expect(panel.getByTestId("manager-task-summary")).toHaveAttribute("data-stage", fixture.stage);
    if (fixture.stop) await expect(panel.getByTestId("manager-task-stop")).toBeVisible();
    if (fixture.stage === "accepted" || fixture.stage === "running" || fixture.stage === "reviewing") await expect(panel.getByTestId("manager-task-primary")).toHaveCount(0);
    if (fixture.stage === "needs-review") await expect(panel.getByTestId("manager-task-primary")).toHaveText("Prepare review");
    await panel.getByRole("button", { name: "Close task details", exact: true }).click();
  }
  await page.getByTestId("board-decisions-filter").click();
  await expect(page.locator('[data-testid="task-card"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="task-card"]').filter({ hasText: "Accepted fixture" })).toHaveCount(0);
});

test("simple creation uses existing defaults and saves without a launch", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  await request.post(`${backend.apiBase}/projects`, { headers, data: { path: backend.dataDir, name: "Manager project" } });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("header-new-task").click();
  const sheet = page.getByTestId("new-task-panel");
  await sheet.getByPlaceholder("Short description").fill("Manager assignment fixture");
  await sheet.getByLabel("Assignment", { exact: true }).fill("Deliver an understandable result.");
  await expect(sheet.getByTestId("new-task-advanced")).not.toHaveAttribute("open", "");
  await expect(sheet.getByTestId("new-task-launch-diagnostics")).not.toBeVisible();
  await sheet.getByTestId("new-task-advanced").locator("summary").click();
  await expect(sheet.getByTestId("new-task-launch-diagnostics")).toBeVisible();
  await sheet.getByTestId("new-task-advanced").locator("summary").click();
  await expect(sheet.getByLabel("Assignment", { exact: true })).toHaveValue("Deliver an understandable result.");
  await expect(sheet.getByTestId("manager-create-assignment")).toBeEnabled();
  await sheet.getByTestId("manager-create-assignment").click();
  await expect.poll(async () => {
    const rows = await (await request.get(`${backend.apiBase}/tasks`, { headers })).json();
    return rows.some((row: { title: string }) => row.title === "Manager assignment fixture");
  }).toBe(true);
  const rows = await (await request.get(`${backend.apiBase}/tasks`, { headers })).json();
  const created = rows.find((row: { title: string }) => row.title === "Manager assignment fixture");
  expect(created.column).toBe("backlog");
  expect(created.workdir).toBe(backend.dataDir);
  expect(created.runId).toBeNull();
});

test("missing execution default offers plain setup and keeps the technical form collapsed", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  await request.post(`${backend.apiBase}/projects`, { headers, data: { path: backend.dataDir, name: "Unconfigured project" } });
  await page.route("**/harnesses", async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/harnesses") { await route.continue(); return; }
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, statuses: payload.statuses.map((row: object) => ({ ...row, available: false })) } });
  });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByTestId("header-new-task").click();
  const sheet = page.getByTestId("new-task-panel");
  await sheet.getByPlaceholder("Short description").fill("Needs setup");
  await sheet.getByLabel("Assignment", { exact: true }).fill("Assignment remains a draft.");
  await expect(sheet.getByTestId("manager-creation-setup")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Set up execution", exact: true })).toBeVisible();
  await expect(sheet.getByTestId("manager-create-assignment")).toBeDisabled();
  await expect(sheet.getByTestId("new-task-launch-diagnostics")).not.toBeVisible();
});


test("expanded run history keeps current action visible and all diagnostics reachable", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const response = await request.post(`${backend.apiBase}/tasks`, { headers, data: { title: "History fixture", prompt: "Fixture assignment", workdir: backend.dataDir, isolation: "none", column: "review" } });
  const task = await response.json();
  setState(backend, task.id, "review", { ...EMPTY_QC_STATE, latestVerdict: "PASS", awaitingOwnerApproval: true, roundCount: 1 });
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    for (let index = 0; index < 12; index++) {
      db.run("INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code) VALUES (?, ?, 'claude-code', 'succeeded', ?, ?, 0)", [`history-${index}`, task.id, Date.now() + index, Date.now() + index + 1]);
    }
    db.run(`INSERT INTO task_quality_reviews (id, task_id, project_path, round, status, verdict, summary, findings_json,
      reviewer_harness, reviewer_model, implementation_run_id, saved_task_json, requested_at, completed_at)
      VALUES ('history-review', ?, ?, 1, 'complete', 'PASS', ?, '[]', 'claude-code', 'fixture-model', 'history-11', '{}', ?, ?)`,
      [task.id, backend.dataDir, "The clamp result meets the assignment. " + "Additional diagnostic detail. ".repeat(60), Date.now(), Date.now()]);
  } finally { db.close(); }
  await page.setViewportSize({ width: 1024, height: 768 });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openAllTasks(page);
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const panel = page.getByRole("complementary").filter({ has: page.getByTestId("manager-task-summary") });
  await expect(panel.getByTestId("manager-task-result")).toContainText("The clamp result meets the assignment.");
  await panel.getByTestId("manager-task-details").click();
  await panel.getByTestId("runs-list").getByRole("button").first().click();
  await expect(panel.getByTestId("runs-list").getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("manager-task-primary")).toBeInViewport();
  await panel.getByTestId("task-qc-history").scrollIntoViewIfNeeded();
  await expect(panel.getByTestId("task-qc-history")).toBeVisible();
  await expect(panel.getByTestId("manager-task-primary")).toBeInViewport();
  await expect(panel.getByTestId("transcript-log")).toBeAttached();
  await panel.getByRole("button", { name: "View diff", exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "View diff", exact: true })).toBeVisible();
  await panel.screenshot({ path: "docs/qa/evidence/fo-manager-first/after-expanded-history-en.png" });
});


test("preparation uses task defaults and offers team setup without exposing the technical form", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  await request.post(`${backend.apiBase}/projects`, { headers, data: { path: backend.dataDir, name: "Preparation project" } });
  const response = await request.post(`${backend.apiBase}/tasks`, { headers, data: { title: "Prepare fixture", prompt: "Fixture assignment", workdir: backend.dataDir, isolation: "none", column: "ready", agent: "claude-code", model: "opus", effort: "high" } });
  const task = await response.json();
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openAllTasks(page);
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const panel = page.getByRole("complementary").filter({ has: page.getByTestId("manager-task-summary") });
  const prepared = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/employee-execution/preflight"));
  await panel.getByTestId("manager-task-primary").click();
  expect((await prepared).postDataJSON()).toMatchObject({ taskId: task.id, harnessId: "claude-code", model: "opus", effort: "high" });
  await expect(panel.getByTestId("manager-task-setup")).toContainText("Choose who will do this assignment");
  await expect(panel.getByTestId("manager-task-primary")).toHaveText("Set up project team");
  await expect(panel.getByTestId("manager-task-technical-details")).not.toBeVisible();
  expect(await (await request.get(`${backend.apiBase}/tasks/${task.id}/runs`, { headers })).json()).toEqual([]);
});

test("Stop targets the active reviewer through the existing cancel endpoint", async ({ page, request, freshBackend: backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const response = await request.post(`${backend.apiBase}/tasks`, { headers, data: { title: "Reviewer Stop fixture", prompt: "Fixture assignment", workdir: backend.dataDir, isolation: "none", column: "review" } });
  const task = await response.json();
  const qc = { ...EMPTY_QC_STATE, activeReviewId: "review-to-stop", roundCount: 1 };
  setState(backend, task.id, "review", qc);
  await page.route(`**/tasks/${task.id}/qc`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ json: { state: qc, reviews: [{ id: "review-to-stop", taskId: task.id, status: "running", round: 1, verdict: null, reviewRunId: "reviewer-run-to-stop" }], timeLimitSeconds: null }, headers: { "access-control-allow-origin": "*" } });
  });
  let cancelled = false;
  await page.route("**/runs/reviewer-run-to-stop/cancel", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    cancelled = true;
    await route.fulfill({ json: { cancelled: true, termination: null }, headers: { "access-control-allow-origin": "*" } });
  });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openAllTasks(page);
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await page.getByTestId("manager-task-stop").click();
  await expect.poll(() => cancelled).toBe(true);
});
