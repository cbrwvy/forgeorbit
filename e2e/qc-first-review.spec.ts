/**
 * FO-QC-FIRST-TEST01 Owner panel. Synthetic project and fake Codex only.
 * Opening the panel does not run the test or start a Reviewer.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoBoard } from "./helpers";
import { FAKE_TASK_FILES_MARKER } from "../src/shared/task-workspace.ts";

const home = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-first-review-ui-home-")));
const HISTORICAL = "/Users/example/workspace/example-project";
test.use({ backendEnv: { HOME: home, AGETOR_CODEX_DRIVER: "fake", AGETOR_FAKE_QC_VERDICT: "PASS" } });
test.describe.configure({ timeout: 120_000 });

const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("min is greater than max");
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;
const clampTest = `import { expect, test } from "bun:test";
import { clampInt } from "./clamp.ts";
test("keeps an in-range value", () => { expect(clampInt(5, 0, 10)).toBe(5); });
`;

function auth(backend: E2EBackend) {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}

test("Owner authorizes one first-review test without a prior QC review", async ({ page, request, freshBackend: backend }) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-first-review-ui-")));
  expect(root === HISTORICAL || root.startsWith(`${HISTORICAL}/`)).toBe(false);
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "README.md"), "# synthetic first review\n");
  writeFileSync(path.join(project, "src/clamp.test.ts"), clampTest);
  await git(project, ["init", "-b", "main"]);
  await git(project, ["add", "README.md", "src/clamp.test.ts"]);
  await git(project, ["-c", "user.email=fo-ui@example.com", "-c", "user.name=FO UI", "commit", "-m", "seed"]);
  writeFileSync(path.join(project, "src/shift.ts"), "export function shiftChars(text: string): string { return text; }\n");
  const registered = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: project, name: "First review" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const workdir = (await registered.json()).path as string;
  expect(workdir).not.toBe(HISTORICAL);

  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  const prompt = `Add src/clamp.ts exporting clampInt. Do not modify other files.\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clampSource }] })}`;
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title: "First review clamp", prompt, workdir, column: "ready", agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "none" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const task = await created.json() as { id: string };

  const prepared = await request.post(`${backend.apiBase}/task-workspace/prepare`, { headers: auth(backend), data: { taskId: task.id, outputPaths: ["src/clamp.ts"] } });
  expect(prepared.ok(), await prepared.text()).toBeTruthy();
  const started = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(started.ok(), await started.text()).toBeTruthy();
  await expect.poll(async () => {
    const view = await request.get(`${backend.apiBase}/task-workspace?taskId=${task.id}`, { headers: auth(backend) });
    return ((await view.json()) as { workspace: { status: string } | null }).workspace?.status ?? "";
  }, { timeout: 20_000 }).toBe("settled");
  const published = await request.post(`${backend.apiBase}/task-workspace/publish`, {
    headers: auth(backend),
    data: { taskId: task.id, approve: true, paths: ["src/clamp.ts"] },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  await expect.poll(async () => {
    const row = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) });
    return ((await row.json()) as { column: string }).column;
  }, { timeout: 20_000 }).toBe("review");

  await gotoBoard(page, backend.bootBase);
  const card = page.getByRole("group", { name: "First review clamp", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("task-mark-done")).toBeVisible();
  await expect(async () => {
    await card.getByRole("button", { name: "First review clamp", exact: true }).click({ timeout: 3_000 });
    await expect(page.getByTestId("task-quality-control")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId("qc-first-review-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("qc-recovery-panel")).toHaveCount(0);
  await expect(page.getByText("no missing-evidence QC BLOCKED review")).toHaveCount(0);
  await expect(page.getByTestId("qc-first-review-run")).not.toHaveText(/:\s*$/);
  await expect(page.getByTestId("qc-first-review-publication")).toContainText("published");
  await expect(page.getByTestId("qc-first-review-status")).toContainText("preview");
  await expect(page.getByTestId("qc-evidence-source")).toContainText("function clampInt");
  await expect(page.getByTestId("qc-evidence-test-source")).toContainText("keeps an in-range value");
  await expect(page.getByTestId("qc-evidence-source")).not.toContainText("function shiftChars");
  await expect(page.getByTestId("qc-evidence-omitted")).toContainText("src/shift.ts");
  await expect(page.getByTestId("qc-evidence-proposed-command")).toContainText("bun test ./src/clamp.test.ts");
  await expect(page.getByTestId("qc-evidence-isolation")).toContainText("offline macOS Seatbelt");
  await expect(page.getByTestId("qc-evidence-test-output")).toHaveCount(0);
  await expect(page.getByTestId("qc-first-review-reviewer")).toContainText("Request AI review");
  await expect(page.getByTestId("task-qc-request")).toBeVisible();

  await page.getByTestId("qc-evidence-acknowledge").check();
  await page.getByTestId("qc-evidence-authorize").click();
  await expect(page.getByTestId("qc-evidence-test-status")).toContainText("prepared");
  await expect(page.getByTestId("qc-evidence-test-status")).toContainText("first-review");
  await expect(page.getByTestId("qc-evidence-test-output")).toHaveCount(0);
  await page.getByTestId("qc-evidence-approve-test").click();
  await expect(page.getByTestId("qc-evidence-test-status")).toContainText("approved");
  await expect(page.getByTestId("qc-evidence-test-output")).toHaveCount(0);
  await page.getByTestId("qc-evidence-run-test").click();
  await expect(page.getByTestId("qc-evidence-test-output")).toContainText("exit 0", { timeout: 20_000 });
  await expect(page.getByTestId("qc-evidence-bound")).toBeVisible();
  await expect(page.getByTestId("qc-first-review-status")).toContainText("complete");
  await expect(page.getByTestId("qc-evidence-test-status")).toContainText("consumed");
  await expect(page.getByTestId("qc-first-review-complete")).toBeVisible();
  await expect(page.getByTestId("task-qc-request")).toBeVisible();
  await expect(card.getByTestId("task-mark-done")).toBeVisible();

  const runs = await request.get(`${backend.apiBase}/tasks/${task.id}/runs`, { headers: auth(backend) });
  const rows = await runs.json() as { qcReviewId: string | null }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.qcReviewId).toBeNull();
  const taskRow = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) });
  expect((await taskRow.json() as { column: string }).column).toBe("review");
  const reviews = await request.get(`${backend.apiBase}/tasks/${task.id}/qc`, { headers: auth(backend) });
  expect((await reviews.json() as { reviews: unknown[] }).reviews).toHaveLength(0);
});
