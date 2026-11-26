/**
 * FO-QC-RECOVERY-PROVENANCE01. Synthetic database and fake Codex only.
 * Does not open the Owner profile, the historical Task B workspace, or a real provider.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assessQcRecovery } from "../shared/qc-recovery.ts";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-recovery-provenance-")));
const HISTORICAL = "/Users/example/workspace/example-project";
process.env.HOME = root;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4463";
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
test("clamps low and high", () => { expect(clampInt(-1, 0, 2)).toBe(0); expect(clampInt(9, 0, 2)).toBe(2); });
test("returns the bound when min equals max", () => { expect(clampInt(4, 4, 4)).toBe(4); });
test("rejects a reversed range", () => { expect(() => clampInt(1, 3, 2)).toThrow(RangeError); });
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

const url = (p: string) => `http://127.0.0.1:4463${p}`;
const authHeaders = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

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
  store.harnesses.setEnabled("codex", true);
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  db?.close?.();
  rmSync(root, { recursive: true, force: true });
});

function observationCount(taskId: string): number {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM review_test_observations WHERE task_id = ?`).get(taskId)?.n ?? 0;
}

async function recoveryView(taskId: string): Promise<{
  eligible: boolean;
  blockers: string[];
  evidenceReason: string | null;
  developerRunId: string | null;
  authorizesDeveloper: boolean;
  evidence: { publishedPaths?: string[]; note: string; basis: string; snapshotCapturedAtDeveloperRun: false } | null;
  evidenceRefresh: { eligible: boolean; blockedReviewId: string | null };
  firstReview: { applicable: boolean };
}> {
  const response = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: authHeaders() });
  expect(response.status).toBe(200);
  return response.json() as Promise<never>;
}

test.serial("a published task-owned file can be recovered after a Reviewer process failure", async () => {
  assertSynthetic(root);
  const dir = path.join(root, "project");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# synthetic recovery\n");
  writeFileSync(path.join(dir, "src/clamp.test.ts"), clampTest);
  writeFileSync(path.join(dir, ".env"), "TOKEN=secret-value\n");
  await git(dir, ["init", "-b", "main"]);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  await git(dir, ["add", "README.md", ".gitignore", "src/clamp.test.ts"]);
  await git(dir, ["-c", "user.email=fo-provenance@example.com", "-c", "user.name=FO Provenance", "commit", "-m", "seed"]);
  writeFileSync(path.join(dir, "src/shift.ts"), shiftSource);
  const projectPath = realpathSync(dir);
  assertSynthetic(projectPath);
  projects.upsert(projectPath, "provenance");
  const batchJson = JSON.stringify({ title: "paused", progress: { pauseReason: "Paused by the owner." } });
  const batchAt = 1793945386885;
  db.run(
    `INSERT INTO pm_orchestrated_batches (id, project_path, status, data_json, created_at, updated_at) VALUES (?, ?, 'paused', ?, ?, ?)`,
    ["batch-provenance", projectPath, batchJson, batchAt, batchAt],
  );

  const { createTask, startTask } = await import("./orchestrator.ts");
  const { prepareTaskWorkspace, publishTaskWorkspace } = await import("./task-workspace.ts");
  const created = await createTask({
    title: "Task B clamp",
    prompt: `${requirements}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clampSource }] })}`,
    workdir: projectPath,
    column: "ready",
    agent: "codex",
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const other = await createTask({
    title: "Task A stays ready",
    prompt: "Do not start",
    workdir: projectPath,
    column: "ready",
    agent: "codex",
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    isolation: "none",
  });
  if ("error" in other) throw new Error(other.error);

  await prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  expect("error" in await startTask(taskId)).toBe(false);
  for (let i = 0; i < 150; i++) {
    const row = db.query<{ status: string }, [string]>(`SELECT status FROM task_workspaces WHERE task_id = ?`).get(taskId);
    if (row?.status === "settled" && tasks.get(taskId)?.column === "review") break;
    await Bun.sleep(20);
  }
  const developer = runs.listForTask(taskId).find((run) => run.status === "succeeded" && !run.qcReviewId);
  expect(developer?.endedAt).toBeNumber();
  const published = await publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] });
  expect(published.status).toBe("published");
  expect(createHash("sha256").update(readFileSync(path.join(projectPath, "src/clamp.ts"))).digest("hex")).toBe(clampHash);
  const publishedAt = new Date((developer!.endedAt ?? 0) + 60_000);
  utimesSync(path.join(projectPath, "src/clamp.ts"), publishedAt, publishedAt);
  expect(lstatSync(path.join(projectPath, "src/clamp.ts")).mtimeMs).toBeGreaterThan((developer!.endedAt ?? 0) + 2_000);
  expect(tasks.get(taskId)?.column).toBe("review");

  const preview = await recoveryView(taskId);
  expect(preview.eligible).toBe(false);
  expect(preview.firstReview.applicable).toBe(true);
  const preparedAuth = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30, purpose: "first-review" }),
  });
  expect(preparedAuth.status).toBe(201);
  const authId = (await preparedAuth.json() as { id: string; sourceFingerprint: string }).id;
  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${authId}/approve`), { method: "POST", headers: authHeaders() })).status).toBe(200);
  const executed = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${authId}/execute`), { method: "POST", headers: authHeaders() });
  expect(executed.status, await executed.clone().text()).toBe(200);
  const observed = await executed.json() as { bundle: { status: string; digest: string; sourceFingerprint: string; files: { path: string; sha256: string; role: string }[]; test: { provenance: string; exitCode: number; command: string } | null } };
  expect(observed.bundle.status).toBe("complete");
  expect(observed.bundle.test).toMatchObject({ command: "bun test ./src/clamp.test.ts", exitCode: 0, provenance: "forgeorbit-observed-test" });
  expect(observed.bundle.files.map((file) => file.path).sort()).toEqual(["src/clamp.test.ts", "src/clamp.ts"]);
  expect(observed.bundle.files.find((file) => file.path === "src/clamp.ts")?.sha256).toBe(clampHash);
  expect(observed.bundle.files.find((file) => file.path === "src/clamp.test.ts")?.sha256).toBe(clampTestHash);
  expect(observationCount(taskId)).toBe(1);

  process.env.AGETOR_FAKE_QC_VERDICT = "MODEL_NOT_FOUND";
  try {
    const preparedReview = await fetch(url(`/tasks/${taskId}/qc/reviews`), {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" }),
    });
    expect(preparedReview.status, await preparedReview.clone().text()).toBe(200);
    const reviewId = (await preparedReview.json() as { review: { id: string } }).review.id;
    const startedReview = await fetch(url(`/tasks/${taskId}/qc/reviews/${reviewId}/start`), { method: "POST", headers: authHeaders() });
    expect(startedReview.status, await startedReview.clone().text()).toBe(200);
  } finally {
    process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  }
  const failedDeadline = Date.now() + 8_000;
  while (Date.now() < failedDeadline && tasks.get(taskId)?.column !== "blocked") await Bun.sleep(40);
  expect(tasks.get(taskId)?.column).toBe("blocked");
  expect(tasks.get(taskId)?.qcState?.latestVerdict ?? null).toBeNull();
  expect(runs.listForTask(taskId)).toHaveLength(2);

  const eligible = await recoveryView(taskId);
  expect(eligible.eligible).toBe(true);
  expect(eligible.blockers).toEqual([]);
  expect(eligible.developerRunId).toBe(developer!.id);
  expect(eligible.authorizesDeveloper).toBe(false);
  expect(eligible.evidence?.snapshotCapturedAtDeveloperRun).toBe(false);
  expect(eligible.evidence?.basis).toBe("git-worktree-not-newer-than-developer-run");
  expect(eligible.evidence?.publishedPaths).toEqual(["src/clamp.ts"]);
  expect(eligible.evidence?.note).toContain("src/clamp.ts");
  expect(eligible.evidence?.note).toContain("publication");
  expect(eligible.evidenceRefresh.eligible).toBe(false);
  expect(eligible.evidenceRefresh.blockedReviewId).toBeNull();
  expect(eligible.firstReview.applicable).toBe(false);
  expect(observationCount(taskId)).toBe(1);

  const manifestRow = db.query<{ id: string; status: string; manifest_json: string }, [string]>(
    `SELECT id, status, manifest_json FROM task_workspaces WHERE task_id = ?`,
  ).get(taskId)!;
  const restoreManifest = () => db.run(
    `UPDATE task_workspaces SET status = ?, manifest_json = ? WHERE id = ?`,
    [manifestRow.status, manifestRow.manifest_json, manifestRow.id],
  );
  const restoreClamp = () => {
    writeFileSync(path.join(projectPath, "src/clamp.ts"), clampSource);
    utimesSync(path.join(projectPath, "src/clamp.ts"), publishedAt, publishedAt);
  };

  writeFileSync(path.join(projectPath, "src/clamp.ts"), `${clampSource}\n// edited\n`);
  const edited = await recoveryView(taskId);
  expect(edited.eligible).toBe(false);
  expect(edited.evidenceReason ?? "").toContain("no longer matches the bytes published for this Developer run");
  restoreClamp();

  const mismatched = JSON.parse(manifestRow.manifest_json) as { publications: { results: { afterSha256: string | null }[] }[] };
  mismatched.publications.at(-1)!.results[0]!.afterSha256 = "a".repeat(64);
  db.run(`UPDATE task_workspaces SET manifest_json = ? WHERE id = ?`, [JSON.stringify(mismatched), manifestRow.id]);
  const badHash = await recoveryView(taskId);
  expect(badHash.eligible).toBe(false);
  expect(badHash.evidenceReason ?? "").toContain("does not match the publication");
  restoreManifest();

  db.run(`UPDATE task_workspaces SET status = 'settled' WHERE id = ?`, [manifestRow.id]);
  const unpublished = await recoveryView(taskId);
  expect(unpublished.eligible).toBe(false);
  expect(unpublished.evidenceReason ?? "").toContain("changed after the successful Developer run");
  restoreManifest();

  const otherTask = JSON.parse(manifestRow.manifest_json) as { taskId: string };
  otherTask.taskId = other.task.id;
  db.run(`UPDATE task_workspaces SET manifest_json = ? WHERE id = ?`, [JSON.stringify(otherTask), manifestRow.id]);
  const wrongTask = await recoveryView(taskId);
  expect(wrongTask.eligible).toBe(false);
  expect(wrongTask.evidenceReason ?? "").toContain("different task");
  restoreManifest();

  const otherRun = JSON.parse(manifestRow.manifest_json) as { developerRunId: string };
  otherRun.developerRunId = "00000000-0000-4000-8000-000000000000";
  db.run(`UPDATE task_workspaces SET manifest_json = ? WHERE id = ?`, [JSON.stringify(otherRun), manifestRow.id]);
  const wrongRun = await recoveryView(taskId);
  expect(wrongRun.eligible).toBe(false);
  expect(wrongRun.evidenceReason ?? "").toContain("different Developer run");
  restoreManifest();

  rmSync(path.join(projectPath, "src/clamp.ts"));
  symlinkSync(path.join(projectPath, "README.md"), path.join(projectPath, "src/clamp.ts"));
  const linked = await recoveryView(taskId);
  expect(linked.eligible).toBe(false);
  expect(linked.evidenceReason ?? "").toContain("symlink");
  rmSync(path.join(projectPath, "src/clamp.ts"));
  restoreClamp();

  const escaped = JSON.parse(manifestRow.manifest_json) as { publications: { results: { path: string; status: string; afterSha256: string }[] }[] };
  escaped.publications.at(-1)!.results.push({ path: "../outside.ts", status: "applied", afterSha256: clampHash });
  db.run(`UPDATE task_workspaces SET manifest_json = ? WHERE id = ?`, [JSON.stringify(escaped), manifestRow.id]);
  const escapedView = await recoveryView(taskId);
  expect(escapedView.eligible).toBe(false);
  expect(escapedView.evidenceReason ?? "").toMatch(/unsafe|escapes/);
  restoreManifest();

  await git(projectPath, ["-c", "user.email=fo-provenance@example.com", "-c", "user.name=FO Provenance", "commit", "--allow-empty", "-m", "move HEAD"]);
  const moved = await recoveryView(taskId);
  expect(moved.eligible).toBe(false);
  expect(moved.evidenceReason ?? "").toContain("Git identity");
  await git(projectPath, ["reset", "--hard", "HEAD~1"]);
  const aged = new Date((developer!.endedAt ?? 0) - 5_000);
  for (const rel of ["README.md", ".gitignore", "src/clamp.test.ts", "src/shift.ts", ".env"]) {
    utimesSync(path.join(projectPath, rel), aged, aged);
  }
  restoreClamp();

  const shiftPath = path.join(projectPath, "src/shift.ts");
  const shiftWhen = new Date(Date.now() + 120_000);
  utimesSync(shiftPath, shiftWhen, shiftWhen);
  const newerShift = await recoveryView(taskId);
  expect(newerShift.eligible).toBe(false);
  expect(newerShift.evidenceReason ?? "").toContain("src/shift.ts");
  expect(newerShift.evidenceReason ?? "").toContain("changed after the successful Developer run");
  utimesSync(shiftPath, new Date((developer!.endedAt ?? 0) - 5_000), new Date((developer!.endedAt ?? 0) - 5_000));

  writeFileSync(shiftPath, "export const tampered = true;\n");
  const tampered = await recoveryView(taskId);
  expect(tampered.eligible).toBe(false);
  expect(tampered.evidenceReason ?? "").toContain("src/shift.ts");
  writeFileSync(shiftPath, shiftSource);
  utimesSync(shiftPath, new Date((developer!.endedAt ?? 0) - 5_000), new Date((developer!.endedAt ?? 0) - 5_000));

  const restored = await recoveryView(taskId);
  expect(restored.eligible).toBe(true);
  expect(observationCount(taskId)).toBe(1);
  expect(JSON.stringify(restored)).not.toContain("secret-value");
  expect(JSON.stringify(restored)).not.toContain("shiftChars");

  const runsBeforeGrant = runs.listForTask(taskId).length;
  const prepared = await fetch(url(`/tasks/${taskId}/qc-recovery`), {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify({ reviewerHarness: "codex", reviewerModel: "fixture-reviewer", reviewerEffort: "low", validMinutes: 30 }),
  });
  expect(prepared.status, await prepared.clone().text()).toBe(201);
  const grant = await prepared.json() as {
    id: string;
    status: string;
    developerRunId: string;
    launchesUsed: number;
    reviewerMode: string;
    reviewerSandbox: string;
    authorizesDeveloper: boolean;
    authorizesRework: boolean;
    authorizesOtherTasks: boolean;
    authorizesBatchResume: boolean;
    evidence: { publishedPaths?: string[] };
    evidenceBundle: {
      status: string;
      digest: string;
      sourceFingerprint: string;
      files: { path: string; role: string; sha256: string; provenance: string }[];
      omitted: { path: string }[];
      test: { provenance: string; command: string; exitCode: number } | null;
    };
  };
  expect(grant.status).toBe("prepared");
  expect(grant.developerRunId).toBe(developer!.id);
  expect(grant.launchesUsed).toBe(0);
  expect(grant.reviewerMode).toBe("ask");
  expect(grant.reviewerSandbox).toBe("read-only");
  expect(grant.authorizesDeveloper).toBe(false);
  expect(grant.authorizesRework).toBe(false);
  expect(grant.authorizesOtherTasks).toBe(false);
  expect(grant.authorizesBatchResume).toBe(false);
  expect(grant.evidence.publishedPaths).toEqual(["src/clamp.ts"]);
  expect(grant.evidenceBundle.status).toBe("complete");
  expect(grant.evidenceBundle.digest).toBe(observed.bundle.digest);
  expect(grant.evidenceBundle.sourceFingerprint).toBe(observed.bundle.sourceFingerprint);
  expect(grant.evidenceBundle.files.map((file) => file.path).sort()).toEqual(["src/clamp.test.ts", "src/clamp.ts"]);
  expect(grant.evidenceBundle.files.find((file) => file.path === "src/clamp.ts")).toMatchObject({ role: "implementation", sha256: clampHash, provenance: "forgeorbit-run-snapshot" });
  expect(grant.evidenceBundle.files.find((file) => file.path === "src/clamp.test.ts")).toMatchObject({ role: "test", sha256: clampTestHash });
  expect(grant.evidenceBundle.omitted.map((item) => item.path)).toContain("src/shift.ts");
  expect(grant.evidenceBundle.test).toMatchObject({ provenance: "forgeorbit-observed-test", command: "bun test ./src/clamp.test.ts", exitCode: 0 });
  expect(JSON.stringify(grant.evidenceBundle)).not.toContain("secret-value");
  expect(JSON.stringify(grant.evidenceBundle)).not.toContain("shiftChars");
  expect(runs.listForTask(taskId)).toHaveLength(runsBeforeGrant);
  expect(tasks.get(taskId)?.column).toBe("blocked");
  expect(observationCount(taskId)).toBe(1);

  const approved = await fetch(url(`/tasks/${taskId}/qc-recovery/${grant.id}/approve`), { method: "POST", headers: authHeaders() });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const approvedGrant = await approved.json() as { status: string; launchesUsed: number; reviewRunId: string | null; approvedBy: string };
  expect(approvedGrant).toMatchObject({ status: "approved", launchesUsed: 0, reviewRunId: null, approvedBy: "owner" });
  expect(runs.listForTask(taskId)).toHaveLength(runsBeforeGrant);

  const started = await fetch(url(`/tasks/${taskId}/qc-recovery/${grant.id}/start`), { method: "POST", headers: authHeaders() });
  expect(started.status, await started.clone().text()).toBe(200);
  const reviewRunId = (await started.json() as { runId: string }).runId;
  const passDeadline = Date.now() + 8_000;
  while (Date.now() < passDeadline && (tasks.get(taskId)?.qcState?.latestVerdict ?? null) !== "PASS") await Bun.sleep(40);
  expect(tasks.get(taskId)?.qcState?.latestVerdict).toBe("PASS");
  expect(tasks.get(taskId)?.column).toBe("review");
  expect(tasks.get(taskId)?.column).not.toBe("done");
  const prompt = runs.events(reviewRunId).filter((event) => event.stream === "user").map((event) => event.data).join("\n");
  expect(prompt).toContain(`Evidence digest: ${observed.bundle.digest}`);
  expect(prompt).toContain("clampInt");
  expect(prompt).toContain(`Developer run: ${developer!.id}`);
  expect(prompt).not.toContain("shiftChars");
  expect(prompt).not.toContain("secret-value");
  expect(runs.listForTask(taskId).filter((run) => !run.qcReviewId && run.status === "succeeded")).toHaveLength(1);
  expect(tasks.get(other.task.id)?.column).toBe("ready");
  expect(runs.listForTask(other.task.id)).toHaveLength(0);
  const batch = db.query<{ status: string; data_json: string; updated_at: number }, [string]>(
    `SELECT status, data_json, updated_at FROM pm_orchestrated_batches WHERE id = ?`,
  ).get("batch-provenance");
  expect(batch).toEqual({ status: "paused", data_json: batchJson, updated_at: batchAt });
  expect(observationCount(taskId)).toBe(1);
  expect(db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM qc_recovery_grants WHERE task_id = ?`).get(taskId)?.n).toBe(1);
}, 40_000);

test.serial("legacy recovery still rejects a newer file when no task workspace was published", async () => {
  const { collectRecoveryEvidence, QcRecoveryEvidenceError } = await import("./qc-recovery-evidence.ts");
  const dir = path.join(root, "legacy");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# legacy\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "."]);
  await git(dir, ["-c", "user.email=fo-provenance@example.com", "-c", "user.name=FO Provenance", "commit", "-m", "seed"]);
  writeFileSync(path.join(dir, "src/shift.ts"), shiftSource);
  const endedAt = Date.now() - 60_000;
  const input = {
    taskId: "legacy-task",
    title: "Legacy",
    prompt: "Implement shift",
    workdir: dir,
    projectPath: dir,
    isolation: "none",
    worktreePath: null,
    developerRunId: "legacy-run",
    developerEndedAt: endedAt,
  };
  await expect(collectRecoveryEvidence(input)).rejects.toBeInstanceOf(QcRecoveryEvidenceError);
  await expect(collectRecoveryEvidence(input)).rejects.toThrow(/changed after the successful Developer run/);
  const when = new Date(endedAt - 5_000);
  utimesSync(path.join(dir, "README.md"), when, when);
  utimesSync(path.join(dir, "src/shift.ts"), when, when);
  const evidence = await collectRecoveryEvidence(input);
  expect(evidence.publishedPaths).toBeUndefined();
  expect(evidence.basis).toBe("git-worktree-not-newer-than-developer-run");
  expect(evidence.note).toContain("none are newer");
  expect(assessQcRecovery({
    archived: false, column: "blocked", liveRun: false, activeReview: false,
    developerRunId: "run", developerSucceeded: true, failedReviewId: "review", failedReviewVerdict: null,
    failedReviewComplete: true, failedReviewImplementationRunId: "run", failedRunStatus: "failed",
    latestVerdict: "BLOCKED", workflowStatus: null, batchStatus: null, requirementsMatch: true,
  }).eligible).toBe(false);
  expect(assessQcRecovery({
    archived: false, column: "review", liveRun: false, activeReview: false,
    developerRunId: "run", developerSucceeded: true, failedReviewId: "review", failedReviewVerdict: null,
    failedReviewComplete: true, failedReviewImplementationRunId: "run", failedRunStatus: "failed",
    latestVerdict: "PASS", workflowStatus: null, batchStatus: null, requirementsMatch: true,
  }).eligible).toBe(false);
  expect(assessQcRecovery({
    archived: false, column: "review", liveRun: false, activeReview: false,
    developerRunId: "run", developerSucceeded: true, failedReviewId: "review", failedReviewVerdict: "CHANGES_REQUESTED",
    failedReviewComplete: true, failedReviewImplementationRunId: "run", failedRunStatus: "succeeded",
    latestVerdict: "CHANGES_REQUESTED", workflowStatus: null, batchStatus: null, requirementsMatch: true,
  }).eligible).toBe(false);
});
