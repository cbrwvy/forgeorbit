import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BackupOperationCard,
  RecoveryPreviewCard,
  RestoreSummaryView,
  SnapshotSummaryCard,
  VerificationSummary,
} from "./BackupRecoverySection";
import type {
  BackupOperationView,
  BackupRestorePreview,
  BackupRestoreSummary,
  BackupSnapshotSummary,
  BackupVerifySummary,
} from "../../../shared/backup.ts";

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
  categories: ["database"],
  counts: {
    knowledgeDocuments: 0,
    knowledgeRevisions: 0,
    attachments: 0,
    screenshots: 0,
    issueThreads: 0,
    pipelineRuns: 0,
  },
  legacy: false,
  brain: {
    coverage: "included",
    memoryCount: 2,
    archivedCount: 1,
    revisionCount: 3,
    pendingExcluded: 0,
    orphanedProjectCount: 1,
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
    phase: "published",
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

const VERIFY_FAILED: BackupVerifySummary = {
  snapshotPath: SNAPSHOT.snapshotPath,
  ok: false,
  snapshotId: "snapshot-1",
  manifestVersion: 4,
  coverage: "complete-profile",
  createdAt: 1_700_000_000_000,
  filesChecked: 12,
  totalBytes: 4096,
  issues: ["checksum mismatch for attachments/a.bin"],
  databaseSha256: null,
  legacy: false,
  verifiedAt: 1_700_000_000_100,
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

const PREVIEW: BackupRestorePreview = {
  snapshot: SNAPSHOT,
  verification: { verifiedAt: 1_700_000_000_000, ok: true, issues: [] },
  recovery: {
    totalProjects: 1,
    totalClusters: 0,
    totalTasks: 2,
    projects: [
      {
        projectPath: "/Users/someone/code/project",
        name: "project",
        existsOnDisk: false,
        requiresUserIntervention: true,
        taskCount: 2,
      },
    ],
    worktrees: [],
    environmentProfiles: [],
    providerAuth: [],
    externalProjectsRequiringAttention: 1,
    missingWorktrees: 0,
    internalReferencesExpected: 3,
    internalReferencesUnresolved: null,
    unresolvedCrossProfileReferences: 1,
    crossProfileDependencies: ["/Users/someone/other-profile/attachments/x.pdf"],
    unresolvedExternalReferences: 2,
    unresolvedExternalDependencies: ["/Users/someone/files/op.bin"],
    readiness: "requires-external-recovery",
    readinessAdvisory: true,
    legacy: false,
    truncated: false,
    brain: {
      coverage: "included",
      memoryCount: 2,
      archivedCount: 1,
      revisionCount: 3,
      pendingExcluded: 0,
      orphanedProjectCount: 1,
      missingProjectPaths: ["/tmp/missing-project"],
      projectScopesTruncated: false,
    },
  },
};

describe("Backup & Recovery operation UI", () => {
  test("published but unconfirmed is announced as such, never as success", () => {
    const html = renderToStaticMarkup(
      <BackupOperationCard
        operation={operation({ state: "published-unconfirmed", integrity: "not_verified" })}
        onCancel={() => {}}
        onVerifySnapshot={() => {}}
      />,
    );
    expect(html).toContain("Published but unconfirmed");
    expect(html).toContain("A destination may exist");
    expect(html).not.toContain("Integrity verified");
    expect(html).not.toContain("Backup created and independently verified");
    expect(html).toContain("Verify this snapshot");
    expect(html).toContain("No automatic retry is performed.");
  });

  test("an unverified completed backup does not claim verification", () => {
    const html = renderToStaticMarkup(
      <BackupOperationCard operation={operation()} onCancel={() => {}} onVerifySnapshot={() => {}} />,
    );
    expect(html).toContain("not yet independently verified");
    expect(html).not.toContain("Backup created and independently verified");
    expect(html).toContain("Integrity not verified");
  });

  test("Brain coverage is explicit and a failed Brain check does not claim success", () => {
    const included = renderToStaticMarkup(<SnapshotSummaryCard snapshot={SNAPSHOT} />);
    expect(included).toContain("Included in this snapshot.");
    expect(included).toContain("2 memories · 1 archived · 3 revisions");
    expect(included).toContain("not attached to another project");
    const invalid = renderToStaticMarkup(
      <VerificationSummary
        summary={{
          ...VERIFY_FAILED,
          issues: ["Brain snapshot is missing brain/memories/missing.md."],
          brain: {
            coverage: "invalid",
            memoryCount: null,
            archivedCount: null,
            revisionCount: null,
            pendingExcluded: null,
            orphanedProjectCount: null,
          },
        }}
      />,
    );
    expect(invalid).toContain("Brain failed verification");
    expect(invalid).toContain("Nothing from this snapshot was restored.");
    expect(invalid).not.toContain("Included in this snapshot.");
  });

  test("a failed verification exposes bounded issues and no success wording", () => {
    const html = renderToStaticMarkup(
      <VerificationSummary summary={VERIFY_FAILED} />,
    );
    expect(html).toContain("Verification failed");
    expect(html).toContain("checksum mismatch");
    expect(html).not.toContain("Snapshot verified");
  });

  test("a legacy snapshot advertises legacy-unverified coverage", () => {
    const legacy: BackupSnapshotSummary = {
      ...SNAPSHOT,
      snapshotId: "legacy-1",
      manifestVersion: 1,
      coverage: "legacy-database-knowledge",
      legacy: true,
      brain: {
        coverage: "legacy-absent",
        memoryCount: null,
        archivedCount: null,
        revisionCount: null,
        pendingExcluded: null,
        orphanedProjectCount: null,
      },
    };
    const html = renderToStaticMarkup(<SnapshotSummaryCard snapshot={legacy} />);
    expect(html).toContain("Manifest v1 · legacy");
    expect(html).toContain("Legacy · unverified");
    expect(html).toContain("legacy-unverified");
    expect(html).toContain("does not erase Brain");
    expect(html).not.toContain("complete profile");
  });

  test("the recovery preview shows advisory readiness, external reconnections and unresolved references", () => {
    const html = renderToStaticMarkup(<RecoveryPreviewCard preview={PREVIEW} />);
    expect(html).toContain("Requires external recovery");
    expect(html).toContain("Readiness is advisory");
    expect(html).toContain("Cross-profile dependencies");
    expect(html).toContain("Unresolved external references");
    expect(html).toContain("Missing on this Mac");
    expect(html).toContain("expected to be rebound");
  });

  test("the restore report says restored but not activated and offers no activation control", () => {
    const html = renderToStaticMarkup(<RestoreSummaryView summary={RESTORE} />);
    expect(html).toContain("Restored — not activated");
    expect(html).toContain("The active profile is not changed");
    expect(html).not.toContain("Activate profile");
    expect(html).not.toContain("Activate Profile");
  });

  test("status text is available to assistive technology, not colour alone", () => {
    const html = renderToStaticMarkup(
      <BackupOperationCard
        operation={operation({
          state: "running",
          integrity: "not_verified",
          cancellable: true,
          progress: { filesProcessed: 1, totalFiles: 4, timestamp: 1 },
        })}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Running");
    expect(html).toContain("Cancel operation");
  });
});
