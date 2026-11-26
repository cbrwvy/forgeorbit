/**
 * FO-MANUAL-STAGING01 (Chromium, fake drivers, disposable profile and Git repository).
 *
 * Can the Owner create a task in a Git project by hand and prepare a task-owned
 * staging workspace without Head of PM? Every click below is the Owner's. Setup
 * (project, employee, harness switch) uses the API only; the task, the
 * admission, the assignment, Ready, the staging preparation and the launch
 * review are driven through the UI. Nothing is confirmed and no provider is
 * reached: fake drivers behind inert stubs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

test.describe.configure({ timeout: 120_000 });

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}`, "content-type": "application/json" });

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  return out;
}

const sheet = (page: Page) => page.getByRole("dialog").locator('[data-testid="new-task-panel"][data-presentation="sheet"]');

test("manual task in a Git project: staging needs isolation off, prepares a task-owned workspace, launch review starts nothing", async ({ page, request, freshBackend: b }) => {
  // Disposable Git repository with one committed test file (the output src/is-odd.ts does not exist).
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-manual-staging-")));
  const repo = path.join(root, "is-odd-fixture");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# isOdd fixture\n");
  writeFileSync(path.join(repo, "src/is-odd.test.ts"), "import { expect, test } from \"bun:test\";\nimport { isOdd } from \"./is-odd.ts\";\ntest(\"odd\", () => { expect(isOdd(3)).toBe(true); });\ntest(\"even\", () => { expect(isOdd(4)).toBe(false); });\n");
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]);

  const registered = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: repo, name: "isOdd fixture" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const project = (await registered.json()).path as string;
  const employee = await request.post(`${b.apiBase}/employees`, { headers: auth(b), data: { name: "Dev One", jobTitle: "Developer", projectPath: project } });
  expect(employee.status()).toBe(201);
  // The fixture resource: the Codex harness driven by the fake driver behind an inert stub.
  expect((await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } })).ok()).toBeTruthy();

  const repoState = async () => ({
    head: (await git(repo, ["rev-parse", "HEAD"])).trim(),
    status: await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    branches: await git(repo, ["branch", "--list"]),
    worktrees: await git(repo, ["worktree", "list", "--porcelain"]),
    testHash: createHash("sha256").update(readFileSync(path.join(repo, "src/is-odd.test.ts"))).digest("hex"),
  });
  const before = await repoState();
  expect(before.status).toBe("");

  const writes: string[] = [];
  page.on("request", (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return;
    const url = new URL(req.url());
    if (url.pathname.startsWith("/preferences/") || /^\/tasks\/[^/]+\/seen$/.test(url.pathname) || url.pathname === "/projects/discover") return;
    writes.push(`${req.method()} ${url.pathname}`);
  });

  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  await page.locator(`[data-testid="project-nav-item"][data-path="${project}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-board").click();

  // ---- A. New Task in a Git project: isolation is ON by default. ----
  async function newTask(title: string, prompt: string, isolate: boolean) {
    await page.getByTestId("project-new-task").click();
    const s = sheet(page);
    await expect(s).toBeVisible();
    const toggle = s.getByTestId("isolate-toggle");
    await expect(toggle).toBeEnabled();
    // The default is unchanged (ticked), and the hint says before creation that staging and worktrees are separate modes.
    await expect(toggle).toBeChecked();
    await expect(s.getByTestId("isolate-staging-hint")).toContainText("separate modes");
    await expect(s.getByTestId("isolate-staging-hint")).toContainText("Staging cannot be prepared for a task created with this on");
    if (!isolate) await toggle.uncheck();
    if (isolate) await expect(toggle).toBeChecked(); else await expect(toggle).not.toBeChecked();
    // The fixture resource: Codex (fake driver behind an inert stub). Its default model is the one the live plan names.
    await s.getByRole("button", { name: "Codex", exact: true }).click();
    await s.getByPlaceholder("Short description").fill(title);
    await s.locator("textarea").first().fill(prompt);
    await s.getByRole("button", { name: "To backlog" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async () => {
      const res = await request.get(`${b.apiBase}/tasks`, { headers: auth(b) });
      return ((await res.json()) as { title: string }[]).some((t) => t.title === title);
    }).toBeTruthy();
    const all = (await (await request.get(`${b.apiBase}/tasks`, { headers: auth(b) })).json()) as { id: string; title: string; isolation: string; column: string; agent: string; model: string | null }[];
    return all.find((t) => t.title === title)!;
  }

  const prompt = "Add src/is-odd.ts exporting isOdd(n: number): boolean. Do not modify other files.";
  const isolated = await newTask("isOdd (isolation left on)", prompt, true);
  expect(isolated.isolation).toBe("worktree");
  expect(isolated.column).toBe("backlog");

  // The task panel's staging control refuses a worktree-isolated task and says why. Nothing is created.
  await page.getByRole("button", { name: "isOdd (isolation left on)", exact: true }).first().click();
  await page.getByTestId("task-workspace-output-input").fill("src/is-odd.ts");
  await page.getByTestId("task-workspace-prepare").click();
  await expect(page.getByTestId("task-workspace-error")).toContainText("worktree isolation");
  test.info().annotations.push({ type: "refusal-text", description: (await page.getByTestId("task-workspace-error").innerText()).trim() });
  await expect(page.getByTestId("task-workspace-baseline")).toHaveCount(0);
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  // Let the panel finish closing before the next click; it can still sit over the New task button mid-animation.
  await expect(page.getByTestId("task-workspace-panel")).toHaveCount(0);

  // ---- B. The supported manual option: leave "Isolate worktree" unchecked. ----
  const task = await newTask("isOdd (task staging)", prompt, false);
  expect(task.isolation).toBe("none");
  expect(task.column).toBe("backlog");
  expect(task.agent).toBe("codex");
  expect(task.model).toBe("gpt-6.1-sol");

  await page.getByRole("button", { name: "isOdd (task staging)", exact: true }).first().click();
  const workflow = page.getByTestId("supervised-live-workflow");
  await expect(workflow).toBeVisible();
  const column = async () => ((await (await request.get(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b) })).json()) as { column: string }).column;

  await page.getByTestId("supervised-live-admit").click();
  await expect.poll(column).toBe("inbox");
  await page.getByTestId("supervised-live-ready").click();
  await expect.poll(column).toBe("ready");

  const assignment = page.getByTestId("task-assignment-panel");
  await assignment.getByTestId("task-assignment-pick").selectOption({ label: "Dev One" });
  await assignment.getByTestId("task-assignment-save").click();
  await expect(assignment.getByTestId("task-assignment-current")).toContainText("Dev One");

  // ---- C. Prepare the task-owned workspace for the single output. ----
  await expect(page.getByTestId("task-workspace-boundary")).toContainText("not an OS sandbox");
  await page.getByTestId("task-workspace-output-input").fill("src/is-odd.ts");
  await page.getByTestId("task-workspace-prepare").click();
  await expect(page.getByTestId("task-workspace-baseline")).toBeVisible();
  await expect(page.getByTestId("task-workspace-status")).toHaveText("armed");
  await expect(page.getByTestId("task-workspace-outputs")).toContainText("src/is-odd.ts");

  const wsRes = await request.get(`${b.apiBase}/task-workspace?taskId=${task.id}`, { headers: auth(b) });
  const ws = ((await wsRes.json()) as { workspace: any }).workspace as { status: string; stagingPath: string; projectPath: string; outputPaths: string[]; layout: string; sandbox: string; osSandbox: boolean; developerRunId: string | null };
  expect(ws).toMatchObject({ status: "armed", outputPaths: ["src/is-odd.ts"], layout: "non-git", sandbox: "workspace-write", osSandbox: false, developerRunId: null });
  expect(ws.stagingPath.startsWith(realpathSync(b.dataDir) + path.sep)).toBeTruthy();
  expect(ws.stagingPath.startsWith(repo + path.sep)).toBeFalsy();
  // The staged copy has the committed test and no output yet; the project is byte-for-byte unchanged.
  expect(existsSync(path.join(ws.stagingPath, "src/is-odd.test.ts"))).toBeTruthy();
  expect(existsSync(path.join(ws.stagingPath, "src/is-odd.ts"))).toBeFalsy();
  expect(await repoState()).toEqual(before);
  const noRuns = async () => expect(await (await request.get(`${b.apiBase}/tasks/${task.id}/runs`, { headers: auth(b) })).json()).toEqual([]);
  await noRuns();

  // ---- D. Open the launch review without confirming it. ----
  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("codex");
  await page.getByTestId("employee-execution-model").fill("gpt-6.1-sol");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("employee-run-banner")).toContainText("Nothing runs until you confirm");
  await expect(page.getByTestId("employee-run-task")).toHaveText("isOdd (task staging)");
  await expect(page.getByTestId("employee-run-worker")).toHaveText("Dev One");
  await expect(page.getByTestId("employee-run-harness")).toContainText("codex");
  const review = await dialog.innerText();
  await page.waitForTimeout(600); // the dialog fades in; capture it settled
  await page.screenshot({ path: test.info().outputPath("launch-review.png") });
  test.info().annotations.push({ type: "launch-review", description: review.replace(/\s+/g, " ").slice(0, 1500) });
  // Working directory = the task-owned staging directory; the project is shown only as the task's project.
  await expect(dialog).toContainText(ws.stagingPath);
  await expect(dialog).toContainText("Workspace-write sandbox: Codex can write only inside the working directory");
  await expect(dialog).not.toContainText("harness-differs-from-task");
  // Distinct meanings: the staging folder is where the agent runs; src/is-odd.ts is only eligible for later publication.
  const target = page.getByTestId("employee-run-target");
  await expect(target).toHaveAttribute("data-target", "task-staging");
  await expect(target).toContainText("runs in the prepared task workspace");
  await expect(target).toContainText("does not run in the project folder or in a Git worktree");
  await expect(page.getByTestId("employee-run-isolation")).toContainText("Task-owned workspace (not a Git worktree)");
  await expect(dialog).not.toContainText("works directly in the project folder");
  await expect(dialog).not.toContainText("No Git worktree isolation");
  const publish = page.getByTestId("employee-run-publish-paths");
  await expect(dialog).toContainText("Paths eligible for later publication");
  await expect(publish).toContainText("src/is-odd.ts");
  await expect(publish).toContainText("not a write restriction");
  await expect(publish).toContainText("separate Owner approval");
  await expect(publish).not.toContainText(ws.stagingPath);
  const workspaceRow = dialog.locator("dt", { hasText: /^Workspace$/ }).locator("xpath=following-sibling::dd[1]");
  await expect(workspaceRow).toContainText(ws.stagingPath);
  await expect(workspaceRow).not.toContainText("src/is-odd.ts");
  await expect(page.getByTestId("employee-run-account")).toContainText("Account Unknown");
  await expect(page.getByTestId("employee-run-quota")).toContainText("Quota Unknown");
  await noRuns();

  // Close without confirming (the review is withdrawn, not started).
  await page.getByTestId("employee-run-cancel").click();
  await expect(dialog).toHaveCount(0);

  // ---- E. Nothing started, nothing sent, nothing published, project untouched. ----
  await noRuns();
  const attempts = (await (await request.get(`${b.apiBase}/employee-execution/attempts?taskId=${task.id}`, { headers: auth(b) })).json()) as { attempts: { status: string }[] };
  expect(attempts.attempts.map((a) => a.status)).toEqual(["cancelled"]);
  const after = ((await (await request.get(`${b.apiBase}/task-workspace?taskId=${task.id}`, { headers: auth(b) })).json()) as { workspace: { status: string; developerRunId: string | null; publications: unknown[] } }).workspace;
  expect(after).toMatchObject({ status: "armed", developerRunId: null, publications: [] });
  expect(await repoState()).toEqual(before);
  expect(existsSync(path.join(repo, "src/is-odd.ts"))).toBeFalsy();
  const head = await (await request.get(`${b.apiBase}/portfolio-manager`, { headers: auth(b) })).json() as { messages?: unknown[] };
  expect(head.messages ?? []).toEqual([]);
  const qc = await (await request.get(`${b.apiBase}/tasks/${task.id}/qc`, { headers: auth(b) })).json() as { reviews: unknown[] };
  expect(qc.reviews).toHaveLength(0);
  const bad = writes.filter((w) => /\/start$|portfolio-manager|head-pm|\/publish|\/attempts\/[^/]+\/start/.test(w));
  expect(bad, writes.join("\n")).toEqual([]);
  test.info().annotations.push({ type: "page-writes", description: writes.join(" | ") });
});
