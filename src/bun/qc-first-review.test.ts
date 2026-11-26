/**
 * FO-QC-FIRST-TEST01. Synthetic database, fake Codex, and one fake test child.
 * Does not open the historical Owner profile or the historical Task B workspace.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-first-review-")));
const HISTORICAL = "/Users/example/workspace/example-project";
process.env.HOME = root;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4461";
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

const url = (p: string) => `http://127.0.0.1:4461${p}`;
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

test("a first review with no QC review can authorize one observed test", async () => {
  const dir = await project("published");
  const taskId = await makeTask(dir, "Synthetic Task B");
  const batchJson = JSON.stringify({ title: "paused", progress: { pauseReason: "Paused by the owner." } });
  db.run(
    `INSERT INTO pm_orchestrated_batches (id, project_path, status, data_json, created_at, updated_at) VALUES (?, ?, 'paused', ?, 1793945386885, 1793945386885)`,
    ["batch-first-review", dir, batchJson],
  );
  const deployments = () => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM deployment_requests`).get()?.n ?? 0;
  const deploymentCount = deployments();
  await workspace.prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  const started = await orchestrator.startTask(taskId);
  expect("error" in started).toBe(false);
  await waitSettled(taskId);
  const published = await workspace.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] });
  expect(published.status).toBe("published");
  const reviewDeadline = Date.now() + 8_000;
  while (Date.now() < reviewDeadline && tasks.get(taskId)?.column !== "review") await Bun.sleep(40);
  const task = tasks.get(taskId);
  expect(task?.column).toBe("review");
  const developer = runs.listForTask(taskId).find((run) => run.status === "succeeded" && !run.qcReviewId);
  expect(developer?.id).toBeTruthy();
  const head = await git(dir, ["rev-parse", "HEAD"]);
  expect(observationCount(taskId)).toBe(0);

  const previewRes = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: auth() });
  expect(previewRes.status).toBe(200);
  const preview = await previewRes.json() as {
    eligible: boolean;
    firstReview: {
      applicable: boolean;
      eligible: boolean;
      blockers: string[];
      developerRunId: string | null;
      publicationStatus: string | null;
      bundle: {
        status: string;
        requirements: string;
        developerRunId: string;
        gitHead: string | null;
        files: { path: string; role: string; sha256: string; provenance: string }[];
        omitted: { path: string; reason: string }[];
        proposedTest: { command: string; argv: string[]; limitation: string } | null;
        test: unknown;
      } | null;
      testAuthorization: { status: string; invocationsUsed: number; purpose: string } | null;
    };
  };
  expect(preview.eligible).toBe(false);
  expect(preview.firstReview.applicable).toBe(true);
  expect(preview.firstReview.eligible).toBe(true);
  expect(preview.firstReview.blockers).toEqual([]);
  expect(preview.firstReview.developerRunId).toBe(developer!.id);
  expect(preview.firstReview.publicationStatus).toBe("published");
  const bundle = preview.firstReview.bundle!;
  expect(bundle.status).toBe("preview");
  expect(bundle.test).toBeNull();
  expect(bundle.requirements).toContain(requirements);
  expect(bundle.developerRunId).toBe(developer!.id);
  expect(bundle.gitHead).toBe(head);
  expect(bundle.files.map((file) => file.path).sort()).toEqual(["src/clamp.test.ts", "src/clamp.ts"]);
  expect(bundle.files.find((file) => file.path === "src/clamp.ts")).toMatchObject({ role: "implementation", sha256: clampHash, provenance: "forgeorbit-run-snapshot" });
  expect(bundle.files.find((file) => file.path === "src/clamp.test.ts")).toMatchObject({ role: "test", sha256: clampTestHash });
  expect(bundle.files.some((file) => file.path === "src/shift.ts")).toBe(false);
  expect(bundle.omitted.find((item) => item.path === "src/shift.ts")?.reason).toContain("Pre-existing untracked");
  expect(bundle.proposedTest?.command).toBe("bun test ./src/clamp.test.ts");
  expect(bundle.proposedTest?.argv).toEqual(["test", "./src/clamp.test.ts"]);
  expect(bundle.proposedTest?.limitation).toContain("offline macOS Seatbelt");
  expect(JSON.stringify(bundle)).not.toContain("secret-value");
  expect(observationCount(taskId)).toBe(0);
  expect(runs.listForTask(taskId)).toHaveLength(1);

  const refreshOnly = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "evidence-refresh" }),
  });
  expect(refreshOnly.status).toBe(409);
  expect(await refreshOnly.json()).toEqual({ error: "This task has no missing-evidence QC BLOCKED review.", code: "ineligible" });
  expect(authCount(taskId)).toBe(0);

  const unacked = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: false, purpose: "first-review" }),
  });
  expect(unacked.status).toBe(400);
  expect(observationCount(taskId)).toBe(0);

  const preparedRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30, purpose: "first-review" }),
  });
  expect(preparedRes.status).toBe(201);
  const prepared = await preparedRes.json() as { id: string; status: string; purpose: string; command: string; sourceFingerprint: string; developerRunId: string; maxInvocations: number; invocationsUsed: number; authorizesReviewer: boolean; authorizesDeveloper: boolean };
  expect(prepared).toMatchObject({
    status: "prepared",
    purpose: "first-review",
    command: "bun test ./src/clamp.test.ts",
    developerRunId: developer!.id,
    maxInvocations: 1,
    invocationsUsed: 0,
    authorizesReviewer: false,
    authorizesDeveloper: false,
  });
  expect(observationCount(taskId)).toBe(0);
  expect(runs.listForTask(taskId)).toHaveLength(1);

  const approvedRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${prepared.id}/approve`), { method: "POST", headers: auth() });
  expect(approvedRes.status).toBe(200);
  expect((await approvedRes.json() as { status: string }).status).toBe("approved");
  expect(observationCount(taskId)).toBe(0);

  writeFileSync(path.join(dir, "src/clamp.ts"), `${clampSource}\n// changed after approval\n`);
  const staleRun = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${prepared.id}/execute`), { method: "POST", headers: auth() });
  expect(staleRun.status).toBe(409);
  expect(observationCount(taskId)).toBe(0);
  const staleRow = db.query<{ status: string }, [string]>(`SELECT status FROM review_test_authorizations WHERE id = ?`).get(prepared.id);
  expect(staleRow?.status).toBe("invalidated");
  writeFileSync(path.join(dir, "src/clamp.ts"), clampSource);

  const cancelledRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30, purpose: "first-review" }),
  });
  expect(cancelledRes.status).toBe(201);
  const cancelled = await cancelledRes.json() as { id: string };
  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${cancelled.id}/cancel`), { method: "POST", headers: auth() })).status).toBe(200);
  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${cancelled.id}/execute`), { method: "POST", headers: auth() })).status).toBe(409);

  const expiredRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30, purpose: "first-review" }),
  });
  const expired = await expiredRes.json() as { id: string };
  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${expired.id}/approve`), { method: "POST", headers: auth() })).status).toBe(200);
  const expiredJson = db.query<{ authorization_json: string }, [string]>(`SELECT authorization_json FROM review_test_authorizations WHERE id = ?`).get(expired.id)!;
  const expiredAuth = JSON.parse(expiredJson.authorization_json) as { expiresAt: number | null };
  expiredAuth.expiresAt = Date.now() - 1_000;
  db.run(`UPDATE review_test_authorizations SET authorization_json = ? WHERE id = ?`, [JSON.stringify(expiredAuth), expired.id]);
  const expiredRun = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${expired.id}/execute`), { method: "POST", headers: auth() });
  expect(expiredRun.status).toBe(409);
  expect((await expiredRun.json() as { error: string }).error).toContain("expired");
  expect(observationCount(taskId)).toBe(0);

  const liveRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30, purpose: "first-review" }),
  });
  expect(liveRes.status).toBe(201);
  const live = await liveRes.json() as { id: string; sourceFingerprint: string };
  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${live.id}/approve`), { method: "POST", headers: auth() })).status).toBe(200);
  const executed = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${live.id}/execute`), { method: "POST", headers: auth() });
  expect(executed.status, await executed.clone().text()).toBe(200);
  const executedBody = await executed.json() as { authorization: { status: string; invocationsUsed: number; sourceFingerprint: string }; bundle: { status: string; digest: string; sourceFingerprint: string; test: { command: string; exitCode: number; sourceFingerprint: string; provenance: string } | null } };
  expect(executedBody.authorization).toMatchObject({ status: "consumed", invocationsUsed: 1, sourceFingerprint: live.sourceFingerprint });
  expect(executedBody.bundle.status).toBe("complete");
  expect(executedBody.bundle.test).toMatchObject({ command: "bun test ./src/clamp.test.ts", exitCode: 0, provenance: "forgeorbit-observed-test", sourceFingerprint: executedBody.bundle.sourceFingerprint });
  expect(observationCount(taskId)).toBe(1);
  expect(runs.listForTask(taskId)).toHaveLength(1);

  const second = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${live.id}/execute`), { method: "POST", headers: auth() });
  expect(second.status).toBe(409);

  const reopened = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: auth() }).then((response) => response.json()) as typeof preview;
  expect(reopened.firstReview.bundle?.status).toBe("complete");
  expect(reopened.firstReview.bundle?.test).toMatchObject({ exitCode: 0, sourceFingerprint: executedBody.bundle.sourceFingerprint });
  expect(reopened.firstReview.testAuthorization).toMatchObject({ status: "consumed", invocationsUsed: 1, purpose: "first-review" });
  expect(observationCount(taskId)).toBe(1);

  await recoverQcRecoveryGrants();
  const restarted = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: auth() }).then((response) => response.json()) as typeof preview;
  expect(restarted.firstReview.bundle?.status).toBe("complete");
  expect(restarted.firstReview.testAuthorization).toMatchObject({ status: "consumed", invocationsUsed: 1, purpose: "first-review" });
  expect(observationCount(taskId)).toBe(1);
  expect(runs.listForTask(taskId)).toHaveLength(1);
  expect(tasks.get(taskId)?.column).not.toBe("done");

  const preparedReview = await fetch(url(`/tasks/${taskId}/qc/reviews`), {
    method: "POST", headers: auth(), body: JSON.stringify({ reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" }),
  });
  expect(preparedReview.status, await preparedReview.clone().text()).toBe(200);
  expect(runs.listForTask(taskId)).toHaveLength(1);
  const reviewId = (await preparedReview.json() as { review: { id: string } }).review.id;
  const startedReview = await fetch(url(`/tasks/${taskId}/qc/reviews/${reviewId}/start`), { method: "POST", headers: auth() });
  expect(startedReview.status, await startedReview.clone().text()).toBe(200);
  const reviewRunId = (await startedReview.json() as { runId: string }).runId;
  const deadline = Date.now() + 8_000;
  let verdict: string | null = null;
  while (Date.now() < deadline && verdict !== "PASS") {
    verdict = tasks.get(taskId)?.qcState?.latestVerdict ?? null;
    if (verdict !== "PASS") await Bun.sleep(40);
  }
  expect(verdict).toBe("PASS");
  const prompt = runs.events(reviewRunId).filter((event) => event.stream === "user").map((event) => event.data).join("\n");
  expect(prompt).toContain(`Evidence digest: ${executedBody.bundle.digest}`);
  expect(prompt).toContain("clampInt");
  expect(prompt).toContain("bun test ./src/clamp.test.ts");
  expect(prompt).toContain(`Developer run: ${developer!.id}`);
  expect(prompt).toContain(`Git HEAD: ${head}`);
  expect(prompt).not.toContain("function shiftChars");
  expect(prompt).not.toContain("secret-value");
  expect(tasks.get(taskId)?.column).toBe("review");
  expect(tasks.get(taskId)?.column).not.toBe("done");
  expect(runs.listForTask(taskId).filter((run) => run.qcReviewId)).toHaveLength(1);
  const batch = db.query<{ status: string; data_json: string }, [string]>(`SELECT status, data_json FROM pm_orchestrated_batches WHERE id = ?`).get("batch-first-review");
  expect(batch).toEqual({ status: "paused", data_json: batchJson });
  expect(deployments()).toBe(deploymentCount);

  const authsBefore = authCount(taskId);
  const again = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "first-review" }),
  });
  expect(again.status).toBe(409);
  expect((await again.json() as { error: string }).error).toContain("A QC review already exists");
  const stillRefresh = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "evidence-refresh" }),
  });
  expect(stillRefresh.status).toBe(409);
  expect(await stillRefresh.json()).toEqual({ error: "This task has no missing-evidence QC BLOCKED review.", code: "ineligible" });
  expect(authCount(taskId)).toBe(authsBefore);
});

test("first-review eligibility rejects the wrong column, a failed run, a live run, and a legacy recovery grant", async () => {
  const dir = await project("gates");
  const taskId = await makeTask(dir, "Gates");
  tasks.update(taskId, { column: "backlog" });
  const backlog = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "first-review" }),
  });
  expect(backlog.status).toBe(409);
  expect((await backlog.json() as { error: string }).error).toContain("Review");

  tasks.update(taskId, { column: "review" });
  const missing = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "first-review" }),
  });
  expect(missing.status).toBe(409);
  expect((await missing.json() as { error: string }).error).toContain("current successful implementation run");

  const failedId = "failed-run-first";
  db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code) VALUES (?, ?, 'codex', 'failed', 1, 2, 1)`, [failedId, taskId]);
  tasks.update(taskId, { column: "review", runId: failedId });
  const failed = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "first-review" }),
  });
  expect(failed.status).toBe(409);
  expect((await failed.json() as { error: string }).error).toContain("failed implementation");

  const succeededId = "succeeded-run-first";
  db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code) VALUES (?, ?, 'codex', 'succeeded', 3, ?, 0)`, [succeededId, taskId, Date.now() + 60_000]);
  db.run(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('live-run-first', ?, 'codex', 'running', 4)`, [taskId]);
  tasks.update(taskId, { column: "review", runId: succeededId });
  const live = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "first-review" }),
  });
  expect(live.status).toBe(409);
  expect((await live.json() as { error: string }).error).toContain("still running");

  db.run(`DELETE FROM runs WHERE id = 'live-run-first'`);
  tasks.update(taskId, { column: "ready", runId: succeededId });
  const ready = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST", headers: auth(), body: JSON.stringify({ acknowledgeRisk: true, purpose: "first-review" }),
  });
  expect(ready.status).toBe(409);
  expect((await ready.json() as { error: string }).error).toContain("Review");

  const legacyId = "legacy-auth-first";
  const legacy = {
    id: legacyId,
    taskId,
    projectPath: dir,
    workspacePath: dir,
    developerRunId: succeededId,
    command: "bun test ./src/clamp.test.ts",
    executable: process.execPath,
    argv: ["test", "./src/clamp.test.ts"],
    testPath: "src/clamp.test.ts",
    sourceFingerprint: "f".repeat(64),
    timeoutMs: 20_000,
    maxOutputBytes: 24_000,
    isolation: "macos-offline-seatbelt",
    acknowledgedRisk: true,
    status: "prepared",
    maxInvocations: 1,
    invocationsUsed: 0,
    validMinutes: 30,
    expiresAt: null,
    approvedAt: null,
    observationId: null,
    failureReason: null,
    authorizesReviewer: false,
    authorizesDeveloper: false,
    authorizesRework: false,
    authorizesOtherTasks: false,
    authorizesBatchResume: false,
    createdAt: 1,
    updatedAt: 1,
  };
  db.run(
    `INSERT INTO review_test_authorizations (id, task_id, project_path, status, authorization_json, created_at, updated_at) VALUES (?, ?, ?, 'prepared', ?, 1, 1)`,
    [legacyId, taskId, dir, JSON.stringify(legacy)],
  );
  const approved = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${legacyId}/approve`), { method: "POST", headers: auth() });
  expect(approved.status).toBe(409);
  expect(await approved.json()).toEqual({ error: "This task has no missing-evidence QC BLOCKED review.", code: "ineligible" });
  const stored = db.query<{ status: string; authorization_json: string }, [string]>(`SELECT status, authorization_json FROM review_test_authorizations WHERE id = ?`).get(legacyId)!;
  expect(stored.status).toBe("prepared");
  expect(JSON.parse(stored.authorization_json).purpose).toBeUndefined();
  expect(observationCount(taskId)).toBe(0);
  expect(runs.listForTask(taskId).every((run) => !run.qcReviewId)).toBe(true);
});
