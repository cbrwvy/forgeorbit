import path from "node:path";
import { Database } from "bun:sqlite";
import { test, expect, api, sql, registerProject, projectPage } from "./organization-acceptance-fixture";
import { gotoApp } from "./helpers";
import { AccountCore } from "../src/bun/account-core.ts";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * FO-MVP-E2E01. One offline Owner path from a PM-created task through an
 * explicit harness/model choice, one canonical Run, a follow-up Turn, the
 * journal and a restart. Fake drivers only. Verified exhaustion is written
 * with the existing trusted-observation writer; no quota adapter is registered.
 */

test.use({
  actionTimeout: 12_000,
  companyEnv: { AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "800" },
});

const scope = (dir: string) => `projectPath=${encodeURIComponent(dir)}`;

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 20_000): Promise<T> {
  let value = await read();
  await expect.poll(async () => {
    value = await read();
    return ready(value);
  }, { timeout }).toBe(true);
  return value;
}

async function boardColumn(page: Page, title: string): Promise<string> {
  const card = page.locator('[data-testid="task-card"]').filter({ has: page.getByText(title, { exact: true }) });
  await expect(card).toBeVisible();
  return (await card.locator("xpath=ancestor::div[contains(@class,'glass-column')][1]").locator("h2").innerText()).trim().toLowerCase();
}

async function openTask(page: Page, dir: string, title: string) {
  await projectPage(page, dir, "board");
  await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(title, { exact: true }) }).click();
}

function seedVerifiedExhaustion(dataDir: string) {
  const database = new Database(path.join(dataDir, "agetor.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  try {
    const core = new AccountCore(database);
    const account = core.createAccount({ provider: "anthropic", displayName: "Synthetic exhaustion" });
    core.bindHarness(account.id, "claude-code");
    const expiresAt = Date.now() + 60_000;
    core.setModelCapability(account.id, "claude-code", "opus-5.5", { support: "supported", expiresAt });
    core.setModelCapability(account.id, "claude-code", "sonnet-5.5", { support: "supported", expiresAt });
    const quota = core.createDefinition({
      accountId: account.id, subscriptionId: null, scope: "model:opus-5.5", unit: { kind: "requests" }, window: "week",
    });
    core.recordTrustedObservations("anthropic-admin", [{
      quotaId: quota.id,
      values: { remaining: 0, limit: 1, used: 1, expiresAt },
      evidence: {
        provider: "anthropic", accountId: account.id, subject: "synthetic-subject", method: "provider-account",
        sourceId: "anthropic-admin", officialUrl: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api",
        checkedAt: "2026-10-28", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic acceptance evidence",
      },
    }]);
    return quota.id;
  } finally {
    database.close();
  }
}

test("PM task, explicit Owner model, one Run, Turn, journal, kanban and restart", async ({ page, request, companyBackend: b }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  page.on("request", (req) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });

  const dir = await registerProject(request, b, "Manual Route");
  await api(request, b, "POST", "/employees/project-managers", { projectPath: dir }, 201);
  await api(request, b, "PATCH", "/harnesses/codex", { enabled: true });
  await api(request, b, "PATCH", "/harnesses/claude-code", { enabled: true });
  const managerPreflight = await api(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  await api(request, b, "PUT", "/project-manager/config", {
    path: dir,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: managerPreflight.isolation.consentKey },
  });

  await api(request, b, "POST", "/project-manager/messages", { path: dir, text: "Split this project into tasks" }, 202);
  const proposed = await until(
    () => api(request, b, "GET", `/project-manager?path=${encodeURIComponent(dir)}`),
    (state) => state.proposals?.some((item: { status: string }) => item.status === "pending"),
  );
  expect(await api(request, b, "GET", "/tasks")).toEqual([]);
  const proposal = proposed.proposals.find((item: { status: string }) => item.status === "pending");

  await gotoApp(page, b.bootBase);
  await projectPage(page, dir, "manager");
  const proposalCard = page.getByTestId("manager-proposal");
  await expect(proposalCard).toHaveAttribute("data-status", "pending");
  await proposalCard.getByTestId("manager-proposal-approve").click();
  await expect(proposalCard).toHaveAttribute("data-status", "approved");
  const created = await api(request, b, "GET", "/tasks");
  expect(created.length).toBeGreaterThan(0);
  expect(created.every((task: { workdir: string; isolation: string }) => task.workdir === dir && task.isolation === "none")).toBe(true);
  expect(sql(b, "SELECT id FROM runs")).toEqual([]);

  const worker = await api(request, b, "POST", "/employees", { name: "Nora Route", jobTitle: "QA Engineer", projectPath: dir }, 201);
  await api(request, b, "POST", `/employees/${worker.id}/professional-profile`, { catalogRoleSlug: "engineering-frontend-developer" });
  await api(request, b, "POST", "/project-manager/messages", { path: dir, text: "Assign the open task to a worker" }, 202);
  const assignmentState = await until(
    () => api(request, b, "GET", `/assignment-proposals?${scope(dir)}`),
    (state) => state.proposals?.length === 1,
  );
  expect(assignmentState.proposals[0].status).toBe("pending");
  expect((await api(request, b, "GET", `/task-assignments/task?taskId=${assignmentState.proposals[0].taskId}`)).assignment).toBeNull();
  const task = created.find((item: { id: string }) => item.id === assignmentState.proposals[0].taskId);
  expect(task).toBeTruthy();

  await page.reload();
  await projectPage(page, dir, "manager");
  const assignmentCard = page.getByTestId("assignment-proposal");
  await expect(assignmentCard).toBeVisible();
  await assignmentCard.getByTestId("assignment-proposal-approve").click();
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was started");
  const { assignment } = await api(request, b, "GET", `/task-assignments/task?taskId=${task.id}`);
  expect(assignment.employeeId).toBe(worker.id);
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);

  // A PM execution suggestion is not the Owner manual-selection exception.
  const beforeExecute = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(dir)}`);
  const managerCount = beforeExecute.messages.filter((message: { role: string }) => message.role === "manager").length;
  await api(request, b, "POST", "/project-manager/messages", { path: dir, text: "Please execute __fake_pm_exec_other__" }, 202);
  await until(
    () => api(request, b, "GET", `/project-manager?path=${encodeURIComponent(dir)}`),
    (state) => state.activeTurn == null && state.messages.filter((message: { role: string }) => message.role === "manager").length > managerCount,
  );
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);
  expect((await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts).toEqual([]);

  const missingStart = await request.post(`${b.apiBase}/employee-execution/attempts/missing-attempt/start`, {
    headers: { authorization: `Bearer ${b.apiToken}` },
    data: { revision: 1, confirm: true },
  });
  expect(missingStart.status()).toBe(404);

  // A fresh manual zero is still Unknown. It is not a verified prohibition and it is not Available.
  const account = await api(request, b, "POST", "/account-core/accounts", { provider: "anthropic", displayName: "Synthetic manual" }, 201);
  await api(request, b, "POST", `/account-core/accounts/${account.id}/harnesses`, { harnessId: "claude-code" }, 201);
  const profile = await api(request, b, "POST", "/agent-profiles", { name: "Manual Route Sonnet", harness: "claude-code", model: "sonnet-5.5" });
  await api(request, b, "POST", `/account-core/accounts/${account.id}/profiles`, { profileId: profile.id }, 201);
  const manualQuota = await api(request, b, "POST", "/account-core/quotas", {
    accountId: account.id, subscriptionId: null, scope: "model:sonnet-5.5", unit: { kind: "requests" }, window: "week",
  }, 201);
  await api(request, b, "POST", `/account-core/quotas/${manualQuota.id}/observations`, {
    remaining: 0, limit: 1, used: 1, expiresAt: Date.now() + 60_000,
  }, 201);
  const observationsBefore = sql(b, "SELECT id FROM quota_observations").length;

  await projectPage(page, dir, "board");
  expect(await boardColumn(page, task.title)).toBe("backlog");
  await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
  const router = page.getByTestId("ai-resource-recommendation");
  await router.locator(":scope > summary").click();
  await router.getByTestId("find-ai-resource").click();
  await expect(router.getByTestId("router-no-verified")).toBeVisible();
  await expect(router.getByTestId("router-verified")).toHaveCount(0);
  await expect(router).not.toContainText(/\bAvailable\b/);
  expect(sql(b, "SELECT id FROM quota_observations")).toHaveLength(observationsBefore);
  expect(sql(b, "SELECT id FROM runs")).toEqual([]);

  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await expect(execution).toContainText("explicit Owner choice");
  await expect(execution).toContainText("Unknown quota is not available");
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("sonnet-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(page.getByTestId("employee-execution-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-execution-quota")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("employee-execution-requested-model")).toContainText("sonnet-5.5");
  await expect(page.getByTestId("employee-execution-result")).not.toContainText(/\bReady\b|\bAvailable\b/);
  await expect(page.getByTestId("employee-execution-errors")).toHaveCount(0);
  expect(sql(b, "SELECT id FROM quota_observations")).toHaveLength(observationsBefore);
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);

  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toBeVisible();
  await expect(page.getByTestId("employee-run-model")).toContainText("Sonnet 5.5");
  await expect(page.getByTestId("employee-run-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-run-dialog")).not.toContainText(/\bAvailable\b/);
  const pending = (await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0];
  expect(pending.status).toBe("awaiting-approval");
  expect(pending.requested.model).toBe("sonnet-5.5");
  const refused = await request.post(`${b.apiBase}/employee-execution/attempts/${pending.id}/start`, {
    headers: { authorization: `Bearer ${b.apiToken}` },
    data: { revision: pending.revision, confirm: false },
  });
  expect(refused.status()).toBe(400);
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);

  const seenColumns = new Set<string>(["backlog"]);
  const startRequest = page.waitForRequest((req) => /\/attempts\/[^/]+\/start$/.test(new URL(req.url()).pathname));
  await page.getByTestId("employee-run-confirm").click();
  const sentStart = await startRequest;
  await expect.poll(async () => {
    const current = await api(request, b, "GET", `/tasks/${task.id}`);
    seenColumns.add(current.column);
    return current.column;
  }, { timeout: 20_000 }).toBe("review");
  expect(seenColumns.has("running")).toBe(true);
  const attempt = (await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0];
  expect(attempt).toMatchObject({
    employee: { id: worker.id }, phase: "completed", result: "succeeded",
    requested: { harnessId: "claude-code", model: "sonnet-5.5" },
    actual: { accountId: null, model: null }, provenance: { approval: "owner" },
  });
  const replay = await request.post(sentStart.url(), { headers: { authorization: `Bearer ${b.apiToken}` }, data: sentStart.postDataJSON() });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).replayed).toBe(true);
  const runs = await api(request, b, "GET", `/tasks/${task.id}/runs`);
  expect(runs).toHaveLength(1);
  const runId = attempt.runId as string;
  expect(runs[0].id).toBe(runId);

  const turnPanel = page.getByTestId("employee-run-status").getByTestId("professional-turns");
  await turnPanel.locator("summary").first().click();
  await turnPanel.getByRole("textbox", { name: "Professional follow-up message" }).fill("Owner follow-up for the manual route");
  await turnPanel.getByTestId("professional-follow-up").click();
  await turnPanel.getByRole("checkbox").check();
  await turnPanel.getByTestId("professional-turn-confirm").click();
  await expect.poll(async () => {
    const history = await api(request, b, "GET", `/employee-execution/runs/${runId}/turns`);
    const current = await api(request, b, "GET", `/tasks/${task.id}`);
    const last = history.turns?.at(-1);
    return history.turns?.length === 2 && last?.observed_run_status === "succeeded" && current.column === "review";
  }, { timeout: 20_000 }).toBe(true);
  const turns = await api(request, b, "GET", `/employee-execution/runs/${runId}/turns`);
  expect(turns.turns.map((turn: { turn_number: number }) => turn.turn_number)).toEqual([1, 2]);
  expect(turns.turns.every((turn: { session_id: string }) => turn.session_id === turns.turns[0].session_id)).toBe(true);
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toHaveLength(1);

  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await expect.poll(async () => boardColumn(page, task.title), { timeout: 10_000 }).toBe("review");

  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-activity").click();
  await expect(page.getByTestId("activity-loading")).toHaveText("");
  const records = (await api(request, b, "GET", `/activity?${scope(dir)}&limit=100`)).events as { id: string; eventType: string }[];
  const eventTypes = records.map((event) => event.eventType);
  for (const type of [
    "task.proposal.created", "task.assignment.proposed", "task.assignment.approved",
    "execution.reviewed", "execution.approved", "execution.started", "run.completed",
    "turn.proposed", "turn.approved", "turn.submitted",
  ]) expect(eventTypes, eventTypes.join(",")).toContain(type);
  expect(records.filter((event) => event.eventType === "run.completed")).toHaveLength(1);
  expect(records.filter((event) => event.eventType === "execution.started")).toHaveLength(1);
  const visibleIds = await page.getByTestId("activity-event").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  for (const id of records.map((event) => event.id)) expect(visibleIds).toContain(id);

  const settledRuns = await api(request, b, "GET", `/tasks/${task.id}/runs`);
  expect(settledRuns).toHaveLength(1);
  expect(settledRuns[0].id).toBe(runId);
  const beforeRestart = {
    task: await api(request, b, "GET", `/tasks/${task.id}`),
    runs: settledRuns,
    turns,
    events: sql(b, "SELECT id, event_type, sequence_id FROM activity_events ORDER BY sequence_id"),
  };
  await b.restart();
  await page.reload();
  expect(await api(request, b, "GET", `/tasks/${task.id}`)).toMatchObject({
    id: task.id, isolation: "none", column: "review", runId,
  });
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual(beforeRestart.runs);
  expect(await api(request, b, "GET", `/employee-execution/runs/${runId}/turns`)).toEqual(beforeRestart.turns);
  expect(sql(b, "SELECT id, event_type, sequence_id FROM activity_events ORDER BY sequence_id")).toEqual(beforeRestart.events);
  expect((await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts).toHaveLength(1);
  await projectPage(page, dir, "board");
  expect(await boardColumn(page, task.title)).toBe("review");
  expect(pageErrors).toEqual([]);
  expect(writes.filter((line) => /\/tasks\/[^/]+\/start$/.test(line))).toEqual([]);
  expect(proposal.id).toBeTruthy();
});

test("verified exhaustion blocks the selected model and does not block its neighbor", async ({ page, request, companyBackend: b }) => {
  test.setTimeout(90_000);
  await page.route("**/*", (route) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  const dir = await registerProject(request, b, "Exhausted gate");
  await api(request, b, "PATCH", "/harnesses/claude-code", { enabled: true });
  const worker = await api(request, b, "POST", "/employees", { name: "Ida Gate", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, b, "POST", "/tasks", {
    title: "Hold the exhausted model", prompt: "do not spend the exhausted model", isolation: "none",
    workdir: dir, agent: "claude-code", model: "opus-5.5", mode: "auto", column: "ready",
  });
  await api(request, b, "POST", "/task-assignments", { taskId: task.id, employeeId: worker.id }, 201);
  const quotaId = seedVerifiedExhaustion(b.dataDir);
  const observations = sql(b, "SELECT id FROM quota_observations").length;
  const sources = await api(request, b, "GET", "/account-core/quota-sources");
  expect(sources.find((source: { id: string }) => source.id === "anthropic-admin")).toMatchObject({ implemented: false, refreshAvailable: false });

  await gotoApp(page, b.bootBase);
  await openTask(page, dir, task.title);
  const router = page.getByTestId("ai-resource-recommendation");
  await router.locator(":scope > summary").click();
  await router.getByTestId("find-ai-resource").click();
  await expect(router.getByTestId("router-no-verified")).toBeVisible();
  await expect(router.getByTestId("router-verified")).toHaveCount(0);
  expect(sql(b, "SELECT id FROM quota_observations")).toHaveLength(observations);

  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "blocked");
  await expect(page.getByTestId("employee-execution-errors").locator("[data-code='resource-excluded']")).toBeVisible();
  await expect(page.getByTestId("employee-execution-errors")).toContainText("exhausted");
  await expect(page.getByTestId("employee-execution-run")).toHaveCount(0);

  await page.getByTestId("employee-execution-model").fill("opus-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "blocked");
  await expect(page.getByTestId("employee-execution-run")).toHaveCount(0);
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);
  expect((await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts).toEqual([]);

  await page.getByTestId("employee-execution-model").fill("sonnet-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(page.getByTestId("employee-execution-quota")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("employee-execution-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-execution-result")).not.toContainText(/\bAvailable\b/);
  await expect(page.getByTestId("employee-execution-errors")).toHaveCount(0);
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toBeVisible();
  await expect(page.getByTestId("employee-run-model")).toContainText("Sonnet 5.5");
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);
  await page.getByTestId("employee-run-cancel").click();
  await expect.poll(async () => (await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts[0].status).toBe("cancelled");
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);
  expect(sql(b, "SELECT id FROM quota_observations")).toHaveLength(observations);
  expect(quotaId).toMatch(/.+/);
});

test("an unverified remaining count stays Unknown and does not block the named model", async ({ page, request, companyBackend: b }) => {
  test.setTimeout(60_000);
  const dir = await registerProject(request, b, "Unverified meter");
  await api(request, b, "PATCH", "/harnesses/claude-code", { enabled: true });
  const worker = await api(request, b, "POST", "/employees", { name: "Una Meter", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, b, "POST", "/tasks", {
    title: "Read the unverified meter", prompt: "look only", isolation: "none",
    workdir: dir, agent: "claude-code", model: "sonnet-5.5", mode: "auto", column: "ready",
  });
  await api(request, b, "POST", "/task-assignments", { taskId: task.id, employeeId: worker.id }, 201);
  const account = await api(request, b, "POST", "/account-core/accounts", { provider: "anthropic", displayName: "Unverified meter" }, 201);
  await api(request, b, "POST", `/account-core/accounts/${account.id}/harnesses`, { harnessId: "claude-code" }, 201);
  const profile = await api(request, b, "POST", "/agent-profiles", { name: "Unverified Sonnet", harness: "claude-code", model: "sonnet-5.5" });
  await api(request, b, "POST", `/account-core/accounts/${account.id}/profiles`, { profileId: profile.id }, 201);
  const quota = await api(request, b, "POST", "/account-core/quotas", {
    accountId: account.id, subscriptionId: null, scope: "model:sonnet-5.5", unit: { kind: "requests" }, window: "week",
  }, 201);
  const forged = await request.post(`${b.apiBase}/account-core/quotas/${quota.id}/observations`, {
    headers: { authorization: `Bearer ${b.apiToken}` },
    data: { remaining: 0, limit: 1, used: 1, expiresAt: Date.now() + 60_000, verification: "verified", provenance: "verified" },
  });
  expect(forged.status()).toBe(400);
  await api(request, b, "POST", `/account-core/quotas/${quota.id}/observations`, {
    remaining: 0, limit: 1, used: 1, expiresAt: Date.now() + 60_000,
  }, 201);

  await gotoApp(page, b.bootBase);
  await openTask(page, dir, task.title);
  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("sonnet-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(page.getByTestId("employee-execution-quota")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("employee-execution-quota")).toContainText("Quota Unknown");
  await expect(page.getByTestId("employee-execution-result")).not.toContainText(/\bAvailable\b|\bReady\b/);
  await expect(page.getByTestId("employee-execution-run")).toBeVisible();
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual([]);
  expect((await api(request, b, "GET", `/employee-execution/attempts?taskId=${task.id}`)).attempts).toEqual([]);
});
