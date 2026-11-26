/**
 * Codex-style permissions for one bounded local action: run one fixed project
 * test through the existing offline observed-test runner (`runSeatbeltBunTest`).
 *
 * Design rules, in the order they matter:
 *  - There is no second runner. Dispatch reuses the offline Seatbelt boundary,
 *    its fixed-contract checks, the practical-test lock and its output bounds.
 *  - The command is derived on the backend from the task-owned workspace. A
 *    requester (or a model) cannot name a command, a directory or a rule.
 *  - Gates that already exist still apply and still win: emergency stop,
 *    project ownership and lifecycle admission, the task workspace state.
 *  - An Owner "allow once" is a pending -> running flip in one guarded UPDATE.
 *    A second approval, a replay after restart or a changed target runs nothing.
 *  - A rule or approval is re-checked immediately before dispatch against fresh
 *    state; a revoked rule, a new deny rule or a changed source runs nothing.
 *  - Nothing here is Owner Trust proof. This is a bearer-token UI approval and
 *    other processes running as the same macOS user can call the same API.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { db, projects, runs, tasks } from "./db.ts";
import type { Project } from "../shared/types.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { autonomyPolicyStore } from "./autonomy/policy-store.ts";
import { listedFiles, runSeatbeltBunTest, withPracticalTestLock } from "./autonomy/observed-test.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { ownerProjectOf, taskInProject } from "./project-ownership.ts";
import { getTaskWorkspace } from "./task-workspace.ts";
import { buildProjectTestEvidence, type CurrentSourceBinding, type ProjectTestEvidence } from "../shared/project-test-evidence.ts";
import { validateRuleCommand } from "../shared/project-permission-command.ts";
import { parseWorkerTestSuggestion } from "../shared/worker-test-suggestion.ts";
import { commandFingerprint, practicalEvidenceDigest, testSummary } from "../shared/practical-cycle.ts";
import { approvedTestCommand, chooseApprovedTestPath, reviewFileRole, sourceFingerprint } from "../shared/review-evidence.ts";
import { handsoffStore } from "./handsoff/store.ts";
import {
  evaluateProjectRule,
  effectiveStatus,
  PERMISSION_REQUEST_TTL_MS,
  PERMISSION_RULE_LIMIT_PER_PROJECT,
  type PermissionAuthority,
  type PermissionDecision,
  type PermissionOrigin,
  type PermissionRequestStatus,
  type ProjectPermissionRequest,
  type ProjectPermissionRequestRow,
  type ProjectTestPreview,
  type ProjectPermissionRule,
  type ProjectPermissionsPayload,
} from "../shared/project-permissions.ts";

export class ProjectPermissionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "ProjectPermissionError";
  }
}

const ACTION = "run_project_test" as const;

interface RuleRow {
  id: string;
  project_path: string;
  action: "run_project_test";
  mode: "deny" | "allow";
  command: string | null;
  created_at: number;
  revoked_at: number | null;
}

interface RequestRow {
  id: string;
  project_path: string;
  task_id: string;
  action: "run_project_test";
  command: string;
  argv_json: string;
  cwd: string;
  source_fingerprint: string;
  command_fingerprint: string;
  status: PermissionRequestStatus;
  authority: PermissionAuthority | null;
  origin: PermissionOrigin;
  origin_run_id: string | null;
  rule_id: string | null;
  reason: string | null;
  exit_code: number | null;
  summary: string | null;
  isolation: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

function ruleOf(row: RuleRow): ProjectPermissionRule {
  return { id: row.id, projectPath: row.project_path, action: row.action, mode: row.mode, command: row.command, createdAt: row.created_at, revokedAt: row.revoked_at };
}

function requestOf(row: RequestRow): ProjectPermissionRequest {
  let argv: string[] = [];
  try {
    const parsed = JSON.parse(row.argv_json);
    if (Array.isArray(parsed)) argv = parsed.map(String);
  } catch { /* keep empty: the fingerprint, not argv, is what binds */ }
  return {
    id: row.id,
    projectPath: row.project_path,
    taskId: row.task_id,
    taskTitle: tasks.get(row.task_id)?.title ?? row.task_id,
    action: row.action,
    command: row.command,
    argv,
    cwd: row.cwd,
    sourceFingerprint: row.source_fingerprint,
    commandFingerprint: row.command_fingerprint,
    status: row.status,
    authority: row.authority,
    origin: row.origin ?? "owner",
    originRunId: row.origin_run_id ?? null,
    ruleId: row.rule_id,
    reason: row.reason,
    exitCode: row.exit_code,
    summary: row.summary,
    isolation: row.isolation,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function emit(row: Pick<RequestRow, "project_path" | "id" | "status">): void {
  try {
    broadcastAppEvent({ type: "project_permission", projectPath: row.project_path, requestId: row.id, status: row.status, ts: Date.now() });
  } catch { /* a missed event is caught up by the next read */ }
}

export function listRules(projectPath?: string | null): ProjectPermissionRule[] {
  const rows = projectPath
    ? db.query<RuleRow, [string]>(`SELECT * FROM project_permission_rules WHERE project_path = ? AND revoked_at IS NULL ORDER BY created_at`).all(projectPath)
    : db.query<RuleRow, []>(`SELECT * FROM project_permission_rules WHERE revoked_at IS NULL ORDER BY project_path, created_at`).all();
  return rows.map(ruleOf);
}

function loadRequest(id: string): RequestRow | null {
  return db.query<RequestRow, [string]>(`SELECT * FROM project_permission_requests WHERE id = ?`).get(id) ?? null;
}

export function getRequest(id: string): ProjectPermissionRequest | null {
  const row = loadRequest(id);
  return row ? requestOf(row) : null;
}

/** Pure read. No expiry write, no rule change, nothing is started. */
export function readProjectPermissions(opts: { projectPath?: string | null; limit?: number } = {}): ProjectPermissionsPayload {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30));
  const rows = opts.projectPath
    ? db.query<RequestRow, [string, number]>(`SELECT * FROM project_permission_requests WHERE project_path = ? ORDER BY created_at DESC LIMIT ?`).all(opts.projectPath, limit)
    : db.query<RequestRow, [number]>(`SELECT * FROM project_permission_requests ORDER BY created_at DESC LIMIT ?`).all(limit);
  const now = Date.now();
  return {
    action: ACTION,
    ...(opts.projectPath ? { workspaceDevelopment: isWorkspaceDevelopmentEnabled(opts.projectPath) } : {}),
    rules: listRules(opts.projectPath),
    requests: rows.map(requestOf).map((request) => ({ ...request, status: effectiveStatus(request, now) })),
  };
}

/**
 * Pure read of the per-project "Development in a working copy" setting.
 * Defaults to false for every project unless explicitly enabled by the Owner.
 * Scoped strictly to that exact registered project; never spills across projects.
 */
export function isWorkspaceDevelopmentEnabled(projectPath: string | null | undefined): boolean {
  if (!projectPath || typeof projectPath !== "string") return false;
  const direct = projects.get(projectPath);
  if (direct) return direct.workspaceDevelopment === true;
  try {
    const canonical = realpathSync(projectPath);
    const byCanonical = projects.get(canonical);
    if (byCanonical) return byCanonical.workspaceDevelopment === true;
    for (const project of projects.list()) {
      try {
        if (realpathSync(project.path) === canonical) return project.workspaceDevelopment === true;
      } catch { /* skip missing project paths */ }
    }
  } catch { /* path missing */ }
  return false;
}

/**
 * Persist the Owner's per-project "Development in a working copy" toggle.
 * Affects subsequent Developer launches only; never alters active runs or existing workspaces.
 */
export function setProjectWorkspaceDevelopment(projectPathRaw: unknown, enabledRaw: unknown): Project {
  const projectPath = requireRegisteredProject(projectPathRaw);
  if (typeof enabledRaw !== "boolean") {
    throw new ProjectPermissionError("enabled must be a boolean.", 400, "invalid");
  }
  const updated = projects.setWorkspaceDevelopment(projectPath, enabledRaw);
  if (!updated) throw new ProjectPermissionError("That project is not registered in ForgeOrbit.", 404, "project");
  try {
    broadcastAppEvent({
      type: "project_permission",
      projectPath,
      requestId: "workspace-development",
      status: enabledRaw ? "enabled" : "disabled",
      ts: Date.now(),
    });
  } catch { /* UI refreshes on next read */ }
  try {
    new ActivityJournalCore(db).record({
      eventType: "permission.workspace_development.updated",
      projectPath,
      actorType: "owner",
      actorId: "owner",
      targetType: "project",
      targetId: projectPath,
      idempotencyKey: `permission-workspace-dev:${projectPath}:${Date.now()}:${enabledRaw ? "1" : "0"}`,
      payload: { enabled: enabledRaw ? 1 : 0 },
    });
  } catch { /* projects table is the source of truth */ }
  return updated;
}

/** Rows for the existing Owner attention roll-up: pending and not expired. */
export function listPendingPermissionRows(): ProjectPermissionRequestRow[] {
  const now = Date.now();
  return db
    .query<RequestRow, [number]>(`SELECT * FROM project_permission_requests WHERE status = 'pending' AND expires_at > ? ORDER BY created_at DESC`)
    .all(now)
    .map(requestOf)
    .map((request) => ({
      projectPath: request.projectPath,
      id: request.id,
      title: request.taskTitle,
      taskId: request.taskId,
      command: request.command,
      cwd: request.cwd,
      commandFingerprint: request.commandFingerprint,
      expiresAt: request.expiresAt,
      origin: request.origin,
    }));
}

// ---------------------------------------------------------------- rules

function requireRegisteredProject(projectPath: unknown): string {
  if (typeof projectPath !== "string" || !projectPath.trim()) throw new ProjectPermissionError("A project is required.", 400, "project");
  if (!projects.get(projectPath)) throw new ProjectPermissionError("That project is not registered in ForgeOrbit.", 404, "project");
  return projectPath;
}

export function setProjectDefault(projectPathRaw: unknown, mode: unknown): ProjectPermissionRule[] {
  const projectPath = requireRegisteredProject(projectPathRaw);
  if (mode !== "ask" && mode !== "deny") throw new ProjectPermissionError("The project default is Ask or Deny.", 400, "mode");
  const now = Date.now();
  db.transaction(() => {
    db.run(
      `UPDATE project_permission_rules SET revoked_at = ? WHERE project_path = ? AND action = ? AND mode = 'deny' AND command IS NULL AND revoked_at IS NULL`,
      [now, projectPath, ACTION],
    );
    if (mode === "deny") {
      db.run(
        `INSERT INTO project_permission_rules (id, project_path, action, mode, command, created_at) VALUES (?, ?, ?, 'deny', NULL, ?)`,
        [randomUUID(), projectPath, ACTION, now],
      );
    }
  })();
  return listRules(projectPath);
}

export function addAllowRule(projectPathRaw: unknown, commandRaw: unknown): ProjectPermissionRule {
  const projectPath = requireRegisteredProject(projectPathRaw);
  const checked = validateRuleCommand(commandRaw);
  if (!checked.ok) throw new ProjectPermissionError(checked.error, 400, "command");
  const active = listRules(projectPath);
  if (active.length >= PERMISSION_RULE_LIMIT_PER_PROJECT) throw new ProjectPermissionError("This project has the maximum number of permission rules. Revoke one first.", 409, "limit");
  const existing = active.find((rule) => rule.mode === "allow" && rule.command === checked.command);
  if (existing) return existing;
  const id = randomUUID();
  db.run(
    `INSERT INTO project_permission_rules (id, project_path, action, mode, command, created_at) VALUES (?, ?, ?, 'allow', ?, ?)`,
    [id, projectPath, ACTION, checked.command, Date.now()],
  );
  return listRules(projectPath).find((rule) => rule.id === id)!;
}

export function revokeRule(id: string): ProjectPermissionRule {
  const row = db.query<RuleRow, [string]>(`SELECT * FROM project_permission_rules WHERE id = ?`).get(id);
  if (!row) throw new ProjectPermissionError("Permission rule not found.", 404, "not-found");
  if (row.revoked_at == null) db.run(`UPDATE project_permission_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [Date.now(), id]);
  return ruleOf(db.query<RuleRow, [string]>(`SELECT * FROM project_permission_rules WHERE id = ?`).get(id)!);
}

// ---------------------------------------------------------------- gates

interface Target {
  projectPath: string;
  taskId: string;
  command: string;
  testPath: string;
  argv: string[];
  executable: string;
  cwd: string;
  sourceFingerprint: string;
  commandFingerprint: string;
}

type GateResult = { ok: true; target: Target } | { ok: false; code: string; reason: string };

function derivedTarget(taskId: string, requestedTestPath: string | null): GateResult {
  const fail = (code: string, reason: string): GateResult => ({ ok: false, code, reason });
  const task = tasks.get(taskId);
  if (!task) return fail("task", "The requesting task no longer exists. No process was started.");
  if (task.pipelineParentId) return fail("task", "A pipeline step cannot request a project test. No process was started.");
  const projectPath = ownerProjectOf(task.workdir, { fresh: true });
  if (!projectPath || !taskInProject(task, projectPath, { fresh: true })) {
    return fail("project", "The task does not belong to a registered project. No process was started.");
  }
  if (autonomyPolicyStore.readEmergency().active) {
    return fail("emergency-stop", "Emergency stop is active. No process was started.");
  }
  const admission = checkProjectLaunchAdmission(projectPath);
  if (!admission.allowed) return fail("project-stopped", `${admission.reason ?? "Project AI execution is not running."} No process was started.`);
  const workspace = getTaskWorkspace(taskId);
  if (!workspace || workspace.taskId !== taskId || workspace.projectPath !== projectPath) {
    return fail("workspace", "No task-owned workspace is bound to this task and project. No process was started.");
  }
  if (workspace.status !== "settled") {
    return fail("workspace", `The task workspace is ${workspace.status}. A test runs only after the Developer run has settled. No process was started.`);
  }
  let files: { path: string; sha256: string }[];
  try {
    files = listedFiles(workspace.stagingPath);
  } catch {
    return fail("workspace", "The task workspace could not be read. No process was started.");
  }
  const roled = files.flatMap((file) => {
    const role = reviewFileRole(file.path);
    return role ? [{ path: file.path, role }] : [];
  });
  const testPath = requestedTestPath
    ? (roled.some((file) => file.path === requestedTestPath && file.role === "test") ? requestedTestPath : null)
    : chooseApprovedTestPath(roled);
  if (!testPath) return fail("test", requestedTestPath ? "That file is not a test file in the task workspace. No process was started." : "No single test file could be chosen in the task workspace. No process was started.");
  const command = approvedTestCommand(testPath);
  if (!command) return fail("test", "The test path is not a fixed test command. No process was started.");
  const argv = ["test", `./${testPath}`];
  const executable = process.execPath;
  const cwd = workspace.stagingPath;
  return {
    ok: true,
    target: {
      projectPath,
      taskId,
      command,
      testPath,
      argv,
      executable,
      cwd,
      sourceFingerprint: sourceFingerprint(files),
      commandFingerprint: commandFingerprint({ command, argv, cwd, executable }),
    },
  };
}

function decisionFor(projectPath: string, command: string): PermissionDecision {
  return evaluateProjectRule(listRules(projectPath), { projectPath, action: ACTION, command });
}

// ---------------------------------------------------------------- requests

function insertRequest(target: Target, status: PermissionRequestStatus, extra: { authority?: PermissionAuthority; ruleId?: string | null; reason?: string | null; originRunId?: string | null }): RequestRow {
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO project_permission_requests (
      id, project_path, task_id, action, command, argv_json, cwd, source_fingerprint, command_fingerprint,
      status, authority, rule_id, reason, created_at, expires_at, decided_at, started_at, origin, origin_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, target.projectPath, target.taskId, ACTION, target.command, JSON.stringify(target.argv), target.cwd,
      target.sourceFingerprint, target.commandFingerprint, status, extra.authority ?? null, extra.ruleId ?? null, extra.reason ?? null,
      now, now + PERMISSION_REQUEST_TTL_MS,
      status === "pending" ? null : now,
      status === "running" ? now : null,
      extra.originRunId ? "worker" : "owner",
      extra.originRunId ?? null,
    ],
  );
  return loadRequest(id)!;
}

/**
 * One concise Activity Journal record per decided request: outcome and authority only.
 * No command output, no credentials. The request row stays the source of truth, so a
 * journal failure never changes or blocks the request.
 */
function journalOutcome(row: RequestRow): void {
  try {
    new ActivityJournalCore(db).record({
      eventType: "permission.test.finished",
      projectPath: row.project_path,
      actorType: row.authority === "owner-once" || row.status === "denied" || row.status === "cancelled" ? "owner" : "system",
      actorId: row.authority === "owner-once" ? "owner" : "project-permissions",
      targetType: "task",
      targetId: row.task_id,
      taskId: row.task_id,
      idempotencyKey: `permission-test:${row.id}:finished`,
      payload: {
        requestId: row.id,
        taskId: row.task_id,
        status: row.status,
        authority: row.authority ?? "none",
        ruleId: row.rule_id ?? "",
        exitCode: row.exit_code,
        commandFingerprint: row.command_fingerprint,
      } as Record<string, string | number>,
    });
  } catch { /* the request row is the durable record */ }
}

function finish(id: string, status: PermissionRequestStatus, fields: { reason?: string | null; exitCode?: number | null; summary?: string | null; isolation?: string | null } = {}): void {
  db.run(
    `UPDATE project_permission_requests
     SET status = ?, reason = COALESCE(?, reason), exit_code = ?, summary = ?, isolation = ?, finished_at = ?
     WHERE id = ? AND status IN ('running', 'pending')`,
    [status, fields.reason ?? null, fields.exitCode ?? null, fields.summary ?? null, fields.isolation ?? null, Date.now(), id],
  );
  const row = loadRequest(id);
  if (row) { emit(row); journalOutcome(row); }
}

/**
 * A worker/task asks to run its project's test. This only records the ask (or
 * the rule's answer). It never grants anything by itself: with no allow rule the
 * request waits for the Owner, with a deny rule it is recorded as denied.
 */
export async function requestProjectTest(input: { taskId?: unknown; testPath?: unknown; reviewed?: { projectPath?: unknown; commandFingerprint?: unknown; sourceFingerprint?: unknown } | null }): Promise<ProjectPermissionRequest> {
  if (typeof input.taskId !== "string" || !input.taskId) throw new ProjectPermissionError("A task is required.", 400, "task");
  const testPath = typeof input.testPath === "string" && input.testPath ? input.testPath : null;
  const gate = derivedTarget(input.taskId, testPath);
  if (!gate.ok) throw new ProjectPermissionError(gate.reason, 409, gate.code);
  const target = gate.target;
  // A caller that showed the Owner a target must submit exactly that target. If the backend now
  // derives something else, nothing is recorded and the Owner has to review again.
  if (input.reviewed != null && (input.reviewed.projectPath !== target.projectPath || input.reviewed.commandFingerprint !== target.commandFingerprint || input.reviewed.sourceFingerprint !== target.sourceFingerprint)) {
    throw new ProjectPermissionError("The command, working directory or source changed after you reviewed it. Review it again. Nothing was requested or run.", 409, "target-changed");
  }
  const open = db.query<{ id: string }, [string, string, number]>(
    `SELECT id FROM project_permission_requests WHERE task_id = ? AND command_fingerprint = ? AND status IN ('pending','running') AND (status = 'running' OR expires_at > ?) LIMIT 1`,
  ).get(target.taskId, target.commandFingerprint, Date.now());
  if (open) throw new ProjectPermissionError("This exact request is already open.", 409, "duplicate");
  const decision = decisionFor(target.projectPath, target.command);
  if (decision.effect === "deny") {
    const row = insertRequest(target, "denied", { ruleId: decision.ruleId, reason: decision.reason + " No process was started." });
    emit(row);
    journalOutcome(row);
    return requestOf(row);
  }
  if (decision.effect === "ask") {
    const row = insertRequest(target, "pending", { reason: decision.reason });
    emit(row);
    return requestOf(row);
  }
  const row = insertRequest(target, "running", { authority: "project-rule", ruleId: decision.ruleId, reason: decision.reason });
  emit(row);
  await dispatch(row.id);
  return requestOf(loadRequest(row.id)!);
}


// ------------------------------------------------- tests covered by the project's "Work independently" policy

/** A request the project's own Work independently policy authorized carries this rule id (the column has no other room). */
const POLICY_RULE_PREFIX = "handsoff:";
const isPolicyAuthority = (row: Pick<RequestRow, "authority" | "rule_id">): boolean =>
  row.authority === "project-rule" && typeof row.rule_id === "string" && row.rule_id.startsWith(POLICY_RULE_PREFIX);

/** Live check: the policy is still on and still covers offline tests. A deny rule is checked separately and always wins. */
function policyStillCovers(row: Pick<RequestRow, "project_path">): boolean {
  const live = handsoffStore.getPolicy(row.project_path);
  return Boolean(live?.policy.enabled && live.policy.runOfflineTests);
}

/**
 * Run the one fixed test of this task's settled working copy because the Owner's stored policy covers it. This is the
 * same request record, derivation, sandbox and gates as an Owner "allow once": the backend derives the target, a deny
 * rule still wins, Emergency Stop and the project lifecycle still apply, and nothing the caller passes names a command.
 * It never starts a test the policy does not cover and never records a pass it did not observe.
 */
export async function requestPolicyCoveredTest(input: { taskId: string; policyRevision: number }): Promise<ProjectPermissionRequest> {
  const gate = derivedTarget(input.taskId, null);
  if (!gate.ok) throw new ProjectPermissionError(gate.reason, 409, gate.code);
  const target = gate.target;
  if (!policyStillCovers({ project_path: target.projectPath })) {
    throw new ProjectPermissionError("The project's Work independently policy does not cover offline tests. No process was started.", 409, "policy");
  }
  const open = db.query<{ id: string }, [string, string, number]>(
    `SELECT id FROM project_permission_requests WHERE task_id = ? AND command_fingerprint = ? AND status IN ('pending','running') AND (status = 'running' OR expires_at > ?) LIMIT 1`,
  ).get(target.taskId, target.commandFingerprint, Date.now());
  if (open) throw new ProjectPermissionError("This exact request is already open.", 409, "duplicate");
  const decision = decisionFor(target.projectPath, target.command);
  if (decision.effect === "deny") {
    const row = insertRequest(target, "denied", { ruleId: decision.ruleId, reason: decision.reason + " No process was started." });
    emit(row);
    journalOutcome(row);
    return requestOf(row);
  }
  const row = insertRequest(target, "running", {
    authority: "project-rule",
    ruleId: `${POLICY_RULE_PREFIX}${input.policyRevision}`,
    reason: `Covered by the project's Work independently policy (revision ${input.policyRevision}).`,
  });
  emit(row);
  await dispatch(row.id);
  return requestOf(loadRequest(row.id)!);
}

export type WorkerSuggestionResult =
  | { outcome: "requested"; requestId: string; status: PermissionRequestStatus }
  | { outcome: "duplicate"; requestId: string }
  | { outcome: "ignored"; code: string; reason: string };

/**
 * The run's own context is the only authority for who is asking. A worker suggestion is valid
 * only while its Developer run is still the task's latest run and still owns the task's settled
 * workspace; a newer run, a replaced workspace or a different task means the suggestion is stale.
 */
function workerContextProblem(taskId: string, runId: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return "The task no longer exists.";
  if (task.runId !== runId) return "The Developer run that suggested this test is no longer the task's latest run.";
  const workspace = getTaskWorkspace(taskId);
  if (!workspace || workspace.taskId !== taskId || workspace.developerRunId !== runId) {
    return "The task workspace does not belong to the Developer run that suggested this test.";
  }
  return null;
}

/**
 * A Developer worker suggested running the project's test. The caller (the core's run-settle hook)
 * passes the run it knows; the worker supplies no task, project, command, path, rule or approval.
 * A valid suggestion records ONE pending request, or a recorded denial when a Deny rule applies.
 * It never starts a process, even when an exact Allow rule exists: that rule covers the Owner's own
 * submit, not a worker's suggestion. Only the Owner's Allow once runs it.
 */
export function suggestProjectTestFromWorker(input: { runId: string; text: string }): WorkerSuggestionResult {
  const ignored = (code: string, reason: string): WorkerSuggestionResult => ({ outcome: "ignored", code, reason });
  if (!parseWorkerTestSuggestion(input.text)) return ignored("no-suggestion", "The worker's final message carries no valid project test suggestion.");
  const run = runs.get(input.runId);
  if (!run) return ignored("run", "The run does not exist.");
  if (run.status !== "succeeded") return ignored("run", "Only a run that finished successfully can suggest a test.");
  if (run.qcReviewId) return ignored("run", "A review run cannot suggest a project test.");
  const taskId = run.taskId;
  const stale = workerContextProblem(taskId, input.runId);
  if (stale) return ignored("stale-run", stale);
  const gate = derivedTarget(taskId, null);
  if (!gate.ok) return ignored(gate.code, gate.reason);
  const target = gate.target;
  const same = db.query<{ id: string }, [string, string]>(`SELECT id FROM project_permission_requests WHERE task_id = ? AND origin_run_id = ? LIMIT 1`).get(taskId, input.runId);
  if (same) return { outcome: "duplicate", requestId: same.id };
  const open = db.query<{ id: string }, [string, string, number]>(
    `SELECT id FROM project_permission_requests WHERE task_id = ? AND command_fingerprint = ? AND status IN ('pending','running') AND (status = 'running' OR expires_at > ?) LIMIT 1`,
  ).get(taskId, target.commandFingerprint, Date.now());
  if (open) return { outcome: "duplicate", requestId: open.id };
  const decision = decisionFor(target.projectPath, target.command);
  try {
    if (decision.effect === "deny") {
      const row = insertRequest(target, "denied", { ruleId: decision.ruleId, reason: `${decision.reason} No process was started.`, originRunId: input.runId });
      emit(row);
      journalOutcome(row);
      return { outcome: "requested", requestId: row.id, status: "denied" };
    }
    const reason = decision.effect === "allow"
      ? "A worker suggested this test. An allow rule covers your own request, not a worker's suggestion, so it waits for your decision."
      : "A worker suggested this test. It needs your decision.";
    const row = insertRequest(target, "pending", { reason, originRunId: input.runId });
    emit(row);
    return { outcome: "requested", requestId: row.id, status: "pending" };
  } catch {
    // The unique (task, originating run) index: a concurrent delivery of the same suggestion won.
    const winner = db.query<{ id: string }, [string, string]>(`SELECT id FROM project_permission_requests WHERE task_id = ? AND origin_run_id = ? LIMIT 1`).get(taskId, input.runId);
    if (winner) return { outcome: "duplicate", requestId: winner.id };
    throw new ProjectPermissionError("The suggestion could not be recorded.", 500, "write");
  }
}

/**
 * Run-settle hook: read the settled run's own main-stream assistant text (the core persisted it;
 * the worker never touched the API) and record at most one pending request. Never throws into the
 * settle path.
 */
export function ingestWorkerTestSuggestion(runId: string): WorkerSuggestionResult {
  try {
    const text = runs
      .events(runId)
      .filter((event) => event.subagentId == null && event.stream === "assistant")
      .map((event) => event.data)
      .join("\n");
    return suggestProjectTestFromWorker({ runId, text });
  } catch (error) {
    return { outcome: "ignored", code: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read-only answer for the task panel: is a request possible right now, what exact target
 * would it name, what would the effective rule do on submission, and what happened to the
 * requests already made for this task. Writes nothing, starts nothing, creates no request.
 * Eligibility is `derivedTarget`'s: the UI does not re-implement it.
 */
export function previewProjectTest(taskId: string): ProjectTestPreview {
  const now = Date.now();
  const requests = db
    .query<RequestRow, [string]>(`SELECT * FROM project_permission_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 5`)
    .all(taskId)
    .map(requestOf)
    .map((request) => ({ ...request, status: effectiveStatus(request, now) }));
  const open = requests.find((request) => request.status === "pending" || request.status === "running") ?? null;
  const gate = derivedTarget(taskId, null);
  if (!gate.ok) {
    return { taskId, eligible: false, code: gate.code, reason: gate.reason, target: null, effect: null, ruleId: null, openRequestId: open?.id ?? null, requests };
  }
  const t = gate.target;
  const decision = decisionFor(t.projectPath, t.command);
  const target = { projectPath: t.projectPath, command: t.command, cwd: t.cwd, sourceFingerprint: t.sourceFingerprint, commandFingerprint: t.commandFingerprint };
  if (open) {
    return { taskId, eligible: false, code: "open", reason: "A request for this test is already open.", target, effect: decision.effect, ruleId: decision.ruleId, openRequestId: open.id, requests };
  }
  return { taskId, eligible: true, code: null, reason: null, target, effect: decision.effect, ruleId: decision.ruleId, openRequestId: null, requests };
}

/**
 * What the task's workspace holds now, for judging whether an earlier test still describes it.
 * Read-only. It deliberately does not apply the emergency-stop or lifecycle gates of
 * `derivedTarget`: those decide whether a *new* run may start, not whether old bytes changed.
 */
function currentSourceBinding(taskId: string, projectPath: string): CurrentSourceBinding | null {
  const workspace = getTaskWorkspace(taskId);
  if (!workspace || workspace.taskId !== taskId || workspace.projectPath !== projectPath) return null;
  let fingerprint: string | null = null;
  // While a Developer run owns the workspace the bytes are in flux: do not read them.
  if (workspace.status === "settled" || workspace.status === "published" || workspace.status === "publication-partial") {
    try {
      fingerprint = sourceFingerprint(listedFiles(workspace.stagingPath));
    } catch {
      fingerprint = null;
    }
  }
  return { projectPath, stagingPath: workspace.stagingPath, status: workspace.status, sourceFingerprint: fingerprint };
}

/**
 * Read-only evidence for the Owner's task review: the task's own project-test requests in its own
 * project, and whether a result still matches the implementation under review. Writes nothing,
 * submits nothing, starts nothing, issues no grant. Another task's or project's rows are never read.
 */
export function readProjectTestEvidence(taskId: string): ProjectTestEvidence {
  const task = tasks.get(taskId);
  if (!task) throw new ProjectPermissionError("Task not found.", 404, "not-found");
  const projectPath = task.pipelineParentId ? null : ownerProjectOf(task.workdir, { fresh: true });
  const requests = projectPath
    ? db
        .query<RequestRow, [string, string]>(`SELECT * FROM project_permission_requests WHERE task_id = ? AND project_path = ? ORDER BY created_at DESC LIMIT 20`)
        .all(taskId, projectPath)
        .map(requestOf)
    : [];
  const ran = requests.some((request) => request.status === "completed" || request.status === "failed");
  // Hashing the workspace is only worth it when there is a result to judge.
  const current = projectPath && ran ? currentSourceBinding(taskId, projectPath) : null;
  return buildProjectTestEvidence({ taskId, projectPath, requests, current, now: Date.now() });
}

/** The Owner's "Allow once". Consumes the grant atomically, then dispatches. */
export async function approveOnce(id: string, body: { projectPath?: unknown; commandFingerprint?: unknown }): Promise<ProjectPermissionRequest> {
  const row = loadRequest(id);
  if (!row) throw new ProjectPermissionError("Permission request not found.", 404, "not-found");
  if (body.projectPath !== row.project_path) throw new ProjectPermissionError("The approval names a different project. Nothing was approved or run.", 409, "project-mismatch");
  if (body.commandFingerprint !== row.command_fingerprint) throw new ProjectPermissionError("The approval names a different command or directory. Nothing was approved or run.", 409, "operation-mismatch");
  const now = Date.now();
  const claimed = db.run(
    `UPDATE project_permission_requests
     SET status = 'running', authority = 'owner-once', decided_at = ?, started_at = ?
     WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    [now, now, id, now],
  );
  if (claimed.changes !== 1) {
    const current = loadRequest(id)!;
    if (current.status === "pending") {
      finish(id, "expired", { reason: "The request expired before it was approved. Nothing was run." });
      throw new ProjectPermissionError("This request expired. Nothing was run. The task can ask again.", 409, "expired");
    }
    throw new ProjectPermissionError(`This request is already ${current.status}. An approval is used once and is not reused.`, 409, current.status);
  }
  emit(loadRequest(id)!);
  await dispatch(id);
  return requestOf(loadRequest(id)!);
}

export function denyRequest(id: string): ProjectPermissionRequest {
  const row = loadRequest(id);
  if (!row) throw new ProjectPermissionError("Permission request not found.", 404, "not-found");
  const now = Date.now();
  const changed = db.run(
    `UPDATE project_permission_requests SET status = 'denied', decided_at = ?, finished_at = ?, reason = ? WHERE id = ? AND status = 'pending'`,
    [now, now, "You denied this request. No process was started.", id],
  );
  if (changed.changes !== 1) throw new ProjectPermissionError(`This request is already ${loadRequest(id)!.status}.`, 409, loadRequest(id)!.status);
  emit(loadRequest(id)!);
  journalOutcome(loadRequest(id)!);
  return requestOf(loadRequest(id)!);
}

export function cancelRequest(id: string, reason = "The request was cancelled. No process was started."): ProjectPermissionRequest {
  const row = loadRequest(id);
  if (!row) throw new ProjectPermissionError("Permission request not found.", 404, "not-found");
  const now = Date.now();
  const changed = db.run(
    `UPDATE project_permission_requests SET status = 'cancelled', finished_at = ?, reason = ? WHERE id = ? AND status = 'pending'`,
    [now, reason, id],
  );
  if (changed.changes !== 1) throw new ProjectPermissionError(`This request is already ${loadRequest(id)!.status}.`, 409, loadRequest(id)!.status);
  emit(loadRequest(id)!);
  journalOutcome(loadRequest(id)!);
  return requestOf(loadRequest(id)!);
}

/** Emergency stop and similar: pending asks are withdrawn. Running tests are not killed here. */
export function cancelPendingPermissionRequests(reason: string): number {
  const rows = db.query<RequestRow, []>(`SELECT * FROM project_permission_requests WHERE status = 'pending'`).all();
  let cancelled = 0;
  for (const row of rows) {
    try {
      cancelRequest(row.id, `${reason} No process was started.`);
      cancelled += 1;
    } catch { /* settled concurrently */ }
  }
  return cancelled;
}

/** Boot: expire stale asks and close tests that were mid-run when the app stopped. Never starts anything. */
export function recoverProjectPermissionRequests(): { expired: number; interrupted: number } {
  const now = Date.now();
  const expired = db.run(
    `UPDATE project_permission_requests SET status = 'expired', finished_at = ?, reason = 'The request expired before it was approved. Nothing was run.'
     WHERE status = 'pending' AND expires_at <= ?`,
    [now, now],
  ).changes;
  const interrupted = db.run(
    `UPDATE project_permission_requests SET status = 'interrupted', finished_at = ?, reason = 'ForgeOrbit restarted while the test was running. No pass was recorded.'
     WHERE status = 'running'`,
    [now],
  ).changes;
  return { expired, interrupted };
}

// ---------------------------------------------------------------- dispatch

/**
 * Runs a request that is already `running` (claimed). Every check is made again
 * against fresh state immediately before the process could start; on any
 * mismatch nothing is spawned and the request ends `blocked`.
 */
async function dispatch(id: string): Promise<void> {
  const row = loadRequest(id);
  if (!row || row.status !== "running") return;
  const block = (reason: string) => finish(id, "blocked", { reason });
  const gate = derivedTarget(row.task_id, row.command.slice("bun test ./".length));
  if (!gate.ok) return block(gate.reason);
  const target = gate.target;
  if (target.projectPath !== row.project_path) return block("The task now belongs to a different project than the one that was approved. No process was started.");
  if (target.command !== row.command || target.cwd !== row.cwd) return block("The command or working directory changed after the request. No process was started.");
  if (target.sourceFingerprint !== row.source_fingerprint) return block("The test or source files changed after the request. The approval does not cover the new bytes. No process was started.");
  if (target.commandFingerprint !== row.command_fingerprint) return block("The operation changed after the request. No process was started.");
  if (row.origin === "worker") {
    const stale = row.origin_run_id ? workerContextProblem(row.task_id, row.origin_run_id) : "The request has no originating run.";
    if (stale) return block(`${stale} The approval does not cover a newer run. No process was started.`);
  }
  const decision = decisionFor(row.project_path, row.command);
  if (decision.effect === "deny") return block(`${decision.reason} No process was started.`);
  if (isPolicyAuthority(row)) {
    if (!policyStillCovers(row)) return block("The project's Work independently policy no longer covers this test. No process was started.");
  } else if (row.authority === "project-rule" && (decision.effect !== "allow" || decision.ruleId !== row.rule_id)) {
    return block("The project rule that allowed this was revoked or changed. No process was started.");
  }
  const observed = await withPracticalTestLock(async () => {
    // The shared lock may have queued this behind another test: look again right before the spawn.
    const again = derivedTarget(row.task_id, target.testPath);
    if (!again.ok || again.target.commandFingerprint !== row.command_fingerprint || again.target.sourceFingerprint !== row.source_fingerprint) return null;
    if (row.origin === "worker" && (!row.origin_run_id || workerContextProblem(row.task_id, row.origin_run_id))) return null;
    if (decisionFor(row.project_path, row.command).effect === "deny") return null;
    if (isPolicyAuthority(row)) { if (!policyStillCovers(row)) return null; }
    else if (row.authority === "project-rule" && decisionFor(row.project_path, row.command).ruleId !== row.rule_id) return null;
    return runSeatbeltBunTest({ workspacePath: target.cwd, testPath: target.testPath, command: target.command, executable: target.executable, argv: target.argv });
  });
  if (!observed) return block("The task, source or rule changed while the request waited. No process was started.");
  if (observed.isolation === "blocked") {
    return finish(id, "blocked", { reason: observed.reason ?? "The offline boundary could not be built. No test was run.", isolation: "blocked" });
  }
  const summary = testSummary(observed.stdout, observed.stderr, observed.exitCode);
  if (sandboxNotApplied(observed)) {
    // sandbox-exec exits 71 when it cannot apply the profile (for example when ForgeOrbit itself runs
    // inside another sandbox). The test never started, so this is not a test failure and not a pass.
    return finish(id, "blocked", {
      reason: "The offline sandbox could not be applied here (sandbox-exec refused to start it). The test did not run and no pass was recorded.",
      summary,
      isolation: "blocked",
    });
  }
  if (observed.interrupted || observed.timedOut || observed.outputExceeded || observed.exitCode == null) {
    return finish(id, observed.interrupted ? "interrupted" : "failed", {
      reason: observed.reason ?? "No exit code was observed. No pass was recorded.",
      summary,
      isolation: observed.isolation,
    });
  }
  const digest = practicalEvidenceDigest({
    sourceFingerprint: row.source_fingerprint,
    commandFingerprint: row.command_fingerprint,
    exitCode: observed.exitCode,
    stdout: observed.stdout.slice(0, 4000),
    stderr: observed.stderr.slice(0, 4000),
  });
  finish(id, observed.exitCode === 0 ? "completed" : "failed", {
    reason: observed.exitCode === 0 ? "The test passed in the offline sandbox." : "The test ran and failed.",
    exitCode: observed.exitCode,
    summary: `${summary}\nEvidence ${digest.slice(0, 12)}`.slice(0, 2000),
    isolation: observed.isolation,
  });
}

/** sandbox-exec's own refusal (EX_OSERR, 71): the boundary was never applied, so no test ran. */
export function sandboxNotApplied(observed: { exitCode: number | null; stderr: string }): boolean {
  return observed.exitCode === 71 && /sandbox-exec: sandbox_apply|sandbox_apply: Operation not permitted/.test(observed.stderr);
}

export const __testing = { derivedTarget };
