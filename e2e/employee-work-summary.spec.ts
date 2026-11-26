import { test, expect, api, registerProject, sql } from "./organization-acceptance-fixture";
import { gotoApp } from "./helpers";

/**
 * Direction 2: the employee profile's recorded work. Offline, fake drivers, disposable backend. One worker has one
 * accepted run and one run whose review asked for changes; a second worker has no run at all. The profile must
 * say what the records establish and nothing more, in English and Russian, at 1280x720.
 */
test.use({ viewport: { width: 1280, height: 720 } });

async function finishedRun(request: any, b: any, dir: string, employeeId: string, title: string) {
  const task = await api(request, b, "POST", "/tasks", { title, prompt: "Write a fixture note.", workdir: dir, column: "ready", isolation: "none", agent: "claude-code", model: "opus-5.5" });
  await api(request, b, "POST", "/task-assignments", { taskId: task.id, employeeId }, 201);
  const review = await api(request, b, "POST", "/employee-execution/reviews", { taskId: task.id, harnessId: "claude-code" });
  expect(review.blockingErrors).toEqual([]);
  const attempt = review.attempt;
  await api(request, b, "POST", `/employee-execution/attempts/${attempt.id}/start`, { revision: attempt.revision, confirm: true, acknowledgeUsage: true });
  await expect.poll(async () => (await api(request, b, "GET", `/employee-execution/attempts/${attempt.id}`)).attempt.phase, { timeout: 20_000 }).toBe("completed");
  await expect.poll(async () => (await api(request, b, "GET", `/tasks/${task.id}`)).column, { timeout: 20_000 }).toBe("review");
  return task;
}

async function review(request: any, b: any, taskId: string) {
  const prep = await api(request, b, "POST", `/tasks/${taskId}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  await api(request, b, "POST", `/tasks/${taskId}/qc/reviews/${prep.review.id}/start`, {});
  await expect.poll(async () => (await api(request, b, "GET", `/tasks/${taskId}`)).qcState?.latestVerdict, { timeout: 30_000 }).not.toBeNull();
}

test("profile shows accepted work, the PASS/acceptance split, Unknown cost and an empty state, in EN and RU", async ({ page, request, companyBackend: b }) => {
  test.setTimeout(120_000);
  const dir = await registerProject(request, b, "Summary project");
  const busy = await api(request, b, "POST", "/employees", { name: "Busy Worker", jobTitle: "Engineer", projectPath: dir }, 201);
  const idle = await api(request, b, "POST", "/employees", { name: "Idle Worker", jobTitle: "Engineer", projectPath: dir }, 201);

  const accepted = await finishedRun(request, b, dir, busy.id, "Accepted task");
  await review(request, b, accepted.id); // fake driver answers PASS
  await api(request, b, "PATCH", `/tasks/${accepted.id}`, { column: "done" });
  const waiting = await finishedRun(request, b, dir, busy.id, "Passed, waiting for the Owner");
  await review(request, b, waiting.id);

  const summary = (await api(request, b, "GET", `/employee-execution/summary?employeeId=${busy.id}`)).summary;
  expect(summary).toMatchObject({ runsStarted: 2, ownerAccepted: 1, awaitingOwner: 1, quality: null });
  expect(summary.review.passed).toBe(2);
  expect(summary.cost.lines).toEqual([]); // fixture runs carry no billing evidence
  expect(sql(b, "SELECT COUNT(*) AS n FROM runs")[0].n).toBe(4); // two developer runs, two reviews: the summary started nothing

  await gotoApp(page, b.bootBase);
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  const open = async (name: string) => {
    await page.getByTestId("staff-row").filter({ hasText: name }).click();
    await expect(page.getByTestId("employee-work-summary")).toBeVisible();
  };

  await open("Busy Worker");
  const card = page.getByTestId("employee-work-summary");
  await expect(page.getByTestId("work-summary-runs-started-value")).toHaveText("2");
  await expect(page.getByTestId("work-summary-review-pass-value")).toHaveText("2");
  await expect(page.getByTestId("work-summary-owner-accepted-value")).toHaveText("1");
  await expect(page.getByTestId("work-summary-awaiting-owner-value")).toHaveText("1");
  await expect(page.getByTestId("work-summary-cost-unknown")).toContainText("Unknown for 2 run(s)");
  await expect(page.getByTestId("work-summary-quality-value")).toContainText("Unknown");
  await expect(card).not.toContainText(/\$\s?0|0\.00|free/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await card.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("work-summary-quality-value")).toBeInViewport();

  // Russian, live: same numbers, translated labels, no English leftovers from this section.
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(card).toContainText("Зафиксированная работа");
  await expect(card).toContainText("Принято владельцем");
  await expect(page.getByTestId("work-summary-cost-unknown")).toContainText("Неизвестно для запусков: 2");
  await expect(card).not.toContainText(/Recorded work|Accepted by the Owner|Unknown for/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  // An employee with no run: an empty state, no zero cost and no rating.
  await page.getByRole("button", { name: /^(Back|Назад)$/ }).first().click();
  await open("Idle Worker");
  await expect(page.getByTestId("work-summary-empty")).toBeVisible();
  await expect(page.getByTestId("work-summary-body")).toHaveCount(0);
  await expect(page.getByTestId("employee-work-summary")).not.toContainText(/\$\s?0|0\.00|rating: \d/i);
});
