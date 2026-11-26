/**
 * FO-QC-RECOVERY01 Owner UI. Fixture setup uses the API.
 * Review again, approval, and start go through visible controls.
 * The Reviewer is the in-process fake. This is not a real QC verdict.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend } from "./fixtures";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import { gotoBoard } from "./helpers";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-recovery-e2e-")));
const ownerHome = path.join(scratch, "owner");
mkdirSync(ownerHome);
const verdictFile = path.join(scratch, "verdict.txt");
writeFileSync(verdictFile, "MODEL_NOT_FOUND\n");
const codexBin = writeCodexProfileFixture(scratch, process.execPath);

test.use({
  backendEnv: {
    HOME: ownerHome,
    AGETOR_CODEX_BIN: codexBin,
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_FAKE_QC_VERDICT_FILE: verdictFile,
  },
});
test.describe.configure({ timeout: 120_000 });

function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}

test("Owner approves one QC-only review of the existing implementation", async ({ page, request, freshBackend: b }) => {
  mkdirSync(path.join(scratch, "project", "src"), { recursive: true });
  const projectPath = realpathSync(path.join(scratch, "project"));
  writeFileSync(path.join(projectPath, "src/shift.ts"), "export function shift(text: string, amount: number): string { return text; }\n");
  writeFileSync(path.join(projectPath, "README.md"), "# recovery e2e\n");
  await git(projectPath, ["init", "-b", "main"]);
  await git(projectPath, ["add", "."]);
  await git(projectPath, ["-c", "user.email=fo-qc@example.com", "-c", "user.name=FO QC", "commit", "-m", "seed"]);
  const registered = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: projectPath, name: "QC recovery" } });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const workdir = (await registered.json()).path as string;

  const dirA = path.join(ownerHome, "profile-a");
  const dirB = path.join(ownerHome, "profile-b");
  writeSyntheticCodexProfile(dirA, "subject-a");
  writeSyntheticCodexProfile(dirB, "subject-b");
  const profileA = await registerProfile(request, b, "Profile A", dirA);
  const profileB = await registerProfile(request, b, "Profile B", dirB);

  const taskA = await createTask(request, b, { title: "Task A", prompt: "Implement shift", workdir, agent: profileA.harnessId });
  const taskB = await createTask(request, b, { title: "Task B", prompt: "Implement clamp", workdir, agent: profileB.harnessId });
  const devA = await employee(request, b, "Developer A", workdir);
  const devB = await employee(request, b, "Developer B", workdir);
  expect((await request.post(`${b.apiBase}/task-assignments`, { headers: auth(b), data: { taskId: taskA.id, employeeId: devA } })).ok()).toBeTruthy();
  expect((await request.post(`${b.apiBase}/task-assignments`, { headers: auth(b), data: { taskId: taskB.id, employeeId: devB } })).ok()).toBeTruthy();

  const draft = await request.post(`${b.apiBase}/project-manager/orchestrated-batches`, { headers: auth(b), data: { path: workdir, taskIds: [taskA.id, taskB.id] } });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const batch = (await draft.json()).batch as { id: string; revision: number };
  const approved = await request.post(`${b.apiBase}/project-manager/orchestrated-batches/${batch.id}/approve`, {
    headers: auth(b),
    data: {
      path: workdir,
      revision: batch.revision,
      defaults: {
        implementerEmployeeId: devA,
        implementerHarnessId: profileA.harnessId,
        implementerModel: "gpt-6.1-sol",
        implementerMode: "auto",
        implementerEffort: "low",
        reviewerHarness: profileB.harnessId,
        reviewerModel: "gpt-6.1-sol",
        reviewerMode: "ask",
        autoReviewAfterImplementation: true,
        autoReworkOnChanges: false,
        maxLaunches: 2,
        maxReworkIterations: 0,
      },
      perTask: {
        [taskB.id]: { implementerEmployeeId: devB, implementerHarnessId: profileB.harnessId, implementerModel: "gpt-6.1-sol", implementerMode: "auto", implementerEffort: "low" },
      },
      validMinutes: 90,
    },
  });
  expect(approved.ok(), await approved.text()).toBeTruthy();
  const started = await request.post(`${b.apiBase}/project-manager/orchestrated-batches/${batch.id}/start`, { headers: auth(b), data: { path: workdir } });
  expect(started.ok(), await started.text()).toBeTruthy();

  await expect.poll(async () => {
    const task = await request.get(`${b.apiBase}/tasks/${taskA.id}`, { headers: auth(b) });
    return (await task.json()).column as string;
  }, { timeout: 30_000 }).toBe("blocked");
  const runsBefore = await request.get(`${b.apiBase}/tasks/${taskA.id}/runs`, { headers: auth(b) });
  const initialRuns = (await runsBefore.json()) as { id: string; qcReviewId: string | null; status: string }[];
  expect(initialRuns.filter((run) => run.status === "succeeded" && !run.qcReviewId)).toHaveLength(1);
  const developerRunId = initialRuns.find((run) => !run.qcReviewId)!.id;

  writeFileSync(verdictFile, "PASS\n");
  await gotoBoard(page, b.bootBase);
  const cardA = page.getByRole("group", { name: "Task A", exact: true });
  await expect(cardA).toBeVisible();
  await expect(async () => {
    await cardA.getByRole("button", { name: "Task A", exact: true }).click({ timeout: 3_000 });
    await expect(page.getByTestId("task-quality-control")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId("qc-recovery-failure")).toBeVisible();
  await expect(page.getByTestId("qc-recovery-developer-run")).toContainText(developerRunId);
  await expect(page.getByTestId("qc-recovery-failed-run")).toBeVisible();
  await page.getByTestId("qc-recovery-open").click();
  const harness = page.getByTestId("qc-recovery-harness");
  await harness.selectOption(profileB.harnessId);
  await expect(page.getByTestId("qc-recovery-unsupported")).toContainText("gpt-6.1-sol");
  await expect(page.getByTestId("qc-recovery-model")).toHaveValue("");
  await page.getByTestId("qc-recovery-model").fill("fixture-reviewer");
  await expect(page.getByTestId("qc-recovery-preview")).toContainText("Profile B");
  await expect(page.getByTestId("qc-recovery-preview")).toContainText("ask");
  await expect(page.getByTestId("qc-recovery-preview")).toContainText("read-only");
  await expect(page.getByTestId("qc-recovery-quota").first()).toContainText("Unknown");
  await expect(page.getByTestId("qc-recovery-scope").first()).toContainText("does not authorize a Developer run");
  await page.getByTestId("qc-recovery-prepare").click();
  await expect(page.getByTestId("qc-recovery-fingerprint")).toBeVisible();
  await expect(page.getByTestId("qc-recovery-model-frozen")).toContainText("fixture-reviewer");
  await expect(page.getByTestId("qc-recovery-mode")).toContainText("ask");
  await expect(page.getByTestId("qc-recovery-launches")).toContainText("1");
  await page.getByTestId("qc-recovery-approve").click();
  await page.getByTestId("qc-recovery-start").click();

  await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("qc-recovery-pass")).toBeVisible();
  await expect(page.getByTestId("qc-recovery-new-run")).toBeVisible();
  const history = page.getByTestId("task-qc-history");
  await expect(history).toContainText("PASS");
  await expect(history).toContainText("complete");
  await expect(page.getByTestId("qc-recovery-runs")).toContainText("1");
  await expect(page.getByTestId("qc-recovery-runs")).toContainText("2");

  const runsAfter = await request.get(`${b.apiBase}/tasks/${taskA.id}/runs`, { headers: auth(b) });
  const finalRuns = (await runsAfter.json()) as { id: string; qcReviewId: string | null; status: string }[];
  expect(finalRuns.filter((run) => !run.qcReviewId && run.status === "succeeded").map((run) => run.id)).toEqual([developerRunId]);
  expect(finalRuns.filter((run) => run.qcReviewId)).toHaveLength(2);
  const taskBRow = await request.get(`${b.apiBase}/tasks/${taskB.id}`, { headers: auth(b) });
  expect((await taskBRow.json()).column).toBe("ready");
  const taskBRuns = await request.get(`${b.apiBase}/tasks/${taskB.id}/runs`, { headers: auth(b) });
  expect(await taskBRuns.json()).toEqual([]);
  const cardB = page.getByRole("group", { name: "Task B", exact: true });
  await expect(cardB.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(cardA.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  const taskARow = await request.get(`${b.apiBase}/tasks/${taskA.id}`, { headers: auth(b) });
  expect((await taskARow.json()).column).toBe("review");
  const batchRow = await request.get(`${b.apiBase}/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(workdir)}`, { headers: auth(b) });
  expect((await batchRow.json()).batch.status).toBe("paused");
});

async function registerProfile(request: APIRequestContext, backend: E2EBackend, displayName: string, directory: string): Promise<{ harnessId: string; accountId: string }> {
  const reg = await request.post(`${backend.apiBase}/account-core/codex-profiles`, { headers: auth(backend), data: { displayName, directory } });
  expect(reg.ok(), await reg.text()).toBeTruthy();
  const profile = (await reg.json()) as { harnessId: string; accountId: string };
  const check = await request.post(`${backend.apiBase}/account-core/codex-profiles/${profile.accountId}/check`, { headers: auth(backend), data: {} });
  expect(check.ok(), await check.text()).toBeTruthy();
  return profile;
}

async function createTask(request: APIRequestContext, backend: E2EBackend, body: { title: string; prompt: string; workdir: string; agent: string }): Promise<{ id: string }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { ...body, model: "gpt-6.1-sol", effort: "low", isolation: "none", column: "ready" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json() as Promise<{ id: string }>;
}

async function employee(request: APIRequestContext, backend: E2EBackend, name: string, projectPath: string): Promise<string> {
  const res = await request.post(`${backend.apiBase}/employees`, { headers: auth(backend), data: { name, jobTitle: "Eng", projectPath } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}
