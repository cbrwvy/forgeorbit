/**
 * Errors raised by the FO-P2-005-A profile activation core.
 *
 * Codes are stable, bounded identifiers for the future UI (FO-P2-005-B). The
 * message is a short, sanitized, user-safe explanation: it never contains file
 * contents, credentials, tokens or a stack trace. Callers may display the code
 * verbatim; they must not parse the message.
 */

export type ProfileActivationErrorCode =
  | "INVALID_INPUT"
  | "TRANSITION_IN_PROGRESS"
  | "TRANSITION_LOCKED"
  | "TRANSITION_LOCK_UNAVAILABLE"
  | "ACTIVATION_PENDING"
  | "CONFLICTING_OPERATION"
  | "CONTROL_DIR_UNTRUSTED"
  | "JOURNAL_CORRUPT"
  | "JOURNAL_UNTRUSTED"
  | "SELECTION_CORRUPT"
  | "SELECTION_UNTRUSTED"
  | "SELECTION_WITHOUT_JOURNAL"
  | "ACTIVE_PROFILE_MISSING"
  | "ROLLBACK_NOT_AVAILABLE"
  | "ROLLBACK_CANDIDATE_INVALID"
  | "CANDIDATE_NOT_FOUND"
  | "CANDIDATE_NOT_DIRECTORY"
  | "CANDIDATE_SYMLINK"
  | "CANDIDATE_OWNERSHIP"
  | "CANDIDATE_PERMISSIONS"
  | "CANDIDATE_ACTIVE"
  | "CANDIDATE_OVERLAP"
  | "FOREIGN_PROFILE_CONFLICT"
  | "CANDIDATE_LIVE_PROCESS"
  | "CANDIDATE_CONFLICTING_OPERATION"
  | "DATABASE_MISSING"
  | "DATABASE_UNREADABLE"
  | "DATABASE_INTEGRITY"
  | "DATABASE_FOREIGN_KEYS"
  | "DATABASE_SCHEMA_INCOMPATIBLE"
  | "DATABASE_SCHEMA_NEWER"
  | "RECOVERY_REPORT_MISSING"
  | "RECOVERY_REPORT_INVALID"
  | "RECOVERY_REPORT_HASH_MISMATCH"
  | "RESTORE_MARKER_MISSING"
  | "RESTORE_MARKER_INVALID"
  | "RESTORE_MARKER_MISMATCH"
  | "READINESS_NOT_READY"
  | "LEGACY_UNVERIFIED"
  | "REQUIRES_REFERENCE_REPAIR"
  | "REQUIRES_EXTERNAL_RECOVERY"
  | "NOT_READY"
  | "READINESS_MISMATCH"
  | "INTERNAL_REFERENCE_MISSING"
  | "KNOWLEDGE_INCONSISTENT"
  | "EXTERNAL_PROJECTS_REQUIRE_ATTENTION"
  | "CANDIDATE_OUTSIDE_MANAGED"
  | "PROJECT_NOT_FOUND"
  | "DIRECTORY_NOT_FOUND"
  | "NOT_A_DIRECTORY"
  | "UNTRUSTED_SYMLINK"
  | "PROTECTED_PATH"
  | "PROJECT_CONFLICT"
  | "FOREIGN_KEY_VIOLATION"
  | "PROFILE_CHANGED"
  | "IO_ERROR";

export class ProfileActivationError extends Error {
  readonly code: ProfileActivationErrorCode;

  constructor(message: string, code: ProfileActivationErrorCode) {
    super(sanitizeActivationText(message));
    this.name = "ProfileActivationError";
    this.code = code;
  }
}

/**
 * Bound and flatten arbitrary diagnostic text before it can reach a log, a
 * journal error record or the future UI. Paths are allowed (they are needed to
 * explain a rejected candidate) but content and newlines are not.
 */
export function sanitizeActivationText(value: unknown, max = 500): string {
  const raw = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
  const flat = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}
