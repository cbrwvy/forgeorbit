/**
 * FO-HEAD02 — cross-project initiative persistence and progress (read from linked records).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ClusterCore } from "./cluster-core.ts";
import { insertHeadPreparedDelegation } from "./portfolio-manager.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { db, headPmInitiatives, portfolioManagerStore, projectManagers, projects, tasks } from "./db.ts";
import { capText } from "../shared/project-interview.ts";
import { sanitizeStoredProposal, sanitizeStoredMessage } from "../shared/project-manager.ts";
import { sanitizeDelegation, type DelegationProposal } from "../shared/portfolio-manager.ts";
import {
  deriveContributionProgress,
  deriveInitiativeStatus,
  HEAD_PM_INITIATIVE_LIMITS,
  sanitizeHeadPmInitiative,
  type HeadPmInitiative,
  type HeadPmInitiativeView,
  type InitiativeBatchSnapshot,
  type InitiativeContribution,
  type InitiativeDelegationDraft,
  type InitiativeDelegationSnapshot,
  type InitiativeTaskSnapshot,
} from "../shared/head-pm-initiative.ts";
import type { HeadPmInitiativeProposal } from "../shared/head-pm-initiative-proposal.ts";
import type { OrchestratedBatchRecord, OrchestratedBatchStatus } from "../shared/pm-orchestrated-batch.ts";

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function fail<T>(status: number, error: string): Result<T> {
  return { ok: false, status, error };
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadRaw(id: string): HeadPmInitiative | null {
  return sanitizeHeadPmInitiative(parseJson(headPmInitiatives.get(id)));
}

function persist(initiative: HeadPmInitiative): HeadPmInitiative {
  headPmInitiatives.put(initiative.id, initiative.status, JSON.stringify(initiative), initiative.createdAt);
  try {
    broadcastAppEvent({ type: "head_pm_initiative", initiativeId: initiative.id, status: initiative.status, ts: Date.now() });
  } catch { /* best-effort */ }
  return initiative;
}

function pmIdentity(projectPath: string): { employeeId: string | null; name: string | null } {
  const row = db.query<{ id: string; name: string }, [string]>(
    `SELECT id, name FROM ai_employees WHERE kind = 'project-manager' AND project_path = ? AND archived_at IS NULL LIMIT 1`,
  ).get(projectPath);
  return row ? { employeeId: row.id, name: row.name } : { employeeId: null, name: null };
}

function clusterForProject(database: Database, projectPath: string): { id: string | null; name: string | null } {
  const core = new ClusterCore(database, { pathExists: () => true, realpath: (p) => p });
  for (const cluster of core.list({ includeArchived: false })) {
    if (core.listProjects(cluster.id).some((p) => p.projectPath === projectPath)) {
      return { id: cluster.id, name: cluster.name };
    }
  }
  return { id: null, name: null };
}

function loadDelegation(id: string | null): DelegationProposal | null {
  if (!id) return null;
  return sanitizeDelegation(parseJson(portfolioManagerStore.getDelegation(id)));
}

function proposalsForDelegation(projectPath: string, delegationId: string): string[] {
  const messageIds = new Set<string>();
  for (const raw of projectManagers.listMessages(projectPath)) {
    const message = sanitizeStoredMessage(parseJson(raw));
    if (message?.delegationId === delegationId) messageIds.add(message.id);
  }
  const ids: string[] = [];
  for (const raw of projectManagers.listProposals(projectPath)) {
    const proposal = sanitizeStoredProposal(parseJson(raw));
    if (!proposal) continue;
    if (messageIds.has(proposal.messageId)) ids.push(proposal.id);
  }
  return ids;
}

function taskIdsFromProposals(projectPath: string, proposalIds: string[]): string[] {
  const ids = new Set<string>();
  for (const pid of proposalIds) {
    const raw = projectManagers.getProposal(projectPath, pid);
    const proposal = sanitizeStoredProposal(parseJson(raw));
    if (!proposal) continue;
    for (const item of proposal.items) {
      if (item.result?.taskId) ids.add(item.result.taskId);
    }
  }
  return [...ids];
}

function parseBatchRecord(raw: string): OrchestratedBatchRecord | null {
  try {
    return JSON.parse(raw) as OrchestratedBatchRecord;
  } catch {
    return null;
  }
}

function discoverBatchIds(projectPath: string, taskIds: Set<string>, known: string[]): string[] {
  const out = new Set(known);
  const rows = db.query<{ id: string; data_json: string }, [string]>(
    `SELECT id, data_json FROM pm_orchestrated_batches WHERE project_path = ? ORDER BY updated_at DESC LIMIT 20`,
  ).all(projectPath);
  for (const row of rows) {
    const record = parseBatchRecord(row.data_json);
    if (!record) continue;
    const batchTasks = record.tasks.map((t) => t.taskId);
    if (batchTasks.some((id) => taskIds.has(id))) out.add(record.id);
  }
  return [...out];
}

function batchSnapshots(projectPath: string, batchIds: string[]): InitiativeBatchSnapshot[] {
  const out: InitiativeBatchSnapshot[] = [];
  for (const id of batchIds) {
    const row = db.query<{ data_json: string }, [string, string]>(
      `SELECT data_json FROM pm_orchestrated_batches WHERE id = ? AND project_path = ?`,
    ).all(id, projectPath)[0];
    if (!row) continue;
    const record = parseBatchRecord(row.data_json);
    if (!record) continue;
    const status = record.status as OrchestratedBatchStatus;
    const needsAttention = status === "paused" || status === "stopped";
    out.push({ id, projectPath, title: record.title, status, needsAttention });
  }
  return out;
}

function taskSnapshots(taskIds: string[]): InitiativeTaskSnapshot[] {
  const out: InitiativeTaskSnapshot[] = [];
  for (const id of taskIds) {
    const task = tasks.get(id);
    if (!task) continue;
    const awaitingOwnerQc = task.column === "review"
      && task.qcState?.awaitingOwnerApproval === true
      && task.qcState.latestVerdict === "PASS";
    out.push({ id, title: task.title, column: task.column, awaitingOwnerQc });
  }
  return out;
}

function refreshContribution(contribution: InitiativeContribution): InitiativeContribution {
  const registered = projects.get(contribution.projectPath) != null;
  const delegation = loadDelegation(contribution.delegationId);
  let proposalIds = contribution.proposalIds;
  if (delegation?.id) {
    proposalIds = [...new Set([...proposalIds, ...proposalsForDelegation(contribution.projectPath, delegation.id)])];
  }
  let taskIds = contribution.taskIds;
  const fromProposals = taskIdsFromProposals(contribution.projectPath, proposalIds);
  taskIds = [...new Set([...taskIds, ...fromProposals])];
  const taskSet = new Set(taskIds);
  const orchestratedBatchIds = discoverBatchIds(contribution.projectPath, taskSet, contribution.orchestratedBatchIds);
  const snapshots = taskSnapshots(taskIds);
  const batches = batchSnapshots(contribution.projectPath, orchestratedBatchIds);
  const pendingProposalCount = projectManagers.listProposals(contribution.projectPath)
    .map((raw) => sanitizeStoredProposal(parseJson(raw)))
    .filter((p) => p?.status === "pending").length;
  const blockers: string[] = [];
  if (!registered) blockers.push("Project is no longer registered.");
  if (snapshots.some((t) => t.awaitingOwnerQc)) blockers.push("QC PASS awaiting Owner acceptance.");
  if (batches.some((b) => b.needsAttention)) blockers.push("Bounded batch needs attention.");
  const progress = deriveContributionProgress({
    delegationStatus: delegation?.status ?? null,
    pendingProposalCount,
    tasks: snapshots.map((t) => ({ id: t.id, column: t.column, awaitingOwnerQc: t.awaitingOwnerQc })),
    batchStatuses: batches.map((b) => ({ id: b.id, status: b.status, needsAttention: b.needsAttention })),
    manuallyClosed: contribution.manuallyClosed,
    projectRegistered: registered,
  });
  return {
    ...contribution,
    proposalIds,
    taskIds,
    orchestratedBatchIds,
    blockers,
    progress,
  };
}

function refreshInitiative(raw: HeadPmInitiative): HeadPmInitiative {
  const contributions = raw.contributions.map((c) => refreshContribution(c));
  const blockers: string[] = [];
  const coordination = db.query<{status: string; data_json: string}, [string]>("SELECT status, data_json FROM head_pm_auto WHERE initiative_id = ?").get(raw.id);
  if (coordination && (coordination.status === "blocked" || coordination.status === "paused")) {
    const reason = JSON.parse(coordination.data_json).blocker;
    if (reason) blockers.push(`Coordination: ${reason}`);
  }
  for (const c of contributions) blockers.push(...c.blockers.map((b) => `${c.projectName}: ${b}`));
  let status = deriveInitiativeStatus(raw.cancelledAt, contributions);
  if (blockers.length && status !== "completed" && status !== "cancelled") status = "needs_owner";
  const next: HeadPmInitiative = { ...raw, contributions, status, blockers: [...new Set(blockers)], updatedAt: Date.now() };
  if (next.status !== raw.status || JSON.stringify(next.contributions) !== JSON.stringify(raw.contributions)) {
    persist(next);
  }
  return next;
}

function toView(initiative: HeadPmInitiative): HeadPmInitiativeView {
  const refreshed = refreshInitiative(initiative);
  const delegationIds = new Set(refreshed.contributions.map((c) => c.delegationId).filter(Boolean) as string[]);
  const delegations: InitiativeDelegationSnapshot[] = [];
  for (const id of delegationIds) {
    const d = loadDelegation(id);
    if (!d) continue;
    delegations.push({
      id: d.id,
      projectPath: d.projectPath,
      objective: d.objective,
      status: d.status,
      initiativeId: d.initiativeId ?? null,
    });
  }
  const taskMap = new Map<string, InitiativeTaskSnapshot>();
  const batches: InitiativeBatchSnapshot[] = [];
  for (const c of refreshed.contributions) {
    for (const t of taskSnapshots(c.taskIds)) taskMap.set(t.id, t);
    batches.push(...batchSnapshots(c.projectPath, c.orchestratedBatchIds));
  }
  return {
    ...refreshed,
    delegations,
    tasks: [...taskMap.values()],
    batches,
  };
}

export function listHeadPmInitiatives(): HeadPmInitiativeView[] {
  return headPmInitiatives.listAll()
    .map((raw) => sanitizeHeadPmInitiative(parseJson(raw)))
    .filter((item): item is HeadPmInitiative => item != null)
    .map((item) => toView(item));
}

export function getHeadPmInitiative(id: string): HeadPmInitiativeView | null {
  const raw = loadRaw(id);
  if (!raw) return null;
  return toView(raw);
}

export function createHeadPmInitiative(body: {
  title?: unknown;
  goal?: unknown;
  description?: unknown;
  projectPaths?: unknown;
}): Result<HeadPmInitiativeView> {
  const title = capText(String(body.title ?? "").trim(), HEAD_PM_INITIATIVE_LIMITS.titleChars);
  if (!title) return fail(400, "Title is required.");
  const goal = capText(String(body.goal ?? "").trim(), HEAD_PM_INITIATIVE_LIMITS.goalChars);
  const description = capText(String(body.description ?? "").trim(), HEAD_PM_INITIATIVE_LIMITS.descriptionChars);
  const pathsRaw = Array.isArray(body.projectPaths) ? body.projectPaths : [];
  const projectPaths = [...new Set(pathsRaw.filter((p): p is string => typeof p === "string" && p.length > 0))];
  if (projectPaths.length === 0) return fail(400, "Pick at least one registered project.");
  if (projectPaths.length > HEAD_PM_INITIATIVE_LIMITS.maxProjects) {
    return fail(400, `At most ${HEAD_PM_INITIATIVE_LIMITS.maxProjects} projects per initiative.`);
  }
  const contributions: InitiativeContribution[] = [];
  for (const projectPath of projectPaths) {
    const project = projects.get(projectPath);
    if (!project) return fail(400, `Project is not registered: ${projectPath}`);
    const cluster = clusterForProject(db, projectPath);
    const pm = pmIdentity(projectPath);
    contributions.push({
      projectPath,
      projectName: project.name,
      clusterId: cluster.id,
      clusterName: cluster.name,
      pmEmployeeId: pm.employeeId,
      pmName: pm.name,
      delegationId: null,
      proposalIds: [],
      taskIds: [],
      orchestratedBatchIds: [],
      manuallyClosed: false,
      closeReason: null,
      blockers: [],
      delegationDraft: null,
      progress: "pending_delegation",
    });
  }
  const now = Date.now();
  const initiative: HeadPmInitiative = {
    id: randomUUID(),
    title,
    goal,
    description,
    contributions,
    status: "draft",
    blockers: [],
    sourceMessageId: null,
    sourceProposalId: null,
    createdAt: now,
    updatedAt: now,
    cancelledAt: null,
  };
  persist(initiative);
  return { ok: true, value: toView(initiative) };
}

export function createHeadPmInitiativeFromProposal(proposal: HeadPmInitiativeProposal): Result<HeadPmInitiativeView> {
  if (proposal.initiativeId) {
    const existing = getHeadPmInitiative(proposal.initiativeId);
    if (existing) return { ok: true, value: existing };
  }
  const contributions: InitiativeContribution[] = [];
  for (const draft of proposal.contributions) {
    const project = projects.get(draft.projectPath);
    if (!project) return fail(400, `Project is not registered: ${draft.projectName}`);
    const cluster = clusterForProject(db, draft.projectPath);
    const pm = pmIdentity(draft.projectPath);
    const delegationDraft: InitiativeDelegationDraft = {
      objective: draft.objective,
      request: draft.request,
      reason: draft.reason,
      contextSummary: draft.contextSummary,
      expectedOutput: draft.expectedOutput,
    };
    contributions.push({
      projectPath: draft.projectPath,
      projectName: project.name,
      clusterId: cluster.id,
      clusterName: cluster.name,
      pmEmployeeId: pm.employeeId,
      pmName: pm.name,
      delegationId: null,
      proposalIds: [],
      taskIds: [],
      orchestratedBatchIds: [],
      manuallyClosed: false,
      closeReason: null,
      blockers: [],
      delegationDraft,
      progress: "pending_delegation",
    });
  }
  const now = Date.now();
  const initiative: HeadPmInitiative = {
    id: randomUUID(),
    title: proposal.title,
    goal: proposal.goal,
    description: proposal.description,
    contributions,
    status: "draft",
    blockers: [],
    sourceMessageId: proposal.messageId,
    sourceProposalId: proposal.id,
    createdAt: now,
    updatedAt: now,
    cancelledAt: null,
  };
  persist(initiative);
  return { ok: true, value: toView(initiative) };
}

export function cancelHeadPmInitiative(id: string): Result<HeadPmInitiativeView> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative not found.");
  if (raw.cancelledAt != null) return { ok: true, value: toView(raw) };
  const next = { ...raw, cancelledAt: Date.now(), status: "cancelled" as const, updatedAt: Date.now() };
  persist(next);
  return { ok: true, value: toView(next) };
}

export function closeHeadPmContribution(
  id: string,
  projectPath: string,
  reason: string,
): Result<HeadPmInitiativeView> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative not found.");
  if (raw.cancelledAt != null) return fail(409, "Initiative is cancelled.");
  const idx = raw.contributions.findIndex((c) => c.projectPath === projectPath);
  if (idx < 0) return fail(404, "Project is not part of this initiative.");
  const closeReason = capText(reason.trim(), HEAD_PM_INITIATIVE_LIMITS.closeReasonChars);
  if (!closeReason) return fail(400, "A reason is required.");
  const contributions = raw.contributions.slice();
  contributions[idx] = {
    ...contributions[idx]!,
    manuallyClosed: true,
    closeReason,
  };
  const next = { ...raw, contributions, updatedAt: Date.now() };
  persist(next);
  return { ok: true, value: toView(next) };
}

export function prepareHeadPmDelegation(
  id: string,
  projectPath: string,
  body: {
    objective?: unknown;
    request?: unknown;
    reason?: unknown;
    contextSummary?: unknown;
    expectedOutput?: unknown;
  },
): Result<{ initiative: HeadPmInitiativeView; delegation: DelegationProposal }> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative not found.");
  if (raw.cancelledAt != null) return fail(409, "Cancelled initiatives cannot create delegations.");
  const idx = raw.contributions.findIndex((c) => c.projectPath === projectPath);
  if (idx < 0) return fail(404, "Project is not part of this initiative.");
  const contribution = raw.contributions[idx]!;
  const existing = loadDelegation(contribution.delegationId);
  if (existing && (existing.status === "proposed" || existing.status === "sending" || existing.status === "sent" || existing.status === "answered")) {
    return fail(409, "This contribution already has an active delegation.");
  }
  const objective = capText(String(body.objective ?? contribution.delegationDraft?.objective ?? "").trim(), HEAD_PM_INITIATIVE_LIMITS.goalChars);
  const request = capText(String(body.request ?? contribution.delegationDraft?.request ?? "").trim(), 4000);
  if (!objective || !request) return fail(400, "Objective and request are required.");
  const project = projects.get(projectPath);
  if (!project) return fail(400, "Project is no longer registered.");
  const delegation = insertHeadPreparedDelegation({
    initiativeId: id,
    projectPath,
    projectName: contribution.projectName,
    objective,
    request,
    reason: typeof body.reason === "string" ? body.reason : contribution.delegationDraft?.reason ?? "",
    contextSummary: typeof body.contextSummary === "string" ? body.contextSummary : contribution.delegationDraft?.contextSummary ?? "",
    expectedOutput: typeof body.expectedOutput === "string" ? body.expectedOutput : contribution.delegationDraft?.expectedOutput ?? "",
  });
  const contributions = raw.contributions.slice();
  contributions[idx] = { ...contribution, delegationId: delegation.id };
  const next = { ...raw, contributions, updatedAt: Date.now() };
  persist(next);
  return { ok: true, value: { initiative: toView(next), delegation } };
}

export function linkHeadPmBatch(
  id: string,
  projectPath: string,
  batchId: string,
): Result<HeadPmInitiativeView> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative not found.");
  const idx = raw.contributions.findIndex((c) => c.projectPath === projectPath);
  if (idx < 0) return fail(404, "Project is not part of this initiative.");
  const row = db.query<{ data_json: string }, [string, string]>(
    `SELECT data_json FROM pm_orchestrated_batches WHERE id = ? AND project_path = ?`,
  ).all(batchId, projectPath)[0];
  if (!row) return fail(404, "Batch not found for this project.");
  if (raw.cancelledAt != null) return fail(409, "Initiative is cancelled.");
  const batch = parseBatchRecord(row.data_json);
  if (!batch || batch.tasks.some(t => tasks.get(t.taskId)?.workdir !== projectPath)) return fail(409, "Batch task project mismatch.");
  const contributions = raw.contributions.slice();
  const c = contributions[idx]!;
  if (!c.orchestratedBatchIds.includes(batchId)) {
    contributions[idx] = { ...c, taskIds: [...new Set([...c.taskIds, ...batch.tasks.map(t => t.taskId)])], orchestratedBatchIds: [...c.orchestratedBatchIds, batchId] };
  }
  const next = { ...raw, contributions, updatedAt: Date.now() };
  persist(next);
  return { ok: true, value: toView(next) };
}
