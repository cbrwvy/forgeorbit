/**
 * Wire contracts for the first user-facing Backup & Recovery workflow
 * (FO-P2-004).
 *
 * These types are shared by the Bun core (which owns the approved
 * BackupProcessRunner storage engine) and the React webview. They are strictly
 * summaries: paths, counts, hashes, verification verdicts and recovery
 * readiness. No task content, database rows, credential values or arbitrary
 * worker error fields cross this boundary.
 */

import type { BackupBrainPreview, BrainSnapshotCoverageSummary } from "./brain/snapshot.ts";

export type BackupOperationKind = "create" | "verify" | "restore";

/**
 * Truthful user-facing operation states. Publication and artifact integrity are
 * independent axes (inherited from the storage engine's R9 contract):
 *
 *  - "completed" says the operation published an artifact / finished reading;
 *    it does NOT say the artifact passed verification. `integrity` answers that.
 *  - "published-unconfirmed" means an artifact may exist but the operation did
 *    not receive a trustworthy completion acknowledgement.
 *  - "indeterminate" means publication could not be established either way.
 *  - "verification-failed" means an artifact was examined and failed integrity.
 *  - "cancelled-before-publication" is only used when non-publication is proven.
 *  - "failed-before-publication" is only used when non-publication is proven.
 */
export type BackupUiState =
  | "queued"
  | "running"
  | "verifying"
  | "publishing"
  | "completed"
  | "cancelled-before-publication"
  | "published-unconfirmed"
  | "indeterminate"
  | "verification-failed"
  | "failed-before-publication";

export type BackupIntegrity = "verified" | "failed" | "not_verified" | "interrupted";

export type BackupManifestVersion = 1 | 2 | 3 | 4;

export type BackupCoverage = "complete-profile" | "legacy-database-knowledge";

export type BackupAssetCategory =
  | "database"
  | "knowledge"
  | "attachments"
  | "screenshots"
  | "issue-threads"
  | "pipeline-runs"
  | "brain";

export type BackupActivationReadiness =
  | "ready"
  | "requires-reference-repair"
  | "requires-external-recovery"
  | "legacy-unverified"
  | "not-ready";

export interface BackupProgress {
  phase?: string;
  bytesProcessed?: number;
  totalBytes?: number;
  filesProcessed?: number;
  totalFiles?: number;
  message?: string;
  timestamp: number;
}

export interface BackupOperationError {
  code: string;
  message: string;
  subsystem?: string;
  verificationIssues?: string[];
  publicationOutcome?: "not_published" | "committed" | "unresolved";
  integrityOutcome?: BackupIntegrity;
}

export interface BackupSnapshotCounts {
  knowledgeDocuments: number;
  knowledgeRevisions: number;
  attachments: number;
  screenshots: number;
  issueThreads: number;
  pipelineRuns: number;
}

/**
 * A bounded description of one snapshot directory. `legacy` is derived from
 * the manifest version, never from a directory name or timestamp. A legacy
 * snapshot is always `legacy-unverified`; it is never presented as a verified
 * complete-profile backup.
 */
export interface BackupSnapshotSummary {
  snapshotPath: string;
  snapshotId: string;
  manifestVersion: BackupManifestVersion;
  coverage: BackupCoverage | null;
  createdAt: number;
  appVersion: string | null;
  schemaVersion: string | null;
  /** The manifest's own creation-time `verified` flag. Independent verification is separate. */
  manifestVerified: boolean;
  files: number;
  totalBytes: number;
  databaseBytes: number | null;
  databaseSha256: string | null;
  categories: BackupAssetCategory[];
  counts: BackupSnapshotCounts;
  legacy: boolean;
  /** Brain category coverage. Legacy snapshots that omit the record are legacy-absent. */
  brain: BrainSnapshotCoverageSummary;
  /** False when the snapshot's database file is missing or untrustworthy. */
  available: boolean;
  /** Bounded reason the manifest could not be summarized, when applicable. */
  manifestError: string | null;
}

export interface BackupHistoryEntry extends BackupSnapshotSummary {
  location: string;
  sizeBytes: number;
  lastVerifiedAt: number | null;
  lastVerificationOk: boolean | null;
  integrity: BackupIntegrity;
}

export interface BackupProfileCategoryScope {
  id: BackupAssetCategory;
  fileCount: number;
  bytes: number;
  included: true;
}

export interface BackupProfileInfo {
  /** Trusted active-profile root resolved by the core; never supplied by the webview. */
  profileRoot: string;
  databaseFilename: string;
  databaseBytes: number;
  coverage: BackupCoverage;
  manifestVersion: BackupManifestVersion;
  categories: BackupProfileCategoryScope[];
  estimatedTotalBytes: number;
  estimatedFileCount: number;
  estimateTruncated: boolean;
  /**
   * Things this engine does not package. Kept explicit so the UI never implies
   * external Git repositories or provider credentials are inside a backup.
   */
  notIncluded: string[];
}

export interface BackupCreateSummary {
  snapshot: BackupSnapshotSummary;
  databaseSha256: string;
  totalFiles: number;
  totalBytes: number;
  durationMs: number;
  publishedAt: number;
}

export interface BackupVerifySummary {
  snapshotPath: string;
  ok: boolean;
  snapshotId: string | null;
  manifestVersion: BackupManifestVersion | null;
  coverage: BackupCoverage | null;
  createdAt: number | null;
  filesChecked: number;
  totalBytes: number;
  issues: string[];
  databaseSha256: string | null;
  legacy: boolean;
  verifiedAt: number;
  /** Set when the verify operation could read a Brain record or a Brain failure. */
  brain?: BrainSnapshotCoverageSummary;
  /**
   * Digest over the verified manifest and every packaged file's actual
   * on-disk content. Restoration is bound to this identity, not to the path.
   */
  contentIdentity?: string | null;
}

export interface BackupProjectPreview {
  projectPath: string;
  name: string | null;
  existsOnDisk: boolean;
  requiresUserIntervention: boolean;
  taskCount: number | null;
}

export interface BackupWorktreePreview {
  taskId: string;
  taskTitle: string | null;
  worktreePath: string;
  existsOnDisk: boolean;
  status: "missing-disposable" | "retained" | "external";
}

export interface BackupEnvironmentPreview {
  id: string;
  projectPath: string;
  needsReconnection: boolean;
}

export interface BackupProviderAuthPreview {
  harnessId: string;
  harnessName: string;
  requiresAuthCheck: boolean;
}

export interface ProjectRecoveryInfo {
  projectPath: string;
  name?: string;
  isExternal: boolean;
  existsOnDisk: boolean;
  requiresUserIntervention: boolean;
  taskCount?: number;
}

export interface WorktreeRecoveryInfo {
  taskId: string;
  taskTitle?: string;
  worktreePath: string;
  existsOnDisk: boolean;
  status: "missing-disposable" | "retained" | "external";
}

export interface EnvironmentProfileRecoveryInfo {
  id: string;
  projectPath: string;
  needsReconnection: boolean;
}

export interface ProviderAuthRecoveryInfo {
  harnessId: string;
  harnessName: string;
  requiresAuthCheck: boolean;
}

export interface RestoreRecoveryPreview {
  projects: ProjectRecoveryInfo[];
  worktrees: WorktreeRecoveryInfo[];
  environmentProfiles: EnvironmentProfileRecoveryInfo[];
  providerAuth: ProviderAuthRecoveryInfo[];
  totalProjects: number;
  totalClusters: number;
  totalTasks: number;
  totalExternalProjectsRequiringAttention: number;
  totalMissingWorktrees: number;
}

export interface BackupRecoveryPreview {
  projects: BackupProjectPreview[];
  worktrees: BackupWorktreePreview[];
  environmentProfiles: BackupEnvironmentPreview[];
  providerAuth: BackupProviderAuthPreview[];
  totalProjects: number;
  totalClusters: number;
  totalTasks: number;
  externalProjectsRequiringAttention: number;
  missingWorktrees: number;
  /** Internal app-managed references expected to be rebound after a v4 restore. */
  internalReferencesExpected: number;
  internalReferencesUnresolved: number | null;
  unresolvedCrossProfileReferences: number;
  crossProfileDependencies: string[];
  unresolvedExternalReferences: number;
  unresolvedExternalDependencies: string[];
  readiness: BackupActivationReadiness;
  /** Readiness is advisory for a future activation workflow; it is not activation. */
  readinessAdvisory: true;
  legacy: boolean;
  truncated: boolean;
  brain: BackupBrainPreview;
}

export interface BackupRestorePreview {
  snapshot: BackupSnapshotSummary;
  verification: {
    verifiedAt: number;
    ok: boolean;
    issues: string[];
    /** Content identity the preview was built from; restore must match it. */
    contentIdentity?: string | null;
  };
  recovery: BackupRecoveryPreview;
}

export interface BackupRestoreSummary {
  destinationPath: string;
  snapshotId: string;
  manifestVersion: BackupManifestVersion | null;
  coverage: BackupCoverage | null;
  dbFilename: string;
  databaseBytes: number;
  databaseTransformed: boolean;
  databaseSha256: string;
  filesRestored: number;
  totalBytesRestored: number;
  durationMs: number;
  restoredAt: number;
  internalReferencesDiscovered: number;
  internalReferencesRebound: number;
  internalReferencesUnresolved: number;
  unresolvedCrossProfileReferences: number;
  crossProfileDependencies: string[];
  unresolvedExternalReferences: number;
  unresolvedExternalDependencies: string[];
  externalProjectsRequiringAttention: number;
  validationStatus: "valid" | "failed" | "unverified";
  activationReadiness: BackupActivationReadiness;
  recoveryReportPath: string;
  /** Manifest version is legacy (v1–v3); never a complete-profile v4 snapshot. */
  legacy: boolean;
  /** Always false. This workflow never activates a restored profile. */
  activated: false;
}

export interface BackupOperationView {
  id: string;
  kind: BackupOperationKind;
  state: BackupUiState;
  integrity: BackupIntegrity;
  phase: string | null;
  progress: BackupProgress | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  snapshotPath: string | null;
  destinationPath: string | null;
  cancellable: boolean;
  cancellationRequested: boolean;
  cancellationOutcome: string | null;
  error: BackupOperationError | null;
  verificationIssues: string[];
  snapshot: BackupSnapshotSummary | null;
  create: BackupCreateSummary | null;
  verify: BackupVerifySummary | null;
  restore: BackupRestoreSummary | null;
}

export interface BackupDestinationGrant {
  id: string;
  path: string;
  purpose: BackupPickPurpose;
}

export type BackupPickPurpose = "backup-parent" | "restore-parent" | "history-location" | "snapshot";

export interface BackupHistoryResponse {
  entries: BackupHistoryEntry[];
  locations: string[];
  generatedAt: number;
}

export interface BackupDiagnosticEnvelope {
  error: string;
  code?: string;
  status?: number;
  requiresVerification?: boolean;
}

export const BACKUP_OPERATION_TERMINAL_STATES: readonly BackupUiState[] = [
  "completed",
  "cancelled-before-publication",
  "published-unconfirmed",
  "indeterminate",
  "verification-failed",
  "failed-before-publication",
];

export function isBackupStateTerminal(state: BackupUiState): boolean {
  return BACKUP_OPERATION_TERMINAL_STATES.includes(state);
}

export function isBackupOperationBusy(operation: BackupOperationView | null | undefined): boolean {
  return operation !== null && operation !== undefined && !isBackupStateTerminal(operation.state);
}

export function backupStateIsFailure(state: BackupUiState): boolean {
  return (
    state === "published-unconfirmed" ||
    state === "indeterminate" ||
    state === "verification-failed" ||
    state === "failed-before-publication"
  );
}

/** Snapshot format is derived only from the manifest version. */
export function backupSnapshotFormat(
  manifestVersion: BackupManifestVersion,
): "complete-profile-v4" | "legacy-v1" | "legacy-v2" | "legacy-v3" {
  switch (manifestVersion) {
    case 4:
      return "complete-profile-v4";
    case 3:
      return "legacy-v3";
    case 2:
      return "legacy-v2";
    case 1:
      return "legacy-v1";
  }
}
