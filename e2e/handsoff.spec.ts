/**
 * Hands-off project execution ("Work independently"), through the real UI and the real core with the fake Codex
 * driver. One setup, one click on "Submit for work", and then the Owner does nothing: the page must show progress,
 * never an approval card, and end on a result. The UI is also watched for every mutating request it sends after
 * the submission: there must be none.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp, gotoBoard } from "./helpers";
import { clickProjectPage } from "./project-nav";
import { FAKE_TASK_FILES_MARKER } from "../src/shared/task-workspace.ts";

const home = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-handsoff-ui-home-")));
test.use({ backendEnv: { HOME: home, AGETOR_CODEX_DRIVER: "fake", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "600", AGETOR_FAKE_QC_VERDICT: "PASS" } });
test.describe.configure({ timeout: 150_000 });

const PAYLOAD = {
  writes: [
    { path: "src/profile.ts", contents: `export function displayName(name: string): string {\n  const trimmed = name.trim();\n  if (!trimmed) throw new Error("empty name");\n  return trimmed;\n}\n` },
    { path: "src/profile.test.ts", contents: `import { expect, test } from "bun:test";\nimport { displayName } from "./profile.ts";\ntest("rejects an empty display name", () => { expect(() => displayName("  ")).toThrow(); });\n` },
  ],
};

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" });

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

async function setup(request: APIRequestContext, backend: E2EBackend, name: string) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-handsoff-ui-${name}-`)));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "README.md"), "# synthetic\n");
  writeFileSync(path.join(project, "src/profile.ts"), `export function displayName(name: string): string {\n  return name;\n}\n`);
  await git(project, ["init", "-b", "main"]);
  await git(project, ["add", "-A"]);
  await git(project, ["-c", "user.email=fo-ui@example.com", "-c", "user.name=FO UI", "commit", "-m", "seed"]);
  const registered = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: project, name } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const workdir = (await registered.json()).path as string;
  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  for (const [employee, jobTitle, roleCategory] of [["Dana Developer", "Developer", "engineering"], ["Rae Reviewer", "Reviewer", "quality"]]) {
    const hired = await request.post(`${backend.apiBase}/employees`, { headers: auth(backend), data: { name: employee, jobTitle, roleCategory, projectPath: workdir } });
    expect(hired.ok(), await hired.text()).toBeTruthy();
  }
  return workdir;
}

async function newTask(request: APIRequestContext, backend: E2EBackend, workdir: string, title: string, column = "ready") {
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: `${title}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify(PAYLOAD)}`, workdir, column, agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "worktree", accessMode: "workspace" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return (await created.json()).id as string;
}

test("one setup and one Submit for work: progress, no approval card, a result, and no further owner request", async ({ page, request, backend }) => {
  const workdir = await setup(request, backend, "happy");
  const title = "Add validation for an empty display name";
  const taskId = await newTask(request, backend, workdir, title);
  const oldBacklog = await newTask(request, backend, workdir, "An old backlog item", "backlog");

  // Setup, once, through the project's settings page.
  await gotoBoard(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${workdir}"]`).click();
  await clickProjectPage(page, "settings");
  const settings = page.getByTestId("handsoff-settings");
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("data-enabled", "false");
  await settings.getByTestId("handsoff-enable").click();
  await expect(settings.getByTestId("handsoff-auto-apply")).toBeVisible();
  // Nothing is pre-selected: enabling covers no agent until the Owner ticks each role + account row.
  const resourceRows = settings.locator('[data-testid^="handsoff-resource-"]');
  await expect(resourceRows.first()).toBeVisible();
  for (let i = 0; i < await resourceRows.count(); i++) await expect(resourceRows.nth(i)).not.toBeChecked();
  for (let i = 0; i < await resourceRows.count(); i++) await resourceRows.nth(i).check();
  // A row is one role + harness + account: clearing the Developer row leaves the Reviewer row for the same login ticked.
  const developerRow = settings.locator('[data-testid^="handsoff-resource-developer-"]').first();
  const reviewerSibling = settings.getByTestId((await developerRow.getAttribute("data-testid"))!.replace("-developer-", "-reviewer-"));
  await developerRow.uncheck();
  await expect(developerRow).not.toBeChecked();
  if (await reviewerSibling.count()) await expect(reviewerSibling).toBeChecked();
  await developerRow.check();
  await settings.getByTestId("handsoff-auto-apply").check();
  await settings.getByTestId("handsoff-save").click();
  await expect(settings).toHaveAttribute("data-enabled", "true");
  const saved = await (await request.get(`${backend.apiBase}/handsoff/policy?projectPath=${encodeURIComponent(workdir)}`, { headers: auth(backend) })).json() as { policy: { enabled: boolean; autoApply: boolean; harnessIds: string[] }; workingCopy: boolean };
  expect(saved.policy).toMatchObject({ enabled: true, autoApply: true });
  expect(saved.policy.harnessIds.length).toBeGreaterThan(0);
  expect(saved.workingCopy).toBe(true);

  // Enabling the policy started nothing, old or new.
  await page.waitForTimeout(800);
  expect((await (await request.get(`${backend.apiBase}/tasks/${oldBacklog}/runs`, { headers: auth(backend) })).json() as unknown[]).length).toBe(0);
  expect((await (await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: auth(backend) })).json() as unknown[]).length).toBe(0);

  // The one deliberate act.
  await clickProjectPage(page, "board");
  const card = page.locator(`[data-testid="task-card"][data-task-id="${taskId}"]`);
  await expect(card).toBeVisible();
  const mutating: string[] = [];
  page.on("request", (req) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method()) && req.url().startsWith(backend.apiBase)) mutating.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await card.getByTestId("task-card-submit-handsoff").click();
  await expect(card.getByTestId("task-card-handsoff")).toBeVisible({ timeout: 20_000 });

  // Never an approval card while it works.
  await expect.poll(async () => {
    const run = (await (await request.get(`${backend.apiBase}/handsoff/tasks/${taskId}`, { headers: auth(backend) })).json() as { run: { status: string } | null }).run;
    expect(await page.getByTestId("attention-handsoff-row").count()).toBe(0);
    expect(await page.getByTestId("permission-request").count()).toBe(0);
    return run?.status;
  }, { timeout: 90_000, intervals: [300] }).toBe("done");

  // Zero owner requests after the submission, a real change in the project, and an honest result.
  expect(mutating).toEqual(["POST /handsoff/submit"]);
  expect(readFileSync(path.join(workdir, "src/profile.ts"), "utf8")).toContain("empty name");
  expect((await (await request.get(`${backend.apiBase}/tasks/${oldBacklog}/runs`, { headers: auth(backend) })).json() as unknown[]).length).toBe(0);
  const rows = await (await request.get(`${backend.apiBase}/owner-actions`, { headers: auth(backend) })).json() as { handsoffBlockers?: unknown[]; projectPermissionRequests?: unknown[] };
  expect(rows.handsoffBlockers ?? []).toEqual([]);
  expect(rows.projectPermissionRequests ?? []).toEqual([]);

  await card.click();
  const panel = page.getByTestId("handsoff-panel");
  await expect(panel).toHaveAttribute("data-status", "done");
  await expect(panel.getByTestId("handsoff-result-files")).toContainText("src/profile.ts");
  await expect(panel.getByTestId("handsoff-result-tests")).toHaveAttribute("data-state", "passed");
  await expect(panel.getByTestId("handsoff-result-review")).toContainText("Approved");
  await expect(panel.getByTestId("handsoff-result-delivery")).toContainText("Applied to the project folder");
});

test("with automatic application off it ends at Ready to apply, and a blocked task is one Needs-you row with one action", async ({ page, request, backend }) => {
  const workdir = await setup(request, backend, "ready");
  const taskId = await newTask(request, backend, workdir, "Prepare only");
  const available = (await (await request.get(`${backend.apiBase}/handsoff/policy?projectPath=${encodeURIComponent(workdir)}`, { headers: auth(backend) })).json() as { available: { harnessId: string; accountKey: string }[] }).available;
  const put = await request.put(`${backend.apiBase}/handsoff/policy`, { headers: auth(backend), data: { projectPath: workdir, policy: { enabled: true, autoApply: false, harnessIds: [...new Set(available.map((o) => o.harnessId))], accountIds: [...new Set(available.map((o) => o.accountKey))] } } });
  expect(put.ok(), await put.text()).toBeTruthy();
  await gotoBoard(page, backend.bootBase);
  const card = page.locator(`[data-testid="task-card"][data-task-id="${taskId}"]`);
  await card.getByTestId("task-card-submit-handsoff").click();
  await expect.poll(async () => ((await (await request.get(`${backend.apiBase}/handsoff/tasks/${taskId}`, { headers: auth(backend) })).json()) as { run: { status: string } | null }).run?.status, { timeout: 90_000 }).toBe("ready-to-apply");
  expect(readFileSync(path.join(workdir, "src/profile.ts"), "utf8")).not.toContain("empty name");
  await expect(card.getByTestId("task-card-handsoff")).toContainText("Ready to apply");
  expect(await page.getByTestId("attention-handsoff-row").count()).toBe(0);

  // A second task in a project whose covered account list excludes every account blocks once, with one action.
  const blocked = await newTask(request, backend, workdir, "Blocked by coverage");
  const narrowed = await request.put(`${backend.apiBase}/handsoff/policy`, { headers: auth(backend), data: { projectPath: workdir, policy: { accountIds: ["no-such-account"] } } });
  expect(narrowed.ok(), await narrowed.text()).toBeTruthy();
  const submit = await request.post(`${backend.apiBase}/handsoff/submit`, { headers: auth(backend), data: { taskId: blocked } });
  expect(submit.status()).toBe(201);
  await expect.poll(async () => ((await (await request.get(`${backend.apiBase}/handsoff/tasks/${blocked}`, { headers: auth(backend) })).json()) as { run: { status: string } | null }).run?.status, { timeout: 30_000 }).toBe("needs-owner");
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-overview").click();
  await page.getByTestId("workspace-attention").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
  const row = page.getByTestId("attention-handsoff-row");
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toHaveAttribute("data-code", "no-resource");
  await expect(row).toContainText("Blocked by coverage");
  // One blocker, one row, one way forward; it names what was refused and that nothing was substituted.
  await expect(row).toContainText("none was substituted");
  await expect(row.getByTestId("attention-handsoff-open")).toBeVisible();
});
