/**
 * Reliable Backup Manager and Snapshot Packaging (FO-P2-002).
 *
 * Coordinates the creation, packaging, and cryptographic verification of
 * portable ForgeOrbit persistent application data snapshots.
 *
 * ## Snapshot Directory Structure
 *
 * ```
 * <snapshot-dir>/
 * ├── manifest.json       <-- Snapshot metadata, versions, and file checksums
 * ├── database.sqlite     <-- Verified, point-in-time SQLite snapshot (via BackupCore)
 * └── knowledge/          <-- Revision-pinned Markdown notes required by the DB
 *     └── bodies/
 *         └── <document-id>/
 *             └── <revision>.md
 * ```
 *
 * ## Consistency & Security Guarantees
 *
 * 1. Database-Knowledge Consistency:
 *    Instead of blindly copying a live mutating directory, the manager inspects
 *    the newly snapshotted `database.sqlite` for all referenced revisions in
 *    `knowledge_revisions`. Each immutable revision file is individually checked
 *    for existence, size, and SHA-256 match before inclusion. If any required
 *    file is missing or modified, the snapshot fails immediately and rolls back.
 * 2. Atomic Staging & Publication:
 *    All components are written into a hidden staging directory
 *    (`.<name>.<uuid>.tmp`) within the parent directory. The snapshot is
 *    published via `renameSync` only after all files and the manifest pass
 *    complete verification.
 * 3. Overwrite & Collision Prevention:
 *    Refuses to overwrite an existing snapshot directory. Prevents race
 *    conditions during publication.
 * 4. Staging Cleanup:
 *    Failed or interrupted snapshot operations clean up their staging directory
 *    completely. `cleanIncompleteSnapshots()` safely cleans orphaned staging dirs.
 * 5. Symlink & Path Traversal Defense:
 *    Rejects symbolic links and path traversal patterns (`..`, null bytes) across
 *    all target paths and intermediate subdirectories.
 * 6. Non-Blocking Event-Loop Cooperative Yielding:
 *    Yields between major phases via `setImmediate` and brackets synchronous
 *    SQLite operations with `beginLagLabel`.
 *
 * ## Event-Loop & Concurrency Notes
 *
 * NOTE: While `createSnapshot` and `verifySnapshot` are declared async, SQLite
 * operations (`VACUUM INTO`, `PRAGMA integrity_check`, and metadata queries) execute
 * synchronously on Bun's main thread. Cooperative `setImmediate` yields occur between
 * phases, but active SQLite page operations will briefly stall the event loop for
 * very large databases.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  BackupCore,
  isSqliteAuxiliaryOrSamePath,
  MAX_MANIFEST_SIZE_BYTES,
  publishDirectoryExclusive,
  type BackupResult,
  type BackupFs,
  type StagingOwnershipMetadata,
  type StagingState,
  pathExistsOrSymlink,
  syncFile,
  syncDirectory,
  writeStagingOwnershipMetadata,
  cleanSubsystemStaging,
  SNAPSHOT_STAGING_SCAN_RE,
  STAGING_LOCK_FILENAME,
  tryAcquireFlock,
  releaseFlock,
} from "./backup-core.ts";
import { resolveDataDir } from "./data-dir.ts";
import { beginLagLabel } from "./event-loop-lag.ts";
import { migrations } from "./migrations/index.ts";
import { BrainSnapshotError, captureBrainSnapshot, verifyPackagedBrain } from "./brain-snapshot.ts";
import { parseBrainSnapshotPath, type SnapshotBrainRecord } from "../shared/brain/snapshot.ts";

export function sha256Hex(buf: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Set of all known canonical migration IDs and historical aliases. */
export const SUPPORTED_SCHEMA_VERSIONS = new Set<string>();
for (const m of migrations) {
  SUPPORTED_SCHEMA_VERSIONS.add(m.id);
  if (m.aliases) {
    for (const alias of m.aliases) {
      SUPPORTED_SCHEMA_VERSIONS.add(alias);
    }
  }
}

/** Check if a schema version string is supported by the current application codebase. */
export function isSupportedSchemaVersion(version: string | null): boolean {
  if (version === null) return true; // Unmigrated or blank SQLite database is supported
  return SUPPORTED_SCHEMA_VERSIONS.has(version);
}

/** Document ID regex matching standard UUID v4 format. */
export const KNOWLEDGE_DOCUMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict Knowledge file path regex matching `knowledge/bodies/<uuid>/<revision>.md` layout. */
export const KNOWLEDGE_FILE_PATH_RE = /^knowledge\/bodies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([1-9][0-9]*)\.md$/i;

/** Allowed relative path regexes for durable application profile assets. */
export const ATTACHMENT_FILE_PATH_RE = /^attachments\/([^/\\\0]+)$/;
export const SCREENSHOT_FILE_PATH_RE = /^screenshots\/([^/\\\0]+)$/;
export const ISSUE_THREAD_FILE_PATH_RE = /^issue-threads\/([^/\\\0]+)\/([^/\\\0]+)$/;
export const PIPELINE_RUN_FILE_PATH_RE = /^pipeline-runs\/([^/\\\0]+)\/([^/\\\0]+)$/;

export type SnapshotAssetCategory =
  | "database"
  | "knowledge"
  | "attachment"
  | "screenshot"
  | "issue-thread"
  | "pipeline-run"
  | "brain";

export type SnapshotCoverage = "complete-profile" | "legacy-database-knowledge";

export const SNAPSHOT_MANDATORY_CATEGORIES: readonly SnapshotAssetCategory[] = [
  "database",
  "knowledge",
  "attachment",
  "screenshot",
  "issue-thread",
  "pipeline-run",
] as const;

export interface ParsedKnowledgePath {
  ok: true;
  documentId: string;
  revision: number;
  normalizedPath: string;
}

export function parseKnowledgeFilePath(filePath: string): ParsedKnowledgePath | { ok: false } {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    return { ok: false };
  }
  const normalized = filePath.replaceAll("\\", "/");
  const match = KNOWLEDGE_FILE_PATH_RE.exec(normalized);
  if (!match) return { ok: false };
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false };
  return {
    ok: true,
    documentId: match[1]!,
    revision,
    normalizedPath: `knowledge/bodies/${match[1]!}/${revision}.md`,
  };
}

export function parseSnapshotAssetPath(
  filePath: string,
): { ok: true; category: SnapshotAssetCategory; normalizedPath: string } | { ok: false; reason: string } {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    return { ok: false, reason: "Empty or invalid path string." };
  }
  if (path.isAbsolute(filePath)) {
    return { ok: false, reason: "Absolute paths are not permitted in snapshots." };
  }
  const normalized = filePath.replaceAll("\\", "/");
  if (
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized === ".."
  ) {
    return { ok: false, reason: "Path traversal detected." };
  }

  if (normalized === "database.sqlite") {
    return { ok: true, category: "database", normalizedPath: "database.sqlite" };
  }

  const knowledgeParsed = parseKnowledgeFilePath(normalized);
  if (knowledgeParsed.ok) {
    return { ok: true, category: "knowledge", normalizedPath: knowledgeParsed.normalizedPath };
  }

  const attMatch = ATTACHMENT_FILE_PATH_RE.exec(normalized);
  if (attMatch) {
    const filename = attMatch[1]!;
    if (filename.startsWith(".") || filename === "." || filename === "..") {
      return { ok: false, reason: `Disallowed hidden or dotfile attachment name: ${filename}` };
    }
    return { ok: true, category: "attachment", normalizedPath: `attachments/${filename}` };
  }

  const scrMatch = SCREENSHOT_FILE_PATH_RE.exec(normalized);
  if (scrMatch) {
    const filename = scrMatch[1]!;
    if (filename.startsWith(".") || filename === "." || filename === "..") {
      return { ok: false, reason: `Disallowed hidden or dotfile screenshot name: ${filename}` };
    }
    return { ok: true, category: "screenshot", normalizedPath: `screenshots/${filename}` };
  }

  const issMatch = ISSUE_THREAD_FILE_PATH_RE.exec(normalized);
  if (issMatch) {
    const taskId = issMatch[1]!;
    const filename = issMatch[2]!;
    if (taskId.startsWith(".") || taskId === "." || taskId === ".." || filename.startsWith(".") || filename === "." || filename === "..") {
      return { ok: false, reason: `Disallowed hidden or dotfile in issue-thread path: ${normalized}` };
    }
    return { ok: true, category: "issue-thread", normalizedPath: `issue-threads/${taskId}/${filename}` };
  }

  const pipeMatch = PIPELINE_RUN_FILE_PATH_RE.exec(normalized);
  if (pipeMatch) {
    const parentId = pipeMatch[1]!;
    const filename = pipeMatch[2]!;
    if (parentId.startsWith(".") || parentId === "." || parentId === ".." || filename.startsWith(".") || filename === "." || filename === "..") {
      return { ok: false, reason: `Disallowed hidden or dotfile in pipeline-run path: ${normalized}` };
    }
    if (!filename.endsWith(".json")) {
      return { ok: false, reason: `Pipeline run files must be JSON handoff files: ${normalized}` };
    }
    return { ok: true, category: "pipeline-run", normalizedPath: `pipeline-runs/${parentId}/${filename}` };
  }

  const brainParsed = parseBrainSnapshotPath(normalized);
  if (brainParsed.ok) {
    return { ok: true, category: "brain", normalizedPath: brainParsed.normalizedPath };
  }

  return { ok: false, reason: `File path does not match any allowlisted snapshot category: ${normalized}` };
}

export type BackupManagerErrorCode =
  | "TARGET_EXISTS"
  | "INVALID_PATH"
  | "SAME_AS_SOURCE"
  | "DIRECTORY_NOT_FOUND"
  | "INCONSISTENT_KNOWLEDGE"
  | "INCONSISTENT_BRAIN"
  | "INCONSISTENT_ASSET"
  | "UNTRUSTED_SYMLINK"
  | "VERIFICATION_FAILED"
  | "PREVIEW_FAILED"
  | "SQLITE_ERROR"
  | "CORRUPT_MANIFEST"
  | "CANCELLED"
  | "UNSUPPORTED_REFERENCE_FORMAT"
  | "UNRESOLVED_CROSS_PROFILE_REFERENCE"
  | "IO_ERROR";

export class BackupManagerError extends Error {
  constructor(
    message: string,
    readonly code: BackupManagerErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BackupManagerError";
  }
}

export interface SnapshotManifestFile {
  /** Relative POSIX path within the snapshot directory. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** Hex-encoded SHA-256 digest. */
  sha256: string;
  /** Asset category classification. */
  category?: SnapshotAssetCategory;
}

export interface SnapshotManifestStats {
  totalBytes: number;
  fileCount: number;
  knowledgeDocumentCount: number;
  knowledgeRevisionCount: number;
  attachmentCount?: number;
  screenshotCount?: number;
  issueThreadCount?: number;
  pipelineRunCount?: number;
}

export interface SnapshotOriginMetadata {
  /** SHA-256 hash of the normalized source profile root directory path */
  sourceProfileRootSha256: string;
  /** Basename of the source profile directory (e.g. "ForgeOrbit") without exposing parent paths or usernames */
  sourceProfileBasename: string;
  /** Secondary hash for canonical resolved symlinks on macOS (/var vs /private/var) */
  sourceProfileRealSha256?: string;
  /** Additional hashes for legitimate multiple symlink aliases */
  sourceProfileAliasSha256s?: string[];
}

export interface SnapshotReferenceEntry {
  /** Database table containing the reference (defaults to "tasks") */
  table?: string;
  /** Stable record primary key identifier (e.g. taskId) */
  recordId?: string;
  /** Primary key column name (defaults to "id") */
  recordIdColumn?: string;
  /** Database column name where this reference appeared (alias for sourceField) */
  column?: string;
  /** Canonical relative path inside the snapshot (e.g. "attachments/sample.pdf") */
  canonicalPath: string;
  /** Asset category */
  category: SnapshotAssetCategory;
  /** Task ID that owns or references this asset (backward compatibility alias for recordId) */
  taskId?: string;
  /** The database field where this reference appeared: "refs" | "attachments" | "sent_files" | "draft" | "backlog" */
  sourceField: "refs" | "attachments" | "sent_files" | "draft" | "backlog" | string;
  /** Reference format in SQLite database: "canonical-relative" or "profile-absolute" */
  refType: "canonical-relative" | "profile-absolute";
  /** Exact occurrence index inside a structured array (0-based) */
  itemIndex?: number;
  /** JSON path to the reference within the structured field (e.g. "$[0].path" or "$[0]") */
  jsonPath?: string;
  /** Relative subpath within the source profile (e.g. "attachments/sample.pdf") */
  relSubpath?: string;
  /** SHA-256 of the exact original raw reference string as stored in SQLite */
  rawRefSha256?: string;
  /** Expected original raw string value or digest */
  expectedOriginalValue?: string;
}

export interface SnapshotManifest {
  manifestVersion: 1 | 2 | 3 | 4;
  snapshotId: string;
  appVersion: string | null;
  schemaVersion: string | null;
  createdAt: number;
  verified: boolean;
  coverage?: SnapshotCoverage;
  categories?: SnapshotAssetCategory[];
  files: SnapshotManifestFile[];
  stats: SnapshotManifestStats;
  origin?: SnapshotOriginMetadata;
  internalReferences?: SnapshotReferenceEntry[];
  /** Caller-supplied metadata (e.g. runnerOperationId) */
  metadata?: Record<string, unknown>;
  /**
   * Present on manifest v4 snapshots created after Brain backup integration.
   * Older v4 snapshots omit it. Restoring those does not invent or erase Brain.
   */
  brain?: SnapshotBrainRecord;
}

export interface SnapshotResult {
  /** Canonical resolved absolute path to the published snapshot directory. */
  path: string;
  /** Unique identifier for the snapshot. */
  snapshotId: string;
  /** Verified manifest contents. */
  manifest: SnapshotManifest;
  /** Wall-clock duration of the snapshot creation in milliseconds. */
  durationMs: number;
}

export interface SnapshotVerificationResult {
  ok: boolean;
  snapshotId?: string;
  appVersion?: string | null;
  schemaVersion?: string | null;
  createdAt?: number;
  manifestVersion?: 1 | 2 | 3 | 4;
  coverage?: SnapshotCoverage;
  categories?: SnapshotAssetCategory[];
  filesChecked: number;
  totalBytes: number;
  issues: string[];
  /** Validated in-memory manifest if verification succeeded. */
  manifest?: SnapshotManifest;
  origin?: SnapshotOriginMetadata;
  /**
   * Digest binding this verification to the exact manifest bytes and the
   * ACTUAL content hashes of every packaged file. Computed only when the
   * verification passed. A caller that later re-verifies and gets a different
   * identity knows the snapshot's logical content changed, even at the same
   * path.
   */
  contentIdentity?: string;
}

export interface BackupManagerOptions {
  /** Source SQLite database to snapshot. */
  db: Database;
  /** Root application data directory. Must be explicitly specified or derived from db path. Never falls back to active profile. */
  dataDir?: string;
  /** Root directory for knowledge files (defaults to path.join(dataDir, "knowledge")). */
  knowledgeRootDir?: string;
  /** Root directory for attachment files (defaults to path.join(dataDir, "attachments")). */
  attachmentsRootDir?: string;
  /** Root directory for screenshot files (defaults to path.join(dataDir, "screenshots")). */
  screenshotsRootDir?: string;
  /** Root directory for issue-thread snapshot files (defaults to path.join(dataDir, "issue-threads")). */
  issueThreadsRootDir?: string;
  /** Root directory for pipeline-run handoff files (defaults to path.join(dataDir, "pipeline-runs")). */
  pipelineRunsRootDir?: string;
  /** Application version override (defaults to package.json version). */
  appVersion?: string | null;
  /** Clock source for timestamping (ms). Defaults to Date.now. */
  now?: () => number;
  /** BackupCore instance or factory. */
  backupCore?: BackupCore;
}

export interface CreateSnapshotOptions {
  /** Explicit directory path for the snapshot. */
  destinationPath?: string;
  /** Target parent directory where a timestamped snapshot folder will be created if destinationPath is omitted. */
  destinationDir?: string;
  /** Desired manifest format version: 4 (portable canonical-relative), 3 (origin metadata), 2 (v2) or 1 (legacy). Defaults to 4. */
  manifestVersion?: 1 | 2 | 3 | 4;
  /** If true, requires all references to resolve completely within the profile and fails if cross-profile or missing references exist. */
  requireCompleteProfile?: boolean;
  /** If true, creates missing parent directories with mode 0o700. Defaults to false. */
  createDirectory?: boolean;
  /** Maximum retry attempts if concurrent knowledge pruning or updates race with snapshotting (defaults to 2). */
  maxRetries?: number;
  /** Optional custom directory publisher for testing atomic directory publication. */
  publishDir?: (stagingDir: string, destDir: string) => void;
  /** Test hook: invoked when snapshot generation retries due to concurrent knowledge mutation. */
  onRetry?: (attempt: number, error: Error) => void;
  /** Test hook: invoked when private staging directory is prepared before SQLite snapshot executes. */
  onStagingPrepared?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after SQLite database backup is completed in staging, before knowledge copying. */
  afterDatabaseBackup?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after knowledge files are copied into staging, before manifest is written. */
  afterKnowledgeCopy?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked before an individual asset file is copied into staging. */
  beforeAssetCopy?: (relPath: string, sourcePath: string) => void | Promise<void>;
  /** Test hook: invoked after an asset is copied to staging but before TOCTOU verification against source. */
  duringAssetCopy?: (relPath: string, sourcePath: string, targetPath: string) => void | Promise<void>;
  /** Test hook: invoked after all assets are copied into staging, before manifest is written. */
  afterAssetsCopy?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after manifest is written, before integrity verification. */
  afterManifestWrite?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after verification succeeds, before atomic publication. */
  beforePublish?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after atomic publication and directory durability sync succeed. */
  afterPublish?: (destinationPath: string) => void | Promise<void>;
  /** Runner operation ID associating this operation with parent process supervisor. */
  runnerOperationId?: string;
  /** Optional caller metadata to embed into manifest (e.g. runnerOperationId) */
  manifestMetadata?: Record<string, unknown>;
  /** Optional filesystem operations for dependency injection and testing publication failures. */
  fs?: BackupFs;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGING_DIR_PREFIX_RE = /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

function computeFileSha256(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(resolved);
  } catch (err) {
    return Promise.reject(
      new BackupManagerError(
        `Failed to stat ${resolved}: ${(err as Error).message}`,
        "IO_ERROR",
        err,
      ),
    );
  }
  if (st.isSymbolicLink()) {
    return Promise.reject(
      new BackupManagerError(
        `Untrusted symbolic link detected: ${resolved}`,
        "UNTRUSTED_SYMLINK",
      ),
    );
  }
  if (!st.isFile()) {
    return Promise.reject(
      new BackupManagerError(
        `Entry is not a regular file: ${resolved}`,
        "IO_ERROR",
      ),
    );
  }

  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) =>
      reject(
        new BackupManagerError(
          `Failed to compute checksum for ${resolved}: ${err.message}`,
          "IO_ERROR",
          err,
        ),
      ),
    );
  });
}

export function getDatabaseSchemaVersion(dbOrPath: Database | string): string | null {
  let db: Database;
  let shouldClose = false;
  if (typeof dbOrPath === "string") {
    db = new Database(dbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = dbOrPath;
  }
  try {
    const tableExists = db
      .query<{ count: number }, []>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='_migrations';",
      )
      .get()?.count;
    if (!tableExists) return null;
    const latest = db
      .query<{ id: string }, []>(
        "SELECT id FROM _migrations ORDER BY rowid DESC LIMIT 1;",
      )
      .get();
    return latest?.id ?? null;
  } catch (err) {
    if (err instanceof BackupManagerError) throw err;
    throw new BackupManagerError(
      `Failed to query database schema version: ${(err as Error).message}`,
      "SQLITE_ERROR",
      err,
    );
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore close error */
      }
    }
  }
}

/** Name of the SQLite table used to record the snapshot's manifest format version. */
export const SNAPSHOT_FORMAT_MARKER_TABLE = "forgeorbit_snapshot_format";

/**
 * Persist the snapshot-format version into the staged SQLite database.
 *
 * This marker lets independent verification detect a manifest-only version
 * downgrade (e.g. changing `manifestVersion` from 4 to 3 without touching the
 * database). It is deliberately an *internal* marker, not a cryptographic
 * authentication of provenance: an attacker who rewrites the whole archive can
 * forge or delete it, so the legacy trust boundary below must not rely on it.
 */
export function writeSnapshotFormatMarker(db: Database, formatVersion: number): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS ${SNAPSHOT_FORMAT_MARKER_TABLE} (format_version INTEGER NOT NULL);`,
  );
  db.run(`DELETE FROM ${SNAPSHOT_FORMAT_MARKER_TABLE};`);
  db.run(`INSERT INTO ${SNAPSHOT_FORMAT_MARKER_TABLE} (format_version) VALUES (?);`, [
    formatVersion,
  ]);
}

/**
 * Read the snapshot-format version recorded in a SQLite database, or null if the
 * database predates the marker (or the marker was removed).
 */
export function readSnapshotFormatMarker(dbOrPath: Database | string): number | null {
  let db: Database;
  let shouldClose = false;
  if (typeof dbOrPath === "string") {
    db = new Database(dbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = dbOrPath;
  }
  try {
    const tableExists = db
      .query<{ count: number }, []>(
        `SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='${SNAPSHOT_FORMAT_MARKER_TABLE}';`,
      )
      .get()?.count;
    if (!tableExists) return null;
    const row = db
      .query<{ format_version: number }, []>(
        `SELECT format_version FROM ${SNAPSHOT_FORMAT_MARKER_TABLE} ORDER BY rowid DESC LIMIT 1;`,
      )
      .get();
    return row ? Number(row.format_version) : null;
  } catch {
    return null;
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export interface KnowledgeRevisionRow {
  document_id: string;
  revision: number;
  byte_length: number;
  content_sha256: string;
}

export function getReferencedKnowledgeRevisions(snapshotDbOrPath: Database | string): KnowledgeRevisionRow[] {
  let db: Database;
  let shouldClose = false;
  if (typeof snapshotDbOrPath === "string") {
    db = new Database(snapshotDbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = snapshotDbOrPath;
  }
  try {
    const tableExists = db
      .query<{ count: number }, []>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='knowledge_revisions';",
      )
      .get()?.count;
    if (!tableExists) return [];

    return db
      .query<KnowledgeRevisionRow, []>(
        "SELECT document_id, revision, byte_length, content_sha256 FROM knowledge_revisions ORDER BY document_id, revision;",
      )
      .all();
  } catch (err) {
    if (err instanceof BackupManagerError) throw err;
    throw new BackupManagerError(
      `Failed to query referenced knowledge revisions: ${(err as Error).message}`,
      "SQLITE_ERROR",
      err,
    );
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore close error */
      }
    }
  }
}

export function getKnowledgeDocumentCount(snapshotDbOrPath: Database | string): number {
  let db: Database;
  let shouldClose = false;
  if (typeof snapshotDbOrPath === "string") {
    db = new Database(snapshotDbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = snapshotDbOrPath;
  }
  try {
    const tableExists = db
      .query<{ count: number }, []>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='knowledge_documents';",
      )
      .get()?.count;
    if (!tableExists) return 0;

    return (
      db
        .query<{ count: number }, []>(
          "SELECT count(*) as count FROM knowledge_documents WHERE archived_at IS NULL;",
        )
        .get()?.count ?? 0
    );
  } catch (err) {
    if (err instanceof BackupManagerError) throw err;
    throw new BackupManagerError(
      `Failed to query knowledge document count: ${(err as Error).message}`,
      "SQLITE_ERROR",
      err,
    );
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore close error */
      }
    }
  }
}

export interface DocumentRevisionConsistencyResult {
  ok: boolean;
  issues: string[];
}

export function verifyDocumentRevisionConsistency(
  snapshotDbOrPath: Database | string,
): DocumentRevisionConsistencyResult {
  const issues: string[] = [];
  let db: Database;
  let shouldClose = false;
  if (typeof snapshotDbOrPath === "string") {
    db = new Database(snapshotDbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = snapshotDbOrPath;
  }

  try {
    const docsTableExists = db
      .query<{ count: number }, []>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='knowledge_documents';",
      )
      .get()?.count;
    const revsTableExists = db
      .query<{ count: number }, []>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='knowledge_revisions';",
      )
      .get()?.count;

    if (!docsTableExists && !revsTableExists) {
      return { ok: true, issues: [] };
    }

    if (docsTableExists && !revsTableExists) {
      const docCount =
        db.query<{ count: number }, []>("SELECT count(*) as count FROM knowledge_documents;").get()?.count ?? 0;
      if (docCount > 0) {
        return {
          ok: false,
          issues: ["knowledge_documents table exists with records, but knowledge_revisions table is missing."],
        };
      }
      return { ok: true, issues: [] };
    }

    interface DocRow {
      id: string;
      revision: number;
      byte_length: number;
      content_sha256: string;
      archived_at: number | null;
    }

    const docs = db
      .query<DocRow, []>(
        "SELECT id, revision, byte_length, content_sha256, archived_at FROM knowledge_documents ORDER BY id;",
      )
      .all();

    interface RevLookupRow {
      byte_length: number;
      content_sha256: string;
    }
    const revStmt = db.query<RevLookupRow, [string, number]>(
      "SELECT byte_length, content_sha256 FROM knowledge_revisions WHERE document_id = ? AND revision = ?;",
    );

    for (const doc of docs) {
      if (!KNOWLEDGE_DOCUMENT_ID_RE.test(doc.id)) {
        issues.push(`Invalid knowledge document id format in knowledge_documents: ${doc.id}`);
        continue;
      }
      if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) {
        issues.push(`Knowledge document ${doc.id} has invalid current revision number: ${doc.revision}`);
        continue;
      }

      const rev = revStmt.get(doc.id, doc.revision);
      if (!rev) {
        issues.push(
          `Knowledge document ${doc.id} (${doc.archived_at != null ? "archived" : "active"}) references current revision ${doc.revision} which does not exist in knowledge_revisions.`,
        );
        continue;
      }

      if (doc.byte_length !== rev.byte_length) {
        issues.push(
          `Knowledge document ${doc.id} byte_length mismatch with current revision ${doc.revision}: document specifies ${doc.byte_length} bytes, revision specifies ${rev.byte_length} bytes.`,
        );
      }

      if (doc.content_sha256 !== rev.content_sha256) {
        issues.push(
          `Knowledge document ${doc.id} content_sha256 mismatch with current revision ${doc.revision}: document specifies ${doc.content_sha256}, revision specifies ${rev.content_sha256}.`,
        );
      }
    }
  } catch (err) {
    issues.push(`Failed to verify document-revision consistency: ${(err as Error).message}`);
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore close error */
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export interface DiscoveredAssetReference {
  rawPath: string;
  canonicalPath: string;
  category: SnapshotAssetCategory;
  taskId: string | null;
  field: "refs" | "attachments" | "sent_files" | "draft" | "backlog";
  refType: "canonical-relative" | "profile-absolute";
  itemIndex?: number;
  jsonPath?: string;
  table?: string;
  recordId?: string;
  column?: string;
}

/**
 * An absolute database reference that cannot be proven to belong to the source
 * profile, a known external Git project, or a confirmed foreign ForgeOrbit
 * profile. Such references are preserved verbatim but surfaced in the recovery
 * report as unresolved (they must never silently vanish from recovery counters).
 */
export interface UnresolvedExternalReference {
  rawPath: string;
  taskId: string | null;
  field: "refs" | "attachments" | "sent_files" | "draft" | "backlog";
  itemIndex?: number;
  jsonPath?: string;
  table?: string;
  recordId?: string;
  column?: string;
}

export interface ReferencedInternalAssets {
  attachments: Set<string>;
  screenshots: Set<string>;
  issueThreads: Set<string>;
  pipelineRuns: Set<string>;
  entries?: DiscoveredAssetReference[];
  discoveredAliasPrefixes?: Set<string>;
  crossProfileReferences?: DiscoveredAssetReference[];
  unresolvedExternalReferences?: UnresolvedExternalReference[];
}

export interface AssetRoots {
  dataDir?: string;
  canonicalDataDir?: string;
  dbParentDir?: string;
  attachmentsRootDir?: string;
  screenshotsRootDir?: string;
  issueThreadsRootDir?: string;
  pipelineRunsRootDir?: string;
  sourceProfileRootSha256?: string;
  sourceProfileRealSha256?: string;
  sourceProfileAliasSha256s?: string[];
}

export interface AssetReferenceLocator {
  itemIndex?: number;
  jsonPath?: string;
  table?: string;
  recordId?: string;
  column?: string;
}

export interface JsonPathToken {
  type: "array" | "prop";
  key: string | number;
}

/**
 * Parses an exact RFC-style JSON path coordinate (e.g. "$[0].path", "$.references[1].path")
 * into traversal tokens. Returns null if malformed.
 */
export function parseJsonPathTokens(jsonPath: string): JsonPathToken[] | null {
  if (typeof jsonPath !== "string" || !jsonPath.startsWith("$")) return null;
  if (jsonPath === "$") return [];

  const tokens: JsonPathToken[] = [];
  let remaining = jsonPath.slice(1);

  while (remaining.length > 0) {
    if (remaining.startsWith("[")) {
      const closeIdx = remaining.indexOf("]");
      if (closeIdx === -1) return null;
      const indexStr = remaining.slice(1, closeIdx);
      if (!/^\d+$/.test(indexStr)) return null;
      tokens.push({ type: "array", key: parseInt(indexStr, 10) });
      remaining = remaining.slice(closeIdx + 1);
    } else if (remaining.startsWith(".")) {
      const nextDot = remaining.indexOf(".", 1);
      const nextBracket = remaining.indexOf("[", 1);
      let endIdx = remaining.length;
      if (nextDot !== -1 && (nextBracket === -1 || nextDot < nextBracket)) {
        endIdx = nextDot;
      } else if (nextBracket !== -1) {
        endIdx = nextBracket;
      }
      const prop = remaining.slice(1, endIdx);
      if (!/^[a-zA-Z0-9_-]+$/.test(prop)) return null;
      tokens.push({ type: "prop", key: prop });
      remaining = remaining.slice(endIdx);
    } else {
      return null;
    }
  }

  return tokens;
}

/**
 * Retrieves the value at a validated JSON path coordinate.
 */
export function getValueAtJsonPath(root: unknown, jsonPath: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const tokens = parseJsonPathTokens(jsonPath);
  if (!tokens) return { ok: false, error: `Malformed JSON path: ${jsonPath}` };

  let current = root;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "array") {
      if (!Array.isArray(current)) {
        return { ok: false, error: `Expected array at step ${i} of ${jsonPath}` };
      }
      const idx = token.key as number;
      if (idx < 0 || idx >= current.length) {
        return { ok: false, error: `Array index ${idx} out of bounds (${current.length}) at ${jsonPath}` };
      }
      current = current[idx];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return { ok: false, error: `Expected object at step ${i} of ${jsonPath}` };
      }
      const prop = token.key as string;
      if (!(prop in current)) {
        return { ok: false, error: `Property ${prop} not found in object at ${jsonPath}` };
      }
      current = (current as Record<string, unknown>)[prop];
    }
  }

  return { ok: true, value: current };
}

/**
 * Deterministically replaces the value at a validated JSON path coordinate.
 */
export function setValueAtJsonPath(root: unknown, jsonPath: string, newValue: unknown): { ok: true; root: unknown } | { ok: false; error: string } {
  const tokens = parseJsonPathTokens(jsonPath);
  if (!tokens) return { ok: false, error: `Malformed JSON path: ${jsonPath}` };
  if (tokens.length === 0) return { ok: true, root: newValue };

  let current = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    if (token.type === "array") {
      if (!Array.isArray(current)) {
        return { ok: false, error: `Expected array at step ${i} of ${jsonPath}` };
      }
      const idx = token.key as number;
      if (idx < 0 || idx >= current.length) {
        return { ok: false, error: `Array index ${idx} out of bounds (${current.length}) at ${jsonPath}` };
      }
      current = current[idx];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return { ok: false, error: `Expected object at step ${i} of ${jsonPath}` };
      }
      const prop = token.key as string;
      if (!(prop in current)) {
        return { ok: false, error: `Property ${prop} not found in object at ${jsonPath}` };
      }
      current = (current as Record<string, unknown>)[prop];
    }
  }

  const lastToken = tokens[tokens.length - 1]!;
  if (lastToken.type === "array") {
    if (!Array.isArray(current)) {
      return { ok: false, error: `Expected array at target of ${jsonPath}` };
    }
    const idx = lastToken.key as number;
    if (idx < 0 || idx >= current.length) {
      return { ok: false, error: `Array index ${idx} out of bounds (${current.length}) at ${jsonPath}` };
    }
    current[idx] = newValue;
  } else {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return { ok: false, error: `Expected object at target of ${jsonPath}` };
    }
    (current as Record<string, unknown>)[lastToken.key as string] = newValue;
  }

  return { ok: true, root };
}

/**
 * Checks whether a directory is structured as a ForgeOrbit profile directory.
 */
export function isForgeOrbitProfileDirectory(dirPath: string): boolean {
  try {
    const resolved = path.resolve(dirPath);
    if (
      existsSync(path.join(resolved, "agetor.sqlite")) ||
      existsSync(path.join(resolved, "agetor.db")) ||
      existsSync(path.join(resolved, "database.sqlite"))
    ) {
      return true;
    }
    const base = path.basename(resolved).toLowerCase();
    if (base.includes("forgeorbit") || base.includes("agetor") || base.startsWith("profile")) {
      return true;
    }
    if (
      resolved.includes("/Application Support/ForgeOrbit") ||
      resolved.includes("/.forgeorbit") ||
      resolved.includes("/.agetor")
    ) {
      return true;
    }
    let catCount = 0;
    if (existsSync(path.join(resolved, "attachments"))) catCount++;
    if (existsSync(path.join(resolved, "screenshots"))) catCount++;
    if (existsSync(path.join(resolved, "issue-threads"))) catCount++;
    if (existsSync(path.join(resolved, "pipeline-runs"))) catCount++;
    if (existsSync(path.join(resolved, "knowledge"))) catCount++;
    if (catCount >= 2) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Checks whether a path resides inside an external Git repository.
 */
export function isGitRepositoryDirectory(dirPath: string): boolean {
  try {
    let cur = path.resolve(dirPath);
    while (cur && cur !== path.dirname(cur)) {
      if (existsSync(path.join(cur, ".git"))) {
        return true;
      }
      cur = path.dirname(cur);
    }
  } catch {
    /* ignore */
  }
  return false;
}

const MACOS_PRIVATE_ALIAS_PREFIXES: Array<[string, string]> = [
  ["/var", "/private/var"],
  ["/tmp", "/private/tmp"],
  ["/etc", "/private/etc"],
];

/**
 * Expands a resolved absolute path into its legitimate macOS `/private` lexical aliases.
 * Purely lexical: does not access the filesystem (safe for offline verification of deleted profiles).
 */
export function expandMacosCanonicalAliases(absPath: string): string[] {
  const resolved = path.resolve(absPath);
  const out = new Set<string>([resolved]);
  for (const [shortPrefix, privatePrefix] of MACOS_PRIVATE_ALIAS_PREFIXES) {
    if (resolved === shortPrefix) {
      out.add(privatePrefix);
    } else if (resolved.startsWith(shortPrefix + path.sep)) {
      out.add(privatePrefix + resolved.slice(shortPrefix.length));
    } else if (resolved === privatePrefix) {
      out.add(shortPrefix);
    } else if (resolved.startsWith(privatePrefix + path.sep)) {
      out.add(shortPrefix + resolved.slice(privatePrefix.length));
    }
  }
  return Array.from(out);
}

/**
 * Resolves the filesystem-aware canonical realpath of a path or its nearest existing parent.
 */
export function resolveExistingOrParentRealpath(absPath: string): string {
  const resolved = path.resolve(absPath);
  try {
    if (existsSync(resolved)) {
      return realpathSync(resolved);
    }
  } catch {
    /* fall through */
  }
  const parent = path.dirname(resolved);
  if (parent && parent !== resolved) {
    try {
      if (existsSync(parent)) {
        return path.join(realpathSync(parent), path.basename(resolved));
      }
    } catch {
      /* ignore */
    }
  }
  return resolved;
}

/**
 * Checks whether two directory paths refer to the same canonical directory identity.
 */
export function isSameCanonicalDirectory(dirA: string, dirB: string): boolean {
  const resA = path.resolve(dirA);
  const resB = path.resolve(dirB);
  if (resA === resB) return true;
  try {
    if (existsSync(resA) && existsSync(resB)) {
      const stA = statSync(resA);
      const stB = statSync(resB);
      if (stA.isDirectory() && stB.isDirectory() && stA.dev === stB.dev && stA.ino === stB.ino) {
        return true;
      }
      return realpathSync(resA) === realpathSync(resB);
    }
  } catch {
    /* fall through */
  }
  const realA = resolveExistingOrParentRealpath(resA);
  const realB = resolveExistingOrParentRealpath(resB);
  if (realA === realB) return true;
  const aliasesA = expandMacosCanonicalAliases(realA);
  const aliasesB = new Set(expandMacosCanonicalAliases(realB));
  return aliasesA.some((a) => aliasesB.has(a));
}

function expandCanonicalRootVariants(rootDir: string): string[] {
  const variants = new Set<string>();
  const resolved = path.resolve(rootDir);
  for (const v of expandMacosCanonicalAliases(resolved)) {
    variants.add(v);
  }
  const real = resolveExistingOrParentRealpath(resolved);
  for (const v of expandMacosCanonicalAliases(real)) {
    variants.add(v);
  }
  return Array.from(variants);
}

export interface SourceProfileLayoutInput {
  dbFilename?: string | null;
  dataDir?: string;
  knowledgeRootDir?: string;
  attachmentsRootDir?: string;
  screenshotsRootDir?: string;
  issueThreadsRootDir?: string;
  pipelineRunsRootDir?: string;
}

export interface ValidatedSourceProfileLayout {
  dataDir: string;
  canonicalDataDir: string;
  dbParentDir?: string;
  knowledgeRootDir: string;
  attachmentsRootDir: string;
  screenshotsRootDir: string;
  issueThreadsRootDir: string;
  pipelineRunsRootDir: string;
}

/**
 * Validates that the source SQLite database and all category roots belong to a single
 * authoritative profile root (FO-P2-003-R6A).
 */
export function validateSourceProfileLayout(input: SourceProfileLayoutInput): ValidatedSourceProfileLayout {
  const hasDiskDb = Boolean(
    input.dbFilename && input.dbFilename !== ":memory:" && input.dbFilename !== "",
  );
  let resolvedDb: string | undefined;
  let dbParentDir: string | undefined;
  let canonicalDbParent: string | undefined;

  if (hasDiskDb && input.dbFilename) {
    if (typeof input.dbFilename !== "string" || !input.dbFilename.trim() || input.dbFilename.includes("\0")) {
      throw new BackupManagerError("Invalid source database path.", "INVALID_PATH");
    }
    resolvedDb = path.resolve(input.dbFilename);
    if (pathExistsOrSymlink(resolvedDb)) {
      const dbLstat = lstatSync(resolvedDb);
      if (dbLstat.isSymbolicLink()) {
        throw new BackupManagerError(
          `Source SQLite database cannot be a symbolic link: ${input.dbFilename}`,
          "UNTRUSTED_SYMLINK",
        );
      }
      if (!dbLstat.isFile()) {
        throw new BackupManagerError(
          `Source SQLite database is not a regular file: ${input.dbFilename}`,
          "INVALID_PATH",
        );
      }
    }
    dbParentDir = path.dirname(resolvedDb);
    canonicalDbParent = resolveExistingOrParentRealpath(dbParentDir);
    if (existsSync(resolvedDb)) {
      const realDbFile = realpathSync(resolvedDb);
      if (path.dirname(realDbFile) !== canonicalDbParent) {
        throw new BackupManagerError(
          `Source SQLite database resolves outside its parent profile directory: ${input.dbFilename}`,
          "UNTRUSTED_SYMLINK",
        );
      }
    }
  }

  let resolvedDataDir: string;
  if (input.dataDir !== undefined) {
    if (
      typeof input.dataDir !== "string" ||
      !input.dataDir.trim() ||
      input.dataDir.includes("\0")
    ) {
      throw new BackupManagerError(
        "Invalid dataDir: must be a non-empty string without null bytes.",
        "INVALID_PATH",
      );
    }
    if (!path.isAbsolute(input.dataDir)) {
      throw new BackupManagerError(
        `dataDir must be an absolute path: ${input.dataDir}`,
        "INVALID_PATH",
      );
    }
    resolvedDataDir = path.resolve(input.dataDir);
  } else if (dbParentDir) {
    resolvedDataDir = dbParentDir;
  } else {
    throw new BackupManagerError(
      "Source profile data directory must be explicitly specified when database has no filesystem path.",
      "INVALID_PATH",
    );
  }

  if (pathExistsOrSymlink(resolvedDataDir)) {
    const dataDirLstat = lstatSync(resolvedDataDir);
    if (dataDirLstat.isSymbolicLink()) {
      // Allow a symlinked dataDir ONLY when backed by an on-disk database in the exact same canonical profile directory
      if (!dbParentDir || !existsSync(resolvedDataDir)) {
        throw new BackupManagerError(
          `Profile data directory cannot be an unverified or dangling symbolic link: ${resolvedDataDir}`,
          "UNTRUSTED_SYMLINK",
        );
      }
      const targetStat = statSync(resolvedDataDir);
      if (!targetStat.isDirectory()) {
        throw new BackupManagerError(
          `Profile data directory symbolic link does not resolve to a directory: ${resolvedDataDir}`,
          "INVALID_PATH",
        );
      }
      if (!isSameCanonicalDirectory(resolvedDataDir, dbParentDir)) {
        throw new BackupManagerError(
          `Profile data directory symbolic link (${resolvedDataDir}) does not match database profile root (${dbParentDir}).`,
          "INVALID_PATH",
        );
      }
    } else if (!dataDirLstat.isDirectory()) {
      throw new BackupManagerError(
        `Profile data directory is not a directory: ${resolvedDataDir}`,
        "INVALID_PATH",
      );
    }
  }

  // Require the source SQLite file to be a direct child of the authoritative profile directory
  if (dbParentDir && !isSameCanonicalDirectory(resolvedDataDir, dbParentDir)) {
    throw new BackupManagerError(
      `Source database (${input.dbFilename}) must be a direct child of the profile data directory (${resolvedDataDir}); cross-profile or shared-ancestor paths are forbidden.`,
      "INVALID_PATH",
    );
  }

  const canonicalDataDir = resolveExistingOrParentRealpath(resolvedDataDir);

  const bindCategoryRoot = (explicitRoot: string | undefined, categoryName: string): string => {
    const resolved = explicitRoot !== undefined ? (() => {
      if (typeof explicitRoot !== "string" || !explicitRoot.trim() || explicitRoot.includes("\0")) {
        throw new BackupManagerError(`Invalid ${categoryName} root path.`, "INVALID_PATH");
      }
      if (!path.isAbsolute(explicitRoot)) {
        throw new BackupManagerError(`${categoryName} root path must be absolute: ${explicitRoot}`, "INVALID_PATH");
      }
      return path.resolve(explicitRoot);
    })() : path.join(resolvedDataDir, categoryName);

    // Category root must be named `<categoryName>` and its parent must be the same canonical profile root
    if (path.basename(resolved) !== categoryName || !isSameCanonicalDirectory(path.dirname(resolved), resolvedDataDir)) {
      throw new BackupManagerError(
        `${categoryName} root (${explicitRoot ?? resolved}) must correspond to ${path.join(resolvedDataDir, categoryName)}.`,
        "INVALID_PATH",
      );
    }

    if (pathExistsOrSymlink(resolved)) {
      const st = lstatSync(resolved);
      if (st.isSymbolicLink()) {
        throw new BackupManagerError(
          `Untrusted symlink detected in ${categoryName} root: ${resolved}`,
          "UNTRUSTED_SYMLINK",
        );
      }
      if (!st.isDirectory()) {
        throw new BackupManagerError(
          `${categoryName} root is not a directory: ${resolved}`,
          "INVALID_PATH",
        );
      }
      const realCat = realpathSync(resolved);
      const expectedCanonicalCat = path.join(canonicalDataDir, categoryName);
      if (realCat !== expectedCanonicalCat) {
        throw new BackupManagerError(
          `${categoryName} root (${resolved}) resolves outside canonical profile root (${expectedCanonicalCat}).`,
          "UNTRUSTED_SYMLINK",
        );
      }
    }

    const canonicalCatPath = path.join(canonicalDataDir, categoryName);
    if (canonicalCatPath !== resolved && pathExistsOrSymlink(canonicalCatPath)) {
      const canonSt = lstatSync(canonicalCatPath);
      if (canonSt.isSymbolicLink()) {
        throw new BackupManagerError(
          `Untrusted symlink detected in canonical ${categoryName} root: ${canonicalCatPath}`,
          "UNTRUSTED_SYMLINK",
        );
      }
      if (!canonSt.isDirectory()) {
        throw new BackupManagerError(
          `Canonical ${categoryName} root is not a directory: ${canonicalCatPath}`,
          "INVALID_PATH",
        );
      }
    }

    return resolved;
  };

  return {
    dataDir: resolvedDataDir,
    canonicalDataDir,
    dbParentDir,
    knowledgeRootDir: bindCategoryRoot(input.knowledgeRootDir, "knowledge"),
    attachmentsRootDir: bindCategoryRoot(input.attachmentsRootDir, "attachments"),
    screenshotsRootDir: bindCategoryRoot(input.screenshotsRootDir, "screenshots"),
    issueThreadsRootDir: bindCategoryRoot(input.issueThreadsRootDir, "issue-threads"),
    pipelineRunsRootDir: bindCategoryRoot(input.pipelineRunsRootDir, "pipeline-runs"),
  };
}

function recordInternalAssetCandidate(
  rawPath: string,
  taskId: string | null,
  field: "refs" | "attachments" | "sent_files" | "draft" | "backlog",
  result: ReferencedInternalAssets,
  roots?: AssetRoots,
  locator?: AssetReferenceLocator,
): void {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) return;
  const normalized = rawPath.replaceAll("\\", "/");
  if (
    normalized.includes("/../") ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized === ".."
  ) {
    throw new BackupManagerError(
      `Path traversal detected in database asset reference: ${rawPath}`,
      "INVALID_PATH",
    );
  }

  const addEntry = (canonicalPath: string, category: SnapshotAssetCategory, refType: "canonical-relative" | "profile-absolute") => {
    if (category === "attachment") result.attachments.add(canonicalPath);
    else if (category === "screenshot") result.screenshots.add(canonicalPath);
    else if (category === "issue-thread") result.issueThreads.add(canonicalPath);
    else if (category === "pipeline-run") result.pipelineRuns.add(canonicalPath);

    if (result.entries) {
      result.entries.push({
        rawPath,
        canonicalPath,
        category,
        taskId,
        field,
        refType,
        itemIndex: locator?.itemIndex,
        jsonPath: locator?.jsonPath,
        table: locator?.table ?? "tasks",
        recordId: locator?.recordId ?? taskId ?? undefined,
        column: locator?.column ?? field,
      });
    }
  };

  const addUnresolvedExternal = () => {
    if (!result.unresolvedExternalReferences) {
      result.unresolvedExternalReferences = [];
    }
    result.unresolvedExternalReferences.push({
      rawPath,
      taskId,
      field,
      itemIndex: locator?.itemIndex,
      jsonPath: locator?.jsonPath,
      table: locator?.table ?? "tasks",
      recordId: locator?.recordId ?? taskId ?? undefined,
      column: locator?.column ?? field,
    });
  };

  // 1. Direct relative category paths matching strict patterns
  if (normalized.startsWith("attachments/") || normalized === "attachments") {
    const filename = normalized.slice("attachments/".length);
    if (normalized.startsWith("attachments/") && filename && !filename.includes("/") && !filename.startsWith(".")) {
      addEntry(`attachments/${filename}`, "attachment", "canonical-relative");
      return;
    }
    throw new BackupManagerError(
      `Invalid relative attachment reference layout: ${rawPath}`,
      "INVALID_PATH",
    );
  }

  if (normalized.startsWith("screenshots/") || normalized === "screenshots") {
    const filename = normalized.slice("screenshots/".length);
    if (normalized.startsWith("screenshots/") && filename && !filename.includes("/") && !filename.startsWith(".")) {
      addEntry(`screenshots/${filename}`, "screenshot", "canonical-relative");
      return;
    }
    throw new BackupManagerError(
      `Invalid relative screenshot reference layout: ${rawPath}`,
      "INVALID_PATH",
    );
  }

  if (normalized.startsWith("issue-threads/") || normalized === "issue-threads") {
    const sub = normalized.slice("issue-threads/".length);
    const parts = sub.split("/");
    if (normalized.startsWith("issue-threads/") && parts.length === 2 && parts[0] && parts[1] && !parts[0].startsWith(".") && !parts[1].startsWith(".")) {
      addEntry(`issue-threads/${parts[0]}/${parts[1]}`, "issue-thread", "canonical-relative");
      return;
    }
    throw new BackupManagerError(
      `Invalid relative issue-thread reference layout: ${rawPath}`,
      "INVALID_PATH",
    );
  }

  if (normalized.startsWith("pipeline-runs/") || normalized === "pipeline-runs") {
    const sub = normalized.slice("pipeline-runs/".length);
    const parts = sub.split("/");
    if (normalized.startsWith("pipeline-runs/") && parts.length === 2 && parts[0] && parts[1] && !parts[0].startsWith(".") && !parts[1].startsWith(".") && parts[1].endsWith(".json")) {
      addEntry(`pipeline-runs/${parts[0]}/${parts[1]}`, "pipeline-run", "canonical-relative");
      return;
    }
    throw new BackupManagerError(
      `Invalid relative pipeline-run reference layout: ${rawPath}`,
      "INVALID_PATH",
    );
  }

  // 2. Absolute paths anchored strictly within verified category roots or canonical profile root
  if (path.isAbsolute(rawPath)) {
    const resolvedPath = path.resolve(rawPath);
    const rawPathVariants = expandMacosCanonicalAliases(resolvedPath);

    const classifyRelativeUnderCategory = (
      normRel: string,
      category: "attachments" | "screenshots" | "issue-threads" | "pipeline-runs",
    ): boolean => {
      if (!normRel || normRel.includes("..") || normRel.startsWith(".")) {
        throw new BackupManagerError(
          `Invalid internal reference under ${category}: ${rawPath}`,
          "INVALID_PATH",
        );
      }
      if (category === "attachments") {
        if (!normRel.includes("/")) {
          addEntry(`attachments/${normRel}`, "attachment", "profile-absolute");
          return true;
        }
        throw new BackupManagerError(
          `Invalid nested attachment reference under profile: ${rawPath}`,
          "INVALID_PATH",
        );
      }
      if (category === "screenshots") {
        if (!normRel.includes("/")) {
          addEntry(`screenshots/${normRel}`, "screenshot", "profile-absolute");
          return true;
        }
        throw new BackupManagerError(
          `Invalid nested screenshot reference under profile: ${rawPath}`,
          "INVALID_PATH",
        );
      }
      if (category === "issue-threads") {
        const parts = normRel.split("/");
        if (parts.length === 2 && parts[0] && parts[1] && !parts[0].startsWith(".") && !parts[1].startsWith(".")) {
          addEntry(`issue-threads/${parts[0]}/${parts[1]}`, "issue-thread", "profile-absolute");
          return true;
        }
        throw new BackupManagerError(
          `Invalid issue-thread reference layout under profile: ${rawPath}`,
          "INVALID_PATH",
        );
      }
      if (category === "pipeline-runs") {
        const parts = normRel.split("/");
        if (parts.length === 2 && parts[0] && parts[1] && !parts[0].startsWith(".") && !parts[1].startsWith(".") && parts[1].endsWith(".json")) {
          addEntry(`pipeline-runs/${parts[0]}/${parts[1]}`, "pipeline-run", "profile-absolute");
          return true;
        }
        throw new BackupManagerError(
          `Invalid pipeline-run reference layout under profile: ${rawPath}`,
          "INVALID_PATH",
        );
      }
      return false;
    };

    const checkRoot = (rootDir: string | undefined, category: "attachments" | "screenshots" | "issue-threads" | "pipeline-runs"): boolean => {
      if (!rootDir) return false;
      const rootVariants = expandCanonicalRootVariants(rootDir);
      for (const rv of rootVariants) {
        for (const pv of rawPathVariants) {
          if (pv.startsWith(rv + path.sep)) {
            const rel = path.relative(rv, pv).replaceAll("\\", "/");
            return classifyRelativeUnderCategory(rel, category);
          }
        }
      }
      return false;
    };

    if (checkRoot(roots?.attachmentsRootDir, "attachments")) return;
    if (checkRoot(roots?.screenshotsRootDir, "screenshots")) return;
    if (checkRoot(roots?.issueThreadsRootDir, "issue-threads")) return;
    if (checkRoot(roots?.pipelineRunsRootDir, "pipeline-runs")) return;

    if (roots?.dataDir) {
      if (checkRoot(path.join(roots.dataDir, "attachments"), "attachments")) return;
      if (checkRoot(path.join(roots.dataDir, "screenshots"), "screenshots")) return;
      if (checkRoot(path.join(roots.dataDir, "issue-threads"), "issue-threads")) return;
      if (checkRoot(path.join(roots.dataDir, "pipeline-runs"), "pipeline-runs")) return;
    }

    // Check symlinked profile root aliases and portable origin profile hashes
    const categoryRegexes: Array<{
      category: "attachments" | "screenshots" | "issue-threads" | "pipeline-runs";
      re: RegExp;
    }> = [
      { category: "attachments", re: /^(.*)[/\\]attachments[/\\](.+)$/ },
      { category: "screenshots", re: /^(.*)[/\\]screenshots[/\\](.+)$/ },
      { category: "issue-threads", re: /^(.*)[/\\]issue-threads[/\\](.+)$/ },
      { category: "pipeline-runs", re: /^(.*)[/\\]pipeline-runs[/\\](.+)$/ },
    ];

    for (const { category, re } of categoryRegexes) {
      const m = re.exec(resolvedPath);
      if (!m || !m[1] || !m[2]) continue;
      const candPrefix = path.resolve(m[1]);
      const relPart = m[2].replaceAll("\\", "/");

      // Online check: if candPrefix is a symlink alias of roots.dataDir on disk
      if (roots?.dataDir && existsSync(candPrefix) && existsSync(roots.dataDir)) {
        if (isSameCanonicalDirectory(candPrefix, roots.dataDir)) {
          if (!result.discoveredAliasPrefixes) {
            result.discoveredAliasPrefixes = new Set();
          }
          result.discoveredAliasPrefixes.add(candPrefix);
          if (classifyRelativeUnderCategory(relPart, category)) return;
        }
      }

      // Cross-profile detection: a candidate prefix structured as a ForgeOrbit
      // profile directory is a confirmed foreign-profile dependency. Origin
      // metadata hashes are deliberately NOT consulted here — they are
      // unauthenticated and must never authorize rewriting external paths.
      if (isForgeOrbitProfileDirectory(candPrefix)) {
        if (!result.crossProfileReferences) {
          result.crossProfileReferences = [];
        }
        const assetCat: SnapshotAssetCategory =
          category === "attachments"
            ? "attachment"
            : category === "screenshots"
              ? "screenshot"
              : category === "issue-threads"
                ? "issue-thread"
                : "pipeline-run";
        result.crossProfileReferences.push({
          rawPath,
          canonicalPath: `${category}/${relPart}`,
          category: assetCat,
          taskId,
          field,
          refType: "profile-absolute",
          itemIndex: locator?.itemIndex,
          jsonPath: locator?.jsonPath,
          table: locator?.table ?? "tasks",
          recordId: locator?.recordId ?? taskId ?? undefined,
          column: locator?.column ?? field,
        });
        return;
      }

      if (isGitRepositoryDirectory(candPrefix)) {
        // Ordinary external Git repository path: preserved as external, not internal
        return;
      }

      // Resembles a persistent-storage category but ownership cannot be proven:
      // surface as an unresolved external operational reference (never silently dropped).
      addUnresolvedExternal();
      return;
    }

    // Non-category absolute path: distinguish a known external Git project
    // reference from an unresolved absolute operational file reference.
    const nonCategoryPrefix = path.dirname(resolvedPath);
    if (isGitRepositoryDirectory(nonCategoryPrefix)) {
      // Known external Git project reference: preserved verbatim.
      return;
    }
    addUnresolvedExternal();

    // NOTE: NEVER fall back to resolveDataDir()!
  }
}

export function getReferencedInternalAssets(
  snapshotDbOrPath: Database | string,
  roots?: AssetRoots,
): ReferencedInternalAssets {
  const result: ReferencedInternalAssets = {
    attachments: new Set(),
    screenshots: new Set(),
    issueThreads: new Set(),
    pipelineRuns: new Set(),
    entries: [],
  };

  let db: Database;
  let shouldClose = false;
  if (typeof snapshotDbOrPath === "string") {
    db = new Database(snapshotDbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = snapshotDbOrPath;
  }

  try {
    const tasksTableExists = db
      .query<{ count: number }, []>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='tasks';",
      )
      .get()?.count;
    if (!tasksTableExists) return result;

    const tableInfo = db.query<{ name: string }, []>("PRAGMA table_info(tasks);").all();
    const cols = new Set(tableInfo.map((c) => c.name));

    interface TaskRefRow {
      id: string;
      refs?: string | null;
      attachments?: string | null;
      sent_files?: string | null;
      draft?: string | null;
      backlog?: string | null;
      prompt?: string | null;
    }

    const selectCols = ["id"];
    if (cols.has("refs")) selectCols.push("refs");
    if (cols.has("attachments")) selectCols.push("attachments");
    if (cols.has("sent_files")) selectCols.push("sent_files");
    if (cols.has("draft")) selectCols.push("draft");
    if (cols.has("backlog")) selectCols.push("backlog");
    if (cols.has("prompt")) selectCols.push("prompt");

    const rows = db
      .query<TaskRefRow, []>(
        `SELECT ${selectCols.join(", ")} FROM tasks;`,
      )
      .all();

    for (const row of rows) {
      if (row.refs) {
        try {
          let parsed: unknown;
          let isJson = false;
          try {
            parsed = JSON.parse(row.refs);
            isJson = true;
          } catch {
            // Not valid JSON: if not formatted as JSON syntax, support legacy plain string / delimited references
            const trimmed = row.refs.trim();
            if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
              const tokens = trimmed.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
              for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                if (!token) continue;
                recordInternalAssetCandidate(token, row.id, "refs", result, roots, {
                  itemIndex: i,
                  jsonPath: `$[${i}]`,
                  table: "tasks",
                  recordId: row.id,
                  column: "refs",
                });
              }
            } else {
              throw new BackupManagerError(`Invalid JSON in tasks.refs for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
            }
          }

          if (isJson && Array.isArray(parsed)) {
            for (let i = 0; i < parsed.length; i++) {
              const item = parsed[i];
              const p = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path : undefined;
              if (typeof p === "string") {
                recordInternalAssetCandidate(p, row.id, "refs", result, roots, {
                  itemIndex: i,
                  jsonPath: typeof item === "string" ? `$[${i}]` : `$[${i}].path`,
                  table: "tasks",
                  recordId: row.id,
                  column: "refs",
                });
              } else if (item !== undefined && item !== null) {
                throw new BackupManagerError(`Unsupported reference format in tasks.refs[${i}] for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
              }
            }
          } else if (isJson && parsed && typeof parsed === "object") {
            if (typeof (parsed as { path?: unknown }).path === "string") {
              recordInternalAssetCandidate((parsed as { path: string }).path, row.id, "refs", result, roots, {
                jsonPath: "$.path",
                table: "tasks",
                recordId: row.id,
                column: "refs",
              });
            }
            if (Array.isArray((parsed as { references?: unknown }).references)) {
              const refsList = (parsed as { references: unknown[] }).references;
              for (let i = 0; i < refsList.length; i++) {
                const item = refsList[i];
                const p = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path : undefined;
                if (typeof p === "string") {
                  recordInternalAssetCandidate(p, row.id, "refs", result, roots, {
                    itemIndex: i,
                    jsonPath: typeof item === "string" ? `$.references[${i}]` : `$.references[${i}].path`,
                    table: "tasks",
                    recordId: row.id,
                    column: "refs",
                  });
                } else if (item !== undefined && item !== null) {
                  throw new BackupManagerError(`Unsupported reference format in tasks.refs.references[${i}] for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
                }
              }
            }
          }
        } catch (err) {
          if (err instanceof BackupManagerError) throw err;
          if ((err as { code?: string })?.code === "INVALID_PATH") throw err;
          throw new BackupManagerError(`Failed to parse tasks.refs for task ${row.id}: ${(err as Error).message}`, "UNSUPPORTED_REFERENCE_FORMAT", err);
        }
      }

      if (row.sent_files) {
        try {
          const parsed = JSON.parse(row.sent_files);
          if (Array.isArray(parsed)) {
            for (let i = 0; i < parsed.length; i++) {
              const item = parsed[i];
              const p = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path : undefined;
              if (typeof p === "string") {
                recordInternalAssetCandidate(p, row.id, "sent_files", result, roots, {
                  itemIndex: i,
                  jsonPath: typeof item === "string" ? `$[${i}]` : `$[${i}].path`,
                  table: "tasks",
                  recordId: row.id,
                  column: "sent_files",
                });
              } else if (item !== undefined && item !== null) {
                throw new BackupManagerError(`Unsupported reference format in tasks.sent_files[${i}] for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
              }
            }
          } else if (parsed && typeof parsed === "object") {
            if (typeof (parsed as { path?: unknown }).path === "string") {
              recordInternalAssetCandidate((parsed as { path: string }).path, row.id, "sent_files", result, roots, {
                jsonPath: "$.path",
                table: "tasks",
                recordId: row.id,
                column: "sent_files",
              });
            }
          }
        } catch (err) {
          if (err instanceof BackupManagerError) throw err;
          if ((err as { code?: string })?.code === "INVALID_PATH") throw err;
          throw new BackupManagerError(`Failed to parse tasks.sent_files for task ${row.id}: ${(err as Error).message}`, "UNSUPPORTED_REFERENCE_FORMAT", err);
        }
      }

      if (row.attachments) {
        try {
          const parsed = JSON.parse(row.attachments);
          if (Array.isArray(parsed)) {
            for (let i = 0; i < parsed.length; i++) {
              const item = parsed[i];
              const p = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path : undefined;
              if (typeof p === "string") {
                recordInternalAssetCandidate(p, row.id, "attachments", result, roots, {
                  itemIndex: i,
                  jsonPath: typeof item === "string" ? `$[${i}]` : `$[${i}].path`,
                  table: "tasks",
                  recordId: row.id,
                  column: "attachments",
                });
              } else if (item !== undefined && item !== null) {
                throw new BackupManagerError(`Unsupported reference format in tasks.attachments[${i}] for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
              }
            }
          } else if (parsed && typeof parsed === "object") {
            if (typeof (parsed as { path?: unknown }).path === "string") {
              recordInternalAssetCandidate((parsed as { path: string }).path, row.id, "attachments", result, roots, {
                jsonPath: "$.path",
                table: "tasks",
                recordId: row.id,
                column: "attachments",
              });
            }
          }
        } catch (err) {
          if (err instanceof BackupManagerError) throw err;
          if ((err as { code?: string })?.code === "INVALID_PATH") throw err;
          throw new BackupManagerError(`Failed to parse tasks.attachments for task ${row.id}: ${(err as Error).message}`, "UNSUPPORTED_REFERENCE_FORMAT", err);
        }
      }

      if (row.draft) {
        try {
          const parsed = JSON.parse(row.draft);
          if (parsed && typeof parsed === "object") {
            const rawRefs = (parsed as { references?: unknown }).references;
            if (rawRefs !== undefined && rawRefs !== null) {
              if (!Array.isArray(rawRefs)) {
                throw new BackupManagerError(`Invalid draft.references in task ${row.id}: must be an array`, "UNSUPPORTED_REFERENCE_FORMAT");
              }
              for (let j = 0; j < rawRefs.length; j++) {
                const item = rawRefs[j];
                const p = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path : undefined;
                if (typeof p === "string") {
                  recordInternalAssetCandidate(p, row.id, "draft", result, roots, {
                    itemIndex: j,
                    jsonPath: typeof item === "string" ? `$.references[${j}]` : `$.references[${j}].path`,
                    table: "tasks",
                    recordId: row.id,
                    column: "draft",
                  });
                } else {
                  throw new BackupManagerError(`Unsupported reference format in tasks.draft.references[${j}] for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
                }
              }
            }
          } else {
            throw new BackupManagerError(`Invalid JSON object in tasks.draft for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
          }
        } catch (err) {
          if (err instanceof BackupManagerError) throw err;
          if ((err as { code?: string })?.code === "INVALID_PATH") throw err;
          throw new BackupManagerError(`Failed to parse tasks.draft for task ${row.id}: ${(err as Error).message}`, "UNSUPPORTED_REFERENCE_FORMAT", err);
        }
      }

      if (row.backlog) {
        try {
          const parsed = JSON.parse(row.backlog);
          if (Array.isArray(parsed)) {
            for (let i = 0; i < parsed.length; i++) {
              const msg = parsed[i];
              if (!msg || typeof msg !== "object") {
                throw new BackupManagerError(`Invalid backlog message object at index ${i} for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
              }
              const rawRefs = (msg as { references?: unknown }).references;
              if (rawRefs !== undefined && rawRefs !== null) {
                if (!Array.isArray(rawRefs)) {
                  throw new BackupManagerError(`Invalid backlog.references at index ${i} for task ${row.id}: must be an array`, "UNSUPPORTED_REFERENCE_FORMAT");
                }
                for (let j = 0; j < rawRefs.length; j++) {
                  const item = rawRefs[j];
                  const p = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path : undefined;
                  if (typeof p === "string") {
                    recordInternalAssetCandidate(p, row.id, "backlog", result, roots, {
                      itemIndex: j,
                      jsonPath: typeof item === "string" ? `$[${i}].references[${j}]` : `$[${i}].references[${j}].path`,
                      table: "tasks",
                      recordId: row.id,
                      column: "backlog",
                    });
                  } else {
                    throw new BackupManagerError(`Unsupported reference format in tasks.backlog[${i}].references[${j}] for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
                  }
                }
              }
            }
          } else {
            throw new BackupManagerError(`Invalid JSON array in tasks.backlog for task ${row.id}`, "UNSUPPORTED_REFERENCE_FORMAT");
          }
        } catch (err) {
          if (err instanceof BackupManagerError) throw err;
          if ((err as { code?: string })?.code === "INVALID_PATH") throw err;
          throw new BackupManagerError(`Failed to parse tasks.backlog for task ${row.id}: ${(err as Error).message}`, "UNSUPPORTED_REFERENCE_FORMAT", err);
        }
      }

      // Note: row.prompt is arbitrary user natural-language text.
      // FO-P2-003-R4D: Freeform prompt text is intentionally NOT scanned for filesystem
      // asset paths to avoid false dependencies or unexpected backup failures.
    }
  } catch (err) {
    if (err instanceof BackupManagerError) throw err;
    throw new BackupManagerError(
      `Failed to query database task asset references: ${(err as Error).message}`,
      "SQLITE_ERROR",
      err,
    );
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore close error */
      }
    }
  }

  return result;
}

export async function copyAndVerifyAssetFile(
  sourceFile: string,
  targetFile: string,
  approvedRootReal: string,
  syncFileFn: (p: string) => void,
  syncDirFn: (p: string) => void,
  duringAssetCopy?: (sourceFile: string, targetFile: string) => void | Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  let stBefore: ReturnType<typeof lstatSync>;
  try {
    stBefore = lstatSync(sourceFile);
  } catch (err) {
    throw new BackupManagerError(
      `Failed to stat asset file ${sourceFile}: ${(err as Error).message}`,
      "INCONSISTENT_ASSET",
      err,
    );
  }

  if (stBefore.isSymbolicLink()) {
    throw new BackupManagerError(
      `Untrusted symbolic link detected in asset storage: ${sourceFile}`,
      "UNTRUSTED_SYMLINK",
    );
  }
  if (!stBefore.isFile()) {
    throw new BackupManagerError(
      `Asset entry is not a regular file: ${sourceFile}`,
      "INCONSISTENT_ASSET",
    );
  }

  // Canonical containment check
  try {
    const realSource = realpathSync(sourceFile);
    if (realSource !== approvedRootReal && !realSource.startsWith(approvedRootReal + path.sep)) {
      throw new BackupManagerError(
        `Asset file escapes approved root directory via symlink: ${sourceFile}`,
        "UNTRUSTED_SYMLINK",
      );
    }
  } catch (err) {
    if (err instanceof BackupManagerError) throw err;
    throw new BackupManagerError(
      `Failed to resolve real path for asset ${sourceFile}: ${(err as Error).message}`,
      "INCONSISTENT_ASSET",
      err,
    );
  }

  const targetDir = path.dirname(targetFile);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  try {
    copyFileSync(sourceFile, targetFile);
    chmodSync(targetFile, 0o600);
  } catch (err) {
    throw new BackupManagerError(
      `Failed to copy asset file ${sourceFile} to ${targetFile}: ${(err as Error).message}`,
      "IO_ERROR",
      err,
    );
  }

  await duringAssetCopy?.(sourceFile, targetFile);

  try {
    syncFileFn(targetFile);
    syncDirFn(targetDir);
  } catch (syncErr) {
    throw new BackupManagerError(
      `Failed to synchronize asset file ${targetFile}: ${(syncErr as Error).message}`,
      "IO_ERROR",
      syncErr,
    );
  }

  const actualSha = await computeFileSha256(targetFile);

  // TOCTOU check: verify source file was not concurrently modified or deleted
  let stAfter: ReturnType<typeof lstatSync>;
  try {
    stAfter = lstatSync(sourceFile);
  } catch (err) {
    throw new BackupManagerError(
      `Asset file was concurrently removed during snapshot: ${sourceFile}`,
      "INCONSISTENT_ASSET",
      err,
    );
  }

  if (stBefore.size !== stAfter.size || stBefore.mtimeMs !== stAfter.mtimeMs || stBefore.ino !== stAfter.ino) {
    throw new BackupManagerError(
      `Asset file was concurrently modified during snapshot: ${sourceFile}`,
      "INCONSISTENT_ASSET",
    );
  }

  return { bytes: stBefore.size, sha256: actualSha };
}

function formatDefaultSnapshotName(nowMs: number, snapshotId: string): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `forgeorbit-snapshot-${stamp}-${snapshotId.slice(0, 8)}`;
}

export function validateInternalReferencesCompleteness(
  manifest: SnapshotManifest,
  rediscovered: ReferencedInternalAssets,
  seenPaths: Set<string>,
): string[] {
  const issues: string[] = [];
  if (manifest.manifestVersion !== 3 && manifest.manifestVersion !== 4) return issues;

  if (!Array.isArray(manifest.internalReferences)) {
    issues.push(`Manifest version ${manifest.manifestVersion} is missing mandatory internalReferences array`);
    return issues;
  }

  const entries = manifest.internalReferences;
  const actual = rediscovered.entries ?? [];

  // In manifest v4, all internal references in the staged database must be canonical-relative
  if (manifest.manifestVersion === 4) {
    for (const act of actual) {
      if (act.refType !== "canonical-relative") {
        issues.push(`Unnormalized profile-absolute reference in manifest v4 database: ${act.rawPath}`);
      }
    }
  }

  const actualByLocator = new Map<string, DiscoveredAssetReference>();
  for (const act of actual) {
    const actTable = act.table ?? "tasks";
    const actRecordId = act.recordId ?? act.taskId ?? "";
    const actCol = act.column ?? act.field;
    const actKey = act.jsonPath
      ? `${actTable}:${actRecordId}:${actCol}:${act.jsonPath}`
      : `${actTable}:${actRecordId}:${actCol}:${act.itemIndex}`;
    actualByLocator.set(actKey, act);
  }

  const seenLocators = new Map<string, SnapshotReferenceEntry>();
  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    if (!entry || typeof entry !== "object") {
      issues.push(`Invalid internalReferences entry at index ${idx}: must be an object`);
      continue;
    }

    const table = entry.table ?? "tasks";
    if (table !== "tasks") {
      issues.push(`Unsupported table in internal reference mapping: ${table}`);
    }

    const col = entry.column ?? entry.sourceField;
    if (!col || !["refs", "attachments", "sent_files", "draft", "backlog"].includes(col)) {
      issues.push(`Unsupported column in internal reference mapping: ${String(col)}`);
    }

    const recordId = entry.recordId ?? entry.taskId;
    if (typeof recordId !== "string" || !recordId.trim()) {
      issues.push(`Missing recordId in internal reference mapping at index ${idx}`);
    }

    const recordIdCol = entry.recordIdColumn ?? "id";
    if (recordIdCol !== "id") {
      issues.push(`Unsupported recordIdColumn in internal reference mapping: ${recordIdCol}`);
    }

    if (manifest.manifestVersion === 4) {
      if (typeof entry.jsonPath !== "string" || !parseJsonPathTokens(entry.jsonPath)) {
        issues.push(`Missing or malformed jsonPath in internal reference mapping at index ${idx}: ${String(entry.jsonPath)}`);
      }
      if (entry.refType !== "canonical-relative") {
        issues.push(`Invalid refType (${String(entry.refType)}) in manifest v4: all internal references must be canonical-relative`);
      }
    } else {
      if (
        entry.itemIndex === undefined ||
        typeof entry.itemIndex !== "number" ||
        !Number.isInteger(entry.itemIndex) ||
        entry.itemIndex < 0
      ) {
        issues.push(`Ambiguous reference mapping: missing or invalid itemIndex for ${String(recordId)}.${String(col)}`);
        continue;
      }
    }

    if (typeof entry.rawRefSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.rawRefSha256)) {
      issues.push(
        `Missing or malformed rawRefSha256 in internal reference mapping for ${String(recordId)}.${String(col)}`,
      );
    }

    if (typeof entry.canonicalPath !== "string" || !entry.canonicalPath.trim()) {
      issues.push(
        `Missing canonicalPath in internal reference mapping for ${String(recordId)}.${String(col)}`,
      );
    } else if (!seenPaths.has(entry.canonicalPath)) {
      issues.push(
        `Internal reference mapping targets asset missing from snapshot manifest: ${entry.canonicalPath}`,
      );
    }

    if (entry.relSubpath !== undefined && entry.relSubpath !== entry.canonicalPath) {
      issues.push(
        `Conflicting relSubpath (${entry.relSubpath}) vs canonicalPath (${entry.canonicalPath}) in internal reference mapping`,
      );
    }

    if (!["attachment", "screenshot", "issue-thread", "pipeline-run"].includes(entry.category)) {
      issues.push(`Invalid category (${String(entry.category)}) in internal reference mapping`);
    }

    if (entry.refType !== "canonical-relative" && entry.refType !== "profile-absolute") {
      issues.push(`Invalid refType (${String(entry.refType)}) in internal reference mapping`);
    }

    const locatorKey = entry.jsonPath
      ? `${table}:${String(recordId)}:${String(col)}:${entry.jsonPath}`
      : `${table}:${String(recordId)}:${String(col)}:${entry.itemIndex}`;

    if (seenLocators.has(locatorKey)) {
      issues.push(`Duplicate internal reference mapping or duplicate entry for locator ${locatorKey}`);
    } else {
      seenLocators.set(locatorKey, entry);
    }
  }

  // Verify every discovered database internal reference has an exact validated entry in manifest.internalReferences
  for (const [actKey, act] of actualByLocator.entries()) {
    let manifestEntry = seenLocators.get(actKey);
    if (!manifestEntry && act.itemIndex !== undefined) {
      const legacyKey = `${act.table ?? "tasks"}:${act.recordId ?? act.taskId ?? ""}:${act.column ?? act.field}:${act.itemIndex}`;
      manifestEntry = seenLocators.get(legacyKey);
    }

    if (!manifestEntry) {
      issues.push(
        `Manifest internalReferences is missing mandatory internal reference at ${actKey} (${act.canonicalPath})`,
      );
      continue;
    }

    const expectedSha = sha256Hex(act.rawPath);
    if (manifestEntry.rawRefSha256 !== expectedSha) {
      issues.push(
        `rawRefSha256 mismatch at ${actKey}: manifest has ${String(manifestEntry.rawRefSha256)}, database reference has ${expectedSha}`,
      );
    }
    if (
      manifestEntry.expectedOriginalValue !== undefined &&
      manifestEntry.expectedOriginalValue !== act.rawPath
    ) {
      issues.push(
        `expectedOriginalValue mismatch at ${actKey}: expected ${manifestEntry.expectedOriginalValue}, database has ${act.rawPath}`,
      );
    }
    if (manifestEntry.canonicalPath !== act.canonicalPath) {
      issues.push(
        `canonicalPath mismatch at ${actKey}: manifest has ${manifestEntry.canonicalPath}, database reference resolves to ${act.canonicalPath}`,
      );
    }
    if (manifestEntry.category !== act.category) {
      issues.push(
        `category mismatch at ${actKey}: manifest has ${manifestEntry.category}, database reference resolves to ${act.category}`,
      );
    }
    if (manifestEntry.refType !== act.refType) {
      issues.push(
        `refType mismatch at ${actKey}: manifest has ${manifestEntry.refType}, database reference resolves to ${act.refType}`,
      );
    }
    if (act.jsonPath && manifestEntry.jsonPath && manifestEntry.jsonPath !== act.jsonPath) {
      issues.push(
        `jsonPath mismatch at ${actKey}: manifest has ${String(manifestEntry.jsonPath)}, database structure requires ${String(act.jsonPath)}`,
      );
    }
  }

  // Reject extra entries in manifest.internalReferences that do not correspond to real internal database references
  for (const [locKey, entry] of seenLocators.entries()) {
    let hasActual = actualByLocator.has(locKey);
    if (!hasActual && entry.itemIndex !== undefined) {
      const legacyKey = `${entry.table ?? "tasks"}:${entry.recordId ?? entry.taskId ?? ""}:${entry.column ?? entry.sourceField}:${entry.itemIndex}`;
      hasActual = actualByLocator.has(legacyKey);
    }
    if (!hasActual) {
      issues.push(
        `Manifest internalReferences contains extra entry not present in database or non-internal reference at ${locKey} (${entry.canonicalPath})`,
      );
    }
  }

  if (entries.length !== actual.length && issues.length === 0) {
    issues.push(
      `Manifest internalReferences count (${entries.length}) does not match discovered database internal references (${actual.length})`,
    );
  }

  return issues;
}

export class BackupManager {
  private readonly db: Database;
  private readonly dataDir: string;
  private readonly canonicalDataDir: string;
  private readonly dbParentDir?: string;
  private readonly knowledgeRootDir: string;
  private readonly attachmentsRootDir: string;
  private readonly screenshotsRootDir: string;
  private readonly issueThreadsRootDir: string;
  private readonly pipelineRunsRootDir: string;
  private readonly appVersion: string | null;
  private readonly now: () => number;
  private readonly backupCore: BackupCore;

  constructor(options: BackupManagerOptions) {
    this.db = options.db;

    const layout = validateSourceProfileLayout({
      dbFilename: options.db.filename,
      dataDir: options.dataDir,
      knowledgeRootDir: options.knowledgeRootDir,
      attachmentsRootDir: options.attachmentsRootDir,
      screenshotsRootDir: options.screenshotsRootDir,
      issueThreadsRootDir: options.issueThreadsRootDir,
      pipelineRunsRootDir: options.pipelineRunsRootDir,
    });

    this.dataDir = layout.dataDir;
    this.canonicalDataDir = layout.canonicalDataDir;
    this.dbParentDir = layout.dbParentDir;
    this.knowledgeRootDir = layout.knowledgeRootDir;
    this.attachmentsRootDir = layout.attachmentsRootDir;
    this.screenshotsRootDir = layout.screenshotsRootDir;
    this.issueThreadsRootDir = layout.issueThreadsRootDir;
    this.pipelineRunsRootDir = layout.pipelineRunsRootDir;
    this.appVersion =
      options.appVersion !== undefined
        ? options.appVersion
        : (typeof pkg?.version === "string" ? pkg.version : null);
    this.now = options.now ?? Date.now;
    this.backupCore = options.backupCore ?? new BackupCore(this.db);
  }

  /**
   * Package a complete, consistent, verified snapshot of ForgeOrbit application data.
   */
  async createSnapshot(options: CreateSnapshotOptions = {}): Promise<SnapshotResult> {
    const startedAt = performance.now();
    const nowMs = this.now();
    const createDir = options.createDirectory ?? false;
    const maxRetries = options.maxRetries ?? 2;
    const manifestVersion = options.manifestVersion ?? 4;

    // Resolve target path
    let resolvedDest: string;
    let parentDir: string;

    if (options.destinationPath) {
      if (
        typeof options.destinationPath !== "string" ||
        !options.destinationPath.trim() ||
        options.destinationPath.includes("\0")
      ) {
        throw new BackupManagerError(
          "Invalid snapshot destination path: must be a non-empty string without null bytes.",
          "INVALID_PATH",
        );
      }
      resolvedDest = path.resolve(options.destinationPath);
      parentDir = path.dirname(resolvedDest);
    } else if (options.destinationDir) {
      if (
        typeof options.destinationDir !== "string" ||
        !options.destinationDir.trim() ||
        options.destinationDir.includes("\0")
      ) {
        throw new BackupManagerError(
          "Invalid snapshot destination directory: must be a non-empty string.",
          "INVALID_PATH",
        );
      }
      parentDir = path.resolve(options.destinationDir);
      // Default name prefix will be computed per snapshot id below
      resolvedDest = "";
    } else {
      throw new BackupManagerError(
        "Either destinationPath or destinationDir must be specified.",
        "INVALID_PATH",
      );
    }

    if (resolvedDest) {
      if (pathExistsOrSymlink(resolvedDest)) {
        throw new BackupManagerError(
          `Snapshot destination already exists: ${resolvedDest}`,
          "TARGET_EXISTS",
        );
      }
      const auxCheck = isSqliteAuxiliaryOrSamePath(this.db.filename, resolvedDest);
      if (auxCheck.isSame) {
        throw new BackupManagerError(
          `Snapshot destination cannot be the same as the source database: ${resolvedDest}`,
          "SAME_AS_SOURCE",
        );
      }
      if (auxCheck.isAuxiliary) {
        throw new BackupManagerError(
          `Snapshot destination cannot target an SQLite auxiliary file of the source database (${auxCheck.auxiliaryType}): ${resolvedDest}`,
          "INVALID_PATH",
        );
      }
    }

    if (!pathExistsOrSymlink(parentDir)) {
      if (createDir) {
        try {
          mkdirSync(parentDir, { recursive: true, mode: 0o700 });
          try {
            chmodSync(parentDir, 0o700);
          } catch {
            /* best effort */
          }
        } catch (err) {
          throw new BackupManagerError(
            `Failed to create destination directory ${parentDir}: ${(err as Error).message}`,
            "IO_ERROR",
            err,
          );
        }
      } else {
        throw new BackupManagerError(
          `Destination parent directory does not exist: ${parentDir}`,
          "DIRECTORY_NOT_FOUND",
        );
      }
    } else {
      const parentStat = lstatSync(parentDir);
      if (parentStat.isSymbolicLink()) {
        throw new BackupManagerError(
          `Destination parent directory cannot be a symbolic link: ${parentDir}`,
          "UNTRUSTED_SYMLINK",
        );
      }
      if (!parentStat.isDirectory()) {
        throw new BackupManagerError(
          `Destination parent is not a directory: ${parentDir}`,
          "INVALID_PATH",
        );
      }
    }

    const syncFileFn = options.fs?.syncFile ?? syncFile;
    const syncDirFn = options.fs?.syncDirectory ?? syncDirectory;

    // Bounded retry loop for handling concurrent knowledge pruning or updates (P2-6)
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const snapshotId = randomUUID();
      const currentDest = resolvedDest || path.join(parentDir, formatDefaultSnapshotName(nowMs, snapshotId));

      if (pathExistsOrSymlink(currentDest)) {
        throw new BackupManagerError(
          `Snapshot destination already exists: ${currentDest}`,
          "TARGET_EXISTS",
        );
      }

      // Staging directory in same filesystem - created exclusively (no recursive)
      const stagingName = `.${path.basename(currentDest)}.fo-snapshot.${snapshotId}.tmp`;
      const stagingDir = path.join(parentDir, stagingName);

      try {
        mkdirSync(stagingDir, { mode: 0o700 });
      } catch (err) {
        throw new BackupManagerError(
          `Failed to create staging directory ${stagingDir}: ${(err as Error).message}`,
          "IO_ERROR",
          err,
        );
      }

      let stagingSucceeded = false;
      let lockFd: number | null = null;
      try {
        try {
          chmodSync(stagingDir, 0o700);
        } catch (chmodErr) {
          throw new BackupManagerError(
            `Failed to set private permissions on staging directory ${stagingDir}: ${(chmodErr as Error).message}`,
            "IO_ERROR",
            chmodErr,
          );
        }

        const lockPath = path.join(stagingDir, STAGING_LOCK_FILENAME);
        try {
          lockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
          if (lockFd !== null) {
            tryAcquireFlock(lockFd);
          }
        } catch {
          /* best effort */
        }

        const metadata: StagingOwnershipMetadata = {
          version: 1,
          subsystem: "backup-manager",
          operationId: snapshotId,
          runnerOperationId: options.runnerOperationId,
          pid: process.pid,
          createdAt: nowMs,
          state: "preparing",
          targetPath: currentDest,
        };
        writeStagingOwnershipMetadata(stagingDir, metadata, false);

        metadata.state = "writing";
        writeStagingOwnershipMetadata(stagingDir, metadata, false);

        await options.onStagingPrepared?.(stagingDir);

        // Phase 1: Database backup via BackupCore
        const stagingDbPath = path.join(stagingDir, "database.sqlite");
        let dbResult: BackupResult;
        try {
          dbResult = await this.backupCore.createBackup(stagingDbPath, {
            createDirectory: false,
            now: this.now,
            fs: options.fs,
          });
        } catch (err) {
          throw new BackupManagerError(
            `Database snapshot failed: ${(err as Error).message}`,
            "SQLITE_ERROR",
            err,
          );
        }

        await options.afterDatabaseBackup?.(stagingDir);

        // Cooperative event-loop yield
        await new Promise((resolve) => setImmediate(resolve));

        // Verify document-revision consistency on snapshotted database (P2-7)
        const docConsistency = verifyDocumentRevisionConsistency(stagingDbPath);
        if (!docConsistency.ok) {
          throw new BackupManagerError(
            `Database document-revision consistency check failed: ${docConsistency.issues.join("; ")}`,
            "INCONSISTENT_KNOWLEDGE",
          );
        }

        // Phase 2: Knowledge files inspection and packaging
        const revisions = getReferencedKnowledgeRevisions(stagingDbPath);
        const manifestFiles: SnapshotManifestFile[] = [
          {
            path: "database.sqlite",
            bytes: dbResult.bytes,
            sha256: dbResult.sha256,
            category: "database",
          },
        ];

        if (revisions.length > 0) {
          // Validate intermediate symlinks on knowledge root
          if (!pathExistsOrSymlink(this.knowledgeRootDir)) {
            throw new BackupManagerError(
              `Knowledge root directory not found: ${this.knowledgeRootDir}`,
              "DIRECTORY_NOT_FOUND",
            );
          }
          const rootStat = lstatSync(this.knowledgeRootDir);
          if (rootStat.isSymbolicLink()) {
            throw new BackupManagerError(
              `Untrusted symlink detected in knowledge root: ${this.knowledgeRootDir}`,
              "UNTRUSTED_SYMLINK",
            );
          }
          if (!rootStat.isDirectory()) {
            throw new BackupManagerError(
              `Knowledge root is not a directory: ${this.knowledgeRootDir}`,
              "INVALID_PATH",
            );
          }
          const realKnowledgeRoot = realpathSync(this.knowledgeRootDir);

          const bodiesDir = path.join(this.knowledgeRootDir, "bodies");
          if (pathExistsOrSymlink(bodiesDir)) {
            const bodiesStat = lstatSync(bodiesDir);
            if (bodiesStat.isSymbolicLink()) {
              throw new BackupManagerError(
                `Untrusted symlink detected in knowledge storage: ${bodiesDir}`,
                "UNTRUSTED_SYMLINK",
              );
            }
          }

          const stagingKnowledgeBodiesDir = path.join(stagingDir, "knowledge", "bodies");
          mkdirSync(stagingKnowledgeBodiesDir, { recursive: true, mode: 0o700 });

          for (const rev of revisions) {
            if (!KNOWLEDGE_DOCUMENT_ID_RE.test(rev.document_id)) {
              throw new BackupManagerError(
                `Invalid knowledge document id format in snapshot: ${rev.document_id}`,
                "INCONSISTENT_KNOWLEDGE",
              );
            }
            if (!Number.isSafeInteger(rev.revision) || rev.revision < 1) {
              throw new BackupManagerError(
                `Invalid knowledge revision number in snapshot: ${rev.revision}`,
                "INCONSISTENT_KNOWLEDGE",
              );
            }

            const docDir = path.join(bodiesDir, rev.document_id);
            if (pathExistsOrSymlink(docDir)) {
              const docStat = lstatSync(docDir);
              if (docStat.isSymbolicLink()) {
                throw new BackupManagerError(
                  `Untrusted symlink detected in knowledge storage: ${docDir}`,
                  "UNTRUSTED_SYMLINK",
                );
              }
            }

            const sourceFile = path.join(
              this.knowledgeRootDir,
              "bodies",
              rev.document_id,
              `${rev.revision}.md`,
            );

            if (!pathExistsOrSymlink(sourceFile)) {
              throw new BackupManagerError(
                `Referenced knowledge file is missing on disk: bodies/${rev.document_id}/${rev.revision}.md`,
                "INCONSISTENT_KNOWLEDGE",
              );
            }

            const lstat = lstatSync(sourceFile);
            if (lstat.isSymbolicLink()) {
              throw new BackupManagerError(
                `Untrusted symlink detected in knowledge storage: ${sourceFile}`,
                "UNTRUSTED_SYMLINK",
              );
            }
            if (!lstat.isFile()) {
              throw new BackupManagerError(
                `Knowledge entry is not a regular file: ${sourceFile}`,
                "INCONSISTENT_KNOWLEDGE",
              );
            }

            // Ensure canonical containment
            try {
              const realSource = realpathSync(sourceFile);
              if (!realSource.startsWith(realKnowledgeRoot + path.sep)) {
                throw new BackupManagerError(
                  `Untrusted symlink detected in knowledge storage: ${sourceFile}`,
                  "UNTRUSTED_SYMLINK",
                );
              }
            } catch (canonErr) {
              if (canonErr instanceof BackupManagerError) throw canonErr;
            }

            if (lstat.size !== rev.byte_length) {
              throw new BackupManagerError(
                `Knowledge file size mismatch for ${rev.document_id} rev ${rev.revision}: expected ${rev.byte_length} bytes, found ${lstat.size}`,
                "INCONSISTENT_KNOWLEDGE",
              );
            }

            // Target relative path in snapshot (canonical POSIX format)
            const relPath = `knowledge/bodies/${rev.document_id}/${rev.revision}.md`;
            const targetFile = path.join(stagingDir, "knowledge", "bodies", rev.document_id, `${rev.revision}.md`);
            const targetDir = path.dirname(targetFile);

            if (!existsSync(targetDir)) {
              mkdirSync(targetDir, { recursive: true, mode: 0o700 });
            }

            copyFileSync(sourceFile, targetFile);
            try {
              chmodSync(targetFile, 0o600);
            } catch {
              /* best effort */
            }

            try {
              syncFileFn(targetFile);
              syncDirFn(targetDir);
            } catch (syncErr) {
              throw new BackupManagerError(
                `Failed to synchronize knowledge file ${targetFile}: ${(syncErr as Error).message}`,
                "IO_ERROR",
                syncErr,
              );
            }

            const actualSha = await computeFileSha256(targetFile);
            if (actualSha !== rev.content_sha256) {
              throw new BackupManagerError(
                `Knowledge file checksum mismatch for ${rev.document_id} rev ${rev.revision}: expected ${rev.content_sha256}, calculated ${actualSha}`,
                "INCONSISTENT_KNOWLEDGE",
              );
            }

            manifestFiles.push({
              path: relPath,
              bytes: lstat.size,
              sha256: actualSha,
              category: "knowledge",
            });
          }

          try {
            syncDirFn(stagingKnowledgeBodiesDir);
            syncDirFn(path.join(stagingDir, "knowledge"));
          } catch (syncErr) {
            throw new BackupManagerError(
              `Failed to synchronize knowledge directory: ${(syncErr as Error).message}`,
              "IO_ERROR",
              syncErr,
            );
          }
        }

        await options.afterKnowledgeCopy?.(stagingDir);

        // Phase 2.5: Durable application profile assets packaging (manifestVersion 2 and 3)
        let attachmentCount = 0;
        let screenshotCount = 0;
        let issueThreadCount = 0;
        let pipelineRunCount = 0;
        let referencedAssets: ReferencedInternalAssets | undefined;

        const resolvedDataDir = path.resolve(this.dataDir);
        let realDataDir = this.canonicalDataDir;
        try {
          if (existsSync(this.dataDir)) {
            realDataDir = realpathSync(this.dataDir);
          }
        } catch {
          /* best effort */
        }

        const sourceProfileRootSha256 = sha256Hex(resolvedDataDir);
        const rootAliases = expandMacosCanonicalAliases(resolvedDataDir);
        let sourceProfileRealSha256: string | undefined =
          this.dbParentDir &&
          this.dbParentDir !== resolvedDataDir &&
          !rootAliases.includes(this.dbParentDir)
            ? sha256Hex(this.dbParentDir)
            : realDataDir && realDataDir !== resolvedDataDir
              ? sha256Hex(realDataDir)
              : undefined;

        const extraAliasHashes: string[] = [];

        if (manifestVersion === 2 || manifestVersion === 3 || manifestVersion === 4) {
          referencedAssets = getReferencedInternalAssets(stagingDbPath, {
            dataDir: this.dataDir,
            attachmentsRootDir: this.attachmentsRootDir,
            screenshotsRootDir: this.screenshotsRootDir,
            issueThreadsRootDir: this.issueThreadsRootDir,
            pipelineRunsRootDir: this.pipelineRunsRootDir,
            sourceProfileRootSha256,
            sourceProfileRealSha256,
          });
          if (referencedAssets.crossProfileReferences && referencedAssets.crossProfileReferences.length > 0) {
            if (options.requireCompleteProfile) {
              throw new BackupManagerError(
                `Snapshot contains references to external profile assets: ${referencedAssets.crossProfileReferences.map((r) => r.rawPath).join(", ")}`,
                "INCONSISTENT_ASSET",
              );
            }
          }
          if (referencedAssets.discoveredAliasPrefixes) {
            for (const aliasPrefix of referencedAssets.discoveredAliasPrefixes) {
              if (!rootAliases.includes(aliasPrefix) && aliasPrefix !== realDataDir) {
                extraAliasHashes.push(sha256Hex(aliasPrefix));
                if (!sourceProfileRealSha256) {
                  sourceProfileRealSha256 = sha256Hex(aliasPrefix);
                }
              }
            }
          }
          const packagedPaths = new Set<string>();

          // 1. Package attachments
          if (pathExistsOrSymlink(this.attachmentsRootDir)) {
            const rootStat = lstatSync(this.attachmentsRootDir);
            if (rootStat.isSymbolicLink()) {
              throw new BackupManagerError(
                `Untrusted symlink detected in attachments root: ${this.attachmentsRootDir}`,
                "UNTRUSTED_SYMLINK",
              );
            }
            if (rootStat.isDirectory()) {
              const realAttRoot = realpathSync(this.attachmentsRootDir);
              const entries = readdirSync(this.attachmentsRootDir);
              for (const entry of entries) {
                if (entry.startsWith(".") || entry === "." || entry === "..") continue;
                const sourceFile = path.join(this.attachmentsRootDir, entry);
                const relPath = `attachments/${entry}`;
                await options.beforeAssetCopy?.(relPath, sourceFile);
                const targetFile = path.join(stagingDir, "attachments", entry);
                const copyRes = await copyAndVerifyAssetFile(
                  sourceFile,
                  targetFile,
                  realAttRoot,
                  syncFileFn,
                  syncDirFn,
                  (s, t) => options.duringAssetCopy?.(relPath, s, t),
                );
                manifestFiles.push({
                  path: relPath,
                  bytes: copyRes.bytes,
                  sha256: copyRes.sha256,
                  category: "attachment",
                });
                packagedPaths.add(relPath);
                attachmentCount++;
              }
              try {
                syncDirFn(path.join(stagingDir, "attachments"));
              } catch {
                /* best effort */
              }
            }
          }

          // Verify all referenced attachments were found on disk
          for (const att of referencedAssets.attachments) {
            if (!packagedPaths.has(att)) {
              throw new BackupManagerError(
                `Database references attachment file missing on disk: ${att}`,
                "INCONSISTENT_ASSET",
              );
            }
          }

          // 2. Package screenshots
          if (pathExistsOrSymlink(this.screenshotsRootDir)) {
            const rootStat = lstatSync(this.screenshotsRootDir);
            if (rootStat.isSymbolicLink()) {
              throw new BackupManagerError(
                `Untrusted symlink detected in screenshots root: ${this.screenshotsRootDir}`,
                "UNTRUSTED_SYMLINK",
              );
            }
            if (rootStat.isDirectory()) {
              const realScrRoot = realpathSync(this.screenshotsRootDir);
              const entries = readdirSync(this.screenshotsRootDir);
              for (const entry of entries) {
                if (entry.startsWith(".") || entry === "." || entry === "..") continue;
                const sourceFile = path.join(this.screenshotsRootDir, entry);
                const relPath = `screenshots/${entry}`;
                await options.beforeAssetCopy?.(relPath, sourceFile);
                const targetFile = path.join(stagingDir, "screenshots", entry);
                const copyRes = await copyAndVerifyAssetFile(
                  sourceFile,
                  targetFile,
                  realScrRoot,
                  syncFileFn,
                  syncDirFn,
                  (s, t) => options.duringAssetCopy?.(relPath, s, t),
                );
                manifestFiles.push({
                  path: relPath,
                  bytes: copyRes.bytes,
                  sha256: copyRes.sha256,
                  category: "screenshot",
                });
                packagedPaths.add(relPath);
                screenshotCount++;
              }
              try {
                syncDirFn(path.join(stagingDir, "screenshots"));
              } catch {
                /* best effort */
              }
            }
          }

          // Verify all referenced screenshots were found on disk
          for (const scr of referencedAssets.screenshots) {
            if (!packagedPaths.has(scr)) {
              throw new BackupManagerError(
                `Database references screenshot file missing on disk: ${scr}`,
                "INCONSISTENT_ASSET",
              );
            }
          }

          // 3. Package issue threads
          if (pathExistsOrSymlink(this.issueThreadsRootDir)) {
            const rootStat = lstatSync(this.issueThreadsRootDir);
            if (rootStat.isSymbolicLink()) {
              throw new BackupManagerError(
                `Untrusted symlink detected in issue-threads root: ${this.issueThreadsRootDir}`,
                "UNTRUSTED_SYMLINK",
              );
            }
            if (rootStat.isDirectory()) {
              const realIssRoot = realpathSync(this.issueThreadsRootDir);
              const taskDirs = readdirSync(this.issueThreadsRootDir);
              for (const taskId of taskDirs) {
                if (taskId.startsWith(".") || taskId === "." || taskId === "..") continue;
                const taskDirPath = path.join(this.issueThreadsRootDir, taskId);
                let st: ReturnType<typeof lstatSync>;
                try {
                  st = lstatSync(taskDirPath);
                } catch {
                  continue;
                }
                if (st.isSymbolicLink() || !st.isDirectory()) continue;
                const files = readdirSync(taskDirPath);
                for (const file of files) {
                  if (file.startsWith(".") || file === "." || file === "..") continue;
                  const sourceFile = path.join(taskDirPath, file);
                  const relPath = `issue-threads/${taskId}/${file}`;
                  await options.beforeAssetCopy?.(relPath, sourceFile);
                  const targetFile = path.join(stagingDir, "issue-threads", taskId, file);
                  const copyRes = await copyAndVerifyAssetFile(
                    sourceFile,
                    targetFile,
                    realIssRoot,
                    syncFileFn,
                    syncDirFn,
                    (s, t) => options.duringAssetCopy?.(relPath, s, t),
                  );
                  manifestFiles.push({
                    path: relPath,
                    bytes: copyRes.bytes,
                    sha256: copyRes.sha256,
                    category: "issue-thread",
                  });
                  packagedPaths.add(relPath);
                  issueThreadCount++;
                }
                try {
                  syncDirFn(path.join(stagingDir, "issue-threads", taskId));
                } catch {
                  /* best effort */
                }
              }
              try {
                syncDirFn(path.join(stagingDir, "issue-threads"));
              } catch {
                /* best effort */
              }
            }
          }

          // Verify all referenced issue threads were found on disk
          for (const iss of referencedAssets.issueThreads) {
            if (!packagedPaths.has(iss)) {
              throw new BackupManagerError(
                `Database references issue thread file missing on disk: ${iss}`,
                "INCONSISTENT_ASSET",
              );
            }
          }

          // 4. Package pipeline runs
          if (pathExistsOrSymlink(this.pipelineRunsRootDir)) {
            const rootStat = lstatSync(this.pipelineRunsRootDir);
            if (rootStat.isSymbolicLink()) {
              throw new BackupManagerError(
                `Untrusted symlink detected in pipeline-runs root: ${this.pipelineRunsRootDir}`,
                "UNTRUSTED_SYMLINK",
              );
            }
            if (rootStat.isDirectory()) {
              const realPipeRoot = realpathSync(this.pipelineRunsRootDir);
              const parentDirs = readdirSync(this.pipelineRunsRootDir);
              for (const parentId of parentDirs) {
                if (parentId.startsWith(".") || parentId === "." || parentId === "..") continue;
                const parentDirPath = path.join(this.pipelineRunsRootDir, parentId);
                let st: ReturnType<typeof lstatSync>;
                try {
                  st = lstatSync(parentDirPath);
                } catch {
                  continue;
                }
                if (st.isSymbolicLink() || !st.isDirectory()) continue;
                const files = readdirSync(parentDirPath);
                for (const file of files) {
                  if (file.startsWith(".") || file === "." || file === ".." || !file.endsWith(".json")) continue;
                  const sourceFile = path.join(parentDirPath, file);
                  const relPath = `pipeline-runs/${parentId}/${file}`;
                  await options.beforeAssetCopy?.(relPath, sourceFile);
                  const targetFile = path.join(stagingDir, "pipeline-runs", parentId, file);
                  const copyRes = await copyAndVerifyAssetFile(
                    sourceFile,
                    targetFile,
                    realPipeRoot,
                    syncFileFn,
                    syncDirFn,
                    (s, t) => options.duringAssetCopy?.(relPath, s, t),
                  );
                  manifestFiles.push({
                    path: relPath,
                    bytes: copyRes.bytes,
                    sha256: copyRes.sha256,
                    category: "pipeline-run",
                  });
                  packagedPaths.add(relPath);
                  pipelineRunCount++;
                }
                try {
                  syncDirFn(path.join(stagingDir, "pipeline-runs", parentId));
                } catch {
                  /* best effort */
                }
              }
              try {
                syncDirFn(path.join(stagingDir, "pipeline-runs"));
              } catch {
                /* best effort */
              }
            }
          }

          // Verify all referenced pipeline runs were found on disk
          for (const pipe of referencedAssets.pipelineRuns) {
            if (!packagedPaths.has(pipe)) {
              throw new BackupManagerError(
                `Database references pipeline run handoff missing on disk: ${pipe}`,
                "INCONSISTENT_ASSET",
              );
            }
          }

          await options.afterAssetsCopy?.(stagingDir);
        }

        // Cooperative event-loop yield
        await new Promise((resolve) => setImmediate(resolve));

        // For Manifest v4: normalize internal references inside stagingDbPath to canonical-relative
        if (manifestVersion === 4 && referencedAssets?.entries && referencedAssets.entries.length > 0) {
          const normDb = new Database(stagingDbPath);
          try {
            normDb.run("BEGIN IMMEDIATE TRANSACTION;");
            const grouped = new Map<string, { taskId: string; col: string; entries: typeof referencedAssets.entries }>();
            for (const entry of referencedAssets.entries) {
              const taskId = entry.recordId ?? entry.taskId ?? "";
              const col = entry.column ?? entry.field;
              const key = `${taskId}::${col}`;
              let g = grouped.get(key);
              if (!g) {
                g = { taskId, col, entries: [] };
                grouped.set(key, g);
              }
              g.entries.push(entry);
            }

            for (const g of grouped.values()) {
              const row = normDb
                .query<{ val: string | null }, [string]>(`SELECT ${g.col} as val FROM tasks WHERE id = ?;`)
                .get(g.taskId);
              if (!row || !row.val) continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(row.val);
              } catch {
                continue;
              }

              for (const entry of g.entries) {
                if (entry.jsonPath) {
                  setValueAtJsonPath(parsed, entry.jsonPath, entry.canonicalPath);
                }
              }

              normDb
                .query(`UPDATE tasks SET ${g.col} = ? WHERE id = ?;`)
                .run(JSON.stringify(parsed), g.taskId);
            }

            normDb.run("COMMIT;");
            const chk = normDb
              .query<{ integrity_check: string }, []>("PRAGMA integrity_check;")
              .all();
            if (chk.length !== 1 || chk[0]?.integrity_check !== "ok") {
              throw new BackupManagerError(
                `Integrity check failed after reference normalization in staging database: ${chk.map((c) => c.integrity_check).join("; ")}`,
                "SQLITE_ERROR",
              );
            }
          } finally {
            normDb.close();
          }

          const newSha = await computeFileSha256(stagingDbPath);
          const newBytes = lstatSync(stagingDbPath).size;
          manifestFiles[0] = {
            path: "database.sqlite",
            bytes: newBytes,
            sha256: newSha,
            category: "database",
          };
        }

        // Persist the snapshot-format marker into the staged database for every
        // manifest version. This records the format the data was demonstrably
        // created under so a later manifest-only version downgrade is detectable.
        {
          const markerDb = new Database(stagingDbPath);
          try {
            writeSnapshotFormatMarker(markerDb, manifestVersion);
          } finally {
            markerDb.close();
          }
          const markerSha = await computeFileSha256(stagingDbPath);
          const markerBytes = lstatSync(stagingDbPath).size;
          manifestFiles[0] = {
            path: "database.sqlite",
            bytes: markerBytes,
            sha256: markerSha,
            category: "database",
          };
        }

        // Brain is packaged only for manifest v4. The lock is held inside
        // captureBrainSnapshot while the committed rows and Markdown are read.
        // v1–v3 snapshots stay free of Brain files.
        let brainRecord: SnapshotBrainRecord | undefined;
        if (manifestVersion === 4) {
          let registeredProjectPaths: string[] = [];
          const projectDb = new Database(stagingDbPath, { readonly: true });
          try {
            const rows = projectDb.query("SELECT path FROM projects").all() as { path: string }[];
            registeredProjectPaths = rows.map((row) => row.path);
          } catch {
            registeredProjectPaths = [];
          } finally {
            projectDb.close();
          }
          try {
            const captured = captureBrainSnapshot({
              sourceRoot: path.join(this.dataDir, "brain"),
              stagingDir,
              registeredProjectPaths,
            });
            brainRecord = captured.record;
            for (const file of captured.files) manifestFiles.push(file);
          } catch (error) {
            if (error instanceof BrainSnapshotError && error.code === "busy") {
              throw new BackupManagerError(error.message, "INCONSISTENT_BRAIN", error);
            }
            if (error instanceof BrainSnapshotError && error.code === "symlink") {
              throw new BackupManagerError(error.message, "UNTRUSTED_SYMLINK", error);
            }
            throw new BackupManagerError(
              error instanceof Error ? error.message : "Brain snapshot failed",
              "VERIFICATION_FAILED",
              error,
            );
          }
        }

        // Phase 3: Manifest compilation
        manifestFiles.sort((a, b) => a.path.localeCompare(b.path));

        const totalBytes = manifestFiles.reduce((acc, f) => acc + f.bytes, 0);
        const docCount = getKnowledgeDocumentCount(stagingDbPath);
        // Schema version MUST be read from the snapshotted database, NOT the live database (P2-5)
        const schemaVer = getDatabaseSchemaVersion(stagingDbPath);

        if (schemaVer !== null && !isSupportedSchemaVersion(schemaVer)) {
          throw new BackupManagerError(
            `Unsupported or unknown future database schema version: ${schemaVer}`,
            "VERIFICATION_FAILED",
          );
        }

        const manifestInternalReferences: SnapshotReferenceEntry[] | undefined =
          (manifestVersion === 3 || manifestVersion === 4) && referencedAssets?.entries
            ? referencedAssets.entries.map((e) => ({
                table: e.table ?? "tasks",
                recordId: e.recordId ?? e.taskId ?? undefined,
                recordIdColumn: "id",
                column: e.column ?? e.field,
                canonicalPath: e.canonicalPath,
                category: e.category,
                taskId: e.taskId ?? undefined,
                sourceField: e.field,
                refType: manifestVersion === 4 ? "canonical-relative" : e.refType,
                itemIndex: e.itemIndex,
                jsonPath: e.jsonPath,
                relSubpath: e.canonicalPath,
                rawRefSha256: manifestVersion === 4 ? sha256Hex(e.canonicalPath) : sha256Hex(e.rawPath),
                expectedOriginalValue:
                  manifestVersion === 4
                    ? e.canonicalPath
                    : e.refType === "canonical-relative"
                      ? e.canonicalPath
                      : undefined,
              }))
            : undefined;

        const originMeta: SnapshotOriginMetadata = {
          sourceProfileRootSha256,
          sourceProfileBasename: path.basename(resolvedDataDir),
          sourceProfileRealSha256,
          sourceProfileAliasSha256s: extraAliasHashes.length > 0 ? extraAliasHashes : undefined,
        };

        const effectiveMetadata: Record<string, unknown> = {
          ...options.manifestMetadata,
          ...(options.runnerOperationId ? { runnerOperationId: options.runnerOperationId } : {}),
        };
        const hasMetadata = Object.keys(effectiveMetadata).length > 0;
        const manifestMetadata = hasMetadata ? effectiveMetadata : undefined;

        // Staging manifest begins with verified: false until full bundle verification completes
        const manifest: SnapshotManifest = manifestVersion === 4
          ? {
              manifestVersion: 4,
              snapshotId,
              appVersion: this.appVersion,
              schemaVersion: schemaVer,
              createdAt: nowMs,
              verified: false,
              coverage: "complete-profile",
              categories: [
                "database",
                "knowledge",
                "attachment",
                "screenshot",
                "issue-thread",
                "pipeline-run",
              ],
              files: manifestFiles,
              stats: {
                totalBytes,
                fileCount: manifestFiles.length,
                knowledgeDocumentCount: docCount,
                knowledgeRevisionCount: revisions.length,
                attachmentCount,
                screenshotCount,
                issueThreadCount,
                pipelineRunCount,
              },
              origin: originMeta,
              internalReferences: manifestInternalReferences,
              metadata: manifestMetadata,
            }
          : manifestVersion === 3
          ? {
              manifestVersion: 3,
              snapshotId,
              appVersion: this.appVersion,
              schemaVersion: schemaVer,
              createdAt: nowMs,
              verified: false,
              coverage: "complete-profile",
              categories: [
                "database",
                "knowledge",
                "attachment",
                "screenshot",
                "issue-thread",
                "pipeline-run",
              ],
              files: manifestFiles,
              stats: {
                totalBytes,
                fileCount: manifestFiles.length,
                knowledgeDocumentCount: docCount,
                knowledgeRevisionCount: revisions.length,
                attachmentCount,
                screenshotCount,
                issueThreadCount,
                pipelineRunCount,
              },
              origin: originMeta,
              internalReferences: manifestInternalReferences,
              metadata: manifestMetadata,
            }
          : manifestVersion === 2
          ? {
              manifestVersion: 2,
              snapshotId,
              appVersion: this.appVersion,
              schemaVersion: schemaVer,
              createdAt: nowMs,
              verified: false,
              coverage: "complete-profile",
              categories: [
                "database",
                "knowledge",
                "attachment",
                "screenshot",
                "issue-thread",
                "pipeline-run",
              ],
              files: manifestFiles,
              stats: {
                totalBytes,
                fileCount: manifestFiles.length,
                knowledgeDocumentCount: docCount,
                knowledgeRevisionCount: revisions.length,
                attachmentCount,
                screenshotCount,
                issueThreadCount,
                pipelineRunCount,
              },
              metadata: manifestMetadata,
            }
          : {
              manifestVersion: 1,
              snapshotId,
              appVersion: this.appVersion,
              schemaVersion: schemaVer,
              createdAt: nowMs,
              verified: false,
              coverage: "legacy-database-knowledge",
              categories: ["database", "knowledge"],
              files: manifestFiles,
              stats: {
                totalBytes,
                fileCount: manifestFiles.length,
                knowledgeDocumentCount: docCount,
                knowledgeRevisionCount: revisions.length,
                attachmentCount: 0,
                screenshotCount: 0,
                issueThreadCount: 0,
                pipelineRunCount: 0,
              },
              metadata: manifestMetadata,
            };

        if (manifest.manifestVersion === 4 && brainRecord) {
          manifest.brain = brainRecord;
          if (brainRecord.coverage === "included" && manifest.categories) {
            manifest.categories = [...manifest.categories, "brain"];
          }
        }

        const manifestPath = path.join(stagingDir, "manifest.json");
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
        try {
          syncFileFn(manifestPath);
          syncDirFn(stagingDir);
        } catch (syncErr) {
          throw new BackupManagerError(
            `Failed to synchronize manifest.json: ${(syncErr as Error).message}`,
            "IO_ERROR",
            syncErr,
          );
        }

        await options.afterManifestWrite?.(stagingDir);

        // Phase 4: Full verification pass of the completed staging bundle
        metadata.state = "verifying";
        writeStagingOwnershipMetadata(stagingDir, metadata, false);

        const verification = await BackupManager.verifySnapshot(stagingDir, { isStaging: true });
        if (!verification.ok) {
          throw new BackupManagerError(
            `Snapshot bundle verification failed prior to publish: ${verification.issues.join("; ")}`,
            "VERIFICATION_FAILED",
          );
        }

        // Now that verification has fully passed, mark verified: true in manifest and flush
        manifest.verified = true;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
        try {
          syncFileFn(manifestPath);
          syncDirFn(stagingDir);
        } catch (syncErr) {
          throw new BackupManagerError(
            `Failed to synchronize final manifest.json: ${(syncErr as Error).message}`,
            "IO_ERROR",
            syncErr,
          );
        }

        await options.beforePublish?.(stagingDir);

        // Collision guard right before atomic publish
        if (pathExistsOrSymlink(currentDest)) {
          throw new BackupManagerError(
            `Snapshot destination was created during execution: ${currentDest}`,
            "TARGET_EXISTS",
          );
        }

        // Phase 5: Atomic publish via exclusive no-replace directory publication
        metadata.state = "publishing";
        writeStagingOwnershipMetadata(stagingDir, metadata, false);

        // Remove staging metadata and lock before atomic publish so final snapshot is clean
        if (lockFd !== null) {
          releaseFlock(lockFd);
          try {
            closeSync(lockFd);
          } catch {
            /* ignore */
          }
          lockFd = null;
        }
        try {
          unlinkSync(path.join(stagingDir, STAGING_LOCK_FILENAME));
        } catch {
          /* best effort */
        }
        try {
          unlinkSync(path.join(stagingDir, ".forgeorbit-ownership.json"));
        } catch {
          /* best effort */
        }
        try {
          syncDirFn(stagingDir);
        } catch {
          /* best effort */
        }

        const publishFn = options.publishDir ?? publishDirectoryExclusive;
        try {
          publishFn(stagingDir, currentDest);
          stagingSucceeded = true;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === "EEXIST" || code === "TARGET_EXISTS" || pathExistsOrSymlink(currentDest)) {
            throw new BackupManagerError(
              `Snapshot destination already exists: ${currentDest}`,
              "TARGET_EXISTS",
            );
          }
          throw new BackupManagerError(
            `Failed to publish snapshot to ${currentDest}: ${(err as Error).message}`,
            "IO_ERROR",
            err,
          );
        }

        try {
          chmodSync(currentDest, 0o700);
        } catch {
          /* best effort */
        }

        try {
          syncDirFn(parentDir);
        } catch (syncErr) {
          throw new BackupManagerError(
            `Failed to synchronize snapshot directory: ${(syncErr as Error).message}`,
            "IO_ERROR",
            syncErr,
          );
        }

        await options.afterPublish?.(currentDest);

        const durationMs = Math.round(performance.now() - startedAt);

        return {
          path: currentDest,
          snapshotId,
          manifest,
          durationMs,
        };
      } catch (attemptErr: unknown) {
        if (!stagingSucceeded) {
          try {
            if (existsSync(stagingDir)) {
              rmSync(stagingDir, { recursive: true, force: true });
            }
          } catch {
            /* best effort cleanup */
          }
        }

        // If error is due to concurrent knowledge or asset mutation (pruning or update race)
        // and bounded retries remain, notify hook, yield, and retry (P2-6, R4C)
        if (
          attemptErr instanceof BackupManagerError &&
          (attemptErr.code === "INCONSISTENT_KNOWLEDGE" ||
            attemptErr.code === "INCONSISTENT_ASSET" ||
            attemptErr.code === "INCONSISTENT_BRAIN") &&
          attempt < maxRetries
        ) {
          options.onRetry?.(attempt + 1, attemptErr);
          await new Promise((resolve) => setImmediate(resolve));
          continue;
        }

        throw attemptErr;
      } finally {
        if (lockFd !== null) {
          releaseFlock(lockFd);
          try {
            closeSync(lockFd);
          } catch {
            /* ignore */
          }
        }
      }
    }

    throw new BackupManagerError(
      "Snapshot creation failed after maximum bounded retries.",
      "INCONSISTENT_ASSET",
    );
  }

  /**
   * Verify an existing snapshot directory independently without modifying application data.
   */
  async verifySnapshot(snapshotPath: string): Promise<SnapshotVerificationResult> {
    return BackupManager.verifySnapshot(snapshotPath);
  }

  /**
   * Safely scan a directory and clean up orphan staging directories owned by BackupManager.
   */
  cleanIncompleteSnapshots(directory: string): { cleaned: string[]; errors: string[] } {
    return BackupManager.cleanIncompleteSnapshots(directory);
  }

  /**
   * Static implementation of independent snapshot verification.
   */
  static async verifySnapshot(
    snapshotPath: string,
    options?: { isStaging?: boolean; requireCompleteProfile?: boolean },
  ): Promise<SnapshotVerificationResult> {
    const issues: string[] = [];
    let filesChecked = 0;
    let totalBytes = 0;

    if (
      typeof snapshotPath !== "string" ||
      !snapshotPath.trim() ||
      snapshotPath.includes("\0")
    ) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: ["Invalid snapshot path."],
      };
    }

    const resolved = path.resolve(snapshotPath);
    if (!pathExistsOrSymlink(resolved)) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [`Snapshot directory not found: ${resolved}`],
      };
    }

    const dirStat = lstatSync(resolved);
    if (dirStat.isSymbolicLink()) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [`Snapshot path is a symlink: ${resolved}`],
      };
    }
    if (!dirStat.isDirectory()) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [`Snapshot path is not a directory: ${resolved}`],
      };
    }

    // Step 1: Read and validate manifest.json
    const manifestPath = path.join(resolved, "manifest.json");
    if (!pathExistsOrSymlink(manifestPath)) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: ["Missing manifest.json in snapshot directory."],
      };
    }

    let manifestStat: ReturnType<typeof lstatSync>;
    try {
      manifestStat = lstatSync(manifestPath);
    } catch (err) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [`Failed to stat manifest.json: ${(err as Error).message}`],
      };
    }

    if (manifestStat.isSymbolicLink()) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: ["manifest.json cannot be a symbolic link."],
      };
    }
    if (!manifestStat.isFile()) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: ["manifest.json is not a regular file (special file / FIFO)."],
      };
    }
    if (manifestStat.size === 0) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: ["manifest.json is empty."],
      };
    }
    if (manifestStat.size > MAX_MANIFEST_SIZE_BYTES) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [
          `manifest.json exceeds maximum size limit of ${MAX_MANIFEST_SIZE_BYTES} bytes (${manifestStat.size} bytes).`,
        ],
      };
    }

    let manifestRaw: string;
    try {
      manifestRaw = await Bun.file(manifestPath).text();
    } catch (err) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [`Failed to read manifest.json: ${(err as Error).message}`],
      };
    }

    let manifest: SnapshotManifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (err) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: [`Corrupt JSON in manifest.json: ${(err as Error).message}`],
      };
    }

    if (
      !manifest ||
      typeof manifest !== "object" ||
      (manifest.manifestVersion !== 1 &&
        manifest.manifestVersion !== 2 &&
        manifest.manifestVersion !== 3 &&
        manifest.manifestVersion !== 4) ||
      typeof manifest.snapshotId !== "string" ||
      !Array.isArray(manifest.files)
    ) {
      return {
        ok: false,
        filesChecked: 0,
        totalBytes: 0,
        issues: ["Invalid manifest.json structure or unsupported manifestVersion."],
      };
    }

    if (!options?.isStaging && manifest.verified !== true) {
      issues.push("Snapshot manifest indicates snapshot is unverified or incomplete.");
    }

    // Validate coverage and mandatory categories (FO-P2-003-R5A)
    if (manifest.coverage === "complete-profile") {
      const missingCategories = SNAPSHOT_MANDATORY_CATEGORIES.filter(
        (cat) => !manifest.categories?.includes(cat),
      );
      if (missingCategories.length > 0) {
        issues.push(
          `Complete-profile snapshot is missing mandatory category declarations: ${missingCategories.join(", ")}`,
        );
      }
    } else if (
      manifest.coverage === "legacy-database-knowledge" ||
      (!manifest.coverage && manifest.manifestVersion === 1)
    ) {
      if (
        manifest.manifestVersion !== 1 &&
        manifest.categories &&
        manifest.categories.some((c) => c !== "database" && c !== "knowledge")
      ) {
        issues.push(`Legacy database-knowledge snapshot cannot declare extended categories: ${manifest.categories.join(", ")}`);
      }
    } else {
      issues.push(`Invalid or missing snapshot coverage declaration: ${manifest.coverage}`);
    }

    if (manifest.manifestVersion === 3 || manifest.manifestVersion === 4) {
      if (
        !manifest.origin ||
        typeof manifest.origin !== "object" ||
        typeof manifest.origin.sourceProfileRootSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(manifest.origin.sourceProfileRootSha256)
      ) {
        issues.push(`Manifest version ${manifest.manifestVersion} missing or invalid required origin metadata.`);
      }
      if (!Array.isArray(manifest.internalReferences)) {
        issues.push(`Manifest version ${manifest.manifestVersion} is missing mandatory internalReferences array.`);
      }
    }

    // Validate schema compatibility of manifest schemaVersion (P2-5)
    if (manifest.schemaVersion !== null && typeof manifest.schemaVersion !== "string") {
      issues.push("Invalid schemaVersion type in manifest.json.");
    } else if (manifest.schemaVersion !== null && !isSupportedSchemaVersion(manifest.schemaVersion)) {
      issues.push(`Unsupported or unknown future schema version in manifest: ${manifest.schemaVersion}`);
    }

    // Step 2: Validate each file in the manifest
    const seenPaths = new Set<string>();
    const identityFiles: Array<{ path: string; bytes: number; sha256: string }> = [];

    for (const f of manifest.files) {
      if (!f || typeof f.path !== "string" || typeof f.bytes !== "number" || typeof f.sha256 !== "string") {
        issues.push("Invalid file entry in manifest.json.");
        continue;
      }

      // Path traversal security check
      if (
        path.isAbsolute(f.path) ||
        f.path.startsWith("..") ||
        f.path.includes(`..${path.sep}`) ||
        f.path.includes("../") ||
        f.path.includes("..\\") ||
        f.path.includes("\0")
      ) {
        issues.push(`Illegal file path in manifest: ${f.path}`);
        continue;
      }

      // Allowlist validation according to manifestVersion
      if (manifest.manifestVersion === 1) {
        if (f.path !== "database.sqlite") {
          const parsedKnowledge = parseKnowledgeFilePath(f.path);
          if (!parsedKnowledge.ok) {
            issues.push(`Snapshot manifest contains unexpected file not permitted by Knowledge schema: ${f.path}`);
            continue;
          }
        }
      } else {
        const parsed = parseSnapshotAssetPath(f.path);
        if (!parsed.ok) {
          if (f.path.startsWith("knowledge/")) {
            issues.push(`Snapshot manifest contains unexpected file not permitted by Knowledge schema: ${f.path}`);
          } else {
            issues.push(`Snapshot manifest contains unexpected file not permitted by schema: ${f.path} (${parsed.reason})`);
          }
          continue;
        }
        if (f.category && f.category !== parsed.category) {
          issues.push(`Manifest entry category mismatch for ${f.path}: declared '${f.category}', expected '${parsed.category}'.`);
        }
        if (parsed.category === "brain" && (manifest.manifestVersion !== 4 || manifest.brain?.coverage !== "included")) {
          issues.push(`Brain files are not part of this snapshot: ${f.path}`);
        }
      }

      // Intermediate directory symlink defense
      const parts = f.path.split(/[/\\]+/).filter(Boolean);
      let compPath = resolved;
      let hasSymlinkComponent = false;
      for (let i = 0; i < parts.length - 1; i++) {
        compPath = path.join(compPath, parts[i]!);
        if (pathExistsOrSymlink(compPath)) {
          try {
            const compStat = lstatSync(compPath);
            if (compStat.isSymbolicLink()) {
              issues.push(`Untrusted intermediate symlink detected in snapshot path: ${f.path}`);
              hasSymlinkComponent = true;
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (hasSymlinkComponent) continue;

      if (seenPaths.has(f.path) || seenPaths.has(f.path.replaceAll("\\", "/"))) {
        issues.push(`Duplicate path in manifest: ${f.path}`);
        continue;
      }

      seenPaths.add(f.path);
      seenPaths.add(f.path.replaceAll("\\", "/"));
      const fullPath = path.join(resolved, f.path);

      // Verify canonical containment within snapshot root
      try {
        const canonicalSnapshot = realpathSync(resolved);
        const parentDir = path.dirname(fullPath);
        if (existsSync(parentDir)) {
          const canonicalParent = realpathSync(parentDir);
          if (canonicalParent !== canonicalSnapshot && !canonicalParent.startsWith(canonicalSnapshot + path.sep)) {
            issues.push(`Snapshot file escapes root directory via symlink: ${f.path}`);
            continue;
          }
        }
      } catch {
        /* parent does not exist or cannot be resolved */
      }

      if (!pathExistsOrSymlink(fullPath)) {
        issues.push(`Required snapshot file missing: ${f.path}`);
        continue;
      }

      let fileStat: ReturnType<typeof lstatSync>;
      try {
        fileStat = lstatSync(fullPath);
      } catch (err) {
        issues.push(`Failed to stat file ${f.path}: ${(err as Error).message}`);
        continue;
      }

      if (fileStat.isSymbolicLink()) {
        issues.push(`Untrusted symlink detected in snapshot: ${f.path}`);
        continue;
      }
      if (!fileStat.isFile()) {
        issues.push(`Snapshot entry is not a regular file: ${f.path}`);
        continue;
      }

      if (fileStat.size !== f.bytes) {
        issues.push(
          `File size mismatch for ${f.path}: expected ${f.bytes} bytes, found ${fileStat.size}`,
        );
      }

      let actualSha: string;
      try {
        actualSha = await computeFileSha256(fullPath);
      } catch (err) {
        issues.push(`Failed to hash file ${f.path}: ${(err as Error).message}`);
        continue;
      }

      if (actualSha !== f.sha256) {
        issues.push(
          `Checksum mismatch for ${f.path}: expected ${f.sha256}, calculated ${actualSha}`,
        );
      }

      identityFiles.push({
        path: f.path.replaceAll("\\", "/"),
        bytes: fileStat.size,
        sha256: actualSha,
      });
      filesChecked++;
      totalBytes += fileStat.size;
    }

    // Step 3: Verify SQLite database integrity
    const dbRevPaths = new Set<string>();
    const allTaskIds = new Set<string>();
    const dbPath = path.join(resolved, "database.sqlite");
    if (!pathExistsOrSymlink(dbPath)) {
      issues.push("Snapshot missing required database.sqlite.");
    } else {
      let dbStat: ReturnType<typeof lstatSync>;
      try {
        dbStat = lstatSync(dbPath);
      } catch (err) {
        issues.push(`Failed to stat database.sqlite: ${(err as Error).message}`);
        dbStat = null as any;
      }
      if (dbStat) {
        if (dbStat.isSymbolicLink()) {
          issues.push("database.sqlite cannot be a symbolic link.");
        } else if (!dbStat.isFile()) {
          issues.push("database.sqlite is not a regular file (special file / FIFO).");
        } else {
          const dbCheck = BackupCore.verifyIntegrity(dbPath);
          if (!dbCheck.ok) {
            issues.push(`SQLite database integrity check failed: ${dbCheck.issues.join("; ")}`);
          } else {
            // Step 4: Verify knowledge references and schema between SQLite and files on disk
            let snapDb: Database | null = null;
            try {
              snapDb = new Database(dbPath, { readonly: true });

              // 4a: Verify schema version of database matches manifest and is supported (P2-5)
              let actualDbSchema: string | null = null;
              try {
                actualDbSchema = getDatabaseSchemaVersion(snapDb);
              } catch (err) {
                issues.push(`Failed to read database schema version: ${(err as Error).message}`);
              }
              if (manifest.schemaVersion !== actualDbSchema) {
                issues.push(
                  `Snapshot manifest schema version '${manifest.schemaVersion}' does not match database schema version '${actualDbSchema}'.`,
                );
              }
              if (actualDbSchema !== null && !isSupportedSchemaVersion(actualDbSchema)) {
                issues.push(`Unsupported or unknown future database schema version: ${actualDbSchema}`);
              }

              // 4a.5: Verify snapshot-format marker consistency (FO-P2-003-R8A).
              // A manifest version that conflicts with the recorded database format
              // is treated as a format downgrade/upgrade attempt and rejected.
              const markerFormatVersion = readSnapshotFormatMarker(snapDb);
              if (
                markerFormatVersion !== null &&
                markerFormatVersion !== manifest.manifestVersion
              ) {
                issues.push(
                  `Snapshot format marker (v${markerFormatVersion}) conflicts with manifest version (v${manifest.manifestVersion}): possible manifest version downgrade or upgrade.`,
                );
              }

              // 4b: Verify document/revision consistency in SQLite (P2-7)
              const consistency = verifyDocumentRevisionConsistency(snapDb);
              if (!consistency.ok) {
                issues.push(...consistency.issues);
              }

              // 4c: Verify knowledge revisions against manifest
              const hasRevTable = snapDb
                .query<{ count: number }, []>(
                  "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='knowledge_revisions';",
                )
                .get()?.count;

              if (hasRevTable) {
                const dbRevs = snapDb
                  .query<KnowledgeRevisionRow, []>(
                    "SELECT document_id, revision, byte_length, content_sha256 FROM knowledge_revisions;",
                  )
                  .all();

                for (const row of dbRevs) {
                  const expectedRel = `knowledge/bodies/${row.document_id}/${row.revision}.md`;
                  dbRevPaths.add(expectedRel);
                  if (
                    !seenPaths.has(expectedRel) &&
                    !seenPaths.has(path.join("knowledge", "bodies", row.document_id, `${row.revision}.md`))
                  ) {
                    issues.push(
                      `Database references knowledge file not included in manifest: ${expectedRel}`,
                    );
                  }
                }

                // Strict Allowlist reverse check:
                // For manifestVersion 1, all non-database files in manifest must be knowledge files in database!
                if (manifest.manifestVersion === 1) {
                  for (const f of manifest.files) {
                    if (f.path === "database.sqlite") continue;
                    const norm = f.path.replaceAll("\\", "/");
                    if (!dbRevPaths.has(norm)) {
                      issues.push(
                        `Manifest contains unreferenced knowledge file not in database: ${f.path}`,
                      );
                    }
                  }
                } else {
                  // For manifestVersion 2, all knowledge files in manifest must be in dbRevPaths!
                  for (const f of manifest.files) {
                    const norm = f.path.replaceAll("\\", "/");
                    if (norm.startsWith("knowledge/bodies/") && !dbRevPaths.has(norm)) {
                      issues.push(
                        `Manifest contains unreferenced knowledge file not in database: ${f.path}`,
                      );
                    }
                  }
                }
              } else {
                for (const f of manifest.files) {
                  const norm = f.path.replaceAll("\\", "/");
                  if (norm.startsWith("knowledge/bodies/")) {
                    issues.push(
                      `Manifest contains unreferenced knowledge file not in database: ${f.path}`,
                    );
                  }
                }
              }

              // 4d: Verify application-specific database-to-file references (manifestVersion 2, 3, and 4)
              if (
                manifest.manifestVersion === 2 ||
                manifest.manifestVersion === 3 ||
                manifest.manifestVersion === 4
              ) {
                const tasksTableExists = snapDb
                  .query<{ count: number }, []>(
                    "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='tasks';",
                  )
                  .get()?.count;

                if (tasksTableExists) {
                  const tableInfo = snapDb.query<{ name: string }, []>("PRAGMA table_info(tasks);").all();
                  const taskCols = new Set(tableInfo.map((c) => c.name));

                  const selectCols = ["id"];
                  if (taskCols.has("refs")) selectCols.push("refs");
                  if (taskCols.has("attachments")) selectCols.push("attachments");
                  if (taskCols.has("sent_files")) selectCols.push("sent_files");
                  if (taskCols.has("draft")) selectCols.push("draft");
                  if (taskCols.has("backlog")) selectCols.push("backlog");

                  const taskRows = snapDb
                    .query<
                      {
                        id: string;
                        refs?: string | null;
                        attachments?: string | null;
                        sent_files?: string | null;
                        draft?: string | null;
                        backlog?: string | null;
                      },
                      []
                    >(`SELECT ${selectCols.join(", ")} FROM tasks;`)
                    .all();
                  for (const r of taskRows) {
                    allTaskIds.add(r.id);
                  }

                  const refAssets = getReferencedInternalAssets(snapDb, {
                    dataDir: resolved,
                    attachmentsRootDir: path.join(resolved, "attachments"),
                    screenshotsRootDir: path.join(resolved, "screenshots"),
                    issueThreadsRootDir: path.join(resolved, "issue-threads"),
                    pipelineRunsRootDir: path.join(resolved, "pipeline-runs"),
                    sourceProfileRootSha256: manifest.origin?.sourceProfileRootSha256,
                    sourceProfileRealSha256: manifest.origin?.sourceProfileRealSha256,
                    sourceProfileAliasSha256s: manifest.origin?.sourceProfileAliasSha256s,
                  });

                  for (const att of refAssets.attachments) {
                    if (!seenPaths.has(att)) {
                      issues.push(`Database references attachment file not included in manifest: ${att}`);
                    }
                  }
                  for (const scr of refAssets.screenshots) {
                    if (!seenPaths.has(scr)) {
                      issues.push(`Database references screenshot file not included in manifest: ${scr}`);
                    }
                  }
                  for (const iss of refAssets.issueThreads) {
                    if (!seenPaths.has(iss)) {
                      issues.push(`Database references issue thread file not included in manifest: ${iss}`);
                    }
                  }
                  for (const pipe of refAssets.pipelineRuns) {
                    if (!seenPaths.has(pipe)) {
                      issues.push(`Database references pipeline handoff file not included in manifest: ${pipe}`);
                    }
                  }

                  if (manifest.manifestVersion === 4) {
                    // v4 is the only format whose reference completeness is
                    // provable: its references are canonical-relative and their
                    // locators are authenticated against the manifest. Legacy v3
                    // reference completeness is NOT verified because origin
                    // metadata is unauthenticated.
                    const refIssues = validateInternalReferencesCompleteness(manifest, refAssets, seenPaths);
                    for (const issue of refIssues) {
                      issues.push(issue);
                    }
                  }

                  if (refAssets.crossProfileReferences && refAssets.crossProfileReferences.length > 0) {
                    if (options?.requireCompleteProfile) {
                      issues.push(
                        `Snapshot database references external profile assets: ${refAssets.crossProfileReferences.map((r) => r.rawPath).join(", ")}`,
                      );
                    }
                  }

                  // Legacy v2 absolute reference check: without origin metadata, completeness cannot be proven
                  if (manifest.manifestVersion === 2) {
                    for (const r of taskRows) {
                      for (const field of [r.refs, r.attachments, r.sent_files]) {
                        if (!field) continue;
                        try {
                          const parsed = JSON.parse(field);
                          if (Array.isArray(parsed)) {
                            for (const item of parsed) {
                              const p = typeof item === "string" ? item : item?.path;
                              if (typeof p === "string" && path.isAbsolute(p)) {
                                const resolvedP = path.resolve(p);
                                if (!resolvedP.startsWith(resolved + path.sep)) {
                                  issues.push(`Legacy manifest version 2 cannot verify absolute database reference without origin metadata: ${p}`);
                                }
                              }
                            }
                          }
                        } catch {
                          /* ignore parse errors */
                        }
                      }
                    }
                  }
                } else if (manifest.manifestVersion === 4) {
                  const emptyRefs: ReferencedInternalAssets = {
                    attachments: new Set(),
                    screenshots: new Set(),
                    issueThreads: new Set(),
                    pipelineRuns: new Set(),
                    entries: [],
                  };
                  const refIssues = validateInternalReferencesCompleteness(manifest, emptyRefs, seenPaths);
                  for (const issue of refIssues) {
                    issues.push(issue);
                  }
                }

                // Reverse task reference check for issue-threads and pipeline-runs
                for (const f of manifest.files) {
                  const norm = f.path.replaceAll("\\", "/");
                  if (norm.startsWith("issue-threads/")) {
                    const parts = norm.split("/");
                    if (parts.length >= 3 && parts[1] && !allTaskIds.has(parts[1])) {
                      issues.push(`Snapshot contains unreferenced issue thread file for non-existent task: ${f.path}`);
                    }
                  } else if (norm.startsWith("pipeline-runs/")) {
                    const parts = norm.split("/");
                    if (parts.length >= 3 && parts[1] && !allTaskIds.has(parts[1])) {
                      issues.push(`Snapshot contains unreferenced pipeline handoff file for non-existent parent task: ${f.path}`);
                    }
                  }
                }
              }

              // 4e: Validate manifest statistics against actual contents
              if (manifest.stats && typeof manifest.stats === "object") {
                if (manifest.stats.fileCount !== manifest.files.length) {
                  issues.push(
                    `Manifest stats fileCount mismatch: expected ${manifest.files.length}, found ${manifest.stats.fileCount}`,
                  );
                }
                if (manifest.stats.totalBytes !== totalBytes) {
                  issues.push(
                    `Manifest stats totalBytes mismatch: expected ${totalBytes}, found ${manifest.stats.totalBytes}`,
                  );
                }
                if (manifest.stats.knowledgeRevisionCount !== dbRevPaths.size) {
                  issues.push(
                    `Manifest stats knowledgeRevisionCount mismatch: expected ${dbRevPaths.size}, found ${manifest.stats.knowledgeRevisionCount}`,
                  );
                }
                try {
                  const actualDocCount = getKnowledgeDocumentCount(snapDb);
                  if (manifest.stats.knowledgeDocumentCount !== actualDocCount) {
                    issues.push(
                      `Manifest stats knowledgeDocumentCount mismatch: expected ${actualDocCount}, found ${manifest.stats.knowledgeDocumentCount}`,
                    );
                  }
                } catch {
                  /* handled if count query fails */
                }

                if (manifest.manifestVersion === 2 || manifest.manifestVersion === 3) {
                  let actAtt = 0;
                  let actScr = 0;
                  let actIss = 0;
                  let actPipe = 0;
                  for (const f of manifest.files) {
                    const norm = f.path.replaceAll("\\", "/");
                    if (norm.startsWith("attachments/")) actAtt++;
                    else if (norm.startsWith("screenshots/")) actScr++;
                    else if (norm.startsWith("issue-threads/")) actIss++;
                    else if (norm.startsWith("pipeline-runs/")) actPipe++;
                  }
                  if (manifest.stats.attachmentCount !== undefined && manifest.stats.attachmentCount !== actAtt) {
                    issues.push(`Manifest stats attachmentCount mismatch: expected ${actAtt}, found ${manifest.stats.attachmentCount}`);
                  }
                  if (manifest.stats.screenshotCount !== undefined && manifest.stats.screenshotCount !== actScr) {
                    issues.push(`Manifest stats screenshotCount mismatch: expected ${actScr}, found ${manifest.stats.screenshotCount}`);
                  }
                  if (manifest.stats.issueThreadCount !== undefined && manifest.stats.issueThreadCount !== actIss) {
                    issues.push(`Manifest stats issueThreadCount mismatch: expected ${actIss}, found ${manifest.stats.issueThreadCount}`);
                  }
                  if (manifest.stats.pipelineRunCount !== undefined && manifest.stats.pipelineRunCount !== actPipe) {
                    issues.push(`Manifest stats pipelineRunCount mismatch: expected ${actPipe}, found ${manifest.stats.pipelineRunCount}`);
                  }
                }
              }
            } catch (err) {
              issues.push(`Failed to inspect snapshot database references: ${(err as Error).message}`);
            } finally {
              if (snapDb) {
                try {
                  snapDb.close();
                } catch {
                  /* ignore */
                }
              }
            }
          }
        }
      }
    }

    // Step 5: Check for unmanifested extra files, symlinks, and forbidden artifacts
    const FORBIDDEN_CREDENTIAL_FILE_RE =
      /^(?:agetor\.pid|forgeorbit\.pid|agetor\.creds\.json|.*\.creds\.json|github-tokens\.json|core-creds\.json|agetor-core\.json|desktop-instance\.lock|daemon\.log)$/i;
    const FORBIDDEN_ROOT_RUNTIME_FILE_RE =
      /^(?:.*\.pid|.*\.lock|.*\.log)$/i;
    const FORBIDDEN_DIR_NAME_RE =
      /^(?:antigravity-logs|codex-logs|cursor-logs|gemini-logs|fx-logs|gemini-inputs|interview-scratch|environment-markers|worktrees)$/i;

    function checkDir(curr: string) {
      let entries: string[];
      try {
        entries = readdirSync(curr);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(curr, entry);
        const rel = path.relative(resolved, full);
        if (rel === "manifest.json") continue;
        if (rel === "database.sqlite") continue;
        if (options?.isStaging && (rel === ".forgeorbit-ownership.json" || rel === ".lock")) continue;

        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }

        const isRootLevel = !rel.includes(path.sep) && !rel.includes("/");

        if (st.isSymbolicLink()) {
          issues.push(`Untrusted symbolic link found in snapshot: ${rel}`);
        } else if (st.isDirectory()) {
          if (FORBIDDEN_DIR_NAME_RE.test(entry)) {
            issues.push(`Forbidden credential or runtime file found in snapshot: ${rel}`);
          }
          checkDir(full);
        } else if (st.isFile()) {
          if (FORBIDDEN_CREDENTIAL_FILE_RE.test(entry)) {
            issues.push(`Forbidden credential or runtime file found in snapshot: ${rel}`);
          } else if (isRootLevel && FORBIDDEN_ROOT_RUNTIME_FILE_RE.test(entry)) {
            issues.push(`Forbidden credential or runtime file found in snapshot: ${rel}`);
          }
          const norm = rel.replaceAll("\\", "/");
          if (manifest.manifestVersion === 1) {
            if (norm.startsWith("knowledge/")) {
              const parsed = parseKnowledgeFilePath(norm);
              if (!parsed.ok) {
                issues.push(`Unexpected or invalid knowledge file in snapshot directory: ${rel}`);
              } else if (!seenPaths.has(norm) && !seenPaths.has(rel)) {
                issues.push(`Unmanifested file found in snapshot: ${rel}`);
              } else if (!dbRevPaths.has(norm)) {
                issues.push(`Snapshot contains unreferenced knowledge file not in database: ${rel}`);
              }
            } else {
              if (!seenPaths.has(norm) && !seenPaths.has(rel)) {
                issues.push(`Unmanifested file found in snapshot: ${rel}`);
              } else {
                issues.push(`Unexpected non-database file found in snapshot: ${rel}`);
              }
            }
          } else {
            if (norm.startsWith("knowledge/")) {
              const parsedKnowledge = parseKnowledgeFilePath(norm);
              if (!parsedKnowledge.ok) {
                issues.push(`Unexpected or invalid knowledge file in snapshot directory: ${rel}`);
              } else if (!seenPaths.has(norm) && !seenPaths.has(rel)) {
                issues.push(`Unmanifested file found in snapshot: ${rel}`);
              } else if (!dbRevPaths.has(norm)) {
                issues.push(`Snapshot contains unreferenced knowledge file not in database: ${rel}`);
              }
            } else if (!seenPaths.has(norm) && !seenPaths.has(rel)) {
              issues.push(`Unmanifested file found in snapshot: ${rel}`);
            } else {
              const parsed = parseSnapshotAssetPath(norm);
              if (!parsed.ok) {
                issues.push(`Unexpected or invalid file in snapshot directory: ${rel}`);
              } else if (parsed.category === "issue-thread") {
                const parts = norm.split("/");
                if (parts.length >= 3 && parts[1] && !allTaskIds.has(parts[1])) {
                  issues.push(`Snapshot contains unreferenced issue thread file for non-existent task: ${rel}`);
                }
              } else if (parsed.category === "pipeline-run") {
                const parts = norm.split("/");
                if (parts.length >= 3 && parts[1] && !allTaskIds.has(parts[1])) {
                  issues.push(`Snapshot contains unreferenced pipeline handoff file for non-existent parent task: ${rel}`);
                }
              }
            }
          }
        } else {
          issues.push(`Special filesystem object found in snapshot: ${rel}`);
        }
      }
    }
    checkDir(resolved);

    let coverage: SnapshotCoverage | undefined;
    if (manifest.coverage === "complete-profile" && manifest.manifestVersion === 4) {
      // v4 is the only format whose reference portability can be proven, so only
      // v4 may claim complete-profile coverage. Legacy v1/v2/v3 snapshots cannot
      // claim modern complete-profile portability on the basis of mutable origin
      // metadata and are reported as legacy-database-knowledge coverage.
      const hasAllMandatory = SNAPSHOT_MANDATORY_CATEGORIES.every((cat) =>
        manifest.categories?.includes(cat),
      );
      if (hasAllMandatory) {
        coverage = "complete-profile";
      } else {
        issues.push("Snapshot claims complete-profile coverage but is missing mandatory category declarations");
      }
    } else if (manifest.coverage === "legacy-database-knowledge" || manifest.manifestVersion !== 4) {
      coverage = "legacy-database-knowledge";
    } else {
      issues.push(`Unknown or untruthful snapshot coverage declaration: ${manifest.coverage}`);
    }

    if (manifest.manifestVersion === 4) {
      issues.push(
        ...verifyPackagedBrain(resolved, manifest.brain, manifest.files).map((issue) =>
          issue.startsWith("Brain ") ? issue : `Brain ${issue}`,
        ),
      );
    } else if (manifest.files.some((file) => file.path.replaceAll("\\", "/").startsWith("brain/"))) {
      issues.push("Brain files are not part of this snapshot format.");
    }

    // Identity is computed only for a fully passing verification, from the
    // manifest bytes actually parsed here plus the ACTUAL hashes of every
    // packaged file (not the manifest's claimed hashes). Changing the
    // manifest, database, attachments or any other packaged file changes it.
    // `manifestRaw` also covers every metadata field (origin, stats, ...).
    const contentIdentity =
      issues.length === 0
        ? sha256Hex(
            JSON.stringify({
              manifestSha256: sha256Hex(manifestRaw),
              files: identityFiles.slice().sort((a, b) => a.path.localeCompare(b.path)),
            }),
          )
        : undefined;

    return {
      ok: issues.length === 0,
      snapshotId: manifest.snapshotId,
      appVersion: manifest.appVersion,
      schemaVersion: manifest.schemaVersion,
      createdAt: manifest.createdAt,
      manifestVersion: manifest.manifestVersion,
      coverage,
      categories: manifest.categories,
      filesChecked,
      totalBytes,
      issues,
      manifest: issues.length === 0 ? manifest : undefined,
      origin: manifest.origin,
      contentIdentity,
    };
  }

  /**
   * Scan a directory and safely remove incomplete temporary snapshot staging directories.
   */
  static cleanIncompleteSnapshots(directory: string): { cleaned: string[]; errors: string[] } {
    return cleanSubsystemStaging(directory, "backup-manager", SNAPSHOT_STAGING_SCAN_RE);
  }
}

/**
 * Convenient standalone helper to create a complete backup snapshot.
 */
export async function createBackupSnapshot(
  options: BackupManagerOptions & CreateSnapshotOptions,
): Promise<SnapshotResult> {
  const manager = new BackupManager(options);
  return manager.createSnapshot(options);
}

/**
 * Convenient standalone helper to verify an existing snapshot.
 */
export function verifyBackupSnapshot(
  snapshotPath: string,
  options?: { isStaging?: boolean; requireCompleteProfile?: boolean },
): Promise<SnapshotVerificationResult> {
  return BackupManager.verifySnapshot(snapshotPath, options);
}

/**
 * Convenient standalone helper to clean up incomplete snapshot staging directories.
 */
export function cleanIncompleteBackupSnapshots(directory: string): { cleaned: string[]; errors: string[] } {
  return BackupManager.cleanIncompleteSnapshots(directory);
}
