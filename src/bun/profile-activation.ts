/**
 * FO-P2-005-A: safe offline profile activation and rollback core.
 *
 * The active profile is selected by exactly one durable mechanism: the
 * `selection.json` pointer in the activation control directory (see
 * `profile-paths.ts`). Activation never renames, copies or mutates a profile,
 * never swaps a symlink and never switches a live process's database. It:
 *
 *   1. prepares a durable journal while the app is still running (read-only
 *      preflight of the candidate, no profile modification);
 *   2. applies/finalises the transition at the next controlled startup, before
 *      any database connection or migration is opened;
 *   3. recovers deterministically from a crash at any journal boundary using
 *      the journal + selection pair;
 *   4. rolls back to the previously active, still-intact profile if startup
 *      validation fails.
 *
 * Every filesystem effect happens under an advisory `flock` transition lock in
 * the control directory, so two processes can never commit a transition at the
 * same time. The journal and selection are written atomically with fsync; both
 * are strictly validated and fail closed when corrupt.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeFileSha256Sync } from "./backup-core.ts";
import { resolveDataDir } from "./data-dir.ts";
import {
  ProfileActivationError,
  sanitizeActivationText,
  type ProfileActivationErrorCode,
} from "./profile-activation-errors.ts";
import {
  ensureActivationControlDir,
  activationControlDir as deriveControlDir,
  acquireTransitionLock,
  buildSelection,
  canonicalizeProfilePath,
  profileIdentityForPath,
  readProfileSelection,
  removeStaleStateTempFiles,
  selectionFilePath,
  writePrivateJsonAtomic,
  detectLiveProfileOwner,
  isAbsoluteProfilePath,
  type ProfileSelection,
} from "./profile-paths.ts";
import {
  inspectCandidateForActivation,
  inspectRollbackTarget,
  pathOverlaps,
  type CandidateInspection,
  type RollbackTargetInspection,
} from "./profile-activation-preflight.ts";
import {
  relinkProject,
  validateProjectRelink,
  ProjectRelinkError,
} from "./project-relink.ts";
import {
  buildRecoveryPreview,
  type RestoreRecoveryPreview,
} from "./backup-restore.ts";
import type { BackupActivationReadiness, ProjectRecoveryInfo } from "../shared/backup.ts";
import type { ProfileActivationRelinkResponse } from "../shared/profile-activation.ts";
import {
  preserveTransitionJournal,
  isTerminalTransitionState,
  parseTransitionJournal,
  readTransitionJournal,
  writeTransitionJournal,
  type CandidateIdentityRecord,
  type ProfileIdentityRecord,
  type TransitionJournal,
  type TransitionState,
} from "./profile-transition-journal.ts";

const MAX_STARTUP_ATTEMPTS = 3;
const ASSET_DIRECTORIES = ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"] as const;
const MAX_ASSET_FILES = 500_000;

/** Test-only deterministic crash injection. Never active outside `bun test`. */
function crashPoint(name: string): void {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env.FORGEORBIT_ACTIVATION_CRASH_POINT !== name) return;
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    /* fall through to exit */
  }
  process.exit(137);
}

function assertAbsoluteProfile(profilePath: string, label: string): string {
  if (!isAbsoluteProfilePath(profilePath)) {
    throw new ProfileActivationError(`${label} must be an absolute path`, "INVALID_INPUT");
  }
  return path.resolve(profilePath);
}

export function isInsideManagedProfiles(
  candidateCanonical: string,
  baseDataDir: string,
  activeDataDir: string,
): boolean {
  const allowedRoots = [
    path.join(path.dirname(path.resolve(baseDataDir)), "managed-profiles"),
    path.join(path.dirname(path.resolve(activeDataDir)), "managed-profiles"),
    path.join(path.resolve(baseDataDir), "managed-profiles"),
    path.join(path.resolve(activeDataDir), "managed-profiles"),
  ];
  for (const root of allowedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalizeProfilePath(root);
    } catch {
      continue;
    }
    const rel = path.relative(canonicalRoot, candidateCanonical);
    if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel.length > 0) {
      return true;
    }
  }
  return false;
}

function selectionMatches(
  selection: ProfileSelection | null,
  profilePath: string,
  transitionId: string,
): boolean {
  if (!selection) return false;
  return (
    selection.transitionId === transitionId &&
    canonicalizeProfilePath(selection.activeProfilePath) === canonicalizeProfilePath(profilePath)
  );
}

interface AssetDigestResult {
  sha256: string;
  files: number;
  bytes: number;
}

/**
 * Digest of the durable profile asset tree. Used to prove that a profile that
 * was not authorized to change (the original profile during activation, or the
 * rollback target) was not modified. Credentials, pid/lock files and the
 * database itself are intentionally out of scope.
 */
export function computeProfileAssetsDigest(profileDir: string): AssetDigestResult {
  const root = canonicalizeProfilePath(profileDir);
  const digest = createHash("sha256");
  let files = 0;
  let bytes = 0;

  const walk = (absoluteDir: string, relativeDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ProfileActivationError("Profile asset directory could not be read", "IO_ERROR");
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(absoluteDir, entry.name);
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        throw new ProfileActivationError("Profile asset could not be inspected", "IO_ERROR");
      }
      if (st.isSymbolicLink()) {
        throw new ProfileActivationError("Profile asset tree contains a symbolic link", "CANDIDATE_SYMLINK");
      }
      if (st.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!st.isFile()) continue;
      files += 1;
      if (files > MAX_ASSET_FILES) {
        throw new ProfileActivationError("Profile has too many asset files to verify", "IO_ERROR");
      }
      let sha: string;
      try {
        sha = computeFileSha256Sync(abs).sha256;
      } catch {
        throw new ProfileActivationError("Profile asset could not be hashed", "IO_ERROR");
      }
      bytes += st.size;
      digest.update(`${rel}\0${st.size}\0${sha}\n`);
    }
  };

  for (const category of ASSET_DIRECTORIES) {
    walk(path.join(root, category), category);
  }
  return { sha256: digest.digest("hex"), files, bytes };
}

function captureProfileIdentity(
  canonicalPath: string,
  options: { includeDatabase: boolean; includeAssets: boolean },
): ProfileIdentityRecord {
  const record: ProfileIdentityRecord = {
    path: canonicalPath,
    identity: profileIdentityForPath(canonicalPath),
    databaseSha256: null,
    databaseBytes: null,
    assetsSha256: null,
  };
  const dbPath = path.join(canonicalPath, "agetor.sqlite");
  let st;
  try {
    st = lstatSync(dbPath);
  } catch {
    st = null;
  }
  if (st && st.isFile() && !st.isSymbolicLink()) {
    record.databaseBytes = st.size;
    if (options.includeDatabase) {
      try {
        record.databaseSha256 = computeFileSha256Sync(dbPath).sha256;
      } catch {
        throw new ProfileActivationError("Profile database could not be hashed", "DATABASE_UNREADABLE");
      }
    }
  }
  if (options.includeAssets) {
    record.assetsSha256 = computeProfileAssetsDigest(canonicalPath).sha256;
  }
  return record;
}

function assertNoLiveDatabaseWriter(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new ProfileActivationError("The previously active profile database is missing", "ACTIVE_PROFILE_MISSING");
  }
  let db: Database;
  try {
    db = new Database(dbPath, { readwrite: true, create: false });
  } catch {
    throw new ProfileActivationError(
      "The previously active profile database is not available for an offline transition",
      "CANDIDATE_LIVE_PROCESS",
    );
  }
  try {
    db.exec("PRAGMA busy_timeout = 500;");
    db.exec("BEGIN EXCLUSIVE;");
    db.exec("ROLLBACK;");
  } catch {
    throw new ProfileActivationError(
      "The previously active profile database is still in use by another process",
      "CANDIDATE_LIVE_PROCESS",
    );
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function assertNoOtherLiveOwner(profileDir: string): void {
  const owner = detectLiveProfileOwner(profileDir, { checkDesktopLock: false });
  if (owner && owner.pid !== process.pid) {
    throw new ProfileActivationError(
      "Another ForgeOrbit process is still using the active profile; quit it before activation",
      "CANDIDATE_LIVE_PROCESS",
    );
  }
}

export interface ActivationPreparation {
  transitionId: string;
  state: TransitionState;
  action: "activate";
  candidatePath: string;
  originalPath: string;
  requestedAt: number;
  requiresRestart: true;
  snapshotId: string | null;
  requiresMigration: boolean;
}

export interface PendingTransitionInfo {
  transitionId: string;
  action: "activate" | "rollback";
  state: TransitionState;
  candidatePath: string;
  originalPath: string;
  requestedAt: number;
  updatedAt: number;
  startupAttempts: number;
  error: { code: string; message: string } | null;
}

export interface ActiveProfileInfo {
  activeDataDir: string;
  baseDataDir: string;
  controlDir: string;
  generation: number | null;
  identity: string | null;
  transitionId: string | null;
  pendingTransition: PendingTransitionInfo | null;
  rollbackAvailable: boolean;
  rollbackTargetPath: string | null;
}

export interface RollbackAvailability {
  available: boolean;
  reason: string | null;
  targetPath: string | null;
  targetIdentity: string | null;
  transitionId: string | null;
}

export interface RollbackPreparation {
  transitionId: string;
  state: TransitionState;
  action: "rollback";
  targetPath: string;
  currentPath: string;
  requestedAt: number;
  requiresRestart: true;
}

export interface StartupProfileResolution {
  baseDataDir: string;
  controlDir: string;
  activeDataDir: string;
  selection: ProfileSelection | null;
  journal: TransitionJournal | null;
  recovered: boolean;
  recoveredFrom: TransitionState | null;
  pendingTransition: PendingTransitionInfo | null;
  warnings: string[];
}

export interface StartupProfileOptions {
  baseDataDir?: string;
  controlDir?: string;
  now?: number;
  lockTimeoutMs?: number;
}

function pendingInfoFromJournal(journal: TransitionJournal | null): PendingTransitionInfo | null {
  if (!journal || isTerminalTransitionState(journal.state)) return null;
  return {
    transitionId: journal.transitionId,
    action: journal.action,
    state: journal.state,
    candidatePath: journal.candidate.path,
    originalPath: journal.original.path,
    requestedAt: journal.requestedAt,
    updatedAt: journal.updatedAt,
    startupAttempts: journal.startupAttempts,
    error: journal.error,
  };
}

function activeResolution(input: {
  baseDataDir: string;
  controlDir: string;
  activeDataDir: string;
  selection: ProfileSelection | null;
  journal: TransitionJournal | null;
  recovered: boolean;
  recoveredFrom: TransitionState | null;
  warnings: string[];
}): StartupProfileResolution {
  return {
    ...input,
    baseDataDir: canonicalizeProfilePath(input.baseDataDir),
    activeDataDir: canonicalizeProfilePath(input.activeDataDir),
    pendingTransition: pendingInfoFromJournal(input.journal),
  };
}

function ensureSelectionForOriginal(input: {
  controlDir: string;
  selection: ProfileSelection | null;
  original: ProfileIdentityRecord;
  transitionId: string;
  now: number;
  journal: TransitionJournal;
}): ProfileSelection {
  if (input.selection && canonicalizeProfilePath(input.selection.activeProfilePath) === input.original.path) {
    return input.selection;
  }
  const next = buildSelection({
    previous: input.selection,
    activeProfilePath: input.original.path,
    activeProfileIdentity: input.original.identity,
    previousProfilePath: input.selection?.activeProfilePath ?? null,
    previousProfileIdentity: input.selection?.activeProfileIdentity ?? null,
    transitionId: input.transitionId,
    now: input.now,
  });
  writePrivateJsonAtomic(selectionFilePath(input.controlDir), next);
  return next;
}

function writeSelection(input: {
  controlDir: string;
  selection: ProfileSelection | null;
  target: { path: string; identity: string };
  transitionId: string;
  now: number;
}): ProfileSelection {
  const next = buildSelection({
    previous: input.selection,
    activeProfilePath: input.target.path,
    activeProfileIdentity: input.target.identity,
    previousProfilePath: input.selection?.activeProfilePath ?? null,
    previousProfileIdentity: input.selection?.activeProfileIdentity ?? null,
    transitionId: input.transitionId,
    now: input.now,
  });
  crashPoint("before_selection_write");
  writePrivateJsonAtomic(selectionFilePath(input.controlDir), next);
  crashPoint("after_selection_update");
  return next;
}

function rollbackTargetFor(journal: TransitionJournal): ProfileIdentityRecord {
  return journal.action === "activate" ? journal.original : journal.candidate;
}

function currentActiveFor(journal: TransitionJournal): ProfileIdentityRecord {
  return journal.action === "activate" ? journal.candidate : journal.original;
}

function failedJournal(
  journal: TransitionJournal,
  code: ProfileActivationErrorCode | string,
  message: string,
  now: number,
  resolved: boolean,
): TransitionJournal {
  return {
    ...journal,
    state: resolved ? "failed" : "rollback_required",
    resolvedAt: resolved ? now : null,
    updatedAt: now,
    error: { code: sanitizeActivationText(String(code), 80) || "UNKNOWN", message: sanitizeActivationText(message) },
  };
}

function terminalSelectionPath(selection: ProfileSelection | null, baseDataDir: string): string {
  return selection?.activeProfilePath ?? baseDataDir;
}

function requireBootableProfile(profilePath: string): void {
  const canonical = canonicalizeProfilePath(profilePath);
  let st;
  try {
    st = lstatSync(canonical);
  } catch {
    throw new ProfileActivationError("The selected active profile no longer exists", "ACTIVE_PROFILE_MISSING");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new ProfileActivationError("The selected active profile is not a real directory", "ACTIVE_PROFILE_MISSING");
  }
  // A directory alone is not a profile. Never let a deleted database be
  // replaced by an empty one just because the selected path still exists.
  try {
    const dbStat = lstatSync(path.join(canonical, "agetor.sqlite"));
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
      throw new ProfileActivationError("The selected active profile database is not a regular file", "DATABASE_MISSING");
    }
  } catch (error) {
    if (error instanceof ProfileActivationError) throw error;
    throw new ProfileActivationError("The selected active profile has no database", "DATABASE_MISSING");
  }
}

/**
 * Resolve (and recover) the active profile during controlled startup. Called by
 * `db.ts` before it opens SQLite or runs migrations. With no control directory
 * this is a pure read that returns the base data directory untouched.
 */
export function resolveStartupProfile(options: StartupProfileOptions = {}): StartupProfileResolution {
  const baseDataDir = canonicalizeProfilePath(options.baseDataDir ?? resolveDataDir());
  const controlDir = options.controlDir ?? deriveControlDir(baseDataDir);
  const now = options.now ?? Date.now();
  const warnings: string[] = [];
  if (!existsSync(controlDir)) {
    return activeResolution({
      baseDataDir,
      controlDir,
      activeDataDir: baseDataDir,
      selection: null,
      journal: null,
      recovered: false,
      recoveredFrom: null,
      warnings,
    });
  }
  ensureActivationControlDir(controlDir, false);
  const lock = acquireTransitionLock(controlDir, options.lockTimeoutMs ?? 5_000);
  try {
    // The lock guarantees no writer is mid-rename; leftovers are only temp
    // siblings from a crashed atomic write, never state evidence.
    removeStaleStateTempFiles(controlDir);
    let selection = readProfileSelection(controlDir);
    let journal = readTransitionJournal(controlDir);
    if (!journal) {
      if (selection && canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(baseDataDir)) {
        throw new ProfileActivationError(
          "The active profile selection has no matching transition journal",
          "SELECTION_WITHOUT_JOURNAL",
        );
      }
      const active = terminalSelectionPath(selection, baseDataDir);
      if (selection) requireBootableProfile(active);
      return activeResolution({
        baseDataDir,
        controlDir,
        activeDataDir: active,
        selection,
        journal: null,
        recovered: false,
        recoveredFrom: null,
        warnings,
      });
    }

    // Reject a selection produced by a different transition: the journal and
    // pointer must never disagree about ownership.
    if (
      selection &&
      selection.transitionId !== journal.transitionId &&
      selection.transitionId !== journal.previousTransitionId
    ) {
      throw new ProfileActivationError(
        "The active profile selection belongs to a different transition",
        "SELECTION_CORRUPT",
      );
    }

    const recoveredFrom = journal.state;
    if (isTerminalTransitionState(journal.state)) {
      if (journal.state === "active") {
        const active = journal.candidate.path;
        if (!selection || canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(active)) {
          throw new ProfileActivationError(
            "The activation journal says active but the selection disagrees",
            "SELECTION_CORRUPT",
          );
        }
        try {
          requireBootableProfile(active);
        } catch (err) {
          // The activated profile disappeared after it was committed. Roll
          // back once to the known-good original rather than bricking startup.
          const failed = failedJournal(
            journal,
            "ACTIVE_PROFILE_MISSING",
            (err as Error).message,
            now,
            false,
          );
          journal = failed;
          writeTransitionJournal(controlDir, journal, now);
          crashPoint("after_rollback_required_journal");
          return performRollback(controlDir, journal, selection, baseDataDir, now, warnings, true);
        }
        return activeResolution({
          baseDataDir,
          controlDir,
          activeDataDir: active,
          selection,
          journal,
          recovered: false,
          recoveredFrom: null,
          warnings,
        });
      }
      if (journal.state === "rolled_back") {
        const active = journal.action === "activate" ? journal.original.path : journal.candidate.path;
        if (!selection || canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(active)) {
          throw new ProfileActivationError(
            "The rolled-back journal says a different profile is active",
            "SELECTION_CORRUPT",
          );
        }
        requireBootableProfile(active);
        return activeResolution({
          baseDataDir,
          controlDir,
          activeDataDir: active,
          selection,
          journal,
          recovered: false,
          recoveredFrom: null,
          warnings,
        });
      }
      // `failed`: selection remains authoritative only if it is still a valid,
      // intact profile. Never open a corrupt profile just because it is named.
      const active = terminalSelectionPath(selection, baseDataDir);
      const bootCheck = inspectRollbackTarget({
        targetPath: active,
        activeDataDir: active,
        allowActiveProfile: true,
      });
      if (!bootCheck.ok) {
        throw new ProfileActivationError(
          bootCheck.message ?? "The selected profile is not bootable after a failed transition",
          bootCheck.code ?? "ACTIVE_PROFILE_MISSING",
        );
      }
      warnings.push("The last profile transition failed; the existing selection is used read-only.");
      return activeResolution({
        baseDataDir,
        controlDir,
        activeDataDir: active,
        selection,
        journal,
        recovered: false,
        recoveredFrom: null,
        warnings,
      });
    }

    if (journal.state === "rollback_required" || journal.state === "rolling_back") {
      return performRollback(controlDir, journal, selection, baseDataDir, now, warnings, true);
    }
    if (journal.action === "rollback") {
      return performRollback(controlDir, journal, selection, baseDataDir, now, warnings, false);
    }
    return performActivation(controlDir, journal, selection, baseDataDir, now, warnings);
  } finally {
    lock.release();
  }
}

function persistJournal(controlDir: string, journal: TransitionJournal, now: number): TransitionJournal {
  const next = { ...journal, updatedAt: now };
  writeTransitionJournal(controlDir, next, now);
  return next;
}

function performActivation(
  controlDir: string,
  initial: TransitionJournal,
  initialSelection: ProfileSelection | null,
  baseDataDir: string,
  now: number,
  warnings: string[],
): StartupProfileResolution {
  let journal = initial;
  let selection = initialSelection;
  const candidate = journal.candidate;
  const original = journal.original;

  const alreadySwitched = selectionMatches(selection, candidate.path, journal.transitionId);

  if (!alreadySwitched) {
    // Nothing has been selected yet. Validate the candidate *before* touching
    // the pointer so a bad candidate never becomes active even briefly.
    assertNoOtherLiveOwner(original.path);
    const candidateInspection = inspectCandidateForActivation({
      candidatePath: candidate.path,
      activeDataDir: original.path,
      baseDataDir,
      controlDir,
      now,
    });
    if (!candidateInspection.ok) {
      const rolled = failedJournal(
        journal,
        candidateInspection.code ?? "NOT_READY",
        candidateInspection.message ?? "Candidate failed activation preflight",
        now,
        false,
      );
      rolled.state = "rolled_back";
      rolled.resolvedAt = now;
      rolled.startupAttempts += 1;
      journal = persistJournal(controlDir, rolled, now);
      selection = ensureSelectionForOriginal({
        controlDir,
        selection,
        original,
        transitionId: journal.transitionId,
        now,
        journal,
      });
      warnings.push("Activation was rejected before any profile selection changed.");
      return activeResolution({
        baseDataDir,
        controlDir,
        activeDataDir: original.path,
        selection,
        journal,
        recovered: true,
        recoveredFrom: initial.state,
        warnings,
      });
    }
    // Activation is only safe if the profile we are leaving can be rolled back
    // to. Validate it now, while it is still the active profile and no writer
    // holds it; a corrupt original must not silently become the fallback.
    const rollbackCandidate = inspectRollbackTarget({
      targetPath: original.path,
      activeDataDir: original.path,
      allowActiveProfile: true,
    });
    if (!rollbackCandidate.ok) {
      const rejected = failedJournal(
        journal,
        rollbackCandidate.code ?? "ROLLBACK_CANDIDATE_INVALID",
        rollbackCandidate.message ?? "The currently active profile cannot be used as a rollback candidate",
        now,
        false,
      );
      rejected.state = "rolled_back";
      rejected.resolvedAt = now;
      rejected.startupAttempts += 1;
      journal = persistJournal(controlDir, rejected, now);
      selection = ensureSelectionForOriginal({
        controlDir,
        selection,
        original,
        transitionId: journal.transitionId,
        now,
        journal,
      });
      warnings.push("Activation was rejected because the currently active profile failed rollback validation.");
      return activeResolution({
        baseDataDir,
        controlDir,
        activeDataDir: original.path,
        selection,
        journal,
        recovered: true,
        recoveredFrom: initial.state,
        warnings,
      });
    }
    // Confirm no writer still holds the old profile before the pointer moves.
    assertNoLiveDatabaseWriter(path.join(original.path, "agetor.sqlite"));
    // Capture the original profile's content identity now, with no writer
    // active, so rollback can prove it was not modified.
    let captured = original;
    if (captured.databaseSha256 === null || captured.assetsSha256 === null) {
      const live = captureProfileIdentity(original.path, { includeDatabase: true, includeAssets: true });
      captured = {
        ...original,
        databaseSha256: captured.databaseSha256 ?? live.databaseSha256,
        databaseBytes: captured.databaseBytes ?? live.databaseBytes,
        assetsSha256: captured.assetsSha256 ?? live.assetsSha256,
      };
    }
    journal = persistJournal(controlDir, { ...journal, original: captured, state: "switching" }, now);
    crashPoint("after_switching_journal");
    selection = writeSelection({
      controlDir,
      selection,
      target: { path: candidate.path, identity: candidate.identity },
      transitionId: journal.transitionId,
      now,
    });
    journal = persistJournal(controlDir, { ...journal, state: "pending_startup_validation" }, now);
    crashPoint("after_pending_journal");
  } else if (journal.state !== "pending_startup_validation") {
    // Recovered after the selection was written but before the journal caught
    // up (or from `switching`): continue from the validation boundary.
    journal = persistJournal(controlDir, { ...journal, state: "pending_startup_validation" }, now);
  }

  // At this point the candidate is selected. Validate it for real before the
  // database is opened, bounded so a crash loop cannot spin forever.
  journal = persistJournal(controlDir, { ...journal, startupAttempts: journal.startupAttempts + 1 }, now);
  if (journal.startupAttempts > MAX_STARTUP_ATTEMPTS) {
    journal = persistJournal(
      controlDir,
      failedJournal(
        journal,
        "ACTIVATION_RETRY_EXHAUSTED",
        "Activation validation kept failing to complete",
        now,
        false,
      ),
      now,
    );
    crashPoint("after_rollback_required_journal");
    return performRollback(controlDir, journal, selection, baseDataDir, now, warnings, true);
  }
  crashPoint("during_startup_validation");
  const validation = inspectCandidateForActivation({
    candidatePath: candidate.path,
    // The candidate is now selected; overlap is checked against the profile it
    // replaced, never against itself.
    activeDataDir: original.path,
    baseDataDir,
    controlDir,
    now,
  });
  if (!validation.ok) {
    journal = persistJournal(
      controlDir,
      failedJournal(
        journal,
        validation.code ?? "NOT_READY",
        validation.message ?? "Candidate failed startup validation",
        now,
        false,
      ),
      now,
    );
    crashPoint("after_rollback_required_journal");
    return performRollback(controlDir, journal, selection, baseDataDir, now, warnings, true);
  }
  journal = {
    ...journal,
    state: "active",
    resolvedAt: now,
    error: null,
    candidate: {
      ...journal.candidate,
      databaseSha256: validation.databaseSha256 ?? journal.candidate.databaseSha256,
      databaseBytes: validation.databaseBytes ?? journal.candidate.databaseBytes,
      recoveryReportSha256: validation.recoveryReportSha256 ?? journal.candidate.recoveryReportSha256,
    },
  };
  journal = persistJournal(controlDir, journal, now);
  crashPoint("after_active_journal");
  return activeResolution({
    baseDataDir,
    controlDir,
    activeDataDir: candidate.path,
    selection,
    journal,
    recovered: true,
    recoveredFrom: initial.state,
    warnings,
  });
}

function performRollback(
  controlDir: string,
  initial: TransitionJournal,
  initialSelection: ProfileSelection | null,
  baseDataDir: string,
  now: number,
  warnings: string[],
  auto: boolean,
): StartupProfileResolution {
  let journal = initial;
  let selection = initialSelection;
  const target = rollbackTargetFor(journal);
  const fallbackActive = currentActiveFor(journal);

  const alreadyRolledBack = selectionMatches(selection, target.path, journal.transitionId);

  if (!alreadyRolledBack) {
    if (!auto) {
      // Explicit rollback: refuse to switch away from the current profile if
      // the current profile has a live writer (another core still owns it).
      try {
        assertNoOtherLiveOwner(fallbackActive.path);
      } catch (err) {
        journal = persistJournal(
          controlDir,
          failedJournal(journal, "CANDIDATE_LIVE_PROCESS", (err as Error).message, now, true),
          now,
        );
        return finishTerminalFailure(controlDir, baseDataDir, journal, selection, warnings);
      }
    }
    const targetInspection = inspectRollbackTarget({
      targetPath: target.path,
      activeDataDir: fallbackActive.path,
      expectedDatabaseSha256: target.databaseSha256,
    });
    if (!targetInspection.ok) {
      const failed = failedJournal(
        journal,
        targetInspection.code ?? "ROLLBACK_CANDIDATE_INVALID",
        targetInspection.message ?? "Rollback target failed validation",
        now,
        true,
      );
      journal = persistJournal(controlDir, failed, now);
      return finishTerminalFailure(controlDir, baseDataDir, journal, selection, warnings);
    }
    if (target.assetsSha256) {
      let actualAssets: string;
      try {
        actualAssets = computeProfileAssetsDigest(target.path).sha256;
      } catch (err) {
        journal = persistJournal(
          controlDir,
          failedJournal(journal, "ROLLBACK_CANDIDATE_INVALID", (err as Error).message, now, true),
          now,
        );
        return finishTerminalFailure(controlDir, baseDataDir, journal, selection, warnings);
      }
      if (actualAssets !== target.assetsSha256) {
        journal = persistJournal(
          controlDir,
          failedJournal(
            journal,
            "PROFILE_CHANGED",
            "The rollback target's durable assets changed since they were recorded",
            now,
            true,
          ),
          now,
        );
        return finishTerminalFailure(controlDir, baseDataDir, journal, selection, warnings);
      }
    }
    journal = persistJournal(controlDir, { ...journal, state: "rolling_back" }, now);
    crashPoint("after_rolling_back_journal");
    selection = writeSelection({
      controlDir,
      selection,
      target: { path: target.path, identity: target.identity },
      transitionId: journal.transitionId,
      now,
    });
    journal = persistJournal(
      controlDir,
      { ...journal, state: "rolled_back", resolvedAt: now },
      now,
    );
    crashPoint("after_rolled_back_journal");
  } else {
    journal = persistJournal(controlDir, { ...journal, state: "rolled_back", resolvedAt: now }, now);
  }
  requireBootableProfile(target.path);
  return activeResolution({
    baseDataDir,
    controlDir,
    activeDataDir: target.path,
    selection,
    journal,
    recovered: true,
    recoveredFrom: initial.state,
    warnings,
  });
}

function finishTerminalFailure(
  controlDir: string,
  baseDataDir: string,
  journal: TransitionJournal,
  selection: ProfileSelection | null,
  warnings: string[],
): StartupProfileResolution {
  // `failed` keeps the current selection authoritative, but only if it is
  // still a valid profile. Never open a missing/invalid profile silently.
  const active = terminalSelectionPath(selection, baseDataDir);
  const inspection = inspectRollbackTarget({
    targetPath: active,
    activeDataDir: active,
    allowActiveProfile: true,
  });
  if (!inspection.ok) {
    throw new ProfileActivationError(
      inspection.message ?? "No bootable profile remains after the failed transition",
      inspection.code ?? "ACTIVE_PROFILE_MISSING",
    );
  }
  warnings.push(`Profile transition failed (${journal.error?.code ?? "UNKNOWN"}); current selection is unchanged.`);
  return activeResolution({
    baseDataDir,
    controlDir,
    activeDataDir: active,
    selection,
    journal,
    recovered: true,
    recoveredFrom: journal.state,
    warnings,
  });
}

export interface ProfileActivationServiceOptions {
  /** Active data directory (already resolved by the caller / startup). */
  activeDataDir: string;
  /** Base data directory used to derive the control directory. */
  baseDataDir?: string;
  controlDir?: string;
  now?: () => number;
  /** True while a backup/restore/verify worker is running in this process. */
  isConflictingOperationRunning?: () => boolean;
}

/**
 * Internal typed backend interface intended for FO-P2-005-B. No HTTP route and
 * no UI control is exposed in this phase; callers must already be inside the
 * trusted backend process.
 */
export class ProfileActivationService {
  readonly activeDataDir: string;
  readonly baseDataDir: string;
  readonly controlDir: string;
  private readonly now: () => number;
  private readonly isConflictingOperationRunning: () => boolean;

  constructor(options: ProfileActivationServiceOptions) {
    this.activeDataDir = assertAbsoluteProfile(options.activeDataDir, "Active data directory");
    this.baseDataDir = assertAbsoluteProfile(options.baseDataDir ?? resolveDataDir(), "Base data directory");
    this.controlDir = options.controlDir ?? deriveControlDir(this.baseDataDir);
    this.now = options.now ?? Date.now;
    this.isConflictingOperationRunning = options.isConflictingOperationRunning ?? (() => false);
  }

  inspectActiveProfile(): ActiveProfileInfo {
    ensureActivationControlDir(this.controlDir, false);
    const selection = readProfileSelection(this.controlDir);
    const journal = readTransitionJournal(this.controlDir);
    const pending = pendingInfoFromJournal(journal);
    const rollback = this.getRollbackAvailability();
    return {
      activeDataDir: selection?.activeProfilePath ?? this.baseDataDir,
      baseDataDir: this.baseDataDir,
      controlDir: this.controlDir,
      generation: selection?.generation ?? null,
      identity: selection?.activeProfileIdentity ?? null,
      transitionId: selection?.transitionId ?? null,
      pendingTransition: pending,
      rollbackAvailable: rollback.available,
      rollbackTargetPath: rollback.targetPath,
    };
  }

  inspectCandidate(candidatePath: string): CandidateInspection {
    const resolved = assertAbsoluteProfile(candidatePath, "Candidate path");
    return inspectCandidateForActivation({
      candidatePath: resolved,
      activeDataDir: this.inspectActiveProfile().activeDataDir,
      baseDataDir: this.baseDataDir,
      controlDir: this.controlDir,
      now: this.now(),
    });
  }

  /**
   * Pre-activation external project relinking inside an inactive managed candidate.
   *
   * Enables the Owner to relink missing external project folders inside an imported,
   * inactive managed profile before activation. Updates database project references,
   * rebinds candidate Brain memory scopes, recalculates candidate database integrity
   * and hashes, and updates candidate recovery records and restore confirmation marker
   * transactionally with full rollback on error.
   */
  relinkCandidateProject(input: {
    candidatePath: string;
    oldPath: string;
    newPath: string;
  }): ProfileActivationRelinkResponse {
    const candidatePath = assertAbsoluteProfile(input?.candidatePath, "Candidate path");
    const canonical = canonicalizeProfilePath(candidatePath);

    if (typeof input?.oldPath !== "string" || !input.oldPath.trim()) {
      throw new ProfileActivationError("oldPath is required", "INVALID_INPUT");
    }
    if (typeof input?.newPath !== "string" || !input.newPath.trim()) {
      throw new ProfileActivationError("newPath is required", "INVALID_INPUT");
    }

    ensureActivationControlDir(this.controlDir, true);
    const lock = acquireTransitionLock(this.controlDir, 0);
    try {
      removeStaleStateTempFiles(this.controlDir);
      if (this.isConflictingOperationRunning()) {
        throw new ProfileActivationError(
          "A backup or restore operation is running; wait for it to finish before relinking candidate projects",
          "CONFLICTING_OPERATION",
        );
      }
      const existingJournal = readTransitionJournal(this.controlDir);
      if (existingJournal && !isTerminalTransitionState(existingJournal.state)) {
        throw new ProfileActivationError(
          "A profile transition is already pending",
          "ACTIVATION_PENDING",
        );
      }

      const activeCanonical = canonicalizeProfilePath(this.activeDataDir);
      const baseCanonical = canonicalizeProfilePath(this.baseDataDir);
      const controlCanonical = canonicalizeProfilePath(this.controlDir);
      if (pathOverlaps(canonical, activeCanonical)) {
        throw new ProfileActivationError("Candidate profile overlaps the currently active profile", "CANDIDATE_ACTIVE");
      }
      if (pathOverlaps(canonical, baseCanonical)) {
        throw new ProfileActivationError("Candidate profile overlaps the base data directory", "CANDIDATE_OVERLAP");
      }
      if (pathOverlaps(canonical, controlCanonical)) {
        throw new ProfileActivationError("Candidate profile overlaps the activation control directory", "CANDIDATE_OVERLAP");
      }

      if (!isInsideManagedProfiles(canonical, this.baseDataDir, this.activeDataDir)) {
        throw new ProfileActivationError(
          "Candidate profile must reside within managed profile storage",
          "CANDIDATE_OUTSIDE_MANAGED",
        );
      }

      let st;
      try {
        st = lstatSync(canonical);
      } catch {
        throw new ProfileActivationError("Candidate profile does not exist", "CANDIDATE_NOT_FOUND");
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ProfileActivationError("Candidate profile is not a real directory", "CANDIDATE_NOT_DIRECTORY");
      }

      const owner = detectLiveProfileOwner(canonical, { checkDesktopLock: true });
      if (owner) {
        throw new ProfileActivationError("Candidate profile is in use by another ForgeOrbit process", "CANDIDATE_LIVE_PROCESS");
      }

      const inspection = inspectCandidateForActivation({
        candidatePath: canonical,
        activeDataDir: this.activeDataDir,
        baseDataDir: this.baseDataDir,
        controlDir: this.controlDir,
        now: this.now(),
      });

      if (!inspection.ok && inspection.code !== "REQUIRES_EXTERNAL_RECOVERY") {
        throw new ProfileActivationError(
          inspection.message ?? "Candidate integrity verification failed",
          inspection.code ?? "DATABASE_INTEGRITY",
        );
      }

      if (inspection.manifestVersion !== 4) {
        throw new ProfileActivationError(
          "Candidate was restored from a legacy manifest and cannot be activated",
          "LEGACY_UNVERIFIED",
        );
      }

      if (!inspection.recoveryReportPath || !inspection.restoreConfirmationPath) {
        throw new ProfileActivationError(
          "Candidate is missing restore provenance records",
          "RESTORE_MARKER_MISSING",
        );
      }

      const dbPath = path.join(canonical, "agetor.sqlite");
      const brainDir = path.join(canonical, "brain");

      const nonce = randomUUID();
      const dbBackup = path.join(canonical, `.agetor.sqlite.relink-${nonce}.tmp`);
      const brainBackup = path.join(canonical, `.brain.relink-${nonce}.tmp`);

      copyFileSync(dbPath, dbBackup);
      if (existsSync(brainDir)) {
        cpSync(brainDir, brainBackup, { recursive: true });
      }

      try {
        const candidateDb = new Database(dbPath, { readwrite: true, create: false });
        let relinkRes: { ok: true; oldPath: string; newPath: string; reboundBrainMemories: number };
        try {
          relinkRes = relinkProject(
            { oldPath: input.oldPath, newPath: input.newPath },
            {
              db: candidateDb,
              dataDir: canonical,
              throwOnBrainError: true,
            },
          );
          candidateDb.run("PRAGMA wal_checkpoint(TRUNCATE);");
          const fkCheck = candidateDb.query("PRAGMA foreign_key_check;").all();
          if (fkCheck.length > 0) {
            throw new ProfileActivationError(
              `Foreign key violation in candidate after relink: ${JSON.stringify(fkCheck)}`,
              "FOREIGN_KEY_VIOLATION",
            );
          }
          const integrityCheck = candidateDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get()?.integrity_check;
          if (integrityCheck !== "ok") {
            throw new ProfileActivationError(
              `Integrity check in candidate failed after relink: ${integrityCheck}`,
              "DATABASE_INTEGRITY",
            );
          }
        } catch (relinkErr) {
          try {
            candidateDb.close();
          } catch {
            /* ignore */
          }
          if (relinkErr instanceof ProfileActivationError) {
            throw relinkErr;
          }
          if (relinkErr instanceof ProjectRelinkError) {
            throw new ProfileActivationError(relinkErr.message, relinkErr.code as ProfileActivationErrorCode);
          }
          const errMsg = relinkErr instanceof Error ? relinkErr.message : String(relinkErr);
          if (errMsg.includes("UNIQUE constraint failed")) {
            throw new ProfileActivationError(errMsg, "PROJECT_CONFLICT");
          }
          if (errMsg.includes("FOREIGN KEY constraint failed")) {
            throw new ProfileActivationError(errMsg, "FOREIGN_KEY_VIOLATION");
          }
          throw relinkErr;
        }

        try {
          candidateDb.close();
        } catch {
          /* ignore */
        }

        const transformedDbSha = computeFileSha256Sync(dbPath).sha256;
        const transformedDbBytes = statSync(dbPath).size;

        const freshPreview = buildRecoveryPreview(dbPath);
        const newReadiness: BackupActivationReadiness =
          freshPreview.totalExternalProjectsRequiringAttention === 0 ? "ready" : "requires-external-recovery";

        const reportPath = inspection.recoveryReportPath;
        const rawReport = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
        rawReport.databaseSha256 = transformedDbSha;
        rawReport.databaseBytes = transformedDbBytes;
        rawReport.databaseTransformed = true;
        rawReport.activationReadiness = newReadiness;
        rawReport.recoveryPreview = freshPreview;
        rawReport.unresolvedExternalReferences = freshPreview.totalExternalProjectsRequiringAttention;
        rawReport.unresolvedExternalDependencies = freshPreview.projects
          .filter((p: ProjectRecoveryInfo) => p.requiresUserIntervention)
          .map((p: ProjectRecoveryInfo) => p.projectPath);
        const relinkRecord = {
          oldPath: relinkRes.oldPath,
          newPath: relinkRes.newPath,
          relinkedAt: this.now(),
          reboundBrainMemories: relinkRes.reboundBrainMemories,
        };
        const priorRelinked = Array.isArray(rawReport.relinkedProjects) ? (rawReport.relinkedProjects as unknown[]) : [];
        rawReport.relinkedProjects = [...priorRelinked, relinkRecord];

        const reportTmp = `${reportPath}.${nonce}.tmp`;
        writeFileSync(reportTmp, JSON.stringify(rawReport, null, 2), { mode: 0o600 });
        renameSync(reportTmp, reportPath);

        const newReportSha = computeFileSha256Sync(reportPath).sha256;

        const confirmationPath = inspection.restoreConfirmationPath;
        const rawConfirmation = JSON.parse(readFileSync(confirmationPath, "utf8")) as Record<string, unknown>;
        rawConfirmation.databaseSha256 = transformedDbSha;
        rawConfirmation.databaseBytes = transformedDbBytes;
        rawConfirmation.recoveryReportSha256 = newReportSha;
        rawConfirmation.relinkedAt = this.now();
        rawConfirmation.destinationPath = canonical;

        const confirmTmp = `${confirmationPath}.${nonce}.tmp`;
        writeFileSync(confirmTmp, JSON.stringify(rawConfirmation, null, 2), { mode: 0o600 });
        renameSync(confirmTmp, confirmationPath);

        const postInspect = inspectCandidateForActivation({
          candidatePath: canonical,
          activeDataDir: this.activeDataDir,
          baseDataDir: this.baseDataDir,
          controlDir: this.controlDir,
          now: this.now(),
        });
        if (!postInspect.ok && postInspect.code !== "REQUIRES_EXTERNAL_RECOVERY") {
          throw new ProfileActivationError(
            postInspect.message ?? "Post-relink candidate integrity verification failed",
            postInspect.code ?? "DATABASE_INTEGRITY",
          );
        }

        try {
          rmSync(dbBackup, { force: true });
        } catch {}
        if (existsSync(brainBackup)) {
          try {
            rmSync(brainBackup, { recursive: true, force: true });
          } catch {}
        }

        return {
          ok: true,
          candidatePath: canonical,
          oldPath: relinkRes.oldPath,
          newPath: relinkRes.newPath,
          reboundBrainMemories: relinkRes.reboundBrainMemories,
          readiness: newReadiness,
          totalExternalProjectsRequiringAttention: freshPreview.totalExternalProjectsRequiringAttention,
          recoveryPreview: freshPreview,
        };
      } catch (err) {
        try {
          copyFileSync(dbBackup, dbPath);
          rmSync(dbBackup, { force: true });
          rmSync(`${dbPath}-wal`, { force: true });
          rmSync(`${dbPath}-shm`, { force: true });
        } catch {}
        if (existsSync(brainBackup)) {
          try {
            rmSync(brainDir, { recursive: true, force: true });
            cpSync(brainBackup, brainDir, { recursive: true });
            rmSync(brainBackup, { recursive: true, force: true });
          } catch {}
        }
        throw err;
      }
    } finally {
      lock.release();
    }
  }

  getPendingTransition(): PendingTransitionInfo | null {
    ensureActivationControlDir(this.controlDir, false);
    return pendingInfoFromJournal(readTransitionJournal(this.controlDir));
  }

  /**
   * Persist an explicit activation request. This never modifies either profile
   * and never changes the selection: the transition is applied by
   * {@link resolveStartupProfile} during the next controlled startup.
   */
  prepareActivation(input: { candidatePath: string }): ActivationPreparation {
    const candidatePath = assertAbsoluteProfile(input?.candidatePath, "Candidate path");
    ensureActivationControlDir(this.controlDir, true);
    const lock = acquireTransitionLock(this.controlDir, 0);
    try {
      removeStaleStateTempFiles(this.controlDir);
      if (this.isConflictingOperationRunning()) {
        throw new ProfileActivationError(
          "A backup or restore operation is running; wait for it to finish before activating a profile",
          "CONFLICTING_OPERATION",
        );
      }
      const existing = readTransitionJournal(this.controlDir);
      if (existing && !isTerminalTransitionState(existing.state)) {
        throw new ProfileActivationError(
          "A profile transition is already pending",
          "ACTIVATION_PENDING",
        );
      }
      const selection = readProfileSelection(this.controlDir);
      const activePath = selection?.activeProfilePath ?? this.baseDataDir;
      const inspection = inspectCandidateForActivation({
        candidatePath,
        activeDataDir: activePath,
        baseDataDir: this.baseDataDir,
        controlDir: this.controlDir,
        now: this.now(),
      });
      if (!inspection.ok || !inspection.canonicalPath) {
        throw new ProfileActivationError(
          inspection.message ?? "Candidate profile is not eligible for activation",
          inspection.code ?? "NOT_READY",
        );
      }
      const now = this.now();
      const originalIdentity = captureProfileIdentity(canonicalizeProfilePath(activePath), {
        includeDatabase: false,
        includeAssets: false,
      });
      const candidateIdentity: CandidateIdentityRecord = {
        path: inspection.canonicalPath,
        identity: profileIdentityForPath(inspection.canonicalPath),
        databaseSha256: inspection.databaseSha256,
        databaseBytes: inspection.databaseBytes,
        assetsSha256: null,
        snapshotId: inspection.snapshotId,
        recoveryReportPath: inspection.recoveryReportPath,
        recoveryReportSha256: inspection.recoveryReportSha256,
        manifestVersion: inspection.manifestVersion,
        readiness: inspection.readiness,
      };
      if (existing) preserveTransitionJournal(this.controlDir, existing);
      const journal: TransitionJournal = {
        version: 1,
        transitionId: randomUUID(),
        previousTransitionId: existing?.transitionId ?? null,
        action: "activate",
        state: "prepared",
        requestedAt: now,
        updatedAt: now,
        resolvedAt: null,
        original: originalIdentity,
        candidate: candidateIdentity,
        previousSelection: selection
          ? {
              activeProfilePath: selection.activeProfilePath,
              activeProfileIdentity: selection.activeProfileIdentity,
              generation: selection.generation,
            }
          : null,
        startupAttempts: 0,
        error: null,
      };
      crashPoint("before_prepare_journal");
      writeTransitionJournal(this.controlDir, journal, now);
      crashPoint("after_prepare_journal");
      return {
        transitionId: journal.transitionId,
        state: journal.state,
        action: "activate",
        candidatePath: candidateIdentity.path,
        originalPath: originalIdentity.path,
        requestedAt: now,
        requiresRestart: true,
        snapshotId: candidateIdentity.snapshotId,
        requiresMigration: inspection.pendingMigrationCount > 0,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Persist an explicit rollback request to the previously active profile.
   * The rollback target is validated and hashed now (it is inactive); the
   * selection is changed only at the next controlled startup.
   */
  requestRollback(): RollbackPreparation {
    ensureActivationControlDir(this.controlDir, true);
    const lock = acquireTransitionLock(this.controlDir, 0);
    try {
      removeStaleStateTempFiles(this.controlDir);
      if (this.isConflictingOperationRunning()) {
        throw new ProfileActivationError(
          "A backup or restore operation is running; wait for it to finish before rolling back",
          "CONFLICTING_OPERATION",
        );
      }
      const existing = readTransitionJournal(this.controlDir);
      if (!existing) {
        throw new ProfileActivationError("There is no activated profile to roll back from", "ROLLBACK_NOT_AVAILABLE");
      }
      if (!isTerminalTransitionState(existing.state)) {
        throw new ProfileActivationError("A profile transition is already pending", "ACTIVATION_PENDING");
      }
      if (existing.action !== "activate" || existing.state !== "active") {
        throw new ProfileActivationError(
          "The current profile was not activated by this core; rollback is unavailable",
          "ROLLBACK_NOT_AVAILABLE",
        );
      }
      const selection = readProfileSelection(this.controlDir);
      if (!selection || canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(existing.candidate.path)) {
        throw new ProfileActivationError("Active profile selection is inconsistent", "SELECTION_CORRUPT");
      }
      const targetPath = existing.original.path;
      const inspection = inspectRollbackTarget({
        targetPath,
        activeDataDir: selection.activeProfilePath,
      });
      if (!inspection.ok || !inspection.canonicalPath) {
        throw new ProfileActivationError(
          inspection.message ?? "Rollback target failed validation",
          inspection.code ?? "ROLLBACK_CANDIDATE_INVALID",
        );
      }
      const now = this.now();
      const capturedTarget = captureProfileIdentity(inspection.canonicalPath, {
        includeDatabase: true,
        includeAssets: true,
      });
      if (capturedTarget.databaseSha256 !== inspection.databaseSha256) {
        throw new ProfileActivationError(
          "Rollback target changed while it was being validated",
          "PROFILE_CHANGED",
        );
      }
      const currentIdentity: ProfileIdentityRecord = {
        path: canonicalizeProfilePath(selection.activeProfilePath),
        identity: selection.activeProfileIdentity,
        databaseSha256: existing.candidate.databaseSha256,
        databaseBytes: existing.candidate.databaseBytes,
        assetsSha256: null,
      };
      preserveTransitionJournal(this.controlDir, existing);
      const journal: TransitionJournal = {
        version: 1,
        transitionId: randomUUID(),
        previousTransitionId: existing.transitionId,
        action: "rollback",
        state: "prepared",
        requestedAt: now,
        updatedAt: now,
        resolvedAt: null,
        original: currentIdentity,
        candidate: {
          ...capturedTarget,
          snapshotId: null,
          recoveryReportPath: null,
          recoveryReportSha256: null,
          manifestVersion: null,
          readiness: null,
        },
        previousSelection: {
          activeProfilePath: selection.activeProfilePath,
          activeProfileIdentity: selection.activeProfileIdentity,
          generation: selection.generation,
        },
        startupAttempts: 0,
        error: null,
      };
      crashPoint("before_rollback_prepare_journal");
      writeTransitionJournal(this.controlDir, journal, now);
      crashPoint("after_rollback_prepare_journal");
      return {
        transitionId: journal.transitionId,
        state: journal.state,
        action: "rollback",
        targetPath: capturedTarget.path,
        currentPath: currentIdentity.path,
        requestedAt: now,
        requiresRestart: true,
      };
    } finally {
      lock.release();
    }
  }

  getRollbackAvailability(): RollbackAvailability {
    ensureActivationControlDir(this.controlDir, false);
    const journal = readTransitionJournal(this.controlDir);
    const selection = readProfileSelection(this.controlDir);
    if (!journal) {
      return { available: false, reason: "No profile activation has been performed", targetPath: null, targetIdentity: null, transitionId: null };
    }
    if (!isTerminalTransitionState(journal.state)) {
      return {
        available: false,
        reason: "A profile transition is pending; rollback becomes available after it resolves",
        targetPath: null,
        targetIdentity: null,
        transitionId: journal.transitionId,
      };
    }
    if (journal.action !== "activate" || journal.state !== "active") {
      return {
        available: false,
        reason: journal.state === "rolled_back" ? "The previous activation was already rolled back" : "No rollback target is available",
        targetPath: null,
        targetIdentity: null,
        transitionId: journal.transitionId,
      };
    }
    if (!selection || canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(journal.candidate.path)) {
      return {
        available: false,
        reason: "Active profile selection is inconsistent",
        targetPath: null,
        targetIdentity: null,
        transitionId: journal.transitionId,
      };
    }
    return {
      available: true,
      reason: null,
      targetPath: journal.original.path,
      targetIdentity: journal.original.identity,
      transitionId: journal.transitionId,
    };
  }
}

/**
 * Record a database-open or migration failure for the in-flight transition so
 * the next startup rolls back deterministically instead of reopening a broken
 * profile forever. Best-effort: never masks the original boot error.
 */
export function markProfileStartupFailure(error: unknown, options: { baseDataDir?: string } = {}): void {
  let baseDataDir: string;
  try {
    baseDataDir = options.baseDataDir ?? resolveDataDir();
  } catch {
    return;
  }
  const controlDir = deriveControlDir(baseDataDir);
  if (!existsSync(controlDir)) return;
  let lock: ReturnType<typeof acquireTransitionLock> | null = null;
  try {
    lock = acquireTransitionLock(controlDir, 1_000);
    const selection = readProfileSelection(controlDir);
    const journal = readTransitionJournal(controlDir);
    if (!journal || isTerminalTransitionState(journal.state)) return;
    if (journal.action !== "activate") return;
    if (!selection || selection.transitionId !== journal.transitionId) return;
    const now = Date.now();
    const code = (error as { code?: unknown } | null)?.code;
    const failed = failedJournal(
      journal,
      typeof code === "string" ? sanitizeActivationText(code, 80) : "DATABASE_OPEN_FAILED",
      `The activated profile could not be opened: ${sanitizeActivationText(error)}`,
      now,
      false,
    );
    writeTransitionJournal(controlDir, failed, now);
  } catch {
    /* never mask the boot failure */
  } finally {
    lock?.release();
  }
}

export type { ProfileSelection, TransitionJournal, TransitionState, ProfileActivationErrorCode };
