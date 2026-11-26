/**
 * Supervised task execution from the project manager (FO-005B).
 *
 * The manager never runs a developer agent on its own. The owner picks a
 * backlog task and presses Execute (or the manager suggests a run in a
 * reply); this module turns that into an execution proposal: the
 * configuration the task would run with, checked against what really
 * exists on this machine (harness enabled, installed, logged in, model
 * offered, CLI version, profile, pipeline, workspace, billing). Nothing
 * runs until the owner approves that exact proposal.
 *
 * Approval writes the reviewed configuration onto the task (the same fields
 * the task's own settings edit) and calls the board's `startTask` — the
 * one task runtime. No second runner, worktree or tmux lifecycle exists
 * here. `startTask`'s own claim (`startingTaskIds`) still refuses a second
 * start from the board, and this module adds two more guards on top: an
 * in-memory claim per proposal and per task taken before the first await,
 * and a unique index (migration 071) allowing one open proposal per task.
 *
 * Run progress is never copied into the proposal. `ExecutionLive` is read
 * from the task and run rows each time a view is built, so the Manager tab
 * can't disagree with the board or the Run Panel.
 */

import { currentReadScope } from "./codex-read-scope.ts";
import { isProductionOwnerGateActive } from "./owner-trust/launch-gate.ts";
import { supervisedRunLimitSeconds } from "./supervised-run-limit.ts";
import { describePermissions, permissionSummary } from "../shared/execution/permissions.ts";
import { diagnoseTaskLaunch } from "./launch-diagnostics.ts";
import { dependencyGateFor } from "./dependency-gate.ts";
import { taskAvailabilityRefusal } from "./task-availability.ts";
import { workspacePermissionIdentity, detectWorkspaceLayout } from "./execution-layout.ts";
import { getTaskWorkspace, permissionSubject } from "./task-workspace.ts";
import { isWorkspaceDevelopmentEnabled } from "./project-permissions.ts";
import { existsSync } from "node:fs";
import { checkHarness } from "./agent-status.ts";
import { describeLaunchTarget } from "./launch-target.ts";
import { agentDriverIsFake } from "./agents.ts";
import { cursorRealExecutionBlock } from "../shared/provider-readiness.ts";
import { parseCliVersion } from "../shared/cli-version.ts";
import type { LaunchTargetFacts } from "../shared/provider-launch-target.ts";
import { configuredClaudeQaAuthHome, claudeQaHomeAccessAccepted } from "./claude-auth-compat.ts";
import { getDiscoveredEfforts, getDiscoveredModels, getHarnessDiscoveredModels } from "./agent-discovery.ts";
import { agentProfiles, harnesses, pipelines, projectExecutions, projectManagers, runs, tasks } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import {
  cancelRun,
  defaultEffortFor,
  isTaskRunLive,
  minCliVersionError,
  moveTaskColumn,
  reconcileTaskSession,
  sendInput,
  startTask,
} from "./orchestrator.ts";
import { cancelPipelineRun, initialPipelineRunState } from "./pipeline-runner.ts";
import { getTaskDiff, gitWorkingTreeCapability } from "./worktree.ts";
import { projectTasks, taskInProject, verifyLaunchScope } from "./project-ownership.ts";
import { checkProjectLaunchAdmission, registerProjectLifecycleStartingReconciler } from "./project-lifecycle.ts";
import { configEligibility, eligibilityRefusal } from "./resource-eligibility.ts";
import { acknowledgeQcOwnerReview, assertCanMoveTaskToDone } from "./task-quality-control.ts";
import { snapshotFromProfile } from "../shared/agent-profile.ts";
import { mergeModelOptions } from "../shared/model-options.ts";
import { resolveStartStep } from "../shared/pipeline.ts";
import { ensureBaselineEstimate } from "./usage-analytics/forecast.ts";
import { promptByteOverage } from "../shared/prompt-limits.ts";
import { capText, redactSecrets } from "../shared/project-interview.ts";
import {
  EXECUTION_LIMITS,
  appendEvent,
  columnBlockReason,
  executionPhase,
  hasBlockingCheck,
  modeAccessLevel,
  modeLabel,
  sameConfig,
  sanitizeStoredExecution,
  taskFingerprint,
  usageNoticeFor,
  type ExecutionCatalog,
  type ExecutionCheck,
  type ExecutionConfig,
  type ExecutionLive,
  type ExecutionProposal,
  type ExecutionResolved,
  type ExecutionResult,
  type ExecutionRunSummary,
  type ExecutionSuggestion,
  type ExecutionView,
} from "../shared/project-execution.ts";
import { MANAGER_LIMITS, type ManagerMessage } from "../shared/project-manager.ts";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  DEFAULT_MODEL,
  defaultModeFor,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type Harness,
  type HarnessStatus,
  type Run,
  type Task,
} from "../shared/types.ts";

export type ExecutionResultOf<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

function fail<T>(status: number, error: string, body?: Record<string, unknown>): ExecutionResultOf<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

function registered(rawPath: unknown): ExecutionResultOf<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

/** Injected in tests; production uses the real probes and runtime. */
export interface ExecutionDeps {
  checkHarness?: (harness: Harness, opts?: { freshAuth?: boolean }) => Promise<HarnessStatus>;
  startTask?: typeof startTask;
  /** Environment variable names visible to a spawned agent (names only). */
  envNames?: () => string[];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Storage.
 * ────────────────────────────────────────────────────────────────────────── */

function parse(raw: string | null): ExecutionProposal | null {
  if (raw == null) return null;
  try {
    return sanitizeStoredExecution(JSON.parse(raw));
  } catch {
    return null;
  }
}

function save(proposal: ExecutionProposal): void {
  projectExecutions.put({
    id: proposal.id,
    projectPath: proposal.projectPath,
    taskId: proposal.taskId,
    status: proposal.status,
    runId: proposal.runId,
    data: JSON.stringify(proposal),
    createdAt: proposal.createdAt,
  });
}

/** The open proposal for a task. A failed start of a batch's own launch is
 *  not open here: the batch retries it, not the Execute flow. */
function openProposal(projectPath: string, taskId: string): ExecutionProposal | null {
  const open = parse(projectExecutions.openForTask(projectPath, taskId));
  if (open && (open.source === "batch" || open.source === "employee") && open.status === "start-failed") return null;
  return open;
}

function load(projectPath: string, id: string): ExecutionProposal | null {
  const proposal = parse(projectExecutions.get(projectPath, id));
  return proposal && proposal.projectPath === projectPath ? proposal : null;
}

function appendSystemMessage(projectPath: string, text: string, executionId: string | null): string {
  const message: ManagerMessage = {
    id: crypto.randomUUID(),
    role: "system",
    text,
    createdAt: Date.now(),
    status: null,
    error: null,
    plan: null,
    proposalId: null,
    executionId,
    proposalError: null,
    suggestedDecisions: [],
    sources: [],
  };
  projectManagers.appendMessage(projectPath, message.id, JSON.stringify(message), MANAGER_LIMITS.messagesKept);
  projectManagers.touch(projectPath);
  return message.id;
}

const BATCH_OWNED = "This run belongs to an execution batch. Retry or resume it from the batch.";
const EMPLOYEE_OWNED = "This run was started for an assigned employee. Follow it from the task's Employee Execution section.";
/** Rows another approval authority owns: this flow neither edits nor approves them. */
const ownedElsewhere = (proposal: ExecutionProposal): string | null =>
  proposal.source === "batch" ? BATCH_OWNED : proposal.source === "employee" ? EMPLOYEE_OWNED : null;

/* ────────────────────────────────────────────────────────────────────────── *
 * Claims (in memory, taken before the first await).
 * ────────────────────────────────────────────────────────────────────────── */

const startingExecutions = new Set<string>();
const startingTasks = new Set<string>();
/** Proposal creation per task, so two Execute clicks can't race the insert. */
const preparingTasks = new Set<string>();

/* ────────────────────────────────────────────────────────────────────────── *
 * Configuration.
 * ────────────────────────────────────────────────────────────────────────── */

function harnessOf(id: string): Harness | null {
  return harnesses.getByIdOrKind(id);
}

/** The configuration a task runs with today, unchanged. */
export function configFromTask(task: Task): ExecutionConfig {
  const kind = harnessOf(task.agent)?.kind ?? "claude-code";
  return {
    pipelineId: task.pipelineId ?? null,
    profileId: task.pipelineId ? null : task.agentProfileId ?? null,
    harness: task.agent,
    model: task.model ?? DEFAULT_MODEL[kind],
    effort: task.effort ?? null,
    mode: task.mode ?? defaultModeFor(kind),
    fast: task.fast,
    maxMode: task.maxMode,
  };
}

/**
 * Normalize a config: a pipeline wins over a profile, and a profile fills
 * the manual fields from its own values (mode null → the kind's default),
 * so the card always shows what will really run.
 */
export function normalizeConfig(config: ExecutionConfig): ExecutionConfig {
  if (config.pipelineId) {
    const pipeline = pipelines.get(config.pipelineId);
    const start = pipeline ? resolveStartStep(pipeline.graph) : null;
    const profile = start?.agentProfileId ? agentProfiles.get(start.agentProfileId) : null;
    if (profile) return { ...fromProfile(profile), pipelineId: config.pipelineId, profileId: null };
    return { ...config, profileId: null };
  }
  if (config.profileId) {
    const profile = agentProfiles.get(config.profileId);
    if (profile) return { ...fromProfile(profile), pipelineId: null, profileId: profile.id };
  }
  return config;
}

function fromProfile(profile: NonNullable<ReturnType<typeof agentProfiles.get>>): ExecutionConfig {
  const kind = harnessOf(profile.harness)?.kind ?? "claude-code";
  return {
    pipelineId: null,
    profileId: profile.id,
    harness: profile.harness,
    model: profile.model,
    effort: profile.effort,
    mode: profile.mode ?? defaultModeFor(kind),
    fast: profile.fast,
    maxMode: profile.maxMode,
  };
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? capText(text, max) : null;
}

/** Read a submitted config. Unknown fields are ignored. */
export function readConfig(value: unknown, base: ExecutionConfig): ExecutionConfig | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "config must be an object";
  const rec = value as Record<string, unknown>;
  const next: ExecutionConfig = { ...base };
  if ("pipelineId" in rec) next.pipelineId = str(rec.pipelineId, 200);
  if ("profileId" in rec) next.profileId = str(rec.profileId, 200);
  if ("harness" in rec) {
    const harness = str(rec.harness, 200);
    if (!harness) return "harness is required";
    next.harness = harness;
  }
  if ("model" in rec) {
    const model = str(rec.model, 200);
    if (!model) return "model is required";
    next.model = model;
  }
  if ("effort" in rec) next.effort = str(rec.effort, 100);
  if ("mode" in rec) {
    const mode = str(rec.mode, 100);
    if (!mode) return "mode is required";
    next.mode = mode;
  }
  if ("fast" in rec) next.fast = rec.fast === true;
  if ("maxMode" in rec) next.maxMode = rec.maxMode === true;
  if (next.pipelineId) next.profileId = null;
  return next;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Checks.
 * ────────────────────────────────────────────────────────────────────────── */

export interface Checked {
  checks: ExecutionCheck[];
  resolved: ExecutionResolved;
  usageNotice: string | null;
  fingerprint: string;
}

function check(level: ExecutionCheck["level"], code: string, message: string): ExecutionCheck {
  return { level, code, message: capText(message, EXECUTION_LIMITS.checkChars) };
}

function defaultEnvNames(): string[] {
  return Object.keys(process.env);
}

async function harnessChecks(
  harness: Harness,
  model: string,
  deps: ExecutionDeps,
  freshAuth: boolean,
  checks: ExecutionCheck[],
): Promise<HarnessStatus | null> {
  if (!harness.enabled) {
    checks.push(check("error", "harness-disabled", `${harness.label} is disabled. Enable it in Settings → Harnesses to run tasks on it.`));
    return null;
  }
  const probe = deps.checkHarness ?? checkHarness;
  let status: HarnessStatus;
  try {
    status = await probe(harness, { freshAuth });
  } catch (error) {
    checks.push(check("error", "harness-check-failed", `Couldn't check ${harness.label}: ${(error as Error).message}`));
    return null;
  }
  if (!status.available) {
    const hint = status.installHint ? ` Install it with: ${status.installHint}` : "";
    checks.push(check("error", "harness-unavailable", `${harness.label} is not available — ${status.reason}.${hint}`));
    return status;
  }
  if (status.loggedIn === false) {
    checks.push(check("error", "harness-logged-out", `${harness.label} isn't logged in — ${status.authHelp ?? "run its login command"}.`));
  }
  const floor = await minCliVersionError(harness, model, status);
  // One check, two reasons: the version parses below the floor, or it did not parse and the model needs one.
  if (floor) checks.push(check("error", parseCliVersion(status.version) === null ? "cli-version-unreadable" : "cli-too-old", floor));
  return status;
}

/**
 * The launch-target facts for the reviewed harness, and the checks they add (Direction 9). The
 * executable that is missing, a mode the harness does not offer, and a version that parses below the
 * model's floor already have their own checks above (`harness-unavailable`, `mode-unknown`,
 * `cli-too-old`); this adds only what no check said yet: a stale profile registration, a contract
 * block, and a version the floor needs but the probe could not read.
 */
function launchTargetChecks(
  harness: Harness,
  model: string,
  mode: string,
  status: HarnessStatus | null,
  checks: ExecutionCheck[],
): LaunchTargetFacts {
  const facts = describeLaunchTarget(harness, { model, mode, status, probed: status !== null && status.available });
  const fixture = agentDriverIsFake(harness.kind);
  switch (facts.code) {
    case "registration-stale":
      checks.push(check("error", "registration-stale", `${harness.label}'s registered profile is no longer valid (removed, disabled, or its folder was replaced). Register it again in Settings → Accounts, then review again. No other account is used instead.`));
      break;
    case "contract-blocked":
      checks.push(check(fixture ? "warning" : "error", "provider-contract-blocked", fixture
        ? `${harness.label} cannot run for real inside ForgeOrbit's sandbox. This is a recorded fixture run.`
        : cursorRealExecutionBlock()));
      break;
    case "version-unreadable":
      // A blocking unreadable version is already reported by `harnessChecks` (same sentence as the board's Run).
      // Only the recorded fixture, which `minCliVersionError` lets through, adds a warning here.
      if (facts.verdict !== "blocked") {
        checks.push(check("warning", "cli-version-unverified", `${harness.label}'s version could not be read from ${facts.executable.path ?? facts.executable.bin}. This is a recorded fixture run, so nothing queries the CLI.`));
      }
      break;
    case "version-prerelease-at-minimum":
      checks.push(check("warning", "cli-version-prerelease", `${harness.label} ${facts.version.parsed ?? ""} is a pre-release at the minimum ${facts.floor?.min ?? ""} for ${facts.floor?.model ?? model}. Whether it is accepted is unknown; it is not blocked.`));
      break;
    default:
      break;
  }
  return facts;
}

function modelChecks(harness: Harness, model: string, effort: string | null, status: HarnessStatus | null, checks: ExecutionCheck[]): string {
  const kind = harness.kind;
  const harnessModels = getHarnessDiscoveredModels(harness.id);
  const discovered = harnessModels.length > 0 ? harnessModels : getDiscoveredModels(kind);
  const options = mergeModelOptions({
    curated: AGENT_OPTIONS[kind].models,
    discovered,
    scoped: CATALOG_SCOPED_KINDS.has(kind),
    loggedIn: status?.loggedIn ?? null,
  });
  const listed = options.find((option) => option.id === model);
  if (!listed) {
    if (CATALOG_SCOPED_KINDS.has(kind) && discovered.length > 0 && status?.loggedIn !== false) {
      checks.push(check("error", "model-unavailable", `${model} isn't in ${harness.label}'s model list for this account. Pick another model.`));
    } else {
      checks.push(check("warning", "model-unlisted", `${model} isn't one of ${harness.label}'s known models. It will be passed to the CLI as typed; the CLI may reject it.`));
    }
  }
  const efforts = supportedEfforts(kind, model, getDiscoveredEfforts(kind, model, harness.id));
  if (effort && efforts.length > 0 && !efforts.some((option) => option.id === effort)) {
    checks.push(check("warning", "effort-unlisted", `Effort "${effort}" isn't listed for ${model}. The CLI may reject it.`));
  }
  if (effort && efforts.length === 0) {
    checks.push(check("info", "effort-ignored", `${model} has no effort setting; "${effort}" is ignored.`));
  }
  return listed?.label ?? model;
}

/**
 * Everything the owner should know before approving, read now. Errors
 * block approval; warnings are shown and must be seen (an approval refuses
 * a warning that wasn't on the reviewed card).
 */
export async function runChecks(
  projectPath: string,
  task: Task | null,
  config: ExecutionConfig,
  deps: ExecutionDeps,
  freshAuth = false,
  opts: { requireDependenciesDone?: boolean } = {},
): Promise<Checked> {
  const checks: ExecutionCheck[] = [];
  const resolved: ExecutionResolved = {
    harnessLabel: config.harness,
    harnessKind: null,
    modelLabel: config.model,
    modeLabel: config.mode,
    accessLevel: 3,
    profileName: null,
    pipelineName: null,
    pipelineSteps: [],
    workdir: task?.workdir ?? projectPath,
    isolation: task?.isolation ?? "worktree",
    workspace: task?.worktreePath ?? task?.workdir ?? projectPath,
    previousMode: null,
  };
  let usageNotice: string | null = null;
  if (!task) {
    checks.push(check("error", "task-missing", "This task no longer exists."));
    return { checks, resolved, usageNotice, fingerprint: "" };
  }

  const lifecycle = checkProjectLaunchAdmission(projectPath);
  if (!lifecycle.allowed) {
    checks.push(check("error", "project-lifecycle", lifecycle.reason!));
  }

  // The task itself: owned by this project now (fresh), really inside it,
  // and with no foreign worktree (FO-008D). Seeing the task in the project
  // never by itself makes it launchable here.
  const scope = verifyLaunchScope(task, projectPath);
  if (!scope.ok && scope.code !== "pipeline-step" && scope.code !== "workdir-missing") {
    checks.push(check("error", scope.code === "task-outside-project" ? "task-other-project" : scope.code, scope.reason));
  }
  if (task.pipelineParentId) {
    checks.push(check("error", "task-pipeline-step", "This is a step of a pipeline run. Run the pipeline task instead."));
  }
  if (task.archivedAt != null) {
    checks.push(check("error", "task-archived", "This task is archived. Unarchive it on the board first."));
  }
  const pipelineRunning = task.pipelineRun?.status === "running";
  if (isTaskRunLive(task.id) || pipelineRunning) {
    checks.push(check("error", "task-running", "This task is already running. Open its run to follow it."));
  } else {
    const columnReason = columnBlockReason(task.column);
    if (columnReason) checks.push(check("error", "task-column", columnReason));
  }
  // Prerequisites (FO-ORCH05). A deleted one always blocks. "Not Done yet"
  // blocks a single-task review; a batch schedules in order, so it only
  // needs the prerequisite to be Done when the task actually launches.
  for (const reason of dependencyGateFor(task).reasons) {
    if (reason.code === "not-done" && !opts.requireDependenciesDone) continue;
    checks.push(check("error", reason.code === "deleted" ? "dependency-deleted" : "dependency-not-done", reason.message));
  }
  if (opts.requireDependenciesDone) {
    const scheduled = taskAvailabilityRefusal(task.id);
    if (scheduled) checks.push(check("error", scheduled.code, scheduled.reason));
  }
  const pipelineRan = !!task.pipelineRun && (task.pipelineRun.history.length > 0 || task.pipelineRun.status !== "idle");
  if (task.pipelineId && config.pipelineId !== task.pipelineId && pipelineRan) {
    checks.push(check("error", "pipeline-locked", "This pipeline task has already run its pipeline; it can't be switched to another configuration. Restart it from the pipeline view."));
  }

  // Pipeline or profile.
  const envNames = (deps.envNames ?? defaultEnvNames)();
  const notices: string[] = [];
  let effective: { harness: Harness | null; model: string; effort: string | null; mode: string } = {
    harness: harnessOf(config.harness),
    model: config.model,
    effort: config.effort,
    mode: config.mode,
  };
  if (config.pipelineId) {
    const pipeline = pipelines.get(config.pipelineId);
    if (!pipeline) {
      checks.push(check("error", "pipeline-missing", "The chosen pipeline no longer exists."));
    } else {
      resolved.pipelineName = pipeline.name;
      const start = resolveStartStep(pipeline.graph);
      if (!start) checks.push(check("error", "pipeline-no-start", `Pipeline “${pipeline.name}” has no start step.`));
      const probed = new Map<string, HarnessStatus | null>();
      for (const step of pipeline.graph.steps) {
        const profile = step.agentProfileId ? agentProfiles.get(step.agentProfileId) : null;
        if (!profile) {
          checks.push(check("error", "pipeline-step-agent", `Step “${step.name}” has no agent, or its agent was deleted.`));
          resolved.pipelineSteps.push({ name: step.name, agent: "—" });
          continue;
        }
        const harness = harnessOf(profile.harness);
        resolved.pipelineSteps.push({ name: step.name, agent: `${profile.name}${harness ? ` · ${harness.label}` : ""}` });
        if (!harness) {
          checks.push(check("error", "pipeline-step-harness", `Step “${step.name}” uses harness "${profile.harness}", which no longer exists.`));
          continue;
        }
        if (!probed.has(harness.id)) {
          const stepChecks: ExecutionCheck[] = [];
          probed.set(harness.id, await harnessChecks(harness, profile.model, deps, freshAuth, stepChecks));
          for (const item of stepChecks) checks.push({ ...item, message: `Step “${step.name}”: ${item.message}` });
          const notice = usageNoticeFor(harness.kind, harness.label, [...envNames, ...Object.keys(harness.env ?? {})]);
          if (notice && !notices.includes(notice)) notices.push(notice);
        }
      }
      if (task.agentProfileId) {
        checks.push(check("info", "profile-detached", "The task's agent profile is replaced by the pipeline's own step agents."));
      }
      checks.push(check("info", "pipeline-steps", `The pipeline runs its ${pipeline.graph.steps.length} step${pipeline.graph.steps.length === 1 ? "" : "s"} as hidden step tasks in one shared workspace; each step uses its own agent's permission mode.`));
      const startProfile = start?.agentProfileId ? agentProfiles.get(start.agentProfileId) : null;
      if (startProfile) {
        const startHarness = harnessOf(startProfile.harness);
        effective = {
          harness: startHarness,
          model: startProfile.model,
          effort: startProfile.effort,
          mode: startProfile.mode ?? (startHarness ? defaultModeFor(startHarness.kind) : "auto"),
        };
      }
    }
  } else if (config.profileId) {
    const profile = agentProfiles.get(config.profileId);
    if (!profile) {
      checks.push(check("error", "profile-missing", "The chosen agent profile no longer exists."));
    } else {
      resolved.profileName = profile.name;
      if (task.agentProfileId === profile.id && runs.countForTask(task.id) > 0) {
        checks.push(check("info", "profile-frozen", `The task already ran with “${profile.name}”; it keeps the settings it first ran with.`));
      }
    }
  } else if (task.agentProfileId) {
    checks.push(check("warning", "profile-detach", `The task's agent profile “${task.agentProfile?.name ?? "profile"}” will be detached; it runs with the settings shown instead.`));
  }
  if (!config.pipelineId && task.pipelineId) {
    checks.push(check("warning", "pipeline-detach", "The task's pipeline will be removed; it runs as a single agent instead."));
  }

  // Harness, model, mode (the start step's for a pipeline).
  const harness = effective.harness;
  if (!harness) {
    checks.push(check("error", "harness-missing", `Harness "${config.harness}" was not found. Pick another one.`));
  } else {
    resolved.harnessLabel = harness.label;
    resolved.harnessKind = harness.kind;
    if (!config.pipelineId) {
      const status = await harnessChecks(harness, effective.model, deps, freshAuth, checks);
      resolved.launchTarget = launchTargetChecks(harness, effective.model, effective.mode, status, checks);
      resolved.modelLabel = modelChecks(harness, effective.model, effective.effort, status, checks);
      const notice = usageNoticeFor(harness.kind, harness.label, [...envNames, ...Object.keys(harness.env ?? {})]);
      if (notice) notices.push(notice);
    } else {
      resolved.modelLabel = AGENT_OPTIONS[harness.kind].models.find((option) => option.id === effective.model)?.label ?? effective.model;
    }
    const modes = supportedModes(harness.kind, effective.model);
    if (!modes.some((option) => option.id === effective.mode)) {
      checks.push(check("error", "mode-unknown", `Mode "${effective.mode}" isn't available for ${harness.label} with ${effective.model}.`));
    }
    resolved.modeLabel = modeLabel(harness.kind, effective.mode);
    resolved.accessLevel = modeAccessLevel(harness.kind, effective.mode);
    if (harness.kind === "claude-code" && effective.mode === "bounded-print") {
      checks.push(check("warning", "bounded-print-policy", "One Claude process, at most 6 agentic turns and an estimated $0.25 stopping threshold (spend can exceed it). File tools only; QC is read-only. No shell, MCP, subagents, automatic retry or continuation. Provider file restrictions are not an OS sandbox."));
      if (configuredClaudeQaAuthHome(harness.env ?? {}) !== undefined) {
        checks.push(check(claudeQaHomeAccessAccepted(harness.env ?? {}) ? "warning" : "error", "claude-qa-auth-home-access", "Claude QA explicitly uses login HOME and can access user files. This weakens filesystem isolation; restricted tools are not an OS sandbox. Separate HOME-access acceptance and fresh Owner execution authorization are required before inference."));
      }
    }
    const previousKind = harnessOf(task.agent)?.kind ?? null;
    const previousMode = task.mode ?? (previousKind ? defaultModeFor(previousKind) : null);
    resolved.previousMode = previousMode;
    if (!config.pipelineId && previousMode && previousKind === harness.kind && previousMode !== effective.mode) {
      const broader = modeAccessLevel(harness.kind, effective.mode) > modeAccessLevel(harness.kind, previousMode);
      checks.push(check("warning", "mode-change", `Permission mode changes from ${modeLabel(harness.kind, previousMode)} to ${resolved.modeLabel}${broader ? " — the agent gets broader access than the task had" : ""}.`));
    }
    if (!config.pipelineId && harness.kind === "codex") {
      const subject = permissionSubject(task);
      const hasArmedStaging = subject.workdir !== task.workdir;
      const openWs = hasArmedStaging ? getTaskWorkspace(task.id) : null;
      const workingCopyDev = Boolean(
        !task.pipelineParentId && !task.worktreePath
        && (task.accessMode ?? "workspace") === "workspace"
        && isWorkspaceDevelopmentEnabled(projectPath),
      );
      const codexWorkingCopy = workingCopyDev || openWs?.writeScope === "working-copy";
      const layout = !hasArmedStaging && workingCopyDev
        ? { layout: "non-git" as const, predicted: true }
        : await detectWorkspaceLayout(subject);
      const effectiveReadScope = (task.accessMode ?? "workspace") === "isolated" ? "restricted" : currentReadScope();
      const permission = describePermissions({
        kind: "codex",
        mode: effective.mode,
        ...layout,
        readScope: effectiveReadScope,
        timeLimitSeconds: supervisedRunLimitSeconds(),
        workingCopy: codexWorkingCopy,
      })!;
      resolved.permission = permission;
      resolved.permissionIdentity = workspacePermissionIdentity(subject, harness);
      if (!permission.launchAllowed || !resolved.permissionIdentity) checks.push(check("error", "permission-owner-decision", permission.blockReason ?? "Workspace permissions are Unknown. Review again."));
      checks.push(check("warning", permission.escalated ? "full-access" : "codex-sandbox", permissionSummary(permission)));
    } else if (!config.pipelineId && resolved.accessLevel >= 3) {
      checks.push(check("warning", "full-access", `${resolved.modeLabel}: the agent edits files and runs commands without asking, with your user's permissions, in the workspace below.`));
    }
    const accessDiagnostics = await diagnoseTaskLaunch(task, {
      harnessId: config.harness,
      mode: effective.mode,
    });
    resolved.accessDiagnostics = accessDiagnostics;
    if (!accessDiagnostics.launchAllowed && accessDiagnostics.blockReason) {
      const alreadyHasCodexBlock = accessDiagnostics.accessMode === "workspace"
        && harness.kind === "codex"
        && checks.some((c) => c.code === "permission-owner-decision");
      if (!alreadyHasCodexBlock) {
        checks.push(check("error", "access-mode-blocked", accessDiagnostics.blockReason));
      }
    }
    if (!config.pipelineId) {
      const overage = promptByteOverage(harness.kind, task.prompt);
      if (overage) {
        checks.push(check("error", "prompt-too-long", `The task's prompt is ${overage.bytes - overage.limit} bytes over ${harness.label}'s ${overage.limit}-byte launch limit. Shorten it first.`));
      }
    }
  }

  // Workspace. An armed task-owned directory is the execution subject even
  // when the task row still records worktree isolation.
  const stagedSubject = permissionSubject(task);
  const openWorkspace = getTaskWorkspace(task.id);
  const projectWorkingCopy = Boolean(
    !config.pipelineId && !task.pipelineParentId && !task.worktreePath
    && (task.accessMode ?? "workspace") === "workspace"
    && isWorkspaceDevelopmentEnabled(projectPath),
  );
  if (!existsSync(task.workdir)) {
    checks.push(check("error", "workdir-missing", `The project folder ${task.workdir} doesn't exist.`));
  } else if (stagedSubject.workdir !== task.workdir) {
    resolved.workspace = stagedSubject.workdir;
    resolved.isolation = stagedSubject.isolation;
    resolved.workspaceKind = "task-staging";
    if (openWorkspace?.writeScope === "working-copy") {
      resolved.workingCopyDevelopment = true;
      resolved.workingCopyScratchPath = openWorkspace.scratchPath ?? null;
      resolved.stagedOutputPaths = [...(openWorkspace.outputPaths ?? [])];
      checks.push(check("info", "task-working-copy", "Development in a working copy is enabled for this project. The Developer edits an isolated non-git copy of the project and can run local offline checks in a private scratch space. The original project stays unchanged until you review the changes and approve applying them."));
    } else {
      resolved.stagedOutputPaths = [...(openWorkspace?.outputPaths ?? [])];
      checks.push(check("info", "task-staging", "The developer runs in a task-owned directory outside this project. Codex workspace-write applies to that directory only. It is not an OS sandbox. Nothing is copied back until you approve publication."));
    }
  } else if (projectWorkingCopy) {
    const capability = await gitWorkingTreeCapability(task.workdir);
    if (capability.kind === "git") {
      resolved.workspace = task.workdir;
      resolved.workspaceKind = "task-staging";
      resolved.workingCopyDevelopment = true;
      checks.push(check("info", "task-working-copy", "Development in a working copy is enabled for this project. ForgeOrbit prepares an isolated non-git copy before launch so the Developer can edit files and run local offline checks without touching the original project."));
    } else {
      checks.push(check("error", "worktree-unavailable", capability.kind === "non-git"
        ? "Development in a working copy requires a Git repository baseline, but this folder is not a Git repository."
        : "Cannot verify Git repository baseline for the task working copy. Check the project folder and Git installation before reviewing again."));
    }
  } else if (task.isolation === "worktree") {
    if (task.worktreePath && existsSync(task.worktreePath)) {
      resolved.workspace = task.worktreePath;
      resolved.workspaceKind = "worktree";
      checks.push(check("info", "worktree-reuse", `Runs in the task's existing worktree${task.branch ? ` on branch ${task.branch}` : ""}.`));
    } else {
      const capability = await gitWorkingTreeCapability(task.workdir);
      if (capability.kind === "git") {
        resolved.workspace = task.workdir;
        resolved.workspaceKind = "worktree";
        checks.push(check("info", "worktree-new", `Creates an isolated git worktree${task.branch ? ` on a new branch ${task.branch}` : ""}; your working copy isn't touched.`));
      } else {
        checks.push(check("error", "worktree-unavailable", capability.kind === "non-git"
          ? "This task requires a Git worktree, but its folder is not a Git repository. Isolation is fixed at task creation; create a separately reviewed task with a supported isolation mode. Nothing will run in the project folder as a fallback."
          : "Cannot verify Git worktree capability. Check the project folder and Git installation before reviewing again. Isolation will not be weakened."));
      }
    }
  } else {
    resolved.workspaceKind = "project-folder";
    checks.push(check("warning", "no-isolation", "Git isolation is off for this task: the agent works directly in the project folder, not on a separate branch."));
  }

  // Billing and limits.
  usageNotice = notices.length > 0 ? notices.join(" ") : null;
  if (usageNotice) checks.push(check("warning", "paid-api", usageNotice));
  checks.push(check("info", "limits-unknown", "ForgeOrbit can't see this account's remaining limits or the cost of a run."));
  checks.push(check("info", "no-push", "Nothing is pushed: the agent's changes stay local until you commit or push them yourself."));

  return { checks, resolved, usageNotice, fingerprint: taskFingerprint(task) };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Live state.
 * ────────────────────────────────────────────────────────────────────────── */

function runSummary(run: Run): ExecutionRunSummary {
  return { id: run.id, status: run.status, agent: run.agent, startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode };
}

function liveOf(proposal: ExecutionProposal): ExecutionLive {
  const task = tasks.get(proposal.taskId);
  if (!task) {
    return {
      taskExists: false,
      title: null,
      column: null,
      archived: false,
      run: null,
      runCount: 0,
      live: false,
      pendingQuestions: 0,
      pipeline: null,
      otherRun: null,
      model: null,
      harness: null,
    };
  }
  const live = isTaskRunLive(task.id) || task.pipelineRun?.status === "running";
  let run: ExecutionRunSummary | null = null;
  let runCount = 0;
  let otherRun: ExecutionRunSummary | null = null;
  if (proposal.status === "started" && proposal.startingAt != null) {
    const since = runs.listForTask(task.id).filter((item) => item.startedAt >= proposal.startingAt! - 1000);
    runCount = since.length;
    const latest = since[0] ?? (proposal.runId ? runs.get(proposal.runId) : null);
    run = latest ? runSummary(latest) : null;
  } else if (task.runId && live) {
    const current = runs.get(task.runId);
    otherRun = current ? runSummary(current) : null;
  }
  let pipeline: ExecutionLive["pipeline"] = null;
  if (task.pipelineId && task.pipelineRun) {
    const state = task.pipelineRun;
    const steps = state.snapshot?.graph.steps ?? [];
    const nameOf = (stepId: string) => steps.find((step) => step.id === stepId)?.name ?? stepId;
    pipeline = {
      status: state.status,
      activeSteps: state.active.map((item) => nameOf(item.stepId)),
      completed: state.history.filter((item) => item.outcome === "succeeded" || item.outcome === "advanced-manually").length,
      total: steps.length,
    };
  }
  return {
    taskExists: true,
    title: task.title,
    column: task.column,
    archived: task.archivedAt != null,
    run,
    runCount,
    live,
    pendingQuestions: task.pendingInteractionCount ?? 0,
    pipeline,
    otherRun,
    model: task.model,
    harness: task.agent,
  };
}

function viewOf(proposal: ExecutionProposal): ExecutionView {
  const live = liveOf(proposal);
  return { ...proposal, live, phase: executionPhase(proposal, live) };
}

/**
 * A proposal left `starting` with no claim behind it lost its start to an
 * app exit or crash. Adopt the run it started if there is one, otherwise
 * mark it failed so it can be approved again.
 */
function reconcileStarting(proposal: ExecutionProposal): ExecutionProposal {
  if (proposal.status !== "starting" || startingExecutions.has(proposal.id)) return proposal;
  if (proposal.source === "employee") {
    // Employee attempts never inherit the older time-window heuristic. A
    // starting proposal remains closed to retries until its exact link exists.
    const run = proposal.runId ? runs.get(proposal.runId) : null;
    if (!run || run.taskId !== proposal.taskId) return proposal;
    const next: ExecutionProposal = { ...proposal, status: "started", startedAt: run.startedAt,
      history: appendEvent(proposal.history, "started", "Reconciled with the exact run recorded before spawn."), updatedAt: Date.now() };
    save(next);
    return next;
  }
  const since = proposal.startingAt ?? proposal.updatedAt;
  const started = runs.listForTask(proposal.taskId)
    .filter((run) => run.startedAt >= since - 1000)
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  const task = tasks.get(proposal.taskId);
  const pipelineStarted = !started && task?.pipelineRun?.startedAt != null && task.pipelineRun.startedAt >= since - 1000;
  const now = Date.now();
  const next: ExecutionProposal = started || pipelineStarted
    ? {
      ...proposal,
      status: "started",
      runId: started?.id ?? null,
      startedAt: started?.startedAt ?? task?.pipelineRun?.startedAt ?? now,
      history: appendEvent(proposal.history, "started", "Run found after the app restarted."),
      updatedAt: now,
    }
    : {
      ...proposal,
      status: "start-failed",
      error: "The app closed before the run started. Check the task and approve again.",
      history: appendEvent(proposal.history, "start-failed", "The app closed before the run started."),
      updatedAt: now,
    };
  save(next);
  return next;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Reading.
 * ────────────────────────────────────────────────────────────────────────── */

export function listExecutions(rawPath: unknown): ExecutionResultOf<ExecutionView[]> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  for (const raw of projectExecutions.listStarting(project.value)) {
    const proposal = parse(raw);
    if (proposal) reconcileStarting(proposal);
  }
  const views = projectExecutions.list(project.value, EXECUTION_LIMITS.listed)
    .map(parse)
    .filter((item): item is ExecutionProposal => item != null && item.projectPath === project.value)
    .map(viewOf);
  return { ok: true, value: views };
}

function locate(rawPath: unknown, id: string): ExecutionResultOf<ExecutionProposal> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const proposal = load(project.value, id);
  if (!proposal) return fail(404, "Execution not found for this project.");
  return { ok: true, value: reconcileStarting(proposal) };
}

/** Reconcile one stored proposal (a batch's launch after a restart). */
export function reconcileExecution(projectPath: string, id: string): ExecutionProposal | null {
  const proposal = load(projectPath, id);
  return proposal ? reconcileStarting(proposal) : null;
}

registerProjectLifecycleStartingReconciler((projectPath) => {
  let count = 0;
  for (const raw of projectExecutions.listStarting(projectPath)) {
    const proposal = parse(raw);
    if (!proposal) continue;
    const after = reconcileStarting(proposal);
    if (after.status !== "starting") count += 1;
  }
  return count;
});

/** True while this process is starting the task through supervised
 *  execution (an approval or a batch launch). */
export function isExecutionStarting(taskId: string): boolean {
  return startingTasks.has(taskId) || preparingTasks.has(taskId);
}

export function appendManagerSystemMessage(projectPath: string, text: string): void {
  appendSystemMessage(projectPath, text, null);
}

export function getExecution(rawPath: unknown, id: string): ExecutionResultOf<ExecutionView> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return { ok: true, value: viewOf(located.value) };
}

/** Short summaries for the manager prompt: what ran from this chat. */
export function executionSummaries(projectPath: string): { taskRef: string; title: string; phase: ExecutionView["phase"]; startedAt: number | null }[] {
  return projectExecutions.list(projectPath, 15)
    .map(parse)
    .filter((item): item is ExecutionProposal => item != null && item.status !== "dismissed")
    .map((proposal) => {
      const view = viewOf(proposal);
      return { taskRef: proposal.taskId.slice(0, 8), title: view.live.title ?? proposal.taskTitle, phase: view.phase, startedAt: proposal.startedAt };
    });
}

/** What the manager prompt lists as available to run tasks. Names only. */
export function executionCatalog(): ExecutionCatalog {
  return {
    harnesses: harnesses.list()
      .filter((harness) => harness.enabled)
      .map((harness) => ({ id: harness.id, label: harness.label, kind: harness.kind, defaultModel: DEFAULT_MODEL[harness.kind] })),
    profiles: agentProfiles.list().map((profile) => ({ name: profile.name, harness: profile.harness, model: profile.model })),
    pipelines: pipelines.list().map((pipeline) => ({ name: pipeline.name, steps: pipeline.graph.steps.length })),
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Preparing a proposal.
 * ────────────────────────────────────────────────────────────────────────── */

function projectTask(projectPath: string, taskId: string): ExecutionResultOf<Task> {
  const task = tasks.get(taskId);
  // A task of another project reads as missing, so ids can't be probed.
  if (!task || !taskInProject(task, projectPath, { fresh: true })) return fail(404, "Task not found in this project.");
  if (task.pipelineParentId) return fail(409, "This is a step of a pipeline run. Run the pipeline task instead.");
  return { ok: true, value: task };
}

function reasonFor(task: Task, config: ExecutionConfig, harness: Harness | null): string {
  if (config.pipelineId) {
    const name = pipelines.get(config.pipelineId)?.name ?? "the pipeline";
    return `The task is set up to run the pipeline “${name}”, so its steps run with their own agents.`;
  }
  if (config.profileId) {
    const name = agentProfiles.get(config.profileId)?.name ?? "its agent profile";
    return `The task is bound to the agent profile “${name}”, which sets its harness, model and permission mode.`;
  }
  const label = harness?.label ?? config.harness;
  return task.mode == null
    ? `Uses the task's own settings: ${label} with ${config.model}, in the harness's default permission mode. Change anything before approving.`
    : `Uses the task's own settings: ${label} with ${config.model}. Change anything before approving.`;
}

interface PrepareInput {
  taskId: unknown;
  source?: "owner" | "manager";
  config?: ExecutionConfig;
  reason?: string;
  messageId?: string | null;
  /** Shown as warnings: what the manager suggested that didn't check out. */
  notes?: string[];
}

async function prepare(projectPath: string, input: PrepareInput, deps: ExecutionDeps): Promise<ExecutionResultOf<{ execution: ExecutionView; existing: boolean }>> {
  if (typeof input.taskId !== "string" || !input.taskId) return fail(400, "taskId is required.");
  const found = projectTask(projectPath, input.taskId);
  if (!found.ok) return found;
  const task = found.value;
  const taskId = task.id;
  if (preparingTasks.has(taskId) || startingTasks.has(taskId)) {
    const open = openProposal(projectPath, taskId);
    if (open) return { ok: true, value: { execution: viewOf(open), existing: true } };
    return fail(409, "A run for this task is being prepared right now.");
  }
  const open = openProposal(projectPath, taskId);
  if (open && input.source !== "manager") return { ok: true, value: { execution: viewOf(reconcileStarting(open)), existing: true } };
  if (open && open.status === "starting") return { ok: true, value: { execution: viewOf(open), existing: true } };

  preparingTasks.add(taskId);
  try {
    const config = normalizeConfig(input.config ?? configFromTask(task));
    const checked = await runChecks(projectPath, task, config, deps, false, { requireDependenciesDone: true });
    // A newer suggestion from the manager replaces an older, unapproved
    // one for the same task; the owner never loses an approval this way.
    const stale = openProposal(projectPath, taskId);
    if (stale) {
      if (stale.status === "starting") return { ok: true, value: { execution: viewOf(stale), existing: true } };
      save({
        ...stale,
        status: "dismissed",
        history: appendEvent(stale.history, "dismissed", "Replaced by a newer suggestion."),
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    const notes = (input.notes ?? []).map((note) => check("warning", "suggestion-adjusted", note));
    const proposal: ExecutionProposal = {
      id,
      projectPath,
      taskId,
      taskTitle: task.title,
      messageId: input.messageId ?? null,
      source: input.source ?? "owner",
      batchId: null,
      reason: capText(input.reason || reasonFor(task, config, harnessOf(config.harness)), EXECUTION_LIMITS.reasonChars),
      config,
      resolved: checked.resolved,
      checks: [...notes, ...checked.checks],
      checkedAt: now,
      reviewedFingerprint: checked.fingerprint,
      usageNotice: checked.usageNotice,
      status: "proposed",
      error: null,
      runId: null,
      startingAt: null,
      startedAt: null,
      revision: 1,
      history: appendEvent([], "proposed", input.source === "manager" ? "Suggested by the manager." : "Prepared from the task's settings."),
      createdAt: now,
      updatedAt: now,
    };
    if (!proposal.messageId) {
      proposal.messageId = appendSystemMessage(projectPath, `Prepared a run for “${task.title}”. Review it and approve to start.`, id);
    }
    try {
      save(proposal);
    } catch {
      // The unique index: another proposal won a race we didn't see.
      const winner = openProposal(projectPath, taskId);
      if (winner) return { ok: true, value: { execution: viewOf(winner), existing: true } };
      return fail(409, "A run for this task is already proposed.");
    }
    return { ok: true, value: { execution: viewOf(proposal), existing: false } };
  } finally {
    preparingTasks.delete(taskId);
  }
}

/**
 * Prepare an execution proposal for one task from its own settings. No
 * model is called; the checks are local CLI probes. Idempotent: a task
 * with an open proposal returns that one.
 */
export async function prepareExecution(
  rawPath: unknown,
  body: { taskId?: unknown },
  deps: ExecutionDeps = {},
): Promise<ExecutionResultOf<{ execution: ExecutionView; existing: boolean }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  return prepare(project.value, { taskId: body.taskId }, deps);
}

/** An exact id, else one case-insensitive name match. `"unknown"` when
 *  the manager named something that doesn't exist (or isn't unique). */
function matchByName<T extends { id: string; name: string }>(items: T[], value: string | null): T | null | "unknown" {
  if (!value || /^(none|null|no)$/i.test(value.trim())) return null;
  const byId = items.find((item) => item.id === value);
  if (byId) return byId;
  const lower = value.trim().toLowerCase();
  const hits = items.filter((item) => item.name.trim().toLowerCase() === lower);
  return hits.length === 1 ? hits[0]! : "unknown";
}

/**
 * Turn the manager's `<execution_proposal>` into a proposal. Every name is
 * checked against what exists; anything that doesn't is dropped (keeping
 * the task's own setting) and listed on the card. The permission mode is
 * never taken from the manager.
 */
export async function proposeFromSuggestion(
  projectPath: string,
  suggestion: ExecutionSuggestion,
  messageId: string,
  deps: ExecutionDeps = {},
): Promise<{ executionId: string | null; error: string | null }> {
  const task = projectTasks(projectPath).find((item) => item.id.startsWith(suggestion.taskRef));
  if (!task) return { executionId: null, error: `The suggested run names #${suggestion.taskRef}, which isn't a task of this project.` };
  const notes: string[] = [];
  let config = configFromTask(task);
  const pipeline = matchByName(pipelines.list(), suggestion.pipeline);
  const profile = matchByName(agentProfiles.list(), suggestion.profile);
  if (pipeline === "unknown") notes.push(`The manager suggested pipeline “${suggestion.pipeline}”, which doesn't exist; it was left out.`);
  else if (pipeline) config = { ...config, pipelineId: pipeline.id, profileId: null };
  if (profile === "unknown") notes.push(`The manager suggested agent profile “${suggestion.profile}”, which doesn't exist; it was left out.`);
  else if (profile && !config.pipelineId) config = { ...config, profileId: profile.id };
  if (!config.pipelineId && !config.profileId && suggestion.harness) {
    const harness = harnessOf(suggestion.harness);
    if (!harness) {
      notes.push(`The manager suggested harness “${suggestion.harness}”, which doesn't exist; the task's own harness is kept.`);
    } else if (harness.id !== config.harness) {
      const previousKind = harnessOf(config.harness)?.kind;
      config = { ...config, harness: harness.id };
      if (previousKind !== harness.kind) {
        // A different CLI: its own default model and mode, never a broader
        // mode carried over from the old one.
        config = { ...config, model: DEFAULT_MODEL[harness.kind], effort: null, mode: safestHandsOffMode(harness.kind, task), fast: false, maxMode: false };
      }
    }
  }
  if (!config.pipelineId && !config.profileId && suggestion.model) {
    const kind = harnessOf(config.harness)?.kind;
    if (kind) config = { ...config, model: suggestion.model, effort: suggestion.effort ?? config.effort };
  } else if (!config.pipelineId && !config.profileId && suggestion.effort) {
    config = { ...config, effort: suggestion.effort };
  }
  const result = await prepare(projectPath, {
    taskId: task.id,
    source: "manager",
    config,
    reason: suggestion.reason ? `Suggested by the manager: ${suggestion.reason}` : "Suggested by the manager.",
    messageId,
    notes,
  }, deps);
  if (!result.ok) return { executionId: null, error: result.error };
  return { executionId: result.value.execution.id, error: null };
}

/** On a harness switch suggested by the manager, the new CLI's default
 *  mode — unless the task was in a narrower mode, in which case the
 *  narrowest the new CLI offers. */
export function safestHandsOffMode(kind: AgentKind, task: Task): string {
  const fallback = defaultModeFor(kind);
  const previousKind = harnessOf(task.agent)?.kind;
  if (!previousKind || !task.mode) return fallback;
  if (modeAccessLevel(previousKind, task.mode) >= modeAccessLevel(kind, fallback)) return fallback;
  const modes = AGENT_OPTIONS[kind].modes.map((mode) => mode.id);
  return modes.reduce((best, id) => (modeAccessLevel(kind, id) < modeAccessLevel(kind, best) ? id : best), fallback);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Editing and checking.
 * ────────────────────────────────────────────────────────────────────────── */

function parseRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export async function updateExecution(
  rawPath: unknown,
  id: string,
  body: { revision?: unknown; config?: unknown },
  deps: ExecutionDeps = {},
): Promise<ExecutionResultOf<ExecutionView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  const proposal = located.value;
  const owned = ownedElsewhere(proposal);
  if (owned) return fail(409, owned, { execution: viewOf(proposal) });
  if (proposal.status !== "proposed" && proposal.status !== "start-failed") {
    return fail(409, proposal.status === "dismissed" ? "This run proposal was cancelled." : "This run was already approved.", { execution: viewOf(proposal) });
  }
  if (startingExecutions.has(proposal.id)) return fail(409, "This run is starting right now.", { execution: viewOf(proposal) });
  if (parseRevision(body.revision) !== proposal.revision) {
    return fail(409, "The run proposal changed since you opened it. Review it again.", { execution: viewOf(proposal) });
  }
  const read = readConfig(body.config, proposal.config);
  if (typeof read === "string") return fail(400, read);
  if (read.profileId && !agentProfiles.get(read.profileId)) return fail(400, "That agent profile no longer exists.");
  if (read.pipelineId && !pipelines.get(read.pipelineId)) return fail(400, "That pipeline no longer exists.");
  if (!read.pipelineId && !read.profileId && !harnessOf(read.harness)) return fail(400, `Harness "${read.harness}" was not found.`);
  const config = normalizeConfig(read);
  const task = tasks.get(proposal.taskId);
  const checked = await runChecks(proposal.projectPath, task, config, deps, false, { requireDependenciesDone: true });
  const changed = !sameConfig(config, proposal.config);
  const next: ExecutionProposal = {
    ...proposal,
    config,
    reason: changed ? "Edited by you." : proposal.reason,
    resolved: checked.resolved,
    checks: checked.checks,
    checkedAt: Date.now(),
    reviewedFingerprint: checked.fingerprint,
    usageNotice: checked.usageNotice,
    revision: proposal.revision + 1,
    history: changed ? appendEvent(proposal.history, "edited", "Configuration edited.") : proposal.history,
    updatedAt: Date.now(),
  };
  save(next);
  return { ok: true, value: viewOf(next) };
}

/** Run the checks again (after installing a CLI, logging in, …). */
export async function recheckExecution(rawPath: unknown, id: string, deps: ExecutionDeps = {}): Promise<ExecutionResultOf<ExecutionView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  const proposal = located.value;
  if (ownedElsewhere(proposal)) return { ok: true, value: viewOf(proposal) };
  if (proposal.status !== "proposed" && proposal.status !== "start-failed") return { ok: true, value: viewOf(proposal) };
  if (startingExecutions.has(proposal.id)) return { ok: true, value: viewOf(proposal) };
  const checked = await runChecks(proposal.projectPath, tasks.get(proposal.taskId), normalizeConfig(proposal.config), deps, true, { requireDependenciesDone: true });
  const next: ExecutionProposal = {
    ...proposal,
    resolved: checked.resolved,
    checks: checked.checks,
    checkedAt: Date.now(),
    reviewedFingerprint: checked.fingerprint,
    usageNotice: checked.usageNotice,
    revision: proposal.revision + 1,
    updatedAt: Date.now(),
  };
  save(next);
  return { ok: true, value: viewOf(next) };
}

export function dismissExecution(rawPath: unknown, id: string): ExecutionResultOf<ExecutionView> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  const proposal = located.value;
  if (proposal.status === "dismissed") return { ok: true, value: viewOf(proposal) };
  if (proposal.status === "starting" || startingExecutions.has(proposal.id)) {
    return fail(409, "This run is starting right now. Stop it from its run panel once it starts.", { execution: viewOf(proposal) });
  }
  if (proposal.status === "started") {
    return fail(409, "This run already started. Stop it from its run panel or here.", { execution: viewOf(proposal) });
  }
  const next: ExecutionProposal = {
    ...proposal,
    status: "dismissed",
    history: appendEvent(proposal.history, "dismissed", "Cancelled by you. Nothing was started."),
    updatedAt: Date.now(),
  };
  save(next);
  return { ok: true, value: viewOf(next) };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Approval.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Write the reviewed configuration onto the task, through the same task
 * fields its own settings edit. A harness switch goes first and alone so
 * `reconcileTaskSession` drops the old CLI's session (and resets its
 * kind-specific ids) before the new values land.
 */
async function applyConfig(taskId: string, config: ExecutionConfig): Promise<void> {
  let task = tasks.get(taskId);
  if (!task) throw new Error("task not found");
  if (config.pipelineId) {
    const pipeline = pipelines.get(config.pipelineId);
    if (!pipeline) throw new Error("pipeline not found");
    if (task.pipelineId !== pipeline.id) {
      if (task.agentProfileId) tasks.setAgentProfile(taskId, null, null);
      tasks.setPipelineBinding(taskId, pipeline.id, initialPipelineRunState(pipeline));
    }
    // A pipeline task's own agent fields only mirror its start step.
    task = tasks.get(taskId)!;
    const harness = harnessOf(config.harness);
    const effort = config.effort ?? (harness ? defaultEffortFor(harness.kind, config.model, harness.id) : null);
    tasks.update(taskId, { agent: config.harness, model: config.model, effort, mode: config.mode, fast: config.fast, maxMode: config.maxMode });
    return;
  }
  if (task.pipelineId) {
    tasks.setPipelineBinding(taskId, null, null);
    task = tasks.get(taskId)!;
  }
  if (task.agent !== config.harness) {
    const before = task;
    const after = tasks.update(taskId, { agent: config.harness });
    if (after) await reconcileTaskSession(taskId, before, after);
    task = tasks.get(taskId)!;
  }
  const harness = harnessOf(config.harness);
  if (!harness) throw new Error(`harness "${config.harness}" not found`);
  if (config.profileId) {
    const profile = agentProfiles.get(config.profileId);
    if (!profile) throw new Error("agent profile not found");
    const profileHarness = harnessOf(profile.harness) ?? harness;
    if (task.agentProfileId !== profile.id) {
      tasks.setAgentProfile(taskId, profile.id, snapshotFromProfile(profile, { kind: profileHarness.kind, label: profileHarness.label }, Date.now()));
    }
  } else if (task.agentProfileId) {
    tasks.setAgentProfile(taskId, null, null);
  }
  const effort = config.effort ?? defaultEffortFor(harness.kind, config.model, harness.id);
  const kindDefaultMode = defaultModeFor(harness.kind);
  task = tasks.get(taskId)!;
  const mode = task.mode == null && config.mode === kindDefaultMode ? null : config.mode;
  if (task.model !== config.model || task.effort !== effort || task.mode !== mode || task.fast !== config.fast || task.maxMode !== config.maxMode) {
    tasks.update(taskId, { model: config.model, effort, mode, fast: config.fast, maxMode: config.maxMode });
  }
}

/** FO-ROUTING03: apply reviewed harness/model/mode without starting a Run. */
export const applyTaskExecutionConfig = applyConfig;

function alreadyRunningMessage(error: string): boolean {
  return /already (running|starting)/i.test(error);
}

/**
 * Start the task the owner approved. Refuses when the task, the checks or
 * the configuration changed since the owner reviewed them, when a billing
 * notice wasn't acknowledged, or when the task is already running (then
 * the existing run is returned). Idempotent: approving a proposal that
 * already started answers with that run; a second approval while one is
 * starting is refused.
 */
export async function approveExecution(
  rawPath: unknown,
  id: string,
  body: { revision?: unknown; acknowledgeUsage?: unknown; acknowledgeFullAccess?: unknown },
  deps: ExecutionDeps = {},
): Promise<ExecutionResultOf<{ execution: ExecutionView; alreadyStarted: boolean }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  let proposal = located.value;
  if (proposal.status === "started") return { ok: true, value: { execution: viewOf(proposal), alreadyStarted: true } };
  if (proposal.status === "dismissed") return fail(409, "This run proposal was cancelled.", { execution: viewOf(proposal) });
  const lifecycle = checkProjectLaunchAdmission(proposal.projectPath);
  if (!lifecycle.allowed) {
    return fail(409, `Nothing was started. ${lifecycle.reason}`, { execution: viewOf(proposal), code: "project-lifecycle" });
  }
  const owned = ownedElsewhere(proposal);
  if (owned) return fail(409, owned, { execution: viewOf(proposal) });
  if (startingExecutions.has(proposal.id) || startingTasks.has(proposal.taskId) || proposal.status === "starting") {
    return fail(409, "This run is already starting.", { execution: viewOf(proposal) });
  }
  if (parseRevision(body.revision) !== proposal.revision) {
    return fail(409, "The run proposal changed since you reviewed it. Review it again before approving.", { execution: viewOf(proposal) });
  }
  if (projectExecutions.otherOpenForTask(proposal.taskId, proposal.id)) {
    return fail(409, "A newer run proposal for this task is open. Review that one instead.", { execution: viewOf(proposal) });
  }
  // Claimed before the first await: a double click or a replayed request
  // can't start the task twice.
  startingExecutions.add(proposal.id);
  startingTasks.add(proposal.taskId);
  try {
    const task = tasks.get(proposal.taskId);
    if (!task || !taskInProject(task, proposal.projectPath, { fresh: true })) {
      return fail(404, "This task no longer exists in this project.", { execution: viewOf(proposal) });
    }
    const scope = verifyLaunchScope(task, proposal.projectPath);
    if (!scope.ok) return fail(409, `Nothing was started. ${scope.reason}`, { execution: viewOf(proposal), code: scope.code });
    if (isTaskRunLive(task.id) || task.pipelineRun?.status === "running") {
      return fail(409, "This task is already running — it was started from somewhere else.", {
        execution: viewOf(proposal),
        runId: task.runId,
        alreadyRunning: true,
      });
    }
    const config = normalizeConfig(proposal.config);
    const checked = await runChecks(proposal.projectPath, task, config, deps, true, { requireDependenciesDone: true });
    const stale = checked.fingerprint !== proposal.reviewedFingerprint || !sameConfig(config, proposal.config)
      || checked.resolved.permissionIdentity !== proposal.resolved.permissionIdentity
      || JSON.stringify(checked.resolved.permission) !== JSON.stringify(proposal.resolved.permission);
    const seen = new Set(proposal.checks.map((item) => item.code));
    const unseen = checked.checks.filter((item) => item.level !== "info" && !seen.has(item.code));
    if (stale || unseen.length > 0 || hasBlockingCheck(checked.checks)) {
      const next: ExecutionProposal = {
        ...proposal,
        config,
        resolved: checked.resolved,
        checks: checked.checks,
        checkedAt: Date.now(),
        reviewedFingerprint: checked.fingerprint,
        usageNotice: checked.usageNotice,
        revision: proposal.revision + 1,
        updatedAt: Date.now(),
      };
      save(next);
      const blocking = checked.checks.find((item) => item.level === "error");
      const message = blocking
        ? `Can't start: ${blocking.message}`
        : stale
          ? "The task changed since you reviewed this run. Check the updated card and approve again."
          : "Something changed since you reviewed this run. Check the updated card and approve again.";
      return fail(409, message, { execution: viewOf(next) });
    }
    if (checked.usageNotice && body.acknowledgeUsage !== true) {
      return fail(400, "This agent may bill per request. Confirm the usage notice to approve.", { execution: viewOf(proposal) });
    }
    // The shared AccountCore eligibility contract (FO-ORCH07.2): confirmed
    // exhaustion or an Owner prohibition refuses before anything is claimed.
    // Unknown evidence stays the Owner's call, as before.
    const blockedResource = configEligibility({ task, projectPath: proposal.projectPath, config });
    if (blockedResource) return fail(409, `Can't start: ${eligibilityRefusal(blockedResource)}`, { execution: viewOf(proposal) });

    if (checked.resolved.permission?.sandbox === "danger-full-access" && body.acknowledgeFullAccess !== true) return fail(400, "Explicit full-access acknowledgement is required.", { execution: viewOf(proposal) });
    if (isProductionOwnerGateActive()) {
      return fail(
        409,
        "Legacy execution approval cannot authorize an Owner-gated launch. Prepare and confirm the task via Employee Execution with macOS Owner authentication.",
        { execution: viewOf(proposal), code: "owner-proof-absent" },
      );
    }
    const startingAt = Date.now();
    proposal = {
      ...proposal,
      status: "starting",
      error: null,
      startingAt,
      history: appendEvent(proposal.history, "approved", "Approved by you."),
      updatedAt: startingAt,
    };
    save(proposal);

    let started: Awaited<ReturnType<typeof startTask>>;
    try {
      await applyConfig(task.id, config);
      ensureBaselineEstimate(task.id);
      started = await (deps.startTask ?? startTask)(task.id, {
        supervisedRun: true,
        codexPermissionReview: checked.resolved.permission, codexPermissionIdentity: checked.resolved.permissionIdentity,
        verifyBeforeRun: () => {
          const current = tasks.get(task.id);
          if (checked.resolved.permissionIdentity && (!current || workspacePermissionIdentity(permissionSubject(current), harnessOf(config.harness) ?? undefined) !== checked.resolved.permissionIdentity)) {
            return "Workspace permissions changed. Review again.";
          }
          // Asked again inside the transaction that records the run.
          const again = current ? configEligibility({ task: current, projectPath: proposal.projectPath, config }) : null;
          return again ? eligibilityRefusal(again) : null;
        },
      });
    } catch (error) {
      started = { error: (error as Error).message };
    }
    const now = Date.now();
    if ("error" in started) {
      const fresh = tasks.get(task.id);
      if (alreadyRunningMessage(started.error)) {
        // Started from the board in the same moment. Not ours: hand the
        // proposal back and point at the run that exists.
        proposal = {
          ...proposal,
          status: "proposed",
          startingAt: null,
          history: appendEvent(proposal.history, "start-failed", "The task was started from somewhere else first."),
          updatedAt: now,
        };
        save(proposal);
        return fail(409, "This task is already running — it was started from somewhere else.", {
          execution: viewOf(proposal),
          runId: fresh?.runId ?? null,
          alreadyRunning: true,
        });
      }
      const error = capText(redactSecrets(started.error), 600);
      proposal = {
        ...proposal,
        status: "start-failed",
        error,
        revision: proposal.revision + 1,
        reviewedFingerprint: fresh ? taskFingerprint(fresh) : proposal.reviewedFingerprint,
        history: appendEvent(proposal.history, "start-failed", error),
        updatedAt: now,
      };
      save(proposal);
      appendSystemMessage(proposal.projectPath, `“${task.title}” couldn't start: ${error}`, proposal.id);
      return { ok: true, value: { execution: viewOf(proposal), alreadyStarted: false } };
    }
    proposal = {
      ...proposal,
      status: "started",
      runId: started.runId || null,
      startedAt: now,
      history: appendEvent(proposal.history, "started", `Started${started.pending ? " (the agent is still launching)" : ""}.`),
      updatedAt: now,
    };
    save(proposal);
    const label = config.pipelineId
      ? `pipeline “${checked.resolved.pipelineName ?? "pipeline"}”`
      : `${checked.resolved.harnessLabel} · ${checked.resolved.modelLabel}`;
    appendSystemMessage(proposal.projectPath, `Started “${task.title}” on ${label}.`, proposal.id);
    return { ok: true, value: { execution: viewOf(proposal), alreadyStarted: false } };
  } finally {
    startingExecutions.delete(proposal.id);
    startingTasks.delete(proposal.taskId);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Launch from an approved execution batch (FO-005C.1).
 * ────────────────────────────────────────────────────────────────────────── */

export interface BatchLaunchRequest {
  projectPath: string;
  taskId: string;
  batchId: string;
  batchTitle: string;
  /** Pre-generated so a crash between this call and its result can still
   *  be traced to the proposal row it wrote. */
  executionId: string;
  config: ExecutionConfig;
  /** `launchFingerprint` the task must still have. */
  expectFingerprint: string;
  fingerprintOf: (task: Task) => string;
  /**
   * The batch's own checks, run after the supervised checks and before
   * anything is written onto the task. A non-null result holds the start.
   */
  verify: (checked: Checked, task: Task) => { code: string; reason: string } | null;
  onRunRecorded?: (runId: string) => void;
  authorizeSubmission?: () => boolean;
  ownerLaunchGrantId?: string;
}

export type BatchLaunchOutcome =
  | { kind: "started"; executionId: string; runId: string | null; appliedFingerprint: string }
  | { kind: "held"; code: string; reason: string }
  | { kind: "busy"; reason: string }
  | { kind: "start-failed"; executionId: string; error: string };

/**
 * Start one task of an approved batch through the same path as the owner's
 * "Approve & Execute": the same in-memory claims, the same checks, the same
 * config write and the board's `startTask`. The batch's approval stands in
 * for the per-task approval; everything it froze is re-verified first.
 * Never starts a task that is live, claimed, or has another open proposal.
 */
export async function launchBatchTask(req: BatchLaunchRequest, deps: ExecutionDeps = {}): Promise<BatchLaunchOutcome> {
  return launchApproved(req, {
    source: "batch",
    batchId: req.batchId,
    employeeRunId: null,
    reason: `Started by the approved batch “${req.batchTitle}”.`,
    approvedText: `Approved as part of the batch “${req.batchTitle}”.`,
  }, deps);
}

/** Who stands in for the per-task approval of a launch. */
interface LaunchOrigin {
  source: "batch" | "employee";
  batchId: string | null;
  employeeRunId: string | null;
  reason: string;
  approvedText: string;
}

/**
 * Start one task that another authority already approved (an execution batch,
 * or the owner's confirmation of an employee execution review). One body for
 * both so the claims, checks, config write and `startTask` call cannot drift.
 */
async function launchApproved(req: BatchLaunchRequest, origin: LaunchOrigin, deps: ExecutionDeps): Promise<BatchLaunchOutcome> {
  const { taskId } = req;
  if (startingTasks.has(taskId) || preparingTasks.has(taskId)) return { kind: "busy", reason: "The task is being started from somewhere else." };
  startingTasks.add(taskId);
  startingExecutions.add(req.executionId);
  try {
    const task = tasks.get(taskId);
    if (!task || !taskInProject(task, req.projectPath, { fresh: true })) return { kind: "held", code: "task-missing", reason: "The task no longer exists in this project." };
    const scope = verifyLaunchScope(task, req.projectPath);
    if (!scope.ok) return { kind: "held", code: `scope:${scope.code}`, reason: scope.reason };
    if (isTaskRunLive(taskId) || task.pipelineRun?.status === "running") return { kind: "busy", reason: "The task is already running." };
    const open = openProposal(req.projectPath, taskId);
    if (open && (open.status === "proposed" || open.status === "starting")) {
      return { kind: "held", code: "proposal-open", reason: "A separate run proposal is open for this task. Dismiss or approve it first." };
    }
    if (req.fingerprintOf(task) !== req.expectFingerprint) {
      return { kind: "held", code: "task-changed", reason: "The task's prompt or settings changed since the batch was approved." };
    }
    const config = normalizeConfig(req.config);
    const checked = await runChecks(req.projectPath, task, config, deps, true);
    const blocking = checked.checks.find((item) => item.level === "error");
    if (blocking) return { kind: "held", code: `check:${blocking.code}`, reason: blocking.message };
    const fresh = tasks.get(taskId);
    if (!fresh || req.fingerprintOf(fresh) !== req.expectFingerprint) {
      return { kind: "held", code: "task-changed", reason: "The task changed while it was being checked." };
    }
    const scheduledRefusal = taskAvailabilityRefusal(fresh.id);
    if (scheduledRefusal) return { kind: "held", code: scheduledRefusal.code, reason: scheduledRefusal.reason };
    const verdict = req.verify(checked, fresh);
    if (verdict) return { kind: "held", ...verdict };

    const now = Date.now();
    let proposal: ExecutionProposal = {
      id: req.executionId,
      projectPath: req.projectPath,
      taskId,
      taskTitle: fresh.title,
      messageId: null,
      source: origin.source,
      batchId: origin.batchId,
      employeeRunId: origin.employeeRunId,
      reason: capText(origin.reason, EXECUTION_LIMITS.reasonChars),
      config,
      resolved: checked.resolved,
      checks: checked.checks,
      checkedAt: now,
      reviewedFingerprint: checked.fingerprint,
      usageNotice: checked.usageNotice,
      status: "starting",
      error: null,
      runId: null,
      startingAt: now,
      startedAt: null,
      revision: 1,
      history: appendEvent([], "approved", origin.approvedText, now),
      createdAt: now,
      updatedAt: now,
    };
    try {
      save(proposal);
    } catch {
      return { kind: "held", code: "proposal-open", reason: "A separate run proposal is open for this task." };
    }

    let started: Awaited<ReturnType<typeof startTask>>;
    let appliedFingerprint = req.expectFingerprint;
    try {
      await applyConfig(taskId, config);
      ensureBaselineEstimate(taskId);
      const applied = tasks.get(taskId);
      if (applied) appliedFingerprint = req.fingerprintOf(applied);
      started = await (deps.startTask ?? startTask)(taskId, {
        codexPermissionReview: checked.resolved.permission, codexPermissionIdentity: checked.resolved.permissionIdentity,
        ...(req.ownerLaunchGrantId ? { ownerLaunchGrantId: req.ownerLaunchGrantId } : {}),
        ...(origin.source === "employee" ? { employeeAttemptId: origin.employeeRunId!, supervisedRun: true } : {}),
        verifyBeforeRun: () => {
          const current = tasks.get(taskId);
          if (!current || req.fingerprintOf(current) !== appliedFingerprint) return "The task changed during runtime preparation.";
          const scope = verifyLaunchScope(current, req.projectPath);
          if (!scope.ok) return scope.reason;
          const scheduledNow = taskAvailabilityRefusal(current.id);
          if (scheduledNow) return scheduledNow.reason;
          if (checked.resolved.permissionIdentity && workspacePermissionIdentity(permissionSubject(current), harnessOf(config.harness) ?? undefined) !== checked.resolved.permissionIdentity) return "Workspace permissions changed. Review again.";
          return req.verify(checked, current)?.reason ?? null;
        },
        authorizeSubmission: req.authorizeSubmission,
        onRunRecorded: (runId) => {
          req.onRunRecorded?.(runId);
          proposal = { ...proposal, runId };
          save(proposal);
        },
      });
    } catch (error) {
      // A thrown error may be after spawn. Employee reconciliation must keep
      // its exact run link and uncertainty instead of declaring start failure.
      if (origin.source === "employee") throw error;
      started = { error: (error as Error).message };
    }
    const end = Date.now();
    if ("error" in started) {
      if (alreadyRunningMessage(started.error)) {
        proposal = { ...proposal, status: "dismissed", startingAt: null, history: appendEvent(proposal.history, "dismissed", "The task was started from somewhere else first."), updatedAt: end };
        save(proposal);
        return { kind: "busy", reason: "The task was started from somewhere else first." };
      }
      const error = origin.source === "employee" && !started.error.startsWith("Professional execution payload exceeds ")
        ? "The runtime returned a start error. Check the task and harness settings before a new review."
        : capText(redactSecrets(started.error), 600);
      proposal = { ...proposal, status: "start-failed", error, history: appendEvent(proposal.history, "start-failed", error), updatedAt: end };
      if (origin.source === "employee" && !proposal.runId) {
        proposal.history = appendEvent(proposal.history, "start-refused", "The runtime returned a start error before recording a run.", end);
      }
      save(proposal);
      return { kind: "start-failed", executionId: proposal.id, error };
    }
    proposal = {
      ...proposal,
      status: "started",
      runId: started.runId || null,
      startedAt: end,
      history: appendEvent(proposal.history, "started", `Started${started.pending ? " (the agent is still launching)" : ""}.`),
      updatedAt: end,
    };
    save(proposal);
    return { kind: "started", executionId: proposal.id, runId: proposal.runId, appliedFingerprint };
  } finally {
    startingTasks.delete(taskId);
    startingExecutions.delete(req.executionId);
  }
}

/**
 * Start the task for an employee execution the owner just confirmed (FO-010E2).
 * Same path as a batch launch: the owner's confirmation of that exact review
 * stands in for the per-task approval, and everything it froze is
 * re-verified first. `executionId` is generated by the caller so a crash can
 * still be traced to the proposal row.
 */
export function launchEmployeeTask(req: BatchLaunchRequest & { employeeRunId: string; employeeName: string }, deps: ExecutionDeps = {}): Promise<BatchLaunchOutcome> {
  return launchApproved(req, {
    source: "employee",
    batchId: null,
    employeeRunId: req.employeeRunId,
    reason: `Started for ${req.employeeName} after the owner confirmed the review.`,
    approvedText: "Confirmed by the owner for the assigned employee.",
  }, deps);
}

/** An unstarted supervised proposal (proposed or starting) exists for the task. */
export function hasOpenSupervisedProposal(projectPath: string, taskId: string): boolean {
  const open = openProposal(projectPath, taskId);
  return !!open && (open.status === "proposed" || open.status === "starting");
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Result and review.
 * ────────────────────────────────────────────────────────────────────────── */

export async function executionResult(rawPath: unknown, id: string): Promise<ExecutionResultOf<ExecutionResult>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  const proposal = located.value;
  const task = tasks.get(proposal.taskId);
  if (!task) return fail(404, "This task no longer exists.");
  if (proposal.status !== "started") return fail(409, "This run hasn't started.");
  const live = liveOf(proposal);
  const runId = live.run?.id ?? proposal.runId;
  const run = runId ? runs.get(runId) : null;

  const diff = await getTaskDiff(task).catch((error: unknown) => ({ base: null, files: [], note: `Couldn't read the changes: ${(error as Error).message}` }));
  const files = diff.files.slice(0, EXECUTION_LIMITS.changedFiles).map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));

  const finalRaw = run ? runs.lastAssistantData(run.id) : null;
  const finalMessage = finalRaw ? capText(redactSecrets(finalRaw).trim(), EXECUTION_LIMITS.finalMessageChars) : null;
  const errors = run
    ? runs.recentStatusLines(run.id, 40)
      .filter((line) => line.stream === "stderr" || /\b(error|failed|fail|⚠|refused|not available|denied|cannot|couldn't)\b/i.test(line.data))
      .slice(-EXECUTION_LIMITS.errorLines)
      .map((line) => capText(redactSecrets(line.data).replace(/\s+/g, " ").trim(), EXECUTION_LIMITS.errorLineChars))
    : [];

  let pipeline: ExecutionResult["pipeline"] = null;
  if (task.pipelineId && task.pipelineRun) {
    const state = task.pipelineRun;
    const steps = state.snapshot?.graph.steps ?? [];
    const nameOf = (stepId: string) => steps.find((step) => step.id === stepId)?.name ?? stepId;
    pipeline = {
      status: state.status,
      steps: state.history.map((record) => ({
        name: nameOf(record.stepId),
        outcome: record.outcome,
        responseKind: record.responseKind ?? null,
        summary: record.handoff?.summary ? capText(redactSecrets(record.handoff.summary), 600) : null,
        openQuestions: (record.handoff?.openQuestions ?? []).slice(0, 5).map((item) => capText(redactSecrets(item), 300)),
      })),
      blocked: state.blocked.map((block) => capText(redactSecrets(block.message), 300)),
    };
  }

  return {
    ok: true,
    value: {
      runStatus: run?.status ?? null,
      exitCode: run?.exitCode ?? null,
      endedAt: run?.endedAt ?? null,
      changes: {
        base: diff.base,
        files,
        truncated: diff.files.length > files.length,
        note: diff.files.length === 0 ? diff.note ?? null : null,
      },
      finalMessage,
      errors,
      pipeline,
      tests: {
        note: task.pipelineId
          ? "Test results appear only as the pipeline steps reported them in their handoffs."
          : "No test step is configured for this run, so ForgeOrbit has no test results. Check the agent's message or run your tests.",
      },
      pendingQuestions: task.pendingInteractionCount ?? 0,
    },
  };
}

export type ReviewAction = "accept" | "return" | "fix" | "stop";

/**
 * The owner's decision on a run's result, through the board's own
 * operations: accept moves the card to Done, return moves it back to the
 * backlog, fix sends the owner's message to the task's run (the same path
 * as the Run Panel's composer), stop is the run's own cancel.
 */
export async function reviewExecution(
  rawPath: unknown,
  id: string,
  body: { action?: unknown; text?: unknown },
): Promise<ExecutionResultOf<ExecutionView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  let proposal = located.value;
  if (proposal.status !== "started") return fail(409, "This run hasn't started.");
  const task = tasks.get(proposal.taskId);
  if (!task || !taskInProject(task, proposal.projectPath, { fresh: true })) return fail(404, "This task no longer exists in this project.");
  if (task.archivedAt != null) return fail(409, "This task is archived.");
  const action = body.action;
  const live = isTaskRunLive(task.id) || task.pipelineRun?.status === "running";
  const record = (kind: Parameters<typeof appendEvent>[1], text: string) => {
    proposal = { ...proposal, history: appendEvent(proposal.history, kind, text), updatedAt: Date.now() };
    save(proposal);
  };
  switch (action) {
    case "accept": {
      if (live) return fail(409, "The run is still going. Wait for it to finish, or stop it first.");
      if (task.pipelineId && task.pipelineRun?.status !== "done") return fail(409, "The pipeline hasn't finished.");
      // The same quality-control gate every other route to Done uses: a review that requested changes, blocked,
      // or is still running must not be bypassed by accepting from here.
      const qcBlock = assertCanMoveTaskToDone(task);
      if (qcBlock) return fail(409, qcBlock);
      if (task.column !== "done") {
        moveTaskColumn(task.id, "done");
        if (task.qcState?.awaitingOwnerApproval && task.qcState.latestVerdict === "PASS") acknowledgeQcOwnerReview(task.id);
      }
      record("accepted", "Result accepted. The task moved to Done.");
      break;
    }
    case "return": {
      if (live) return fail(409, "The run is still going. Stop it first.");
      if (task.pipelineId) return fail(409, "A pipeline task's column follows its run. Restart it from the pipeline view.");
      if (task.column !== "backlog") moveTaskColumn(task.id, "backlog");
      record("returned", "Returned to the backlog.");
      break;
    }
    case "fix": {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return fail(400, "Write what to fix first.");
      if (text.length > EXECUTION_LIMITS.fixChars) return fail(400, `Fix requests are limited to ${EXECUTION_LIMITS.fixChars} characters.`);
      if (task.pipelineId) return fail(409, "Open the pipeline to retry or advance a step.");
      const runId = task.runId ?? proposal.runId;
      if (!runId) return fail(409, "This task has no run to continue.");
      const sent = await sendInput(runId, text, { bounded: true });
      if (!sent.delivered) {
        const saved = "savedToBacklog" in sent && sent.savedToBacklog ? " It was saved to the task's backlog." : "";
        return fail(409, `The fix request wasn't delivered: ${"reason" in sent ? sent.reason : "unknown reason"}.${saved}`);
      }
      record("fix-requested", capText(`Fix requested: ${text.replace(/\s+/g, " ")}`, EXECUTION_LIMITS.historyTextChars));
      break;
    }
    case "stop": {
      if (!live) return fail(409, "Nothing is running for this task.");
      if (task.pipelineId) {
        const stopped = await cancelPipelineRun(task.id);
        if ("error" in stopped) return fail(stopped.status, stopped.error);
      } else {
        if (!task.runId || !(await cancelRun(task.runId))) return fail(409, "The run couldn't be stopped. Use its run panel.");
      }
      record("stopped", "Stopped by you.");
      break;
    }
    default:
      return fail(400, "action must be accept, return, fix, or stop");
  }
  return { ok: true, value: viewOf(proposal) };
}

export const __testing = {
  startingExecutions,
  startingTasks,
  preparingTasks,
  reset(): void {
    startingExecutions.clear();
    startingTasks.clear();
    preparingTasks.clear();
  },
};
