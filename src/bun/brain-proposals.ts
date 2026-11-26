/**
 * Durable memory proposals (FO-BRAIN03).
 *
 * Parsing a manager reply never reaches this module's approval path.
 * Approval is the only caller of the Brain store's proposal writer.
 * Boot clears an in-flight claim and does not create or approve a memory.
 */

import { randomUUID } from "node:crypto";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { BrainError } from "./brain-error.ts";
import { brainDirectory, openBrainStore, type BrainStore } from "./brain-store.ts";
import { dataDir, db, projects } from "./db.ts";
import { containsCredentialMaterial, proposalProvenance, type BrainCreateInput, type BrainMemory } from "../shared/brain/document.ts";
import {
  claimAllowsKind,
  proposalFingerprint,
  type MemoryProposal,
  type MemoryProposalDraft,
  type MemoryProposalDuplicate,
  type MemoryProposalEvent,
  type MemoryProposalManager,
  type MemoryProposalPermission,
  type MemoryProposalStatus,
} from "../shared/brain/proposals.ts";

export interface ProposalSource {
  managerKind: MemoryProposalManager;
  sourceProjectPath: string | null;
  conversationKey: string;
  turnId: string;
  messageId: string;
  permission: MemoryProposalPermission;
}

interface ProposalRow {
  id: string;
  status: MemoryProposalStatus;
  revision: number;
  manager_kind: MemoryProposalManager;
  source_project_path: string | null;
  conversation_key: string;
  turn_id: string;
  message_id: string;
  scope_kind: "company" | "project";
  scope_id: string;
  company_scope_allowed: number;
  claim: MemoryProposal["claim"];
  source_ref: string;
  original_title: string;
  original_kind: MemoryProposal["kind"];
  original_content: string;
  original_fingerprint: string;
  title: string;
  kind: MemoryProposal["kind"];
  content: string;
  content_fingerprint: string;
  edited_by_owner: number;
  decision: MemoryProposal["decision"];
  decision_reason: string | null;
  decided_at: number | null;
  memory_id: string | null;
  approval_request_id: string;
  approval_claim: string | null;
  created_at: number;
  updated_at: number;
}

let storeSingleton: BrainStore | null = null;
let afterMemoryCreated: ((memoryId: string) => void) | null = null;
let afterClaim: (() => Promise<void>) | null = null;

export function brainProposalStore(): BrainStore {
  if (!storeSingleton) {
    storeSingleton = openBrainStore(brainDirectory(dataDir), {
      isRegistered(projectPath) {
        return projects.get(projectPath) != null;
      },
    });
  }
  return storeSingleton;
}

/** Test seam. The production path leaves both unset. */
export const brainProposalTestHooks = {
  setAfterMemoryCreated(fn: ((memoryId: string) => void) | null) {
    afterMemoryCreated = fn;
  },
  setAfterClaim(fn: (() => Promise<void>) | null) {
    afterClaim = fn;
  },
};

export function recoverBrainProposals(): number {
  const changed = db.run(
    `UPDATE brain_memory_proposals
     SET approval_claim = NULL
     WHERE status = 'pending' AND memory_id IS NULL AND approval_claim IS NOT NULL`,
  ).changes;
  return changed;
}

export function recordMemoryProposals(source: ProposalSource, drafts: readonly MemoryProposalDraft[]): string[] {
  if (drafts.length === 0) return [];
  const ids: string[] = [];
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const draft of drafts) {
      const id = randomUUID();
      const inserted = db.run(
        `INSERT OR IGNORE INTO brain_memory_proposals (
          id, status, revision, manager_kind, source_project_path, conversation_key, turn_id, message_id,
          scope_kind, scope_id, company_scope_allowed, claim, source_ref,
          original_title, original_kind, original_content, original_fingerprint,
          title, kind, content, content_fingerprint, edited_by_owner,
          approval_request_id, created_at, updated_at
        ) VALUES (?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          id,
          source.managerKind,
          source.sourceProjectPath,
          source.conversationKey,
          source.turnId,
          source.messageId,
          draft.scopeKind,
          draft.scopeId,
          source.permission.company ? 1 : 0,
          draft.claim,
          draft.sourceRef,
          draft.title,
          draft.kind,
          draft.content,
          draft.fingerprint,
          draft.title,
          draft.kind,
          draft.content,
          draft.fingerprint,
          id,
          now,
          now,
        ],
      ).changes;
      if (inserted !== 1) continue;
      addEvent(id, "created", 1, "Proposed by the manager. Not a memory.", now);
      ids.push(id);
      journal({
        eventType: "brain.proposal.created",
        projectPath: draft.projectPath,
        actorType: source.managerKind === "project-manager" ? "project-manager" : "system",
        actorId: source.managerKind,
        targetId: id,
        turnId: source.turnId,
        idempotencyKey: `brain_proposal:${id}:created`,
        payload: {
          proposalId: id,
          title: draft.title,
          managerKind: source.managerKind,
          scopeKind: draft.scopeKind,
          claim: draft.claim,
        },
        createdAt: now,
      });
    }
  });
  tx();
  return ids;
}

export function listMemoryProposals(filter: {
  status?: MemoryProposalStatus | "all";
  managerKind?: MemoryProposalManager;
  sourceProjectPath?: string;
  messageId?: string;
  limit?: number;
} = {}): MemoryProposal[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status && filter.status !== "all") {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.managerKind) {
    where.push("manager_kind = ?");
    args.push(filter.managerKind);
  }
  if (filter.sourceProjectPath) {
    where.push("source_project_path = ?");
    args.push(filter.sourceProjectPath);
  }
  if (filter.messageId) {
    where.push("message_id = ?");
    args.push(filter.messageId);
  }
  const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
  const sql = `SELECT * FROM brain_memory_proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.query<ProposalRow, (string | number)[]>(sql).all(...args, limit);
  return rows.map((row) => toView(row, false));
}

export function readMemoryProposal(id: string): MemoryProposal {
  return toView(mustRow(id), true);
}

export function editMemoryProposal(
  id: string,
  edit: { expectedRevision: number; title?: string; kind?: MemoryProposal["kind"]; content?: string },
): MemoryProposal {
  const row = mustRow(id);
  if (row.status !== "pending") throw new BrainError("Only a pending proposal can be edited.", 409, "not_pending");
  if (row.revision !== edit.expectedRevision) throw new BrainError("This proposal changed. Review it again.", 409, "revision_conflict");
  const title = edit.title ?? row.title;
  const kind = edit.kind ?? row.kind;
  const content = edit.content ?? row.content;
  if (!claimAllowsKind(row.claim, kind)) {
    throw new BrainError(`A ${row.claim} proposal cannot be stored as a ${kind}.`, 400, "invalid_request");
  }
  if (containsCredentialMaterial(`${title}\n${content}`)) {
    throw new BrainError("Brain refused text that looks like a secret or credential.", 400, "credential_refused");
  }
  const fingerprint = proposalFingerprint({ scopeKind: row.scope_kind, scopeId: row.scope_id, kind, title, content });
  const now = Date.now();
  const changed = db.run(
    `UPDATE brain_memory_proposals
     SET title = ?, kind = ?, content = ?, content_fingerprint = ?, edited_by_owner = 1, revision = revision + 1, updated_at = ?
     WHERE id = ? AND status = 'pending' AND revision = ?`,
    [title, kind, content, fingerprint, now, id, row.revision],
  ).changes;
  if (changed !== 1) throw new BrainError("This proposal changed. Review it again.", 409, "revision_conflict");
  addEvent(id, "edited", row.revision + 1, "Owner edited the pending proposal.", now);
  return readMemoryProposal(id);
}

export async function approveMemoryProposal(id: string, expectedRevision: number): Promise<{ proposal: MemoryProposal; memory: BrainMemory; replayed: boolean }> {
  const existing = loadApproved(id);
  if (existing) return existing;
  const row = mustRow(id);
  if (row.status !== "pending") throw new BrainError(`This proposal is ${row.status}.`, 409, "not_pending");
  assertScopeStillValid(row);
  const input = createInput(row);
  const recalled = brainProposalStore().recallRequest(row.approval_request_id, input);
  if (recalled) return finalize(row.id, recalled, true);
  if (row.revision !== expectedRevision) throw new BrainError("This proposal changed. Review it again.", 409, "revision_conflict");
  if (containsCredentialMaterial(`${row.title}\n${row.content}`)) {
    throw new BrainError("Brain refused text that looks like a secret or credential.", 400, "credential_refused");
  }
  const claim = randomUUID();
  const claimed = db.run(
    `UPDATE brain_memory_proposals
     SET approval_claim = ?, updated_at = ?
     WHERE id = ? AND status = 'pending' AND memory_id IS NULL AND approval_claim IS NULL AND revision = ?`,
    [claim, Date.now(), id, expectedRevision],
  ).changes;
  if (claimed !== 1) return waitForApproval(id);
  if (afterClaim) await afterClaim();
  try {
    const created = brainProposalStore().createFromProposal(input, proposalProvenance({
      proposedBy: row.manager_kind,
      proposalId: row.id,
      claim: row.claim,
      editedByOwner: row.edited_by_owner === 1,
    }));
    afterMemoryCreated?.(created.memory.id);
    return finalize(row.id, created.memory, created.replayed);
  } catch (error) {
    db.run(
      `UPDATE brain_memory_proposals SET approval_claim = NULL WHERE id = ? AND status = 'pending' AND approval_claim = ? AND memory_id IS NULL`,
      [id, claim],
    );
    throw error;
  }
}

export function rejectMemoryProposal(id: string, expectedRevision: number, reason: string | null): MemoryProposal {
  const row = mustRow(id);
  if (row.status === "rejected") return toView(row, true);
  if (row.memory_id || row.status === "approved") {
    throw new BrainError("A memory was already created for this proposal. It was not rejected.", 409, "already_approved");
  }
  if (row.status !== "pending") throw new BrainError(`This proposal is ${row.status}.`, 409, "not_pending");
  if (row.revision !== expectedRevision) throw new BrainError("This proposal changed. Review it again.", 409, "revision_conflict");
  const now = Date.now();
  const changed = db.run(
    `UPDATE brain_memory_proposals
     SET status = 'rejected', decision = 'rejected', decision_reason = ?, decided_at = ?, approval_claim = NULL,
         revision = revision + 1, updated_at = ?
     WHERE id = ? AND status = 'pending' AND memory_id IS NULL AND revision = ?`,
    [reason, now, now, id, expectedRevision],
  ).changes;
  if (changed !== 1) throw new BrainError("This proposal changed. Review it again.", 409, "revision_conflict");
  addEvent(id, "rejected", expectedRevision + 1, reason ?? "Owner rejected the proposal. No memory was created.", now);
  journal({
    eventType: "brain.proposal.rejected",
    projectPath: row.scope_kind === "project" ? row.scope_id : null,
    actorType: "owner",
    actorId: "owner",
    targetId: id,
    turnId: row.turn_id,
    idempotencyKey: `brain_proposal:${id}:rejected`,
    payload: { proposalId: id, reason: reason ?? "" },
    createdAt: now,
  });
  return readMemoryProposal(id);
}

function createInput(row: ProposalRow): BrainCreateInput {
  return {
    scopeKind: row.scope_kind,
    ...(row.scope_kind === "project" ? { projectPath: row.scope_id } : {}),
    title: row.title,
    kind: row.kind,
    content: row.content,
    requestId: row.approval_request_id,
  };
}

function assertScopeStillValid(row: ProposalRow): void {
  if (row.scope_kind === "company") {
    if (row.company_scope_allowed !== 1) {
      throw new BrainError("Company scope was not approved for this proposal.", 409, "scope_unauthorized");
    }
    return;
  }
  if (row.manager_kind === "project-manager" && row.scope_id !== row.source_project_path) {
    throw new BrainError("A project manager proposal cannot be moved to another project.", 409, "scope_unauthorized");
  }
  if (projects.get(row.scope_id) == null) {
    const now = Date.now();
    db.run(
      `UPDATE brain_memory_proposals
       SET status = 'invalidated', decision = 'invalidated', decision_reason = ?, decided_at = ?,
           approval_claim = NULL, revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'pending' AND memory_id IS NULL`,
      ["The project is no longer registered. The proposal was not attached to another project.", now, now, row.id],
    );
    addEvent(row.id, "invalidated", row.revision + 1, "Project is no longer registered.", now);
    throw new BrainError("The project is no longer registered. Nothing was saved to another project.", 409, "project_not_registered");
  }
}

function finalize(id: string, memory: BrainMemory, replayed: boolean): { proposal: MemoryProposal; memory: BrainMemory; replayed: boolean } {
  const now = Date.now();
  db.run(
    `UPDATE brain_memory_proposals
     SET status = 'approved', decision = 'approved', memory_id = ?, decided_at = COALESCE(decided_at, ?),
         approval_claim = NULL, revision = revision + 1, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [memory.id, now, now, id],
  );
  const row = mustRow(id);
  if (row.memory_id !== memory.id) {
    throw new BrainError("The proposal is bound to a different memory.", 409, "duplicate_request");
  }
  addEvent(id, "approved", row.revision, `Owner approved. Memory ${memory.id}.`, now);
  journal({
    eventType: "brain.proposal.approved",
    projectPath: row.scope_kind === "project" ? row.scope_id : null,
    actorType: "owner",
    actorId: "owner",
    targetId: id,
    turnId: row.turn_id,
    idempotencyKey: `brain_proposal:${id}:approved`,
    payload: { proposalId: id, memoryId: memory.id, editedByOwner: row.edited_by_owner === 1 },
    createdAt: now,
  });
  return { proposal: toView(row, true), memory, replayed };
}

function loadApproved(id: string): { proposal: MemoryProposal; memory: BrainMemory; replayed: true } | null {
  const row = db.query<ProposalRow, [string]>("SELECT * FROM brain_memory_proposals WHERE id = ?").get(id);
  if (!row || row.status !== "approved" || !row.memory_id) return null;
  return { proposal: toView(row, true), memory: brainProposalStore().read(row.memory_id), replayed: true };
}

async function waitForApproval(id: string): Promise<{ proposal: MemoryProposal; memory: BrainMemory; replayed: boolean }> {
  for (let i = 0; i < 40; i++) {
    const done = loadApproved(id);
    if (done) return done;
    const row = mustRow(id);
    if (row.status === "pending" && row.approval_claim == null && row.memory_id == null) break;
    await Bun.sleep(25);
  }
  const done = loadApproved(id);
  if (done) return done;
  throw new BrainError("This proposal is being approved. Try again.", 409, "approval_in_progress");
}

function mustRow(id: string): ProposalRow {
  const row = db.query<ProposalRow, [string]>("SELECT * FROM brain_memory_proposals WHERE id = ?").get(id);
  if (!row) throw new BrainError("That proposal was not found.", 404, "not_found");
  return row;
}

function addEvent(proposalId: string, kind: string, revision: number, detail: string, createdAt: number): void {
  db.run(
    `INSERT INTO brain_memory_proposal_events (id, proposal_id, kind, revision, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), proposalId, kind, revision, detail.slice(0, 500), createdAt],
  );
}

function duplicateOf(row: ProposalRow): MemoryProposalDuplicate | null {
  if (row.status !== "pending") return null;
  try {
    return brainProposalStore().likelyDuplicate(createInput(row));
  } catch {
    return null;
  }
}

function toView(row: ProposalRow, withEvents: boolean): MemoryProposal {
  const events = withEvents
    ? db.query<MemoryProposalEvent & { created_at: number; proposal_id: string }, [string]>(
      "SELECT id, kind, revision, detail, created_at FROM brain_memory_proposal_events WHERE proposal_id = ? ORDER BY created_at ASC",
    ).all(row.id).map((event) => ({
      id: event.id,
      kind: event.kind,
      revision: event.revision,
      detail: event.detail,
      createdAt: event.created_at,
    }))
    : undefined;
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    managerKind: row.manager_kind,
    sourceProjectPath: row.source_project_path,
    conversationKey: row.conversation_key,
    turnId: row.turn_id,
    messageId: row.message_id,
    scope: { kind: row.scope_kind, id: row.scope_id },
    companyScopeAllowed: row.company_scope_allowed === 1,
    claim: row.claim,
    sourceRef: row.source_ref,
    original: {
      title: row.original_title,
      kind: row.original_kind,
      content: row.original_content,
      fingerprint: row.original_fingerprint,
    },
    title: row.title,
    kind: row.kind,
    content: row.content,
    contentFingerprint: row.content_fingerprint,
    editedByOwner: row.edited_by_owner === 1,
    decision: row.decision,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at,
    memoryId: row.memory_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    duplicateWarning: duplicateOf(row),
    ...(events ? { events } : {}),
    role: "data",
    executable: false,
    overridesRules: false,
  };
}

function journal(input: {
  eventType: "brain.proposal.created" | "brain.proposal.approved" | "brain.proposal.rejected";
  projectPath: string | null;
  actorType: "owner" | "project-manager" | "system";
  actorId: string;
  targetId: string;
  turnId: string;
  idempotencyKey: string;
  payload: Record<string, string | boolean>;
  createdAt: number;
}): void {
  try {
    new ActivityJournalCore(db).record({
      eventType: input.eventType,
      projectPath: input.projectPath,
      actorType: input.actorType,
      actorId: input.actorId,
      targetType: "proposal",
      targetId: input.targetId,
      turnId: input.turnId,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      createdAt: input.createdAt,
    });
  } catch (error) {
    console.warn("[agetor] brain proposal journal", error);
  }
}
