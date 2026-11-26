/**
 * FO-P2-005-A: trusted activation preflight.
 *
 * A candidate is only accepted when it is a real, privately-owned directory
 * produced by the supported inactive-restore workflow and its database and
 * durable assets still verify. Recovery metadata is never trusted on its own:
 * the database digest, integrity, foreign keys, schema subset, internal asset
 * references and readiness are all recomputed here.
 *
 * The preflight is read-only. It opens the candidate database with
 * `readonly: true`; it never creates, migrates, rebinds or writes the
 * candidate or the active profile, and it never reads credential files.
 */

import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CORE_STAGING_SCAN_RE,
  RESTORE_CONFIRMATION_FILENAME,
  RESTORE_RECOVERY_FILENAME,
  RESTORE_STAGING_SCAN_RE,
  SNAPSHOT_STAGING_SCAN_RE,
  STAGING_LOCK_FILENAME,
  STAGING_METADATA_FILENAME,
  computeFileSha256Sync,
  releaseFlock,
  tryAcquireFlock,
} from "./backup-core.ts";
import {
  buildRecoveryPreview,
  type RestoreRecoveryPreview,
} from "./backup-restore.ts";
import {
  getReferencedInternalAssets,
  isForgeOrbitProfileDirectory,
} from "./backup-manager.ts";
import { migrations } from "./migrations/index.ts";
import type { BackupActivationReadiness } from "../shared/backup.ts";
import {
  ProfileActivationError,
  sanitizeActivationText,
  type ProfileActivationErrorCode,
} from "./profile-activation-errors.ts";
import {
  canonicalizeProfilePath,
  detectLiveProfileOwner,
  isAbsoluteProfilePath,
  isSha256Hex,
  profileIdentityForPath,
} from "./profile-paths.ts";

export const RECOVERY_REPORT_FILENAME = RESTORE_RECOVERY_FILENAME;
export { RESTORE_CONFIRMATION_FILENAME };
const MAX_RECOVERY_REPORT_BYTES = 1024 * 1024;
const MAX_RESTORE_CONFIRMATION_BYTES = 16 * 1024;
const MAX_READINESS_ARRAY_ENTRIES = 4_000;
const MAX_KNOWN_FUTURE_SKEW_MS = 5 * 60 * 1000;

const READINESS_VALUES: readonly BackupActivationReadiness[] = [
  "ready",
  "requires-reference-repair",
  "requires-external-recovery",
  "legacy-unverified",
  "not-ready",
];

export interface CandidateCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface CandidateInspection {
  ok: boolean;
  code: ProfileActivationErrorCode | null;
  message: string | null;
  candidatePath: string;
  canonicalPath: string | null;
  snapshotId: string | null;
  manifestVersion: number | null;
  appVersion: string | null;
  readiness: BackupActivationReadiness | null;
  databaseSha256: string | null;
  databaseBytes: number | null;
  recoveryReportPath: string | null;
  recoveryReportSha256: string | null;
  restoreConfirmationPath: string | null;
  pendingMigrationCount: number;
  recoveryPreview?: RestoreRecoveryPreview | null;
  checks: CandidateCheck[];
  warnings: string[];
}

interface RecoveryReport {
  snapshotId: string;
  manifestVersion: number;
  appVersion: string | null;
  restoredAt: number;
  runnerOperationId: string;
  databaseSha256: string;
  databaseBytes: number | null;
  databaseTransformed: boolean | null;
  activationReadiness: BackupActivationReadiness;
  unresolvedCrossProfileReferences: number;
  crossProfileDependencies: string[];
  unresolvedExternalReferences: number;
  unresolvedExternalDependencies: string[];
  internalReferencesUnresolved: number;
  rebindingUnresolved: number;
  recoveryPreview: { totalExternalProjectsRequiringAttention: number };
  raw: Record<string, unknown>;
}

interface RestoreConfirmation {
  snapshotId: string;
  runnerOperationId: string;
  databaseSha256: string;
  databaseBytes: number;
  recoveryReportSha256: string;
  confirmedAt: number;
  destinationPath: string;
}

function boundedStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_READINESS_ARRAY_ENTRIES) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 1_024) return null;
    out.push(entry);
  }
  return out;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readBoundedPrivateJson(file: string, maxBytes: number): Record<string, unknown> {
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProfileActivationError("Required profile file is missing", "IO_ERROR");
    }
    throw new ProfileActivationError("Required profile file is unreadable", "IO_ERROR");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ProfileActivationError("Required profile file is not a regular file", "CANDIDATE_SYMLINK");
  }
  if (st.size > maxBytes) {
    throw new ProfileActivationError("Required profile file exceeds its maximum size", "RECOVERY_REPORT_INVALID");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) {
    throw new ProfileActivationError("Required profile file is owned by another user", "CANDIDATE_OWNERSHIP");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ProfileActivationError(
      "Required profile file must not be accessible by other users",
      "CANDIDATE_PERMISSIONS",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ProfileActivationError("Required profile file is not valid JSON", "RECOVERY_REPORT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileActivationError("Required profile file is not a JSON object", "RECOVERY_REPORT_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function parseRecoveryReport(raw: Record<string, unknown>): RecoveryReport {
  const snapshotId = raw.snapshotId;
  const manifestVersion = raw.manifestVersion;
  const restoredAt = raw.restoredAt;
  const runnerOperationId = raw.runnerOperationId;
  const databaseSha256 = raw.databaseSha256;
  if (
    typeof snapshotId !== "string" ||
    snapshotId.length === 0 ||
    snapshotId.length > 200 ||
    typeof manifestVersion !== "number" ||
    !Number.isSafeInteger(manifestVersion) ||
    manifestVersion < 1 ||
    manifestVersion > 100 ||
    typeof restoredAt !== "number" ||
    !Number.isSafeInteger(restoredAt) ||
    restoredAt < 0 ||
    typeof runnerOperationId !== "string" ||
    runnerOperationId.length === 0 ||
    runnerOperationId.length > 200 ||
    !isSha256Hex(databaseSha256)
  ) {
    throw new ProfileActivationError("Recovery report is structurally invalid", "RECOVERY_REPORT_INVALID");
  }
  if (
    typeof raw.activationReadiness !== "string" ||
    !READINESS_VALUES.includes(raw.activationReadiness as BackupActivationReadiness)
  ) {
    throw new ProfileActivationError("Recovery report readiness is invalid", "RECOVERY_REPORT_INVALID");
  }
  const cross = nonNegativeInt(raw.unresolvedCrossProfileReferences);
  const external = nonNegativeInt(raw.unresolvedExternalReferences);
  const internal = nonNegativeInt(raw.internalReferencesUnresolved) ?? 0;
  const crossDeps = boundedStringArray(raw.crossProfileDependencies);
  const externalDeps = boundedStringArray(raw.unresolvedExternalDependencies);
  const preview = raw.recoveryPreview;
  if (
    cross === null ||
    external === null ||
    crossDeps === null ||
    externalDeps === null ||
    !preview ||
    typeof preview !== "object" ||
    Array.isArray(preview)
  ) {
    throw new ProfileActivationError("Recovery report is structurally invalid", "RECOVERY_REPORT_INVALID");
  }
  const previewRecord = preview as Record<string, unknown>;
  const externalAttention = nonNegativeInt(previewRecord.totalExternalProjectsRequiringAttention);
  if (
    externalAttention === null ||
    !Array.isArray(previewRecord.projects) ||
    !Array.isArray(previewRecord.worktrees) ||
    !Array.isArray(previewRecord.environmentProfiles) ||
    !Array.isArray(previewRecord.providerAuth)
  ) {
    throw new ProfileActivationError("Recovery report preview is structurally invalid", "RECOVERY_REPORT_INVALID");
  }
  let rebindingUnresolved = 0;
  if (raw.rebindingStats !== undefined) {
    const stats = raw.rebindingStats;
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
      throw new ProfileActivationError("Recovery report rebinding statistics are invalid", "RECOVERY_REPORT_INVALID");
    }
    const unresolved = nonNegativeInt((stats as Record<string, unknown>).unresolved);
    if (unresolved === null) {
      throw new ProfileActivationError("Recovery report rebinding statistics are invalid", "RECOVERY_REPORT_INVALID");
    }
    rebindingUnresolved = unresolved;
  }
  let appVersion: string | null = null;
  if (raw.appVersion !== undefined) {
    if (typeof raw.appVersion !== "string" || raw.appVersion.length > 200) {
      throw new ProfileActivationError("Recovery report application version is invalid", "RECOVERY_REPORT_INVALID");
    }
    appVersion = raw.appVersion;
  }
  const databaseBytes = nonNegativeInt(raw.databaseBytes);
  let databaseTransformed: boolean | null = null;
  if (raw.databaseTransformed !== undefined) {
    if (typeof raw.databaseTransformed !== "boolean") {
      throw new ProfileActivationError("Recovery report transform flag is invalid", "RECOVERY_REPORT_INVALID");
    }
    databaseTransformed = raw.databaseTransformed;
  }
  return {
    snapshotId,
    manifestVersion,
    appVersion,
    restoredAt,
    runnerOperationId,
    databaseSha256,
    databaseBytes,
    databaseTransformed,
    activationReadiness: raw.activationReadiness as BackupActivationReadiness,
    unresolvedCrossProfileReferences: cross,
    crossProfileDependencies: crossDeps,
    unresolvedExternalReferences: external,
    unresolvedExternalDependencies: externalDeps,
    internalReferencesUnresolved: internal,
    rebindingUnresolved,
    recoveryPreview: { totalExternalProjectsRequiringAttention: externalAttention },
    raw,
  };
}

function parseRestoreConfirmation(raw: Record<string, unknown>): RestoreConfirmation {
  if (raw.version !== 1) {
    throw new ProfileActivationError("Restore confirmation marker version is invalid", "RESTORE_MARKER_INVALID");
  }
  const snapshotId = raw.snapshotId;
  const runnerOperationId = raw.runnerOperationId;
  const databaseSha256 = raw.databaseSha256;
  const databaseBytes = nonNegativeInt(raw.databaseBytes);
  const recoveryReportSha256 = raw.recoveryReportSha256;
  const confirmedAt = nonNegativeInt(raw.confirmedAt);
  const destinationPath = raw.destinationPath;
  if (
    typeof snapshotId !== "string" ||
    snapshotId.length === 0 ||
    snapshotId.length > 200 ||
    typeof runnerOperationId !== "string" ||
    runnerOperationId.length === 0 ||
    runnerOperationId.length > 200 ||
    !isSha256Hex(databaseSha256) ||
    databaseBytes === null ||
    !isSha256Hex(recoveryReportSha256) ||
    confirmedAt === null ||
    !isAbsoluteProfilePath(destinationPath)
  ) {
    throw new ProfileActivationError("Restore confirmation marker is structurally invalid", "RESTORE_MARKER_INVALID");
  }
  return { snapshotId, runnerOperationId, databaseSha256, databaseBytes, recoveryReportSha256, confirmedAt, destinationPath };
}

/**
 * Open an inactive profile database for verification.
 *
 * Read-only first (WAL is not touched). Some legitimate WAL profiles cannot be
 * opened read-only without a `-shm` file; in that case retry read-write without
 * CREATE so the check works offline without ever creating a profile.
 */
function openInactiveDatabase(dbPath: string): Database {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (readonlyError) {
    try {
      return new Database(dbPath, { readwrite: true, create: false });
    } catch {
      throw readonlyError;
    }
  }
}

function checkDatabaseIntegrity(db: Database): string | null {
  try {
    const rows = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").all();
    const values = rows.map((row) => String(row.integrity_check));
    if (values.length !== 1 || values[0] !== "ok") {
      return sanitizeActivationText(values.join("; "), 240) || "integrity check failed";
    }
    return null;
  } catch {
    return "integrity check could not be executed";
  }
}

function checkForeignKeys(db: Database): number | null {
  try {
    const rows = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check;").all();
    return rows.length;
  } catch {
    return null;
  }
}

interface SchemaCheck {
  compatible: boolean;
  newer: boolean;
  missingCoreTables: string[];
  pending: number;
  detail: string;
}

function checkSchema(db: Database): SchemaCheck {
  const tables = new Set(
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table';").all().map((row) => row.name),
  );
  const missingCoreTables = ["_migrations", "tasks", "preferences"].filter((table) => !tables.has(table));
  if (missingCoreTables.length > 0) {
    return { compatible: false, newer: false, missingCoreTables, pending: 0, detail: `missing ${missingCoreTables.join(", ")}` };
  }
  const appliedIds = new Set(
    db.query<{ id: string }, []>("SELECT id FROM _migrations;").all().map((row) => row.id),
  );
  const known = new Map<string, number>();
  migrations.forEach((migration, index) => {
    known.set(migration.id, index);
    for (const alias of migration.aliases ?? []) known.set(alias, index);
  });
  const unknown: string[] = [];
  for (const id of appliedIds) {
    if (!known.has(id)) unknown.push(id);
  }
  if (unknown.length > 0) {
    return {
      compatible: false,
      newer: true,
      missingCoreTables: [],
      pending: 0,
      detail: sanitizeActivationText(unknown.join(", "), 240),
    };
  }
  const appliedIndexes = new Set<number>();
  for (const id of appliedIds) {
    const index = known.get(id);
    if (index !== undefined) appliedIndexes.add(index);
  }
  let pending = 0;
  migrations.forEach((migration, index) => {
    const applied = appliedIndexes.has(index) || appliedIds.has(migration.id);
    if (!applied) pending += 1;
  });
  return { compatible: true, newer: false, missingCoreTables: [], pending, detail: "" };
}

function checkKnowledgeConsistency(db: Database, profileDir: string): number {
  const tables = new Set(
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table';").all().map((row) => row.name),
  );
  if (!tables.has("knowledge_documents")) return 0;
  const documentCount =
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM knowledge_documents;").get()?.count ?? 0;
  if (documentCount > 0 && !tables.has("knowledge_revisions")) return 1;
  if (!tables.has("knowledge_revisions")) return 0;
  const rows = db.query<
    { document_id: string; revision: number; byte_length: number; content_sha256: string },
    []
  >("SELECT document_id, revision, byte_length, content_sha256 FROM knowledge_revisions;").all();
  let missing = 0;
  for (const row of rows) {
    if (
      typeof row.document_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.document_id) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    ) {
      missing += 1;
      continue;
    }
    const file = path.join(profileDir, "knowledge", "bodies", row.document_id, `${row.revision}.md`);
    let st;
    try {
      st = lstatSync(file);
    } catch {
      missing += 1;
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size !== row.byte_length) {
      missing += 1;
      continue;
    }
    try {
      const sha = computeFileSha256Sync(file).sha256;
      if (sha !== row.content_sha256) missing += 1;
    } catch {
      missing += 1;
    }
  }
  return missing;
}

function safeRelativeReference(value: string): string | null {
  if (!value || value.length > 4_096 || value.includes("\0") || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === ".." || part === ".")) return null;
  return normalized;
}

function checkReferencedAssets(db: Database, profileDir: string): {
  missing: number;
  crossProfile: number;
  unresolvedExternal: number;
} {
  const scanned = getReferencedInternalAssets(db, {
    dataDir: profileDir,
    canonicalDataDir: profileDir,
    attachmentsRootDir: path.join(profileDir, "attachments"),
    screenshotsRootDir: path.join(profileDir, "screenshots"),
    issueThreadsRootDir: path.join(profileDir, "issue-threads"),
    pipelineRunsRootDir: path.join(profileDir, "pipeline-runs"),
  });
  let missing = 0;
  const sets: Array<Set<string>> = [
    scanned.attachments,
    scanned.screenshots,
    scanned.issueThreads,
    scanned.pipelineRuns,
  ];
  for (const entries of sets) {
    for (const entry of entries) {
      const rel = safeRelativeReference(entry);
      if (!rel) {
        missing += 1;
        continue;
      }
      const file = path.join(profileDir, rel);
      let st;
      try {
        st = lstatSync(file);
      } catch {
        missing += 1;
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) missing += 1;
    }
  }
  return {
    missing,
    crossProfile: scanned.crossProfileReferences?.length ?? 0,
    unresolvedExternal: scanned.unresolvedExternalReferences?.length ?? 0,
  };
}

function stagingOperationIsActive(directory: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(directory) as string[];
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (
      !CORE_STAGING_SCAN_RE.test(entry) &&
      !SNAPSHOT_STAGING_SCAN_RE.test(entry) &&
      !RESTORE_STAGING_SCAN_RE.test(entry)
    ) {
      continue;
    }
    const full = path.join(directory, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const lockPath = path.join(full, STAGING_LOCK_FILENAME);
    let fd: number | null = null;
    let acquired = false;
    try {
      fd = openSync(lockPath, 0);
    } catch {
      continue;
    }
    try {
      acquired = tryAcquireFlock(fd);
    } catch {
      acquired = false;
    } finally {
      try {
        if (acquired) releaseFlock(fd);
      } catch {
        /* ignore */
      }
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (!acquired) return true;
  }
  return false;
}

function ancestryConflict(candidate: string): string | null {
  // Narrow on purpose: an ancestor that actually contains a ForgeOrbit
  // database is a foreign profile. A directory whose *name* merely looks like
  // a profile (restores folder, "ForgeOrbit Backups", ...) is not.
  const parent = path.dirname(candidate);
  if (parent === candidate) return null;
  let current = parent;
  for (let depth = 0; depth < 64; depth += 1) {
    if (isForgeOrbitProfileDirectory(current) && existsSync(path.join(current, "agetor.sqlite"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return null;
}

export function pathOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const relAB = path.relative(a, b);
  const relBA = path.relative(b, a);
  const inside = (rel: string) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  return inside(relAB) || inside(relBA);
}

class InspectionFailure extends Error {
  constructor(
    readonly code: ProfileActivationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface InspectCandidateOptions {
  candidatePath: string;
  activeDataDir: string;
  baseDataDir: string;
  controlDir: string;
  now?: number;
  requireRestoreConfirmation?: boolean;
}

/**
 * Run the full trusted preflight. Returns a structured rejection instead of
 * throwing for expected candidate problems; only programmer errors throw.
 */
export function inspectCandidateForActivation(options: InspectCandidateOptions): CandidateInspection {
  const checks: CandidateCheck[] = [];
  const warnings: string[] = [];
  const now = options.now ?? Date.now();
  const candidatePath = typeof options.candidatePath === "string" ? path.resolve(options.candidatePath) : "";
  const result: CandidateInspection = {
    ok: false,
    code: null,
    message: null,
    candidatePath,
    canonicalPath: null,
    snapshotId: null,
    manifestVersion: null,
    appVersion: null,
    readiness: null,
    databaseSha256: null,
    databaseBytes: null,
    recoveryReportPath: null,
    recoveryReportSha256: null,
    restoreConfirmationPath: null,
    pendingMigrationCount: 0,
    recoveryPreview: null,
    checks,
    warnings,
  };
  const fail = (code: ProfileActivationErrorCode, message: string): CandidateInspection => {
    result.ok = false;
    result.code = code;
    result.message = sanitizeActivationText(message);
    checks.push({ id: `fail:${code}`, ok: false, detail: result.message });
    return result;
  };
  const pass = (id: string, detail?: string) => {
    checks.push(detail ? { id, ok: true, detail: sanitizeActivationText(detail) } : { id, ok: true });
  };

  try {
    if (!isAbsoluteProfilePath(candidatePath)) {
      throw new InspectionFailure("CANDIDATE_NOT_FOUND", "Candidate path must be absolute");
    }
    let st;
    try {
      st = lstatSync(candidatePath);
    } catch {
      throw new InspectionFailure("CANDIDATE_NOT_FOUND", "Candidate profile does not exist");
    }
    if (st.isSymbolicLink()) {
      throw new InspectionFailure("CANDIDATE_SYMLINK", "Candidate profile must not be a symbolic link");
    }
    if (!st.isDirectory()) {
      throw new InspectionFailure("CANDIDATE_NOT_DIRECTORY", "Candidate profile is not a directory");
    }
    pass("candidate-real-directory");
    const canonical = canonicalizeProfilePath(candidatePath);
    result.canonicalPath = canonical;
    const canonicalStat = lstatSync(canonical);
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
      throw new InspectionFailure("CANDIDATE_SYMLINK", "Candidate profile canonical path is not a real directory");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && canonicalStat.uid !== uid) {
      throw new InspectionFailure("CANDIDATE_OWNERSHIP", "Candidate profile is owned by another user");
    }
    if ((canonicalStat.mode & 0o077) !== 0) {
      throw new InspectionFailure(
        "CANDIDATE_PERMISSIONS",
        "Candidate profile must not be accessible by other users",
      );
    }
    if ((canonicalStat.mode & 0o700) !== 0o700) {
      throw new InspectionFailure("CANDIDATE_PERMISSIONS", "Candidate profile permissions are too restrictive to own");
    }
    pass("candidate-private-ownership");

    const activeCanonical = canonicalizeProfilePath(options.activeDataDir);
    const baseCanonical = canonicalizeProfilePath(options.baseDataDir);
    if (pathOverlaps(canonical, activeCanonical)) {
      throw new InspectionFailure("CANDIDATE_ACTIVE", "Candidate profile overlaps the currently active profile");
    }
    if (pathOverlaps(canonical, baseCanonical)) {
      throw new InspectionFailure("CANDIDATE_OVERLAP", "Candidate profile overlaps the base data directory");
    }
    const controlCanonical = canonicalizeProfilePath(options.controlDir);
    if (pathOverlaps(canonical, controlCanonical)) {
      throw new InspectionFailure("CANDIDATE_OVERLAP", "Candidate profile overlaps the activation control directory");
    }
    pass("candidate-no-overlap");

    const foreign = ancestryConflict(canonical);
    if (foreign) {
      throw new InspectionFailure(
        "FOREIGN_PROFILE_CONFLICT",
        `Candidate profile is nested inside another ForgeOrbit profile: ${foreign}`,
      );
    }
    pass("candidate-no-foreign-profile");

    const owner = detectLiveProfileOwner(canonical, { checkDesktopLock: true });
    if (owner) {
      throw new InspectionFailure("CANDIDATE_LIVE_PROCESS", "Candidate profile is in use by another ForgeOrbit process");
    }
    pass("candidate-not-in-use");

    if (existsSync(path.join(canonical, STAGING_METADATA_FILENAME))) {
      throw new InspectionFailure(
        "CANDIDATE_CONFLICTING_OPERATION",
        "Candidate profile is an in-progress restore staging directory",
      );
    }
    if (stagingOperationIsActive(canonical) || stagingOperationIsActive(path.dirname(canonical))) {
      throw new InspectionFailure(
        "CANDIDATE_CONFLICTING_OPERATION",
        "A backup or restore operation is still running beside the candidate profile",
      );
    }
    pass("candidate-no-conflicting-operation");

    const dbPath = path.join(canonical, "agetor.sqlite");
    let dbStat;
    try {
      dbStat = lstatSync(dbPath);
    } catch {
      throw new InspectionFailure("DATABASE_MISSING", "Candidate profile is missing its SQLite database");
    }
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
      throw new InspectionFailure("CANDIDATE_SYMLINK", "Candidate database is not a regular file");
    }
    if (uid !== null && dbStat.uid !== uid) {
      throw new InspectionFailure("CANDIDATE_OWNERSHIP", "Candidate database is owned by another user");
    }
    if ((dbStat.mode & 0o077) !== 0) {
      throw new InspectionFailure(
        "CANDIDATE_PERMISSIONS",
        "Candidate database must not be accessible by other users",
      );
    }
    result.databaseBytes = dbStat.size;
    pass("database-present");

    let db: Database;
    try {
      db = openInactiveDatabase(dbPath);
    } catch {
      throw new InspectionFailure("DATABASE_UNREADABLE", "Candidate database could not be opened");
    }
    try {
      const integrity = checkDatabaseIntegrity(db);
      if (integrity) throw new InspectionFailure("DATABASE_INTEGRITY", `Candidate database integrity check failed: ${integrity}`);
      pass("database-integrity");
      const fkViolations = checkForeignKeys(db);
      if (fkViolations === null) {
        throw new InspectionFailure("DATABASE_FOREIGN_KEYS", "Candidate database foreign-key check could not run");
      }
      if (fkViolations > 0) {
        throw new InspectionFailure(
          "DATABASE_FOREIGN_KEYS",
          `Candidate database has ${fkViolations} foreign-key violation(s)`,
        );
      }
      pass("database-foreign-keys");
      const schema = checkSchema(db);
      if (!schema.compatible) {
        throw new InspectionFailure(
          schema.newer ? "DATABASE_SCHEMA_NEWER" : "DATABASE_SCHEMA_INCOMPATIBLE",
          schema.newer
            ? `Candidate schema contains migrations this runtime does not know: ${schema.detail}`
            : `Candidate schema is incompatible: ${schema.detail}`,
        );
      }
      result.pendingMigrationCount = schema.pending;
      if (schema.pending > 0) {
        warnings.push(`Candidate schema has ${schema.pending} pending migration(s); they run after activation`);
      }
      pass("database-schema-compatible");

      const actualDbSha = computeFileSha256Sync(dbPath).sha256;
      result.databaseSha256 = actualDbSha;

      const reportPath = path.join(canonical, RECOVERY_REPORT_FILENAME);
      result.recoveryReportPath = reportPath;
      let reportRaw: Record<string, unknown>;
      try {
        reportRaw = readBoundedPrivateJson(reportPath, MAX_RECOVERY_REPORT_BYTES);
      } catch (err) {
        if (err instanceof ProfileActivationError && err.code === "IO_ERROR") {
          throw new InspectionFailure("RECOVERY_REPORT_MISSING", "Candidate profile has no recovery report");
        }
        throw new InspectionFailure(
          "RECOVERY_REPORT_INVALID",
          err instanceof Error ? err.message : "Recovery report is invalid",
        );
      }
      const reportSha = computeFileSha256Sync(reportPath).sha256;
      result.recoveryReportSha256 = reportSha;
      let report: RecoveryReport;
      try {
        report = parseRecoveryReport(reportRaw);
      } catch (err) {
        throw new InspectionFailure(
          "RECOVERY_REPORT_INVALID",
          err instanceof Error ? err.message : "Recovery report is invalid",
        );
      }
      result.snapshotId = report.snapshotId;
      result.manifestVersion = report.manifestVersion;
      result.appVersion = report.appVersion;
      if (!report.appVersion) {
        warnings.push("Candidate recovery report does not record the application version; schema compatibility is used");
      }
      result.readiness = report.activationReadiness;
      if (report.manifestVersion !== 4) {
        throw new InspectionFailure(
          "LEGACY_UNVERIFIED",
          `Candidate was restored from a legacy manifest v${report.manifestVersion} and cannot be activated`,
        );
      }
      if (report.databaseSha256 !== actualDbSha) {
        throw new InspectionFailure(
          "RECOVERY_REPORT_HASH_MISMATCH",
          "Candidate database no longer matches the digest recorded by its restore",
        );
      }
      pass("recovery-report-structure");
      pass("database-digest-matches-report");

      const requireConfirmation = options.requireRestoreConfirmation !== false;
      if (requireConfirmation) {
        const confirmationPath = path.join(canonical, RESTORE_CONFIRMATION_FILENAME);
        result.restoreConfirmationPath = confirmationPath;
        let confirmationRaw: Record<string, unknown>;
        try {
          confirmationRaw = readBoundedPrivateJson(confirmationPath, MAX_RESTORE_CONFIRMATION_BYTES);
        } catch (err) {
          if (err instanceof ProfileActivationError && err.code === "IO_ERROR") {
            throw new InspectionFailure(
              "RESTORE_MARKER_MISSING",
              "Candidate profile has no post-publication restore confirmation; it is not a confirmed restore",
            );
          }
          throw new InspectionFailure(
            "RESTORE_MARKER_INVALID",
            err instanceof Error ? err.message : "Restore confirmation marker is invalid",
          );
        }
        let confirmation: RestoreConfirmation;
        try {
          confirmation = parseRestoreConfirmation(confirmationRaw);
        } catch (err) {
          throw new InspectionFailure(
            "RESTORE_MARKER_INVALID",
            err instanceof Error ? err.message : "Restore confirmation marker is invalid",
          );
        }
        if (canonicalizeProfilePath(confirmation.destinationPath) !== canonical) {
          throw new InspectionFailure(
            "RESTORE_MARKER_MISMATCH",
            "Restore confirmation marker was issued for a different destination",
          );
        }
        if (
          confirmation.snapshotId !== report.snapshotId ||
          confirmation.runnerOperationId !== report.runnerOperationId ||
          confirmation.databaseSha256 !== report.databaseSha256 ||
          confirmation.recoveryReportSha256 !== reportSha ||
          confirmation.databaseBytes !== dbStat.size
        ) {
          throw new InspectionFailure(
            "RESTORE_MARKER_MISMATCH",
            "Restore confirmation marker does not match the recovery report or database",
          );
        }
        if (confirmation.confirmedAt > now + MAX_KNOWN_FUTURE_SKEW_MS) {
          throw new InspectionFailure("RESTORE_MARKER_INVALID", "Restore confirmation timestamp is in the future");
        }
        pass("restore-confirmed");
      }

      const knowledgeMissing = checkKnowledgeConsistency(db, canonical);
      if (knowledgeMissing > 0) {
        throw new InspectionFailure(
          "KNOWLEDGE_INCONSISTENT",
          `Candidate Knowledge store has ${knowledgeMissing} missing or modified revision file(s)`,
        );
      }
      pass("knowledge-consistent");

      let assets: { missing: number; crossProfile: number; unresolvedExternal: number };
      try {
        assets = checkReferencedAssets(db, canonical);
      } catch (err) {
        throw new InspectionFailure(
          "INTERNAL_REFERENCE_MISSING",
          `Candidate profile references cannot be validated: ${sanitizeActivationText(err)}`,
        );
      }
      if (assets.missing > 0) {
        throw new InspectionFailure(
          "INTERNAL_REFERENCE_MISSING",
          `Candidate profile is missing ${assets.missing} referenced asset file(s)`,
        );
      }
      pass("internal-references-present");

      let preview: RestoreRecoveryPreview;
      try {
        preview = buildRecoveryPreview(db);
        result.recoveryPreview = preview;
      } catch (err) {
        throw new InspectionFailure(
          "RECOVERY_REPORT_INVALID",
          `Candidate recovery preview could not be built: ${sanitizeActivationText(err)}`,
        );
      }

      const expectedReadiness = assets.crossProfile > 0 || assets.unresolvedExternal > 0 || preview.totalExternalProjectsRequiringAttention > 0
        ? "requires-external-recovery"
        : report.rebindingUnresolved > 0 || report.internalReferencesUnresolved > 0
          ? "requires-reference-repair"
          : "ready";
      // The recomputed verdict wins: a hand-edited "ready" report cannot hide
      // external or reference-repair dependencies that actually exist.
      if (expectedReadiness === "requires-external-recovery") {
        throw new InspectionFailure(
          "REQUIRES_EXTERNAL_RECOVERY",
          "Candidate depends on external projects or profiles that need recovery before activation",
        );
      }
      if (expectedReadiness === "requires-reference-repair") {
        throw new InspectionFailure(
          "REQUIRES_REFERENCE_REPAIR",
          "Candidate has unresolved internal references and needs repair before activation",
        );
      }
      if (expectedReadiness !== "ready") {
        throw new InspectionFailure("NOT_READY", "Candidate is not ready for activation");
      }
      // Surface the recorded non-ready class accurately (never as success),
      // then reject any remaining disagreement as a mismatch.
      if (report.activationReadiness === "legacy-unverified") {
        throw new InspectionFailure("LEGACY_UNVERIFIED", "Candidate was not independently verified for activation");
      }
      if (report.activationReadiness === "requires-reference-repair") {
        throw new InspectionFailure(
          "REQUIRES_REFERENCE_REPAIR",
          "Candidate has unresolved internal references and needs repair before activation",
        );
      }
      if (report.activationReadiness === "requires-external-recovery") {
        throw new InspectionFailure(
          "REQUIRES_EXTERNAL_RECOVERY",
          "Candidate depends on external projects or profiles that need recovery before activation",
        );
      }
      if (report.activationReadiness === "not-ready") {
        throw new InspectionFailure("NOT_READY", "Candidate is not ready for activation");
      }
      if (report.activationReadiness !== "ready") {
        throw new InspectionFailure(
          "READINESS_MISMATCH",
          `Candidate readiness is reported as ${report.activationReadiness} but verifies as ${expectedReadiness}`,
        );
      }
      pass("candidate-ready");
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    result.ok = result.code === null;
    return result;
  } catch (err) {
    if (err instanceof InspectionFailure) return fail(err.code, err.message);
    if (err instanceof ProfileActivationError) return fail(err.code, err.message);
    return fail("IO_ERROR", `Candidate inspection failed: ${sanitizeActivationText(err)}`);
  }
}

export interface RollbackTargetInspection {
  ok: boolean;
  code: ProfileActivationErrorCode | null;
  message: string | null;
  canonicalPath: string | null;
  identity: string | null;
  databaseSha256: string | null;
  databaseBytes: number | null;
}

/**
 * A rollback target is the previously active profile. It was never a restored
 * profile, so it does not need a recovery report or readiness marker — but it
 * must still be a real, private, intact database that this runtime can open.
 */
export function inspectRollbackTarget(input: {
  targetPath: string;
  activeDataDir: string;
  expectedDatabaseSha256?: string | null;
  /** Only for post-failure boot checks, where the target may already be selected. */
  allowActiveProfile?: boolean;
}): RollbackTargetInspection {
  const result: RollbackTargetInspection = {
    ok: false,
    code: null,
    message: null,
    canonicalPath: null,
    identity: null,
    databaseSha256: null,
    databaseBytes: null,
  };
  const fail = (code: ProfileActivationErrorCode, message: string) => {
    result.code = code;
    result.message = sanitizeActivationText(message);
    return result;
  };
  try {
    if (!isAbsoluteProfilePath(input.targetPath)) return fail("CANDIDATE_NOT_FOUND", "Rollback target must be absolute");
    const resolved = path.resolve(input.targetPath);
    let st;
    try {
      st = lstatSync(resolved);
    } catch {
      return fail("CANDIDATE_NOT_FOUND", "Rollback target profile does not exist");
    }
    if (st.isSymbolicLink()) return fail("CANDIDATE_SYMLINK", "Rollback target must not be a symbolic link");
    if (!st.isDirectory()) return fail("CANDIDATE_NOT_DIRECTORY", "Rollback target is not a directory");
    const canonical = canonicalizeProfilePath(resolved);
    result.canonicalPath = canonical;
    result.identity = profileIdentityForPath(canonical);
    const canonicalStat = lstatSync(canonical);
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
      return fail("CANDIDATE_SYMLINK", "Rollback target canonical path is not a real directory");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && canonicalStat.uid !== uid) {
      return fail("CANDIDATE_OWNERSHIP", "Rollback target is owned by another user");
    }
    if ((canonicalStat.mode & 0o077) !== 0) {
      return fail("CANDIDATE_PERMISSIONS", "Rollback target must not be accessible by other users");
    }
    if (!input.allowActiveProfile && canonicalizeProfilePath(input.activeDataDir) === canonical) {
      return fail("CANDIDATE_ACTIVE", "Rollback target is already the active profile");
    }
    // A post-failure boot check inspects the profile this process is about to
    // open (and whose desktop lock this process itself holds), so live-owner
    // detection would always self-conflict there.
    if (!input.allowActiveProfile) {
      // Never inspect the desktop instance lock here: the calling desktop
      // process itself holds the base profile's lock while it resolves the
      // transition, so a held lock is not evidence of another owner. A live
      // core-credentials file still is.
      const owner = detectLiveProfileOwner(canonical, { checkDesktopLock: false });
      if (owner) return fail("CANDIDATE_LIVE_PROCESS", "Rollback target is in use by another ForgeOrbit process");
    }
    const dbPath = path.join(canonical, "agetor.sqlite");
    let dbStat;
    try {
      dbStat = lstatSync(dbPath);
    } catch {
      return fail("DATABASE_MISSING", "Rollback target is missing its SQLite database");
    }
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) return fail("CANDIDATE_SYMLINK", "Rollback database is not a regular file");
    if ((dbStat.mode & 0o077) !== 0) {
      return fail("CANDIDATE_PERMISSIONS", "Rollback database must not be accessible by other users");
    }
    result.databaseBytes = dbStat.size;
    let db: Database;
    try {
      db = openInactiveDatabase(dbPath);
    } catch {
      return fail("DATABASE_UNREADABLE", "Rollback target database could not be opened");
    }
    try {
      const integrity = checkDatabaseIntegrity(db);
      if (integrity) return fail("DATABASE_INTEGRITY", `Rollback target integrity check failed: ${integrity}`);
      const fkViolations = checkForeignKeys(db);
      if (fkViolations === null) return fail("DATABASE_FOREIGN_KEYS", "Rollback target foreign-key check could not run");
      if (fkViolations > 0) return fail("DATABASE_FOREIGN_KEYS", "Rollback target has foreign-key violations");
      const schema = checkSchema(db);
      if (!schema.compatible) {
        return fail(
          schema.newer ? "DATABASE_SCHEMA_NEWER" : "DATABASE_SCHEMA_INCOMPATIBLE",
          schema.newer
            ? `Rollback schema contains migrations this runtime does not know: ${schema.detail}`
            : `Rollback schema is incompatible: ${schema.detail}`,
        );
      }
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    const sha = computeFileSha256Sync(dbPath).sha256;
    result.databaseSha256 = sha;
    if (input.expectedDatabaseSha256 && input.expectedDatabaseSha256 !== sha) {
      return fail("PROFILE_CHANGED", "Rollback target database changed since it was recorded");
    }
    result.ok = true;
    return result;
  } catch (err) {
    return fail("IO_ERROR", `Rollback target inspection failed: ${sanitizeActivationText(err)}`);
  }
}

