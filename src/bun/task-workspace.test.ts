/**
 * FO-TASKB-WORKSPACE01. Synthetic git project and database only.
 * The Developer is the fake Codex driver. No provider call and no historical workspace.
 */
import { createHash } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assessQcRecovery } from "../shared/qc-recovery.ts";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-task-workspace-")));
const dataDir = path.join(root, "data");
const HISTORICAL = "/Users/example/workspace/example-project";
process.env.AGETOR_DATA_DIR = dataDir;
process.env.HOME = root;
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

const orchestrator = await import("./orchestrator.ts");
const store = await import("./db.ts");
const workspace = await import("./task-workspace.ts");
const evidence = await import("./review-evidence.ts");
const layout = await import("./execution-layout.ts");
const agents = await import("./agents.ts");
const permissions = await import("../shared/execution/permissions.ts");
const qc = await import("./task-quality-control.ts");

store.harnesses.setEnabled("codex", true);

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}

const shiftSource = "export function shiftChars(text: string, amount: number): string { return text; }\n";
const SHIFT_HASH = createHash("sha256").update(shiftSource).digest("hex");
const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("min is greater than max");
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;
const clampTest = `import { expect, test } from "bun:test";
import { clampInt } from "./clamp.ts";
test("returns an in-range value unchanged", () => { expect(clampInt(5, 0, 10)).toBe(5); });
test("clamps below the minimum and above the maximum", () => { expect(clampInt(-3, 0, 10)).toBe(0); expect(clampInt(12, 0, 10)).toBe(10); });
test("returns the only legal value when the bounds are equal", () => { expect(clampInt(1, 2, 2)).toBe(2); });
test("rejects a reversed range", () => { expect(() => clampInt(1, 3, 2)).toThrow(RangeError); });
`;

function prompt(writes: { path: string; contents: string }[], requirements: string): string {
  return `${requirements}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes })}`;
}

async function project(name: string): Promise<string> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# task b fixture\n");
  writeFileSync(path.join(dir, "src/clamp.test.ts"), clampTest);
  writeFileSync(path.join(dir, ".env"), "TOKEN=secret-value\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "README.md", "src/clamp.test.ts"]);
  await git(dir, ["-c", "user.email=fo-task@example.com", "-c", "user.name=FO Task", "commit", "-m", "seed"]);
  writeFileSync(path.join(dir, "src/shift.ts"), shiftSource);
  store.projects.upsert(dir, name);
  return realpathSync(dir);
}

async function task(dir: string, title: string, text: string): Promise<string> {
  const created = await orchestrator.createTask({
    title,
    prompt: text,
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

async function waitSettled(taskId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const view = workspace.getTaskWorkspace(taskId);
    if (view?.status === "settled" || view?.status === "published" || view?.status === "publication-partial") return;
    await Bun.sleep(20);
  }
  throw new Error(`workspace did not settle: ${workspace.getTaskWorkspace(taskId)?.status}`);
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("staging keeps the original project unchanged, attributes only clamp.ts, and publication needs approval", async () => {
  const historicalBefore = existsSyncSafe(path.join(HISTORICAL, "src/shift.ts"));
  const dir = await project("happy");
  expect(dir).not.toBe(HISTORICAL);
  const requirements = "Add src/clamp.ts exporting clampInt. Do not change other files.";
  const taskId = await task(dir, "Task B clampInt", prompt([{ path: "src/clamp.ts", contents: clampSource }], requirements));
  const batchJson = JSON.stringify({ title: "historical", progress: { pauseReason: "Paused by the owner." } });
  const batchAt = 1793945386885;
  store.db.run(
    `INSERT INTO pm_orchestrated_batches (id, project_path, status, data_json, created_at, updated_at) VALUES (?, ?, 'paused', ?, ?, ?)`,
    ["batch-workspace-01", dir, batchJson, batchAt, batchAt],
  );

  await expect(workspace.prepareTaskWorkspace(taskId, { outputPaths: ["../etc/passwd"] })).rejects.toThrow(/Unsafe/);
  const prepared = await workspace.prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  expect(prepared.osSandbox).toBe(false);
  expect(prepared.sandbox).toBe("workspace-write");
  expect(prepared.layout).toBe("non-git");
  expect(prepared.authorizesPublication).toBe(false);
  expect(prepared.files.some((file) => file.path === "src/shift.ts" && file.provenance === "untracked")).toBe(true);
  expect(prepared.files.some((file) => file.path === "src/clamp.ts" && file.provenance === "absent")).toBe(true);
  expect(prepared.omitted.some((item) => item.path === ".env")).toBe(true);
  expect(existsSyncSafe(path.join(prepared.stagingPath, ".git"))).toBe(false);
  expect(existsSyncSafe(path.join(prepared.stagingPath, ".env"))).toBe(false);
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);

  const detected = await layout.detectWorkspaceLayout({ isolation: "none", workdir: prepared.stagingPath, worktreePath: null });
  const reviewed = permissions.describePermissions({ kind: "codex", mode: "auto", ...detected })!;
  expect(reviewed).toMatchObject({ layout: "non-git", sandbox: "workspace-write", launchAllowed: true, escalated: false });
  const harness = store.harnesses.getByIdOrKind("codex")!;
  const command = await agents.buildCodexCommand(harness, "hi", {
    mode: "auto", model: "gpt-6.1-sol", effort: "low", codexPermissionReview: reviewed,
    codexPermissionIdentity: layout.workspacePermissionIdentity({ isolation: "none", workdir: prepared.stagingPath, worktreePath: null }, harness),
  }, prepared.stagingPath);
  expect(command.cmd).toContain("workspace-write");
  expect(command.cmd).not.toContain("danger-full-access");
  const repoReview = permissions.describePermissions({ kind: "codex", mode: "auto", layout: "repo-root", predicted: false })!;
  await expect(agents.buildCodexCommand(harness, "hi", {
    mode: "auto", model: "gpt-6.1-sol", effort: "low", codexPermissionReview: repoReview, codexPermissionIdentity: "stale",
  }, prepared.stagingPath)).rejects.toThrow(/differ from Owner Review/);

  const started = await orchestrator.startTask(taskId);
  expect("error" in started).toBe(false);
  await waitSettled(taskId);
  const settled = workspace.getTaskWorkspace(taskId)!;
  expect(settled.status).toBe("settled");
  expect(settled.exitCode).toBe(0);
  expect(settled.violation).toBe(false);
  expect(settled.developerRunId).toBeTruthy();
  expect(settled.changes.find((entry) => entry.path === "src/clamp.ts")).toMatchObject({ kind: "created", scope: "output" });
  expect(settled.changes.find((entry) => entry.path === "src/shift.ts")?.kind).toBe("unchanged");
  expect(settled.evidenceScope.included.map((item) => item.path)).toContain("src/clamp.ts");
  expect(settled.evidenceScope.included.map((item) => item.path)).not.toContain("src/shift.ts");
  expect(settled.evidenceScope.omitted.map((item) => item.path)).toContain("src/shift.ts");
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);
  expect(existsSyncSafe(path.join(dir, "src/clamp.ts"))).toBe(false);
  expect(store.runs.listForTask(taskId)).toHaveLength(1);
  expect(store.tasks.get(taskId)?.column).not.toBe("done");

  await expect(workspace.publishTaskWorkspace(taskId, { approve: false, paths: ["src/clamp.ts"] })).rejects.toThrow(/approve: true/);
  expect(existsSyncSafe(path.join(dir, "src/clamp.ts"))).toBe(false);
  writeFileSync(path.join(dir, "README.md"), "# changed under the developer\n");
  await expect(workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] })).rejects.toThrow(/changed in the project/);
  expect(existsSyncSafe(path.join(dir, "src/clamp.ts"))).toBe(false);
  writeFileSync(path.join(dir, "README.md"), "# task b fixture\n");
  await expect(workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/shift.ts"] })).rejects.toThrow(/not an in-scope/);
  const published = await workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] });
  expect(published.status).toBe("published");
  expect(sha(path.join(dir, "src/clamp.ts"))).toBe(createHash("sha256").update(clampSource).digest("hex"));
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);

  const run = store.runs.listForTask(taskId)[0]!;
  const bundle = await evidence.collectReviewEvidence({
    taskId,
    requirements,
    workspacePath: dir,
    projectPath: dir,
    developerRunId: run.id,
    developerEndedAt: run.endedAt ?? Date.now(),
    snapshot: evidence.readRunSourceSnapshot(run.id),
    rulesText: null,
    knowledgeRefs: [],
    resourceFingerprint: null,
  });
  expect(bundle.blocker).toBeNull();
  expect(bundle.files.map((file) => file.path).sort()).toEqual(["src/clamp.test.ts", "src/clamp.ts"]);
  expect(bundle.files.some((file) => file.path === "src/shift.ts")).toBe(false);
  expect(bundle.test).toBeNull();
  expect(bundle.status).toBe("preview");
  expect(JSON.stringify(bundle)).not.toContain("secret-value");

  const recovery = assessQcRecovery({
    archived: false, column: "review", liveRun: false, activeReview: false,
    developerRunId: run.id, developerSucceeded: true, failedReviewId: null, failedReviewVerdict: null,
    failedReviewComplete: false, failedReviewImplementationRunId: null, failedRunStatus: null,
    latestVerdict: null, workflowStatus: null, batchStatus: "paused", requirementsMatch: true,
  });
  expect(recovery.eligible).toBe(false);
  expect(recovery.blockers.join(" ")).toContain("finished Reviewer run");
  const firstReview = qc.prepareQcReview({ taskId, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  expect(firstReview.review.implementationRunId).toBe(run.id);
  expect(store.runs.listForTask(taskId)).toHaveLength(1);

  const runsBeforeRecover = store.runs.listForTask(taskId).length;
  store.db.run(`UPDATE task_workspaces SET status = 'executing' WHERE task_id = ?`, [taskId]);
  expect(workspace.recoverTaskWorkspaces()).toBe(1);
  expect(workspace.getTaskWorkspace(taskId)?.status).toBe("settled");
  expect(store.runs.listForTask(taskId)).toHaveLength(runsBeforeRecover);
  expect(store.tasks.get(taskId)?.column).not.toBe("done");
  const batch = store.db.query<{ status: string; data_json: string; updated_at: number }, [string]>(
    `SELECT status, data_json, updated_at FROM pm_orchestrated_batches WHERE id = ?`,
  ).get("batch-workspace-01")!;
  expect(batch).toEqual({ status: "paused", data_json: batchJson, updated_at: batchAt });
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM employee_executions").get()?.n).toBe(0);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_test_authorizations").get()?.n).toBe(0);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM qc_recovery_grants").get()?.n).toBe(0);
  if (historicalBefore) expect(sha(path.join(HISTORICAL, "src/shift.ts"))).toBe(historicalBefore);
}, 30_000);

test("an unauthorized edit of a pre-existing file is visible and cannot be published", async () => {
  const dir = await project("tamper");
  const taskId = await task(dir, "Task B tamper", prompt([
    { path: "src/clamp.ts", contents: clampSource },
    { path: "src/shift.ts", contents: "export const tampered = true;\n" },
  ], "Add clamp and do not touch shift."));
  await workspace.prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  const started = await orchestrator.startTask(taskId);
  expect("error" in started).toBe(false);
  await waitSettled(taskId);
  const settled = workspace.getTaskWorkspace(taskId)!;
  expect(settled.exitCode).toBe(0);
  expect(settled.violation).toBe(true);
  expect(settled.changes.find((entry) => entry.path === "src/shift.ts")?.scope).toBe("unauthorized");
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);
  await expect(workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/shift.ts"] })).rejects.toThrow(/not an in-scope/);
  await expect(workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts", "src/shift.ts"] })).rejects.toThrow(/not an in-scope/);
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);
  expect(existsSyncSafe(path.join(dir, "src/clamp.ts"))).toBe(false);
  const published = await workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] });
  expect(published.status).toBe("published");
  expect(readFileSync(path.join(dir, "src/clamp.ts"), "utf8")).toBe(clampSource);
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);
}, 30_000);

test("symlinks, oversized files, abandoned staging, and a partial publication stay inside the project", async () => {
  const dir = await project("edges");
  const linkTask = await task(dir, "link", "leave the tree alone");
  symlinkSync(path.join(dir, "README.md"), path.join(dir, "src/alias.ts"));
  await expect(workspace.prepareTaskWorkspace(linkTask, { outputPaths: ["src/clamp.ts"] })).rejects.toThrow(/symlink/);
  rmSync(path.join(dir, "src/alias.ts"));

  const huge = await task(dir, "huge", "too big");
  writeFileSync(path.join(dir, "src/big.ts"), "a".repeat(50_000));
  await expect(workspace.prepareTaskWorkspace(huge, { outputPaths: ["src/clamp.ts"] })).rejects.toThrow(/size limit/);
  rmSync(path.join(dir, "src/big.ts"));

  const abandonId = await task(dir, "abandon", "prepare only");
  const armed = await workspace.prepareTaskWorkspace(abandonId, { outputPaths: ["src/clamp.ts"] });
  workspace.abandonTaskWorkspace(abandonId);
  expect(existsSyncSafe(armed.stagingPath)).toBe(false);
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);

  const partialId = await task(dir, "partial", prompt([
    { path: "src/clamp.ts", contents: clampSource },
    { path: "notes/extra.ts", contents: "export const extra = 1;\n" },
  ], "two outputs"));
  await workspace.prepareTaskWorkspace(partialId, { outputPaths: ["src/clamp.ts", "notes/extra.ts"] });
  expect("error" in await orchestrator.startTask(partialId)).toBe(false);
  await waitSettled(partialId);
  workspace.__testing.beforePublishWrite = (rel) => {
    if (rel === "notes/extra.ts") throw new Error("injected publication fault");
  };
  await expect(workspace.publishTaskWorkspace(partialId, { approve: true, paths: ["src/clamp.ts", "notes/extra.ts"] })).rejects.toThrow(/injected publication fault/);
  workspace.__testing.beforePublishWrite = null;
  expect(readFileSync(path.join(dir, "src/clamp.ts"), "utf8")).toBe(clampSource);
  expect(existsSyncSafe(path.join(dir, "notes/extra.ts"))).toBe(false);
  expect(sha(path.join(dir, "src/shift.ts"))).toBe(SHIFT_HASH);
  const partial = workspace.getTaskWorkspace(partialId)!;
  expect(partial.status).toBe("publication-partial");
  expect(partial.publications.at(-1)?.outcome).toBe("partial");
}, 30_000);

function existsSyncSafe(file: string): string | false {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return false;
    return sha(file);
  } catch {
    return false;
  }
}
