/**
 * Brain 2.0 Automatic Knowledge Extractor (FO-BRAIN04).
 *
 * Ingests durable ForgeOrbit events (completed tasks, successful runs, QC reviews,
 * rework history, owner decisions, head decisions) and idempotently extracts
 * reusable knowledge candidates without saving full conversations or raw logs.
 */

import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { db, dataDir, projects } from "./db.ts";
import { brainDirectory, openBrainStore, type BrainStore } from "./brain-store.ts";
import { BrainError } from "./brain-error.ts";
import type {
  BrainExtractionCandidate,
  CandidateDecisionInput,
  CandidateEditInput,
  CandidateListQuery,
  CandidateQualityAssessment,
  ExtractionEventKind,
} from "../shared/brain/extraction.ts";
import type { BrainCreateInput, BrainExtractionProvenance, BrainKind, BrainMemory, BrainScopeKind } from "../shared/brain/document.ts";
import { generateEmbedding, storeEmbedding } from "./brain-embeddings.ts";
import { ownerProjectOf } from "./project-ownership.ts";
import { BRAIN_KINDS, containsCredentialMaterial } from "../shared/brain/document.ts";
import { evaluateCandidateQuality } from "./brain-quality.ts";

export interface TaskCompletedSourceEvent {
  kind: "completed_task";
  taskId: string;
  runId?: string;
  taskTitle: string;
  prompt: string;
  solutionSummary?: string;
  /**
   * Whether an independent quality-control review passed for this task. Only
   * then may the text say so; reaching Done alone is not verification.
   */
  qcPassed?: boolean;
  projectPath: string;
  completedAt: number;
}

export interface SuccessfulRunSourceEvent {
  kind: "successful_run";
  taskId: string;
  runId: string;
  agent: string;
  projectPath: string;
  approachSummary?: string;
  endedAt: number;
}

export interface QcReviewSourceEvent {
  kind: "qc_review";
  taskId: string;
  runId: string;
  reviewId: string;
  verdict: "approved" | "rework" | "rejected";
  summary: string;
  failurePattern?: string;
  projectPath: string;
  reviewedAt: number;
}

export interface ReworkResolvedSourceEvent {
  kind: "rework_resolved";
  taskId: string;
  priorError: string;
  fixSummary: string;
  projectPath: string;
  resolvedAt: number;
}

export interface OwnerDecisionSourceEvent {
  kind: "owner_decision";
  decisionId: string;
  title: string;
  content: string;
  projectPath?: string;
  decidedAt: number;
}

export interface HeadDecisionSourceEvent {
  kind: "head_decision";
  initiativeId: string;
  title: string;
  content: string;
  scopeKind: BrainScopeKind;
  scopeId: string;
  decidedAt: number;
}

export type ExtractionEvent =
  | TaskCompletedSourceEvent
  | SuccessfulRunSourceEvent
  | QcReviewSourceEvent
  | ReworkResolvedSourceEvent
  | OwnerDecisionSourceEvent
  | HeadDecisionSourceEvent;

interface CandidateRow {
  id: string;
  status: string;
  source_event_kind: string;
  source_event_id: string;
  source_record_ids_json: string;
  scope_kind: string;
  scope_id: string;
  title: string;
  kind: string;
  content: string;
  confidence: number;
  extraction_method: string;
  provenance_json: string;
  quality_json: string;
  supersedes_memory_id: string | null;
  related_memory_ids_json: string;
  memory_id: string | null;
  decision_reason: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
}

function toCandidate(r: CandidateRow): BrainExtractionCandidate {
  return {
    id: r.id,
    status: r.status as any,
    sourceEventKind: r.source_event_kind as any,
    sourceEventId: r.source_event_id,
    sourceRecordIds: JSON.parse(r.source_record_ids_json),
    scopeKind: r.scope_kind as any,
    scopeId: r.scope_id,
    title: r.title,
    kind: r.kind as any,
    content: r.content,
    confidence: r.confidence,
    extractionMethod: r.extraction_method as any,
    quality: JSON.parse(r.quality_json),
    supersedesMemoryId: r.supersedes_memory_id,
    relatedMemoryIds: JSON.parse(r.related_memory_ids_json),
    memoryId: r.memory_id,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at,
  };
}

export function extractCandidateDraft(event: ExtractionEvent): {
  title: string;
  content: string;
  kind: BrainKind;
  scopeKind: BrainScopeKind;
  scopeId: string;
  sourceRecordIds: string[];
  sourceEventId: string;
  eventAt: number;
} {
  switch (event.kind) {
    case "completed_task": {
      const title = `Task completed: ${event.taskTitle.slice(0, 150)}`;
      const outcome = event.qcPassed
        ? "Moved to Done after a quality-control review passed."
        : "Moved to Done. No quality-control review is recorded for it.";
      const content = event.solutionSummary
        ? `Task: ${event.taskTitle}\nApproach: ${event.solutionSummary}`
        : `Task: ${event.taskTitle}\nOutcome: ${outcome}\nRequirement: ${event.prompt.slice(0, 500)}`;
      return {
        title,
        content,
        kind: "fact",
        scopeKind: "project",
        scopeId: event.projectPath,
        sourceRecordIds: [event.taskId, ...(event.runId ? [event.runId] : [])],
        sourceEventId: event.taskId,
        eventAt: event.completedAt,
      };
    }
    case "successful_run": {
      const title = `Developer run finished on ${event.agent}`;
      const content = event.approachSummary
        ? `Agent ${event.agent} executed task ${event.taskId}.\nRun outcome: ${event.approachSummary}`
        : `Agent ${event.agent} finished task ${event.taskId} with a successful exit. No quality-control review is implied.`;
      return {
        title,
        content,
        kind: "observation",
        scopeKind: "project",
        scopeId: event.projectPath,
        sourceRecordIds: [event.taskId, event.runId],
        sourceEventId: event.runId,
        eventAt: event.endedAt,
      };
    }
    case "qc_review": {
      if (event.verdict === "approved") {
        const title = `QC passed: ${event.summary.slice(0, 150)}`;
        const content = `Task ${event.taskId} passed quality control review.\nVerification details: ${event.summary}`;
        return {
          title,
          content,
          kind: "fact",
          scopeKind: "project",
          scopeId: event.projectPath,
          sourceRecordIds: [event.taskId, event.runId, event.reviewId],
          sourceEventId: event.reviewId,
          eventAt: event.reviewedAt,
        };
      } else {
        const title = `Known failure pattern: ${event.failurePattern ?? event.summary.slice(0, 120)}`;
        const content = `Quality review required rework.\nVerdict: ${event.verdict}\nDefect: ${event.summary}${event.failurePattern ? `\nPattern: ${event.failurePattern}` : ""}`;
        return {
          title,
          content,
          kind: "observation",
          scopeKind: "project",
          scopeId: event.projectPath,
          sourceRecordIds: [event.taskId, event.runId, event.reviewId],
          sourceEventId: event.reviewId,
          eventAt: event.reviewedAt,
        };
      }
    }
    case "rework_resolved": {
      const title = `Resolved issue: ${event.priorError.slice(0, 120)}`;
      const content = `Encountered defect: ${event.priorError}\nResolution: ${event.fixSummary}`;
      return {
        title,
        content,
        kind: "fact",
        scopeKind: "project",
        scopeId: event.projectPath,
        sourceRecordIds: [event.taskId],
        sourceEventId: `rework-${event.taskId}`,
        eventAt: event.resolvedAt,
      };
    }
    case "owner_decision": {
      return {
        title: event.title,
        content: event.content,
        kind: "decision",
        scopeKind: event.projectPath ? "project" : "company",
        scopeId: event.projectPath ?? "company",
        sourceRecordIds: [event.decisionId],
        sourceEventId: event.decisionId,
        eventAt: event.decidedAt,
      };
    }
    case "head_decision": {
      return {
        title: event.title,
        content: event.content,
        kind: "decision",
        scopeKind: event.scopeKind,
        scopeId: event.scopeId,
        sourceRecordIds: [event.initiativeId],
        sourceEventId: event.initiativeId,
        eventAt: event.decidedAt,
      };
    }
  }
}

let storeGetter: (() => BrainStore) | null = null;
export function setBrainStoreGetter(fn: (() => BrainStore) | null): void {
  storeGetter = fn;
}

function getStore(): BrainStore {
  if (storeGetter) return storeGetter();
  return openBrainStore(brainDirectory(dataDir), {
    isRegistered(projectPath) {
      return projects.get(projectPath) != null;
    },
  });
}

function resolveRegisteredOwner(workdir: string): string | null {
  const store = getStore();
  if (store.isProjectRegistered(workdir)) return workdir;
  const owner = ownerProjectOf(workdir);
  return owner && store.isProjectRegistered(owner) ? owner : null;
}

/**
 * Idempotently ingests a durable event and creates a candidate in `brain_extraction_candidates`.
 */
export async function ingestExtractionEvent(event: ExtractionEvent): Promise<BrainExtractionCandidate | null> {
  const draft = extractCandidateDraft(event);

  // A project candidate belongs to the registered project that owns the task's
  // folder (a subfolder or a linked worktree counts), never to the raw folder.
  // A folder no registered project owns would yield a candidate that cannot be
  // approved, so it yields none.
  if (draft.scopeKind === "project") {
    const owner = resolveRegisteredOwner(draft.scopeId);
    if (!owner) return null;
    draft.scopeId = owner;
  }

  // Check idempotency: if already ingested, do not duplicate!
  const existing = db.query<CandidateRow, [string, string]>(
    "SELECT * FROM brain_extraction_candidates WHERE source_event_kind = ? AND source_event_id = ?",
  ).get(event.kind, draft.sourceEventId);

  if (existing) {
    return toCandidate(existing);
  }

  // Pre-generate candidate embedding for quality evaluation
  const embedded = await generateEmbedding(`${draft.title}\n${draft.content}`);

  // Evaluate candidate quality against brain index
  const store = getStore();
  const brainDb = (store as any).db;
  const quality = evaluateCandidateQuality(brainDb, {
    title: draft.title,
    content: draft.content,
    scopeKind: draft.scopeKind,
    scopeId: draft.scopeId,
    sourceTimestamps: { eventAt: draft.eventAt, extractedAt: Date.now() },
    candidateEmbedding: embedded?.vector,
  });

  // If exact duplicate or low info / credential failed
  if (!quality.pass) {
    // We reject candidates that contain credentials or lack information
    return null;
  }

  const id = randomUUID();
  const now = Date.now();
  const provenance: BrainExtractionProvenance = {
    source: "automatic-extraction",
    approval: "explicit",
    approvedBy: "owner",
    sourceEventKind: event.kind,
    sourceRecordIds: draft.sourceRecordIds,
    extractionMethod: "heuristic",
    confidence: quality.confidence,
    note: `Extracted from durable event ${event.kind}. Stored as candidate pending Owner review.`,
    supersedesMemoryId: quality.supersedesMemoryId ?? null,
  };

  db.run(
    `INSERT INTO brain_extraction_candidates (
      id, status, source_event_kind, source_event_id, source_record_ids_json,
      scope_kind, scope_id, title, kind, content, confidence,
      extraction_method, provenance_json, quality_json, supersedes_memory_id,
      related_memory_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_event_kind, source_event_id) DO NOTHING`,
    [
      id,
      "candidate",
      event.kind,
      draft.sourceEventId,
      JSON.stringify(draft.sourceRecordIds),
      draft.scopeKind,
      draft.scopeId,
      draft.title,
      draft.kind,
      draft.content,
      quality.confidence,
      "heuristic",
      JSON.stringify(provenance),
      JSON.stringify(quality),
      quality.supersedesMemoryId ?? null,
      JSON.stringify([]),
      now,
      now,
    ],
  );

  const inserted = db.query<CandidateRow, [string]>(
    "SELECT * FROM brain_extraction_candidates WHERE id = ?",
  ).get(id);

  return inserted ? toCandidate(inserted) : null;
}

export function listExtractionCandidates(query: CandidateListQuery = {}): BrainExtractionCandidate[] {
  const status = query.status ?? "candidate";
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));

  let sql = "SELECT * FROM brain_extraction_candidates WHERE 1=1";
  const params: any[] = [];

  if (status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }
  if (query.scopeKind) {
    sql += " AND scope_kind = ?";
    params.push(query.scopeKind);
  }
  if (query.projectPath) {
    sql += " AND scope_id = ?";
    params.push(query.projectPath);
  }
  if (query.sourceEventKind) {
    sql += " AND source_event_kind = ?";
    params.push(query.sourceEventKind);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.query<CandidateRow, any[]>(sql).all(...params);
  return rows.map(toCandidate);
}

export function readExtractionCandidate(id: string): BrainExtractionCandidate | null {
  const row = db.query<CandidateRow, [string]>(
    "SELECT * FROM brain_extraction_candidates WHERE id = ?",
  ).get(id);
  return row ? toCandidate(row) : null;
}

export function editExtractionCandidate(id: string, edit: CandidateEditInput): BrainExtractionCandidate {
  const existing = readExtractionCandidate(id);
  if (!existing) {
    throw new BrainError("Candidate not found.", 404, "not_found");
  }
  if (existing.status !== "candidate") {
    throw new BrainError("Only pending candidates can be edited.", 409, "invalid_status");
  }

  for (const [name, value] of [["title", edit.title], ["content", edit.content]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new BrainError(`Candidate ${name} must be non-empty text.`, 400, "invalid_request");
    }
  }
  if (edit.kind !== undefined && !(BRAIN_KINDS as readonly string[]).includes(edit.kind)) {
    throw new BrainError("Candidate kind is not valid.", 400, "invalid_request");
  }
  const nextTitle = edit.title?.trim() ?? existing.title;
  const nextKind = edit.kind ?? existing.kind;
  const nextContent = edit.content?.trim() ?? existing.content;
  // The candidate row is stored and shown as typed, so a credential is refused
  // here and not only when the memory file is written.
  if (containsCredentialMaterial(`${nextTitle}\n${nextContent}`)) {
    throw new BrainError("Brain refused text that looks like a secret or credential.", 400, "credential_refused");
  }
  const now = Date.now();

  db.run(
    `UPDATE brain_extraction_candidates
     SET title = ?, kind = ?, content = ?, updated_at = ?
     WHERE id = ?`,
    [nextTitle, nextKind, nextContent, now, id],
  );

  return readExtractionCandidate(id)!;
}

export async function approveExtractionCandidate(
  id: string,
  options?: { title?: string; kind?: BrainKind; content?: string },
): Promise<{ candidate: BrainExtractionCandidate; memory: BrainMemory }> {
  const candidate = readExtractionCandidate(id);
  if (!candidate) {
    throw new BrainError("Candidate not found.", 404, "not_found");
  }
  if (candidate.status === "approved" && candidate.memoryId) {
    const store = getStore();
    const memory = store.read(candidate.memoryId);
    return { candidate, memory };
  }
  if (candidate.status !== "candidate") {
    throw new BrainError("Candidate cannot be approved in current status.", 409, "invalid_status");
  }

  const store = getStore();
  const finalTitle = options?.title?.trim() ?? candidate.title;
  const finalKind = options?.kind ?? candidate.kind;
  const finalContent = options?.content?.trim() ?? candidate.content;

  const input: BrainCreateInput = {
    scopeKind: candidate.scopeKind,
    projectPath: candidate.scopeKind === "project" ? candidate.scopeId : undefined,
    title: finalTitle,
    kind: finalKind,
    content: finalContent,
    requestId: candidate.id,
  };

  const provenance: BrainExtractionProvenance = {
    source: "automatic-extraction",
    approval: "explicit",
    approvedBy: "owner",
    sourceEventKind: candidate.sourceEventKind,
    sourceRecordIds: candidate.sourceRecordIds,
    extractionMethod: candidate.extractionMethod,
    confidence: candidate.confidence,
    note: `Extracted from ${candidate.sourceEventKind}. Approved by Owner.`,
    supersedesMemoryId: candidate.supersedesMemoryId,
  };

  const created = (store as any).createFromExtraction
    ? (store as any).createFromExtraction(input, provenance)
    : store.create(input);

  const memory: BrainMemory = created.memory;

  // Persist real embedding
  const layout = (store as any).layout;
  const dbIndex = (store as any).db;
  if (dbIndex) {
    await storeEmbedding(dbIndex, memory.id, memory.revision, memory.contentSha256, memory.title, memory.content);
  }

  const now = Date.now();
  db.run(
    `UPDATE brain_extraction_candidates
     SET status = 'approved', memory_id = ?, decided_at = ?, updated_at = ?
     WHERE id = ?`,
    [memory.id, now, now, id],
  );

  return { candidate: readExtractionCandidate(id)!, memory };
}

export function rejectExtractionCandidate(id: string, reason?: string): BrainExtractionCandidate {
  const candidate = readExtractionCandidate(id);
  if (!candidate) {
    throw new BrainError("Candidate not found.", 404, "not_found");
  }
  if (candidate.status !== "candidate") {
    throw new BrainError("Only pending candidates can be rejected.", 409, "invalid_status");
  }

  const now = Date.now();
  db.run(
    `UPDATE brain_extraction_candidates
     SET status = 'rejected', decision_reason = ?, decided_at = ?, updated_at = ?
     WHERE id = ?`,
    [reason?.trim() ?? "Rejected by Owner", now, now, id],
  );

  return readExtractionCandidate(id)!;
}
