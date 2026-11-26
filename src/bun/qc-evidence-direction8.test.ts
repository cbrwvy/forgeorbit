/**
 * Direction 8 (offline): what evidence reaches the independent Reviewer and the Owner.
 * Synthetic database, fake Codex Reviewer with a deterministic verdict, one real offline test child.
 * Does not open the historical Owner profile or any historical workspace.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";
import { MISSING_OBSERVED_TEST } from "../shared/review-evidence.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d8-evidence-")));
const HISTORICAL = "/Users/example/workspace/example-project";
process.env.HOME = root;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4852";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("min is greater than max");
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;
const clampHash = createHash("sha256").update(clampSource).digest("hex");
const clampTest = `import { expect, test } from "bun:test";
import { clampInt } from "./clamp.ts";
test("keeps an in-range value", () => {
  expect(clampInt(5, 0, 10)).toBe(5);
});
`;
const clampTestHash = createHash("sha256").update(clampTest).digest("hex");
const shiftSource = "export function shiftChars(text: string, amount: number): string { return text; }\n";
const requirements = "Add src/clamp.ts exporting clampInt. Do not modify other files.";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let projects: typeof import("./db.ts").projects;
let harnesses: typeof import("./db.ts").harnesses;
let orchestrator: typeof import("./orchestrator.ts");
let workspace: typeof import("./task-workspace.ts");
let recoverQcRecoveryGrants: typeof import("./qc-recovery.ts").recoverQcRecoveryGrants;

const url = (p: string) => `http://127.0.0.1:4852${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err || out);
  return out.trim();
}

function assertSynthetic(dir: string): void {
  const real = realpathSync(dir);
  if (real === HISTORICAL || real.startsWith(`${HISTORICAL}/`)) throw new Error("Refusing the historical workspace.");
}

beforeAll(async () => {
  const store = await import("./db.ts");
  db = store.db;
  tasks = store.tasks;
  runs = store.runs;
  projects = store.projects;
  harnesses = store.harnesses;
  harnesses.setEnabled("codex", true);
  orchestrator = await import("./orchestrator.ts");
  workspace = await import("./task-workspace.ts");
  ({ recoverQcRecoveryGrants } = await import("./qc-recovery.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  db?.close?.();
  rmSync(root, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const dir = path.join(root, name);
  assertSynthetic(root);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# synthetic first review\n");
  writeFileSync(path.join(dir, "src/clamp.test.ts"), clampTest);
  writeFileSync(path.join(dir, ".env"), "TOKEN=secret-value\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "README.md", "src/clamp.test.ts"]);
  await git(dir, ["-c", "user.email=fo-first@example.com", "-c", "user.name=FO First", "commit", "-m", "seed"]);
  writeFileSync(path.join(dir, "src/shift.ts"), shiftSource);
  const real = realpathSync(dir);
  assertSynthetic(real);
  projects.upsert(real, name);
  return real;
}

async function waitSettled(taskId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const view = workspace.getTaskWorkspace(taskId);
    if (view?.status === "settled" || view?.status === "published" || view?.status === "publication-partial") return;
    await Bun.sleep(20);
  }
  throw new Error(`workspace did not settle: ${workspace.getTaskWorkspace(taskId)?.status}`);
}

async function makeTask(dir: string, title: string): Promise<string> {
  const created = await orchestrator.createTask({
    title,
    prompt: `${requirements}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clampSource }] })}`,
    workdir: dir,
    column: "ready",
    agent: "codex",
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

function observationCount(taskId: string): number {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM review_test_observations WHERE task_id = ?`).get(taskId)?.n ?? 0;
}

function authCount(taskId: string): number {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM review_test_authorizations WHERE task_id = ?`).get(taskId)?.n ?? 0;
}

const wrongSource = "export function clampInt(value: number, min: number, max: number): number {\n  return 0;\n}\n";

async function publishedTask(name: string, source: string, beforePublish?: (taskId: string) => Promise<void>): Promise<{ dir: string; taskId: string; developerRunId: string }> {
  const dir = await project(name);
  const created = await orchestrator.createTask({
    title: `D8 ${name}`,
    prompt: `${requirements}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: source }] })}`,
    workdir: dir, column: "ready", agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  await workspace.prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  const started = await orchestrator.startTask(taskId);
  expect("error" in started).toBe(false);
  await waitSettled(taskId);
  if (beforePublish) await beforePublish(taskId);
  expect((await workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] })).status).toBe("published");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && tasks.get(taskId)?.column !== "review") await Bun.sleep(40);
  expect(tasks.get(taskId)?.column).toBe("review");
  return { dir, taskId, developerRunId: runs.listForTask(taskId).find((run) => run.status === "succeeded" && !run.qcReviewId)!.id };
}

/** Owner prepares, approves and runs the one observed test (real, offline). Returns the evidence digest. */
async function observeTest(taskId: string): Promise<{ authId: string; digest: string; exitCode: number }> {
  const prepared = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30, purpose: "first-review" }),
  });
  expect(prepared.status, await prepared.clone().text()).toBe(201);
  const authId = (await prepared.json() as { id: string }).id;
  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${authId}/approve`), { method: "POST", headers: auth() })).status).toBe(200);
  const executed = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${authId}/execute`), { method: "POST", headers: auth() });
  expect(executed.status, await executed.clone().text()).toBe(200);
  const body = await executed.json() as { bundle: { digest: string; test: { exitCode: number } } };
  return { authId, digest: body.bundle.digest, exitCode: body.bundle.test.exitCode };
}

/** Start one ordinary independent review with a fixed verdict, wait for it, and return what the Reviewer was sent. */
async function reviewWith(taskId: string, verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED"): Promise<string> {
  process.env.AGETOR_FAKE_QC_VERDICT = verdict;
  try {
    const prepared = await fetch(url(`/tasks/${taskId}/qc/reviews`), {
      method: "POST", headers: auth(), body: JSON.stringify({ reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" }),
    });
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    const reviewId = (await prepared.json() as { review: { id: string } }).review.id;
    const started = await fetch(url(`/tasks/${taskId}/qc/reviews/${reviewId}/start`), { method: "POST", headers: auth() });
    expect(started.status, await started.clone().text()).toBe(200);
    const reviewRunId = (await started.json() as { runId: string }).runId;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && tasks.get(taskId)?.qcState?.activeReviewId) await Bun.sleep(40);
    expect(tasks.get(taskId)?.qcState?.latestVerdict).toBe(verdict);
    return runs.events(reviewRunId).filter((event) => event.stream === "user").map((event) => event.data).join("\n");
  } finally {
    process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  }
}

test("a failing observed test reaches the Reviewer as a failure, is not a pass, and the verdict needs a new implementation", async () => {
  const { taskId, developerRunId } = await publishedTask("failing", wrongSource);
  const observed = await observeTest(taskId);
  expect(observed.exitCode).not.toBe(0);

  const prompt = await reviewWith(taskId, "CHANGES_REQUESTED");
  expect(prompt).toContain(`Evidence digest: ${observed.digest}`);
  expect(prompt).toContain("### ForgeOrbit-observed test");
  expect(prompt).toContain("Command: bun test ./src/clamp.test.ts");
  expect(prompt).toMatch(/Exit code: [1-9]/);
  expect(prompt).not.toContain("Exit code: 0");
  expect(prompt).toContain("It is not a QC verdict");
  expect(prompt).toContain(`Developer run: ${developerRunId}`);

  // The failing result did not become a pass, and the task did not reach Done.
  const task = tasks.get(taskId)!;
  expect(task.qcState).toMatchObject({ latestVerdict: "CHANGES_REQUESTED", awaitingOwnerApproval: false });
  expect(task.column).toBe("ready");
  const refused = await fetch(url(`/tasks/${taskId}`), { method: "PATCH", headers: auth(), body: JSON.stringify({ column: "done" }) });
  expect(refused.status).toBe(409);
});

test("a revision change after a recorded test: the old result is not sent to the Reviewer as evidence of the new bytes", async () => {
  const { dir, taskId } = await publishedTask("revision", clampSource);
  const observed = await observeTest(taskId);
  expect(observed.exitCode).toBe(0);

  // The code changes after the test was recorded.
  writeFileSync(path.join(dir, "src/clamp.ts"), `${clampSource}\n// changed after the recorded test\n`);
  const view = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: auth() }).then((response) => response.json()) as { firstReview: { bundle: { status: string; test: unknown } | null } };
  expect(view.firstReview.bundle?.test ?? null).toBeNull();
  expect(view.firstReview.bundle?.status).not.toBe("complete");

  // An Owner-started review of the changed bytes carries a limitation, never the earlier passing output.
  const prompt = await reviewWith(taskId, "BLOCKED");
  expect(prompt).toContain("## Evidence limitation");
  expect(prompt).not.toContain("### ForgeOrbit-observed test");
  expect(prompt).not.toContain(`Evidence digest: ${observed.digest}`);
  expect(prompt).toContain("return BLOCKED");
  expect(tasks.get(taskId)?.qcState).toMatchObject({ latestVerdict: "BLOCKED" });
  const refused = await fetch(url(`/tasks/${taskId}`), { method: "PATCH", headers: auth(), body: JSON.stringify({ column: "done" }) });
  expect(refused.status).toBe(409);

  // The earlier result stays on record for the bytes it observed; nothing was run again for the new ones.
  writeFileSync(path.join(dir, "src/clamp.ts"), clampSource);
  expect(observationCount(taskId)).toBe(1);
});

test("missing evidence: with no recorded test the Reviewer is told so, and the missing test is not a pass", async () => {
  const { taskId } = await publishedTask("missing", clampSource);
  expect(observationCount(taskId)).toBe(0);
  const prompt = await reviewWith(taskId, "BLOCKED");
  expect(prompt).toContain("## Evidence limitation");
  expect(prompt).toContain(MISSING_OBSERVED_TEST.split("\n")[0]!.slice(0, 40));
  expect(prompt).not.toContain("### ForgeOrbit-observed test");
  expect(tasks.get(taskId)?.qcState).toMatchObject({ latestVerdict: "BLOCKED", awaitingOwnerApproval: false });
  expect(tasks.get(taskId)?.column).not.toBe("done");
  expect(observationCount(taskId)).toBe(0);
});

test("the separate project test (run_project_test) is not an observed QC test: its result neither satisfies nor replaces the Reviewer's evidence", async () => {
  const permissions = await import("./project-permissions.ts");
  let projectTestPassed = false;
  const { taskId } = await publishedTask("project-test", clampSource, async (id) => {
    // The Owner's separate Allow once on the settled workspace, before anything is published.
    for (let i = 0; i < 150 && tasks.get(id)?.column === "running"; i++) await Bun.sleep(20);
    const request = await permissions.requestProjectTest({ taskId: id });
    expect(request.status).toBe("pending");
    const done = await permissions.approveOnce(request.id, { projectPath: request.projectPath, commandFingerprint: request.commandFingerprint } as never);
    expect(done.status).toBe("completed");
    expect(done.exitCode).toBe(0);
    projectTestPassed = true;
  });
  expect(projectTestPassed).toBe(true);
  const before = observationCount(taskId);
  expect(before).toBe(0);
  // No observed QC test exists because of it, and the Reviewer's evidence still says so.
  expect(observationCount(taskId)).toBe(before);
  const prompt = await reviewWith(taskId, "BLOCKED");
  expect(prompt).toContain("## Evidence limitation");
  expect(prompt).not.toContain("### ForgeOrbit-observed test");
  expect(tasks.get(taskId)?.qcState).toMatchObject({ latestVerdict: "BLOCKED" });
});
