/**
 * Bounded, allowlisted worker error IPC (FO-P2-003-R9).
 *
 * The worker-to-parent error frame carries only the diagnostic fields the parent
 * needs to classify a publication outcome truthfully. Everything else is dropped
 * before it crosses the process boundary. The parent re-validates and re-bounds
 * every field so a compromised or buggy worker cannot inject unbounded data.
 */

import {
  MAX_IPC_ERROR_CODE_CHARS,
  MAX_IPC_ERROR_DETAILS_BYTES,
  MAX_IPC_ERROR_ISSUE_CHARS,
  MAX_IPC_ERROR_ISSUE_COUNT,
  MAX_IPC_ERROR_MESSAGE_CHARS,
  MAX_IPC_ERROR_PATH_CHARS,
  MAX_IPC_FRAME_BYTES,
  type ArtifactIntegrityOutcome,
  type PublicationOutcome,
  type SerializedBackupError,
  type SerializedBackupErrorDetails,
} from "./backup-runner-types.ts";

const PUBLICATION_OUTCOMES: ReadonlySet<string> = new Set<PublicationOutcome>([
  "not_published",
  "committed",
  "unresolved",
]);

const INTEGRITY_OUTCOMES: ReadonlySet<string> = new Set<ArtifactIntegrityOutcome>([
  "verified",
  "failed",
  "not_verified",
  "interrupted",
]);

const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Removes secrets that must never be persisted or transmitted in diagnostics. */
export function redactIpcSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(token[=:]\s*)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(password[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(secret[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(sk-[a-zA-Z0-9_\-]{20,})/gi, "[REDACTED_API_KEY]")
    .replace(/(ghp_[a-zA-Z0-9]{20,})/gi, "[REDACTED_GH_TOKEN]")
    .replace(/(github_pat_[a-zA-Z0-9_]{20,})/gi, "[REDACTED_GH_TOKEN]");
}

/** Strips control characters (including NUL/newlines) and bounds a string. */
export function sanitizeIpcString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

/**
 * Sanitizes a path for IPC while preserving the identity required for recovery.
 * The path is not basename-collapsed or homedir-redacted: the parent needs the
 * exact destination to reconcile the artifact. Only control characters and
 * excessive length are removed.
 */
export function sanitizeIpcPath(value: unknown): string | undefined {
  return sanitizeIpcString(value, MAX_IPC_ERROR_PATH_CHARS);
}

function sanitizeCode(value: unknown): string | undefined {
  const cleaned = sanitizeIpcString(value, MAX_IPC_ERROR_CODE_CHARS);
  if (!cleaned) return undefined;
  return CODE_RE.test(cleaned) ? cleaned : undefined;
}

function boundedIssues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_IPC_ERROR_ISSUE_COUNT) break;
    const issue = sanitizeIpcString(entry, MAX_IPC_ERROR_ISSUE_CHARS);
    if (issue !== undefined) out.push(issue);
  }
  return out;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Strict allowlist projection. Unknown keys, wrong types, excess array entries
 * and over-long strings are dropped rather than trusted.
 */
export function coerceSerializedErrorDetails(
  raw: unknown,
): SerializedBackupErrorDetails | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const details: SerializedBackupErrorDetails = {};

  const destinationPath = sanitizeIpcPath(r.destinationPath);
  if (destinationPath !== undefined) details.destinationPath = destinationPath;
  const targetPath = sanitizeIpcPath(r.targetPath);
  if (targetPath !== undefined) details.targetPath = targetPath;

  const verificationFailed = booleanField(r.verificationFailed);
  if (verificationFailed !== undefined) details.verificationFailed = verificationFailed;
  const verificationInterrupted = booleanField(r.verificationInterrupted);
  if (verificationInterrupted !== undefined) details.verificationInterrupted = verificationInterrupted;
  const destinationVerified = booleanField(r.destinationVerified);
  if (destinationVerified !== undefined) details.destinationVerified = destinationVerified;

  const causeCode = sanitizeCode(r.causeCode);
  if (causeCode !== undefined) details.causeCode = causeCode;
  const committedAt = sanitizeCode(r.committedAt);
  if (committedAt !== undefined) details.committedAt = committedAt;

  if (typeof r.publicationOutcome === "string" && PUBLICATION_OUTCOMES.has(r.publicationOutcome)) {
    details.publicationOutcome = r.publicationOutcome as PublicationOutcome;
  }
  if (typeof r.integrityOutcome === "string" && INTEGRITY_OUTCOMES.has(r.integrityOutcome)) {
    details.integrityOutcome = r.integrityOutcome as ArtifactIntegrityOutcome;
  }

  // Accept the canonical wire name, and map a raw `issues` field conservatively.
  const issues = boundedIssues(r.verificationIssues ?? r.issues);
  if (issues !== undefined && issues.length > 0) details.verificationIssues = issues;

  if (Object.keys(details).length === 0) return undefined;
  const encoded = JSON.stringify(details);
  if (Buffer.byteLength(encoded, "utf8") > MAX_IPC_ERROR_DETAILS_BYTES) {
    // Keep the highest-value recovery identity, discard the bulk.
    const minimal: SerializedBackupErrorDetails = {};
    if (details.destinationPath) minimal.destinationPath = details.destinationPath;
    if (details.targetPath) minimal.targetPath = details.targetPath;
    if (details.causeCode) minimal.causeCode = details.causeCode;
    if (details.verificationFailed !== undefined) {
      minimal.verificationFailed = details.verificationFailed;
    }
    if (details.verificationInterrupted !== undefined) {
      minimal.verificationInterrupted = details.verificationInterrupted;
    }
    if (details.destinationVerified !== undefined) {
      minimal.destinationVerified = details.destinationVerified;
    }
    if (details.publicationOutcome) minimal.publicationOutcome = details.publicationOutcome;
    if (details.integrityOutcome) minimal.integrityOutcome = details.integrityOutcome;
    return Object.keys(minimal).length > 0 ? minimal : undefined;
  }
  return details;
}

/** Extracts the allowlisted details from an arbitrary application error. */
function extractErrorDetails(err: unknown): SerializedBackupErrorDetails | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as Record<string, unknown>;
  const fromDetails = coerceSerializedErrorDetails(record.details);
  if (fromDetails) return fromDetails;
  const cause = record.cause;
  if (cause && typeof cause === "object") {
    return coerceSerializedErrorDetails((cause as Record<string, unknown>).details);
  }
  return undefined;
}

/**
 * Worker-side serializer. `subsystem` is supplied by the worker from its own
 * error classes so this module stays dependency-free.
 */
export function serializeBackupError(
  err: unknown,
  subsystem?: "backup-core" | "backup-manager" | "backup-restore",
): SerializedBackupError {
  const record = (err ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  const code =
    sanitizeCode(typeof record.code === "string" ? record.code : undefined) ?? "UNKNOWN_ERROR";
  const rawMessage =
    typeof record.message === "string" && record.message.length > 0
      ? record.message
      : String(err);
  const message =
    sanitizeIpcString(redactIpcSecrets(rawMessage), MAX_IPC_ERROR_MESSAGE_CHARS) ??
    "Unknown worker error";
  const serialized: SerializedBackupError = { code, message };
  const resolvedSubsystem =
    subsystem ??
    (record.name === "BackupCoreError"
      ? "backup-core"
      : record.name === "BackupManagerError"
        ? "backup-manager"
        : record.name === "RestoreError"
          ? "backup-restore"
          : undefined);
  if (resolvedSubsystem) serialized.subsystem = resolvedSubsystem;
  const details = extractErrorDetails(err);
  if (details) serialized.details = details;
  return serialized;
}

/** Parent-side strict parser. Returns null for a structurally invalid frame. */
export function parseSerializedBackupError(raw: unknown): SerializedBackupError | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== "string") return null;
  const code = sanitizeCode(r.code);
  if (!code) return null;
  if (typeof r.message !== "string") return null;
  const message =
    sanitizeIpcString(redactIpcSecrets(r.message), MAX_IPC_ERROR_MESSAGE_CHARS) ??
    "Unknown worker error";
  const parsed: SerializedBackupError = { code, message };
  const subsystem = sanitizeCode(r.subsystem);
  if (subsystem !== undefined) parsed.subsystem = subsystem;
  const details = coerceSerializedErrorDetails(r.details);
  if (details !== undefined) parsed.details = details;
  return parsed;
}

/**
 * Serializes an error frame and guarantees the resulting line fits inside the
 * existing 64 KiB frame limit. Progressively drops the lowest-value diagnostics
 * rather than truncating JSON mid-frame.
 */
export function serializeWorkerErrorFrame(operationId: string, error: SerializedBackupError): string {
  const build = (e: SerializedBackupError): string =>
    JSON.stringify({ type: "error", operationId, error: e }) + "\n";

  let candidate = build(error);
  if (Buffer.byteLength(candidate, "utf8") <= MAX_IPC_FRAME_BYTES) return candidate;

  const reduced: SerializedBackupError = { ...error };
  if (reduced.details?.verificationIssues) {
    reduced.details = {
      ...reduced.details,
      verificationIssues: reduced.details.verificationIssues.slice(0, 1).map((issue) =>
        issue.slice(0, 200),
      ),
    };
    candidate = build(reduced);
    if (Buffer.byteLength(candidate, "utf8") <= MAX_IPC_FRAME_BYTES) return candidate;
  }
  reduced.details = undefined;
  reduced.message = reduced.message.slice(0, 200);
  candidate = build(reduced);
  if (Buffer.byteLength(candidate, "utf8") <= MAX_IPC_FRAME_BYTES) return candidate;

  return build({
    code: "IPC_ERROR",
    message: "Worker error details exceeded the IPC frame budget",
  });
}
