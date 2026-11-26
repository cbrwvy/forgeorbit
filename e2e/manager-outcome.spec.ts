import { Database } from "bun:sqlite";
import path from "node:path";
import { test, expect, type E2EBackend, type APIRequestContext } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";
import { EMPTY_QC_STATE } from "../src/shared/task-quality-control";

test.describe.configure({ timeout: 90_000 });

async function seedAcceptance(request: APIRequestContext, backend: E2EBackend, summary: string | null, findings: string[], assignment: string) {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const response = await request.post(`${backend.apiBase}/tasks`, { headers, data: {
    title: "Clamp — acceptance outcome fixture", prompt: assignment, workdir: backend.dataDir, isolation: "none", column: "review",
  } });
  expect(response.ok()).toBeTruthy();
  const task = await response.json();
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.run("INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code) VALUES ('outcome-implementation', ?, 'claude-code', 'succeeded', ?, ?, 0)", [task.id, Date.now() - 2000, Date.now() - 1000]);
    db.run("UPDATE tasks SET qc_state = ? WHERE id = ?", [JSON.stringify({ ...EMPTY_QC_STATE, latestVerdict: "PASS", roundCount: 1, awaitingOwnerApproval: true }), task.id]);
    if (summary !== null) db.run(`INSERT INTO task_quality_reviews (id, task_id, project_path, round, status, verdict, summary, findings_json,
      reviewer_harness, reviewer_model, implementation_run_id, saved_task_json, requested_at, completed_at)
      VALUES ('outcome-review', ?, ?, 1, 'complete', 'PASS', ?, ?, 'claude-code', 'fixture-model', 'outcome-implementation', '{}', ?, ?)`,
      [task.id, backend.dataDir, summary, JSON.stringify(findings.map((text) => ({ severity: "suggestion", text }))), Date.now(), Date.now()]);
  } finally { db.close(); }
  return task;
}

for (const locale of ["en", "ru"] as const) {
  test(`acceptance shows the delivered outcome, observed tests and review notes without Details (${locale})`, async ({ page, request, freshBackend: backend }) => {
    const assignment = locale === "en" ? "Keep numbers within the minimum and maximum values, including at both boundaries." : "Ограничить числа минимальным и максимальным значениями, включая обе границы.";
    const outcome = locale === "en"
      ? "Numbers below the minimum now return the minimum; numbers above the maximum return the maximum. Numbers already within the range stay unchanged."
      : "Числа ниже минимума теперь заменяются минимумом, а числа выше максимума — максимумом. Значения внутри диапазона остаются без изменений.";
    const appendix = locale === "en" ? "Full report: both boundaries and unchanged interior values were checked against the assignment. " : "Полный отчёт: обе границы и значения внутри диапазона проверены по условиям задания. ";
    const fullSummary = outcome + "\n\n" + appendix.repeat(8);
    const findings = locale === "en" ? ["Consider a short usage example.", "Document how an invalid range is handled.", "Add examples of decimal inputs to the guide."]
      : ["Можно добавить короткий пример использования.", "Опишите поведение при неверном диапазоне.", "Добавьте в справку примеры с дробными числами."];
    await request.put(`${backend.apiBase}/preferences/locale`, { headers: { authorization: `Bearer ${backend.apiToken}` }, data: { value: locale } });
    const task = await seedAcceptance(request, backend, fullSummary, findings, assignment);
    // Read-only API fixture for a stored observation bound to this reviewed run and source.
    // No test or provider process is executed to create these counts.
    await page.route(`**/tasks/${task.id}/qc-evidence`, async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {
        taskId: task.id, developerRunId: "outcome-implementation", sourceFingerprint: "clamp-current-fingerprint", observedTestStatus: "observed",
        test: { command: "bun test src/clamp.test.ts", exitCode: 0, stdout: "", stderr: " 3 pass\n 0 fail\n 11 expect() calls\nRan 3 tests across 1 file. [6ms]\n",
          provenance: "forgeorbit-observed-test", sourceFingerprint: "clamp-current-fingerprint", startedAt: 1, executedAt: 2, workspacePath: backend.dataDir, limitation: null },
      } });
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoApp(page, backend.bootBase, { newTaskPinned: false });
    await openAllTasks(page);
    await page.getByRole("button", { name: task.title, exact: true }).click();
    const panel = page.getByRole("complementary").filter({ has: page.getByTestId("manager-task-summary") });
    const delivered = panel.getByTestId("manager-task-outcome");
    await expect(delivered.getByTestId("manager-task-result")).toContainText(outcome);
    await expect(delivered.getByTestId("manager-outcome-tests")).toHaveText(locale === "en" ? "Verified tests: 3 passed · 0 failed" : "Подтверждённые тесты: 3 пройдено · 0 с ошибками");
    await expect(delivered.getByTestId("manager-outcome-findings")).toContainText(findings[0]!);
    await expect(panel.getByTestId("manager-task-technical-details")).not.toBeVisible();
    await expect(panel.getByTestId("manager-task-assignment")).toContainText(assignment);
    await expect(panel.getByTestId("manager-task-primary")).toBeInViewport();
    const outcomeBox = await delivered.boundingBox();
    const buttonBox = await panel.getByTestId("manager-task-primary").boundingBox();
    const assignmentBox = await panel.getByTestId("manager-task-assignment").boundingBox();
    expect(outcomeBox!.y + outcomeBox!.height).toBeLessThan(buttonBox!.y);
    expect(assignmentBox!.y).toBeGreaterThan(buttonBox!.y + buttonBox!.height);
    await panel.screenshot({ path: `docs/qa/evidence/fo-manager-first/acceptance-outcome-${locale}.png` });
    await panel.getByTestId("manager-task-details").click();
    await panel.getByTestId("task-qc-history").scrollIntoViewIfNeeded();
    await expect(panel.getByTestId("task-qc-history").getByText(fullSummary, { exact: true })).toBeAttached();
    await panel.getByTestId("task-qc-findings").getByText(findings[2]!, { exact: true }).scrollIntoViewIfNeeded();
    await expect(panel.getByTestId("task-qc-findings").getByText(findings[2]!, { exact: true })).toBeVisible();
    await expect(panel.getByTestId("manager-task-primary")).toBeInViewport();
  });
}

test("missing summary and evidence are explicit and never become invented counts or findings", async ({ page, request, freshBackend: backend }) => {
  const assignment = "Keep a number inside the requested range.";
  const task = await seedAcceptance(request, backend, null, [], assignment);
  await page.route(`**/tasks/${task.id}/qc-evidence`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {
      taskId: task.id, developerRunId: "outcome-implementation", sourceFingerprint: null, observedTestStatus: "missing", test: null,
    } });
  });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await openAllTasks(page);
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const panel = page.getByRole("complementary").filter({ has: page.getByTestId("manager-task-summary") });
  await expect(panel.getByTestId("manager-task-result")).toHaveText("A delivery summary is unavailable. Check Details before accepting.");
  await expect(panel.getByTestId("manager-outcome-tests")).toHaveCount(0);
  await expect(panel.getByTestId("manager-outcome-findings")).toHaveCount(0);
  await expect(panel.getByTestId("manager-task-primary")).toHaveText("Accept result");
  await expect(panel.getByTestId("manager-task-assignment")).toContainText(assignment);
  await expect(panel.getByTestId("manager-task-technical-details")).not.toBeVisible();
  await panel.screenshot({ path: "docs/qa/evidence/fo-manager-first/acceptance-outcome-fallback.png" });
});
