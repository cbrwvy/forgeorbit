import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, GitMerge, Loader2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { buildResolveConflictsPrompt } from "@/lib/resolve-conflicts-prompt";
import type { TaskReference } from "../../../shared/types.ts";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { createAndStartTask, TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";
import { WorktreeOptions } from "./WorktreeOptions";
import { PromptComposer } from "./PromptComposer";

export interface ResolveConflictsContext {
  path: string;
  repo: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: ResolveConflictsContext | null;
  onCreated?: (taskId: string) => void;
}

/**
 * "Resolve with Agetor" dialog for a PR's merge conflicts. Creates a task ON
 * the PR's head branch (`existingBranch: context.headRef`), which the server
 * requires worktree isolation for and ignores `baseRef` on — so this dialog
 * renders `WorktreeOptions`' `locked` variant (a read-only "Branch" row +
 * a checked/disabled isolate checkbox) instead of the live picker, and
 * shares the same `PromptComposer` (`/` autocomplete, drag/paste-to-attach,
 * References picker) `CreateTaskFromIssueDialog` uses, rather than a bare
 * `Textarea`.
 */
export function ResolveConflictsDialog({ open, onClose, context, onCreated }: Props) {
  const { locale: uiLocale } = useUILocale();
  const launch = useTaskLaunch(open);

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [references, setReferences] = useState<TaskReference[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // `@` file-reference scope: the worktree is locked to the PR's head branch
  // (`context.headRef`) — `listProjectFiles` falls back to
  // `origin/<headRef>` when it only exists as a remote-tracking ref. Gated
  // on `open` so a closed dialog never fetches; memoized so
  // `useProjectFiles`'s effect doesn't refire on every unrelated re-render.
  const fileScope = useMemo(
    () => (open && context ? { dir: context.path, ref: context.headRef } : null),
    [open, context?.path, context?.headRef, uiLocale],
  );

  // Reset per-open transient state (prompt dirtiness, errors, references) so
  // a previous PR's edits don't leak into the next one. Harness/model/prefs
  // fetching is owned by useTaskLaunch.
  useEffect(() => {
    if (!open) return;
    setPromptDirty(false);
    setSubmitError(null);
    setReferences([]);
  }, [open]);

  // Seed (and re-seed) the prompt from the context, but only while the user
  // hasn't started editing it — matches the composer's usual "don't clobber
  // what you typed" rule.
  useEffect(() => {
    if (!open || !context || promptDirty) return;
    setPrompt(buildResolveConflictsPrompt(context));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context, promptDirty]);

  const overage = promptByteOverage(launch.effectiveKind, composeLaunchPrompt(launch.selectedProfile, prompt));
  // Names the harness a launch will ACTUALLY run under — the selected
  // profile's harness when one is picked, else the manually-picked one
  // (finding F2-3; `launch.agent`/`selectedStatus` stay pinned to the
  // manual picker and go stale once a profile hides that block).
  const selectedHarnessLabel = launch.harnesses.find((h) => h.id === launch.effectiveAgent)?.label ?? launch.effectiveAgent;

  const canSubmit =
    !!context && prompt.trim().length > 0 && !!launch.effectiveStatus?.available && !submitting && overage == null;

  const submit = async () => {
    if (!context || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createAndStartTask({
        title: tr("common.resolve_conflicts_pr", { p0: String(context.number), p1: String(context.title) }),
        prompt: prompt.trim(),
        agent: launch.agent,
        workdir: context.path,
        isolation: "worktree" as const,
        existingBranch: context.headRef,
        references,
        mode: launch.mode,
        model: launch.model,
        effort: launch.effort,
        fast: launch.fast,
        maxMode: launch.maxMode,
        // Omit entirely when no profile is selected (finding F2-1) — see
        // NewTaskForm.submit's matching comment.
        ...(launch.agentProfileId ? { agentProfileId: launch.agentProfileId } : {}),
        column: "ready" as const,
      });
      launch.rememberPicks();
      onCreated?.(created);
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="resolve-conflicts-dialog-title"
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      {/* `display: contents` keeps this test-id wrapper out of the flex
       *  layout below — header/body/footer still act as direct flex items
       *  of the Dialog panel (which needs that for its max-h/overflow
       *  scroll region to work), while still giving e2e a stable node to
       *  find the whole dialog by. Dialog's own props don't forward
       *  arbitrary data-* attributes onto the panel. */}
      <div data-testid="resolve-conflicts-dialog" className="contents">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div id="resolve-conflicts-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
              <GitMerge className="size-4 shrink-0 text-muted-foreground" /><I18nText id="tasks.resolve_with_forgeorbit" />{" "}</div>
            {context && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                PR #{context.number} — {context.title}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            title={tr("common.close")}
            aria-label={tr("common.close")}
            disabled={submitting}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
          {launch.loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />{" "}<I18nText id="tasks.loading_harnesses" />{" "}</div>
          )}

          {!launch.loading && launch.loadError && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-danger">
              <AlertCircle className="size-4" /> {launch.loadError}
            </div>
          )}

          {!launch.loading && !launch.loadError && !context && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <AlertCircle className="size-4" />{" "}<I18nText id="tasks.the_pr_s_state_changed_close_and_reopen" />{" "}</div>
          )}

          {!launch.loading && !launch.loadError && !!context && (
            <div className="space-y-3">
              {context && (
                <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"><I18nText id="tasks.merges" />{" "}<span className="font-mono">origin/{context.baseRef}</span>{" "}<I18nText id="tasks.into" />{" "}
                  <span className="font-mono">{context.headRef}</span>{" "}<I18nText id="tasks.in_a_worktree_checked_out_on_that_branch" />{" "}</div>
              )}

              <PromptComposer
                value={prompt}
                onChange={(v) => { setPrompt(v); setPromptDirty(true); }}
                agent={launch.effectiveAgent}
                references={references}
                onReferencesChange={setReferences}
                setReferences={setReferences}
                fileScope={fileScope}
                startingFolder={context.path}
                rows={8}
                footer={overage && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning"><I18nText id="tasks.this_prompt_is" />{" "}{Math.ceil(overage.bytes / 1024)}{" "}<I18nText id="tasks.kb" />{" "}{selectedHarnessLabel}<I18nText id="tasks.s_one_shot_launch_caps_prompts_at" />{" "}{Math.floor(overage.limit / 1024)}{" "}<I18nText id="tasks.kb_pick_another_harness_or_trim_the_prompt" />{" "}</div>
                )}
              />

              <WorktreeOptions locked={{ branch: context.headRef }} />

              <TaskLaunchPickers launch={launch} />

              {submitError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-danger">
                  {submitError}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 p-3">
          <Button variant="outline" onClick={onClose} disabled={submitting}><I18nText id="common.cancel" />{" "}</Button>
          <Button data-testid="resolve-conflicts-submit" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="mr-1 size-3.5 animate-spin" />{" "}<I18nText id="common.creating" />{" "}</>
            ) : (
              tr("common.create_start")
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
