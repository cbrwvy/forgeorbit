/**
 * Pure presentation helpers for the Backup & Recovery screen (FO-P2-004).
 *
 * Kept free of React and network access so the UI state model — including the
 * truthful operation-state vocabulary — is directly testable under `bun test`.
 */

import type { TranslationKey } from "@/i18n/core";
import type {
  BackupActivationReadiness,
  BackupCoverage,
  BackupHistoryEntry,
  BackupIntegrity,
  BackupManifestVersion,
  BackupOperationView,
  BackupProfileInfo,
  BackupRestoreSummary,
  BackupSnapshotSummary,
  BackupUiState,
} from "../../shared/backup.ts";
import { backupStateIsFailure, isBackupStateTerminal } from "../../shared/backup.ts";

export type BackupTabId = "create" | "verify" | "history" | "restore";

export const BACKUP_TABS: readonly { id: BackupTabId; labelKey: TranslationKey }[] = [
  { id: "create", labelKey: "backup.tab_create" },
  { id: "verify", labelKey: "backup.tab_verify" },
  { id: "history", labelKey: "backup.tab_history" },
  { id: "restore", labelKey: "backup.tab_restore" },
];

export function backupStateLabelKey(state: BackupUiState): TranslationKey {
  switch (state) {
    case "queued":
      return "backup.state_queued";
    case "running":
      return "backup.state_running";
    case "verifying":
      return "backup.state_verifying";
    case "publishing":
      return "backup.state_publishing";
    case "completed":
      return "backup.state_completed";
    case "cancelled-before-publication":
      return "backup.state_cancelled_before_publication";
    case "published-unconfirmed":
      return "backup.state_published_unconfirmed";
    case "indeterminate":
      return "backup.state_indeterminate";
    case "verification-failed":
      return "backup.state_verification_failed";
    case "failed-before-publication":
      return "backup.state_failed_before_publication";
  }
}

export type BackupBadgeTone = "default" | "secondary" | "destructive" | "outline";

export function backupStateTone(state: BackupUiState): BackupBadgeTone {
  if (backupStateIsFailure(state)) return "destructive";
  if (state === "completed") return "default";
  if (state === "queued" || state === "cancelled-before-publication") return "outline";
  return "secondary";
}

export function backupIntegrityLabelKey(integrity: BackupIntegrity): TranslationKey {
  switch (integrity) {
    case "verified":
      return "backup.integrity_verified";
    case "failed":
      return "backup.integrity_failed";
    case "interrupted":
      return "backup.integrity_interrupted";
    case "not_verified":
      return "backup.integrity_not_verified";
  }
}

export function backupCoverageLabelKey(coverage: BackupCoverage | null): TranslationKey {
  switch (coverage) {
    case "complete-profile":
      return "backup.coverage_complete_profile";
    case "legacy-database-knowledge":
      return "backup.coverage_legacy";
    case null:
      return "backup.coverage_unknown";
  }
}

export function backupFormatLabelKey(manifestVersion: BackupManifestVersion): TranslationKey {
  switch (manifestVersion) {
    case 4:
      return "backup.format_v4";
    case 3:
      return "backup.format_legacy_v3";
    case 2:
      return "backup.format_legacy_v2";
    case 1:
      return "backup.format_legacy_v1";
  }
}

export function backupReadinessLabelKey(readiness: BackupActivationReadiness): TranslationKey {
  switch (readiness) {
    case "ready":
      return "backup.readiness_ready";
    case "requires-reference-repair":
      return "backup.readiness_requires_reference_repair";
    case "requires-external-recovery":
      return "backup.readiness_requires_external_recovery";
    case "legacy-unverified":
      return "backup.readiness_legacy_unverified";
    case "not-ready":
      return "backup.readiness_not_ready";
  }
}

/**
 * A single truthful outcome line. `completed` is deliberately split by
 * integrity: a created snapshot with no independent verification is not
 * "verified", and a PUBLISHED_UNCONFIRMED result is never success.
 */
export function backupOperationOutcomeKey(operation: BackupOperationView): TranslationKey {
  if (operation.state === "completed") {
    if (operation.kind === "create") {
      if (operation.integrity === "verified") return "backup.outcome_backup_verified";
      if (operation.integrity === "failed" || operation.integrity === "interrupted") {
        return "backup.outcome_backup_verification_failed";
      }
      return "backup.outcome_backup_created_unverified";
    }
    if (operation.kind === "verify") return "backup.outcome_verified";
    return operation.integrity === "verified"
      ? "backup.outcome_restored_not_activated"
      : "backup.outcome_restored_not_activated_unverified";
  }
  return backupStateLabelKey(operation.state);
}

export function isBackupOperationTerminal(operation: BackupOperationView | null): boolean {
  return operation === null || isBackupStateTerminal(operation.state);
}

export function canCancelBackupOperation(operation: BackupOperationView | null): boolean {
  return (
    operation !== null &&
    operation.cancellable &&
    !operation.cancellationRequested &&
    !isBackupStateTerminal(operation.state)
  );
}

export function isBackupOperationFailure(operation: BackupOperationView | null): boolean {
  return operation !== null && backupStateIsFailure(operation.state);
}

export function backupProgressPercent(operation: BackupOperationView): number | null {
  const progress = operation.progress;
  if (!progress) return null;
  if (progress.totalBytes !== undefined && progress.totalBytes > 0 && progress.bytesProcessed !== undefined) {
    return clampPercent((progress.bytesProcessed / progress.totalBytes) * 100);
  }
  if (progress.totalFiles !== undefined && progress.totalFiles > 0 && progress.filesProcessed !== undefined) {
    return clampPercent((progress.filesProcessed / progress.totalFiles) * 100);
  }
  return null;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatBackupTimestamp(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function backupEstimatedScope(profile: BackupProfileInfo | null): {
  bytes: number;
  files: number;
  truncated: boolean;
} | null {
  if (!profile) return null;
  return {
    bytes: profile.estimatedTotalBytes,
    files: profile.estimatedFileCount,
    truncated: profile.estimateTruncated,
  };
}

export function historyEntryMatchesLocation(entry: BackupHistoryEntry, location: string): boolean {
  const normalized = location.endsWith("/") ? location.slice(0, -1) : location;
  return entry.location === normalized || entry.snapshotPath.startsWith(`${normalized}/`);
}

/**
 * A restore summary must never be mistaken for activation. This helper exists
 * so the UI and tests share one answer.
 */
export function restoreWasActivated(summary: BackupRestoreSummary | null): boolean {
  return summary !== null && Boolean((summary as { activated?: boolean }).activated);
}

export function snapshotNeedsVerification(
  snapshot: BackupSnapshotSummary | null,
  verificationId: string | null,
): boolean {
  return snapshot !== null && verificationId === null;
}

export function historyEmpty(history: BackupHistoryEntry[] | null): boolean {
  return history !== null && history.length === 0;
}

export function backupStatusLiveText(operation: BackupOperationView | null): string {
  if (!operation) return "";
  if (operation.state === "running" || operation.state === "verifying" || operation.state === "publishing") {
    return operation.progress?.phase ?? operation.phase ?? operation.state;
  }
  return operation.state;
}

export function operationTouchesDestination(
  operation: BackupOperationView | null,
  destinationPath: string | null,
): boolean {
  if (!operation || !destinationPath) return false;
  return operation.destinationPath === destinationPath || operation.snapshotPath === destinationPath;
}

/**
 * How long a terminal operation stays eligible for rehydration after the user
 * leaves and re-enters Settings. In-progress operations are always eligible.
 * Keeps a much older finished operation from reappearing as if it just ran.
 */
export const BACKUP_OPERATION_REHYDRATE_TERMINAL_MAX_AGE_MS = 10 * 60 * 1000;

/** Threshold of consecutive status-poll failures before the UI says it is disconnected. */
export const BACKUP_OPERATION_POLL_FAILURE_THRESHOLD = 3;

export type BackupOperationTabSource = "create" | "verify" | "history" | "restore";

/**
 * The tab/source a rehydrated operation belongs to. Restore operations are
 * shown on the restore tab; a verify operation on the verify tab. `history` is
 * only a user-intent label for in-session verifies launched from history, so
 * it is never reconstructed after a remount.
 */
export function backupOperationTabSource(
  operation: Pick<BackupOperationView, "kind">,
): BackupOperationTabSource {
  if (operation.kind === "create") return "create";
  if (operation.kind === "restore") return "restore";
  return "verify";
}

/**
 * Picks the operation the screen should reattach to after mounting. A live
 * (non-terminal) operation always wins; otherwise the most recent terminal
 * operation within the rehydration window is restored so its completed/failed
 * status is not lost just because the user navigated away.
 */
export function selectRehydratedOperation(
  operations: readonly BackupOperationView[],
  now: number = Date.now(),
  terminalMaxAgeMs: number = BACKUP_OPERATION_REHYDRATE_TERMINAL_MAX_AGE_MS,
): BackupOperationView | null {
  if (operations.length === 0) return null;
  const newestFirst = [...operations].sort((a, b) => b.updatedAt - a.updatedAt);
  const inProgress = newestFirst.find((operation) => !isBackupStateTerminal(operation.state));
  if (inProgress) return inProgress;
  const newest = newestFirst[0] ?? null;
  if (!newest) return null;
  return now - newest.updatedAt <= terminalMaxAgeMs ? newest : null;
}

/**
 * Stale-response gate for operation polling. A response is only applied when
 * it belongs to the newest request AND to the operation the screen is still
 * displaying, so an older tick can never overwrite a newer operation's state.
 */
export function isCurrentOperationResponse(input: {
  requestToken: number;
  latestToken: number;
  requestedOperationId: string;
  currentOperationId: string | null;
}): boolean {
  return (
    input.requestToken === input.latestToken &&
    input.currentOperationId === input.requestedOperationId
  );
}

/**
 * Consecutive-failure bookkeeping for status polling. Polling failures are
 * surfaced after the threshold but never trigger the backup/restore action
 * again; only the status read is retried.
 */
export function nextPollFailureCount(previous: number, failed: boolean): number {
  return failed ? previous + 1 : 0;
}
