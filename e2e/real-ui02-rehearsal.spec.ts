/**
 * FO-REAL-UI02 rehearsal: the four-call journey through the task UI with FAKE drivers only. It proves the click path,
 * the Owner-reserved steps, the disclosure of the restricted read scope and of the 600 s supervised limit, and that QC PASS
 * waits for a separate Accept. It is not live evidence: the Head, Developer and Reviewer here are local fakes, and the
 * restricted read profile itself is only exercised by the real-binary tests in src/bun/codex-read-scope*.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
import { FAKE_TASK_FILES_MARKER } from "../src/shared/task-workspace.ts";

const home = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-real-ui02-home-")));
test.use({
  backendEnv: {
    HOME: home,
    AGETOR_FAKE_QC_VERDICT: "PASS",
    FORGEORBIT_CODEX_READ_SCOPE: "restricted",
    FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS: "600",
  },
});
test.describe.configure({ timeout: 240_000 });

const isOddSource = "export function isOdd(n: number): boolean { return Math.abs(n % 2) === 1; }\n";
const isOddTest = `import { expect, test } from "bun:test";
import { isOdd } from "./is-odd.ts";
test("isOdd", () => { expect(isOdd(3)).toBe(true); expect(isOdd(4)).toBe(false); expect(isOdd(-1)).toBe(true); });
`;

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}`, "content-type": "application/json" });
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}
async function call(request: APIRequestContext, b: E2EBackend, method: string, route: string, data?: unknown) {
  const res = await request.fetch(b.apiBase + route, { method, data, headers: auth(b) });
  const text = await res.text();
  expect(res.ok(), `${method} ${route}: ${text}`).toBeTruthy();
  return text ? JSON.parse(text) : null;
}

test("the whole journey: Head creates, Head proposes staging, Developer implements, Reviewer passes, the Owner accepts", async ({ page, request, freshBackend: b }) => {
  // --- Setup that makes no model call --------------------------------------------------------------------------
  const project = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "fo-real-ui02-"))), "is-odd-fixture");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "README.md"), "# isOdd fixture\n");
  writeFileSync(path.join(project, "src/is-odd.test.ts"), isOddTest);
  await git(project, ["init", "-b", "main"]);
  await git(project, ["add", "."]);
  await git(project, ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-m", "seed"]);
  const registered = await call(request, b, "POST", "/projects", { path: project, name: "isOdd fixture" });
  const projectPath = registered.path as string;
  await call(request, b, "PATCH", "/harnesses/codex", { enabled: true });
  const developer = await call(request, b, "POST", "/employees", { projectPath, name: "Dev One", jobTitle: "Developer" });
  const preflight = await call(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call(request, b, "PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey } });

  const taskState = async (id: string) => (await call(request, b, "GET", `/tasks/${id}`)) as { column: string; runId: string | null; isolation: string; qcState: { latestVerdict: string | null; awaitingOwnerApproval: boolean } | null };

  // --- Call 1: Head creates one task ---------------------------------------------------------------------------
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  await page.getByTestId("head-pm-orb").click();
  await page.getByTestId("head-pm-scope").selectOption({ label: "isOdd fixture" });
  const composer = page.getByTestId("head-pm-composer");
  const send = async (text: string) => {
    // Opening a task from the Head's card can close the Head: reopen it and keep the same project as the scope.
    if (!(await composer.isVisible().catch(() => false))) {
      await page.getByTestId("head-pm-orb").click();
      await page.getByTestId("head-pm-scope").selectOption({ label: "isOdd fixture" });
    }
    const before = ((await call(request, b, "GET", "/portfolio-manager")) as { messages: unknown[] }).messages.length;
    await composer.fill(text);
    await page.getByTestId("head-pm-send").click();
    await expect.poll(async () => ((await call(request, b, "GET", "/portfolio-manager")) as { messages: unknown[] }).messages.length).toBe(before + 2);
  };
  await send(`__fake_head_board__ ${JSON.stringify({ kind: "create", title: "Add isOdd", description: "Add src/is-odd.ts exporting isOdd(n: number): boolean. Do not modify other files." })}`);
  const card = page.getByTestId("head-pm-board-proposal").last();
  await expect(card).toHaveAttribute("data-status", "pending");
  await card.getByTestId("head-pm-board-approve").click();
  await expect(card).toHaveAttribute("data-status", "applied");
  const tasks = (await call(request, b, "GET", "/tasks")) as Array<{ id: string; title: string }>;
  const taskId = tasks.find((t) => t.title === "Add isOdd")!.id;
  expect((await taskState(taskId)).column).toBe("backlog");
  expect((await taskState(taskId)).isolation).toBe("worktree");
  // Rehearsal only: the fake Developer needs its file instructions in the task prompt (a real Developer reads the prompt).
  const original = (await call(request, b, "GET", `/tasks/${taskId}`)) as { prompt: string };
  await call(request, b, "PATCH", `/tasks/${taskId}`, { prompt: `${original.prompt}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/is-odd.ts", contents: isOddSource }] })}` });

  // --- Between calls, ordinary clicks on the task: admit, assign the Developer, make it Ready --------------------
  await card.getByTestId("head-pm-board-open-task").click();
  await expect(page.getByTestId("supervised-live-workflow")).toBeVisible();
  await page.getByTestId("supervised-live-admit").click();
  await expect.poll(async () => (await taskState(taskId)).column).toBe("inbox");
  await page.getByTestId("task-assignment-pick").selectOption(developer.id);
  await page.getByTestId("task-assignment-save").click();
  await expect(page.getByTestId("task-assignment-current")).toContainText("Dev One");
  await page.getByTestId("supervised-live-ready").click();
  await expect.poll(async () => (await taskState(taskId)).column).toBe("ready");

  // --- Call 2: Head proposes staging; the Owner grants it ------------------------------------------------------
  await send(`__fake_head_board__ ${JSON.stringify({ kind: "plan_execution", taskId, employeeId: developer.id, harnessId: "codex" })}`);
  const staging = page.getByTestId("head-pm-board-proposal").last();
  await expect(staging).toHaveAttribute("data-kind", "plan_execution");
  await staging.getByTestId("head-pm-staging-outputs").fill("src/is-odd.ts");
  await staging.getByTestId("head-pm-staging-grant").check();
  await staging.getByTestId("head-pm-board-approve").click();
  await expect(staging).toHaveAttribute("data-status", "applied");
  const workspace = async () => ((await call(request, b, "GET", `/task-workspace?taskId=${taskId}`)) as { workspace: { status: string; outputPaths: string[] } | null }).workspace;
  expect((await workspace())?.status).toBe("armed");
  expect((await workspace())?.outputPaths).toEqual(["src/is-odd.ts"]);
  expect((await call(request, b, "GET", `/tasks/${taskId}/runs`)) as unknown[]).toHaveLength(0);

  // --- Call 3: the Developer. Prepare, review, confirm ---------------------------------------------------------
  if (await page.getByTestId("head-pm-close").isVisible().catch(() => false)) await page.getByTestId("head-pm-close").click();
  await expect(page.getByTestId("employee-execution")).toBeVisible();
  await page.getByTestId("employee-execution").locator("summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("codex");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("permission-time-limit")).toContainText("600 s");
  await expect(dialog.getByTestId("permission-time-limit")).toContainText("nothing about cost or quota");
  await expect(dialog.getByTestId("permission-disclosure")).toContainText("Read scope restricted");
  const usage = dialog.getByTestId("employee-run-usage");
  if (await usage.count()) await usage.locator("input[type=checkbox]").check();
  await page.getByTestId("employee-run-confirm").click();
  await expect.poll(async () => (await workspace())?.status, { timeout: 60_000 }).toBe("settled");
  await expect.poll(async () => (await taskState(taskId)).column, { timeout: 60_000 }).toBe("review");
  const devRuns = (await call(request, b, "GET", `/tasks/${taskId}/runs`)) as Array<{ status: string; termination?: unknown }>;
  expect(devRuns).toHaveLength(1);
  expect(devRuns[0]!.status).toBe("succeeded");

  // --- Between calls: publish only src/is-odd.ts, then run the exact offline test --------------------------------
  await page.getByTestId("task-workspace-pick-src-is-odd.ts").check();
  await page.getByTestId("task-workspace-approve").check();
  await page.getByTestId("task-workspace-publish").click();
  await expect.poll(async () => (await workspace())?.status).toBe("published");
  await page.getByTestId("qc-evidence-acknowledge").check();
  await page.getByTestId("qc-evidence-authorize").click();
  await expect(page.getByTestId("qc-evidence-proposed-command")).toContainText("bun test ./src/is-odd.test.ts");
  await page.getByTestId("qc-evidence-approve-test").click();
  await page.getByTestId("qc-evidence-run-test").click();
  await expect(page.getByTestId("qc-evidence-test-output")).toContainText("exit code 0", { timeout: 60_000 });

  // --- Call 4: the independent Reviewer ------------------------------------------------------------------------
  await expect(page.getByTestId("task-qc-time-limit")).toContainText("600 s");
  await page.getByTestId("task-qc-request").click();
  await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible({ timeout: 60_000 });
  const afterQc = await taskState(taskId);
  expect(afterQc.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true });
  // PASS leaves the task in Review. Only the Owner's separate Accept moves it to Done.
  expect(afterQc.column).toBe("review");
  await page.getByTestId("supervised-live-done").click();
  await expect.poll(async () => (await taskState(taskId)).column).toBe("done");
});
