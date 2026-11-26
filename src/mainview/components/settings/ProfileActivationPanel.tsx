import { t as tr } from "@/i18n/core";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { api, ApiError } from "@/lib/api";
import { shortenPath } from "@/lib/path-display";
import { backupReadinessLabelKey } from "@/lib/backup-recovery";
import type { BackupRestoreSummary, ProjectRecoveryInfo } from "../../../shared/backup.ts";
import type {
  ProfileActivationCandidateResponse,
  ProfileActivationStatusResponse,
} from "../../../shared/profile-activation.ts";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function pathLabel(path: string): string {
  return shortenPath(path, "", 4);
}

export function ProfileActivationPanel({
  candidatePath,
  restoreSummary,
  busy,
}: {
  candidatePath: string | null;
  restoreSummary: BackupRestoreSummary | null;
  busy: boolean;
}) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<ProfileActivationStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ProfileActivationCandidateResponse | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const [relinkDialogOpen, setRelinkDialogOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectRecoveryInfo | null>(null);
  const [relinkNewPath, setRelinkNewPath] = useState("");
  const [relinkBusy, setRelinkBusy] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [lastRelinkOutcome, setLastRelinkOutcome] = useState<{
    projectName: string;
    newPath: string;
    reboundBrainMemories: number;
  } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.profileActivationStatus();
      setStatus(next);
      setStatusError(null);
    } catch (error) {
      setStatusError(messageOf(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, candidatePath]);

  const runInspect = useCallback(async () => {
    if (!candidatePath) return;
    setInspectLoading(true);
    setInspectError(null);
    try {
      const result = await api.inspectProfileActivationCandidate(candidatePath);
      setInspection(result);
    } catch (error) {
      setInspection(null);
      setInspectError(messageOf(error));
    } finally {
      setInspectLoading(false);
    }
  }, [candidatePath]);

  useEffect(() => {
    if (candidatePath) {
      void runInspect();
    } else {
      setInspection(null);
      setInspectError(null);
    }
  }, [candidatePath, runInspect]);

  const handleRelinkProject = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!candidatePath || !selectedProject || relinkBusy) return;
    const trimmed = relinkNewPath.trim();
    if (!trimmed) return;
    setRelinkBusy(true);
    setRelinkError(null);
    try {
      const res = await api.relinkCandidateProject(candidatePath, selectedProject.projectPath, trimmed);
      toast.success(tr("profile_activation.relink_success"));
      setLastRelinkOutcome({
        projectName: selectedProject.name ?? selectedProject.projectPath,
        newPath: res.newPath,
        reboundBrainMemories: res.reboundBrainMemories,
      });
      setRelinkDialogOpen(false);
      setRelinkNewPath("");
      setSelectedProject(null);
      await runInspect();
    } catch (err) {
      setRelinkError(messageOf(err));
    } finally {
      setRelinkBusy(false);
    }
  };

  const onPrepare = useCallback(async () => {
    if (!candidatePath || !inspection?.ok) return;
    const ok = await confirm({
      title: tr("profile_activation.confirm_activate_title"),
      description: tr("profile_activation.confirm_activate_body", { path: pathLabel(candidatePath) }),
      confirmLabel: tr("profile_activation.prepare_button"),
    });
    if (!ok) return;
    setActionBusy(true);
    try {
      await api.prepareProfileActivation(candidatePath);
      await refreshStatus();
      toast.success(tr("profile_activation.prepare_success"));
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setActionBusy(false);
    }
  }, [candidatePath, confirm, inspection?.ok, refreshStatus]);

  const onRelaunch = useCallback(async () => {
    const ok = await confirm({
      title: tr("profile_activation.confirm_relaunch_title"),
      description: tr("profile_activation.confirm_relaunch_body"),
      confirmLabel: tr("profile_activation.relaunch_button"),
    });
    if (!ok) return;
    setActionBusy(true);
    try {
      await api.relaunchForProfileTransition();
      toast.message(tr("profile_activation.relaunch_started"));
    } catch (error) {
      toast.error(messageOf(error));
      setActionBusy(false);
    }
  }, [confirm]);

  const onRollbackPrepare = useCallback(async () => {
    const target = status?.rollback.targetPath;
    const ok = await confirm({
      title: tr("profile_activation.confirm_rollback_title"),
      description: tr("profile_activation.confirm_rollback_body", {
        path: target ? pathLabel(target) : "—",
      }),
      confirmLabel: tr("profile_activation.rollback_prepare_button"),
      variant: "destructive",
    });
    if (!ok) return;
    setActionBusy(true);
    try {
      await api.prepareProfileRollback();
      await refreshStatus();
      toast.success(tr("profile_activation.rollback_prepare_success"));
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setActionBusy(false);
    }
  }, [confirm, refreshStatus, status?.rollback.targetPath]);

  const controlsDisabled = busy || actionBusy;
  const pending = status?.pendingTransition ?? null;

  return (
    <Card data-testid="profile-activation-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{tr("profile_activation.title")}</CardTitle>
        <p className="text-xs text-muted-foreground">{tr("profile_activation.intro")}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {statusError && <p className="text-destructive">{statusError}</p>}
        {status && (
          <div className="space-y-1" data-testid="profile-activation-active">
            <p className="font-medium">{tr("profile_activation.active_profile")}</p>
            <p className="break-words font-mono" title={status.active.profileRoot}>
              {pathLabel(status.active.profileRoot)}
            </p>
            {status.active.identity && (
              <p className="text-muted-foreground">
                {tr("profile_activation.identity")}: <span className="font-mono">{status.active.identity}</span>
              </p>
            )}
          </div>
        )}

        {status?.startup.warnings.map((warning) => (
          <p key={warning} className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-warning">
            {warning}
          </p>
        ))}

        {pending && (
          <div className="space-y-2 rounded-md border border-border px-2 py-2" data-testid="profile-activation-pending">
            <Badge variant="secondary">{tr("profile_activation.pending_badge")}</Badge>
            <p>
              {tr("profile_activation.pending_body", {
                action: pending.action,
                path: pathLabel(pending.candidatePath),
              })}
            </p>
            {pending.error && (
              <p className="text-destructive">
                {pending.error.code}: {pending.error.message}
              </p>
            )}
            <Button
              size="sm"
              disabled={controlsDisabled}
              onClick={() => void onRelaunch()}
              data-testid="profile-activation-relaunch"
            >
              {tr("profile_activation.relaunch_button")}
            </Button>
          </div>
        )}

        {status?.rollback.available && !pending && (
          <div className="space-y-2 rounded-md border border-border px-2 py-2" data-testid="profile-activation-rollback">
            <p className="font-medium">{tr("profile_activation.rollback_title")}</p>
            <p className="text-muted-foreground">{tr("profile_activation.rollback_body")}</p>
            {status.rollback.targetPath && (
              <p className="break-words font-mono" title={status.rollback.targetPath}>
                {pathLabel(status.rollback.targetPath)}
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={controlsDisabled}
              onClick={() => void onRollbackPrepare()}
              data-testid="profile-activation-rollback-prepare"
            >
              <RotateCcw className="mr-1 size-3.5" />
              {tr("profile_activation.rollback_prepare_button")}
            </Button>
          </div>
        )}

        {candidatePath && (
          <div className="space-y-3 border-t border-border pt-3" data-testid="profile-activation-candidate">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{tr("profile_activation.candidate_title")}</p>
                <p className="break-words font-mono" title={candidatePath} data-testid="profile-activation-candidate-path">
                  {pathLabel(candidatePath)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" data-testid="candidate-import-status">
                  {tr("profile_activation.import_complete")}
                </Badge>
                {inspection?.ok ? (
                  <Badge variant="default" className="bg-success hover:bg-success/90 text-success-foreground" data-testid="candidate-readiness-badge">
                    {tr("profile_activation.ready_badge")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="border-warning/50 text-warning" data-testid="candidate-readiness-badge">
                    {tr("profile_activation.external_recovery_required")}
                  </Badge>
                )}
              </div>
            </div>

            {restoreSummary && (
              <div className="space-y-1 text-muted-foreground">
                <p>
                  {tr("backup.recovery_readiness")}:{" "}
                  <span className="text-foreground">{tr(backupReadinessLabelKey(restoreSummary.activationReadiness))}</span>
                </p>
              </div>
            )}

            {/* Candidate Missing External Projects */}
            {(() => {
              const candidateProjects = inspection?.recoveryPreview?.projects ?? [];
              const totalAttention = inspection?.recoveryPreview?.totalExternalProjectsRequiringAttention ?? 0;
              if (candidateProjects.length === 0) return null;
              return (
                <div className="space-y-2 rounded-md border border-border p-2.5" data-testid="candidate-missing-projects-section">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-xs">{tr("profile_activation.missing_projects_title")}</p>
                    <span className="text-[11px] text-muted-foreground" data-testid="candidate-unresolved-count">
                      {totalAttention > 0
                        ? tr("profile_activation.remaining_unresolved", { count: totalAttention })
                        : tr("profile_activation.all_projects_relinked")}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {tr("profile_activation.missing_projects_desc")}
                  </p>

                  {lastRelinkOutcome && (
                    <div className="rounded border border-success/30 bg-success/10 p-2 text-[11px] text-success" data-testid="candidate-relink-outcome">
                      {tr("profile_activation.relink_outcome", {
                        name: lastRelinkOutcome.projectName,
                        path: pathLabel(lastRelinkOutcome.newPath),
                        memories: lastRelinkOutcome.reboundBrainMemories,
                      })}
                    </div>
                  )}

                  <div className="space-y-1.5 pt-1">
                    {candidateProjects.map((proj) => {
                      const slug = (proj.name || proj.projectPath.split("/").pop() || "project")
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "-")
                        .replace(/^-|-$/g, "");
                      const isMissing = proj.requiresUserIntervention;
                      return (
                        <div
                          key={proj.projectPath}
                          className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/60 bg-muted/20 p-2"
                          data-testid={`candidate-project-row-${slug}`}
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-xs">{proj.name || proj.projectPath.split("/").pop()}</span>
                              {isMissing ? (
                                <Badge variant="destructive" className="text-[10px] py-0 px-1.5" data-testid={`candidate-project-status-${slug}`}>
                                  {tr("profile_activation.missing_on_disk")}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-success border-success/40" data-testid={`candidate-project-status-${slug}`}>
                                  {tr("profile_activation.present_on_disk")}
                                </Badge>
                              )}
                            </div>
                            <p className="break-words font-mono text-[11px] text-muted-foreground" title={proj.projectPath}>
                              {proj.projectPath}
                            </p>
                          </div>
                          {isMissing && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={controlsDisabled || relinkBusy}
                              onClick={() => {
                                setSelectedProject(proj);
                                setRelinkNewPath("");
                                setRelinkError(null);
                                setRelinkDialogOpen(true);
                              }}
                              data-testid={`candidate-relink-btn-${slug}`}
                            >
                              {tr("profile_activation.relink_button")}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={controlsDisabled || inspectLoading} onClick={() => void runInspect()}>
                {inspectLoading ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                {tr("profile_activation.inspect_button")}
              </Button>
              <Button
                size="sm"
                disabled={controlsDisabled || !inspection?.ok || Boolean(pending)}
                onClick={() => void onPrepare()}
                data-testid="profile-activation-prepare"
              >
                <Zap className="mr-1 size-3.5" />
                {tr("profile_activation.prepare_button")}
              </Button>
            </div>
            {inspectError && <p className="text-destructive">{inspectError}</p>}
            {inspection && !inspection.ok && (
              <p className="text-destructive" data-testid="profile-activation-inspect-failed">
                {inspection.code}: {inspection.message}
              </p>
            )}
            {inspection?.checks.length ? (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border p-2">
                {inspection.checks.map((check) => (
                  <li key={check.id} className={check.ok ? "text-muted-foreground" : "text-destructive"}>
                    {check.ok ? "✓" : "✗"} {check.id}
                    {check.detail ? ` — ${check.detail}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {!candidatePath && (
          <p className="text-muted-foreground">{tr("profile_activation.no_candidate")}</p>
        )}
      </CardContent>

      <Dialog
        open={relinkDialogOpen}
        onClose={() => !relinkBusy && setRelinkDialogOpen(false)}
        labelledBy="candidate-relink-dialog-title"
        describedBy="candidate-relink-dialog-desc"
        className="max-w-md p-4"
      >
        <form onSubmit={handleRelinkProject} data-testid="candidate-relink-dialog" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h3 id="candidate-relink-dialog-title" className="text-base font-semibold leading-none tracking-tight">
              {tr("profile_activation.relink_dialog_title")}
            </h3>
            <p id="candidate-relink-dialog-desc" className="text-xs text-muted-foreground">
              {tr("profile_activation.relink_dialog_desc")}
            </p>
          </div>
          {selectedProject && (
            <div className="rounded border border-border bg-muted/30 p-2 text-xs space-y-1">
              <p className="font-medium">{selectedProject.name || selectedProject.projectPath.split("/").pop()}</p>
              <p className="font-mono text-muted-foreground text-[11px] break-words">{selectedProject.projectPath}</p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="candidate-relink-input" className="text-xs font-medium">
              {tr("profile_activation.relink_input_label")}
            </label>
            <Input
              id="candidate-relink-input"
              data-testid="candidate-relink-input"
              value={relinkNewPath}
              onChange={(e) => setRelinkNewPath(e.target.value)}
              placeholder="/path/to/folder"
              disabled={relinkBusy}
              autoFocus
            />
            {relinkError && (
              <p className="text-xs text-destructive" role="alert" data-testid="candidate-relink-error">
                {relinkError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={relinkBusy}
              onClick={() => setRelinkDialogOpen(false)}
              data-testid="candidate-relink-cancel"
            >
              {tr("profile_activation.relink_cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={relinkBusy || !relinkNewPath.trim()}
              data-testid="candidate-relink-submit"
            >
              {relinkBusy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
              {tr("profile_activation.relink_submit")}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
