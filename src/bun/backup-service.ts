/**
 * Trusted application integration for the approved Backup/Restore storage
 * engine (FO-P2-004).
 *
 * This module owns the only `BackupProcessRunner` instance the desktop app
 * uses. It resolves the source profile from trusted configuration, validates
 * every user-selected path server-side, and exposes bounded summaries to the
 * webview. Heavy work stays in the isolated worker; no database content or
 * credential value crosses this boundary.
 *
 * Security properties intentionally kept here (not in the webview):
 *  - the backup source database is always `<active data dir>/agetor.sqlite`;
 *    no request field can name it;
 *  - only a native-panel pick issues a destination grant, and a grant is
 *    single-use and short-lived;
 *  - destinations inside the active profile are rejected, as are existing
 *    restore destinations;
 *  - snapshot verification uses the isolated runner, never an in-process
 *    shortcut, and every restore requires a fresh successful verification;
 *  - a single operation may run at a time, so two conflicting writes against
 *    the same or different destinations cannot start;
 *  - INDETERMINATE / PUBLISHED_UNCONFIRMED outcomes are never retried
 *    automatically and never reported as success.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { checkNotActiveDataDir } from "./backup-restore.ts";
import { emptyBrainCoverage, summarizeBrainRecord } from "../shared/brain/snapshot.ts";
import {
  type SnapshotManifest,
} from "./backup-manager.ts";
import {
  buildSnapshotRecoveryPreview,
  summaryFromVerifiedSnapshot,
} from "./backup-preview.ts";
import { MAX_MANIFEST_SIZE_BYTES, RESTORE_RECOVERY_FILENAME } from "./backup-core.ts";
import { BackupProcessRunner } from "./backup-runner.ts";
import {
  type BackupOperationState,
  type BackupOperationStatus,
  type CancellationResult,
  type CompactCreateSnapshotResult,
  type CompactRestoreSnapshotResult,
  type CompactVerifySnapshotResult,
  type PublicationOutcome,
  type SafeProgressInfo,
} from "./backup-runner-types.ts";
import { redactIpcSecrets, sanitizeIpcString } from "./backup-ipc.ts";
import type {
  BackupActivationReadiness,
  BackupAssetCategory,
  BackupCoverage,
  BackupCreateSummary,
  BackupDestinationGrant,
  BackupHistoryEntry,
  BackupHistoryResponse,
  BackupIntegrity,
  BackupManifestVersion,
  BackupOperationError,
  BackupOperationKind,
  BackupOperationView,
  BackupPickPurpose,
  BackupProfileCategoryScope,
  BackupProfileInfo,
  BackupProgress,
  BackupRecoveryPreview,
  BackupRestorePreview,
  BackupRestoreSummary,
  BackupSnapshotSummary,
  BackupUiState,
  BackupVerifySummary,
} from "../shared/backup.ts";
import { isBackupStateTerminal } from "../shared/backup.ts";
import { sealRestoredOwnerTrustFile } from "./owner-trust/store.ts";

/** Minimal runner surface so a test can substitute a deterministic fake. */
export interface BackupRunnerLike {
  createSnapshot(
    dbPath: string,
    snapshotDestinationDirOrPath: string,
    options?: Parameters<BackupProcessRunner["createSnapshot"]>[2],
  ): ReturnType<BackupProcessRunner["createSnapshot"]>;
  verifySnapshot(
    snapshotPath: string,
    options?: Parameters<BackupProcessRunner["verifySnapshot"]>[1],
  ): ReturnType<BackupProcessRunner["verifySnapshot"]>;
  restoreSnapshot(
    snapshotPath: string,
    destinationDir: string,
    options?: Parameters<BackupProcessRunner["restoreSnapshot"]>[2],
  ): ReturnType<BackupProcessRunner["restoreSnapshot"]>;
  requestCancellation(
    operationId: string,
    options?: { force?: boolean },
  ): Promise<CancellationResult>;
  dispose(): Promise<void>;
}

export class BackupServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = "BackupServiceError";
    this.code = code;
    this.status = status;
  }
}

export interface BackupServiceOptions {
  /** Trusted active profile data directory (from `resolveDataDir()`). */
  dataDir: string;
  /** Trusted active profile database path (a direct child of `dataDir`). */
  dbPath?: string;
  /** Clock source (tests). */
  now?: () => number;
  /** Registry file path override (tests). */
  registryPath?: string;
  /** A pre-built runner (tests). A default isolated runner is created lazily. */
  runner?: BackupRunnerLike;
  /** Runner factory, used instead of the default one. */
  runnerFactory?: (onStateChange: (status: BackupOperationStatus) => void) => BackupRunnerLike;
}

const MAX_LOCATIONS = 20;
const MAX_HISTORY_ENTRIES = 200;
const MAX_CHILDREN_PER_LOCATION = 100;
const MAX_GRANTS = 32;
const GRANT_TTL_MS = 15 * 60 * 1000;
const VERIFICATION_TTL_MS = 30 * 60 * 1000;
const MAX_RECENT_OPERATIONS = 100;
const MAX_REGISTRY_SNAPSHOTS = 500;
/** Hard cap on the convenience registry file; oversized content is ignored. */
const MAX_REGISTRY_FILE_BYTES = 1024 * 1024;
const MAX_PREVIEW_DEPENDENCIES = 40;
const MAX_PREVIEW_APPROVALS = 64;
const MAX_SUMMARY_ISSUES = 20;
const MAX_SUMMARY_ISSUE_CHARS = 500;
const MAX_SUMMARY_MESSAGE_CHARS = 500;
const MAX_ESTIMATE_ENTRIES = 20_000;
const MAX_ESTIMATE_MS = 1_500;

const KNOWN_CATEGORIES: readonly BackupAssetCategory[] = [
  "database",
  "knowledge",
  "attachments",
  "screenshots",
  "issue-threads",
  "pipeline-runs",
  "brain",
];

const LEGACY_COVERAGE: BackupCoverage = "legacy-database-knowledge";
const COMPLETE_COVERAGE: BackupCoverage = "complete-profile";

interface RegistryVerification {
  verifiedAt: number;
  ok: boolean;
  databaseSha256: string | null;
  snapshotId: string | null;
  issues: string[];
  /** Absent for registry entries written before content-bound verification. */
  contentIdentity?: string | null;
}

interface RegistrySnapshot {
  path: string;
  location: string;
  createdAt: number;
  snapshotId: string;
  manifestVersion: BackupManifestVersion;
  coverage: BackupCoverage | null;
  totalBytes: number;
  databaseSha256: string | null;
}

interface RegistryState {
  version: 1;
  locations: string[];
  snapshots: RegistrySnapshot[];
  verifications: Record<string, RegistryVerification>;
}

interface GrantRecord extends BackupDestinationGrant {
  expiresAt: number;
  consumed: boolean;
}

interface VerificationRecord {
  id: string;
  canonicalPath: string;
  snapshotPath: string;
  verifiedAt: number;
  ok: boolean;
  databaseSha256: string | null;
  snapshotId: string | null;
  manifestVersion: BackupManifestVersion | null;
  coverage: BackupCoverage | null;
  issues: string[];
  /** Content identity proved by this verification, when the engine supplied one. */
  contentIdentity: string | null;
}

/**
 * A snapshot identity the user was actually shown in a successful preview.
 * A restore request carrying this verification id is bound to exactly this
 * content, not merely to the path.
 */
interface PreviewApproval {
  verificationId: string;
  canonicalPath: string;
  contentIdentity: string;
  approvedAt: number;
}

interface OperationInternal {
  view: BackupOperationView;
  runnerTypeExpected: "create-snapshot" | "verify-snapshot" | "restore-snapshot" | "verify-then-restore";
  currentRunnerId: string | null;
  terminal: boolean;
  verificationId: string | null;
  pendingDestinationName: string | null;
  /**
   * Exact snapshot content identity approved by the user (from the preview
   * when one was shown, else the successful verification). The isolated
   * restore worker re-verifies and refuses a different identity.
   */
  expectedContentIdentity: string | null;
}

function emptyRegistry(): RegistryState {
  return { version: 1, locations: [], snapshots: [], verifications: {} };
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
    ? value
    : undefined;
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitizeIpcString(redactIpcSecrets(value), max);
  return cleaned;
}

function boundedIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_SUMMARY_ISSUES) break;
    const text = safeText(entry, MAX_SUMMARY_ISSUE_CHARS);
    if (text) out.push(text);
  }
  return out;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function canonicalizeExisting(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function canonicalizeForComparison(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function manifestCategories(value: unknown, files: SnapshotManifest["files"]): BackupAssetCategory[] {
  const found = new Set<BackupAssetCategory>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && (KNOWN_CATEGORIES as readonly string[]).includes(entry)) {
        found.add(entry as BackupAssetCategory);
      }
    }
  }
  for (const file of files) {
    const category = file.category;
    if (typeof category === "string" && (KNOWN_CATEGORIES as readonly string[]).includes(category)) {
      found.add(category as BackupAssetCategory);
    }
  }
  if (files.some((f) => f.path === "database.sqlite")) found.add("database");
  return [...found];
}

function normalizedManifestVersion(value: unknown): BackupManifestVersion | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

export class BackupService {
  private readonly dataDir: string;
  private readonly canonicalDataDir: string;
  private readonly dbPath: string;
  private readonly now: () => number;
  private readonly registryPath: string;
  private readonly runnerFactory: ((onStateChange: (status: BackupOperationStatus) => void) => BackupRunnerLike) | null;
  private runner: BackupRunnerLike | null = null;

  private readonly operations = new Map<string, OperationInternal>();
  private readonly operationOrder: string[] = [];
  private readonly runnerToOperation = new Map<string, string>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly verificationsByPath = new Map<string, VerificationRecord>();
  private readonly verificationsById = new Map<string, VerificationRecord>();
  private readonly approvedPreviews = new Map<string, PreviewApproval>();
  private readonly snapshotSelections = new Map<string, number>();
  private readonly knownSnapshots = new Set<string>();
  private disposePromise: Promise<void> | null = null;
  private activeOperationId: string | null = null;
  private registry: RegistryState;

  constructor(options: BackupServiceOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.canonicalDataDir = canonicalizeForComparison(this.dataDir);
    this.dbPath = path.resolve(options.dbPath ?? path.join(this.dataDir, "agetor.sqlite"));
    this.now = options.now ?? Date.now;
    this.registryPath = options.registryPath ?? path.join(this.dataDir, "backup-registry.json");
    this.registry = this.loadRegistry();
    this.seedVerificationsFromRegistry();
    if (options.runner) {
      this.runner = options.runner;
      this.runnerFactory = null;
    } else if (options.runnerFactory) {
      this.runnerFactory = options.runnerFactory;
    } else {
      this.runnerFactory = (onStateChange) =>
        new BackupProcessRunner({ onStateChange });
    }
  }

  // ── Trusted profile / scope ────────────────────────────────────────────────

  getProfileInfo(): BackupProfileInfo {
    const databaseBytes = this.safeFileBytes(this.dbPath);
    const categories: BackupProfileCategoryScope[] = [
      { id: "database", fileCount: 1, bytes: databaseBytes, included: true },
    ];
    const estimate = this.estimateScope();
    for (const entry of estimate.categories) categories.push(entry);
    return {
      profileRoot: this.dataDir,
      databaseFilename: path.basename(this.dbPath),
      databaseBytes,
      coverage: COMPLETE_COVERAGE,
      manifestVersion: 4,
      categories,
      estimatedTotalBytes: databaseBytes + estimate.totalBytes,
      estimatedFileCount: 1 + estimate.fileCount,
      estimateTruncated: estimate.truncated,
      notIncluded: [
        "external-git-repositories",
        "provider-sign-in-sessions",
        "profile-root-credential-files",
        "runtime-files-pid-locks-logs",
      ],
    };
  }

  // ── Native-panel destination grants ────────────────────────────────────────

  issueDestinationGrant(rawPath: unknown, purpose: BackupPickPurpose): BackupDestinationGrant {
    if (purpose !== "backup-parent" && purpose !== "restore-parent" && purpose !== "history-location") {
      throw new BackupServiceError("Unsupported destination purpose", "INVALID_PURPOSE", 400);
    }
    const picked = this.requireAbsolutePath(rawPath, "destination");
    let stat;
    try {
      stat = statSync(picked);
    } catch {
      throw new BackupServiceError("The selected folder no longer exists", "INVALID_DESTINATION", 400);
    }
    if (!stat.isDirectory()) {
      throw new BackupServiceError("The selected item is not a folder", "INVALID_DESTINATION", 400);
    }
    const canonical = canonicalizeExisting(picked);
    this.assertNotActiveProfile(canonical, "destination");
    this.assertSafeDestinationAncestry(canonical);
    this.pruneGrants();
    if (this.grants.size >= MAX_GRANTS) {
      throw new BackupServiceError("Too many pending destination choices; choose the folder again", "TOO_MANY_GRANTS", 429);
    }
    const grant: GrantRecord = {
      id: randomUUID(),
      path: canonical,
      purpose,
      expiresAt: this.now() + GRANT_TTL_MS,
      consumed: false,
    };
    this.grants.set(grant.id, grant);
    return { id: grant.id, path: grant.path, purpose: grant.purpose };
  }

  addLocation(grantId: unknown): string[] {
    const grant = this.consumeGrant(grantId, "history-location");
    this.ensureLocation(grant.path);
    this.saveRegistry();
    return [...this.registry.locations];
  }

  // ── Operations: create ─────────────────────────────────────────────────────

  startCreate(grantId: unknown): BackupOperationView {
    this.assertNoActiveOperation();
    const grant = this.peekGrant(grantId, "backup-parent");
    this.assertSourceProfileReady();
    const destinationParent = grant.path;
    this.assertDestinationParent(destinationParent);
    grant.consumed = true;

    const operation = this.newOperation("create", null, null);
    try {
      const runner = this.getRunner();
      void runner
        .createSnapshot(this.dbPath, destinationParent, {
          dataDir: this.dataDir,
          knowledgeRootDir: path.join(this.dataDir, "knowledge"),
          attachmentsRootDir: path.join(this.dataDir, "attachments"),
          screenshotsRootDir: path.join(this.dataDir, "screenshots"),
          issueThreadsRootDir: path.join(this.dataDir, "issue-threads"),
          pipelineRunsRootDir: path.join(this.dataDir, "pipeline-runs"),
          manifestVersion: 4,
          createDirectory: true,
        })
        .then((result) => this.completeCreate(operation, result, destinationParent))
        .catch((err) => this.failOperation(operation, err));
    } catch (err) {
      this.failOperation(operation, err);
    }
    return operation.view;
  }

  // ── Operations: verify ─────────────────────────────────────────────────────

  startVerify(snapshotPathRaw: unknown): BackupOperationView {
    this.assertNoActiveOperation();
    const snapshotPath = this.validateSnapshotPath(snapshotPathRaw);
    const operation = this.newOperation("verify", snapshotPath, null);
    try {
      const runner = this.getRunner();
      void runner
        .verifySnapshot(snapshotPath)
        .then((result) => this.completeVerify(operation, result))
        .catch((err) => this.failOperation(operation, err));
    } catch (err) {
      this.failOperation(operation, err);
    }
    return operation.view;
  }

  // ── Snapshot inspection / preview ──────────────────────────────────────────

  /**
   * Records a snapshot the user just chose in the native panel. Only recorded
   * selections, app-created snapshots and snapshots inside a configured backup
   * location may be inspected or verified, so a webview cannot turn these
   * read-only routes into an arbitrary path oracle.
   */
  issueSnapshotSelection(rawPath: unknown): string {
    const snapshotPath = this.validateSnapshotPath(rawPath, { allowUnknown: true });
    this.pruneSnapshotSelections();
    this.snapshotSelections.set(canonicalizeForComparison(snapshotPath), this.now() + GRANT_TTL_MS * 4);
    return snapshotPath;
  }

  inspectSnapshot(snapshotPathRaw: unknown): BackupSnapshotSummary {
    const snapshotPath = this.validateSnapshotPath(snapshotPathRaw);
    return this.summarizeSnapshot(snapshotPath);
  }

  /**
   * Builds the recovery preview from a FRESH isolated verification, then binds
   * that exact content identity to the verification id. The snapshot database
   * is opened only inside the worker; the main process never parses it. If the
   * snapshot changed since the user's verification (manifest, database,
   * attachment or any other packaged asset), the stale verification is
   * invalidated and the caller must verify again.
   */
  async previewRestore(snapshotPathRaw: unknown, verificationId?: unknown): Promise<BackupRestorePreview> {
    const snapshotPath = this.validateSnapshotPath(snapshotPathRaw);
    const verification = this.requireVerification(snapshotPath, verificationId);
    const runner = this.getRunner();

    let result: CompactVerifySnapshotResult;
    try {
      result = await runner.verifySnapshot(snapshotPath, { includePreview: true });
    } catch (err) {
      if (err instanceof BackupServiceError) throw err;
      throw new BackupServiceError(
        "Could not verify the snapshot for a recovery preview",
        "PREVIEW_FAILED",
        400,
      );
    }

    if (
      !result.ok ||
      !result.contentIdentity ||
      !verification.contentIdentity ||
      result.contentIdentity !== verification.contentIdentity
    ) {
      this.invalidateVerification(verification);
      throw new BackupServiceError(
        "The snapshot content changed since it was verified. Verify it again before previewing or restoring.",
        "SNAPSHOT_CHANGED",
        409,
      );
    }

    const manifestSummary = result.manifest;
    if (!result.preview || !manifestSummary || !result.manifestVersion) {
      throw new BackupServiceError(
        "Could not read the snapshot database for a recovery preview",
        "PREVIEW_FAILED",
        400,
      );
    }

    const summary = summaryFromVerifiedSnapshot({
      snapshotPath: path.resolve(result.snapshotPath),
      manifestVersion: result.manifestVersion,
      snapshotId: manifestSummary.snapshotId,
      appVersion: manifestSummary.appVersion,
      schemaVersion: manifestSummary.schemaVersion,
      createdAt: manifestSummary.createdAt,
      manifestVerified: manifestSummary.verified === true,
      coverage: this.coverageFrom(result.coverage, result.manifestVersion),
      categories: manifestSummary.categories,
      stats: {
        fileCount: manifestSummary.stats.fileCount,
        totalBytes: manifestSummary.stats.totalBytes,
        knowledgeDocumentCount: manifestSummary.stats.knowledgeDocumentCount,
        knowledgeRevisionCount: manifestSummary.stats.knowledgeRevisionCount,
        attachmentCount: manifestSummary.stats.attachmentCount,
        screenshotCount: manifestSummary.stats.screenshotCount,
        issueThreadCount: manifestSummary.stats.issueThreadCount,
        pipelineRunCount: manifestSummary.stats.pipelineRunCount,
      },
      databaseBytes: result.databaseBytes ?? null,
      databaseSha256: result.databaseSha256 ?? null,
      brain: manifestSummary.brain,
    });

    const canonical = canonicalizeForComparison(snapshotPath);
    this.recordPreviewApproval({
      verificationId: verification.id,
      canonicalPath: canonical,
      contentIdentity: result.contentIdentity,
      approvedAt: this.now(),
    });

    return {
      snapshot: summary,
      verification: {
        verifiedAt: verification.verifiedAt,
        ok: verification.ok,
        issues: verification.issues,
        contentIdentity: result.contentIdentity,
      },
      recovery: result.preview,
    };
  }

  private recordPreviewApproval(approval: PreviewApproval): void {
    this.approvedPreviews.set(approval.verificationId, approval);
    if (this.approvedPreviews.size <= MAX_PREVIEW_APPROVALS) return;
    const oldest = [...this.approvedPreviews.values()].sort((a, b) => a.approvedAt - b.approvedAt);
    for (const entry of oldest.slice(0, this.approvedPreviews.size - MAX_PREVIEW_APPROVALS)) {
      this.approvedPreviews.delete(entry.verificationId);
    }
  }

  private approvedPreviewFor(verificationId: string, canonicalPath: string): PreviewApproval | null {
    const approval = this.approvedPreviews.get(verificationId);
    if (!approval) return null;
    if (approval.canonicalPath !== canonicalPath) return null;
    if (this.now() - approval.approvedAt > VERIFICATION_TTL_MS) {
      this.approvedPreviews.delete(verificationId);
      return null;
    }
    return approval;
  }

  private invalidateApprovedVerification(verificationId: string | null): void {
    if (!verificationId) return;
    const record = this.verificationsById.get(verificationId);
    if (record) this.invalidateVerification(record);
  }

  /** Drops a verification whose proved content no longer matches the snapshot. */
  private invalidateVerification(record: VerificationRecord): void {
    this.verificationsById.delete(record.id);
    if (this.verificationsByPath.get(record.canonicalPath)?.id === record.id) {
      this.verificationsByPath.delete(record.canonicalPath);
    }
    delete this.registry.verifications[record.snapshotPath];
    for (const [id, approval] of this.approvedPreviews) {
      if (approval.canonicalPath === record.canonicalPath) this.approvedPreviews.delete(id);
    }
    this.saveRegistry();
  }

  // ── Operations: restore ────────────────────────────────────────────────────

  startRestore(input: {
    snapshotPath: unknown;
    grantId?: unknown;
    verificationId?: unknown;
    destinationName?: unknown;
    managed?: boolean;
  }): BackupOperationView {
    this.assertNoActiveOperation();
    const snapshotPath = this.validateSnapshotPath(input.snapshotPath);
    const verification = this.requireVerification(snapshotPath, input.verificationId);
    let parentPath: string;
    if (input.grantId && input.grantId !== "managed") {
      const grant = this.peekGrant(input.grantId, "restore-parent");
      parentPath = grant.path;
      grant.consumed = true;
    } else {
      const baseDir = path.dirname(path.resolve(this.dataDir));
      const managedParent = path.join(baseDir, "managed-profiles");
      if (!existsSync(managedParent)) {
        mkdirSync(managedParent, { recursive: true, mode: 0o700 });
      }
      parentPath = managedParent;
    }
    const destinationName = this.validateDestinationName(input.destinationName);
    const destinationPath = this.resolveNewRestoreDestination(parentPath, destinationName);
    this.assertRestoreDestination(snapshotPath, destinationPath);

    // Bind the operation to what the user actually approved. When a preview was
    // shown for this verification, its content identity wins; otherwise the
    // successful verification's identity is the approval.
    const approval = this.approvedPreviewFor(verification.id, canonicalizeForComparison(snapshotPath));
    const expectedContentIdentity = approval?.contentIdentity ?? verification.contentIdentity;
    if (!expectedContentIdentity) {
      throw new BackupServiceError(
        "Verify and preview this snapshot again before restoring it",
        "SNAPSHOT_CHANGED",
        409,
      );
    }

    const operation = this.newOperation("restore", snapshotPath, destinationPath);
    operation.verificationId = verification.id;
    operation.expectedContentIdentity = expectedContentIdentity;
    operation.runnerTypeExpected = "verify-then-restore";
    operation.pendingDestinationName = destinationName;

    void this.runRestore(operation, snapshotPath, destinationPath).catch((err) =>
      this.failOperation(operation, err),
    );
    return operation.view;
  }

  private async runRestore(
    operation: OperationInternal,
    snapshotPath: string,
    destinationPath: string,
  ): Promise<void> {
    const runner = this.getRunner();
    operation.view.state = "verifying";
    operation.view.phase = "verification";
    operation.view.updatedAt = this.now();
    const verification = await runner.verifySnapshot(snapshotPath);
    if (operation.terminal) return;
    if (!verification.ok) {
      if (operation.expectedContentIdentity) {
        // The user approved a specific content identity; a snapshot that no
        // longer verifies is not that snapshot anymore. Abort with the same
        // explicit "preview again" outcome instead of a generic integrity
        // failure the UI might treat as retryable.
        this.invalidateApprovedVerification(operation.verificationId);
        throw new BackupServiceError(
          "The snapshot changed after you previewed it. Verify and preview it again before restoring.",
          "SNAPSHOT_CHANGED",
          409,
        );
      }
      this.setVerificationFailure(operation, verification.issues);
      this.finalize(operation, "verification-failed", "failed");
      return;
    }
    if (!verification.contentIdentity || verification.contentIdentity !== operation.expectedContentIdentity) {
      this.invalidateApprovedVerification(operation.verificationId);
      throw new BackupServiceError(
        "The snapshot changed after you previewed it. Verify and preview it again before restoring.",
        "SNAPSHOT_CHANGED",
        409,
      );
    }
    if (operation.view.cancellationRequested) {
      this.finalize(operation, "cancelled-before-publication", "not_verified");
      return;
    }
    operation.view.state = "running";
    operation.view.phase = "restoring";
    operation.view.updatedAt = this.now();
    const result = await runner.restoreSnapshot(snapshotPath, destinationPath, {
      dbFilename: "agetor.sqlite",
      createDirectory: true,
      requireCompleteProfile: false,
      allowMissingHistoricalKnowledge: true,
      rebindInternalReferences: true,
      expectedContentIdentity: operation.expectedContentIdentity,
    });
    if (operation.terminal) return;
    this.completeRestore(operation, result);
  }

  // ── History ────────────────────────────────────────────────────────────────

  listHistory(): BackupHistoryResponse {
    const candidates = new Map<string, { location: string }>();
    for (const location of this.registry.locations.slice(0, MAX_LOCATIONS)) {
      let entries;
      try {
        entries = readdirSync(location, { withFileTypes: true });
      } catch {
        continue;
      }
      let accepted = 0;
      for (const entry of entries) {
        if (accepted >= MAX_CHILDREN_PER_LOCATION) break;
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const candidate = path.join(location, entry.name);
        try {
          if (!lstatSync(candidate).isDirectory()) continue;
          if (!lstatSync(path.join(candidate, "manifest.json")).isFile()) continue;
        } catch {
          continue;
        }
        candidates.set(canonicalizeExisting(candidate), { location });
        accepted++;
      }
    }
    for (const record of this.registry.snapshots.slice(-MAX_REGISTRY_SNAPSHOTS)) {
      if (candidates.has(canonicalizeExisting(record.path))) continue;
      if (candidates.size >= MAX_HISTORY_ENTRIES) break;
      try {
        if (!lstatSync(record.path).isDirectory()) continue;
      } catch {
        continue;
      }
      const location = this.registry.locations.includes(record.location) ? record.location : record.location;
      candidates.set(canonicalizeExisting(record.path), { location });
    }

    const entries: BackupHistoryEntry[] = [];
    for (const [canonicalPath, meta] of candidates) {
      if (entries.length >= MAX_HISTORY_ENTRIES) break;
      let summary: BackupSnapshotSummary;
      try {
        summary = this.summarizeSnapshot(canonicalPath);
      } catch {
        continue;
      }
      const canonicalSummaryPath = canonicalizeForComparison(summary.snapshotPath);
      const inMemory = this.verificationsByPath.get(canonicalSummaryPath);
      const persisted = this.registry.verifications[summary.snapshotPath];
      const verification: VerificationRecord | null = inMemory
        ? inMemory
        : persisted
          ? {
              id: `registry:${canonicalSummaryPath}`,
              canonicalPath: canonicalSummaryPath,
              snapshotPath: summary.snapshotPath,
              verifiedAt: persisted.verifiedAt,
              ok: persisted.ok,
              databaseSha256: persisted.databaseSha256,
              snapshotId: persisted.snapshotId,
              manifestVersion: null,
              coverage: null,
              issues: persisted.issues,
              contentIdentity: persisted.contentIdentity ?? null,
            }
          : null;
      const matchesArtifact =
        verification !== null &&
        (verification.databaseSha256 === null ||
          summary.databaseSha256 === null ||
          verification.databaseSha256 === summary.databaseSha256);
      let integrity: BackupIntegrity = "not_verified";
      if (matchesArtifact && verification) integrity = verification.ok ? "verified" : "failed";
      entries.push({
        ...summary,
        location: meta.location,
        sizeBytes: summary.totalBytes,
        lastVerifiedAt: verification?.verifiedAt ?? null,
        lastVerificationOk: verification?.ok ?? null,
        integrity,
      });
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return {
      entries: entries.slice(0, MAX_HISTORY_ENTRIES),
      locations: [...this.registry.locations],
      generatedAt: this.now(),
    };
  }

  // ── Operation status / cancellation ────────────────────────────────────────

  getOperation(operationId: string): BackupOperationView {
    const internal = this.operations.get(operationId);
    if (!internal) {
      throw new BackupServiceError("Operation not found", "OPERATION_NOT_FOUND", 404);
    }
    return internal.view;
  }

  /** True while any backup/verify/restore operation is non-terminal. */
  isBusy(): boolean {
    if (this.activeOperationId === null) return false;
    const active = this.operations.get(this.activeOperationId);
    return Boolean(active && !active.terminal);
  }

  listOperations(): BackupOperationView[] {
    return this.operationOrder
      .slice(-MAX_RECENT_OPERATIONS)
      .map((id) => this.operations.get(id))
      .filter((entry): entry is OperationInternal => entry !== undefined)
      .map((entry) => entry.view);
  }

  async cancelOperation(operationId: string): Promise<{
    operation: BackupOperationView;
    cancellation: CancellationResult | null;
  }> {
    const internal = this.operations.get(operationId);
    if (!internal) {
      throw new BackupServiceError("Operation not found", "OPERATION_NOT_FOUND", 404);
    }
    if (internal.terminal) {
      return { operation: internal.view, cancellation: null };
    }
    internal.view.cancellationRequested = true;
    internal.view.updatedAt = this.now();
    const runnerId = internal.currentRunnerId;
    if (!runnerId) {
      this.finalize(internal, "cancelled-before-publication", "not_verified", {
        outcome: "cancelled_before_execution",
      });
      return {
        operation: internal.view,
        cancellation: {
          outcome: "cancelled_before_execution",
          cancelled: true,
          accepted: true,
          operationId,
        },
      };
    }
    const runner = this.getRunner();
    const result = await runner.requestCancellation(runnerId);
    internal.view.cancellationOutcome = result.outcome;
    internal.view.updatedAt = this.now();
    if (result.outcome === "not_found") {
      // The worker no longer knows this operation. Never leave the UI stuck
      // pretending it is still running: preserve the uncertainty explicitly.
      this.finalize(internal, "indeterminate", "not_verified", { outcome: result.outcome });
      return { operation: internal.view, cancellation: result };
    }
    if (result.outcome === "cancelled_before_execution" || result.outcome === "cancelled_before_publication") {
      this.finalize(internal, "cancelled-before-publication", "not_verified", { outcome: result.outcome });
    } else if (result.outcome === "publication_unresolved") {
      this.finalize(internal, "indeterminate", "not_verified", { outcome: result.outcome });
    } else if (result.outcome === "publication_committed") {
      // The artifact exists; never present this as cancelled or verified.
      this.finalize(internal, "published-unconfirmed", "not_verified", { outcome: result.outcome });
    }
    return { operation: internal.view, cancellation: result };
  }

  /**
   * Disposes the isolated runner exactly once. Application shutdown calls this;
   * closing the Settings dialog/webview must never. Runs the runner's bounded
   * disposal (R8B/R9): queued operations are cancelled, live workers are
   * terminated within the single deadline, and published artifacts/receipts
   * are preserved.
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = (async () => {
        const runner = this.runner;
        this.runner = null;
        if (runner) await runner.dispose();
      })();
    }
    return this.disposePromise;
  }

  // ── Internal: operation lifecycle ──────────────────────────────────────────

  private newOperation(
    kind: BackupOperationKind,
    snapshotPath: string | null,
    destinationPath: string | null,
  ): OperationInternal {
    const timestamp = this.now();
    const view: BackupOperationView = {
      id: randomUUID(),
      kind,
      state: "queued",
      integrity: "not_verified",
      phase: null,
      progress: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      snapshotPath,
      destinationPath,
      cancellable: true,
      cancellationRequested: false,
      cancellationOutcome: null,
      error: null,
      verificationIssues: [],
      snapshot: null,
      create: null,
      verify: null,
      restore: null,
    };
    const internal: OperationInternal = {
      view,
      runnerTypeExpected:
        kind === "create" ? "create-snapshot" : kind === "verify" ? "verify-snapshot" : "restore-snapshot",
      currentRunnerId: null,
      terminal: false,
      verificationId: null,
      pendingDestinationName: null,
      expectedContentIdentity: null,
    };
    this.operations.set(view.id, internal);
    this.operationOrder.push(view.id);
    this.activeOperationId = view.id;
    while (this.operationOrder.length > MAX_RECENT_OPERATIONS) {
      const dropped = this.operationOrder.shift();
      if (dropped) {
        const entry = this.operations.get(dropped);
        if (entry?.terminal) this.operations.delete(dropped);
      }
    }
    return internal;
  }

  private handleRunnerState(status: BackupOperationStatus): void {
    let operationId = this.runnerToOperation.get(status.operationId);
    if (!operationId) {
      const active = this.activeOperationId ? this.operations.get(this.activeOperationId) : undefined;
      if (!active || active.terminal) return;
      if (!this.runnerTypeMatches(active, status.type)) return;
      operationId = active.view.id;
      active.currentRunnerId = status.operationId;
      this.runnerToOperation.set(status.operationId, operationId);
    }
    const internal = this.operations.get(operationId);
    if (!internal || internal.terminal) return;
    if (internal.currentRunnerId === null) internal.currentRunnerId = status.operationId;

    const mapped = this.mapRunnerState(status.state);
    if (mapped) internal.view.state = mapped;
    if (internal.view.startedAt === null && status.state !== "queued") {
      internal.view.startedAt = status.startedAt;
    }
    internal.view.phase = status.progress?.phase ?? internal.view.phase;
    internal.view.progress = this.sanitizeProgress(status.progress);
    internal.view.updatedAt = this.now();
  }

  private runnerTypeMatches(
    internal: OperationInternal,
    type: BackupOperationStatus["type"],
  ): boolean {
    if (internal.runnerTypeExpected === "verify-then-restore") {
      return type === "verify-snapshot" || type === "restore-snapshot";
    }
    return type === internal.runnerTypeExpected;
  }

  private mapRunnerState(state: BackupOperationState): BackupUiState | null {
    switch (state) {
      case "queued":
        return "queued";
      case "running":
        return "running";
      case "verifying":
        return "verifying";
      case "publishing":
        return "publishing";
      case "completed":
      case "failed":
      case "cancelled":
        // The authoritative UI state comes from the result/error, never from a
        // bare worker state transition.
        return null;
    }
  }

  private sanitizeProgress(progress: SafeProgressInfo | undefined): BackupProgress | null {
    if (!progress || typeof progress !== "object") return null;
    const out: BackupProgress = { timestamp: this.now() };
    const phase = safeText(progress.phase, 120);
    if (phase) out.phase = phase;
    const bytesProcessed = nonNegativeInt(progress.bytesProcessed);
    if (bytesProcessed !== undefined) out.bytesProcessed = bytesProcessed;
    const totalBytes = nonNegativeInt(progress.totalBytes);
    if (totalBytes !== undefined) out.totalBytes = totalBytes;
    const filesProcessed = nonNegativeInt(progress.filesProcessed);
    if (filesProcessed !== undefined) out.filesProcessed = filesProcessed;
    const totalFiles = nonNegativeInt(progress.totalFiles);
    if (totalFiles !== undefined) out.totalFiles = totalFiles;
    const message = safeText(progress.message, 200);
    if (message) out.message = message;
    return out;
  }

  private completeCreate(
    operation: OperationInternal,
    result: CompactCreateSnapshotResult,
    destinationParent: string,
  ): void {
    if (operation.terminal) return;
    const summary = this.summarizeSnapshot(result.path, result);
    const create: BackupCreateSummary = {
      snapshot: summary,
      databaseSha256: result.databaseSha256,
      totalFiles: result.totalFiles,
      totalBytes: result.totalBytes,
      durationMs: result.durationMs,
      publishedAt: result.createdAt,
    };
    operation.view.create = create;
    operation.view.snapshot = summary;
    operation.view.snapshotPath = summary.snapshotPath;
    operation.view.phase = "published";
    operation.view.error = null;
    this.ensureLocation(destinationParent);
    this.rememberSnapshot(summary, destinationParent);
    // The engine's own creation-time manifest verification is NOT the separate
    // integrity result the UI reports. Leave this artifact unverified until an
    // independent verification operation succeeds.
    this.finalize(operation, "completed", "not_verified");
  }

  private completeVerify(
    operation: OperationInternal,
    result: CompactVerifySnapshotResult,
  ): void {
    if (operation.terminal) return;
    const snapshotPath = path.resolve(result.snapshotPath);
    const manifestVersion = normalizedManifestVersion(result.manifestVersion);
    const legacy = manifestVersion !== null && manifestVersion < 4;
    const issues = boundedIssues(result.issues);
    const verify: BackupVerifySummary = {
      snapshotPath,
      ok: result.ok,
      snapshotId: safeText(result.snapshotId, 200) ?? null,
      manifestVersion,
      coverage: this.coverageFrom(result.coverage, manifestVersion),
      createdAt: nonNegativeInt(result.createdAt) ?? null,
      filesChecked: nonNegativeInt(result.filesChecked) ?? 0,
      totalBytes: nonNegativeInt(result.totalBytes) ?? 0,
      issues,
      databaseSha256: result.databaseSha256 ?? null,
      legacy,
      verifiedAt: this.now(),
      contentIdentity:
        typeof result.contentIdentity === "string" && /^[0-9a-f]{64}$/.test(result.contentIdentity)
          ? result.contentIdentity
          : null,
      brain: issues.some((issue) => issue.startsWith("Brain "))
        ? emptyBrainCoverage("invalid")
        : result.manifest
          ? summarizeBrainRecord(result.manifest.brain)
          : undefined,
    };
    operation.view.verify = verify;
    operation.view.verificationIssues = issues;
    operation.view.snapshotPath = snapshotPath;
    if (result.ok) {
      operation.view.phase = "verified";
      this.recordVerification(operation, verify);
      this.linkVerifiedSnapshot(snapshotPath, verify.databaseSha256, true);
      this.finalize(operation, "completed", "verified");
    } else {
      this.recordVerification(operation, verify);
      this.linkVerifiedSnapshot(snapshotPath, verify.databaseSha256, false);
      this.finalize(operation, "verification-failed", "failed");
    }
  }

  private completeRestore(
    operation: OperationInternal,
    result: CompactRestoreSnapshotResult,
  ): void {
    if (operation.terminal) return;
    const manifestVersion = normalizedManifestVersion(result.manifestVersion);
    const legacy = manifestVersion !== null && manifestVersion < 4;
    const coverage = this.coverageFrom(result.coverage, manifestVersion);
    const readiness = this.readinessFrom(result, legacy);
    const summary: BackupRestoreSummary = {
      destinationPath: path.resolve(result.destinationPath),
      snapshotId: result.snapshotId,
      manifestVersion,
      coverage,
      dbFilename: result.dbFilename,
      databaseBytes: result.databaseBytes,
      databaseTransformed: result.databaseTransformed === true,
      databaseSha256: result.databaseSha256,
      filesRestored: result.filesRestored,
      totalBytesRestored: result.totalBytesRestored,
      durationMs: result.durationMs,
      restoredAt: result.restoredAt ?? this.now(),
      internalReferencesDiscovered: result.internalReferencesDiscovered ?? 0,
      internalReferencesRebound: result.internalReferencesRebound ?? 0,
      internalReferencesUnresolved: result.internalReferencesUnresolved ?? 0,
      unresolvedCrossProfileReferences: result.unresolvedCrossProfileReferences ?? 0,
      crossProfileDependencies: boundedList(result.crossProfileDependencies, MAX_PREVIEW_DEPENDENCIES),
      unresolvedExternalReferences: result.unresolvedExternalReferences ?? 0,
      unresolvedExternalDependencies: boundedList(result.unresolvedExternalDependencies, MAX_PREVIEW_DEPENDENCIES),
      externalProjectsRequiringAttention: result.externalProjectsRequiringAttention ?? 0,
      validationStatus: result.validationStatus ?? "unverified",
      activationReadiness: readiness,
      recoveryReportPath: path.join(path.resolve(result.destinationPath), RESTORE_RECOVERY_FILENAME),
      legacy,
      activated: false,
    };
    operation.view.restore = summary;
    operation.view.destinationPath = summary.destinationPath;
    sealRestoredOwnerTrustFile(path.join(summary.destinationPath, result.dbFilename || "agetor.sqlite"));
    operation.view.snapshotPath = operation.view.snapshotPath ?? null;
    operation.view.phase = "restored";
    const integrity: BackupIntegrity =
      legacy
        ? "not_verified"
        : summary.validationStatus === "valid"
          ? "verified"
          : summary.validationStatus === "failed"
            ? "failed"
            : "not_verified";
    this.finalize(operation, "completed", integrity);
  }

  private setVerificationFailure(operation: OperationInternal, issues: unknown): void {
    const bounded = boundedIssues(issues);
    operation.view.verificationIssues = bounded;
    operation.view.verify = {
      snapshotPath: operation.view.snapshotPath ?? "",
      ok: false,
      snapshotId: null,
      manifestVersion: null,
      coverage: null,
      createdAt: null,
      filesChecked: 0,
      totalBytes: 0,
      issues: bounded,
      databaseSha256: null,
      legacy: false,
      verifiedAt: this.now(),
    };
  }

  private failOperation(operation: OperationInternal, err: unknown): void {
    if (operation.terminal) return;
    const error = this.toOperationError(err);
    operation.view.error = error;
    operation.view.verificationIssues = error.verificationIssues ?? [];
    const classify = this.classifyFailure(err, error);
    this.finalize(operation, classify.state, classify.integrity);
    if (
      operation.view.kind === "create" &&
      (classify.state === "published-unconfirmed" || classify.state === "indeterminate")
    ) {
      // Preserve where the artifact may live. For an ambiguous outcome this is
      // often the chosen parent folder rather than the final snapshot child.
      const details = (err as { details?: { destinationPath?: unknown; targetPath?: unknown } } | null)?.details;
      const rawPath = typeof details?.destinationPath === "string"
        ? details.destinationPath
        : typeof details?.targetPath === "string"
          ? details.targetPath
          : null;
      if (rawPath) {
        operation.view.destinationPath = path.resolve(rawPath);
        if (classify.state === "published-unconfirmed") {
          try {
            operation.view.snapshotPath = path.resolve(rawPath);
            operation.view.snapshot = this.summarizeSnapshot(operation.view.snapshotPath);
            this.rememberSnapshot(operation.view.snapshot, path.dirname(operation.view.snapshotPath));
          } catch {
            /* preserve the raw path only */
          }
        }
      }
    }
  }

  private classifyFailure(
    err: unknown,
    error: BackupOperationError,
  ): { state: BackupUiState; integrity: BackupIntegrity } {
    const code = error.code;
    const details = (err as { details?: Record<string, unknown> } | null)?.details;
    const published = details?.published === true;
    const publication = details?.publicationOutcome as PublicationOutcome | undefined;
    const interrupted = details?.verificationInterrupted === true;
    if (code === "PUBLISHED_UNCONFIRMED") {
      return { state: "published-unconfirmed", integrity: "not_verified" };
    }
    if (code === "INDETERMINATE") {
      return { state: "indeterminate", integrity: "not_verified" };
    }
    if (code === "VERIFICATION_FAILED") {
      return { state: "verification-failed", integrity: interrupted ? "interrupted" : "failed" };
    }
    if (publication === "committed" || published) {
      return { state: "published-unconfirmed", integrity: "not_verified" };
    }
    if (publication === "unresolved") {
      return { state: "indeterminate", integrity: "not_verified" };
    }
    if (code === "CANCELLED" || details?.state === "cancelled") {
      return { state: "cancelled-before-publication", integrity: "not_verified" };
    }
    return { state: "failed-before-publication", integrity: "not_verified" };
  }

  private finalize(
    operation: OperationInternal,
    state: BackupUiState,
    integrity: BackupIntegrity,
    options?: { outcome?: string },
  ): void {
    if (operation.terminal) return;
    operation.terminal = true;
    operation.view.state = state;
    operation.view.integrity = integrity;
    operation.view.finishedAt = this.now();
    operation.view.updatedAt = operation.view.finishedAt;
    operation.view.cancellable = false;
    if (options?.outcome && !operation.view.cancellationOutcome) {
      operation.view.cancellationOutcome = options.outcome;
    }
    if (internalIsFailure(state)) {
      operation.view.cancellable = false;
    }
    if (this.activeOperationId === operation.view.id) this.activeOperationId = null;
    if (operation.currentRunnerId) this.runnerToOperation.delete(operation.currentRunnerId);
    this.saveRegistry();
  }

  // ── Internal: errors ───────────────────────────────────────────────────────

  private toOperationError(err: unknown): BackupOperationError {
    const record = (err ?? {}) as {
      code?: unknown;
      message?: unknown;
      subsystem?: unknown;
      details?: unknown;
    };
    const rawCode = typeof record.code === "string" ? record.code : "UNKNOWN_ERROR";
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : "UNKNOWN_ERROR";
    const message =
      safeText(
        typeof record.message === "string" && record.message.length > 0 ? record.message : String(err),
        MAX_SUMMARY_MESSAGE_CHARS,
      ) ?? "Backup operation failed";
    const out: BackupOperationError = { code, message };
    const subsystem = safeText(record.subsystem, 64);
    if (subsystem) out.subsystem = subsystem;
    if (record.details && typeof record.details === "object") {
      const details = record.details as Record<string, unknown>;
      const issues = boundedIssues(details.verificationIssues ?? details.issues);
      if (issues.length > 0) out.verificationIssues = issues;
      const publication = details.publicationOutcome;
      if (publication === "not_published" || publication === "committed" || publication === "unresolved") {
        out.publicationOutcome = publication;
      }
      const integrity = details.integrityOutcome;
      if (integrity === "verified" || integrity === "failed" || integrity === "not_verified" || integrity === "interrupted") {
        out.integrityOutcome = integrity;
      }
    }
    return out;
  }

  // ── Internal: snapshot summaries ───────────────────────────────────────────

  private summarizeSnapshot(
    snapshotPathRaw: string,
    preloaded?: CompactCreateSnapshotResult,
  ): BackupSnapshotSummary {
    const snapshotPath = path.resolve(snapshotPathRaw);
    let manifest: SnapshotManifest;
    if (preloaded) {
      manifest = {
        manifestVersion: preloaded.manifest.manifestVersion,
        snapshotId: preloaded.snapshotId,
        appVersion: preloaded.appVersion,
        schemaVersion: preloaded.schemaVersion,
        createdAt: preloaded.createdAt,
        verified: true,
        coverage: preloaded.coverage,
        categories: preloaded.manifest.categories,
        stats: preloaded.manifest.stats,
        brain: preloaded.manifest.brain,
        files: [],
      };
    } else {
      const read = readManifest(snapshotPath);
      manifest = read.manifest;
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const databaseEntry = files.find((file) => file.path === "database.sqlite");
    const databasePath = path.join(snapshotPath, "database.sqlite");
    let available = false;
    try {
      const st = lstatSync(databasePath);
      available = st.isFile() && !st.isSymbolicLink();
    } catch {
      available = false;
    }
    const counts = {
      knowledgeDocuments: safeCount(manifest.stats?.knowledgeDocumentCount),
      knowledgeRevisions: safeCount(manifest.stats?.knowledgeRevisionCount),
      attachments: safeCount(manifest.stats?.attachmentCount),
      screenshots: safeCount(manifest.stats?.screenshotCount),
      issueThreads: safeCount(manifest.stats?.issueThreadCount),
      pipelineRuns: safeCount(manifest.stats?.pipelineRunCount),
    };
    const manifestVersion = normalizedManifestVersion(manifest.manifestVersion);
    if (manifestVersion === null) {
      throw new BackupServiceError("Unsupported snapshot manifest version", "INVALID_SNAPSHOT", 400);
    }
    const legacy = manifestVersion < 4;
    return {
      snapshotPath,
      snapshotId: safeText(manifest.snapshotId, 200) ?? path.basename(snapshotPath),
      manifestVersion,
      coverage: this.coverageFrom(manifest.coverage, manifestVersion),
      createdAt: nonNegativeInt(manifest.createdAt) ?? 0,
      appVersion: safeText(manifest.appVersion, 100) ?? null,
      schemaVersion: safeText(manifest.schemaVersion, 100) ?? null,
      manifestVerified: manifest.verified === true,
      files: safeCount(manifest.stats?.fileCount),
      totalBytes: safeCount(manifest.stats?.totalBytes),
      databaseBytes: preloaded ? nonNegativeInt(preloaded.databaseBytes) ?? null : databaseEntry ? safeCount(databaseEntry.bytes) : null,
      databaseSha256: preloaded
        ? typeof preloaded.databaseSha256 === "string" && /^[0-9a-f]{64}$/.test(preloaded.databaseSha256)
          ? preloaded.databaseSha256
          : null
        : typeof databaseEntry?.sha256 === "string" && /^[0-9a-f]{64}$/.test(databaseEntry.sha256)
          ? databaseEntry.sha256
          : null,
      categories: manifestCategories(manifest.categories, files),
      counts,
      brain: summarizeBrainRecord(manifest.brain),
      legacy,
      available,
      manifestError: null,
    };
  }

  private coverageFrom(
    value: unknown,
    manifestVersion: BackupManifestVersion | null,
  ): BackupCoverage | null {
    if (value === COMPLETE_COVERAGE) return COMPLETE_COVERAGE;
    if (value === LEGACY_COVERAGE) return LEGACY_COVERAGE;
    if (manifestVersion !== null && manifestVersion < 4) return LEGACY_COVERAGE;
    return null;
  }

  private rememberSnapshot(summary: BackupSnapshotSummary, location: string): void {
    const canonical = canonicalizeForComparison(summary.snapshotPath);
    this.knownSnapshots.add(canonical);
    this.registry.snapshots = this.registry.snapshots.filter(
      (entry) => canonicalizeForComparison(entry.path) !== canonical,
    );
    this.registry.snapshots.push({
      path: summary.snapshotPath,
      location,
      createdAt: summary.createdAt,
      snapshotId: summary.snapshotId,
      manifestVersion: summary.manifestVersion,
      coverage: summary.coverage,
      totalBytes: summary.totalBytes,
      databaseSha256: summary.databaseSha256,
    });
    if (this.registry.snapshots.length > MAX_REGISTRY_SNAPSHOTS) {
      this.registry.snapshots = this.registry.snapshots.slice(-MAX_REGISTRY_SNAPSHOTS);
    }
    this.saveRegistry();
  }

  private ensureLocation(location: string): void {
    if (!this.registry.locations.includes(location)) {
      this.registry.locations.push(location);
      if (this.registry.locations.length > MAX_LOCATIONS) {
        this.registry.locations = this.registry.locations.slice(-MAX_LOCATIONS);
      }
    }
  }

  private recordVerification(operation: OperationInternal, verify: BackupVerifySummary): void {
    const record: VerificationRecord = {
      id: operation.view.id,
      canonicalPath: canonicalizeForComparison(verify.snapshotPath),
      snapshotPath: verify.snapshotPath,
      verifiedAt: verify.verifiedAt,
      ok: verify.ok,
      databaseSha256: verify.databaseSha256,
      snapshotId: verify.snapshotId,
      manifestVersion: verify.manifestVersion,
      coverage: verify.coverage,
      issues: verify.issues,
      contentIdentity: verify.contentIdentity ?? null,
    };
    this.verificationsByPath.set(record.canonicalPath, record);
    this.verificationsById.set(record.id, record);
    operation.verificationId = record.id;
    const registryVerification: RegistryVerification = {
      verifiedAt: record.verifiedAt,
      ok: record.ok,
      databaseSha256: record.databaseSha256,
      snapshotId: record.snapshotId,
      issues: record.issues,
      contentIdentity: record.contentIdentity,
    };
    this.registry.verifications[verify.snapshotPath] = registryVerification;
    this.pruneVerifications();
  }

  private pruneVerifications(): void {
    const keys = Object.keys(this.registry.verifications);
    if (keys.length <= MAX_REGISTRY_SNAPSHOTS) return;
    const sorted = keys
      .map((key) => ({ key, at: this.registry.verifications[key]?.verifiedAt ?? 0 }))
      .sort((a, b) => a.at - b.at);
    for (const entry of sorted.slice(0, sorted.length - MAX_REGISTRY_SNAPSHOTS)) {
      delete this.registry.verifications[entry.key];
    }
  }

  private linkVerifiedSnapshot(snapshotPath: string, databaseSha256: string | null, ok: boolean): void {
    const target = canonicalizeForComparison(snapshotPath);
    for (const internal of this.operations.values()) {
      if (internal.view.kind !== "create" || internal.view.create === null) continue;
      const snapshot = internal.view.create.snapshot;
      if (canonicalizeForComparison(snapshot.snapshotPath) !== target) continue;
      if (
        databaseSha256 !== null &&
        snapshot.databaseSha256 !== null &&
        databaseSha256 !== snapshot.databaseSha256
      ) {
        continue;
      }
      internal.view.integrity = ok ? "verified" : "failed";
      internal.view.updatedAt = this.now();
    }
  }

  private requireVerification(snapshotPathRaw: string, verificationId: unknown): VerificationRecord {
    const canonical = canonicalizeForComparison(snapshotPathRaw);
    let record: VerificationRecord | undefined;
    if (typeof verificationId === "string" && verificationId.length > 0) {
      const byId = this.verificationsById.get(verificationId);
      if (!byId || byId.canonicalPath !== canonical) {
        throw new BackupServiceError(
          "Verify this snapshot before restoring it",
          "VERIFICATION_REQUIRED",
          409,
        );
      }
      record = byId;
    } else {
      record = this.verificationsByPath.get(canonical);
    }
    if (!record || !record.ok) {
      throw new BackupServiceError(
        "Verify this snapshot successfully before restoring it",
        "VERIFICATION_REQUIRED",
        409,
      );
    }
    if (this.now() - record.verifiedAt > VERIFICATION_TTL_MS) {
      throw new BackupServiceError(
        "The snapshot verification is stale; verify it again before restoring",
        "VERIFICATION_REQUIRED",
        409,
      );
    }
    return record;
  }

  private readinessFrom(
    result: CompactRestoreSnapshotResult,
    legacy: boolean,
  ): BackupActivationReadiness {
    if (legacy) return "legacy-unverified";
    const value = result.activationReadiness;
    if (
      value === "ready" ||
      value === "requires-reference-repair" ||
      value === "requires-external-recovery" ||
      value === "legacy-unverified" ||
      value === "not-ready"
    ) {
      return value;
    }
    return "not-ready";
  }

  private requireAbsolutePath(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new BackupServiceError(`A valid ${label} path is required`, "INVALID_PATH", 400);
    }
    if (!path.isAbsolute(value)) {
      throw new BackupServiceError(`The ${label} path must be absolute`, "INVALID_PATH", 400);
    }
    return path.resolve(value);
  }

  private validateSnapshotPath(value: unknown, options?: { allowUnknown?: boolean }): string {
    const picked = this.requireAbsolutePath(value, "snapshot");
    let st;
    try {
      st = lstatSync(picked);
    } catch {
      throw new BackupServiceError("The selected snapshot folder no longer exists", "INVALID_SNAPSHOT", 400);
    }
    if (st.isSymbolicLink()) {
      throw new BackupServiceError("Snapshot paths cannot be symbolic links", "UNTRUSTED_SYMLINK", 400);
    }
    if (!st.isDirectory()) {
      throw new BackupServiceError("The selected snapshot is not a folder", "INVALID_SNAPSHOT", 400);
    }
    try {
      const manifestStat = lstatSync(path.join(picked, "manifest.json"));
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        throw new BackupServiceError("The snapshot manifest is not a regular file", "INVALID_SNAPSHOT", 400);
      }
    } catch (err) {
      if (err instanceof BackupServiceError) throw err;
      throw new BackupServiceError("The selected folder is not a backup snapshot", "INVALID_SNAPSHOT", 400);
    }
    // Validate the manifest before any operation so a malformed selection fails
    // with a descriptive error instead of a worker crash.
    readManifest(picked);
    if (!options?.allowUnknown && !this.isKnownSnapshotPath(picked)) {
      throw new BackupServiceError(
        "Choose this snapshot folder in the native picker or add its location first",
        "SNAPSHOT_SELECTION_REQUIRED",
        403,
      );
    }
    return picked;
  }

  private isKnownSnapshotPath(snapshotPath: string): boolean {
    this.pruneSnapshotSelections();
    const canonical = canonicalizeForComparison(snapshotPath);
    if (this.knownSnapshots.has(canonical)) return true;
    if (this.snapshotSelections.has(canonical)) return true;
    for (const record of this.registry.snapshots) {
      if (canonicalizeForComparison(record.path) === canonical) return true;
    }
    const parent = canonicalizeForComparison(path.dirname(canonical));
    for (const location of this.registry.locations) {
      if (canonicalizeForComparison(location) === parent) return true;
    }
    return false;
  }

  private pruneSnapshotSelections(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.snapshotSelections) {
      if (expiresAt <= now) this.snapshotSelections.delete(key);
    }
  }

  private assertSourceProfileReady(): void {
    let st;
    try {
      st = lstatSync(this.dbPath);
    } catch {
      throw new BackupServiceError(
        "The active profile database could not be found",
        "INVALID_SOURCE_PROFILE",
        409,
      );
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new BackupServiceError(
        "The active profile database is not a regular file",
        "INVALID_SOURCE_PROFILE",
        409,
      );
    }
    if (path.dirname(canonicalizeForComparison(this.dbPath)) !== this.canonicalDataDir) {
      // The trusted path is constructed from the trusted data dir; this is a
      // belt-and-braces check against future refactors.
      throw new BackupServiceError(
        "The active profile database is outside the active profile",
        "INVALID_SOURCE_PROFILE",
        409,
      );
    }
  }

  private assertDestinationParent(destinationParent: string): void {
    let st;
    try {
      st = lstatSync(destinationParent);
    } catch {
      throw new BackupServiceError("The destination folder no longer exists", "INVALID_DESTINATION", 400);
    }
    if (!st.isDirectory()) {
      throw new BackupServiceError("The destination is not a folder", "INVALID_DESTINATION", 400);
    }
    this.assertNotActiveProfile(destinationParent, "destination");
    this.assertSafeDestinationAncestry(destinationParent);
  }

  /**
   * Rejects a destination that is, or sits inside, a snapshot bundle or another
   * ForgeOrbit profile. Restoring into either would modify an existing artifact
   * or profile even though no file is overwritten. Bounded to 24 ancestors.
   */
  private assertSafeDestinationAncestry(destination: string): void {
    let current = canonicalizeForComparison(destination);
    const root = path.parse(current).root;
    for (let depth = 0; depth < 24; depth++) {
      if (this.looksLikeSnapshotDirectory(current)) {
        throw new BackupServiceError(
          "The destination cannot be a snapshot or reside inside one",
          "INVALID_DESTINATION",
          409,
        );
      }
      if (this.looksLikeProfileDirectory(current)) {
        throw new BackupServiceError(
          "The destination cannot be another ForgeOrbit profile or reside inside one",
          "PROFILE_PROTECTED",
          409,
        );
      }
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private looksLikeSnapshotDirectory(dirPath: string): boolean {
    try {
      return (
        lstatSync(path.join(dirPath, "manifest.json")).isFile() &&
        lstatSync(path.join(dirPath, "database.sqlite")).isFile()
      );
    } catch {
      return false;
    }
  }

  private looksLikeProfileDirectory(dirPath: string): boolean {
    try {
      return lstatSync(path.join(dirPath, "agetor.sqlite")).isFile();
    } catch {
      return false;
    }
  }

  private assertNotActiveProfile(rawPath: string, label: string): void {
    const canonical = canonicalizeForComparison(rawPath);
    if (isPathInside(this.canonicalDataDir, canonical)) {
      throw new BackupServiceError(
        `The ${label} cannot be the active profile or reside inside it`,
        "ACTIVE_PROFILE_PROTECTED",
        409,
      );
    }
    try {
      checkNotActiveDataDir(rawPath);
    } catch (err) {
      if (err instanceof BackupServiceError) throw err;
      throw new BackupServiceError(
        `The ${label} cannot be an active application data directory`,
        "ACTIVE_PROFILE_PROTECTED",
        409,
      );
    }
  }

  private validateDestinationName(value: unknown): string {
    if (value === undefined || value === null || value === "") {
      const stamp = new Date(this.now());
      const pad = (n: number) => String(n).padStart(2, "0");
      return `forgeorbit-restored-${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}-${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}`;
    }
    if (typeof value !== "string") {
      throw new BackupServiceError("The destination folder name is invalid", "INVALID_DESTINATION", 400);
    }
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > 120 ||
      trimmed === "." ||
      trimmed === ".." ||
      trimmed.startsWith(".") ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(trimmed)
    ) {
      throw new BackupServiceError(
        "The destination folder name may only contain letters, numbers, spaces, dots, dashes and underscores",
        "INVALID_DESTINATION",
        400,
      );
    }
    return trimmed;
  }

  private resolveNewRestoreDestination(parent: string, name: string): string {
    this.assertDestinationParent(parent);
    const destination = path.join(parent, name);
    let exists = true;
    try {
      lstatSync(destination);
    } catch {
      exists = false;
    }
    if (exists) {
      throw new BackupServiceError(
        `The destination already exists: ${destination}`,
        "TARGET_EXISTS",
        409,
      );
    }
    this.assertNotActiveProfile(destination, "restore destination");
    return destination;
  }

  private assertRestoreDestination(snapshotPath: string, destinationPath: string): void {
    const canonicalSnapshot = canonicalizeForComparison(snapshotPath);
    const canonicalDestination = canonicalizeForComparison(destinationPath);
    if (
      canonicalDestination === canonicalSnapshot ||
      isPathInside(canonicalSnapshot, canonicalDestination) ||
      isPathInside(canonicalDestination, canonicalSnapshot)
    ) {
      throw new BackupServiceError(
        "The restore destination cannot overlap the snapshot",
        "TARGET_EXISTS",
        409,
      );
    }
  }

  // ── Internal: grants ───────────────────────────────────────────────────────

  private pruneGrants(): void {
    const now = this.now();
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now || grant.consumed) this.grants.delete(id);
    }
  }

  private peekGrant(grantId: unknown, purpose: BackupPickPurpose): GrantRecord {
    if (typeof grantId !== "string" || grantId.length === 0) {
      throw new BackupServiceError("Choose a destination folder first", "DESTINATION_GRANT_REQUIRED", 400);
    }
    const grant = this.grants.get(grantId);
    if (!grant || grant.consumed || grant.expiresAt <= this.now() || grant.purpose !== purpose) {
      throw new BackupServiceError(
        "The destination choice expired or is invalid; choose the folder again",
        "DESTINATION_GRANT_REQUIRED",
        409,
      );
    }
    let st;
    try {
      st = lstatSync(grant.path);
    } catch {
      throw new BackupServiceError("The chosen folder no longer exists", "INVALID_DESTINATION", 409);
    }
    if (!st.isDirectory()) {
      throw new BackupServiceError("The chosen destination is not a folder", "INVALID_DESTINATION", 409);
    }
    return grant;
  }

  private consumeGrant(grantId: unknown, purpose: BackupPickPurpose): GrantRecord {
    const grant = this.peekGrant(grantId, purpose);
    grant.consumed = true;
    return grant;
  }

  private assertNoActiveOperation(): void {
    if (!this.activeOperationId) return;
    const active = this.operations.get(this.activeOperationId);
    if (active && !active.terminal) {
      throw new BackupServiceError(
        "Another backup or recovery operation is already running",
        "OPERATION_IN_PROGRESS",
        409,
      );
    }
    this.activeOperationId = null;
  }

  private getRunner(): BackupRunnerLike {
    if (!this.runner) {
      if (!this.runnerFactory) {
        throw new BackupServiceError(
          "The backup worker is not available",
          "WORKER_UNAVAILABLE",
          500,
        );
      }
      this.runner = this.runnerFactory((status) => this.handleRunnerState(status));
    }
    return this.runner;
  }

  // ── Internal: bounded profile estimate ─────────────────────────────────────

  private estimateScope(): {
    categories: BackupProfileCategoryScope[];
    totalBytes: number;
    fileCount: number;
    truncated: boolean;
  } {
    const roots: { id: BackupAssetCategory; root: string }[] = [
      { id: "knowledge", root: path.join(this.dataDir, "knowledge") },
      { id: "attachments", root: path.join(this.dataDir, "attachments") },
      { id: "screenshots", root: path.join(this.dataDir, "screenshots") },
      { id: "issue-threads", root: path.join(this.dataDir, "issue-threads") },
      { id: "pipeline-runs", root: path.join(this.dataDir, "pipeline-runs") },
      { id: "brain", root: path.join(this.dataDir, "brain") },
    ];
    const categories: BackupProfileCategoryScope[] = [];
    let totalBytes = 0;
    let fileCount = 0;
    let truncated = false;
    const deadline = this.now() + MAX_ESTIMATE_MS;
    let seen = 0;
    const walk = (dir: string, id: BackupAssetCategory): { bytes: number; files: number } => {
      let bytes = 0;
      let files = 0;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return { bytes, files };
      }
      for (const entry of entries) {
        if (seen >= MAX_ESTIMATE_ENTRIES || this.now() > deadline) {
          truncated = true;
          return { bytes, files };
        }
        seen++;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          truncated = true;
          continue;
        }
        if (entry.isDirectory()) {
          const child = walk(full, id);
          bytes += child.bytes;
          files += child.files;
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = lstatSync(full);
          bytes += st.size;
          files++;
        } catch {
          /* raced away */
        }
      }
      return { bytes, files };
    };
    for (const entry of roots) {
      if (!existsSync(entry.root)) {
        categories.push({ id: entry.id, fileCount: 0, bytes: 0, included: true });
        continue;
      }
      let st;
      try {
        st = lstatSync(entry.root);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        truncated = true;
        categories.push({ id: entry.id, fileCount: 0, bytes: 0, included: true });
        continue;
      }
      if (!st.isDirectory()) {
        categories.push({ id: entry.id, fileCount: 0, bytes: 0, included: true });
        continue;
      }
      const result = walk(entry.root, entry.id);
      categories.push({ id: entry.id, fileCount: result.files, bytes: result.bytes, included: true });
      totalBytes += result.bytes;
      fileCount += result.files;
    }
    return { categories, totalBytes, fileCount, truncated };
  }

  private safeFileBytes(filePath: string): number {
    try {
      const st = lstatSync(filePath);
      return st.isFile() && !st.isSymbolicLink() ? st.size : 0;
    } catch {
      return 0;
    }
  }

  // ── Internal: registry persistence ─────────────────────────────────────────

  private seedVerificationsFromRegistry(): void {
    for (const [snapshotPath, persisted] of Object.entries(this.registry.verifications)) {
      const canonical = canonicalizeForComparison(snapshotPath);
      if (this.verificationsByPath.has(canonical)) continue;
      const record: VerificationRecord = {
        id: `registry:${canonical}`,
        canonicalPath: canonical,
        snapshotPath,
        verifiedAt: persisted.verifiedAt,
        ok: persisted.ok,
        databaseSha256: persisted.databaseSha256,
        snapshotId: persisted.snapshotId,
        manifestVersion: null,
        coverage: null,
        issues: persisted.issues,
        contentIdentity: persisted.contentIdentity ?? null,
      };
      this.verificationsByPath.set(canonical, record);
      this.verificationsById.set(record.id, record);
    }
  }

  private loadRegistry(): RegistryState {
    try {
      // Bound the convenience index before reading it. A corrupt or oversized
      // registry must never prevent startup; it is ignored and rebuilt from
      // real snapshot discovery. Valid existing data is preserved and used.
      const stat = lstatSync(this.registryPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRY_FILE_BYTES) {
        return emptyRegistry();
      }
      const raw = JSON.parse(readFileSync(this.registryPath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyRegistry();
      const record = raw as Record<string, unknown>;
      const locations = Array.isArray(record.locations)
        ? record.locations
            .filter((value): value is string => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))
            .slice(0, MAX_LOCATIONS)
        : [];
      const snapshots = Array.isArray(record.snapshots)
        ? record.snapshots
            .filter((value): value is RegistrySnapshot => {
              if (!value || typeof value !== "object") return false;
              const entry = value as Record<string, unknown>;
              return typeof entry.path === "string" && path.isAbsolute(entry.path);
            })
            .slice(-MAX_REGISTRY_SNAPSHOTS)
        : [];
      const verifications: Record<string, RegistryVerification> = {};
      if (record.verifications && typeof record.verifications === "object" && !Array.isArray(record.verifications)) {
        for (const [key, value] of Object.entries(record.verifications as Record<string, unknown>)) {
          if (!value || typeof value !== "object") continue;
          const entry = value as Record<string, unknown>;
          const verifiedAt = nonNegativeInt(entry.verifiedAt);
          if (verifiedAt === undefined) continue;
          verifications[key] = {
            verifiedAt,
            ok: entry.ok === true,
            databaseSha256:
              typeof entry.databaseSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.databaseSha256)
                ? entry.databaseSha256
                : null,
            snapshotId: safeText(entry.snapshotId, 200) ?? null,
            issues: boundedIssues(entry.issues),
            contentIdentity:
              typeof entry.contentIdentity === "string" && /^[0-9a-f]{64}$/.test(entry.contentIdentity)
                ? entry.contentIdentity
                : null,
          };
        }
      }
      return { version: 1, locations, snapshots, verifications };
    } catch {
      return emptyRegistry();
    }
  }

  private saveRegistry(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.registry, null, 2), { mode: 0o600 });
      renameSync(temporary, this.registryPath);
    } catch {
      /* best effort: the registry is a convenience index, never the artifact */
    }
  }
}

function internalIsFailure(state: BackupUiState): boolean {
  return (
    state === "published-unconfirmed" ||
    state === "indeterminate" ||
    state === "verification-failed" ||
    state === "failed-before-publication"
  );
}

function safeCount(value: unknown): number {
  return nonNegativeInt(value) ?? 0;
}

function boundedList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    const text = safeText(entry, 1024);
    if (text) out.push(text);
  }
  return out;
}

/** Reads and validates the bounded snapshot manifest without touching the DB. */
function readManifest(snapshotPath: string): { manifest: SnapshotManifest } {
  const manifestPath = path.join(snapshotPath, "manifest.json");
  let st;
  try {
    st = lstatSync(manifestPath);
  } catch {
    throw new BackupServiceError("Snapshot manifest.json is missing", "INVALID_SNAPSHOT", 400);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new BackupServiceError("Snapshot manifest.json is not a regular file", "INVALID_SNAPSHOT", 400);
  }
  if (st.size <= 0 || st.size > MAX_MANIFEST_SIZE_BYTES) {
    throw new BackupServiceError("Snapshot manifest.json has an invalid size", "INVALID_SNAPSHOT", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new BackupServiceError("Snapshot manifest.json is corrupt", "INVALID_SNAPSHOT", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BackupServiceError("Snapshot manifest.json is invalid", "INVALID_SNAPSHOT", 400);
  }
  const manifest = parsed as SnapshotManifest;
  if (normalizedManifestVersion(manifest.manifestVersion) === null) {
    throw new BackupServiceError("Unsupported snapshot manifest version", "INVALID_SNAPSHOT", 400);
  }
  if (typeof manifest.snapshotId !== "string" || manifest.snapshotId.length === 0) {
    throw new BackupServiceError("Snapshot manifest is missing its identifier", "INVALID_SNAPSHOT", 400);
  }
  if (!Array.isArray(manifest.files) && !manifest.stats) {
    throw new BackupServiceError("Snapshot manifest is missing its file inventory", "INVALID_SNAPSHOT", 400);
  }
  return { manifest };
}
