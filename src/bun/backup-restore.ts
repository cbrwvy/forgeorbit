/**
 * Safe Backup Restore Core (FO-P2-003).
 *
 * Provides verified, fail-closed restoration of ForgeOrbit persistent application
 * data from an existing backup snapshot into a new, inactive destination directory.
 *
 * ## Restore Guarantees & Safety Invariants
 *
 * 1. Independent Offline Verification:
 *    The snapshot bundle is independently verified via `verifyBackupSnapshot` before
 *    any staging or restoration begins. Manifest integrity, version compatibility,
 *    SHA-256 digests, SQLite page integrity, and knowledge document references are
 *    all validated upfront.
 * 2. Inactive Destination Only:
 *    Restores exclusively into a NEW, non-existent destination path. Refuses to overwrite
 *    any existing file, directory, or symlink.
 * 3. Active Profile & Collision Protection:
 *    Strictly prevents restoration into or inside any active application data directory
 *    (including `resolveDataDir()`, production defaults, and env overrides).
 * 4. Overlap Rejection:
 *    Destination path must not be identical to, inside, or containing the source snapshot.
 * 5. Symlink & Traversal Hardening:
 *    Rejects symbolic links, path traversal sequences (`..`), null bytes, and intermediate
 *    directory symlinks.
 * 6. Atomic Staging & Publication:
 *    All restored files are written into a hidden, manager-owned temporary staging
 *    directory (`.<name>.restore.<uuid>.tmp`) on the same filesystem. Staging is verified
 *    again post-extraction, and published atomically to the final destination via `renameSync`.
 * 7. Fail-Closed Cleanup:
 *    On any failure or verification rejection, the restore-owned staging directory is
 *    immediately removed. The original backup snapshot is never modified.
 * 8. Zero Secret Leakage:
 *    Only application database and referenced knowledge files are restored. PID files,
 *    active bearer tokens, session keys, and ephemeral runtime state are never restored.
 *
 * ## Event-Loop & Concurrency Notes
 *
 * NOTE: While `restoreBackupSnapshot` is an async function, Bun SQLite's
 * `PRAGMA integrity_check` and metadata queries execute synchronously on Bun's main thread.
 * Cooperative `setImmediate` yields occur before and after SQLite calls, and database checks
 * are bracketed with `beginLagLabel`. Callers should be aware that restoring very large
 * databases will stall the event loop for the duration of the synchronous SQLite checks.
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
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  BackupCore,
  publishDirectoryExclusive,
  pathExistsOrSymlink,
  syncFile,
  syncDirectory,
  writeStagingOwnershipMetadata,
  cleanSubsystemStaging,
  RESTORE_CONFIRMATION_FILENAME,
  RESTORE_RECOVERY_FILENAME,
  RESTORE_STAGING_SCAN_RE,
  STAGING_LOCK_FILENAME,
  tryAcquireFlock,
  releaseFlock,
  type BackupFs,
  type StagingOwnershipMetadata,
} from "./backup-core.ts";
import {
  getDatabaseSchemaVersion,
  getKnowledgeDocumentCount,
  getReferencedInternalAssets,
  getReferencedKnowledgeRevisions,
  getValueAtJsonPath,
  isSupportedSchemaVersion,
  parseJsonPathTokens,
  parseKnowledgeFilePath,
  parseSnapshotAssetPath,
  setValueAtJsonPath,
  sha256Hex,
  validateInternalReferencesCompleteness,
  verifyBackupSnapshot,
  verifyDocumentRevisionConsistency,
  type SnapshotCoverage,
  type SnapshotManifest,
  type SnapshotReferenceEntry,
  type SnapshotVerificationResult,
} from "./backup-manager.ts";
import { verifyPackagedBrain } from "./brain-snapshot.ts";
import { resolveDataDir } from "./data-dir.ts";
import { activationControlDir } from "./profile-paths.ts";
import { resolveActiveDataDir } from "./profile-activation-state.ts";
import { beginLagLabel } from "./event-loop-lag.ts";

export type RestoreErrorCode =
  | "TARGET_EXISTS"
  | "INVALID_PATH"
  | "DIRECTORY_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_VERIFICATION_FAILED"
  | "SNAPSHOT_CHANGED"
  | "UNSUPPORTED_VERSION"
  | "INCOMPLETE_PROFILE"
  | "ACTIVE_PROFILE_PROTECTED"
  | "OVERLAPPING_PATHS"
  | "UNTRUSTED_SYMLINK"
  | "SQLITE_ERROR"
  | "VERIFICATION_FAILED"
  | "CANCELLED"
  | "PUBLISHED_UNCONFIRMED"
  | "INDETERMINATE"
  | "IO_ERROR";

export class RestoreError extends Error {
  constructor(
    message: string,
    readonly code: RestoreErrorCode,
    cause?: unknown,
    /**
     * Structured, bounded diagnostics. Used by R8B to report the destination path
     * and commit phase for post-publication uncertainty.
     */
    readonly details?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RestoreError";
  }
}

export interface RestoreOptions {
  /**
   * Database filename inside the destination directory.
   * Defaults to "agetor.sqlite" to match ForgeOrbit's primary production database.
   */
  dbFilename?: string;
  /** If true, creates missing parent directories with mode 0o700. Defaults to false. */
  createDirectory?: boolean;
  /** If true, strictly requires the snapshot to provide complete-profile coverage. */
  requireCompleteProfile?: boolean;
  /**
   * Content identity the user approved (from preview/verification). The worker
   * re-verifies the snapshot and refuses to extract a different identity, which
   * binds restoration to the approved content rather than the filesystem path.
   */
  expectedContentIdentity?: string;
  /**
   * Rebind internal application-owned file references in SQLite to point to the restored destination directory.
   * Only applicable to modern v4 snapshots; legacy v1/v2/v3 snapshots are never automatically rebound.
   */
  rebindInternalReferences?: boolean;
  /** Clock source for timestamping (ms). Defaults to Date.now. */
  now?: () => number;
  /** Test hook: invoked when private staging directory is prepared before extraction. */
  onStagingPrepared?: (stagingDir: string) => void | Promise<void>;
  /** Optional custom directory publisher for testing atomic directory publication. */
  publishDir?: (stagingDir: string, destDir: string) => void;
  /** Test hook: invoked after snapshot is verified, before extraction begins. */
  beforeExtract?: (snapshotDir: string) => void | Promise<void>;
  /** Test hook: invoked after staging files are extracted, before post-extraction verification. */
  afterExtract?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after post-extraction verification succeeds, before publication. */
  beforePublish?: (stagingDir: string) => void | Promise<void>;
  /** Test hook: invoked after atomic publication and directory durability sync succeed. */
  afterPublish?: (destinationPath: string) => void | Promise<void>;
  /** Runner operation ID associating this operation with parent process supervisor. */
  runnerOperationId?: string;
  /** Optional filesystem operations for dependency injection and testing publication failures. */
  fs?: BackupFs;
}

export type ActivationReadiness =
  | "ready"
  | "requires-reference-repair"
  | "requires-external-recovery"
  | "legacy-unverified"
  | "not-ready";

export interface ReferenceRebindingStats {
  discovered: number;
  rebound: number;
  unchanged: number;
  unresolved: number;
}

import type {
  ProjectRecoveryInfo,
  WorktreeRecoveryInfo,
  EnvironmentProfileRecoveryInfo,
  ProviderAuthRecoveryInfo,
  RestoreRecoveryPreview,
} from "../shared/backup.ts";

export type {
  ProjectRecoveryInfo,
  WorktreeRecoveryInfo,
  EnvironmentProfileRecoveryInfo,
  ProviderAuthRecoveryInfo,
  RestoreRecoveryPreview,
};

export interface RestoreResult {
  /** Canonical resolved destination directory. */
  destinationPath: string;
  /** Snapshot identifier restored from manifest. */
  snapshotId: string;
  /** Manifest version from restored snapshot. */
  manifestVersion?: 1 | 2 | 3 | 4;
  /** Application version from manifest. */
  appVersion: string | null;
  /** Database schema migration version from manifest. */
  schemaVersion: string | null;
  /** Name of the restored database file. */
  dbFilename: string;
  /** Size of the restored SQLite database in bytes. */
  databaseBytes: number;
  /** SHA-256 digest of the original database from the snapshot manifest. */
  originalDatabaseSha256: string;
  /** SHA-256 digest of the restored database (transformed if rebound). */
  databaseSha256: string;
  /** Whether the restored database was transformed by internal reference rebinding. */
  databaseTransformed: boolean;
  /** Number of active knowledge documents in restored database. */
  knowledgeDocumentCount: number;
  /** Number of knowledge revision files restored. */
  knowledgeRevisionCount: number;
  /** Number of attachment files restored. */
  attachmentCount?: number;
  /** Number of screenshot files restored. */
  screenshotCount?: number;
  /** Number of issue-thread files restored. */
  issueThreadCount?: number;
  /** Number of pipeline-run files restored. */
  pipelineRunCount?: number;
  /** Total files restored (database + knowledge files + durable assets). */
  filesRestored: number;
  /** Total bytes of all restored files. */
  totalBytesRestored: number;
  /** Wall-clock duration of restoration in milliseconds. */
  durationMs: number;
  /** Unix timestamp in ms when restore completed. */
  restoredAt: number;
  /** Verified profile coverage classification. */
  coverage?: SnapshotCoverage;
  /** Rebinding statistics (discovered, rebound, unchanged, unresolved). */
  rebindingStats?: ReferenceRebindingStats;
  internalReferencesDiscovered?: number;
  internalReferencesRebound?: number;
  internalReferencesUnresolved?: number;
  /** Number of unresolved cross-profile references detected in database. */
  unresolvedCrossProfileReferences?: number;
  /** Raw paths of external profile dependencies. */
  crossProfileDependencies?: string[];
  /** Number of unresolved absolute external operational references. */
  unresolvedExternalReferences?: number;
  /** Raw paths of unresolved absolute external operational references. */
  unresolvedExternalDependencies?: string[];
  /** Number of external project references requiring user attention. */
  externalProjectsRequiringAttention?: number;
  /** Overall validation status. */
  validationStatus: "valid" | "failed" | "unverified";
  /** Activation readiness status. */
  activationReadiness: ActivationReadiness;
  /** Recovery preview summary. */
  recoveryPreview?: RestoreRecoveryPreview;
}

interface KnowledgeRevisionRow {
  document_id: string;
  revision: number;
  byte_length: number;
  content_sha256: string;
}

const RESTORE_STAGING_DIR_RE = /^\..+\.restore\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export function validateDbFilename(name: string): void {
  if (typeof name !== "string" || !name.trim()) {
    throw new RestoreError(
      "Invalid dbFilename: must be a non-empty string.",
      "INVALID_PATH",
    );
  }
  if (name.includes("\0")) {
    throw new RestoreError(
      "Invalid dbFilename: null bytes are not permitted.",
      "INVALID_PATH",
    );
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new RestoreError(
      `Invalid dbFilename: directory separators are not permitted: ${name}`,
      "INVALID_PATH",
    );
  }
  if (path.basename(name) !== name) {
    throw new RestoreError(
      `Invalid dbFilename: path components are not permitted: ${name}`,
      "INVALID_PATH",
    );
  }
  if (name === "." || name === "..") {
    throw new RestoreError(
      `Invalid dbFilename: navigation components are not permitted: ${name}`,
      "INVALID_PATH",
    );
  }
  if (name.startsWith(".")) {
    throw new RestoreError(
      `Invalid dbFilename: hidden filenames are not permitted: ${name}`,
      "INVALID_PATH",
    );
  }
  const baseName = name.split(".")[0]?.toLowerCase() ?? "";
  const reservedDevices = [
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
  ];
  if (reservedDevices.includes(baseName)) {
    throw new RestoreError(
      `Invalid dbFilename: reserved device name not permitted: ${name}`,
      "INVALID_PATH",
    );
  }
  if (!/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/.test(name)) {
    throw new RestoreError(
      `Invalid dbFilename: filename contains disallowed characters: ${name}`,
      "INVALID_PATH",
    );
  }
}

function computeFileSha256(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(resolved);
  } catch (err) {
    return Promise.reject(
      new RestoreError(
        `Failed to stat ${resolved}: ${(err as Error).message}`,
        "IO_ERROR",
        err,
      ),
    );
  }
  if (st.isSymbolicLink()) {
    return Promise.reject(
      new RestoreError(
        `Untrusted symbolic link detected: ${resolved}`,
        "UNTRUSTED_SYMLINK",
      ),
    );
  }
  if (!st.isFile()) {
    return Promise.reject(
      new RestoreError(
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
        new RestoreError(
          `Failed to compute checksum for ${resolved}: ${err.message}`,
          "IO_ERROR",
          err,
        ),
      ),
    );
  });
}

/** Check that relativePath contains no symlinks or path escapes relative to rootPath. */
export function assertNoSymlinksInPath(rootPath: string, relativePath: string): void {
  if (path.isAbsolute(relativePath)) {
    throw new RestoreError(
      `Illegal absolute path: ${relativePath}`,
      "INVALID_PATH",
    );
  }
  const parts = relativePath.split(/[/\\]+/).filter(Boolean);
  let current = path.resolve(rootPath);
  for (const part of parts) {
    if (part === ".." || part === "." || part.includes("\0")) {
      throw new RestoreError(
        `Path traversal detected: ${relativePath}`,
        "INVALID_PATH",
      );
    }
    current = path.join(current, part);
    if (pathExistsOrSymlink(current)) {
      try {
        const st = lstatSync(current);
        if (st.isSymbolicLink()) {
          throw new RestoreError(
            `Untrusted symbolic link detected in path: ${current}`,
            "UNTRUSTED_SYMLINK",
          );
        }
      } catch (err) {
        if (err instanceof RestoreError) throw err;
      }
    }
  }

  // Canonical containment check
  try {
    const realRoot = realpathSync(rootPath);
    let realTarget: string;
    try {
      realTarget = realpathSync(current);
    } catch {
      realTarget = realpathSync(path.dirname(current));
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new RestoreError(
        `Path escapes root directory via symlink: ${relativePath}`,
        "UNTRUSTED_SYMLINK",
      );
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err;
  }
}

/** Ensure snapshotPath and destinationPath do not overlap in any way. */
function checkPathsOverlap(snapshotPath: string, destinationPath: string): void {
  const normSnap = path.resolve(snapshotPath);
  const normDest = path.resolve(destinationPath);

  if (normSnap === normDest) {
    throw new RestoreError(
      `Destination path cannot be the same as the source snapshot: ${destinationPath}`,
      "OVERLAPPING_PATHS",
    );
  }

  const relSnapToDest = path.relative(normSnap, normDest);
  if (!relSnapToDest.startsWith("..") && !path.isAbsolute(relSnapToDest)) {
    throw new RestoreError(
      `Destination path cannot reside inside the source snapshot: ${destinationPath}`,
      "OVERLAPPING_PATHS",
    );
  }

  const relDestToSnap = path.relative(normDest, normSnap);
  if (!relDestToSnap.startsWith("..") && !path.isAbsolute(relDestToSnap)) {
    throw new RestoreError(
      `Source snapshot cannot reside inside the destination path: ${snapshotPath}`,
      "OVERLAPPING_PATHS",
    );
  }

  // Canonical overlap verification if paths/parents exist
  try {
    const realSnap = realpathSync(normSnap);
    let realDest: string;
    try {
      realDest = realpathSync(normDest);
    } catch {
      const realParent = realpathSync(path.dirname(normDest));
      realDest = path.join(realParent, path.basename(normDest));
    }

    if (realSnap === realDest) {
      throw new RestoreError(
        `Destination path resolves to the same location as snapshot: ${destinationPath}`,
        "OVERLAPPING_PATHS",
      );
    }

    const relReal1 = path.relative(realSnap, realDest);
    if (!relReal1.startsWith("..") && !path.isAbsolute(relReal1)) {
      throw new RestoreError(
        `Destination path resolves inside the snapshot directory: ${destinationPath}`,
        "OVERLAPPING_PATHS",
      );
    }

    const relReal2 = path.relative(realDest, realSnap);
    if (!relReal2.startsWith("..") && !path.isAbsolute(relReal2)) {
      throw new RestoreError(
        `Snapshot directory resolves inside the destination path: ${snapshotPath}`,
        "OVERLAPPING_PATHS",
      );
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err;
  }
}

/** Guard against restoring into or inside an active application data directory. */
export function checkNotActiveDataDir(destinationPath: string): void {
  const normDest = path.resolve(destinationPath);
  let realDest = normDest;
  try {
    realDest = realpathSync(normDest);
  } catch {
    try {
      const realParent = realpathSync(path.dirname(normDest));
      realDest = path.join(realParent, path.basename(normDest));
    } catch {
      /* destination parent may not exist yet */
    }
  }

  const activeCandidates: string[] = [
    // The actual active profile (which may be an activated restored profile),
    // plus the base/profile default roots restore has always protected.
    resolveActiveDataDir(),
    resolveActiveDataDir({ env: {} }),
    resolveDataDir(),
    resolveDataDir({ env: {} }),
    path.join(homedir(), ".agetor"),
    path.join(homedir(), "Library", "Application Support", "ForgeOrbit"),
  ];

  if (process.env.FORGEORBIT_DATA_DIR) {
    activeCandidates.push(process.env.FORGEORBIT_DATA_DIR);
  }
  if (process.env.AGETOR_DATA_DIR) {
    activeCandidates.push(process.env.AGETOR_DATA_DIR);
  }
  // Never allow a restore destination inside the activation control directory.
  for (const candidate of [...activeCandidates]) {
    try {
      activeCandidates.push(activationControlDir(candidate));
    } catch {
      /* candidate has no usable parent; it is not a profile root */
    }
  }

  for (const candidate of activeCandidates) {
    if (!candidate) continue;
    const normCand = path.resolve(candidate);
    let realCand = normCand;
    try {
      realCand = realpathSync(normCand);
    } catch {
      /* candidate might not exist on disk */
    }

    if (normDest === normCand || realDest === realCand) {
      throw new RestoreError(
        `Destination path is an active application data directory: ${destinationPath}`,
        "ACTIVE_PROFILE_PROTECTED",
      );
    }

    const relToCand = path.relative(normCand, normDest);
    if (!relToCand.startsWith("..") && !path.isAbsolute(relToCand)) {
      throw new RestoreError(
        `Destination path resides inside active application data directory (${normCand}): ${destinationPath}`,
        "ACTIVE_PROFILE_PROTECTED",
      );
    }

    const relToRealCand = path.relative(realCand, realDest);
    if (!relToRealCand.startsWith("..") && !path.isAbsolute(relToRealCand)) {
      throw new RestoreError(
        `Destination path resolves inside active application data directory (${realCand}): ${destinationPath}`,
        "ACTIVE_PROFILE_PROTECTED",
      );
    }
  }
}

/**
 * Inspect the restored database to build a structured recovery preview for
 * external projects, disposable worktrees, environment profiles, and provider auth.
 */
export function buildRecoveryPreview(dbOrPath: Database | string): RestoreRecoveryPreview {
  let db: Database;
  let shouldClose = false;
  if (typeof dbOrPath === "string") {
    db = new Database(dbOrPath, { readonly: true });
    shouldClose = true;
  } else {
    db = dbOrPath;
  }

  try {
    const projects: ProjectRecoveryInfo[] = [];
    const worktrees: WorktreeRecoveryInfo[] = [];
    const environmentProfiles: EnvironmentProfileRecoveryInfo[] = [];
    const providerAuth: ProviderAuthRecoveryInfo[] = [];

    // 1. External projects
    const projectTableExists = (db.query<{ count: number }, [string]>(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
    ).get("projects")?.count ?? 0) > 0;

    const tasksTableExists = (db.query<{ count: number }, [string]>(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
    ).get("tasks")?.count ?? 0) > 0;

    const taskCols = tasksTableExists
      ? new Set(db.query<{ name: string }, []>("PRAGMA table_info(tasks);").all().map((c) => c.name))
      : new Set<string>();

    const seenProjects = new Map<string, { name?: string; taskCount: number }>();

    if (projectTableExists) {
      interface ProjectRow { path: string; name: string; }
      const pRows = db.query<ProjectRow, []>("SELECT path, name FROM projects;").all();
      for (const r of pRows) {
        seenProjects.set(r.path, { name: r.name, taskCount: 0 });
      }
    }

    if (tasksTableExists && taskCols.has("workdir")) {
      interface TaskWorkdirRow { workdir: string; }
      const wRows = db.query<TaskWorkdirRow, []>("SELECT workdir FROM tasks WHERE workdir IS NOT NULL AND workdir != '';").all();
      for (const r of wRows) {
        const existing = seenProjects.get(r.workdir);
        if (existing) {
          existing.taskCount++;
        } else {
          seenProjects.set(r.workdir, { taskCount: 1 });
        }
      }
    }

    for (const [pPath, info] of seenProjects.entries()) {
      let exists = false;
      try {
        exists = existsSync(pPath) && statSync(pPath).isDirectory();
      } catch {
        exists = false;
      }
      projects.push({
        projectPath: pPath,
        name: info.name,
        isExternal: true,
        existsOnDisk: exists,
        requiresUserIntervention: !exists,
        taskCount: info.taskCount,
      });
    }

    // 2. Ephemeral disposable worktrees
    if (tasksTableExists && taskCols.has("worktree_path")) {
      interface TaskWorktreeRow { id: string; title: string; worktree_path: string; }
      const wtRows = db.query<TaskWorktreeRow, []>(
        "SELECT id, title, worktree_path FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path != '';",
      ).all();
      for (const r of wtRows) {
        let exists = false;
        try {
          exists = existsSync(r.worktree_path) && statSync(r.worktree_path).isDirectory();
        } catch {
          exists = false;
        }
        worktrees.push({
          taskId: r.id,
          taskTitle: r.title,
          worktreePath: r.worktree_path,
          existsOnDisk: exists,
          status: exists ? "retained" : "missing-disposable",
        });
      }
    }

    // 3. Environment Profiles
    const envTableExists = (db.query<{ count: number }, [string]>(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
    ).get("environment_profiles")?.count ?? 0) > 0;

    if (envTableExists) {
      interface EnvRow { id: string; project_path: string; }
      const envRows = db.query<EnvRow, []>("SELECT id, project_path FROM environment_profiles;").all();
      for (const r of envRows) {
        environmentProfiles.push({
          id: r.id,
          projectPath: r.project_path,
          needsReconnection: true,
        });
      }
    }

    // 4. Provider Authentication Requirements (without exposing credentials)
    const harnessTableExists = (db.query<{ count: number }, [string]>(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
    ).get("harnesses")?.count ?? 0) > 0;

    if (harnessTableExists) {
      const colRows = db.query<{ name: string }, []>("PRAGMA table_info(harnesses);").all();
      const colNames = new Set(colRows.map((c) => c.name));
      const hasEnabled = colNames.has("enabled");
      const labelCol = colNames.has("label") ? "label" : (colNames.has("name") ? "name" : "id");
      const sql = hasEnabled
        ? `SELECT id, ${labelCol} as label FROM harnesses WHERE enabled = 1;`
        : `SELECT id, ${labelCol} as label FROM harnesses;`;
      interface HarnessRow { id: string; label: string; }
      const hRows = db.query<HarnessRow, []>(sql).all();
      for (const r of hRows) {
        providerAuth.push({
          harnessId: r.id,
          harnessName: r.label,
          requiresAuthCheck: true,
        });
      }
    }

    const clusterTableExists = (db.query<{ count: number }, [string]>(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
    ).get("clusters")?.count ?? 0) > 0;
    const totalClusters = clusterTableExists
      ? (db.query<{ count: number }, []>("SELECT count(*) as count FROM clusters;").get()?.count ?? 0)
      : 0;

    const totalTasks = tasksTableExists
      ? (db.query<{ count: number }, []>("SELECT count(*) as count FROM tasks;").get()?.count ?? 0)
      : 0;

    const totalExternalProjectsRequiringAttention = projects.filter((p) => p.requiresUserIntervention).length;
    const totalMissingWorktrees = worktrees.filter((w) => w.status === "missing-disposable").length;

    return {
      projects,
      worktrees,
      environmentProfiles,
      providerAuth,
      totalProjects: seenProjects.size,
      totalClusters,
      totalTasks,
      totalExternalProjectsRequiringAttention,
      totalMissingWorktrees,
    };
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

export interface RebindInternalReferencesResult {
  stats: ReferenceRebindingStats;
  databaseTransformed: boolean;
  databaseSha256: string;
  databaseBytes: number;
}

/**
 * Apply deterministic internal path rebinding to the staged SQLite database.
 * Rewrites profile-absolute internal references to point to the final destination directory.
 */
export async function rebindStagedInternalReferences(options: {
  stagingDbPath: string;
  stagingDir: string;
  finalDestPath: string;
  manifest: SnapshotManifest;
  syncFileFn: (p: string) => void;
  rebindEnabled?: boolean;
}): Promise<RebindInternalReferencesResult> {
  const { stagingDbPath, stagingDir, finalDestPath, manifest, syncFileFn } = options;
  const rebindEnabled = options.rebindEnabled !== false;

  const seenManifestPaths = new Set(
    (manifest.files ?? []).map((f) => f.path.replaceAll("\\", "/")),
  );
  const preRebindAssets = getReferencedInternalAssets(stagingDbPath, {
    dataDir: stagingDir,
    attachmentsRootDir: path.join(stagingDir, "attachments"),
    screenshotsRootDir: path.join(stagingDir, "screenshots"),
    issueThreadsRootDir: path.join(stagingDir, "issue-threads"),
    pipelineRunsRootDir: path.join(stagingDir, "pipeline-runs"),
    sourceProfileRootSha256: manifest.origin?.sourceProfileRootSha256,
    sourceProfileRealSha256: manifest.origin?.sourceProfileRealSha256,
  });

  if (manifest.manifestVersion === 3 || manifest.manifestVersion === 4) {
    const completenessIssues = validateInternalReferencesCompleteness(
      manifest,
      preRebindAssets,
      seenManifestPaths,
    );
    if (completenessIssues.length > 0) {
      throw new RestoreError(
        `Internal reference mapping validation failed: ${completenessIssues.join("; ")}`,
        "VERIFICATION_FAILED",
      );
    }
  }

  const entries = manifest.internalReferences;
  if (!Array.isArray(entries) || entries.length === 0) {
    const currentSha = await computeFileSha256(stagingDbPath);
    const currentBytes = lstatSync(stagingDbPath).size;
    return {
      stats: { discovered: 0, rebound: 0, unchanged: 0, unresolved: 0 },
      databaseTransformed: false,
      databaseSha256: currentSha,
      databaseBytes: currentBytes,
    };
  }

  if (!rebindEnabled) {
    const currentSha = await computeFileSha256(stagingDbPath);
    const currentBytes = lstatSync(stagingDbPath).size;
    const resolvedFinalDest = path.resolve(finalDestPath);
    const staleCount =
      manifest.manifestVersion === 4
        ? entries.length
        : (preRebindAssets.entries ?? []).filter(
            (e) =>
              e.refType === "profile-absolute" &&
              !path.resolve(e.rawPath).startsWith(resolvedFinalDest + path.sep),
          ).length;
    return {
      stats: {
        discovered: entries.length,
        rebound: 0,
        unchanged: Math.max(0, entries.length - staleCount),
        unresolved: staleCount,
      },
      databaseTransformed: false,
      databaseSha256: currentSha,
      databaseBytes: currentBytes,
    };
  }

  // 1. Strict schema allowlists and pre-validation
  const ALLOWED_TABLES = new Set(["tasks"]);
  const ALLOWED_COLUMNS = new Set(["refs", "attachments", "sent_files", "draft", "backlog"]);
  const ALLOWED_CATEGORIES = new Set(["attachment", "screenshot", "issue-thread", "pipeline-run"]);

  const discoveredByLocator = new Map<string, NonNullable<typeof preRebindAssets.entries>[number]>();
  for (const d of preRebindAssets.entries ?? []) {
    const locKey = d.jsonPath
      ? `${d.table ?? "tasks"}:${d.recordId ?? d.taskId ?? ""}:${d.column ?? d.field}:${d.jsonPath}`
      : `${d.table ?? "tasks"}:${d.recordId ?? d.taskId ?? ""}:${d.column ?? d.field}:${d.itemIndex}`;
    discoveredByLocator.set(locKey, d);
  }

  for (const entry of entries) {
    const tbl = entry.table ?? "tasks";
    if (!ALLOWED_TABLES.has(tbl)) {
      throw new RestoreError(`Unsupported table in reference mapping: ${tbl}`, "VERIFICATION_FAILED");
    }
    const col = entry.column ?? entry.sourceField;
    if (!ALLOWED_COLUMNS.has(col)) {
      throw new RestoreError(`Unsupported column in reference mapping: ${col}`, "VERIFICATION_FAILED");
    }
    if (entry.column && entry.sourceField && entry.column !== entry.sourceField) {
      throw new RestoreError(
        `Conflicting column (${entry.column}) and sourceField (${entry.sourceField}) in reference mapping`,
        "VERIFICATION_FAILED",
      );
    }
    if (entry.recordId && entry.taskId && entry.recordId !== entry.taskId) {
      throw new RestoreError(
        `Conflicting recordId (${entry.recordId}) and taskId (${entry.taskId}) in reference mapping`,
        "VERIFICATION_FAILED",
      );
    }
    if (entry.recordIdColumn !== undefined && entry.recordIdColumn !== "id") {
      throw new RestoreError(
        `Unsupported recordIdColumn in reference mapping: ${entry.recordIdColumn}`,
        "VERIFICATION_FAILED",
      );
    }
    if (!ALLOWED_CATEGORIES.has(entry.category)) {
      throw new RestoreError(`Unsupported category in reference mapping: ${entry.category}`, "VERIFICATION_FAILED");
    }
    const parsedPath = parseSnapshotAssetPath(entry.canonicalPath);
    if (!parsedPath.ok || parsedPath.category !== entry.category) {
      throw new RestoreError(`Invalid reference canonical path or category mismatch: ${entry.canonicalPath}`, "VERIFICATION_FAILED");
    }
    if (entry.relSubpath !== undefined && entry.relSubpath !== entry.canonicalPath) {
      throw new RestoreError(
        `Conflicting relSubpath (${entry.relSubpath}) vs canonicalPath (${entry.canonicalPath})`,
        "VERIFICATION_FAILED",
      );
    }
    if (typeof entry.rawRefSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.rawRefSha256)) {
      throw new RestoreError(
        `Missing or malformed mandatory rawRefSha256 in reference mapping for ${entry.canonicalPath}`,
        "VERIFICATION_FAILED",
      );
    }
    const stagedFile = path.join(stagingDir, entry.canonicalPath);
    if (!pathExistsOrSymlink(stagedFile)) {
      throw new RestoreError(`Referenced internal asset missing from snapshot staging: ${entry.canonicalPath}`, "VERIFICATION_FAILED");
    }
    const st = lstatSync(stagedFile);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RestoreError(`Referenced internal asset is not a regular file: ${entry.canonicalPath}`, "VERIFICATION_FAILED");
    }
  }

  // 2. Open staging SQLite database
  const db = new Database(stagingDbPath);
  let reboundCount = 0;
  let unchangedCount = 0;
  let unresolvedCount = 0;

  try {
    // Group entries by (taskId, column)
    const taskColumnMap = new Map<string, { taskId: string; col: "refs" | "attachments" | "sent_files" | "draft" | "backlog"; entries: SnapshotReferenceEntry[] }>();

    for (const entry of entries) {
      const taskId = entry.recordId ?? entry.taskId;
      if (!taskId || typeof taskId !== "string") {
        throw new RestoreError("Missing required recordId/taskId in reference mapping", "VERIFICATION_FAILED");
      }
      const col = (entry.column ?? entry.sourceField) as "refs" | "attachments" | "sent_files" | "draft" | "backlog";
      const key = `${taskId}::${col}`;
      let group = taskColumnMap.get(key);
      if (!group) {
        group = { taskId, col, entries: [] };
        taskColumnMap.set(key, group);
      }
      group.entries.push(entry);
    }

    interface PlannedUpdate {
      taskId: string;
      col: "refs" | "attachments" | "sent_files" | "draft" | "backlog";
      transformedJson: string;
    }
    const plannedUpdates: PlannedUpdate[] = [];

    interface TaskRow {
      id: string;
      refs?: string | null;
      attachments?: string | null;
      sent_files?: string | null;
      draft?: string | null;
      backlog?: string | null;
    }
    const tableInfo = db.query<{ name: string }, []>("PRAGMA table_info(tasks);").all();
    const taskCols = new Set(tableInfo.map((c) => c.name));

    const selectCols = ["id"];
    if (taskCols.has("refs")) selectCols.push("refs");
    if (taskCols.has("attachments")) selectCols.push("attachments");
    if (taskCols.has("sent_files")) selectCols.push("sent_files");
    if (taskCols.has("draft")) selectCols.push("draft");
    if (taskCols.has("backlog")) selectCols.push("backlog");

    const selectStmt = db.query<TaskRow, [string]>(`SELECT ${selectCols.join(", ")} FROM tasks WHERE id = ?;`);

    for (const group of taskColumnMap.values()) {
      const row = selectStmt.get(group.taskId);
      if (!row) {
        throw new RestoreError(`Referenced record missing from database: tasks/${group.taskId}`, "VERIFICATION_FAILED");
      }
      const rawJson = (row as unknown as Record<string, string | null | undefined>)[group.col];
      if (rawJson === null || rawJson === undefined || !rawJson.trim()) {
        throw new RestoreError(`Referenced field tasks.${group.col} is empty for task ${group.taskId}`, "VERIFICATION_FAILED");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch (err) {
        throw new RestoreError(`Referenced field tasks.${group.col} is not valid JSON for task ${group.taskId}`, "VERIFICATION_FAILED");
      }

      const clone = JSON.parse(JSON.stringify(parsed));
      const modifiedLocators = new Set<string>();

      for (const entry of group.entries) {
        if (typeof entry.rawRefSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.rawRefSha256)) {
          throw new RestoreError(
            `Missing or malformed mandatory rawRefSha256 for task ${group.taskId}`,
            "VERIFICATION_FAILED",
          );
        }

        let curVal: string | undefined;
        if (entry.jsonPath) {
          const res = getValueAtJsonPath(clone, entry.jsonPath);
          if (res.ok && typeof res.value === "string") {
            curVal = res.value;
          } else {
            throw new RestoreError(
              `Reference jsonPath (${entry.jsonPath}) did not resolve to a string path in tasks.${group.col} for task ${group.taskId}`,
              "VERIFICATION_FAILED",
            );
          }
        } else if (Array.isArray(clone) && entry.itemIndex !== undefined) {
          if (entry.itemIndex < 0 || entry.itemIndex >= clone.length) {
            throw new RestoreError(
              `Reference itemIndex ${entry.itemIndex} out of bounds for task ${group.taskId} (array length: ${clone.length})`,
              "VERIFICATION_FAILED",
            );
          }
          const item = clone[entry.itemIndex];
          curVal = typeof item === "string" ? item : (item && typeof item === "object") ? (item as { path?: unknown }).path as string : undefined;
        }

        if (typeof curVal !== "string") {
          throw new RestoreError(
            `Reference locator item does not contain a string path for task ${group.taskId}`,
            "VERIFICATION_FAILED",
          );
        }

        const actualDigest = sha256Hex(curVal);
        if (actualDigest !== entry.rawRefSha256) {
          throw new RestoreError(
            `Expected original value digest mismatch in tasks.${group.col} for task ${group.taskId}: expected ${entry.rawRefSha256}, got ${actualDigest}`,
            "VERIFICATION_FAILED",
          );
        }

        if (entry.expectedOriginalValue !== undefined && curVal !== entry.expectedOriginalValue) {
          throw new RestoreError(
            `Expected original value mismatch in tasks.${group.col} for task ${group.taskId}: expected ${entry.expectedOriginalValue}, got ${curVal}`,
            "VERIFICATION_FAILED",
          );
        }

        const locKey = entry.jsonPath
          ? `${entry.table ?? "tasks"}:${group.taskId}:${group.col}:${entry.jsonPath}`
          : `${entry.table ?? "tasks"}:${group.taskId}:${group.col}:${entry.itemIndex}`;

        let discovered = discoveredByLocator.get(locKey);
        if (!discovered && entry.itemIndex !== undefined) {
          const legacyKey = `${entry.table ?? "tasks"}:${group.taskId}:${group.col}:${entry.itemIndex}`;
          discovered = discoveredByLocator.get(legacyKey);
        }

        if (
          !discovered ||
          discovered.canonicalPath !== entry.canonicalPath ||
          discovered.category !== entry.category
        ) {
          throw new RestoreError(
            `Reference at ${locKey} is not an authenticated internal profile asset (refusing to overwrite external or mismatched path)`,
            "VERIFICATION_FAILED",
          );
        }

        if (modifiedLocators.has(locKey)) {
          throw new RestoreError(
            `Duplicate or conflicting reference mappings targeting locator ${locKey} in tasks.${group.col} for task ${group.taskId}`,
            "VERIFICATION_FAILED",
          );
        }
        modifiedLocators.add(locKey);

        const shouldRebind = manifest.manifestVersion === 4 || entry.refType === "profile-absolute";

        if (shouldRebind) {
          const finalPath = path.join(finalDestPath, entry.canonicalPath);
          if (entry.jsonPath) {
            setValueAtJsonPath(clone, entry.jsonPath, finalPath);
          } else if (Array.isArray(clone) && entry.itemIndex !== undefined) {
            const item = clone[entry.itemIndex];
            if (typeof item === "string") {
              clone[entry.itemIndex] = finalPath;
            } else if (item && typeof item === "object") {
              clone[entry.itemIndex] = { ...(item as Record<string, unknown>), path: finalPath };
            }
          }
          reboundCount++;
        } else {
          unchangedCount++;
        }
      }

      plannedUpdates.push({
        taskId: group.taskId,
        col: group.col,
        transformedJson: JSON.stringify(clone),
      });
    }

    // 3. Transactional update execution
    db.run("BEGIN IMMEDIATE TRANSACTION;");
    try {
      for (const update of plannedUpdates) {
        db.query(`UPDATE tasks SET ${update.col} = ? WHERE id = ?;`).run(update.transformedJson, update.taskId);
      }
      db.run("COMMIT;");
    } catch (err) {
      try {
        db.run("ROLLBACK;");
      } catch {
        /* ignore */
      }
      throw new RestoreError(`SQLite transaction failed during internal reference rebinding: ${(err as Error).message}`, "SQLITE_ERROR", err);
    }

    // 4. Post-transformation SQLite integrity and consistency validation
    const integrityRows = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").all();
    const integrityOk = integrityRows.length === 1 && integrityRows[0]?.integrity_check === "ok";
    if (!integrityOk) {
      const issues = integrityRows.map((r) => r.integrity_check);
      throw new RestoreError(`Post-rebinding database integrity check failed: ${issues.join("; ")}`, "VERIFICATION_FAILED");
    }

    const fkRows = db.query<{ table: string; rowid: number; parent: string; fkid: number }, []>("PRAGMA foreign_key_check;").all();
    if (fkRows.length > 0) {
      throw new RestoreError(`Post-rebinding foreign key violations detected: ${fkRows.map((v) => `${v.table}->${v.parent}`).join("; ")}`, "VERIFICATION_FAILED");
    }

    const docRevCheck = verifyDocumentRevisionConsistency(db);
    if (!docRevCheck.ok) {
      throw new RestoreError(`Post-rebinding document revision consistency check failed: ${docRevCheck.issues.join("; ")}`, "VERIFICATION_FAILED");
    }

    // 5. Staged-path mapping verification:
    // In the staged DB, references point to finalDestPath.
    // Verify each one exists in stagingDir!
    const stagedRefAssets = getReferencedInternalAssets(db, {
      dataDir: finalDestPath,
      attachmentsRootDir: path.join(finalDestPath, "attachments"),
      screenshotsRootDir: path.join(finalDestPath, "screenshots"),
      issueThreadsRootDir: path.join(finalDestPath, "issue-threads"),
      pipelineRunsRootDir: path.join(finalDestPath, "pipeline-runs"),
    });

    for (const att of stagedRefAssets.attachments) {
      if (!pathExistsOrSymlink(path.join(stagingDir, att))) {
        throw new RestoreError(`Post-rebinding referenced attachment missing from staging: ${att}`, "VERIFICATION_FAILED");
      }
    }
    for (const scr of stagedRefAssets.screenshots) {
      if (!pathExistsOrSymlink(path.join(stagingDir, scr))) {
        throw new RestoreError(`Post-rebinding referenced screenshot missing from staging: ${scr}`, "VERIFICATION_FAILED");
      }
    }
    for (const iss of stagedRefAssets.issueThreads) {
      if (!pathExistsOrSymlink(path.join(stagingDir, iss))) {
        throw new RestoreError(`Post-rebinding referenced issue thread missing from staging: ${iss}`, "VERIFICATION_FAILED");
      }
    }
    for (const pipe of stagedRefAssets.pipelineRuns) {
      if (!pathExistsOrSymlink(path.join(stagingDir, pipe))) {
        throw new RestoreError(`Post-rebinding referenced pipeline run missing from staging: ${pipe}`, "VERIFICATION_FAILED");
      }
    }

    // 5b. Verify every rebound path targets finalDestPath and no stale origin references remain
    const resolvedFinalDest = path.resolve(finalDestPath);
    for (const entry of entries) {
      const shouldBeAbsolute = manifest.manifestVersion === 4 || entry.refType === "profile-absolute";
      if (!shouldBeAbsolute) continue;
      const taskId = entry.recordId ?? entry.taskId;
      const col = (entry.column ?? entry.sourceField) as "refs" | "attachments" | "sent_files" | "draft" | "backlog";
      if (!taskId) continue;
      const row = selectStmt.get(taskId);
      const rawJson = row?.[col];
      if (!rawJson) {
        throw new RestoreError(`Post-rebinding verification failed: missing ${col} on task ${taskId}`, "VERIFICATION_FAILED");
      }
      const parsed = JSON.parse(rawJson);
      let val: string | undefined;
      if (entry.jsonPath) {
        const v = getValueAtJsonPath(parsed, entry.jsonPath);
        if (v.ok && typeof v.value === "string") val = v.value;
      } else if (Array.isArray(parsed) && entry.itemIndex !== undefined) {
        const item = parsed[entry.itemIndex];
        val = typeof item === "string" ? item : item?.path;
      }
      const expectedTarget = path.join(resolvedFinalDest, entry.canonicalPath);
      if (val !== expectedTarget || !path.resolve(val).startsWith(resolvedFinalDest + path.sep)) {
        throw new RestoreError(
          `Post-rebinding path verification failed for task ${taskId}.${col} (${entry.jsonPath ?? entry.itemIndex}): expected ${expectedTarget}, got ${String(val)}`,
          "VERIFICATION_FAILED",
        );
      }
    }

    if (
      manifest.origin?.sourceProfileRootSha256 ||
      manifest.origin?.sourceProfileRealSha256 ||
      manifest.origin?.sourceProfileAliasSha256s?.length
    ) {
      const originCheck = getReferencedInternalAssets(db, {
        sourceProfileRootSha256: manifest.origin.sourceProfileRootSha256,
        sourceProfileRealSha256: manifest.origin.sourceProfileRealSha256,
        sourceProfileAliasSha256s: manifest.origin.sourceProfileAliasSha256s,
      });
      const staleRefs = (originCheck.entries ?? []).filter(
        (r) =>
          r.refType === "profile-absolute" &&
          !path.resolve(r.rawPath).startsWith(resolvedFinalDest + path.sep),
      );
      if (staleRefs.length > 0) {
        unresolvedCount += staleRefs.length;
        throw new RestoreError(
          `Stale original-profile internal references remained after rebinding: ${staleRefs.map((s) => s.rawPath).join(", ")}`,
          "VERIFICATION_FAILED",
        );
      }
    }

    // Flush WAL to main database file
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  // Sync database file to disk
  syncFileFn(stagingDbPath);

  const transformedDbSha = await computeFileSha256(stagingDbPath);
  const transformedDbBytes = lstatSync(stagingDbPath).size;

  return {
    stats: {
      discovered: entries.length,
      rebound: reboundCount,
      unchanged: unchangedCount,
      unresolved: unresolvedCount,
    },
    databaseTransformed: reboundCount > 0,
    databaseSha256: transformedDbSha,
    databaseBytes: transformedDbBytes,
  };
}

export class BackupRestore {
  constructor(private readonly defaultOptions: RestoreOptions = {}) {}

  /**
   * Restore ForgeOrbit persistent application data from a verified snapshot into a new inactive destination directory.
   */
  async restore(
    snapshotPath: string,
    destinationPath: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    const startedAt = performance.now();
    const now = options.now ?? this.defaultOptions.now ?? Date.now;
    const createDir = options.createDirectory ?? this.defaultOptions.createDirectory ?? false;
    const dbFilename = options.dbFilename ?? this.defaultOptions.dbFilename ?? "agetor.sqlite";

    // 0. Strict validation of dbFilename to prevent path traversal
    validateDbFilename(dbFilename);

    // 1. Validate destination path syntax
    if (
      typeof destinationPath !== "string" ||
      !destinationPath.trim() ||
      destinationPath.includes("\0")
    ) {
      throw new RestoreError(
        "Invalid destination path: must be a non-empty string without null bytes.",
        "INVALID_PATH",
      );
    }

    if (destinationPath.endsWith(path.sep) || destinationPath.endsWith("/")) {
      throw new RestoreError(
        `Destination path must not end with a trailing separator: ${destinationPath}`,
        "INVALID_PATH",
      );
    }

    const resolvedDest = path.resolve(destinationPath);
    const parentDir = path.dirname(resolvedDest);

    // 2. Validate snapshot path syntax & existence
    if (
      typeof snapshotPath !== "string" ||
      !snapshotPath.trim() ||
      snapshotPath.includes("\0")
    ) {
      throw new RestoreError(
        "Invalid snapshot path: must be a non-empty string without null bytes.",
        "INVALID_PATH",
      );
    }

    const resolvedSnap = path.resolve(snapshotPath);

    // 3. Active profile protection & Overlap checks (must run before target exists checks)
    checkNotActiveDataDir(resolvedDest);
    checkPathsOverlap(resolvedSnap, resolvedDest);

    // Destination must NOT exist (fail-closed refusal to overwrite)
    if (pathExistsOrSymlink(resolvedDest)) {
      throw new RestoreError(
        `Restore destination already exists: ${resolvedDest}`,
        "TARGET_EXISTS",
      );
    }
    if (!pathExistsOrSymlink(resolvedSnap)) {
      throw new RestoreError(
        `Snapshot directory not found: ${resolvedSnap}`,
        "SNAPSHOT_NOT_FOUND",
      );
    }

    const snapStat = lstatSync(resolvedSnap);
    if (snapStat.isSymbolicLink()) {
      throw new RestoreError(
        `Snapshot path cannot be a symbolic link: ${resolvedSnap}`,
        "UNTRUSTED_SYMLINK",
      );
    }
    if (!snapStat.isDirectory()) {
      throw new RestoreError(
        `Snapshot path must be a directory: ${resolvedSnap}`,
        "INVALID_PATH",
      );
    }

    // 4. Validate or create parent directory
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
          throw new RestoreError(
            `Failed to create restore destination parent directory ${parentDir}: ${(err as Error).message}`,
            "IO_ERROR",
            err,
          );
        }
      } else {
        throw new RestoreError(
          `Destination parent directory does not exist: ${parentDir}`,
          "DIRECTORY_NOT_FOUND",
        );
      }
    } else {
      const parentStat = lstatSync(parentDir);
      if (parentStat.isSymbolicLink()) {
        throw new RestoreError(
          `Destination parent directory cannot be a symbolic link: ${parentDir}`,
          "UNTRUSTED_SYMLINK",
        );
      }
      if (!parentStat.isDirectory()) {
        throw new RestoreError(
          `Destination parent path is not a directory: ${parentDir}`,
          "INVALID_PATH",
        );
      }
    }

    // 5. Independent snapshot verification before restoration begins
    const verification: SnapshotVerificationResult = await verifyBackupSnapshot(resolvedSnap);
    if (!verification.ok || !verification.manifest) {
      throw new RestoreError(
        `Snapshot verification failed: ${verification.issues.join("; ")}`,
        "SNAPSHOT_VERIFICATION_FAILED",
      );
    }

    // Bind restoration to this validated in-memory manifest (immutable snapshot representation)
    const manifest = verification.manifest;

    if (options.expectedContentIdentity !== undefined) {
      if (
        typeof verification.contentIdentity !== "string" ||
        verification.contentIdentity !== options.expectedContentIdentity
      ) {
        throw new RestoreError(
          "The snapshot content changed after it was previewed; a new preview and confirmation are required.",
          "SNAPSHOT_CHANGED",
        );
      }
    }
    // Residual TOCTOU note: verification and extraction are separate reads of
    // the snapshot, so this is not atomic pinning. The extraction pass below
    // re-hashes every staged file against this in-memory manifest (and the
    // staged database against its manifest entry) before publication, so bytes
    // that changed between the two reads fail closed instead of being restored.

    if (
      manifest.manifestVersion !== 1 &&
      manifest.manifestVersion !== 2 &&
      manifest.manifestVersion !== 3 &&
      manifest.manifestVersion !== 4
    ) {
      throw new RestoreError(
        `Unsupported manifest version: ${manifest.manifestVersion}. Supported versions are 1, 2, 3, 4.`,
        "UNSUPPORTED_VERSION",
      );
    }

    if (options.requireCompleteProfile && verification.coverage !== "complete-profile") {
      throw new RestoreError(
        `Snapshot coverage is '${verification.coverage ?? "legacy-database-knowledge"}', but requireCompleteProfile was specified.`,
        "INCOMPLETE_PROFILE",
      );
    }

    if (manifest.schemaVersion !== null && !isSupportedSchemaVersion(manifest.schemaVersion)) {
      throw new RestoreError(
        `Snapshot requires an unknown future schema version (${manifest.schemaVersion}) that cannot be safely restored.`,
        "UNSUPPORTED_VERSION",
      );
    }

    // 6. Temporary Staging Directory Setup (exclusive creation, mode 0o700)
    const operationId = randomUUID();
    const stagingName = `.${path.basename(resolvedDest)}.fo-restore.${operationId}.tmp`;
    const stagingDir = path.join(parentDir, stagingName);

    const fs = options.fs ?? this.defaultOptions.fs;
    const syncFileFn = fs?.syncFile ?? syncFile;
    const syncDirFn = fs?.syncDirectory ?? syncDirectory;

    try {
      mkdirSync(stagingDir, { mode: 0o700 });
    } catch (err) {
      throw new RestoreError(
        `Failed to create staging directory ${stagingDir}: ${(err as Error).message}`,
        "IO_ERROR",
        err,
      );
    }

    let stagingSucceeded = false;
    /**
     * R8B: set exactly at the atomic publication commit point. Any failure after
     * this point must be classified as post-publication uncertainty — never as
     * "no artifact exists", and never by deleting the published directory.
     */
    let publicationCommitted = false;
    let filesRestored = 0;
    let totalBytesRestored = 0;
    let lockFd: number | null = null;

    try {
      try {
        chmodSync(stagingDir, 0o700);
      } catch (chmodErr) {
        throw new RestoreError(
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
        subsystem: "backup-restore",
        operationId,
        runnerOperationId: options.runnerOperationId,
        pid: process.pid,
        createdAt: now(),
        state: "preparing",
        targetPath: resolvedDest,
      };
      writeStagingOwnershipMetadata(stagingDir, metadata, false);

      // Optional test hook before extraction begins (simulates external modifications to snapshot)
      await options.beforeExtract?.(resolvedSnap);

      metadata.state = "writing";
      writeStagingOwnershipMetadata(stagingDir, metadata, false);

      await options.onStagingPrepared?.(stagingDir);

      // 7. Extract SQLite Database
      await new Promise((resolve) => setImmediate(resolve));
      const sourceDbPath = path.join(resolvedSnap, "database.sqlite");
      if (!pathExistsOrSymlink(sourceDbPath)) {
        throw new RestoreError(
          "Snapshot is missing required database.sqlite.",
          "SNAPSHOT_VERIFICATION_FAILED",
        );
      }
      const sourceDbStat = lstatSync(sourceDbPath);
      if (sourceDbStat.isSymbolicLink()) {
        throw new RestoreError(
          "Snapshot database cannot be a symbolic link.",
          "UNTRUSTED_SYMLINK",
        );
      }
      if (!sourceDbStat.isFile()) {
        throw new RestoreError(
          "Snapshot database is not a regular file.",
          "SNAPSHOT_VERIFICATION_FAILED",
        );
      }

      const stagingDbPath = path.join(stagingDir, dbFilename);
      const resolvedStagingDb = path.resolve(stagingDbPath);
      if (path.dirname(resolvedStagingDb) !== path.resolve(stagingDir)) {
        throw new RestoreError(
          `Database target escapes staging directory: ${dbFilename}`,
          "INVALID_PATH",
        );
      }

      try {
        copyFileSync(sourceDbPath, stagingDbPath, constants.COPYFILE_EXCL);
        chmodSync(stagingDbPath, 0o600);
      } catch (err) {
        throw new RestoreError(
          `Failed to extract database to staging: ${(err as Error).message}`,
          "IO_ERROR",
          err,
        );
      }

      try {
        syncFileFn(stagingDbPath);
      } catch (syncErr) {
        throw new RestoreError(
          `Failed to synchronize restored database: ${(syncErr as Error).message}`,
          "IO_ERROR",
          syncErr,
        );
      }

      const dbStat = statSync(stagingDbPath);
      filesRestored++;
      totalBytesRestored += dbStat.size;

      // 8. Extract Knowledge Documents and Durable Persistent Assets
      let knowledgeRevisionCount = 0;
      let attachmentCount = 0;
      let screenshotCount = 0;
      let issueThreadCount = 0;
      let pipelineRunCount = 0;

      const seenManifestPaths = new Set<string>();
      for (const fileEntry of manifest.files) {
        if (seenManifestPaths.has(fileEntry.path)) {
          throw new RestoreError(
            `Snapshot manifest contains duplicate path: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }
        seenManifestPaths.add(fileEntry.path);
        if (fileEntry.path === "database.sqlite") continue;

        const parsed = parseSnapshotAssetPath(fileEntry.path);
        if (!parsed.ok) {
          // Reject foreign, unexpected, or malformed file types from being restored
          throw new RestoreError(
            `Snapshot contains unexpected file not permitted for restoration: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }
        if (manifest.manifestVersion === 1 && parsed.category !== "knowledge") {
          throw new RestoreError(
            `Manifest version 1 snapshot contains non-knowledge asset: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }
        if (parsed.category === "brain" && (manifest.manifestVersion !== 4 || manifest.brain?.coverage !== "included")) {
          throw new RestoreError(
            `Brain files are not part of this snapshot: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }

        switch (parsed.category) {
          case "knowledge":
            knowledgeRevisionCount++;
            break;
          case "attachment":
            attachmentCount++;
            break;
          case "screenshot":
            screenshotCount++;
            break;
          case "issue-thread":
            issueThreadCount++;
            break;
          case "pipeline-run":
            pipelineRunCount++;
            break;
          case "brain":
            break;
        }

        // Symlink and path traversal defense
        assertNoSymlinksInPath(resolvedSnap, fileEntry.path);

        const sourceFile = path.join(resolvedSnap, fileEntry.path);
        if (!pathExistsOrSymlink(sourceFile)) {
          throw new RestoreError(
            `Snapshot file is missing: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }
        const sourceFileStat = lstatSync(sourceFile);
        if (sourceFileStat.isSymbolicLink()) {
          throw new RestoreError(
            `Snapshot file is a symbolic link: ${fileEntry.path}`,
            "UNTRUSTED_SYMLINK",
          );
        }
        if (!sourceFileStat.isFile()) {
          throw new RestoreError(
            `Snapshot file is not a regular file: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }

        const targetFile = path.join(stagingDir, fileEntry.path);
        const targetFileDir = path.dirname(targetFile);

        if (!existsSync(targetFileDir)) {
          mkdirSync(targetFileDir, { recursive: true, mode: 0o700 });
        }

        try {
          copyFileSync(sourceFile, targetFile, constants.COPYFILE_EXCL);
          chmodSync(targetFile, 0o600);
        } catch (err) {
          throw new RestoreError(
            `Failed to extract file ${fileEntry.path}: ${(err as Error).message}`,
            "IO_ERROR",
            err,
          );
        }

        try {
          syncFileFn(targetFile);
          syncDirFn(targetFileDir);
        } catch (syncErr) {
          throw new RestoreError(
            `Failed to synchronize restored file ${targetFile}: ${(syncErr as Error).message}`,
            "IO_ERROR",
            syncErr,
          );
        }

        const fileStat = statSync(targetFile);
        filesRestored++;
        totalBytesRestored += fileStat.size;
      }

      for (const sub of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs", "brain"]) {
        const subPath = path.join(stagingDir, sub);
        if (existsSync(subPath)) {
          try {
            syncDirFn(subPath);
          } catch {
            /* best effort */
          }
        }
      }
      try {
        syncDirFn(stagingDir);
      } catch (syncErr) {
        throw new RestoreError(
          `Failed to synchronize staging directory: ${(syncErr as Error).message}`,
          "IO_ERROR",
          syncErr,
        );
      }

      // 9. Optional test hook after extraction
      await options.afterExtract?.(stagingDir);

      // 10. Post-Extraction Verification Pass against Captured Manifest
      await new Promise((resolve) => setImmediate(resolve));

      // 10a. Validate staged SQLite database against captured manifest
      const dbEntry = manifest.files.find((f) => f.path === "database.sqlite");
      if (!dbEntry) {
        throw new RestoreError(
          "Snapshot manifest does not contain a database.sqlite record.",
          "VERIFICATION_FAILED",
        );
      }

      const stagingDbStat = lstatSync(stagingDbPath);
      if (stagingDbStat.isSymbolicLink() || !stagingDbStat.isFile()) {
        throw new RestoreError(
          "Restored database entry is not a regular file.",
          "VERIFICATION_FAILED",
        );
      }

      if (stagingDbStat.size !== dbEntry.bytes) {
        throw new RestoreError(
          `Restored database size mismatch: expected ${dbEntry.bytes} bytes, got ${stagingDbStat.size}`,
          "VERIFICATION_FAILED",
        );
      }

      const dbSha256 = await computeFileSha256(stagingDbPath);
      const originalDatabaseSha256 = dbEntry.sha256;
      if (dbSha256 !== dbEntry.sha256) {
        throw new RestoreError(
          `Restored database checksum mismatch: expected ${dbEntry.sha256}, got ${dbSha256}`,
          "VERIFICATION_FAILED",
        );
      }

      const disposeLag = beginLagLabel("sqlite restore integrity check");
      try {
        const integrity = BackupCore.verifyIntegrity(stagingDbPath);
        if (!integrity.ok) {
          throw new RestoreError(
            `Restored database integrity check failed: ${integrity.issues.join("; ")}`,
            "VERIFICATION_FAILED",
          );
        }
      } finally {
        disposeLag();
      }

      // Verify schema version of restored database matches manifest and is supported (P2-5)
      let restoredSchema: string | null = null;
      try {
        restoredSchema = getDatabaseSchemaVersion(stagingDbPath);
      } catch (err) {
        throw new RestoreError(
          `Failed to read schema version from restored database: ${(err as Error).message}`,
          "SQLITE_ERROR",
          err,
        );
      }
      if (manifest.schemaVersion !== restoredSchema) {
        throw new RestoreError(
          `Restored database schema version '${restoredSchema}' does not match manifest schema version '${manifest.schemaVersion}'.`,
          "VERIFICATION_FAILED",
        );
      }
      if (restoredSchema !== null && !isSupportedSchemaVersion(restoredSchema)) {
        throw new RestoreError(
          `Restored database requires an unsupported future schema version: ${restoredSchema}`,
          "UNSUPPORTED_VERSION",
        );
      }

      // Verify document-revision consistency on restored database (P2-7)
      const docConsistency = verifyDocumentRevisionConsistency(stagingDbPath);
      if (!docConsistency.ok) {
        throw new RestoreError(
          `Restored database document-revision consistency check failed: ${docConsistency.issues.join("; ")}`,
          "VERIFICATION_FAILED",
        );
      }

      // 10b. Validate all staged knowledge files against captured manifest
      for (const fileEntry of manifest.files) {
        if (fileEntry.path === "database.sqlite") continue;

        const stagedFile = path.join(stagingDir, fileEntry.path);
        if (!pathExistsOrSymlink(stagedFile)) {
          throw new RestoreError(
            `Restored snapshot is missing expected file: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }

        const st = lstatSync(stagedFile);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new RestoreError(
            `Restored entry is not a regular file: ${fileEntry.path}`,
            "VERIFICATION_FAILED",
          );
        }

        if (st.size !== fileEntry.bytes) {
          throw new RestoreError(
            `Restored file size mismatch for ${fileEntry.path}: expected ${fileEntry.bytes}, got ${st.size}`,
            "VERIFICATION_FAILED",
          );
        }

        const actualSha = await computeFileSha256(stagedFile);
        if (actualSha !== fileEntry.sha256) {
          throw new RestoreError(
            `Restored file checksum mismatch for ${fileEntry.path}: expected ${fileEntry.sha256}, got ${actualSha}`,
            "VERIFICATION_FAILED",
          );
        }
      }

      if (manifest.manifestVersion === 4) {
        const brainIssues = verifyPackagedBrain(stagingDir, manifest.brain, manifest.files);
        if (brainIssues.length > 0) {
          throw new RestoreError(
            `Brain restore verification failed: ${brainIssues.join("; ")}`,
            "VERIFICATION_FAILED",
          );
        }
      }

      // 10c. Verify no extra unmanifested files exist in staging
      const expectedStagedRelPaths = new Set<string>();
      expectedStagedRelPaths.add(dbFilename);
      for (const f of manifest.files) {
        if (f.path !== "database.sqlite") {
          expectedStagedRelPaths.add(f.path);
        }
      }

      function checkStagingDir(curr: string) {
        let entries: string[];
        try {
          entries = readdirSync(curr);
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(curr, entry);
          const rel = path.relative(stagingDir, full);
          if (rel === ".forgeorbit-ownership.json" || rel === ".lock") continue;
          const st = lstatSync(full);
          if (st.isDirectory()) {
            checkStagingDir(full);
          } else if (st.isFile()) {
            if (!expectedStagedRelPaths.has(rel)) {
              throw new RestoreError(
                `Unmanifested file found in staging directory: ${rel}`,
                "VERIFICATION_FAILED",
              );
            }
            if (rel !== dbFilename) {
              const norm = rel.replaceAll("\\", "/");
              const parsed = parseSnapshotAssetPath(norm);
              if (!parsed.ok) {
                throw new RestoreError(
                  `Unexpected file layout in staging directory: ${rel}`,
                  "VERIFICATION_FAILED",
                );
              }
              if (manifest.manifestVersion === 1 && parsed.category !== "knowledge") {
                throw new RestoreError(
                  `Manifest version 1 staging directory contains non-knowledge asset: ${rel}`,
                  "VERIFICATION_FAILED",
                );
              }
            }
          } else {
            throw new RestoreError(
              `Untrusted object found in staging directory: ${rel}`,
              "VERIFICATION_FAILED",
            );
          }
        }
      }
      checkStagingDir(stagingDir);

      // Check that no transient SQLite WAL or SHM files exist in staging
      if (pathExistsOrSymlink(`${stagingDbPath}-wal`)) {
        throw new RestoreError(
          "Transient SQLite WAL file detected in restored database directory.",
          "VERIFICATION_FAILED",
        );
      }
      if (pathExistsOrSymlink(`${stagingDbPath}-shm`)) {
        throw new RestoreError(
          "Transient SQLite SHM file detected in restored database directory.",
          "VERIFICATION_FAILED",
        );
      }

      // Check that no PID files, active credential files, or tokens were restored
      const forbiddenFiles = [
        "agetor.pid",
        "forgeorbit.pid",
        "agetor-core.json",
        "core-creds.json",
        "agetor.creds.json",
        "github-tokens.json",
        "desktop-instance.lock",
        "daemon.log",
      ];
      for (const forbidden of forbiddenFiles) {
        if (pathExistsOrSymlink(path.join(stagingDir, forbidden))) {
          throw new RestoreError(
            `Forbidden runtime artifact detected in staging: ${forbidden}`,
            "VERIFICATION_FAILED",
          );
        }
      }
      const forbiddenDirs = [
        "daemon-logs",
        "ui-logs",
        "gemini-inputs",
        "interview-scratch",
        "environment-markers",
      ];
      for (const forbidden of forbiddenDirs) {
        if (pathExistsOrSymlink(path.join(stagingDir, forbidden))) {
          throw new RestoreError(
            `Forbidden runtime directory detected in staging: ${forbidden}`,
            "VERIFICATION_FAILED",
          );
        }
      }

      // Cross-verify knowledge document references from the staged database
      const referencedRevisions = getReferencedKnowledgeRevisions(stagingDbPath);
      const expectedKnowledgePaths = new Set<string>();
      for (const rev of referencedRevisions) {
        const expectedRel = path.join("knowledge", "bodies", rev.document_id, `${rev.revision}.md`);
        expectedKnowledgePaths.add(expectedRel);
        expectedKnowledgePaths.add(`knowledge/bodies/${rev.document_id}/${rev.revision}.md`);
        const stagedFile = path.join(stagingDir, expectedRel);

        if (!pathExistsOrSymlink(stagedFile)) {
          throw new RestoreError(
            `Restored database references knowledge file missing from staging: ${expectedRel}`,
            "VERIFICATION_FAILED",
          );
        }

        const st = lstatSync(stagedFile);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new RestoreError(
            `Restored knowledge entry is not a regular file: ${expectedRel}`,
            "VERIFICATION_FAILED",
          );
        }

        if (st.size !== rev.byte_length) {
          throw new RestoreError(
            `Restored knowledge file size mismatch for ${expectedRel}: expected ${rev.byte_length}, got ${st.size}`,
            "VERIFICATION_FAILED",
          );
        }

        const actualSha = await computeFileSha256(stagedFile);
        if (actualSha !== rev.content_sha256) {
          throw new RestoreError(
            `Restored knowledge file checksum mismatch for ${expectedRel}: expected ${rev.content_sha256}, got ${actualSha}`,
            "VERIFICATION_FAILED",
          );
        }
      }

      // Reverse check: all staged knowledge files must be referenced by the database (P2-3)
      for (const f of manifest.files) {
        if (f.path === "database.sqlite") continue;
        const norm = f.path.replaceAll("\\", "/");
        if (norm.startsWith("knowledge/")) {
          if (!expectedKnowledgePaths.has(norm)) {
            throw new RestoreError(
              `Restored staging directory contains unreferenced knowledge file not in database: ${f.path}`,
              "VERIFICATION_FAILED",
            );
          }
        }
      }

      // 10d. If manifestVersion === 2, 3 or 4, cross-verify all referenced internal assets
      if (
        manifest.manifestVersion === 2 ||
        manifest.manifestVersion === 3 ||
        manifest.manifestVersion === 4
      ) {
        const refAssets = getReferencedInternalAssets(stagingDbPath, {
          dataDir: stagingDir,
          attachmentsRootDir: path.join(stagingDir, "attachments"),
          screenshotsRootDir: path.join(stagingDir, "screenshots"),
          issueThreadsRootDir: path.join(stagingDir, "issue-threads"),
          pipelineRunsRootDir: path.join(stagingDir, "pipeline-runs"),
          sourceProfileRootSha256: manifest.origin?.sourceProfileRootSha256,
          sourceProfileRealSha256: manifest.origin?.sourceProfileRealSha256,
          sourceProfileAliasSha256s: manifest.origin?.sourceProfileAliasSha256s,
        });
        for (const att of refAssets.attachments) {
          const stagedAtt = path.join(stagingDir, att);
          if (!pathExistsOrSymlink(stagedAtt)) {
            throw new RestoreError(
              `Restored database references attachment file missing from staging: ${att}`,
              "VERIFICATION_FAILED",
            );
          }
        }
        for (const scr of refAssets.screenshots) {
          const stagedScr = path.join(stagingDir, scr);
          if (!pathExistsOrSymlink(stagedScr)) {
            throw new RestoreError(
              `Restored database references screenshot file missing from staging: ${scr}`,
              "VERIFICATION_FAILED",
            );
          }
        }
        for (const iss of refAssets.issueThreads) {
          const stagedIss = path.join(stagingDir, iss);
          if (!pathExistsOrSymlink(stagedIss)) {
            throw new RestoreError(
              `Restored database references issue thread file missing from staging: ${iss}`,
              "VERIFICATION_FAILED",
            );
          }
        }
        for (const pipe of refAssets.pipelineRuns) {
          const stagedPipe = path.join(stagingDir, pipe);
          if (!pathExistsOrSymlink(stagedPipe)) {
            throw new RestoreError(
              `Restored database references pipeline handoff file missing from staging: ${pipe}`,
              "VERIFICATION_FAILED",
            );
          }
        }

        if (manifest.manifestVersion === 4) {
          // Only v4 reference completeness is provable; legacy v3 completeness
          // is NOT validated because origin metadata is unauthenticated.
          const seenStagedManifestPaths = new Set(
            manifest.files.map((f) => f.path.replaceAll("\\", "/")),
          );
          const completenessIssues = validateInternalReferencesCompleteness(
            manifest,
            refAssets,
            seenStagedManifestPaths,
          );
          if (completenessIssues.length > 0) {
            throw new RestoreError(
              `Snapshot internalReferences completeness check failed: ${completenessIssues.join("; ")}`,
              "SNAPSHOT_VERIFICATION_FAILED",
            );
          }
        }

        // Reverse task reference check for issue-threads and pipeline-runs
        let snapDb: Database | null = null;
        try {
          snapDb = new Database(stagingDbPath, { readonly: true });
          const hasTasksTable = (snapDb.query<{ count: number }, [string]>(
            "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
          ).get("tasks")?.count ?? 0) > 0;

          const allTaskIds = new Set<string>();
          if (hasTasksTable) {
            const rows = snapDb.query<{ id: string }, []>("SELECT id FROM tasks;").all();
            for (const r of rows) allTaskIds.add(r.id);
          }

          for (const f of manifest.files) {
            const norm = f.path.replaceAll("\\", "/");
            if (norm.startsWith("issue-threads/")) {
              const parts = norm.split("/");
              if (parts.length >= 3 && parts[1] && !allTaskIds.has(parts[1])) {
                throw new RestoreError(
                  `Restored staging directory contains issue thread file for non-existent task: ${f.path}`,
                  "VERIFICATION_FAILED",
                );
              }
            } else if (norm.startsWith("pipeline-runs/")) {
              const parts = norm.split("/");
              if (parts.length >= 3 && parts[1] && !allTaskIds.has(parts[1])) {
                throw new RestoreError(
                  `Restored staging directory contains pipeline handoff file for non-existent parent task: ${f.path}`,
                  "VERIFICATION_FAILED",
                );
              }
            }
          }
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

      const docCount = getKnowledgeDocumentCount(stagingDbPath);

      // 10e. Build structured recovery preview from the staged database
      const recoveryPreview = buildRecoveryPreview(stagingDbPath);

      // Detect cross-profile references and unresolved external operational references
      let unresolvedCrossProfileReferences = 0;
      let crossProfileDependencies: string[] = [];
      let unresolvedExternalReferences = 0;
      let unresolvedExternalDependencies: string[] = [];
      try {
        const scanSnapDb = new Database(stagingDbPath, { readonly: true });
        try {
          const stagedAssets = getReferencedInternalAssets(scanSnapDb, {
            dataDir: stagingDir,
            attachmentsRootDir: path.join(stagingDir, "attachments"),
            screenshotsRootDir: path.join(stagingDir, "screenshots"),
            issueThreadsRootDir: path.join(stagingDir, "issue-threads"),
            pipelineRunsRootDir: path.join(stagingDir, "pipeline-runs"),
            sourceProfileRootSha256: manifest.origin?.sourceProfileRootSha256,
            sourceProfileRealSha256: manifest.origin?.sourceProfileRealSha256,
            sourceProfileAliasSha256s: manifest.origin?.sourceProfileAliasSha256s,
          });
          if (stagedAssets.crossProfileReferences && stagedAssets.crossProfileReferences.length > 0) {
            unresolvedCrossProfileReferences = stagedAssets.crossProfileReferences.length;
            crossProfileDependencies = Array.from(
              new Set(stagedAssets.crossProfileReferences.map((r) => r.rawPath)),
            );
          }
          if (stagedAssets.unresolvedExternalReferences && stagedAssets.unresolvedExternalReferences.length > 0) {
            unresolvedExternalReferences = stagedAssets.unresolvedExternalReferences.length;
            unresolvedExternalDependencies = Array.from(
              new Set(stagedAssets.unresolvedExternalReferences.map((r) => r.rawPath)),
            );
          }
        } finally {
          scanSnapDb.close();
        }
      } catch (err) {
        if (err instanceof RestoreError) throw err;
      }

      if (options.requireCompleteProfile && unresolvedCrossProfileReferences > 0) {
        throw new RestoreError(
          `Snapshot restore failed requireCompleteProfile: external profile dependencies detected: ${crossProfileDependencies.join(", ")}`,
          "INCOMPLETE_PROFILE",
        );
      }

      // 10f. Perform transactional internal reference rebinding (v4 only).
      // Legacy v1/v2/v3 snapshots never receive automatic reference rebinding:
      // their absolute references cannot be authenticated against forgeable
      // origin metadata, so they are restored verbatim and reported unverified.
      let rebindRes: RebindInternalReferencesResult;
      if (manifest.manifestVersion === 4) {
        rebindRes = await rebindStagedInternalReferences({
          stagingDbPath,
          stagingDir,
          finalDestPath: resolvedDest,
          manifest,
          syncFileFn,
          rebindEnabled: options.rebindInternalReferences,
        });
      } else {
        rebindRes = {
          stats: { discovered: 0, rebound: 0, unchanged: 0, unresolved: 0 },
          databaseTransformed: false,
          databaseSha256: await computeFileSha256(stagingDbPath),
          databaseBytes: lstatSync(stagingDbPath).size,
        };
      }

      // Determine activation readiness
      let activationReadiness: ActivationReadiness;
      if (manifest.manifestVersion !== 4) {
        // Legacy v1/v2/v3: automatic recovery readiness is never claimed.
        // Manual reference reconnection is required (or the caller fails closed).
        activationReadiness = "legacy-unverified";
      } else if (unresolvedCrossProfileReferences > 0) {
        activationReadiness = "requires-external-recovery";
      } else if (unresolvedExternalReferences > 0) {
        activationReadiness = "requires-external-recovery";
      } else if (options.rebindInternalReferences === false) {
        activationReadiness = "requires-reference-repair";
      } else if (rebindRes.stats.unresolved > 0) {
        activationReadiness = "requires-reference-repair";
      } else if (recoveryPreview.totalExternalProjectsRequiringAttention > 0) {
        activationReadiness = "requires-external-recovery";
      } else {
        activationReadiness = "ready";
      }

      const finalDbSha256 = rebindRes.databaseSha256;
      const finalDbBytes = rebindRes.databaseBytes;
      const databaseTransformed = rebindRes.databaseTransformed;

      // 11. Optional hook before atomic publication
      await options.beforePublish?.(stagingDir);

      // Final collision guard right before atomic publish
      if (pathExistsOrSymlink(resolvedDest)) {
        throw new RestoreError(
          `Destination path was created concurrently during restore: ${resolvedDest}`,
          "TARGET_EXISTS",
        );
      }

      // 12. Atomic Publication via exclusive no-replace directory publication
      metadata.state = "publishing";
      writeStagingOwnershipMetadata(stagingDir, metadata, false);

      // Clean up staging lock and metadata before atomic publish so destination directory is clean
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

      // Persist structured recovery preview inside staging directory before atomic publish
      try {
        const recoverySummary = {
          snapshotId: manifest.snapshotId,
          manifestVersion: manifest.manifestVersion,
          appVersion: manifest.appVersion,
          restoredAt: now(),
          runnerOperationId: options.runnerOperationId,
          originalDatabaseSha256,
          databaseSha256: finalDbSha256,
          databaseTransformed,
          rebindingStats: rebindRes.stats,
          activationReadiness,
          unresolvedCrossProfileReferences,
          crossProfileDependencies,
          unresolvedExternalReferences,
          unresolvedExternalDependencies,
          recoveryPreview,
        };
        const stagedRecoveryPath = path.join(stagingDir, RESTORE_RECOVERY_FILENAME);
        writeFileSync(
          stagedRecoveryPath,
          JSON.stringify(recoverySummary, null, 2),
          { mode: 0o600 },
        );
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
        publishFn(stagingDir, resolvedDest);
        stagingSucceeded = true;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "EEXIST" || code === "TARGET_EXISTS" || pathExistsOrSymlink(resolvedDest)) {
          throw new RestoreError(
            `Restore destination already exists: ${resolvedDest}`,
            "TARGET_EXISTS",
          );
        }
        throw new RestoreError(
          `Failed to publish restored directory to ${resolvedDest}: ${(err as Error).message}`,
          "IO_ERROR",
          err,
        );
      }

      // Precise publication commit point reached: destination directory is published.
      // From here on, every failure is post-publication uncertainty (R8B). The
      // published directory is preserved; it is never deleted to conceal an error.
      publicationCommitted = true;
      try {
        await options.afterPublish?.(resolvedDest);

        // Verify final restored directory contains the expected database file
        const finalDbPath = path.join(resolvedDest, dbFilename);
        if (!pathExistsOrSymlink(finalDbPath)) {
          throw new RestoreError(
            `Restored destination directory is missing expected database: ${dbFilename}`,
            "VERIFICATION_FAILED",
          );
        }

        // Verify published database file integrity and checksum against staged transformation
        const actualFinalDbSha = await computeFileSha256(finalDbPath);
        if (actualFinalDbSha !== finalDbSha256) {
          throw new RestoreError(
            `Published database checksum mismatch: expected ${finalDbSha256}, got ${actualFinalDbSha}`,
            "VERIFICATION_FAILED",
          );
        }

        // Verify all rebound internal assets exist at destination after publication
        if (databaseTransformed && Array.isArray(manifest.internalReferences)) {
          for (const ref of manifest.internalReferences) {
            if (manifest.manifestVersion === 4 || ref.refType === "profile-absolute") {
              const finalAssetPath = path.join(resolvedDest, ref.canonicalPath);
              if (!pathExistsOrSymlink(finalAssetPath)) {
                throw new RestoreError(
                  `Rebound internal asset missing from destination after publish: ${ref.canonicalPath}`,
                  "VERIFICATION_FAILED",
                );
              }
            }
          }
        }

        try {
          chmodSync(resolvedDest, 0o700);
        } catch {
          /* best effort */
        }

        try {
          syncDirFn(parentDir);
        } catch (syncErr) {
          throw new RestoreError(
            `Failed to synchronize restored destination directory: ${(syncErr as Error).message}`,
            "PUBLISHED_UNCONFIRMED",
            syncErr,
            {
              destinationPath: resolvedDest,
              committedAt: "publication",
              destinationVerified: false,
              verificationFailed: false,
              causeCode: "IO_ERROR",
            },
          );
        }

        // FO-P2-005-A: the restore is only "confirmed" once the published
        // directory, its database digest and its recovery report have all been
        // verified at the final location. Activation requires this marker, so a
        // merely published (PUBLISHED_UNCONFIRMED / INDETERMINATE) directory
        // that never reached this point can never be activated. The marker is
        // bound to the report bytes, snapshot, runner operation and database.
        const finalReportPath = path.join(resolvedDest, RESTORE_RECOVERY_FILENAME);
        let finalReportSha256 = "";
        try {
          finalReportSha256 = createHash("sha256").update(readFileSync(finalReportPath)).digest("hex");
        } catch (reportErr) {
          throw new RestoreError(
            `Restore published but its recovery report is unreadable: ${(reportErr as Error).message}`,
            "PUBLISHED_UNCONFIRMED",
            reportErr,
            {
              destinationPath: resolvedDest,
              committedAt: "publication",
              destinationVerified: false,
              verificationFailed: false,
              causeCode: "IO_ERROR",
            },
          );
        }
        const confirmationPath = path.join(resolvedDest, RESTORE_CONFIRMATION_FILENAME);
        const confirmationTmp = `${confirmationPath}.${randomUUID()}.tmp`;
        try {
          writeFileSync(
            confirmationTmp,
            JSON.stringify(
              {
                version: 1,
                snapshotId: manifest.snapshotId,
                runnerOperationId: options.runnerOperationId ?? null,
                databaseSha256: finalDbSha256,
                databaseBytes: finalDbBytes,
                recoveryReportSha256: finalReportSha256,
                confirmedAt: now(),
                destinationPath: resolvedDest,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          syncFile(confirmationTmp);
          renameSync(confirmationTmp, confirmationPath);
          syncDirectory(resolvedDest);
          syncDirFn(parentDir);
        } catch (markerErr) {
          try {
            unlinkSync(confirmationTmp);
          } catch {
            /* best effort */
          }
          throw new RestoreError(
            `Restore published but its confirmation marker could not be written: ${(markerErr as Error).message}`,
            "PUBLISHED_UNCONFIRMED",
            markerErr,
            {
              destinationPath: resolvedDest,
              committedAt: "publication",
              destinationVerified: false,
              verificationFailed: false,
              causeCode: "IO_ERROR",
            },
          );
        }
      } catch (postPublishErr) {
        if (postPublishErr instanceof RestoreError) {
          if (postPublishErr.code === "PUBLISHED_UNCONFIRMED") throw postPublishErr;
          const verificationFailed = postPublishErr.code === "VERIFICATION_FAILED";
          const detailIssues = (postPublishErr.details as { verificationIssues?: unknown } | undefined)
            ?.verificationIssues;
          const issues = Array.isArray(detailIssues)
            ? detailIssues
                .filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
                .slice(0, 20)
                .map((issue) => issue.slice(0, 500))
            : [];
          throw new RestoreError(
            postPublishErr.message,
            "PUBLISHED_UNCONFIRMED",
            postPublishErr,
            {
              destinationPath: resolvedDest,
              committedAt: "publication",
              destinationVerified: false,
              verificationFailed,
              verificationInterrupted: false,
              causeCode: postPublishErr.code,
              verificationIssues:
                issues.length > 0 ? issues : verificationFailed ? [postPublishErr.message.slice(0, 500)] : [],
            },
          );
        }
        throw new RestoreError(
          `Restore published but post-publication finalization failed: ${(postPublishErr as Error).message}`,
          "PUBLISHED_UNCONFIRMED",
          postPublishErr,
          {
            destinationPath: resolvedDest,
            committedAt: "publication",
            destinationVerified: false,
            verificationFailed: false,
            causeCode: (postPublishErr as { code?: string })?.code,
          },
        );
      }

      const durationMs = Math.round(performance.now() - startedAt);

      return {
        destinationPath: resolvedDest,
        snapshotId: manifest.snapshotId,
        manifestVersion: manifest.manifestVersion,
        appVersion: manifest.appVersion,
        schemaVersion: manifest.schemaVersion,
        dbFilename,
        databaseBytes: finalDbBytes,
        originalDatabaseSha256,
        databaseSha256: finalDbSha256,
        databaseTransformed,
        knowledgeDocumentCount: docCount,
        knowledgeRevisionCount: referencedRevisions.length,
        attachmentCount:
          manifest.manifestVersion === 2 ||
          manifest.manifestVersion === 3 ||
          manifest.manifestVersion === 4 ||
          attachmentCount > 0
            ? attachmentCount
            : undefined,
        screenshotCount:
          manifest.manifestVersion === 2 ||
          manifest.manifestVersion === 3 ||
          manifest.manifestVersion === 4 ||
          screenshotCount > 0
            ? screenshotCount
            : undefined,
        issueThreadCount:
          manifest.manifestVersion === 2 ||
          manifest.manifestVersion === 3 ||
          manifest.manifestVersion === 4 ||
          issueThreadCount > 0
            ? issueThreadCount
            : undefined,
        pipelineRunCount:
          manifest.manifestVersion === 2 ||
          manifest.manifestVersion === 3 ||
          manifest.manifestVersion === 4 ||
          pipelineRunCount > 0
            ? pipelineRunCount
            : undefined,
        filesRestored,
        totalBytesRestored,
        durationMs,
        restoredAt: now(),
        coverage: verification.coverage,
        rebindingStats: rebindRes.stats,
        internalReferencesDiscovered: rebindRes.stats.discovered,
        internalReferencesRebound: rebindRes.stats.rebound,
        internalReferencesUnresolved: rebindRes.stats.unresolved,
        unresolvedCrossProfileReferences,
        crossProfileDependencies,
        unresolvedExternalReferences,
        unresolvedExternalDependencies,
        externalProjectsRequiringAttention: recoveryPreview.totalExternalProjectsRequiringAttention,
        validationStatus: "valid",
        activationReadiness,
        recoveryPreview,
      };
    } finally {
      if (lockFd !== null) {
        releaseFlock(lockFd);
        try {
          closeSync(lockFd);
        } catch {
          /* ignore */
        }
      }
      // Never delete a published destination: once the commit point is reached the
      // staging directory *is* the destination. Pre-publication staging is cleaned.
      if (!stagingSucceeded && !publicationCommitted) {
        try {
          if (existsSync(stagingDir)) {
            rmSync(stagingDir, { recursive: true, force: true });
          }
        } catch {
          /* best effort cleanup */
        }
      }
    }
  }

  /**
   * Safely scan a directory and clean up orphan staging directories owned by restore operations.
   */
  static cleanIncompleteRestoreStaging(directory: string): { cleaned: string[]; errors: string[] } {
    return cleanSubsystemStaging(directory, "backup-restore", RESTORE_STAGING_SCAN_RE);
  }
}

/**
 * Convenient standalone helper to restore a backup snapshot.
 */
export async function restoreBackupSnapshot(
  snapshotPath: string,
  destinationPath: string,
  options?: RestoreOptions,
): Promise<RestoreResult> {
  const core = new BackupRestore();
  return core.restore(snapshotPath, destinationPath, options);
}

/**
 * Convenient standalone helper to clean up incomplete restore staging directories.
 */
export function cleanIncompleteRestoreStaging(directory: string): { cleaned: string[]; errors: string[] } {
  return BackupRestore.cleanIncompleteRestoreStaging(directory);
}
