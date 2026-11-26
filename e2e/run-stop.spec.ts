import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoBoard, openAllTasks } from "./helpers";

/**
 * Supervised run control, driven through the task UI against a REAL local process: the real Codex tmux driver and a
 * stub `codex` that stays alive until it is stopped. Process exit is checked from this test with kill(pid, 0), not
 * through the app. No provider is called; the stub answers nothing a model would.
 */
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-run-stop-e2e-")));
const pids = path.join(scratch, "pids");
const behaviorFile = path.join(scratch, "behavior");
const stub = path.join(scratch, "codex-stub.sh");
mkdirSync(pids);
writeFileSync(behaviorFile, "");
writeFileSync(stub, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.200.0"; exit 0;;
  --help) echo "codex stub"; exit 0;;
esac
if [ "$1" = "exec" ]; then
  n=$(ls "${pids}" | wc -l | tr -d ' ')
  echo $$ > "${pids}/$((n + 1)).pid"
  behavior=$(head -n 1 "${behaviorFile}")
  tail -n +2 "${behaviorFile}" > "${behaviorFile}.tmp" && mv "${behaviorFile}.tmp" "${behaviorFile}"
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"stub-thread"}'
  case "$behavior" in
    hold) while :; do sleep 1; done;;
  esac
  echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
fi
exit 0
`);
chmodSync(stub, 0o755);
const tmuxBin = Bun.which("tmux") ?? "/opt/homebrew/bin/tmux";

const behavior = (...lines: string[]) => writeFileSync(behaviorFile, lines.map((line) => `${line}\n`).join(""));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const pidFiles = () => readdirSync(pids).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
async function pidAfter(known: number): Promise<number> {
  await expect.poll(() => pidFiles().length, { timeout: 30_000, message: "the stub process to start" }).toBeGreaterThan(known);
  return Number(readFileSync(path.join(pids, pidFiles()[known]!), "utf8").trim());
}
const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

const realProcessEnv = {
  AGETOR_CODEX_BIN: stub,
  AGETOR_CODEX_DRIVER: "",
  AGETOR_TMUX_BIN: tmuxBin,
  AGETOR_SKIP_CLI_VERSION_FLOOR: "1",
};

async function setup(request: APIRequestContext, b: E2EBackend, title: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "fo-run-stop-proj-"));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Idea\n");
  const project = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name: title } });
  expect(project.ok(), await project.text()).toBeTruthy();
  const enable = await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
  expect(enable.ok(), await enable.text()).toBeTruthy();
  return (await project.json()).path as string;
}
async function makeTask(request: APIRequestContext, b: E2EBackend, projectPath: string, title: string): Promise<string> {
  const res = await request.post(`${b.apiBase}/tasks`, {
    headers: auth(b),
    data: { title, prompt: `Do ${title}`, workdir: projectPath, agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none", column: "ready" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}
const getTask = async (request: APIRequestContext, b: E2EBackend, id: string) =>
  (await (await request.get(`${b.apiBase}/tasks/${id}`, { headers: auth(b) })).json()) as { column: string; runId: string | null; agent: string; prompt: string; qcState: { latestVerdict: string | null; activeReviewId: string | null } | null };
const getRuns = async (request: APIRequestContext, b: E2EBackend, id: string) =>
  (await (await request.get(`${b.apiBase}/tasks/${id}/runs`, { headers: auth(b) })).json()) as Array<{ id: string; status: string; termination?: { reason: string; outcome: string; processId: number | null } }>;
const getQc = async (request: APIRequestContext, b: E2EBackend, id: string) =>
  (await (await request.get(`${b.apiBase}/tasks/${id}/qc`, { headers: auth(b) })).json()) as { reviews: Array<{ status: string; verdict: string | null; summary: string | null }> };

async function openTask(page: import("@playwright/test").Page, b: E2EBackend, projectPath: string, title: string) {
  await gotoBoard(page, b.bootBase);
  await page.getByRole("button", { name: new RegExp(title) }).first().click();
}

test.describe("without a time limit", () => {
  test.use({ backendEnv: realProcessEnv });
  test.describe.configure({ timeout: 120_000 });

  test("the Owner stops a running Developer and then a running Reviewer from the task panel", async ({ page, request, freshBackend: b }) => {
    const projectPath = await setup(request, b, "Run stop");
    const devTitle = "Stop developer";
    const otherTitle = "Bystander";
    const dev = await makeTask(request, b, projectPath, devTitle);
    const other = await makeTask(request, b, projectPath, otherTitle);

    // A second task is running with its own process; stopping the first must not touch it.
    behavior("hold", "hold");
    const known = pidFiles().length;
    const startOther = await request.post(`${b.apiBase}/tasks/${other}/start`, { headers: auth(b) });
    expect(startOther.ok(), await startOther.text()).toBeTruthy();
    const otherPid = await pidAfter(known);

    await gotoBoard(page, b.bootBase);
    const card = page.getByRole("group", { name: devTitle, exact: true });
    await card.getByRole("button", { name: "Run", exact: true }).click({ force: true });
    const devPid = await pidAfter(known + 1);
    await page.getByRole("button", { name: new RegExp(devTitle) }).first().click();
    await expect(page.getByTestId("run-stop")).toBeVisible();

    // Manual Developer stop.
    await page.getByTestId("run-stop").click();
    await expect.poll(() => alive(devPid), { timeout: 20_000 }).toBe(false);
    const exited = page.getByTestId("run-termination");
    await expect(exited).toHaveAttribute("data-state", "exited", { timeout: 20_000 });
    await expect(exited).toContainText("Stopped by you. The process was observed to exit.");
    await expect(page.getByTestId("run-termination-next")).toContainText("Nothing was published");
    await expect.poll(async () => (await getTask(request, b, dev)).column).toBe("ready");
    const devRuns = await getRuns(request, b, dev);
    expect(devRuns).toHaveLength(1);
    expect(devRuns[0]!.status).toBe("cancelled");
    expect(devRuns[0]!.termination).toMatchObject({ reason: "manual", outcome: "exited", processId: devPid });
    expect((await getQc(request, b, dev)).reviews).toHaveLength(0);
    expect((await getTask(request, b, dev)).column).not.toBe("done");
    expect(alive(otherPid)).toBe(true);
    expect((await getTask(request, b, other)).column).toBe("running");

    // Manual Reviewer stop, on a task whose Developer finished on its own.
    const reviewTitle = "Stop reviewer";
    const reviewed = await makeTask(request, b, projectPath, reviewTitle);
    behavior("finish");
    const startReviewed = await request.post(`${b.apiBase}/tasks/${reviewed}/start`, { headers: auth(b) });
    expect(startReviewed.ok(), await startReviewed.text()).toBeTruthy();
    await expect.poll(async () => (await getTask(request, b, reviewed)).column, { timeout: 30_000 }).toBe("review");
    const before = await getTask(request, b, reviewed);
    await page.reload();
    await openAllTasks(page);
    await page.getByRole("button", { name: new RegExp(reviewTitle) }).first().click();
    await expect(page.getByTestId("task-quality-control")).toBeVisible();
    const reviewKnown = pidFiles().length;
    behavior("hold");
    await page.getByTestId("task-qc-request").click();
    const reviewPid = await pidAfter(reviewKnown);
    await expect.poll(async () => (await getQc(request, b, reviewed)).reviews[0]?.status).toBe("running");
    const liveTask = await getTask(request, b, reviewed);
    // Stop targets the Reviewer's own run, not the finished implementation run.
    const reviewRuns = await getRuns(request, b, reviewed);
    expect(reviewRuns).toHaveLength(2);
    expect(liveTask.runId).toBe(reviewRuns[0]!.id);
    await expect(page.getByTestId("run-stop")).toBeVisible();

    await page.getByTestId("run-stop").click();
    await expect.poll(() => alive(reviewPid), { timeout: 20_000 }).toBe(false);
    await expect(page.getByTestId("qc-termination")).toHaveAttribute("data-state", "exited", { timeout: 20_000 });
    await expect(page.getByTestId("qc-termination")).toContainText("Stopped by you. The process was observed to exit.");
    await expect(page.getByTestId("qc-termination-next")).toContainText("No verdict was recorded");
    await expect(page.getByTestId("task-qc-history")).toContainText("stopped by the Owner");
    // A stopped review is not a process failure and not a verdict.
    await expect(page.getByTestId("task-qc-process-failure")).toHaveCount(0);
    const qc = await getQc(request, b, reviewed);
    expect(qc.reviews[0]).toMatchObject({ status: "complete", verdict: null });
    const after = await getTask(request, b, reviewed);
    expect(after.column).toBe("blocked");
    expect(after.qcState?.latestVerdict).toBeNull();
    expect(after.qcState?.activeReviewId).toBeNull();
    expect([after.agent, after.prompt]).toEqual([before.agent, before.prompt]);
    const finalRuns = await getRuns(request, b, reviewed);
    expect(finalRuns.map((r) => r.status).sort()).toEqual(["cancelled", "succeeded"]);
    expect(alive(otherPid)).toBe(true);
    // Clean up the bystander through the same Stop path.
    const stopOther = await request.post(`${b.apiBase}/runs/${(await getTask(request, b, other)).runId}/cancel`, { headers: auth(b) });
    expect(((await stopOther.json()) as { termination: { outcome: string } }).termination.outcome).toBe("exited");
    expect(alive(otherPid)).toBe(false);
  });
});

test.describe("with an opt-in time limit", () => {
  test.use({ backendEnv: { ...realProcessEnv, FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS: "4" } });
  test.describe.configure({ timeout: 120_000 });

  test("a Reviewer reaches the limit before launch is shown, is stopped by the core, and reads the same in Russian at a compact width", async ({ page, request, freshBackend: b }) => {
    const projectPath = await setup(request, b, "Run limit");
    const title = "Limit reviewer";
    const id = await makeTask(request, b, projectPath, title);
    behavior("finish");
    const start = await request.post(`${b.apiBase}/tasks/${id}/start`, { headers: auth(b) });
    expect(start.ok(), await start.text()).toBeTruthy();
    await expect.poll(async () => (await getTask(request, b, id)).column, { timeout: 30_000 }).toBe("review");
    // A plain Run does not get the limit: only runs the Owner supervises do.
    const devRuns = await getRuns(request, b, id);
    expect(devRuns[0]!.termination).toBeUndefined();

    await openTask(page, b, projectPath, title);
    await expect(page.getByTestId("task-quality-control")).toBeVisible();
    // The effective limit is shown before the review is launched, and is only a time bound.
    await expect(page.getByTestId("task-qc-time-limit")).toContainText("4 s");
    await expect(page.getByTestId("task-qc-time-limit")).toContainText("not cost or quota");

    const known = pidFiles().length;
    behavior("hold");
    await page.getByTestId("task-qc-request").click();
    const pid = await pidAfter(known);
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    await expect(page.getByTestId("qc-termination")).toHaveAttribute("data-reason", "time-limit", { timeout: 20_000 });
    await expect(page.getByTestId("qc-termination")).toContainText("Stopped at the time limit of 4 s. The process was observed to exit.");
    await expect(page.getByTestId("task-qc-history")).toContainText("time limit of 4 s");
    const qc = await getQc(request, b, id);
    expect(qc.reviews[0]).toMatchObject({ status: "complete", verdict: null });
    expect((await getTask(request, b, id)).column).toBe("blocked");
    expect((await getTask(request, b, id)).column).not.toBe("done");
    const runs = await getRuns(request, b, id);
    const reviewRun = runs.find((r) => r.termination);
    expect(reviewRun).toMatchObject({ status: "cancelled", termination: { reason: "time-limit", outcome: "exited", processId: pid } });

    // The same record in Russian at a compact width: no clipped notice, the next step is named.
    const put = await request.put(`${b.apiBase}/preferences/locale`, { headers: auth(b), data: { value: "ru" } });
    expect(put.ok()).toBeTruthy();
    await page.setViewportSize({ width: 560, height: 900 });
    await page.reload();
    await openAllTasks(page);
    await page.getByRole("button", { name: new RegExp(title) }).first().click();
    const russian = page.getByTestId("qc-termination");
    await expect(russian).toContainText("Остановлено по лимиту времени 4 с. Завершение процесса подтверждено наблюдением.");
    await expect(page.getByTestId("qc-termination-next")).toContainText("Вердикт не записан");
    const box = await russian.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 560).toBe(true);
  });
});
