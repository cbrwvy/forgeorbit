import { describe, expect, test } from "bun:test";
import {
  BACKUP_TABS,
  backupCoverageLabelKey,
  backupEstimatedScope,
  backupFormatLabelKey,
  backupOperationTabSource,
  isCurrentOperationResponse,
  nextPollFailureCount,
  selectRehydratedOperation,
  BACKUP_OPERATION_POLL_FAILURE_THRESHOLD,
  backupIntegrityLabelKey,
  backupOperationOutcomeKey,
  backupProgressPercent,
  backupReadinessLabelKey,
  backupStateLabelKey,
  backupStateTone,
  canCancelBackupOperation,
  formatBackupTimestamp,
  formatByteSize,
  historyEmpty,
  isBackupOperationTerminal,
  restoreWasActivated,
} from "./backup-recovery.ts";
import { activeSection, openSection, SETTINGS_SECTIONS, SETTINGS_SUBSECTIONS } from "./settings-dialog-view.ts";
import type {
  BackupHistoryEntry,
  BackupOperationView,
  BackupProfileInfo,
  BackupRestoreSummary,
  BackupSnapshotSummary,
  BackupUiState,
} from "../../shared/backup.ts";

const SNAPSHOT: BackupSnapshotSummary = {
  snapshotPath: "/tmp/backups/snapshot-1",
  snapshotId: "snapshot-1",
  manifestVersion: 4,
  coverage: "complete-profile",
  createdAt: 1_700_000_000_000,
  appVersion: "1.0.3",
  schemaVersion: "89",
  manifestVerified: true,
  files: 12,
  totalBytes: 4096,
  databaseBytes: 2048,
  databaseSha256: "a".repeat(64),
  categories: ["database", "attachments"],
  counts: {
    knowledgeDocuments: 0,
    knowledgeRevisions: 0,
    attachments: 1,
    screenshots: 0,
    issueThreads: 0,
    pipelineRuns: 0,
  },
  legacy: false,
  brain: {
    coverage: "legacy-absent",
    memoryCount: null,
    archivedCount: null,
    revisionCount: null,
    pendingExcluded: null,
    orphanedProjectCount: null,
  },
  available: true,
  manifestError: null,
};

function operation(overrides: Partial<BackupOperationView> = {}): BackupOperationView {
  return {
    id: "op-1",
    kind: "create",
    state: "completed",
    integrity: "not_verified",
    phase: null,
    progress: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: 2,
    snapshotPath: SNAPSHOT.snapshotPath,
    destinationPath: null,
    cancellable: false,
    cancellationRequested: false,
    cancellationOutcome: null,
    error: null,
    verificationIssues: [],
    snapshot: SNAPSHOT,
    create: {
      snapshot: SNAPSHOT,
      databaseSha256: "a".repeat(64),
      totalFiles: 12,
      totalBytes: 4096,
      durationMs: 10,
      publishedAt: 1_700_000_000_000,
    },
    verify: null,
    restore: null,
    ...overrides,
  };
}

const PROFILE: BackupProfileInfo = {
  profileRoot: "/tmp/profile",
  databaseFilename: "agetor.sqlite",
  databaseBytes: 1024,
  coverage: "complete-profile",
  manifestVersion: 4,
  categories: [{ id: "database", fileCount: 1, bytes: 1024, included: true }],
  estimatedTotalBytes: 2048,
  estimatedFileCount: 2,
  estimateTruncated: false,
  notIncluded: ["external-git-repositories", "provider-sign-in-sessions"],
};

const HISTORY_ENTRY: BackupHistoryEntry = {
  ...SNAPSHOT,
  location: "/tmp/backups",
  sizeBytes: 4096,
  lastVerifiedAt: 1_700_000_000_000,
  lastVerificationOk: true,
  integrity: "verified",
};

const RESTORE: BackupRestoreSummary = {
  destinationPath: "/tmp/restores/restored",
  snapshotId: "snapshot-1",
  manifestVersion: 4,
  coverage: "complete-profile",
  dbFilename: "agetor.sqlite",
  databaseBytes: 2048,
  databaseTransformed: true,
  databaseSha256: "b".repeat(64),
  filesRestored: 12,
  totalBytesRestored: 4096,
  durationMs: 100,
  restoredAt: 1_700_000_000_000,
  internalReferencesDiscovered: 2,
  internalReferencesRebound: 2,
  internalReferencesUnresolved: 0,
  unresolvedCrossProfileReferences: 0,
  crossProfileDependencies: [],
  unresolvedExternalReferences: 0,
  unresolvedExternalDependencies: [],
  externalProjectsRequiringAttention: 0,
  validationStatus: "valid",
  activationReadiness: "ready",
  recoveryReportPath: "/tmp/restores/restored/.forgeorbit-recovery.json",
  legacy: false,
  activated: false,
};

describe("Backup & Recovery navigation", () => {
  test("Backup & Recovery lives in Settings → Advanced and the legacy id still opens it", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain("advanced");
    expect(SETTINGS_SUBSECTIONS.find((sub) => sub.id === "backup")).toMatchObject({ section: "advanced", label: "Backup & Recovery" });
    expect(openSection("backup")).toEqual({ kind: "section", section: "advanced", anchor: "backup" });
    expect(activeSection(openSection("backup"))).toBe("advanced");
  });

  test("the four primary areas are present in a stable order", () => {
    expect(BACKUP_TABS.map((tab) => tab.id)).toEqual(["create", "verify", "history", "restore"]);
  });
});

describe("truthful operation states", () => {
  const states: BackupUiState[] = [
    "queued",
    "running",
    "verifying",
    "publishing",
    "completed",
    "cancelled-before-publication",
    "published-unconfirmed",
    "indeterminate",
    "verification-failed",
    "failed-before-publication",
  ];

  test("every state has its own label and accessible tone", () => {
    const labels = states.map(backupStateLabelKey);
    expect(new Set(labels).size).toBe(states.length);
    expect(backupStateTone("published-unconfirmed")).toBe("destructive");
    expect(backupStateTone("verification-failed")).toBe("destructive");
    expect(backupStateTone("indeterminate")).toBe("destructive");
    expect(backupStateTone("completed")).toBe("default");
  });

  test("a published but unconfirmed artifact is never described as verified", () => {
    const op = operation({ state: "published-unconfirmed", integrity: "not_verified" });
    expect(backupOperationOutcomeKey(op)).toBe("backup.state_published_unconfirmed");
    expect(backupOperationOutcomeKey(op)).not.toBe("backup.outcome_backup_verified");
  });

  test("completed create splits on the separate integrity result", () => {
    expect(backupOperationOutcomeKey(operation({ integrity: "not_verified" }))).toBe(
      "backup.outcome_backup_created_unverified",
    );
    expect(backupOperationOutcomeKey(operation({ integrity: "verified" }))).toBe(
      "backup.outcome_backup_verified",
    );
    expect(backupOperationOutcomeKey(operation({ integrity: "failed" }))).toBe(
      "backup.outcome_backup_verification_failed",
    );
  });

  test("a completed verify reports verified; a failed verify does not", () => {
    expect(
      backupOperationOutcomeKey(operation({ kind: "verify", state: "completed", integrity: "verified" })),
    ).toBe("backup.outcome_verified");
    expect(
      backupOperationOutcomeKey(operation({ kind: "verify", state: "verification-failed", integrity: "failed" })),
    ).toBe("backup.state_verification_failed");
  });

  test("restore outcomes say not activated and never claim activation", () => {
    expect(restoreWasActivated(RESTORE)).toBe(false);
    expect(
      restoreWasActivated({ ...RESTORE, activated: true as unknown as false }),
    ).toBe(true);
    expect(
      backupOperationOutcomeKey(
        operation({ kind: "restore", state: "completed", integrity: "verified", restore: RESTORE }),
      ),
    ).toBe("backup.outcome_restored_not_activated");
  });

  test("integrity and readiness labels cover every value", () => {
    for (const value of ["verified", "failed", "interrupted", "not_verified"] as const) {
      expect(backupIntegrityLabelKey(value)).toStartWith("backup.integrity_");
    }
    for (const value of ["ready", "requires-reference-repair", "requires-external-recovery", "legacy-unverified", "not-ready"] as const) {
      expect(backupReadinessLabelKey(value)).toStartWith("backup.readiness_");
    }
    expect(backupCoverageLabelKey(null)).toBe("backup.coverage_unknown");
    expect(backupFormatLabelKey(4)).toBe("backup.format_v4");
    expect(backupFormatLabelKey(1)).toBe("backup.format_legacy_v1");
  });
});

describe("busy, cancellation and terminal state", () => {
  test("terminal states are never cancellable and running states are", () => {
    expect(isBackupOperationTerminal(operation({ state: "completed" }))).toBe(true);
    expect(isBackupOperationTerminal(operation({ state: "running" }))).toBe(false);
    expect(canCancelBackupOperation(operation({ state: "running", cancellable: true }))).toBe(true);
    expect(canCancelBackupOperation(operation({ state: "completed", cancellable: true }))).toBe(false);
    expect(
      canCancelBackupOperation(operation({ state: "running", cancellable: true, cancellationRequested: true })),
    ).toBe(false);
  });

  test("progress is derived from bytes or files and clamped", () => {
    expect(
      backupProgressPercent(
        operation({
          state: "running",
          progress: { bytesProcessed: 50, totalBytes: 200, timestamp: 1 },
        }),
      ),
    ).toBe(25);
    expect(
      backupProgressPercent(
        operation({
          state: "running",
          progress: { filesProcessed: 3, totalFiles: 3, timestamp: 1 },
        }),
      ),
    ).toBe(100);
    expect(
      backupProgressPercent(
        operation({
          state: "running",
          progress: { bytesProcessed: 999, totalBytes: 10, timestamp: 1 },
        }),
      ),
    ).toBe(100);
  });

  test("empty history and scope estimates are explicit", () => {
    expect(historyEmpty([])).toBe(true);
    expect(historyEmpty([HISTORY_ENTRY])).toBe(false);
    expect(backupEstimatedScope(PROFILE)).toEqual({ bytes: 2048, files: 2, truncated: false });
    expect(formatByteSize(4096)).toBe("4.00 KB");
    expect(formatBackupTimestamp(0)).toBe("—");
    expect(formatBackupTimestamp(1_700_000_000_000)).not.toBe("—");
  });
});

describe("operation rehydration and status polling", () => {
  test("a live operation wins over an older finished one", () => {
    const running = operation({ id: "live", state: "running", updatedAt: 50, cancellable: true });
    const finished = operation({ id: "done", state: "completed", updatedAt: 100 });
    expect(selectRehydratedOperation([finished, running], 200)?.id).toBe("live");
  });

  test("the most recent finished operation is restored within the window", () => {
    const older = operation({ id: "older", state: "failed-before-publication", updatedAt: 100 });
    const newer = operation({ id: "newer", state: "verification-failed", updatedAt: 150 });
    expect(selectRehydratedOperation([older, newer], 200)?.id).toBe("newer");
    expect(selectRehydratedOperation([older], 100 + 60_000)?.id).toBe("older");
  });

  test("an old finished operation is not resurrected on every Settings visit", () => {
    const old = operation({ id: "old", state: "completed", updatedAt: 100 });
    expect(selectRehydratedOperation([old], 100 + 60 * 60 * 1000)).toBeNull();
    expect(selectRehydratedOperation([], 100)).toBeNull();
  });

  test("an operation is routed to the tab its kind belongs to", () => {
    expect(backupOperationTabSource({ kind: "create" })).toBe("create");
    expect(backupOperationTabSource({ kind: "verify" })).toBe("verify");
    expect(backupOperationTabSource({ kind: "restore" })).toBe("restore");
  });

  test("poll failures escalate to a visible error but reset on success", () => {
    let failures = 0;
    for (let i = 0; i < BACKUP_OPERATION_POLL_FAILURE_THRESHOLD; i++) {
      failures = nextPollFailureCount(failures, true);
    }
    expect(failures).toBe(BACKUP_OPERATION_POLL_FAILURE_THRESHOLD);
    expect(nextPollFailureCount(failures, false)).toBe(0);
  });

  test("a stale or wrong-operation response can never overwrite a newer state", () => {
    const current = { requestedOperationId: "op-2", currentOperationId: "op-2" };
    expect(isCurrentOperationResponse({ ...current, requestToken: 4, latestToken: 4 })).toBe(true);
    expect(isCurrentOperationResponse({ ...current, requestToken: 3, latestToken: 4 })).toBe(false);
    expect(
      isCurrentOperationResponse({
        requestToken: 4,
        latestToken: 4,
        requestedOperationId: "op-1",
        currentOperationId: "op-2",
      }),
    ).toBe(false);
  });
});
