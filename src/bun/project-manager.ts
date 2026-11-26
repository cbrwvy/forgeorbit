import type { PortfolioTurnAttribution } from "../shared/head-portfolio-binding.ts";
/**
 * Project manager (FO-005A): one logical AI manager per registered project.
 *
 * Nothing here runs in the background. The model is called only when the
 * owner sends a message from the Manager tab; each message is one isolated
 * turn (`isolated-agent-turn.ts`, the same runner and restrictions as the
 * FO-003 interview): the agent runs once, in an empty scratch folder, in
 * the harness's most restricted mode, with the project context inline in
 * the prompt. It never sees the project folder and cannot change it.
 *
 * Context is read here, server-side: markdown documents through the
 * interview's safe reader (inside the project only, secrets never opened,
 * redacted, capped) plus the board's own task rows. Replies are parsed with
 * `parseManagerReply` and stored as data. Tasks are created only by
 * `approveProposal`, through `createTask` — which never starts an agent and
 * never creates a worktree — after the owner reviewed the proposal.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { AssignmentProposalCore, teamForPrompt } from "./assignment-proposals.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { parseAssignmentDrafts } from "../shared/assignments/proposals.ts";
import { HiringProposalCore } from "./catalog/hiring-proposal-core.ts";
import { parseHiringDrafts } from "../shared/hiring/proposals.ts";
import { applyManagerIntakePromotions } from "./pm-intake.ts";
import { isIntakeGrantId, pmIntakeGrants } from "./pm-intake-grants.ts";
import { buildPmOrchestratedContext } from "./pm-orchestrated-workflow.ts";
import { buildPmOrchestratedBatchContext } from "./pm-orchestrated-batch.ts";
import { recommendQcReviewers } from "./task-quality-control.ts";
import { agentProfiles, db, harnesses, preferences, projectManagers, projectRules, projects, taskScheduling } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import { getEnvironmentManager } from "./environment/runtime.ts";
import { cancelIsolatedTurn, runIsolatedTurn, type IsolatedTurnControl } from "./isolated-agent-turn.ts";
import { createTask } from "./orchestrator.ts";
import { gitWorkingTreeCapability } from "./worktree.ts";
import { executionCatalog, executionSummaries, proposeFromSuggestion } from "./project-execution.ts";
import { discoverProject } from "./project-discovery.ts";
import { interviewPreflight, readSafeMarkdown } from "./project-interview.ts";
import { linkProposalDependencies } from "./task-scheduling.ts";
import { loadBrainContext, type BrainConsumedContext, type ContextResult as BrainResult } from "./brain-context.ts";
import { loadKnowledgeContext, type ContextResult } from "./knowledge-context.ts";
import { loadEffectiveKnowledgeForProject } from "./knowledge-effective.ts";
import { checkProjectLaunchAdmission, reconcileProjectDrain, registerProjectLifecycleManagerProbe } from "./project-lifecycle.ts";
import { isBrainGrantId } from "../shared/brain/context.ts";
import { parseMemoryProposalPermission, parseMemoryProposals } from "../shared/brain/proposals.ts";
import { isBrowserGrantId, stripBrowserActionMarkup } from "../shared/browser/agent.ts";
import { loadBrowserAgentGrants, settleBrowserAgentAction } from "./browser-agent.ts";
import { defaultBrowserSessionManager } from "./browser-session.ts";
import { isNativeGrantId, stripNativeActionMarkup } from "../shared/native-computer/agent.ts";
import { loadNativeAgentGrants, reconcileInterruptedNativeMessage, settleNativeAgentAction } from "./native-computer-agent.ts";
import { defaultNativeComputerSessionManager } from "./native-computer-session.ts";
import { recordMemoryProposals } from "./brain-proposals.ts";
import { isGrantId, type KnowledgePromptDocument } from "../shared/knowledge/context.ts";
import { projectTasks as ownedProjectTasks } from "./project-ownership.ts";
import { priorityFromProposal } from "../shared/task-scheduling.ts";
import { PHASE_LABELS, displayPhase } from "../shared/environment/present.ts";
import { defaultDocPaths, formatStacks } from "../shared/project-discovery.ts";
import { capText, contextExcerpt, redactSecrets, type InterviewIsolation } from "../shared/project-interview.ts";
import { parseProjectMeta, projectMetaKey } from "../shared/project-wizard.ts";
import {
  DEFAULT_MANAGER_CONFIG,
  MANAGER_LIMITS,
  annotateDuplicates,
  applyItemEdits,
  proposalCycleMessage,
  buildManagerPrompt,
  creationOrder,
  parseManagerReply,
  plannedAction,
  proposalItemToTaskInput,
  sanitizeManagerConfig,
  sanitizeStoredMessage,
  sanitizeStoredProposal,
  selectHistory,
  settledProposalStatus,
  type ContextSource,
  type DuplicateCandidate,
  type ManagerBacklogTask,
  type ManagerConfig,
  type ManagerDecision,
  type ManagerMessage,
  type ManagerPromptContext,
  type ManagerState,
  type ProposalItem,
  type ResolvedDependency,
  type TaskProposal,
  type TaskRefLookup,
} from "../shared/project-manager.ts";
import type { ColumnId, Harness, Task } from "../shared/types.ts";

/** A turn that runs longer than this is stopped and reported as failed. */
const TURN_TIMEOUT_MS = Number(process.env.AGETOR_MANAGER_TURN_TIMEOUT_MS ?? 0) || 5 * 60_000;
/** Settled turns stay readable this long for the client's poll. */
const SETTLED_TTL_MS = 10 * 60_000;
/** Largest document read at all; anything bigger is skipped, not cut. */
const DOC_READ_CAP = 512 * 1024;

export type ManagerResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

function fail<T>(status: number, error: string, body?: Record<string, unknown>): ManagerResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Storage helpers.
 * ────────────────────────────────────────────────────────────────────────── */

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadConfig(projectPath: string): ManagerConfig {
  const row = projectManagers.getConfig(projectPath);
  return row ? sanitizeManagerConfig(parseJson(row.config)) : { ...DEFAULT_MANAGER_CONFIG };
}

function loadMessages(projectPath: string): ManagerMessage[] {
  return projectManagers.listMessages(projectPath)
    .map((raw) => sanitizeStoredMessage(parseJson(raw)))
    .filter((item): item is ManagerMessage => item != null);
}

function loadMessage(projectPath: string, id: string): ManagerMessage | null {
  return sanitizeStoredMessage(parseJson(projectManagers.getMessage(projectPath, id)));
}

function appendMessage(projectPath: string, message: ManagerMessage): void {
  projectManagers.appendMessage(projectPath, message.id, JSON.stringify(message), MANAGER_LIMITS.messagesKept);
}

function saveMessage(projectPath: string, message: ManagerMessage): void {
  projectManagers.updateMessage(projectPath, message.id, JSON.stringify(message));
}

function loadProposal(projectPath: string, id: string): TaskProposal | null {
  const proposal = sanitizeStoredProposal(parseJson(projectManagers.getProposal(projectPath, id)));
  return proposal && proposal.projectPath === projectPath ? proposal : null;
}

function saveProposal(proposal: TaskProposal): void {
  projectManagers.putProposal(proposal.projectPath, proposal.id, proposal.status, JSON.stringify(proposal), proposal.createdAt);
}

function loadDecisions(projectPath: string): ManagerDecision[] {
  return projectManagers.listDecisions(projectPath).map((row) => ({
    id: row.id,
    text: row.text,
    source: row.source === "manager" || row.source === "approval" ? row.source : "owner",
    createdAt: row.created_at,
  }));
}

function newMessage(role: ManagerMessage["role"], text: string, fields: Partial<ManagerMessage> = {}): ManagerMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: Date.now(),
    status: null,
    error: null,
    plan: null,
    proposalId: null,
    executionId: null,
    proposalError: null,
    suggestedDecisions: [],
    sources: [],
    ...fields,
  };
}

function registered(rawPath: unknown): ManagerResult<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Turn registry (in memory; one turn at a time per project).
 * ────────────────────────────────────────────────────────────────────────── */

export type ManagerTurnStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ManagerTurnView {
  id: string;
  projectPath: string;
  messageId: string;
  status: ManagerTurnStatus;
  error: string | null;
  startedAt: number;
  settledAt: number | null;
}

interface ManagerJob extends ManagerTurnView {
  control: IsolatedTurnControl;
  intakeGrantId: string | null;
}

const jobs = new Map<string, ManagerJob>();
const runningByProject = new Map<string, string>();

registerProjectLifecycleManagerProbe((projectPath) => runningByProject.has(projectPath));

function viewOf(job: ManagerJob): ManagerTurnView {
  return {
    id: job.id,
    projectPath: job.projectPath,
    messageId: job.messageId,
    status: job.status,
    error: job.error,
    startedAt: job.startedAt,
    settledAt: job.settledAt,
  };
}

function pruneSettled(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.settledAt != null && now - job.settledAt > SETTLED_TTL_MS) jobs.delete(id);
  }
}

export function getManagerTurn(id: string): ManagerTurnView | null {
  pruneSettled();
  const job = jobs.get(id);
  return job ? viewOf(job) : null;
}

export function cancelManagerTurn(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  cancelIsolatedTurn(job.control);
  return true;
}

function activeTurnFor(projectPath: string): ManagerState["activeTurn"] {
  const id = runningByProject.get(projectPath);
  const job = id ? jobs.get(id) : undefined;
  return job && job.status === "running" ? { id: job.id, messageId: job.messageId, startedAt: job.startedAt } : null;
}

/** The project's running turn, if any (read by the portfolio manager to
 *  follow a delegated request). */
export function activeManagerTurn(projectPath: string): ManagerState["activeTurn"] {
  return activeTurnFor(projectPath);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * State and config.
 * ────────────────────────────────────────────────────────────────────────── */

export function getManagerState(rawPath: unknown): ManagerResult<ManagerState> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const projectPath = project.value;
  const lifecycle = checkProjectLaunchAdmission(projectPath);
  if (!lifecycle.allowed) return fail(409, lifecycle.reason!);
  const activeTurn = activeTurnFor(projectPath);
  // A message still "pending" with no turn behind it lost its turn to an
  // app exit or crash: mark it failed so it can be retried.
  const messages = loadMessages(projectPath).map((message) => {
    if (message.role !== "owner" || message.status !== "pending" || message.id === activeTurn?.messageId) return message;
    const reconciled = reconcileInterruptedNativeMessage(message, db);
    const failed = {
      ...message,
      status: "failed" as const,
      error: reconciled.error,
      ...(reconciled.nativeAction ? { nativeAction: reconciled.nativeAction } : {}),
    };
    saveMessage(projectPath, failed);
    return failed;
  });
  return {
    ok: true,
    value: {
      projectPath,
      config: loadConfig(projectPath),
      messages,
      proposals: projectManagers.listProposals(projectPath)
        .map((raw) => sanitizeStoredProposal(parseJson(raw)))
        .filter((item): item is TaskProposal => item != null && item.projectPath === projectPath),
      decisions: loadDecisions(projectPath),
      activeTurn,
      lastActivityAt: projectManagers.getConfig(projectPath)?.lastActivityAt ?? null,
    },
  };
}

export function updateManagerConfig(rawPath: unknown, rawConfig: unknown): ManagerResult<ManagerConfig> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const config = sanitizeManagerConfig(rawConfig);
  if (config.profileId && !agentProfiles.get(config.profileId)) return fail(400, "That agent profile no longer exists.");
  if (config.harness && !harnesses.getByIdOrKind(config.harness)) return fail(400, `Harness "${config.harness}" was not found.`);
  projectManagers.setConfig(project.value, JSON.stringify(config));
  return { ok: true, value: config };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Project context.
 * ────────────────────────────────────────────────────────────────────────── */

const COLUMN_ORDER: ColumnId[] = ["running", "blocked", "ready", "inbox", "backlog", "review", "done"];

/** The project's board tasks by the shared ownership contract: its folder,
 *  its subfolders and proven worktrees, never an ambiguous folder. */
function projectTasks(projectPath: string): Task[] {
  return ownedProjectTasks(projectPath);
}

function excerptOf(prompt: string): string {
  const flat = redactSecrets(prompt).replace(/\s+/g, " ").trim();
  return capText(flat, MANAGER_LIMITS.backlogExcerptChars);
}

function environmentSummary(projectPath: string): string | null {
  const manager = getEnvironmentManager();
  if (!manager) return null;
  const rows: string[] = [];
  for (const status of manager.list()) {
    const profile = manager.profile(status.profileId);
    if (!profile || profile.projectPath !== projectPath) continue;
    const phase = displayPhase({ configured: true, recordedPhase: status.recordedPhase, ownership: status.ownership });
    rows.push(`${profile.name}: ${PHASE_LABELS[phase]}${status.lastError ? ` (last error: ${capText(redactSecrets(status.lastError), 200)})` : ""}`);
  }
  return rows.length > 0 ? rows.join("; ") : "no launch profile is configured";
}

export interface GatheredContext {
  context: ManagerPromptContext;
  sources: ContextSource[];
  lookup: TaskRefLookup;
  candidates: DuplicateCandidate[];
}

function readDoc(
  root: string | null,
  rel: string | null,
  label: string,
  maxChars: number,
  id: string,
  documents: ManagerPromptContext["documents"],
  sources: ContextSource[],
): void {
  if (!rel) {
    sources.push({ id, label, path: null, status: "missing", detail: "Not found in the project." });
    return;
  }
  const raw = root ? readSafeMarkdown(root, rel, DOC_READ_CAP) : null;
  if (raw == null) {
    sources.push({ id, label, path: rel, status: "skipped", detail: "Not readable: missing, outside the project, not Markdown, or larger than 512 KB." });
    return;
  }
  const cleaned = raw.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) {
    sources.push({ id, label, path: rel, status: "missing", detail: "The file is empty." });
    return;
  }
  const text = contextExcerpt(cleaned, maxChars);
  const truncated = cleaned.length > maxChars;
  documents.push({ label, path: rel, text, truncated });
  sources.push({
    id,
    label,
    path: rel,
    status: truncated ? "truncated" : "included",
    detail: truncated ? `First ${maxChars.toLocaleString("en-US")} characters (secrets redacted).` : "Included (secrets redacted).",
  });
}

/**
 * Everything the manager knows about one project, read now. Files come only
 * from inside the project and only through `readSafeMarkdown`; the backlog
 * and state come from the board's own rows. Nothing is invented: what isn't
 * found is reported as missing.
 */
export async function gatherManagerContext(projectPath: string, config: ManagerConfig): Promise<GatheredContext> {
  const project = projects.get(projectPath);
  const meta = parseProjectMeta(preferences.get(projectMetaKey(projectPath)));
  const discovered = await discoverProject({ path: projectPath });
  const report = discovered.ok ? discovered.report : null;
  let root: string | null = null;
  try {
    root = realpathSync(projectPath);
  } catch {
    root = null;
  }

  const documents: ManagerPromptContext["documents"] = [];
  const sources: ContextSource[] = [];
  const stack = report ? formatStacks(report.stacks) : "No stack detected";
  sources.push({
    id: "identity",
    label: "Project identity",
    path: null,
    status: "included",
    detail: report ? `Name, folder, ${stack}${meta.description ? ", description" : ""}.` : "Name and folder only: the folder could not be scanned.",
  });

  const found = report ? defaultDocPaths(report.documentation) : { ideaPath: null, prdPath: null };
  readDoc(root, meta.idea ?? found.ideaPath, "IDEA.md", MANAGER_LIMITS.ideaChars, "idea", documents, sources);
  readDoc(root, meta.prd ?? found.prdPath, "PRD.md", MANAGER_LIMITS.prdChars, "prd", documents, sources);
  readDoc(root, report?.readmePath ?? null, "README", MANAGER_LIMITS.readmeChars, "readme", documents, sources);
  for (const rel of config.extraDocs) {
    readDoc(root, rel, `Document ${rel}`, MANAGER_LIMITS.extraDocChars, `doc:${rel}`, documents, sources);
  }
  const missingDocuments = sources
    .filter((source) => (source.id === "idea" || source.id === "prd") && source.status !== "included" && source.status !== "truncated")
    .map((source) => source.label);

  const all = projectTasks(projectPath);
  const active = all.filter((task) => !task.archivedAt);
  const counts: Record<ColumnId, number> = { backlog: 0, inbox: 0, ready: 0, running: 0, blocked: 0, review: 0, done: 0 };
  for (const task of active) counts[task.column] += 1;
  const ordered = [...active].sort((a, b) =>
    COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column) || b.updatedAt - a.updatedAt);
  const { team, assignees } = teamForPrompt(db, projectPath);
  const backlog: ManagerBacklogTask[] = [];
  let used = 0;
  for (const task of ordered) {
    if (backlog.length >= MANAGER_LIMITS.backlogTasks) break;
    const row: ManagerBacklogTask = {
      ref: task.id.slice(0, 8),
      title: capText(redactSecrets(task.title).replace(/\s+/g, " ").trim(), MANAGER_LIMITS.taskTitleChars),
      column: task.column,
      taskType: task.taskType,
      excerpt: excerptOf(task.prompt),
      priority: taskScheduling.priorityOf(task.id),
      dependsOn: taskScheduling.dependenciesOf(task.id).map((id) => id.slice(0, 8)),
      ...(assignees.has(task.id) ? { assignee: assignees.get(task.id)! } : {}),
    };
    const size = row.title.length + row.excerpt.length + 40;
    if (used + size > MANAGER_LIMITS.backlogChars) break;
    used += size;
    backlog.push(row);
  }
  const archivedCount = all.length - active.length;
  sources.push({
    id: "backlog",
    label: "Board tasks",
    path: null,
    status: active.length === 0 ? "missing" : backlog.length < active.length ? "truncated" : "included",
    detail: active.length === 0
      ? "No tasks on the board for this project."
      : `${backlog.length} of ${active.length} active tasks listed${archivedCount > 0 ? `, ${archivedCount} archived counted` : ""}.`,
  });

  const environment = environmentSummary(projectPath);
  sources.push({
    id: "environment",
    label: "Local environment",
    path: null,
    status: environment ? "included" : "missing",
    detail: environment ? capText(environment, 300) : "The environment manager is not running.",
  });

  const lookup = new Map<string, { id: string; title: string; column: ColumnId }>();
  for (const task of all) lookup.set(task.id.slice(0, 8), { id: task.id, title: task.title, column: task.column });

  const qcLine = (task: (typeof active)[number]) => `#${task.id.slice(0, 8)} ${task.title}`;
  const awaitingReview = active
    .filter(
      (task) =>
        task.column === "review" &&
        !task.qcState?.activeReviewId &&
        (task.qcState?.roundCount ?? 0) === 0,
    )
    .map(qcLine)
    .slice(0, 15);
  const awaitingOwnerApproval = active
    .filter((task) => task.column === "review" && task.qcState?.awaitingOwnerApproval && task.qcState.latestVerdict === "PASS")
    .map(qcLine)
    .slice(0, 15);
  const recommendedReviewerRoles = recommendQcReviewers(projectPath).map((r) => r.label);

  const orchestrated = buildPmOrchestratedContext(projectPath).map((row) => ({
    taskId: row.taskId,
    title: row.title,
    status: row.summary?.status ?? "unknown",
    phase: row.summary?.phase ?? "unknown",
    pauseReason: row.summary?.pauseReason ?? null,
  }));

  const orchestratedBatches = buildPmOrchestratedBatchContext(projectPath);

  return {
    context: {
      name: project?.name || path.basename(projectPath),
      path: projectPath,
      description: meta.description ?? "",
      stack,
      signals: report?.signals.slice(0, 20) ?? [],
      gitBranch: report?.git.present ? report.git.branch : null,
      documents,
      missingDocuments,
      backlog,
      backlogOmitted: active.length - backlog.length,
      counts,
      archivedCount,
      blocked: active.filter((task) => task.column === "blocked").map((task) => `#${task.id.slice(0, 8)} ${task.title}`).slice(0, 20),
      running: active.filter((task) => task.column === "running").map((task) => `#${task.id.slice(0, 8)} ${task.title}`).slice(0, 20),
      environment,
      ...(team.length > 0 ? { team } : {}),
      executions: executionSummaries(projectPath),
      qualityControl:
        awaitingReview.length > 0 || awaitingOwnerApproval.length > 0 || recommendedReviewerRoles.length > 0
          ? { awaitingReview, awaitingOwnerApproval, recommendedReviewerRoles }
          : undefined,
      ...(orchestrated.length > 0 ? { orchestratedWorkflows: orchestrated } : {}),
      ...(orchestratedBatches.length > 0 ? { orchestratedBatches } : {}),
    },
    sources,
    lookup,
    candidates: active.map((task) => ({ id: task.id, title: task.title, column: task.column })),
  };
}

export async function getManagerContextSources(rawPath: unknown): Promise<ManagerResult<ContextSource[]>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const config = loadConfig(project.value);
  const gathered = await gatherManagerContext(project.value, config);
  const decisions = loadDecisions(project.value);
  const sources = [...gathered.sources];
  sources.push({
    id: "decisions",
    label: "Confirmed decisions",
    path: null,
    status: decisions.length > 0 ? "included" : "missing",
    detail: decisions.length > 0 ? `${decisions.length} confirmed.` : "None confirmed yet.",
  });
  return { ok: true, value: sources };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Sending a message.
 * ────────────────────────────────────────────────────────────────────────── */

interface AgentChoice {
  harnessId: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
  maxMode: boolean;
}

function agentChoice(config: ManagerConfig): AgentChoice | string {
  if (config.profileId) {
    const profile = agentProfiles.get(config.profileId);
    if (!profile) return "The agent profile picked for this manager no longer exists. Pick another one.";
    return { harnessId: profile.harness, model: profile.model, effort: profile.effort, fast: profile.fast, maxMode: profile.maxMode };
  }
  if (!config.harness) return "Choose an agent for this project's manager first.";
  return { harnessId: config.harness, model: config.model, effort: config.effort, fast: config.fast, maxMode: config.maxMode };
}

type PreflightDeps = Parameters<typeof interviewPreflight>[3];

/** What the configured agent may still do, for the consent box. Local CLI
 *  probes only, never a model. */
export async function managerPreflight(
  rawPath: unknown,
  deps: PreflightDeps = {},
): Promise<ManagerResult<{ harness: { id: string; label: string; kind: string }; model: string; isolation: InterviewIsolation }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const lifecycle = checkProjectLaunchAdmission(project.value);
  if (!lifecycle.allowed) return fail(409, lifecycle.reason!);
  const choice = agentChoice(loadConfig(project.value));
  if (typeof choice === "string") return fail(400, choice);
  const result = await interviewPreflight(choice.harnessId, choice.model, choice.effort, deps);
  if (!result.ok) return fail(result.status, result.error);
  return {
    ok: true,
    value: {
      harness: { id: result.harness.id, label: result.harness.label, kind: result.harness.kind },
      model: result.model,
      isolation: result.isolation,
    },
  };
}

export interface SendResult {
  turn: ManagerTurnView;
  message: ManagerMessage;
}

/**
 * Start one manager turn for an owner message (new, or a retry of the last
 * one that failed). Resolves once the agent was launched or refused; the
 * reply is written to the history when the turn settles, whether or not
 * anyone is still watching.
 */
export async function sendManagerMessage(
  rawPath: unknown,
  body: { text?: unknown; retryMessageId?: unknown; knowledgeGrantId?: unknown; brainGrantId?: unknown; browserGrantId?: unknown; nativeGrantId?: unknown; intakeGrantId?: unknown; allowMemoryProposals?: unknown; allowCompanyMemoryProposals?: unknown; memoryProposalProjectPaths?: unknown },
  deps: PreflightDeps = {},
  /** Internal only (never read from a request body): the portfolio
   *  manager's approved delegation this message carries (FO-008C). */
  origin: { delegationId?: string; portfolioAttribution?: PortfolioTurnAttribution } = {},
): Promise<ManagerResult<SendResult>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const projectPath = project.value;
  const lifecycle = checkProjectLaunchAdmission(projectPath);
  if (!lifecycle.allowed) return fail(409, lifecycle.reason!);
  const retryId = typeof body.retryMessageId === "string" ? body.retryMessageId : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!retryId && !text) return fail(400, "Write a message first.");
  if (text.length > MANAGER_LIMITS.messageChars) {
    return fail(400, `Messages are limited to ${MANAGER_LIMITS.messageChars} characters.`);
  }
  // A knowledge permission (FO-011E) is spent by this message and no other.
  // It is never taken from a delegation: a project manager reached through
  // the portfolio manager receives only what the owner approved for it.
  let knowledgeGrantId: string | null = null;
  if (body.knowledgeGrantId != null) {
    if (!isGrantId(body.knowledgeGrantId)) return fail(400, "Invalid knowledge permission.");
    if (origin.delegationId) return fail(400, "A delegated request can't carry knowledge notes.");
    knowledgeGrantId = body.knowledgeGrantId;
  }
  let brainGrantId: string | null = null;
  if (body.brainGrantId != null) {
    if (!isBrainGrantId(body.brainGrantId)) return fail(400, "Invalid Brain permission.");
    if (origin.delegationId) return fail(400, "A delegated request can't carry Brain memories.");
    brainGrantId = body.brainGrantId;
  }
  let browserGrantId: string | null = null;
  if (body.browserGrantId != null) {
    if (!isBrowserGrantId(body.browserGrantId)) return fail(400, "Invalid browser permission.");
    if (origin.delegationId) return fail(400, "A delegated request can't use a browser session.");
    browserGrantId = body.browserGrantId;
  }
  let nativeGrantId: string | null = null;
  if (body.nativeGrantId != null) {
    if (!isNativeGrantId(body.nativeGrantId)) return fail(400, "Invalid native permission.");
    if (origin.delegationId) return fail(400, "A delegated request can't use a native computer session.");
    nativeGrantId = body.nativeGrantId;
  }
  let intakeGrantId: string | null = null;
  if (body.intakeGrantId != null) {
    if (!isIntakeGrantId(body.intakeGrantId)) return fail(400, "Invalid intake promotion grant.");
    if (origin.delegationId) return fail(400, "A delegated request can't carry intake promotion.");
    intakeGrantId = body.intakeGrantId;
  }
  if (runningByProject.has(projectPath)) {
    return fail(409, "The manager is still answering. Wait for it or cancel first.");
  }
  const turnId = crypto.randomUUID();
  // Claimed before the first await so a double click can't start two turns.
  runningByProject.set(projectPath, turnId);
  const release = () => {
    if (runningByProject.get(projectPath) === turnId) runningByProject.delete(projectPath);
  };

  try {
    const config = loadConfig(projectPath);
    let message: ManagerMessage;
    const history = loadMessages(projectPath);
    if (retryId) {
      const found = loadMessage(projectPath, retryId);
      const lastOwner = [...history].reverse().find((item) => item.role === "owner");
      if (!found || found.role !== "owner") {
        release();
        return fail(404, "That message was not found.");
      }
      if (lastOwner?.id !== found.id || (found.status !== "failed" && found.status !== "cancelled")) {
        release();
        return fail(409, "Only the last message that failed can be retried.");
      }
      message = {
        ...found,
        browserGrantId: undefined,
        browserAction: undefined,
        nativeGrantId: undefined,
        nativeAction: undefined,
      };
    } else {
      message = newMessage("owner", text, {
        status: "pending",
        ...(origin.delegationId ? { delegationId: origin.delegationId } : {}),
        ...(origin.portfolioAttribution ? { portfolioAttribution: origin.portfolioAttribution } : {}),
      });
    }

    const choice = agentChoice(config);
    if (typeof choice === "string") {
      release();
      return fail(400, choice);
    }
    const preflight = await interviewPreflight(choice.harnessId, choice.model, choice.effort, deps);
    if (!preflight.ok) {
      release();
      return fail(preflight.status, preflight.error);
    }
    if (config.consentKey !== preflight.isolation.consentKey) {
      release();
      return fail(428, "Confirm what this agent can and can't do before the manager uses it.", { isolation: preflight.isolation });
    }

    // Last gate before the prompt: everything above can still refuse without
    // spending the owner's permission. Brain is checked first so a refused
    // memory set does not spend a knowledge grant or start a model.
    const memoryPermission = parseMemoryProposalPermission(
      body,
      { kind: "project", projectPath },
      (path) => projects.get(path) != null,
    );
    if (!memoryPermission.ok) {
      release();
      return fail(400, memoryPermission.error);
    }
    if (memoryPermission.value && origin.delegationId) {
      release();
      return fail(400, "A delegated request can't propose Brain memories.");
    }
    if (!retryId && memoryPermission.value) {
      message = { ...message, memoryProposalPermission: memoryPermission.value };
    }
    let brain: BrainResult<BrainConsumedContext> | null = null;
    if (brainGrantId) {
      const service = await loadBrainContext();
      brain = service.consume({ kind: "project", projectPath }, brainGrantId, message.id, turnId);
      if (!brain.ok) {
        release();
        return fail(brain.status, brain.error, { ...(brain.issues ? { brainIssues: brain.issues } : {}), brainRejected: true });
      }
    }
    let knowledge: ContextResult<{ documents: KnowledgePromptDocument[]; totalBytes: number; ref: string }> | null = null;
    if (knowledgeGrantId) {
      const service = await loadKnowledgeContext();
      knowledge = service.consume({ kind: "project", projectPath }, knowledgeGrantId, message.id);
      if (!knowledge.ok) {
        release();
        return fail(knowledge.status, knowledge.error, { ...(knowledge.issues ? { knowledgeIssues: knowledge.issues } : {}), knowledgeRejected: true });
      }
    }
    if (intakeGrantId) {
      const bound = pmIntakeGrants.bindMessage(projectPath, intakeGrantId, message.id);
      if (!bound.ok) {
        release();
        return fail(409, bound.error, { intakeRejected: true });
      }
    }

    const gathered = await gatherManagerContext(projectPath, config);

    // FO-INT01-03: Detect canonical runbook scenario in owner message and provide structured context as untrusted project data
    const CANONICAL_RUNBOOKS = [
      "startup-mvp",
      "enterprise-feature",
      "marketing-campaign",
      "incident-response",
    ] as const;
    const matchedSlug = CANONICAL_RUNBOOKS.find((s) => message.text.includes(s));
    if (matchedSlug) {
      try {
        const { getRunbookCatalogService } = await import("./catalog/runbook-catalog.ts");
        const { getRoleCatalogService } = await import("./catalog/role-catalog.ts");
        const { HIRING_PROPOSAL_LIMITS } = await import("../shared/hiring/types.ts");
        const rbService = getRunbookCatalogService();
        const roleCatalog = getRoleCatalogService();
        const rb = rbService.getRunbook(matchedSlug);
        const pendingCount = db
          .query<{ n: number }, [string]>(
            `SELECT COUNT(*) AS n FROM hiring_proposals WHERE project_path = ? AND status = 'pending'`,
          )
          .get(projectPath)?.n ?? 0;

        gathered.context.runbookScenario = {
          slug: rb.slug,
          title: rb.title,
          summary: rb.summary,
          mode: rb.mode,
          duration: rb.duration,
          groups: rb.roster.map((g) => ({
            group: g.group,
            activation: g.activation,
            agents: g.agents.map((a) => {
              let competencies: string[] | undefined;
              try {
                const fullRole = roleCatalog.getRole(a.slug);
                const rawComps = fullRole.frontmatter?.competencies ?? fullRole.frontmatter?.skills;
                if (Array.isArray(rawComps)) {
                  competencies = rawComps.filter((c): c is string => typeof c === "string");
                }
              } catch {}
              return {
                slug: a.slug,
                name: a.name,
                division: a.division,
                competencies,
              };
            }),
          })),
          existingTeamCount: gathered.context.team?.length ?? 0,
          projectConstraints: [
            `Maximum pending proposals per project: ${HIRING_PROPOSAL_LIMITS.pendingPerProject}`,
            `Current pending proposals: ${pendingCount}`,
            `Proposals per PM reply limit: ${HIRING_PROPOSAL_LIMITS.perReply}`,
            `Existing active employees: ${gathered.context.team?.length ?? 0}`,
          ],
        };
      } catch {
        // Runbook context loading failure safely ignored
      }
    }

    const decisions = loadDecisions(projectPath).slice(-MANAGER_LIMITS.decisions);
    const prior = history.filter((item) => item.id !== message.id);
    const inheritedKnowledge = (await loadEffectiveKnowledgeForProject(projectPath))?.preview;
    let browserObservation: import("../shared/browser/agent.ts").BrowserAgentObservation | null = null;
    let browserOrigins: string[] = [];
    if (browserGrantId) {
      const grants = await loadBrowserAgentGrants();
      const target = { managerKind: "project-manager" as const, projectPath };
      const known = grants.get(target, browserGrantId);
      const live = known.ok ? await (await defaultBrowserSessionManager()).snapshot(known.value.sessionId) : null;
      const consumed = grants.consume(target, browserGrantId, message.id, turnId, live);
      if (!consumed.ok) {
        release();
        return fail(consumed.status, consumed.error, { browserRejected: true });
      }
      browserObservation = consumed.value;
      browserOrigins = known.ok ? known.value.approvedOrigins : [];
      message = { ...message, browserGrantId };
    }
    let nativeObservation: import("../shared/native-computer/agent.ts").NativeAgentObservation | null = null;
    if (nativeGrantId) {
      const grants = await loadNativeAgentGrants();
      const target = { managerKind: "project-manager" as const, projectPath };
      const known = grants.get(target, nativeGrantId);
      const live = known.ok ? await (await defaultNativeComputerSessionManager()).inspect(known.value.sessionId).catch(() => null) : null;
      const consumed = grants.consume(target, nativeGrantId, message.id, turnId, live);
      if (!consumed.ok) {
        release();
        return fail(consumed.status, consumed.error, { nativeRejected: true });
      }
      nativeObservation = consumed.value;
      message = { ...message, nativeGrantId };
    }
    const prompt = buildManagerPrompt({
      context: gathered.context,
      config,
      decisions,
      history: selectHistory(prior),
      message: message.text,
      catalog: executionCatalog(),
      knowledge: knowledge?.ok ? knowledge.value.documents : undefined,
      brain: brain?.ok ? brain.value.memories : undefined,
      memoryProposals: message.memoryProposalPermission ?? null,
      projectRules: projectRules.list(projectPath),
      inheritedKnowledge,
      browser: browserObservation,
      browserOrigins,
      native: nativeObservation,
    });
    const sources: ContextSource[] = [
      ...gathered.sources,
      ...(gathered.context.runbookScenario
        ? [{
            id: "runbook",
            label: "Selected runbook blueprint",
            path: null,
            status: "included" as const,
            detail: `${gathered.context.runbookScenario.title} (${gathered.context.runbookScenario.slug}).`,
          }]
        : []),
      ...(knowledge?.ok
        ? [{
            id: "knowledge",
            label: "Owner-approved knowledge notes",
            path: null,
            status: "included" as const,
            detail: `${knowledge.value.documents.length} note${knowledge.value.documents.length === 1 ? "" : "s"}, ${knowledge.value.totalBytes.toLocaleString("en-US")} bytes, for this message only.`,
          }]
        : []),
      ...(brain?.ok
        ? [{
            id: "brain",
            label: "Owner-approved Brain memories",
            path: null,
            status: "included" as const,
            detail: `${brain.value.memories.length} memor${brain.value.memories.length === 1 ? "y" : "ies"}, ${brain.value.totalChars.toLocaleString("en-US")} characters, digest ${brain.value.digest.slice(0, 12)}, for this message only: ${brain.value.memories.map((item) => `${item.title} (${item.scope.kind} r${item.revision})`).join("; ")}.`,
          }]
        : []),
      ...(browserObservation
        ? [{
            id: "browser",
            label: "Owner-approved webpage observation",
            path: null,
            status: "included" as const,
            detail: "One untrusted page for this message only. One browser action. This does not run a project task.",
          }]
        : []),
      ...(nativeObservation
        ? [{
            id: "native",
            label: "Owner-approved native window observation",
            path: null,
            status: "included" as const,
            detail: `${nativeObservation.application.bundleId} (${nativeObservation.window.title || "untitled"}), ${nativeObservation.elementCount} elements, for this message only. One native action. This does not run a project task.`,
          }]
        : []),
      {
        id: "decisions",
        label: "Confirmed decisions",
        path: null,
        status: decisions.length > 0 ? "included" : "missing",
        detail: decisions.length > 0 ? `${decisions.length} confirmed.` : "None confirmed yet.",
      },
    ];

    message = { ...message, status: "pending", error: null };
    if (retryId) saveMessage(projectPath, message);
    else appendMessage(projectPath, message);
    projectManagers.touch(projectPath);

    if (brain?.ok && brainGrantId) (await loadBrainContext()).markUsed(brainGrantId);
    pruneSettled();
    const job: ManagerJob = {
      id: turnId,
      projectPath,
      messageId: message.id,
      status: "running",
      error: null,
      startedAt: Date.now(),
      settledAt: null,
      control: { cancelRequested: false, handle: null },
      intakeGrantId,
    };
    jobs.set(turnId, job);
    void runJob(job, preflight.harness, {
      mode: preflight.mode,
      model: preflight.model,
      effort: preflight.effort,
      fast: choice.fast,
      maxMode: choice.maxMode,
      prompt,
      lockdownArgs: preflight.isolation.args,
    }, gathered, sources);
    return { ok: true, value: { turn: viewOf(job), message } };
  } catch (error) {
    release();
    return fail(500, `Couldn't start the manager: ${(error as Error).message}`);
  }
}

type SettledListener = (settled: { projectPath: string; messageId: string; status: ManagerTurnStatus }) => void;
const settledListeners = new Set<SettledListener>();

/** Called after a turn settled and its reply (or failure) was saved. The
 *  portfolio manager uses it to follow a delegated request (FO-008D). */
export function onManagerTurnSettled(listener: SettledListener): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

function settleJob(job: ManagerJob, status: ManagerTurnStatus, error: string | null): void {
  job.status = status;
  job.error = error;
  job.settledAt = Date.now();
  if (runningByProject.get(job.projectPath) === job.id) runningByProject.delete(job.projectPath);
  reconcileProjectDrain(job.projectPath);
  for (const listener of [...settledListeners]) {
    try {
      listener({ projectPath: job.projectPath, messageId: job.messageId, status });
    } catch (err) {
      console.warn("[agetor] manager turn listener threw", err);
    }
  }
}

function markOwner(job: ManagerJob, status: "answered" | "failed" | "cancelled", error: string | null): void {
  const message = loadMessage(job.projectPath, job.messageId);
  if (message) saveMessage(job.projectPath, { ...message, status, error });
}

async function runJob(
  job: ManagerJob,
  harness: Harness,
  opts: { mode: string; model: string; effort: string | null; fast: boolean; maxMode: boolean; prompt: string; lockdownArgs: string[] },
  gathered: GatheredContext,
  sources: ContextSource[],
): Promise<void> {
  try {
    const outcome = await runIsolatedTurn({ turnId: job.id, harness, timeoutMs: TURN_TIMEOUT_MS, ...opts }, job.control);
    if (outcome.kind === "cancelled") {
      markOwner(job, "cancelled", "Cancelled. Nothing was changed.");
      settleJob(job, "cancelled", "Cancelled.");
      return;
    }
    if (outcome.kind === "failed") {
      markOwner(job, "failed", outcome.error);
      settleJob(job, "failed", outcome.error);
      return;
    }
    const parsed = parseManagerReply(outcome.text, gathered.lookup);
    if (!parsed.ok) {
      markOwner(job, "failed", parsed.error);
      settleJob(job, "failed", parsed.error);
      return;
    }
    const reply = parsed.parsed;
    reply.reply = stripBrowserActionMarkup(reply.reply);
    reply.reply = stripNativeActionMarkup(reply.reply);
    const confirmed = new Set(loadDecisions(job.projectPath).map((item) => item.text.toLowerCase()));
    const replyMessage = newMessage("manager", reply.reply, {
      portfolioAttribution: loadMessage(job.projectPath, job.messageId)?.portfolioAttribution,
      delegationId: loadMessage(job.projectPath, job.messageId)?.delegationId,
      plan: reply.plan,
      proposalError: reply.proposalError ?? reply.planError ?? reply.executionError,
      suggestedDecisions: reply.suggestedDecisions.filter((item) => !confirmed.has(item.toLowerCase())),
      sources,
    });
    if (reply.proposal) {
      const now = Date.now();
      const proposal: TaskProposal = {
        id: crypto.randomUUID(),
        projectPath: job.projectPath,
        messageId: replyMessage.id,
        title: reply.proposal.title,
        summary: reply.proposal.summary,
        status: "pending",
        items: annotateDuplicates(reply.proposal.items, gathered.candidates),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      saveProposal(proposal);
      replyMessage.proposalId = proposal.id;
      new ActivityJournalCore(db).record({
        eventType: "task.proposal.created",
        projectPath: job.projectPath,
        actorType: "project-manager",
        actorId: "project-manager",
        targetType: "proposal",
        targetId: proposal.id,
        idempotencyKey: `pm_proposal:${proposal.id}:created`,
        payload: {
          proposalId: proposal.id,
          title: proposal.title,
          summary: proposal.summary,
          itemCount: proposal.items.length,
          taskTitles: proposal.items.map((i) => i.title).filter(Boolean),
        },
        createdAt: now,
      });
    }
    if (reply.execution) {
      // Only a suggestion: it becomes a card the owner reviews and approves.
      const suggested = await proposeFromSuggestion(job.projectPath, reply.execution, replyMessage.id);
      if (suggested.executionId) replyMessage.executionId = suggested.executionId;
      else if (suggested.error && !replyMessage.proposalError) replyMessage.proposalError = `${suggested.error} No run was proposed.`;
    }
    const intakeApplied = applyManagerIntakePromotions(
      job.projectPath,
      job.messageId,
      job.intakeGrantId,
      outcome.text,
      gathered.lookup,
    );
    if (intakeApplied.notes.length > 0) {
      const text = `Intake promotion: ${intakeApplied.notes.join(" ")}`;
      replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${text}` : text;
    }
    if (intakeApplied.promoted.length > 0) {
      replyMessage.intakePromotedTaskIds = intakeApplied.promoted;
    }
    // Assignment suggestions (FO-010D). Untrusted model output: the core
    // resolves every ref against this project's own tasks and workers and
    // stores only what passes the same checks as an owner-entered proposal.
    // Nothing is assigned; the owner reviews each one.
    const drafted = parseAssignmentDrafts(outcome.text);
    if (drafted.drafts.length > 0 || drafted.errors.length > 0) {
      const notes = [...drafted.errors];
      if (drafted.drafts.length > 0) {
        const origin = loadMessage(job.projectPath, job.messageId);
        try {
          const result = new AssignmentProposalCore(db, new AssignmentCore(db)).createFromManager(job.projectPath, drafted.drafts, {
            messageId: replyMessage.id,
            delegationId: origin?.delegationId ?? null,
          });
          notes.push(...result.dropped);
        } catch (err) {
          notes.push(`Assignment suggestions could not be recorded: ${(err as Error).message}`);
        }
      }
      if (notes.length > 0) {
        const text = `Assignment suggestions: ${notes.join(" ")}`;
        replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${text}` : text;
      }
    }
    // Team hiring suggestions (FO-014C). Untrusted model output: validated against
    // the local role catalog, scope, and existing team. No employee is created;
    // proposals become pending items for the owner to review and approve.
    const hiringDrafted = parseHiringDrafts(outcome.text);
    if (hiringDrafted.drafts.length > 0 || hiringDrafted.errors.length > 0) {
      const notes = [...hiringDrafted.errors];
      if (hiringDrafted.drafts.length > 0) {
        try {
          const result = new HiringProposalCore(db).createFromManager(job.projectPath, hiringDrafted.drafts, {
            messageId: replyMessage.id,
          });
          replyMessage.hiringProposalIds = result.created.map((p) => p.id);
          notes.push(...result.dropped);
        } catch (err) {
          notes.push(`Team hiring suggestions could not be recorded: ${(err as Error).message}`);
        }
      }
      if (notes.length > 0) {
        const text = `Team hiring suggestions: ${notes.join(" ")}`;
        replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${text}` : text;
      }
    }
    const ownerMessage = loadMessage(job.projectPath, job.messageId);
    const memoryPermission = ownerMessage?.memoryProposalPermission ?? null;
    const memoryParsed = parseMemoryProposals(outcome.text, memoryPermission, (path) => projects.get(path) != null);
    if (memoryParsed.drafts.length > 0 || memoryParsed.errors.length > 0) {
      const notes = [...memoryParsed.errors];
      if (memoryParsed.drafts.length > 0 && memoryPermission) {
        try {
          const ids = recordMemoryProposals({
            managerKind: "project-manager",
            sourceProjectPath: job.projectPath,
            conversationKey: job.projectPath,
            turnId: job.id,
            messageId: replyMessage.id,
            permission: memoryPermission,
          }, memoryParsed.drafts);
          if (ids.length > 0) replyMessage.memoryProposalIds = ids;
        } catch (err) {
          notes.push(`Memory proposals could not be recorded: ${(err as Error).message}`);
        }
      }
      if (notes.length > 0) {
        const text = `Memory proposals: ${notes.join(" ")}`;
        replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${text}` : text;
      }
    }
    try {
      const settled = await settleBrowserAgentAction(await loadBrowserAgentGrants(), await defaultBrowserSessionManager(), {
        target: { managerKind: "project-manager", projectPath: job.projectPath },
        grantId: ownerMessage?.browserGrantId ?? null,
        messageId: job.messageId,
        turnId: job.id,
        replyText: outcome.text,
      });
      if (settled.record) replyMessage.browserAction = settled.record;
      if (settled.note) replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${settled.note}` : settled.note;
    } catch (err) {
      const text = `Browser action was not run: ${(err as Error).message}`;
      replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${text}` : text;
    }
    try {
      const settledNative = await settleNativeAgentAction(await loadNativeAgentGrants(), await defaultNativeComputerSessionManager(), {
        target: { managerKind: "project-manager", projectPath: job.projectPath },
        grantId: ownerMessage?.nativeGrantId ?? null,
        messageId: job.messageId,
        turnId: job.id,
        replyText: outcome.text,
      });
      if (settledNative.record) replyMessage.nativeAction = settledNative.record;
      if (settledNative.note) replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${settledNative.note}` : settledNative.note;
    } catch (err) {
      const text = `Native action was not run: ${(err as Error).message}`;
      replyMessage.proposalError = replyMessage.proposalError ? `${replyMessage.proposalError} ${text}` : text;
    }
    appendMessage(job.projectPath, replyMessage);
    markOwner(job, "answered", null);
    projectManagers.touch(job.projectPath);
    settleJob(job, "succeeded", null);
  } catch (error) {
    const text = `The reply could not be saved: ${(error as Error).message}`;
    try {
      markOwner(job, "failed", text);
    } catch {
      /* the turn still settles */
    }
    settleJob(job, "failed", text);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Proposals.
 * ────────────────────────────────────────────────────────────────────────── */

function createdTaskIds(proposal: TaskProposal): Set<string> {
  const out = new Set<string>();
  for (const item of proposal.items) {
    if (item.result?.status === "created" && item.result.taskId) out.add(item.result.taskId);
  }
  return out;
}

function candidatesFor(projectPath: string): DuplicateCandidate[] {
  return projectTasks(projectPath)
    .filter((task) => !task.archivedAt)
    .map((task) => ({ id: task.id, title: task.title, column: task.column }));
}

function sameDuplicate(a: ProposalItem["duplicate"], b: ProposalItem["duplicate"]): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "task" && b.kind === "task") return a.taskId === b.taskId;
  if (a.kind === "item" && b.kind === "item") return a.itemId === b.itemId;
  return false;
}

function parseRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function locateProposal(rawPath: unknown, id: string): ManagerResult<TaskProposal> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const proposal = loadProposal(project.value, id);
  if (!proposal) return fail(404, "Proposal not found for this project.");
  return { ok: true, value: proposal };
}

/** Save the owner's edits without approving. */
export function saveProposalEdits(rawPath: unknown, id: string, body: { items?: unknown; revision?: unknown }): ManagerResult<TaskProposal> {
  const located = locateProposal(rawPath, id);
  if (!located.ok) return located;
  const proposal = located.value;
  if (proposal.status === "approved" || proposal.status === "rejected") {
    return fail(409, `This proposal was already ${proposal.status}.`, { proposal });
  }
  if (approving.has(proposal.id)) return fail(409, "This proposal is being approved right now.", { proposal });
  const revision = parseRevision(body.revision);
  if (revision !== proposal.revision) {
    return fail(409, "The proposal changed since you opened it. Review it again.", { proposal });
  }
  const edited = applyItemEdits(proposal.items, body.items);
  if (!edited.ok) return fail(400, edited.error);
  const next: TaskProposal = {
    ...proposal,
    items: annotateDuplicates(edited.items, candidatesFor(proposal.projectPath), createdTaskIds(proposal)),
    revision: proposal.revision + 1,
    updatedAt: Date.now(),
  };
  saveProposal(next);
  return { ok: true, value: next };
}

const approving = new Set<string>();

export interface ApproveResult {
  proposal: TaskProposal;
  /** Task ids created by this call (not earlier attempts). */
  created: string[];
  alreadyApproved: boolean;
}

/** The agent for new backlog tasks: same default as the New Task form. */
function defaultTaskAgent(): string | undefined {
  const enabled = harnesses.list().filter((harness) => harness.enabled);
  const preferred = preferences.get("defaultHarness");
  if (preferred && enabled.some((harness) => harness.id === preferred)) return preferred;
  return enabled[0]?.id;
}

function resolveDependencies(item: ProposalItem, items: ProposalItem[]): ResolvedDependency[] {
  return item.dependsOn.map((dep) => {
    if (dep.kind === "task") return { title: dep.title, taskId: dep.taskId };
    const target = items.find((other) => other.id === dep.itemId);
    const taskId = target?.result && (target.result.status === "created" || target.result.status === "linked")
      ? target.result.taskId
      : null;
    return { title: target?.title ?? dep.itemId, taskId };
  });
}

type CreateTaskFn = typeof createTask;

/** Write dependency links and priorities for the tasks created in this
 *  approval. Returns the links that couldn't be made. */
function applyProposalScheduling(projectPath: string, items: ProposalItem[], created: string[]): string[] {
  const createdNow = new Set(created);
  const taskOf = (item: ProposalItem | undefined) =>
    item?.result && (item.result.status === "created" || item.result.status === "linked") ? item.result.taskId : null;
  const links: { taskId: string; dependsOn: string[] }[] = [];
  for (const item of items) {
    if (item.result?.status !== "created" || !item.result.taskId) continue;
    const taskId = item.result.taskId;
    if (createdNow.has(taskId)) taskScheduling.setPriority(taskId, priorityFromProposal(item.priority));
    const dependsOn: string[] = [];
    for (const dep of item.dependsOn) {
      const target = dep.kind === "task" ? dep.taskId : taskOf(items.find((other) => other.id === dep.itemId));
      if (!target) continue;
      if (createdNow.has(taskId) || createdNow.has(target)) dependsOn.push(target);
    }
    if (dependsOn.length > 0) links.push({ taskId, dependsOn });
  }
  return links.length > 0 ? linkProposalDependencies(projectPath, links) : [];
}

/**
 * Create the reviewed tasks in the project's backlog. Idempotent: items
 * already created or linked are never created again, a second approve of
 * the same proposal while one runs is refused, and a finished proposal
 * answers with its stored results. A failure on one item doesn't undo the
 * others; the proposal stays `partial` and a retry creates only what's
 * left. Tasks go through `createTask` with column `backlog` — no agent is
 * started and no worktree is created.
 */
export async function approveProposal(
  rawPath: unknown,
  id: string,
  body: { items?: unknown; revision?: unknown },
  deps: { createTask?: CreateTaskFn } = {},
): Promise<ManagerResult<ApproveResult>> {
  const located = locateProposal(rawPath, id);
  if (!located.ok) return located;
  let proposal = located.value;
  if (approving.has(proposal.id)) return fail(409, "This proposal is already being approved.", { proposal });
  if (proposal.status === "rejected") return fail(409, "This proposal was rejected.", { proposal });
  if (proposal.status === "approved") return { ok: true, value: { proposal, created: [], alreadyApproved: true } };
  const revision = parseRevision(body.revision);
  if (revision !== proposal.revision) {
    return fail(409, "The proposal changed since you reviewed it. Review it again before approving.", { proposal });
  }
  const create = deps.createTask ?? createTask;
  approving.add(proposal.id);
  try {
    const edited = applyItemEdits(proposal.items, body.items);
    if (!edited.ok) return fail(400, edited.error);
    const cyclic = proposalCycleMessage(edited.items.filter((item) => item.include));
    if (cyclic) return fail(409, `This plan can't be approved: ${cyclic}. Nothing was created.`);
    for (const item of edited.items) {
      if (!item.include || plannedAction(item) !== "create") continue;
      if (!item.title || !item.description || item.acceptanceCriteria.length === 0) {
        return fail(400, `“${item.title || item.id}” needs a title, a description and at least one acceptance criterion.`);
      }
    }
    const projectPath = proposal.projectPath;
    const own = createdTaskIds(proposal);
    const rechecked = annotateDuplicates(edited.items, candidatesFor(projectPath), own);
    // The board may have gained a matching task since the owner reviewed
    // the proposal. Creating it anyway would be a duplicate the owner never
    // saw, so stop and show it instead.
    const surprise = rechecked.some((item, index) => {
      const before = edited.items[index]!;
      return item.include && !before.result && item.duplicate && !sameDuplicate(item.duplicate, before.duplicate);
    });
    if (surprise) {
      const next = { ...proposal, items: rechecked, revision: proposal.revision + 1, updatedAt: Date.now() };
      saveProposal(next);
      return fail(409, "A matching task appeared on the board since you reviewed this. Check the marked items and approve again.", { proposal: next });
    }

    const capability = await gitWorkingTreeCapability(projectPath);
    if (capability.kind === "unknown") return fail(409, "Cannot verify the project's Git capability. No tasks were created; check the folder and Git installation before approving again.");
    const isolation = capability.kind === "git" ? "worktree" : "none";

    const attemptStartedAt = Date.now();
    proposal = { ...proposal, items: rechecked, revision: proposal.revision + 1, updatedAt: attemptStartedAt };
    saveProposal(proposal);
    const agent = defaultTaskAgent();
    const created: string[] = [];
    const persistItem = (itemId: string, result: ProposalItem["result"]) => {
      proposal = {
        ...proposal,
        items: proposal.items.map((item) => (item.id === itemId ? { ...item, result } : item)),
        updatedAt: Date.now(),
      };
      saveProposal(proposal);
    };

    for (const ordered of creationOrder(proposal.items)) {
      const item = proposal.items.find((candidate) => candidate.id === ordered.id)!;
      const action = plannedAction(item);
      if (action === "done") continue;
      const at = Date.now();
      if (action === "skip") {
        persistItem(item.id, { status: "skipped", taskId: null, error: null, at });
        continue;
      }
      if (action === "link") {
        const dup = item.duplicate!;
        if (dup.kind === "task") {
          persistItem(item.id, { status: "linked", taskId: dup.taskId, error: null, at });
        } else {
          const target = proposal.items.find((other) => other.id === dup.itemId);
          const targetId = target?.result && (target.result.status === "created" || target.result.status === "linked")
            ? target.result.taskId
            : null;
          persistItem(item.id, targetId
            ? { status: "linked", taskId: targetId, error: null, at }
            : { status: "failed", taskId: null, error: `“${dup.title}”, which this item repeats, wasn't created.`, at });
        }
        continue;
      }
      const input = proposalItemToTaskInput(item, resolveDependencies(item, proposal.items));
      // A crash between `createTask` and the save below would leave the
      // item "creating" with its task already on the board: adopt it.
      if (item.result?.status === "creating") {
        const adopted = projectTasks(projectPath).find((task) =>
          task.title === input.title && task.prompt === input.prompt && task.createdAt >= item.result!.at - 1000);
        if (adopted) {
          persistItem(item.id, { status: "created", taskId: adopted.id, error: null, at });
          continue;
        }
      }
      persistItem(item.id, { status: "creating", taskId: null, error: null, at });
      let outcome: Awaited<ReturnType<CreateTaskFn>>;
      try {
        outcome = await create({
          title: input.title,
          prompt: input.prompt,
          taskType: input.taskType,
          workdir: projectPath,
          isolation,
          column: "backlog",
          ...(agent ? { agent } : {}),
        });
      } catch (error) {
        outcome = { error: (error as Error).message };
      }
      if ("error" in outcome) {
        persistItem(item.id, { status: "failed", taskId: null, error: capText(outcome.error, 500), at: Date.now() });
        continue;
      }
      created.push(outcome.task.id);
      persistItem(item.id, { status: "created", taskId: outcome.task.id, error: null, at: Date.now() });
    }

    // Structured scheduling (FO-005C.1): the links and priorities the
    // owner reviewed on the card become real dependency rows for the tasks
    // created now. Linked (existing) tasks are left as they are. Nothing is
    // started, and no batch is prepared.
    const linkWarnings = applyProposalScheduling(projectPath, proposal.items, created);
    const status = settledProposalStatus(proposal.items);
    proposal = { ...proposal, status, structuredDependencies: true, updatedAt: Date.now() };
    saveProposal(proposal);

    const failed = proposal.items.filter((item) => item.result?.status === "failed");
    const titles = proposal.items
      .filter((item) => item.result?.status === "created" && item.result.taskId && created.includes(item.result.taskId))
      .map((item) => item.title);
    const linked = proposal.items.filter((item) => item.result?.status === "linked").length;
    const parts: string[] = [];
    parts.push(titles.length > 0 ? `Added ${titles.length} task${titles.length === 1 ? "" : "s"} to the backlog.` : "No new tasks were added.");
    if (linked > 0) parts.push(`${linked} matched existing task${linked === 1 ? "" : "s"}.`);
    if (failed.length > 0) parts.push(`${failed.length} failed — approve again to retry ${failed.length === 1 ? "it" : "them"}.`);
    if (linkWarnings.length > 0) parts.push(`Some dependencies weren't linked: ${linkWarnings.join(" ")}`);
    appendMessage(projectPath, newMessage("system", `“${proposal.title}”: ${parts.join(" ")}`, { proposalId: proposal.id }));
    if (titles.length > 0) {
      projectManagers.addDecision(
        projectPath,
        crypto.randomUUID(),
        capText(`Approved “${proposal.title}”: added ${titles.map((title) => `“${title}”`).join(", ")} to the backlog.`, MANAGER_LIMITS.decisionChars),
        "approval",
      );
    }
    projectManagers.touch(projectPath);
    return { ok: true, value: { proposal, created, alreadyApproved: false } };
  } finally {
    approving.delete(proposal.id);
  }
}

export function rejectProposal(rawPath: unknown, id: string): ManagerResult<TaskProposal> {
  const located = locateProposal(rawPath, id);
  if (!located.ok) return located;
  const proposal = located.value;
  if (approving.has(proposal.id)) return fail(409, "This proposal is being approved right now.", { proposal });
  if (proposal.status === "rejected") return { ok: true, value: proposal };
  if (proposal.status === "approved") return fail(409, "This proposal was already approved.", { proposal });
  const next: TaskProposal = { ...proposal, status: "rejected", revision: proposal.revision + 1, updatedAt: Date.now() };
  saveProposal(next);
  const created = proposal.items.filter((item) => item.result?.status === "created").length;
  appendMessage(
    proposal.projectPath,
    newMessage("system", created > 0
      ? `“${proposal.title}” dismissed. The ${created} task${created === 1 ? "" : "s"} already added stay on the board.`
      : `“${proposal.title}” rejected. No tasks were created.`, { proposalId: proposal.id }),
  );
  projectManagers.touch(proposal.projectPath);
  return { ok: true, value: next };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Decisions.
 * ────────────────────────────────────────────────────────────────────────── */

export function addManagerDecision(rawPath: unknown, body: { text?: unknown; source?: unknown }): ManagerResult<ManagerDecision> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return fail(400, "Write the decision first.");
  if (text.length > MANAGER_LIMITS.decisionChars) return fail(400, `Decisions are limited to ${MANAGER_LIMITS.decisionChars} characters.`);
  const existing = loadDecisions(project.value);
  const same = existing.find((item) => item.text.toLowerCase() === text.toLowerCase());
  if (same) return { ok: true, value: same };
  if (existing.length >= MANAGER_LIMITS.decisions * 4) return fail(409, "Too many decisions saved. Remove some first.");
  const source = body.source === "manager" ? "manager" : "owner";
  const id = crypto.randomUUID();
  projectManagers.addDecision(project.value, id, text, source);
  projectManagers.touch(project.value);
  return { ok: true, value: { id, text, source, createdAt: Date.now() } };
}

export function deleteManagerDecision(rawPath: unknown, id: string): ManagerResult<{ deleted: boolean }> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  return { ok: true, value: { deleted: projectManagers.deleteDecision(project.value, id) } };
}

export const __testing = {
  jobs,
  runningByProject,
  approving,
  reset(): void {
    jobs.clear();
    runningByProject.clear();
    approving.clear();
  },
};
