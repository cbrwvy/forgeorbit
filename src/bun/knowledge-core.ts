/**
 * Index for hierarchical Markdown notes.
 *
 * The registry decides whether an owner exists. The Markdown file is written
 * before the SQLite commit and removed again if that commit does not land.
 * A stale expectedRevision cannot replace a newer note. Nothing here starts
 * a model, a shell, or a connection to a server.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { FORGEORBIT_COMPANY, type KnowledgeOwnerRef } from "../shared/clusters/types.ts";
import {
  KNOWLEDGE_CONTEXT_NOTE,
  KNOWLEDGE_LIMITS,
  type KnowledgeCreateInput,
  type KnowledgeDocument,
  type KnowledgeRevisionInfo,
  type KnowledgeScope,
  type KnowledgeSearchHit,
  type KnowledgeUpdateInput,
} from "../shared/knowledge/document.ts";
import { KnowledgeError } from "./knowledge-error.ts";
import type { KnowledgeFiles } from "./knowledge-files.ts";

interface DocumentRow {
  id: string;
  owner_kind: KnowledgeOwnerRef["kind"];
  owner_id: string;
  title: string;
  description: string;
  category: string;
  tags_json: string;
  sensitive: number;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  content_sha256: string;
  byte_length: number;
  inherit_to_projects: number;
}

interface RevisionRow {
  revision: number;
  created_at: number;
  byte_length: number;
  content_sha256: string;
}

export interface KnowledgeRead extends KnowledgeDocument {
  content: string;
  sha256: string;
}

export interface KnowledgeCoreOptions {
  now?: () => number;
  /** Runs after the new Markdown file is durable and before SQLite commits. */
  beforeCommit?: () => void;
}

export class KnowledgeCore {
  private readonly now: () => number;
  private readonly beforeCommit?: () => void;

  constructor(
    private readonly db: Database,
    private readonly files: KnowledgeFiles,
    options: KnowledgeCoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.beforeCommit = options.beforeCommit;
    this.db.run("PRAGMA foreign_keys = ON");
  }

  list(owner: KnowledgeOwnerRef, options: { includeArchived?: boolean; category?: string | null; tag?: string | null; limit?: number } = {}): { documents: KnowledgeDocument[]; truncated: boolean } {
    this.requireOwner(owner);
    return this.listOwners([owner], options);
  }

  create(input: KnowledgeCreateInput): KnowledgeDocument {
    this.requireOwner(input.owner);
    const id = randomUUID();
    const now = this.now();
    const bytes = encode(input.content);
    let written: number | null = null;
    try {
      this.db.transaction(() => {
        const stored = this.files.writeRevision(id, 1, bytes);
        written = 1;
        this.beforeCommit?.();
        this.db.run(
          `INSERT INTO knowledge_documents (
             id, owner_kind, owner_id, title, description, category, tags_json, sensitive,
             revision, created_at, updated_at, archived_at, content_sha256, byte_length, inherit_to_projects
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?)`,
          [
            id,
            input.owner.kind,
            input.owner.id,
            input.title,
            input.description,
            input.category,
            JSON.stringify(input.tags),
            input.sensitive ? 1 : 0,
            now,
            now,
            stored.sha256,
            stored.byteLength,
            input.inheritToProjects ? 1 : 0,
          ],
        );
        this.insertRevision(id, 1, now, stored);
      }).immediate();
    } catch (error) {
      if (written != null) this.files.removeRevision(id, written);
      throw asKnowledgeError(error);
    }
    return this.requireMeta(id);
  }

  read(id: string, revision?: number): KnowledgeRead {
    const row = this.requireRow(id);
    const target = revision ?? row.revision;
    if (revision != null && !this.revisionRow(id, target)) {
      throw new KnowledgeError("Revision not found.", 404);
    }
    const bytes = this.files.readRevision(id, target, revision == null ? row.content_sha256 : this.revisionRow(id, target)?.content_sha256);
    return { ...toDocument(row), content: new TextDecoder().decode(bytes), sha256: this.revisionRow(id, target)?.content_sha256 ?? row.content_sha256 };
  }

  update(id: string, input: KnowledgeUpdateInput): KnowledgeDocument {
    const bytes = input.content === undefined ? null : encode(input.content);
    let written: number | null = null;
    try {
      // Lock the SQLite writer before publishing bytes: a competing
      // connection must never rename or clean up this same next revision.
      this.db.transaction(() => {
        const row = this.requireRow(id);
        this.assertCurrent(row, input.expectedRevision);
        if (row.archived_at != null) throw new KnowledgeError("Archived notes cannot be edited. Restore the note first.", 409);
        const next = row.revision + 1;
        const payload = bytes ?? this.files.readRevision(id, row.revision, row.content_sha256);
        const stored = this.files.writeRevision(id, next, payload);
        written = next;
        this.beforeCommit?.();
        const title = input.title ?? row.title;
        const description = input.description ?? row.description;
        const category = input.category ?? row.category;
        const tags = input.tags ?? parseTags(row.tags_json);
        const sensitive = input.sensitive ?? row.sensitive === 1;
        const inherit = input.inheritToProjects ?? row.inherit_to_projects === 1;
        const changed = this.db.run(
          `UPDATE knowledge_documents
              SET title = ?, description = ?, category = ?, tags_json = ?, sensitive = ?,
                  inherit_to_projects = ?, revision = ?, updated_at = ?, content_sha256 = ?, byte_length = ?
            WHERE id = ? AND revision = ? AND archived_at IS NULL`,
          [
            title,
            description,
            category,
            JSON.stringify(tags),
            sensitive ? 1 : 0,
            inherit ? 1 : 0,
            next,
            this.now(),
            stored.sha256,
            stored.byteLength,
            id,
            row.revision,
          ],
        ).changes;
        if (changed !== 1) throw new KnowledgeError("This note was saved by a newer edit. Reload it and try again.", 409);
        this.insertRevision(id, next, this.now(), stored);
      }).immediate();
    } catch (error) {
      if (written != null) this.files.removeRevision(id, written);
      throw asKnowledgeError(error);
    }
    this.prune(id);
    return this.requireMeta(id);
  }

  archive(id: string, expectedRevision: number): KnowledgeDocument {
    this.setArchived(id, expectedRevision, true);
    return this.requireMeta(id);
  }

  restore(id: string, expectedRevision: number): KnowledgeDocument {
    this.setArchived(id, expectedRevision, false);
    return this.requireMeta(id);
  }

  remove(id: string, expectedRevision: number): void {
    const row = this.requireRow(id);
    if (row.archived_at == null) throw new KnowledgeError("Archive the note before deleting it.", 409);
    let removed = false;
    try {
      this.db.transaction(() => {
        const current = this.requireRow(id);
        this.assertCurrent(current, expectedRevision);
        if (current.archived_at == null) throw new KnowledgeError("Archive the note before deleting it.", 409);
        this.db.run(`DELETE FROM knowledge_revisions WHERE document_id = ?`, [id]);
        const changed = this.db.run(
          `DELETE FROM knowledge_documents WHERE id = ? AND revision = ? AND archived_at IS NOT NULL`,
          [id, current.revision],
        ).changes;
        if (changed !== 1) throw new KnowledgeError("This note was saved by a newer edit. Reload it and try again.", 409);
        removed = true;
      })();
    } catch (error) {
      throw asKnowledgeError(error);
    }
    if (removed) this.files.removeDocument(id);
  }

  revisions(id: string): KnowledgeRevisionInfo[] {
    this.requireRow(id);
    return this.db.query<RevisionRow, [string]>(
      `SELECT revision, created_at, byte_length, content_sha256
         FROM knowledge_revisions WHERE document_id = ? ORDER BY revision DESC`,
    ).all(id).map((row) => ({
      revision: row.revision,
      createdAt: row.created_at,
      byteLength: row.byte_length,
      sha256: row.content_sha256,
    }));
  }

  search(options: {
    query: string;
    owner?: KnowledgeOwnerRef;
    projectPath?: string;
    includeArchived?: boolean;
    category?: string | null;
    tag?: string | null;
    limit: number;
  }): { hits: KnowledgeSearchHit[]; truncated: boolean } {
    const owners = options.projectPath
      ? this.ownersForProject(options.projectPath)
      : options.owner
        ? [this.requireOwner(options.owner)]
        : null;
    if (!owners) throw new KnowledgeError("Search needs an owner or a registered project.", 400);
    const listed = this.listOwners(owners, {
      includeArchived: options.includeArchived,
      category: options.category,
      tag: options.tag,
      limit: KNOWLEDGE_LIMITS.scan,
    });
    const needle = options.query.toLowerCase();
    const hits: KnowledgeSearchHit[] = [];
    let scannedAll = true;
    for (let index = 0; index < listed.documents.length; index++) {
      const document = listed.documents[index]!;
      const meta = `${document.title}\n${document.description}\n${document.category}\n${document.tags.join(" ")}`.toLowerCase();
      let matched = meta.includes(needle);
      let source = document.description || document.title;
      if (!matched) {
        try {
          source = this.read(document.id).content;
          matched = source.toLowerCase().includes(needle);
        } catch {
          matched = false;
        }
      }
      if (!matched) continue;
      hits.push({ document, snippet: document.sensitive ? null : snippet(source, needle) });
      if (hits.length >= options.limit) {
        scannedAll = index === listed.documents.length - 1 && !listed.truncated;
        break;
      }
    }
    return { hits, truncated: listed.truncated || !scannedAll };
  }

  scope(projectPath: string): KnowledgeScope {
    const project = this.requireProject(projectPath);
    const clusterId = this.clusterIdFor(project.id);
    const cluster = clusterId ? { kind: "cluster" as const, id: clusterId } : null;
    const company: KnowledgeOwnerRef = { kind: "company", id: FORGEORBIT_COMPANY.id };
    const owners = [company, ...(cluster ? [cluster] : []), project];
    return {
      company,
      cluster,
      project,
      documents: this.listOwners(owners, { limit: KNOWLEDGE_LIMITS.listDefault }).documents,
      note: KNOWLEDGE_CONTEXT_NOTE,
    };
  }

  private setArchived(id: string, expectedRevision: number, archived: boolean): void {
    this.db.transaction(() => {
      const row = this.requireRow(id);
      this.assertCurrent(row, expectedRevision);
      if (archived && row.archived_at != null) throw new KnowledgeError("Note is already archived.", 409);
      if (!archived && row.archived_at == null) throw new KnowledgeError("Note is not archived.", 409);
      const changed = this.db.run(
        `UPDATE knowledge_documents SET archived_at = ?, updated_at = ? WHERE id = ? AND revision = ?`,
        [archived ? this.now() : null, this.now(), id, row.revision],
      ).changes;
      if (changed !== 1) throw new KnowledgeError("This note was saved by a newer edit. Reload it and try again.", 409);
    })();
  }

  private listOwners(
    owners: KnowledgeOwnerRef[],
    options: { includeArchived?: boolean; category?: string | null; tag?: string | null; limit?: number },
  ): { documents: KnowledgeDocument[]; truncated: boolean } {
    if (owners.length === 0) return { documents: [], truncated: false };
    const limit = options.limit ?? KNOWLEDGE_LIMITS.listDefault;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const owner of owners) {
      clauses.push("(owner_kind = ? AND owner_id = ?)");
      params.push(owner.kind, owner.id);
    }
    let sql = `SELECT * FROM knowledge_documents WHERE (${clauses.join(" OR ")})`;
    if (!options.includeArchived) sql += " AND archived_at IS NULL";
    if (options.category) {
      sql += " AND category = ?";
      params.push(options.category);
    }
    if (options.tag) {
      sql += " AND EXISTS (SELECT 1 FROM json_each(knowledge_documents.tags_json) WHERE json_each.value = ?)";
      params.push(options.tag);
    }
    sql += " ORDER BY updated_at DESC, id ASC LIMIT ?";
    params.push(limit + 1);
    const rows = this.db.query<DocumentRow, Array<string | number>>(sql).all(...params);
    return { documents: rows.slice(0, limit).map(toDocument), truncated: rows.length > limit };
  }

  private ownersForProject(projectPath: string): KnowledgeOwnerRef[] {
    const project = this.requireProject(projectPath);
    const clusterId = this.clusterIdFor(project.id);
    const owners: KnowledgeOwnerRef[] = [{ kind: "company", id: FORGEORBIT_COMPANY.id }];
    if (clusterId) owners.push({ kind: "cluster", id: clusterId });
    owners.push(project);
    return owners;
  }

  private requireOwner(owner: KnowledgeOwnerRef): KnowledgeOwnerRef {
    if (owner.kind === "company") {
      if (owner.id !== FORGEORBIT_COMPANY.id) throw new KnowledgeError("Invalid owner.", 400);
      return owner;
    }
    if (owner.kind === "cluster") {
      const row = this.db.query<{ id: string }, [string]>(`SELECT id FROM clusters WHERE id = ?`).get(owner.id);
      if (!row) throw new KnowledgeError("Cluster not found.", 404);
      return owner;
    }
    return this.requireProject(owner.id);
  }

  private requireProject(projectPath: string): KnowledgeOwnerRef {
    const row = this.db.query<{ path: string }, [string]>(`SELECT path FROM projects WHERE path = ?`).get(projectPath);
    if (!row) throw new KnowledgeError("Project is not registered.", 404);
    return { kind: "project", id: row.path };
  }

  private clusterIdFor(projectPath: string): string | null {
    const row = this.db.query<{ cluster_id: string }, [string]>(
      `SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ?`,
    ).get(projectPath);
    return row?.cluster_id ?? null;
  }

  private requireRow(id: string): DocumentRow {
    const row = this.db.query<DocumentRow, [string]>(`SELECT * FROM knowledge_documents WHERE id = ?`).get(id);
    if (!row) throw new KnowledgeError("Note not found.", 404);
    return row;
  }

  private requireMeta(id: string): KnowledgeDocument {
    return toDocument(this.requireRow(id));
  }

  private revisionRow(id: string, revision: number): RevisionRow | null {
    return this.db.query<RevisionRow, [string, number]>(
      `SELECT revision, created_at, byte_length, content_sha256 FROM knowledge_revisions WHERE document_id = ? AND revision = ?`,
    ).get(id, revision) ?? null;
  }

  private insertRevision(id: string, revision: number, at: number, stored: { sha256: string; byteLength: number }): void {
    this.db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, ?, ?, ?, ?)`,
      [id, revision, at, stored.byteLength, stored.sha256],
    );
  }

  private assertCurrent(row: DocumentRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new KnowledgeError("This note was saved by a newer edit. Reload it and try again.", 409);
    }
  }

  private prune(id: string): void {
    try {
      const rows = this.db.query<{ revision: number }, [string]>(
        `SELECT revision FROM knowledge_revisions WHERE document_id = ? ORDER BY revision DESC`,
      ).all(id);
      const extra = rows.slice(KNOWLEDGE_LIMITS.revisionsKept);
      if (extra.length === 0) return;
      this.db.transaction(() => {
        for (const row of extra) {
          this.db.run(`DELETE FROM knowledge_revisions WHERE document_id = ? AND revision = ?`, [id, row.revision]);
        }
      }).immediate();
      // Files may outlive rolled-back metadata; committed metadata must
      // never point to a file removed by a failed pruning transaction.
      for (const row of extra) this.files.removeRevision(id, row.revision);
    } catch {
      /* history pruning never hides the current note */
    }
  }
}

function toDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    owner: { kind: row.owner_kind, id: row.owner_id },
    title: row.title,
    description: row.description,
    category: row.category,
    tags: parseTags(row.tags_json),
    sensitive: row.sensitive === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    byteLength: row.byte_length,
    inheritToProjects: row.inherit_to_projects === 1,
  };
}

function parseTags(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
    return value as string[];
  } catch {
    return [];
  }
}

function encode(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function snippet(source: string, needle: string): string {
  const flat = source.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, KNOWLEDGE_LIMITS.snippet);
  const start = Math.max(0, at - 40);
  const slice = flat.slice(start, start + KNOWLEDGE_LIMITS.snippet);
  return `${start > 0 ? "…" : ""}${slice}`;
}

function asKnowledgeError(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  return new KnowledgeError("Knowledge operation failed.", 500);
}
