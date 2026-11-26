import { headUsageEvidence } from "./usage-analytics/head.ts";
import { HeadPortfolioBindingCore, HeadBindingError } from "./head-portfolio-binding.ts";
import { AccountCore } from "./account-core.ts";
import type { PortfolioTurnAttribution } from "../shared/head-portfolio-binding.ts";
/**
 * Global portfolio manager (FO-008C): one logical AI manager over every
 * registered project.
 *
 * Nothing here runs in the background. The model is called only when the
 * owner sends a message (or retries one); each message is one isolated turn
 * through the same runner, pre-flight and restrictions the project manager
 * uses (`isolated-agent-turn.ts`, `interviewPreflight`): an empty scratch
 * folder, the harness's most restricted mode, the portfolio context inline.
 *
 * Context is the portfolio snapshot the core already builds (FO-008A/B) —
 * boards, runs, batches, environments, estimates, resources — never project
 * files, credentials or source. Replies are parsed strictly; a plan is a
 * read-only card, and a delegation is one message the owner may approve.
 *
 * Approving a delegation is the only thing that leaves this module: it goes
 * through the project's own `sendManagerMessage`, so that project's agent,
 * consent and checks apply, and the answer lands in that project's manager
 * history. Its result comes back here as an observation when the state is
 * read. No second global turn is started on its own.
 */

import { parseHeadScope } from "../shared/head-pm-scope.ts";
import { gatherScopedHeadContext, resolveHeadScope, sameHeadScope, type ScopedHeadContext } from "./head-pm-scope.ts";
import { headBoardProposals, readHeadBoardDraft, saveHeadBoardDraft } from "./head-board-proposals.ts";
import { db, agentProfiles, harnesses, portfolioManagerStore, projectManagers, projects } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import {
  cancelIsolatedTurn,
  isolatedRunId,
  isolatedSessionKey,
  isolatedTurnScratchDir,
  runIsolatedTurn,
  type IsolatedTurnControl,
} from "./isolated-agent-turn.ts";
import {
  authorizeSupervisedLaunch,
  buildHeadTurnOperation,
  discardUnconsumedLaunchTicket,
  isProductionOwnerGateActive,
} from "./owner-trust/launch-gate.ts";
import { isClaudeProfile, selectedClaudeAccount } from "./claude-profiles.ts";
import { isCodexProfile, selectedCodexAccount } from "./codex-profiles.ts";
import { recordProviderRefusal, supersedeProviderRefusals } from "./provider-refusals.ts";
import type { ProviderRefusalSummary } from "../shared/provider-refusal.ts";
import { buildPortfolioSnapshot } from "./portfolio-adapter.ts";
import { interviewPreflight } from "./project-interview.ts";
import { activeManagerTurn, getManagerState, onManagerTurnSettled, sendManagerMessage, type ManagerResult } from "./project-manager.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { analyzePortfolio } from "../shared/portfolio/index.ts";
import type { PortfolioAnalysis, PortfolioSnapshotInput, ProjectSummary } from "../shared/portfolio/types.ts";
import { formatCalendar, formatCash, formatDurationForecast, formatDurationMs, formatMoney } from "../shared/estimation/present.ts";
import { capText, interviewSupportFor, lastTagBody, redactSecrets, type InterviewIsolation } from "../shared/project-interview.ts";
import {
  DEFAULT_MANAGER_CONFIG,
  sanitizeManagerConfig,
  sanitizeStoredMessage,
  sanitizeStoredProposal,
  selectHistory,
  type ContextSource,
  type ManagerConfig,
  type ManagerMessage,
} from "../shared/project-manager.ts";
import {
  PORTFOLIO_MANAGER_LIMITS as L,
  buildPortfolioPrompt,
  observationSummary,
  parsePortfolioReply,
  sanitizeDelegation,
  sanitizePortfolioMessage,
  sanitizePortfolioPlan,
  type DelegationDraft,
  type DelegationProposal,
  type DelegationResult,
  type DelegationTarget,
  type DelegationView,
  type PortfolioDecision,
  type PortfolioManagerMessage,
  type PortfolioManagerState,
  type PortfolioObservation,
  type PortfolioPlan,
  type PortfolioPromptContext,
  type PortfolioPromptProject,
  type ProjectRefs,
} from "../shared/portfolio-manager.ts";
import { usageNoticeFor } from "../shared/project-execution.ts";
import type { ColumnId, Harness } from "../shared/types.ts";
import { loadBrainContext, type BrainConsumedContext, type ContextResult as BrainResult } from "./brain-context.ts";
import { parseMemoryProposalPermission, parseMemoryProposals } from "../shared/brain/proposals.ts";
import { isBrowserGrantId, stripBrowserActionMarkup } from "../shared/browser/agent.ts";
import { loadBrowserAgentGrants, settleBrowserAgentAction } from "./browser-agent.ts";
import { defaultBrowserSessionManager } from "./browser-session.ts";
import { isNativeGrantId, stripNativeActionMarkup } from "../shared/native-computer/agent.ts";
import { loadNativeAgentGrants, reconcileInterruptedNativeMessage, settleNativeAgentAction } from "./native-computer-agent.ts";
import { defaultNativeComputerSessionManager } from "./native-computer-session.ts";
import { recordMemoryProposals } from "./brain-proposals.ts";
import { loadKnowledgeContext, type ContextResult } from "./knowledge-context.ts";
import { loadEffectiveKnowledgeForProject } from "./knowledge-effective.ts";
import { buildHeadPmKnowledgeSummaries, renderHeadPmKnowledgeSection } from "../shared/knowledge/effective.ts";
import { isBrainGrantId } from "../shared/brain/context.ts";
import { isGrantId, type KnowledgePromptDocument } from "../shared/knowledge/context.ts";
import {
  buildHeadPmCoordination,
  companyStructureLines,
  projectCoordinationExtraLines,
} from "./head-pm-coordination.ts";
import {
  approveHeadPmInitiativeProposal,
  dismissHeadPmInitiativeProposal,
  listHeadPmInitiativeProposals,
  patchHeadPmInitiativeProposal,
  rejectHeadPmInitiativeProposal,
  saveHeadPmInitiativeProposal,
} from "./head-pm-initiative-proposal.ts";
import { tryAnswerInitiativeStatusQuestion } from "./head-pm-initiative-status.ts";
import { objectivePrompt, parseObjectiveRequest, saveObjectiveDraft, type ObjectiveRequest } from "./orchestration/objective-mission.ts";
import { tryAnswerOrchestrationQuestion } from "./orchestration/head-pm-integration.ts";
import { tryAnswerInfraQuestion } from "./infra-auto/head-answers.ts";
import type { HeadPmCoordinationSnapshot } from "../shared/head-pm-coordination.ts";

const TURN_TIMEOUT_MS = Number(process.env.AGETOR_PORTFOLIO_TURN_TIMEOUT_MS ?? 0) || 5 * 60_000;
const SETTLED_TTL_MS = 10 * 60_000;

export type PortfolioResult<T> = ManagerResult<T>;

function fail<T>(status: number, error: string, body?: Record<string, unknown>): PortfolioResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Storage helpers.
 * ────────────────────────────────────────────────────────────────────────── */

function loadConfig(): ManagerConfig {
  const row = portfolioManagerStore.getConfig();
  // The portfolio manager never reads project documents.
  return row ? { ...sanitizeManagerConfig(parseJson(row.config)), extraDocs: [] } : { ...DEFAULT_MANAGER_CONFIG };
}

function loadMessages(): PortfolioManagerMessage[] {
  return portfolioManagerStore.listMessages()
    .map((raw) => sanitizePortfolioMessage(parseJson(raw)))
    .filter((item): item is PortfolioManagerMessage => item != null);
}

function loadMessage(id: string): PortfolioManagerMessage | null {
  return sanitizePortfolioMessage(parseJson(portfolioManagerStore.getMessage(id)));
}

function appendMessage(message: PortfolioManagerMessage): void {
  portfolioManagerStore.appendMessage(message.id, JSON.stringify(message), L.messagesKept);
}

function saveMessage(message: PortfolioManagerMessage): void {
  portfolioManagerStore.updateMessage(message.id, JSON.stringify(message));
}

function loadPlans(): PortfolioPlan[] {
  return portfolioManagerStore.listPlans()
    .map((raw) => sanitizePortfolioPlan(parseJson(raw)))
    .filter((item): item is PortfolioPlan => item != null);
}

function savePlan(plan: PortfolioPlan): void {
  portfolioManagerStore.putPlan(plan.id, plan.messageId, plan.status, JSON.stringify(plan), plan.createdAt);
}

function loadDelegation(id: string): DelegationProposal | null {
  return sanitizeDelegation(parseJson(portfolioManagerStore.getDelegation(id)));
}

function loadDelegations(): DelegationProposal[] {
  return portfolioManagerStore.listDelegations()
    .map((raw) => sanitizeDelegation(parseJson(raw)))
    .filter((item): item is DelegationProposal => item != null);
}

function saveDelegation(item: DelegationProposal): void {
  portfolioManagerStore.putDelegation(item.id, item.projectPath, item.messageId, item.status, JSON.stringify(item), item.createdAt);
}

/** Ids and status only on the shared `/app/events` stream (FO-008D): the
 *  tab re-reads the state; no request text, answer or credential is sent. */
function announce(item: DelegationProposal): void {
  try {
    broadcastAppEvent({ type: "portfolio_delegation", delegationId: item.id, projectPath: item.projectPath, status: item.status, ts: Date.now() });
  } catch (err) {
    console.warn("[agetor] portfolio delegation event failed", err);
  }
}

/** Persist a status change and announce it. */
function transition(item: DelegationProposal): void {
  saveDelegation(item);
  announce(item);
}

function loadDecisions(): PortfolioDecision[] {
  return portfolioManagerStore.listDecisions().map((row) => ({
    id: row.id,
    text: row.text,
    source: row.source === "manager" || row.source === "approval" ? row.source : "owner",
    createdAt: row.created_at,
  }));
}

function addDecisionOnce(text: string, source: PortfolioDecision["source"]): void {
  const value = capText(text.replace(/\s+/g, " ").trim(), L.decisionChars);
  if (!value) return;
  if (loadDecisions().some((item) => item.text.toLowerCase() === value.toLowerCase())) return;
  portfolioManagerStore.addDecision(crypto.randomUUID(), value, source);
}

function newMessage(role: PortfolioManagerMessage["role"], text: string, fields: Partial<PortfolioManagerMessage> = {}): PortfolioManagerMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: Date.now(),
    status: null,
    error: null,
    planId: null,
    delegationIds: [],
    initiativeProposalId: null,
    protocolErrors: [],
    suggestedDecisions: [],
    sources: [],
    delegationId: null,
    ...fields,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Turn registry (in memory; one global turn at a time).
 * ────────────────────────────────────────────────────────────────────────── */

export type PortfolioTurnStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface PortfolioTurnView {
  attribution?: PortfolioTurnAttribution;
  missionId?: string;
  id: string;
  messageId: string;
  status: PortfolioTurnStatus;
  error: string | null;
  startedAt: number;
  settledAt: number | null;
}

interface PortfolioJob extends PortfolioTurnView {
  objective?: ObjectiveRequest;
  scoped?: ScopedHeadContext;
  control: IsolatedTurnControl;
}

const jobs = new Map<string, PortfolioJob>();
let runningTurnId: string | null = null;

function viewOf(job: PortfolioJob): PortfolioTurnView {
  return { attribution: job.attribution, missionId: job.missionId, id: job.id, messageId: job.messageId, status: job.status, error: job.error, startedAt: job.startedAt, settledAt: job.settledAt };
}

function pruneSettled(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.settledAt != null && now - job.settledAt > SETTLED_TTL_MS) jobs.delete(id);
  }
}

export function getPortfolioTurn(id: string): PortfolioTurnView | null {
  pruneSettled();
  const job = jobs.get(id);
  return job ? viewOf(job) : null;
}

export function cancelPortfolioTurn(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  cancelIsolatedTurn(job.control);
  return true;
}

function activeTurn(): PortfolioManagerState["activeTurn"] {
  const job = runningTurnId ? jobs.get(runningTurnId) : undefined;
  return job && job.status === "running" ? { id: job.id, messageId: job.messageId, startedAt: job.startedAt } : null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Delegation targets and reconciliation.
 * ────────────────────────────────────────────────────────────────────────── */

function envNames(): string[] {
  return Object.keys(process.env);
}

/** The project's own manager as configured now. Stored rows only. */
export function delegationTarget(projectPath: string): DelegationTarget {
  const empty: DelegationTarget = {
    registered: false,
    managerConfigured: false,
    harnessId: null,
    harnessLabel: null,
    model: null,
    consentConfirmed: false,
    problem: null,
    usageNotice: null,
  };
  if (!projects.get(projectPath)) return { ...empty, problem: "This project is no longer registered." };
  const row = projectManagers.getConfig(projectPath);
  const config = row ? sanitizeManagerConfig(parseJson(row.config)) : { ...DEFAULT_MANAGER_CONFIG };
  let harnessId = config.harness;
  let model = config.model;
  if (config.profileId) {
    const profile = agentProfiles.get(config.profileId);
    if (!profile) return { ...empty, registered: true, problem: "The agent profile picked for this project's manager no longer exists." };
    harnessId = profile.harness;
    model = profile.model;
  }
  if (!harnessId) {
    return { ...empty, registered: true, problem: "This project's manager has no agent yet. Open the project's Manager tab and choose one." };
  }
  const harness = harnesses.getByIdOrKind(harnessId);
  const base: DelegationTarget = {
    ...empty,
    registered: true,
    managerConfigured: true,
    harnessId,
    harnessLabel: harness?.label ?? harnessId,
    model,
    consentConfirmed: config.consentKey != null,
  };
  if (!harness) return { ...base, problem: `Harness "${harnessId}" of this project's manager was not found.` };
  if (!harness.enabled) return { ...base, problem: `${harness.label} is disabled. Enable it in Settings first.` };
  const support = interviewSupportFor(harness.kind);
  if (!support.supported) return { ...base, problem: `${harness.label}: ${support.reason}` };
  const notice = usageNoticeFor(harness.kind, harness.label, [...envNames(), ...Object.keys(harness.env ?? {})]);
  if (!base.consentConfirmed) {
    return { ...base, usageNotice: notice, problem: "Confirm the agent in this project's Manager tab before sending it requests." };
  }
  return { ...base, usageNotice: notice };
}

function loadPmMessages(projectPath: string): ManagerMessage[] {
  return projectManagers.listMessages(projectPath)
    .map((raw) => sanitizeStoredMessage(parseJson(raw)))
    .filter((item): item is ManagerMessage => item != null);
}

const approving = new Set<string>();

function systemNote(delegation: DelegationProposal, text: string): void {
  appendMessage(newMessage("system", text, { delegationId: delegation.id, attribution: delegation.attribution }));
}

function resultFromAnswer(projectPath: string, owner: ManagerMessage, now: number): DelegationResult {
  const messages = loadPmMessages(projectPath);
  const at = messages.findIndex((item) => item.id === owner.id);
  const reply = at >= 0 ? messages.slice(at + 1).find((item) => item.role === "manager") ?? null : null;
  const proposal = reply?.proposalId ? sanitizeStoredProposal(parseJson(projectManagers.getProposal(projectPath, reply.proposalId))) : null;
  return {
    status: "answered",
    reply: reply ? capText(redactSecrets(reply.text).trim(), L.observationChars) : "",
    planTitle: reply?.plan?.title ?? null,
    planSteps: reply?.plan?.steps?.length ?? 0,
    proposalTitle: proposal?.title ?? null,
    proposalTasks: proposal?.items.length ?? 0,
    runSuggested: reply?.executionId != null,
    error: null,
    observedAt: now,
    replyMessageId: reply?.id ?? null,
  };
}

/**
 * Bring one delegation up to date from the project manager's own history.
 * Writes only when something changed. Never starts a turn.
 */
function reconcileDelegation(item: DelegationProposal): DelegationProposal {
  const now = Date.now();
  let current = item;
  if (current.status === "sending" && !approving.has(current.id)) {
    // The app stopped between claiming the row and recording the send.
    const sent = loadPmMessages(current.projectPath).find((message) => message.delegationId === current.id);
    current = sent
      ? { ...current, status: "sent", pmMessageId: sent.id, error: null, updatedAt: now }
      : { ...current, status: "failed", error: "The app closed before the request was sent. Nothing was sent; approve again to retry.", updatedAt: now };
    transition(current);
  }
  if (current.status !== "sent" || !current.pmMessageId) return current;
  let owner = sanitizeStoredMessage(parseJson(projectManagers.getMessage(current.projectPath, current.pmMessageId)));
  if (owner?.status === "pending" && activeManagerTurn(current.projectPath)?.messageId !== owner.id) {
    // The project manager lost its turn (app exit); let it mark the message.
    getManagerState(current.projectPath);
    owner = sanitizeStoredMessage(parseJson(projectManagers.getMessage(current.projectPath, current.pmMessageId)));
  }
  if (!owner) {
    current = {
      ...current,
      status: "failed",
      error: "The project manager's copy of this request is no longer in its history.",
      result: { status: "failed", reply: "", planTitle: null, planSteps: 0, proposalTitle: null, proposalTasks: 0, runSuggested: false, error: "Request not found in the project manager history.", observedAt: now, replyMessageId: null },
      settledAt: now,
      updatedAt: now,
    };
    transition(current);
    systemNote(current, `The request to the project manager of ${current.projectName} can no longer be followed.`);
    return current;
  }
  if (owner.status === "answered") {
    const result = resultFromAnswer(current.projectPath, owner, now);
    current = { ...current, status: "answered", error: null, result, settledAt: now, updatedAt: now };
    transition(current);
    systemNote(current, `The project manager of ${current.projectName} answered “${current.objective}”. The answer is saved in that project's manager chat and will be included the next time you ask here.`);
    return current;
  }
  if (owner.status === "failed" || owner.status === "cancelled") {
    const error = owner.error ?? (owner.status === "cancelled" ? "The project manager's request was cancelled." : "The project manager didn't answer.");
    current = {
      ...current,
      status: "failed",
      error,
      result: { status: owner.status, reply: "", planTitle: null, planSteps: 0, proposalTitle: null, proposalTasks: 0, runSuggested: false, error, observedAt: now, replyMessageId: null },
      settledAt: now,
      updatedAt: now,
    };
    transition(current);
    systemNote(current, `The project manager of ${current.projectName} didn't answer “${current.objective}”: ${capText(error, 300)} Approve it again to retry.`);
  }
  return current;
}

function withTarget(item: DelegationProposal): DelegationView {
  return { ...item, target: delegationTarget(item.projectPath) };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * State and config.
 * ────────────────────────────────────────────────────────────────────────── */

function headBindingCore(): HeadPortfolioBindingCore {
  return new HeadPortfolioBindingCore(db, () => runningTurnId !== null || approving.size > 0
    || loadDelegations().some(d => d.status === "sending"));
}
export function getHeadPortfolioBinding() {
  return { ok: true as const, value: headBindingCore().get() };
}
export function changeHeadPortfolioBinding(body: unknown) {
  try {
    // Existing recovery never invokes AI; reconcile orphaned sending rows first.
    recoverPortfolioDelegations();
    return { ok: true as const, value: headBindingCore().change(body) };
  } catch (error) {
    return fail(error instanceof HeadBindingError ? error.status : 500,
      error instanceof HeadBindingError ? error.message : "Head binding operation failed.");
  }
}

export function getPortfolioManagerState(): PortfolioResult<PortfolioManagerState> {
  const turn = activeTurn();
  // An owner message left "pending" with no turn behind it lost its turn to
  // an app exit: mark it failed so it can be retried.
  for (const message of loadMessages()) {
    if (message.role !== "owner" || message.status !== "pending" || message.id === turn?.messageId) continue;
    const reconciled = reconcileInterruptedNativeMessage(message, db);
    saveMessage({
      ...message,
      status: "failed",
      error: reconciled.error,
      ...(reconciled.nativeAction ? { nativeAction: reconciled.nativeAction } : {}),
    });
  }
  const delegations = loadDelegations().map(reconcileDelegation).map(withTarget);
  const messages = loadMessages();
  return {
    ok: true,
    value: {
      headBinding: headBindingCore().get(),
      config: loadConfig(),
      messages,
      boardProposals: headBoardProposals(new Set(messages.map((message) => message.id))),
      plans: loadPlans(),
      initiativeProposals: listHeadPmInitiativeProposals(),
      delegations,
      decisions: loadDecisions(),
      activeTurn: turn,
      lastActivityAt: portfolioManagerStore.getConfig()?.lastActivityAt ?? null,
    },
  };
}

export function updatePortfolioManagerConfig(rawConfig: unknown): PortfolioResult<ManagerConfig> {
  const config = { ...sanitizeManagerConfig(rawConfig), extraDocs: [] };
  if (config.profileId && !agentProfiles.get(config.profileId)) return fail(400, "That agent profile no longer exists.");
  if (config.harness && !harnesses.getByIdOrKind(config.harness)) return fail(400, `Harness "${config.harness}" was not found.`);
  portfolioManagerStore.setConfig(JSON.stringify(config));
  return { ok: true, value: config };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Portfolio context.
 * ────────────────────────────────────────────────────────────────────────── */

const COLUMN_ORDER: ColumnId[] = ["backlog", "inbox", "ready", "running", "blocked", "review", "done"];
const COLUMN_LABEL: Record<ColumnId, string> = {
  backlog: "Backlog",
  inbox: "Inbox",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

function clean(text: string, max: number): string {
  return capText(redactSecrets(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), max);
}

function iso(ms: number | null): string {
  return ms == null ? "an unknown time" : new Date(ms).toISOString();
}

function countText(value: number | null, noun: string): string {
  return value == null ? `${noun}: unknown` : `${noun}: ${value}`;
}

function titleList(
  tasks: PortfolioSnapshotInput["projects"][number]["tasks"],
  column: ColumnId,
): string | null {
  const rows = tasks.filter((task) => !task.archived && !task.pipelineParentId && task.column === column);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, L.titlesPerList).map((task) => `#${task.id.slice(0, 8)} ${clean(task.title, L.titleChars)}`);
  const more = rows.length > shown.length ? ` (+${rows.length - shown.length} more)` : "";
  return `${COLUMN_LABEL[column]} tasks: ${shown.join("; ")}${more}`;
}

function environmentLine(summary: ProjectSummary): string {
  if (summary.environmentPhase) {
    return `Environment: ${summary.environmentPhase} (recorded ${iso(summary.environmentPhaseObservedAtMs)}).`;
  }
  if (summary.environmentRecordedPhase) {
    return `Environment: current state unknown — last recorded ${summary.environmentRecordedPhase} at ${iso(summary.environmentPhaseObservedAtMs)}; it was not probed.`;
  }
  if (summary.environmentConfigured === false) return "Environment: no launch profile is configured.";
  return "Environment: unknown.";
}

function managerLine(projectPath: string): string {
  const target = delegationTarget(projectPath);
  if (!target.managerConfigured) return "Project manager: no agent configured, so a delegation to it would fail until the owner sets one.";
  const agent = `${target.harnessLabel ?? target.harnessId}${target.model ? ` · ${target.model}` : ""}`;
  return target.problem ? `Project manager: ${agent}, not ready (${target.problem})` : `Project manager: ${agent}.`;
}

function estimateLine(analysis: PortfolioAnalysis, projectId: string): string {
  const slice = analysis.estimation?.projects.find((item) => item.projectId === projectId) ?? null;
  if (!slice || !slice.agent) return "Estimate: none saved for this project.";
  const parts = [`agent time ${formatDurationForecast(slice.agent).headline}`];
  if (slice.calendar) parts.push(`calendar ${formatCalendar(slice.calendar).headline}`);
  if (slice.additionalCash) parts.push(`additional cash ${formatCash(slice.additionalCash).headline}`);
  if (slice.apiEquivalent) parts.push(`API-equivalent (not real spending) ${formatCash(slice.apiEquivalent).headline}`);
  parts.push(`confidence ${slice.confidence ?? "unknown"}`);
  if (!slice.current) parts.push("not current");
  return `Estimate (${slice.scenario ?? "scenario unknown"}): ${parts.join(", ")}.`;
}

function projectLines(
  summary: ProjectSummary,
  analysis: PortfolioAnalysis,
  snapshot: PortfolioSnapshotInput,
): string[] {
  const health = analysis.health.find((item) => item.projectId === summary.projectId);
  const source = snapshot.projects.find((item) => item.id === summary.projectId);
  const lines: string[] = [];
  lines.push(`Signals: ${health?.signals.join(", ") || "none"}; snapshot ${summary.freshness}.`);
  if (summary.boardObserved && summary.columns) {
    lines.push(`Tasks by column: ${COLUMN_ORDER.map((column) => `${COLUMN_LABEL[column]} ${summary.columns![column]}`).join(", ")}${summary.archivedCount ? `; archived ${summary.archivedCount}` : ""}.`);
    if (summary.taskCount === 0) lines.push("The board has no tasks. That is an empty project, not a finished one.");
    for (const column of ["running", "blocked", "review"] as const) {
      const list = source ? titleList(source.tasks, column) : null;
      if (list) lines.push(list);
    }
    if ((summary.reviewCount ?? 0) > 0) lines.push("Tasks in Review wait for the owner; they are not done.");
  } else {
    lines.push("Board: not observed, so task counts are unknown.");
  }
  lines.push(`${countText(summary.activeRunCount, "Running agent runs")}; ${countText(summary.failedRunCount, "failed runs")}; ${countText(summary.orphanedRunCount, "orphaned runs")}.`);
  const batches = source && source.coverage.batches
    ? source.batches.map((batch) => batch.status)
    : null;
  if (batches == null) lines.push("Execution batches: unknown.");
  else if (batches.length > 0) {
    const counts = new Map<string, number>();
    for (const status of batches) counts.set(status, (counts.get(status) ?? 0) + 1);
    lines.push(`Execution batches: ${[...counts].map(([status, n]) => `${status} ${n}`).join(", ")}.`);
  }
  if (summary.runningPipelineCount) lines.push(`Running pipelines: ${summary.runningPipelineCount}.`);
  if (summary.priorityCounts) {
    const entries = Object.entries(summary.priorityCounts).filter(([, n]) => (n ?? 0) > 0);
    if (entries.length > 0) lines.push(`Task priorities (unknown = never set): ${entries.map(([key, n]) => `${key} ${n}`).join(", ")}.`);
  }
  lines.push(countText(summary.dependencyCount, "Structured dependencies") + ".");
  lines.push(environmentLine(summary));
  lines.push(managerLine(summary.path));
  lines.push(estimateLine(analysis, summary.projectId));
  const gaps = (analysis.completeness?.missing ?? [])
    .filter((item) => item.path === summary.projectId)
    .map((item) => item.message)
    .slice(0, 4);
  if (gaps.length > 0) lines.push(`Missing data: ${gaps.join(" ")}`);
  return lines;
}

function moneyText(money: { status: string; money: { currency: string; minor: number } | null } | undefined): string {
  if (!money) return "unknown";
  if (money.status === "known" && money.money) return formatMoney(money.money);
  return money.status;
}

function durationText(value: { status: string; ms: number | null; knownMs?: number | null } | undefined): string {
  if (!value) return "unknown";
  if ((value.status === "known" || value.status === "estimated") && value.ms != null) return formatDurationMs(value.ms);
  if (value.status === "incomplete" && value.knownMs != null) return `incomplete (known part ${formatDurationMs(value.knownMs)}, not a total)`;
  return value.status;
}

export interface GatheredPortfolioContext {
  context: PortfolioPromptContext;
  refs: ProjectRefs;
  sources: ContextSource[];
  projectCount: number;
}

function projectOrder(analysis: PortfolioAnalysis): ProjectSummary[] {
  const attention = new Set(analysis.aggregate?.attentionProjectIds ?? []);
  const name = (item: ProjectSummary) => (item.name ?? item.path).toLowerCase();
  return [...analysis.projects].sort((a, b) =>
    Number(attention.has(b.projectId)) - Number(attention.has(a.projectId))
    || name(a).localeCompare(name(b))
    || a.path.localeCompare(b.path));
}

/**
 * What the portfolio manager may know, read now from the portfolio core.
 * No project file is opened and no CLI is started. Large portfolios are cut
 * deterministically (projects needing attention first, then by name), and
 * the cut is stated in the prompt and the sources.
 */
export function gatherPortfolioContext(observations: PortfolioObservation[] = []): GatheredPortfolioContext {
  let built;
  try {
    built = buildPortfolioSnapshot();
  } catch {
    return emptyContext("The portfolio could not be read.", observations);
  }
  const analysis = analyzePortfolio(built.snapshot);
  if (!analysis.ok || !analysis.aggregate) {
    const reason = analysis.issues.find((issue) => issue.severity === "error")?.message ?? "The portfolio snapshot was rejected.";
    return emptyContext(`Portfolio analysis was not produced: ${reason}`, observations);
  }
  const aggregate = analysis.aggregate;
  const coordination = buildHeadPmCoordination();
  const refs = new Map<string, { path: string; name: string }>();
  const projectsOut: PortfolioPromptProject[] = [];
  let used = 0;
  const ordered = projectOrder(analysis);
  for (const summary of ordered) {
    if (projectsOut.length >= L.projectsInPrompt) break;
    const ref = `P${projectsOut.length + 1}`;
    const name = clean(summary.name || summary.path, 120);
    const lines = [
      ...projectLines(summary, analysis, built.snapshot),
      ...projectCoordinationExtraLines(summary.path, coordination),
    ];
    const size = name.length + summary.path.length + lines.reduce((sum, line) => sum + line.length + 3, 0);
    if (used + size > L.contextChars && projectsOut.length > 0) break;
    used += size;
    refs.set(ref, { path: summary.path, name });
    projectsOut.push({ ref, name, path: summary.path, lines });
  }
  const omitted = ordered.length - projectsOut.length;

  const overview = [
    ...companyStructureLines(coordination),
    `Registered projects: ${aggregate.projectCount}. Current snapshots: ${aggregate.currentProjectCount}; stale: ${aggregate.staleProjectCount}; not proven current: ${aggregate.unprovenProjectCount}.`,
    `Projects needing attention: ${aggregate.attentionProjectIds.length}. Active projects: ${aggregate.activeProjectIds.length}.`,
    `Board totals (Review is not Done): tasks ${countFact(aggregate.taskCount)}, review ${countFact(aggregate.reviewCount)}, blocked ${countFact(aggregate.blockedCount)}, done ${countFact(aggregate.doneCount)}, running runs ${countFact(aggregate.activeRunCount)}, paused batches ${countFact(aggregate.pausedBatchCount)}.`,
  ];

  const resources = built.snapshot.resources.map((resource) => {
    const view = analysis.resources.find((item) => item.id === resource.id);
    const quota = resource.quota.kind === "percent-used"
      ? `${resource.quota.usedPercent}% used (not remaining capacity)`
      : resource.quota.kind === "remaining"
        ? `${resource.quota.remaining} ${resource.quota.unit} remaining`
        : resource.quota.kind === "unknown"
          ? `quota unknown (${clean(resource.quota.reason, 160)})`
          : resource.quota.kind;
    const parts = [
      `${resource.harnessId} (${resource.harnessKind ?? "unknown kind"})`,
      `availability ${resource.availability.value ?? "unknown — the harness was not probed"}`,
      `running ${resource.occupiedSlots.value ?? "unknown"}`,
      `concurrency limit ${resource.concurrencyLimit.value ?? "unknown"}`,
      quota,
      resource.accountId ? `account ${resource.accountId} (user-declared, not provider-verified)` : "account not identified (may share an account with another harness)",
    ];
    if (resource.subscriptionId) parts.push(`subscription ${resource.subscriptionId} (shared identity, not additive capacity)`);
    if (view?.capacity === "unknown") parts.push("capacity unknown");
    return parts.join("; ");
  });

  const conflicts = analysis.conflicts.slice(0, 20).map((conflict) =>
    `${conflict.class} (${conflict.severity}): ${clean(conflict.explanation, 300)}`);
  const recommendations = analysis.proposals.slice(0, 10).map((proposal) =>
    clean(`${proposal.actions.map((action) => action.summary).join(" ")} Why: ${proposal.rationale.join(" ")}`, 500));
  const estimation = analysis.estimation
    ? [
      `Agent time across current projects: ${durationText(analysis.estimation.agent)}.`,
      `Portfolio calendar: ${durationText(analysis.estimation.calendar)}${analysis.estimation.calendar.note ? ` (${clean(analysis.estimation.calendar.note, 200)})` : ""}.`,
      `Additional cash: ${moneyText(analysis.estimation.additionalCash)}. API-equivalent (not real spending): ${moneyText(analysis.estimation.apiEquivalent)}. Existing subscriptions: ${moneyText(analysis.estimation.subscriptions)}.`,
      `Confidence: ${analysis.estimation.confidence}. Closest to finishing: ${clean(analysis.estimation.closestProject.note, 300)}`,
      `Time left today: ${clean(analysis.estimation.remainingWindow.note, 200)}`,
    ]
    : ["No estimate information."];
  const dataGaps = [
    ...built.warnings.map((item) => clean(item, 300)),
    ...(analysis.completeness?.warnings ?? []).map((item) => clean(item, 300)),
  ].filter((item, index, list) => list.indexOf(item) === index).slice(0, 20);
  if (omitted > 0) dataGaps.unshift(`${omitted} project(s) were left out of this message by the size limit.`);

  const byPath = new Map([...refs].map(([ref, value]) => [value.path, ref]));
  const context: PortfolioPromptContext = {
    capturedAt: built.snapshot.capturedAtMs,
    overview,
    projects: projectsOut,
    omittedProjects: omitted,
    resources,
    conflicts,
    recommendations,
    estimation,
    dataGaps,
    // Observations arrive keyed by project path; the prompt names projects by ref.
    observations: observations.map((item) => ({ ...item, ref: byPath.get(item.ref ?? "") ?? null })),
  };

  const sources: ContextSource[] = [
    {
      id: "company",
      label: "Company & clusters",
      path: null,
      status: coordination.projects.length > 0 ? "included" : "missing",
      detail: `${coordination.clusters.length} cluster(s); ${coordination.projects.length} project(s) with PM identity and intake counts.`,
    },
    {
      id: "snapshot",
      label: "Portfolio snapshot",
      path: null,
      status: "included",
      detail: `Read at ${new Date(built.snapshot.capturedAtMs).toLocaleString("en-US")} from boards, runs, batches, environments and estimates. No project files were opened.`,
    },
    {
      id: "projects",
      label: "Projects",
      path: null,
      status: aggregate.projectCount === 0 ? "missing" : omitted > 0 ? "truncated" : "included",
      detail: aggregate.projectCount === 0
        ? "No registered projects."
        : omitted > 0
          ? `${projectsOut.length} of ${aggregate.projectCount} projects included (attention first); ${omitted} left out by the size limit.`
          : `All ${aggregate.projectCount} projects included.`,
    },
    {
      id: "resources",
      label: "Harnesses and quotas",
      path: null,
      status: resources.length > 0 ? "included" : "missing",
      detail: resources.length > 0 ? `${resources.length} harness(es); accounts not identified are treated as possibly shared.` : "No harness rows.",
    },
    {
      id: "estimates",
      label: "Estimates",
      path: null,
      status: analysis.estimation ? "included" : "missing",
      detail: analysis.estimation ? `Confidence ${analysis.estimation.confidence}.` : "No estimate was produced.",
    },
    {
      id: "observations",
      label: "Project manager answers",
      path: null,
      status: observations.length > 0 ? "included" : "missing",
      detail: observations.length > 0 ? `${observations.length} answered delegation(s).` : "No delegated request has been answered yet.",
    },
    {
      id: "gaps",
      label: "Data gaps",
      path: null,
      status: dataGaps.length > 0 ? "truncated" : "included",
      detail: dataGaps.length > 0 ? `${dataGaps.length} note(s) about missing or unknown data.` : "No gaps reported.",
    },
  ];
  return { context, refs, sources, projectCount: aggregate.projectCount };
}

function countFact(fact: { status: string; value: number | null; knownValue: number | null }): string {
  if (fact.status === "known" && fact.value != null) return String(fact.value);
  if (fact.status === "incomplete") return fact.knownValue == null ? "partial" : `partial (${fact.knownValue} known)`;
  return "unknown";
}

function emptyContext(reason: string, observations: PortfolioObservation[]): GatheredPortfolioContext {
  return {
    context: {
      capturedAt: Date.now(),
      overview: [reason],
      projects: [],
      omittedProjects: 0,
      resources: [],
      conflicts: [],
      recommendations: [],
      estimation: [],
      dataGaps: [reason],
      observations: observations.map((item) => ({ ...item, ref: null })),
    },
    refs: new Map(),
    sources: [{ id: "snapshot", label: "Portfolio snapshot", path: null, status: "missing", detail: reason }],
    projectCount: 0,
  };
}

function observationsFor(delegations: DelegationProposal[]): PortfolioObservation[] {
  return delegations
    .filter((item) => item.result && (item.status === "answered" || item.status === "failed"))
    .sort((a, b) => (b.result!.observedAt - a.result!.observedAt))
    .slice(0, L.observationsInPrompt)
    .map((item) => ({
      ref: item.projectPath, // mapped to a P-ref by gatherPortfolioContext
      projectName: item.projectName,
      objective: item.objective,
      status: item.result!.status,
      summary: observationSummary(item.result!),
      observedAt: item.result!.observedAt,
    }));
}

export function getPortfolioContextSources(): PortfolioResult<{ sources: ContextSource[]; projectCount: number; listedProjects: number }> {
  const gathered = gatherPortfolioContext(observationsFor(loadDelegations()));
  const decisions = loadDecisions();
  return {
    ok: true,
    value: {
      sources: [
        ...gathered.sources,
        {
          id: "decisions",
          label: "Confirmed decisions",
          path: null,
          status: decisions.length > 0 ? "included" : "missing",
          detail: decisions.length > 0 ? `${decisions.length} confirmed.` : "None confirmed yet.",
        },
      ],
      projectCount: gathered.projectCount,
      listedProjects: gathered.context.projects.length,
    },
  };
}

/** FO-HEAD01: read-only cross-project coordination for Head of PM UI. */
export function getHeadPmCoordination(): PortfolioResult<HeadPmCoordinationSnapshot> {
  return { ok: true, value: buildHeadPmCoordination() };
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
    if (!profile) return "The agent profile picked for the portfolio manager no longer exists. Pick another one.";
    return { harnessId: profile.harness, model: profile.model, effort: profile.effort, fast: profile.fast, maxMode: profile.maxMode };
  }
  if (!config.harness) return "Choose an agent for the portfolio manager first.";
  return { harnessId: config.harness, model: config.model, effort: config.effort, fast: config.fast, maxMode: config.maxMode };
}

type PreflightDeps = Parameters<typeof interviewPreflight>[3];

export async function portfolioManagerPreflight(
  deps: PreflightDeps = {},
): Promise<PortfolioResult<{ harness: { id: string; label: string; kind: string }; model: string; isolation: InterviewIsolation }>> {
  const choice = agentChoice(loadConfig());
  if (typeof choice === "string") return fail(400, choice);
  const result = await interviewPreflight(choice.harnessId, choice.model, choice.effort, deps);
  if (!result.ok) return fail(result.status, result.error);
  return {
    ok: true,
    value: { harness: { id: result.harness.id, label: result.harness.label, kind: result.harness.kind }, model: result.model, isolation: result.isolation },
  };
}

export interface PortfolioSendResult {
  turn: PortfolioTurnView;
  message: PortfolioManagerMessage;
}

/**
 * Start one turn for an owner message (new, or a retry of the last one that
 * failed). The reply is written to the history when the turn settles.
 */
export interface PortfolioSendOwnerOptions {
  /** In-process test seam only (never populated from HTTP request bodies). */
  ownerProof?: unknown;
  locale?: "en" | "ru";
}

export async function sendPortfolioMessage(
  body: { objectiveProjectPaths?: unknown; scope?: unknown; text?: unknown; retryMessageId?: unknown; knowledgeGrantId?: unknown; brainGrantId?: unknown; browserGrantId?: unknown; nativeGrantId?: unknown; allowMemoryProposals?: unknown; allowCompanyMemoryProposals?: unknown; memoryProposalProjectPaths?: unknown },
  deps: PreflightDeps = {},
  ownerOptions?: PortfolioSendOwnerOptions,
): Promise<PortfolioResult<PortfolioSendResult>> {
  let knowledgeGrantId: string | null = null;
  if (body.knowledgeGrantId != null) {
    if (!isGrantId(body.knowledgeGrantId)) return fail(400, "Invalid knowledge permission.");
    knowledgeGrantId = body.knowledgeGrantId;
  }
  let brainGrantId: string | null = null;
  if (body.brainGrantId != null) {
    if (!isBrainGrantId(body.brainGrantId)) return fail(400, "Invalid Brain permission.");
    brainGrantId = body.brainGrantId;
  }
  let browserGrantId: string | null = null;
  if (body.browserGrantId != null) {
    if (!isBrowserGrantId(body.browserGrantId)) return fail(400, "Invalid browser permission.");
    browserGrantId = body.browserGrantId;
  }
  let nativeGrantId: string | null = null;
  if (body.nativeGrantId != null) {
    if (!isNativeGrantId(body.nativeGrantId)) return fail(400, "Invalid native permission.");
    nativeGrantId = body.nativeGrantId;
  }
  const requestedScope = parseHeadScope(body.scope);
  if (body.scope !== undefined && !requestedScope) return fail(400, "Select a valid Head of PM scope.");
  const retryId = typeof body.retryMessageId === "string" ? body.retryMessageId : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!retryId && !text) return fail(400, "Write a message first.");
  if (text.length > L.messageChars) return fail(400, `Messages are limited to ${L.messageChars} characters.`);
  let objective: ObjectiveRequest | undefined;
  if (body.objectiveProjectPaths !== undefined) {
    if (retryId || requestedScope || knowledgeGrantId || brainGrantId || browserGrantId || nativeGrantId ||
      body.allowMemoryProposals || body.allowCompanyMemoryProposals || body.memoryProposalProjectPaths) {
      return fail(400, "Mission planning accepts only the objective and its two selected projects.");
    }
    try {
      objective = parseObjectiveRequest(text, body.objectiveProjectPaths);
    } catch (error) {
      return fail(400, (error as Error).message);
    }
  }
  const memoryPermission = parseMemoryProposalPermission(
    body,
    { kind: "portfolio" },
    (path) => projects.get(path) != null,
  );
  if (!memoryPermission.ok) return fail(400, memoryPermission.error);
  if (runningTurnId) return fail(409, "The portfolio manager is still answering. Wait for it or cancel first.");
  const turnId = crypto.randomUUID();
  // Claimed before the first await so a double click can't start two turns.
  runningTurnId = turnId;
  const release = () => {
    if (runningTurnId === turnId) runningTurnId = null;
  };

  try {
    const config = loadConfig();
    const history = loadMessages();
    let message: PortfolioManagerMessage;
    if (retryId) {
      const found = loadMessage(retryId);
      const lastOwner = [...history].reverse().find((item) => item.role === "owner");
      if (!found || found.role !== "owner") {
        release();
        return fail(404, "That message was not found.");
      }
      if (lastOwner?.id !== found.id || (found.status !== "failed" && found.status !== "cancelled")) {
        release();
        return fail(409, "Only the last message that failed can be retried.");
      }
      if (requestedScope) {
        release();
        return fail(400, "A retry keeps its original scope.");
      }
      message = {
        ...found,
        browserGrantId: undefined,
        browserAction: undefined,
        nativeGrantId: undefined,
        nativeAction: undefined,
        ...(found.headScope ? { memoryProposalPermission: memoryPermission.value ?? undefined } : {}),
      };
    } else {
      message = newMessage("owner", text, {
        status: "pending",
        ...(memoryPermission.value ? { memoryProposalPermission: memoryPermission.value } : {}),
      });
    }

    let scoped: ScopedHeadContext | undefined;
    const scope = message.headScope?.scope ?? requestedScope;
    if (scope) {
      const resolved = resolveHeadScope(scope, retryId ? "canonical" : "selection");
      if (!resolved.ok) {
        release();
        return resolved;
      }
      if (message.headScope && !sameHeadScope(message.headScope, resolved.value)) {
        release();
        return fail(409, "The scope of that request changed. Select it again and send a new message.");
      }
      message = { ...message, headScope: resolved.value };
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
      return fail(428, "Confirm what this agent can and can't do before the portfolio manager uses it.", { isolation: preflight.isolation });
    }

    if (message.headScope) {
      // Membership can change while provider preflight is in flight.
      const current = resolveHeadScope(message.headScope.scope);
      if (!current.ok || !sameHeadScope(message.headScope, current.value)) {
        release();
        return fail(409, "The selected scope changed. Review it and send a new message.");
      }
      scoped = gatherScopedHeadContext(current.value);
      if (memoryPermission.value?.projectPaths.some((path) => !scoped!.includesProject(path))) {
        release();
        return fail(400, "Memory proposals must stay within the selected scope.");
      }
    }

    // Last gate before the prompt (see the project manager): the owner's
    // one-message permission is spent here, after every other refusal.
    let knowledge: ContextResult<{ documents: KnowledgePromptDocument[]; totalBytes: number; ref: string }> | null = null;
    if (knowledgeGrantId) {
      knowledge = (await loadKnowledgeContext()).consume({ kind: "portfolio" }, knowledgeGrantId, message.id);
      if (!knowledge.ok) {
        release();
        return fail(knowledge.status, knowledge.error, { ...(knowledge.issues ? { knowledgeIssues: knowledge.issues } : {}), knowledgeRejected: true });
      }
    }

    if (scoped && knowledge?.ok && knowledge.value.documents.some((doc) =>
      (doc.level === "project" && !scoped!.includesProject(doc.owner.id))
      || (doc.level === "cluster" && doc.owner.id !== scoped!.scope.clusterId))) {
      release();
      return fail(409, "The attached notes are outside the selected scope. Nothing was sent.", { knowledgeRejected: true });
    }

    const factualReply = objective ? null : (await tryAnswerOrchestrationQuestion(message.text, scoped))
      ?? (scoped ? null : tryAnswerInitiativeStatusQuestion(message.text))
      ?? tryAnswerInfraQuestion(message.text);
    if (factualReply) {
      const attribution = headBindingCore().capture(turnId, projects.list().map((p) => p.path));
      message = { ...message, status: "answered", error: null, attribution };
      const replyMessage = newMessage("manager", factualReply, { attribution });
      db.transaction(() => {
        if (retryId) saveMessage(message);
        else { message = { ...message, attribution }; appendMessage(message); }
        appendMessage(replyMessage);
      }).immediate();
      portfolioManagerStore.touch();
      release();
      const settled: PortfolioTurnView = {
        attribution,
        id: turnId,
        messageId: message.id,
        status: "succeeded",
        error: null,
        startedAt: Date.now(),
        settledAt: Date.now(),
      };
      return { ok: true, value: { turn: settled, message } };
    }

    // After the no-model status answer. A refused memory set does not start a turn.
    let brain: BrainResult<BrainConsumedContext> | null = null;
    if (brainGrantId) {
      brain = (await loadBrainContext()).consume({ kind: "portfolio" }, brainGrantId, message.id, turnId);
      if (!brain.ok) {
        release();
        return fail(brain.status, brain.error, { ...(brain.issues ? { brainIssues: brain.issues } : {}), brainRejected: true });
      }
    }

    if (scoped && brain?.ok && brain.value.memories.some((item) => item.scope.kind === "project" && !scoped!.includesProject(item.scope.id))) {
      release();
      return fail(409, "The attached memories are outside the selected scope. Nothing was sent.", { brainRejected: true });
    }

    const delegations = scoped || objective ? [] : loadDelegations().map(reconcileDelegation);
    const gathered: { context: PortfolioPromptContext; refs: ProjectRefs; sources: ContextSource[] } = objective ? {
      refs: new Map(objective.projects.map((project, index) => [`P${index + 1}`, project])),
      context: {
        capturedAt: Date.now(), overview: [], projects: [], omittedProjects: 0, resources: [], conflicts: [],
        recommendations: [], dataGaps: [], estimation: [], observations: [],
      },
      sources: [],
    } : scoped ?? gatherPortfolioContext(observationsFor(delegations));
    const waiting = delegations.filter((item) => item.status === "sent" || item.status === "sending");
    if (waiting.length > 0) {
      gathered.context.dataGaps.push(`${waiting.length} delegated request(s) are still waiting for a project manager's answer.`);
    }
    const decisions = scoped || objective ? [] : loadDecisions().slice(-L.decisions);
    const harnessRows = harnesses.list();
    const attribution = headBindingCore().capture(turnId, [...gathered.refs.values()].map(p => p.path));
    const headSummaries = [];
    for (const proj of scoped || objective ? [] : gathered.refs.values()) {
      const bundle = await loadEffectiveKnowledgeForProject(proj.path);
      if (bundle) {
        headSummaries.push({ projectPath: proj.path, projectName: proj.name, preview: bundle.preview });
      }
    }
    const headKnowledge = renderHeadPmKnowledgeSection(buildHeadPmKnowledgeSummaries(headSummaries));
    let browserObservation: import("../shared/browser/agent.ts").BrowserAgentObservation | null = null;
    let browserOrigins: string[] = [];
    if (browserGrantId) {
      const grants = await loadBrowserAgentGrants();
      const known = grants.get({ managerKind: "head-of-pm", projectPath: null }, browserGrantId);
      const live = known.ok ? await (await defaultBrowserSessionManager()).snapshot(known.value.sessionId) : null;
      const consumed = grants.consume({ managerKind: "head-of-pm", projectPath: null }, browserGrantId, message.id, turnId, live);
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
      const known = grants.get({ managerKind: "head-of-pm", projectPath: null }, nativeGrantId);
      const live = known.ok ? await (await defaultNativeComputerSessionManager()).inspect(known.value.sessionId).catch(() => null) : null;
      const consumed = grants.consume({ managerKind: "head-of-pm", projectPath: null }, nativeGrantId, message.id, turnId, live);
      if (!consumed.ok) {
        release();
        return fail(consumed.status, consumed.error, { nativeRejected: true });
      }
      nativeObservation = consumed.value;
      message = { ...message, nativeGrantId };
    }
    if (scoped) {
      const current = resolveHeadScope(scoped.scope.scope);
      const stillIncluded = (path: string) => scoped.scope.scope.kind !== "cluster"
        || db.query("SELECT 1 FROM cluster_project_memberships WHERE project_path=? AND cluster_id=?").get(path, scoped.scope.clusterId);
      const paths = [...gathered.refs.values()].map((project) => project.path);
      if (brain?.ok) for (const item of brain.value.memories) if (item.scope.kind === "project") paths.push(item.scope.id);
      if (knowledge?.ok) for (const doc of knowledge.value.documents) if (doc.level === "project") paths.push(doc.owner.id);
      if (!current.ok || !sameHeadScope(scoped.scope, current.value) || paths.some((path) => !stillIncluded(path))) {
        release();
        return fail(409, "The selected scope changed before the turn started. Review it and send a new message.");
      }
    }
    if (!objective) {
      try {
        gathered.context.estimation.push(...headUsageEvidence(message.text, scoped?.scope, scoped?.includesProject ?? (() => true)));
      } catch {
        gathered.context.dataGaps.push("Usage Analytics evidence was unavailable for this turn.");
      }
      try {
        const { headRouterEvidence } = await import("./router-v2/router-v2-head.ts");
        gathered.context.estimation.push(...headRouterEvidence(message.text, scoped?.scope));
      } catch {
        gathered.context.dataGaps.push("Smart Router evidence was unavailable for this turn.");
      }
    }
    const prompt = objective ? objectivePrompt(objective) : buildPortfolioPrompt({
      attribution,
      headScope: scoped?.scope,
      context: gathered.context,
      config,
      harnesses: harnessRows.map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })),
      decisions,
      history: selectHistory(history.filter((item) => item.id !== message.id && (scoped
        ? item.headScope && sameHeadScope(item.headScope, scoped.scope)
          && (scoped.scope.scope.kind !== "cluster" || item.role === "owner") && !item.sources.some((source) =>
          ["knowledge", "brain", "browser", "native"].includes(source.id))
        : !item.headScope))),
      message: message.text,
      knowledge: knowledge?.ok ? knowledge.value.documents : undefined,
      brain: brain?.ok ? brain.value.memories : undefined,
      memoryProposals: message.memoryProposalPermission ?? null,
      headKnowledge,
      browser: browserObservation,
      browserOrigins,
      native: nativeObservation,
    });
    const sources: ContextSource[] = [
      ...gathered.sources,
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
            detail: `${brain.value.memories.length} memor${brain.value.memories.length === 1 ? "y" : "ies"}, ${brain.value.totalChars.toLocaleString("en-US")} characters, digest ${brain.value.digest.slice(0, 12)}, for this message only: ${brain.value.memories.map((item) => `${item.title} (${item.scope.kind} ${item.scope.id} r${item.revision})`).join("; ")}.`,
          }]
        : []),
      ...(browserObservation
        ? [{
            id: "browser",
            label: "Owner-approved webpage observation",
            path: null,
            status: "included" as const,
            detail: "One untrusted page for this message only. One browser action.",
          }]
        : []),
      ...(nativeObservation
        ? [{
            id: "native",
            label: "Owner-approved native window observation",
            path: null,
            status: "included" as const,
            detail: `${nativeObservation.application.bundleId} (${nativeObservation.window.title || "untitled"}), ${nativeObservation.elementCount} elements, for this message only. One native action.`,
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

    let ownerLaunch: { grantId: string; taskStateDigest: string } | undefined;
    if (isProductionOwnerGateActive() || ownerOptions?.ownerProof !== undefined) {
      const scopeProjects = [...gathered.refs.values()].map((project) => project.path);
      const built = buildHeadTurnOperation({
        turnId,
        messageId: message.id,
        taskId: isolatedSessionKey(turnId),
        runId: isolatedRunId(turnId),
        workspace: isolatedTurnScratchDir(turnId),
        harnessId: preflight.harness.id,
        modelId: preflight.model,
        mode: preflight.mode,
        effort: preflight.effort,
        lockdownArgs: preflight.isolation.args,
        scope: {
          kind: scoped?.scope.scope.kind ?? "workspace",
          projectPath: scoped?.scope.projectPath ?? null,
          clusterId: scoped?.scope.clusterId ?? null,
          taskId: scoped?.scope.scope.kind === "task" ? scoped.scope.scope.id : null,
          projectPaths: scopeProjects,
        },
        messageText: message.text,
        prompt,
        grants: {
          knowledge: Boolean(knowledge?.ok),
          brain: Boolean(brain?.ok),
          browser: Boolean(browserObservation),
          native: Boolean(nativeObservation),
        },
      });
      if (!built.ok) {
        release();
        return fail(409, built.reason, { code: built.code });
      }
      const auth = await authorizeSupervisedLaunch({
        built: built.built,
        proofOverride: ownerOptions?.ownerProof,
        locale: ownerOptions?.locale ?? "en",
      });
      if (!auth.ok) {
        release();
        const status = auth.code === "owner-not-enrolled"
          || auth.code === "owner-revoked"
          || auth.code === "owner-restored-inactive"
          || auth.code === "owner-account-unbound"
          || auth.code === "owner-provider-blocked"
          || auth.code === "owner-router-ineligible"
          || auth.code === "owner-project-paused"
          || auth.code === "owner-emergency-stop"
          ? 409
          : 403;
        return fail(status, auth.reason, { code: auth.code });
      }
      ownerLaunch = {
        grantId: auth.grantId,
        taskStateDigest: built.built.operation.taskStateDigest,
      };
    }

    try {
      message = { ...message, status: "pending", error: null };
      db.transaction(() => {
        // Retry attempts get their own durable snapshot; original chat attribution stays.
        if (!objective) {
          if (retryId) saveMessage(message);
          else { message = { ...message, attribution }; appendMessage(message); }
        }
        db.run(`INSERT INTO portfolio_manager_turn_attributions (turn_id, message_id, data, requested_runtime, created_at) VALUES (?, ?, ?, ?, ?)`,
          [turnId, message.id, JSON.stringify(attribution), JSON.stringify({
            harnessId: preflight.harness.id, model: preflight.model, effort: preflight.effort,
            mode: preflight.mode, fast: choice.fast, maxMode: choice.maxMode,
            requestedAccountId: new AccountCore(db).resolveIdentity(preflight.harness.id, config.profileId).accountId,
            actualModel: null, actualAccountId: null,
          }), attribution.capturedAt]);
      }).immediate();
      portfolioManagerStore.touch();

      if (brain?.ok && brainGrantId) (await loadBrainContext()).markUsed(brainGrantId);
      pruneSettled();
      const job: PortfolioJob = {
        objective,
        scoped,
        attribution,
        id: turnId,
        messageId: message.id,
        status: "running",
        error: null,
        startedAt: Date.now(),
        settledAt: null,
        control: { cancelRequested: false, handle: null },
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
        ...(ownerLaunch ? { ownerLaunch } : {}),
      }, gathered.refs, new Set(harnessRows.map((item) => item.id)), sources);
      return { ok: true, value: { turn: viewOf(job), message } };
    } catch (innerError) {
      discardUnconsumedLaunchTicket(ownerLaunch?.grantId);
      throw innerError;
    }
  } catch (error) {
    release();
    return fail(500, `Couldn't start the portfolio manager: ${(error as Error).message}`);
  }
}

function settleJob(job: PortfolioJob, status: PortfolioTurnStatus, error: string | null): void {
  job.status = status;
  job.error = error;
  job.settledAt = Date.now();
  if (runningTurnId === job.id) runningTurnId = null;
}

function markOwner(job: PortfolioJob, status: "answered" | "failed" | "cancelled", error: string | null, providerRefusal?: ProviderRefusalSummary): void {
  const message = loadMessage(job.messageId);
  if (message) saveMessage({ ...message, status, error, ...(providerRefusal ? { providerRefusal } : {}) });
}

/** The account this Head harness is bound to, or null when it is not identified. Never throws. */
function headAccountId(harness: Harness): string | null {
  try {
    if (isCodexProfile(harness)) return selectedCodexAccount(harness)?.id ?? null;
    if (isClaudeProfile(harness)) return selectedClaudeAccount(harness)?.id ?? null;
    return null;
  } catch {
    return null;
  }
}

function delegationFromDraft(draft: DelegationDraft, messageId: string, now: number): DelegationProposal {
  return {
    id: crypto.randomUUID(),
    messageId,
    projectPath: draft.projectPath,
    projectName: draft.projectName,
    objective: draft.objective,
    request: draft.request,
    reason: draft.reason,
    contextSummary: draft.contextSummary,
    expectedOutput: draft.expectedOutput,
    status: "proposed",
    revision: 1,
    error: null,
    pmMessageId: null,
    pmTurnId: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    settledAt: null,
  };
}

async function runJob(
  job: PortfolioJob,
  harness: Harness,
  opts: {
    mode: string;
    model: string;
    effort: string | null;
    fast: boolean;
    maxMode: boolean;
    prompt: string;
    lockdownArgs: string[];
    ownerLaunch?: { grantId: string; taskStateDigest: string };
  },
  refs: ProjectRefs,
  harnessIds: ReadonlySet<string>,
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
      // A provider refusal is recorded as an observation and shown as such. Recording it changes
      // nothing else: no retry, no other account or model, no plan or task.
      let refusal: ProviderRefusalSummary | undefined;
      if (outcome.providerRefusal) {
        try {
          refusal = recordProviderRefusal({
            kind: outcome.providerRefusal.kind, provider: harness.kind,
            scope: { harnessId: harness.id, accountId: headAccountId(harness), modelId: opts.model },
            surface: "head-turn", evidenceId: job.messageId, proof: outcome.providerRefusal.proof,
            retryHint: outcome.providerRefusal.retryHint, diagnostics: outcome.providerRefusal.diagnostics,
          });
        } catch { /* the failure itself is still reported below */ }
      }
      markOwner(job, "failed", outcome.error, refusal);
      settleJob(job, "failed", outcome.error);
      return;
    }
    // A provider answer is the only recovery signal for an earlier refusal on this exact scope.
    try { supersedeProviderRefusals({ harnessId: harness.id, accountId: headAccountId(harness), modelId: opts.model }, job.messageId); } catch { /* observation only */ }
    if (job.objective) {
      job.missionId = saveObjectiveDraft(job.objective, outcome.text).id;
      settleJob(job, "succeeded", null);
      return;
    }
    const scoped = job.scoped;
    const boardDraft = scoped ? readHeadBoardDraft(outcome.text, scoped, sources.some((source) =>
      ["knowledge", "brain", "browser", "native"].includes(source.id))) : null;
    // Scoped turns never feed the old portfolio → per-project PM path.
    const scopedReply = scoped ? lastTagBody(outcome.text, "reply", true) : null;
    const parsed = parsePortfolioReply(scoped ? (scopedReply ? `<reply>${scopedReply}</reply>` : "") : outcome.text, refs, harnessIds);
    if (!parsed.ok) {
      markOwner(job, "failed", parsed.error);
      settleJob(job, "failed", parsed.error);
      return;
    }
    const reply = parsed.parsed;
    reply.reply = stripBrowserActionMarkup(reply.reply);
    reply.reply = stripNativeActionMarkup(reply.reply);
    const confirmed = new Set(loadDecisions().map((item) => item.text.toLowerCase()));
    const replyMessage = newMessage("manager", reply.reply, {
      attribution: job.attribution,
      headScope: scoped?.scope,
      protocolErrors: [reply.planError, reply.delegationError, reply.initiativeProposalError].filter((item): item is string => item != null),
      suggestedDecisions: reply.suggestedDecisions.filter((item) => !confirmed.has(item.toLowerCase())),
      sources,
    });
    const now = Date.now();
    if (!scoped && reply.plan) {
      const plan: PortfolioPlan = { id: crypto.randomUUID(), messageId: replyMessage.id, ...reply.plan, status: "proposed", createdAt: now, updatedAt: now };
      savePlan(plan);
      replyMessage.planId = plan.id;
    }
    if (!scoped && reply.initiativeProposal) {
      const saved = saveHeadPmInitiativeProposal(replyMessage.id, reply.initiativeProposal);
      replyMessage.initiativeProposalId = saved.id;
    }
    for (const draft of scoped ? [] : reply.delegations) {
      const delegation = { ...delegationFromDraft(draft, replyMessage.id, now), attribution: job.attribution };
      transition(delegation);
      replyMessage.delegationIds.push(delegation.id);
    }
    const ownerMessage = loadMessage(job.messageId);
    const memoryPermission = ownerMessage?.memoryProposalPermission ?? null;
    const memoryParsed = parseMemoryProposals(outcome.text, memoryPermission, (path) => projects.get(path) != null);
    if (memoryParsed.drafts.length > 0 || memoryParsed.errors.length > 0) {
      const notes = [...memoryParsed.errors];
      if (memoryParsed.drafts.length > 0 && memoryPermission) {
        try {
          const ids = recordMemoryProposals({
            managerKind: "head-of-pm",
            sourceProjectPath: null,
            conversationKey: "portfolio",
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
        replyMessage.protocolErrors = [...replyMessage.protocolErrors, `Memory proposals: ${notes.join(" ")}`];
      }
    }
    try {
      const settled = await settleBrowserAgentAction(await loadBrowserAgentGrants(), await defaultBrowserSessionManager(), {
        target: { managerKind: "head-of-pm", projectPath: null },
        grantId: ownerMessage?.browserGrantId ?? null,
        messageId: job.messageId,
        turnId: job.id,
        replyText: outcome.text,
      });
      if (settled.record) replyMessage.browserAction = settled.record;
      if (settled.note) replyMessage.protocolErrors = [...replyMessage.protocolErrors, settled.note];
    } catch (err) {
      replyMessage.protocolErrors = [...replyMessage.protocolErrors, `Browser action was not run: ${(err as Error).message}`];
    }
    try {
      const settledNative = await settleNativeAgentAction(await loadNativeAgentGrants(), await defaultNativeComputerSessionManager(), {
        target: { managerKind: "head-of-pm", projectPath: null },
        grantId: ownerMessage?.nativeGrantId ?? null,
        messageId: job.messageId,
        turnId: job.id,
        replyText: outcome.text,
      });
      if (settledNative.record) replyMessage.nativeAction = settledNative.record;
      if (settledNative.note) replyMessage.protocolErrors = [...replyMessage.protocolErrors, settledNative.note];
    } catch (err) {
      replyMessage.protocolErrors = [...replyMessage.protocolErrors, `Native action was not run: ${(err as Error).message}`];
    }
    if (boardDraft && !boardDraft.ok) replyMessage.protocolErrors.push(boardDraft.error);
    db.transaction(() => {
      appendMessage(replyMessage);
      if (scoped && boardDraft?.ok && boardDraft.value) saveHeadBoardDraft(replyMessage.id, scoped.scope, boardDraft.value);
      markOwner(job, "answered", null);
    }).immediate();
    portfolioManagerStore.touch();
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
 * Plans: read-only proposals. Accepting one records a decision and changes
 * no project.
 * ────────────────────────────────────────────────────────────────────────── */

export function setPlanStatus(id: string, status: "accepted" | "dismissed"): PortfolioResult<PortfolioPlan> {
  const plan = sanitizePortfolioPlan(parseJson(portfolioManagerStore.getPlan(id)));
  if (!plan) return fail(404, "Plan not found.");
  if (plan.status === status) return { ok: true, value: plan };
  if (plan.status !== "proposed") return fail(409, `This plan was already ${plan.status}.`, { plan });
  const next = { ...plan, status, updatedAt: Date.now() };
  savePlan(next);
  if (status === "accepted") {
    addDecisionOnce(`Accepted the portfolio plan “${plan.title}”. Nothing was started; each project still needs its own approvals.`, "approval");
  }
  appendMessage(newMessage("system", status === "accepted"
    ? `Plan “${plan.title}” accepted as a decision. No project was changed.`
    : `Plan “${plan.title}” dismissed.`));
  portfolioManagerStore.touch();
  return { ok: true, value: next };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Delegations.
 * ────────────────────────────────────────────────────────────────────────── */

function parseRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function sendFailureText(projectName: string, status: number, error: string): string {
  if (status === 428) return `The manager of ${projectName} needs its agent confirmed first. Open ${projectName} → Manager, confirm the agent, then approve again.`;
  if (status === 409) return `The manager of ${projectName} is busy answering another message. Approve again when it finishes. (${error})`;
  return `The manager of ${projectName} couldn't take the request: ${error}`;
}

type SendFn = typeof sendManagerMessage;

export interface ApproveDelegationResult {
  delegation: DelegationView;
  alreadySent: boolean;
}

/**
 * Send one reviewed delegation to its project's manager. Idempotent: an
 * in-memory claim (taken before the first await) and a compare-and-set on
 * the stored status keep a double click or two windows from sending twice;
 * a delegation already sent answers with its stored state. The target is
 * the project stored on the proposal — never one from the request body.
 */
export async function approveDelegation(
  id: string,
  body: { revision?: unknown },
  deps: PreflightDeps = {},
  send: SendFn = sendManagerMessage,
): Promise<PortfolioResult<ApproveDelegationResult>> {
  const stored = loadDelegation(id);
  if (!stored) return fail(404, "Delegation not found.");
  if (approving.has(id)) return fail(409, "This request is being sent right now.", { delegation: withTarget(stored) });
  const item = reconcileDelegation(stored);
  if (item.status === "sent" || item.status === "answered") {
    return { ok: true, value: { delegation: withTarget(item), alreadySent: true } };
  }
  if (item.status === "rejected") return fail(409, "This request was rejected.", { delegation: withTarget(item) });
  if (item.status === "sending") return fail(409, "This request is being sent right now.", { delegation: withTarget(item) });
  if (parseRevision(body.revision) !== item.revision) {
    return fail(409, "The request changed since you reviewed it. Review it again before approving.", { delegation: withTarget(item) });
  }
  const project = resolveProject(item.projectPath);
  if (!project.ok || project.path !== item.projectPath) {
    return fail(409, `${item.projectName} is no longer a registered project, so nothing was sent.`, { delegation: withTarget(item) });
  }
  const target = delegationTarget(item.projectPath);
  if (target.problem) {
    return fail(409, `Nothing was sent. ${target.problem}`, { delegation: { ...item, target } });
  }

  approving.add(id);
  try {
    const now = Date.now();
    const sending: DelegationProposal = { ...item, status: "sending", error: null, approvedAt: now, updatedAt: now, revision: item.revision + 1 };
    if (!portfolioManagerStore.claimDelegation(id, ["proposed", "failed"], "sending", JSON.stringify(sending))) {
      const fresh = loadDelegation(id) ?? item;
      return fail(409, "This request was already handled.", { delegation: withTarget(fresh) });
    }
    // Retry the project manager's own failed copy rather than adding a
    // second one, when it is still its last message.
    let retryMessageId: string | undefined;
    if (item.pmMessageId) {
      const pmMessages = loadPmMessages(item.projectPath);
      const lastOwner = [...pmMessages].reverse().find((message) => message.role === "owner");
      if (lastOwner?.id === item.pmMessageId && (lastOwner.status === "failed" || lastOwner.status === "cancelled")) {
        retryMessageId = lastOwner.id;
      }
    }
    const result = await send(item.projectPath, retryMessageId ? { retryMessageId } : { text: item.request }, deps, { delegationId: id, portfolioAttribution: item.attribution });
    if (!result.ok) {
      const error = sendFailureText(item.projectName, result.status, result.error);
      const failed: DelegationProposal = { ...sending, status: "failed", error, updatedAt: Date.now() };
      transition(failed);
      systemNote(failed, `Nothing was sent to the project manager of ${item.projectName}: ${capText(error, 300)}`);
      return fail(result.status === 428 ? 409 : result.status >= 500 ? 502 : 409, error, { delegation: withTarget(failed) });
    }
    const sent: DelegationProposal = {
      ...sending,
      status: "sent",
      pmMessageId: result.value.message.id,
      pmTurnId: result.value.turn.id,
      result: null,
      settledAt: null,
      updatedAt: Date.now(),
    };
    transition(sent);
    addDecisionOnce(`Approved sending “${item.objective}” to the project manager of ${item.projectName}.`, "approval");
    systemNote(sent, `Sent to the project manager of ${item.projectName}. Its answer will appear in that project's manager chat and here.`);
    portfolioManagerStore.touch();
    return { ok: true, value: { delegation: withTarget(sent), alreadySent: false } };
  } catch (error) {
    const failed: DelegationProposal = { ...item, status: "failed", error: `The request could not be sent: ${(error as Error).message}`, updatedAt: Date.now() };
    transition(failed);
    return fail(500, failed.error!, { delegation: withTarget(failed) });
  } finally {
    approving.delete(id);
  }
}

export function rejectDelegation(id: string): PortfolioResult<DelegationView> {
  const item = loadDelegation(id);
  if (!item) return fail(404, "Delegation not found.");
  if (approving.has(id) || item.status === "sending") return fail(409, "This request is being sent right now.", { delegation: withTarget(item) });
  if (item.status === "rejected") return { ok: true, value: withTarget(item) };
  if (item.status !== "proposed" && item.status !== "failed") {
    return fail(409, "This request was already sent.", { delegation: withTarget(item) });
  }
  const next: DelegationProposal = { ...item, status: "rejected", revision: item.revision + 1, updatedAt: Date.now() };
  if (!portfolioManagerStore.claimDelegation(id, ["proposed", "failed"], "rejected", JSON.stringify(next))) {
    return fail(409, "This request was already handled.", { delegation: withTarget(loadDelegation(id) ?? item) });
  }
  announce(next);
  systemNote(next, `Request to the project manager of ${item.projectName} rejected. Nothing was sent.`);
  portfolioManagerStore.touch();
  return { ok: true, value: withTarget(next) };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Decisions.
 * ────────────────────────────────────────────────────────────────────────── */

export function addPortfolioDecision(body: { text?: unknown; source?: unknown }): PortfolioResult<PortfolioDecision> {
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return fail(400, "Write the decision first.");
  if (text.length > L.decisionChars) return fail(400, `Decisions are limited to ${L.decisionChars} characters.`);
  const existing = loadDecisions();
  const same = existing.find((item) => item.text.toLowerCase() === text.toLowerCase());
  if (same) return { ok: true, value: same };
  if (existing.length >= L.decisions * 4) return fail(409, "Too many decisions saved. Remove some first.");
  const source = body.source === "manager" ? "manager" : "owner";
  const id = crypto.randomUUID();
  portfolioManagerStore.addDecision(id, text, source);
  portfolioManagerStore.touch();
  return { ok: true, value: { id, text, source, createdAt: Date.now() } };
}

export function deletePortfolioDecision(id: string): PortfolioResult<{ deleted: boolean }> {
  return { ok: true, value: { deleted: portfolioManagerStore.deleteDecision(id) } };
}

/**
 * Follow a delegated request the moment its project manager settles: bring
 * the delegation up to date and announce it. Reads stored rows only; never
 * starts a model call.
 */
onManagerTurnSettled(({ projectPath, messageId }) => {
  for (const item of loadDelegations()) {
    if (item.projectPath === projectPath && item.pmMessageId === messageId && item.status === "sent") reconcileDelegation(item);
  }
});

/**
 * Boot recovery: settle delegations a previous process left in flight
 * (claimed but unsent → failed or adopted; sent but the project manager's
 * turn died with the app → failed and retryable). Each change is announced.
 */
export function recoverPortfolioDelegations(): number {
  let changed = 0;
  for (const item of loadDelegations()) {
    if (item.status !== "sending" && item.status !== "sent") continue;
    const next = reconcileDelegation(item);
    if (next.status !== item.status) changed += 1;
  }
  return changed;
}

/** FO-HEAD02: structured delegation proposal for an initiative (Owner approval still required). */
export function insertHeadPreparedDelegation(input: {
  initiativeId: string;
  projectPath: string;
  projectName: string;
  objective: string;
  request: string;
  reason?: string;
  contextSummary?: string;
  expectedOutput?: string;
}): DelegationProposal {
  const now = Date.now();
  const message = newMessage(
    "system",
    `Prepared delegation for “${input.projectName}” (initiative ${input.initiativeId.slice(0, 8)}).`,
    { delegationIds: [] },
  );
  appendMessage(message);
  const delegation: DelegationProposal = {
    id: crypto.randomUUID(),
    messageId: message.id,
    initiativeId: input.initiativeId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    objective: capText(input.objective, L.objectiveChars),
    request: capText(input.request, L.requestChars),
    reason: capText(input.reason ?? "", L.reasonChars),
    contextSummary: capText(input.contextSummary ?? "", L.contextSummaryChars),
    expectedOutput: capText(input.expectedOutput ?? "", L.expectedOutputChars),
    status: "proposed",
    revision: 1,
    error: null,
    pmMessageId: null,
    pmTurnId: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    settledAt: null,
  };
  saveMessage({ ...message, delegationIds: [delegation.id] });
  transition(delegation);
  portfolioManagerStore.touch();
  return delegation;
}

export const __testing = {
  jobs,
  approving,
  reset(): void {
    jobs.clear();
    approving.clear();
    runningTurnId = null;
  },
};
