/**
 * Typed contracts and lifecycle definitions for isolated Backup/Restore runner (FO-P2-003-R4A).
 *
 * Enforces bounded IPC summaries, strict schema validation, and trustworthy completion.
 */

import type { BackupResult, ForeignKeyViolation, IntegrityCheckResult } from "./backup-core.ts";
import type {
  SnapshotAssetCategory,
  SnapshotCoverage,
  SnapshotResult,
  SnapshotVerificationResult,
} from "./backup-manager.ts";
import type { RestoreResult } from "./backup-restore.ts";
import type { BackupRecoveryPreview } from "../shared/backup.ts";
import type { SnapshotBrainRecord } from "../shared/brain/snapshot.ts";

/** Strict maximum byte length for a single IPC frame (line). Prevents memory blowup. */
export const MAX_IPC_FRAME_BYTES = 64 * 1024; // 64 KiB

/** Maximum buffered bytes before rejecting as IPC frame overflow. */
export const MAX_IPC_BUFFER_BYTES = 128 * 1024; // 128 KiB

/** Maximum bytes of child stderr retained for diagnostic logging without leaking secrets. */
export const MAX_STDERR_TAIL_BYTES = 16 * 1024; // 16 KiB

export type BackupOperationType =
  | "backup-database"
  | "verify-database"
  | "create-snapshot"
  | "verify-snapshot"
  | "restore-snapshot";

export type BackupOperationState =
  | "queued"
  | "running"
  | "verifying"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled";

/** States that a worker process is allowed to emit over IPC. Note: "completed" is strictly forbidden. */
export type WorkerOperationState = "running" | "verifying" | "publishing";
export type WorkerMessageState = WorkerOperationState;

/**
 * Publication and artifact integrity are independent questions (R9):
 *  - publication asks whether THIS operation created a durable artifact;
 *  - integrity asks whether that exact artifact passed independent verification.
 * A committed publication never implies a verified artifact and a failed
 * verification never implies that nothing was published.
 */
export type PublicationOutcome = "not_published" | "committed" | "unresolved";

export type ArtifactIntegrityOutcome = "verified" | "failed" | "not_verified" | "interrupted";

export interface SafeProgressInfo {
  phase?: string;
  bytesProcessed?: number;
  totalBytes?: number;
  filesProcessed?: number;
  totalFiles?: number;
  message?: string;
  timestamp: number;
}

// ── Bounded worker error diagnostics (R9) ────────────────────────────────────

/** Maximum characters retained for a serialized error message. */
export const MAX_IPC_ERROR_MESSAGE_CHARS = 2_000;
/** Maximum characters retained for a serialized subsystem/cause code. */
export const MAX_IPC_ERROR_CODE_CHARS = 64;
/** Maximum characters retained for a serialized destination/error path. */
export const MAX_IPC_ERROR_PATH_CHARS = 1_024;
/** Maximum number of verification issues transmitted over IPC. */
export const MAX_IPC_ERROR_ISSUE_COUNT = 20;
/** Maximum characters retained per verification issue. */
export const MAX_IPC_ERROR_ISSUE_CHARS = 500;
/** Maximum serialized size of the allowlisted diagnostic detail object. */
export const MAX_IPC_ERROR_DETAILS_BYTES = 16 * 1024;

/**
 * Strict, bounded, allowlisted diagnostic payload carried by a worker error
 * frame. Unknown fields are never forwarded. All arrays and strings are
 * bounded by the constants above.
 */
export interface SerializedBackupErrorDetails {
  destinationPath?: string;
  targetPath?: string;
  verificationFailed?: boolean;
  verificationInterrupted?: boolean;
  destinationVerified?: boolean;
  causeCode?: string;
  committedAt?: string;
  publicationOutcome?: PublicationOutcome;
  integrityOutcome?: ArtifactIntegrityOutcome;
  verificationIssues?: string[];
}

export interface SerializedBackupError {
  code: string;
  message: string;
  subsystem?: string;
  details?: SerializedBackupErrorDetails;
}

export interface BackupDatabasePayload {
  type: "backup-database";
  dbPath: string;
  destinationPath: string;
  createDirectory?: boolean;
}

export interface VerifyDatabasePayload {
  type: "verify-database";
  filePath: string;
}

export interface CreateSnapshotPayload {
  type: "create-snapshot";
  dbPath: string;
  snapshotDestinationDir?: string;
  destinationPath?: string;
  knowledgeRootDir?: string;
  attachmentsRootDir?: string;
  screenshotsRootDir?: string;
  issueThreadsRootDir?: string;
  pipelineRunsRootDir?: string;
  dataDir?: string;
  manifestVersion?: 1 | 2 | 3 | 4;
  createDirectory?: boolean;
  maxRetries?: number;
  manifestMetadata?: Record<string, unknown>;
}

export interface VerifySnapshotPayload {
  type: "verify-snapshot";
  snapshotPath: string;
  /**
   * Also build the bounded recovery preview inside the worker, from the same
   * verified snapshot. The main process never opens the snapshot database.
   */
  includePreview?: boolean;
}

export interface RestoreSnapshotPayload {
  type: "restore-snapshot";
  snapshotPath: string;
  destinationDir: string;
  /** When set, the worker's own re-verification must match this identity. */
  expectedContentIdentity?: string;
  dbFilename?: string;
  createDirectory?: boolean;
  allowMissingHistoricalKnowledge?: boolean;
  requireCompleteProfile?: boolean;
  rebindInternalReferences?: boolean;
}

export type BackupOperationPayload =
  | BackupDatabasePayload
  | VerifyDatabasePayload
  | CreateSnapshotPayload
  | VerifySnapshotPayload
  | RestoreSnapshotPayload;

export interface BackupOperationRequest {
  operationId: string;
  payload: BackupOperationPayload;
}

// ── Bounded Summary Result Types ─────────────────────────────────────────────

export interface CompactBackupDatabaseResult {
  operationId: string;
  type: "backup-database";
  path: string;
  bytes: number;
  sha256: string;
  durationMs: number;
  createdAt?: number;
  /**
   * Structured publication-receipt write outcome (R8B). Absent means no receipt
   * was requested. A `written: false` value is an evidence gap, never proof that
   * the artifact above does not exist.
   */
  publicationReceipt?:
    | { written: true; directorySynced: boolean }
    | { written: false; code: string; message: string };
}

export interface CompactVerifyDatabaseResult {
  operationId: string;
  type: "verify-database";
  filePath: string;
  ok: boolean;
  issues: string[];
  foreignKeyViolations?: ForeignKeyViolation[];
  sha256?: string;
  bytes?: number;
}

export interface SnapshotManifestStatsSummary {
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

export interface SnapshotManifestSummary {
  manifestVersion: 1 | 2 | 3 | 4;
  snapshotId: string;
  appVersion: string | null;
  schemaVersion: string | null;
  createdAt: number;
  verified: boolean;
  coverage?: SnapshotCoverage;
  categories?: SnapshotAssetCategory[];
  stats: SnapshotManifestStatsSummary;
  origin?: SnapshotOriginMetadata;
  /** Counts only. Project paths stay in the on-disk manifest so this frame stays bounded. */
  brain?: SnapshotBrainRecord;
}

export interface CompactCreateSnapshotResult {
  operationId: string;
  type: "create-snapshot";
  path: string;
  snapshotId: string;
  databaseSha256: string;
  databaseBytes: number;
  totalFiles: number;
  totalBytes: number;
  schemaVersion: string | null;
  appVersion: string | null;
  createdAt: number;
  durationMs: number;
  coverage?: SnapshotCoverage;
  manifest: SnapshotManifestSummary;
}

export interface CompactVerifySnapshotResult {
  operationId: string;
  type: "verify-snapshot";
  snapshotPath: string;
  ok: boolean;
  snapshotId?: string;
  manifestVersion?: 1 | 2 | 3 | 4;
  appVersion?: string | null;
  schemaVersion?: string | null;
  createdAt?: number;
  databaseSha256?: string;
  databaseBytes?: number;
  filesChecked: number;
  totalBytes: number;
  issues: string[];
  coverage?: SnapshotCoverage;
  manifest?: SnapshotManifestSummary;
  /**
   * Digest over the verified manifest bytes and every packaged file's actual
   * content hash. Restoration is bound to this identity, never to the path.
   */
  contentIdentity?: string;
  /** Present only when the caller requested `includePreview`. */
  preview?: BackupRecoveryPreview;
}

export type ActivationReadiness =
  | "ready"
  | "requires-reference-repair"
  | "requires-external-recovery"
  | "legacy-unverified"
  | "not-ready";

export interface CompactRestoreSnapshotResult {
  operationId: string;
  type: "restore-snapshot";
  destinationPath: string;
  snapshotId: string;
  manifestVersion?: 1 | 2 | 3 | 4;
  appVersion: string | null;
  schemaVersion: string | null;
  dbFilename: string;
  databaseBytes: number;
  originalDatabaseSha256: string;
  databaseSha256: string;
  databaseTransformed: boolean;
  knowledgeDocumentCount: number;
  knowledgeRevisionCount: number;
  attachmentCount?: number;
  screenshotCount?: number;
  issueThreadCount?: number;
  pipelineRunCount?: number;
  filesRestored: number;
  totalBytesRestored: number;
  durationMs: number;
  restoredAt?: number;
  coverage?: SnapshotCoverage;
  internalReferencesDiscovered?: number;
  internalReferencesRebound?: number;
  internalReferencesUnchanged?: number;
  internalReferencesUnresolved?: number;
  unresolvedCrossProfileReferences?: number;
  crossProfileDependencies?: string[];
  unresolvedExternalReferences?: number;
  unresolvedExternalDependencies?: string[];
  externalProjectsRequiringAttention?: number;
  validationStatus?: "valid" | "failed" | "unverified";
  activationReadiness?: ActivationReadiness;
}

export type BoundedBackupResultPayload =
  | CompactBackupDatabaseResult
  | CompactVerifyDatabaseResult
  | CompactCreateSnapshotResult
  | CompactVerifySnapshotResult
  | CompactRestoreSnapshotResult;

export type BackupOperationResultMap = {
  "backup-database": CompactBackupDatabaseResult;
  "verify-database": CompactVerifyDatabaseResult;
  "create-snapshot": CompactCreateSnapshotResult;
  "verify-snapshot": CompactVerifySnapshotResult;
  "restore-snapshot": CompactRestoreSnapshotResult;
};

// ── IPC Protocol Messages ────────────────────────────────────────────────────

export type WorkerToParentMessage =
  | {
      type: "state";
      operationId: string;
      state: WorkerOperationState;
      stagingDir?: string;
      progress?: SafeProgressInfo;
    }
  | {
      type: "published";
      operationId: string;
      targetPath: string;
      publishedAt: number;
    }
  | {
      type: "result";
      operationId: string;
      result: BoundedBackupResultPayload;
    }
  | {
      type: "error";
      operationId: string;
      error: SerializedBackupError;
    };

export type ParentToWorkerMessage =
  | {
      type: "start";
      operation: BackupOperationRequest;
    }
  | {
      type: "cancel";
      operationId: string;
    };

export interface BackupOperationStatus {
  operationId: string;
  type: BackupOperationType;
  state: BackupOperationState;
  targetPath: string;
  pid?: number;
  stagingDir?: string;
  startedAt: number;
  updatedAt: number;
  progress?: SafeProgressInfo;
  error?: SerializedBackupError;
}

export type CancellationOutcome =
  | "cancelled_before_execution"
  | "cancelled_before_publication"
  | "publication_committed"
  | "already_completed"
  | "already_failed"
  | "publication_unresolved"
  | "not_found";

export interface CancellationResult {
  outcome: CancellationOutcome;
  cancelled: boolean;
  accepted: boolean;
  operationId: string;
  details?: {
    targetPath?: string;
    state?: BackupOperationState;
    published?: boolean;
    reason?: string;
  };
}

export type BackupRunnerErrorCode =
  | "OPERATION_NOT_FOUND"
  | "OPERATION_IN_PROGRESS"
  | "DESTINATION_COLLISION"
  | "INVALID_DESTINATION"
  | "INVALID_PATH"
  | "SQLITE_AUXILIARY_FILE"
  | "UNSUPPORTED_FILESYSTEM"
  | "WORKER_SCRIPT_NOT_FOUND"
  | "WORKER_INTEGRITY_FAILED"
  | "WORKER_EXITED_UNEXPECTEDLY"
  | "ACTIVE_PROFILE_PROTECTED"
  | "CANCELLED"
  | "TIMEOUT"
  | "WORKER_SPAWN_FAILED"
  | "WORKER_CRASH"
  | "IPC_ERROR"
  | "INVALID_WORKER_RESPONSE"
  | "VERIFICATION_FAILED"
  | "SQLITE_ERROR"
  | "IO_ERROR"
  | "UNTRUSTED_SYMLINK"
  | "TARGET_EXISTS"
  | "PUBLISHED_UNCONFIRMED"
  | "INDETERMINATE"
  | "UNKNOWN_ERROR";

export class BackupRunnerError extends Error {
  readonly code: BackupRunnerErrorCode | string;
  readonly operationId?: string;
  readonly state?: BackupOperationState;
  readonly subsystem?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    code: BackupRunnerErrorCode | string,
    options?: {
      operationId?: string;
      state?: BackupOperationState;
      subsystem?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BackupRunnerError";
    this.code = code;
    this.operationId = options?.operationId;
    this.state = options?.state;
    this.subsystem = options?.subsystem;
    this.details = options?.details;
  }
}
