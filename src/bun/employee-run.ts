import { bindComputerWorkflow, prepareComputerWorkflowReview } from "./task-computer-workflow.ts";
import { objectiveTaskIsManaged, objectiveTaskOperation } from "./orchestration/objective-mission.ts";
import { ProfessionalTurnCore, recordProfessionalTurnRunOutcome } from "./professional-turn-core.ts";
/**
 * Employee supervised execution (FO-010E2).
 *
 * Connects an assigned AI worker to a real run, and only through the one
 * existing task runtime (`launchEmployeeTask` -> the board's `startTask`).
 * It adds organizational context and verification; it is not a second
 * launcher, scheduler, or shell.
 *
 * Two owner actions, in this order:
 *   1. review  - the server re-reads everything (FO-010E1 preflight plus the
 *                supervised checks) and stores ONE pending record describing
 *                exactly the run that would start. Starts nothing.
 *   2. start   - the owner confirms that record. The server then, with no
 *                SQLite transaction held across the spawn:
 *                  validate + atomically claim (one write transaction)
 *                  -> invoke the existing runtime
 *                  -> persist the real outcome.
 *
 * The confirmation is single use, expires, and is bound to task, project,
 * employee, assignment revision, harness, requested model/effort, permission
 * mode and the supervised checks the owner saw. It is never a standing grant,
 * and it is not an FO-010D assignment approval or an FO-011E knowledge grant.
 *
 * `actual.*` is recorded only from what the runtime established. A successful
 * spawn is not proof of a provider account or a model.
 */

import { currentReadScope } from "./codex-read-scope.ts";
import {
  authorizeSupervisedLaunch,
  buildEmployeeAttemptOperation,
  discardUnconsumedLaunchTicket,
  isProductionOwnerGateActive,
} from "./owner-trust/launch-gate.ts";
import { supervisedRunLimitSeconds } from "./supervised-run-limit.ts";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolveProfessionalBinding, verifyProfessionalBinding } from "./professional-runtime.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { taskAvailabilityRefusal, taskAvailabilityNow } from "./task-availability.ts";
import type { Task } from "../shared/types.ts";
import { sanitizeStoredExecution, taskFingerprint, type ExecutionConfig } from "../shared/project-execution.ts";
import {
  EMPLOYEE_REVIEW_VALID_MS,
  parseCancelRequest,
  parseStartRequest,
  reasonOfRun,
  resultOfRunStatus,
  type EmployeeRunReviewFacts,
  type EmployeeRunView,
} from "../shared/execution/run.ts";
import { parsePreflightRequest, type PreflightIssue, type PreflightRequest, type PreflightResult } from "../shared/execution/preflight.ts";
import { resourceKey, workflowResourceBlock } from "./orchestrated-resources.ts";
import { getWorkflow, noteOrchestratedLaunchCommitted, validateOrchestratedEmployeeStart } from "./pm-orchestrated-workflow.ts";
import { capText, redactSecrets } from "../shared/project-interview.ts";
import { db, harnesses, projectExecutions, runs, tasks } from "./db.ts";
import { ownershipOf, verifyLaunchScope } from "./project-ownership.ts";
import { describePermissions, layoutNeedsExternalGit } from "../shared/execution/permissions.ts";
import { employeeConfig } from "./execution-selection.ts";
import { routingEvidenceKey } from "./routing-evidence-key.ts";
import { buildRoutingSnapshot } from "./model-router.ts";
import { workspacePermissionIdentity, detectWorkspaceLayout } from "./execution-layout.ts";
import { abandonWorkspaceIfArmed, getTaskWorkspace, permissionSubject, prepareTaskWorkspace, TaskWorkspaceError } from "./task-workspace.ts";
import { isWorkspaceDevelopmentEnabled } from "./project-permissions.ts";
import { parseTaskStagingGrant, presentPermissionBlocks, type TaskStagingGrant } from "../shared/execution/workspace-grant.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";
import type { ExecutionProposal } from "../shared/project-execution.ts";
import { EmployeeRunCore, type EmployeeRunRow } from "./employee-run-core.ts";
import { PreflightError, prepareEmployeeExecution, type PreflightDeps } from "./employee-execution.ts";
import { isRunLive, isRunStarting, subscribeGlobal } from "./orchestrator.ts";
import {
  hasOpenSupervisedProposal,
  launchEmployeeTask,
  reconcileExecution,
  runChecks,
  type ExecutionDeps,
} from "./project-execution.ts";

export class EmployeeRunError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid", readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "EmployeeRunError";
  }
}

export interface EmployeeRunDeps {
  now?: () => number;
  /** Seams for the FO-010E1 preflight (ownership, router snapshot, owner policy). */
  preflight?: PreflightDeps;
  /** Seams for the supervised checks and the runtime call (`startTask`). */
  exec?: ExecutionDeps;
  launch?: typeof launchEmployeeTask;
  newId?: () => string;
  /** Internal mission admission, checked again at the existing submission boundary. */
  missionStage?: { mode: string; verify: () => string | null; onRunRecorded: (runId: string) => void };
  /** Test hook: runs after the claim commits and before the runtime is called. */
  afterClaim?: () => Promise<void> | void;
  /** Optional explicit Owner proof (used by tests to exercise rejection/acceptance without mocking native UI). */
  ownerProof?: unknown;
  ownerLocale?: "en" | "ru";
  /** A hands-off launch asks the project's Owner authorization for its single-use grant instead of a native prompt. */
  handsoffLaunch?: import("./owner-trust/launch-gate.ts").ProjectGrantClaim;
}

/** Attempts this process is starting right now. A `starting` row outside it lost its claim to a crash. */
const activeClaims = new Set<string>();

const issue = (code: string, message: string): PreflightIssue => ({ code, message });
const coreFor = (deps: EmployeeRunDeps) => new EmployeeRunCore(db, deps.now ?? Date.now);

/* ────────────────────────────────────────────────────────────────────────── *
 * Reading and reconciling.
 * ────────────────────────────────────────────────────────────────────────── */

function runStatusOf(row: EmployeeRunRow): EmployeeRunView["runStatus"] {
  if (!row.run_id) return null;
  const run = runs.get(row.run_id);
  if (!run || run.taskId !== row.task_id) return null;
  return run.status === "running" ? (isRunLive(run.id) ? "running" : isRunStarting(run.id) ? "starting" : null) : run.endedAt != null ? resultOfRunStatus(run.status) : null;
}

/** Record the end of the run once, from the run row. No guessing. */
function syncFinish(core: EmployeeRunCore, row: EmployeeRunRow): EmployeeRunRow {
  if (row.status !== "started" || row.finished_at != null || !row.run_id) return row;
  const run = runs.get(row.run_id);
  const result = run ? resultOfRunStatus(run.status) : null;
  if (!run || run.taskId !== row.task_id || !result || run.endedAt == null) return row;
  return core.finish(row.id, { finishedAt: run.endedAt, result, reason: reasonOfRun(result, run.exitCode) }) ?? row;
}

/** Read the exact durable link only. Never call supervised recovery's time heuristic. */
function linkedProposal(row: EmployeeRunRow): ExecutionProposal | null {
  if (!row.execution_id) return null;
  try {
    const proposal = sanitizeStoredExecution(JSON.parse(projectExecutions.get(row.project_path, row.execution_id) ?? "null"));
    return proposal?.id === row.execution_id && proposal.source === "employee"
      && proposal.employeeRunId === row.id && proposal.taskId === row.task_id && proposal.projectPath === row.project_path
      ? proposal : null;
  } catch { return null; }
}

function confirmedRun(row: EmployeeRunRow) {
  const proposal = linkedProposal(row);
  if (row.run_id && proposal?.runId && row.run_id !== proposal.runId) return null;
  const id = row.run_id ?? proposal?.runId;
  const run = id ? runs.get(id) : null;
  return run && run.taskId === row.task_id && row.approved_at != null
    && run.startedAt >= (row.claimed_at ?? row.approved_at) ? run : null;
}

/** A lost start stays unknown unless its exact Run ID was durably recorded. */
function reconcileStarting(core: EmployeeRunCore, row: EmployeeRunRow): EmployeeRunRow {
  if (!(row.status === "starting" || row.status === "indeterminate") || activeClaims.has(row.id)) return row;
  const found = confirmedRun(row);
  if (found) {
    const owner = core.byRun(found.id);
    if (!owner || owner.id === row.id) {
      const proposal = linkedProposal(row);
      if (proposal?.runId === found.id) reconcileExecution(row.project_path, proposal.id);
      return core.markStarted(row.id, {
        runId: found.id, startedAt: found.startedAt, actualHarnessId: found.agent,
        reason: "Reconciled with the exact run recorded by the runtime.",
      }) ?? row;
    }
  }
  const proposal = linkedProposal(row);
  if (!row.run_id && proposal?.status === "start-failed" && !proposal.runId
    && proposal.history.some((event) => event.kind === "start-refused")) {
    return core.settleStart(row.id, "start-failed", "Reconciled: the runtime refused the start before recording a run.") ?? row;
  }
  return core.settleStart(row.id, "indeterminate",
    "The start outcome is not confirmed. No exact run link can be verified; the process may still exist. Reconcile Status before another employee launch.") ?? row;
}

/** Owner read/reconciliation, serialized with claims. No process or run mutation. */
export function reconcileEmployeeExecution(id: string, raw: unknown, deps: EmployeeRunDeps = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 0) {
    throw new EmployeeRunError("Expected an empty object. Runtime facts cannot be supplied by the client.");
  }
  const core = coreFor(deps);
  return db.transaction(() => {
    const row = core.get(id);
    if (!row) throw new EmployeeRunError("Employee execution not found.", 404, "not-found");
    // Historical attribution survives a move. A reconcile cannot use another
    // project's current task as evidence for this historical attempt.
    const task = tasks.get(row.task_id);
    if (task) {
      const owner = ownershipOf(task.workdir, { fresh: true });
      if (owner.kind !== "owned" || owner.projectPath !== row.project_path || !verifyLaunchScope(task, row.project_path).ok) {
        throw new EmployeeRunError("The task no longer belongs to the recorded project.", 409, "ownership-changed");
      }
    }
    const attempt = viewOf(core, row);
    const found = confirmedRun(core.get(id)!);
    const outcome = attempt.phase === "running" ? "running" : attempt.result && attempt.result !== "orphaned"
      ? "terminal" : attempt.status === "start-failed" ? "start-failed" : "indeterminate";
    return { attempt, outcome, confirmedRun: found ? { id: found.id, status: found.status, startedAt: found.startedAt, endedAt: found.endedAt } : null };
  }).immediate();
}

function abandonAutoPreparedFromRow(row: EmployeeRunRow): void {
  try {
    const facts = JSON.parse(row.review_json) as EmployeeRunReviewFacts;
    if (facts.autoPreparedWorkspaceId) {
      abandonWorkspaceIfArmed(row.task_id, facts.autoPreparedWorkspaceId);
    }
  } catch { /* ignore unreadable review_json */ }
}

function settle(core: EmployeeRunCore, row: EmployeeRunRow): EmployeeRunRow {
  let next = row;
  if (next.status === "awaiting-approval" && next.expires_at <= core.now()) {
    next = core.expire(next.id) ?? next;
    if (next.status === "expired") abandonAutoPreparedFromRow(next);
  }
  if (next.status === "starting" || next.status === "indeterminate") next = reconcileStarting(core, next);
  return syncFinish(core, next);
}

function viewOf(core: EmployeeRunCore, row: EmployeeRunRow): EmployeeRunView {
  const settled = settle(core, row);
  return core.view(settled, runStatusOf(settled));
}

export function getEmployeeRun(id: string, deps: EmployeeRunDeps = {}): EmployeeRunView {
  const core = coreFor(deps);
  const row = core.get(id);
  if (!row) throw new EmployeeRunError("Employee execution not found.", 404, "not-found");
  return viewOf(core, row);
}

export function listEmployeeRuns(filter: { taskId?: string; employeeId?: string; limit?: number; before?: string }, deps: EmployeeRunDeps = {}): EmployeeRunView[] {
  const core = coreFor(deps);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
  const rows = filter.taskId ? core.listForTask(filter.taskId, limit) : filter.employeeId ? core.listForEmployee(filter.employeeId, limit, filter.before) : [];
  return rows.map((row) => viewOf(core, row));
}

/**
 * Boot recovery: settle every start that was in flight when the process died
 * and write the end of every run that finished meanwhile. Never starts
 * anything. Returns how many rows changed.
 */
export function recoverEmployeeExecutions(deps: EmployeeRunDeps = {}): number {
  new ProfessionalTurnCore(db).recover();
  const core = coreFor(deps);
  let changed = 0;
  for (const row of core.listStarting()) {
    if (reconcileStarting(core, row).status !== row.status) changed++;
  }
  for (const row of core.listUnfinished()) {
    const run = row.run_id && runs.get(row.run_id);
    if (run && run.endedAt != null) recordProfessionalTurnRunOutcome(db, run.id, run.status, run.endedAt);
    if (syncFinish(core, row).finished_at != null) changed++;
  }
  return changed;
}

let tracking = false;
/** Write a run's end the moment it settles. Idempotent. */
export function initEmployeeExecutionTracking(deps: EmployeeRunDeps = {}): void {
  if (tracking) return;
  tracking = true;
  subscribeGlobal((event) => {
    if (event.kind !== "run-status") return;
    const core = coreFor(deps);
    const row = core.byRun(event.runId);
    if (row) syncFinish(core, row);
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Review.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The configuration the existing runtime would use. Never silently broader than the task's mode,
 * except where the Owner's saved preferences name a required permission mode: that choice is
 * explicit, is disclosed in the review warnings, and is re-validated by the preflight.
 */
export { employeeConfig } from "./execution-selection.ts";

function inputsKeyOf(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function factsOf(preflight: PreflightResult, checked: Awaited<ReturnType<typeof runChecks>>, permission: EmployeeRunReviewFacts["permission"], extraWarnings: PreflightIssue[]): EmployeeRunReviewFacts {
  const selection = preflight.selection!;
  return {
    evidence: selection.evidence,
    account: { state: selection.account.state, label: selection.account.label },
    quota: { state: selection.quota.state, label: selection.quota.label, facts: selection.quota.facts },
    model: { state: selection.model.state, label: selection.model.label },
    warnings: [...preflight.warnings, ...extraWarnings].slice(0, 20),
    permission,
    ownerRestrictions: {
      spending: preflight.ownerRestrictions.spending,
      allowedHarnesses: preflight.ownerRestrictions.allowedHarnesses,
      requiredApprovals: preflight.ownerRestrictions.requiredApprovals.slice(0, 10),
    },
    checks: checked.checks.slice(0, 40).map((c) => ({ level: c.level, code: c.code, message: c.message })),
    harnessLabel: checked.resolved.harnessLabel,
    modelLabel: checked.resolved.modelLabel,
    modeLabel: checked.resolved.modeLabel,
    accessLevel: checked.resolved.accessLevel,
    workspace: checked.resolved.workspace,
    isolation: checked.resolved.isolation,
    ...(checked.resolved.launchTarget ? { launchTarget: checked.resolved.launchTarget } : {}),
    ...(checked.resolved.workspaceKind ? { workspaceKind: checked.resolved.workspaceKind } : {}),
    ...(checked.resolved.stagedOutputPaths ? { stagedOutputPaths: checked.resolved.stagedOutputPaths.slice(0, 20) } : {}),
    ...(checked.resolved.accessDiagnostics ? { accessDiagnostics: checked.resolved.accessDiagnostics } : {}),
  };
}

export interface ReviewOutcome {
  preflight: PreflightResult;
  /** Null when anything blocks; nothing was recorded then. */
  attempt: EmployeeRunView | null;
  blockingErrors: PreflightIssue[];
  reused: boolean;
}

/**
 * Re-read everything and record ONE pending review, or explain what blocks.
 * Starts nothing and writes only the pending review row.
 */
function splitExecutionPermission(raw: unknown): { body: unknown; grant: TaskStagingGrant | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.hasOwn(raw, "executionPermission")) {
    return { body: raw, grant: null };
  }
  const record = { ...(raw as Record<string, unknown>) };
  const value = record.executionPermission;
  delete record.executionPermission;
  const parsed = parseTaskStagingGrant(value);
  if (!parsed.ok) throw new EmployeeRunError(parsed.error, 400, "invalid");
  return { body: record, grant: parsed.grant };
}

async function ensureTaskStagingGrant(task: Task, projectPath: string, kind: string, mode: string, grant: TaskStagingGrant, externalGit: boolean): Promise<PreflightIssue | null> {
  if (kind !== "codex" || mode !== "auto") {
    return issue("permission-scope", `This approval is for sandboxed Auto on Codex. The reviewed mode is ${mode}. Nothing was prepared.`);
  }
  let granted: string;
  let canonical: string;
  let workdir: string;
  try {
    granted = realpathSync(grant.projectPath);
    canonical = realpathSync(projectPath);
    workdir = realpathSync(task.workdir);
  } catch {
    return issue("permission-scope", "The approved project folder is not available. Nothing was prepared.");
  }
  if (granted !== canonical) return issue("permission-scope", "This approval is for a different registered project. Nothing was prepared.");
  const open = getTaskWorkspace(task.id);
  if (open && (open.status === "armed" || open.status === "executing" || open.status === "settled" || open.status === "publication-partial")) {
    let openProject: string;
    try { openProject = realpathSync(open.projectPath); } catch { openProject = open.projectPath; }
    if (openProject !== workdir) return issue("permission-scope", "An open task workspace belongs to a different project. Nothing was changed.");
    if (open.status !== "armed") return issue("task-staging-refused", "A task workspace is still open. Abandon or publish it before preparing another. Nothing was started in the project folder.");
    const same = open.outputPaths.length === grant.outputPaths.length && grant.outputPaths.every((path) => open.outputPaths.includes(path));
    if (!same) return issue("permission-scope", "A task workspace is already open for different output paths. Nothing was replaced.");
    return null;
  }
  if (!externalGit) return issue("permission-scope", "This review does not require a task-owned workspace write. Clear that approval and review again.");
  try {
    await prepareTaskWorkspace(task.id, { outputPaths: grant.outputPaths }, { approvedProjectPath: projectPath });
  } catch (error) {
    const message = error instanceof TaskWorkspaceError
      ? error.message
      : "The task-owned workspace could not be prepared. Nothing was started in the project folder.";
    return issue("task-staging-refused", message);
  }
  return null;
}

export async function reviewEmployeeExecution(raw: unknown, deps: EmployeeRunDeps = {}): Promise<ReviewOutcome> {
  let request: PreflightRequest;
  let grant: TaskStagingGrant | null = null;
  let body: unknown = raw;
  try {
    const split = splitExecutionPermission(raw);
    grant = split.grant;
    body = split.body;
    request = parsePreflightRequest(body);
  } catch (message) {
    if (message instanceof EmployeeRunError) throw message;
    throw new EmployeeRunError(typeof message === "string" ? message : "Invalid request.", 400, "invalid");
  }
  if (objectiveTaskIsManaged(request.taskId) && !deps.missionStage) {
    throw new EmployeeRunError("The mission prepares this task's launch.", 409, "mission-launch");
  }
  if (!request.harnessId) throw new EmployeeRunError("harnessId is required: choose the harness for this run.", 400, "harness-required");

  let preflight = prepareEmployeeExecution(body, deps.preflight);
  const blocked = (extra: PreflightIssue[] = []): ReviewOutcome => {
    const blockingErrors = presentPermissionBlocks([...preflight.blockingErrors, ...extra]);
    return {
      preflight: { ...preflight, outcome: "blocked", blockingErrors },
      attempt: null, reused: false, blockingErrors,
    };
  };
  const externalGit = preflight.permission?.mode === "auto" && layoutNeedsExternalGit(preflight.permission.layout);
  const externalGitOnly = externalGit && preflight.blockingErrors.every((item) => item.code === "permission-owner-decision");
  if (!preflight.employee || !preflight.assignment || !preflight.canonicalProject || !preflight.selection) return blocked();
  if (preflight.outcome !== "prepared" && !(grant && externalGitOnly)) return blocked();

  if (coreFor(deps).hasUnconfirmed(request.taskId)) {
    return blocked([issue("unresolved-execution", "An earlier execution may still have a process. Reconcile Status before reviewing another launch; acknowledgement cannot release this protection.")]);
  }
  const task = tasks.get(request.taskId);
  const harness = harnesses.list().find((h) => h.id === request.harnessId);
  if (!task || !harness) return blocked([issue("task-or-harness-missing", "The task or harness disappeared while preparing.")]);
  const projectPath = preflight.canonicalProject.path;
  if (task.pipelineId) {
    return blocked([issue("pipeline-task", "This task runs a pipeline with its own step agents. An employee cannot be attributed to it here.")]);
  }
  if (hasOpenSupervisedProposal(projectPath, task.id)) {
    return blocked([issue("proposal-open", "A separate run proposal is open for this task. Dismiss or approve it first.")]);
  }

  let professional: import("../shared/execution/professional.ts").ProfessionalBinding;
  try { professional = resolveProfessionalBinding(db, preflight.employee.id, (deps.now ?? Date.now)()); }
  catch (error) { return blocked([issue("professional-invalid", (error as Error).message)]); }
  const config = employeeConfig(task, harness, request);
  if (deps.missionStage) {
    const problem = deps.missionStage.verify();
    if (problem) return blocked([issue("mission-revision", problem)]);
    if (config.mode !== deps.missionStage.mode) {
      // The exact Owner-approved internal mode is reviewed by runChecks below.
      config.mode = deps.missionStage.mode;
      config.profileId = null;
    }
  }
  let computerReview: Awaited<ReturnType<typeof prepareComputerWorkflowReview>>;
  try {
    computerReview = await prepareComputerWorkflowReview(task, harness, config.mode);
  } catch (error) {
    return blocked([issue("computer-workflow", (error as Error).message)]);
  }
  let autoPreparedWorkspaceId: string | null = null;
  const cleanupAutoPrepared = () => {
    if (autoPreparedWorkspaceId) abandonWorkspaceIfArmed(task.id, autoPreparedWorkspaceId);
  };
  const projectWorkingCopy = isWorkspaceDevelopmentEnabled(projectPath);
  if (grant) {
    const stagingIssue = await ensureTaskStagingGrant(task, projectPath, harness.kind, config.mode, grant, externalGit);
    if (stagingIssue) return blocked([stagingIssue]);
    const refreshed = prepareEmployeeExecution(body, deps.preflight);
    if (refreshed.assignment?.id !== preflight.assignment.id || refreshed.assignment?.revision !== preflight.assignment.revision
      || refreshed.canonicalProject?.path !== projectPath) {
      return blocked([issue("permission-scope", "The task assignment or project changed during staging. Review again.")]);
    }
    preflight = refreshed;
    if (preflight.outcome !== "prepared") return blocked();
  } else if (
    projectWorkingCopy
    && harness.kind === "codex"
    && config.mode === "auto"
    && (task.accessMode ?? "workspace") === "workspace"
    && !task.pipelineId
    && !task.worktreePath
  ) {
    const existingWs = getTaskWorkspace(task.id);
    if (!existingWs || existingWs.status === "abandoned" || existingWs.status === "published") {
      try {
        const preparedWs = await prepareTaskWorkspace(task.id, { writeScope: "working-copy" }, { approvedProjectPath: projectPath });
        autoPreparedWorkspaceId = preparedWs.id;
      } catch (error) {
        const message = error instanceof TaskWorkspaceError
          ? error.message
          : "The task working copy could not be prepared. Nothing was started in the project folder.";
        return blocked([issue("task-staging-refused", message)]);
      }
      const refreshed = prepareEmployeeExecution(body, deps.preflight);
      if (refreshed.assignment?.id !== preflight.assignment.id || refreshed.assignment?.revision !== preflight.assignment.revision
        || refreshed.canonicalProject?.path !== projectPath) {
        cleanupAutoPrepared();
        return blocked([issue("permission-scope", "The task assignment or project changed while preparing the working copy. Review again.")]);
      }
      preflight = refreshed;
      if (preflight.outcome !== "prepared") {
        cleanupAutoPrepared();
        return blocked();
      }
    }
  }
  const checked = await runChecks(projectPath, task, config, deps.exec ?? {});
  const errors = checked.checks.filter((c) => c.level === "error").map((c) => issue(c.code, c.message));
  if (errors.length > 0) {
    cleanupAutoPrepared();
    return blocked(errors);
  }

  const core = coreFor(deps);
  const now = (deps.now ?? Date.now)();
  const openWs = getTaskWorkspace(task.id);
  const effectiveWorkingCopy = projectWorkingCopy || (openWs?.status === "armed" && openWs.writeScope === "working-copy");
  const layout = await detectWorkspaceLayout(permissionSubject(task));
  const permission = describePermissions({
    kind: harness.kind,
    mode: config.mode,
    layout: layout.layout,
    predicted: layout.predicted,
    readScope: currentReadScope(),
    timeLimitSeconds: supervisedRunLimitSeconds(),
    workingCopy: effectiveWorkingCopy,
  });
  if (permission && (!permission.launchAllowed || !checked.resolved.permissionIdentity
    || workspacePermissionIdentity(permissionSubject(task), harness) !== checked.resolved.permissionIdentity
    || JSON.stringify(permission) !== JSON.stringify(checked.resolved.permission))) {
    cleanupAutoPrepared();
    return blocked([issue("permission-changed", "Workspace permissions changed or are Unknown. Review again.")]);
  }
  const prefs = loadExecutorPreferences();
  const extraWarnings: PreflightIssue[] = [];
  const taskMode = task.mode ?? null;
  if (prefs.requiredMode && config.mode === prefs.requiredMode && taskMode !== config.mode) {
    extraWarnings.push(issue("mode-set-by-preferences", `Your preferences require permission mode "${config.mode}"; the task was configured with "${taskMode ?? "the harness default"}". The task will be changed to this mode at start.`));
  }
  const facts: EmployeeRunReviewFacts = {
    resourceKey: resourceKey(harness),
    ...factsOf(preflight, checked, permission, extraWarnings),
    permissionIdentity: permission ? workspacePermissionIdentity(permissionSubject(task), harness) : null,
    routingPreferences: prefs,
    routingEvidenceKey: routingEvidenceKey(deps.preflight?.snapshot?.() ?? buildRoutingSnapshot(db)),
    workspaceDevelopment: projectWorkingCopy,
    ...(computerReview ? {
      computerWorkflow: computerReview.scope,
      computerWorkflowDocumentDigest: computerReview.documentDigest,
      computerWorkflowLockdownArgs: computerReview.lockdownArgs,
    } : {}),
    ...(openWs?.writeScope === "working-copy" ? {
      workingCopyWriteScope: "working-copy" as const,
      workingCopyScratchPath: openWs.scratchPath ?? null,
    } : {}),
    ...(autoPreparedWorkspaceId ? { autoPreparedWorkspaceId } : {}),
  };
  const { employee, assignment } = preflight;
  if (!employee || !assignment) {
    cleanupAutoPrepared();
    return blocked([issue("assignment-changed", "The assignment changed. Review again.")]);
  }
  const inputsKey = inputsKeyOf([
    task.id, projectPath, employee.id, assignment.id, assignment.revision, harness.id,
    request.model, request.effort, request.complexity, request.policy, config, checked.fingerprint,
    professional.kind === "professional" ? { ...professional, boundAt: 0 } : professional,
    checked.checks.filter((c) => c.level !== "info").map((c) => c.code),
    permission, workspacePermissionIdentity(permissionSubject(task), harness), prefs, facts.routingEvidenceKey,
    projectWorkingCopy, openWs?.writeScope ?? null, computerReview,
  ]);
  try {
    const { row, reused } = db.transaction(() => {
      const result = core.createOrReuse({
        id: (deps.newId ?? (() => crypto.randomUUID()))(),
        taskId: task.id,
        taskTitle: task.title,
        projectPath,
        employeeId: employee.id,
        employeeName: employee.name,
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        requestedHarnessId: harness.id,
        requestedModel: request.model,
        requestedEffort: request.effort,
        requestedComplexity: request.complexity,
        requestedPolicy: request.policy,
        requestedMode: config.mode,
        inputsKey,
        taskFingerprint: checked.fingerprint,
        configJson: JSON.stringify(config),
        reviewJson: JSON.stringify(facts),
        professionalJson: JSON.stringify(professional),
        usageNotice: checked.usageNotice,
        unconfirmedPrior: core.hasUnconfirmed(task.id),
        expiresAt: now + EMPLOYEE_REVIEW_VALID_MS,
      });
      try { verifyProfessionalBinding(db, result.row); }
      catch (error) { throw new EmployeeRunError((error as Error).message, 409, "professional-changed"); }
      return result;
    }).immediate();
    return {
      preflight: { ...preflight, outcome: "prepared", permission, blockingErrors: [] },
      attempt: core.view(row, null), blockingErrors: [], reused,
    };
  } catch (error) {
    if ((error as Error).message === "unresolved-execution") throw new EmployeeRunError("An earlier execution is unresolved. Reconcile it first.", 409, "unresolved-execution");
    if (/UNIQUE constraint failed: employee_executions\.task_id/i.test((error as Error).message)) {
      throw new EmployeeRunError("A start is already in progress for this task.", 409, "execution-starting");
    }
    throw error;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Start.
 * ────────────────────────────────────────────────────────────────────────── */

export interface StartOutcome {
  attempt: EmployeeRunView;
  /** True when this request found the start already claimed or finished; nothing new was launched. */
  replayed: boolean;
}

/** Everything that must still hold. Returns a reason to refuse, or null. Synchronous: safe inside a write transaction. */
function stillValid(row: EmployeeRunRow, deps: EmployeeRunDeps, inLaunch: boolean): string | null {
  const stageProblem = deps.missionStage?.verify();
  if (stageProblem) return stageProblem;
  if (deps.missionStage && row.requested_mode !== deps.missionStage.mode) return "Mission execution mode changed.";
  const preflight = prepareEmployeeExecution({
    taskId: row.task_id,
    harnessId: row.requested_harness_id,
    model: row.requested_model,
    effort: row.requested_effort,
    complexity: row.requested_complexity,
    policy: row.requested_policy,
    expectedAssignmentRevision: row.assignment_revision,
  }, { ...deps.preflight, ...(inLaunch ? { isStarting: () => false, isLive: () => false } : {}) });
  if (preflight.outcome !== "prepared") {
    const first = preflight.blockingErrors[0];
    return first ? `${first.message}` : "The preflight no longer passes.";
  }
  if (preflight.canonicalProject?.path !== row.project_path) return "The task is no longer in the project that was reviewed.";
  const lifecycle = checkProjectLaunchAdmission(row.project_path);
  if (!lifecycle.allowed) return lifecycle.reason;
  if (preflight.employee?.id !== row.employee_id) return "A different employee is assigned now.";
  if (preflight.assignment?.id !== row.assignment_id || preflight.assignment.revision !== row.assignment_revision) {
    return "The assignment changed since you reviewed it.";
  }
  const task = tasks.get(row.task_id);
  if (!task) return "The task no longer exists.";
  if (task.pipelineId) return "The task now runs a pipeline.";
  const scheduledRefusal = taskAvailabilityRefusal(row.task_id, (deps.now ?? taskAvailabilityNow)());
  if (scheduledRefusal) return scheduledRefusal.reason;
  const reviewed = JSON.parse(row.review_json) as EmployeeRunReviewFacts;
  if (task.computerWorkflowRevision || reviewed.computerWorkflow) {
    try {
      bindComputerWorkflow(task, reviewed.computerWorkflow && {
        scope: reviewed.computerWorkflow,
        documentDigest: reviewed.computerWorkflowDocumentDigest,
        lockdownArgs: reviewed.computerWorkflowLockdownArgs ?? [],
      });
    } catch (error) { return (error as Error).message; }
  }
  if (reviewed.resourceKey) {
    try { const h = harnesses.getByIdOrKind(row.requested_harness_id); if (!h || resourceKey(h) !== reviewed.resourceKey) return "Execution account or resource changed. Review again."; }
    catch { return "Execution account or resource is unavailable. No fallback."; }
  }
  if (reviewed.permission && (!reviewed.permissionIdentity || workspacePermissionIdentity(permissionSubject(task), harnesses.getByIdOrKind(row.requested_harness_id) ?? undefined) !== reviewed.permissionIdentity)) return "Workspace permissions changed or are Unknown. Review again.";
  if (reviewed.workspaceDevelopment !== undefined && Boolean(reviewed.workspaceDevelopment) !== isWorkspaceDevelopmentEnabled(row.project_path)) {
    return "Project workspace development setting changed since you reviewed this run. Review again.";
  }
  if (reviewed.accessDiagnostics && (task.accessMode ?? "workspace") !== reviewed.accessDiagnostics.accessMode) return "Access mode changed. Review again.";
  if (reviewed.routingEvidenceKey && reviewed.routingEvidenceKey !== routingEvidenceKey(deps.preflight?.snapshot?.() ?? buildRoutingSnapshot(db))) return "Account or quota evidence changed. Review again.";
  if (reviewed.routingPreferences && JSON.stringify(loadExecutorPreferences()) !== JSON.stringify(reviewed.routingPreferences)) return "Routing preferences changed. Review again.";
  // launchApproved verifies the applied task fingerprint separately after configuration.
  if (!inLaunch && taskFingerprint(task) !== row.task_fingerprint) return "The task changed since you reviewed it.";
  try { verifyProfessionalBinding(db, row); }
  catch (error) { return (error as Error).message; }
  return null;
}

const CODE_BY_STATUS: Record<string, string> = {
  expired: "approval-expired",
  superseded: "approval-superseded",
  cancelled: "approval-cancelled",
  rejected: "approval-rejected",
  "start-failed": "start-failed",
};

/**
 * The owner's confirmation. Idempotent: repeating it for a start that was
 * already claimed returns that attempt and launches nothing.
 */
export async function startEmployeeExecution(id: string, raw: unknown, deps: EmployeeRunDeps = {}): Promise<StartOutcome> {
  let request;
  try {
    request = parseStartRequest(raw);
  } catch (message) {
    throw new EmployeeRunError(typeof message === "string" ? message : "Invalid request.", 400, "invalid");
  }
  const core = coreFor(deps);
  const first = core.get(id);
  if (!first) throw new EmployeeRunError("Employee execution not found.", 404, "not-found");
  if (objectiveTaskIsManaged(first.task_id) && (!deps.missionStage || !objectiveTaskOperation(first.task_id, id))) {
    throw new EmployeeRunError("Confirm this launch from the mission.", 409, "mission-launch");
  }
  let row = settle(core, first);
  const view = () => core.view(settle(core, core.get(id) ?? row), runStatusOf(core.get(id) ?? row));

  // A repeat of an already claimed or finished start: same attempt, no second launch.
  if (row.status === "starting" || row.status === "started" || row.status === "indeterminate") {
    return { attempt: view(), replayed: true };
  }
  if (row.status !== "awaiting-approval") {
    throw new EmployeeRunError(
      row.status === "start-failed" ? "That start already failed. Review the run again." : `This review is ${row.status}. Review the run again.`,
      409, CODE_BY_STATUS[row.status] ?? "attempt-closed", { attempt: view() },
    );
  }
  if (request.revision !== row.revision) {
    throw new EmployeeRunError("The review changed since you opened it. Review it again.", 409, "attempt-changed", { attempt: view() });
  }
  const lifecycle = checkProjectLaunchAdmission(row.project_path);
  if (!lifecycle.allowed) {
    throw new EmployeeRunError(lifecycle.reason!, 409, "project-lifecycle", { attempt: view() });
  }
  if ((JSON.parse(row.review_json) as EmployeeRunReviewFacts).permission?.sandbox === "danger-full-access" && !request.acknowledgeFullAccess) {
    throw new EmployeeRunError("Explicit full-access acknowledgement is required.", 400, "full-access-ack-required", { attempt: view() });
  }
  if (request.orchestratedWorkflowId) {
    const { validateOrchestratedEmployeeStart } = await import("./pm-orchestrated-workflow.ts");
    validateOrchestratedEmployeeStart(request.orchestratedWorkflowId, id, row.task_id);
  } else if (row.usage_notice && !request.acknowledgeUsage) {
    throw new EmployeeRunError("This agent may bill per request. Confirm the usage notice to run.", 400, "usage-ack-required", { attempt: view() });
  }
  if (core.hasUnconfirmed(row.task_id, row.id)) {
    throw new EmployeeRunError("An earlier process may still exist. Acknowledgement is not proof that it stopped. Reconcile the earlier attempt first.", 409, "unresolved-execution", { attempt: view() });
  }

  // Validate and claim in one write transaction. No await, no spawn inside it.
  const executionId = (deps.newId ?? (() => crypto.randomUUID()))();
  const claim = core.claim(id, request.revision, executionId, (current) =>
    core.hasUnconfirmed(current.task_id, current.id) ? "An earlier execution is unresolved. Reconcile it first." : stillValid(current, deps, false));
  if (!claim.ok) {
    if (claim.reason === "not-open" && claim.row && (claim.row.status === "starting" || claim.row.status === "started")) {
      // Lost the race to an identical confirmation: report it, launch nothing.
      return { attempt: view(), replayed: true };
    }
    if ((claim.reason === "invalid" || claim.reason === "expired") && claim.row) {
      abandonAutoPreparedFromRow(claim.row);
    }
    const scheduledFailure = claim.reason === "invalid" && Boolean(claim.problem?.includes("Waiting for scheduled time"));
    const code = scheduledFailure
      ? "scheduled-not-yet-available"
      : claim.reason === "invalid" ? "approval-rejected" : claim.reason === "expired" ? "approval-expired" : claim.reason === "revision" ? "attempt-changed" : "attempt-closed";
    const message = claim.reason === "invalid"
      ? `Nothing was started. ${claim.problem} Review the run again.`
      : claim.reason === "expired" ? "This review expired. Review the run again."
        : claim.reason === "revision" ? "The review changed since you opened it. Review it again."
          : "This review can no longer be confirmed. Review the run again.";
    throw new EmployeeRunError(message, 409, code, { attempt: view() });
  }
  row = claim.row;
  activeClaims.add(id);
  let ownerLaunchGrantId: string | undefined;
  try {
    await deps.afterClaim?.();
    const postClaimScheduled = taskAvailabilityRefusal(row.task_id, (deps.now ?? taskAvailabilityNow)());
    if (postClaimScheduled) {
      core.settleStart(row.id, "rejected", capText(`Nothing was started. ${postClaimScheduled.reason}`, 500));
      abandonAutoPreparedFromRow(row);
      throw new EmployeeRunError(postClaimScheduled.reason, 409, postClaimScheduled.code, { attempt: view() });
    }
    if (isProductionOwnerGateActive() || deps.ownerProof !== undefined) {
      const currentTask = tasks.get(row.task_id);
      if (!currentTask) {
        core.settleStart(row.id, "rejected", "Nothing was started. Task not found.");
        throw new EmployeeRunError("Task not found.", 404, "not-found", { attempt: view() });
      }
      const config = JSON.parse(row.config_json) as ExecutionConfig;
      const reviewFacts = JSON.parse(row.review_json) as EmployeeRunReviewFacts;
      const built = buildEmployeeAttemptOperation({
        attempt: row,
        task: currentTask,
        config,
        reviewFacts,
        now: core.now(),
      });
      if (!built.ok) {
        core.settleStart(row.id, "rejected", capText(`Nothing was started. ${built.reason}`, 500));
        abandonAutoPreparedFromRow(row);
        throw new EmployeeRunError(built.reason, 409, built.code, { attempt: view() });
      }
      const auth = await authorizeSupervisedLaunch({
        built: built.built,
        proofOverride: deps.ownerProof,
        locale: deps.ownerLocale ?? "en",
        ...(deps.handsoffLaunch ? { projectGrant: deps.handsoffLaunch } : {}),
      });
      if (!auth.ok) {
        core.settleStart(row.id, "rejected", capText(`Nothing was started. ${auth.reason}`, 500));
        abandonAutoPreparedFromRow(row);
        const status = auth.code === "owner-not-enrolled" || auth.code === "owner-revoked" || auth.code === "owner-restored-inactive"
          ? 409
          : 403;
        throw new EmployeeRunError(auth.reason, status, auth.code, { attempt: view() });
      }
      ownerLaunchGrantId = auth.grantId;
    }
    return {
      attempt: await launch(core, row, request.acknowledgeUsage || !!request.orchestratedWorkflowId, deps, request.orchestratedWorkflowId, ownerLaunchGrantId),
      replayed: false,
    };
  } finally {
    discardUnconsumedLaunchTicket(ownerLaunchGrantId);
    activeClaims.delete(id);
  }
}

async function launch(core: EmployeeRunCore, row: EmployeeRunRow, acknowledgeUsage: boolean, deps: EmployeeRunDeps, orchestratedWorkflowId?: string, ownerLaunchGrantId?: string): Promise<EmployeeRunView> {
  const config = JSON.parse(row.config_json) as ExecutionConfig;
  const seen = new Set((JSON.parse(row.review_json) as EmployeeRunReviewFacts).checks.map((c) => c.code));
  const done = (updated: EmployeeRunRow | null) => {
    const current = updated ?? core.get(row.id)!;
    return core.view(syncFinish(core, current), runStatusOf(current));
  };
  const adopt = (reason: string | null): EmployeeRunRow | null => {
    const found = confirmedRun(core.get(row.id) ?? row);
    return found ? core.markStarted(row.id, { runId: found.id, startedAt: found.startedAt, actualHarnessId: found.agent, reason }) : null;
  };

  let outcome: Awaited<ReturnType<typeof launchEmployeeTask>>;
  try {
    outcome = await (deps.launch ?? launchEmployeeTask)({
      projectPath: row.project_path,
      taskId: row.task_id,
      batchId: "",
      batchTitle: "",
      executionId: row.execution_id!,
      employeeRunId: row.id,
      employeeName: row.employee_name,
      config,
      ...(ownerLaunchGrantId ? { ownerLaunchGrantId } : {}),
      expectFingerprint: row.task_fingerprint,
      fingerprintOf: taskFingerprint,
      onRunRecorded: deps.missionStage?.onRunRecorded ?? (orchestratedWorkflowId ? (runId) => {
        const w = getWorkflow(orchestratedWorkflowId);
        if (w) noteOrchestratedLaunchCommitted(w, "implementation", runId);
      } : undefined),
      authorizeSubmission: deps.missionStage ? () => deps.missionStage!.verify() === null : orchestratedWorkflowId ? () => {
        const w = getWorkflow(orchestratedWorkflowId);
        if (w?.grant.requireTaskWorkspace) {
          const open = getTaskWorkspace(w.taskId);
          const prepared = !!open && (open.status === "armed" || (open.status === "executing" && !!open.developerRunId));
          if (!prepared) return false;
        }
        return !!w && w.status === "active" && (w.grant.expiresAt == null || Date.now() < w.grant.expiresAt) && w.counters.launchesUsed <= w.grant.maxLaunches && !workflowResourceBlock(w.grant);
      } : undefined,
      verify: (checked, task) => {
        if (orchestratedWorkflowId) {
          try { validateOrchestratedEmployeeStart(orchestratedWorkflowId, row.id, row.task_id); }
          catch (e) { return { code: "grant-changed", reason: (e as Error).message }; }
        }
        const unseen = checked.checks.filter((c) => c.level !== "info" && !seen.has(c.code));
        if (unseen.length > 0) return { code: "checks-changed", reason: `Something changed since you reviewed this run: ${unseen[0]!.message}` };
        if (checked.usageNotice && !acknowledgeUsage) return { code: "usage-ack-required", reason: "This agent may bill per request and the notice was not confirmed." };
        const problem = stillValid(core.get(row.id) ?? row, deps, true);
        return problem ? { code: "employee-state-changed", reason: problem } : null;
      },
    }, deps.exec ?? {});
  } catch (error) {
    // Anything thrown here happened somewhere between claiming and knowing.
    // Do not retry; keep the claim's facts and ask for a human look.
    const adopted = adopt("A run was found after an error while starting.");
    if (adopted?.status === "started") return done(adopted);
    return done(core.settleStart(row.id, "indeterminate", "The start ended with an error and its outcome is not confirmed. The process may still exist."));
  }

  switch (outcome.kind) {
    case "started": {
      const runId = outcome.runId ?? adopt(null)?.run_id ?? null;
      if (!runId) {
        return done(core.settleStart(row.id, "indeterminate", "The runtime reported a start but no run was recorded. Check the task before running again."));
      }
      const run = runs.get(runId);
      if (!run || run.taskId !== row.task_id) return done(core.settleStart(row.id, "indeterminate", "The reported run cannot be verified for this task."));
      return done(core.markStarted(row.id, { runId, startedAt: run.startedAt, actualHarnessId: run.agent }));
    }
    case "held":
      return done(core.settleStart(row.id, "rejected", capText(`Nothing was started. ${outcome.reason}`, 500)));
    case "busy":
      return done(core.settleStart(row.id, "rejected", capText(`Nothing was started. ${outcome.reason}`, 500)));
    case "start-failed": {
      // A run row that exists after a failed start may still be alive. Link it; do not claim "not started".
      const found = confirmedRun(core.get(row.id) ?? row);
      if (found) return done(core.markStarted(row.id, { runId: found.id, startedAt: found.startedAt, actualHarnessId: found.agent }));
      return done(core.settleStart(row.id, "start-failed", capText(redactSecrets(outcome.error), 500)));
    }
  }
}

/** The owner withdraws a review. Only a review that was not confirmed. */
export function cancelEmployeeExecution(id: string, raw: unknown, deps: EmployeeRunDeps = {}): EmployeeRunView {
  let request;
  try {
    request = parseCancelRequest(raw);
  } catch (message) {
    throw new EmployeeRunError(typeof message === "string" ? message : "Invalid request.", 400, "invalid");
  }
  const core = coreFor(deps);
  const row = core.get(id);
  if (!row) throw new EmployeeRunError("Employee execution not found.", 404, "not-found");
  const next = row.status === "awaiting-approval" ? core.cancel(id, request.revision) : row;
  if (!next || (next.status !== "cancelled" && next.status !== "expired" && next.status !== "superseded")) {
    throw new EmployeeRunError("This run was already confirmed or has changed. It cannot be withdrawn here.", 409, "attempt-closed", { attempt: viewOf(core, next ?? row) });
  }
  abandonAutoPreparedFromRow(next);
  return viewOf(core, next);
}

export const __testing = {
  activeClaims,
  reset(): void {
    activeClaims.clear();
  },
};
