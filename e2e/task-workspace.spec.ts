/**
 * FO-TASKB-WORKSPACE01 Owner UI. Synthetic project and fake Codex only.
 * Preparing, publishing, and inspecting do not start a Reviewer or a batch.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoBoard } from "./helpers";
import { FAKE_TASK_FILES_MARKER } from "../src/shared/task-workspace.ts";

const home = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-task-workspace-ui-home-")));
test.use({ backendEnv: { HOME: home } });
test.describe.configure({ timeout: 120_000 });

const shiftSource = "export function shiftChars(text: string, amount: number): string { return text; }\n";
const shiftHash = createHash("sha256").update(shiftSource).digest("hex");
const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("min is greater than max");
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;
const clampTest = "import { expect, test } from \"bun:test\";\nimport { clampInt } from \"./clamp.ts\";\ntest(\"keeps an in-range value\", () => { expect(clampInt(5, 0, 10)).toBe(5); });\n";

function auth(backend: E2EBackend) {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}

test("Owner reviews a task-owned change set and publishes only the approved file", async ({ page, request, freshBackend: backend }) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-task-workspace-ui-")));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "README.md"), "# synthetic task b\n");
  writeFileSync(path.join(project, "src/clamp.test.ts"), clampTest);
  await git(project, ["init", "-b", "main"]);
  await git(project, ["add", "README.md", "src/clamp.test.ts"]);
  await git(project, ["-c", "user.email=fo-ui@example.com", "-c", "user.name=FO UI", "commit", "-m", "seed"]);
  writeFileSync(path.join(project, "src/shift.ts"), shiftSource);
  const registered = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: project, name: "Task workspace" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const workdir = (await registered.json()).path as string;

  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  const prompt = `Add src/clamp.ts exporting clampInt. Do not modify other files.\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clampSource }] })}`;
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title: "Synthetic Task B", prompt, workdir, column: "ready", agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "none" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const task = await created.json() as { id: string; title: string };
  const batchJson = JSON.stringify({ title: "paused historical batch" });
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  db.run(
    `INSERT INTO pm_orchestrated_batches (id, project_path, status, data_json, created_at, updated_at) VALUES (?, ?, 'paused', ?, 1793945386885, 1793945386885)`,
    ["ui-batch-workspace-01", workdir, batchJson],
  );
  db.close();

  await gotoBoard(page, backend.bootBase);
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await page.getByTestId("task-workspace-output-input").fill("src/clamp.ts");
  await page.getByTestId("task-workspace-prepare").click();
  await expect(page.getByTestId("task-workspace-baseline")).toBeVisible();
  await expect(page.getByTestId("task-workspace-outputs")).toContainText("src/clamp.ts");
  await expect(page.getByTestId("task-workspace-boundary")).toContainText("not an OS sandbox");

  const started = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(started.ok(), await started.text()).toBeTruthy();
  await expect(page.getByTestId("task-workspace-changes")).toContainText("src/clamp.ts");
  await expect(page.getByTestId("task-workspace-evidence-included")).toContainText("src/clamp.ts");
  await expect(page.getByTestId("task-workspace-evidence-included")).not.toContainText("src/shift.ts");
  await expect(page.getByTestId("task-workspace-evidence-omitted")).toContainText("src/shift.ts");
  await expect(page.getByTestId("task-workspace-violation")).toHaveCount(0);

  await page.getByTestId("task-workspace-pick-src-clamp.ts").check();
  await page.getByTestId("task-workspace-approve").check();
  await page.getByTestId("task-workspace-publish").click();
  await expect(page.getByTestId("task-workspace-status")).toHaveText("published");
  expect(readFileSync(path.join(workdir, "src/clamp.ts"), "utf8")).toBe(clampSource);
  expect(createHash("sha256").update(readFileSync(path.join(workdir, "src/shift.ts"))).digest("hex")).toBe(shiftHash);

  const after = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) });
  const body = await after.json() as { column: string };
  expect(body.column).not.toBe("done");
  const runs = await request.get(`${backend.apiBase}/tasks/${task.id}/runs`, { headers: auth(backend) });
  const runRows = await runs.json() as { qcReviewId: string | null }[];
  expect(runRows).toHaveLength(1);
  expect(runRows[0]?.qcReviewId).toBeNull();
  const reviews = await request.get(`${backend.apiBase}/tasks/${task.id}/qc`, { headers: auth(backend) });
  expect((await reviews.json() as { reviews: unknown[] }).reviews).toHaveLength(0);
  const check = new Database(path.join(backend.dataDir, "agetor.sqlite"), { readonly: true });
  const batch = check.query("SELECT status, data_json, updated_at FROM pm_orchestrated_batches WHERE id = ?").get("ui-batch-workspace-01") as { status: string; data_json: string; updated_at: number };
  check.close();
  expect(batch).toEqual({ status: "paused", data_json: batchJson, updated_at: 1793945386885 });
});
