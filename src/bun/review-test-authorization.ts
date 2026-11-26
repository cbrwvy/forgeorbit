/**
 * One Owner authorization for one fixed Bun test.
 * Preview never calls this module's execute path. A consumed, cancelled,
 * or expired authorization does not spawn again, including after restart.
 */
import { randomUUID } from "node:crypto";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { db } from "./db.ts";
import { executeApprovedTest } from "./review-evidence.ts";
import { clampRecoveryMinutes } from "../shared/qc-recovery.ts";
import {
  bindObservedTest,
  type ReviewEvidenceBundle,
  type ReviewEvidenceTest,
  type ReviewTestAuthorization,
  type ReviewTestPurpose,
} from "../shared/review-evidence.ts";

export class ReviewTestAuthorizationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "ReviewTestAuthorizationError";
  }
}

interface AuthRow {
  id: string;
  task_id: string;
  project_path: string;
  status: string;
  authorization_json: string;
  created_at: number;
  updated_at: number;
}

interface ObservationRow {
  id: string;
  observation_json: string;
  created_at: number;
}

function parseAuthorization(raw: string): ReviewTestAuthorization | null {
  try {
    const auth = JSON.parse(raw) as ReviewTestAuthorization;
    if (!auth || auth.maxInvocations !== 1) return null;
    if (auth.authorizesDeveloper !== false || auth.authorizesReviewer !== false || auth.authorizesBatchResume !== false) return null;
    if (auth.authorizesRework !== false || auth.authorizesOtherTasks !== false) return null;
    if (auth.acknowledgedRisk !== true) return null;
    if (auth.isolation !== "not-os-sandboxed" && auth.isolation !== "macos-offline-seatbelt") return null;
    if (typeof auth.taskId !== "string" || typeof auth.command !== "string" || typeof auth.sourceFingerprint !== "string") return null;
    if (auth.purpose == null) auth.purpose = "evidence-refresh";
    if (auth.purpose !== "first-review" && auth.purpose !== "evidence-refresh") return null;
    return auth;
  } catch {
    return null;
  }
}

function rowAuth(row: AuthRow): ReviewTestAuthorization | null {
  const auth = parseAuthorization(row.authorization_json);
  if (!auth) return null;
  auth.status = row.status as ReviewTestAuthorization["status"];
  auth.id = row.id;
  return auth;
}

function loadAuth(id: string): ReviewTestAuthorization | null {
  const row = db.query<AuthRow, [string]>(`SELECT * FROM review_test_authorizations WHERE id = ?`).get(id);
  return row ? rowAuth(row) : null;
}

function saveAuth(auth: ReviewTestAuthorization): void {
  auth.updatedAt = Date.now();
  db.run(
    `UPDATE review_test_authorizations SET status = ?, authorization_json = ?, updated_at = ? WHERE id = ?`,
    [auth.status, JSON.stringify(auth), auth.updatedAt, auth.id],
  );
}

function journal(auth: ReviewTestAuthorization, eventType: "qc.test.prepared" | "qc.test.approved" | "qc.test.executed" | "qc.test.cancelled", extra: Record<string, string | number>): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath: auth.projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "task",
    targetId: auth.taskId,
    taskId: auth.taskId,
    idempotencyKey: `qc-test:${auth.id}:${eventType}`,
    payload: {
      taskId: auth.taskId,
      authorizationId: auth.id,
      command: auth.command,
      sourceFingerprint: auth.sourceFingerprint,
      ...extra,
    },
  });
}

export function findStoredObservation(input: {
  taskId: string;
  workspacePath: string;
  command: string;
  sourceFingerprint: string;
}): ReviewEvidenceTest | null {
  const row = db.query<ObservationRow, [string, string, string, string]>(
    `SELECT id, observation_json, created_at FROM review_test_observations
     WHERE task_id = ? AND workspace_path = ? AND command = ? AND source_fingerprint = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(input.taskId, input.workspacePath, input.command, input.sourceFingerprint);
  if (!row) return null;
  try {
    const test = JSON.parse(row.observation_json) as ReviewEvidenceTest;
    if (test?.provenance !== "forgeorbit-observed-test") return null;
    if (test.command !== input.command || test.sourceFingerprint !== input.sourceFingerprint) return null;
    if (test.workspacePath !== input.workspacePath) return null;
    return test;
  } catch {
    return null;
  }
}

export function openTestAuthorization(taskId: string): ReviewTestAuthorization | null {
  const row = db.query<AuthRow, [string]>(
    `SELECT * FROM review_test_authorizations WHERE task_id = ? AND status IN ('prepared', 'approved') ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId);
  return row ? rowAuth(row) : null;
}

export function latestTestAuthorization(taskId: string): ReviewTestAuthorization | null {
  const row = db.query<AuthRow, [string]>(
    `SELECT * FROM review_test_authorizations WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId);
  return row ? rowAuth(row) : null;
}

export function requireTestAuthorization(taskId: string, authId: string): ReviewTestAuthorization {
  const auth = loadAuth(authId);
  if (!auth || auth.taskId !== taskId) throw new ReviewTestAuthorizationError("Test authorization not found.", 404, "not-found");
  return auth;
}

/** Drop a prepared or approved grant when the source it named is no longer the source on disk. */
export function invalidateTestAuthorization(taskId: string, authId: string): void {
  const auth = loadAuth(authId);
  if (!auth || auth.taskId !== taskId) return;
  if (auth.status !== "prepared" && auth.status !== "approved") return;
  auth.status = "invalidated";
  saveAuth(auth);
}

function sameScope(auth: ReviewTestAuthorization, bundle: ReviewEvidenceBundle): string | null {
  if (bundle.taskId !== auth.taskId) return "The task changed after the test authorization was prepared.";
  if (bundle.developerRunId !== auth.developerRunId) return "The Developer run changed after the test authorization was prepared.";
  if (bundle.projectPath !== auth.projectPath) return "The project path changed after the test authorization was prepared.";
  if (bundle.workspacePath !== auth.workspacePath) return "The workspace path changed after the test authorization was prepared.";
  if (!bundle.proposedTest) return "No single approved test command is available. No test was run.";
  if (bundle.proposedTest.command !== auth.command || bundle.proposedTest.testPath !== auth.testPath) {
    return "The proposed test command changed. No test was run.";
  }
  if (bundle.proposedTest.executable !== auth.executable) return "The Bun executable changed after authorization. No test was run.";
  if (bundle.proposedTest.argv.join("\0") !== auth.argv.join("\0")) return "The test argv changed. No test was run.";
  if (bundle.sourceFingerprint !== auth.sourceFingerprint) return "Source or test files changed after authorization. The previous approval does not cover the new bytes.";
  return null;
}

export function prepareTestAuthorization(input: {
  bundle: ReviewEvidenceBundle;
  developerRunId: string;
  purpose: ReviewTestPurpose;
  acknowledgeRisk: boolean;
  validMinutes: unknown;
}): ReviewTestAuthorization {
  if (input.acknowledgeRisk !== true) {
    throw new ReviewTestAuthorizationError("Authorize the test only after acknowledging that it is not OS-isolated.", 400, "acknowledgement");
  }
  if (input.bundle.status === "blocked") {
    throw new ReviewTestAuthorizationError(input.bundle.blocker ?? "Evidence could not be read. No test was run.", 409, "evidence");
  }
  if (input.bundle.status === "complete" && input.bundle.test) {
    throw new ReviewTestAuthorizationError("A test result is already bound to this source fingerprint. It was not run again.", 409, "already-observed");
  }
  if (input.bundle.status !== "preview" || !input.bundle.proposedTest) {
    throw new ReviewTestAuthorizationError(input.bundle.blocker ?? "A test command is not available. No test was run.", 409, "evidence");
  }
  if (openTestAuthorization(input.bundle.taskId)) {
    throw new ReviewTestAuthorizationError("A test authorization is already open. Approve, run, or cancel it.", 409, "open-authorization");
  }
  const now = Date.now();
  const proposed = input.bundle.proposedTest;
  const auth: ReviewTestAuthorization = {
    id: randomUUID(),
    taskId: input.bundle.taskId,
    projectPath: input.bundle.projectPath,
    workspacePath: input.bundle.workspacePath,
    developerRunId: input.developerRunId,
    purpose: input.purpose,
    command: proposed.command,
    executable: proposed.executable,
    argv: [...proposed.argv],
    testPath: proposed.testPath,
    sourceFingerprint: input.bundle.sourceFingerprint,
    timeoutMs: proposed.timeoutMs,
    maxOutputBytes: proposed.maxOutputBytes,
    isolation: "macos-offline-seatbelt",
    acknowledgedRisk: true,
    status: "prepared",
    maxInvocations: 1,
    invocationsUsed: 0,
    validMinutes: clampRecoveryMinutes(input.validMinutes),
    expiresAt: null,
    approvedAt: null,
    observationId: null,
    failureReason: null,
    authorizesReviewer: false,
    authorizesDeveloper: false,
    authorizesRework: false,
    authorizesOtherTasks: false,
    authorizesBatchResume: false,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO review_test_authorizations (id, task_id, project_path, status, authorization_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [auth.id, auth.taskId, auth.projectPath, auth.status, JSON.stringify(auth), auth.createdAt, auth.updatedAt],
  );
  journal(auth, "qc.test.prepared", { workspacePath: auth.workspacePath, purpose: auth.purpose });
  return loadAuth(auth.id)!;
}

export function approveTestAuthorization(taskId: string, authId: string, bundle: ReviewEvidenceBundle): ReviewTestAuthorization {
  const auth = loadAuth(authId);
  if (!auth || auth.taskId !== taskId) throw new ReviewTestAuthorizationError("Test authorization not found.", 404, "not-found");
  if (auth.status === "approved") return auth;
  if (auth.status !== "prepared") throw new ReviewTestAuthorizationError(`Test authorization is ${auth.status}.`, 409, auth.status);
  const mismatch = sameScope(auth, bundle);
  if (mismatch || bundle.status === "blocked") {
    auth.status = "invalidated";
    saveAuth(auth);
    throw new ReviewTestAuthorizationError(mismatch ?? bundle.blocker ?? "Evidence changed. No test was run.", 409, "evidence");
  }
  const now = Date.now();
  auth.status = "approved";
  auth.approvedAt = now;
  auth.expiresAt = now + auth.validMinutes * 60_000;
  saveAuth(auth);
  journal(auth, "qc.test.approved", { expiresAt: auth.expiresAt });
  return loadAuth(authId)!;
}

function claimExecution(authId: string): ReviewTestAuthorization {
  const now = Date.now();
  const current = loadAuth(authId);
  if (!current || current.status !== "approved" || current.invocationsUsed !== 0) {
    throw new ReviewTestAuthorizationError("This test authorization was already used or is not approved. It does not run again.", 409, "consumed");
  }
  current.status = "consumed";
  current.invocationsUsed = 1;
  current.updatedAt = now;
  const result = db.run(
    `UPDATE review_test_authorizations SET status = 'consumed', authorization_json = ?, updated_at = ? WHERE id = ? AND status = 'approved'`,
    [JSON.stringify(current), now, authId],
  );
  if (result.changes !== 1) {
    throw new ReviewTestAuthorizationError("This test authorization was already used. It does not run again.", 409, "consumed");
  }
  return loadAuth(authId)!;
}

export async function executeTestAuthorization(taskId: string, authId: string, bundle: ReviewEvidenceBundle): Promise<{ authorization: ReviewTestAuthorization; bundle: ReviewEvidenceBundle }> {
  const auth = loadAuth(authId);
  if (!auth || auth.taskId !== taskId) throw new ReviewTestAuthorizationError("Test authorization not found.", 404, "not-found");
  if (auth.status === "cancelled") throw new ReviewTestAuthorizationError("Test authorization was cancelled. No test was run.", 409, "cancelled");
  if (auth.status === "expired") throw new ReviewTestAuthorizationError("Test authorization expired. No test was run.", 409, "expired");
  if (auth.status === "invalidated") throw new ReviewTestAuthorizationError("Test authorization was invalidated. No test was run.", 409, "invalidated");
  if (auth.status === "consumed" || auth.invocationsUsed > 0) {
    throw new ReviewTestAuthorizationError("This test authorization was already used. It does not run again.", 409, "consumed");
  }
  if (auth.status !== "approved") throw new ReviewTestAuthorizationError("Approve the test authorization before running it. No test was run.", 409, auth.status);
  if (auth.expiresAt != null && Date.now() >= auth.expiresAt) {
    auth.status = "expired";
    saveAuth(auth);
    throw new ReviewTestAuthorizationError("Test authorization expired. No test was run.", 409, "expired");
  }
  const mismatch = sameScope(auth, bundle);
  if (mismatch || bundle.status === "blocked") {
    auth.status = "invalidated";
    saveAuth(auth);
    throw new ReviewTestAuthorizationError(mismatch ?? bundle.blocker ?? "Evidence changed. No test was run.", 409, "evidence");
  }
  if (bundle.status === "complete" && bundle.test?.sourceFingerprint === auth.sourceFingerprint) {
    throw new ReviewTestAuthorizationError("A test result is already bound to this source fingerprint. It was not run again.", 409, "already-observed");
  }
  const claimed = claimExecution(auth.id);
  const observed = await executeApprovedTest({
    workspacePath: claimed.workspacePath,
    projectPath: claimed.projectPath,
    testPath: claimed.testPath,
    command: claimed.command,
    executable: claimed.executable,
    argv: claimed.argv,
    sourceFingerprint: claimed.sourceFingerprint,
  });
  if (!observed.ok) {
    claimed.failureReason = observed.reason;
    saveAuth(claimed);
    throw new ReviewTestAuthorizationError(observed.reason, 409, "test-failed-to-observe");
  }
  const observationId = randomUUID();
  db.run(
    `INSERT INTO review_test_observations (id, task_id, project_path, workspace_path, command, source_fingerprint, observation_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [observationId, claimed.taskId, claimed.projectPath, observed.test.workspacePath, observed.test.command, observed.test.sourceFingerprint, JSON.stringify(observed.test), observed.test.executedAt],
  );
  claimed.observationId = observationId;
  claimed.failureReason = null;
  saveAuth(claimed);
  journal(claimed, "qc.test.executed", { exitCode: observed.test.exitCode });
  const bound = bindObservedTest(bundle, observed.test);
  if (!bound) {
    throw new ReviewTestAuthorizationError("The observed test could not be bound to the source fingerprint.", 409, "evidence");
  }
  return { authorization: loadAuth(authId)!, bundle: bound };
}

export function cancelTestAuthorization(taskId: string, authId: string): ReviewTestAuthorization {
  const auth = loadAuth(authId);
  if (!auth || auth.taskId !== taskId) throw new ReviewTestAuthorizationError("Test authorization not found.", 404, "not-found");
  if (auth.status === "cancelled") return auth;
  if (auth.status !== "prepared" && auth.status !== "approved") {
    throw new ReviewTestAuthorizationError(`Test authorization is ${auth.status} and can no longer be cancelled.`, 409, auth.status);
  }
  auth.status = "cancelled";
  saveAuth(auth);
  journal(auth, "qc.test.cancelled", { workspacePath: auth.workspacePath });
  return loadAuth(authId)!;
}

/** Bind a previously stored observation. Does not spawn a test. */
export function withStoredObservation(bundle: ReviewEvidenceBundle): ReviewEvidenceBundle {
  if (bundle.status !== "preview" || !bundle.proposedTest) return bundle;
  const stored = findStoredObservation({
    taskId: bundle.taskId,
    workspacePath: bundle.workspacePath,
    command: bundle.proposedTest.command,
    sourceFingerprint: bundle.sourceFingerprint,
  });
  if (!stored) return bundle;
  return bindObservedTest(bundle, stored) ?? bundle;
}

/** Expire unused approvals. Never spawns a test and never starts a Reviewer. */
export function recoverTestAuthorizations(): number {
  const rows = db.query<AuthRow, []>(`SELECT * FROM review_test_authorizations WHERE status = 'approved'`).all();
  let expired = 0;
  const now = Date.now();
  for (const row of rows) {
    const auth = rowAuth(row);
    if (!auth?.expiresAt || auth.expiresAt > now) continue;
    auth.status = "expired";
    saveAuth(auth);
    expired += 1;
  }
  return expired;
}
