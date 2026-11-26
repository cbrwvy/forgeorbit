import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useId, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock, Copy, GitPullRequest, PauseCircle, Play, Plus, RefreshCw, ShieldAlert, Sparkles, Square } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { shortenPath } from "@/lib/path-display";
import { isMacPlatform } from "@/lib/platform";
import { projectLabel, type WorkspacePage } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ProjectTabs } from "./ProjectTabs";
import { Input } from "@/components/ui/input";
import { parseProjectMeta, projectMetaKey } from "../../../shared/project-wizard.ts";
import type {
  EffectiveProjectLifecycleState,
  ProjectLifecycleSnapshot,
  ProjectLifecycleUnavailableCode,
} from "../../../shared/project-lifecycle.ts";
import type { Project } from "../../../shared/types.ts";

interface Props {
  project: Project;
  page: WorkspacePage;
  homeDir: string;
  onPageChange: (page: WorkspacePage) => void;
  onOpenHead?: (projectPath: string) => void;
  onNewTask: () => void;
  onOpenCluster: (id: string) => void;
  /** Breadcrumb root. Opens the spaces list. */
  onOpenOverview?: () => void;
  /** Optional parent callback when Start / Stop persists a new lifecycle snapshot. */
  onLifecycleChange?: (lifecycle: ProjectLifecycleSnapshot) => void;
  /** Optional callback when the project folder is relinked to a new path. */
  onRelink?: (newPath: string) => void;
  /** Optional callback to open the Git dialog for this project. */
  onOpenGit?: () => void;
}

/**
 * Identity row for the open project. Git remote (`owner/name`) is shown only
 * after `GET /github/provider-info` succeeds — a directory that isn't a git
 * repo, or has no forge remote, simply omits the line.
 */
export function ProjectHeader({
  project,
  page,
  homeDir,
  onPageChange,
  onOpenHead,
  onNewTask,
  onOpenCluster,
  onOpenOverview,
  onLifecycleChange,
  onRelink,
  onOpenGit,
}: Props) {
  useUILocale();
  const label = projectLabel(project);
  const pathLabel = shortenPath(project.path, homeDir);
  const [copied, setCopied] = useState(false);
  const copyPath = () => {
    void navigator.clipboard?.writeText(project.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  const [gitLabel, setGitLabel] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [cluster, setCluster] = useState<{ id: string; name: string } | "unassigned" | "unknown" | null>(null);
  const [lifecycle, setLifecycle] = useState<ProjectLifecycleSnapshot | null>(project.lifecycle ?? null);
  const [pendingAction, setPendingAction] = useState<"start" | "stop" | null>(null);
  const [confirmation, setConfirmation] = useState<{
    state: EffectiveProjectLifecycleState;
    activeExecutions: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [relinkOpen, setRelinkOpen] = useState(false);
  const [relinkPath, setRelinkPath] = useState("");
  const [relinking, setRelinking] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);

  const handleRelinkConfirm = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = relinkPath.trim();
    if (!trimmed || relinking) return;
    setRelinking(true);
    setRelinkError(null);
    try {
      const res = await api.relinkProject(project.path, trimmed);
      toast.success(tr("projects.relink_success"));
      setRelinkOpen(false);
      onRelink?.(res.newPath);
    } catch (err) {
      setRelinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setRelinking(false);
    }
  };

  useEffect(() => {
    if (project.lifecycle) {
      setLifecycle(project.lifecycle);
    }
  }, [project.lifecycle]);

  useEffect(() => {
    setLifecycle(project.lifecycle ?? null);
    setPendingAction(null);
    setConfirmation(null);
    setActionError(null);
    if (!project.lifecycle && typeof api.getProjectLifecycle === "function") {
      let cancelled = false;
      void api.getProjectLifecycle(project.path).then(
        (res) => {
          if (!cancelled) setLifecycle(res.lifecycle);
        },
        () => {},
      );
      return () => {
        cancelled = true;
      };
    }
  }, [project.path]);

  const handleStopProject = async () => {
    if (pendingAction) return;
    setPendingAction("stop");
    setActionError(null);
    try {
      const result = await api.stopProject(project.path);
      setLifecycle(result.lifecycle);
      setConfirmation({
        state: result.lifecycle.state,
        activeExecutions: result.lifecycle.activeExecutions,
      });
      onLifecycleChange?.(result.lifecycle);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  };

  const handleStartProject = async () => {
    if (pendingAction) return;
    setPendingAction("start");
    setActionError(null);
    try {
      const result = await api.startProject(project.path);
      setLifecycle(result.lifecycle);
      setConfirmation({
        state: result.lifecycle.state,
        activeExecutions: result.lifecycle.activeExecutions,
      });
      onLifecycleChange?.(result.lifecycle);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setGitLabel(null);
    void api.getProviderInfo(project.path).then(
      (info) => {
        if (!cancelled && info.owner && info.name) setGitLabel(`${info.owner}/${info.name}`);
      },
      () => {
        if (!cancelled) setGitLabel(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    setDescription(null);
    void api.listPreferences().then(
      (prefs) => {
        if (cancelled) return;
        const text = parseProjectMeta(prefs[projectMetaKey(project.path)]).description ?? null;
        setDescription(text);
      },
      () => {
        if (!cancelled) setDescription(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    setCluster(null);
    void api.resolveClusterMembership(project.path).then(
      (row) => {
        if (cancelled) return;
        setCluster(row.cluster ? { id: row.cluster.id, name: row.cluster.name } : "unassigned");
      },
      () => {
        if (!cancelled) setCluster("unknown");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  const pageLabel = pageLabelFor(page);
  const crumb = "glass-nav-item -mx-1 rounded-md px-1";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const action = lifecycle ? lifecycleActionFor(lifecycle) : null;
  const notes = action ? lifecycleNotes(action) : null;
  const confirmationMessage = confirmation ? confirmationText(confirmation.state, confirmation.activeExecutions) : null;

  return (
    <div
      className="flex min-w-0 shrink-0 flex-col gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-page pb-3 pt-4"
      data-testid="project-header"
    >
      <nav aria-label={tr("navigation.breadcrumb")} className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="project-breadcrumb">
        {onOpenOverview ? (
          <button type="button" className={crumb} onClick={onOpenOverview} data-testid="project-breadcrumb-root"><I18nText id="nav.workspaces" /></button>
        ) : (
          <span><I18nText id="nav.workspaces" /></span>
        )}
        <ChevronRight className="size-3 shrink-0" aria-hidden />
        {cluster && cluster !== "unknown" && cluster !== "unassigned" ? (
          <button type="button" className={cn(crumb, "max-w-[10rem] truncate")} title={cluster.name} onClick={() => onOpenCluster(cluster.id)} data-testid="project-breadcrumb-space"><span data-testid="project-context-space">{cluster.name}</span></button>
        ) : (
          <span className="max-w-[10rem] truncate" data-testid="project-context-space">
            {cluster === "unassigned" ? tr("project.context.none") : cluster === "unknown" ? tr("project.context.unknown") : tr("project.context.loading")}
          </span>
        )}
        <ChevronRight className="size-3 shrink-0" aria-hidden />
        <button type="button" className={cn(crumb, "min-w-0 max-w-[14rem] truncate")} title={label} onClick={() => onPageChange("board")} data-testid="project-breadcrumb-project">{label}</button>
        <ChevronRight className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium text-foreground" aria-current="page" data-testid="project-breadcrumb-page">{pageLabel}</span>
      </nav>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 basis-64 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold tracking-tight [overflow-wrap:anywhere]" data-testid="project-header-name">
              <span data-testid="project-context-project">{label}</span>
            </h2>
          </div>
          {lifecycle && <ProjectWorkStatus lifecycle={lifecycle} />}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="project-header-actions">
          {lifecycle && action && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!action.enabled || pendingAction !== null}
              title={action.reason ?? tr("m5.action.scope_hint")}
              onClick={action.kind === "stop" ? () => void handleStopProject() : () => void handleStartProject()}
              data-testid={action.kind === "stop" ? "project-lifecycle-stop" : "project-lifecycle-start"}
            >
              {action.kind === "stop" ? <Square className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
              {pendingAction === "stop" || (action.kind === "stop" && action.draining)
                ? tr("m5.action.stopping")
                : pendingAction === "start"
                  ? tr("m5.action.starting")
                  : action.kind === "stop" ? tr("m5.action.stop") : tr("m5.action.start")}
            </Button>
          )}
          {onOpenHead && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenHead(project.path)} data-testid="project-open-head-pm">
              <Sparkles className="size-3.5" aria-hidden />{tr("m5.header.ask_head")}
            </Button>
          )}
          {onOpenGit && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onOpenGit}
              aria-label="Git"
              title={tr("navigation.git_pull_requests_and_issues_github_gitlab_bitbucket")}
              data-testid="project-open-git"
            >
              <GitPullRequest className="size-3.5" aria-hidden />Git
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={onNewTask}
            data-testid="project-new-task"
            title={`${tr("common.new_task")} (${isMacPlatform() ? "⌘N" : "Ctrl+N"})`}
            aria-keyshortcuts={isMacPlatform() ? "Meta+N" : "Control+N"}
          >
            <Plus className="size-3.5" aria-hidden /><I18nText id="common.new_task" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((value) => !value)}
            title={tr("m5.header.details_hint")}
            data-testid="project-header-details-toggle"
          >
            <I18nText id="m5.header.details" />
            <ChevronDown className={cn("size-3.5 transition-transform duration-fast", detailsOpen && "rotate-180")} aria-hidden />
          </Button>
        </div>
      </div>
      {(notes || confirmationMessage || actionError) && (
        <div className="flex flex-col gap-0.5" data-testid="project-lifecycle-notes">
          {notes && (
            <p className="text-[11px] text-muted-foreground" data-testid="project-lifecycle-unavailable-reason">{notes}</p>
          )}
          {confirmationMessage && (
            <p className="text-[11px] font-medium text-foreground" role="status" data-testid="project-lifecycle-confirmation">{confirmationMessage}</p>
          )}
          {actionError && (
            <p className="text-[11px] font-medium text-destructive" role="alert" data-testid="project-lifecycle-error">{actionError}</p>
          )}
        </div>
      )}
      {project.existsOnDisk === false && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
          data-testid="project-missing-folder-banner"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
            <span data-testid="project-missing-folder-message">
              <I18nText id="projects.missing_folder_warning" />
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-warning/50 text-foreground hover:bg-warning/20"
            onClick={() => {
              setRelinkPath("");
              setRelinkError(null);
              setRelinkOpen(true);
            }}
            data-testid="relink-project-folder"
          >
            <I18nText id="projects.relink_project_folder" />
          </Button>
        </div>
      )}
      {detailsOpen && (
        <div id={detailsId} className="ds-panel flex min-w-0 flex-col gap-1.5 px-3 py-2.5 text-xs" data-testid="project-header-details">
          <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="shrink-0 font-medium text-foreground"><I18nText id="m5.header.folder" /></span>
            <span className="min-w-0 truncate" title={project.path} data-testid="project-header-path">{pathLabel}</span>
            <button
              type="button"
              className="glass-nav-item shrink-0 rounded p-0.5"
              onClick={copyPath}
              aria-label={copied ? tr("uxfix.pathCopied") : tr("uxfix.copyPath")}
              title={copied ? tr("uxfix.pathCopied") : tr("uxfix.copyPath")}
              data-testid="project-header-copy-path"
            >
              {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            </button>
          </p>
          {gitLabel && (
            <p className="text-muted-foreground" data-testid="project-header-git">
              <span className="font-medium text-foreground"><I18nText id="m5.header.repository" /></span>{" "}{gitLabel}
            </p>
          )}
          {description && (
            <p className="text-muted-foreground" data-testid="project-header-description">{description}</p>
          )}
          {cluster && cluster !== "unknown" && (
            cluster === "unassigned" ? (
              <p className="text-muted-foreground" data-testid="project-cluster-unassigned" title={tr("uxfix.noCluster")}>{tr("uxfix.clusterLabel")}: {tr("uxfix.noCluster")}</p>
            ) : (
              <button
                type="button"
                className="glass-nav-item max-w-full self-start truncate rounded-md px-1.5 py-0.5 text-xs"
                data-testid="project-cluster-link"
                title={cluster.name}
                onClick={() => onOpenCluster(cluster.id)}
              ><I18nText id="projects.cluster" />{" "}{cluster.name}
              </button>
            )
          )}
          {lifecycle && <ProjectLifecycleDetails lifecycle={lifecycle} />}
          <p className="text-muted-foreground" data-testid="project-actions-scope"><I18nText id="m5.header.actions_scope" /></p>
        </div>
      )}
      <ProjectTabs page={page} onPageChange={onPageChange} />
      <Dialog
        open={relinkOpen}
        onClose={() => !relinking && setRelinkOpen(false)}
        labelledBy="relink-dialog-title"
        describedBy="relink-dialog-desc"
        className="max-w-md p-4"
      >
        <form onSubmit={handleRelinkConfirm} data-testid="relink-project-dialog" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h3 id="relink-dialog-title" className="text-base font-semibold leading-none tracking-tight">
              <I18nText id="projects.relink_dialog_title" />
            </h3>
            <p id="relink-dialog-desc" className="text-xs text-muted-foreground">
              <I18nText id="projects.relink_dialog_description" />
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="relink-folder-input" className="text-xs font-medium">
              <I18nText id="projects.relink_dialog_input_label" />
            </label>
            <Input
              id="relink-folder-input"
              data-testid="relink-folder-input"
              value={relinkPath}
              onChange={(e) => setRelinkPath(e.target.value)}
              placeholder="/path/to/project"
              disabled={relinking}
              autoFocus
            />
            {relinkError && (
              <p className="text-xs text-destructive" role="alert" data-testid="relink-error">
                {relinkError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={relinking}
              onClick={() => setRelinkOpen(false)}
              data-testid="cancel-relink-project"
            >
              <I18nText id="common.cancel" />
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!relinkPath.trim() || relinking}
              data-testid="confirm-relink-project"
            >
              {relinking ? <I18nText id="common.saving" /> : <I18nText id="projects.relink_dialog_confirm" />}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

interface LifecycleAction {
  kind: "start" | "stop";
  enabled: boolean;
  /** Why the action is unavailable (shown beside it and as its tooltip). */
  reason: string | null;
  /** Stop already requested and work is still finishing. */
  draining: boolean;
}

/** The one lifecycle action to show, chosen from the real state. Draining reads
 *  as a disabled "Stopping…" (never as Paused); recovering and invalid show the
 *  disabled start with its reason. The request each button sends is unchanged. */
export function lifecycleActionFor(lifecycle: ProjectLifecycleSnapshot): LifecycleAction {
  const startReason = unavailableMessage(lifecycle.startUnavailableCode, lifecycle.activeExecutions, lifecycle.startUnavailableReason);
  const stopReason = unavailableMessage(lifecycle.stopUnavailableCode, lifecycle.activeExecutions, lifecycle.stopUnavailableReason);
  if (lifecycle.canStop) return { kind: "stop", enabled: true, reason: null, draining: false };
  if (lifecycle.canStart) return { kind: "start", enabled: true, reason: null, draining: false };
  if (lifecycle.state === "draining") return { kind: "stop", enabled: false, reason: stopReason ?? startReason, draining: true };
  return { kind: "start", enabled: false, reason: startReason ?? stopReason, draining: false };
}

function lifecycleNotes(action: LifecycleAction): string | null {
  return action.enabled ? null : action.reason;
}

export function workStatusText(lifecycle: Pick<ProjectLifecycleSnapshot, "state" | "activeExecutions">): string {
  switch (lifecycle.state) {
    case "running": return tr("m5.status.running");
    case "draining": return tr("m5.status.draining", { count: String(lifecycle.activeExecutions) });
    case "paused": return tr("m5.status.paused");
    case "recovering": return tr("m5.status.recovering");
    case "invalid": return tr("m5.status.invalid");
  }
}

function WorkStatusIcon({ state }: { state: EffectiveProjectLifecycleState }) {
  const cls = "size-3 shrink-0";
  if (state === "paused") return <PauseCircle className={cls} aria-hidden />;
  if (state === "draining") return <Clock className={cls} aria-hidden />;
  if (state === "recovering") return <RefreshCw className={cls} aria-hidden />;
  if (state === "invalid") return <ShieldAlert className={cls} aria-hidden />;
  return null;
}

/** Plain-language work status next to the project name. The exact lifecycle
 *  state stays on `data-state` and in Details. */
function ProjectWorkStatus({ lifecycle }: { lifecycle: ProjectLifecycleSnapshot }) {
  useUILocale();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" data-testid="project-lifecycle-bar" data-state={lifecycle.state}>
      <span
        className={cn("inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", lifecycleBadgeClass(lifecycle.state))}
        data-testid="project-lifecycle-state"
        data-state={lifecycle.state}
        title={`${tr("m5.status.label")}: ${lifecycleStateLabel(lifecycle.state)}`}
      >
        <WorkStatusIcon state={lifecycle.state} />
        <span className="min-w-0 truncate">{workStatusText(lifecycle)}</span>
      </span>
      {lifecycle.activeExecutions > 0 && lifecycle.state !== "draining" && (
        <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-[11px] tabular-nums text-foreground" data-testid="project-lifecycle-active-count">
          {tr("project_lifecycle.active_count", { count: String(lifecycle.activeExecutions) })}
        </span>
      )}
      {lifecycle.state === "draining" && (lifecycle.activeBreakdown.unconfirmedProcesses ?? 0) > 0 && (
        <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning" data-testid="project-lifecycle-unconfirmed">
          {tr("d5.lifecycle.unconfirmed", { count: String(lifecycle.activeBreakdown.unconfirmedProcesses) })}
        </span>
      )}
      {lifecycle.launchesBlocked && lifecycle.state !== "paused" && lifecycle.state !== "draining" && (
        <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning" data-testid="project-lifecycle-launches-blocked">
          {tr("project_lifecycle.launches_blocked")}
        </span>
      )}
    </div>
  );
}

/** The exact lifecycle values, for the Details panel. */
function ProjectLifecycleDetails({ lifecycle }: { lifecycle: ProjectLifecycleSnapshot }) {
  useUILocale();
  return (
    <p className="text-muted-foreground" data-testid="project-lifecycle-details">
      <span className="font-medium text-foreground">{tr("project_lifecycle.label")}</span>{" "}
      {lifecycleStateLabel(lifecycle.state)}
      {" · "}{tr("project_lifecycle.active_count", { count: String(lifecycle.activeExecutions) })}
      {lifecycle.launchesBlocked ? ` · ${tr("project_lifecycle.launches_blocked")}` : ""}
    </p>
  );
}

export function lifecycleStateLabel(state: EffectiveProjectLifecycleState): string {
  switch (state) {
    case "running":
      return tr("project_lifecycle.state.running");
    case "draining":
      return tr("project_lifecycle.state.draining");
    case "paused":
      return tr("project_lifecycle.state.paused");
    case "recovering":
      return tr("project_lifecycle.state.recovering");
    case "invalid":
      return tr("project_lifecycle.state.invalid");
  }
}

export function lifecycleBadgeClass(state: EffectiveProjectLifecycleState): string {
  switch (state) {
    case "running":
      return "bg-success/15 text-success";
    case "draining":
    case "recovering":
      return "bg-warning/15 text-warning";
    case "paused":
      return "bg-muted text-muted-foreground";
    case "invalid":
      return "bg-destructive/15 text-destructive";
  }
}

function unavailableMessage(
  code: ProjectLifecycleUnavailableCode | null,
  activeExecutions: number,
  fallback: string | null,
): string | null {
  switch (code) {
    case "already-running":
      return tr("project_lifecycle.unavailable.already-running");
    case "draining-active-work":
      return tr("project_lifecycle.unavailable.draining-active-work", { count: String(activeExecutions) });
    case "recovering":
      return tr("project_lifecycle.unavailable.recovering");
    case "invalid-state":
      return tr("project_lifecycle.unavailable.invalid-state");
    case "already-paused":
      return tr("project_lifecycle.unavailable.already-paused");
    case "already-draining":
      return tr("project_lifecycle.unavailable.already-draining", { count: String(activeExecutions) });
    default:
      return fallback;
  }
}

function confirmationText(state: EffectiveProjectLifecycleState, activeExecutions: number): string | null {
  switch (state) {
    case "draining":
      return tr("project_lifecycle.confirm.draining", { count: String(activeExecutions) });
    case "paused":
      return tr("project_lifecycle.confirm.paused");
    case "running":
      return tr("project_lifecycle.confirm.running");
    default:
      return null;
  }
}

function pageLabelFor(page: WorkspacePage): string {
  switch (page) {
    case "board": return tr("nav.tasks");
    case "usage": return tr("nav.analytics");
    case "team": return tr("m5.tab.team");
    case "recurring": return tr("kanban.recurring.nav");
    case "estimates": return tr("common.estimates");
    case "environment": return tr("common.environment");
    case "manager": return tr("headPm.unified.legacy");
    case "settings": return tr("m5.more.rules");
    case "knowledge": return tr("nav.tab.notes");
    case "brain": return tr("nav.tab.memory");
    case "browser": return tr("common.browser");
    case "native-computer": return tr("common.native_computer");
    default: return tr("common.overview");
  }
}
