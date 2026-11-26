/**
 * Non-Blocking Backup/Restore Process Isolation Runner (FO-P2-003-R4A).
 *
 * Spawns and supervises dedicated Bun child processes for computationally heavy
 * SQLite online backups, integrity verification, snapshot packaging, and restorations.
 *
 * Guarantees:
 * 1. Bun main event loop remains responsive and never blocks on SQLite VACUUM or large disk I/O.
 * 2. Process-wide settings like `process.umask(0o077)` stay strictly within isolated worker processes.
 * 3. Never transfers live SQLite connections across process boundaries.
 * 4. Strictly refuses active production data directory restoration.
 * 5. Bounded result protocol: compact JSON summaries over IPC, full manifests kept on disk.
 * 6. Reliable worker stdout delivery respecting backpressure and exit synchronization.
 * 7. Strict runtime validation for frame sizes, discriminants, paths, checksums, and states.
 * 8. Trustworthy completion: parent is the sole authority; subscribers never see transient "completed" -> "failed".
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkNotActiveDataDir, cleanIncompleteRestoreStaging, RestoreError } from "./backup-restore.ts";
import {
  BackupCoreError,
  cleanScopedWorkerStaging,
  cleanStalePublicationReceipts,
  cleanSubsystemStaging,
  CORE_STAGING_SCAN_RE,
  isPidAlive,
  isSqliteAuxiliaryOrSamePath,
  pathExistsOrSymlink,
  type PublicationTempCleanupResult,
  readBackupPublicationReceipt,
  readStagingOwnershipMetadata,
  recoverStalePublicationTempFiles,
  releaseFlock,
  removeBackupPublicationReceipt,
  type ScopedCleanupResult,
  type StagingSubsystem,
  tryAcquireFlock,
  RESTORE_RECOVERY_FILENAME,
} from "./backup-core.ts";
import { parseSerializedBackupError } from "./backup-ipc.ts";
import { BackupManagerError, cleanIncompleteBackupSnapshots, validateSourceProfileLayout } from "./backup-manager.ts";
import {
  type ArtifactIntegrityOutcome,
  type BackupDatabasePayload,
  type BackupOperationPayload,
  type BackupOperationRequest,
  type BackupOperationResultMap,
  type BackupOperationState,
  type BackupOperationStatus,
  type BackupOperationType,
  BackupRunnerError,
  type BoundedBackupResultPayload,
  type CancellationOutcome,
  type CancellationResult,
  type CompactBackupDatabaseResult,
  type CompactCreateSnapshotResult,
  type CompactRestoreSnapshotResult,
  type CompactVerifyDatabaseResult,
  type CompactVerifySnapshotResult,
  type CreateSnapshotPayload,
  MAX_IPC_BUFFER_BYTES,
  MAX_IPC_FRAME_BYTES,
  MAX_IPC_ERROR_ISSUE_CHARS,
  MAX_IPC_ERROR_ISSUE_COUNT,
  MAX_STDERR_TAIL_BYTES,
  type ParentToWorkerMessage,
  type PublicationOutcome,
  type RestoreSnapshotPayload,
  type SafeProgressInfo,
  type SerializedBackupError,
  type SerializedBackupErrorDetails,
  type VerifyDatabasePayload,
  type VerifySnapshotPayload,
  type WorkerMessageState,
  type WorkerToParentMessage,
} from "./backup-runner-types.ts";

export interface BackupProcessRunnerOptions {
  /** Maximum number of concurrent worker processes (default 1). */
  maxConcurrency?: number;
  /** Default bounded timeout in milliseconds for operations (default 300,000 ms = 5 min; 0 = disabled). */
  defaultTimeoutMs?: number;
  /** Maximum number of completed operations retained in public history (default 100). */
  maxRecentOperations?: number;
  /** Explicit path to worker script. If omitted, resolved from packaged or local paths. */
  workerScriptPath?: string;
  /** Explicit path to Bun executable. Defaults to process.execPath. */
  bunExecutable?: string;
  /** Bounded grace period in milliseconds to wait for children to exit during dispose (default 4,000 ms). */
  disposeGraceMs?: number;
  /** Callback fired whenever any operation transitions state or reports progress. */
  onStateChange?: (status: BackupOperationStatus) => void;
}

interface ActiveOperationHandle {
  operationId: string;
  type: BackupOperationType;
  payload: BackupOperationPayload;
  /**
   * The final artifact path this operation reports. Auto-named snapshot
   * operations start with the destination parent here and mutate it to the
   * generated snapshot path once the worker publishes. It is deliberately NOT
   * the lock ownership key — see `reservationKey`.
   */
  targetPath: string;
  initialTargetPath: string;
  /**
   * Immutable key added to `activeTargets` at submission time and the only key
   * this operation may ever release. For an auto-named snapshot this is the
   * destination parent that was collapsed on; for every other operation it is
   * the resolved destination itself.
   */
  reservationKey: string;
  /** True once `releaseTarget` removed `reservationKey`; makes release idempotent. */
  reservationReleased: boolean;
  candidateChildPath?: string;
  preExistingParentEntries: Set<string>;
  state: BackupOperationState;
  startedAt: number;
  updatedAt: number;
  timeoutMs: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  pid?: number;
  stagingDir?: string;
  progress?: SafeProgressInfo;
  lastError?: BackupRunnerError;
  result?: BoundedBackupResultPayload;
  isCancelled: boolean;
  isTimedOut: boolean;
  published: boolean;
  publishedAt?: number;
  destinationExistedAtStart: boolean;
  stderrTail?: string;
  workerCwd?: string | null;
  workerCwdLockFd?: number | null;
  isSettled?: boolean;
  /** True once a worker process was actually spawned for this operation. */
  started?: boolean;
  /** True once the child process actually exited (not merely signalled). */
  exited?: boolean;
  /** True once a terminal outcome has been stored in `recentOperations`. */
  finalized?: boolean;
  /** True while the runner is performing bounded disposal for this handle. */
  isDisposing?: boolean;
  /** True when an isolated verification was intentionally terminated (not an artifact error). */
  verificationInterrupted?: boolean;
  /** True only after an isolated verification of this operation's exact artifact succeeded. */
  destinationVerified?: boolean;
  completionPromise?: Promise<void>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

function isAutoNamedSnapshotPayload(payload: BackupOperationPayload): payload is CreateSnapshotPayload {
  return (
    payload.type === "create-snapshot" &&
    Boolean(payload.snapshotDestinationDir) &&
    !payload.destinationPath
  );
}

function listDirectoryEntryNames(dirPath: string): Set<string> {
  const names = new Set<string>();
  try {
    const resolved = path.resolve(dirPath);
    if (pathExistsOrSymlink(resolved)) {
      const st = lstatSync(resolved);
      if (!st.isSymbolicLink() && st.isDirectory()) {
        for (const entry of readdirSync(resolved)) {
          names.add(entry);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return names;
}

function verifySnapshotOperationIdentity(snapshotDir: string, expectedOperationId: string): boolean {
  try {
    const resolvedDir = path.resolve(snapshotDir);
    if (!pathExistsOrSymlink(resolvedDir)) return false;
    const dirStat = lstatSync(resolvedDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    const manifestPath = path.join(resolvedDir, "manifest.json");
    if (!pathExistsOrSymlink(manifestPath)) return false;
    const mStat = lstatSync(manifestPath);
    if (mStat.isSymbolicLink() || !mStat.isFile()) return false;
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.verified !== true) return false;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata !== "object") return false;
    return metadata.runnerOperationId === expectedOperationId;
  } catch {
    return false;
  }
}

function verifyRestoreOperationIdentity(restoreDir: string, expectedOperationId: string): boolean {
  try {
    const resolvedDir = path.resolve(restoreDir);
    if (!pathExistsOrSymlink(resolvedDir)) return false;
    const dirStat = lstatSync(resolvedDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    const recoveryPath = path.join(resolvedDir, RESTORE_RECOVERY_FILENAME);
    if (!pathExistsOrSymlink(recoveryPath)) return false;
    const rStat = lstatSync(recoveryPath);
    if (rStat.isSymbolicLink() || !rStat.isFile()) return false;
    const raw = readFileSync(recoveryPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    return parsed.runnerOperationId === expectedOperationId;
  } catch {
    return false;
  }
}

/**
 * Classification of an operation's publication state from durable, local evidence only
 * (R8B). Process exit codes, `failed`, `killed`, `timed_out` and `INDETERMINATE` are
 * deliberately NOT treated as proof of non-publication — only affirmative filesystem
 * evidence (no artifact, no receipt, no in-progress publication marker, and a child
 * that has actually exited) can establish "not published".
 */
type PublicationEvidence = "committed" | "unresolved" | "not_published";

/**
 * Structured outcome of reconciling a destination against one operation's
 * evidence (R9). Publication and integrity are reported independently so a
 * committed artifact can never be mistaken for a verified one, and a failed
 * verification can never erase the fact that something was published.
 */
interface PublicationReconciliation {
  publication: PublicationOutcome;
  integrity: ArtifactIntegrityOutcome;
  destinationPath?: string;
  destinationVerified: boolean;
  verificationFailed: boolean;
  verificationInterrupted: boolean;
  issues: string[];
  identityVerified: boolean;
  reason?: string;
}

function baseReconciliation(
  publication: PublicationOutcome,
  options: Partial<Omit<PublicationReconciliation, "publication">> = {},
): PublicationReconciliation {
  return {
    publication,
    integrity: options.integrity ?? "not_verified",
    destinationPath: options.destinationPath,
    destinationVerified: options.destinationVerified === true,
    verificationFailed: options.verificationFailed === true,
    verificationInterrupted: options.verificationInterrupted === true,
    issues: options.issues ?? [],
    identityVerified: options.identityVerified === true,
    reason: options.reason,
  };
}

function boundedVerificationIssues(issues: unknown): string[] {
  if (!Array.isArray(issues)) return [];
  const out: string[] = [];
  for (const issue of issues) {
    if (out.length >= MAX_IPC_ERROR_ISSUE_COUNT) break;
    if (typeof issue !== "string") continue;
    const trimmed = issue.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_IPC_ERROR_ISSUE_CHARS));
  }
  return out;
}

/**
 * Reads staging ownership metadata and only accepts it when it is attributable
 * to THIS runner operation and its target. Unknown or foreign metadata is
 * treated as no evidence at all.
 */
function readOwnedStagingState(
  handle: {
    operationId: string;
    stagingDir?: string;
    initialTargetPath: string;
  },
  expectedSubsystem?: StagingSubsystem,
): "publishing" | "completed" | "prepublication" | "unknown" {
  if (!handle.stagingDir) return "unknown";
  try {
    const metadata = readStagingOwnershipMetadata(handle.stagingDir);
    if (!metadata) return "unknown";
    // The runner operation id is the strongest identity. Workers that do not
    // request a publication receipt still write the staging target path; the
    // parent has already validated that staging directory belongs to THIS
    // operation's target, so a matching subsystem + target is attributable.
    const runnerIdentityMatches = metadata.runnerOperationId === handle.operationId;
    const stagingIdentityMatches =
      metadata.runnerOperationId === undefined &&
      expectedSubsystem !== undefined &&
      metadata.subsystem === expectedSubsystem &&
      typeof metadata.targetPath === "string" &&
      metadata.targetPath.length > 0;
    if (!runnerIdentityMatches && !stagingIdentityMatches) return "unknown";
    if (typeof metadata.targetPath === "string" && metadata.targetPath.length > 0) {
      if (path.resolve(metadata.targetPath) !== path.resolve(handle.initialTargetPath)) {
        return "unknown";
      }
    }
    if (metadata.state === "publishing" || metadata.state === "completed") {
      return metadata.state;
    }
    return "prepublication";
  } catch {
    return "unknown";
  }
}

/**
 * Reads the staging ownership metadata state without spawning a verification child.
 * Returns "unknown" when the metadata is absent or unreadable (fail-closed: the caller
 * must not treat unknown evidence as proof of anything).
 */
function readStagingPublicationState(
  stagingDir?: string,
): "publishing" | "completed" | "prepublication" | "unknown" {
  if (!stagingDir) return "unknown";
  try {
    if (!pathExistsOrSymlink(stagingDir)) return "unknown";
    const metaPath = path.join(stagingDir, ".forgeorbit-ownership.json");
    if (!pathExistsOrSymlink(metaPath)) return "unknown";
    const raw = readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw) as { state?: unknown };
    if (parsed?.state === "publishing" || parsed?.state === "completed") {
      return parsed.state;
    }
    if (
      parsed?.state === "preparing" ||
      parsed?.state === "writing" ||
      parsed?.state === "verifying" ||
      parsed?.state === "failed"
    ) {
      return "prepublication";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Safely scans tmpdir() for orphaned worker and verification working directories (fo-worker-cwd-*, fo-verify-cwd-*).
 * Uses OS flock checks and PID validation to distinguish active processes from dead-process orphans.
 * Bounded work, conservative failure modes, symlink safe.
 */
export function cleanOrphanWorkerCwds(
  maxAgeMs = 300_000,
  baseTmpDir: string = tmpdir(),
): { cleaned: string[]; preserved: string[]; errors: string[] } {
  const result = { cleaned: [] as string[], preserved: [] as string[], errors: [] as string[] };
  const resolvedBase = path.resolve(baseTmpDir);

  let entries: string[];
  try {
    const st = lstatSync(resolvedBase);
    if (st.isSymbolicLink() || !st.isDirectory()) return result;
    entries = readdirSync(resolvedBase);
  } catch {
    return result;
  }

  const CWD_RE = /^fo-(?:worker|verify)-cwd-[0-9a-zA-Z_-]+$/;
  const now = Date.now();
  let checkedCount = 0;

  for (const entry of entries) {
    if (!CWD_RE.test(entry)) continue;
    checkedCount++;
    if (checkedCount > 100) break;

    const cwdPath = path.join(resolvedBase, entry);
    try {
      const st = lstatSync(cwdPath);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        result.preserved.push(cwdPath);
        continue;
      }

      // Check for OS lock file inside cwd
      const lockPath = path.join(cwdPath, ".fo-worker.lock");
      if (pathExistsOrSymlink(lockPath)) {
        let lockFd: number | null = null;
        try {
          lockFd = openSync(lockPath, constants.O_RDWR, 0o600);
          const acquired = tryAcquireFlock(lockFd);
          if (!acquired) {
            // An active process holds the flock!
            result.preserved.push(cwdPath);
            continue;
          }
        } catch {
          result.preserved.push(cwdPath);
          continue;
        } finally {
          if (lockFd !== null) {
            try {
              releaseFlock(lockFd);
            } catch {}
            try {
              closeSync(lockFd);
            } catch {}
          }
        }
      }

      // Inspect metadata if present
      const metaPath = path.join(cwdPath, ".fo-worker.json");
      if (pathExistsOrSymlink(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8"));
          if (meta?.pid && isPidAlive(meta.pid)) {
            result.preserved.push(cwdPath);
            continue;
          }
        } catch {
          // malformed metadata: preserve if recent
          if (now - st.mtimeMs < maxAgeMs) {
            result.preserved.push(cwdPath);
            continue;
          }
        }
      } else {
        if (now - st.mtimeMs < maxAgeMs) {
          result.preserved.push(cwdPath);
          continue;
        }
      }

      // Safe to clean dead orphan directory
      rmSync(cwdPath, { recursive: true, force: true });
      result.cleaned.push(cwdPath);
    } catch (err) {
      result.errors.push(`Failed to clean worker cwd ${cwdPath}: ${(err as Error).message}`);
    }
  }

  return result;
}

const VALID_OPERATION_TYPES: Set<BackupOperationType> = new Set([
  "backup-database",
  "verify-database",
  "create-snapshot",
  "verify-snapshot",
  "restore-snapshot",
]);

const STATE_RANK: Record<BackupOperationState, number> = {
  queued: 0,
  running: 1,
  verifying: 2,
  publishing: 3,
  completed: 4,
  failed: 4,
  cancelled: 4,
};

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

function sanitizeDiagnostics(text: string): string {
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(token[=:]\s*)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(password[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(secret[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(sk-[a-zA-Z0-9_\-]{20,})/gi, "[REDACTED_API_KEY]")
    .replace(/(ghp_[a-zA-Z0-9]{20,})/gi, "[REDACTED_GH_TOKEN]")
    .replace(/(github_pat_[a-zA-Z0-9_]{20,})/gi, "[REDACTED_GH_TOKEN]");
}

export const WORKER_ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "NODE_ENV",
  "BUN_INSTALL",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "FORGEORBIT_DATA_DIR",
  "AGETOR_DATA_DIR",
  "FORGEORBIT_TEST_ENV",
]);

const SENSITIVE_KEY_PATTERN = /(?:KEY|TOKEN|SECRET|AUTH|PASS|CRED|SIGN|PRIVATE|BEARER)/i;

/**
 * Builds an isolated, minimal child environment for backup worker processes (FO-P2-003-R4D).
 * Strictly filters parent environment against an explicit allowlist and strips all
 * provider API keys, Git host tokens, bearer tokens, signing credentials, and unrelated variables.
 */
export function buildWorkerEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  customEntries: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    FORGEORBIT_ISOLATED_OPERATION: "1",
  };

  for (const key of WORKER_ALLOWED_ENV_VARS) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue; // defense-in-depth: never inherit sensitive variables
    const val = baseEnv[key];
    if (val !== undefined && typeof val === "string") {
      env[key] = val;
    }
  }

  // Ensure default system PATH if parent PATH is missing
  if (!env.PATH) {
    env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";
  }

  // Allow controlled internal additions (e.g. testing) as long as they don't match sensitive patterns
  for (const [k, v] of Object.entries(customEntries)) {
    if (!SENSITIVE_KEY_PATTERN.test(k) && typeof v === "string") {
      env[k] = v;
    }
  }

  return env;
}

function writeToChildStdin(
  proc: ReturnType<typeof Bun.spawn> | null,
  data: string,
): void {
  if (!proc || !proc.stdin || typeof proc.stdin === "number") return;
  try {
    proc.stdin.write(data);
    proc.stdin.flush();
  } catch {
    /* best effort */
  }
}

/**
 * Resolves the trusted worker script path (FO-P2-003-R4D).
 *
 * In packaged macOS applications:
 * 1. Strictly refuses arbitrary environment-supplied worker scripts (FORGEORBIT_BACKUP_WORKER_PATH)
 *    unless in explicit test mode.
 * 2. Uses the packaged worker bundle inside the .app bundle (Resources/app/bun/backup-worker.js).
 * 3. Verifies sha256 checksum against sidecar if present.
 * 4. Fails closed with WORKER_SCRIPT_NOT_FOUND or WORKER_INTEGRITY_FAILED instead of falling back to unrelated scripts.
 */
export function resolveWorkerScriptPath(
  customPath?: string,
  context: { execPath?: string; moduleDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const execPath = context.execPath ?? process.execPath;
  const moduleDir = context.moduleDir ?? import.meta.dir;
  const env = context.env ?? process.env;

  const execDir = path.dirname(execPath);
  const isPackagedMacApp =
    path.basename(execDir) === "MacOS" &&
    path.basename(path.dirname(execDir)) === "Contents";
  const isPackagedAppCode =
    moduleDir.includes(`${path.sep}Contents${path.sep}Resources${path.sep}app`) ||
    moduleDir.endsWith(`${path.sep}Resources${path.sep}app${path.sep}bun`);

  const isPackaged = isPackagedMacApp || isPackagedAppCode;

  if (customPath) {
    const resolvedCustom = path.resolve(customPath);
    if (!existsSync(resolvedCustom)) {
      throw new BackupRunnerError(
        `Specified worker script does not exist: ${resolvedCustom}`,
        "WORKER_SCRIPT_NOT_FOUND",
      );
    }
    return resolvedCustom;
  }

  // In packaged mode, NEVER allow environment-supplied worker script overrides under any circumstances
  // (even if NODE_ENV=test or FORGEORBIT_TEST_ENV=1 is set)
  if (!isPackaged) {
    if (env.FORGEORBIT_BACKUP_WORKER_PATH) {
      const envWorker = path.resolve(env.FORGEORBIT_BACKUP_WORKER_PATH);
      if (!existsSync(envWorker)) {
        throw new BackupRunnerError(
          `FORGEORBIT_BACKUP_WORKER_PATH points to non-existent file: ${envWorker}`,
          "WORKER_SCRIPT_NOT_FOUND",
        );
      }
      return envWorker;
    }
  }

  if (isPackaged) {
    // Search packaged app bundle: Contents/Resources/app/bun/backup-worker.js
    const packagedBun = path.resolve(execDir, "../Resources/app/bun/backup-worker.js");
    if (existsSync(packagedBun)) {
      verifyWorkerIntegrity(packagedBun, true);
      return packagedBun;
    }
    const packagedBin = path.resolve(execDir, "../Resources/app/bin/backup-worker.js");
    if (existsSync(packagedBin)) {
      verifyWorkerIntegrity(packagedBin, true);
      return packagedBin;
    }
    if (isPackagedAppCode) {
      const localBundled = path.resolve(moduleDir, "backup-worker.js");
      if (existsSync(localBundled)) {
        verifyWorkerIntegrity(localBundled, true);
        return localBundled;
      }
    }
    throw new BackupRunnerError(
      `Packaged backup worker script missing inside app bundle: ${packagedBun}`,
      "WORKER_SCRIPT_NOT_FOUND",
    );
  }

  // Local TypeScript source (development / test runner)
  const localTs = path.join(moduleDir, "backup-worker.ts");
  if (existsSync(localTs)) return localTs;

  // Local JavaScript source
  const localJs = path.join(moduleDir, "backup-worker.js");
  if (existsSync(localJs)) return localJs;

  // CWD-relative repository source
  const repoTs = path.join(process.cwd(), "src", "bun", "backup-worker.ts");
  if (existsSync(repoTs)) return repoTs;

  throw new BackupRunnerError(
    `Could not resolve backup worker script in development source tree (${localTs})`,
    "WORKER_SCRIPT_NOT_FOUND",
  );
}

function verifyWorkerIntegrity(scriptPath: string, requireSidecar = false): void {
  const hashPath = scriptPath.replace(/\.js$/, ".sha256");
  if (!existsSync(hashPath)) {
    if (requireSidecar) {
      throw new BackupRunnerError(
        `Packaged backup worker integrity sidecar missing: ${hashPath}`,
        "WORKER_INTEGRITY_FAILED",
      );
    }
    return;
  }
  try {
    const expected = readFileSync(hashPath, "utf8").trim();
    const actual = new Bun.CryptoHasher("sha256")
      .update(readFileSync(scriptPath))
      .digest("hex");
    if (expected !== actual) {
      throw new BackupRunnerError(
        `Backup worker bundle integrity mismatch: expected ${expected}, got ${actual}`,
        "WORKER_INTEGRITY_FAILED",
      );
    }
  } catch (err) {
    if (err instanceof BackupRunnerError) throw err;
    throw new BackupRunnerError(
      `Failed to verify backup worker integrity: ${(err as Error).message}`,
      "WORKER_INTEGRITY_FAILED",
      { cause: err },
    );
  }
}

export class BackupProcessRunner {
  private readonly maxConcurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxRecentOperations: number;
  private readonly workerScriptPath: string;
  private readonly bunExecutable: string;
  private readonly disposeGraceMs: number;
  private readonly onStateChange?: (status: BackupOperationStatus) => void;

  private readonly activeOperations = new Map<string, ActiveOperationHandle>();
  private readonly recentOperations = new Map<string, BackupOperationStatus>();
  private readonly activeTargets = new Set<string>();
  private readonly queue: ActiveOperationHandle[] = [];
  private readonly activeVerificationProcs = new Set<ReturnType<typeof Bun.spawn>>();
  private runningCount = 0;
  private isDisposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: BackupProcessRunnerOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.maxRecentOperations = Math.max(1, options.maxRecentOperations ?? 100);
    this.workerScriptPath = resolveWorkerScriptPath(options.workerScriptPath);
    this.bunExecutable = options.bunExecutable ?? process.execPath;
    this.disposeGraceMs = Math.max(50, options.disposeGraceMs ?? 4000);
    this.onStateChange = options.onStateChange;
  }

  /**
   * Submit an online SQLite backup operation to run in an isolated child process.
   */
  async backupDatabase(
    dbPath: string,
    destinationPath: string,
    options?: { createDirectory?: boolean; timeoutMs?: number },
  ): Promise<BackupOperationResultMap["backup-database"]> {
    const payload: BackupDatabasePayload = {
      type: "backup-database",
      dbPath,
      destinationPath,
      createDirectory: options?.createDirectory,
    };
    return this.submitOperation<"backup-database">(payload, options?.timeoutMs);
  }

  /**
   * Submit an SQLite database integrity verification operation.
   */
  async verifyDatabase(
    filePath: string,
    options?: { timeoutMs?: number },
  ): Promise<BackupOperationResultMap["verify-database"]> {
    const payload: VerifyDatabasePayload = {
      type: "verify-database",
      filePath,
    };
    return this.submitOperation<"verify-database">(payload, options?.timeoutMs);
  }

  /**
   * Submit a full backup snapshot creation operation with Knowledge files packaging.
   */
  async createSnapshot(
    dbPath: string,
    snapshotDestinationDirOrPath: string,
    options?: {
      isExplicitPath?: boolean;
      knowledgeRootDir?: string;
      dataDir?: string;
      attachmentsRootDir?: string;
      screenshotsRootDir?: string;
      issueThreadsRootDir?: string;
      pipelineRunsRootDir?: string;
      manifestVersion?: 1 | 2 | 3 | 4;
      createDirectory?: boolean;
      maxRetries?: number;
      manifestMetadata?: Record<string, unknown>;
      timeoutMs?: number;
    },
  ): Promise<BackupOperationResultMap["create-snapshot"]> {
    const payload: CreateSnapshotPayload = {
      type: "create-snapshot",
      dbPath,
      snapshotDestinationDir: options?.isExplicitPath ? undefined : snapshotDestinationDirOrPath,
      destinationPath: options?.isExplicitPath ? snapshotDestinationDirOrPath : undefined,
      knowledgeRootDir: options?.knowledgeRootDir,
      dataDir: options?.dataDir,
      attachmentsRootDir: options?.attachmentsRootDir,
      screenshotsRootDir: options?.screenshotsRootDir,
      issueThreadsRootDir: options?.issueThreadsRootDir,
      pipelineRunsRootDir: options?.pipelineRunsRootDir,
      manifestVersion: options?.manifestVersion,
      createDirectory: options?.createDirectory,
      maxRetries: options?.maxRetries,
      manifestMetadata: options?.manifestMetadata,
    };
    return this.submitOperation<"create-snapshot">(payload, options?.timeoutMs);
  }

  /**
   * Submit a snapshot bundle verification operation.
   */
  async verifySnapshot(
    snapshotPath: string,
    options?: { timeoutMs?: number; includePreview?: boolean },
  ): Promise<BackupOperationResultMap["verify-snapshot"]> {
    const payload: VerifySnapshotPayload = {
      type: "verify-snapshot",
      snapshotPath,
      includePreview: options?.includePreview,
    };
    return this.submitOperation<"verify-snapshot">(payload, options?.timeoutMs);
  }

  /**
   * Submit a snapshot restoration operation into a new inactive directory.
   */
  async restoreSnapshot(
    snapshotPath: string,
    destinationDir: string,
    options?: {
      dbFilename?: string;
      createDirectory?: boolean;
      requireCompleteProfile?: boolean;
      allowMissingHistoricalKnowledge?: boolean;
      rebindInternalReferences?: boolean;
      expectedContentIdentity?: string;
      timeoutMs?: number;
    },
  ): Promise<BackupOperationResultMap["restore-snapshot"]> {
    const payload: RestoreSnapshotPayload = {
      type: "restore-snapshot",
      snapshotPath,
      destinationDir,
      expectedContentIdentity: options?.expectedContentIdentity,
      dbFilename: options?.dbFilename,
      createDirectory: options?.createDirectory,
      requireCompleteProfile: options?.requireCompleteProfile,
      allowMissingHistoricalKnowledge: options?.allowMissingHistoricalKnowledge,
      rebindInternalReferences: options?.rebindInternalReferences,
    };
    return this.submitOperation<"restore-snapshot">(payload, options?.timeoutMs);
  }

  /**
   * Lists plausible auto-named snapshot child directories for this operation, in priority order.
   * Only non-hidden, non-pre-existing children are ever considered.
   */
  private listSnapshotCandidatePaths(handle: ActiveOperationHandle): string[] {
    const payload = handle.payload as CreateSnapshotPayload;
    if (payload.type !== "create-snapshot" || !payload.snapshotDestinationDir || payload.destinationPath) {
      return [];
    }
    const parentDir = path.resolve(payload.snapshotDestinationDir);
    const candidates = new Set<string>();
    if (handle.candidateChildPath) candidates.add(handle.candidateChildPath);
    if (handle.targetPath && handle.targetPath !== parentDir) {
      candidates.add(path.resolve(handle.targetPath));
    }
    if (handle.stagingDir) {
      const base = path.basename(handle.stagingDir);
      const match = base.match(/^\.([A-Za-z0-9._-]+)\.fo-snapshot\.([a-f0-9-]+)\.tmp$/);
      if (match && match[1]) candidates.add(path.join(parentDir, match[1]));
    }
    if (pathExistsOrSymlink(parentDir)) {
      try {
        for (const sub of readdirSync(parentDir)) {
          if (sub.startsWith(".")) continue;
          if (handle.preExistingParentEntries.has(sub)) continue;
          candidates.add(path.join(parentDir, sub));
        }
      } catch {
        /* ignore */
      }
    }
    return Array.from(candidates).filter((cand) => {
      const resolved = path.resolve(cand);
      if (resolved === parentDir || path.dirname(resolved) !== parentDir) return false;
      if (handle.preExistingParentEntries.has(path.basename(resolved))) return false;
      return true;
    });
  }

  /**
   * True only when a concrete artifact at the expected destination matches this
   * operation's identity: a matching receipt/result size for backups, or the
   * operation ID embedded in a snapshot manifest / restore recovery marker.
   */
  private publishedArtifactMatches(handle: ActiveOperationHandle): boolean {
    switch (handle.type) {
      case "backup-database": {
        const target = handle.initialTargetPath;
        if (!target || !pathExistsOrSymlink(target)) return false;
        try {
          const st = lstatSync(target);
          if (st.isSymbolicLink() || !st.isFile() || st.size <= 0) return false;
          const receipt = readBackupPublicationReceipt(handle.operationId);
          if (receipt && path.resolve(receipt.targetPath) === path.resolve(target)) {
            return st.size === receipt.bytes;
          }
          if (handle.result?.type === "backup-database") {
            return st.size === handle.result.bytes;
          }
          return false;
        } catch {
          return false;
        }
      }
      case "create-snapshot": {
        const payload = handle.payload as CreateSnapshotPayload;
        if (payload.destinationPath) {
          return (
            !!handle.initialTargetPath &&
            pathExistsOrSymlink(handle.initialTargetPath) &&
            verifySnapshotOperationIdentity(handle.initialTargetPath, handle.operationId)
          );
        }
        for (const cand of this.listSnapshotCandidatePaths(handle)) {
          if (verifySnapshotOperationIdentity(cand, handle.operationId)) {
            handle.candidateChildPath = cand;
            handle.targetPath = cand;
            return true;
          }
        }
        return false;
      }
      case "restore-snapshot": {
        return (
          !!handle.initialTargetPath &&
          pathExistsOrSymlink(handle.initialTargetPath) &&
          verifyRestoreOperationIdentity(handle.initialTargetPath, handle.operationId)
        );
      }
      default:
        // Read-only operations never create a destination artifact.
        return false;
    }
  }

  /**
   * Authoritative, local-only publication classification (R8B).
   *
   * `committed`     — publication of this operation is affirmatively established.
   * `unresolved`    — publication is possible (or the destination is present but
   *                   cannot be attributed to this operation); non-publication is
   *                   NOT established.
   * `not_published` — affirmative evidence that this operation did not publish:
   *                   no artifact at the destination, no receipt, no in-progress
   *                   publication marker, and no child that could still publish.
   */
  private classifyPublicationEvidence(handle: ActiveOperationHandle): PublicationEvidence {
    // 1. Never adopt a destination that existed before this operation started.
    //    Exclusive publication semantics make it affirmatively "not ours".
    if (handle.destinationExistedAtStart || handle.lastError?.code === "TARGET_EXISTS") {
      return "not_published";
    }

    if (handle.type === "verify-database" || handle.type === "verify-snapshot") {
      return "not_published";
    }

    const state = handle.state;
    if (state === "completed") return "committed";

    // 2. In-memory evidence from the worker protocol.
    if (handle.published) return "committed";
    if (handle.result !== undefined) {
      // A successful result proves publication was attempted; only a matching
      // artifact lets us call it committed. Missing/mismatched artifact is ambiguous.
      return this.publishedArtifactMatches(handle) ? "committed" : "unresolved";
    }

    // 3. Durable receipt evidence (backup database).
    if (handle.type === "backup-database") {
      const receipt = readBackupPublicationReceipt(handle.operationId);
      if (receipt) {
        const resolvedReceiptTarget = path.resolve(receipt.targetPath);
        if (resolvedReceiptTarget === path.resolve(handle.initialTargetPath)) {
          // The receipt proves this operation published. If the artifact is now
          // missing or truncated, publication still happened — it is unresolved,
          // never a successful cancellation.
          return this.publishedArtifactMatches(handle) ? "committed" : "unresolved";
        }
      }
    }

    // 4. Identity-bearing artifacts (snapshots and restores).
    if (this.publishedArtifactMatches(handle)) return "committed";

    // 5. Staging publication marker: a completed publication is affirmative
    //    evidence even when the receipt write did not happen; a rename may still
    //    be in flight while publishing.
    const stagingState = readStagingPublicationState(handle.stagingDir);
    const ownedStagingState = readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined);
    if (ownedStagingState === "completed") return "committed";
    if (stagingState === "publishing" || stagingState === "completed") return "unresolved";
    if (ownedStagingState === "publishing") return "unresolved";

    // 6. Any artifact at the destination we could not attribute to this operation
    //    is ambiguity, never proof of non-publication.
    if (handle.type === "backup-database") {
      if (handle.initialTargetPath && pathExistsOrSymlink(handle.initialTargetPath)) {
        return "unresolved";
      }
    } else if (handle.type === "create-snapshot") {
      const payload = handle.payload as CreateSnapshotPayload;
      if (payload.destinationPath) {
        if (handle.initialTargetPath && pathExistsOrSymlink(handle.initialTargetPath)) {
          return "unresolved";
        }
      } else if (
        this.listSnapshotCandidatePaths(handle).some((cand) => pathExistsOrSymlink(cand))
      ) {
        return "unresolved";
      }
    } else if (handle.type === "restore-snapshot") {
      if (handle.initialTargetPath && pathExistsOrSymlink(handle.initialTargetPath)) {
        return "unresolved";
      }
    }

    // 7. Only a child that actually started and has genuinely exited can no
    //    longer publish. A worker that never spawned cannot have published.
    if (!handle.started && !handle.published) return "not_published";
    if (state === "publishing") return "unresolved";
    if (handle.proc !== null && !handle.exited) return "unresolved";
    if (state === "queued") return "not_published";
    if (!handle.exited && !handle.isSettled) return "unresolved";

    return "not_published";
  }

  /**
   * Waits for a handle's supervision promise until `deadline` (monotonic ms).
   * Returns true when the completion promise settled within the budget.
   */
  private async waitForCompletionUntil(
    handle: ActiveOperationHandle,
    deadline: number,
  ): Promise<boolean> {
    if (!handle.completionPromise) return false;
    const remaining = Math.max(0, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const settled = await Promise.race([
        handle.completionPromise.then(() => true).catch(() => true),
        timeout,
      ]);
      return settled;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Request cancellation of a queued or running operation with authoritative outcome classification.
   *
   * Contract (R8B):
   * - `cancelled: true` is only returned when non-publication is affirmatively established
   *   by filesystem evidence, never merely because the worker failed, was killed, timed out,
   *   reported INDETERMINATE, or left no receipt.
   * - `cancel()` therefore returns false for `publication_committed` and `publication_unresolved`.
   * - A filesystem check followed by SIGTERM is not an atomic barrier: we wait for the child to
   *   actually exit (bounded) and re-inspect the destination afterwards.
   */
  async requestCancellation(
    operationId: string,
    options?: { force?: boolean },
  ): Promise<CancellationResult> {
    const recent = this.recentOperations.get(operationId);
    if (recent) {
      return this.classifyFinishedCancellation(recent, "Operation already finished");
    }

    const handle = this.activeOperations.get(operationId);
    if (!handle) {
      return {
        outcome: "not_found",
        cancelled: false,
        accepted: false,
        operationId,
        details: { reason: "Operation not found" },
      };
    }

    // Terminal states cannot be cancelled; never redefine an already-delivered outcome.
    if (handle.state === "completed") {
      return {
        outcome: "already_completed",
        cancelled: false,
        accepted: false,
        operationId,
        details: { state: "completed", targetPath: handle.targetPath },
      };
    }
    if (handle.isSettled || handle.finalized || handle.state === "failed" || handle.state === "cancelled") {
      return this.classifySettledCancellation(handle);
    }

    // Inspect durable publication state before taking any action.
    const evidenceBefore = this.classifyPublicationEvidence(handle);
    if (evidenceBefore === "committed") {
      return {
        outcome: "publication_committed",
        cancelled: false,
        accepted: false,
        operationId,
        details: { state: handle.state, targetPath: handle.targetPath, published: true },
      };
    }

    // If queued, cancel immediately.
    if (handle.state === "queued") {
      const idx = this.queue.indexOf(handle);
      if (idx !== -1) this.queue.splice(idx, 1);

      this.releaseTarget(handle);
      const cancelErr = new BackupRunnerError("Operation was cancelled before execution", "CANCELLED", {
        operationId,
        state: "cancelled",
      });
      this.settleOperation(handle, cancelErr, "cancelled");

      return {
        outcome: "cancelled_before_execution",
        cancelled: true,
        accepted: true,
        operationId,
        details: { state: "cancelled" },
      };
    }

    // Operation is running in a child process: request cooperative cancellation.
    handle.isCancelled = true;

    if (handle.proc && !handle.exited) {
      if (options?.force) {
        this.terminateChild(handle, "SIGTERM", true);
      } else {
        const cancelMsg: ParentToWorkerMessage = {
          type: "cancel",
          operationId,
        };
        writeToChildStdin(handle.proc, JSON.stringify(cancelMsg) + "\n");

        setTimeout(() => {
          if (handle.proc && !handle.exited) {
            this.terminateChild(handle, "SIGTERM", true);
          }
        }, 1000).unref?.();
      }
    }

    // Bounded wait for the child to genuinely exit (not merely be signalled).
    const deadline = performance.now() + this.cancellationGraceMs();
    await this.waitForCompletionUntil(handle, deadline);

    // A terminal outcome delivered during the wait must never be redefined.
    const stateAfterWait = handle.state as BackupOperationState;
    if (handle.isSettled || stateAfterWait === "completed") {
      if (stateAfterWait === "completed") {
        return {
          outcome: "already_completed",
          cancelled: false,
          accepted: false,
          operationId,
          details: { state: "completed", targetPath: handle.targetPath },
        };
      }
      return this.classifySettledCancellation(handle);
    }

    const evidenceAfter = this.classifyPublicationEvidence(handle);

    if (evidenceAfter === "committed") {
      return {
        outcome: "publication_committed",
        cancelled: false,
        accepted: false,
        operationId,
        details: { state: handle.state, targetPath: handle.targetPath, published: true },
      };
    }

    if (evidenceAfter === "unresolved") {
      return {
        outcome: "publication_unresolved",
        cancelled: false,
        accepted: false,
        operationId,
        details: {
          state: handle.state,
          targetPath: handle.targetPath,
          reason: "Publication is possible but could not be reconciled",
        },
      };
    }

    // If the child is still alive, it may still publish: this is not provable non-publication.
    if (handle.proc !== null && !handle.exited) {
      return {
        outcome: "publication_unresolved",
        cancelled: false,
        accepted: false,
        operationId,
        details: {
          state: handle.state,
          targetPath: handle.targetPath,
          reason: "Worker is still running after cancellation request",
        },
      };
    }

    // Affirmative non-publication: settle the operation and its stored history consistently.
    const cancelErr = new BackupRunnerError("Operation was cancelled before publication", "CANCELLED", {
      operationId,
      state: "cancelled",
      details: { targetPath: handle.targetPath },
    });
    this.cleanWorkerStaging(handle);
    this.settleOperation(handle, cancelErr, "cancelled");

    return {
      outcome: "cancelled_before_publication",
      cancelled: true,
      accepted: true,
      operationId,
      details: { state: "cancelled", targetPath: handle.targetPath },
    };
  }

  /**
   * Cancellation result for an operation already stored in public history. This
   * never re-accepts a finished operation and never upgrades an unresolved or
   * committed publication into a successful cancellation.
   */
  private classifyFinishedCancellation(
    recent: BackupOperationStatus,
    reason: string,
  ): CancellationResult {
    const code = recent.error?.code;
    const base = {
      cancelled: false,
      accepted: false,
      operationId: recent.operationId,
      details: { state: recent.state, targetPath: recent.targetPath, reason },
    } as const;
    if (recent.state === "completed") return { ...base, outcome: "already_completed" };
    if (code === "PUBLISHED_UNCONFIRMED") {
      return { ...base, outcome: "publication_committed", details: { ...base.details, published: true } };
    }
    if (code === "INDETERMINATE") {
      return { ...base, outcome: "publication_unresolved" };
    }
    if (recent.state === "cancelled" || code === "CANCELLED") {
      return { ...base, outcome: "cancelled_before_publication" };
    }
    if (recent.state === "failed") {
      return { ...base, outcome: "already_failed" };
    }
    return { ...base, outcome: "already_failed" };
  }

  /**
   * Cancellation result for an operation whose terminal outcome has already been
   * delivered while the handle is still tracked. The classification follows the
   * stored outcome and durable evidence; it never upgrades a failure into a
   * successful cancellation.
   */
  private classifySettledCancellation(handle: ActiveOperationHandle): CancellationResult {
    const operationId = handle.operationId;
    const code = handle.lastError?.code;
    const evidence = this.classifyPublicationEvidence(handle);
    const base = {
      cancelled: false,
      accepted: false,
      operationId,
      details: { state: handle.state, targetPath: handle.targetPath },
    } as const;

    if (handle.state === "completed") {
      return { ...base, outcome: "already_completed" };
    }
    if (code === "PUBLISHED_UNCONFIRMED" || evidence === "committed") {
      return { ...base, outcome: "publication_committed", details: { ...base.details, published: true } };
    }
    if (code === "INDETERMINATE" || evidence === "unresolved") {
      return { ...base, outcome: "publication_unresolved" };
    }
    if (handle.state === "cancelled" || code === "CANCELLED") {
      return {
        ...base,
        outcome: "cancelled_before_publication",
        cancelled: true,
        accepted: true,
      };
    }
    return { ...base, outcome: "already_failed" };
  }

  /** Bounded cancellation settlement budget (never unbounded, never longer than disposal). */
  private cancellationGraceMs(): number {
    return Math.max(500, Math.min(2000, this.disposeGraceMs));
  }

  /**
   * Request cancellation of a queued or running operation.
   * Returns true only when cancellation is accepted before publication.
   */
  async cancel(operationId: string, options?: { force?: boolean }): Promise<boolean> {
    const res = await this.requestCancellation(operationId, options);
    return res.cancelled;
  }

  /**
   * Get the current status of an operation.
   */
  getOperationStatus(operationId: string): BackupOperationStatus | null {
    const handle = this.activeOperations.get(operationId);
    if (handle) return this.toPublicStatus(handle);
    return this.recentOperations.get(operationId) ?? null;
  }

  /**
   * List all tracked operations (active or recently settled).
   */
  listOperations(): BackupOperationStatus[] {
    if (this.isDisposed) return [];
    const active = Array.from(this.activeOperations.values()).map((h) => this.toPublicStatus(h));
    const recent = Array.from(this.recentOperations.values());
    return [...active, ...recent];
  }

  /**
   * Dispose the runner, terminating all active child processes, waiting for exit,
   * reconciling publication outcomes, and rejecting queued operations.
   */
  /**
   * Dispose the runner.
   *
   * R8B: one authoritative disposal state machine with a SINGLE monotonic deadline
   * that covers queue draining, worker termination, IPC draining, verification
   * termination, reconciliation and final settlement. The deadline is never reset
   * for additional verification attempts, and no duplicate isolated verification
   * child is spawned after the in-flight one is terminated.
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.runDisposal();
    }
    return this.disposePromise;
  }

  private async runDisposal(): Promise<void> {
    this.isDisposed = true;
    const startedAt = performance.now();
    const deadline = startedAt + this.disposeGraceMs;
    // Reserve a small slice of the single budget for hard-kill reaping so the
    // whole call still finishes inside the grace period.
    const reapReserve = Math.min(150, Math.max(20, Math.floor(this.disposeGraceMs / 10)));

    // 1. Drain and cancel all queued operations immediately.
    for (const handle of [...this.queue]) {
      const idx = this.queue.indexOf(handle);
      if (idx !== -1) this.queue.splice(idx, 1);
      this.releaseTarget(handle);
      const cancelErr = new BackupRunnerError(
        "Operation cancelled before execution: runner was disposed",
        "CANCELLED",
        { operationId: handle.operationId, state: "cancelled" },
      );
      this.settleOperation(handle, cancelErr, "cancelled");
    }
    this.queue.length = 0;

    const activeHandles = Array.from(this.activeOperations.values());

    // 2. Terminate in-flight reconciliation verification children immediately.
    //    Their verdict is not required for a truthful settlement, and allowing them
    //    to run (or spawning a replacement) is what previously blew the deadline.
    await this.killVerificationChildren(Math.min(250, Math.max(0, deadline - performance.now())));

    // 3. Initiate bounded termination of every active worker.
    for (const handle of activeHandles) {
      handle.isDisposing = true;
      if (handle.timeoutTimer) {
        clearTimeout(handle.timeoutTimer);
        handle.timeoutTimer = null;
      }
      if (!handle.proc || handle.exited) continue;
      this.terminateChild(handle, "SIGTERM", false);
      const procRef = handle.proc;
      const killDelay = Math.min(800, Math.max(50, Math.floor(this.disposeGraceMs / 2)));
      setTimeout(() => {
        if (procRef && !handle.exited) {
          try {
            procRef.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, killDelay).unref?.();
    }

    // 4. One end-to-end wait for all supervisions, bounded by the SAME deadline
    //    (minus the reaping reserve).
    const completions = activeHandles
      .map((handle) => handle.completionPromise)
      .filter((p): p is Promise<void> => Boolean(p));
    if (completions.length > 0) {
      const remaining = Math.max(0, deadline - reapReserve - performance.now());
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        await Promise.race([
          Promise.all(completions.map((p) => p.catch(() => {}))).then(() => {}),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // 5. Terminate anything still alive (workers and verification children) and reap briefly.
    //    Verification children are intentionally terminated here; that must never be
    //    translated into a definitive artifact IO_ERROR (see handleWorkerCompletion).
    await this.terminateRemainingChildren(activeHandles, deadline);

    // 6. Single authoritative settlement for anything still unsettled. Reconciliation is
    //    durable-evidence-only: no new verification child is started after the deadline.
    for (const handle of activeHandles) {
      this.releaseTarget(handle);
      if (handle.finalized) continue;
      handle.isDisposing = true;

      if (handle.isSettled) {
        // The terminal outcome already delivered to the caller is authoritative;
        // store it without changing it.
        this.finalizeOperation(handle);
        continue;
      }

      this.settleReconciledOutcome(handle, this.durableReconciliation(handle), {
        cause: handle.lastError,
        exitCode: -1,
        phase: "disposed",
      });
    }

    this.runningCount = 0;
  }

  /**
   * SIGKILLs in-flight isolated verification children and waits (bounded) for them to
   * exit. Used only during disposal; the verdict of a terminated verification child is
   * reported as "verification interrupted", never as an artifact IO_ERROR.
   */
  private async killVerificationChildren(waitMs: number): Promise<void> {
    const procs = Array.from(this.activeVerificationProcs);
    this.activeVerificationProcs.clear();
    for (const proc of procs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (procs.length === 0 || waitMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([
        Promise.all(procs.map((p) => p.exited.catch(() => {}))).then(() => {}),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * SIGKILLs surviving workers and verification children and reaps them within the
   * remaining disposal budget (never past it).
   */
  private async terminateRemainingChildren(
    handles: ActiveOperationHandle[],
    deadline: number,
  ): Promise<void> {
    const procs: Array<ReturnType<typeof Bun.spawn>> = [];
    for (const handle of handles) {
      if (!handle.proc || handle.exited) continue;
      try {
        handle.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      procs.push(handle.proc);
    }
    for (const vProc of Array.from(this.activeVerificationProcs)) {
      try {
        vProc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      procs.push(vProc);
    }
    this.activeVerificationProcs.clear();

    const remaining = Math.max(0, deadline - performance.now());
    if (procs.length === 0 || remaining <= 0) return;
    const reapBudget = Math.min(250, remaining);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, reapBudget);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([
        Promise.all(procs.map((p) => p.exited.catch(() => {}))).then(() => {}),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Controlled internal storage lifecycle entrypoint to conservatively recover stale
   * temporary artifacts (temp files, staging directories, orphaned worker cwds, stale receipts)
   * in validated storage and temporary roots.
   */
  recoverStaleTemporaryArtifacts(storageParentDir?: string): {
    tempFiles: PublicationTempCleanupResult;
    staging: { cleaned: string[]; preserved: string[]; errors: string[] };
    workerCwds: { cleaned: string[]; preserved: string[]; errors: string[] };
    receipts: { cleaned: string[]; preserved: string[] };
  } {
    const stagingCleaned: string[] = [];
    const stagingPreserved: string[] = [];
    const stagingErrors: string[] = [];

    let tempFileResult: PublicationTempCleanupResult = { cleaned: [], preserved: [], errors: [] };

    if (storageParentDir && pathExistsOrSymlink(storageParentDir)) {
      const resolved = path.resolve(storageParentDir);
      try {
        tempFileResult = recoverStalePublicationTempFiles(resolved);
      } catch {
        /* best effort */
      }

      try {
        const coreRes = cleanSubsystemStaging(resolved, "backup-core", CORE_STAGING_SCAN_RE);
        stagingCleaned.push(...coreRes.cleaned);
        stagingErrors.push(...coreRes.errors);
      } catch {
        /* best effort */
      }

      try {
        const snapRes = cleanIncompleteBackupSnapshots(resolved);
        stagingCleaned.push(...snapRes.cleaned);
        stagingErrors.push(...snapRes.errors);
      } catch {
        /* best effort */
      }

      try {
        const restRes = cleanIncompleteRestoreStaging(resolved);
        stagingCleaned.push(...restRes.cleaned);
        stagingErrors.push(...restRes.errors);
      } catch {
        /* best effort */
      }
    }

    const cwdsResult = cleanOrphanWorkerCwds(300_000);
    const receiptsResult = cleanStalePublicationReceipts(3600_000, { preserveUnreconciledPublished: true });

    return {
      tempFiles: tempFileResult,
      staging: {
        cleaned: stagingCleaned,
        preserved: stagingPreserved,
        errors: stagingErrors,
      },
      workerCwds: cwdsResult,
      receipts: receiptsResult,
    };
  }

  /**
   * Controlled internal storage lifecycle entrypoint to conservatively recover stale
   * publication temporary files in an explicitly validated storage directory.
   */
  recoverStalePublicationTempFiles(storageParentDir: string): PublicationTempCleanupResult {
    const resolved = path.resolve(storageParentDir);
    return recoverStalePublicationTempFiles(resolved);
  }

  // ── Internal Lifecycle & Queue Management ──────────────────────────────────

  private normalizePayloadPaths(payload: BackupOperationPayload, baseCwd: string = process.cwd()): BackupOperationPayload {
    if (!payload || typeof payload !== "object") return payload;
    const resolveOpt = (p: string | undefined): string | undefined => (typeof p === "string" ? path.resolve(baseCwd, p) : p);
    const resolveReq = (p: string): string => (typeof p === "string" ? path.resolve(baseCwd, p) : p);

    switch (payload.type) {
      case "backup-database": {
        return {
          ...payload,
          dbPath: resolveReq(payload.dbPath),
          destinationPath: resolveReq(payload.destinationPath),
        };
      }
      case "verify-database": {
        return {
          ...payload,
          filePath: resolveReq(payload.filePath),
        };
      }
      case "create-snapshot": {
        return {
          ...payload,
          dbPath: resolveReq(payload.dbPath),
          destinationPath: resolveOpt(payload.destinationPath),
          snapshotDestinationDir: resolveOpt(payload.snapshotDestinationDir),
          dataDir: resolveOpt(payload.dataDir),
          knowledgeRootDir: resolveOpt(payload.knowledgeRootDir),
          attachmentsRootDir: resolveOpt(payload.attachmentsRootDir),
          screenshotsRootDir: resolveOpt(payload.screenshotsRootDir),
          issueThreadsRootDir: resolveOpt(payload.issueThreadsRootDir),
          pipelineRunsRootDir: resolveOpt(payload.pipelineRunsRootDir),
        };
      }
      case "verify-snapshot": {
        return {
          ...payload,
          snapshotPath: resolveReq(payload.snapshotPath),
        };
      }
      case "restore-snapshot": {
        return {
          ...payload,
          snapshotPath: resolveReq(payload.snapshotPath),
          destinationDir: resolveReq(payload.destinationDir),
        };
      }
      default:
        return payload;
    }
  }

  private async submitOperation<T extends BackupOperationType>(
    rawPayload: BackupOperationPayload,
    timeoutMsOverride?: number,
  ): Promise<BackupOperationResultMap[T]> {
    if (this.isDisposed) {
      throw new BackupRunnerError("BackupProcessRunner has been disposed", "OPERATION_NOT_FOUND");
    }

    // Normalize relative paths against parent submission cwd before any existence or ownership checks
    const payload = this.normalizePayloadPaths(rawPayload, process.cwd());

    // Revalidate normalized payload including source profile layout relationships
    this.validateRequestPayload(payload);

    const targetPath = this.resolveTargetPath(payload);
    const autoNamed = isAutoNamedSnapshotPayload(payload);
    const destinationExistedAtStart = autoNamed
      ? false
      : Boolean(targetPath && pathExistsOrSymlink(targetPath));
    const preExistingParentEntries =
      autoNamed && payload.snapshotDestinationDir
        ? listDirectoryEntryNames(payload.snapshotDestinationDir)
        : new Set<string>();

    // Active profile protection for restore operations (fail-closed in parent using normalized path)
    if (payload.type === "restore-snapshot") {
      try {
        checkNotActiveDataDir(targetPath);
      } catch (err) {
        throw new BackupRunnerError(
          `Restore destination cannot target active profile or production data directory: ${targetPath}`,
          "ACTIVE_PROFILE_PROTECTED",
          { cause: err },
        );
      }
    }

    // Destination collision prevention
    if (targetPath && this.activeTargets.has(targetPath)) {
      throw new BackupRunnerError(
        `An operation targeting ${targetPath} is already in progress`,
        "DESTINATION_COLLISION",
      );
    }

    if (targetPath) {
      this.activeTargets.add(targetPath);
    }

    const operationId = randomUUID();
    const timeoutMs =
      timeoutMsOverride !== undefined
        ? Math.max(0, timeoutMsOverride)
        : this.defaultTimeoutMs;

    let resolvePromise!: (val: unknown) => void;
    let rejectPromise!: (err: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    let settled = false;
    const safeResolve = (val: unknown) => {
      if (settled) return;
      settled = true;
      handle.isSettled = true;
      resolvePromise(val);
    };
    const safeReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      handle.isSettled = true;
      rejectPromise(err);
    };

    const handle: ActiveOperationHandle = {
      operationId,
      type: payload.type,
      payload,
      targetPath,
      initialTargetPath: targetPath,
      reservationKey: targetPath,
      reservationReleased: false,
      preExistingParentEntries,
      state: "queued",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timeoutMs,
      timeoutTimer: null,
      proc: null,
      isCancelled: false,
      isTimedOut: false,
      published: false,
      destinationExistedAtStart,
      resolve: safeResolve,
      reject: safeReject,
      promise,
      isSettled: false,
    };

    this.activeOperations.set(operationId, handle);
    this.queue.push(handle);

    this.notifyState(handle);
    this.drainQueue();

    return promise as Promise<BackupOperationResultMap[T]>;
  }

  private validateRequestPayload(payload: BackupOperationPayload): void {
    if (!payload || typeof payload !== "object") {
      throw new BackupRunnerError("Invalid operation request payload: not an object", "INVALID_PATH");
    }
    if (!VALID_OPERATION_TYPES.has(payload.type)) {
      throw new BackupRunnerError(`Unsupported operation type: ${(payload as { type: string }).type}`, "INVALID_PATH");
    }

    const checkString = (val: unknown, field: string): string => {
      if (typeof val !== "string" || val.trim().length === 0 || val.includes("\0")) {
        throw new BackupRunnerError(`Invalid ${field}: must be a non-empty string without null bytes`, "INVALID_PATH");
      }
      return val;
    };

    switch (payload.type) {
      case "backup-database": {
        checkString(payload.dbPath, "dbPath");
        checkString(payload.destinationPath, "destinationPath");
        const auxCheck = isSqliteAuxiliaryOrSamePath(payload.dbPath, payload.destinationPath);
        if (auxCheck.isSame) {
          throw new BackupRunnerError(
            `Destination path cannot be the same as the source database: ${payload.destinationPath}`,
            "INVALID_DESTINATION",
          );
        }
        if (auxCheck.isAuxiliary) {
          throw new BackupRunnerError(
            `Destination path cannot target an SQLite auxiliary file of the source database (${auxCheck.auxiliaryType}): ${payload.destinationPath}`,
            "SQLITE_AUXILIARY_FILE",
          );
        }
        break;
      }
      case "verify-database":
        checkString(payload.filePath, "filePath");
        break;
      case "create-snapshot":
        checkString(payload.dbPath, "dbPath");
        if (!payload.snapshotDestinationDir && !payload.destinationPath) {
          throw new BackupRunnerError("Must provide either snapshotDestinationDir or destinationPath", "INVALID_PATH");
        }
        if (payload.snapshotDestinationDir) checkString(payload.snapshotDestinationDir, "snapshotDestinationDir");
        if (payload.destinationPath) checkString(payload.destinationPath, "destinationPath");
        try {
          validateSourceProfileLayout({
            dbFilename: payload.dbPath,
            dataDir: payload.dataDir,
            knowledgeRootDir: payload.knowledgeRootDir,
            attachmentsRootDir: payload.attachmentsRootDir,
            screenshotsRootDir: payload.screenshotsRootDir,
            issueThreadsRootDir: payload.issueThreadsRootDir,
            pipelineRunsRootDir: payload.pipelineRunsRootDir,
          });
        } catch (err) {
          if (err instanceof BackupManagerError) {
            throw new BackupRunnerError(err.message, err.code, {
              subsystem: "backup-manager",
              cause: err,
            });
          }
          throw err;
        }
        break;
      case "verify-snapshot":
        checkString(payload.snapshotPath, "snapshotPath");
        break;
      case "restore-snapshot":
        checkString(payload.snapshotPath, "snapshotPath");
        checkString(payload.destinationDir, "destinationDir");
        if (payload.dbFilename !== undefined) {
          checkString(payload.dbFilename, "dbFilename");
          if (payload.dbFilename.includes("/") || payload.dbFilename.includes("\\") || payload.dbFilename.includes("..")) {
            throw new BackupRunnerError("dbFilename must be a bare filename without path separators", "INVALID_PATH");
          }
        }
        break;
    }
  }

  private drainQueue(): void {
    if (this.isDisposed) return;

    while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
      const handle = this.queue.shift()!;
      this.runningCount++;
      this.spawnWorker(handle).catch((err) => {
        this.failOperation(handle, err);
      });
    }
  }

  private async spawnWorker(handle: ActiveOperationHandle): Promise<void> {
    if (isAutoNamedSnapshotPayload(handle.payload) && handle.payload.snapshotDestinationDir) {
      for (const name of listDirectoryEntryNames(handle.payload.snapshotDestinationDir)) {
        handle.preExistingParentEntries.add(name);
      }
    } else if (!handle.destinationExistedAtStart && handle.initialTargetPath) {
      if (pathExistsOrSymlink(handle.initialTargetPath)) {
        handle.destinationExistedAtStart = true;
      }
    }

    this.updateState(handle, "running");

    if (handle.timeoutMs > 0) {
      handle.timeoutTimer = setTimeout(() => {
        this.handleTimeout(handle);
      }, handle.timeoutMs);
      (handle.timeoutTimer as { unref?: () => void }).unref?.();
    }

    // Recover stale temporary artifacts conservatively before starting an operation touching an explicitly validated storage parent
    try {
      let storageParent: string | null = null;
      if (handle.type === "backup-database") {
        storageParent = path.dirname(handle.targetPath);
      } else if (handle.type === "create-snapshot") {
        const payload = handle.payload as CreateSnapshotPayload;
        storageParent = payload.snapshotDestinationDir ?? (payload.destinationPath ? path.dirname(payload.destinationPath) : null);
      } else if (handle.type === "restore-snapshot") {
        const payload = handle.payload as RestoreSnapshotPayload;
        storageParent = path.dirname(payload.destinationDir);
      }
      if (storageParent && pathExistsOrSymlink(storageParent)) {
        this.recoverStaleTemporaryArtifacts(storageParent);
      } else {
        this.recoverStaleTemporaryArtifacts();
      }
    } catch {
      /* conservative recovery must never fail active operation start */
    }

    // Establish private 0o700 working directory for the worker process
    let workerCwd: string;
    try {
      workerCwd = mkdtempSync(path.join(tmpdir(), "fo-worker-cwd-"));
      chmodSync(workerCwd, 0o700);
      handle.workerCwd = workerCwd;
      try {
        const lockPath = path.join(workerCwd, ".fo-worker.lock");
        const lockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
        tryAcquireFlock(lockFd);
        handle.workerCwdLockFd = lockFd;
        const metaPath = path.join(workerCwd, ".fo-worker.json");
        writeFileSync(
          metaPath,
          JSON.stringify({
            operationId: handle.operationId,
            createdAt: Date.now(),
            subsystem: "backup-runner",
          }),
          { mode: 0o600 },
        );
      } catch {
        /* best effort */
      }
    } catch {
      workerCwd = tmpdir();
    }

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.bunExecutable, "--no-env-file", this.workerScriptPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: workerCwd,
        env: buildWorkerEnvironment(),
      });
    } catch (spawnErr) {
      if (handle.workerCwdLockFd !== undefined && handle.workerCwdLockFd !== null) {
        try {
          releaseFlock(handle.workerCwdLockFd);
        } catch {}
        try {
          closeSync(handle.workerCwdLockFd);
        } catch {}
        handle.workerCwdLockFd = null;
      }
      if (handle.workerCwd) {
        try {
          rmSync(handle.workerCwd, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        handle.workerCwd = null;
      }
      throw new BackupRunnerError(
        `Failed to spawn isolated backup worker: ${(spawnErr as Error).message}`,
        "WORKER_SPAWN_FAILED",
        { operationId: handle.operationId, cause: spawnErr },
      );
    }

    handle.proc = proc;
    handle.pid = proc.pid;
    handle.started = true;
    this.notifyState(handle);

    // Stream and drain pipes concurrently
    const stdoutPromise = this.pipeWorkerOutput(handle, proc);
    const stderrPromise = this.drainWorkerStderr(handle, proc);
    const exitPromise = proc.exited;

    // Send the start request immediately
    const startMsg: ParentToWorkerMessage = {
      type: "start",
      operation: {
        operationId: handle.operationId,
        payload: handle.payload,
      },
    };

    if (!proc.stdin || typeof proc.stdin === "number") {
      throw new BackupRunnerError(
        "Worker process stdin is not a writable stream",
        "IPC_ERROR",
        { operationId: handle.operationId },
      );
    }

    try {
      proc.stdin.write(JSON.stringify(startMsg) + "\n");
      proc.stdin.flush();
    } catch (writeErr) {
      throw new BackupRunnerError(
        `Failed to transmit start command to worker: ${(writeErr as Error).message}`,
        "IPC_ERROR",
        { operationId: handle.operationId, cause: writeErr },
      );
    }

    // Supervise process completion: all pipes drained AND child exited
    const completion = Promise.all([stdoutPromise, stderrPromise, exitPromise])
      .then(([, , exitCode]) => {
        return this.handleWorkerCompletion(handle, exitCode);
      })
      .catch((err) => {
        this.failOperation(handle, err);
      });
    handle.completionPromise = completion;
  }

  private async pipeWorkerOutput(
    handle: ActiveOperationHandle,
    proc: ReturnType<typeof Bun.spawn>,
  ): Promise<void> {
    if (!proc.stdout || typeof proc.stdout === "number") return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        if (buffer.length > MAX_IPC_BUFFER_BYTES) {
          handle.lastError = new BackupRunnerError(
            `Worker output exceeded maximum IPC buffer limit (${MAX_IPC_BUFFER_BYTES} bytes)`,
            "IPC_ERROR",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;

          if (line.length > MAX_IPC_FRAME_BYTES) {
            handle.lastError = new BackupRunnerError(
              `Worker output frame exceeded maximum allowed size (${MAX_IPC_FRAME_BYTES} bytes)`,
              "IPC_ERROR",
              { operationId: handle.operationId },
            );
            this.terminateChild(handle, "SIGKILL", true);
            return;
          }

          this.handleWorkerMessage(handle, line);
        }
      }

      // If stream ended with unconsumed data that didn't terminate in a newline, reject as truncated message
      if (buffer.trim().length > 0) {
        handle.lastError = new BackupRunnerError(
          `Truncated IPC message from worker (stream closed before newline): ${buffer.trim().slice(0, 100)}`,
          "IPC_ERROR",
          { operationId: handle.operationId },
        );
        this.terminateChild(handle, "SIGKILL", true);
      }
    } catch (readErr) {
      if (!handle.lastError) {
        handle.lastError = new BackupRunnerError(
          `Error reading worker stdout: ${(readErr as Error).message}`,
          "IPC_ERROR",
          { operationId: handle.operationId, cause: readErr },
        );
      }
    }
  }

  private async drainWorkerStderr(
    handle: ActiveOperationHandle,
    proc: ReturnType<typeof Bun.spawn>,
  ): Promise<void> {
    if (!proc.stderr || typeof proc.stderr === "number") return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        if (accumulated.length > MAX_STDERR_TAIL_BYTES) {
          accumulated = accumulated.slice(-MAX_STDERR_TAIL_BYTES);
        }
      }
      handle.stderrTail = sanitizeDiagnostics(accumulated.trim());
    } catch {
      /* process closed */
    }
  }

  private handleWorkerMessage(handle: ActiveOperationHandle, line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      handle.lastError = new BackupRunnerError(
        `Malformed IPC JSON message from worker: ${line.slice(0, 100)}`,
        "IPC_ERROR",
        { operationId: handle.operationId },
      );
      this.terminateChild(handle, "SIGKILL", true);
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      handle.lastError = new BackupRunnerError(
        "Invalid IPC payload: message must be a JSON object",
        "IPC_ERROR",
        { operationId: handle.operationId },
      );
      this.terminateChild(handle, "SIGKILL", true);
      return;
    }

    const m = msg as Record<string, unknown>;

    // Strict operation ID validation
    if (typeof m.operationId !== "string" || m.operationId !== handle.operationId) {
      handle.lastError = new BackupRunnerError(
        `Worker message operation ID mismatch: expected ${handle.operationId}, got ${String(m.operationId)}`,
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId },
      );
      this.terminateChild(handle, "SIGKILL", true);
      return;
    }

    // Message discriminant validation
    if (m.type !== "state" && m.type !== "published" && m.type !== "result" && m.type !== "error") {
      handle.lastError = new BackupRunnerError(
        `Unsupported worker message type: ${String(m.type)}`,
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId },
      );
      this.terminateChild(handle, "SIGKILL", true);
      return;
    }

    switch (m.type) {
      case "state": {
        // State message after terminal result or error is invalid
        if (handle.result !== undefined || handle.lastError !== undefined) {
          handle.lastError = new BackupRunnerError(
            "Worker emitted state update after terminal outcome",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        const state = m.state as string;

        // Workers are strictly prohibited from emitting "completed"
        if (state === "completed") {
          handle.lastError = new BackupRunnerError(
            "Worker emitted premature completed state; parent is the sole authority for completion",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        if (state !== "running" && state !== "verifying" && state !== "publishing") {
          handle.lastError = new BackupRunnerError(
            `Invalid worker state reported: ${state}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        if (handle.state === "publishing" && (state === "running" || state === "verifying")) {
          handle.lastError = new BackupRunnerError(
            `Invalid backwards state transition from publishing to ${state}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        if (typeof m.stagingDir === "string" && m.stagingDir.length > 0) {
          const resolvedStaging = path.resolve(m.stagingDir);
          const stagingBase = path.basename(resolvedStaging);
          const stagingParent = path.dirname(resolvedStaging);

          if (handle.type === "backup-database") {
            const expectedParent = path.dirname(handle.initialTargetPath);
            const expectedTargetBase = path.basename(handle.initialTargetPath);
            const match = stagingBase.match(/^\.(.+)\.fo-core\.([a-f0-9-]{36})\.tmp$/i);
            if (stagingParent !== expectedParent || !match || match[1] !== expectedTargetBase) {
              handle.lastError = new BackupRunnerError(
                `Worker reported invalid or forged stagingDir (${m.stagingDir}) for target ${handle.initialTargetPath}`,
                "INVALID_WORKER_RESPONSE",
                { operationId: handle.operationId },
              );
              this.terminateChild(handle, "SIGKILL", true);
              return;
            }
            handle.stagingDir = resolvedStaging;
          } else if (handle.type === "restore-snapshot") {
            const expectedParent = path.dirname(handle.initialTargetPath);
            const expectedTargetBase = path.basename(handle.initialTargetPath);
            const match = stagingBase.match(/^\.(.+)\.(?:fo-restore|restore)\.([a-f0-9-]{36})\.tmp$/i);
            if (stagingParent !== expectedParent || !match || match[1] !== expectedTargetBase) {
              handle.lastError = new BackupRunnerError(
                `Worker reported invalid or forged stagingDir (${m.stagingDir}) for restore target ${handle.initialTargetPath}`,
                "INVALID_WORKER_RESPONSE",
                { operationId: handle.operationId },
              );
              this.terminateChild(handle, "SIGKILL", true);
              return;
            }
            handle.stagingDir = resolvedStaging;
          } else if (handle.type === "create-snapshot") {
            const payload = handle.payload as CreateSnapshotPayload;
            const match = stagingBase.match(/^\.(.+)\.fo-snapshot\.([a-f0-9-]{36})\.tmp$/i);
            if (payload.destinationPath) {
              const expectedParent = path.dirname(handle.initialTargetPath);
              const expectedTargetBase = path.basename(handle.initialTargetPath);
              if (stagingParent !== expectedParent || !match || match[1] !== expectedTargetBase) {
                handle.lastError = new BackupRunnerError(
                  `Worker reported invalid or forged stagingDir (${m.stagingDir}) for explicit snapshot destination ${handle.initialTargetPath}`,
                  "INVALID_WORKER_RESPONSE",
                  { operationId: handle.operationId },
                );
                this.terminateChild(handle, "SIGKILL", true);
                return;
              }
              handle.stagingDir = resolvedStaging;
            } else if (payload.snapshotDestinationDir) {
              const expectedParent = path.resolve(payload.snapshotDestinationDir);
              const childName = match?.[1] ?? "";
              if (
                stagingParent !== expectedParent ||
                !match ||
                !childName ||
                childName.startsWith(".") ||
                childName.includes("/") ||
                childName.includes("\\") ||
                childName === ".." ||
                handle.preExistingParentEntries.has(childName)
              ) {
                handle.lastError = new BackupRunnerError(
                  `Worker reported invalid, forged, or pre-existing stagingDir (${m.stagingDir}) for snapshot destination directory ${expectedParent}`,
                  "INVALID_WORKER_RESPONSE",
                  { operationId: handle.operationId },
                );
                this.terminateChild(handle, "SIGKILL", true);
                return;
              }
              handle.stagingDir = resolvedStaging;
              handle.candidateChildPath = path.join(expectedParent, childName);
            }
          } else {
            handle.lastError = new BackupRunnerError(
              `Worker reported unexpected stagingDir for read-only operation ${handle.type}`,
              "INVALID_WORKER_RESPONSE",
              { operationId: handle.operationId },
            );
            this.terminateChild(handle, "SIGKILL", true);
            return;
          }
        }

        if (m.progress && typeof m.progress === "object") {
          const prog = m.progress as SafeProgressInfo;
          if (typeof prog.timestamp === "number" && Number.isFinite(prog.timestamp)) {
            handle.progress = prog;
          }
        }

        this.updateState(handle, state as BackupOperationState);
        break;
      }

      case "published": {
        if (handle.result !== undefined || handle.lastError !== undefined) {
          handle.lastError = new BackupRunnerError(
            "Worker emitted published update after terminal outcome",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        if (typeof m.targetPath !== "string" || m.targetPath.trim().length === 0) {
          handle.lastError = new BackupRunnerError(
            "Worker published message missing valid targetPath",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        const resolvedTarget = path.resolve(m.targetPath);
        let pathMatches = false;

        if (isAutoNamedSnapshotPayload(handle.payload) && handle.payload.snapshotDestinationDir) {
          const expectedParent = path.resolve(handle.payload.snapshotDestinationDir);
          const childName = path.basename(resolvedTarget);
          if (
            path.dirname(resolvedTarget) === expectedParent &&
            childName.length > 0 &&
            !childName.startsWith(".") &&
            !handle.preExistingParentEntries.has(childName) &&
            (!handle.candidateChildPath || resolvedTarget === handle.candidateChildPath) &&
            verifySnapshotOperationIdentity(resolvedTarget, handle.operationId)
          ) {
            pathMatches = true;
            handle.candidateChildPath = resolvedTarget;
            handle.targetPath = resolvedTarget;
          }
        } else {
          if (resolvedTarget === handle.initialTargetPath && !handle.destinationExistedAtStart) {
            pathMatches = true;
          }
        }

        if (!pathMatches) {
          handle.lastError = new BackupRunnerError(
            `Worker published targetPath mismatch or unverified identity: expected ${handle.targetPath}, got ${String(m.targetPath)}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        handle.published = true;
        handle.publishedAt = typeof m.publishedAt === "number" ? m.publishedAt : Date.now();
        break;
      }

      case "result": {
        // Duplicate terminal message checks
        if (handle.result !== undefined) {
          handle.result = undefined;
          handle.lastError = new BackupRunnerError(
            "Duplicate result message received from worker",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }
        if (handle.lastError !== undefined) {
          handle.lastError = new BackupRunnerError(
            "Worker result received after error",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }

        try {
          const validated = this.validateWorkerResult(handle, m.result);
          handle.result = validated;
        } catch (valErr) {
          handle.lastError =
            valErr instanceof BackupRunnerError
              ? valErr
              : new BackupRunnerError(
                  `Worker result validation failed: ${(valErr as Error).message}`,
                  "INVALID_WORKER_RESPONSE",
                  { operationId: handle.operationId, cause: valErr },
                );
          this.terminateChild(handle, "SIGKILL", true);
        }
        break;
      }

      case "error": {
        if (handle.result !== undefined) {
          handle.lastError = new BackupRunnerError(
            "Worker emitted error after successful result",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
          this.terminateChild(handle, "SIGKILL", true);
          return;
        }
        if (handle.lastError !== undefined) {
          // Already have an error recorded
          return;
        }

        const errPayload = m.error;
        if (!errPayload || typeof errPayload !== "object") {
          handle.lastError = new BackupRunnerError(
            "Worker emitted malformed error payload",
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        } else {
          handle.lastError = this.deserializeError(
            errPayload as SerializedBackupError,
            handle.operationId,
          );
        }
        this.terminateChild(handle, "SIGKILL", true);
        break;
      }
    }
  }

  private validateWorkerResult(
    handle: ActiveOperationHandle,
    result: unknown,
  ): BoundedBackupResultPayload {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new BackupRunnerError(
        "Worker result must be a non-null object",
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId },
      );
    }

    const r = result as Record<string, unknown>;
    if (Object.keys(r).length === 0) {
      throw new BackupRunnerError(
        "Empty result object received from worker",
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId },
      );
    }

    if (r.operationId !== handle.operationId) {
      throw new BackupRunnerError(
        `Worker result operationId mismatch: expected ${handle.operationId}, got ${String(r.operationId)}`,
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId },
      );
    }

    if (r.type !== handle.type) {
      throw new BackupRunnerError(
        `Worker result type mismatch: expected ${handle.type}, got ${String(r.type)}`,
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId },
      );
    }

    const checkNonNegInt = (num: unknown, name: string): number => {
      if (typeof num !== "number" || !Number.isInteger(num) || num < 0 || !Number.isFinite(num)) {
        throw new BackupRunnerError(
          `Invalid ${name}: must be a non-negative integer`,
          "INVALID_WORKER_RESPONSE",
          { operationId: handle.operationId },
        );
      }
      return num;
    };

    const checkSha256 = (hash: unknown, name: string): string => {
      if (typeof hash !== "string" || !HEX_SHA256_RE.test(hash)) {
        throw new BackupRunnerError(
          `Invalid ${name}: must be a 64-character lowercase hexadecimal SHA-256 digest`,
          "INVALID_WORKER_RESPONSE",
          { operationId: handle.operationId },
        );
      }
      return hash;
    };

    switch (handle.type) {
      case "backup-database": {
        const payload = handle.payload as BackupDatabasePayload;
        const expectedPath = path.resolve(payload.destinationPath);
        if (typeof r.path !== "string" || path.resolve(r.path) !== expectedPath) {
          throw new BackupRunnerError(
            `Worker result destination mismatch: expected ${expectedPath}, got ${String(r.path)}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        }
        checkNonNegInt(r.bytes, "bytes");
        checkSha256(r.sha256, "sha256");
        if (typeof r.durationMs !== "number" || r.durationMs < 0 || !Number.isFinite(r.durationMs)) {
          throw new BackupRunnerError("Invalid durationMs in result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        return r as unknown as CompactBackupDatabaseResult;
      }

      case "verify-database": {
        const payload = handle.payload as VerifyDatabasePayload;
        const expectedFile = path.resolve(payload.filePath);
        if (typeof r.filePath !== "string" || path.resolve(r.filePath) !== expectedFile) {
          throw new BackupRunnerError(
            `Worker result filePath mismatch: expected ${expectedFile}, got ${String(r.filePath)}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        }
        if (typeof r.ok !== "boolean") {
          throw new BackupRunnerError("Invalid verification ok boolean flag", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        if (!Array.isArray(r.issues)) {
          throw new BackupRunnerError("Issues in verify-database result must be an array", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        if (r.foreignKeyViolations !== undefined && !Array.isArray(r.foreignKeyViolations)) {
          throw new BackupRunnerError("foreignKeyViolations in verify-database result must be an array", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        return r as unknown as CompactVerifyDatabaseResult;
      }

      case "create-snapshot": {
        const payload = handle.payload as CreateSnapshotPayload;
        if (typeof r.path !== "string" || r.path.trim().length === 0) {
          throw new BackupRunnerError("Snapshot path must be a non-empty string", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        const resolvedPath = path.resolve(r.path);

        // Path relationship validation
        if (payload.destinationPath) {
          const expected = path.resolve(payload.destinationPath);
          if (resolvedPath !== expected) {
            throw new BackupRunnerError(
              `Snapshot destination mismatch: expected ${expected}, got ${resolvedPath}`,
              "INVALID_WORKER_RESPONSE",
              { operationId: handle.operationId },
            );
          }
        } else if (payload.snapshotDestinationDir) {
          const parentDir = path.resolve(payload.snapshotDestinationDir);
          if (path.dirname(resolvedPath) !== parentDir) {
            throw new BackupRunnerError(
              `Snapshot directory ${resolvedPath} is not located within requested parent ${parentDir}`,
              "INVALID_WORKER_RESPONSE",
              { operationId: handle.operationId },
            );
          }
          const rel = path.relative(parentDir, resolvedPath);
          if (rel.includes("..") || rel.includes("/") || rel.includes("\\")) {
            throw new BackupRunnerError("Snapshot path contains invalid traversal", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
          }
        }

        if (typeof r.snapshotId !== "string" || r.snapshotId.length === 0) {
          throw new BackupRunnerError("Invalid snapshotId in result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        checkSha256(r.databaseSha256, "databaseSha256");
        checkNonNegInt(r.databaseBytes, "databaseBytes");
        checkNonNegInt(r.totalFiles, "totalFiles");
        checkNonNegInt(r.totalBytes, "totalBytes");
        if (typeof r.createdAt !== "number" || r.createdAt <= 0 || !Number.isFinite(r.createdAt)) {
          throw new BackupRunnerError("Invalid createdAt timestamp in result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }

        const m = r.manifest as Record<string, unknown>;
        if (!m || typeof m !== "object") {
          throw new BackupRunnerError("Missing manifest summary in snapshot result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        if ((m.manifestVersion !== 1 && m.manifestVersion !== 2 && m.manifestVersion !== 3 && m.manifestVersion !== 4) || m.snapshotId !== r.snapshotId || m.verified !== true) {
          throw new BackupRunnerError("Snapshot manifest summary is unverified or invalid", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        const stats = m.stats as Record<string, unknown>;
        if (!stats || typeof stats !== "object") {
          throw new BackupRunnerError("Missing manifest stats in snapshot result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        checkNonNegInt(stats.totalBytes, "stats.totalBytes");
        checkNonNegInt(stats.fileCount, "stats.fileCount");
        checkNonNegInt(stats.knowledgeDocumentCount, "stats.knowledgeDocumentCount");
        checkNonNegInt(stats.knowledgeRevisionCount, "stats.knowledgeRevisionCount");
        if (stats.attachmentCount !== undefined) checkNonNegInt(stats.attachmentCount, "stats.attachmentCount");
        if (stats.screenshotCount !== undefined) checkNonNegInt(stats.screenshotCount, "stats.screenshotCount");
        if (stats.issueThreadCount !== undefined) checkNonNegInt(stats.issueThreadCount, "stats.issueThreadCount");
        if (stats.pipelineRunCount !== undefined) checkNonNegInt(stats.pipelineRunCount, "stats.pipelineRunCount");

        return r as unknown as CompactCreateSnapshotResult;
      }

      case "verify-snapshot": {
        const payload = handle.payload as VerifySnapshotPayload;
        const expectedPath = path.resolve(payload.snapshotPath);
        if (typeof r.snapshotPath !== "string" || path.resolve(r.snapshotPath) !== expectedPath) {
          throw new BackupRunnerError(
            `verify-snapshot path mismatch: expected ${expectedPath}, got ${String(r.snapshotPath)}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        }
        if (typeof r.ok !== "boolean") {
          throw new BackupRunnerError("verify-snapshot ok must be a boolean", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        checkNonNegInt(r.filesChecked, "filesChecked");
        checkNonNegInt(r.totalBytes, "totalBytes");
        if (!Array.isArray(r.issues)) {
          throw new BackupRunnerError("verify-snapshot issues must be an array", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }

        if (r.ok) {
          if (typeof r.snapshotId !== "string" || r.snapshotId.length === 0) {
            throw new BackupRunnerError("Verified snapshot must report snapshotId", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
          }
          if (typeof r.contentIdentity !== "string" || !/^[0-9a-f]{64}$/.test(r.contentIdentity)) {
            throw new BackupRunnerError("Verified snapshot must report a valid contentIdentity", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
          }
          if (r.issues.length > 0) {
            throw new BackupRunnerError("Successful snapshot verification cannot report issues", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
          }
        }

        return r as unknown as CompactVerifySnapshotResult;
      }

      case "restore-snapshot": {
        const payload = handle.payload as RestoreSnapshotPayload;
        const expectedDest = path.resolve(payload.destinationDir);
        if (typeof r.destinationPath !== "string" || path.resolve(r.destinationPath) !== expectedDest) {
          throw new BackupRunnerError(
            `restore-snapshot destinationPath mismatch: expected ${expectedDest}, got ${String(r.destinationPath)}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        }
        if (typeof r.snapshotId !== "string" || r.snapshotId.length === 0) {
          throw new BackupRunnerError("Invalid snapshotId in restore result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        if (typeof r.dbFilename !== "string" || r.dbFilename.length === 0 || r.dbFilename.includes("/") || r.dbFilename.includes("\\")) {
          throw new BackupRunnerError("Invalid dbFilename in restore result", "INVALID_WORKER_RESPONSE", { operationId: handle.operationId });
        }
        checkNonNegInt(r.databaseBytes, "databaseBytes");
        checkSha256(r.databaseSha256, "databaseSha256");
        checkNonNegInt(r.knowledgeDocumentCount, "knowledgeDocumentCount");
        checkNonNegInt(r.knowledgeRevisionCount, "knowledgeRevisionCount");
        if (r.attachmentCount !== undefined) checkNonNegInt(r.attachmentCount, "attachmentCount");
        if (r.screenshotCount !== undefined) checkNonNegInt(r.screenshotCount, "screenshotCount");
        if (r.issueThreadCount !== undefined) checkNonNegInt(r.issueThreadCount, "issueThreadCount");
        if (r.pipelineRunCount !== undefined) checkNonNegInt(r.pipelineRunCount, "pipelineRunCount");
        checkNonNegInt(r.filesRestored, "filesRestored");
        checkNonNegInt(r.totalBytesRestored, "totalBytesRestored");

        return r as unknown as CompactRestoreSnapshotResult;
      }
    }
  }

  private async handleWorkerCompletion(handle: ActiveOperationHandle, exitCode: number): Promise<void> {
    handle.exited = true;
    if (handle.timeoutTimer) {
      clearTimeout(handle.timeoutTimer);
      handle.timeoutTimer = null;
    }

    // Keep the destination reservation until this operation reaches its
    // authoritative terminal outcome (verification/publication reconciliation
    // happens below). Releasing here would let a concurrent operation into the
    // same parent while this one is still being verified.
    this.runningCount = Math.max(0, this.runningCount - 1);

    // 1. Successful worker result: independent verification must succeed before
    //    the operation can be reported completed.
    if (handle.result !== undefined && !handle.lastError) {
      try {
        await this.verifyDestinationArtifactExists(handle);
        if (handle.finalized) {
          this.drainQueue();
          return;
        }
        handle.destinationVerified = true;
        this.updateState(handle, "completed");
        handle.resolve(handle.result);
        this.finalizeOperation(handle);
      } catch (fsErr) {
        if (handle.finalized) {
          this.drainQueue();
          return;
        }
        const runnerErr =
          fsErr instanceof BackupRunnerError
            ? fsErr
            : new BackupRunnerError(
                `Destination artifact verification failed after worker completion: ${(fsErr as Error).message}`,
                "IO_ERROR",
                { operationId: handle.operationId, state: "failed", cause: fsErr },
              );
        // An intentionally terminated verification child is not an artifact
        // verdict. Classify from durable evidence without spawning another child.
        const recon = handle.verificationInterrupted
          ? this.durableReconciliation(handle)
          : this.classifyResultVerificationFailure(handle, runnerErr);
        this.settleReconciledOutcome(handle, recon, {
          cause: runnerErr,
          exitCode,
          phase: handle.verificationInterrupted ? "verification_interrupted" : "verification_failed",
        });
      }
      this.drainQueue();
      return;
    }

    // 2. One authoritative publication reconciliation for worker errors, lost
    //    acknowledgments, crashes, timeouts and cancellation.
    const recon = await this.reconcilePublishedDestination(handle);
    if (handle.finalized) {
      this.drainQueue();
      return;
    }
    this.settleReconciledOutcome(handle, recon, {
      cause: handle.lastError,
      exitCode,
      phase: handle.lastError ? "protocol_error" : "missing_ack",
    });
    this.drainQueue();
  }

  /**
   * Durable-evidence-only reconciliation. Never spawns a verification child, so
   * it is safe during disposal and after a verification child was terminated.
   */
  private durableReconciliation(handle: ActiveOperationHandle): PublicationReconciliation {
    if (handle.destinationExistedAtStart || handle.lastError?.code === "TARGET_EXISTS") {
      return baseReconciliation("not_published", {
        destinationPath: handle.candidateChildPath ?? handle.targetPath,
        reason: "destination existed before this operation started",
      });
    }
    if (handle.type === "verify-database" || handle.type === "verify-snapshot") {
      return baseReconciliation("not_published", {
        destinationPath: handle.candidateChildPath ?? handle.targetPath,
      });
    }

    const evidence = this.classifyPublicationEvidence(handle);
    // classifyPublicationEvidence may resolve an auto-named snapshot candidate.
    const destinationPath = handle.candidateChildPath ?? handle.targetPath;
    if (evidence === "committed") {
      const interrupted = handle.verificationInterrupted === true;
      const verified = handle.destinationVerified === true && !interrupted;
      return baseReconciliation("committed", {
        integrity: interrupted ? "interrupted" : verified ? "verified" : "not_verified",
        destinationPath,
        destinationVerified: verified,
        verificationInterrupted: interrupted,
        identityVerified: true,
        reason: "durable publication evidence",
      });
    }
    if (evidence === "unresolved") {
      return baseReconciliation("unresolved", {
        destinationPath,
        reason: "publication is possible but not attributable",
      });
    }
    return baseReconciliation("not_published", { destinationPath });
  }

  /**
   * True only when this operation has positive publication identity for the
   * artifact it reported. Destination existence alone never qualifies.
   */
  private hasResultPublicationOwnership(handle: ActiveOperationHandle): boolean {
    switch (handle.type) {
      case "backup-database": {
        const target = handle.initialTargetPath;
        if (!target || !pathExistsOrSymlink(target)) return false;
        if (handle.published) return true;
        if (readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined) === "completed") return true;
        const receipt = readBackupPublicationReceipt(handle.operationId);
        return !!receipt && path.resolve(receipt.targetPath) === path.resolve(target);
      }
      case "create-snapshot": {
        const payload = handle.payload as CreateSnapshotPayload;
        if (payload.destinationPath) {
          return verifySnapshotOperationIdentity(
            handle.initialTargetPath ?? "",
            handle.operationId,
          );
        }
        return this.listSnapshotCandidatePaths(handle).some((candidate) =>
          verifySnapshotOperationIdentity(candidate, handle.operationId),
        );
      }
      case "restore-snapshot":
        return verifyRestoreOperationIdentity(
          handle.initialTargetPath ?? "",
          handle.operationId,
        );
      default:
        return false;
    }
  }

  /**
   * Classification for a successful worker result whose independent artifact
   * verification failed. A result is a claim, not proof of ownership: only a
   * matching receipt, validated published frame, completed staging identity or
   * operation marker makes the failure post-publication.
   */
  private classifyResultVerificationFailure(
    handle: ActiveOperationHandle,
    cause: BackupRunnerError,
  ): PublicationReconciliation {
    const destinationPath = handle.candidateChildPath ?? handle.targetPath;
    if (handle.destinationExistedAtStart || cause.code === "TARGET_EXISTS") {
      return baseReconciliation("not_published", {
        destinationPath,
        reason: "destination existed before this operation started",
      });
    }
    // Identity/validation failures are definitive and never authorize adoption.
    if (cause.code === "INVALID_WORKER_RESPONSE") {
      return baseReconciliation("not_published", {
        destinationPath,
        reason: "worker result identity did not match this operation's destination",
      });
    }
    if (!this.hasResultPublicationOwnership(handle)) {
      // No authenticated ownership evidence: fail closed with the original
      // verification error. The artifact is preserved but never adopted.
      return baseReconciliation("not_published", {
        destinationPath,
        reason: "artifact could not be attributed to this operation",
      });
    }

    const detail = (cause.details ?? {}) as SerializedBackupErrorDetails;
    const interrupted =
      handle.verificationInterrupted === true ||
      cause.code === "VERIFICATION_INTERRUPTED" ||
      detail.verificationInterrupted === true;
    const issues = boundedVerificationIssues(detail.verificationIssues);
    if (interrupted) {
      return baseReconciliation("committed", {
        integrity: "interrupted",
        destinationPath: detail.destinationPath ?? destinationPath,
        verificationInterrupted: true,
        identityVerified: true,
        issues,
      });
    }
    return baseReconciliation("committed", {
      integrity: "failed",
      destinationPath: detail.destinationPath ?? destinationPath,
      verificationFailed: true,
      identityVerified: true,
      issues: issues.length > 0 ? issues : ["Artifact verification failed"],
    });
  }

  private publicationDetails(
    recon: PublicationReconciliation,
    extra: { exitCode: number; phase: string; cause?: BackupRunnerError },
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      targetPath: recon.destinationPath,
      destinationPath: recon.destinationPath,
      publicationOutcome: recon.publication,
      integrityOutcome: recon.integrity,
      destinationVerified: recon.destinationVerified,
      verificationFailed: recon.verificationFailed,
      verificationInterrupted: recon.verificationInterrupted,
      exitCode: extra.exitCode,
      phase: extra.phase,
    };
    if (recon.issues.length > 0) details.verificationIssues = recon.issues;
    if (recon.reason) details.reason = recon.reason;
    if (extra.cause) details.causeCode = extra.cause.code;
    return details;
  }

  /**
   * The single authoritative settlement path for a reconciled outcome. Caller
   * promise and stored history are updated exactly once, from the same values.
   */
  private settleReconciledOutcome(
    handle: ActiveOperationHandle,
    recon: PublicationReconciliation,
    context: { cause?: BackupRunnerError; exitCode: number; phase: string },
  ): void {
    if (handle.finalized || handle.isSettled) return;

    const cause = context.cause;
    if (
      cause?.code === "TARGET_EXISTS" ||
      handle.lastError?.code === "TARGET_EXISTS" ||
      (handle.destinationExistedAtStart && !handle.isCancelled)
    ) {
      this.cleanWorkerStaging(handle);
      this.settleOperation(
        handle,
        new BackupRunnerError(
          `Target destination already existed before operation: ${handle.targetPath}`,
          "TARGET_EXISTS",
          { operationId: handle.operationId, state: "failed" },
        ),
        "failed",
      );
      return;
    }

    const details = this.publicationDetails(recon, context);

    if (recon.publication === "committed") {
      const message = cause
        ? `Destination was published but the operation did not complete: ${cause.message}`
        : "Destination was published but final acknowledgment was missing due to worker termination or IPC failure";
      this.settleOperation(
        handle,
        new BackupRunnerError(message, "PUBLISHED_UNCONFIRMED", {
          operationId: handle.operationId,
          state: "failed",
          cause,
          details,
        }),
        "failed",
        { preserveReceipt: true },
      );
      return;
    }

    if (recon.publication === "unresolved") {
      // An explicit protocol violation is a definitive worker failure. It is not
      // a claim that nothing was published, but it is not silent ambiguity
      // either: preserve the protocol error instead of masking it.
      if (cause?.code === "INVALID_WORKER_RESPONSE" || cause?.code === "IPC_ERROR") {
        this.settleOperation(handle, cause, "failed");
        return;
      }
      this.settleOperation(
        handle,
        new BackupRunnerError(
          `Operation may have published but publication could not be verified (${context.phase})`,
          "INDETERMINATE",
          {
            operationId: handle.operationId,
            state: "failed",
            cause,
            details,
          },
        ),
        "failed",
        { preserveReceipt: true },
      );
      return;
    }

    // Affirmative non-publication: a definitive outcome is truthful here.
    this.cleanWorkerStaging(handle);

    if (handle.isTimedOut) {
      this.settleOperation(
        handle,
        new BackupRunnerError(`Operation timed out after ${handle.timeoutMs}ms`, "TIMEOUT", {
          operationId: handle.operationId,
          state: "failed",
          details,
        }),
        "failed",
      );
      return;
    }

    if (cause?.code === "CANCELLED" || handle.isCancelled) {
      this.settleOperation(
        handle,
        new BackupRunnerError(
          this.isDisposed ? "Operation was cancelled due to runner disposal" : "Operation was cancelled",
          "CANCELLED",
          {
            operationId: handle.operationId,
            state: "cancelled",
            details,
          },
        ),
        "cancelled",
      );
      return;
    }

    if (cause) {
      this.settleOperation(handle, cause, "failed");
      return;
    }

    if (context.exitCode !== 0 || this.isDisposed) {
      const diag = handle.stderrTail ? ` (diagnostics: ${handle.stderrTail.slice(-200)})` : "";
      this.settleOperation(
        handle,
        new BackupRunnerError(
          this.isDisposed
            ? "Operation was cancelled due to runner disposal"
            : `Worker process terminated unexpectedly with exit code ${context.exitCode}${diag}`,
          this.isDisposed ? "CANCELLED" : "WORKER_CRASH",
          {
            operationId: handle.operationId,
            state: this.isDisposed ? "cancelled" : "failed",
            details,
          },
        ),
        this.isDisposed ? "cancelled" : "failed",
      );
      return;
    }

    this.settleOperation(
      handle,
      new BackupRunnerError(
        "Worker process exited with code 0 without providing a valid result",
        "INVALID_WORKER_RESPONSE",
        { operationId: handle.operationId, state: "failed", details },
      ),
      "failed",
    );
  }

  /**
   * Structured publication + integrity reconciliation (R9).
   *
   * Publication is established only from evidence attributable to THIS
   * operation (receipt, validated published frame, completed staging identity,
   * snapshot manifest identity or restore recovery marker). Integrity is
   * established only by an independent verification verdict. The two axes are
   * never conflated.
   */
  private async reconcilePublishedDestination(
    handle: ActiveOperationHandle,
  ): Promise<PublicationReconciliation> {
    const destinationPath = handle.candidateChildPath ?? handle.targetPath;
    try {
      // Never adopt a destination that existed before the operation started.
      if (handle.destinationExistedAtStart || handle.lastError?.code === "TARGET_EXISTS") {
        return baseReconciliation("not_published", {
          destinationPath,
          reason: "destination existed before this operation started",
        });
      }
      if (handle.type === "verify-database" || handle.type === "verify-snapshot") {
        return baseReconciliation("not_published", { destinationPath });
      }
      // During disposal reconciliation is durable-evidence-only: never spawn a
      // duplicate verification child after (or in place of) a terminated one.
      if (this.isDisposed || handle.isDisposing) {
        return this.durableReconciliation(handle);
      }

      switch (handle.type) {
        case "backup-database":
          return await this.reconcileBackupDestination(handle);
        case "create-snapshot":
          return await this.reconcileSnapshotDestination(handle);
        case "restore-snapshot":
          return await this.reconcileRestoreDestination(handle);
        default:
          return baseReconciliation("not_published", { destinationPath });
      }
    } catch (err) {
      return baseReconciliation("unresolved", {
        destinationPath,
        reason: `reconciliation failed: ${(err as Error).message}`,
      });
    }
  }

  private async reconcileBackupDestination(
    handle: ActiveOperationHandle,
  ): Promise<PublicationReconciliation> {
    const target = handle.initialTargetPath;
    if (!target) {
      return baseReconciliation("unresolved", { reason: "missing expected destination" });
    }
    const exists = pathExistsOrSymlink(target);
    const receipt = readBackupPublicationReceipt(handle.operationId);
    const receiptMatches =
      !!receipt && path.resolve(receipt.targetPath) === path.resolve(target);
    const ownedStaging = readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined);
    const publishedFrame = handle.published === true;
    const stagingCompleted = ownedStaging === "completed";
    const resultClaim =
      handle.result?.type === "backup-database" ? handle.result : undefined;
    const publicationCommitted = receiptMatches || stagingCompleted || (publishedFrame && exists);

    if (!exists) {
      if (publicationCommitted) {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Published backup artifact is missing at the expected destination"],
        });
      }
      if (ownedStaging === "publishing") {
        return baseReconciliation("unresolved", {
          destinationPath: target,
          reason: "publication rename may still be in flight",
        });
      }
      return baseReconciliation("not_published", { destinationPath: target });
    }

    if (!publicationCommitted) {
      return baseReconciliation("unresolved", {
        destinationPath: target,
        reason: receipt
          ? "publication receipt does not match the destination"
          : "destination exists but is not attributable to this operation",
      });
    }

    let fileStat;
    try {
      fileStat = await stat(target);
    } catch (err) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: [`Published backup artifact is unreadable: ${(err as Error).message}`],
      });
    }
    if (!fileStat.isFile() || fileStat.size === 0) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: ["Published backup artifact is not a regular, non-empty file"],
      });
    }
    if (receiptMatches && fileStat.size !== receipt!.bytes) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: [
          `Published backup size mismatch: receipt ${receipt!.bytes} bytes, found ${fileStat.size}`,
        ],
      });
    }

    const ver = await this.runIsolatedVerification("verify-database", target);
    if (ver.interrupted) {
      handle.verificationInterrupted = true;
      return baseReconciliation("committed", {
        integrity: "interrupted",
        destinationPath: target,
        verificationInterrupted: true,
        identityVerified: true,
      });
    }
    if (!ver.ok) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: boundedVerificationIssues(ver.issues).length
          ? boundedVerificationIssues(ver.issues)
          : ["Backup artifact failed SQLite integrity verification"],
      });
    }

    if (receiptMatches) {
      if (ver.sha256 && ver.sha256 !== receipt!.sha256) {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Verified artifact SHA-256 does not match the publication receipt"],
        });
      }
      if (ver.bytes !== undefined && ver.bytes !== receipt!.bytes) {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Verified artifact size does not match the publication receipt"],
        });
      }
    } else if (resultClaim) {
      if (ver.sha256 && ver.sha256 !== resultClaim.sha256) {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Verified artifact SHA-256 does not match the worker result"],
        });
      }
      if (ver.bytes !== undefined && ver.bytes !== resultClaim.bytes) {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Verified artifact size does not match the worker result"],
        });
      }
    }

    handle.destinationVerified = true;
    return baseReconciliation("committed", {
      integrity: "verified",
      destinationPath: target,
      destinationVerified: true,
      identityVerified: true,
    });
  }

  private async reconcileSnapshotDestination(
    handle: ActiveOperationHandle,
  ): Promise<PublicationReconciliation> {
    const payload = handle.payload as CreateSnapshotPayload;

    if (payload.destinationPath) {
      const target = handle.initialTargetPath;
      if (!target || !pathExistsOrSymlink(target)) {
        if (readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined) === "completed") {
          return baseReconciliation("committed", {
            integrity: "failed",
            destinationPath: target,
            verificationFailed: true,
            identityVerified: true,
            issues: ["Published snapshot directory is missing at the expected destination"],
          });
        }
        return baseReconciliation("not_published", { destinationPath: target });
      }
      if (!verifySnapshotOperationIdentity(target, handle.operationId)) {
        return baseReconciliation("unresolved", {
          destinationPath: target,
          reason: "snapshot manifest does not belong to this operation",
        });
      }
      return await this.verifySnapshotReconciliation(handle, target);
    }

    if (payload.snapshotDestinationDir && !payload.destinationPath) {
      for (const candidate of this.listSnapshotCandidatePaths(handle)) {
        if (!verifySnapshotOperationIdentity(candidate, handle.operationId)) continue;
        const recon = await this.verifySnapshotReconciliation(handle, candidate);
        if (recon.publication === "committed") {
          handle.candidateChildPath = candidate;
          handle.targetPath = candidate;
        }
        return recon;
      }
      const parentDir = path.resolve(payload.snapshotDestinationDir);
      let hasUnattributableChild = false;
      if (pathExistsOrSymlink(parentDir)) {
        try {
          hasUnattributableChild = readdirSync(parentDir).some(
            (entry) => !entry.startsWith(".") && !handle.preExistingParentEntries.has(entry),
          );
        } catch {
          /* ignore */
        }
      }
      if (readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined) === "publishing" || hasUnattributableChild) {
        return baseReconciliation("unresolved", {
          destinationPath: parentDir,
          reason: "snapshot destination is present but not attributable to this operation",
        });
      }
      return baseReconciliation("not_published", { destinationPath: parentDir });
    }

    return baseReconciliation("not_published", { reason: "no snapshot destination requested" });
  }

  private async verifySnapshotReconciliation(
    handle: ActiveOperationHandle,
    target: string,
  ): Promise<PublicationReconciliation> {
    let dirStat;
    try {
      dirStat = await stat(target);
    } catch (err) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: [`Snapshot destination is unreadable: ${(err as Error).message}`],
      });
    }
    if (!dirStat.isDirectory()) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: ["Snapshot destination is not a directory"],
      });
    }
    const ver = await this.runIsolatedVerification("verify-snapshot", target);
    if (ver.interrupted) {
      handle.verificationInterrupted = true;
      return baseReconciliation("committed", {
        integrity: "interrupted",
        destinationPath: target,
        verificationInterrupted: true,
        identityVerified: true,
      });
    }
    if (!ver.ok) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: boundedVerificationIssues(ver.issues).length
          ? boundedVerificationIssues(ver.issues)
          : ["Snapshot verification failed"],
      });
    }
    handle.destinationVerified = true;
    return baseReconciliation("committed", {
      integrity: "verified",
      destinationPath: target,
      destinationVerified: true,
      identityVerified: true,
    });
  }

  private async reconcileRestoreDestination(
    handle: ActiveOperationHandle,
  ): Promise<PublicationReconciliation> {
    const target = handle.initialTargetPath;
    if (!target || !pathExistsOrSymlink(target)) {
      if (readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined) === "completed") {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Published restore directory is missing at the expected destination"],
        });
      }
      if (readOwnedStagingState(handle, this.resolveSubsystem(handle.type) ?? undefined) === "publishing") {
        return baseReconciliation("unresolved", {
          destinationPath: target,
          reason: "restore publication rename may still be in flight",
        });
      }
      return baseReconciliation("not_published", { destinationPath: target });
    }
    if (!verifyRestoreOperationIdentity(target, handle.operationId)) {
      return baseReconciliation("unresolved", {
        destinationPath: target,
        reason: "restore recovery marker does not belong to this operation",
      });
    }

    const payload = handle.payload as RestoreSnapshotPayload;
    const dbFilename = payload.dbFilename ?? "agetor.sqlite";
    const dbFile = path.join(target, dbFilename);
    if (!pathExistsOrSymlink(dbFile)) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: [`Restored database file is missing: ${dbFilename}`],
      });
    }
    try {
      const dbStat = await stat(dbFile);
      if (!dbStat.isFile() || dbStat.size === 0) {
        return baseReconciliation("committed", {
          integrity: "failed",
          destinationPath: target,
          verificationFailed: true,
          identityVerified: true,
          issues: ["Restored database file is not a regular, non-empty file"],
        });
      }
    } catch (err) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: [`Restored database file is unreadable: ${(err as Error).message}`],
      });
    }

    const ver = await this.runIsolatedVerification("verify-database", dbFile);
    if (ver.interrupted) {
      handle.verificationInterrupted = true;
      return baseReconciliation("committed", {
        integrity: "interrupted",
        destinationPath: target,
        verificationInterrupted: true,
        identityVerified: true,
      });
    }
    if (!ver.ok) {
      return baseReconciliation("committed", {
        integrity: "failed",
        destinationPath: target,
        verificationFailed: true,
        identityVerified: true,
        issues: boundedVerificationIssues(ver.issues).length
          ? boundedVerificationIssues(ver.issues)
          : ["Restored database failed SQLite integrity verification"],
      });
    }
    handle.destinationVerified = true;
    return baseReconciliation("committed", {
      integrity: "verified",
      destinationPath: target,
      destinationVerified: true,
      identityVerified: true,
    });
  }

  private async runIsolatedVerification(
    type: "verify-database" | "verify-snapshot",
    targetFileOrPath: string,
    timeoutMs: number = 30_000,
    options?: { deadline?: number },
  ): Promise<{
    ok: boolean;
    interrupted?: boolean;
    sha256?: string;
    bytes?: number;
    snapshotId?: string;
    databaseSha256?: string;
    issues?: string[];
  }> {
    const outcome: {
      ok: boolean;
      interrupted?: boolean;
      sha256?: string;
      bytes?: number;
      snapshotId?: string;
      databaseSha256?: string;
      issues?: string[];
    } = { ok: false, issues: [] };

    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let verificationCwd: string | null = null;
    let verifyLockFd: number | null = null;

    try {
      verificationCwd = mkdtempSync(path.join(tmpdir(), "fo-verify-cwd-"));
      try {
        chmodSync(verificationCwd, 0o700);
      } catch {
        /* best effort */
      }
      try {
        const lockPath = path.join(verificationCwd, ".fo-worker.lock");
        verifyLockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
        tryAcquireFlock(verifyLockFd);
      } catch {
        /* best effort */
      }

      const canonicalScript = resolveWorkerScriptPath();
      proc = Bun.spawn([this.bunExecutable, "--no-env-file", canonicalScript], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: verificationCwd,
        env: buildWorkerEnvironment(),
      });
      this.activeVerificationProcs.add(proc);

      const resolvedTarget = path.resolve(targetFileOrPath);
      const opId = randomUUID();
      const reqMsg: ParentToWorkerMessage = {
        type: "start",
        operation: {
          operationId: opId,
          payload:
            type === "verify-database"
              ? { type: "verify-database", filePath: resolvedTarget }
              : { type: "verify-snapshot", snapshotPath: resolvedTarget },
        },
      };

      if (!proc.stdin || typeof proc.stdin === "number") {
        return outcome;
      }

      proc.stdin.write(JSON.stringify(reqMsg) + "\n");
      proc.stdin.flush();

      let isTimeout = false;
      const deadlineRemaining = options?.deadline
        ? Math.max(0, Math.floor(options.deadline - performance.now()))
        : timeoutMs;
      const effectiveTimeout = Math.min(timeoutMs, deadlineRemaining);
      timer = setTimeout(() => {
        isTimeout = true;
        outcome.interrupted = true;
        if (proc && !proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, effectiveTimeout);
      (timer as { unref?: () => void }).unref?.();

      const drainStderr = async () => {
        if (!proc?.stderr || typeof proc.stderr === "number") return;
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        let total = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_STDERR_TAIL_BYTES) break;
          }
        } catch {
          /* ignore */
        }
      };
      const stderrPromise = drainStderr();

      let buffer = "";
      let foundResult: Record<string, unknown> | null = null;

      if (proc.stdout && typeof proc.stdout !== "number") {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_IPC_BUFFER_BYTES) {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            return outcome;
          }

          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;
            if (line.length > MAX_IPC_FRAME_BYTES) {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* ignore */
              }
              return outcome;
            }

            try {
              const parsed = JSON.parse(line);
              if (parsed?.operationId === opId && parsed?.type === "result" && parsed.result) {
                foundResult = parsed.result;
              }
            } catch {
              /* ignore */
            }
          }
        }
      }

      await Promise.all([proc.exited, stderrPromise]);

      if (isTimeout || !foundResult) {
        if (!foundResult && this.isDisposed) {
          // A verification child terminated by disposal is not an artifact verdict.
          outcome.interrupted = true;
        }
        return outcome;
      }

      if (foundResult.ok === true) {
        outcome.ok = true;
        outcome.sha256 = typeof foundResult.sha256 === "string" ? foundResult.sha256 : undefined;
        outcome.bytes = typeof foundResult.bytes === "number" ? foundResult.bytes : undefined;
        outcome.snapshotId = typeof foundResult.snapshotId === "string" ? foundResult.snapshotId : undefined;
        outcome.databaseSha256 =
          typeof foundResult.databaseSha256 === "string" ? foundResult.databaseSha256 : undefined;
        outcome.issues = Array.isArray(foundResult.issues) ? (foundResult.issues as string[]) : [];
      } else {
        outcome.ok = false;
        outcome.issues = Array.isArray(foundResult.issues)
          ? (foundResult.issues as string[])
          : ["Verification failed"];
      }

      return outcome;
    } catch {
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
      if (proc) {
        this.activeVerificationProcs.delete(proc);
        if (!proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
      if (verifyLockFd !== null) {
        try {
          releaseFlock(verifyLockFd);
        } catch {}
        try {
          closeSync(verifyLockFd);
        } catch {}
        verifyLockFd = null;
      }
      if (verificationCwd) {
        try {
          if (existsSync(verificationCwd)) {
            rmSync(verificationCwd, { recursive: true, force: true });
          }
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * Structured details for a post-publication verification failure. These flow
   * into the caller-visible error AND the stored history unchanged.
   */
  private verificationErrorDetails(
    destinationPath: string,
    options: { failed?: boolean; interrupted?: boolean; issues?: string[] },
  ): SerializedBackupErrorDetails {
    return {
      destinationPath,
      destinationVerified: false,
      verificationFailed: options.failed === true,
      verificationInterrupted: options.interrupted === true,
      verificationIssues: boundedVerificationIssues(options.issues),
      publicationOutcome: "committed",
      integrityOutcome: options.interrupted ? "interrupted" : "failed",
    };
  }

  private async verifyDestinationArtifactExists(handle: ActiveOperationHandle): Promise<void> {
    const result = handle.result!;
    switch (result.type) {
      case "backup-database": {
        if (handle.destinationExistedAtStart) {
          throw new BackupRunnerError(
            `Exclusive backup destination already existed before operation: ${result.path}`,
            "TARGET_EXISTS",
            { operationId: handle.operationId },
          );
        }
        const receipt = readBackupPublicationReceipt(handle.operationId);
        if (receipt) {
          if (
            path.resolve(receipt.targetPath) !== path.resolve(result.path) ||
            receipt.sha256 !== result.sha256 ||
            receipt.bytes !== result.bytes
          ) {
            throw new BackupRunnerError(
              `Backup publication receipt mismatch for operation ${handle.operationId}`,
              "INVALID_WORKER_RESPONSE",
              { operationId: handle.operationId },
            );
          }
        }
        const s = await stat(result.path);
        if (!s.isFile() || s.size === 0) {
          throw new BackupRunnerError(
            `Backup destination artifact is missing, not a regular file, or zero bytes: ${result.path}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        if (s.size !== result.bytes) {
          throw new BackupRunnerError(
            `Backup destination file size mismatch: expected ${result.bytes} bytes, found ${s.size}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        const ver = await this.runIsolatedVerification("verify-database", result.path);
        if (!ver.ok) {
          if (ver.interrupted) {
            handle.verificationInterrupted = true;
            throw new BackupRunnerError(
              "Backup artifact verification was interrupted before it could complete",
              "VERIFICATION_INTERRUPTED",
              {
                operationId: handle.operationId,
                details: this.verificationErrorDetails(result.path, { interrupted: true }),
              },
            );
          }
          throw new BackupRunnerError(
            `Backup artifact failed SQLite integrity verification: ${ver.issues?.join("; ")}`,
            "VERIFICATION_FAILED",
            {
              operationId: handle.operationId,
              details: this.verificationErrorDetails(result.path, {
                failed: true,
                issues: ver.issues,
              }),
            },
          );
        }
        if (ver.sha256 && ver.sha256 !== result.sha256) {
          throw new BackupRunnerError(
            `Backup artifact SHA-256 mismatch: reported ${result.sha256}, actual ${ver.sha256}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        if (ver.bytes !== undefined && ver.bytes !== result.bytes) {
          throw new BackupRunnerError(
            `Backup artifact byte size mismatch: reported ${result.bytes}, verified ${ver.bytes}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        break;
      }
      case "create-snapshot": {
        const payload = handle.payload as CreateSnapshotPayload;
        const resolvedResultPath = path.resolve(result.path);
        if (payload.destinationPath) {
          if (handle.destinationExistedAtStart) {
            throw new BackupRunnerError(
              `Exclusive snapshot destination already existed before operation: ${result.path}`,
              "TARGET_EXISTS",
              { operationId: handle.operationId },
            );
          }
        } else if (payload.snapshotDestinationDir) {
          if (handle.preExistingParentEntries.has(path.basename(resolvedResultPath))) {
            throw new BackupRunnerError(
              `Auto-named snapshot destination already existed before operation: ${result.path}`,
              "TARGET_EXISTS",
              { operationId: handle.operationId },
            );
          }
          if (handle.candidateChildPath && resolvedResultPath !== handle.candidateChildPath) {
            throw new BackupRunnerError(
              `Worker reported snapshot result path '${resolvedResultPath}' inconsistent with candidate '${handle.candidateChildPath}'`,
              "INVALID_WORKER_RESPONSE",
              { operationId: handle.operationId },
            );
          }
        }
        if (!verifySnapshotOperationIdentity(resolvedResultPath, handle.operationId)) {
          throw new BackupRunnerError(
            `Snapshot manifest runnerOperationId mismatch at destination: ${result.path}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        }
        const s = await stat(resolvedResultPath);
        if (!s.isDirectory()) {
          throw new BackupRunnerError(
            `Snapshot destination is not a directory: ${result.path}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        const m = await stat(path.join(resolvedResultPath, "manifest.json"));
        if (!m.isFile()) {
          throw new BackupRunnerError("Snapshot manifest.json missing", "VERIFICATION_FAILED", {
            operationId: handle.operationId,
          });
        }
        const db = await stat(path.join(resolvedResultPath, "database.sqlite"));
        if (!db.isFile() || db.size === 0) {
          throw new BackupRunnerError("Snapshot database.sqlite missing or empty", "VERIFICATION_FAILED", {
            operationId: handle.operationId,
          });
        }
        if (db.size !== result.databaseBytes) {
          throw new BackupRunnerError(
            `Snapshot database.sqlite size mismatch: expected ${result.databaseBytes}, found ${db.size}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        const ver = await this.runIsolatedVerification("verify-snapshot", resolvedResultPath);
        if (!ver.ok) {
          if (ver.interrupted) {
            handle.verificationInterrupted = true;
            throw new BackupRunnerError(
              "Snapshot verification was interrupted before it could complete",
              "VERIFICATION_INTERRUPTED",
              {
                operationId: handle.operationId,
                details: this.verificationErrorDetails(resolvedResultPath, { interrupted: true }),
              },
            );
          }
          throw new BackupRunnerError(
            `Snapshot verification failed: ${ver.issues?.join("; ")}`,
            "VERIFICATION_FAILED",
            {
              operationId: handle.operationId,
              details: this.verificationErrorDetails(resolvedResultPath, {
                failed: true,
                issues: ver.issues,
              }),
            },
          );
        }
        if (ver.snapshotId && ver.snapshotId !== result.snapshotId) {
          throw new BackupRunnerError(
            `Snapshot artifact snapshotId mismatch: expected ${result.snapshotId}, verified ${ver.snapshotId}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        if (ver.databaseSha256 && ver.databaseSha256 !== result.databaseSha256) {
          throw new BackupRunnerError(
            `Snapshot database SHA-256 mismatch: reported ${result.databaseSha256}, verified ${ver.databaseSha256}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        handle.targetPath = resolvedResultPath;
        break;
      }
      case "restore-snapshot": {
        if (handle.destinationExistedAtStart) {
          throw new BackupRunnerError(
            `Exclusive restore destination already existed before operation: ${result.destinationPath}`,
            "TARGET_EXISTS",
            { operationId: handle.operationId },
          );
        }
        if (!verifyRestoreOperationIdentity(result.destinationPath, handle.operationId)) {
          throw new BackupRunnerError(
            `Restored directory recovery marker runnerOperationId mismatch: ${result.destinationPath}`,
            "INVALID_WORKER_RESPONSE",
            { operationId: handle.operationId },
          );
        }
        const s = await stat(result.destinationPath);
        if (!s.isDirectory()) {
          throw new BackupRunnerError(
            `Restored destination is not a directory: ${result.destinationPath}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        const dbFile = path.join(result.destinationPath, result.dbFilename);
        const dbStat = await stat(dbFile);
        if (!dbStat.isFile() || dbStat.size === 0) {
          throw new BackupRunnerError(
            `Restored database file missing or zero bytes: ${result.dbFilename}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        if (dbStat.size !== result.databaseBytes) {
          throw new BackupRunnerError(
            `Restored database file size mismatch: expected ${result.databaseBytes}, found ${dbStat.size}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        const ver = await this.runIsolatedVerification("verify-database", dbFile);
        if (!ver.ok) {
          if (ver.interrupted) {
            handle.verificationInterrupted = true;
            throw new BackupRunnerError(
              "Restored database verification was interrupted before it could complete",
              "VERIFICATION_INTERRUPTED",
              {
                operationId: handle.operationId,
                details: this.verificationErrorDetails(result.destinationPath, { interrupted: true }),
              },
            );
          }
          throw new BackupRunnerError(
            `Restored database SQLite verification failed: ${ver.issues?.join("; ")}`,
            "VERIFICATION_FAILED",
            {
              operationId: handle.operationId,
              details: this.verificationErrorDetails(result.destinationPath, {
                failed: true,
                issues: ver.issues,
              }),
            },
          );
        }
        if (ver.sha256 && ver.sha256 !== result.databaseSha256) {
          throw new BackupRunnerError(
            `Restored database SHA-256 mismatch: reported ${result.databaseSha256}, verified ${ver.sha256}`,
            "VERIFICATION_FAILED",
            { operationId: handle.operationId },
          );
        }
        break;
      }
      case "verify-database":
      case "verify-snapshot":
        // Read-only operations; no new destination artifact created
        break;
    }
  }

  private handleTimeout(handle: ActiveOperationHandle): void {
    if (handle.state === "completed" || handle.state === "failed" || handle.state === "cancelled") {
      return;
    }

    // If publishing has already commenced or succeeded, give brief grace period for atomic rename
    if (handle.published || handle.state === "publishing") {
      setTimeout(() => {
        if (handle.state !== "completed") {
          handle.isTimedOut = true;
          this.terminateChild(handle, "SIGKILL", true);
        }
      }, 1000);
      return;
    }

    handle.isTimedOut = true;
    this.terminateChild(handle, "SIGTERM", true);
  }

  private terminateChild(
    handle: ActiveOperationHandle,
    signal: "SIGTERM" | "SIGKILL",
    escalateToKill: boolean,
  ): void {
    const proc = handle.proc;
    if (!proc || handle.exited) return;

    try {
      proc.kill(signal);
    } catch {
      /* process may already be exiting */
    }

    // Bun's `proc.killed` becomes true as soon as a signal is requested, even if
    // the child ignores SIGTERM. Escalate based on actual exit, not `killed`.
    if (escalateToKill && signal === "SIGTERM") {
      setTimeout(() => {
        if (handle.proc && !handle.exited) {
          try {
            handle.proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 500).unref?.();
    }
  }

  private cleanWorkerStaging(handle: ActiveOperationHandle): ScopedCleanupResult {
    // If published or completed, never delete published results
    if (handle.published || handle.state === "completed") {
      return { attempted: false, cleaned: [], preserved: [], errors: [] };
    }

    const cleanupTargetPath = handle.candidateChildPath ?? handle.targetPath;
    if (!cleanupTargetPath) {
      return { attempted: false, cleaned: [], preserved: [], errors: [] };
    }

    const subsystem = this.resolveSubsystem(handle.type);
    if (!subsystem) {
      return { attempted: false, cleaned: [], preserved: [], errors: [] };
    }

    let parentDir: string;
    if (handle.type === "create-snapshot") {
      const payload = handle.payload as CreateSnapshotPayload;
      if (payload.snapshotDestinationDir) {
        parentDir = path.resolve(payload.snapshotDestinationDir);
      } else {
        parentDir = path.dirname(path.resolve(cleanupTargetPath));
      }
    } else {
      parentDir = path.dirname(path.resolve(cleanupTargetPath));
    }

    return cleanScopedWorkerStaging({
      parentDir,
      subsystem,
      targetPath: cleanupTargetPath,
      runnerOperationId: handle.operationId,
      workerPid: handle.pid,
      candidateStagingDir: handle.stagingDir,
    });
  }

  private resolveSubsystem(type: BackupOperationType): StagingSubsystem | null {
    switch (type) {
      case "backup-database":
        return "backup-core";
      case "create-snapshot":
        return "backup-manager";
      case "restore-snapshot":
        return "backup-restore";
      default:
        return null;
    }
  }

  /**
   * Settles an operation exactly once with an authoritative terminal outcome.
   *
   * Refuses to touch an operation whose terminal outcome was already delivered to
   * the caller, which is what prevents a late completion callback (or a second
   * settle path) from overwriting the settled result and history.
   */
  private settleOperation(
    handle: ActiveOperationHandle,
    error: BackupRunnerError,
    state: BackupOperationState,
    options?: { preserveReceipt?: boolean },
  ): boolean {
    if (handle.finalized || handle.isSettled) return false;
    handle.lastError = error;
    this.updateState(handle, state);
    handle.reject(error);
    this.finalizeOperation(handle, options);
    return true;
  }

  private finalizeOperation(handle: ActiveOperationHandle, options?: { preserveReceipt?: boolean }): void {
    if (handle.finalized) return;
    handle.finalized = true;

    // Single authoritative terminal path: every outcome (success, worker or
    // verifier failure, cancellation, timeout, disposal, unexpected exit)
    // funnels through here, so the destination reservation can never leak.
    this.releaseTarget(handle);

    if (handle.timeoutTimer) {
      clearTimeout(handle.timeoutTimer);
      handle.timeoutTimer = null;
    }

    if (handle.workerCwdLockFd !== undefined && handle.workerCwdLockFd !== null) {
      try {
        releaseFlock(handle.workerCwdLockFd);
      } catch {
        /* best effort */
      }
      try {
        closeSync(handle.workerCwdLockFd);
      } catch {
        /* best effort */
      }
      handle.workerCwdLockFd = null;
    }

    if (handle.workerCwd) {
      try {
        if (existsSync(handle.workerCwd)) {
          rmSync(handle.workerCwd, { recursive: true, force: true });
        }
      } catch {
        /* best effort */
      }
      handle.workerCwd = null;
    }

    const shouldPreserveReceipt =
      options?.preserveReceipt === true ||
      handle.lastError?.code === "PUBLISHED_UNCONFIRMED" ||
      handle.lastError?.code === "INDETERMINATE" ||
      // Never delete receipt evidence while a non-completed operation's
      // publication role is still unresolved.
      (handle.state !== "completed" &&
        readBackupPublicationReceipt(handle.operationId) !== null);

    if (!shouldPreserveReceipt) {
      removeBackupPublicationReceipt(handle.operationId);
    }

    // Save lightweight public status into recentOperations
    const status = this.toPublicStatus(handle);
    this.recentOperations.set(handle.operationId, status);

    // Bound recentOperations
    if (this.recentOperations.size > this.maxRecentOperations) {
      const oldestKey = this.recentOperations.keys().next().value;
      if (oldestKey) {
        this.recentOperations.delete(oldestKey);
      }
    }

    // Clear heavy resources from handle
    handle.proc = null;
    handle.result = undefined;

    // Remove from activeOperations map
    this.activeOperations.delete(handle.operationId);
  }

  private failOperation(handle: ActiveOperationHandle, err: unknown): void {
    if (handle.finalized) return;
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.releaseTarget(handle);

    const runnerErr =
      err instanceof BackupRunnerError
        ? err
        : new BackupRunnerError(
            (err as Error).message ?? String(err),
            "UNKNOWN_ERROR",
            { operationId: handle.operationId, cause: err },
          );

    // One authoritative settlement path: durable publication evidence wins over
    // a generic supervision failure and is never reported as non-publication.
    this.settleReconciledOutcome(handle, this.durableReconciliation(handle), {
      cause: runnerErr,
      exitCode: -1,
      phase: "supervision_failure",
    });
    this.drainQueue();
  }

  /**
   * Releases exactly the reservation key this operation acquired. The key is
   * captured at submission time and never mutated by a published artifact path,
   * so an auto-named snapshot can report its generated destination without
   * leaving the destination parent locked. Idempotent: a settled operation can
   * never delete a reservation later acquired by another operation.
   */
  private releaseTarget(handle: ActiveOperationHandle): void {
    if (handle.reservationReleased) return;
    handle.reservationReleased = true;
    if (handle.reservationKey) {
      this.activeTargets.delete(handle.reservationKey);
    }
  }

  private updateState(handle: ActiveOperationHandle, state: BackupOperationState): void {
    // A finalized operation's state is authoritative and must never be rewritten.
    if (handle.finalized) return;
    handle.state = state;
    handle.updatedAt = Date.now();
    this.notifyState(handle);
  }

  private notifyState(handle: ActiveOperationHandle): void {
    if (this.onStateChange) {
      try {
        this.onStateChange(this.toPublicStatus(handle));
      } catch {
        /* ignore callback errors */
      }
    }
  }

  private toPublicStatus(handle: ActiveOperationHandle): BackupOperationStatus {
    return {
      operationId: handle.operationId,
      type: handle.type,
      state: handle.state,
      targetPath: handle.targetPath,
      pid: handle.pid,
      stagingDir: handle.stagingDir,
      startedAt: handle.startedAt,
      updatedAt: handle.updatedAt,
      progress: handle.progress,
      error: handle.lastError
        ? {
            code: String(handle.lastError.code),
            message: handle.lastError.message,
            subsystem: handle.lastError.subsystem,
            details: handle.lastError.details as SerializedBackupErrorDetails | undefined,
          }
        : undefined,
    };
  }

  private resolveTargetPath(payload: BackupOperationPayload): string {
    switch (payload.type) {
      case "backup-database":
        return path.resolve(payload.destinationPath);
      case "verify-database":
        return path.resolve(payload.filePath);
      case "create-snapshot":
        return path.resolve(payload.destinationPath ?? payload.snapshotDestinationDir ?? "");
      case "verify-snapshot":
        return path.resolve(payload.snapshotPath);
      case "restore-snapshot":
        return path.resolve(payload.destinationDir);
    }
  }

  private deserializeError(rawError: unknown, operationId: string): BackupRunnerError {
    const error = parseSerializedBackupError(rawError);
    if (!error) {
      return new BackupRunnerError(
        "Worker emitted a malformed or unbounded error payload",
        "INVALID_WORKER_RESPONSE",
        { operationId },
      );
    }
    const code = error.code;
    const message = error.message;
    const details = error.details;

    if (error.subsystem === "backup-core") {
      const cause = new BackupCoreError(message, code as never);
      if (details) Object.assign(cause, { details });
      return new BackupRunnerError(message, code, {
        operationId,
        subsystem: "backup-core",
        details,
        cause,
      });
    }
    if (error.subsystem === "backup-manager") {
      const cause = new BackupManagerError(message, code as never);
      if (details) Object.assign(cause, { details });
      return new BackupRunnerError(message, code, {
        operationId,
        subsystem: "backup-manager",
        details,
        cause,
      });
    }
    if (error.subsystem === "backup-restore") {
      return new BackupRunnerError(message, code, {
        operationId,
        subsystem: "backup-restore",
        details,
        cause: new RestoreError(message, code as never, undefined, details),
      });
    }

    return new BackupRunnerError(message, code, {
      operationId,
      subsystem: error.subsystem,
      details,
    });
  }
}
