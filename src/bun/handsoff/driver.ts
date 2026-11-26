/**
 * Hands-off project execution ("Work independently"): the one driver that carries a deliberately submitted task
 * through its normal lifecycle without a click per step.
 *
 *   queued -> developing -> testing -> reviewing -> (fixing -> developing ...) -> applying -> finished
 *
 * It owns no runtime. Every step calls the service that already performs it: the assignment core, the employee
 * run (review + start), the offline test authorization, the QC review, the scoped publication and the Done
 * transition. What the driver adds is the decision that a step is covered by the Owner's stored policy.
 *
 * Rules that hold for every step:
 *  - `step()` reads the real records (task, runs, workspace, review) and decides from them. Memory is a hint, so
 *    a restart, a repeated tick or a second wake-up cannot replay a finished action.
 *  - One unfinished run per task (unique index) and one in-flight drive per run (in-process chain).
 *  - Emergency Stop and the project lifecycle are checked before every launch. Stop never resumes by itself.
 *  - A refusal is a stored blocker with one action, never a retry loop.
 */
import { db, projects, runs, taskQualityReviews, taskScheduling, tasks } from "../db.ts";
import { AssignmentCore } from "../assignment-core.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { storePracticalReworkBrief } from "../autonomy/observed-test.ts";
import { EmployeeRunCore } from "../employee-run-core.ts";
import { cancelEmployeeExecution, EmployeeRunError, reviewEmployeeExecution, startEmployeeExecution, type EmployeeRunDeps } from "../employee-run.ts";
import { missionAccountLimit } from "../orchestration/mission-resource.ts";
import { cancelRun, defaultEffortFor, isTaskRunLive, moveTaskColumn, subscribeGlobal } from "../orchestrator.ts";
import { isProductionOwnerGateActive } from "../owner-trust/launch-gate.ts";
import { authorizationView } from "./authorization.ts";
import { ProjectPermissionError, requestPolicyCoveredTest } from "../project-permissions.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { ownerProjectOf, taskInProject, verifyLaunchScope } from "../project-ownership.ts";
import { isWorkspaceDevelopmentEnabled } from "../project-permissions.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { acceptAuthorizedTaskDone, cancelPendingQcReview, prepareQcReview, startQcReview } from "../task-quality-control.ts";
import { getTaskWorkspace, publishTaskWorkspace, rearmSettledWorkspace, abandonTaskWorkspace, TaskWorkspaceError } from "../task-workspace.ts";
import { classifyLaunchFailure, classifyReviewFailure } from "../../shared/practical-cycle.ts";
import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
import { QC_LIMITS } from "../../shared/task-quality-control.ts";
import {
  effectiveHandsoffPolicy,
  fixDecision,
  HANDSOFF_LIMITS,
  isHandsoffTerminal,
  normalizeFindings,
  textFingerprint,
  type HandsoffActionKind,
  type HandsoffBlocker,
  type HandsoffBlockerCode,
  type HandsoffChange,
  type HandsoffEventKind,
  type HandsoffPolicy,
  type HandsoffResult,
  type HandsoffRun,
  type HandsoffStage,
  type HandsoffState,
  type HandsoffStatus,
  type HandsoffTestState,
} from "../../shared/handsoff.ts";
import type { Task } from "../../shared/types.ts";
import { chooseResource, accountKey, type ChosenResource } from "./resources.ts";
import { renderStagedEvidence, stagingFingerprint } from "./evidence.ts";
import { HandsoffError } from "./errors.ts";
import { handsoffStore } from "./store.ts";
import {
  buildSmartQueueOverview,
  busyDeveloperEmployeeIds,
  busyReviewerEmployeeIds,
  evaluateProjectQueue,
  isDeveloperWorker,
  isReviewerWorker,
  projectTeam,
} from "./queue.ts";
import { onSmartQueueChange } from "./queue-events.ts";
import { onTaskAvailabilityChange, taskAvailabilityFor, taskAvailabilityNow } from "../task-availability.ts";

type Next = "idle" | "now" | { afterMs: number };

export interface HandsoffDeps {
  now?: () => number;
  run?: EmployeeRunDeps;
  /** Test seam: runs right after a correction round is recorded, before the next Developer launch. */
  onFix?: (taskId: string, round: number) => void;
  /** Test seam: runs right before the reviewed change is applied (a local edit can be made here). */
  beforeApply?: (taskId: string) => void;
  /** Test seam: replaces the provider-limit lookup. */
  accountLimit?: typeof missionAccountLimit;
}
let deps: HandsoffDeps = {};
/** Test seam only: a fixed clock and the employee-run deps used by every launch. */
export function setHandsoffDepsForTest(next: HandsoffDeps | null): void { deps = next ?? {}; }
const nowMs = () => deps.now?.() ?? taskAvailabilityNow();

/* ---------------------------------------------------------------------------------------------- bookkeeping */

function announce(run: Pick<HandsoffRun, "projectPath" | "taskId" | "id">, status: string): void {
  try { broadcastAppEvent({ type: "handsoff", projectPath: run.projectPath, taskId: run.taskId, runId: run.id, status, ts: nowMs() }); } catch { /* the next read catches up */ }
}

function note(run: HandsoffRun, kind: HandsoffEventKind, message: string, detail: Record<string, unknown> = {}): void {
  handsoffStore.appendEvent(run, kind, message, detail, nowMs());
}

function save(run: HandsoffRun, patch: Parameters<typeof handsoffStore.updateRun>[1]): HandsoffRun {
  const next = handsoffStore.updateRun(run.id, { ...patch, now: nowMs() });
  announce(next, next.status);
  return next;
}

const workerDetail = (ref: HandsoffState["developer"]) => ref ? { employeeName: ref.employeeName, harnessId: ref.harnessId, accountId: ref.accountId, modelId: ref.modelId } : {};

function block(run: HandsoffRun, code: HandsoffBlockerCode, message: string, action: HandsoffActionKind, extra: Partial<HandsoffState> = {}): Next {
  const blocker: HandsoffBlocker = { code, message, action, at: nowMs() };
  const same = run.status === "needs-owner" && run.blocker?.code === code && run.blocker.message === message;
  const next = save(run, { status: "needs-owner", blocker, state: { ...run.state, ...extra, waitUntil: null, waitReason: null, waitKind: null } });
  if (!same) note(next, "needs-owner", message, { code });
  return "idle";
}

function waitFor(run: HandsoffRun, reason: string, until: number | null = null, kind: HandsoffState["waitKind"] = null): Next {
  const changed = run.status !== "waiting" || run.state.waitReason !== reason || run.state.waitUntil !== until || (run.state.waitKind ?? null) !== (kind ?? null);
  const next = save(run, { status: "waiting", blocker: null, state: { ...run.state, waitUntil: until, waitReason: reason, waitKind: kind ?? null } });
  if (changed) note(next, "waiting", reason, until ? { until, ...(kind ? { waitKind: kind } : {}) } : {});
  return until && until > nowMs() ? { afterMs: Math.min(until - nowMs(), 60_000) } : "idle";
}

function resumeActive(run: HandsoffRun): HandsoffRun {
  if (run.status === "active" && !run.blocker && run.state.waitReason == null && !run.state.waitKind) return run;
  return save(run, { status: "active", blocker: null, state: { ...run.state, waitUntil: null, waitReason: null, waitKind: null } });
}

function stop(run: HandsoffRun, message: string): Next {
  if (run.status === "stopped") return "idle";
  const next = save(run, { status: "stopped", blocker: null });
  note(next, "stopped", message);
  return "idle";
}

function finish(run: HandsoffRun, status: Extract<HandsoffStatus, "done" | "ready-to-apply" | "awaiting-accept" | "failed" | "cancelled">, message: string, result?: HandsoffResult | null): Next {
  const kind: HandsoffEventKind = status === "done" ? "done" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "ready-to-apply";
  const next = save(run, { stage: "finished", status, blocker: null, finishedAt: nowMs(), ...(result !== undefined ? { result } : {}) });
  note(next, kind, message, workerDetail(next.state.developer));
  // Immediately reconsider queued work in this project now that a slot/worker was freed.
  void scheduleProject(next.projectPath);
  return "idle";
}

const advanceStage = (run: HandsoffRun, stage: HandsoffStage, state: HandsoffState = run.state): HandsoffRun => save(run, { stage, status: "active", blocker: null, state: { ...state, waitUntil: null, waitReason: null, waitKind: null } });

/* ------------------------------------------------------------------------------------------------ facts */

function currentPolicy(run: HandsoffRun): HandsoffPolicy {
  return effectiveHandsoffPolicy(run.policy, handsoffStore.getPolicy(run.projectPath)?.policy ?? null);
}

function team(projectPath: string) {
  return db.query<{ id: string; name: string; role_category: string; job_title: string }, [string]>(
    `SELECT id, name, role_category, job_title FROM ai_employees
       WHERE kind = 'worker' AND status = 'active' AND archived_at IS NULL AND project_path = ? ORDER BY created_at, id LIMIT 30`,
  ).all(projectPath);
}
const isDeveloper = (m: { role_category: string; job_title: string }) => ["engineering", "architecture"].includes(m.role_category) || /developer|engineer|разработчик/i.test(m.job_title);
const isReviewer = (m: { role_category: string; job_title: string }) => m.role_category === "quality" || /reviewer|ревьюер/i.test(m.job_title);

/** A dependent task starts only when every prerequisite is genuinely Done. A review or a patch is not Done. */
function dependencyHold(taskId: string): { kind: "wait" | "block"; reason: string } | null {
  for (const id of taskScheduling.dependenciesOf(taskId)) {
    const dependency = tasks.get(id);
    if (!dependency) return { kind: "block", reason: "A prerequisite task no longer exists. Clear or replace that dependency before this task can start." };
    if (dependency.column !== "done") return { kind: "wait", reason: `Waiting for "${dependency.title}" to be done.` };
  }
  return null;
}

function openDriven(projectPath: string, exceptId: string, stages: HandsoffStage[]): number {
  return handsoffStore.listOpenRuns(projectPath).filter((other) => other.id !== exceptId && other.status === "active" && stages.includes(other.stage)).length;
}

function workspaceChanges(taskId: string): { changes: HandsoffChange[]; paths: string[]; status: string | null; violation: boolean } {
  const ws = getTaskWorkspace(taskId);
  if (!ws) return { changes: [], paths: [], status: null, violation: false };
  const live = ws.changes.filter((change) => change.scope === "output" && change.kind !== "unchanged");
  return { changes: live.map((c) => ({ path: c.path, kind: c.kind })), paths: live.map((c) => c.path), status: ws.status, violation: ws.violation };
}

function resultOf(run: HandsoffRun, delivery: HandsoffResult["delivery"], appliedPaths: string[] = []): HandsoffResult {
  const { changes } = workspaceChanges(run.taskId);
  return {
    changedFiles: changes,
    delivery,
    appliedPaths,
    tests: run.state.tests,
    review: run.state.review,
    fixRounds: run.round,
    developer: run.state.developer,
    reviewer: run.state.reviewer,
  };
}

const reasonText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * On a build that asks for a device confirmation per provider launch, hands-off work runs only inside the project's
 * Owner authorization. This reads that state; it never prompts. Absent or stale authorization is one project-level blocker.
 */
function authorizationBlock(run: HandsoffRun): Next | null {
  if (!isProductionOwnerGateActive()) return null;
  const view = authorizationView(run.projectPath);
  if (view.state === "active" || view.state === "not-required") return null;
  const code: HandsoffBlockerCode = view.state === "expired" ? "authorization-expired"
    : view.state === "exhausted" ? "authorization-exhausted"
      : view.state === "needs-renewal" ? "authorization-renewal"
        : view.state === "revoked" ? "authorization-revoked" : "authorization-missing";
  const detail = view.state === "needs-renewal" ? ` It no longer covers: ${view.reasons.join(", ")}.` : "";
  return block(run, code, `This project's hands-off authorization is ${view.state === "off" ? "off" : view.state}.${detail} Nothing was started. Authorize it in the project's settings.`, "open-settings");
}

/** An error thrown by the start path that is really an authorization refusal becomes the project-level blocker. */
function authorizationRefusal(run: HandsoffRun, error: unknown): Next | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !(code.startsWith("handsoff-authorization-") || code === "owner-emergency-stop" || code === "owner-project-paused" || code === "owner-envelope" || code === "owner-sandbox" || code === "owner-privileged-excluded" || code === "owner-task-stale" || code === "owner-operation-mismatch")) return null;
  if (code === "owner-emergency-stop") return stop(run, "Emergency Stop is active. Nothing new will start.");
  if (code === "owner-project-paused") return waitFor(run, reasonText(error));
  const mapped: HandsoffBlockerCode = code === "handsoff-authorization-expired" ? "authorization-expired"
    : code === "handsoff-authorization-exhausted" ? "authorization-exhausted"
      : code === "handsoff-authorization-renewal" ? "authorization-renewal"
        : code === "handsoff-authorization-revoked" ? "authorization-revoked"
          : code === "handsoff-authorization-missing" || code === "handsoff-authorization-not-authorized" ? "authorization-missing" : "authorization-renewal";
  return block(run, mapped, `${reasonText(error)} Nothing was started.`, "open-settings");
}

/* ------------------------------------------------------------------------------------------- stage: queued */

async function launchDeveloper(run: HandsoffRun, task: Task, policy: HandsoffPolicy, preferredDeveloperId: string | null = null): Promise<Next> {
  const project = run.projectPath;
  const admission = checkProjectLaunchAdmission(project);
  if (!admission.allowed) return waitFor(run, admission.reason ?? "The project is stopped. Nothing was started.", null, "project-paused");
  const availability = taskAvailabilityFor(task, nowMs());
  if (!availability.available) {
    return waitFor(run, "Waiting for scheduled time.", availability.availableFromMs, "scheduled");
  }
  if (!isWorkspaceDevelopmentEnabled(project)) {
    return block(run, "workspace-off", "Development in a working copy is off for this project, so a Developer cannot work in an isolated copy. Nothing was started.", "open-settings");
  }
  const unauthorized = authorizationBlock(run);
  if (unauthorized) return unauthorized;
  const scope = verifyLaunchScope(task, project);
  if (!scope.ok) return block(run, "launch-refused", `${scope.reason ?? "The task is outside this project."} Nothing was started.`, "open-task");
  const hold = dependencyHold(task.id);
  if (hold) return hold.kind === "wait" ? waitFor(run, hold.reason, null, "dependency") : block(run, "launch-refused", hold.reason, "open-task");
  if (openDriven(project, run.id, ["developing", "reviewing"]) >= policy.maxParallel) return waitFor(run, "Waiting for a free slot in this project.", null, "slot");
  // Reconcile an unknown earlier launch before anything else is attempted.
  if (run.state.launchIntent?.kind === "developer" && !run.state.developerRunId) {
    const adopted = runs.listForTask(task.id).find((candidate) => !candidate.qcReviewId && candidate.startedAt >= run.state.launchIntent!.at - 2000);
    if (adopted) {
      const state = { ...run.state, developerRunId: adopted.id, launchIntent: null };
      note(run, "developer-started", "Adopted the Developer run that an interrupted launch had already started.", { runId: adopted.id });
      advanceStage(run, "developing", state);
      return "now";
    }
    if (new EmployeeRunCore(db, nowMs).hasUnconfirmed(task.id)) {
      return block(run, "unconfirmed-launch", "An earlier Developer launch may still have a process. Its outcome is unknown, so nothing was launched again.", "open-task");
    }
    run = save(run, { state: { ...run.state, launchIntent: null } });
  }
  // Assignment: an explicit worker is kept (and waited on if currently busy); otherwise pick an idle Developer.
  const assignments = new AssignmentCore(db);
  let assignment = assignments.forTask(task.id);
  const busyDevs = busyDeveloperEmployeeIds(project, undefined, run.id);
  if (assignment) {
    if (busyDevs.has(assignment.employeeId)) {
      return waitFor(run, "Waiting for an available worker.", null, "worker");
    }
  } else {
    if (!policy.autoAssign) return block(run, "no-worker", "The task has no assigned worker and the policy does not choose one.", "open-task");
    const developers = projectTeam(project).filter(isDeveloperWorker);
    if (developers.length === 0) return block(run, "no-worker", "This project has no active Developer on its team. Add one or assign a worker.", "open-task");
    const preferred = preferredDeveloperId ? developers.find((d) => d.id === preferredDeveloperId && !busyDevs.has(d.id)) : null;
    const developer = preferred ?? developers.find((d) => !busyDevs.has(d.id));
    if (!developer) return waitFor(run, "Waiting for an available worker.", null, "worker");
    try {
      assignment = assignments.assign(task.id, developer.id).assignment;
      note(run, "assigned", `Assigned ${developer.name}.`, { employeeName: developer.name });
    } catch (error) {
      return block(run, "no-worker", `The worker could not be assigned: ${reasonText(error)}`, "open-task");
    }
  }
  const chosen = chooseResource({ taskId: task.id, projectPath: project, title: task.title, role: "developer", policy, requested: run.state.requested });
  if (!chosen.ok) return block(run, "no-resource", chosen.message, "open-settings");
  const limited = limitWait(run, chosen.resource, "developer");
  if (limited) return limited;

  const review = await reviewEmployeeExecution({ taskId: task.id, harnessId: chosen.resource.harnessId, model: chosen.resource.modelId }, deps.run ?? {});
  const attempt = review.attempt;
  if (!attempt) {
    const first = review.blockingErrors[0];
    if (first?.code === "scheduled-not-yet-available") {
      const freshAvail = taskAvailabilityFor(tasks.get(task.id) ?? task, nowMs());
      return waitFor(run, "Waiting for scheduled time.", freshAvail.availableFromMs, "scheduled");
    }
    if (first?.code === "unresolved-execution") return block(run, "unconfirmed-launch", first.message, "open-task");
    if (first?.code === "execution-starting") return waitFor(run, "Another start for this task is still in progress.");
    return block(run, "launch-refused", `${first?.message ?? "The Developer run could not be prepared."} Nothing was started.`, "open-task");
  }
  const refuseAttempt = (code: HandsoffBlockerCode, message: string, action: HandsoffActionKind): Next => {
    try { cancelEmployeeExecution(attempt.id, { revision: attempt.revision }, deps.run ?? {}); } catch { /* already closed */ }
    return block(run, code, message, action);
  };
  if (attempt.review.workingCopyWriteScope !== "working-copy") {
    return refuseAttempt("workspace-off", "The reviewed run would not use an isolated working copy. Nothing was started in the project folder.", "open-settings");
  }
  if (attempt.requested.mode !== chosen.resource.mode) {
    return refuseAttempt("launch-refused", `The reviewed mode "${attempt.requested.mode}" differs from the covered mode. Nothing was started.`, "open-task");
  }
  if (attempt.usageNotice && !policy.acknowledgeUsageNotice) {
    return refuseAttempt("usage-notice", `${attempt.usageNotice} Allow agents that may bill per request in the project's Work independently settings to continue.`, "open-settings");
  }
  const intended = save(run, { state: { ...run.state, launchIntent: { kind: "developer", at: nowMs() }, launchAttempts: run.state.launchAttempts + 1 } });
  let started: Awaited<ReturnType<typeof startEmployeeExecution>>;
  try {
    started = await startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true, acknowledgeUsage: Boolean(attempt.usageNotice) && policy.acknowledgeUsageNotice }, {
      ...(deps.run ?? {}),
      handsoffLaunch: { handsoffRunId: intended.id, round: intended.round, intentAt: intended.state.launchIntent!.at },
    });
  } catch (error) {
    const rolledBack = save(intended, { state: { ...intended.state, launchIntent: null, launchAttempts: Math.max(0, intended.state.launchAttempts - 1) } });
    if ((error as { code?: unknown } | null)?.code === "scheduled-not-yet-available") {
      const freshAvail = taskAvailabilityFor(tasks.get(task.id) ?? task, nowMs());
      return waitFor(rolledBack, "Waiting for scheduled time.", freshAvail.availableFromMs, "scheduled");
    }
    const refused = authorizationRefusal(rolledBack, error);
    if (refused) return refused;
    const unknown = !(error instanceof EmployeeRunError);
    return launchFailed(intended, reasonText(error), unknown);
  }
  const view = started.attempt;
  if (view.status !== "started" || !view.runId) {
    return launchFailed(intended, view.reason ?? `The start ended as ${view.status}.`, view.status === "indeterminate");
  }
  const employeeName = view.employee.name;
  const developer = { employeeId: view.employee.id, employeeName, harnessId: view.actual.harnessId ?? chosen.resource.harnessId, modelId: view.actual.model ?? chosen.resource.modelId, accountId: view.actual.accountId ?? chosen.resource.accountId };
  const state: HandsoffState = { ...intended.state, developerRunId: view.runId, launchIntent: null, testDone: false, testAuthorizationId: null, evidenceFingerprint: null, reviewId: null, developer };
  const advanced = advanceStage(intended, run.round > 0 ? "developing" : "developing", state);
  note(advanced, run.round > 0 ? "fix-started" : "developer-started", `${employeeName} started working in an isolated working copy.`, { ...workerDetail(developer), runId: view.runId, round: run.round });
  return "idle";
}

function launchFailed(run: HandsoffRun, reason: string, unknownOutcome: boolean): Next {
  if (unknownOutcome && new EmployeeRunCore(db, nowMs).hasUnconfirmed(run.taskId)) {
    return block(run, "unconfirmed-launch", `The Developer launch has an unknown outcome (${reason}). Nothing was launched again.`, "open-task");
  }
  const kind = classifyLaunchFailure(reason);
  if (kind === "provider_failure" && run.state.launchAttempts < HANDSOFF_LIMITS.maxLaunchAttempts) {
    const until = nowMs() + HANDSOFF_LIMITS.retryBackoffMs * run.state.launchAttempts;
    return waitFor(save(run, { state: { ...run.state, launchIntent: null } }), "The provider refused the launch. Trying again shortly.", until);
  }
  const cleared = save(run, { state: { ...run.state, launchIntent: null } });
  if (kind === "account_unavailable" || kind === "model_unavailable" || kind === "provider_failure" || kind === "expired_grant") {
    return block(cleared, "provider-refused", `The provider or account refused the launch: ${reason}`, "open-accounts");
  }
  return block(cleared, "launch-refused", `The Developer could not be started: ${reason}`, "open-task");
}

/** A known provider limit is a wait; an unknown reset time needs the Owner to choose. Never a retry loop. */
function limitWait(run: HandsoffRun, resource: ChosenResource, role: "developer" | "reviewer"): Next | null {
  const limit = (deps.accountLimit ?? missionAccountLimit)({ harnessId: resource.harnessId, accountId: resource.accountId, modelId: resource.modelId }, role, nowMs());
  if (!limit) return null;
  if (limit.resetAt != null && limit.resetAt > nowMs()) return waitFor(run, `The account ${limit.accountLabel} reached its provider limit. Work continues when it resets.`, limit.resetAt, "provider-limit");
  return block(run, "account-limit", `The account ${limit.accountLabel} reached its provider limit and its reset time is unknown. Nothing is retried automatically. Choose another covered account or try again later.`, "open-accounts");
}

/* ------------------------------------------------------------------------------------- stage: developing */

async function afterDeveloper(run: HandsoffRun, task: Task, policy: HandsoffPolicy): Promise<Next> {
  const devRunId = run.state.developerRunId;
  const dev = devRunId ? runs.get(devRunId) : null;
  if (!devRunId || !dev) {
    // The launch recorded no run: reconcile the real state before anything is retried.
    return launchDeveloper(advanceStage(run, "queued"), task, policy);
  }
  if (dev.status === "running" || isTaskRunLive(task.id)) return "idle";
  if (dev.status === "cancelled") return stop(run, "The Developer run was stopped. Nothing was started again.");
  if (dev.status !== "succeeded") {
    const summary = dev.status === "orphaned" ? "The Developer run was interrupted by a restart." : `The Developer run ${dev.status}.`;
    if (run.state.launchAttempts < HANDSOFF_LIMITS.maxLaunchAttempts && dev.status === "orphaned") {
      note(run, "note", `${summary} Starting a fresh run.`);
      return launchDeveloper(advanceStage(run, "queued", { ...run.state, developerRunId: null }), tasks.get(task.id) ?? task, policy);
    }
    return block(run, "developer-failed", `${summary} No result was recorded.`, "open-task");
  }
  const ws = getTaskWorkspace(task.id);
  if (!ws || ws.developerRunId !== devRunId) {
    if (ws?.status === "executing" || task.column === "running") return { afterMs: 400 };
    return block(run, "workspace-missing", "The Developer finished but no task working copy is bound to that run, so nothing can be reviewed or applied.", "open-task");
  }
  if (ws.status === "executing" || task.column === "running") return { afterMs: 200 };
  if (ws.interruption || ws.violation || !ws.scanComplete) {
    return block(run, "workspace-missing", "The working copy is incomplete or contains an unauthorized change, so nothing was reviewed or applied.", "open-task");
  }
  note(run, "developer-finished", "The Developer finished.", workerDetail(run.state.developer));
  advanceStage(run, "testing");
  // Developer worker is now free — reconsider the project queue once testing starts.
  void scheduleProject(run.projectPath);
  return "now";
}

/* --------------------------------------------------------------------------------------- stage: testing */

async function runTest(run: HandsoffRun, task: Task, policy: HandsoffPolicy): Promise<Next> {
  const fingerprint = stagingFingerprint(task.id);
  if (!fingerprint) return block(run, "workspace-missing", "The working copy could not be read, so nothing was tested or reviewed.", "open-task");
  if (!policy.runOfflineTests) {
    advanceStage(run, "reviewing", { ...run.state, testDone: true, evidenceFingerprint: fingerprint, tests: { state: "skipped", command: null, summary: "Offline tests are not covered by this project's policy." } });
    return "now";
  }
  note(run, "test-started", "Running the project's offline test in the sandbox.");
  let request;
  try {
    request = await requestPolicyCoveredTest({ taskId: task.id, policyRevision: run.policyRevision });
  } catch (error) {
    if (error instanceof ProjectPermissionError && error.code === "test") {
      note(run, "test-finished", "No test ran: the change contains no single test file.");
      return afterTestResult(run, task, policy, { state: "not-run", command: null, summary: "No single test file was found in the change." }, fingerprint);
    }
    if (error instanceof ProjectPermissionError && (error.code === "emergency-stop" || error.code === "project-stopped")) return waitFor(run, error.message);
    if (error instanceof ProjectPermissionError && error.code === "duplicate") return { afterMs: 500 };
    note(run, "test-finished", `The offline test could not run: ${reasonText(error)}`);
    return afterTestResult(run, task, policy, { state: "unavailable", command: null, summary: reasonText(error) }, fingerprint);
  }
  const summary = request.summary ?? request.reason ?? null;
  if (request.status === "completed" || request.status === "failed") {
    const passed = request.status === "completed" && request.exitCode === 0;
    note(run, "test-finished", passed ? "The offline test passed." : `The offline test failed (exit code ${request.exitCode ?? "unknown"}).`, { exitCode: request.exitCode, command: request.command });
    return afterTestResult(run, task, policy, { state: passed ? "passed" : "failed", command: request.command, summary }, request.sourceFingerprint);
  }
  const state: HandsoffTestState = request.status === "denied" ? "unavailable" : "unavailable";
  note(run, "test-finished", `The offline test did not run (${request.status}). It is not counted as a pass.`, { status: request.status });
  return afterTestResult(run, task, policy, { state, command: request.command, summary: summary ?? `The test ${request.status}.` }, request.sourceFingerprint ?? fingerprint);
}

async function afterTestResult(run: HandsoffRun, task: Task, policy: HandsoffPolicy, tests: HandsoffResult["tests"], fingerprint: string | null): Promise<Next> {
  const withTests = { ...run.state, tests, evidenceFingerprint: fingerprint };
  if (tests.state === "failed") {
    return sendBack(save(run, { state: withTests }), task, policy, { kind: "test_failed", findings: tests.summary ?? "The offline test failed.", fingerprint, limitCode: "test-failed-limit" });
  }
  if ((tests.state === "not-run" || tests.state === "unavailable") && policy.requireTest) {
    if (tests.state === "not-run") {
      return sendBack(save(run, { state: withTests }), task, policy, { kind: "missing_evidence", findings: "The change has no test the project can run. Add a test file next to the change.", fingerprint, limitCode: "test-required" });
    }
    return block(save(run, { state: withTests }), "test-blocked", `A passing test is required and the offline test could not run: ${tests.summary ?? "unavailable"}. It is not counted as a pass.`, "open-task");
  }
  advanceStage(run, "reviewing", { ...withTests, testDone: true });
  return "now";
}

/** Route actionable findings back to the Developer, within the bounded rounds and only while progress is real. */
async function sendBack(run: HandsoffRun, task: Task, policy: HandsoffPolicy, input: { kind: Parameters<typeof storePracticalReworkBrief>[0]["kind"]; findings: string; fingerprint: string | null; limitCode: "test-failed-limit" | "test-required" | "review-limit" }): Promise<Next> {
  const qc = tasks.get(task.id)?.qcState;
  const findingsHash = textFingerprint(normalizeFindings(input.findings));
  const decision = fixDecision({
    round: run.round, maxFixRounds: policy.maxFixRounds, qcRoundsUsed: qc?.roundCount ?? 0, qcMaxRounds: qc?.maxRounds ?? QC_LIMITS.maxRounds,
    findingsHash, previousFindingsHash: run.state.lastFindingsHash, sourceFingerprint: input.fingerprint, previousFingerprint: run.state.lastFingerprint,
  });
  if (decision.kind === "stop") {
    const code: HandsoffBlockerCode = decision.code === "no-progress" ? "no-progress" : input.limitCode;
    return block(run, code, `${decision.reason} Last finding: ${input.findings.slice(0, 300)}`, "open-task");
  }
  storePracticalReworkBrief({
    taskId: task.id, epoch: run.round + 1, kind: input.kind, requirements: task.prompt, diff: null,
    testErrors: input.kind === "test_failed" ? input.findings : null, reviewerFindings: input.kind === "test_failed" ? null : input.findings, projectRules: null,
  });
  const ws = getTaskWorkspace(task.id);
  if (ws?.status === "settled" && !rearmSettledWorkspace(task.id)) {
    return block(run, "workspace-missing", "The working copy could not be re-opened for a correction.", "open-task");
  }
  if (tasks.get(task.id)?.column !== "ready") moveTaskColumn(task.id, "ready");
  const state: HandsoffState = { ...run.state, lastFindingsHash: findingsHash, lastFingerprint: input.fingerprint, developerRunId: null, launchIntent: null, launchAttempts: 0, testDone: false, reviewId: null, testAuthorizationId: null };
  const next = save(run, { stage: "fixing", status: "active", round: run.round + 1, state, blocker: null });
  note(next, "fix-started", `Sending the work back for correction (round ${next.round} of ${policy.maxFixRounds}).`, { kind: input.kind });
  deps.onFix?.(task.id, next.round);
  return "now";
}

/* ------------------------------------------------------------------------------------- stage: reviewing */

async function reviewStage(run: HandsoffRun, task: Task, policy: HandsoffPolicy): Promise<Next> {
  const existing = run.state.reviewId ? taskQualityReviews.get(run.state.reviewId) : null;
  if (existing && (existing.status === "pending" || existing.status === "running")) return "idle";
  if (existing && existing.status === "complete") return afterReview(run, task, policy, existing);
  if (existing && existing.status === "cancelled") {
    return block(save(run, { state: { ...run.state, reviewId: null } }), "review-failed", "The Reviewer did not produce a verdict. Nothing was applied.", "retry");
  }
  const admission = checkProjectLaunchAdmission(run.projectPath);
  if (!admission.allowed) return waitFor(run, admission.reason ?? "The project is stopped. Nothing was started.", null, "project-paused");
  const unauthorized = authorizationBlock(run);
  if (unauthorized) return unauthorized;
  if (isTaskRunLive(task.id)) return "idle";
  const chosen = chooseResource({ taskId: task.id, projectPath: run.projectPath, title: task.title, role: "reviewer", policy, requested: { harnessId: null, modelId: null, accountId: null } });
  if (!chosen.ok) return block(run, "no-resource", chosen.message, "open-settings");
  const limited = limitWait(run, chosen.resource, "reviewer");
  if (limited) return limited;
  const developerId = run.state.developer?.employeeId ?? null;
  const busyReviewers = busyReviewerEmployeeIds(run.projectPath, run.id);
  const eligibleReviewers = projectTeam(run.projectPath).filter((member) => isReviewerWorker(member) && member.id !== developerId);
  const reviewer = eligibleReviewers.find((member) => !busyReviewers.has(member.id)) ?? eligibleReviewers[0];
  let reviewId: string;
  try {
    const prepared = prepareQcReview({ taskId: task.id, reviewerHarness: chosen.resource.harnessId, reviewerModel: chosen.resource.modelId, reviewerEmployeeId: reviewer?.id });
    if (prepared.blockedReason) return block(run, "review-blocked", `${prepared.blockedReason} Nothing was started.`, "open-task");
    reviewId = prepared.review.id;
  } catch (error) {
    return block(run, "review-blocked", `The independent review could not be prepared: ${reasonText(error)}`, "open-task");
  }
  // The review is bound to the exact bytes the test judged.
  const fingerprint = stagingFingerprint(task.id);
  if (!fingerprint) {
    try { cancelPendingQcReview(reviewId); } catch { /* closed */ }
    return block(run, "workspace-missing", "The working copy could not be read, so nothing was reviewed.", "open-task");
  }
  if (run.state.evidenceFingerprint && fingerprint !== run.state.evidenceFingerprint) {
    try { cancelPendingQcReview(reviewId); } catch { /* closed */ }
    return block(run, "apply-conflict", "The working copy changed after its test ran. The earlier test cannot be reused. Nothing was reviewed or applied.", "retry", { testDone: false, evidenceFingerprint: null });
  }
  const reviewerRef = { employeeId: reviewer?.id ?? null, employeeName: reviewer?.name ?? null, harnessId: chosen.resource.harnessId, modelId: chosen.resource.modelId, accountId: chosen.resource.accountId };
  run = save(run, { state: { ...run.state, reviewId, reviewer: reviewerRef, evidenceFingerprint: fingerprint, launchIntent: { kind: "review", at: nowMs() } } });
  const contract = readOnlyReviewerContract(chosen.resource.kind);
  const ownRun = run;
  const verify = (): string | null => {
    if (autonomyPolicyStore.readEmergency().active) return "Emergency Stop is active.";
    if (!currentPolicy(ownRun).enabled) return "Work independently was turned off for this project.";
    const gate = checkProjectLaunchAdmission(ownRun.projectPath);
    if (!gate.allowed) return gate.reason ?? "The project is stopped.";
    if (stagingFingerprint(task.id) !== fingerprint) return "The working copy changed after the evidence was prepared.";
    return null;
  };
  const started = await startQcReview(reviewId, undefined, {
    mode: contract?.mode ?? "ask",
    effort: defaultEffortFor(chosen.resource.kind as never, chosen.resource.modelId, chosen.resource.harnessId),
    allowColumns: ["review"],
    evidenceNote: "The evidence section is authoritative. It describes a working copy that has not been applied. Do not use a shell. Do not publish, deploy or push.",
    evidenceSection: renderStagedEvidence(task.id, run.state.tests, fingerprint),
    verify,
    onRunRecorded: () => undefined,
  }, { handsoffLaunch: { handsoffRunId: ownRun.id, round: ownRun.round, intentAt: ownRun.state.launchIntent?.at ?? 0 } }).catch((error) => ({ error: reasonText(error), code: (error as { code?: string })?.code }));
  if ("error" in started) {
    const cleared = save(run, { state: { ...run.state, reviewId: null, launchIntent: null } });
    if (autonomyPolicyStore.readEmergency().active) return stop(cleared, "Emergency Stop is active. Nothing new will start.");
    const liveAdmission = checkProjectLaunchAdmission(run.projectPath);
    if (!liveAdmission.allowed) {
      return waitFor(cleared, liveAdmission.reason ?? "The project is stopped. Nothing was started.", null, "project-paused");
    }
    const refused = authorizationRefusal(cleared, { code: (started as { code?: string }).code, message: started.error });
    if (refused) return refused;
    return block(cleared, "review-failed", `The independent Reviewer could not be started: ${started.error}`, "retry");
  }
  const next = save(run, { state: { ...run.state, launchIntent: null } });
  note(next, "review-started", "An independent Reviewer started.", { ...workerDetail(reviewerRef), runId: started.runId });
  return "idle";
}

async function afterReview(run: HandsoffRun, task: Task, policy: HandsoffPolicy, review: NonNullable<ReturnType<typeof taskQualityReviews.get>>): Promise<Next> {
  const verdictState = { verdict: review.verdict, summary: review.summary, round: review.round };
  const state = { ...run.state, review: verdictState };
  const noted = save(run, { state });
  note(noted, "review-finished", `The Reviewer's verdict: ${review.verdict ?? "no verdict"}.`, { verdict: review.verdict, ...workerDetail(run.state.reviewer) });
  if (review.verdict === "PASS") {
    advanceStage(noted, "applying", state);
    return "now";
  }
  if (review.verdict === "CHANGES_REQUESTED") {
    const findings = review.feedback ?? review.summary ?? "The Reviewer asked for changes.";
    return sendBack(noted, task, policy, { kind: classifyReviewFailure(review.summary), findings, fingerprint: run.state.evidenceFingerprint, limitCode: "review-limit" });
  }
  return block(noted, "review-blocked", `The Reviewer could not approve the work: ${review.summary ?? "no verdict was produced"}. Nothing was applied.`, "open-task");
}

/* -------------------------------------------------------------------------------------- stage: applying */

async function applyStage(run: HandsoffRun, task: Task, policy: HandsoffPolicy): Promise<Next> {
  const { paths, status } = workspaceChanges(task.id);
  const qc = tasks.get(task.id)?.qcState;
  if (qc?.latestVerdict !== "PASS") return block(run, "review-blocked", "There is no passing independent review for the current work, so nothing was applied.", "open-task");
  if (paths.length === 0 || status === "published") {
    const delivered = status === "published";
    return closeWork(run, task, policy, delivered ? "applied" : "none", delivered ? appliedPathsOf(task.id) : []);
  }
  // Review and test must judge the bytes that are applied.
  const current = stagingFingerprint(task.id);
  if (!current || (run.state.evidenceFingerprint && current !== run.state.evidenceFingerprint)) {
    return block(run, "apply-conflict", "The working copy changed after the review. The earlier evidence cannot be reused and nothing was applied.", "retry", { testDone: false, evidenceFingerprint: null, reviewId: null });
  }
  deps.beforeApply?.(task.id);
  if (!policy.autoApply) {
    const result = resultOf(run, "prepared");
    return finish(run, "ready-to-apply", "The reviewed change is ready in its working copy. The project folder was not changed.", result);
  }
  try {
    await publishTaskWorkspace(task.id, { approve: true, paths });
  } catch (error) {
    const message = error instanceof TaskWorkspaceError ? error.message : reasonText(error);
    return block(run, "apply-conflict", `Nothing was overwritten. ${message}`, "retry");
  }
  note(run, "applied", `Applied ${paths.length} file${paths.length === 1 ? "" : "s"} to the project folder.`, { paths });
  return closeWork(run, task, policy, "applied", paths);
}

function appliedPathsOf(taskId: string): string[] {
  const ws = getTaskWorkspace(taskId);
  const last = ws?.publications.at(-1);
  return last ? last.results.filter((r) => r.status === "applied" || r.status === "already-applied").map((r) => r.path) : [];
}

async function closeWork(run: HandsoffRun, task: Task, policy: HandsoffPolicy, delivery: HandsoffResult["delivery"], applied: string[]): Promise<Next> {
  const result = resultOf(run, delivery, applied);
  if (!policy.autoDone) return finish(run, "awaiting-accept", "The work is finished and checked. Accepting it stays with you.", result);
  const done = acceptAuthorizedTaskDone(task.id);
  if (!done.ok || done.task.column !== "done") {
    return block(save(run, { result }), "done-refused", `The task could not be marked Done: ${done.ok ? "it did not reach Done" : done.reason}`, "open-task");
  }
  return finish(run, "done", delivery === "applied" ? "Applied to the project folder and marked Done." : "Checked and marked Done.", result);
}

/* ------------------------------------------------------------------------------------------- the step */

async function step(runId: string, preferredDeveloperId: string | null = null): Promise<Next> {
  let run = handsoffStore.getRun(runId);
  if (!run || run.finishedAt != null || isHandsoffTerminal(run.status)) return "idle";
  const task = tasks.get(run.taskId);
  if (!task || task.archivedAt != null) return finish(run, "cancelled", "The task was removed or archived.");
  if (autonomyPolicyStore.readEmergency().active) return stop(run, "Emergency Stop is active. Nothing new will start.");
  if (run.status === "stopped" || run.status === "needs-owner") return "idle";
  const policy = currentPolicy(run);
  if (!policy.enabled) return stop(run, "Work independently was turned off for this project. Nothing new will start.");
  if (run.status === "waiting" && run.state.waitKind === "scheduled") {
    const availability = taskAvailabilityFor(task, nowMs());
    if (!availability.available) {
      if (availability.availableFromMs !== run.state.waitUntil) {
        return waitFor(run, "Waiting for scheduled time.", availability.availableFromMs, "scheduled");
      }
      return availability.availableFromMs && availability.availableFromMs > nowMs()
        ? { afterMs: Math.min(availability.availableFromMs - nowMs(), 60_000) }
        : "idle";
    }
  }
  if (run.status === "waiting" && run.state.waitKind !== "scheduled" && run.state.waitUntil != null && run.state.waitUntil > nowMs()) return { afterMs: Math.min(run.state.waitUntil - nowMs(), 60_000) };
  if (run.status === "waiting") run = resumeActive(run);
  switch (run.stage) {
    case "queued":
    case "fixing":
      return launchDeveloper(run, task, policy, preferredDeveloperId);
    case "developing":
      return afterDeveloper(run, task, policy);
    case "testing":
      return runTest(run, task, policy);
    case "reviewing":
      return reviewStage(run, task, policy);
    case "applying":
      return applyStage(run, task, policy);
    default:
      return "idle";
  }
}

/* --------------------------------------------------------------------------------------------- scheduling */

const chains = new Map<string, Promise<void>>();
const queued = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Per-project serialized smart-queue chains so concurrent wakes/completions never double-claim. */
const projectChains = new Map<string, Promise<void>>();
const projectQueued = new Set<string>();
/** Runs and Developer employee IDs currently mid-launch in this process. */
const claimingRunIds = new Set<string>();
const claimingEmployeeIds = new Set<string>();
/** Cross-project round-robin fairness timestamp: least-recently-served project goes first. */
const lastProjectDispatchedAt = new Map<string, number>();

async function drive(runId: string, preferredDeveloperId: string | null = null): Promise<void> {
  try {
    for (let i = 0; i < 25; i += 1) {
      let next: Next;
      try { next = await step(runId, i === 0 ? preferredDeveloperId : null); }
      catch (error) {
        const run = handsoffStore.getRun(runId);
        if (run && !run.finishedAt && run.status !== "needs-owner") block(run, "internal", `An unexpected error stopped this step: ${reasonText(error).slice(0, 300)}`, "retry");
        return;
      }
      if (next === "now") continue;
      if (typeof next === "object") schedule(runId, next.afterMs);
      return;
    }
  } finally {
    claimingRunIds.delete(runId);
    if (preferredDeveloperId) claimingEmployeeIds.delete(preferredDeveloperId);
  }
}

function schedule(runId: string, afterMs: number): void {
  const previous = timers.get(runId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => { timers.delete(runId); void wake(runId); }, Math.max(50, afterMs));
  timer.unref?.();
  timers.set(runId, timer);
}

/** Drive one specific run directly (used for active lifecycle stages and explicit blocker recording). */
function wakeRunDirect(runId: string, preferredDeveloperId: string | null = null): Promise<void> {
  if (queued.has(runId)) return chains.get(runId) ?? Promise.resolve();
  queued.add(runId);
  const tail = (chains.get(runId) ?? Promise.resolve()).then(async () => {
    queued.delete(runId);
    await drive(runId, preferredDeveloperId);
  }).catch(() => undefined);
  chains.set(runId, tail);
  void tail.finally(() => { if (chains.get(runId) === tail) chains.delete(runId); });
  return tail;
}

/**
 * Canonical per-project smart queue pass:
 *   1. Drive active lifecycle continuations (`applying` -> `testing` -> `reviewing` -> `fixing` -> `developing`)
 *      so already-started tasks complete and never starve behind newly queued tasks.
 *   2. Dispatch eligible `queued` tasks strictly in persisted Kanban board order (`compareBoardTasks`:
 *      urgency DESC -> `board_rank` ASC -> `created_at` ASC -> `id` ASC), allocating distinct idle Developers
 *      within `policy.maxParallel` and skipping scheduled/dependency/worker/limit-blocked tasks.
 *   3. Sync waiting queued runs and arm timers for scheduled timestamps or provider limit resets.
 *   4. Drive any blocked `status: "active"` queued runs through `step()` so exact Owner blockers are recorded.
 */
async function runProjectQueuePass(projectPath: string): Promise<void> {
  const evaluated = evaluateProjectQueue(projectPath, {
    now: nowMs(),
    accountLimit: deps.accountLimit,
    claimingRunIds,
    claimingEmployeeIds,
  });

  // 1. Active lifecycle continuations first (non-preemptive, anti-starvation for QC & rework).
  for (const cont of evaluated.continuations) {
    if (cont.status === "waiting" && cont.state.waitUntil != null && cont.state.waitUntil > nowMs()) {
      schedule(cont.id, Math.min(cont.state.waitUntil - nowMs(), 60_000));
      continue;
    }
    void wakeRunDirect(cont.id);
  }

  // 2. Dispatch eligible queued candidates in canonical Kanban order.
  const handledQueued = new Set<string>();
  for (const candidate of evaluated.dispatchable) {
    handledQueued.add(candidate.run.id);
    if (claimingRunIds.has(candidate.run.id)) continue;
    if (candidate.developerId && claimingEmployeeIds.has(candidate.developerId)) continue;
    claimingRunIds.add(candidate.run.id);
    if (candidate.developerId) claimingEmployeeIds.add(candidate.developerId);
    lastProjectDispatchedAt.set(projectPath, nowMs());
    void wakeRunDirect(candidate.run.id, candidate.developerId);
  }

  // 3. Sync waiting queued runs (scheduled, dependency, busy worker, full slot, paused project, provider limit).
  for (const waiting of evaluated.waitingQueued) {
    handledQueued.add(waiting.run.id);
    const fresh = handsoffStore.getRun(waiting.run.id);
    if (!fresh || fresh.finishedAt != null || fresh.stage !== "queued" || fresh.status === "stopped" || fresh.status === "needs-owner") continue;
    const waitKind =
      waiting.waitKind === "scheduled" ||
      waiting.waitKind === "dependency" ||
      waiting.waitKind === "worker" ||
      waiting.waitKind === "slot" ||
      waiting.waitKind === "provider-limit" ||
      waiting.waitKind === "project-paused"
        ? waiting.waitKind
        : null;
    const next = waitFor(fresh, waiting.reason ?? "Waiting.", waiting.waitUntil, waitKind);
    if (typeof next === "object") schedule(fresh.id, next.afterMs);
  }

  // 4. Any remaining active `queued` run hit a real Owner-action or stop gate (auth, workspace-off,
  //    no-resource, no-worker, unknown provider reset, Emergency Stop, policy-off): let `step()` record it.
  for (const run of handsoffStore.listOpenRuns(projectPath)) {
    if (run.stage !== "queued" || handledQueued.has(run.id) || claimingRunIds.has(run.id)) continue;
    if (run.status === "active" || (run.status === "waiting" && (run.state.waitUntil == null || run.state.waitUntil <= nowMs()))) {
      void wakeRunDirect(run.id);
    }
  }
}

/** Serialize smart queue scheduling per project so rapid submissions/reorders/completions coalesce cleanly. */
export function scheduleProject(projectPath: string): Promise<void> {
  if (projectQueued.has(projectPath)) return projectChains.get(projectPath) ?? Promise.resolve();
  projectQueued.add(projectPath);
  const tail = (projectChains.get(projectPath) ?? Promise.resolve()).then(async () => {
    projectQueued.delete(projectPath);
    await runProjectQueuePass(projectPath);
  }).catch(() => undefined);
  projectChains.set(projectPath, tail);
  void tail.finally(() => { if (projectChains.get(projectPath) === tail) projectChains.delete(projectPath); });
  return tail;
}

/**
 * Cross-project round-robin scheduler: serves projects in least-recently-dispatched order
 * so a project with many high-urgency tasks never permanently starves other projects.
 * Never compares raw `board_rank` values across unrelated projects.
 */
export function scheduleAllProjects(): Promise<void> {
  const projectPaths = [...new Set(handsoffStore.listOpenRuns().map((r) => r.projectPath))];
  projectPaths.sort((a, b) => {
    const la = lastProjectDispatchedAt.get(a) ?? 0;
    const lb = lastProjectDispatchedAt.get(b) ?? 0;
    return la !== lb ? la - lb : a.localeCompare(b);
  });
  return Promise.all(projectPaths.map((p) => scheduleProject(p))).then(() => undefined);
}

/** Request one scheduling pass for a run: `queued` runs go through the project smart queue; active stages drive directly. */
export function wake(runId: string): Promise<void> {
  const run = handsoffStore.getRun(runId);
  if (!run || run.finishedAt != null) return Promise.resolve();
  if (run.stage === "queued") return scheduleProject(run.projectPath);
  return wakeRunDirect(runId);
}

export async function settled(runId: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const run = handsoffStore.getRun(runId);
    const pTail = run ? projectChains.get(run.projectPath) : undefined;
    const rTail = chains.get(runId);
    if (!pTail && !rTail) return;
    if (pTail) await pTail;
    if (rTail) await rTail;
  }
}

export async function settledProject(projectPath: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const pTail = projectChains.get(projectPath);
    const runTails = handsoffStore.listOpenRuns(projectPath).map((r) => chains.get(r.id)).filter((t): t is Promise<void> => Boolean(t));
    if (!pTail && runTails.length === 0) return;
    if (pTail) await pTail;
    if (runTails.length > 0) await Promise.all(runTails);
  }
}

/** Canonical backend smart queue summary for one project (same evaluator as dispatch). */
export function projectQueueView(projectPath: string) {
  return evaluateProjectQueue(projectPath, {
    now: nowMs(),
    accountLimit: deps.accountLimit,
    claimingRunIds,
    claimingEmployeeIds,
  }).summary;
}

/** Canonical backend smart queue summaries across all enabled/active projects. */
export function allProjectQueuesView() {
  return buildSmartQueueOverview({
    now: nowMs(),
    accountLimit: deps.accountLimit,
    claimingRunIds,
    claimingEmployeeIds,
  });
}

/* ------------------------------------------------------------------------------------------ public API */

export { HandsoffError } from "./errors.ts";

export interface SubmitOptions { harnessId?: unknown; model?: unknown; accountId?: unknown }

function requested(options: SubmitOptions): HandsoffState["requested"] {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, HANDSOFF_LIMITS.maxIdLength) : null;
  return { harnessId: text(options.harnessId), modelId: text(options.model), accountId: text(options.accountId) };
}

/** The deliberate act: this task, now. Nothing else is ever swept in. */
export function submitTask(taskId: unknown, options: SubmitOptions = {}): HandsoffRun {
  if (typeof taskId !== "string" || !taskId) throw new HandsoffError("A task is required.", 400, "task");
  const task = tasks.get(taskId);
  if (!task) throw new HandsoffError("Task not found.", 404, "not-found");
  if (task.archivedAt != null) throw new HandsoffError("The task is archived.", 409, "archived");
  if (task.pipelineId || task.pipelineParentId) throw new HandsoffError("A pipeline task runs through its own steps.", 409, "pipeline");
  if (task.column !== "backlog" && task.column !== "ready") throw new HandsoffError("Only a task in Backlog or Ready can be submitted for work.", 409, "column");
  const projectPath = ownerProjectOf(task.workdir, { fresh: true });
  if (!projectPath || !projects.get(projectPath) || !taskInProject(task, projectPath, { fresh: true })) {
    throw new HandsoffError("The task does not belong to exactly one registered project.", 409, "project");
  }
  const stored = handsoffStore.getPolicy(projectPath);
  if (!stored?.policy.enabled) throw new HandsoffError("Work independently is off for this project. Turn it on in the project's settings first.", 409, "policy-off");
  if (autonomyPolicyStore.readEmergency().active) throw new HandsoffError("Emergency Stop is active. Nothing was submitted.", 409, "emergency-stop");
  const admission = checkProjectLaunchAdmission(projectPath);
  if (!admission.allowed) throw new HandsoffError(`${admission.reason ?? "The project is stopped."} Nothing was submitted.`, 409, "project-stopped");
  if (isTaskRunLive(taskId) || new EmployeeRunCore(db, nowMs).hasUnconfirmed(taskId)) throw new HandsoffError("The task already has a run in progress or an unconfirmed earlier launch.", 409, "busy");
  let run: HandsoffRun;
  try {
    run = handsoffStore.insertRun({ taskId, projectPath, policyRevision: stored.revision, policy: stored.policy, requested: requested(options), now: nowMs() });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(reasonText(error))) throw new HandsoffError("This task was already submitted.", 409, "already-submitted");
    throw error;
  }
  note(run, "submitted", `Submitted for work under policy revision ${run.policyRevision}.`, {});
  // Submitting a Backlog task is the Owner's explicit admission of that one task: it moves to Ready, which the launch
  // services require. Nothing else is moved; the other Backlog and Inbox tasks stay exactly where they are.
  if (task.column === "backlog") {
    moveTaskColumn(taskId, "ready");
    note(run, "submitted", "The task was moved from Backlog to Ready because you submitted it.", { from: "backlog", to: "ready" });
  }
  announce(run, "active");
  void wake(run.id);
  return run;
}

function mustOpen(runId: string): HandsoffRun {
  const run = handsoffStore.getRun(runId);
  if (!run) throw new HandsoffError("Hands-off run not found.", 404, "not-found");
  if (run.finishedAt != null) throw new HandsoffError("This work is already finished.", 409, "finished");
  return run;
}

/** The Owner's one action on a blocker: look again now. Resets only the counters the Owner just reviewed. */
export function retryRun(runId: string): HandsoffRun {
  const run = mustOpen(runId);
  if (run.status !== "needs-owner" && run.status !== "waiting") throw new HandsoffError("This work is not waiting for a decision.", 409, "state");
  if (autonomyPolicyStore.readEmergency().active) throw new HandsoffError("Emergency Stop is active. Nothing was started.", 409, "emergency-stop");
  const stage: HandsoffStage = run.stage === "testing" || run.stage === "reviewing" || run.stage === "applying" || run.stage === "developing" ? run.stage : "queued";
  const state = { ...run.state, launchAttempts: 0, waitUntil: null, waitReason: null, reviewId: stage === "reviewing" ? null : run.state.reviewId };
  const next = save(run, { stage, status: "active", blocker: null, state });
  note(next, "resumed", "The Owner asked for another attempt.", {});
  void wake(next.id);
  return next;
}

/** After Emergency Stop or a stop: explicit, one run, and only while no stop is active. */
export function resumeRun(runId: string): HandsoffRun {
  const run = mustOpen(runId);
  if (run.status !== "stopped") throw new HandsoffError("Only stopped work can be resumed.", 409, "state");
  if (autonomyPolicyStore.readEmergency().active) throw new HandsoffError("Emergency Stop is active. Lift it first. Nothing was started.", 409, "emergency-stop");
  if (!currentPolicy(run).enabled) throw new HandsoffError("Work independently is off for this project. Turn it on first.", 409, "policy-off");
  const dev = run.state.developerRunId ? runs.get(run.state.developerRunId) : null;
  let stage: HandsoffStage = run.stage;
  let state: HandsoffState = { ...run.state, launchAttempts: 0, launchIntent: null };
  if (dev && dev.status === "cancelled") {
    // The stopped Developer run produced an interrupted working copy: start that round again from a clean one.
    const ws = getTaskWorkspace(run.taskId);
    if (ws?.status === "settled" || ws?.status === "armed") { try { abandonTaskWorkspace(run.taskId); } catch { /* still in use */ } }
    stage = "queued";
    state = { ...state, developerRunId: null, testDone: false, reviewId: null };
    if (tasks.get(run.taskId)?.column !== "ready") moveTaskColumn(run.taskId, "ready");
  } else if (stage === "reviewing" && state.reviewId) {
    const review = taskQualityReviews.get(state.reviewId);
    if (review?.status === "cancelled") state = { ...state, reviewId: null };
  }
  const next = save(run, { stage, status: "active", blocker: null, state });
  note(next, "resumed", "The Owner resumed this work.", {});
  void wake(next.id);
  return next;
}

/** The Owner ends this work. Live processes of this run are asked to stop; nothing is applied. */
export async function cancelHandsoffRun(runId: string): Promise<HandsoffRun> {
  const run = mustOpen(runId);
  save(run, { status: "stopped" });
  await cancelLiveProcesses(run);
  const fresh = handsoffStore.getRun(run.id)!;
  finish(fresh, "cancelled", "The Owner cancelled this work. Nothing further will start.");
  return handsoffStore.getRun(run.id)!;
}

async function cancelLiveProcesses(run: HandsoffRun): Promise<number> {
  let count = 0;
  const task = tasks.get(run.taskId);
  const ids = new Set<string>();
  if (run.state.developerRunId) ids.add(run.state.developerRunId);
  if (run.state.reviewId) {
    const review = taskQualityReviews.get(run.state.reviewId);
    if (review?.reviewRunId) ids.add(review.reviewRunId);
  }
  if (task?.runId && isTaskRunLive(task.id)) ids.add(task.runId);
  for (const id of ids) {
    const row = runs.get(id);
    if (row?.status === "running") { try { if (await cancelRun(id)) count += 1; } catch { /* already ending */ } }
  }
  return count;
}

/**
 * Emergency Stop: every unfinished run is marked stopped first (so no event wakes a launch), then its live
 * processes are asked to stop. Completed evidence stays. Nothing restarts when the stop is cleared.
 */
export async function stopHandsoffForEmergency(reason: string): Promise<{ stopped: number; outstanding: string[] }> {
  const open = handsoffStore.listOpenRuns();
  const outstanding: string[] = [];
  for (const run of open) {
    if (run.status !== "stopped") { const next = save(run, { status: "stopped", blocker: null }); note(next, "stopped", `${reason} Nothing new will start.`); }
  }
  for (const run of open) {
    await cancelLiveProcesses(run);
    const row = run.state.developerRunId ? runs.get(run.state.developerRunId) : null;
    if (row && isTaskRunLive(run.taskId)) outstanding.push(row.id);
  }
  return { stopped: open.length, outstanding };
}

/** Revocation and a project-level stop: this project's unfinished runs are stopped first, then their processes asked to stop. */
export async function stopHandsoffForProject(projectPath: string, reason: string): Promise<{ stopped: number }> {
  const open = handsoffStore.listOpenRuns(projectPath);
  for (const run of open) {
    if (run.status !== "stopped") { const next = save(run, { status: "stopped", blocker: null }); note(next, "stopped", `${reason} Nothing new will start.`); }
  }
  for (const run of open) await cancelLiveProcesses(run);
  return { stopped: open.length };
}

/* ------------------------------------------------------------------------------------------------ boot */

let initialized = false;
let sweep: ReturnType<typeof setInterval> | undefined;
let unsubAvailability: (() => void) | undefined;
let unsubQueueChange: (() => void) | undefined;

/** Re-evaluate any open hands-off run for this task when its scheduled availability changes. */
export function notifyHandsoffAvailabilityChanged(taskId: string): void {
  const run = handsoffStore.openRunForTask(taskId);
  if (!run) return;
  const previous = timers.get(run.id);
  if (previous) {
    clearTimeout(previous);
    timers.delete(run.id);
  }
  announce(run, "queue-updated");
  if (run.status !== "stopped" && run.status !== "needs-owner") {
    void scheduleProject(run.projectPath);
  }
}

/** Wake the run a task event belongs to. Cheap: one indexed read, and only for tasks the driver owns. */
export function initHandsoff(): void {
  if (initialized) return;
  initialized = true;
  unsubAvailability = onTaskAvailabilityChange((taskId) => {
    notifyHandsoffAvailabilityChanged(taskId);
  });
  unsubQueueChange = onSmartQueueChange((projectPath, reason) => {
    if (projectPath) {
      try { broadcastAppEvent({ type: "handsoff", projectPath, taskId: null, runId: null, status: reason, ts: nowMs() }); } catch { /* next read catches up */ }
      if (handsoffStore.listOpenRuns(projectPath).some((r) => r.status === "active" || r.status === "waiting")) {
        void scheduleProject(projectPath);
      }
    } else {
      void scheduleAllProjects();
    }
  });
  subscribeGlobal((event) => {
    if (event.kind !== "run-status" && event.kind !== "column") return;
    const run = handsoffStore.openRunForTask(event.taskId);
    if (run && run.status !== "stopped" && run.status !== "needs-owner") {
      if (run.stage === "queued") void scheduleProject(run.projectPath);
      else void wakeRunDirect(run.id);
    }
    if (event.kind === "column" && event.column === "done") {
      const affectedProjects = new Set<string>();
      for (const dependent of taskScheduling.dependentsOf(event.taskId)) {
        const waiting = handsoffStore.openRunForTask(dependent);
        if (waiting && waiting.status === "waiting") affectedProjects.add(waiting.projectPath);
      }
      for (const p of affectedProjects) void scheduleProject(p);
    }
  });
  sweep = setInterval(() => {
    void scheduleAllProjects();
  }, HANDSOFF_LIMITS.sweepMs);
  sweep.unref?.();
}

export function stopHandsoffTimers(): void {
  if (sweep) clearInterval(sweep);
  sweep = undefined;
  unsubAvailability?.();
  unsubAvailability = undefined;
  unsubQueueChange?.();
  unsubQueueChange = undefined;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  claimingRunIds.clear();
  claimingEmployeeIds.clear();
  initialized = false;
}

/**
 * Boot: read the recorded state and drive from what really exists. A run that was mid-launch is reconciled by its
 * own step (adopt the run it started, or report the unknown outcome). Nothing is replayed from memory, and a stop
 * that was active stays active. Queued tasks resume in persisted Kanban urgency + rank order.
 */
export function recoverHandsoff(): number {
  const emergency = autonomyPolicyStore.readEmergency().active;
  let count = 0;
  const projectsToSchedule = new Set<string>();
  for (const run of handsoffStore.listOpenRuns()) {
    count += 1;
    if (emergency && run.status !== "stopped") { const next = save(run, { status: "stopped", blocker: null }); note(next, "stopped", "Emergency Stop was active at start. Nothing new will start."); continue; }
    if (run.status === "active" || run.status === "waiting") projectsToSchedule.add(run.projectPath);
  }
  for (const p of [...projectsToSchedule].sort()) void scheduleProject(p);
  return count;
}

/** Machine-readable facts for the webview: the open run, or the latest finished one, with its history. */
export function handsoffView(taskId: string) {
  const run = handsoffStore.openRunForTask(taskId) ?? handsoffStore.latestRunForTask(taskId);
  return { run, events: run ? handsoffStore.listEvents({ runId: run.id }, 60) : [] };
}

export { accountKey };
