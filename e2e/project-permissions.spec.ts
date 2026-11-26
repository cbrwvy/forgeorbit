/**
 * Project permissions for one bounded local action: run one fixed project test in the
 * offline sandbox. Synthetic project, fake Codex driver, disposable data dir. The test
 * itself runs through the REAL offline Seatbelt runner, so "Finished" is a real result.
 * No provider call. Selectors are test ids and roles.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, Request } from "@playwright/test";
import { expect, test, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp, gotoBoard, openAllTasks } from "./helpers";
import { FAKE_TASK_FILES_MARKER } from "../src/shared/task-workspace.ts";

const home = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-project-permissions-ui-home-")));
test.use({ backendEnv: { HOME: home, AGETOR_CODEX_DRIVER: "fake" } });
test.describe.configure({ timeout: 120_000 });

const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`;
const clampTest = `import { expect, test } from "bun:test";
import { clampInt } from "./clamp.ts";
test("clamps", () => { expect(clampInt(12, 0, 10)).toBe(10); });
`;

function auth(backend: E2EBackend) {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

/** A registered project with a task whose Developer run has settled in its own workspace. */
async function settledTask(request: APIRequestContext, backend: E2EBackend, name: string, promptExtra = ""): Promise<{ project: string; taskId: string; title: string }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-project-permissions-ui-${name}-`)));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "README.md"), "# synthetic permissions\n");
  writeFileSync(path.join(project, "src/clamp.test.ts"), clampTest);
  await git(project, ["init", "-b", "main"]);
  await git(project, ["add", "README.md", "src/clamp.test.ts"]);
  await git(project, ["-c", "user.email=fo-ui@example.com", "-c", "user.name=FO UI", "commit", "-m", "seed"]);
  const registered = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: project, name } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const workdir = (await registered.json()).path as string;
  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  const title = `Permission task ${name}`;
  const prompt = `Add src/clamp.ts.\n${promptExtra}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clampSource }] })}`;
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt, workdir, column: "ready", agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "none" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const task = (await created.json()) as { id: string };
  const prepared = await request.post(`${backend.apiBase}/task-workspace/prepare`, { headers: auth(backend), data: { taskId: task.id, outputPaths: ["src/clamp.ts"] } });
  expect(prepared.ok(), await prepared.text()).toBeTruthy();
  const started = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(started.ok(), await started.text()).toBeTruthy();
  await expect.poll(async () => {
    const view = await request.get(`${backend.apiBase}/task-workspace?taskId=${task.id}`, { headers: auth(backend) });
    return ((await view.json()) as { workspace: { status: string } | null }).workspace?.status ?? "";
  }, { timeout: 30_000 }).toBe("settled");
  return { project: workdir, taskId: task.id, title };
}

/** The task's request, submitted the way the UI does: review the derived target, then submit exactly it. */
async function ask(request: APIRequestContext, backend: E2EBackend, taskId: string) {
  const shown = await request.get(`${backend.apiBase}/project-permissions/tasks/${taskId}`, { headers: auth(backend) });
  const preview = await shown.json() as { target: { projectPath: string; commandFingerprint: string; sourceFingerprint: string } | null };
  const res = await request.post(`${backend.apiBase}/project-permissions/requests`, {
    headers: auth(backend),
    data: { taskId, reviewed: preview.target },
    timeout: 90_000,
  });
  return { status: res.status(), body: await res.json() as Record<string, any> };
}

async function readRequests(request: APIRequestContext, backend: E2EBackend, project: string) {
  const res = await request.get(`${backend.apiBase}/project-permissions?projectPath=${encodeURIComponent(project)}`, { headers: auth(backend) });
  return await res.json() as { rules: { id: string; mode: string; command: string | null }[]; requests: Record<string, any>[] };
}

function watchPermissionWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return;
    if (req.url().includes("/project-permissions")) writes.push(req);
  });
  return writes;
}

async function openNeedsYou(page: Page) {
  await page.getByTestId("workspace-overview").click();
  await page.getByTestId("workspace-attention").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
}

async function openPermissionSettings(page: Page) {
  await page.getByTestId("open-settings").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("settings-nav-autonomy").click();
  await expect(dialog.getByTestId("settings-sub-project_permissions")).toBeVisible();
  return dialog;
}

test("Ask is the default; opening Needs you and Settings sends nothing and runs nothing", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId, title } = await settledTask(request, backend, "ask");
  const pending = await ask(request, backend, taskId);
  expect(pending.status).toBe(201);
  expect(pending.body.status).toBe("pending");

  await gotoApp(page, backend.bootBase);
  const writes = watchPermissionWrites(page);
  await openNeedsYou(page);
  const row = page.getByTestId("permission-request");
  await expect(row).toBeVisible();
  await expect(row).toContainText(title);
  await expect(row.getByTestId("permission-command")).toHaveText("bun test ./src/clamp.test.ts");
  await expect(row.getByTestId("permission-cwd")).toContainText("task-workspaces");
  await expect(row.getByTestId("permission-allow-once")).toBeVisible();
  await expect(row.getByTestId("permission-deny")).toBeVisible();

  const dialogOpened = await openPermissionSettings(page);
  await dialogOpened.getByTestId("perm-project-select").selectOption(project);
  await expect(dialogOpened.getByTestId("perm-default-select")).toHaveValue("ask");
  await expect(dialogOpened.getByTestId("perm-rules-none")).toBeVisible();
  await expect(dialogOpened.getByTestId("perm-history-row").first()).toHaveAttribute("data-status", "pending");
  await page.reload();
  await gotoApp(page, backend.bootBase);

  expect(writes).toHaveLength(0);
  const state = await readRequests(request, backend, project);
  expect(state.requests[0]!.status).toBe("pending");
  expect(state.requests[0]!.startedAt).toBeNull();
});

test("Allow once runs the real fixture test once; the outcome is explicit and a replay does not run it again", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId } = await settledTask(request, backend, "allow");
  const pending = (await ask(request, backend, taskId)).body;

  await gotoApp(page, backend.bootBase);
  await openNeedsYou(page);
  await page.getByTestId("permission-allow-once").click();
  const outcome = page.getByTestId("permission-outcome");
  await expect(outcome).toBeVisible({ timeout: 60_000 });
  await expect(outcome).toHaveAttribute("data-status", "completed");
  await expect(outcome.getByTestId("permission-outcome-text")).toContainText("passed");

  const done = (await readRequests(request, backend, project)).requests.find((r) => r.id === pending.id)!;
  expect(done.status).toBe("completed");
  expect(done.exitCode).toBe(0);
  expect(done.authority).toBe("owner-once");
  expect(done.isolation).toBe("macos-offline-seatbelt");
  expect(done.summary).toMatch(/1 pass/);

  // Replay and a reload: the grant is spent, nothing is offered, nothing runs.
  const replay = await request.post(`${backend.apiBase}/project-permissions/requests/${pending.id}/approve`, {
    headers: auth(backend),
    data: { projectPath: project, commandFingerprint: pending.commandFingerprint },
  });
  expect(replay.status()).toBe(409);
  await page.reload();
  await gotoApp(page, backend.bootBase);
  await openNeedsYou(page);
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  const after = (await readRequests(request, backend, project)).requests.find((r) => r.id === pending.id)!;
  expect(after.finishedAt).toBe(done.finishedAt);
});

test("Deny starts no process and is final", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId } = await settledTask(request, backend, "deny");
  const pending = (await ask(request, backend, taskId)).body;
  await gotoApp(page, backend.bootBase);
  await openNeedsYou(page);
  await page.getByTestId("permission-deny").click();
  const outcome = page.getByTestId("permission-outcome");
  await expect(outcome).toHaveAttribute("data-status", "denied");
  await expect(outcome.getByTestId("permission-outcome-text")).toContainText("No process was started");
  const denied = (await readRequests(request, backend, project)).requests.find((r) => r.id === pending.id)!;
  expect(denied.status).toBe("denied");
  expect(denied.startedAt).toBeNull();
  expect(denied.exitCode).toBeNull();
  const late = await request.post(`${backend.apiBase}/project-permissions/requests/${pending.id}/approve`, {
    headers: auth(backend),
    data: { projectPath: project, commandFingerprint: pending.commandFingerprint },
  });
  expect(late.status()).toBe(409);
});

test("a project rule is added with a confirmation, allows only its command, and a revoked rule no longer authorizes after reload", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId } = await settledTask(request, backend, "rule");
  await gotoApp(page, backend.bootBase);
  let dialog = await openPermissionSettings(page);
  await dialog.getByTestId("perm-project-select").selectOption(project);
  await dialog.getByTestId("perm-rule-input").fill("rm -rf /");
  await expect(dialog.getByTestId("perm-rule-invalid")).toBeVisible();
  await expect(dialog.getByTestId("perm-rule-add")).toBeDisabled();
  await dialog.getByTestId("perm-rule-input").fill("bun test ./src/clamp.test.ts");
  await dialog.getByTestId("perm-rule-add").click();
  // Cancelling the confirmation adds nothing.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByTestId("perm-rule-row")).toHaveCount(0);
  await dialog.getByTestId("perm-rule-add").click();
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(dialog.getByTestId("perm-rule-row")).toHaveCount(1);
  await expect(dialog.getByTestId("perm-rule-command")).toHaveText("bun test ./src/clamp.test.ts");

  // The rule answers the ask with a real run, labelled as rule-authorized.
  const ran = await ask(request, backend, taskId);
  expect(ran.body.status).toBe("completed");
  expect(ran.body.authority).toBe("project-rule");

  await dialog.getByTestId("perm-rule-revoke").click();
  await expect(dialog.getByTestId("perm-rules-none")).toBeVisible();

  // Reload: the rule stays revoked and the next ask waits for the Owner again.
  await page.reload();
  await gotoApp(page, backend.bootBase);
  dialog = await openPermissionSettings(page);
  await dialog.getByTestId("perm-project-select").selectOption(project);
  await expect(dialog.getByTestId("perm-rules-none")).toBeVisible();
  const again = await ask(request, backend, taskId);
  expect(again.body.status).toBe("pending");
});

test("a project default of Deny records the denial without a process", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId } = await settledTask(request, backend, "default-deny");
  await gotoApp(page, backend.bootBase);
  const dialog = await openPermissionSettings(page);
  await dialog.getByTestId("perm-project-select").selectOption(project);
  await dialog.getByTestId("perm-default-select").selectOption("deny");
  await expect(dialog.getByTestId("perm-default-select")).toHaveValue("deny");
  const denied = await ask(request, backend, taskId);
  expect(denied.body.status).toBe("denied");
  expect(denied.body.startedAt).toBeNull();
  await dialog.getByTestId("perm-default-select").selectOption("ask");
  await expect(dialog.getByTestId("perm-default-select")).toHaveValue("ask");
});

test("mutations need the Owner bearer header, not a query token", async ({ request, freshBackend: backend }) => {
  const viaQuery = await request.put(`${backend.apiBase}/project-permissions/default?token=${backend.apiToken}`, { data: { projectPath: "/x", mode: "deny" } });
  expect(viaQuery.status()).toBe(401);
  const none = await request.post(`${backend.apiBase}/project-permissions/requests`, { data: { taskId: "x" } });
  expect(none.status()).toBe(401);
});

test("Russian: the request, the buttons and the outcome are translated; the exact command stays as is", async ({ page, request, freshBackend: backend }) => {
  const { taskId } = await settledTask(request, backend, "ru");
  await ask(request, backend, taskId);
  await gotoApp(page, backend.bootBase);
  const settings = await (async () => { await page.getByTestId("open-settings").click(); return page.getByRole("dialog"); })();
  await settings.locator("#interface-language").selectOption("ru");
  await settings.getByRole("button", { name: /Закрыть|Close/ }).first().click().catch(() => page.keyboard.press("Escape"));
  await openNeedsYou(page);
  const row = page.getByTestId("permission-request");
  await expect(row.getByTestId("permission-allow-once")).toHaveText("Разрешить один раз");
  await expect(row.getByTestId("permission-deny")).toHaveText("Отклонить");
  await expect(row.getByTestId("permission-command")).toHaveText("bun test ./src/clamp.test.ts");
  await row.getByTestId("permission-deny").click();
  await expect(page.getByTestId("permission-outcome-text")).toContainText("Процесс не запускался");
});

for (const locale of ["en", "ru"] as const) {
  test(`${locale} 800px: the request row and the Settings panel fit and are inspectable`, async ({ page, request, freshBackend: backend }, testInfo) => {
    await page.setViewportSize({ width: 800, height: 900 });
    const { project, taskId } = await settledTask(request, backend, `layout-${locale}`);
    await ask(request, backend, taskId);
    await gotoApp(page, backend.bootBase);
    if (locale === "ru") {
      await page.getByTestId("open-settings").click();
      await page.getByRole("dialog").locator("#interface-language").selectOption("ru");
      await page.keyboard.press("Escape");
    }
    await openNeedsYou(page);
    await expect(page.getByTestId("permission-request")).toBeVisible();
    const overflowPage = await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
    expect(overflowPage).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`needs-you-${locale}.png`) });
    const dialog = await openPermissionSettings(page);
    await dialog.getByTestId("perm-project-select").selectOption(project);
    await expect(dialog.getByTestId("perm-history-row").first()).toBeVisible();
    const overflowDialog = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflowDialog).toBeLessThanOrEqual(0);
    await dialog.getByTestId("settings-sub-project_permissions").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`settings-${locale}.png`) });
  });
}

// ---------------------------------------------------------------------------------------------
// FO-PERM02: the whole flow from the task panel. Nothing is seeded: no request exists until the
// Owner reviews and submits from the task, and the result comes back on the same task.
// ---------------------------------------------------------------------------------------------

async function openTaskPanel(page: Page, title: string) {
  const card = page.getByRole("group", { name: title, exact: true });
  await expect(card).toBeVisible();
  await expect(async () => {
    await card.getByRole("button", { name: title, exact: true }).click({ timeout: 3_000 });
    await expect(page.getByTestId("project-test-panel")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByTestId("project-test-panel").scrollIntoViewIfNeeded();
  return page.getByTestId("project-test-panel");
}

async function closeTaskPanel(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-test-panel")).toHaveCount(0);
}

async function permissionRequestCount(request: APIRequestContext, backend: E2EBackend, project: string) {
  return (await readRequests(request, backend, project)).requests.length;
}

test("task UI: Request project test -> Needs you Allow once -> the real offline result is back on the same task", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId, title } = await settledTask(request, backend, "taskflow");
  expect(await permissionRequestCount(request, backend, project)).toBe(0); // nothing seeded
  await gotoBoard(page, backend.bootBase);
  const writes = watchPermissionWrites(page);

  let panel = await openTaskPanel(page, title);
  // Opening the task created nothing.
  await expect(panel.getByTestId("project-test-latest")).toHaveCount(0);
  expect(writes).toHaveLength(0);
  expect(await permissionRequestCount(request, backend, project)).toBe(0);

  // Review shows the backend-derived command and directory, and what a submission will do.
  await panel.getByTestId("project-test-review").click();
  const box = panel.getByTestId("project-test-review-box");
  await expect(box.getByTestId("project-test-command")).toHaveText("bun test ./src/clamp.test.ts");
  await expect(box.getByTestId("project-test-cwd")).toContainText("task-workspaces");
  await expect(box.getByTestId("project-test-effect")).toContainText("Nothing runs until you choose Allow once");
  await expect(box.getByTestId("project-test-submit")).toHaveText("Submit request");
  expect(writes).toHaveLength(0); // reviewing is still a read
  await box.getByTestId("project-test-submit").click();

  // Ask: the request is pending, waits in Needs you, and has not run.
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "pending");
  await expect(panel.getByTestId("project-test-pending-where")).toBeVisible();
  await expect(panel.getByTestId("project-test-review")).toHaveCount(0); // no second request while one is open
  expect(await permissionRequestCount(request, backend, project)).toBe(1);
  expect((await readRequests(request, backend, project)).requests[0]!.startedAt).toBeNull();

  // Reload and reopen: still one pending request, nothing approved, nothing run.
  await page.reload();
  await gotoBoard(page, backend.bootBase);
  panel = await openTaskPanel(page, title);
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "pending");
  expect(await permissionRequestCount(request, backend, project)).toBe(1);
  expect((await readRequests(request, backend, project)).requests[0]!.startedAt).toBeNull();

  // Decide in the existing Needs you flow.
  await closeTaskPanel(page);
  await openNeedsYou(page);
  const row = page.getByTestId("permission-request");
  await expect(row).toContainText(title);
  await expect(row.getByTestId("permission-command")).toHaveText("bun test ./src/clamp.test.ts");
  await row.getByTestId("permission-allow-once").click();
  await expect(page.getByTestId("permission-outcome")).toHaveAttribute("data-status", "completed", { timeout: 60_000 });

  // Back on the same task: the result is shown from the same request record.
  await openAllTasks(page);
  panel = await openTaskPanel(page, title);
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "completed");
  await expect(panel.getByTestId("project-test-outcome")).toContainText("passed");
  await expect(panel.getByTestId("project-test-outcome")).toContainText("Allowed once by you");
  await expect(panel.getByTestId("project-test-technical")).toContainText("Exit code");
  await expect(panel.getByTestId("project-test-stop-note")).toContainText("does not terminate a test that is already running");
  await expect(panel.getByTestId("project-test-approval-note")).toContainText("not proof that a person is present");
  const all = await readRequests(request, backend, project);
  expect(all.requests).toHaveLength(1);
  expect(all.requests[0]).toMatchObject({ status: "completed", exitCode: 0, authority: "owner-once", isolation: "macos-offline-seatbelt" });

  // A passing test is evidence of that test only: the task is not Done and no QC verdict was recorded.
  const taskRow = await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend) })).json() as { column: string };
  expect(taskRow.column).not.toBe("done");

  // Replay, reload and reopen cannot run it again.
  const finishedAt = all.requests[0]!.finishedAt;
  const replay = await request.post(`${backend.apiBase}/project-permissions/requests/${all.requests[0]!.id}/approve`, {
    headers: auth(backend),
    data: { projectPath: project, commandFingerprint: all.requests[0]!.commandFingerprint },
  });
  expect(replay.status()).toBe(409);
  await page.reload();
  await gotoBoard(page, backend.bootBase);
  panel = await openTaskPanel(page, title);
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "completed");
  const after = await readRequests(request, backend, project);
  expect(after.requests).toHaveLength(1);
  expect(after.requests[0]!.finishedAt).toBe(finishedAt);
});

test("task UI: Deny in Needs you starts no process and the task shows the denial", async ({ page, request, freshBackend: backend }) => {
  const { project, title } = await settledTask(request, backend, "taskdeny");
  await gotoBoard(page, backend.bootBase);
  const panel = await openTaskPanel(page, title);
  await panel.getByTestId("project-test-review").click();
  await panel.getByTestId("project-test-submit").click();
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "pending");
  await closeTaskPanel(page);
  await openNeedsYou(page);
  await page.getByTestId("permission-deny").click();
  await expect(page.getByTestId("permission-outcome")).toHaveAttribute("data-status", "denied");
  await openAllTasks(page);
  const again = await openTaskPanel(page, title);
  await expect(again.getByTestId("project-test-latest")).toHaveAttribute("data-status", "denied");
  await expect(again.getByTestId("project-test-outcome")).toContainText("No process was started");
  const rows = (await readRequests(request, backend, project)).requests;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "denied", startedAt: null, exitCode: null });
});

test("task UI: an exact Allow rule says it will run immediately, runs once on submit, and shows the result", async ({ page, request, freshBackend: backend }) => {
  const { project, title } = await settledTask(request, backend, "taskrule");
  const added = await request.post(`${backend.apiBase}/project-permissions/rules`, { headers: auth(backend), data: { projectPath: project, command: "bun test ./src/clamp.test.ts" } });
  expect(added.status()).toBe(201);
  await gotoBoard(page, backend.bootBase);
  const panel = await openTaskPanel(page, title);
  await panel.getByTestId("project-test-review").click();
  const box = panel.getByTestId("project-test-review-box");
  await expect(box).toHaveAttribute("data-effect", "allow");
  await expect(box.getByTestId("project-test-effect")).toContainText("runs the test immediately");
  await expect(box.getByTestId("project-test-submit")).toHaveText("Submit and run now");
  // A double click submits once: the button is disabled while the request is in flight.
  await box.getByTestId("project-test-submit").dblclick();
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "completed", { timeout: 60_000 });
  await expect(panel.getByTestId("project-test-outcome")).toContainText("Allowed by a project rule");
  const rows = (await readRequests(request, backend, project)).requests;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "completed", authority: "project-rule", exitCode: 0 });
});

test("task UI: a Deny rule says so before submission, and nothing runs", async ({ page, request, freshBackend: backend }) => {
  const { project, title } = await settledTask(request, backend, "taskdenyrule");
  const res = await request.put(`${backend.apiBase}/project-permissions/default`, { headers: auth(backend), data: { projectPath: project, mode: "deny" } });
  expect(res.ok()).toBeTruthy();
  await gotoBoard(page, backend.bootBase);
  const panel = await openTaskPanel(page, title);
  await panel.getByTestId("project-test-review").click();
  await expect(panel.getByTestId("project-test-effect")).toContainText("A project rule denies this");
  await panel.getByTestId("project-test-submit").click();
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "denied");
  const rows = (await readRequests(request, backend, project)).requests;
  expect(rows[0]).toMatchObject({ status: "denied", startedAt: null });
});

test("task UI: a target that changed after review is refused and needs a new review", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId, title } = await settledTask(request, backend, "taskchanged");
  const ws = await (await request.get(`${backend.apiBase}/task-workspace?taskId=${taskId}`, { headers: auth(backend) })).json() as { workspace: { stagingPath: string } };
  await gotoBoard(page, backend.bootBase);
  const panel = await openTaskPanel(page, title);
  await panel.getByTestId("project-test-review").click();
  await expect(panel.getByTestId("project-test-review-box")).toBeVisible();
  // The source changes on disk after the Owner looked.
  writeFileSync(path.join(ws.workspace.stagingPath, "src/clamp.ts"), clampSource + "// edited after review\n");
  await panel.getByTestId("project-test-submit").click();
  await expect(panel.getByTestId("project-test-notice")).toContainText("changed after you reviewed it");
  await expect(panel.getByTestId("project-test-review-box")).toHaveCount(0);
  expect(await permissionRequestCount(request, backend, project)).toBe(0);
  // A new review shows the new target and can be submitted.
  await panel.getByTestId("project-test-review").click();
  await panel.getByTestId("project-test-submit").click();
  await expect(panel.getByTestId("project-test-latest")).toHaveAttribute("data-status", "pending");
  expect(await permissionRequestCount(request, backend, project)).toBe(1);
});

test("task UI: when a test cannot be requested the panel shows the core's actual reason", async ({ page, request, freshBackend: backend }) => {
  const { project } = await settledTask(request, backend, "taskunavail");
  const bare = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title: "No workspace task", prompt: "nothing", workdir: project, column: "backlog", agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "none" },
  });
  expect(bare.ok(), await bare.text()).toBeTruthy();
  await gotoBoard(page, backend.bootBase);
  const panel = await openTaskPanel(page, "No workspace task");
  await expect(panel.getByTestId("project-test-unavailable")).toHaveAttribute("data-code", "workspace");
  await expect(panel.getByTestId("project-test-reason")).toContainText("No task-owned workspace is bound to this task and project");
  await expect(panel.getByTestId("project-test-review")).toHaveCount(0);
  expect(await permissionRequestCount(request, backend, project)).toBe(0);
});

test("task UI Russian: the section, the review and the effect are translated; the command stays exact", async ({ page, request, freshBackend: backend }) => {
  const { title } = await settledTask(request, backend, "taskru");
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByRole("dialog").locator("#interface-language").selectOption("ru");
  await page.keyboard.press("Escape");
  await openAllTasks(page);
  const panel = await openTaskPanel(page, title);
  await expect(panel.getByTestId("project-test-hint")).toContainText("Успех — это свидетельство только об этом тесте");
  await panel.getByTestId("project-test-review").click();
  await expect(panel.getByTestId("project-test-command")).toHaveText("bun test ./src/clamp.test.ts");
  await expect(panel.getByTestId("project-test-effect")).toContainText("Разрешить один раз");
  await expect(panel.getByTestId("project-test-stop-note")).toContainText("не прерывает тест");
});

// ---------------------------------------------------------------------------------------------
// FO-PERMISSIONS-04: the stored result is shown, read-only, next to QC in the same task's review.
// ---------------------------------------------------------------------------------------------

type Req = { id: string; projectPath: string; commandFingerprint: string; cwd: string; status: string };

/** Submit as the UI does, then give the one Owner "Allow once" over the API. The test itself runs for real. */
async function runForReal(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<Req> {
  const pending = (await ask(request, backend, taskId)).body as Req;
  const res = await request.post(`${backend.apiBase}/project-permissions/requests/${pending.id}/approve`, {
    headers: auth(backend),
    data: { projectPath: pending.projectPath, commandFingerprint: pending.commandFingerprint },
    timeout: 90_000,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as Req;
}

async function taskColumn(request: APIRequestContext, backend: E2EBackend, taskId: string) {
  const row = await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend) })).json() as { column: string; qcState: unknown };
  return row;
}

function evidenceOf(page: Page) {
  return page.getByTestId("task-quality-control").getByTestId("project-test-evidence");
}

test("review evidence: a real offline run appears next to QC as a current pass and changes nothing else", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId, title } = await settledTask(request, backend, "ev-real");
  await expect.poll(async () => (await taskColumn(request, backend, taskId)).column, { timeout: 30_000 }).toBe("review");

  await gotoBoard(page, backend.bootBase);
  const writes = watchPermissionWrites(page);
  await openTaskPanel(page, title);
  // Nothing requested yet: "Not run yet", which is neither a pass nor a failure.
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "not-run");
  await expect(evidenceOf(page).getByTestId("project-test-evidence-empty-kind")).toHaveText("Not run yet");
  await expect(evidenceOf(page).getByTestId("project-test-evidence-details")).toHaveCount(0);
  const qcBefore = await taskColumn(request, backend, taskId);

  const done = await runForReal(request, backend, taskId);
  expect(done.status).toBe("completed");

  // The open task refreshes from the permission event: no click, no reload.
  const latest = evidenceOf(page).getByTestId("project-test-evidence-latest");
  await expect(latest).toHaveAttribute("data-kind", "passed", { timeout: 30_000 });
  await expect(latest).toHaveAttribute("data-freshness", "current");
  await expect(evidenceOf(page)).toHaveAttribute("data-current-pass", "true");
  await expect(latest.getByTestId("project-test-evidence-latest-kind")).toHaveText("Passed");
  await expect(latest.getByTestId("project-test-evidence-latest-command")).toHaveText("bun test ./src/clamp.test.ts");
  await expect(latest.getByTestId("project-test-evidence-latest-freshness")).toContainText("Current");
  await expect(evidenceOf(page).getByTestId("project-test-evidence-note")).toContainText("does not set the QC verdict");
  // Raw output is not copied here.
  await expect(evidenceOf(page)).not.toContainText("1 pass");

  // The link opens the existing request details, where the bounded output summary lives.
  await evidenceOf(page).getByTestId("project-test-evidence-details").click();
  await expect(page.getByTestId("project-test-technical").first()).toContainText("1 pass");
  expect(writes).toHaveLength(0); // following the link is not a write

  // QC did not pass, the task is not Done, and the request record is the only thing that changed.
  const qcAfter = await taskColumn(request, backend, taskId);
  expect(qcAfter.column).toBe(qcBefore.column);
  expect(qcAfter.column).not.toBe("done");
  expect(qcAfter.qcState ?? null).toEqual(qcBefore.qcState ?? null);
  await expect(page.getByTestId("task-qc-awaiting-owner")).toHaveCount(0);
  expect((await readRequests(request, backend, project)).requests).toHaveLength(1);
});

test("review evidence: a source change after the pass makes it historical, never current proof", async ({ page, request, freshBackend: backend }) => {
  const { taskId, title } = await settledTask(request, backend, "ev-stale");
  await expect.poll(async () => (await taskColumn(request, backend, taskId)).column, { timeout: 30_000 }).toBe("review");
  const done = await runForReal(request, backend, taskId);
  await gotoBoard(page, backend.bootBase);
  await openTaskPanel(page, title);
  await expect(evidenceOf(page).getByTestId("project-test-evidence-latest")).toHaveAttribute("data-freshness", "current", { timeout: 30_000 });

  writeFileSync(path.join(done.cwd, "src/clamp.ts"), clampSource + "// changed after the pass\n");
  await page.reload();
  await gotoBoard(page, backend.bootBase);
  await openTaskPanel(page, title);
  const latest = evidenceOf(page).getByTestId("project-test-evidence-latest");
  await expect(latest).toHaveAttribute("data-kind", "passed", { timeout: 30_000 });
  await expect(latest).toHaveAttribute("data-freshness", "historical");
  await expect(evidenceOf(page)).toHaveAttribute("data-current-pass", "false");
  await expect(latest.getByTestId("project-test-evidence-latest-freshness")).toContainText("not proof for the current revision");
  await expect(latest.getByTestId("project-test-evidence-latest-freshness-reason")).toContainText("changed after this test ran");
});

test("review evidence: denied is 'did not run', and a newer pending attempt is not hidden by an earlier pass", async ({ page, request, freshBackend: backend }) => {
  const { taskId, title } = await settledTask(request, backend, "ev-newer");
  await expect.poll(async () => (await taskColumn(request, backend, taskId)).column, { timeout: 30_000 }).toBe("review");
  await runForReal(request, backend, taskId);
  await gotoBoard(page, backend.bootBase);
  await openTaskPanel(page, title);
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "passed", { timeout: 30_000 });

  // A newer attempt waits for the Owner: the headline is that, and the pass is labelled earlier.
  const pending = (await ask(request, backend, taskId)).body as Req;
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "pending", { timeout: 30_000 });
  await expect(evidenceOf(page).getByTestId("project-test-evidence-latest-kind")).toHaveText("Waiting for your decision");
  await expect(evidenceOf(page).getByTestId("project-test-evidence-earlier")).toHaveAttribute("data-kind", "passed");
  await expect(evidenceOf(page)).toHaveAttribute("data-current-pass", "false");
  await expect(page.getByTestId("project-test-earlier")).toBeVisible();

  // Denied: the headline reads "Did not run", never "Failed", and the earlier pass stays earlier.
  const denied = await request.post(`${backend.apiBase}/project-permissions/requests/${pending.id}/deny`, { headers: auth(backend), data: {} });
  expect(denied.ok()).toBeTruthy();
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "did-not-run", { timeout: 30_000 });
  await expect(evidenceOf(page).getByTestId("project-test-evidence-latest-kind")).toHaveText("Did not run");
  await expect(evidenceOf(page).getByTestId("project-test-evidence-latest-description")).toContainText("not a failed test");
  await expect(evidenceOf(page)).not.toContainText("Failed");
  await expect(evidenceOf(page)).toHaveAttribute("data-current-pass", "false");
});

test("review evidence: another task's result is never shown, and reloading is read-only", async ({ page, request, freshBackend: backend }) => {
  const a = await settledTask(request, backend, "ev-iso-a");
  const b = await settledTask(request, backend, "ev-iso-b");
  await expect.poll(async () => (await taskColumn(request, backend, a.taskId)).column, { timeout: 30_000 }).toBe("review");
  await expect.poll(async () => (await taskColumn(request, backend, b.taskId)).column, { timeout: 30_000 }).toBe("review");
  const doneA = await runForReal(request, backend, a.taskId);
  const finishedAt = (await readRequests(request, backend, a.project)).requests[0]!.finishedAt;

  await gotoBoard(page, backend.bootBase);
  const writes = watchPermissionWrites(page);
  await openTaskPanel(page, b.title);
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "not-run");
  await expect(evidenceOf(page)).not.toContainText(doneA.id);
  await closeTaskPanel(page);
  await openTaskPanel(page, a.title);
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "passed");
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await gotoBoard(page, backend.bootBase);
    await openTaskPanel(page, a.title);
    await expect(evidenceOf(page)).toHaveAttribute("data-kind", "passed");
  }
  expect(writes).toHaveLength(0);
  const rows = (await readRequests(request, backend, a.project)).requests;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.finishedAt).toBe(finishedAt);
  expect((await readRequests(request, backend, b.project)).requests).toHaveLength(0);
  expect((await taskColumn(request, backend, a.taskId)).column).not.toBe("done");
});

test("review evidence Russian: the kind, the freshness and the note are translated; the command stays exact", async ({ page, request, freshBackend: backend }) => {
  const { taskId, title } = await settledTask(request, backend, "ev-ru");
  await expect.poll(async () => (await taskColumn(request, backend, taskId)).column, { timeout: 30_000 }).toBe("review");
  await runForReal(request, backend, taskId);
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByRole("dialog").locator("#interface-language").selectOption("ru");
  await page.keyboard.press("Escape");
  await openAllTasks(page);
  await openTaskPanel(page, title);
  const latest = evidenceOf(page).getByTestId("project-test-evidence-latest");
  await expect(latest.getByTestId("project-test-evidence-latest-kind")).toHaveText("Пройден", { timeout: 30_000 });
  await expect(latest.getByTestId("project-test-evidence-latest-freshness")).toContainText("Актуально");
  await expect(latest.getByTestId("project-test-evidence-latest-command")).toHaveText("bun test ./src/clamp.test.ts");
  await expect(evidenceOf(page).getByTestId("project-test-evidence-note")).toContainText("не задаёт вердикт QC");
});

// ---------------------------------------------------------------------------------------------
// FO-PERMISSIONS-05: a deterministic worker suggests the test; the Owner decides in Needs you.
// ---------------------------------------------------------------------------------------------

const WORKER_MARKER = "__agetor_fake_worker_test_request__";

async function waitForWorkerRequest(request: APIRequestContext, backend: E2EBackend, project: string): Promise<Record<string, any>> {
  let found: Record<string, any> | undefined;
  await expect.poll(async () => {
    found = (await readRequests(request, backend, project)).requests[0];
    return found?.origin ?? "";
  }, { timeout: 30_000 }).toBe("worker");
  return found!;
}

test("worker suggestion: it waits in Needs you, runs nothing until Allow once, and the result lands in the same task's review", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId, title } = await settledTask(request, backend, "worker-flow", WORKER_MARKER);
  const pending = await waitForWorkerRequest(request, backend, project);
  expect(pending.status).toBe("pending");
  expect(pending.command).toBe("bun test ./src/clamp.test.ts");
  expect(pending.authority).toBeNull();
  expect(pending.exitCode).toBeNull();
  // The Owner submit route ignores a forged origin: only the core's own suggestion path sets it.
  const shown = await (await request.get(`${backend.apiBase}/project-permissions/tasks/${taskId}`, { headers: auth(backend) })).json() as { target: unknown };
  const forged = await request.post(`${backend.apiBase}/project-permissions/requests`, { headers: auth(backend), data: { taskId, reviewed: shown.target, origin: "worker", originRunId: "x" } });
  expect(forged.status()).toBe(409); // the worker's request is still open: "already open"; the forged origin changed nothing
  expect((await readRequests(request, backend, project)).requests).toHaveLength(1);

  await gotoApp(page, backend.bootBase);
  const writes = watchPermissionWrites(page);
  await openNeedsYou(page);
  const row = page.getByTestId("permission-request");
  await expect(row).toHaveAttribute("data-origin", "worker");
  await expect(row.getByTestId("permission-origin")).toContainText("cannot approve it");
  await expect(row).toContainText(title);
  await expect(row.getByTestId("permission-command")).toHaveText("bun test ./src/clamp.test.ts");
  await page.reload();
  await gotoApp(page, backend.bootBase);
  await openNeedsYou(page);
  await expect(page.getByTestId("permission-request")).toHaveCount(1);
  expect(writes).toHaveLength(0);
  // Still pending, still nothing run, after opening and reloading.
  const afterReload = (await readRequests(request, backend, project)).requests;
  expect(afterReload).toHaveLength(1);
  expect(afterReload[0]!.status).toBe("pending");
  expect(afterReload[0]!.startedAt).toBeNull();

  await page.getByTestId("permission-allow-once").click();
  const outcome = page.getByTestId("permission-outcome");
  await expect(outcome).toHaveAttribute("data-status", "completed", { timeout: 60_000 });
  const done = (await readRequests(request, backend, project)).requests[0]!;
  expect(done.exitCode).toBe(0);
  expect(done.authority).toBe("owner-once");
  expect(done.isolation).toBe("macos-offline-seatbelt");
  expect(done.origin).toBe("worker");

  const qcBefore = await taskColumn(request, backend, taskId);
  await gotoBoard(page, backend.bootBase);
  await openTaskPanel(page, title);
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "passed", { timeout: 30_000 });
  await expect(evidenceOf(page)).toHaveAttribute("data-current-pass", "true");
  expect((await readRequests(request, backend, project)).requests).toHaveLength(1);
  const qcAfter = await taskColumn(request, backend, taskId);
  expect(qcAfter.column).toBe(qcBefore.column);
  expect(qcAfter.column).not.toBe("done");
  expect(qcAfter.qcState ?? null).toEqual(qcBefore.qcState ?? null);
});

test("worker suggestion: Deny in Needs you starts nothing, and the task shows it did not run", async ({ page, request, freshBackend: backend }) => {
  const { project, taskId, title } = await settledTask(request, backend, "worker-deny", WORKER_MARKER);
  await waitForWorkerRequest(request, backend, project);
  await gotoApp(page, backend.bootBase);
  await openNeedsYou(page);
  await page.getByTestId("permission-deny").click();
  await expect(page.getByTestId("permission-outcome")).toHaveAttribute("data-status", "denied", { timeout: 30_000 });
  const rows = (await readRequests(request, backend, project)).requests;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("denied");
  expect(rows[0]!.startedAt).toBeNull();
  expect(rows[0]!.exitCode).toBeNull();
  await gotoBoard(page, backend.bootBase);
  await openTaskPanel(page, title);
  await expect(evidenceOf(page)).toHaveAttribute("data-kind", "did-not-run", { timeout: 30_000 });
  expect((await taskColumn(request, backend, taskId)).column).not.toBe("done");
});
