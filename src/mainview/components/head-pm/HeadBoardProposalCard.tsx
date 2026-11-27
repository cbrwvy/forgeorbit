import { useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
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

function friendlyProjectName(project: { path: string; name: string }): string {
  const raw = project.name.trim();
  if (!raw) return project.path.split("/").filter(Boolean).pop() ?? project.path;
  if (raw.startsWith("/") || raw.includes("/Users/")) {
    return raw.split("/").filter(Boolean).pop() ?? raw;
  }
  return raw;
}

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
  const [settledExpanded, setSettledExpanded] = useState(false);
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
    : action.kind === "create_batch" ? t("headPm.board.create_batch")
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
  const batchTaskIds = action.kind === "create_batch"
    ? (action.createdTaskIds ?? action.tasks.map((item) => item.createdTaskId).filter((id): id is string => Boolean(id)))
    : [];
  const journeyTaskIds = action.kind === "create_batch" ? batchTaskIds : (taskId ? [taskId] : []);
  const editPreview = resolveEditPreview(proposal, tasks);
  const unsafeBlankEdit = editPreview?.descriptionStatus === "unsafe-blank";
  const isSettled = status === "applied" || status === "rejected";
  const summarySubject =
    action.kind === "edit"
      ? (editPreview?.nextTitle ?? editPreview?.currentTitle ?? action.title)
      : action.kind === "create_batch"
        ? t("headPm.board.batchCount", { count: String(action.tasks.length) })
        : action.title;
  const hasTechMeta = Boolean(proposal.permissions || proposal.policy || proposal.result);
  const projectLabelByPath = new Map(affected.map((p) => [p.path, friendlyProjectName(p)]));

  // Settled proposals (already applied or rejected) collapse to a calm 1-line summary
  // so old history never overwhelms the chat window; full details stay one click away.
  if (isSettled && !settledExpanded) {
    return (
      <section
        className="rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-xs [overflow-wrap:anywhere]"
        data-testid="head-pm-board-proposal"
        data-status={status}
        data-kind={action.kind}
      >
        <div className="flex items-center gap-2">
          {status === "applied" ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
          ) : (
            <XCircle className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground">{name}</span>
            {summarySubject && (
              <span className="text-muted-foreground"> · {summarySubject}</span>
            )}
          </div>
          <Badge
            variant={status === "applied" ? "success" : "secondary"}
            data-testid="head-pm-board-status"
            className="shrink-0 text-[10px]"
          >
            {statusLabel}
          </Badge>
          <button
            type="button"
            onClick={() => setSettledExpanded(true)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            data-testid="head-pm-board-expand"
          >
            <span>{t("headPm.board.showDetails")}</span>
            <ChevronRight className="size-3" aria-hidden />
          </button>
        </div>
        {status === "applied" && journeyTaskIds.length > 0 && tasks && onOpenTaskRecord && (action.kind === "create" || action.kind === "create_batch" || action.kind === "execute" || action.kind === "request_qc") && (
          <div className="mt-2">
            <GoalJourney compact tasks={tasks} taskIds={journeyTaskIds} onOpenTask={onOpenTaskRecord} />
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      className={
        status === "pending"
          ? "space-y-2.5 rounded-xl border border-warning/35 bg-card p-3.5 text-sm shadow-sm [overflow-wrap:anywhere]"
          : "space-y-2.5 rounded-xl border border-border/70 bg-card/80 p-3 text-sm [overflow-wrap:anywhere]"
      }
      data-testid="head-pm-board-proposal"
      data-status={status}
      data-kind={action.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-1.5 font-semibold">
          <span>{name}</span>
          {action.kind === "create_batch" && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground" data-testid="head-pm-batch-count">
              {action.tasks.length}
            </span>
          )}
        </h3>
        <Badge
          variant={status === "pending" ? "warning" : status === "applied" ? "success" : status === "failed" ? "destructive" : "secondary"}
          data-testid="head-pm-board-status"
        >
          {statusLabel}
        </Badge>
        {isSettled && (
          <button
            type="button"
            onClick={() => setSettledExpanded(false)}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span>{t("headPm.board.hideDetails")}</span>
            <ChevronDown className="size-3" aria-hidden />
          </button>
        )}
      </div>
      {action.kind !== "edit" && action.kind !== "create_batch" && <p className="font-medium">{action.title}</p>}
      {affected.length === 0 && <p className="text-xs text-muted-foreground">{context.label}</p>}
      {affected.length > 0 && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="head-pm-board-affected"
          title={affected.map((p) => p.path).join("\n")}
          data-projects={affected.map((p) => p.path).join("|")}
        >
          {t("d3.board.affects", { projects: affected.map((p) => friendlyProjectName(p)).join(", ") })}
        </p>
      )}
      {action.kind === "create" && "description" in action && action.description && (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">{action.description}</p>
      )}
      {action.kind === "create_batch" && (
        <ol className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg bg-muted/35 p-2 text-xs" data-testid="head-pm-batch-list">
          {action.tasks.map((item, idx) => {
            const itemProject = item.projectPath ? projectLabelByPath.get(item.projectPath) : null;
            const showDesc = Boolean(item.description && item.description.trim() !== item.title.trim());
            return (
              <li
                key={`${idx}-${item.title}`}
                className="rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5"
                data-testid="head-pm-batch-item"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">{idx + 1}.</span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.createdTaskId ? (
                        <button
                          type="button"
                          onClick={() => {
                            void Promise.resolve(onOpenTask(item.createdTaskId!)).then((opened) => {
                              if (!opened && (item.projectPath ?? context.projectPath)) {
                                onOpenProject((item.projectPath ?? context.projectPath)!);
                              }
                            });
                          }}
                          className="text-left font-medium text-foreground underline-offset-2 hover:underline"
                          data-testid="head-pm-batch-open-task"
                        >
                          {item.title}
                        </button>
                      ) : (
                        <span className="font-medium text-foreground">{item.title}</span>
                      )}
                      {affected.length > 1 && itemProject && (
                        <span className="rounded bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground">{itemProject}</span>
                      )}
                    </div>
                    {showDesc && (
                      <p className="whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {action.kind === "edit" && editPreview && (
        <div className="space-y-1.5 rounded-lg bg-muted/45 p-2.5 text-xs" data-testid="head-pm-edit-preview">
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
              <div className="space-y-1 border-l border-border pl-2">
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
      {action.kind === "assign" && <p className="text-xs">{action.employeeName} · {t("headPm.board.separateLaunch")}</p>}
      {action.kind === "prioritize" && <p className="text-xs">{priorityText(action.priority)}</p>}
      {action.kind === "plan_execution" && <p className="text-xs">{action.employeeName} ({action.harnessId}{action.model ? ` / ${action.model}` : ""})</p>}
      {action.kind === "plan_execution" && status === "pending" && context.projectPath && (
        <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs" data-testid="head-pm-staging-permission">
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
      {action.kind === "execute" && <p className="text-xs">{action.employeeName ?? proposal.specialistName ?? t("m0.assignedSpecialist")} ({action.harnessId ?? proposal.provider ?? t("m0.configuredHarness")})</p>}
      {action.kind === "request_qc" && <p className="text-xs">{action.reviewerHarness ?? "QC Reviewer"}{action.reviewerModel ? ` (${action.reviewerModel})` : ""}</p>}
      {action.kind === "rework" && action.feedback && <p className="text-xs italic text-muted-foreground">{action.feedback}</p>}

      {proposal.missionResource && <MissionResourceReview proposal={proposal.missionResource} />}

      {proposal.sideEffects && (
        <p className="text-xs text-muted-foreground">{knownText(proposal.sideEffects)}</p>
      )}

      {hasTechMeta && (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            {t("headPm.board.techDetails")}
          </summary>
          <div className="mt-1.5 space-y-1 rounded-md border border-border/50 bg-muted/20 p-2">
            {proposal.permissions && (
              <p>
                <span className="font-medium text-foreground">{t("headPm.board.permissions")}:</span> {knownText(proposal.permissions)}
              </p>
            )}
            {proposal.policy && (
              <p>
                <span className="font-medium text-foreground">{t("headPm.board.policy")}:</span> {knownText(proposal.policy)}
              </p>
            )}
            {proposal.result && (
              <p className="font-mono">
                <span className="font-sans font-medium text-foreground">{t("headPm.board.result")}:</span>{" "}
                {typeof proposal.result === "string" ? proposal.result : JSON.stringify(proposal.result)}
              </p>
            )}
          </div>
        </details>
      )}

      {(error || proposal.error) && <div role="alert" className="text-xs text-danger">
        <p>{t("headPm.board.applyError")}</p>
        <details className="mt-1 text-muted-foreground">
          <summary className="cursor-pointer">{t("manager.details")}</summary>
          <p>{error ?? proposal.error}</p>
        </details>
      </div>}
      {status === "applied" && journeyTaskIds.length > 0 && tasks && onOpenTaskRecord && (action.kind === "create" || action.kind === "create_batch" || action.kind === "execute" || action.kind === "request_qc") && (
        <GoalJourney compact tasks={tasks} taskIds={journeyTaskIds} onOpenTask={onOpenTaskRecord} />
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {status === "pending" && <>
          <Button type="button" size="sm" disabled={working || unsafeBlankEdit} onClick={() => void act("approve")}
            data-testid="head-pm-board-approve">
            {action.kind === "replan_mission"
              ? t("usage.replanApprove")
              : action.kind === "edit"
                ? t("headPm.board.applyEdit")
                : action.kind === "create_batch"
                  ? t("headPm.board.createAll", { count: String(action.tasks.length) })
                  : t("headPm.board.approve")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void act("reject")}
            data-testid="head-pm-board-reject">{t(action.kind === "replan_mission" ? "usage.replanReject" : "headPm.board.reject")}</Button>
        </>}
        {context.projectPath && <Button type="button" size="sm" variant="ghost" onClick={() => onOpenProject(context.projectPath!)}>
          {t("headPm.board.openProject")}
        </Button>}
        {action.kind !== "create_batch" && taskId && <Button type="button" size="sm" variant="ghost" onClick={() => {
          void Promise.resolve(onOpenTask(taskId)).then((opened) => {
            if (!opened && context.projectPath) onOpenProject(context.projectPath);
          });
        }} data-testid="head-pm-board-open-task">{t("headPm.board.openTask")}</Button>}
      </div>
    </section>
  );
}
