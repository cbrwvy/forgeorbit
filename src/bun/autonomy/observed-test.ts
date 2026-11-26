/**
 * Policy-authorized observed tests for one task-owned workspace.
 * The command allowlist is not the isolation boundary. The existing offline
 * Seatbelt profile is. If that boundary cannot be built, nothing is spawned
 * and the attempt is blocked with the boundary's own reason.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { dataDir, db, tasks } from "../db.ts";
import { createBunProcessHost } from "../environment/process-host.ts";
import { createOfflineMacosBoundary, offlineBoundaryRequest, type OfflineMacosBoundary } from "../macos-offline-boundary.ts";
import { getTaskWorkspace, prepareTaskWorkspace, rearmSettledWorkspace } from "../task-workspace.ts";
import { autonomyPolicyStore } from "./policy-store.ts";
import type { AuthorizedTestGrant, AutonomyPolicyBody } from "../../shared/autonomy-policy.ts";
import {
  buildReworkBrief,
  commandFingerprint,
  composePracticalReworkPrompt,
  PRACTICAL_FAILURE_KINDS,
  PRACTICAL_TEST_OUTPUT_BYTES,
  PRACTICAL_TEST_TIMEOUT_MS,
  practicalEvidenceDigest,
  practicalFailureNeedsOwner,
  practicalFailureReworkable,
  testSummary,
  type PracticalFailureKind,
} from "../../shared/practical-cycle.ts";
import {
  approvedTestCommand,
  reviewFileRole,
  sha256Text,
  sourceFingerprint,
} from "../../shared/review-evidence.ts";

export { composePracticalReworkPrompt };

type BoundaryFactory = typeof createOfflineMacosBoundary;
let boundaryFactory: BoundaryFactory = createOfflineMacosBoundary;
let practicalTestTail: Promise<void> = Promise.resolve();

export function withPracticalTestLock<T>(work: () => Promise<T>): Promise<T> {
  const run = practicalTestTail.then(work, work);
  practicalTestTail = run.then(() => undefined, () => undefined);
  return run;
}

export function setPracticalBoundaryFactoryForTest(factory: BoundaryFactory | null): void {
  boundaryFactory = factory ?? createOfflineMacosBoundary;
}

export interface SeatbeltTestResult {
  isolation: "macos-offline-seatbelt" | "blocked";
  reason: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  interrupted: boolean;
  startedAt: number;
  finishedAt: number;
}

export async function runSeatbeltBunTest(input: {
  workspacePath: string;
  testPath: string;
  command: string;
  executable: string;
  argv: string[];
  /** `reviewer` mounts the project read-only. Defaults to `developer` (unchanged). */
  role?: "developer" | "reviewer";
}): Promise<SeatbeltTestResult> {
  const startedAt = Date.now();
  const empty = (reason: string): SeatbeltTestResult => ({
    isolation: "blocked",
    reason,
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputExceeded: false,
    interrupted: false,
    startedAt,
    finishedAt: Date.now(),
  });
  if (approvedTestCommand(input.testPath) !== input.command) {
    return empty("The test command does not match the fixed Bun test contract. No process was started.");
  }
  if (input.argv.join("\0") !== ["test", `./${input.testPath}`].join("\0")) {
    return empty("The test argv does not match the authorized command. No process was started.");
  }
  let workspace: string;
  try {
    workspace = realpathSync(input.workspacePath);
  } catch {
    return empty("The task workspace is missing. No test was run.");
  }
  const abs = path.join(workspace, input.testPath);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return empty("The approved test path is not a regular file. It was not followed.");
    if (realpathSync(abs) !== abs) return empty("The approved test file escapes the workspace. No test was run.");
  } catch {
    return empty("The approved test file is missing. No test was run.");
  }
  const scratch = path.join(dataDir, "practical-test-scratch", randomUUID());
  try {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    chmodSync(scratch, 0o700);
  } catch (error) {
    return empty(error instanceof Error ? error.message : "A private scratch directory could not be created.");
  }
  let boundary: OfflineMacosBoundary;
  try {
    boundary = boundaryFactory({
      project: workspace,
      scratch: realpathSync(scratch),
      role: input.role ?? "developer",
      executable: input.executable,
    });
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    return empty(error instanceof Error ? error.message : "The Seatbelt boundary could not be built. No test was run.");
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  let bytes = 0;
  let outputExceeded = false;
  const host = createBunProcessHost({ perlAvailable: false });
  const started = await host.start(offlineBoundaryRequest(boundary, input.argv, "a".repeat(32), (stream, text) => {
    bytes += Buffer.byteLength(text);
    if (bytes > PRACTICAL_TEST_OUTPUT_BYTES) {
      outputExceeded = true;
      return;
    }
    (stream === "stdout" ? stdout : stderr).push(text);
  }));
  if (!started.ok) {
    rmSync(scratch, { recursive: true, force: true });
    return empty(started.detail || "The Seatbelt process could not be started. No test result was invented.");
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    started.process.signal("SIGKILL");
  }, PRACTICAL_TEST_TIMEOUT_MS);
  const exit = await started.process.exited;
  clearTimeout(timer);
  rmSync(scratch, { recursive: true, force: true });
  if (outputExceeded) {
    try { started.process.signal("SIGKILL"); } catch { /* already gone */ }
    return {
      isolation: "macos-offline-seatbelt",
      reason: "Test output exceeds the evidence bound. It was not stored and it is not a pass.",
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      outputExceeded: true,
      interrupted: false,
      startedAt,
      finishedAt: Date.now(),
    };
  }
  const interrupted = !timedOut && exit.signal != null && exit.code == null;
  return {
    isolation: "macos-offline-seatbelt",
    reason: timedOut
      ? `Approved test command exceeded ${PRACTICAL_TEST_TIMEOUT_MS}ms. No test result was invented.`
      : interrupted
        ? "The test process was interrupted before it exited. No pass was recorded."
        : null,
    exitCode: timedOut || interrupted ? null : exit.code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    timedOut,
    outputExceeded: false,
    interrupted,
    startedAt,
    finishedAt: Date.now(),
  };
}

interface AttemptRow {
  id: string;
  task_id: string;
  status: string;
  exit_code: number | null;
  failure_kind: string | null;
  summary: string | null;
  rework_epoch: number;
  command: string;
  source_fingerprint: string;
  evidence_digest: string | null;
  isolation: string;
  isolation_reason: string | null;
  policy_id: string | null;
  policy_revision: number | null;
  provider: string | null;
  model: string | null;
  account_id: string | null;
  instruction_sha: string | null;
  execution_mode: string | null;
  implementation_execution: string;
  workspace_path: string;
  started_at: number;
  finished_at: number | null;
}

export interface PracticalTestDecision {
  kind: "skip" | "deferred" | "pass" | "rework" | "block";
  reason: string;
  failureKind: PracticalFailureKind | null;
  owner: boolean;
  attemptId: string | null;
}

function implementationExecution(): "synthetic-driver" | "provider" | "not-launched" {
  if (process.env.AGETOR_CLAUDE_DRIVER === "fake" || process.env.AGETOR_CODEX_DRIVER === "fake") return "synthetic-driver";
  return "provider";
}

export function listedFiles(workspace: string): { path: string; sha256: string }[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (found.length >= 8) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const abs = path.join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) {
        const rel = path.relative(workspace, abs).split(path.sep).join("/");
        if (reviewFileRole(rel)) found.push(rel);
      }
      if (found.length >= 8) return;
    }
  };
  walk(workspace);
  return found.sort().map((rel) => ({ path: rel, sha256: sha256Text(readFileSync(path.join(workspace, rel), "utf8")) }));
}

function matchingGrant(body: AutonomyPolicyBody, projectPath: string, taskId: string): AuthorizedTestGrant[] {
  return (body.authorizedTests ?? []).filter((grant) => grant.projectPath === projectPath && (!grant.taskId || grant.taskId === taskId));
}

function journal(eventType: "autonomy.test.observed" | "autonomy.test.blocked", projectPath: string, taskId: string, payload: Record<string, string | number>): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath,
    actorType: "system",
    actorId: "autonomy",
    targetType: "task",
    targetId: taskId,
    taskId,
    idempotencyKey: `practical-test:${payload.policyId}:${taskId}:${eventType}:${payload.command ?? payload.reasonCode}:${payload.exitCode ?? ""}`,
    payload,
  });
}

export function recoverInterruptedPracticalTests(): number {
  const rows = db.query<{ id: string }, []>(`SELECT id FROM practical_test_attempts WHERE status = 'running'`).all();
  const now = Date.now();
  for (const row of rows) {
    db.run(
      `UPDATE practical_test_attempts
       SET status = 'interrupted', summary = ?, finished_at = ?, isolation_reason = ?
       WHERE id = ? AND status = 'running'`,
      [
        "The test process was still running when ForgeOrbit restarted. No pass was recorded.",
        now,
        "interrupted",
        row.id,
      ],
    );
  }
  return rows.length;
}

export function hasPassingPracticalTest(taskId: string): boolean {
  const row = db.query<{ status: string; exit_code: number | null; evidence_digest: string | null }, [string]>(
    `SELECT status, exit_code, evidence_digest FROM practical_test_attempts WHERE task_id = ? ORDER BY rework_epoch DESC, started_at DESC LIMIT 1`,
  ).get(taskId);
  return !!row && row.status === "passed" && row.exit_code === 0 && row.evidence_digest != null;
}

export function peekPracticalReworkBrief(taskId: string): string | null {
  const row = db.query<{ brief: string }, [string]>(`SELECT brief FROM practical_rework_briefs WHERE task_id = ?`).get(taskId);
  return row?.brief ?? null;
}

export function consumePracticalReworkBrief(taskId: string): void {
  db.run(`DELETE FROM practical_rework_briefs WHERE task_id = ?`, [taskId]);
}

export function storePracticalReworkBrief(input: {
  taskId: string;
  epoch: number;
  kind: PracticalFailureKind;
  requirements: string;
  diff: string | null;
  testErrors: string | null;
  reviewerFindings: string | null;
  projectRules: string | null;
}): void {
  const brief = buildReworkBrief({
    ...input,
    brainContext: "Project memories are applied at launch only when the policy permits retrieve_brain. This brief does not copy company memory.",
  });
  db.run(
    `INSERT INTO practical_rework_briefs (task_id, epoch, kind, brief, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET epoch = excluded.epoch, kind = excluded.kind, brief = excluded.brief, created_at = excluded.created_at`,
    [input.taskId, input.epoch, input.kind, brief, Date.now()],
  );
}

async function noteBrain(input: { taskId: string; projectPath: string; title: string; content: string; verified: boolean }): Promise<void> {
  const sourceId = `practical:${input.taskId}:${input.title}`;
  const existing = db.query<{ id: string }, [string]>(
    `SELECT id FROM brain_extraction_candidates WHERE source_event_kind = 'practical-test' AND source_event_id = ?`,
  ).get(sourceId);
  if (existing) return;
  const at = Date.now();
  db.run(
    `INSERT INTO brain_extraction_candidates (
      id, status, source_event_kind, source_event_id, source_record_ids_json, scope_kind, scope_id,
      title, kind, content, confidence, extraction_method, provenance_json, quality_json,
      related_memory_ids_json, created_at, updated_at
    ) VALUES (?, 'candidate', 'practical-test', ?, ?, 'project', ?, ?, 'observation', ?, ?, 'practical-cycle', ?, ?, '[]', ?, ?)`,
    [
      randomUUID(),
      sourceId,
      JSON.stringify([sourceId]),
      input.projectPath,
      input.title.slice(0, 180),
      input.content.slice(0, 2000),
      input.verified ? 0.8 : 0.4,
      JSON.stringify({ source: "practical-cycle", verified: input.verified, establishedFact: input.verified, hypothesis: false }),
      JSON.stringify({ pass: true, issues: [], duplicateType: "none", relationship: "new", confidence: input.verified ? 0.8 : 0.4 }),
      at,
      at,
    ],
  );
}

async function noteWeakness(attemptId: string, projectPath: string, summary: string): Promise<void> {
  try {
    const { recordImprovementObservation } = await import("../self-improve/engine.ts");
    recordImprovementObservation({
      role: "developer",
      projectPath,
      fingerprint: "validation-step-missing",
      summary,
      verified: true,
      synthetic: false,
      origin: "production",
      source: "practical-test",
      sourceId: attemptId,
      evidence: { attemptId, summary },
    });
  } catch {
    // The attempt row remains the source of truth if improvement storage is unavailable.
  }
}

function decisionFromExisting(row: AttemptRow): PracticalTestDecision {
  if (row.status === "running") {
    return { kind: "deferred", reason: "An authorized test is already running for this source.", failureKind: null, owner: false, attemptId: row.id };
  }
  if (row.status === "passed" && row.exit_code === 0 && row.evidence_digest) {
    return { kind: "pass", reason: "The authorized test already passed for this source fingerprint.", failureKind: null, owner: false, attemptId: row.id };
  }
  const kind = (PRACTICAL_FAILURE_KINDS as readonly string[]).includes(row.failure_kind ?? "")
    ? row.failure_kind as PracticalFailureKind
    : "test_failed";
  if (practicalFailureReworkable(kind) && row.status === "failed") {
    return { kind: "rework", reason: row.summary ?? "The observed test failed.", failureKind: kind, owner: false, attemptId: row.id };
  }
  return {
    kind: "block",
    reason: row.summary ?? row.isolation_reason ?? "The observed test did not pass.",
    failureKind: kind,
    owner: practicalFailureNeedsOwner(kind),
    attemptId: row.id,
  };
}

export async function ensurePracticalWorkspace(missionId: string, task: { taskId: string; projectPath: string; reworkEpoch?: number }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const binding = autonomyPolicyStore.getBinding(missionId);
  if (!binding) return { ok: true };
  const policy = autonomyPolicyStore.policyRevision(binding.policyId, binding.revision);
  if (!policy || policy.body.mode !== "full-autonomy" || !policy.body.permittedActions.includes("run_observed_test")) return { ok: true };
  const grants = matchingGrant(policy.body, task.projectPath, task.taskId);
  if (grants.length !== 1) return { ok: true };
  const current = getTaskWorkspace(task.taskId);
  if (current?.status === "armed" || current?.status === "executing") return { ok: true };
  if (current?.status === "settled" && (task.reworkEpoch ?? 0) > 0) {
    const rearmed = rearmSettledWorkspace(task.taskId);
    return rearmed ? { ok: true } : { ok: false, reason: "The settled task workspace could not be rearmed for rework. Nothing was started in the project folder." };
  }
  if (current) return { ok: true };
  try {
    await prepareTaskWorkspace(task.taskId, { outputPaths: grants[0]!.outputPaths });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The task workspace could not be prepared." };
  }
}

export async function considerPracticalTest(missionId: string, task: {
  taskId: string;
  projectPath: string;
  reworkEpoch?: number;
  harnessId: string;
  modelId: string;
  accountId?: string;
}): Promise<PracticalTestDecision> {
  const skip = (reason: string): PracticalTestDecision => ({ kind: "skip", reason, failureKind: null, owner: false, attemptId: null });
  const binding = autonomyPolicyStore.getBinding(missionId);
  if (!binding || binding.outcome === "supervised") return skip("Supervised execution does not run tests automatically.");
  const policy = autonomyPolicyStore.policyRevision(binding.policyId, binding.revision);
  if (!policy) return { kind: "block", reason: "The mission policy revision is missing.", failureKind: "expired_grant", owner: true, attemptId: null };
  const body = policy.body;
  const needs = body.qc.requireObservedTest || body.completion.conditions.includes("observed_test");
  if (!needs) return skip("The policy does not require an observed test.");
  if (body.mode !== "full-autonomy" || !body.permittedActions.includes("run_observed_test")) {
    return skip("Automatic tests stay with the Owner unless Full Autonomy lists run_observed_test.");
  }
  if (autonomyPolicyStore.readEmergency().active) {
    return { kind: "block", reason: "Emergency stop is active. No test was started.", failureKind: "expired_grant", owner: true, attemptId: null };
  }
  const grants = matchingGrant(body, task.projectPath, task.taskId);
  if (grants.length !== 1) {
    return {
      kind: "block",
      reason: grants.length === 0
        ? "No Owner-approved test command is bound to this project. No process was started."
        : "The policy names more than one test command for this task. No command was chosen automatically.",
      failureKind: "missing_evidence",
      owner: false,
      attemptId: null,
    };
  }
  const grant = grants[0]!;
  const workspace = getTaskWorkspace(task.taskId);
  if (!workspace || workspace.projectPath !== task.projectPath || workspace.taskId !== task.taskId) {
    return { kind: "block", reason: "No task-owned workspace is bound to this task and project. No test was run.", failureKind: "workspace_conflict", owner: false, attemptId: null };
  }
  if (workspace.status === "armed" || workspace.status === "executing") {
    return { kind: "deferred", reason: "The task workspace is still in use. The test waits.", failureKind: null, owner: false, attemptId: null };
  }
  if (workspace.status !== "settled") {
    return { kind: "block", reason: `The task workspace is ${workspace.status}. A test runs only after the Developer run has settled.`, failureKind: "workspace_conflict", owner: false, attemptId: null };
  }
  const files = listedFiles(workspace.stagingPath);
  if (files.length === 0) {
    return { kind: "block", reason: "No implementation or test file was found in the task workspace. No test result was invented.", failureKind: "missing_evidence", owner: false, attemptId: null };
  }
  const fingerprint = sourceFingerprint(files);
  const testPath = grant.command.slice("bun test ./".length);
  const argv = ["test", `./${testPath}`];
  const executable = process.execPath;
  const cmdFingerprint = commandFingerprint({ command: grant.command, argv, cwd: workspace.stagingPath, executable });
  const epoch = task.reworkEpoch ?? 0;
  const existing = db.query<AttemptRow, [string, string, string, number]>(
    `SELECT * FROM practical_test_attempts
     WHERE task_id = ? AND command_fingerprint = ? AND source_fingerprint = ? AND rework_epoch = ?
       AND status IN ('running', 'passed', 'failed', 'blocked')
     ORDER BY started_at DESC LIMIT 1`,
  ).get(task.taskId, cmdFingerprint, fingerprint, epoch);
  if (existing) return decisionFromExisting(existing);

  let instructionSha: string | null = null;
  try {
    const { activeImprovementSnapshot } = await import("../self-improve/engine.ts");
    instructionSha = activeImprovementSnapshot({ projectPath: task.projectPath, role: "developer" }).sha256;
  } catch {
    instructionSha = null;
  }
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO practical_test_attempts (
      id, task_id, project_path, workspace_path, mission_id, rework_epoch, command, command_fingerprint,
      source_fingerprint, status, isolation, policy_id, policy_revision, provider, model, account_id,
      instruction_sha, complexity, execution_mode, implementation_execution, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'pending', ?, ?, ?, ?, ?, ?, 'standard', ?, ?, ?)`,
    [
      id, task.taskId, task.projectPath, workspace.stagingPath, missionId, epoch, grant.command, cmdFingerprint,
      fingerprint, policy.id, policy.revision, task.harnessId, task.modelId, task.accountId ?? null,
      instructionSha, body.mode, implementationExecution(), now,
    ],
  );
  const observed = await withPracticalTestLock(() => runSeatbeltBunTest({
    workspacePath: workspace.stagingPath,
    testPath,
    command: grant.command,
    executable,
    argv,
  }));
  const passed = observed.isolation === "macos-offline-seatbelt"
    && observed.exitCode === 0
    && !observed.timedOut
    && !observed.outputExceeded
    && !observed.interrupted;
  const failureKind: PracticalFailureKind | null = passed
    ? null
    : observed.isolation === "blocked"
      ? "workspace_conflict"
      : observed.outputExceeded
        ? "test_failed"
        : "test_failed";
  const status = passed ? "passed" : observed.interrupted ? "interrupted" : observed.isolation === "blocked" ? "blocked" : "failed";
  const summary = observed.reason ?? testSummary(observed.stdout, observed.stderr, observed.exitCode);
  const digest = passed || observed.exitCode != null
    ? practicalEvidenceDigest({
      sourceFingerprint: fingerprint,
      commandFingerprint: cmdFingerprint,
      exitCode: observed.exitCode,
      stdout: observed.stdout.slice(0, 4000),
      stderr: observed.stderr.slice(0, 4000),
    })
    : null;
  db.run(
    `UPDATE practical_test_attempts
     SET status = ?, exit_code = ?, summary = ?, failure_kind = ?, evidence_digest = ?, isolation = ?, isolation_reason = ?, finished_at = ?
     WHERE id = ?`,
    [status, observed.exitCode, summary, failureKind, digest, observed.isolation, observed.reason, observed.finishedAt, id],
  );
  try {
    if (observed.exitCode != null && observed.isolation === "macos-offline-seatbelt") {
      journal("autonomy.test.observed", task.projectPath, task.taskId, {
        policyId: policy.id,
        revision: policy.revision,
        taskId: task.taskId,
        exitCode: observed.exitCode,
        command: grant.command,
      });
    } else {
      journal("autonomy.test.blocked", task.projectPath, task.taskId, {
        policyId: policy.id,
        revision: policy.revision,
        taskId: task.taskId,
        reasonCode: (failureKind ?? "workspace_conflict").slice(0, 80),
      });
    }
  } catch {
    // The attempt row is the durable record if the journal rejects a duplicate key.
  }
  await noteBrain({
    taskId: task.taskId,
    projectPath: task.projectPath,
    title: passed ? "Observed test passed" : "Observed test did not pass",
    content: `${summary} Command fingerprint ${cmdFingerprint.slice(0, 12)}. Source fingerprint ${fingerprint.slice(0, 12)}. Instruction ${instructionSha ?? "none"}. Provider ${task.harnessId}. Model ${task.modelId}. Account ${task.accountId ?? "unscoped"}. Execution ${body.mode}. Implementation driver ${implementationExecution()}. Quota Unknown.`,
    verified: true,
  });
  if (!passed && failureKind === "test_failed") {
    await noteWeakness(id, task.projectPath, "QC finding: validation step missing; observed test failed");
    const rules = files.some((file) => file.path.endsWith("AGENTS.md"))
      ? readFileSync(path.join(workspace.stagingPath, "AGENTS.md"), "utf8").slice(0, 2000)
      : null;
    const diff = files.map((file) => `${file.path} ${file.sha256.slice(0, 12)}`).join("\n");
    storePracticalReworkBrief({
      taskId: task.taskId,
      epoch: epoch + 1,
      kind: "test_failed",
      requirements: tasks.get(task.taskId)?.prompt ?? summary,
      diff,
      testErrors: testSummary(observed.stdout, observed.stderr, observed.exitCode),
      reviewerFindings: null,
      projectRules: rules,
    });
  }
  const stored = db.query<AttemptRow, [string]>(`SELECT * FROM practical_test_attempts WHERE id = ?`).get(id)!;
  return decisionFromExisting(stored);
}

export function practicalCycleStatus(missionId?: string | null) {
  const rows = missionId
    ? db.query<AttemptRow, [string]>(`SELECT * FROM practical_test_attempts WHERE mission_id = ? ORDER BY started_at DESC LIMIT 40`).all(missionId)
    : db.query<AttemptRow, []>(`SELECT * FROM practical_test_attempts ORDER BY started_at DESC LIMIT 40`).all();
  const briefs = db.query<{ task_id: string; epoch: number; kind: string; brief: string }, []>(
    `SELECT task_id, epoch, kind, brief FROM practical_rework_briefs`,
  ).all();
  return {
    limits: {
      testConcurrency: 1,
      timeoutMs: PRACTICAL_TEST_TIMEOUT_MS,
      maxOutputBytes: PRACTICAL_TEST_OUTPUT_BYTES,
    },
    attempts: rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      exitCode: row.exit_code,
      summary: row.summary,
      failureKind: row.failure_kind,
      command: row.command,
      sourceFingerprint: row.source_fingerprint,
      evidenceDigest: row.evidence_digest,
      isolation: row.isolation,
      isolationReason: row.isolation_reason,
      policyId: row.policy_id,
      policyRevision: row.policy_revision,
      provider: row.provider,
      model: row.model,
      accountId: row.account_id,
      instructionSha: row.instruction_sha,
      executionMode: row.execution_mode,
      implementationExecution: row.implementation_execution,
      reworkEpoch: row.rework_epoch,
      workspacePath: row.workspace_path,
    })),
    briefs: briefs.map((row) => ({ taskId: row.task_id, epoch: row.epoch, kind: row.kind, brief: row.brief })),
  };
}
