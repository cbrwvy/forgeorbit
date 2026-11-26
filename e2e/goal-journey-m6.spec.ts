import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";
import type { Task, TaskQcReview, TaskQcState } from "../src/shared/types.ts";

/**
 * FO-UX-SIMPLIFY02-M6: one project-scoped path from a goal to an accepted result, driven only
 * through the UI. Every agent is a fake driver (no provider, no quota). The model's answer for
 * the goal is a deterministic fixture (`__fake_head_board__ {json}`). Only infrastructure is
 * seeded: projects, one specialist and the Head's agent configuration. No plan, approval,
 * assignment, run, quality check or acceptance is seeded.
 */

test.describe.configure({ mode: "serial", timeout: 150_000 });
test.use({ backendEnv: { AGETOR_FAKE_QC_VERDICT: "PASS", AGETOR_FAKE_PORTFOLIO_DELAY_MS: "200" } });

const GOAL = { kind: "create", title: "Add a health endpoint", description: "Add GET /health that answers ok. Acceptance: it answers 200." };
const GOAL_TEXT = `__fake_head_board__ ${JSON.stringify(GOAL)}`;

function headers(b: E2EBackend) {
  return { authorization: `Bearer ${b.apiToken}` };
}

async function call<T>(request: APIRequestContext, b: E2EBackend, method: string, route: string, data?: unknown, status = 200): Promise<T> {
  const response = await request.fetch(b.apiBase + route, { method, data, headers: headers(b) });
  const body = await response.text();
  expect(response.status(), `${method} ${route}: ${body}`).toBe(status);
  return (body ? JSON.parse(body) : null) as T;
}

async function seed(request: APIRequestContext, b: E2EBackend) {
  const alpha = path.join(b.dataDir, "Alpha");
  const beta = path.join(b.dataDir, "Beta");
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  await call(request, b, "POST", "/projects", { path: alpha, name: "Project Alpha" });
  await call(request, b, "POST", "/projects", { path: beta, name: "Project Beta" });
  const worker = await call<{ id: string; name: string }>(request, b, "POST", "/employees", { projectPath: alpha, name: "Ada", jobTitle: "Backend Engineer" }, 201);
  await call(request, b, "PATCH", "/harnesses/codex", { enabled: true });
  const preflight = await call<{ isolation: { consentKey: string } }>(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call(request, b, "PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey } });
  return { alpha, beta, worker };
}

/** Non-GET requests the page makes, to prove opening, linking and refreshing mutate nothing. */
function recordWrites(page: Page): { all: () => string[]; since: (mark: number) => string[]; mark: () => number } {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return;
    const url = new URL(req.url());
    // UI preferences/drafts, the unread marker an opened task panel sets and the read-only project
    // discovery a project page asks for are not project state.
    if (url.pathname.startsWith("/preferences/") || url.pathname === "/projects/discover" || /^\/tasks\/[^/]+\/seen$/.test(url.pathname)) return;
    writes.push(`${req.method()} ${url.pathname}`);
  });
  return { all: () => writes, since: (mark) => writes.slice(mark), mark: () => writes.length };
}

const tasksIn = async (request: APIRequestContext, b: E2EBackend, dir: string) =>
  (await call<Task[]>(request, b, "GET", "/tasks")).filter((task) => task.workdir === dir);

async function openProjectPlan(page: Page, dir: string) {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await page.getByTestId("manager-tab-plan").click();
  await expect(page.getByTestId("manager-plan-section")).toBeVisible();
}

/** Home → explicit target → Head of PM for that project → goal → plan card. Sends one message. */
async function giveGoal(page: Page, dir: string, text = GOAL_TEXT) {
  await expect(page.getByTestId("global-overview")).toBeVisible();
  await expect(page.getByTestId("home-ask-head")).toBeDisabled();
  await expect(page.getByTestId("home-goal-target-hint")).toBeVisible();
  await page.getByTestId("home-goal-target").selectOption({ label: "Project Alpha" });
  await expect(page.getByTestId("home-ask-head")).toBeEnabled();
  await page.getByTestId("home-ask-head").click();
  await expect(page.getByTestId("head-pm-panel")).toBeVisible();
  await expect(page.getByTestId("head-pm-scope")).toHaveValue(`project:${dir}`);
  await page.getByTestId("head-pm-composer").fill(text);
  await page.getByTestId("head-pm-send").click();
  const card = page.getByTestId("head-pm-board-proposal").last();
  await expect(card).toHaveAttribute("data-status", "pending", { timeout: 20_000 });
  return card;
}

/** The task panel's own steps, exactly as the existing workflow offers them. */
async function admitAssignAndRun(page: Page, request: APIRequestContext, b: E2EBackend, taskId: string, workerName: string) {
  const row = page.locator(`[data-testid="goal-journey-row"][data-task-id="${taskId}"]`);
  await row.getByTestId("goal-journey-open").click();
  await page.getByTestId("supervised-live-admit").click();
  await expect.poll(async () => (await call<Task>(request, b, "GET", `/tasks/${taskId}`)).column).toBe("inbox");
  await page.getByTestId("supervised-live-ready").click();
  await expect.poll(async () => (await call<Task>(request, b, "GET", `/tasks/${taskId}`)).column).toBe("ready");
  const assignment = page.getByTestId("task-assignment-panel");
  await assignment.getByTestId("task-assignment-pick").selectOption({ label: workerName });
  await assignment.getByTestId("task-assignment-save").click();
  await expect(assignment.getByTestId("task-assignment-current")).toContainText(workerName);
  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("opus-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  // Preparing started nothing.
  expect(await call<unknown[]>(request, b, "GET", `/tasks/${taskId}/runs`)).toEqual([]);
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-worker")).toHaveText(workerName);
  expect(await call<unknown[]>(request, b, "GET", `/tasks/${taskId}/runs`)).toEqual([]);
  if (await page.getByTestId("employee-run-usage").count()) await page.getByTestId("employee-run-usage").getByRole("checkbox").check();
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect.poll(async () => (await call<Task>(request, b, "GET", `/tasks/${taskId}`)).column, { timeout: 40_000 }).toBe("review");
}

async function closeTaskPanel(page: Page) {
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await expect(page.getByTestId("supervised-live-workflow")).toHaveCount(0);
}

test("goal → plan → approve → run → quality check → explicit acceptance", async ({ page, request, freshBackend: b }, info) => {
  const { alpha, beta, worker } = await seed(request, b);
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  const writes = recordWrites(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // 1. Give a goal. Home forces an explicit target; opening the chat sends nothing.
  const card = await giveGoal(page, alpha);
  expect(writes.all().filter((w) => w.startsWith("POST /portfolio-manager/messages"))).toHaveLength(1);

  // 2. Review the plan. The persisted card names what approving does and nothing exists yet.
  await expect(card).toContainText("Add a health endpoint");
  await expect(card).toContainText("Add GET /health that answers ok");
  expect(await tasksIn(request, b, alpha)).toEqual([]);
  const beforeReload = writes.mark();
  await page.reload();
  await page.getByTestId("head-pm-orb").click();
  await expect(page.getByTestId("head-pm-board-proposal").last()).toHaveAttribute("data-status", "pending");
  // A refresh repeats nothing and changes nothing.
  expect(writes.since(beforeReload)).toEqual([]);
  expect(await tasksIn(request, b, alpha)).toEqual([]);

  // 3. Approve. This adds the task to the Backlog and starts nothing.
  await page.getByTestId("head-pm-board-approve").last().click();
  const applied = page.getByTestId("head-pm-board-proposal").last();
  await expect(applied).toHaveAttribute("data-status", "applied", { timeout: 20_000 });
  const [task] = await tasksIn(request, b, alpha);
  expect(task).toMatchObject({ title: GOAL.title, column: "backlog" });
  expect(await call<unknown[]>(request, b, "GET", `/tasks/${task!.id}/runs`)).toEqual([]);
  // The same record answers "where is it now" right under the approval, with the next step in words.
  const inCard = applied.getByTestId("goal-journey-row");
  await expect(inCard).toHaveAttribute("data-phase", "backlog-draft");
  await expect(inCard).toHaveAttribute("data-qc", "not-run");
  await expect(inCard.getByTestId("goal-journey-stage")).toHaveText("In the Backlog — not started");
  await expect(inCard.getByTestId("goal-journey-next")).toContainText("admit it to the project inbox");
  await expect(inCard.getByTestId("goal-journey-accept")).toHaveCount(0);
  await page.getByTestId("head-pm-close").click();

  // 4. Follow it from the project's Plan and Execution page: the same task, same stage.
  await openProjectPlan(page, alpha);
  const row = page.locator(`[data-testid="goal-journey-row"][data-task-id="${task!.id}"]`);
  await expect(row).toHaveAttribute("data-phase", "backlog-draft");
  await expect(row.getByTestId("goal-journey-title")).toHaveText(GOAL.title);
  // Another project shows none of it.
  await expect(page.getByTestId("goal-journey-row")).toHaveCount(1);

  // 5. Admit, assign, prepare and confirm the run through the existing task panel steps.
  await admitAssignAndRun(page, request, b, task!.id, worker.name);
  await closeTaskPanel(page);

  // 6. Finished is not accepted, and no quality check has run: the page says exactly that.
  await expect(row).toHaveAttribute("data-phase", "awaiting-qc", { timeout: 20_000 });
  await expect(row).toHaveAttribute("data-qc", "not-run");
  await expect(row.getByTestId("goal-journey-qc")).toHaveText("Not run");
  await expect(row.getByTestId("goal-journey-stage")).toHaveText("Finished — waiting for a quality check");
  await expect(row.getByTestId("goal-journey-accept")).toHaveCount(0);

  // 7. Request the quality check from the task, as the existing flow does.
  await row.getByTestId("goal-journey-open").click();
  await page.getByTestId("task-qc-reviewer-harness").selectOption("claude-code");
  await page.getByTestId("task-qc-reviewer-model").fill("haiku-5.5");
  await page.getByTestId("task-qc-request").click();
  await expect.poll(async () => (await call<{ state: TaskQcState }>(request, b, "GET", `/tasks/${task!.id}/qc`)).state.latestVerdict, { timeout: 40_000 }).toBe("PASS");
  await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
  await closeTaskPanel(page);

  // 8. QC PASS is not acceptance: the task is still in Review and Accept is the Owner's call.
  expect((await call<Task>(request, b, "GET", `/tasks/${task!.id}`)).column).toBe("review");
  await expect(row).toHaveAttribute("data-phase", "awaiting-owner-acceptance", { timeout: 20_000 });
  await expect(row).toHaveAttribute("data-qc", "passed");
  await expect(row).toHaveAttribute("data-needs-you", "true");
  await expect(row.getByTestId("goal-journey-qc")).toHaveText("Passed");
  await expect(row.getByTestId("goal-journey-accept-note")).toContainText("not your acceptance");
  const qc = await call<{ reviews: TaskQcReview[] }>(request, b, "GET", `/tasks/${task!.id}/qc`);
  expect(qc.reviews).toHaveLength(1);
  expect(qc.reviews[0]).toMatchObject({ verdict: "PASS", projectPath: alpha });

  // The same waiting item is in Home's attention feed (no second notification is made).
  await page.getByTestId("workspace-overview").click();
  await expect(page.getByTestId("home-attention-row").filter({ hasText: GOAL.title })).toHaveCount(1);
  await openProjectPlan(page, alpha);
  await page.screenshot({ path: info.outputPath("awaiting-acceptance.png") });

  // 9. Evidence is one click away, and looking at it changes nothing.
  const beforeEvidence = writes.mark();
  await row.getByTestId("goal-journey-open").click();
  await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
  expect(writes.since(beforeEvidence)).toEqual([]);
  await closeTaskPanel(page);
  expect((await call<Task>(request, b, "GET", `/tasks/${task!.id}`)).column).toBe("review");

  // 10. Accept result — the Owner's explicit click, the same board move the task panel makes.
  await row.getByTestId("goal-journey-accept").click();
  await expect.poll(async () => (await call<Task>(request, b, "GET", `/tasks/${task!.id}`)).column).toBe("done");
  await expect(row).toHaveAttribute("data-phase", "done");
  await expect(row.getByTestId("goal-journey-stage")).toHaveText("Accepted");
  await expect(row.getByTestId("goal-journey-accept")).toHaveCount(0);

  // Scope: nothing leaked into the other project, and only one start was ever made.
  expect(await tasksIn(request, b, beta)).toEqual([]);
  expect(writes.all().filter((w) => /\/tasks\/[^/]+\/start$/.test(w))).toEqual([]);
  expect(errors).toEqual([]);
});

test("a rejected plan creates nothing and starts nothing; a refresh repeats nothing", async ({ page, request, freshBackend: b }) => {
  const { alpha } = await seed(request, b);
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  const writes = recordWrites(page);

  const card = await giveGoal(page, alpha);
  await card.getByTestId("head-pm-board-reject").click();
  await expect(page.getByTestId("head-pm-board-proposal").last()).toHaveAttribute("data-status", "rejected", { timeout: 20_000 });
  expect(await tasksIn(request, b, alpha)).toEqual([]);
  const mark = writes.mark();
  await page.reload();
  await page.getByTestId("head-pm-orb").click();
  await expect(page.getByTestId("head-pm-board-proposal").last()).toHaveAttribute("data-status", "rejected");
  expect(writes.since(mark)).toEqual([]);
  expect(await tasksIn(request, b, alpha)).toEqual([]);
  expect(writes.all().filter((w) => /\/(start|approve)$/.test(w))).toEqual([]);
  await expect(page.getByTestId("goal-journey-row")).toHaveCount(0);
});

test.describe("a failed quality check", () => {
  test.use({ backendEnv: { AGETOR_FAKE_QC_VERDICT: "CHANGES_REQUESTED", AGETOR_FAKE_PORTFOLIO_DELAY_MS: "200" } });

  test("is shown as failed and never offers Accept result", async ({ page, request, freshBackend: b }) => {
    const { alpha, worker } = await seed(request, b);
    await gotoApp(page, b.bootBase, { newTaskPinned: false });
    const card = await giveGoal(page, alpha);
    await card.getByTestId("head-pm-board-approve").click();
    await expect(page.getByTestId("head-pm-board-proposal").last()).toHaveAttribute("data-status", "applied", { timeout: 20_000 });
    const [task] = await tasksIn(request, b, alpha);
    await page.getByTestId("head-pm-close").click();
    await openProjectPlan(page, alpha);
    await admitAssignAndRun(page, request, b, task!.id, worker.name);
    await page.getByTestId("task-qc-reviewer-harness").selectOption("claude-code");
    await page.getByTestId("task-qc-reviewer-model").fill("haiku-5.5");
    await page.getByTestId("task-qc-request").click();
    await expect.poll(async () => (await call<{ state: TaskQcState }>(request, b, "GET", `/tasks/${task!.id}/qc`)).state.latestVerdict, { timeout: 40_000 }).toBe("CHANGES_REQUESTED");
    await closeTaskPanel(page);
    const row = page.locator(`[data-testid="goal-journey-row"][data-task-id="${task!.id}"]`);
    await expect(row).toHaveAttribute("data-qc", "failed", { timeout: 20_000 });
    await expect(row.getByTestId("goal-journey-qc")).toHaveText("Failed — changes requested");
    await expect(row.getByTestId("goal-journey-accept")).toHaveCount(0);
    expect((await call<Task>(request, b, "GET", `/tasks/${task!.id}`)).column).not.toBe("done");
  });
});

test("a pending project plan is listed on Home and in Head of PM; opening it approves and starts nothing", async ({ page, request, freshBackend: b }) => {
  const { alpha, beta } = await seed(request, b);
  // The project manager's own fake answer is the plan fixture (a pending proposal, no tasks yet).
  const preflight = await call<{ isolation: { consentKey: string } }>(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call(request, b, "PUT", "/project-manager/config", { path: alpha, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey } });
  await call(request, b, "POST", "/project-manager/messages", { path: alpha, text: "Break user authentication into tasks" }, 202);
  await expect.poll(async () => (await call<{ proposals: { status: string }[] }>(request, b, "GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).proposals.map((p) => p.status), { timeout: 30_000 }).toEqual(["pending"]);

  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  const writes = recordWrites(page);
  // Home lists the plan with its project and says approving only fills the Backlog.
  const plans = page.getByTestId("home-plans");
  await expect(plans.getByTestId("plans-waiting-row")).toHaveCount(1);
  await expect(plans.getByTestId("plans-waiting-row")).toHaveAttribute("data-path", alpha);
  await expect(plans).toContainText("Project Alpha");
  await expect(plans).toContainText("Nothing starts until you start it");

  // The Head of PM panel for that project lists the same plan; the other project's panel does not.
  await page.getByTestId("home-goal-target").selectOption({ label: "Project Beta" });
  await page.getByTestId("home-ask-head").click();
  await expect(page.getByTestId("head-pm-scope")).toHaveValue(`project:${beta}`);
  await expect(page.getByTestId("head-pm-panel").getByTestId("plans-waiting")).toHaveCount(0);
  await page.getByTestId("head-pm-scope").selectOption({ label: "Project Alpha" });
  await expect(page.getByTestId("head-pm-panel").getByTestId("plans-waiting-row")).toHaveCount(1);

  // Review plan opens the card where it is decided — the same persisted record.
  await page.getByTestId("head-pm-panel").getByTestId("plans-waiting-review").click();
  await expect(page.getByTestId("manager-inbox-section")).toBeVisible();
  const proposal = page.getByTestId("manager-proposal");
  await expect(proposal).toHaveAttribute("data-status", "pending");
  await expect(proposal.getByTestId("manager-proposal-item")).toHaveCount(5);
  await expect(proposal.getByTestId("manager-proposal-summary")).toContainText("No agent is started");
  expect(writes.all()).toEqual([]);
  expect(await tasksIn(request, b, alpha)).toEqual([]);
});

for (const locale of ["en", "ru"] as const) {
  test(`goal path reads in ${locale} and fits at 800 px`, async ({ page, request, freshBackend: b }, info) => {
    const { alpha } = await seed(request, b);
    await putPreference(request, b, "locale", locale);
    // A task that needs the Owner, for a second row in the list (layout only).
    await call(request, b, "POST", "/tasks", { title: "Fix the login redirect", prompt: "Fix it", workdir: alpha, isolation: "none", column: "blocked" });
    await page.setViewportSize({ width: 800, height: 800 });
    await gotoApp(page, b.bootBase, { newTaskPinned: false });
    const noOverflow = async (testId: string) => {
      const fits = await page.getByTestId(testId).first().evaluate((el) => el.scrollWidth - el.clientWidth <= 1);
      expect(fits, `${locale}: ${testId} overflows`).toBe(true);
    };
    const pageFits = async (label: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${locale}: ${label} scrolls sideways`).toBe(true);
    };

    await expect(page.getByTestId("home-goal-target")).toBeVisible();
    await pageFits("home");
    await page.getByTestId("home-goal-target").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`home-${locale}.png`) });
    await page.getByTestId("home-goal-target").selectOption({ label: "Project Alpha" });
    await page.getByTestId("home-ask-head").click();
    await page.getByTestId("head-pm-composer").fill(GOAL_TEXT);
    await page.getByTestId("head-pm-send").click();
    const card = page.getByTestId("head-pm-board-proposal").last();
    await expect(card).toHaveAttribute("data-status", "pending", { timeout: 20_000 });
    await card.getByTestId("head-pm-board-approve").click();
    await expect(card).toHaveAttribute("data-status", "applied", { timeout: 20_000 });
    const inCard = card.getByTestId("goal-journey-row");
    await expect(inCard).toHaveAttribute("data-phase", "backlog-draft");
    await expect(inCard.getByTestId("goal-journey-stage")).toHaveText(locale === "ru" ? "В Бэклоге — не начата" : "In the Backlog — not started");
    await noOverflow("head-pm-panel");
    await page.screenshot({ path: info.outputPath(`head-${locale}.png`) });
    await page.getByTestId("head-pm-close").click();

    await openProjectPlan(page, alpha);
    await expect(page.getByTestId("goal-journey-row")).toHaveCount(2);
    // Needs-you first.
    await expect(page.getByTestId("goal-journey-row").first()).toHaveAttribute("data-needs-you", "true");
    await expect(page.getByTestId("goal-journey-row").first().getByTestId("goal-journey-stage")).toHaveText(locale === "ru" ? "Заблокирована — нужны вы" : "Blocked — needs you");
    await noOverflow("goal-journey");
    await pageFits("plan page");
    await page.screenshot({ path: info.outputPath(`plan-${locale}.png`) });
  });
}
