import { columnLabel } from "@/lib/status-presenters";
import { countLabel, englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, FolderGit2, Loader2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { abbreviateHome } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import {
  COLUMNS,
  type ColumnId,
  type Project,
  type Task,
  type WorktreeGitStatus,
  type WorktreeInfo,
  type WorktreeStaleReason,
} from "../../../shared/types.ts";
import { buildDeleteConfirmCopy, triageDeleteOutcome } from "./worktree-delete-intent.ts";
import { driftOf, driftTitle } from "@/lib/branch-drift";

interface Props {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  projects: Project[];
  onOpenTask: (task: Task) => void;
  /** For abbreviating absolute paths as "~/…" in the row subtitles — mirrors
   *  every other path-displaying surface (TaskCard, RunPanel, SettingsDialog). */
  homeDir: string;
}

const POLL_MS = 5_000;

/** On-demand `getWorktreeGitStatus` calls are subprocess-backed on the bun
 *  side, so the auto-fetch pool caps fan-out rather than firing one request
 *  per row simultaneously. */
const GIT_STATUS_CONCURRENCY = 5;

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

const STALE_REASON_LABEL: Record<WorktreeStaleReason, string> = {
  orphaned: "orphaned",
  get archived() { return tr("common.archived_not_cleaned_up"); },
  get inactive() { return tr("common.inactive_7_days"); },
};

/** "5m ago" / "3h ago" / "2d ago" — coarse relative age for the Updated
 *  column. No existing relative-time helper covers a raw ms epoch (the one
 *  in GitHubDialog.tsx takes an ISO date string for GitHub API payloads), so
 *  this is a small local formatter per the plan brief. */
function formatAge(ms: number | null): string {
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return tr("common.just_now");
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return tr("common.m_ago", { p0: String(mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr("common.h_ago", { p0: String(hours) });
  const days = Math.floor(hours / 24);
  return tr("common.d_ago", { p0: String(days) });
}

/** `Project.name || basename(p.path)` chain (KanbanFilters.tsx:58-62),
 *  extended with the orphan/unowned fallbacks the plan calls for. */
function resolveProjectLabel(workdir: string | null, projects: Project[]): string {
  if (!workdir) return "—";
  const p = projects.find((pr) => pr.path === workdir);
  if (p) return p.name || basename(p.path) || p.path;
  return basename(workdir) || "—";
}

/** Filter/sort value for a row's status — distinct from its display label so
 *  "Archived" can be filtered/sorted independently of the underlying column. */
function statusValue(w: WorktreeInfo): string {
  if (w.archivedAt != null) return "archived";
  return w.column ?? "";
}

function statusLabel(w: WorktreeInfo): string {
  if (w.column == null) return "";
  return columnLabel(w.column);
}

type SortField = "updated" | "project" | "status" | "branch";
type StaleFilter = "all" | "stale" | "fresh";

export function WorktreesDialog({ open, onClose, tasks, projects, onOpenTask, homeDir }: Props) {
  const { locale: uiLocale } = useUILocale();
  const confirm = useConfirm();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Live per-worktree dirty/ahead/merged, fetched on open + Refresh (not the
  // 5s poll — see fetchGitStatuses). "loading" is a sentinel, not the
  // WorktreeGitStatus shape itself.
  const [gitStatus, setGitStatus] = useState<Map<string, WorktreeGitStatus | "loading">>(new Map());
  // Bumped on every fetch pass so a superseding Refresh (or the dialog
  // closing) makes in-flight results from an older pass a no-op.
  const gitStatusRunRef = useRef(0);

  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [staleFilter, setStaleFilter] = useState<StaleFilter>("all");
  const [sortField, setSortField] = useState<SortField>("updated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Bounded-concurrency pool: fetches live git status for every row in
  // `list`, capped at GIT_STATUS_CONCURRENCY in flight. Marks all ids
  // "loading" up front so the spinner shows immediately, then fills in each
  // result (or drops the id on error — no badge, no toast spam) as it
  // resolves. `runId` lets a superseding pass (a fresh Refresh, or the
  // dialog closing) discard stale results instead of racing the map.
  const fetchGitStatuses = useCallback((list: WorktreeInfo[]) => {
    const runId = ++gitStatusRunRef.current;
    setGitStatus((cur) => {
      const next = new Map(cur);
      for (const w of list) next.set(w.id, "loading");
      return next;
    });
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        const w = list[idx];
        if (!w) return;
        try {
          const status = await api.getWorktreeGitStatus(w.id);
          if (gitStatusRunRef.current !== runId) return;
          setGitStatus((cur) => new Map(cur).set(w.id, status));
        } catch {
          if (gitStatusRunRef.current !== runId) return;
          setGitStatus((cur) => {
            const next = new Map(cur);
            next.delete(w.id);
            return next;
          });
        }
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(GIT_STATUS_CONCURRENCY, list.length) }, worker),
    );
  }, []);

  const refresh = useCallback(async (manual = false, fetchGit = false) => {
    if (manual) setRefreshing(true);
    try {
      const list = await api.listWorktrees();
      setWorktrees(list);
      setError(null);
      if (fetchGit) fetchGitStatuses(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [fetchGitStatuses]);

  // Fetch on open + poll every 5s while open; cleared on close/unmount.
  // Git status is auto-fetched on the initial open load and on manual
  // Refresh only — not on every 5s poll tick, to avoid a git subprocess
  // fan-out in the background while the dialog just sits open.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void refresh(false, true).finally(() => setLoading(false));
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  // Discard any in-flight git-status pass and drop stale badges when the
  // dialog closes (or unmounts) — reopening re-fetches fresh regardless.
  useEffect(() => {
    if (open) return;
    gitStatusRunRef.current++;
    setGitStatus(new Map());
  }, [open]);

  // Reset filters each time the dialog is reopened — a stale filter carried
  // across sessions would silently hide rows the user doesn't expect.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setProjectFilter([]);
    setStatusFilter([]);
    setStaleFilter("all");
    setSortField("updated");
    setSortDir("desc");
  }, [open]);

  const projectValue = useCallback((w: WorktreeInfo) => w.workdir ?? "__none__", []);
  const projectLabel = useCallback((w: WorktreeInfo) => resolveProjectLabel(w.workdir, projects), [projects]);

  const projectItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const w of worktrees) {
      const v = projectValue(w);
      if (!seen.has(v)) seen.set(v, projectLabel(w));
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [worktrees, projectValue, projectLabel, uiLocale]);

  const statusItems = useMemo(
    () => [...COLUMNS.map((c) => ({ value: c.id as string, label: columnLabel(c.id) })), { value: "archived", label: tr("common.archived_bdb865") }],
    [uiLocale],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return worktrees.filter((w) => {
      if (q) {
        const hay = `${w.taskTitle ?? ""}\n${w.branch ?? ""}\n${projectLabel(w)}\n${w.path}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (projectFilter.length > 0 && !projectFilter.includes(projectValue(w))) return false;
      if (statusFilter.length > 0 && !statusFilter.includes(statusValue(w))) return false;
      if (staleFilter === "stale" && !w.stale) return false;
      if (staleFilter === "fresh" && w.stale) return false;
      return true;
    });
  }, [worktrees, query, projectFilter, statusFilter, staleFilter, projectLabel, projectValue, uiLocale]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortField) {
        case "updated":
          return ((a.taskUpdatedAt ?? 0) - (b.taskUpdatedAt ?? 0)) * dir;
        case "project":
          return projectLabel(a).localeCompare(projectLabel(b)) * dir;
        case "status":
          return statusLabel(a).localeCompare(statusLabel(b)) * dir;
        case "branch":
          return (a.branch ?? "").localeCompare(b.branch ?? "") * dir;
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, sortField, sortDir, projectLabel, uiLocale]);

  const anyFilterActive =
    query !== "" || projectFilter.length > 0 || statusFilter.length > 0 || staleFilter !== "all";

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((cur) => new Set(cur).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  const deleteTaskBacked = async (w: WorktreeInfo) => {
    if (!w.taskId) return;
    const taskId = w.taskId;
    // Busy spans fetch → confirm → archive as one continuous stretch so the
    // trash icon spins the whole time (rather than appearing frozen during
    // the status fetch) and a second click can never double-fire while the
    // confirm dialog is up or the archive request is in flight.
    await withBusy(w.id, async () => {
      // The cached `gitStatus` map is only populated on open + manual
      // Refresh — by the time the user clicks delete it's frequently
      // "loading" or missing entirely, which would undersell what's about
      // to be discarded. Fetch fresh; a failed check falls back to the
      // no-warning copy rather than blocking the delete.
      let status: WorktreeGitStatus | null = null;
      try {
        status = await api.getWorktreeGitStatus(w.id);
      } catch {
        status = null;
      }
      const copy = buildDeleteConfirmCopy(w, status);
      const ok = await confirm(() => ({
        title: copy.title,
        description: (
          <>
            {copy.alreadyArchived ? (
              <><I18nText id="projects.the_ticket" /><span className="font-medium text-foreground/80">{w.taskTitle}</span><I18nText id="projects.is_already" />{" "}<strong><I18nText id="common.archived" /></strong><I18nText id="projects.its_worktree_directory_will_be_removed_the_git" />{" "}</>
            ) : (
              <><I18nText id="projects.the_ticket" /><span className="font-medium text-foreground/80">{w.taskTitle}</span><I18nText id="projects.will_be" />{" "}<strong><I18nText id="common.archived" /></strong>{" "}<I18nText id="projects.hidden_from_the_board_restorable_via_unarchive_and" />{" "}</>
            )}
            {copy.showDirtyWarning && (
              <div className="mt-2 font-medium text-danger"><I18nText id="projects.this_worktree_has_uncommitted_changes_they_will_be" />{" "}</div>
            )}
            {copy.unknown && (
              <div className="mt-2 font-medium text-danger"><I18nText id="projects.agetor_couldn_t_check_this_worktree_for_uncommitted" />{" "}</div>
            )}
            {(w.runActive || w.heldByBackgroundAgents) && tr("common.an_agent_is_still_working_on_this_task_33a2c7")}
          </>
        ),
        confirmLabel: copy.confirmLabel,
        variant: "destructive",
      }));
      if (!ok) return;
      try {
        const result = await api.archiveTask(taskId, {
          force: true,
          stopRun: true,
          forceWorktree: true,
          awaitTeardown: true,
        });
        const outcome = triageDeleteOutcome(result.teardown, w.branch);
        // Silent on success — the house convention for destructive list
        // mutations (SettingsDialog.tsx) is that the row vanishing from the
        // refreshed list IS the feedback. Only a genuine failure toasts.
        if (outcome.kind === "error") toast.error(outcome.message);
        await refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        await refresh();
      }
    });
  };

  const deleteOrphan = async (w: WorktreeInfo) => {
    const ok = await confirm(() => ({
      title: tr("common.delete_orphaned_worktree"),
      description: tr("common.no_ticket_owns_this_directory_it_will_be"),
      confirmLabel: tr("common.delete"),
      variant: "destructive",
    }));
    if (!ok) return;
    await withBusy(w.id, async () => {
      try {
        await api.deleteWorktree(w.id);
        await refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="worktrees-dialog-title"
      className="flex max-h-[86vh] w-full max-w-6xl flex-col p-0"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="worktrees-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" /><I18nText id="common.worktrees" />{" "}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {worktrees.length === sorted.length
              ? tr("common.worktree", { p0: String(worktrees.length), p1: String(worktrees.length === 1 ? "" : englishPluralSuffix()) })
              : tr("common.of_worktrees", { p0: String(sorted.length), p1: String(worktrees.length) })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            title={tr("common.refresh")}
            aria-label={tr("common.refresh")}
            disabled={refreshing}
            onClick={() => { void refresh(true, true); }}
          >
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" title={tr("common.close")} aria-label={tr("common.close")} onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            {...IDENTIFIER_INPUT_PROPS}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("projects.search_title_branch_project_path")}
            className="pl-8"
          />
        </div>
        <MultiSearchSelect
          values={projectFilter}
          onChange={setProjectFilter}
          items={projectItems}
          emptyLabel={tr("common.all_projects")}
          placeholder={tr("common.search_projects")}
          className="w-48"
        />
        <MultiSearchSelect
          values={statusFilter}
          onChange={setStatusFilter}
          items={statusItems}
          emptyLabel={tr("common.all_statuses")}
          placeholder={tr("common.search_statuses")}
          className="w-44"
        />
        <Select
          value={staleFilter}
          onChange={(e) => setStaleFilter(e.target.value as StaleFilter)}
          className="w-36"
          title={tr("projects.filter_by_staleness")}
        >
          <option value="all"><I18nText id="common.all" /></option>
          <option value="stale"><I18nText id="projects.stale_only" /></option>
          <option value="fresh"><I18nText id="projects.fresh_only" /></option>
        </Select>
        <Select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="w-32"
          title={tr("projects.sort_field")}
        >
          <option value="updated"><I18nText id="common.updated" /></option>
          <option value="project"><I18nText id="common.project_985959" /></option>
          <option value="status"><I18nText id="common.status" /></option>
          <option value="branch"><I18nText id="common.branch" /></option>
        </Select>
        <Button
          size="icon"
          variant="outline"
          title={sortDir === "asc" ? tr("common.ascending") : tr("common.descending")}
          aria-label={tr("common.toggle_sort_direction")}
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
        >
          {sortDir === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
        </Button>
        {anyFilterActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setProjectFilter([]);
              setStatusFilter([]);
              setStaleFilter("all");
            }}
          ><I18nText id="common.clear" />{" "}</Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!loading && error && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-danger">
            <AlertCircle className="size-4" /> {error}
          </div>
        )}

        {loading && worktrees.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{" "}<I18nText id="projects.loading_worktrees" />{" "}</div>
        )}

        {!loading && !error && worktrees.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <FolderGit2 className="size-6 opacity-40" /><I18nText id="projects.no_worktrees_on_disk" />{" "}</div>
        )}

        {!loading && !error && worktrees.length > 0 && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <FolderGit2 className="size-6 opacity-40" /><I18nText id="projects.no_worktrees_match_these_filters" />{" "}</div>
        )}

        {sorted.length > 0 && (
          <div className="flex flex-col gap-2">
            {sorted.map((w) => {
              const task = w.taskId ? tasks.find((t) => t.id === w.taskId) : undefined;
              const busy = busyIds.has(w.id);
              const status = gitStatus.get(w.id);
              return (
                <div key={w.id} className="flex items-start gap-3 rounded-md border border-border/60 bg-card p-3">
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {task ? (
                        <button
                          type="button"
                          className="min-w-0 truncate text-left text-sm font-medium hover:underline"
                          onClick={() => onOpenTask(task)}
                          title={tr("common.open_task")}
                        >
                          {task.title}
                        </button>
                      ) : w.taskId ? (
                        <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
                          {w.taskTitle}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground"><I18nText id="projects.no_ticket" /></span>
                      )}
                      {w.column != null && (
                        <Badge variant="outline">{statusLabel(w)}</Badge>
                      )}
                      {w.archivedAt != null && <Badge variant="secondary"><I18nText id="common.archived_bdb865" /></Badge>}
                      {w.stale && (
                        <Badge
                          variant="destructive"
                          title={w.staleReasons.map((r) => STALE_REASON_LABEL[r]).join(", ")}
                        ><I18nText id="projects.stale" />{" "}</Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {(() => {
                        // The listing reports the task's own branch (fs + DB
                        // only); the per-row git status reads the live HEAD.
                        // A worktree that drifted onto another branch shows
                        // where it really is, with the task branch on hover.
                        const drift = driftOf(w.branch, status && status !== "loading" ? status.branch : null);
                        if (!drift.drifted) return <span className="font-mono">{w.branch ?? "—"}</span>;
                        return (
                          <span className="flex items-center gap-1" title={driftTitle(w.branch)}>
                            <span className="font-mono">{drift.live}</span>
                            <span
                              data-testid="worktree-row-branch-drift"
                              className="rounded bg-info/15 px-1 text-[10px] font-medium text-info"
                            ><I18nText id="common.drifted" />{" "}</span>
                          </span>
                        );
                      })()}
                      <span>{projectLabel(w)}</span>
                      <span className="min-w-0 truncate" title={w.path}>{abbreviateHome(w.path, homeDir)}</span>
                      <span><I18nText id="common.updated_27eb5e" />{" "}{formatAge(w.taskUpdatedAt)}</span>
                      {w.runActive && <span className="text-success"><I18nText id="common.running_c071cf" /></span>}
                      {!w.runActive && w.heldByBackgroundAgents && (
                        <span className="text-success"><I18nText id="projects.agents_working" /></span>
                      )}
                      {status === "loading" && (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label={tr("projects.loading_git_status")} />
                      )}
                      {status && status !== "loading" && !status.ignored && (
                        <>
                          {status.dirty && (
                            <span className="text-warning" title={tr("projects.has_uncommitted_changes")}><I18nText id="projects.uncommitted" />{" "}</span>
                          )}
                          {status.ahead > 0 && (
                            <span
                              className="inline-flex items-center gap-0.5"
                              title={tr("common.commit_ahead", { p0: countLabel(status.ahead, "commit") })}
                            >
                              <ArrowUp className="size-3" />
                              {status.ahead}
                            </span>
                          )}
                          {status.merged === true && (
                            <span
                              className="text-success"
                              title={
                                status.dirty
                                  ? tr("common.merged_into_the_default_branch_committed_work_is")
                                  : tr("common.already_merged_into_the_default_branch_safe_to")
                              }
                            ><I18nText id="common.merged" />{" "}</span>
                          )}
                        </>
                      )}
                      {w.stale && (
                        <span className="text-muted-foreground">
                          {w.staleReasons.map((r) => STALE_REASON_LABEL[r]).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    title={
                      w.runActive
                        ? (w.taskId ? tr("common.stop_the_running_agent_and_delete_worktree") : tr("common.stop_the_run_first"))
                        : tr("projects.delete_worktree")
                    }
                    aria-label={tr("projects.delete_worktree")}
                    disabled={(w.runActive && !w.taskId) || busy}
                    onClick={() => { void (w.taskId ? deleteTaskBacked(w) : deleteOrphan(w)); }}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4 text-destructive" />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
