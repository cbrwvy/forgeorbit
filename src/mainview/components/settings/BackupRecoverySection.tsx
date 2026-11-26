import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DatabaseBackup,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/state";
import { useConfirm } from "@/components/ui/confirm";
import { api, ApiError } from "@/lib/api";
import type { BrainSnapshotCoverageSummary } from "../../../shared/brain/snapshot.ts";
import { shortenPath } from "@/lib/path-display";
import { cn } from "@/lib/utils";
import { ProfileActivationPanel } from "@/components/settings/ProfileActivationPanel";
import type {
  BackupHistoryEntry,
  BackupHistoryResponse,
  BackupOperationView,
  BackupPickPurpose,
  BackupProfileInfo,
  BackupRecoveryPreview,
  BackupRestorePreview,
  BackupRestoreSummary,
  BackupSnapshotSummary,
  BackupVerifySummary,
} from "../../../shared/backup.ts";
import { isBackupOperationBusy, isBackupStateTerminal } from "../../../shared/backup.ts";
import {
  BACKUP_TABS,
  backupCoverageLabelKey,
  backupEstimatedScope,
  backupFormatLabelKey,
  backupIntegrityLabelKey,
  backupOperationOutcomeKey,
  backupProgressPercent,
  backupReadinessLabelKey,
  backupStateLabelKey,
  backupStateTone,
  canCancelBackupOperation,
  formatBackupTimestamp,
  formatByteSize,
  isBackupOperationFailure,
  isBackupOperationTerminal,
  backupOperationTabSource,
  isCurrentOperationResponse,
  nextPollFailureCount,
  restoreWasActivated,
  selectRehydratedOperation,
  BACKUP_OPERATION_POLL_FAILURE_THRESHOLD,
  type BackupTabId,
} from "@/lib/backup-recovery";

type OperationSource = "create" | "verify" | "history" | "restore";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function pathLabel(path: string): string {
  return shortenPath(path, "", 4);
}

/**
 * Polls a running operation until it settles; a terminal result is never
 * re-fetched. A stale response can never overwrite a newer operation (token +
 * operation-id gate), consecutive failures become visible after the shared
 * threshold, and the interval is always cleared on unmount.
 */
function useBackupOperationPolling() {
  const [operation, setOperationState] = useState<BackupOperationView | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const operationRef = useRef<BackupOperationView | null>(null);
  const failuresRef = useRef(0);
  const tokenRef = useRef(0);

  useEffect(() => {
    operationRef.current = operation;
  }, [operation]);

  const setOperation = useCallback(
    (next: BackupOperationView | null | ((prev: BackupOperationView | null) => BackupOperationView | null)) => {
      setOperationState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        operationRef.current = value;
        return value;
      });
    },
    [],
  );

  const pollNow = useCallback(async () => {
    const current = operationRef.current;
    if (!current) return;
    const requestedId = current.id;
    const token = ++tokenRef.current;
    try {
      const response = await api.backupOperation(requestedId);
      if (
        !isCurrentOperationResponse({
          requestToken: token,
          latestToken: tokenRef.current,
          requestedOperationId: requestedId,
          currentOperationId: operationRef.current?.id ?? null,
        })
      ) {
        return;
      }
      failuresRef.current = nextPollFailureCount(failuresRef.current, false);
      setPollError(null);
      setOperationState((prev) => (prev?.id === requestedId ? response.operation : prev));
    } catch (error) {
      if (token !== tokenRef.current) return;
      failuresRef.current = nextPollFailureCount(failuresRef.current, true);
      if (failuresRef.current >= BACKUP_OPERATION_POLL_FAILURE_THRESHOLD) {
        setPollError(messageOf(error));
      }
    }
  }, []);

  const retryPoll = useCallback(() => {
    failuresRef.current = 0;
    setPollError(null);
    // Retry only the status read. The backup/restore action is never re-issued.
    void pollNow();
  }, [pollNow]);

  const operationId = operation?.id ?? null;
  const state = operation?.state ?? null;
  useEffect(() => {
    if (!operationId || !state || isBackupStateTerminal(state)) {
      failuresRef.current = 0;
      setPollError(null);
      return;
    }
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped) void pollNow();
    }, 700);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [operationId, state, pollNow]);

  return { operation, setOperation, pollError, retryPoll };
}

function StateBadges({ operation }: { operation: BackupOperationView }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={backupStateTone(operation.state)} data-testid="backup-operation-state">
        {tr(backupStateLabelKey(operation.state))}
      </Badge>
      {operation.state === "completed" && (
        <Badge
          variant={
            operation.integrity === "verified"
              ? "default"
              : operation.integrity === "failed"
                ? "destructive"
                : "outline"
          }
          data-testid="backup-operation-integrity"
        >
          {tr(backupIntegrityLabelKey(operation.integrity))}
        </Badge>
      )}
    </div>
  );
}

export function BackupOperationCard({
  operation,
  onCancel,
  onVerifySnapshot,
  onOpenVerify,
  cancelBusy,
}: {
  operation: BackupOperationView;
  onCancel: () => void;
  onVerifySnapshot?: (snapshotPath: string) => void;
  onOpenVerify?: () => void;
  cancelBusy?: boolean;
}) {
  const percent = backupProgressPercent(operation);
  const progress = operation.progress;
  const outcomeKey = backupOperationOutcomeKey(operation);
  const failure = isBackupOperationFailure(operation);
  const bodyKey =
    operation.state === "published-unconfirmed"
      ? "backup.published_unconfirmed_body"
      : operation.state === "indeterminate"
        ? "backup.indeterminate_body"
        : operation.state === "verification-failed"
          ? "backup.verification_failed_body"
          : operation.state === "cancelled-before-publication"
            ? "backup.cancelled_before_publication_body"
            : operation.state === "failed-before-publication"
              ? "backup.failed_before_publication_body"
              : null;
  const canVerify =
    onVerifySnapshot !== undefined &&
    operation.snapshotPath !== null &&
    (operation.state === "published-unconfirmed" ||
      operation.state === "indeterminate" ||
      (operation.kind === "create" && operation.state === "completed" && operation.integrity !== "verified"));

  return (
    <Card className="mt-4" data-testid="backup-operation">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">{tr("backup.operation")}</CardTitle>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {tr(
                operation.kind === "create"
                  ? "backup.tab_create"
                  : operation.kind === "verify"
                    ? "backup.tab_verify"
                    : "backup.tab_restore",
              )}
            </p>
          </div>
          <StateBadges operation={operation} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p
          role="status"
          aria-live="polite"
          className={cn("font-medium", failure && "text-destructive")}
          data-testid="backup-operation-outcome"
        >
          {tr(outcomeKey)}
        </p>
        {bodyKey && <p className="text-xs text-muted-foreground">{tr(bodyKey)}</p>}

        {operation.phase && (
          <p className="text-xs text-muted-foreground">
            {tr("backup.operation_phase")}: <span className="text-foreground">{operation.phase}</span>
          </p>
        )}

        {(operation.state === "running" ||
          operation.state === "verifying" ||
          operation.state === "publishing" ||
          operation.state === "queued") && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
              <span>
                {progress?.filesProcessed !== undefined && progress?.totalFiles !== undefined
                  ? tr("backup.progress_files", {
                      done: String(progress.filesProcessed),
                      total: String(progress.totalFiles),
                    })
                  : progress?.bytesProcessed !== undefined && progress?.totalBytes !== undefined
                    ? tr("backup.progress_bytes", {
                        done: formatByteSize(progress.bytesProcessed),
                        total: formatByteSize(progress.totalBytes),
                      })
                    : tr("backup.progress_indeterminate")}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={tr("backup.operation_progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              className="h-1.5 overflow-hidden rounded-full bg-secondary"
            >
              <div
                className={cn("h-full bg-primary transition-[width]", percent === null && "w-1/3 motion-safe:animate-pulse")}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {operation.cancellationRequested && !operation.finishedAt && (
          <p className="text-xs text-muted-foreground">{tr("backup.cancellation_requested")}</p>
        )}
        {operation.cancellationOutcome && (
          <p className="text-xs text-muted-foreground">
            {tr("backup.cancellation_outcome")}:{" "}
            {tr(cancellationOutcomeKey(operation.cancellationOutcome))}
          </p>
        )}

        {operation.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            <p className="font-medium text-destructive">{tr("backup.operation_failed")}</p>
            <p className="mt-1 break-words text-foreground">{operation.error.message}</p>
            <p className="mt-1 text-muted-foreground">
              {tr("backup.error_code", { code: operation.error.code })}
            </p>
          </div>
        )}

        {operation.verificationIssues.length > 0 && (
          <details className="rounded-md border p-2" open={failure}>
            <summary className="cursor-pointer text-xs font-medium">{tr("backup.verify_issues")}</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {operation.verificationIssues.map((issue, index) => (
                <li key={index} className="break-words">{issue}</li>
              ))}
            </ul>
          </details>
        )}

        {operation.destinationPath && operation.create === null && (
          <p className="break-words text-xs">
            <span className="text-muted-foreground">{tr("backup.destination")}: </span>
            <span className="font-mono" title={operation.destinationPath}>
              {pathLabel(operation.destinationPath)}
            </span>
          </p>
        )}

        {operation.kind === "create" && operation.create && (
          <div className="space-y-1 text-xs">
            <p className="break-words">
              <span className="text-muted-foreground">{tr("backup.result_path")}: </span>
              <span className="font-mono" title={operation.create.snapshot.snapshotPath}>
                {pathLabel(operation.create.snapshot.snapshotPath)}
              </span>
            </p>
            <p className="text-muted-foreground">
              {tr("backup.result_created_at")}: {formatBackupTimestamp(operation.create.snapshot.createdAt)} ·{" "}
              {formatByteSize(operation.create.totalBytes)} ·{" "}
              {tr("backup.files_count", { count: String(operation.create.totalFiles) })}
            </p>
          </div>
        )}

        {operation.kind === "verify" && operation.verify && (
          <VerificationSummary summary={operation.verify} />
        )}

        {operation.kind === "restore" && operation.restore && (
          <RestoreSummaryView summary={operation.restore} />
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {canCancelBackupOperation(operation) && (
            <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelBusy}>
              {cancelBusy ? tr("backup.cancelling") : tr("backup.cancel_operation")}
            </Button>
          )}
          {canVerify && operation.snapshotPath && (
            <Button size="sm" variant="secondary" onClick={() => onVerifySnapshot?.(operation.snapshotPath!)}>
              <ShieldCheck className="size-3.5" />
              {tr("backup.verify_now")}
            </Button>
          )}
          {!canVerify &&
            onOpenVerify !== undefined &&
            (operation.state === "published-unconfirmed" || operation.state === "indeterminate") && (
              <Button size="sm" variant="secondary" onClick={onOpenVerify}>
                <ShieldCheck className="size-3.5" />
                {tr("backup.verify_entry")}
              </Button>
            )}
        </div>
        {failure && <p className="text-[11px] text-muted-foreground">{tr("backup.retry_note")}</p>}
      </CardContent>
    </Card>
  );
}

function cancellationOutcomeKey(outcome: string) {
  switch (outcome) {
    case "cancelled_before_execution":
      return "backup.cancel_outcome_cancelled_before_execution" as const;
    case "cancelled_before_publication":
      return "backup.cancel_outcome_cancelled_before_publication" as const;
    case "publication_committed":
      return "backup.cancel_outcome_publication_committed" as const;
    case "publication_unresolved":
      return "backup.cancel_outcome_publication_unresolved" as const;
    case "already_completed":
      return "backup.cancel_outcome_already_completed" as const;
    case "already_failed":
      return "backup.cancel_outcome_already_failed" as const;
    default:
      return "backup.cancel_outcome_not_found" as const;
  }
}

function brainCoverageKey(coverage: BrainSnapshotCoverageSummary["coverage"]) {
  switch (coverage) {
    case "included":
      return "backup.brain_included" as const;
    case "absent":
      return "backup.brain_absent" as const;
    case "invalid":
      return "backup.brain_invalid" as const;
    case "legacy-absent":
      return "backup.brain_legacy_absent" as const;
  }
}

export function BrainCoverageDetails({
  brain,
  testId = "backup-brain-coverage",
}: {
  brain: BrainSnapshotCoverageSummary;
  testId?: string;
}) {
  return (
    <div className="space-y-1" data-testid={testId} data-coverage={brain.coverage}>
      <p className="text-xs font-medium">{tr("backup.brain_title")}</p>
      <p className="text-xs text-muted-foreground">{tr(brainCoverageKey(brain.coverage))}</p>
      {brain.coverage === "included" && brain.memoryCount !== null && (
        <p className="text-xs text-muted-foreground" data-testid="backup-brain-counts">
          {tr("backup.brain_included_counts", {
            memories: String(brain.memoryCount),
            archived: String(brain.archivedCount ?? 0),
            revisions: String(brain.revisionCount ?? 0),
          })}
        </p>
      )}
      {brain.coverage === "included" && (brain.pendingExcluded ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr("backup.brain_pending_excluded", { count: String(brain.pendingExcluded) })}
        </p>
      )}
      {brain.coverage === "included" && (brain.orphanedProjectCount ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr("backup.brain_orphaned", { count: String(brain.orphanedProjectCount) })}
        </p>
      )}
      {brain.coverage !== "invalid" && (
        <p className="text-xs text-muted-foreground">{tr("backup.brain_portability")}</p>
      )}
    </div>
  );
}

export function SnapshotSummaryCard({
  snapshot,
  showVerify,
}: {
  snapshot: BackupSnapshotSummary;
  showVerify?: boolean;
}) {
  return (
    <div className="space-y-2" data-testid="backup-snapshot-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={snapshot.legacy ? "outline" : "secondary"}>
          {tr(backupFormatLabelKey(snapshot.manifestVersion))}
        </Badge>
        <Badge variant="outline">{tr(backupCoverageLabelKey(snapshot.coverage))}</Badge>
        {snapshot.legacy && <Badge variant="destructive">{tr("backup.legacy_badge")}</Badge>}
        {snapshot.manifestVerified ? (
          <Badge variant="outline">{tr("backup.manifest_verified_creation")}</Badge>
        ) : (
          <Badge variant="outline">{tr("backup.manifest_unverified")}</Badge>
        )}
        {!snapshot.available && <Badge variant="destructive">{tr("backup.entry_unavailable")}</Badge>}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{tr("backup.snapshot_id")}</dt>
          <dd className="break-all font-mono">{snapshot.snapshotId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.created")}</dt>
          <dd>{formatBackupTimestamp(snapshot.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.file_count")}</dt>
          <dd>{snapshot.files}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.total_size")}</dt>
          <dd>{formatByteSize(snapshot.totalBytes)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.database_bytes")}</dt>
          <dd>{formatByteSize(snapshot.databaseBytes)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{tr("backup.snapshot_path")}</dt>
          <dd className="break-words font-mono" title={snapshot.snapshotPath}>
            {pathLabel(snapshot.snapshotPath)}
          </dd>
        </div>
      </dl>
      <BrainCoverageDetails brain={snapshot.brain} />
      {snapshot.legacy && (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
          {tr("backup.legacy_notice", { version: String(snapshot.manifestVersion) })}
        </p>
      )}
      {!showVerify && snapshot.legacy && (
        <p className="text-xs text-muted-foreground">{tr("backup.internal_references_legacy")}</p>
      )}
    </div>
  );
}

export function VerificationSummary({ summary }: { summary: BackupVerifySummary }) {
  return (
    <div className="space-y-2 text-xs" data-testid="backup-verification-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={summary.ok ? "default" : "destructive"}>
          {summary.ok ? tr("backup.verified_badge") : tr("backup.failed_badge")}
        </Badge>
        {summary.legacy && <Badge variant="outline">{tr("backup.legacy_badge")}</Badge>}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{tr("backup.manifest_version")}</dt>
          <dd>{summary.manifestVersion === null ? "—" : tr(backupFormatLabelKey(summary.manifestVersion))}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.coverage_title")}</dt>
          <dd>{tr(backupCoverageLabelKey(summary.coverage))}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.file_count")}</dt>
          <dd>{summary.filesChecked}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.total_size")}</dt>
          <dd>{formatByteSize(summary.totalBytes)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.verification_timestamp")}</dt>
          <dd>{formatBackupTimestamp(summary.verifiedAt)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{tr("backup.snapshot_id")}</dt>
          <dd className="break-all font-mono">{summary.snapshotId ?? "—"}</dd>
        </div>
      </dl>
      {summary.brain && <BrainCoverageDetails brain={summary.brain} testId="backup-verify-brain-coverage" />}
      <details className="rounded-md border p-2" open={!summary.ok}>
        <summary className="cursor-pointer font-medium">{tr("backup.verify_details")}</summary>
        <div className="mt-2 space-y-1">
          <p className="text-muted-foreground">
            {summary.issues.length === 0 ? tr("backup.verify_no_issues") : tr("backup.verify_issues")}
          </p>
          {summary.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {summary.issues.map((issue, index) => (
                <li key={index} className="break-words">{issue}</li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

export function RestoreSummaryView({ summary }: { summary: BackupRestoreSummary }) {
  const activated = restoreWasActivated(summary);
  return (
    <div className="space-y-2 text-xs" data-testid="backup-restore-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default">{tr("backup.restored_title")}</Badge>
        {summary.legacy || summary.validationStatus !== "valid" ? (
          <Badge variant="destructive">{tr("backup.unverified_badge")}</Badge>
        ) : (
          <Badge variant="outline">{tr("backup.validated_badge")}</Badge>
        )}
        {activated && <Badge variant="destructive">{tr("backup.activated_unexpected")}</Badge>}
      </div>
      <p className="rounded-md border p-2">
        <span className="font-medium">{tr("backup.restored_body")}</span>
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">{tr("backup.destination")}</dt>
          <dd className="break-words font-mono" title={summary.destinationPath}>
            {pathLabel(summary.destinationPath)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.files_restored")}</dt>
          <dd>
            {summary.filesRestored} · {formatByteSize(summary.totalBytesRestored)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.manifest_version")}</dt>
          <dd>
            {summary.manifestVersion === null
              ? "—"
              : `${tr(backupFormatLabelKey(summary.manifestVersion))} · ${tr(backupCoverageLabelKey(summary.coverage))}`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.recovery_readiness")}</dt>
          <dd>{tr(backupReadinessLabelKey(summary.activationReadiness))}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.database_transformed")}</dt>
          <dd>
            {summary.internalReferencesRebound} / {summary.internalReferencesDiscovered}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr("backup.validation_status")}</dt>
          <dd>{tr(validationKey(summary.validationStatus))}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">{tr("backup.recovery_report")}</dt>
          <dd className="break-words font-mono" title={summary.recoveryReportPath}>
            {pathLabel(summary.recoveryReportPath)}
          </dd>
        </div>
      </dl>
      {(summary.crossProfileDependencies.length > 0 || summary.unresolvedExternalDependencies.length > 0) && (
        <details className="rounded-md border p-2" open>
          <summary className="cursor-pointer font-medium">{tr("backup.unresolved_external_title")}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {summary.crossProfileDependencies.map((dependency, index) => (
              <li key={`cross-${index}`} className="break-words">
                {tr("backup.cross_profile_dependency_item")}: <span className="font-mono">{dependency}</span>
              </li>
            ))}
            {summary.unresolvedExternalDependencies.map((dependency, index) => (
              <li key={`external-${index}`} className="break-words">
                {tr("backup.unresolved_external_item")}: <span className="font-mono">{dependency}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-[11px] text-muted-foreground">{tr("backup.readiness_advisory")}</p>
    </div>
  );
}

function validationKey(status: BackupRestoreSummary["validationStatus"]) {
  switch (status) {
    case "valid":
      return "backup.validation_valid" as const;
    case "failed":
      return "backup.validation_failed" as const;
    case "unverified":
      return "backup.validation_unverified" as const;
  }
}

export function RecoveryPreviewCard({ preview }: { preview: BackupRestorePreview }) {
  const recovery: BackupRecoveryPreview = preview.recovery;
  const legacy = preview.snapshot.legacy;
  return (
    <Card className="mt-4" data-testid="backup-recovery-preview">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{tr("backup.restore_preview_title")}</CardTitle>
          <Badge variant={legacy ? "destructive" : "secondary"}>
            {tr(backupReadinessLabelKey(recovery.readiness))}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{tr("backup.readiness_advisory")}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <SnapshotSummaryCard snapshot={preview.snapshot} showVerify />
        <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-2.5 text-xs sm:grid-cols-4" data-testid="backup-preview-counts">
          <div>
            <span className="text-muted-foreground">{tr("common.projects")}: </span>
            <span className="font-semibold">{recovery.totalProjects}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{tr("common.clusters")}: </span>
            <span className="font-semibold">{recovery.totalClusters}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{tr("common.tasks")}: </span>
            <span className="font-semibold">{recovery.totalTasks}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{tr("common.attachments")}: </span>
            <span className="font-semibold">{preview.snapshot.counts.attachments}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-testid="backup-preview-security-status">
          <Badge variant="outline" className="text-xs">
            {tr("backup.credentials_excluded")}
          </Badge>
          <Badge variant="default" className="text-xs">
            {tr("backup.integrity_status_verified")}
          </Badge>
        </div>
        {preview.recovery.brain.missingProjectPaths.length > 0 && (
          <div data-testid="backup-brain-missing-projects">
            <p className="text-xs font-medium">{tr("backup.brain_missing_projects")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {preview.recovery.brain.missingProjectPaths.map((projectPath) => (
                <li key={projectPath} className="break-words font-mono">{projectPath}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs">
          <span className="font-medium">{tr("backup.independent_verification")}: </span>
          <span className="text-muted-foreground">
            {tr("backup.verified_badge")} · {formatBackupTimestamp(preview.verification.verifiedAt)}
          </span>
        </p>
        {legacy && (
          <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
            {tr("backup.legacy_restore_warning")}
          </p>
        )}
        <div>
          <p className="text-xs font-medium">{tr("backup.internal_references")}</p>
          <p className="text-xs text-muted-foreground">
            {legacy
              ? tr("backup.internal_references_legacy")
              : tr("backup.internal_references_count", {
                  count: String(recovery.internalReferencesExpected),
                })}
          </p>
          {!legacy && recovery.internalReferencesUnresolved !== null && (
            <p className="text-xs text-muted-foreground">
              {tr("backup.internal_references_unresolved_count", {
                count: String(recovery.internalReferencesUnresolved),
              })}
            </p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium">{tr("backup.cross_profile_title")}</p>
          <p className="text-xs text-muted-foreground">
            {tr("backup.cross_profile_count", {
              count: String(recovery.unresolvedCrossProfileReferences),
            })}
          </p>
          {recovery.crossProfileDependencies.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {recovery.crossProfileDependencies.map((dependency) => (
                <li key={dependency} className="break-words font-mono">{dependency}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium">{tr("backup.unresolved_external_title")}</p>
          <p className="text-xs text-muted-foreground">
            {tr("backup.unresolved_external_count", {
              count: String(recovery.unresolvedExternalReferences),
            })}
          </p>
          {recovery.unresolvedExternalDependencies.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {recovery.unresolvedExternalDependencies.map((dependency) => (
                <li key={dependency} className="break-words font-mono">{dependency}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium">{tr("backup.external_projects_title")}</p>
          {recovery.projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tr("backup.external_projects_none")}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {recovery.projects.map((project) => (
                <li key={project.projectPath} className="break-words">
                  <span className="font-mono">{project.projectPath}</span>
                  {" — "}
                  {project.requiresUserIntervention
                    ? tr("backup.external_project_missing")
                    : tr("backup.external_project_present")}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium">{tr("backup.provider_auth_title")}</p>
          <p className="text-xs text-muted-foreground">
            {tr("backup.provider_auth_body", { count: String(recovery.providerAuth.length) })}
          </p>
          {recovery.providerAuth.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {recovery.providerAuth.map((provider) => (
                <li key={provider.harnessId} className="break-words">
                  {provider.harnessName}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium">{tr("backup.missing_worktrees_title")}</p>
          <p className="text-xs text-muted-foreground">
            {tr("backup.missing_worktrees_body", { count: String(recovery.missingWorktrees) })}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium">{tr("backup.environment_profiles_title")}</p>
          <p className="text-xs text-muted-foreground">
            {tr("backup.environment_profiles_body", {
              count: String(recovery.environmentProfiles.length),
            })}
          </p>
        </div>
        {recovery.truncated && <p className="text-xs text-warning">{tr("backup.preview_truncated")}</p>}
      </CardContent>
    </Card>
  );
}

function HistoryRow({
  entry,
  busy,
  onVerify,
}: {
  entry: BackupHistoryEntry;
  busy: boolean;
  onVerify: (path: string) => void;
}) {
  return (
    <li className="rounded-md border p-3" data-testid="backup-history-entry">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={entry.legacy ? "outline" : "secondary"}>
              {tr(backupFormatLabelKey(entry.manifestVersion))}
            </Badge>
            <Badge variant="outline">{tr(backupCoverageLabelKey(entry.coverage))}</Badge>
            <Badge variant={entry.integrity === "verified" ? "default" : entry.integrity === "failed" ? "destructive" : "outline"}>
              {tr(backupIntegrityLabelKey(entry.integrity))}
            </Badge>
            {entry.legacy && <Badge variant="destructive">{tr("backup.legacy_badge")}</Badge>}
          </div>
          <p className="break-words font-mono text-xs" title={entry.snapshotPath}>
            {pathLabel(entry.snapshotPath)}
          </p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{entry.snapshotId}</p>
          <p className="text-xs text-muted-foreground">
            {formatBackupTimestamp(entry.createdAt)} · {formatByteSize(entry.sizeBytes)} ·{" "}
            {tr("backup.location")}: <span className="font-mono">{pathLabel(entry.location)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {tr("backup.last_verified")}:{" "}
            {entry.lastVerifiedAt === null
              ? tr("backup.never_verified")
              : `${formatBackupTimestamp(entry.lastVerifiedAt)} · ${entry.lastVerificationOk ? tr("backup.verified_badge") : tr("backup.failed_badge")}`}
          </p>
          {!entry.available && <p className="text-xs text-destructive">{tr("backup.entry_unavailable")}</p>}
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onVerify(entry.snapshotPath)}>
          <ShieldCheck className="size-3.5" />
          {tr("backup.verify_entry")}
        </Button>
      </div>
    </li>
  );
}

export function BackupRecoverySection() {
  useUILocale();
  const confirm = useConfirm();
  const [tab, setTab] = useState<BackupTabId>("create");
  const [profile, setProfile] = useState<BackupProfileInfo | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const { operation, setOperation, pollError, retryPoll } = useBackupOperationPolling();
  const [operationSource, setOperationSource] = useState<OperationSource | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [createGrant, setCreateGrant] = useState<{ id: string; path: string } | null>(null);

  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);
  const [restoreSnapshotPath, setRestoreSnapshotPath] = useState<string | null>(null);
  const [verifyPurpose, setVerifyPurpose] = useState<"verify" | "restore" | "history" | null>(null);
  const [verified, setVerified] = useState<{ path: string; operationId: string } | null>(null);
  const [preview, setPreview] = useState<BackupRestorePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [restoreGrant, setRestoreGrant] = useState<{ id: string; path: string } | null>(null);
  const [destinationName, setDestinationName] = useState("");
  const [activationRestore, setActivationRestore] = useState<{
    path: string;
    summary: BackupRestoreSummary;
  } | null>(null);

  const [history, setHistory] = useState<BackupHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const notifiedRef = useRef<string | null>(null);
  const busy = isBackupOperationBusy(operation) || actionBusy;

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError(null);
    try {
      setProfile(await api.backupProfile());
    } catch (error) {
      setProfileError(messageOf(error));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await api.backupHistory());
    } catch (error) {
      setHistoryError(messageOf(error));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (tab === "history") void loadHistory();
  }, [tab, loadHistory]);

  // Reattach to an operation that was running when the user left Settings (or
  // to a just-finished one, so its outcome is not lost). This only reads status
  // by backend operation id — it never starts a second backup/restore.
  const rehydratedRef = useRef(false);
  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.backupOperations();
        if (cancelled) return;
        const restored = selectRehydratedOperation(response.operations);
        if (!restored) return;
        const source = backupOperationTabSource(restored);
        setOperation((prev) => prev ?? restored);
        setOperationSource((prev) => prev ?? source);
        setTab(source === "history" ? "verify" : source);
        if (isBackupStateTerminal(restored.state)) {
          // Preserve the finished status without replaying its toast.
          notifiedRef.current = restored.id;
        }
        if (restored.kind === "verify" && restored.state === "completed" && restored.verify?.ok) {
          setVerified({ path: restored.verify.snapshotPath, operationId: restored.id });
        }
        if (restored.snapshotPath) setRestoreSnapshotPath(restored.snapshotPath);
      } catch (error) {
        if (!cancelled) setActionError(messageOf(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setOperation]);

  // Terminal operation notifications. Ambiguous outcomes never produce a
  // success toast; a failed verification never does either.
  useEffect(() => {
    if (!operation || !isBackupOperationTerminal(operation)) return;
    if (notifiedRef.current === operation.id) return;
    const source = operationSource;
    if (source === null) return;
    notifiedRef.current = operation.id;
    if (operation.kind === "create") {
      if (operation.state === "completed") {
        toast.success(tr("backup.outcome_backup_created_unverified"), {
          description: operation.create
            ? operation.create.snapshot.snapshotPath
            : undefined,
        });
      } else if (isBackupOperationFailure(operation)) {
        toast.error(tr(backupStateLabelKey(operation.state)), {
          description: operation.error?.message,
          duration: Infinity,
        });
      }
      if (tab === "history") void loadHistory();
    } else if (operation.kind === "verify") {
      if (operation.state === "completed" && operation.verify?.ok) {
        setVerified({ path: operation.verify.snapshotPath, operationId: operation.id });
        toast.success(tr("backup.outcome_verified"), {
          description: tr("backup.file_count") + ": " + String(operation.verify.filesChecked),
        });
        if (verifyPurpose === "restore") {
          void loadPreview(operation.verify.snapshotPath, operation.id);
        } else if (verifyPurpose === "history") {
          void loadHistory();
        }
      } else if (isBackupOperationFailure(operation)) {
        toast.error(tr("backup.failed_badge"), {
          description: operation.verificationIssues[0] ?? operation.error?.message,
          duration: Infinity,
        });
      }
    } else if (operation.kind === "restore") {
      if (operation.state === "completed") {
        if (operation.restore?.destinationPath) {
          setActivationRestore({ path: operation.restore.destinationPath, summary: operation.restore });
        }
        if (operation.integrity === "verified") {
          toast.success(tr("backup.outcome_restored_not_activated"), {
            description: operation.restore?.destinationPath,
          });
        } else {
          toast.warning(tr("backup.outcome_restored_not_activated_unverified"), {
            description: operation.restore?.destinationPath,
          });
        }
      } else if (isBackupOperationFailure(operation)) {
        if (operation.error?.code === "SNAPSHOT_CHANGED") {
          // The approved preview no longer describes the snapshot. Require a
          // new verification and preview before another restore attempt.
          setPreview(null);
          setVerified(null);
        }
        toast.error(tr(backupStateLabelKey(operation.state)), {
          description: operation.error?.message,
          duration: Infinity,
        });
      }
    }
    // `loadPreview`/`loadHistory` are stable callbacks; notifying once per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, operationSource, tab, verifyPurpose]);

  const loadPreview = useCallback(async (path: string, verificationId: string) => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await api.previewBackupRestore(path, verificationId));
    } catch (error) {
      setPreview(null);
      setPreviewError(messageOf(error));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const startOperation = useCallback(
    (next: BackupOperationView, source: OperationSource) => {
      notifiedRef.current = null;
      setOperationSource(source);
      setActionError(null);
      setOperation(next);
    },
    [setOperation],
  );

  const startVerify = useCallback(
    async (path: string, purpose: "verify" | "restore" | "history") => {
      if (!path) {
        setActionError(tr("backup.select_snapshot_first"));
        return;
      }
      setActionBusy(true);
      setVerifyPurpose(purpose);
      setActionError(null);
      if (purpose !== "verify") setPreview(null);
      try {
        const response = await api.verifyBackup(path);
        startOperation(response.operation, purpose === "restore" ? "restore" : purpose === "history" ? "history" : "verify");
      } catch (error) {
        setActionError(messageOf(error));
      } finally {
        setActionBusy(false);
      }
    },
    [startOperation],
  );

  const chooseDestination = async (
    purpose: BackupPickPurpose,
  ): Promise<{ id?: string; path: string } | null> => {
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await api.pickBackupDestination(purpose);
      if (response.cancelled || !response.path) return null;
      return { id: response.grantId, path: response.path };
    } catch (error) {
      setActionError(messageOf(error));
      return null;
    } finally {
      setActionBusy(false);
    }
  };

  const onCreate = async () => {
    if (!createGrant) {
      setActionError(tr("backup.choose_destination_first"));
      return;
    }
    const ok = await confirm({
      title: tr("backup.confirm_create_title"),
      description: (
        <div className="space-y-2">
          <p>{tr("backup.confirm_create_body", { path: createGrant.path })}</p>
          <p className="font-medium">{tr("backup.warning_unencrypted_body")}</p>
        </div>
      ),
      confirmLabel: tr("backup.create_button"),
    });
    if (!ok) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await api.createBackup(createGrant.id);
      startOperation(response.operation, "create");
      setCreateGrant(null);
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setActionBusy(false);
    }
  };

  const createDestination = restoreGrant
    ? destinationName.trim().length > 0
      ? `${restoreGrant.path.replace(/\/$/, "")}/${destinationName.trim()}`
      : tr("backup.destination_generated", { path: restoreGrant.path })
    : destinationName.trim().length > 0
      ? `managed-profiles/${destinationName.trim()}`
      : "managed-profiles/forgeorbit-restored-…";

  const destinationNameInvalid =
    destinationName.trim().length > 0 &&
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(destinationName.trim());

  const onRestore = async () => {
    if (!restoreSnapshotPath) {
      setActionError(tr("backup.select_snapshot_first"));
      return;
    }
    if (!preview) {
      setActionError(tr("backup.verify_before_restore"));
      return;
    }
    if (!verified || verified.path !== restoreSnapshotPath) {
      setActionError(tr("backup.verify_before_restore"));
      return;
    }
    if (destinationNameInvalid) {
      setActionError(tr("backup.destination_name_invalid"));
      return;
    }
    const finalPath = restoreGrant
      ? (destinationName.trim().length > 0
          ? `${restoreGrant.path.replace(/\/$/, "")}/${destinationName.trim()}`
          : tr("backup.destination_generated", { path: restoreGrant.path }))
      : destinationName.trim().length > 0
        ? `managed-profiles/${destinationName.trim()}`
        : "managed-profiles/forgeorbit-restored-…";
    const ok = await confirm({
      title: tr("backup.confirm_restore_title"),
      description: (
        <div className="space-y-2">
          <p>{tr("backup.confirm_restore_body", { path: finalPath })}</p>
          <p className="font-medium">{tr("backup.restored_body")}</p>
          <p>{tr("backup.readiness_advisory")}</p>
        </div>
      ),
      confirmLabel: tr("backup.restore_button"),
    });
    if (!ok) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await api.restoreBackup({
        snapshotPath: restoreSnapshotPath,
        grantId: restoreGrant?.id,
        verificationId: verified.operationId,
        destinationName: destinationName.trim() || undefined,
        managed: !restoreGrant,
      });
      startOperation(response.operation, "restore");
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setActionBusy(false);
    }
  };

  const onCancel = async () => {
    if (!operation) return;
    setActionBusy(true);
    try {
      const response = await api.cancelBackupOperation(operation.id);
      setOperation(response.operation);
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setActionBusy(false);
    }
  };

  const onAddLocation = async () => {
    const chosen = await chooseDestination("history-location");
    if (!chosen?.id) return;
    setActionBusy(true);
    try {
      await api.addBackupLocation(chosen.id);
      await loadHistory();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setActionBusy(false);
    }
  };

  const scope = backupEstimatedScope(profile);
  const activeOperationForTab =
    operation &&
    operationSource !== null &&
    ((tab === "create" && operationSource === "create") ||
      (tab === "verify" && (operationSource === "verify" || operationSource === "history")) ||
      (tab === "history" && operationSource === "history") ||
      (tab === "restore" && operationSource === "restore"));

  if (profileLoading && !profile) {
    return <LoadingState label={tr("backup.loading")} testId="backup-loading" />;
  }
  if (profileError && !profile) {
    return (
      <div className="space-y-3 pt-3">
        <ErrorState
          message={tr("backup.load_failed") + " " + profileError}
          action={
            <Button size="sm" variant="outline" onClick={() => void loadProfile()}>
              {tr("backup.refresh")}
            </Button>
          }
          testId="backup-load-error"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-3 text-sm" data-testid="backup-recovery-section">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{tr("backup.title")}</h3>
        <p className="max-w-prose text-xs text-muted-foreground">{tr("backup.intro")}</p>
      </div>

      <div role="tablist" aria-label={tr("backup.title")} className="ds-tabs flex max-w-full flex-wrap gap-1">
        {BACKUP_TABS.map((item) => (
          <Button
            key={item.id}
            size="sm"
            role="tab"
            aria-selected={tab === item.id}
            variant={tab === item.id ? "secondary" : "ghost"}
            onClick={() => setTab(item.id)}
            data-testid={`backup-nav-tab-${item.id}`}
          >
            {tr(item.labelKey)}
          </Button>
        ))}
      </div>

      {actionError && (
        <ErrorState
          message={actionError}
          action={
            <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
              {tr("common.dismiss")}
            </Button>
          }
          testId="backup-action-error"
        />
      )}

      {pollError && (
        <ErrorState
          message={`${tr("backup.status_connection_error")} ${pollError}`}
          action={
            <Button size="sm" variant="outline" onClick={retryPoll}>
              <RefreshCw className="size-3.5" />
              {tr("backup.status_retry")}
            </Button>
          }
          testId="backup-operation-poll-error"
        />
      )}

      {tab === "create" && (
        <div className="space-y-3" data-testid="backup-tab-create">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{tr("backup.create_heading")}</CardTitle>
              <p className="text-xs text-muted-foreground">{tr("backup.create_coverage_body")}</p>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{tr("backup.create_coverage_title")}</Badge>
                <Badge variant="outline">{tr(backupCoverageLabelKey(profile?.coverage ?? null))}</Badge>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="backup-brain-new-snapshots">
                {tr("backup.brain_new_snapshots")}
              </p>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{tr("backup.source_profile")}</dt>
                  <dd className="break-words font-mono" title={profile?.profileRoot}>
                    {profile ? pathLabel(profile.profileRoot) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{tr("backup.create_database")}</dt>
                  <dd>
                    {profile?.databaseFilename ?? "—"} · {formatByteSize(profile?.databaseBytes)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{tr("backup.create_scope_title")}</dt>
                  <dd data-testid="backup-estimated-scope">
                    {scope
                      ? tr("backup.create_scope_body", {
                          files: String(scope.files),
                          size: formatByteSize(scope.bytes),
                        })
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{tr("backup.create_assets")}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {(profile?.categories ?? []).map((category) => (
                      <Badge key={category.id} variant="outline">
                        {category.id} · {category.fileCount}
                      </Badge>
                    ))}
                  </dd>
                </div>
              </dl>
              {scope?.truncated && <p className="text-xs text-muted-foreground">{tr("backup.create_scope_truncated")}</p>}
              <p className="text-xs text-muted-foreground">{tr("backup.source_profile_body")}</p>
              <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
                <p className="font-medium text-warning">{tr("backup.warning_unencrypted_title")}</p>
                <p className="mt-1 text-muted-foreground">{tr("backup.warning_unencrypted_body")}</p>
              </div>
              <div>
                <p className="text-xs font-medium">{tr("backup.not_included_title")}</p>
                <p className="text-xs text-muted-foreground">{tr("backup.not_included_body")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{tr("backup.excluded_note")}</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const chosen = await chooseDestination("backup-parent");
                    if (chosen?.id) setCreateGrant({ id: chosen.id, path: chosen.path });
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  {tr("backup.choose_folder")}
                </Button>
                {createGrant && (
                  <p className="break-words text-xs" title={createGrant.path}>
                    {tr("backup.destination")}: <span className="font-mono">{pathLabel(createGrant.path)}</span>
                  </p>
                )}
                <Button size="sm" disabled={busy || !createGrant} onClick={() => void onCreate()}>
                  <DatabaseBackup className="size-3.5" />
                  {tr("backup.create_button")}
                </Button>
              </div>
            </CardContent>
          </Card>
          {activeOperationForTab && (
            <BackupOperationCard
              operation={operation!}
              onCancel={() => void onCancel()}
              onVerifySnapshot={(path) => {
                setTab("verify");
                void startVerify(path, "verify");
              }}
              onOpenVerify={() => setTab("verify")}
              cancelBusy={actionBusy}
            />
          )}
        </div>
      )}

      {tab === "verify" && (
        <div className="space-y-3" data-testid="backup-tab-verify">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{tr("backup.verify_heading")}</CardTitle>
              <p className="text-xs text-muted-foreground">{tr("backup.verify_intro")}</p>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const chosen = await chooseDestination("snapshot");
                    if (chosen) {
                      setSnapshotPath(chosen.path);
                      setVerified(null);
                    }
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  {tr("backup.choose_snapshot")}
                </Button>
                <span className="min-w-0 break-words text-xs" title={snapshotPath ?? undefined}>
                  {snapshotPath ? pathLabel(snapshotPath) : tr("backup.no_snapshot_selected")}
                </span>
                <Button
                  size="sm"
                  disabled={busy || !snapshotPath}
                  onClick={() => snapshotPath && void startVerify(snapshotPath, "verify")}
                >
                  <ShieldCheck className="size-3.5" />
                  {tr("backup.verify_button")}
                </Button>
              </div>
              {operation?.kind === "verify" && operation.verify && !activeOperationForTab && (
                <VerificationSummary summary={operation.verify} />
              )}
            </CardContent>
          </Card>
          {activeOperationForTab && (
            <BackupOperationCard
              operation={operation!}
              onCancel={() => void onCancel()}
              onOpenVerify={() => setTab("verify")}
              cancelBusy={actionBusy}
            />
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-3" data-testid="backup-tab-history">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-medium">{tr("backup.history_heading")}</h4>
              <p className="max-w-prose text-xs text-muted-foreground">{tr("backup.history_intro")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy || historyLoading} onClick={() => void loadHistory()}>
                <RefreshCw className={cn("size-3.5", historyLoading && "motion-safe:animate-spin")} />
                {tr("backup.refresh_history")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onAddLocation()}>
                <FolderOpen className="size-3.5" />
                {tr("backup.add_location")}
              </Button>
            </div>
          </div>
          {historyError && <ErrorState message={historyError} testId="backup-history-error" />}
          {historyLoading && !history && <LoadingState label={tr("backup.loading")} testId="backup-history-loading" />}
          {history && history.entries.length === 0 && (
            <EmptyState
              title={tr("backup.history_empty_title")}
              description={tr("backup.history_empty_body")}
              testId="backup-history-empty"
            />
          )}
          {history && history.entries.length > 0 && (
            <ul className="space-y-2" data-testid="backup-history-list">
              {history.entries.map((entry) => (
                <HistoryRow
                  key={entry.snapshotPath}
                  entry={entry}
                  busy={busy}
                  onVerify={(path) => void startVerify(path, "history")}
                />
              ))}
            </ul>
          )}
          {history && history.locations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {tr("backup.location")}:{" "}
              {history.locations.map((location, index) => (
                <span key={location} className="font-mono">
                  {index > 0 ? " · " : ""}
                  {pathLabel(location)}
                </span>
              ))}
            </p>
          )}
          {activeOperationForTab && (
            <BackupOperationCard
              operation={operation!}
              onCancel={() => void onCancel()}
              onVerifySnapshot={(path) => void startVerify(path, "history")}
              onOpenVerify={() => setTab("verify")}
              cancelBusy={actionBusy}
            />
          )}
        </div>
      )}

      {tab === "restore" && (
        <div className="space-y-3" data-testid="backup-tab-restore">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{tr("backup.restore_heading")}</CardTitle>
              <p className="text-xs text-muted-foreground">{tr("backup.restore_intro")}</p>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="backup-choose-snapshot-button"
                  disabled={busy}
                  onClick={async () => {
                    const chosen = await chooseDestination("snapshot");
                    if (chosen) {
                      setRestoreSnapshotPath(chosen.path);
                      setVerified(null);
                      setPreview(null);
                      setPreviewError(null);
                    }
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  {tr("backup.choose_snapshot")}
                </Button>
                <Input
                  value={restoreSnapshotPath ?? ""}
                  onChange={async (e) => {
                    const val = e.target.value.trim();
                    setRestoreSnapshotPath(val || null);
                    setVerified(null);
                    setPreview(null);
                    setPreviewError(null);
                    if (val) {
                      try {
                        await api.selectSnapshot(val);
                      } catch {
                        /* verification will catch invalid paths */
                      }
                    }
                  }}
                  placeholder="/path/to/snapshot"
                  aria-label={tr("backup.snapshot_path")}
                  data-testid="backup-snapshot-path-input"
                  className="h-8 text-xs max-w-xs font-mono"
                  disabled={busy}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="backup-verify-snapshot-button"
                  disabled={busy || !restoreSnapshotPath}
                  onClick={() => restoreSnapshotPath && void startVerify(restoreSnapshotPath, "restore")}
                >
                  <ShieldCheck className="size-3.5" />
                  {tr("backup.verify_button")}
                </Button>
                {verified && restoreSnapshotPath && verified.path === restoreSnapshotPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || previewLoading}
                    onClick={() => void loadPreview(restoreSnapshotPath, verified.operationId)}
                  >
                    {previewLoading ? tr("backup.previewing") : tr("backup.preview_button")}
                  </Button>
                )}
              </div>
              {previewError && <ErrorState message={previewError} testId="backup-preview-error" />}
              {previewLoading && <LoadingState label={tr("backup.previewing")} testId="backup-preview-loading" />}
              {preview && <RecoveryPreviewCard preview={preview} />}
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium">{tr("backup.destination_parent")}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      const chosen = await chooseDestination("restore-parent");
                      if (chosen?.id) {
                        setRestoreGrant({ id: chosen.id, path: chosen.path });
                        if (destinationName.trim().length === 0) {
                          const now = new Date();
                          const pad = (n: number) => String(n).padStart(2, "0");
                          setDestinationName(
                            `forgeorbit-restored-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
                          );
                        }
                      }
                    }}
                  >
                    <FolderOpen className="size-3.5" />
                    {tr("backup.choose_parent")}
                  </Button>
                  <span className="min-w-0 break-words text-xs" title={restoreGrant?.path}>
                    {restoreGrant ? pathLabel(restoreGrant.path) : "—"}
                  </span>
                </div>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">{tr("backup.destination_name")}</span>
                  <Input
                    value={destinationName}
                    onChange={(event) => setDestinationName(event.target.value)}
                    placeholder="forgeorbit-restored-…"
                    aria-invalid={destinationNameInvalid}
                    disabled={busy}
                    data-testid="backup-destination-name"
                  />
                  <span className={cn("block text-xs", destinationNameInvalid ? "text-destructive" : "text-muted-foreground")}>
                    {destinationNameInvalid ? tr("backup.destination_name_invalid") : tr("backup.destination_name_hint")}
                  </span>
                </label>
                {createDestination && (
                  <p className="break-words text-xs" data-testid="backup-destination-result">
                    {tr("backup.destination_result")}:{" "}
                    <span className="font-mono">{createDestination}</span>
                  </p>
                )}
                <Button
                  size="sm"
                  data-testid="backup-restore-button"
                  disabled={busy || !restoreSnapshotPath || !preview || !verified || destinationNameInvalid}
                  onClick={() => void onRestore()}
                >
                  {tr("backup.restore_button")}
                </Button>
              </div>
            </CardContent>
          </Card>
          <ProfileActivationPanel
            candidatePath={activationRestore?.path ?? null}
            restoreSummary={activationRestore?.summary ?? null}
            busy={busy}
          />
          {activeOperationForTab && (
            <BackupOperationCard
              operation={operation!}
              onCancel={() => void onCancel()}
              onVerifySnapshot={(path) => void startVerify(path, "restore")}
              onOpenVerify={() => setTab("verify")}
              cancelBusy={actionBusy}
            />
          )}
        </div>
      )}
    </div>
  );
}

export const __backupRecoveryInternals = { messageOf, pathLabel };
