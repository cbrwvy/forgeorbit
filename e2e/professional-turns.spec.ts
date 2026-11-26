import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page, type Locator } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

async function call(request: APIRequestContext, backend: E2EBackend, method: string, route: string, data?: unknown, expected = 200) {
  const res = await request.fetch(`${backend.apiBase}${route}`, { method, headers: { authorization: `Bearer ${backend.apiToken}` }, data });
  expect(res.status(), await res.text()).toBe(expected);
  return res.json();
}
async function setup(request: APIRequestContext, backend: E2EBackend, agent = "claude-code") {
  await call(request, backend, "PATCH", `/harnesses/${agent}`, { enabled: true });
  const dir = await mkdtemp(path.join(backend.dataDir, "fo014d-browser-project-"));
  await call(request, backend, "POST", "/projects", { path: dir, name: "Professional fixture" });
  const employee = await call(request, backend, "POST", "/employees", { name: "Ada Professional", jobTitle: "Engineer", projectPath: dir }, 201);
  await call(request, backend, "POST", `/employees/${employee.id}/professional-profile`, { catalogRoleSlug: "engineering-backend-architect", promptMarkdown: "# Approved historical revision\nHISTORICAL_PROFILE_MARKER" });
  const task = await call(request, backend, "POST", "/tasks", { title: "Professional runtime task", prompt: "Do approved fixture work", workdir: dir, column: "ready", isolation: "none", agent, model: agent === "codex" ? "gpt-6.1-sol" : "opus", mode: "auto" });
  await call(request, backend, "POST", "/task-assignments", { taskId: task.id, employeeId: employee.id }, 201);
  return { employee, task };
}
async function expand(details: Locator) {
  if (await details.getAttribute("open") === null) await details.locator("summary").first().click();
}
async function openReview(page: Page, backend: E2EBackend, agent = "claude-code") {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Professional runtime task" }).click();
  await expand(page.getByTestId("employee-execution"));
  await page.getByTestId("employee-execution-harness").selectOption(agent);
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toBeVisible();
}

test("Owner reviews each follow-up; three Turns share one Run and frozen professional revision on desktop/mobile", async ({ page, request, freshBackend: backend }, testInfo) => {
  const { employee, task } = await setup(request, backend);
  await openReview(page, backend);
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect.poll(async () => (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0]?.finishedAt).toBeTruthy();
  const attempt = (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0];
  const turnPanel = page.getByTestId("employee-run-status").getByTestId("professional-turns");
  await turnPanel.locator("summary").first().click();
  for (let i = 1; i <= 2; i++) {
    await expect(turnPanel.locator("summary").first()).toContainText("recoverable");
    await turnPanel.getByRole("textbox", { name: "Professional follow-up message" }).fill(`Owner approved message ${i} · Привет 😀`);
    await turnPanel.getByTestId("professional-follow-up").click();
    await expect(turnPanel.getByTestId("professional-turn-reviewed-message")).toHaveText(`Owner approved message ${i} · Привет 😀`);
    await expect(turnPanel.getByTestId("professional-turn-review")).toContainText(attempt.runId);
    await expect(turnPanel.getByTestId("professional-turn-review")).toContainText("professional revision 1");
    await expect(turnPanel.getByTestId("professional-turn-confirm")).toBeDisabled();
    const before = await call(request, backend, "GET", `/employee-execution/runs/${attempt.runId}/turns`);
    expect(before.turns.at(-1).status).toBe("reviewed");
    expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(1);
    if (i === 1) {
      await turnPanel.getByTestId("professional-turn-reviewed-message").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("turn-review-desktop.png"), fullPage: true });
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await turnPanel.getByTestId("professional-turn-reviewed-message").scrollIntoViewIfNeeded();
      await expect(turnPanel.getByTestId("professional-turn-reviewed-message")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("turn-review-mobile.png"), fullPage: true });
      await page.setViewportSize(viewport);
    }
    if (i === 1) await call(request, backend, "PUT", `/employees/${employee.id}/professional-profile`, { expectedRevision: 1, promptMarkdown: "# New active revision\nNOT_THE_RUNNING_CONTEXT" });
    await turnPanel.getByRole("checkbox").check();
    await turnPanel.getByTestId("professional-turn-confirm").click();
    await expect(turnPanel.getByTestId("professional-turn-review")).toHaveCount(0);
    await expect.poll(async () => (await call(request, backend, "GET", `/employee-execution/runs/${attempt.runId}/turns`)).turns.at(-1).status).toBe("included");
    await expect.poll(async () => (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0]?.finishedAt).toBeTruthy();
  }
  const history = await call(request, backend, "GET", `/employee-execution/runs/${attempt.runId}/turns`);
  expect(history.turns.map((t: { turn_number: number }) => t.turn_number)).toEqual([1, 2, 3]);
  expect(history.turns.every((t: { snapshot_sha256: string }) => t.snapshot_sha256 === createHash("sha256").update(JSON.stringify(attempt.professional.binding)).digest("hex"))).toBe(true);
  expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(1);
  const legacy = await call(request, backend, "POST", `/runs/${attempt.runId}/input`, { line: "Unapproved legacy bypass" });
  expect(legacy.delivered).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("turns-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(turnPanel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("turns-mobile.png"), fullPage: true });
});

test("sub-2s follow-up settles automatically with stale parent status and disconnected events; panel reopens offline", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  await openReview(page, backend);
  await page.getByTestId("employee-run-confirm").click();
  const attemptsPath = `/employee-execution/attempts?taskId=${task.id}`;
  await expect.poll(async () => (await call(request, backend, "GET", attemptsPath)).attempts[0]?.finishedAt).toBeTruthy();
  const frozen = await call(request, backend, "GET", attemptsPath);
  const runId = frozen.attempts[0].runId;
  // The parent never sees running. Suppress SSE to prove the missed-event
  // fallback independently from App's lifecycle event fan-out.
  await page.route(`**/employee-execution/attempts?taskId=${task.id}`, route => route.fulfill({ json: frozen }));
  await page.route(/\/events\?token=/, route => route.abort());
  await page.reload();
  await openAllTasks(page);
  await page.getByRole("button", { name: "Professional runtime task" }).click();
  await expand(page.getByTestId("employee-execution"));
  let panel = page.getByTestId("employee-run-status").getByTestId("professional-turns");
  await expand(panel);
  await expect(panel.locator("summary").first()).toContainText("recoverable");
  const turnsPath = `/employee-execution/runs/${runId}/turns`;
  let submitted = false, injected = false, reads = 0, offline = false;
  await page.route("**/employee-execution/turns/*/submit", async route => {
    const response = await route.fetch(); submitted = true;
    await route.fulfill({ response });
  });
  await page.route(`**${turnsPath}`, async route => {
    reads++;
    if (offline) { await route.abort("connectionrefused"); return; }
    const response = await route.fetch();
    if (submitted && !injected) {
      // Deterministically reproduce the GET racing the 20ms fake driver.
      const h = await response.json(); injected = true;
      h.session = { state: "attached", reason: null };
      h.turns.at(-1).observed_run_status = null;
      h.turns.at(-1).observed_run_ended_at = null;
      await route.fulfill({ json: h });
    } else await route.fulfill({ response });
  });
  await panel.getByRole("textbox", { name: "Professional follow-up message" }).fill("Fast approved fixture turn");
  await panel.getByTestId("professional-follow-up").click();
  await panel.getByRole("checkbox").check();
  await panel.getByTestId("professional-turn-confirm").click();
  await expect.poll(() => injected).toBe(true);
  await expect(panel.locator("summary").first()).toContainText("recoverable");
  const h = await call(request, backend, "GET", turnsPath);
  const latest = h.turns.at(-1);
  expect(latest.observed_run_status).toBe("succeeded");
  expect(latest.observed_run_ended_at - latest.submitted_at).toBeLessThan(2000);
  const turn = panel.getByTestId("professional-turn").last();
  await turn.locator("summary").click();
  await expect(turn).toContainText("succeeded");
  expect(frozen.attempts[0].runStatus).toBe("succeeded");
  const oldSnapshot = h.turns[0];
  await page.keyboard.press("Escape");
  const closedReads = reads;
  await page.waitForTimeout(1700);
  expect(reads).toBe(closedReads);
  offline = true;
  const offlineStartReads = reads;
  await page.getByRole("button", { name: "Professional runtime task" }).click();
  await expand(page.getByTestId("employee-execution"));
  panel = page.getByTestId("employee-run-status").getByTestId("professional-turns");
  await expand(panel);
  await expect(panel.getByTestId("professional-turn-error")).toBeVisible();
  await page.waitForTimeout(3200);
  // Mount and explicit expansion may each read once; the shared network
  // layer permits one transport retry per read. Neither recurs on error.
  expect(reads - offlineStartReads).toBeLessThanOrEqual(4);
  const failedReads = reads;
  await page.waitForTimeout(1700);
  expect(reads).toBe(failedReads);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  offline = false;
  await page.getByRole("button", { name: "Professional runtime task" }).click();
  await expand(page.getByTestId("employee-execution"));
  panel = page.getByTestId("employee-run-status").getByTestId("professional-turns");
  await expand(panel);
  await expect(panel.locator("summary").first()).toContainText("recoverable");
  expect((await call(request, backend, "GET", turnsPath)).turns[0]).toEqual(oldSnapshot);
  // Reopening the native details also refreshes after a failed read,
  // even when the task itself stays mounted.
  await panel.locator("summary").first().click();
  offline = true;
  await expand(panel);
  await expect(panel.getByTestId("professional-turn-error")).toBeVisible();
  await panel.locator("summary").first().click();
  offline = false;
  await expand(panel);
  await expect(panel.getByTestId("professional-turn-error")).toHaveCount(0);
});

test.describe("ordinary long background turn", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "3200" } });
  test("run-local lifecycle events and fallback refresh a long follow-up", async ({ page, request, freshBackend: backend }) => {
    const { task } = await setup(request, backend, "codex");
    await openReview(page, backend, "codex");
    await page.getByTestId("employee-run-confirm").click();
    await expect.poll(async () => (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0]?.finishedAt).toBeTruthy();
    const attempt = (await call(request, backend, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0];
    const turnsPath = `/employee-execution/runs/${attempt.runId}/turns`;
    const before = await call(request, backend, "GET", turnsPath);
    const panel = page.getByTestId("employee-run-status").getByTestId("professional-turns");
    await panel.locator("summary").first().click();
    await expect(panel.locator("summary").first()).toContainText("recoverable");
    await panel.getByRole("textbox", { name: "Professional follow-up message" }).fill("Approved long fixture turn");
    await panel.getByTestId("professional-follow-up").click();
    await panel.getByRole("checkbox").check();
    await panel.getByTestId("professional-turn-confirm").click();
    await expect(panel.getByTestId("professional-turn-review")).toHaveCount(0);
    const latest = panel.getByTestId("professional-turn").last();
    await latest.locator("summary").click();
    await expect(latest).toContainText("Unknown");
    await expect(latest).toContainText("succeeded");
    await expect(panel.locator("summary").first()).toContainText("recoverable");
    const after = await call(request, backend, "GET", turnsPath);
    expect(after.turns[0]).toEqual(before.turns[0]);
    expect(after.turns.at(-1).observed_run_ended_at - after.turns.at(-1).submitted_at).toBeGreaterThanOrEqual(3000);
    expect(await call(request, backend, "GET", `/tasks/${task.id}/runs`)).toHaveLength(1);
  });
});
