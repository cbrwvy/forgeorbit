import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import { E2E_BASE_URL } from "../playwright.config";

/**
 * FO-005C.2 Autonomous Execution UI in the Manager tab. Every agent is a
 * fake driver (no real CLI, no AI quota) on an isolated backend + data dir.
 * The UI renders the core's batch views; these tests check that what the
 * owner sees and clicks matches what the core did — and that nothing starts
 * before an explicit Start.
 */

test.describe.configure({ mode: "serial" });

const BASE_ENV = {
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_CURSOR_BIN: "/nonexistent/cursor-agent",
  AGETOR_FAKE_MANAGER_DELAY_MS: "200",
  AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "1500",
};

type Api = { request: APIRequestContext; backend: { apiBase: string; apiToken: string } };

function auth(api: Api["backend"]): { authorization: string } {
  return { authorization: `Bearer ${api.apiToken}` };
}

async function enable({ request, backend }: Api, harness: string): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/${harness}`, { headers: auth(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function registerProject({ request, backend }: Api, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo005c2-${name.replace(/\W+/g, "-")}-`));
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`);
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function createTask({ request, backend }: Api, dir: string, title: string, fields: Record<string, unknown> = {}): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: {
      title,
      prompt: `${title}.\n\n## Acceptance criteria\n- It works`,
      workdir: dir,
      agent: "codex",
      model: "gpt-6.1-sol",
      isolation: "none",
      column: "backlog",
      ...fields,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

async function runsOf({ request, backend }: Api, taskId: string): Promise<any[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: auth(backend) });
  return (await res.json()) as any[];
}

async function apiBatch({ request, backend }: Api, dir: string, taskIds: string[], policy: Record<string, unknown> = {}): Promise<any> {
  const res = await request.post(`${backend.apiBase}/project-manager/batches`, {
    headers: auth(backend),
    data: { path: dir, taskIds, title: "API batch", policy: { noOverageHarnessIds: ["codex"], ...policy } },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

async function apiApprove({ request, backend }: Api, dir: string, batch: any): Promise<any> {
  const res = await request.post(`${backend.apiBase}/project-manager/batches/${batch.id}/approve`, {
    headers: auth(backend),
    data: { path: dir, revision: batch.revision, previewKey: batch.preview.key, acknowledgedHarnessIds: batch.preview.spendingHarnessIds },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).batch;
}

/** Counts every request that could start an agent. */
function countStarts(page: Page): () => number {
  let starts = 0;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const url = req.url();
    if (/\/project-manager\/batches\/[^/]+\/(start|resume)$/.test(url)) starts += 1;
    if (/\/project-manager\/executions\/[^/]+\/approve$/.test(url)) starts += 1;
    if (/\/tasks\/[^/]+\/start$/.test(url)) starts += 1;
  });
  return () => starts;
}

async function openAutonomy(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await page.getByTestId("manager-tab-autonomy").click();
  await expect(page.getByTestId("autonomous-execution")).toBeVisible();
}

const entry = (page: Page, taskId: string) => page.locator(`[data-testid="batch-entry"][data-task-id="${taskId}"]`);
const draftTask = (page: Page, taskId: string) => page.locator(`[data-testid="batch-draft-task"][data-task-id="${taskId}"]`);

async function confirmDialog(page: Page, title: string, button: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(title);
  await dialog.getByRole("button", { name: button }).click();
  await expect(dialog).toHaveCount(0);
}

test.use({ backendEnv: BASE_ENV });

test("create, link, preview, approve, start, follow and accept a batch", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const api: Api = { request, backend };
  await enable(api, "codex");
  const dir = await registerProject(api, "Batch Orbit");
  const schema = await createTask(api, dir, "Write the schema");
  const service = await createTask(api, dir, "Build the service");
  await createTask(api, dir, "Not in the batch");
  const starts = countStarts(page);

  await gotoApp(page, backend.bootBase);
  await openAutonomy(page, dir);
  await expect(page.getByTestId("batches-empty")).toBeVisible();

  // Pick two tasks; creating the draft starts nothing.
  await page.getByTestId("batch-new").click();
  await page.locator(`[data-testid="batch-create-task"][data-task-id="${schema}"]`).check();
  await page.locator(`[data-testid="batch-create-task"][data-task-id="${service}"]`).check();
  await page.getByTestId("batch-create-title").fill("Schema then service");
  await page.getByTestId("batch-create-submit").click();
  const detail = page.getByTestId("batch-detail");
  await expect(detail).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("batch-title")).toHaveText("Schema then service");
  await expect(page.getByTestId("batch-draft-task")).toHaveCount(2);

  // Structured link: the service waits for the schema.
  await draftTask(page, service).getByTestId("batch-task-scheduling-toggle").click();
  const serviceEditor = draftTask(page, service).getByTestId("scheduling-editor");
  await serviceEditor.getByTestId("scheduling-add-select").selectOption(schema);
  await serviceEditor.getByTestId("scheduling-add").click();
  await expect(serviceEditor.locator(`[data-testid="scheduling-dep"][data-dep-id="${schema}"]`)).toBeVisible();
  await serviceEditor.getByTestId("scheduling-priority").selectOption("critical");
  await expect(serviceEditor.getByTestId("scheduling-priority")).toHaveValue("critical");

  // A cycle is refused with its path, and nothing changes.
  await draftTask(page, schema).getByTestId("batch-task-scheduling-toggle").click();
  const schemaEditor = draftTask(page, schema).getByTestId("scheduling-editor");
  await schemaEditor.getByTestId("scheduling-add-select").selectOption(service);
  await schemaEditor.getByTestId("scheduling-add").click();
  await expect(schemaEditor.getByTestId("scheduling-error")).toContainText("cycle");
  await expect(schemaEditor.getByTestId("scheduling-error")).toContainText("Write the schema → Build the service → Write the schema");
  await expect(schemaEditor.getByTestId("scheduling-dep")).toHaveCount(0);

  // Reorder (owner order) and the preview from the core.
  await draftTask(page, service).getByTestId("batch-task-up").click();
  await expect(page.getByTestId("batch-draft-task").first()).toHaveAttribute("data-task-id", service);
  const preview = page.getByTestId("batch-preview");
  await expect(preview.getByTestId("batch-preview-count")).toHaveText("2");
  await expect(preview.getByTestId("batch-preview-harnesses")).toContainText("Codex");
  // Dependencies beat priority and order in the planned start order.
  await expect(preview.getByTestId("batch-preview-order")).toContainText("“Write the schema” → “Build the service”");
  // Overage can't be verified: approval is blocked until the owner says so.
  await expect(preview.locator('[data-testid="execution-check"][data-code="spend-overage-unverified"]')).toBeVisible();
  await expect(preview.locator('[data-testid="execution-check"][data-code="limits-unknown"]')).toBeVisible();
  await expect(page.getByTestId("batch-cannot-approve")).toBeVisible();
  await expect(page.getByTestId("batch-approve")).toBeDisabled();

  const noOverage = page.getByTestId("batch-policy-no-overage");
  await expect(noOverage).toContainText("not a check");
  await noOverage.locator('[data-harness-id="codex"]').check();
  await page.getByTestId("batch-policy-save").click();
  await expect(preview.locator('[data-testid="execution-check"][data-code="spend-no-overage-confirmed"]')).toBeVisible();
  await expect(page.getByTestId("batch-cannot-approve")).toHaveCount(0);
  await expect(page.getByTestId("batch-approve")).toBeDisabled();
  await page.getByTestId("batch-reviewed").check();
  await page.getByTestId("batch-approve").click();
  await expect(detail).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("batch-not-started")).toBeVisible();
  await expect(page.getByTestId("batch-approval")).toContainText("codex");
  // Neither the preview nor the approval started anything.
  expect(starts()).toBe(0);
  expect(await runsOf(api, schema)).toHaveLength(0);
  expect(await runsOf(api, service)).toHaveLength(0);

  // Start is separate and explicit.
  await page.getByTestId("batch-start").click();
  await expect(detail).toHaveAttribute("data-status", "running");
  expect(starts()).toBe(1);
  await expect(entry(page, service)).toHaveAttribute("data-state", "pending");
  await expect(entry(page, service).getByTestId("batch-entry-readiness")).toContainText("Waiting for “Write the schema” to be Done");
  await expect(entry(page, schema)).toHaveAttribute("data-state", /running|review/);

  // The finished run waits for the owner; the dependent task doesn't start.
  await expect(entry(page, schema)).toHaveAttribute("data-state", "review", { timeout: 20_000 });
  await expect(page.locator('[data-testid="batch-group"][data-group="review"]')).toBeVisible();
  await expect(entry(page, schema).getByTestId("batch-entry-review-note")).toContainText("isn't acceptance");
  await expect(page.getByTestId("batch-next")).toContainText("review");
  expect(await runsOf(api, service)).toHaveLength(0);

  // Open the existing Run Panel from the queue.
  await entry(page, schema).getByTestId("batch-entry-open-run").click();
  const closePanel = page.getByRole("button", { name: "Close task details" });
  await expect(closePanel).toBeVisible();
  await closePanel.click();
  await expect(closePanel).toHaveCount(0);

  // Accept through the FO-005B review; the dependent task then starts.
  await entry(page, schema).getByTestId("batch-entry-review").click();
  const review = entry(page, schema).getByTestId("batch-entry-review-card");
  await expect(review.getByTestId("execution-card")).toContainText("started by an approved batch");
  await review.getByTestId("execution-accept").click();
  await expect(entry(page, schema)).toHaveAttribute("data-state", "done");
  await expect(entry(page, service)).toHaveAttribute("data-state", /running|review/, { timeout: 20_000 });
  await expect(entry(page, service)).toHaveAttribute("data-state", "review", { timeout: 20_000 });
  await entry(page, service).getByTestId("batch-entry-review").click();
  await entry(page, service).getByTestId("batch-entry-review-card").getByTestId("execution-accept").click();
  await expect(detail).toHaveAttribute("data-status", "completed", { timeout: 20_000 });
  expect(await runsOf(api, schema)).toHaveLength(1);
  expect(await runsOf(api, service)).toHaveLength(1);

  // History, oldest first.
  await page.getByTestId("batch-events").locator("summary").click();
  const kinds = await page.getByTestId("batch-event").evaluateAll((items) => items.map((item) => item.getAttribute("data-kind")));
  expect(kinds.indexOf("approved")).toBeLessThan(kinds.indexOf("started"));
  expect(kinds).toContain("task-started");
  expect(kinds.at(-1)).toBe("completed");
  await expect(page.locator('[data-testid="batch-row"]')).toHaveAttribute("data-status", "completed");
});

test.describe("lifecycle controls", () => {
  test.use({ backendEnv: { ...BASE_ENV, AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "60000" } });

  test("pause, resume, cancel and stop runs are separate actions", async ({ page, request, freshBackend: backend }) => {
    test.slow();
    const api: Api = { request, backend };
    await enable(api, "codex");
    const dir = await registerProject(api, "Lifecycle Orbit");
    const first = await createTask(api, dir, "First task");
    const second = await createTask(api, dir, "Second task");
    const outsider = await createTask(api, dir, "Started from the board");
    const batch = await apiApprove(api, dir, await apiBatch(api, dir, [first, second]));

    await gotoApp(page, backend.bootBase);
    await openAutonomy(page, dir);
    await page.locator(`[data-testid="batch-row"][data-batch-id="${batch.id}"]`).click();
    const detail = page.getByTestId("batch-detail");
    await expect(detail).toHaveAttribute("data-status", "approved");
    // Only the actions this status allows.
    await expect(page.getByTestId("batch-pause")).toHaveCount(0);
    await expect(page.getByTestId("batch-resume")).toHaveCount(0);
    await expect(page.getByTestId("batch-stop-runs")).toHaveCount(0);

    // Double Start: one launch.
    const [a, b] = await Promise.all([
      request.post(`${backend.apiBase}/project-manager/batches/${batch.id}/start`, { headers: auth(backend), data: { path: dir } }),
      request.post(`${backend.apiBase}/project-manager/batches/${batch.id}/start`, { headers: auth(backend), data: { path: dir } }),
    ]);
    expect([a.status(), b.status()]).toEqual([200, 200]);
    await expect(detail).toHaveAttribute("data-status", "running");
    expect(await runsOf(api, first)).toHaveLength(1);
    expect(await runsOf(api, second)).toHaveLength(0);
    // A run of a task outside the batch.
    const board = await request.post(`${backend.apiBase}/tasks/${outsider}/start`, { headers: auth(backend) });
    expect(board.ok()).toBeTruthy();

    // Stop runs isn't offered while running.
    await expect(page.getByTestId("batch-stop-runs")).toHaveCount(0);
    await page.getByTestId("batch-pause").click();
    await expect(detail).toHaveAttribute("data-status", "paused");
    await expect(page.getByTestId("batch-reason")).toContainText("Paused by you");
    await expect(entry(page, first)).toHaveAttribute("data-state", "running");
    await page.getByTestId("batch-resume").click();
    await expect(detail).toHaveAttribute("data-status", "running");
    expect(await runsOf(api, second)).toHaveLength(0);

    // Cancel: no more starts; the running agent keeps running.
    await page.getByTestId("batch-cancel").click();
    await confirmDialog(page, "Cancel the queue?", "Cancel queue");
    await expect(detail).toHaveAttribute("data-status", "cancelled");
    await expect(page.getByTestId("batch-start")).toHaveCount(0);
    await expect(page.getByTestId("batch-resume")).toHaveCount(0);
    expect((await runsOf(api, first))[0].status).toBe("running");

    // Stop batch runs: a dangerous, confirmed action that stops only its own.
    await page.getByTestId("batch-stop-runs").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("First task");
    await expect(dialog).not.toContainText("Started from the board");
    await dialog.getByRole("button", { name: "Stop batch runs" }).click();
    await expect(page.getByTestId("batch-notice")).toContainText("Stop sent to 1 run");
    await expect.poll(async () => (await runsOf(api, first))[0].status, { timeout: 15_000 }).toBe("cancelled");
    expect((await runsOf(api, outsider))[0].status).toBe("running");
    expect(await runsOf(api, second)).toHaveLength(0);
  });
});

test("a stale preview has to be reviewed again; a hold is explained and released only after a warning", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const api: Api = { request, backend };
  await enable(api, "codex");
  const dir = await registerProject(api, "Stale Orbit");
  const taskId = await createTask(api, dir, "Changing task");
  const batch = await apiBatch(api, dir, [taskId]);

  await gotoApp(page, backend.bootBase);
  await openAutonomy(page, dir);
  await page.locator(`[data-testid="batch-row"][data-batch-id="${batch.id}"]`).click();
  await page.getByTestId("batch-reviewed").check();
  // The task changes after the owner looked at the preview.
  const patched = await request.patch(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend), data: { prompt: "Something else entirely." } });
  expect(patched.ok()).toBeTruthy();
  await page.getByTestId("batch-approve").click();
  await expect(page.getByTestId("batch-error")).toContainText("changed");
  await expect(page.getByTestId("batch-preview-changed")).toBeVisible();
  await expect(page.getByTestId("batch-reviewed")).not.toBeChecked();
  await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "draft");
  await page.getByTestId("batch-reviewed").check();
  await page.getByTestId("batch-approve").click();
  await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "approved");

  // Changed again after approval: the start is held, never run.
  await request.patch(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend), data: { prompt: "And again." } });
  await page.getByTestId("batch-start").click();
  await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "paused");
  await expect(page.getByTestId("batch-reason")).toContainText("can't start");
  const held = entry(page, taskId);
  await expect(held).toHaveAttribute("data-state", "held");
  await expect(held.getByTestId("batch-entry-hold")).toContainText("changed since the batch was approved");
  expect(await runsOf(api, taskId)).toHaveLength(0);

  // Release shows the reason first; keeping it on hold changes nothing.
  await held.getByTestId("batch-entry-release").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("changed since the batch was approved");
  await dialog.getByRole("button", { name: "Keep on hold" }).click();
  await expect(held).toHaveAttribute("data-state", "held");
  // Resume, then release: the server checks again and holds it again.
  await page.getByTestId("batch-resume").click();
  await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "running");
  await held.getByTestId("batch-entry-release").click();
  await confirmDialog(page, "Release", "Release task");
  await expect(held).toHaveAttribute("data-state", "held");
  expect(await runsOf(api, taskId)).toHaveLength(0);
  await page.getByTestId("batch-events").locator("summary").click();
  await expect(page.locator('[data-testid="batch-event"][data-kind="task-released"]')).toHaveCount(1);
});

test.describe("spending", () => {
  // A base URL nobody can classify: billing is unknown, so it counts as paid.
  test.use({ backendEnv: { ...BASE_ENV, OPENAI_BASE_URL: "http://proxy.invalid" } });

  test("unknown billing needs a named acknowledgement; an unavailable harness blocks approval", async ({ page, request, freshBackend: backend }) => {
    test.slow();
    const api: Api = { request, backend };
    await enable(api, "codex");
    await enable(api, "cursor");
    const dir = await registerProject(api, "Spend Orbit");
    const taskId = await createTask(api, dir, "Paid task");
    const cursorTask = await createTask(api, dir, "Cursor task", { agent: "cursor", model: "grok-4.7" });
    const paid = await apiBatch(api, dir, [taskId]);
    const broken = await apiBatch(api, dir, [cursorTask], { noOverageHarnessIds: ["cursor"] });
    const starts = countStarts(page);

    await gotoApp(page, backend.bootBase);
    await openAutonomy(page, dir);
    await page.locator(`[data-testid="batch-row"][data-batch-id="${paid.id}"]`).click();
    const preview = page.getByTestId("batch-preview");
    await expect(preview.locator('[data-testid="execution-check"][data-code="spend-unknown-forbidden"]')).toBeVisible();
    await expect(page.getByTestId("batch-approve")).toBeDisabled();

    await page.getByTestId("batch-policy-spending").locator('[data-option="allow-paid"]').check();
    await page.getByTestId("batch-policy-save").click();
    await expect(preview.locator('[data-testid="execution-check"][data-code="spend-unknown"]')).toBeVisible();
    const ack = page.locator('[data-testid="batch-spending-ack"][data-harness-id="codex"]');
    await expect(ack).toBeVisible();
    await page.getByTestId("batch-reviewed").check();
    await expect(page.getByTestId("batch-approve")).toBeDisabled();
    await ack.check();
    await page.getByTestId("batch-approve").click();
    await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("batch-approval")).toContainText("Spending acknowledged for codex");
    expect(starts()).toBe(0);

    await page.locator(`[data-testid="batch-row"][data-batch-id="${broken.id}"]`).click();
    await expect(page.getByTestId("batch-preview").locator('[data-testid="execution-check"][data-code="task:harness-unavailable"]').first()).toBeVisible();
    await page.getByTestId("batch-reviewed").check();
    await expect(page.getByTestId("batch-approve")).toBeDisabled();
    expect(await runsOf(api, cursorTask)).toHaveLength(0);
  });
});

test("a batch from an approved proposal; batches stay inside their project", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const api: Api = { request, backend };
  await enable(api, "codex");
  const dir = await registerProject(api, "Proposal Orbit");
  const other = await registerProject(api, "Other Orbit");
  const otherTask = await createTask(api, other, "Someone else's task");
  await apiBatch(api, other, [otherTask]);

  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
  await page.getByTestId("manager-composer").fill("Break user authentication into tasks");
  await page.getByTestId("manager-send").click();
  const proposal = page.getByTestId("manager-proposal");
  await expect(proposal).toHaveAttribute("data-status", "pending", { timeout: 20_000 });
  await expect(proposal.getByTestId("manager-proposal-batch")).toHaveCount(0);
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");

  await proposal.getByTestId("manager-proposal-batch").click();
  await expect(page.getByTestId("manager-tab-autonomy")).toHaveAttribute("aria-selected", "true");
  const detail = page.getByTestId("batch-detail");
  await expect(detail).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("batch-draft-task")).toHaveCount(5);
  // The proposal's links became real dependencies: the planned order respects them.
  await expect(page.getByTestId("batch-preview-order")).toContainText("→");
  await expect(page.getByTestId("batch-mapping-note")).toHaveCount(0);
  const rows = page.getByTestId("batch-row");
  await expect(rows).toHaveCount(1);
  // The other project's batch never shows here.
  await expect(page.getByText("API batch")).toHaveCount(0);
  const runs = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  for (const task of (await runs.json()) as any[]) {
    if (task.workdir === dir) expect(task.column).toBe("backlog");
  }
});

test("Task Details: priority and dependencies", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const api: Api = { request, backend };
  const dir = await registerProject(api, "Details Orbit");
  const base = await createTask(api, dir, "Base task");
  const top = await createTask(api, dir, "Top task", { prompt: "Top.\n\n## Depends on\n- Base task (task 1a2b3c4d)\n" });

  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByText("Top task", { exact: true }).first().click();
  const panel = page.locator("aside").last();
  await panel.getByText("Task details", { exact: true }).click();
  await panel.getByTestId("task-scheduling-section").locator("summary").click();
  const editor = panel.getByTestId("scheduling-editor");
  await expect(editor.getByTestId("scheduling-markdown-warning")).toBeVisible();
  await expect(editor.getByTestId("scheduling-readiness")).toHaveAttribute("data-state", "ready");
  // Only this project's other tasks are offered, never the task itself.
  const options = await editor.getByTestId("scheduling-add-select").locator("option").allTextContents();
  expect(options.filter((text) => !text.startsWith("Add"))).toEqual(["Base task"]);
  await editor.getByTestId("scheduling-add-select").selectOption(base);
  await editor.getByTestId("scheduling-add").click();
  await expect(editor.locator(`[data-testid="scheduling-dep"][data-dep-id="${base}"]`)).toBeVisible();
  await expect(editor.getByTestId("scheduling-readiness")).toHaveAttribute("data-state", "waiting");
  await expect(editor.getByTestId("scheduling-markdown-warning")).toHaveCount(0);
  await editor.getByTestId("scheduling-priority").selectOption("high");
  await expect(editor.getByTestId("scheduling-priority")).toHaveValue("high");
  const stored = await request.get(`${backend.apiBase}/project-manager/scheduling?path=${encodeURIComponent(dir)}`, { headers: auth(backend) });
  const row = ((await stored.json()).tasks as any[]).find((item) => item.taskId === top);
  expect(row.priority).toBe("high");
  expect(row.dependsOn.map((dep: any) => dep.taskId)).toEqual([base]);
});

test.describe("appearance and access", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });

  test("narrow window, dark mode, reduced motion and the keyboard", async ({ page, request, freshBackend: backend }) => {
    test.slow();
    const api: Api = { request, backend };
    await enable(api, "codex");
    const dir = await registerProject(api, "Narrow Orbit");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await createTask(api, dir, `Task ${i + 1} with a deliberately long title that has to wrap inside a narrow window without pushing the layout sideways`));
    }
    await apiBatch(api, dir, ids);

    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await gotoApp(page, backend.bootBase);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
    await page.getByTestId("project-page-manager").click();
    await expect(page.getByTestId("manager-page")).toBeVisible();
    // The app shell's side panels collapse for a phone-width window.
    const sidebar = page.getByRole("button", { name: "Collapse project sidebar" });
    if (await sidebar.count()) await sidebar.click();
    const taskPanel = page.getByRole("button", { name: "Collapse new task panel" });
    if (await taskPanel.count()) await taskPanel.click();
    await page.setViewportSize({ width: 390, height: 844 });

    // Keyboard: the view switch is a tab list that Enter activates.
    const tab = page.getByTestId("manager-tab-autonomy");
    await tab.focus();
    await page.keyboard.press("Enter");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tablist", { name: "Project manager" })).toBeVisible();
    const row = page.getByTestId("batch-row").first();
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("batch-detail")).toBeVisible();
    await expect(page.getByTestId("batch-draft-task")).toHaveCount(12);
    const reviewed = page.getByTestId("batch-reviewed");
    await reviewed.focus();
    await page.keyboard.press("Space");
    await expect(reviewed).toBeChecked();

    // Nothing pushes the manager sideways at 390 px.
    const fits = await page.getByTestId("manager-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    expect(fits).toBe(true);
    const detailFits = await page.getByTestId("batch-detail").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    expect(detailFits).toBe(true);
    // Approve keeps an accessible name; the approval panel is labelled.
    await expect(page.getByRole("region", { name: "Approval" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve batch" })).toBeVisible();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Recovery: two headless backends, one after the other, on one data dir.
 * ────────────────────────────────────────────────────────────────────────── */

async function startHeadless(dataDir: string, port: number, token: string): Promise<ChildProcess> {
  // Same isolation as the worker fixture (e2e/fixtures.ts, via
  // e2e/isolated-env.ts): own data dir and HOME, isolated harness homes,
  // every harness binary stubbed, nothing FORGEORBIT_*/AGETOR_* inherited.
  // The seed is idempotent, so the second boot on the same dir re-runs it.
  const fxBin = writeFxStubBin(dataDir);
  const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
  if (!seeded.ok) throw new Error(`could not initialize isolated test accounts: ${seeded.stderr}`);
  const child = spawn("bun", ["src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    env: isolatedCoreEnv({
      dataDir,
      apiPort: port,
      apiToken: token,
      fxBin,
      extra: { ...BASE_ENV, AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "60000" },
    }),
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error("headless backend didn't start");
}

async function stopHeadless(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("after a restart a running batch comes back paused and waits for Resume", async ({ page, request }, testInfo) => {
  test.slow();
  const dataDir = await mkdtemp(path.join(tmpdir(), "fo005c2-restart-"));
  const port = 4840 + testInfo.parallelIndex;
  const token = `fo005c2-${crypto.randomUUID()}`;
  const backend = { apiBase: `http://127.0.0.1:${port}`, apiToken: token };
  const api: Api = { request, backend };
  let child = await startHeadless(dataDir, port, token);
  try {
    await enable(api, "codex");
    const dir = await registerProject(api, "Restart Orbit");
    const first = await createTask(api, dir, "Long task");
    const second = await createTask(api, dir, "Next task");
    const batch = await apiApprove(api, dir, await apiBatch(api, dir, [first, second]));
    const started = await request.post(`${backend.apiBase}/project-manager/batches/${batch.id}/start`, { headers: auth(backend), data: { path: dir } });
    expect(started.ok()).toBeTruthy();
    expect(await runsOf(api, first)).toHaveLength(1);

    await stopHeadless(child);
    child = await startHeadless(dataDir, port, token);
    const starts = countStarts(page);

    await gotoApp(page, `${E2E_BASE_URL}/#api=${port}&token=${token}`);
    await openAutonomy(page, dir);
    await page.locator(`[data-testid="batch-row"][data-batch-id="${batch.id}"]`).click();
    const detail = page.getByTestId("batch-detail");
    await expect(detail).toHaveAttribute("data-status", "paused");
    await expect(page.getByTestId("batch-reason")).toHaveAttribute("data-code", "restart");
    await expect(page.getByTestId("batch-reason")).toContainText("restarted");
    // The earlier run is still visible; nothing new started.
    await expect(entry(page, first).getByTestId("batch-entry-run")).toContainText((await runsOf(api, first))[0].id.slice(0, 8));
    await page.waitForTimeout(1000);
    expect(await runsOf(api, second)).toHaveLength(0);
    expect(starts()).toBe(0);
    await page.getByTestId("batch-events").locator("summary").click();
    await expect(page.locator('[data-testid="batch-event"][data-kind="recovered"]')).toHaveCount(1);

    // Resume is the owner's explicit action.
    await page.getByTestId("batch-resume").click();
    expect(starts()).toBe(1);
    await expect(detail).toHaveAttribute("data-status", /running|paused/);
  } finally {
    await stopHeadless(child);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ----- FO-ORCH08 bounded autonomous grant ------------------------------------------------------------------------

test.describe("bounded autonomous execution", () => {
  test.use({ backendEnv: { ...BASE_ENV, AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "60000" } });

  test("off by default; the Owner reviews, confirms, grants, sees the counters and can revoke", async ({ page, request, freshBackend: backend }) => {
    test.slow();
    const api: Api = { request, backend };
    await enable(api, "codex");
    const dir = await registerProject(api, "Grant Orbit");
    const first = await createTask(api, dir, "Granted task", { mode: "ask" });
    const second = await createTask(api, dir, "Second granted task", { mode: "ask" });
    const batch = await apiApprove(api, dir, await apiBatch(api, dir, [first, second], { maxParallel: 2 }));
    const starts = countStarts(page);

    await gotoApp(page, backend.bootBase);
    await openAutonomy(page, dir);
    await page.locator(`[data-testid="batch-row"][data-batch-id="${batch.id}"]`).click();
    const section = page.getByTestId("autonomy-section");
    await expect(section).toHaveAttribute("data-mode", "manual");
    await expect(page.getByTestId("autonomy-off")).toBeVisible();

    await page.getByTestId("autonomy-enable").click();
    const review = page.getByTestId("autonomy-review");
    await expect(review).toBeVisible();
    await expect(page.locator('[data-testid="autonomy-review-tasks"] > li')).toHaveCount(2);
    await expect(page.getByTestId("autonomy-cost-note")).toContainText("does not measure money");
    // Quota is Unknown here: the grant needs its own acknowledgement plus the explicit confirmation.
    await expect(page.getByTestId("autonomy-unknown-quota-review")).toBeVisible();
    await expect(page.getByTestId("autonomy-grant")).toBeDisabled();
    await page.getByTestId("autonomy-confirm").check();
    await expect(page.getByTestId("autonomy-grant")).toBeDisabled();
    await page.getByTestId("autonomy-ack-unknown").check();
    await page.getByTestId("autonomy-max-runs").fill("3");
    await page.getByTestId("autonomy-max-parallel").fill("2");
    await expect(page.getByTestId("autonomy-grant")).toBeEnabled();
    expect(starts()).toBe(0); // reviewing and confirming started nothing
    await page.getByTestId("autonomy-grant").click();

    await expect(section).toHaveAttribute("data-mode", "bounded");
    await expect(page.getByTestId("autonomy-mode").first()).toHaveAttribute("data-mode", "bounded");
    await expect(page.getByTestId("autonomy-runs")).toHaveText("0 / 3");
    await expect(page.getByTestId("autonomy-task")).toHaveCount(2);
    await expect(page.getByTestId("autonomy-resource").first()).toContainText("codex");
    await expect(page.getByTestId("autonomy-unknown-quota")).toContainText("isn't verified");
    expect((await runsOf(api, first)).length + (await runsOf(api, second)).length).toBe(0);

    // The Owner starts it; the grant's counter follows the Runs the core recorded.
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("autonomy-runs")).toHaveText("2 / 3", { timeout: 15_000 });
    await expect(page.getByTestId("autonomy-current")).not.toContainText("Nothing is running");

    // Revoke asks first, then pauses the batch and ends the grant; nothing else starts.
    await page.getByTestId("autonomy-revoke").click();
    await confirmDialog(page, "Revoke autonomous execution?", "Revoke");
    await expect(section).toHaveAttribute("data-mode", "revoked");
    await expect(page.getByTestId("autonomy-revoke")).toHaveCount(0);
    await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "paused");
    await expect(page.getByTestId("autonomy-ended")).toHaveAttribute("data-code", "owner");
    await expect(page.locator('[data-testid="batch-row"]')).toContainText("Autonomous grant revoked");
  });
});
