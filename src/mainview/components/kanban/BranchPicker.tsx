import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowDownUp, GitBranch, RefreshCw } from "lucide-react";
import { api, type BranchInfo } from "@/lib/api";
import { SearchSelect } from "@/components/ui/search-select";
import { cn } from "@/lib/utils";

interface Props {
  /** Workdir whose branches to list. Empty = no project picked yet. */
  workdir: string;
  value: string;
  onChange: (next: string) => void;
  className?: string;
  /**
   * Field label rendered above the picker. Sharing the label row with the
   * Git Fetch button keeps the picker trigger itself full-width, so long
   * branch names aren't clipped inside the narrow new-task sidebar.
   */
  label?: string;
  /** Tooltip on the trigger. */
  title?: string;
  placement?: "top" | "bottom";
  disabled?: boolean;
}

const HEAD_VALUE = "__HEAD__";

const formatAge = (ms: number): string => {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 30 * day) return tr("common.d_ago", { p0: String(Math.floor(diff / day)) });
  if (diff < 365 * day) return tr("common.mo_ago", { p0: String(Math.floor(diff / (30 * day))) });
  return tr("common.y_ago", { p0: String(Math.floor(diff / (365 * day))) });
};

/**
 * Base-ref picker: lists local branches of the selected project sorted by
 * most-recent commit. The current branch is pinned at the top. The explicit
 * "HEAD" row only shows up when the workdir has no real branches yet (fresh
 * `git init`) — once any branches exist, picking the current branch row
 * covers the "use what's checked out" intent without the extra entry. Empty
 * value still means "use HEAD" downstream so the picker can sit unselected.
 */
export function BranchPicker({ workdir, value, onChange, className, label, title, placement, disabled }: Props) {
  useUILocale();
  // Branches are tagged with the workdir they were fetched for. Without the
  // tag, switching projects would let the auto-select effect below see the
  // previous repo's `branches` array (state updates from `setBranches([])`
  // don't apply until the next render) and re-pick its "current" branch into
  // a freshly-cleared `value`.
  const [snap, setSnap] = useState<{ workdir: string; list: BranchInfo[] }>({ workdir: "", list: [] });
  // Listing failure (git for-each-ref / API). Kept separate from `fetchError`
  // so the picker tooltip never mislabels a `git fetch` failure as "couldn't
  // list branches".
  const [error, setError] = useState<string | null>(null);
  // `git fetch` failure, surfaced on the Fetch button only.
  const [fetchError, setFetchError] = useState<string | null>(null);
  // `git pull` failure, surfaced on the Pull button only (kept separate from
  // `fetchError` for the same reason: don't mislabel a pull failure as a fetch).
  const [pullError, setPullError] = useState<string | null>(null);
  // Bumped by the Git Fetch/Pull buttons to re-run the listing effect after a
  // `git fetch`/`git pull` changes refs, without touching `workdir`.
  const [refreshKey, setRefreshKey] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [pulling, setPulling] = useState(false);
  const lastWorkdirRef = useRef(workdir);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // A workdir/refresh change abandons any in-flight fetch/pull UI: clear its
    // spinner and error so they don't linger against the new project (the
    // fetch/pull promises themselves are also guarded below).
    setFetching(false);
    setFetchError(null);
    setPulling(false);
    setPullError(null);
    // Reset eagerly so the picker never shows the previous project's branches
    // while the new fetch is in flight.
    setSnap({ workdir, list: [] });
    // Workdir changed since last run — drop the previously selected ref so a
    // branch from the prior repo doesn't linger (and won't get rendered as a
    // "custom ref" entry against a repo that doesn't have it). Guarded so a
    // manual refresh (same workdir, bumped refreshKey) leaves the selection be.
    if (lastWorkdirRef.current !== workdir) {
      lastWorkdirRef.current = workdir;
      if (value) onChange("");
    }
    if (!workdir) return;
    (async () => {
      try {
        const list = await api.listBranches(workdir);
        if (!cancelled) setSnap({ workdir, list });
      } catch (e) {
        if (!cancelled) {
          setSnap({ workdir, list: [] });
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [workdir, refreshKey]);

  // A pull failure is branch-specific ("can't fast-forward <branch>"), so clear
  // it when the selection changes — otherwise its tooltip lingers on the Pull
  // button against a different branch and reads as that branch's failure.
  useEffect(() => { setPullError(null); }, [value]);

  // Pull all remotes, then re-list branches so freshly pushed `origin/*`
  // branches appear in the picker. Network-bound, so the trigger spins while
  // it runs; failures surface on the Fetch button via `fetchError`. The fetch
  // is tagged with the workdir it started against so a project switch mid-fetch
  // can't apply a stale result/spinner/error to the new project.
  const handleFetch = async () => {
    // Don't fetch while a pull is mid-flight: two concurrent git network ops on
    // the same repo race on git's ref/FETCH_HEAD locks. The Fetch button is also
    // disabled while `pulling` for the same reason.
    if (!workdir || fetching || pulling) return;
    const dir = workdir;
    setFetching(true);
    setFetchError(null);
    try {
      await api.gitFetch(dir);
      if (dir === lastWorkdirRef.current) setRefreshKey((k) => k + 1);
    } catch (e) {
      if (dir === lastWorkdirRef.current) setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (dir === lastWorkdirRef.current) setFetching(false);
    }
  };

  // Fast-forward the selected local branch to its upstream, then re-list so the
  // behind indicator clears. Network-bound like fetch; same workdir-tagging so a
  // project switch mid-pull can't apply a stale spinner/error/result. Guarded by
  // `canPull` below — only enabled for a local branch that has an upstream.
  const handlePull = async () => {
    if (!workdir || pulling || fetching || !canPull) return;
    const dir = workdir;
    const branch = value;
    setPulling(true);
    setPullError(null);
    try {
      await api.gitPull(dir, branch);
      if (dir === lastWorkdirRef.current) setRefreshKey((k) => k + 1);
    } catch (e) {
      if (dir === lastWorkdirRef.current) setPullError(e instanceof Error ? e.message : String(e));
    } finally {
      if (dir === lastWorkdirRef.current) setPulling(false);
    }
  };

  // Only trust `branches` when its workdir matches the current one; otherwise
  // the data is stale from the prior project and would mislead both the
  // dropdown and the auto-select effect below.
  const branches = snap.workdir === workdir ? snap.list : [];

  // The selected branch's tracking info drives the Pull button + behind badge.
  // Pull only makes sense for a real local branch with an upstream — not the
  // synthetic HEAD row, a remote-only `origin/*`, or a custom sha.
  const selected = branches.find((b) => b.name === value);
  const canPull = !!selected && !selected.remote && !!selected.upstream;
  const behind = selected?.behind ?? 0;
  const ahead = selected?.ahead ?? 0;
  // Diverged = behind AND ahead → a fast-forward pull will be refused. We still
  // let the user click Pull (the server returns the explicit ff error), but the
  // badge/tooltip say "diverged" instead of steering them to "pull to ff".
  const diverged = behind > 0 && ahead > 0;

  // When branches arrive and no explicit value is set, pre-select the current
  // branch so the trigger doesn't show a misleading "HEAD" while a real ref is
  // already checked out. Guarded by `value` so we don't fight the user after
  // they pick something else.
  useEffect(() => {
    if (value) return;
    const current = branches.find((b) => b.current);
    if (current) onChange(current.name);
    // Intentionally not depending on onChange to avoid loops when the parent
    // doesn't memoize it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, value]);

  // Drop the synthetic "HEAD" row when there's at least one real branch — the
  // current-branch row already represents "what's checked out". On an empty
  // repo (no branches yet) we keep HEAD so the picker isn't blank.
  const items: { value: string; label: string; hint: string; pinned: boolean }[] = [];
  if (branches.length === 0) {
    items.push({
      value: HEAD_VALUE,
      label: tr("tasks.head"),
      hint: tr("common.use_the_workdir_s_current_head_when_the"),
      pinned: true,
    });
  }
  for (const b of branches) {
    const age = b.current ? `current · ${formatAge(b.committedAt)}` : formatAge(b.committedAt);
    items.push({
      value: b.name,
      label: b.name,
      hint: b.behind ? tr("common.behind_b74a11", { p0: String(age), p1: String(b.behind) }) : age,
      pinned: b.current,
    });
  }

  // Treat empty string as HEAD so the trigger always shows something concrete.
  const effective = value || HEAD_VALUE;
  const displayedItem = items.find((i) => i.value === effective);
  if (!displayedItem && value) {
    // Custom value the user typed (e.g. a sha) — render an entry so the
    // trigger label matches what will actually be sent.
    items.push({ value, label: value, hint: tr("common.custom_ref"), pinned: false });
  }

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      {/* Label + behind badge + Git Pull/Fetch share one row so the picker below
          stays full-width. The controls sit flush-right (ml-auto) even with no label. */}
      <div className="flex items-center gap-2">
        {label && <label className="text-muted-foreground">{label}</label>}
        {behind > 0 && (
          diverged ? (
            <span
              className="ml-auto inline-flex items-center gap-0.5 text-xs font-medium text-warning"
              title={tr("common.has_diverged_from_ahead_behind_fast_forward_not", { p0: String(selected?.name), p1: String(selected?.upstream ?? tr("common.the_remote")), p2: String(ahead), p3: String(behind) })}
            >
              <ArrowDownUp className="size-3" aria-hidden /><I18nText id="common.diverged" />{" "}</span>
          ) : (
            <span
              className="ml-auto inline-flex items-center gap-0.5 text-xs font-medium text-warning"
              title={tr("common.commit_behind_pull_to_fast_forward", { p0: String(behind), p1: String(behind === 1 ? "" : englishPluralSuffix()), p2: String(selected?.upstream ?? tr("common.the_remote")) })}
            >
              <ArrowDownToLine className="size-3" aria-hidden />
              {behind}{" "}<I18nText id="common.behind" />{" "}</span>
          )
        )}
        <button
          type="button"
          onClick={handlePull}
          disabled={disabled || !workdir || pulling || fetching || !canPull}
          title={
            pullError
              ? tr("common.git_pull_failed", { p0: String(pullError) })
              : !selected || selected.remote
                ? tr("common.select_a_local_branch_to_pull")
                : !selected.upstream
                  ? tr("common.no_upstream_configured_for", { p0: String(selected.name) })
                  : diverged
                    ? tr("common.has_diverged_from_fast_forward_will_fail_reconcile", { p0: String(selected.name), p1: String(selected.upstream) })
                    : tr("common.fast_forward_to_git_pull_ff_only", { p0: String(selected.name), p1: String(selected.upstream) })
          }
          className={cn(
            "inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            behind > 0 ? "" : "ml-auto",
            (disabled || !workdir || pulling || fetching || !canPull) && "cursor-not-allowed opacity-50",
          )}
        >
          <ArrowDownToLine className={cn("size-3", pulling && "animate-pulse")} aria-hidden />
          {pulling ? tr("common.pulling") : tr("common.pull")}
        </button>
        <button
          type="button"
          onClick={handleFetch}
          disabled={disabled || !workdir || fetching || pulling}
          title={
            fetchError
              ? tr("common.git_fetch_failed", { p0: String(fetchError) })
              : "Fetch all branches from remote (git fetch --all --prune)"
          }
          className={cn(
            "inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            (disabled || !workdir || fetching || pulling) && "cursor-not-allowed opacity-50",
          )}
        >
          <RefreshCw className={cn("size-3", fetching && "animate-spin")} aria-hidden />
          {fetching ? tr("common.fetching") : tr("common.fetch")}
        </button>
      </div>
      <SearchSelect
        value={effective}
        onChange={(next) => onChange(next === HEAD_VALUE ? "" : next)}
        items={items}
        className="w-full"
        placement={placement}
        disabled={disabled}
        title={title ?? (error ? tr("common.couldn_t_list_branches", { p0: String(error) }) : undefined)}
        placeholder={tr("tasks.search_branches")}
        emptyLabel="HEAD"
        leadingIcon={<GitBranch className="size-3.5" />}
        displayValue={(v) => (v === HEAD_VALUE ? tr("tasks.head") : v)}
      />
    </div>
  );
}
