import { useRef, useState } from "react";
import { publishTaskAssignmentChanged } from "@/lib/task-assignment-events";
import { Badge } from "@/components/ui/badge";
import { priorityText } from "@/lib/status-presenters";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/core";
import { api } from "@/lib/api";
import { knownText } from "@/lib/known-text";
import type { HeadBoardEditPreview, HeadBoardProposal } from "../../../shared/head-pm-scope.ts";
import { MissionResourceReview } from "../orchestration/MissionResourceReview";
import type { TaskStagingGrant } from "../../../shared/execution/workspace-grant.ts";
import type { Task } from "../../../shared/types.ts";
import { GoalJourney } from "../workspace/manager/GoalJourney";

function resolveEditPreview(proposal: HeadBoardProposal, tasks?: readonly Task[]): HeadBoardEditPreview | null {
  const action = proposal.action;
  if (action.kind !== "edit") return null;
  if (proposal.editPreview) return proposal.editPreview;
  const rawAction = action as unknown as Record<string, unknown>;
  const task = tasks?.find((item) => item.id === action.taskId) ?? null;
  const currentTitle = task?.title ?? null;
  const currentDescription = task?.prompt ?? null;
  const nextTitle = typeof rawAction.title === "string" && rawAction.title.trim().length > 0 ? rawAction.title : null;
  const hasBlank = (Object.hasOwn(rawAction, "description") && rawAction.description !== undefined && (typeof rawAction.description !== "string" || rawAction.description.trim().length === 0))
    || (Object.hasOwn(rawAction, "prompt") && rawAction.prompt !== undefined && (typeof rawAction.prompt !== "string" || rawAction.prompt.trim().length === 0));
  const rawDesc = !hasBlank && typeof rawAction.description === "string" && rawAction.description.trim().length > 0 ? rawAction.description : null;
  const descriptionStatus: HeadBoardEditPreview["descriptionStatus"] = hasBlank
    ? "unsafe-blank"
    : rawDesc !== null && (proposal.status !== "pending" || currentDescription === null || rawDesc !== currentDescription)
      ? "updated"
      : "unchanged";
  const titleChanged = nextTitle !== null && (
    proposal.status === "pending"
      ? (currentTitle === null ? true : nextTitle !== currentTitle)
      : (descriptionStatus !== "updated" || (currentTitle !== null && nextTitle !== currentTitle))
  );
  return {
    taskId: action.taskId,
    currentTitle,
    nextTitle,
    titleChanged,
    currentDescription,
    nextDescription: descriptionStatus === "updated" ? rawDesc : null,
    descriptionStatus,
  };
}

export function HeadBoardProposalCard({ proposal, onChange, onOpenProject, onOpenTask, tasks, onOpenTaskRecord }: {
  proposal: HeadBoardProposal;
  onChange: (value: HeadBoardProposal) => void;
  onOpenProject: (path: string) => void;
  onOpenTask: (id: string) => boolean | Promise<boolean>;
  /** With these, an applied card shows where its task stands now (M6): stage, quality check, next step. */
  tasks?: readonly Task[];
  onOpenTaskRecord?: (task: Task) => void;
}) {
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowStaging, setAllowStaging] = useState(false);
  const [outputPaths, setOutputPaths] = useState("");
  const act = async (decision: "approve" | "reject") => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    const permission: TaskStagingGrant | undefined = decision === "approve" && proposal.action.kind === "plan_execution" && allowStaging && proposal.context.projectPath
      ? {
          operation: "developer-execution",
          projectPath: proposal.context.projectPath,
          scope: "task-staging",
          outputPaths: outputPaths.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        }
      : undefined;
    try {
      const updated = await api.settleHeadBoardProposal(proposal.messageId, decision, permission, proposal.action.kind === "replan_mission" ? proposal.action.digest : undefined);
      onChange(updated);
      if (updated.status === "applied" && updated.action.kind === "assign") publishTaskAssignmentChanged(updated.action.taskId);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busy.current = false; setWorking(false); }
  };
  const { action, context, status } = proposal;
  const name = action.kind === "replan_mission" ? t("usage.replanTitle")
    : action.kind === "create" ? t("headPm.board.create")
    : action.kind === "edit" ? t("headPm.board.edit")
    : action.kind === "admit" ? t("headPm.board.admit")
    : action.kind === "stage_ready" ? t("headPm.board.stage_ready")
    : action.kind === "assign" ? t("headPm.board.assign")
    : action.kind === "plan_execution" ? t("headPm.board.plan_execution")
    : action.kind === "execute" ? t("headPm.board.execute")
    : action.kind === "request_qc" ? t("headPm.board.request_qc")
    : action.kind === "rework" ? t("headPm.board.rework")
    : action.kind === "complete" ? t("headPm.board.complete")
    : t("headPm.board.prioritize");
  const statusLabel = status === "pending" ? t("headPm.board.pending")
    : status === "applied" ? t("headPm.board.applied")
    : status === "rejected" ? t("headPm.board.rejected")
    : status === "failed" ? t("headPm.board.failed")
    : t("headPm.board.applying");
  const affected = proposal.affectedProjects?.length ? proposal.affectedProjects
    : context.projectPath ? [{ path: context.projectPath, name: context.label }] : [];
  const taskId = proposal.taskId ?? ("taskId" in action ? action.taskId : null);
  const editPreview = resolveEditPreview(proposal, tasks);
  const unsafeBlankEdit = editPreview?.descriptionStatus === "unsafe-blank";
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3 text-sm [overflow-wrap:anywhere]"
      data-testid="head-pm-board-proposal" data-status={status} data-kind={action.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-semibold">{name}</h3>
        <Badge variant={status === "pending" ? "warning" : status === "applied" ? "success" : status === "failed" ? "destructive" : "secondary"}
          data-testid="head-pm-board-status">{statusLabel}</Badge>
      </div>
      {action.kind !== "edit" && <p className="font-medium">{action.title}</p>}
      {affected.length === 0 && <p className="text-xs text-muted-foreground">{context.label}</p>}
      {affected.length > 0 && (
        <p className="text-xs font-medium text-muted-foreground" data-testid="head-pm-board-affected" title={affected.map((p) => p.path).join("\n")} data-projects={affected.map((p) => p.path).join("|")}>
          {t("d3.board.affects", { projects: affected.map((p) => p.name).join(", ") })}
        </p>
      )}
      {action.kind === "create" && "description" in action && action.description && (
        <p className="whitespace-pre-wrap break-words">{action.description}</p>
      )}
      {action.kind === "edit" && editPreview && (
        <div className="space-y-2 rounded-md bg-muted/45 p-3 text-sm" data-testid="head-pm-edit-preview">
          <p data-testid="head-pm-edit-task">
            <span className="font-medium text-foreground">{t("headPm.board.editTask")}:</span>{" "}
            <span title={editPreview.taskId}>{editPreview.currentTitle ?? action.title}</span>
          </p>
          <p data-testid="head-pm-edit-title">
            <span className="font-medium text-foreground">{t("headPm.board.editTitle")}:</span>{" "}
            {editPreview.titleChanged && editPreview.nextTitle
              ? (editPreview.currentTitle && editPreview.currentTitle !== editPreview.nextTitle
                ? t("headPm.board.editTitleChange", { from: editPreview.currentTitle, to: editPreview.nextTitle })
                : editPreview.nextTitle)
              : t("headPm.board.editUnchanged")}
          </p>
          <div className="space-y-1" data-testid="head-pm-edit-description" data-description-status={editPreview.descriptionStatus}>
            <p>
              <span className="font-medium text-foreground">{t("headPm.board.editDescription")}:</span>{" "}
              {editPreview.descriptionStatus === "unchanged" && (
                <span className="text-muted-foreground">{t("headPm.board.editUnchanged")}</span>
              )}
              {editPreview.descriptionStatus === "updated" && (
                <span>{t("headPm.board.editProposed")}</span>
              )}
            </p>
            {editPreview.descriptionStatus === "updated" && (
              <div className="space-y-1 pl-2 border-l border-border">
                {editPreview.currentDescription !== null && status === "pending" && (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground" data-testid="head-pm-edit-description-current">
                    <span className="font-medium">{t("headPm.board.editCurrent")}:</span> {editPreview.currentDescription}
                  </p>
                )}
                {editPreview.nextDescription && (
                  <p className="whitespace-pre-wrap break-words text-foreground" data-testid="head-pm-edit-description-next">
                    <span className="font-medium">{t("headPm.board.editProposed")}:</span> {editPreview.nextDescription}
                  </p>
                )}
              </div>
            )}
            {editPreview.descriptionStatus === "unsafe-blank" && (
              <p role="alert" className="text-danger" data-testid="head-pm-edit-unsafe-blank">
                {t("headPm.board.editUnsafeBlank")}
              </p>
            )}
          </div>
        </div>
      )}
      {action.kind === "assign" && <p>{action.employeeName} · {t("headPm.board.separateLaunch")}</p>}
      {action.kind === "prioritize" && <p>{priorityText(action.priority)}</p>}
      {action.kind === "plan_execution" && <p>{action.employeeName} ({action.harnessId}{action.model ? ` / ${action.model}` : ""})</p>}
      {action.kind === "plan_execution" && status === "pending" && context.projectPath && (
        <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5" data-testid="head-pm-staging-permission">
          <p role="status">{t("headPm.board.stagingPermission", { path: context.projectPath })}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={allowStaging}
              onChange={(event) => setAllowStaging(event.target.checked)}
              aria-label={t("headPm.board.stagingApprove")}
              data-testid="head-pm-staging-grant"
            />
            <span>{t("headPm.board.stagingApprove")}</span>
          </label>
          <label className="block">
            <span className="mb-1 block font-medium">{t("headPm.board.stagingOutputs")}</span>
            <textarea
              className="min-h-14 w-full rounded-md border bg-background px-2 py-1"
              value={outputPaths}
              onChange={(event) => setOutputPaths(event.target.value)}
              aria-label={t("headPm.board.stagingOutputs")}
              data-testid="head-pm-staging-outputs"
            />
            <span className="mt-1 block text-muted-foreground">{t("headPm.board.stagingOutputsHint")}</span>
          </label>
        </div>
      )}
      {action.kind === "execute" && <p>{action.employeeName ?? proposal.specialistName ?? t("m0.assignedSpecialist")} ({action.harnessId ?? proposal.provider ?? t("m0.configuredHarness")})</p>}
      {action.kind === "request_qc" && <p>{action.reviewerHarness ?? "QC Reviewer"}{action.reviewerModel ? ` (${action.reviewerModel})` : ""}</p>}
      {action.kind === "rework" && action.feedback && <p className="italic text-muted-foreground">{action.feedback}</p>}

      {proposal.missionResource && <MissionResourceReview proposal={proposal.missionResource} />}

      {/* Unified proposal metadata (Section 5) */}
      {proposal.permissions && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{t("headPm.board.permissions")}:</span> {knownText(proposal.permissions)}
        </p>
      )}
      {proposal.policy && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{t("headPm.board.policy")}:</span> {knownText(proposal.policy)}
        </p>
      )}
      {proposal.sideEffects && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{t("headPm.board.sideEffects")}:</span> {knownText(proposal.sideEffects)}
        </p>
      )}
      {proposal.result && (
        <p className="text-[11px] text-muted-foreground font-mono">
          <span className="font-medium font-sans text-foreground">{t("headPm.board.result")}:</span> {typeof proposal.result === "string" ? proposal.result : JSON.stringify(proposal.result)}
        </p>
      )}

      {(error || proposal.error) && <div role="alert" className="text-danger">
        <p>{t("headPm.board.applyError")}</p>
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("manager.details")}</summary>
          <p>{error ?? proposal.error}</p>
        </details>
      </div>}
      {status === "applied" && taskId && tasks && onOpenTaskRecord && (action.kind === "create" || action.kind === "execute" || action.kind === "request_qc") && (
        <GoalJourney compact tasks={tasks} taskIds={[taskId]} onOpenTask={onOpenTaskRecord} />
      )}
      <div className="flex flex-wrap gap-1 pt-0.5">
        {status === "pending" && <>
          <Button type="button" size="sm" disabled={working || unsafeBlankEdit} onClick={() => void act("approve")}
            data-testid="head-pm-board-approve">{t(action.kind === "replan_mission" ? "usage.replanApprove" : action.kind === "edit" ? "headPm.board.applyEdit" : "headPm.board.approve")}</Button>
          <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void act("reject")}
            data-testid="head-pm-board-reject">{t(action.kind === "replan_mission" ? "usage.replanReject" : "headPm.board.reject")}</Button>
        </>}
        {context.projectPath && <Button type="button" size="sm" variant="ghost" onClick={() => onOpenProject(context.projectPath!)}>
          {t("headPm.board.openProject")}
        </Button>}
        {taskId && <Button type="button" size="sm" variant="ghost" onClick={() => {
          void Promise.resolve(onOpenTask(taskId)).then((opened) => {
            if (!opened && context.projectPath) onOpenProject(context.projectPath);
          });
        }} data-testid="head-pm-board-open-task">{t("headPm.board.openTask")}</Button>}
      </div>
    </section>
  );
}
