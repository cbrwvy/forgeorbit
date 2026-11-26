/**
 * Knowledge Context Resolver (FO-011E).
 *
 * Decides which stored notes may be handed to an AI manager, shows the owner
 * exactly what would leave the machine, and turns the owner's confirmation
 * into a grant that one manager turn can consume once.
 *
 * - Scope comes from the registries on the server, never from the client:
 *   a project manager gets company notes, the notes of the project's current
 *   cluster, and the project's own notes. The portfolio manager gets company
 *   notes plus notes of an owner the owner names explicitly.
 * - Sensitive and archived notes are never eligible. Choosing a note is not
 *   consent; only an approved grant is.
 * - Markdown is materialized here from the Knowledge Core. The bytes that are
 *   hashed are the bytes that go into the prompt.
 * - This module starts no model, shell or connection, and logs no note text.
 */

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { FORGEORBIT_COMPANY, type KnowledgeOwnerRef } from "../shared/clusters/types.ts";
import { KNOWLEDGE_LIMITS, type KnowledgeDocument } from "../shared/knowledge/document.ts";
import {
  KNOWLEDGE_CONTEXT_CONSENT_NOTE,
  KNOWLEDGE_CONTEXT_LIMITS,
  KNOWLEDGE_TOKEN_NOTE,
  compareContextItems,
  levelOf,
  type KnowledgeContextGrant,
  type KnowledgeContextIssue,
  type KnowledgeContextItem,
  type KnowledgeContextPreview,
  type KnowledgeContextTarget,
  type KnowledgeEligibleDocument,
  type KnowledgeEligibleOwner,
  type KnowledgeEligibleResult,
  type KnowledgeIssueCode,
  type KnowledgePromptDocument,
  type KnowledgeSelectionInput,
  type KnowledgeTransmission,
  type KnowledgeTransmissionStatus,
} from "../shared/knowledge/context.ts";
import { KnowledgeCore } from "./knowledge-core.ts";
import { KnowledgeError } from "./knowledge-error.ts";

export type ContextFailure = { ok: false; status: number; error: string; issues?: KnowledgeContextIssue[] };
export type ContextResult<T> = { ok: true; value: T } | ContextFailure;

export interface KnowledgeContextDeps {
  /** Canonical registered project for a path the client sent (the same
   *  resolver the managers use), or a refusal. */
  resolveProject: (raw: string) => { ok: true; path: string } | { ok: false; status: number; error: string };
  now?: () => number;
}

interface GrantRow {
  id: string;
  manager_kind: "project" | "portfolio";
  project_path: string | null;
  status: KnowledgeTransmissionStatus;
  preview_key: string;
  items_json: string;
  total_bytes: number;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
  message_id: string | null;
  detail: string | null;
}

interface StoredItem {
  id: string;
  revision: number;
  sha256: string;
  purpose: string | null;
  title: string;
  level: KnowledgeContextItem["level"];
  byteLength: number;
}

interface ResolvedTarget {
  target: KnowledgeContextTarget;
  receiver: { kind: "project" | "portfolio"; label: string };
  /** Why a note owned by `owner` may not be sent to this manager, or null. */
  denies(owner: KnowledgeOwnerRef): KnowledgeIssueCode | null;
  /** Company is always allowed. Other owners need an explicit purpose. */
  requiresPurpose(owner: KnowledgeOwnerRef): boolean;
}

interface Evaluation {
  items: KnowledgeContextItem[];
  documents: KnowledgePromptDocument[];
  issues: KnowledgeContextIssue[];
  totalBytes: number;
}

function fail(status: number, error: string, issues?: KnowledgeContextIssue[]): ContextFailure {
  return { ok: false, status, error, ...(issues ? { issues } : {}) };
}

export class KnowledgeContextService {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly core: KnowledgeCore,
    private readonly deps: KnowledgeContextDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Boot: a grant that waited through a restart is never honored. */
  recover(): number {
    return this.db.run(
      `UPDATE knowledge_context_grants SET status = 'expired', settled_at = ?, detail = 'app restarted before the message was sent'
        WHERE status = 'approved'`,
      [this.now()],
    ).changes;
  }

  /* ── eligible documents ─────────────────────────────────────────────────── */

  eligible(target: KnowledgeContextTarget, explicitOwner?: KnowledgeOwnerRef): ContextResult<KnowledgeEligibleResult> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const scope = resolved.value;
    const owners = this.ownersToList(scope, explicitOwner);
    if (!owners.ok) return owners;
    const documents: KnowledgeEligibleDocument[] = [];
    let truncated = false;
    for (const owner of owners.value) {
      let listed;
      try {
        listed = this.core.list(owner, { limit: KNOWLEDGE_LIMITS.listDefault });
      } catch (error) {
        if (error instanceof KnowledgeError) return fail(error.status, error.message);
        throw error;
      }
      truncated ||= listed.truncated;
      for (const document of listed.documents) {
        const reason = this.documentReason(scope, document);
        documents.push({
          document,
          level: levelOf(document.owner),
          ownerLabel: this.ownerLabel(document.owner),
          eligible: reason == null,
          reason,
        });
      }
    }
    documents.sort((a, b) => compareContextItems(
      { level: a.level, ownerLabel: a.ownerLabel, title: a.document.title, id: a.document.id },
      { level: b.level, ownerLabel: b.ownerLabel, title: b.document.title, id: b.document.id },
    ));
    return {
      ok: true,
      value: {
        receiver: scope.receiver,
        documents,
        truncated,
        owners: target.kind === "portfolio" ? this.portfolioOwners() : [],
        note: KNOWLEDGE_CONTEXT_CONSENT_NOTE,
      },
    };
  }

  /* ── preview / approve ──────────────────────────────────────────────────── */

  preview(target: KnowledgeContextTarget, selections: KnowledgeSelectionInput[]): ContextResult<KnowledgeContextPreview> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    return { ok: true, value: this.previewOf(resolved.value, this.evaluate(resolved.value, selections)) };
  }

  approve(
    target: KnowledgeContextTarget,
    selections: KnowledgeSelectionInput[],
    previewKey: string,
  ): ContextResult<KnowledgeContextGrant> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const evaluation = this.evaluate(resolved.value, selections);
    const preview = this.previewOf(resolved.value, evaluation);
    if (evaluation.issues.length > 0) {
      return fail(409, "Some notes changed or can't be sent. Preview them again.", evaluation.issues);
    }
    if (preview.previewKey !== previewKey) {
      return fail(409, "The notes changed since the preview. Preview them again.", [
        { code: "preview-changed", documentId: null, message: "The previewed list no longer matches the notes." },
      ]);
    }
    const id = randomBytes(32).toString("hex");
    const now = this.now();
    const stored: StoredItem[] = evaluation.items.map((item) => ({
      id: item.id,
      revision: item.revision,
      sha256: item.sha256,
      purpose: item.purpose,
      title: item.title,
      level: item.level,
      byteLength: item.byteLength,
    }));
    const projectPath = resolved.value.target.kind === "project" ? resolved.value.target.projectPath : null;
    this.db.transaction(() => {
      // One live permission per manager: a newer confirmation replaces the older one.
      this.db.run(
        `UPDATE knowledge_context_grants SET status = 'revoked', settled_at = ?, detail = 'replaced by a newer confirmation'
          WHERE status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
        [now, resolved.value.target.kind, projectPath ?? ""],
      );
      this.db.run(
        `INSERT INTO knowledge_context_grants (id, manager_kind, project_path, status, preview_key, items_json, total_bytes, created_at, expires_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
        [id, resolved.value.target.kind, projectPath, preview.previewKey, JSON.stringify(stored), evaluation.totalBytes, now, now + KNOWLEDGE_CONTEXT_LIMITS.grantTtlMs],
      );
    }).immediate();
    return { ok: true, value: { grantId: id, expiresAt: now + KNOWLEDGE_CONTEXT_LIMITS.grantTtlMs, preview } };
  }

  revoke(target: KnowledgeContextTarget, grantId: string): ContextResult<{ revoked: boolean }> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const projectPath = resolved.value.target.kind === "project" ? resolved.value.target.projectPath : "";
    const changed = this.db.run(
      `UPDATE knowledge_context_grants SET status = 'revoked', settled_at = ?, detail = 'cancelled by the owner'
        WHERE id = ? AND status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
      [this.now(), grantId, resolved.value.target.kind, projectPath],
    ).changes;
    return { ok: true, value: { revoked: changed === 1 } };
  }

  /* ── consume (called by a manager turn) ─────────────────────────────────── */

  /**
   * Use a grant for one manager message. The grant is spent first, in one
   * atomic statement, so two concurrent sends can't both win. The notes are
   * then re-read and re-verified; any difference ends the grant as
   * `rejected` and nothing is sent. The returned documents hold the exact
   * bytes that were hashed.
   */
  consume(
    target: KnowledgeContextTarget,
    grantId: string,
    messageId: string | null,
  ): ContextResult<{ documents: KnowledgePromptDocument[]; totalBytes: number; ref: string }> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const kind = resolved.value.target.kind;
    const projectPath = resolved.value.target.kind === "project" ? resolved.value.target.projectPath : "";
    const now = this.now();
    const spent = this.db.run(
      `UPDATE knowledge_context_grants SET status = 'consumed', settled_at = ?, message_id = ?
        WHERE id = ? AND status = 'approved' AND expires_at > ? AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
      [now, messageId, grantId, now, kind, projectPath],
    ).changes;
    if (spent !== 1) {
      const row = this.grantRow(grantId);
      if (row && row.status === "approved" && row.expires_at <= now) {
        this.db.run(`UPDATE knowledge_context_grants SET status = 'expired', settled_at = ?, detail = 'expired before the message was sent' WHERE id = ? AND status = 'approved'`, [now, grantId]);
      }
      return fail(409, "The permission to send these notes is not valid any more (already used, expired, cancelled, or for another manager). Choose and confirm the notes again.");
    }
    const row = this.grantRow(grantId)!;
    const stored = parseStored(row.items_json);
    const selections: KnowledgeSelectionInput[] = stored.map((item) => ({
      id: item.id,
      revision: item.revision,
      sha256: item.sha256,
      ...(item.purpose ? { purpose: item.purpose } : {}),
    }));
    const evaluation = this.evaluate(resolved.value, selections);
    const preview = this.previewOf(resolved.value, evaluation);
    const drift = evaluation.issues.length > 0 || preview.previewKey !== row.preview_key;
    if (drift) {
      const issues = evaluation.issues.length > 0
        ? evaluation.issues
        : [{ code: "preview-changed" as const, documentId: null, message: "The notes changed after they were confirmed." }];
      this.db.run(
        `UPDATE knowledge_context_grants SET status = 'rejected', detail = ? WHERE id = ?`,
        [issues.map((issue) => issue.code).join(",").slice(0, 400), grantId],
      );
      return fail(409, "A confirmed note changed or can't be sent any more. Nothing was sent. Review the notes and confirm again.", issues);
    }
    return { ok: true, value: { documents: evaluation.documents, totalBytes: evaluation.totalBytes, ref: grantId.slice(0, 8) } };
  }

  /** Record which owner message used a consumed grant (retries keep the first). */
  attachMessage(grantId: string, messageId: string): void {
    this.db.run(`UPDATE knowledge_context_grants SET message_id = ? WHERE id = ? AND status = 'consumed' AND message_id IS NULL`, [messageId, grantId]);
  }

  /* ── audit ──────────────────────────────────────────────────────────────── */

  transmissions(target: KnowledgeContextTarget): ContextResult<{ transmissions: KnowledgeTransmission[] }> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const projectPath = resolved.value.target.kind === "project" ? resolved.value.target.projectPath : "";
    const rows = this.db.query<GrantRow, [string, string, number]>(
      `SELECT * FROM knowledge_context_grants WHERE manager_kind = ? AND IFNULL(project_path, '') = ?
        ORDER BY created_at DESC, id ASC LIMIT ?`,
    ).all(resolved.value.target.kind, projectPath, KNOWLEDGE_CONTEXT_LIMITS.auditPage);
    const now = this.now();
    return {
      ok: true,
      value: {
        transmissions: rows.map((row) => ({
          ref: row.id.slice(0, 8),
          status: row.status === "approved" && row.expires_at <= now ? "expired" : row.status,
          createdAt: row.created_at,
          settledAt: row.settled_at,
          messageId: row.message_id,
          totalBytes: row.total_bytes,
          detail: row.detail,
          items: parseStored(row.items_json).map((item) => ({
            id: item.id,
            title: item.title,
            level: item.level,
            revision: item.revision,
            sha256: item.sha256,
            byteLength: item.byteLength,
            purpose: item.purpose,
          })),
        })),
      },
    };
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private resolveTarget(target: KnowledgeContextTarget): ContextResult<ResolvedTarget> {
    if (target.kind === "portfolio") {
      return {
        ok: true,
        value: {
          target,
          receiver: { kind: "portfolio", label: "Portfolio manager" },
          denies: (owner) => this.portfolioDenies(owner),
          requiresPurpose: (owner) => owner.kind !== "company",
        },
      };
    }
    const project = this.deps.resolveProject(target.projectPath);
    if (!project.ok) return fail(project.status, project.error);
    const projectPath = project.path;
    const row = this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(projectPath);
    if (!row) return fail(404, "Project is not registered.");
    // Membership is read now, on every call, so a moved project loses the
    // old cluster at once.
    const membership = this.db.query<{ cluster_id: string }, [string]>(
      `SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ?`,
    ).get(projectPath);
    const clusterId = membership?.cluster_id ?? null;
    return {
      ok: true,
      value: {
        target: { kind: "project", projectPath },
        receiver: { kind: "project", label: `Project manager · ${row.name || path.basename(projectPath)}` },
        denies: (owner) => {
          if (owner.kind === "company") return owner.id === FORGEORBIT_COMPANY.id ? null : "out-of-scope";
          if (owner.kind === "project") return owner.id === projectPath ? null : "out-of-scope";
          if (!clusterId || owner.id !== clusterId) return "out-of-scope";
          return this.clusterExists(owner.id) ? null : "owner-missing";
        },
        requiresPurpose: () => false,
      },
    };
  }

  private portfolioDenies(owner: KnowledgeOwnerRef): KnowledgeIssueCode | null {
    if (owner.kind === "company") return owner.id === FORGEORBIT_COMPANY.id ? null : "out-of-scope";
    if (owner.kind === "cluster") return this.clusterExists(owner.id) ? null : "owner-missing";
    return this.db.query(`SELECT 1 FROM projects WHERE path = ?`).get(owner.id) ? null : "owner-missing";
  }

  private clusterExists(id: string): boolean {
    return this.db.query(`SELECT 1 FROM clusters WHERE id = ? AND archived_at IS NULL`).get(id) != null;
  }

  private ownersToList(scope: ResolvedTarget, explicit?: KnowledgeOwnerRef): ContextResult<KnowledgeOwnerRef[]> {
    if (scope.target.kind === "project") {
      const owners: KnowledgeOwnerRef[] = [{ kind: "company", id: FORGEORBIT_COMPANY.id }];
      const row = this.db.query<{ cluster_id: string }, [string]>(
        `SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ?`,
      ).get(scope.target.projectPath);
      if (row && this.clusterExists(row.cluster_id)) owners.push({ kind: "cluster", id: row.cluster_id });
      owners.push({ kind: "project", id: scope.target.projectPath });
      if (explicit) {
        const known = owners.some((owner) => owner.kind === explicit.kind && owner.id === explicit.id);
        if (!known) return fail(403, "That owner's notes are outside this manager's scope.");
      }
      return { ok: true, value: explicit ? [explicit] : owners };
    }
    // Portfolio: company notes by default; any other owner only when named.
    if (!explicit) return { ok: true, value: [{ kind: "company", id: FORGEORBIT_COMPANY.id }] };
    const denied = scope.denies(explicit);
    if (denied) return fail(denied === "owner-missing" ? 404 : 403, "That owner is not available to the portfolio manager.");
    return { ok: true, value: [explicit] };
  }

  private portfolioOwners(): KnowledgeEligibleOwner[] {
    const owners: KnowledgeEligibleOwner[] = [];
    for (const row of this.db.query<{ id: string; name: string }, []>(`SELECT id, name FROM clusters WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id`).all()) {
      owners.push({ owner: { kind: "cluster", id: row.id }, level: "cluster", label: row.name });
    }
    for (const row of this.db.query<{ path: string; name: string }, []>(`SELECT path, name FROM projects ORDER BY name COLLATE NOCASE, path`).all()) {
      owners.push({ owner: { kind: "project", id: row.path }, level: "project", label: row.name || path.basename(row.path) });
    }
    return owners;
  }

  private ownerLabel(owner: KnowledgeOwnerRef): string {
    if (owner.kind === "company") return "Company";
    if (owner.kind === "cluster") {
      return this.db.query<{ name: string }, [string]>(`SELECT name FROM clusters WHERE id = ?`).get(owner.id)?.name ?? "Cluster";
    }
    const row = this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(owner.id);
    return row?.name || path.basename(owner.id);
  }

  private documentReason(scope: ResolvedTarget, document: KnowledgeDocument): KnowledgeIssueCode | null {
    if (document.archivedAt != null) return "archived";
    if (document.sensitive) return "sensitive";
    const denied = scope.denies(document.owner);
    if (denied) return denied;
    if (document.byteLength > KNOWLEDGE_CONTEXT_LIMITS.documentBytes) return "too-large";
    return null;
  }

  private evaluate(scope: ResolvedTarget, selections: KnowledgeSelectionInput[]): Evaluation {
    const issues: KnowledgeContextIssue[] = [];
    const items: KnowledgeContextItem[] = [];
    const documents: KnowledgePromptDocument[] = [];
    const issue = (code: KnowledgeIssueCode, documentId: string | null, message: string) => issues.push({ code, documentId, message });
    for (const selection of selections) {
      let read;
      try {
        read = this.core.read(selection.id);
      } catch (error) {
        if (error instanceof KnowledgeError && error.status === 404) issue("not-found", selection.id, "This note no longer exists.");
        else issue("unreadable", selection.id, "This note could not be read.");
        continue;
      }
      const reason = this.documentReason(scope, read);
      if (reason) {
        issue(reason, read.id, reasonMessage(reason, read.title));
        continue;
      }
      const bytes = new TextEncoder().encode(read.content);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== read.sha256 || bytes.byteLength !== read.byteLength) {
        issue("integrity", read.id, `"${read.title}" does not match its recorded checksum.`);
        continue;
      }
      if (selection.revision !== undefined && selection.revision !== read.revision) {
        issue("stale-revision", read.id, `"${read.title}" has a newer revision (${read.revision}) than the one you reviewed (${selection.revision}).`);
        continue;
      }
      if (selection.sha256 !== undefined && selection.sha256 !== actualHash) {
        issue("stale-hash", read.id, `"${read.title}" changed since you reviewed it.`);
        continue;
      }
      const purpose = selection.purpose?.trim() || null;
      if (scope.requiresPurpose(read.owner) && !purpose) {
        issue("purpose-required", read.id, `Say why "${read.title}" is needed. Notes outside company level are sent only on purpose.`);
        continue;
      }
      const item: KnowledgeContextItem = {
        id: read.id,
        title: read.title,
        level: levelOf(read.owner),
        owner: read.owner,
        ownerLabel: this.ownerLabel(read.owner),
        category: read.category,
        revision: read.revision,
        sha256: actualHash,
        updatedAt: read.updatedAt,
        byteLength: bytes.byteLength,
        purpose,
      };
      items.push(item);
      documents.push({ ...item, content: read.content });
    }
    // Deterministic order for the prompt, the preview and the key.
    const order = items.map((item, index) => ({ item, doc: documents[index]! }));
    order.sort((a, b) => compareContextItems(a.item, b.item));
    const sortedItems = order.map((entry) => entry.item);
    const sortedDocs = order.map((entry) => entry.doc);
    const totalBytes = sortedItems.reduce((sum, item) => sum + item.byteLength, 0);
    if (totalBytes > KNOWLEDGE_CONTEXT_LIMITS.totalBytes) {
      issue(
        "over-budget",
        null,
        `The chosen notes are ${totalBytes.toLocaleString("en-US")} bytes. One message can carry ${KNOWLEDGE_CONTEXT_LIMITS.totalBytes.toLocaleString("en-US")}. Choose fewer notes; nothing is cut for you.`,
      );
    }
    return { items: sortedItems, documents: sortedDocs, issues, totalBytes };
  }

  private previewOf(scope: ResolvedTarget, evaluation: Evaluation): KnowledgeContextPreview {
    const key = createHash("sha256")
      .update(JSON.stringify({
        target: scope.target.kind === "project" ? ["project", scope.target.projectPath] : ["portfolio"],
        items: evaluation.items.map((item) => [item.id, item.revision, item.sha256, item.purpose ?? ""]),
      }))
      .digest("hex")
      .slice(0, 32);
    return {
      receiver: scope.receiver,
      items: evaluation.items,
      totalBytes: evaluation.totalBytes,
      limits: {
        documents: KNOWLEDGE_CONTEXT_LIMITS.documents,
        documentBytes: KNOWLEDGE_CONTEXT_LIMITS.documentBytes,
        totalBytes: KNOWLEDGE_CONTEXT_LIMITS.totalBytes,
      },
      tokenEstimate: null,
      tokenNote: KNOWLEDGE_TOKEN_NOTE,
      previewKey: key,
      issues: evaluation.issues,
      canApprove: evaluation.issues.length === 0 && evaluation.items.length > 0,
      note: KNOWLEDGE_CONTEXT_CONSENT_NOTE,
    };
  }

  private grantRow(id: string): GrantRow | null {
    return this.db.query<GrantRow, [string]>(`SELECT * FROM knowledge_context_grants WHERE id = ?`).get(id) ?? null;
  }
}

function reasonMessage(code: KnowledgeIssueCode, title: string): string {
  switch (code) {
    case "archived": return `"${title}" is archived and is not sent.`;
    case "sensitive": return `"${title}" is marked sensitive and is never sent to a model.`;
    case "out-of-scope": return `"${title}" is outside this manager's scope.`;
    case "owner-missing": return `The owner of "${title}" is not available any more.`;
    case "too-large": return `"${title}" is larger than ${KNOWLEDGE_CONTEXT_LIMITS.documentBytes.toLocaleString("en-US")} bytes. Split it; it is not cut for you.`;
    default: return `"${title}" can't be sent.`;
  }
}

function parseStored(json: string): StoredItem[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is StoredItem =>
      !!item && typeof item === "object"
      && typeof (item as StoredItem).id === "string"
      && typeof (item as StoredItem).revision === "number"
      && typeof (item as StoredItem).sha256 === "string");
  } catch {
    return [];
  }
}

/* ── default instance ─────────────────────────────────────────────────────── */

let defaultService: KnowledgeContextService | null = null;
let override: KnowledgeContextService | null = null;

export async function loadKnowledgeContext(): Promise<KnowledgeContextService> {
  if (override) return override;
  if (defaultService) return defaultService;
  const [{ db, dataDir }, { createKnowledgeFiles }, { resolveProject }] = await Promise.all([
    import("./db.ts"),
    import("./knowledge-files.ts"),
    import("./environment/http.ts"),
  ]);
  defaultService = new KnowledgeContextService(
    db,
    new KnowledgeCore(db, createKnowledgeFiles(path.join(dataDir, "knowledge"))),
    { resolveProject },
  );
  return defaultService;
}

/** Boot hook, next to the other recovery calls. */
export async function recoverKnowledgeContext(): Promise<number> {
  return (await loadKnowledgeContext()).recover();
}

/** Tests only. */
export function __setKnowledgeContextForTest(service: KnowledgeContextService | null): void {
  override = service;
}
