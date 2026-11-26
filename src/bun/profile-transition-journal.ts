/**
 * FO-P2-005-A: durable activation transition journal.
 *
 * One journal file describes at most one transition. It is written atomically
 * in the activation control directory (outside every profile), never inside
 * the profile being replaced, and is never silently deleted: terminal journals
 * are moved into `history/` before a new transition starts.
 *
 * The journal intentionally stores no credentials, tokens, task content or
 * attachment bodies — only canonical paths, content digests, bounded
 * identifiers and the resolved error code/message.
 */

import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync } from "node:fs";
import path from "node:path";
import {
  ACTIVATION_HISTORY_DIRNAME,
  ACTIVATION_JOURNAL_FILENAME,
  canonicalizeProfilePath,
  isAbsoluteProfilePath,
  isSha256Hex,
  isUuid,
  journalFilePath,
  profileIdentityForPath,
  writePrivateJsonAtomic,
  ensureActivationControlDir,
  readPrivateFileForState,
} from "./profile-paths.ts";
import { ProfileActivationError, sanitizeActivationText } from "./profile-activation-errors.ts";

// The HTTP/UI contract describes the same durable states as the journal.
export type { ProfileTransitionState as TransitionState } from "../shared/profile-activation.ts";
import type { ProfileTransitionState as TransitionState } from "../shared/profile-activation.ts";

export type TransitionAction = "activate" | "rollback";

export const TERMINAL_TRANSITION_STATES: readonly TransitionState[] = [
  "active",
  "rolled_back",
  "failed",
];

export function isTerminalTransitionState(state: TransitionState): boolean {
  return TERMINAL_TRANSITION_STATES.includes(state);
}

export interface ProfileIdentityRecord {
  /** Canonical absolute profile directory. */
  path: string;
  /** Stable location-derived identity. */
  identity: string;
  /** Digest last verified for the profile database, when known. */
  databaseSha256: string | null;
  databaseBytes: number | null;
  /** Digest of the durable asset tree, when captured. */
  assetsSha256: string | null;
}

export interface CandidateIdentityRecord extends ProfileIdentityRecord {
  snapshotId: string | null;
  recoveryReportPath: string | null;
  recoveryReportSha256: string | null;
  manifestVersion: number | null;
  readiness: string | null;
}

export interface JournalErrorRecord {
  code: string;
  message: string;
}

export interface TransitionJournal {
  version: 1;
  transitionId: string;
  /**
   * The transition whose selection this journal starts from (a rollback or a
   * chained activation). Null for the first transition.
   */
  previousTransitionId: string | null;
  action: TransitionAction;
  state: TransitionState;
  requestedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** The profile that was active when the transition was prepared. */
  original: ProfileIdentityRecord;
  /** The profile the transition wants to make active. */
  candidate: CandidateIdentityRecord;
  /** The committed selection immediately before this transition. */
  previousSelection: {
    activeProfilePath: string;
    activeProfileIdentity: string;
    generation: number;
  } | null;
  /** Bounded retry counter so a crash loop cannot spin forever. */
  startupAttempts: number;
  error: JournalErrorRecord | null;
}

const STATES: readonly TransitionState[] = [
  "prepared",
  "switching",
  "pending_startup_validation",
  "active",
  "rollback_required",
  "rolling_back",
  "rolled_back",
  "failed",
];

const READINESS_VALUES = new Set([
  "ready",
  "requires-reference-repair",
  "requires-external-recovery",
  "legacy-unverified",
  "not-ready",
]);

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseErrorRecord(raw: unknown): JournalErrorRecord | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileActivationError("Transition journal error record is malformed", "JOURNAL_CORRUPT");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "code" && key !== "message")) {
    throw new ProfileActivationError("Transition journal error record has unknown fields", "JOURNAL_CORRUPT");
  }
  if (
    typeof record.code !== "string" ||
    !/^[A-Z0-9_]{1,80}$/.test(record.code) ||
    typeof record.message !== "string"
  ) {
    throw new ProfileActivationError("Transition journal error record is malformed", "JOURNAL_CORRUPT");
  }
  return { code: record.code, message: sanitizeActivationText(record.message) };
}

function parseIdentityRecord(raw: unknown, role: "original" | "candidate"): CandidateIdentityRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileActivationError(`Transition journal ${role} record is malformed`, "JOURNAL_CORRUPT");
  }
  const record = raw as Record<string, unknown>;
  const baseKeys = new Set(["path", "identity", "databaseSha256", "databaseBytes", "assetsSha256"]);
  const candidateKeys = new Set([
    "snapshotId",
    "recoveryReportPath",
    "recoveryReportSha256",
    "manifestVersion",
    "readiness",
  ]);
  for (const key of Object.keys(record)) {
    if (!baseKeys.has(key) && !(role === "candidate" && candidateKeys.has(key))) {
      throw new ProfileActivationError(`Transition journal ${role} record has unknown fields`, "JOURNAL_CORRUPT");
    }
  }
  if (!isAbsoluteProfilePath(record.path) || !isSha256Hex(record.identity)) {
    throw new ProfileActivationError(`Transition journal ${role} path identity is malformed`, "JOURNAL_CORRUPT");
  }
  if (!(record.databaseSha256 === null || isSha256Hex(record.databaseSha256))) {
    throw new ProfileActivationError(`Transition journal ${role} database digest is malformed`, "JOURNAL_CORRUPT");
  }
  if (
    !(
      record.databaseBytes === null ||
      (Number.isSafeInteger(record.databaseBytes) && (record.databaseBytes as number) >= 0)
    )
  ) {
    throw new ProfileActivationError(`Transition journal ${role} database size is malformed`, "JOURNAL_CORRUPT");
  }
  if (!(record.assetsSha256 === null || isSha256Hex(record.assetsSha256))) {
    throw new ProfileActivationError(`Transition journal ${role} asset digest is malformed`, "JOURNAL_CORRUPT");
  }
  if (profileIdentityForPath(canonicalizeProfilePath(record.path)) !== record.identity) {
    throw new ProfileActivationError(
      `Transition journal ${role} identity does not match its path`,
      "JOURNAL_CORRUPT",
    );
  }
  const base: ProfileIdentityRecord = {
    path: record.path,
    identity: record.identity,
    databaseSha256: record.databaseSha256,
    databaseBytes: record.databaseBytes as number | null,
    assetsSha256: record.assetsSha256,
  };
  if (role === "original") return base as CandidateIdentityRecord;
  {
    if (!(record.snapshotId === null || (typeof record.snapshotId === "string" && record.snapshotId.length <= 200))) {
      throw new ProfileActivationError("Transition journal candidate snapshot id is malformed", "JOURNAL_CORRUPT");
    }
    if (!(record.recoveryReportPath === null || isAbsoluteProfilePath(record.recoveryReportPath))) {
      throw new ProfileActivationError("Transition journal candidate report path is malformed", "JOURNAL_CORRUPT");
    }
    if (!(record.recoveryReportSha256 === null || isSha256Hex(record.recoveryReportSha256))) {
      throw new ProfileActivationError("Transition journal candidate report digest is malformed", "JOURNAL_CORRUPT");
    }
    if (
      !(
        record.manifestVersion === null ||
        (Number.isSafeInteger(record.manifestVersion) &&
          (record.manifestVersion as number) >= 1 &&
          (record.manifestVersion as number) <= 100)
      )
    ) {
      throw new ProfileActivationError("Transition journal candidate manifest version is malformed", "JOURNAL_CORRUPT");
    }
    if (!(record.readiness === null || (typeof record.readiness === "string" && READINESS_VALUES.has(record.readiness)))) {
      throw new ProfileActivationError("Transition journal candidate readiness is malformed", "JOURNAL_CORRUPT");
    }
    return {
      ...base,
      snapshotId: record.snapshotId as string | null,
      recoveryReportPath: record.recoveryReportPath as string | null,
      recoveryReportSha256: record.recoveryReportSha256 as string | null,
      manifestVersion: record.manifestVersion as number | null,
      readiness: record.readiness as string | null,
    };
  }
}

export function parseTransitionJournal(raw: unknown): TransitionJournal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileActivationError("Transition journal is not an object", "JOURNAL_CORRUPT");
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "transitionId",
    "previousTransitionId",
    "action",
    "state",
    "requestedAt",
    "updatedAt",
    "resolvedAt",
    "original",
    "candidate",
    "previousSelection",
    "startupAttempts",
    "error",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ProfileActivationError("Transition journal contains unknown fields", "JOURNAL_CORRUPT");
    }
  }
  if (record.version !== 1) {
    throw new ProfileActivationError("Unsupported transition journal version", "JOURNAL_CORRUPT");
  }
  if (!isUuid(record.transitionId)) {
    throw new ProfileActivationError("Transition journal id is malformed", "JOURNAL_CORRUPT");
  }
  if (!(record.previousTransitionId === null || isUuid(record.previousTransitionId))) {
    throw new ProfileActivationError("Transition journal previous id is malformed", "JOURNAL_CORRUPT");
  }
  if (record.action !== "activate" && record.action !== "rollback") {
    throw new ProfileActivationError("Transition journal action is malformed", "JOURNAL_CORRUPT");
  }
  if (typeof record.state !== "string" || !STATES.includes(record.state as TransitionState)) {
    throw new ProfileActivationError("Transition journal state is malformed", "JOURNAL_CORRUPT");
  }
  if (!isTimestamp(record.requestedAt) || !isTimestamp(record.updatedAt)) {
    throw new ProfileActivationError("Transition journal timestamps are malformed", "JOURNAL_CORRUPT");
  }
  if (!(record.resolvedAt === null || isTimestamp(record.resolvedAt))) {
    throw new ProfileActivationError("Transition journal resolution timestamp is malformed", "JOURNAL_CORRUPT");
  }
  if (
    !Number.isSafeInteger(record.startupAttempts) ||
    (record.startupAttempts as number) < 0 ||
    (record.startupAttempts as number) > 1_000
  ) {
    throw new ProfileActivationError("Transition journal attempt counter is malformed", "JOURNAL_CORRUPT");
  }
  const original = parseIdentityRecord(record.original, "original");
  const candidate = parseIdentityRecord(record.candidate, "candidate");
  if (original.path === candidate.path) {
    throw new ProfileActivationError("Transition journal cannot target the currently active profile", "JOURNAL_CORRUPT");
  }
  let previousSelection: TransitionJournal["previousSelection"] = null;
  if (record.previousSelection !== null) {
    const previous = record.previousSelection;
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
      throw new ProfileActivationError("Transition journal previous selection is malformed", "JOURNAL_CORRUPT");
    }
    const previousRecord = previous as Record<string, unknown>;
    const keys = Object.keys(previousRecord);
    if (
      keys.some((key) => !["activeProfilePath", "activeProfileIdentity", "generation"].includes(key)) ||
      !isAbsoluteProfilePath(previousRecord.activeProfilePath) ||
      !isSha256Hex(previousRecord.activeProfileIdentity) ||
      !Number.isSafeInteger(previousRecord.generation) ||
      (previousRecord.generation as number) < 0
    ) {
      throw new ProfileActivationError("Transition journal previous selection is malformed", "JOURNAL_CORRUPT");
    }
    previousSelection = {
      activeProfilePath: previousRecord.activeProfilePath,
      activeProfileIdentity: previousRecord.activeProfileIdentity,
      generation: previousRecord.generation as number,
    };
  }
  const error = parseErrorRecord(record.error);
  const state = record.state as TransitionState;
  if ((state === "active" || state === "rolled_back" || state === "failed") && record.resolvedAt === null) {
    throw new ProfileActivationError("Terminal transition journal is missing its resolution timestamp", "JOURNAL_CORRUPT");
  }
  if (!isTerminalTransitionState(state) && record.resolvedAt !== null) {
    throw new ProfileActivationError("Unresolved transition journal has a resolution timestamp", "JOURNAL_CORRUPT");
  }
  if ((state === "rollback_required" || state === "failed") && error === null) {
    throw new ProfileActivationError("Failed transition journal is missing its error record", "JOURNAL_CORRUPT");
  }
  if (record.action === "activate" && candidate.recoveryReportPath === null) {
    throw new ProfileActivationError("Activation journal is missing its verified recovery report", "JOURNAL_CORRUPT");
  }
  return {
    version: 1,
    transitionId: record.transitionId,
    previousTransitionId: record.previousTransitionId,
    action: record.action,
    state,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt,
    original,
    candidate,
    previousSelection,
    startupAttempts: record.startupAttempts as number,
    error,
  };
}

export function readTransitionJournal(controlDir: string): TransitionJournal | null {
  let text: string;
  try {
    text = readPrivateFileForState(journalFilePath(controlDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileActivationError("Transition journal is not valid JSON", "JOURNAL_CORRUPT");
  }
  return parseTransitionJournal(parsed);
}

export function writeTransitionJournal(controlDir: string, journal: TransitionJournal, now: number): void {
  writePrivateJsonAtomic(journalFilePath(controlDir), { ...journal, updatedAt: now });
}

/**
 * Preserve a terminal journal before a new transition replaces it. Evidence is
 * never deleted: it moves to `history/<transitionId>.json`, fsynced.
 */
export function preserveTransitionJournal(controlDir: string, journal: TransitionJournal): void {
  // Copy (never move) the resolved journal into `history/` before a new
  // transition replaces `transition.json`. A crash between the copy and the
  // new write therefore leaves the old journal fully intact.
  const historyDir = path.join(controlDir, ACTIVATION_HISTORY_DIRNAME);
  ensureActivationControlDir(controlDir, true);
  try {
    mkdirSync(historyDir, { recursive: false, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ProfileActivationError("Activation history directory could not be created", "IO_ERROR");
    }
  }
  writePrivateJsonAtomic(path.join(historyDir, `${journal.transitionId}.json`), journal);
}

export function archiveTransitionJournal(controlDir: string, journal: TransitionJournal): void {
  const historyDir = path.join(controlDir, ACTIVATION_HISTORY_DIRNAME);
  ensureActivationControlDir(controlDir, true);
  try {
    mkdirSync(historyDir, { recursive: false, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ProfileActivationError("Activation history directory could not be created", "IO_ERROR");
    }
  }
  const target = path.join(historyDir, `${journal.transitionId}.json`);
  try {
    renameSync(journalFilePath(controlDir), target);
    const dirFd = openSync(controlDir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    throw new ProfileActivationError("Activated transition evidence could not be archived", "IO_ERROR");
  }
}

export function historyDir(controlDir: string): string {
  return path.join(controlDir, ACTIVATION_HISTORY_DIRNAME);
}

export const TRANSITION_JOURNAL_FILENAME = ACTIVATION_JOURNAL_FILENAME;
