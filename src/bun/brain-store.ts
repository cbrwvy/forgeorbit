/**
 * Brain index and lifecycle.
 *
 * Markdown under `dataDir/brain/memories` is the readable record.
 * `index.sqlite` in that same directory is the lookup index.
 * A row stays pending until its file hash matches, then becomes committed.
 * Disagreement is reported and left in place. Retrieval serves committed,
 * matching, in-scope rows only.
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Database } from "bun:sqlite";
import { validateProjectPath } from "../shared/clusters/paths.ts";
import {
  BRAIN_BACKUP_LIMITATION,
  BRAIN_INHERITANCE_RULE,
  BRAIN_PROVENANCE_NOTE,
  BRAIN_SCHEMA_VERSION,
  brainCompanyScope,
  brainRecordOrigin,
  containsCredentialMaterial,
  decodeMemoryFile,
  encodeMemoryFile,
  isBrainMemoryId,
  snippetOf,
  type BrainCreateInput,
  type BrainFileHeader,
  type BrainIndexStatus,
  type BrainIntegrityIssue,
  type BrainKind,
  type BrainListQuery,
  type BrainMemory,
  type BrainMemorySummary,
  type BrainProposalProvenance,
  type BrainExtractionProvenance,
  type BrainProvenance,
  type BrainScope,
  type BrainScopeKind,
  type BrainStatusValue,
  type BrainUpdateInput,
} from "../shared/brain/document.ts";
import { BrainError } from "./brain-error.ts";
import { normalizeMemoryContent, normalizeMemoryTitle } from "../shared/brain/proposals.ts";
import {
  ensureEmbeddingsSchema,
  findRelatedMemories,
  getEmbeddingStatus,
  rebuildEmbeddings,
  searchMemories,
  storeEmbedding,
} from "./brain-embeddings.ts";
import type {
  EmbeddingEngineStatus,
  RelatedMemoryItem,
  SearchMode,
  SemanticSearchQuery,
  SemanticSearchResult,
} from "../shared/brain/embeddings.ts";
import {
  copyRevision,
  listMemoryNames,
  openBrainLayout,
  readMemoryFile,
  writeMemoryFile,
  type BrainLayout,
} from "./brain-files.ts";

export interface BrainProjects {
  isRegistered(projectPath: string): boolean;
}

export interface BrainHooks {
  afterPendingInsert?: () => void;
  afterFileWrite?: () => void;
}

export interface BrainCreateResult {
  memory: BrainMemory;
  replayed: boolean;
}

interface MemoryRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  title: string;
  kind: string;
  status: string;
  origin: string;
  provenance_json: string;
  revision: number;
  content_sha256: string;
  byte_length: number;
  body: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  durability: string;
}

const PROVENANCE: BrainProvenance = {
  source: "owner",
  approval: "explicit",
  note: BRAIN_PROVENANCE_NOTE,
};

export const BRAIN_SCHEMA_SQL = `
CREATE TABLE brain_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
CREATE TABLE brain_memories (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'project', 'cluster', 'agent')),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 4096),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'observation')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  origin TEXT NOT NULL CHECK (origin = 'owner'),
  provenance_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 100000),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  durability TEXT NOT NULL CHECK (durability IN ('pending', 'committed'))
);
CREATE INDEX brain_memories_scope
  ON brain_memories(scope_kind, scope_id, status, durability, updated_at DESC);
CREATE TABLE brain_revisions (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, revision),
  FOREIGN KEY (memory_id) REFERENCES brain_memories(id)
);
CREATE TABLE brain_requests (
  request_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface BrainStore {
  create(input: BrainCreateInput): BrainCreateResult;
  /** Owner-approved proposal. Provenance is not owner-authored. */
  createFromProposal(input: BrainCreateInput, provenance: BrainProposalProvenance): BrainCreateResult;
  /** Owner-approved or policy-granted extraction candidate. */
  createFromExtraction(input: BrainCreateInput, provenance: BrainExtractionProvenance): BrainCreateResult;
  /** Read a memory already stored for this request id. Does not insert. */
  recallRequest(requestId: string, input: BrainCreateInput): BrainMemory | null;
  /** Same scope and normalized title, or the same content fingerprint. */
  likelyDuplicate(input: BrainCreateInput): { id: string; title: string } | null;
  list(query: BrainListQuery): { memories: BrainMemorySummary[]; truncated: boolean };
  searchSemantic(query: SemanticSearchQuery): Promise<SemanticSearchResult[]>;
  /** Same retrieval, plus the mode that was actually served. */
  searchReport(query: SemanticSearchQuery): Promise<{ results: SemanticSearchResult[]; mode: SearchMode; total: number }>;
  getEmbeddingStatus(): EmbeddingEngineStatus;
  rebuildEmbeddings(): Promise<{ total: number; embedded: number; failed: number }>;
  findRelated(memoryId: string): RelatedMemoryItem[];
  read(id: string): BrainMemory;
  update(id: string, input: BrainUpdateInput): BrainMemory;
  archive(id: string, expectedRevision: number): BrainMemory;
  rebindProjectScope(oldProjectPath: string, newProjectPath: string): { reboundCount: number; memoryIds: string[] };
  status(): BrainIndexStatus;
  /** Whether a project path is a registered project in this profile. */
  isProjectRegistered(projectPath: string): boolean;
  close(): void;
  readonly db?: Database;
  readonly layout?: BrainLayout;
}

export function brainDirectory(dataDir: string): string {
  return path.join(dataDir, "brain");
}

export function openBrainStore(
  rootDir: string,
  projects: BrainProjects,
  options: { now?: () => number; hooks?: BrainHooks } = {},
): BrainStore {
  const layout = openBrainLayout(rootDir);
  const db = new Database(layout.databasePath, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 2000");
  ensureSchema(db);
  const now = options.now ?? (() => Date.now());
  const hooks = options.hooks ?? {};
  const createWith = (input: BrainCreateInput, provenance: BrainProvenance): BrainCreateResult => {
    if (containsCredentialMaterial(`${input.title}\n${input.content}`)) {
      throw new BrainError("Brain refused text that looks like a secret or credential.", 400, "credential_refused");
    }
    const scope = resolveScope(input.scopeKind, input.projectPath, projects);
    const payloadHash = sha256Text(canonicalPayload(input, scope.id));
    if (input.requestId) {
      const prior = requestRow(db, input.requestId);
      if (prior) {
        if (prior.payload_sha256 !== payloadHash) {
          throw new BrainError("That submission was already used for a different memory.", 409, "duplicate_request");
        }
        return { memory: finishPending(db, layout, prior.memory_id, hooks), replayed: true };
      }
    }
    const id = randomUUID();
    const createdAt = now();
    const hash = sha256Text(input.content);
    const header = headerFrom(id, scope, input.title, input.kind, "active", 1, createdAt, createdAt, null, hash);
    const file = encodeMemoryFile(header, input.content);
    insertPending(db, header, input.content, hash, createdAt, input.requestId ?? null, payloadHash, provenance);
    hooks.afterPendingInsert?.();
    writeMemoryFile(layout, id, file);
    hooks.afterFileWrite?.();
    markCommitted(db, id);
    const createdMemory = readCommitted(db, layout, id);
    void storeEmbedding(db, id, 1, hash, input.title, input.content).catch(() => {});
    return { memory: createdMemory, replayed: false };
  };
  const store: BrainStore = {
    get db() {
      return db;
    },
    get layout() {
      return layout;
    },
    create(input) {
      return createWith(input, PROVENANCE);
    },
    createFromProposal(input, provenance) {
      if (
        provenance.source !== "owner-approved-proposal" ||
        provenance.approval !== "explicit" ||
        provenance.approvedBy !== "owner" ||
        (provenance.proposedBy !== "project-manager" && provenance.proposedBy !== "head-of-pm") ||
        typeof provenance.proposalId !== "string" ||
        provenance.proposalId.length < 8 ||
        typeof provenance.note !== "string" ||
        typeof provenance.editedByOwner !== "boolean"
      ) {
        throw new BrainError("Proposal provenance is incomplete.", 400, "invalid_request");
      }
      return createWith(input, provenance);
    },
    createFromExtraction(input, provenance) {
      if (
        provenance.source !== "automatic-extraction" ||
        (provenance.approval !== "explicit" && provenance.approval !== "policy-granted") ||
        (provenance.approvedBy !== "owner" && provenance.approvedBy !== "policy-engine") ||
        typeof provenance.sourceEventKind !== "string" ||
        !Array.isArray(provenance.sourceRecordIds) ||
        typeof provenance.confidence !== "number"
      ) {
        throw new BrainError("Extraction provenance is incomplete.", 400, "invalid_request");
      }
      return createWith(input, provenance);
    },
    recallRequest(requestId, input) {
      if (!input.requestId || input.requestId !== requestId) {
        throw new BrainError("requestId is required to recall a proposal.", 400, "invalid_request");
      }
      const scope = resolveScope(input.scopeKind, input.projectPath, projects);
      const payloadHash = sha256Text(canonicalPayload(input, scope.id));
      const prior = requestRow(db, requestId);
      if (!prior) return null;
      if (prior.payload_sha256 !== payloadHash) {
        throw new BrainError("That submission was already used for a different memory.", 409, "duplicate_request");
      }
      return finishPending(db, layout, prior.memory_id, hooks);
    },
    likelyDuplicate(input) {
      const scope = resolveScope(input.scopeKind, input.projectPath, projects);
      const wantedTitle = normalizeMemoryTitle(input.title);
      const exact = sha256Text(input.content);
      const normalized = sha256Text(normalizeMemoryContent(input.content));
      const rows = db.query(
        `SELECT id, title, body, content_sha256 FROM brain_memories
         WHERE durability = 'committed' AND status = 'active' AND scope_kind = ? AND scope_id = ?`,
      ).all(scope.kind, scope.id) as { id: string; title: string; body: string; content_sha256: string }[];
      for (const row of rows) {
        if (sha256Text(row.body) !== row.content_sha256) continue;
        const sameTitle = normalizeMemoryTitle(row.title) === wantedTitle;
        const sameBody = row.content_sha256 === exact || sha256Text(normalizeMemoryContent(row.body)) === normalized;
        if (sameTitle || sameBody) return { id: row.id, title: row.title };
      }
      return null;
    },
    list(query) {
      reconcilePending(db, layout);
      const scope = resolveScope(query.scopeKind, query.projectPath, projects);
      const company = brainCompanyScope();
      const needle = query.text.length > 0 ? likeNeedle(query.text) : "";
      const rows = db.query(`
        SELECT * FROM brain_memories
        WHERE durability = 'committed' AND status = ?
          AND (
            (scope_kind = ? AND scope_id = ?)
            OR (? = 1 AND scope_kind = 'company' AND scope_id = ?)
          )
          AND (? = '' OR lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(
        query.status,
        scope.kind,
        scope.id,
        query.inheritCompany ? 1 : 0,
        company.id,
        needle,
        needle,
        needle,
        Math.min(200, Math.max(query.limit + 1, query.limit * 4)),
      ) as MemoryRow[];
      const memories: BrainMemorySummary[] = [];
      for (const row of rows) {
        if (memories.length > query.limit) break;
        const verified = verifyRow(layout, row);
        if (!verified.ok) continue;
        if (!sameScope(row, scope) && !(query.inheritCompany && row.scope_kind === "company" && row.scope_id === company.id)) continue;
        memories.push(toSummary(row, verified.body));
      }
      const truncated = memories.length > query.limit;
      return { memories: memories.slice(0, query.limit), truncated };
    },
    read(id) {
      assertId(id);
      reconcilePending(db, layout);
      return readCommitted(db, layout, id);
    },
    update(id, input) {
      assertId(id);
      const row = mustRow(db, id);
      if (row.durability !== "committed") throw new BrainError("That memory is not ready.", 409, "integrity");
      if (row.status !== "active") throw new BrainError("Archived memories cannot be edited.", 409, "archived");
      if (row.revision !== input.expectedRevision) {
        throw new BrainError("This memory changed. Reload it and try again.", 409, "revision_conflict");
      }
      const verified = verifyRow(layout, row);
      if (!verified.ok) throw integrityError(verified.code);
      const title = input.title ?? row.title;
      const kind = (input.kind ?? row.kind) as BrainKind;
      const content = input.content ?? verified.body;
      if (containsCredentialMaterial(`${title}\n${content}`)) {
        throw new BrainError("Brain refused text that looks like a secret or credential.", 400, "credential_refused");
      }
      const updatedAt = now();
      const revision = row.revision + 1;
      const hash = sha256Text(content);
      const scope = { kind: row.scope_kind as BrainScope["kind"], id: row.scope_id };
      const header = headerFrom(id, scope, title, kind, "active", revision, row.created_at, updatedAt, null, hash);
      const nextFile = encodeMemoryFile(header, content);
      const currentFile = readMemoryFile(layout, id);
      if ("text" in currentFile) copyRevision(layout, id, row.revision, currentFile.text);
      writeMemoryFile(layout, id, nextFile);
      const tx = db.transaction(() => {
        const changed = db.run(
          `UPDATE brain_memories
           SET title = ?, kind = ?, content_sha256 = ?, byte_length = ?, body = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND status = 'active' AND durability = 'committed'`,
          [title, kind, hash, byteLength(content), content, revision, updatedAt, id, row.revision],
        ).changes;
        if (changed !== 1) throw new BrainError("This memory changed. Reload it and try again.", 409, "revision_conflict");
        db.run(
          `INSERT INTO brain_revisions (memory_id, revision, content_sha256, byte_length, title, kind, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
          [id, revision, hash, byteLength(content), title, kind, updatedAt],
        );
      });
      tx();
      const updatedMemory = readCommitted(db, layout, id);
      void storeEmbedding(db, id, revision, hash, title, content).catch(() => {});
      return updatedMemory;
    },
    archive(id, expectedRevision) {
      assertId(id);
      const row = mustRow(db, id);
      if (row.status === "archived") throw new BrainError("This memory is already archived.", 409, "already_archived");
      if (row.durability !== "committed") throw new BrainError("That memory is not ready.", 409, "integrity");
      if (row.revision !== expectedRevision) {
        throw new BrainError("This memory changed. Reload it and try again.", 409, "revision_conflict");
      }
      const verified = verifyRow(layout, row);
      if (!verified.ok) throw integrityError(verified.code);
      const archivedAt = now();
      const revision = row.revision + 1;
      const scope = { kind: row.scope_kind as BrainScope["kind"], id: row.scope_id };
      const header = headerFrom(
        id,
        scope,
        row.title,
        row.kind as BrainKind,
        "archived",
        revision,
        row.created_at,
        archivedAt,
        archivedAt,
        row.content_sha256,
      );
      const currentFile = readMemoryFile(layout, id);
      if ("text" in currentFile) copyRevision(layout, id, row.revision, currentFile.text);
      writeMemoryFile(layout, id, encodeMemoryFile(header, verified.body));
      const tx = db.transaction(() => {
        const changed = db.run(
          `UPDATE brain_memories
           SET status = 'archived', archived_at = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND status = 'active' AND durability = 'committed'`,
          [archivedAt, revision, archivedAt, id, row.revision],
        ).changes;
        if (changed !== 1) throw new BrainError("This memory changed. Reload it and try again.", 409, "revision_conflict");
        db.run(
          `INSERT INTO brain_revisions (memory_id, revision, content_sha256, byte_length, title, kind, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'archived', ?)`,
          [id, revision, row.content_sha256, row.byte_length, row.title, row.kind, archivedAt],
        );
      });
      tx();
      return readCommitted(db, layout, id);
    },
    rebindProjectScope(oldProjectPath, newProjectPath) {
      if (oldProjectPath === newProjectPath) {
        return { reboundCount: 0, memoryIds: [] };
      }
      reconcilePending(db, layout);
      const rows = db.query(
        "SELECT * FROM brain_memories WHERE scope_kind = 'project' AND scope_id = ?",
      ).all(oldProjectPath) as MemoryRow[];
      const memoryIds: string[] = [];
      for (const row of rows) {
        const file = readMemoryFile(layout, row.id);
        if ("text" in file) {
          const decoded = decodeMemoryFile(file.text);
          if (decoded.ok) {
            const nextHeader = {
              ...decoded.header,
              scopeId: newProjectPath,
            };
            const nextText = encodeMemoryFile(nextHeader, decoded.body);
            writeMemoryFile(layout, row.id, nextText);
          }
        }
        memoryIds.push(row.id);
      }
      if (memoryIds.length > 0) {
        const tx = db.transaction(() => {
          db.run(
            "UPDATE brain_memories SET scope_id = ? WHERE scope_kind = 'project' AND scope_id = ?",
            [newProjectPath, oldProjectPath],
          );
        });
        tx();
      }
      return { reboundCount: memoryIds.length, memoryIds };
    },
    status() {
      reconcilePending(db, layout);
      const issues: BrainIntegrityIssue[] = [];
      const rows = db.query("SELECT * FROM brain_memories").all() as MemoryRow[];
      const indexed = new Set<string>();
      let active = 0;
      let archived = 0;
      let pending = 0;
      const orphanCounts = new Map<string, number>();
      for (const row of rows) {
        indexed.add(row.id);
        if (row.durability === "pending") {
          pending += 1;
          const verified = verifyRow(layout, row);
          issues.push(verified.ok
            ? { memoryId: row.id, code: "pending_missing_file", detail: "Pending row still has a matching file and was not promoted." }
            : { memoryId: row.id, code: verified.code === "missing_file" ? "pending_missing_file" : verified.code, detail: "Pending memory was retained and is excluded from retrieval." });
          continue;
        }
        if (row.status === "active") active += 1;
        if (row.status === "archived") archived += 1;
        const verified = verifyRow(layout, row);
        if (!verified.ok) {
          issues.push({ memoryId: row.id, code: verified.code, detail: "Index row retained. Retrieval will not substitute another memory." });
        }
        if (row.scope_kind === "project" && !projects.isRegistered(row.scope_id)) {
          orphanCounts.set(row.scope_id, (orphanCounts.get(row.scope_id) ?? 0) + 1);
        }
      }
      for (const [scopeId, count] of orphanCounts) {
        issues.push({
          memoryId: null,
          code: "orphaned_project",
          detail: `${count} memory record(s) remain bound to ${scopeId} and are not attached to another project.`,
        });
      }
      let names: string[] = [];
      try {
        names = listMemoryNames(layout);
      } catch (error) {
        if (error instanceof BrainError) {
          issues.push({ memoryId: null, code: "path_rejected", detail: error.message });
        } else {
          throw error;
        }
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        if (!name.endsWith(".md")) {
          issues.push({ memoryId: null, code: "unexpected_file", detail: `Unexpected file ${name} was left in place.` });
          continue;
        }
        const id = name.slice(0, -3);
        if (!isBrainMemoryId(id)) {
          issues.push({ memoryId: null, code: "unexpected_file", detail: `Unexpected file ${name} was left in place.` });
          continue;
        }
        if (!indexed.has(id)) {
          issues.push({ memoryId: id, code: "unindexed_file", detail: "File has no index row and was not activated." });
        }
      }
      return {
        schemaVersion: BRAIN_SCHEMA_VERSION,
        counts: { active, archived, pending, issues: issues.length },
        issues,
        orphanedProjects: [...orphanCounts].map(([scopeId, count]) => ({ scopeId, count })),
        backup: { includedInProfileSnapshot: true, limitation: BRAIN_BACKUP_LIMITATION },
        retrieval: {
          defaultStatus: "active",
          companyInheritance: "opt-in",
          role: "data",
          rule: BRAIN_INHERITANCE_RULE,
        },
      };
    },
    async searchSemantic(query) {
      const report = await this.searchReport(query);
      return report.results;
    },
    async searchReport(query) {
      reconcilePending(db, layout);
      return searchMemories(db, query);
    },
    getEmbeddingStatus() {
      return getEmbeddingStatus(db);
    },
    async rebuildEmbeddings() {
      reconcilePending(db, layout);
      return rebuildEmbeddings(db);
    },
    findRelated(memoryId) {
      assertId(memoryId);
      const row = mustRow(db, memoryId);
      return findRelatedMemories(db, memoryId, row.scope_kind as BrainScopeKind, row.scope_id);
    },
    isProjectRegistered(projectPath) {
      return projects.isRegistered(projectPath);
    },
    close() {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
  reconcilePending(db, layout);
  return store;
}

function ensureSchema(db: Database): void {
  const existing = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brain_schema'").get() as { name: string } | null;
  if (!existing) {
    const tx = db.transaction(() => {
      db.exec(BRAIN_SCHEMA_SQL);
      db.run("INSERT INTO brain_schema (id, version) VALUES (1, ?)", [BRAIN_SCHEMA_VERSION]);
    });
    tx();
    ensureEmbeddingsSchema(db);
    return;
  }
  const row = db.query("SELECT version FROM brain_schema WHERE id = 1").get() as { version: number } | null;
  if (!row || row.version !== BRAIN_SCHEMA_VERSION) {
    throw new BrainError("Unsupported brain schema.", 500, "schema");
  }
  ensureEmbeddingsSchema(db);
}

function resolveScope(kind: BrainCreateInput["scopeKind"], projectPath: string | undefined, projects: BrainProjects): BrainScope {
  if (kind === "company") return brainCompanyScope();
  const parsed = validateProjectPath(projectPath);
  if (!parsed.ok) throw new BrainError(parsed.error, 400, "invalid_project");
  if (!projects.isRegistered(parsed.path)) {
    throw new BrainError("Project is not registered.", 404, "project_not_registered");
  }
  return { kind: "project", id: parsed.path };
}

function requestRow(db: Database, requestId: string): { memory_id: string; payload_sha256: string } | null {
  return db.query("SELECT memory_id, payload_sha256 FROM brain_requests WHERE request_id = ?")
    .get(requestId) as { memory_id: string; payload_sha256: string } | null;
}

function insertPending(
  db: Database,
  header: BrainFileHeader,
  body: string,
  hash: string,
  createdAt: number,
  requestId: string | null,
  payloadHash: string,
  provenance: BrainProvenance,
): void {
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO brain_memories (
        id, scope_kind, scope_id, title, kind, status, origin, provenance_json, revision,
        content_sha256, byte_length, body, created_at, updated_at, archived_at, durability
      ) VALUES (?, ?, ?, ?, ?, 'active', 'owner', ?, 1, ?, ?, ?, ?, ?, NULL, 'pending')`,
      [
        header.id,
        header.scopeKind,
        header.scopeId,
        header.title,
        header.kind,
        JSON.stringify(provenance),
        hash,
        byteLength(body),
        body,
        createdAt,
        createdAt,
      ],
    );
    db.run(
      `INSERT INTO brain_revisions (memory_id, revision, content_sha256, byte_length, title, kind, status, created_at)
       VALUES (?, 1, ?, ?, ?, ?, 'active', ?)`,
      [header.id, hash, byteLength(body), header.title, header.kind, createdAt],
    );
    if (requestId) {
      db.run(
        "INSERT INTO brain_requests (request_id, memory_id, payload_sha256, created_at) VALUES (?, ?, ?, ?)",
        [requestId, header.id, payloadHash, createdAt],
      );
    }
  });
  try {
    tx();
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) {
      throw new BrainError("Duplicate memory id.", 409, "duplicate_id");
    }
    throw error;
  }
}

function markCommitted(db: Database, id: string): void {
  const changed = db.run(
    "UPDATE brain_memories SET durability = 'committed' WHERE id = ? AND durability = 'pending'",
    [id],
  ).changes;
  if (changed !== 1) throw new BrainError("That memory is not ready.", 409, "integrity");
}

function finishPending(db: Database, layout: BrainLayout, id: string, hooks: BrainHooks): BrainMemory {
  const row = mustRow(db, id);
  if (row.durability === "committed") return readCommitted(db, layout, id);
  const header = headerFromRow(row);
  const file = encodeMemoryFile(header, row.body);
  const current = readMemoryFile(layout, id);
  if ("rejected" in current) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  if ("missing" in current) {
    hooks.afterPendingInsert?.();
    writeMemoryFile(layout, id, file);
    hooks.afterFileWrite?.();
  }
  const verified = verifyRow(layout, row);
  if (!verified.ok) throw integrityError(verified.code);
  markCommitted(db, id);
  return readCommitted(db, layout, id);
}

function reconcilePending(db: Database, layout: BrainLayout): void {
  const rows = db.query("SELECT * FROM brain_memories WHERE durability = 'pending'").all() as MemoryRow[];
  for (const row of rows) {
    const verified = verifyRow(layout, row);
    if (verified.ok) markCommitted(db, row.id);
  }
}

function readCommitted(db: Database, layout: BrainLayout, id: string): BrainMemory {
  const row = mustRow(db, id);
  if (row.durability !== "committed") throw new BrainError("That memory is not ready.", 409, "integrity");
  if (row.scope_kind !== "company" && row.scope_kind !== "project") {
    throw new BrainError("That scope is not available.", 409, "scope_unavailable");
  }
  const verified = verifyRow(layout, row);
  if (!verified.ok) throw integrityError(verified.code);
  return toMemory(row, verified.body);
}

function verifyRow(layout: BrainLayout, row: MemoryRow): { ok: true; body: string } | { ok: false; code: BrainIntegrityIssue["code"] } {
  const file = readMemoryFile(layout, row.id);
  if ("missing" in file) return { ok: false, code: "missing_file" };
  if ("rejected" in file) return { ok: false, code: "path_rejected" };
  const decoded = decodeMemoryFile(file.text);
  if (!decoded.ok) return { ok: false, code: "metadata_mismatch" };
  const header = decoded.header;
  const hash = sha256Text(decoded.body);
  if (hash !== header.contentSha256 || hash !== row.content_sha256 || decoded.body !== row.body) {
    return { ok: false, code: "content_mismatch" };
  }
  if (
    header.id !== row.id ||
    header.scopeKind !== row.scope_kind ||
    header.scopeId !== row.scope_id ||
    header.kind !== row.kind ||
    header.status !== row.status ||
    header.revision !== row.revision ||
    header.title !== row.title ||
    header.createdAt !== row.created_at ||
    header.updatedAt !== row.updated_at ||
    header.archivedAt !== (row.archived_at ?? null)
  ) {
    return { ok: false, code: "metadata_mismatch" };
  }
  return { ok: true, body: decoded.body };
}

function mustRow(db: Database, id: string): MemoryRow {
  const row = db.query("SELECT * FROM brain_memories WHERE id = ?").get(id) as MemoryRow | null;
  if (!row) throw new BrainError("That memory was not found.", 404, "not_found");
  return row;
}

function headerFrom(
  id: string,
  scope: BrainScope,
  title: string,
  kind: BrainKind,
  status: BrainStatusValue,
  revision: number,
  createdAt: number,
  updatedAt: number,
  archivedAt: number | null,
  contentSha256: string,
): BrainFileHeader {
  return {
    id,
    scopeKind: scope.kind,
    scopeId: scope.id,
    kind,
    status,
    origin: "owner",
    revision,
    createdAt,
    updatedAt,
    archivedAt,
    contentSha256,
    title,
  };
}

function headerFromRow(row: MemoryRow): BrainFileHeader {
  return headerFrom(
    row.id,
    { kind: row.scope_kind as BrainScope["kind"], id: row.scope_id },
    row.title,
    row.kind as BrainKind,
    row.status as BrainStatusValue,
    row.revision,
    row.created_at,
    row.updated_at,
    row.archived_at,
    row.content_sha256,
  );
}

function toMemory(row: MemoryRow, content: string): BrainMemory {
  const summary = toSummary(row, content);
  return {
    id: summary.id,
    scope: summary.scope,
    title: summary.title,
    kind: summary.kind,
    status: summary.status,
    origin: summary.origin,
    provenance: summary.provenance,
    revision: summary.revision,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archivedAt: summary.archivedAt,
    contentSha256: summary.contentSha256,
    byteLength: summary.byteLength,
    content,
    role: "data",
    executable: false,
    overridesRules: false,
  };
}

function toSummary(row: MemoryRow, content: string): BrainMemorySummary {
  const provenance = parseProvenance(row.provenance_json);
  return {
    id: row.id,
    scope: { kind: row.scope_kind as BrainScope["kind"], id: row.scope_id },
    title: row.title,
    kind: row.kind as BrainKind,
    status: row.status as BrainStatusValue,
    origin: brainRecordOrigin(provenance),
    provenance,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    contentSha256: row.content_sha256,
    byteLength: row.byte_length,
    snippet: snippetOf(content),
    role: "data",
    executable: false,
    overridesRules: false,
  };
}

function parseProvenance(json: string): BrainProvenance {
  try {
    const value = JSON.parse(json) as BrainProvenance;
    if (value?.source === "owner" && value.approval === "explicit" && typeof value.note === "string") return value;
    if (
      value?.source === "owner-approved-proposal" &&
      value.approval === "explicit" &&
      value.approvedBy === "owner" &&
      (value.proposedBy === "project-manager" || value.proposedBy === "head-of-pm") &&
      typeof value.proposalId === "string" &&
      typeof value.note === "string" &&
      typeof value.editedByOwner === "boolean" &&
      (value.claim === "owner-stated" || value.claim === "observation" || value.claim === "hypothesis")
    ) {
      return value;
    }
    if (
      value?.source === "automatic-extraction" &&
      (value.approval === "explicit" || value.approval === "policy-granted") &&
      (value.approvedBy === "owner" || value.approvedBy === "policy-engine") &&
      typeof value.sourceEventKind === "string" &&
      Array.isArray(value.sourceRecordIds) &&
      typeof value.note === "string"
    ) {
      return value;
    }
  } catch {
    /* fall through */
  }
  return PROVENANCE;
}

function sameScope(row: MemoryRow, scope: BrainScope): boolean {
  return row.scope_kind === scope.kind && row.scope_id === scope.id;
}

function integrityError(code: BrainIntegrityIssue["code"]): BrainError {
  if (code === "missing_file") {
    return new BrainError("The memory file is missing. The index row was kept and the memory was not replaced.", 409, "missing_file");
  }
  if (code === "content_mismatch") {
    return new BrainError("The memory file does not match its index. It was left in place and excluded from retrieval.", 409, "content_mismatch");
  }
  if (code === "path_rejected") return new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  return new BrainError("The memory file metadata does not match its index. It was not moved to another scope.", 409, "metadata_mismatch");
}

function assertId(id: string): void {
  if (!isBrainMemoryId(id)) throw new BrainError("Invalid memory id.", 400, "invalid_request");
}

function canonicalPayload(input: BrainCreateInput, scopeId: string): string {
  return JSON.stringify({
    scopeKind: input.scopeKind,
    scopeId,
    title: input.title,
    kind: input.kind,
    content: input.content,
  });
}

function likeNeedle(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
