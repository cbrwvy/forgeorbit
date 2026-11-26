import { quotaFact, type QuotaFactKind } from "../shared/accounts/availability.ts";
import { selectedCodexAccount } from "./codex-profiles.ts";
import { accountResourceEvidence } from "./account-resource-evidence.ts";
import { PROVIDER_REFUSAL_PREFLIGHT_WARNING } from "../shared/provider-refusal.ts";
import { currentReadScope } from "./codex-read-scope.ts";
import { supervisedRunLimitSeconds } from "./supervised-run-limit.ts";
import { DEEPSEEK_INSTALLATION_ID } from "../shared/harness-installation.ts";
import { DEEPSEEK_EXECUTION_BLOCKER } from "./deepseek-execution-policy.ts";
/**
 * Employee execution preflight (FO-010E1).
 *
 * Reads current server state and describes a FUTURE run of an assigned task.
 * It writes nothing: no run, task, assignment, employee, account or quota
 * row. It probes only local Git metadata for permissions, never an AI CLI or provider, switches no account,
 * and never opens auth credential files. A result is a snapshot, not a permission.
 */

import { employeeConfig } from "./execution-selection.ts";
import { workspacePermissionIdentity, detectWorkspaceLayoutNow, type DetectedLayout } from "./execution-layout.ts";
import { getTaskWorkspace, permissionSubject } from "./task-workspace.ts";
import { isWorkspaceDevelopmentEnabled } from "./project-permissions.ts";
import { describePermissions } from "../shared/execution/permissions.ts";
import { diagnoseTaskLaunchNow } from "./launch-diagnostics.ts";
import { createHash } from "node:crypto";
import { AGENT_OPTIONS, supportedEfforts, supportedModes, type AgentKind, type Harness, type Task } from "../shared/types.ts";
import { columnBlockReason } from "../shared/project-execution.ts";
import { currentFact, routeTask } from "../shared/model-router/route.ts";
import type { CandidateAssessment, OwnerRoutingConstraints, ResourceCandidate, RoutingSnapshot } from "../shared/model-router/types.ts";
import {
  EXECUTION_START_CONTRACT,
  PREFLIGHT_BANNER,
  PREFLIGHT_VALID_MS,
  classifyHarnessEvidence,
  nextActionFor,
  parsePreflightRequest,
  type EvidenceState,
  type PreflightAccountState,
  type PreflightHarnessOption,
  type PreflightHarnessSelection,
  type PreflightIssue,
  type PreflightModelEvidence,
  type PreflightQuotaState,
  type PreflightResult,
} from "../shared/execution/preflight.ts";
import type { ExecutorPreferences } from "../shared/execution/executor-routing.ts";
import { db, harnesses, projects, tasks } from "./db.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";
import { AccountCore } from "./account-core.ts";
import { assessmentsFor, decideEligibility, evaluateResourceEligibility, withExecutorPreferences } from "./resource-eligibility.ts";

export { decideEligibility, evaluateResourceEligibility, withExecutorPreferences };
export type { ResourceEligibility } from "./resource-eligibility.ts";
import { dependencyGateFor } from "./dependency-gate.ts";
import { taskAvailabilityFor } from "./task-availability.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { buildRoutingSnapshot, projectRoutingInput, RoutingInputError } from "./model-router.ts";
import { ownershipOf, verifyLaunchScope, type TaskOwnership } from "./project-ownership.ts";
import { isTaskRunLive } from "./orchestrator.ts";
import { isExecutionStarting } from "./project-execution.ts";

export class PreflightError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PreflightError";
  }
}

export interface PreflightDeps {
  now?: () => number;
  classify?: (workdir: string) => TaskOwnership;
  isLive?: (taskId: string) => boolean;
  isStarting?: (taskId: string) => boolean;
  snapshot?: () => RoutingSnapshot;
  /** Test seam: replaces the saved Owner restrictions the router would see. */
  owner?: (saved: OwnerRoutingConstraints) => OwnerRoutingConstraints;
  /** Test seam: replaces the saved executor-routing preferences. */
  preferences?: () => ExecutorPreferences;
}

interface EmployeeRow {
  id: string;
  kind: string;
  name: string;
  job_title: string;
  project_path: string | null;
  status: string;
  archived_at: number | null;
}

const issue = (code: string, message: string): PreflightIssue => ({ code, message });
const unique = (items: string[]) => [...new Set(items)];

function accountState(
  harnessId: string,
  candidates: readonly ResourceCandidate[],
  snapshot: RoutingSnapshot,
  profileId: string | null,
  now: number,
): PreflightAccountState {
  // Display metadata only. The external identity field may hold an email and is never returned.
  const view = (id: string) => {
    const a = snapshot.accounts.find((x) => x.id === id);
    return a ? [{ id: a.id, displayName: a.displayName, provider: a.provider, verification: a.verification, availability: a.availability }] : [];
  };
  // AccountCore names an execution account only through an explicit profile association.
  // Never by email, plan, display name, or "the only bound account".
  const identity = new AccountCore(db, () => now).resolveIdentity(harnessId, profileId);
  if (identity.accountId) {
    const accounts = view(identity.accountId);
    const authorized = candidates.find((c) => c.accountId === identity.accountId)?.authorization;
    const verified = identity.verification === "verified" && authorized != null && currentFact(authorized, now) && authorized.value;
    return verified
      ? { state: "identified-verified", label: "The account is identified and its CLI authorization is verified.", accounts }
      : { state: "identified-unverified", label: "The account is identified by an agent-profile association. Its CLI authorization is not verified.", accounts };
  }
  const possible = unique(candidates.flatMap((c) => (c.accountId ? [c.accountId] : []))).flatMap(view);
  const detail = possible.length === 0
    ? "no account is bound to this harness"
    : `${possible.length} registry account${possible.length === 1 ? " is" : "s are"} bound, but none is selected`;
  return { state: "unknown", label: `Account Unknown — ${detail}. Nothing is switched.`, accounts: possible };
}

const FACT_ORDER: QuotaFactKind[] = ["verified", "owner-reported", "observed", "historical", "conflict", "unknown"];

function quotaState(assessments: readonly CandidateAssessment[], now: number): PreflightQuotaState {
  const byId = new Map<string, PreflightQuotaState["quotas"][number] & { current: boolean }>();
  for (const a of assessments) {
    for (const q of a.quotaEvidence) {
      byId.set(q.definition.id, {
        id: q.definition.id,
        status: q.status,
        verification: q.current?.verification ?? null,
        fact: quotaFact(q, now).kind,
        // A current verified meter with no remaining count is not capacity.
        current: q.status === "current" && q.current?.verification === "verified" && q.current.remaining !== null,
      });
    }
  }
  const quotas = [...byId.values()].map(({ current: _current, ...rest }) => rest);
  const facts = FACT_ORDER.filter((k) => quotas.some((q) => q.fact === k));
  if (quotas.length === 0) return { state: "unknown", label: "Quota Unknown — no quota evidence is registered.", quotas, facts };
  const rows = [...byId.values()];
  if (rows.some((q) => q.status === "conflict")) return { state: "conflicting", label: "Quota evidence conflicts. Nothing is refreshed.", quotas, facts };
  if (rows.every((q) => q.current)) return { state: "verified", label: "Quota evidence is current and verified.", quotas, facts };
  if (rows.some((q) => q.status === "stale")) return { state: "stale", label: "Quota evidence is stale. Nothing is refreshed here.", quotas, facts };
  return { state: "unknown", label: "Quota Unknown — evidence is missing or unverified.", quotas, facts };
}

function modelEvidence(candidates: readonly ResourceCandidate[], requested: string | null, now: number): PreflightModelEvidence {
  const rows = candidates
    .filter((c) => requested === null || c.modelId === requested)
    .map((c) => ({
      modelId: c.modelId,
      support: c.support?.support ?? "unknown",
      verification: c.support && c.support.verification === "verified" && c.support.expiresAt !== null && c.support.expiresAt > now
        ? "verified" : "unverified",
    }));
  if (rows.length === 0 || rows.every((r) => r.support === "unknown" || r.verification !== "verified")) {
    return { state: "unknown", label: "Model capability Unknown — support is not verified.", models: rows };
  }
  if (rows.some((r) => r.support === "unsupported")) return { state: "unsupported", label: "Model is confirmed unsupported.", models: rows };
  return { state: "supported", label: "Model support is verified.", models: rows };
}


function readEmployee(id: string): EmployeeRow | null {
  return db.query<EmployeeRow, [string]>(
    `SELECT id, kind, name, job_title, project_path, status, archived_at FROM ai_employees WHERE id = ?`,
  ).get(id) ?? null;
}

/** Read one consistent view and describe the proposed run. Writes nothing. */
export function prepareEmployeeExecution(raw: unknown, deps: PreflightDeps = {}): PreflightResult {
  let request;
  try {
    request = parsePreflightRequest(raw);
  } catch (message) {
    throw new PreflightError(typeof message === "string" ? message : "Invalid request.");
  }
  return db.transaction(() => build(request, deps))();
}

function build(request: ReturnType<typeof parsePreflightRequest>, deps: PreflightDeps): PreflightResult {
  const now = (deps.now ?? Date.now)();
  const task = tasks.get(request.taskId);
  if (!task) throw new PreflightError("Task not found.", 404);
  const prefs = (deps.preferences ?? loadExecutorPreferences)();
  const layoutCache = new Map<string, DetectedLayout>();
  const detectLayoutCached = (subject: Pick<Task, "isolation" | "workdir" | "worktreePath">): DetectedLayout => {
    const key = `${subject.isolation}\0${subject.workdir}\0${subject.worktreePath ?? ""}`;
    let hit = layoutCache.get(key);
    if (!hit) {
      hit = detectWorkspaceLayoutNow(subject);
      layoutCache.set(key, hit);
    }
    return hit;
  };

  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  const classify = deps.classify ?? ((workdir: string) => ownershipOf(workdir, { fresh: true }));

  // Task state.
  if (task.pipelineParentId) errors.push(issue("task-pipeline-step", "This is a step of a pipeline run. Prepare the pipeline task instead."));
  if (task.archivedAt != null) errors.push(issue("task-archived", "This task is archived."));
  const live = (deps.isLive ?? isTaskRunLive)(task.id) || task.pipelineRun?.status === "running";
  if (live) errors.push(issue("task-running", "This task already has a live run."));
  else {
    const column = columnBlockReason(task.column);
    if (column) errors.push(issue("task-column", column));
  }
  if ((deps.isStarting ?? isExecutionStarting)(task.id)) {
    errors.push(issue("execution-starting", "A supervised start is already in progress for this task."));
  }

  // A worktree-isolated task in a folder that is not a Git repository can never run. Say so now, in the same words the
  // launch review uses, instead of letting Prepare succeed and the review refuse later. An armed task workspace
  // (isolation none) is judged by its own folder through `permissionSubject`.
  if (task.isolation === "worktree") {
    const detected = detectLayoutCached(permissionSubject(task));
    if (detected.predicted && detected.layout === "non-git") {
      errors.push(issue("worktree-unavailable", "This task requires a Git worktree, but its folder is not a Git repository. Isolation is fixed at task creation; create a separately reviewed task with a supported isolation mode. Nothing will run in the project folder as a fallback."));
    }
  }

  // Prerequisites: Done only. A deleted one keeps blocking (FO-ORCH05).
  for (const reason of dependencyGateFor(task).reasons) {
    errors.push(issue(reason.code === "deleted" ? "dependency-deleted" : "dependency-not-done", reason.message));
  }

  // Scheduled availability (FO-KANBAN-SCHEDULE01): earliest UTC start restriction.
  const availability = taskAvailabilityFor(task);
  if (!availability.available) {
    errors.push(issue("scheduled-not-yet-available", `Task is scheduled to be available from ${availability.availableFromUtc}. Waiting for scheduled time.`));
  }

  // Ownership: one registered project, decided now.
  let projectPath: string | null = null;
  let via = "";
  let ownership: TaskOwnership | null = null;
  try {
    ownership = classify(task.workdir);
  } catch {
    ownership = { kind: "unattributed", reason: "invalid" };
  }
  if (ownership.kind === "owned") {
    projectPath = ownership.projectPath;
    via = ownership.via;
    const scope = verifyLaunchScope(task, projectPath);
    if (!scope.ok && scope.code !== "pipeline-step") {
      errors.push(issue(scope.code === "task-outside-project" ? "task-other-project" : scope.code, scope.reason));
    }
  } else if (ownership.kind === "ambiguous") {
    errors.push(issue("ownership-ambiguous", `The task's folder can't be attributed to one project: ${ownership.reason}`));
  } else {
    errors.push(ownership.reason === "symlink-escape"
      ? issue("symlink-escape", "The task's folder resolves outside the project through a symlink.")
      : issue("task-outside-project", "The task's folder is not part of a registered project."));
  }
  const project = projectPath ? projects.get(projectPath) : null;
  if (projectPath && !project) errors.push(issue("project-unregistered", "The task's project is no longer registered."));

  // Assignment and employee.
  let assignment: PreflightResult["assignment"] = null;
  let employee: PreflightResult["employee"] = null;
  let assignmentRow: ReturnType<AssignmentCore["forTask"]> = null;
  try {
    assignmentRow = new AssignmentCore(db).forTask(task.id);
  } catch {
    assignmentRow = null;
  }
  if (!assignmentRow) {
    errors.push(issue("no-assignment", "No worker is assigned to this task. Preflight does not assign anyone."));
    if (request.expectedAssignmentRevision !== null) {
      errors.push(issue("stale-assignment", "The assignment you reviewed no longer exists."));
    }
  } else {
    assignment = { id: assignmentRow.id, revision: assignmentRow.revision, assignedAt: assignmentRow.assignedAt };
    if (request.expectedAssignmentRevision !== null && request.expectedAssignmentRevision !== assignmentRow.revision) {
      errors.push(issue("stale-assignment", `The assignment changed (revision ${request.expectedAssignmentRevision} → ${assignmentRow.revision}). Review it and prepare again.`));
    }
    if (projectPath && assignmentRow.projectPath !== projectPath) {
      errors.push(issue("assignment-project-diverged", "The task is no longer in the project it was assigned from."));
    }
    const person = readEmployee(assignmentRow.employeeId);
    if (!person) errors.push(issue("employee-missing", "The assigned employee no longer exists."));
    else {
      employee = { id: person.id, name: person.name, jobTitle: person.job_title, kind: person.kind, status: person.status };
      if (person.kind !== "worker") errors.push(issue("employee-not-worker", "Only a worker can be prepared for a task."));
      if (person.archived_at != null || person.status === "archived") errors.push(issue("employee-archived", "The assigned employee is archived."));
      else if (person.status !== "active") errors.push(issue("employee-inactive", "The assigned employee is not active."));
      if (!person.project_path || (projectPath && person.project_path !== projectPath)) {
        errors.push(issue("employee-other-project", "The assigned employee does not belong to the task's project."));
      } else if (!projects.get(person.project_path)) {
        errors.push(issue("project-unregistered", "The employee's project is no longer registered."));
      }
    }
  }

  // Resources: registered local harnesses, judged by the existing router.
  const registered = harnesses.list();
  let snapshot: RoutingSnapshot | null = null;
  let preview: ReturnType<typeof routeTask> | null = null;
  let owner: OwnerRoutingConstraints = {
    allowedHarnesses: null, allowedAccounts: null, spending: null, maxExpectedCost: null,
    globalConcurrency: null, projectPriority: null, requiredApprovals: ["Owner must approve any future execution."],
  };
  if (projectPath && project) {
    try {
      const built = projectRoutingInput(projectPath, task.id, request.complexity ? { complexity: request.complexity } : {});
      owner = withExecutorPreferences(deps.owner ? deps.owner(built.owner) : built.owner, prefs);
      snapshot = deps.snapshot ? deps.snapshot() : buildRoutingSnapshot(db, now);
      preview = routeTask(built.requirements, snapshot, request.policy, owner);
    } catch (error) {
      const message = error instanceof RoutingInputError ? error.message : "Routing evidence could not be read.";
      errors.push(issue("routing-input-unavailable", message));
    }
  }
  const assessments = preview ? assessmentsFor(preview) : [];
  const recommended = preview?.recommendedCandidate ?? null;

  const options: PreflightHarnessOption[] = registered.map((h) => optionFor(h, snapshot, assessments, recommended, now));
  const chosen = request.harnessId ? registered.find((h) => h.id === request.harnessId) ?? null : null;
  let selection: PreflightHarnessSelection | null = null;
  if (request.harnessId && !chosen) errors.push(issue("unknown-harness", "That harness is not registered on this machine."));
  if (request.harnessId === DEEPSEEK_INSTALLATION_ID) errors.push(issue("deepseek-policy-unsupported", DEEPSEEK_EXECUTION_BLOCKER));
  if (chosen) {
    try { if (chosen.kind === "codex") selectedCodexAccount(chosen); }
    catch { errors.push(issue("codex-profile-unavailable", "Selected Codex account profile is unavailable. No fallback.")); }
    const option = options.find((o) => o.harnessId === chosen.id)!;
    const mine = snapshot ? snapshot.candidates.filter((c) => c.harnessId === chosen.id) : [];
    const myAssessments = assessments.filter((a) => a.candidate.harnessId === chosen.id);
    const launching = employeeConfig(task, chosen, request, prefs).model;
    const named = myAssessments.filter((a) => a.candidate.modelId === launching);
    const focused = named.length > 0 ? named : myAssessments;
    selection = {
      ...option,
      account: accountState(chosen.id, mine, snapshot ?? EMPTY_SNAPSHOT, task.agentProfileId ?? null, now),
      quota: quotaState(focused, now),
      model: modelEvidence(mine, launching, now),
      missingEvidence: unique(focused.flatMap((a) => a.unknowns)),
      conflicts: unique(focused.flatMap((a) => a.conflicts)),
      provenance: unique(focused.flatMap((a) => a.provenance)),
    };
    if (!chosen.enabled) errors.push(issue("harness-disabled", "This harness is disabled in Settings."));
    else if (option.evidence === "blocked") {
      const reasons = unique(myAssessments.flatMap((a) => a.reasons));
      const ownerBlock = reasons.some((r) => /^Owner /.test(r));
      errors.push(issue(ownerBlock ? "owner-policy" : "resource-excluded", reasons.join(" ") || "Existing restrictions exclude this resource."));
    }
    // Owner preferences are prohibitions: choosing the model or harness by hand cannot waive them.
    if (prefs.forbiddenModels.includes(launching ?? "")) {
      selection.evidence = "blocked";
      errors.push(issue("owner-model-forbidden", `Your preferences forbid the model "${launching}".`));
    }
    if (prefs.requiredMode && !supportedModes(chosen.kind, launching).some((m) => m.id === prefs.requiredMode)) {
      errors.push(issue("required-mode-unsupported", `This harness and model do not offer the permission mode your preferences require ("${prefs.requiredMode}").`));
    }
    if (request.model !== null) {
      const known = new Set([...mine.flatMap((c) => (c.modelId ? [c.modelId] : [])), ...(AGENT_OPTIONS[chosen.kind]?.models ?? []).map((m) => m.id)]);
      if (!known.has(request.model)) errors.push(issue("unknown-model", "That model is not offered for this harness."));
    }
    if (request.effort !== null) {
      const allowed = supportedEfforts(chosen.kind as AgentKind, request.model ?? null).map((e) => e.id);
      if (!allowed.includes(request.effort)) errors.push(issue("unsupported-effort", "That effort is not offered for this harness and model."));
    }
    // Unknown, stale and percent-only evidence stay warnings. A launch model whose
    // every router assessment is excluded (exhausted quota, Owner ban, unavailable
    // account, confirmed unsupported model) is a prohibition and cannot be
    // waived by choosing it, or by leaving the model blank so the default launches.
    const excludedNamed = named.filter((a) => a.status === "excluded");
    if (named.length > 0 && excludedNamed.length === named.length) {
      selection.evidence = "blocked";
      if (!errors.some((e) => e.code === "harness-disabled" || e.code === "owner-policy" || e.code === "resource-excluded")) {
        const reasons = unique(excludedNamed.flatMap((a) => a.reasons));
        const ownerBlock = reasons.some((r) => /^Owner /.test(r));
        errors.push(issue(ownerBlock ? "owner-policy" : "resource-excluded", reasons.join(" ") || "Existing restrictions exclude this model."));
      }
    } else if (excludedNamed.length > 0) {
      const reasons = unique(excludedNamed.flatMap((a) => a.reasons));
      warnings.push(issue("resource-excluded", reasons.join(" ")));
    }
    // The shared decision (also used for every batch start): additionally narrows to the
    // account a profile association identifies, so that account's exhaustion blocks it
    // even when another registry account would not be.
    const shared = decideEligibility({
      harness: chosen,
      model: launching,
      owner,
      assessments,
      identityAccountId: new AccountCore(db, () => now).resolveIdentity(chosen.id, task.agentProfileId ?? null).accountId,
      snapshot: snapshot ?? EMPTY_SNAPSHOT,
      now,
    });
    if (shared.blocked) {
      selection.evidence = "blocked";
      if (!errors.some((e) => e.code === "harness-disabled" || e.code === "owner-policy" || e.code === "resource-excluded")) {
        errors.push(issue(shared.code!, shared.reasons.join(" ")));
      }
    }
    if (chosen.id !== task.agent) {
      warnings.push(issue("harness-differs-from-task", `This task is configured for "${task.agent}". Using "${chosen.label}" would change the task at start time. Preflight changes nothing.`));
    }
    if ((option.evidence === "unknown" || option.evidence === "conditional") && selection.evidence !== "blocked") {
      warnings.push(issue("evidence-" + option.evidence, `${option.evidence === "unknown" ? "Unknown" : "Conditional"} evidence for this harness. It is not confirmed ready or available.`));
    }
    if (option.evidence === "conflicting") warnings.push(issue("evidence-conflicting", "Evidence for this harness conflicts."));
    // A refusal the provider gave for exactly this account and model. It is an observation: it never
    // blocks a launch the Owner chooses, but the preflight must not call this resource ready.
    const refused = accountResourceEvidence(chosen, task, launching ?? "", employeeConfig(task, chosen, request, prefs).mode, "developer", [], now).providerRefusal;
    selection.providerRefusal = refused ?? null;
    if (refused) {
      warnings.push(issue("provider-usage-limit-refused", PROVIDER_REFUSAL_PREFLIGHT_WARNING));
      if (selection.evidence === "verified") selection.evidence = "conditional";
    }
    if (selection.account.state !== "identified-verified") warnings.push(issue("account-unverified", selection.account.label));
    if (selection.quota.state !== "verified") warnings.push(issue("quota-unverified", selection.quota.label));
    if (selection.model.state !== "supported") warnings.push(issue("model-unverified", selection.model.label));
  }
  if (!snapshot && projectPath && project) {
    // Router unavailable: registered harnesses stay selectable but are never shown as verified.
  }

  const effectiveMode = chosen ? employeeConfig(task, chosen, request, prefs).mode : (task.mode ?? "");
  const effectiveReadScope = (task.accessMode ?? "workspace") === "isolated" ? "restricted" : currentReadScope();
  const subject = permissionSubject(task);
  const hasArmedStaging = subject.workdir !== task.workdir;
  const openWorkspace = hasArmedStaging ? getTaskWorkspace(task.id) : null;
  const workingCopyDev = Boolean(
    projectPath && project && isWorkspaceDevelopmentEnabled(projectPath)
    && (task.accessMode ?? "workspace") === "workspace"
    && !task.pipelineId && !task.pipelineParentId && !task.worktreePath,
  );
  const codexWorkingCopy = workingCopyDev || openWorkspace?.writeScope === "working-copy";
  const layoutForPermission = !hasArmedStaging && workingCopyDev
    ? { layout: "non-git" as const, predicted: true }
    : detectLayoutCached(subject);
  const permission = chosen?.kind === "codex"
    ? describePermissions({
      kind: chosen.kind,
      mode: effectiveMode,
      ...layoutForPermission,
      readScope: effectiveReadScope,
      timeLimitSeconds: supervisedRunLimitSeconds(),
      workingCopy: codexWorkingCopy,
    })
    : null;
  if (permission?.launchAllowed === false) errors.push(issue("permission-owner-decision", permission.blockReason!));
  const accessDiagnostics = diagnoseTaskLaunchNow(task, {
    harnessId: chosen?.id ?? task.agent,
    mode: effectiveMode,
    detectLayout: detectLayoutCached,
  });
  if (!accessDiagnostics.launchAllowed && accessDiagnostics.blockReason) {
    const alreadyBlockedByCodex = accessDiagnostics.accessMode === "workspace"
      && chosen?.kind === "codex"
      && permission?.launchAllowed === false;
    if (!alreadyBlockedByCodex) errors.push(issue("access-mode-blocked", accessDiagnostics.blockReason));
  }
  const outcome: PreflightResult["outcome"] = errors.length > 0 ? "blocked" : request.harnessId ? "prepared" : "selection-needed";
  const missingEvidence = selection ? selection.missingEvidence : (preview?.unknownInformation ?? []);
  const result: PreflightResult = {
    permission,
    accessDiagnostics,
    readOnly: true,
    executionAvailable: false,
    banner: PREFLIGHT_BANNER,
    outcome,
    taskId: task.id,
    task: { title: task.title, column: task.column, agent: task.agent, mode: task.mode ?? null },
    canonicalProject: projectPath ? { path: projectPath, name: project?.name ?? null, via } : null,
    employee,
    assignment,
    requested: { harnessId: request.harnessId, model: request.model, effort: request.effort, complexity: request.complexity },
    harnessOptions: options,
    selection,
    routerRecommendation: recommendedView(preview, recommended),
    ownerRestrictions: {
      spending: owner.spending,
      maxExpectedCost: owner.maxExpectedCost ? { ...owner.maxExpectedCost } : null,
      allowedHarnesses: owner.allowedHarnesses,
      allowedAccounts: owner.allowedAccounts,
      requiredApprovals: [...owner.requiredApprovals],
      forbiddenModels: [...prefs.forbiddenModels],
      requiredMode: prefs.requiredMode,
    },
    executionMode: {
      taskMode: task.mode ?? null,
      taskHarness: task.agent,
      note: "The mode comes from the task. Preflight does not change it or grant any permission.",
    },
    missingEvidence,
    warnings,
    blockingErrors: errors,
    capturedAt: now,
    validUntil: now + PREFLIGHT_VALID_MS,
    stateKey: "",
    proposedNextAction: { code: "", text: "" },
    startContract: EXECUTION_START_CONTRACT,
  };
  result.proposedNextAction = nextActionFor(result);
  result.stateKey = stateKeyOf(task, result, codexWorkingCopy);
  return result;
}

const EMPTY_SNAPSHOT: RoutingSnapshot = {
  capturedAt: 0, candidates: [], accounts: [], bindings: [], subscriptions: [], subscriptionLinks: [],
  quotas: [], limits: [], occupancyComplete: false,
};

function optionFor(
  harness: Harness,
  snapshot: RoutingSnapshot | null,
  assessments: readonly CandidateAssessment[],
  recommended: CandidateAssessment | null,
  now: number,
): PreflightHarnessOption {
  const mine = assessments.filter((a) => a.candidate.harnessId === harness.id);
  const candidates = snapshot ? snapshot.candidates.filter((c) => c.harnessId === harness.id) : [];
  const evidence: EvidenceState = snapshot ? classifyHarnessEvidence(harness.enabled, mine, candidates, now) : harness.enabled ? "unknown" : "blocked";
  const why: string[] = [];
  if (recommended?.candidate.harnessId !== harness.id) {
    if (!harness.enabled) why.push("Harness is disabled.");
    if (!snapshot) why.push("Routing evidence is unavailable.");
    for (const a of mine) why.push(...a.reasons.filter((r) => !r.startsWith("All required")), ...a.unknowns);
    if (recommended && mine.some((a) => a.status === "verified")) why.push("Another verified candidate was ranked higher or the policy could not separate them.");
    if (!mine.length && snapshot && harness.enabled) why.push("The router found no candidate for this harness.");
  }
  return { harnessId: harness.id, kind: harness.kind, label: harness.label, enabled: harness.enabled, evidence, notRecommendedBecause: unique(why) };
}

function recommendedView(preview: ReturnType<typeof routeTask> | null, best: CandidateAssessment | null): PreflightResult["routerRecommendation"] {
  const note = "Reference only. A recommendation is not permission to run and is never stored as the model that was used.";
  if (!preview) return { status: "no-verified-candidate", harnessId: null, modelId: null, accountId: null, note: "No routing preview is available." };
  return {
    status: preview.status,
    harnessId: best?.candidate.harnessId ?? null,
    modelId: best?.candidate.modelId ?? null,
    accountId: best?.candidate.accountId ?? null,
    note,
  };
}

function stateKeyOf(task: Task, result: PreflightResult, workingCopy = false): string {
  const facts = [
    task.id, task.column, task.updatedAt, task.archivedAt, result.canonicalProject?.path ?? null,
    result.employee ? [result.employee.id, result.employee.status, result.employee.kind] : null,
    result.assignment ? [result.assignment.id, result.assignment.revision] : null,
    result.requested, result.selection?.evidence ?? null, result.blockingErrors.map((e) => e.code),
    result.permission ?? null, result.permission ? workspacePermissionIdentity(permissionSubject(task), harnesses.getByIdOrKind(result.requested.harnessId ?? task.agent) ?? undefined) : null,
    ...(workingCopy ? ["working-copy"] : []),
  ];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}
