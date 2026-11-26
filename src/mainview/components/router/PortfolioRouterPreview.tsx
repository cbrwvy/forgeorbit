import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { createPreviewSession, type PortfolioPreviewResponse } from "@/lib/model-router-api";

import { CandidateGroupsView } from "./CandidateCards";
import { useEvidenceClock } from "./useEvidenceClock";
import {
  EMPTY_PREVIEW_DRAFT,
  POLICY_COPY,
  PREVIEW_BANNER,
  PRIORITY_CHOICES,
  PreviewDraftError,
  buildPortfolioPreviewBody,
  type PortfolioPreviewRequest,
  policies,
  portfolioComparison,
  previewBoundary,
  hasExpiredQuota,
  type PortfolioComparison,
  type PreviewDraft,
} from "@/lib/model-router-preview";
import type { TaskPriority } from "../../../shared/task-scheduling.ts";

export interface PortfolioPreviewTask {
  path: string;
  name: string | null;
  tasks: { id: string; title: string }[];
}

function messageOf(reason: unknown): string {
  if (reason instanceof PreviewDraftError || reason instanceof ApiError || reason instanceof Error) return reason.message;
  return tr("common.the_comparison_could_not_be_calculated");
}

/**
 * Compact portfolio comparison. Task choices come from the snapshot already
 * loaded by the portfolio page. Compare sends one portfolio-preview request
 * and does not reserve quota or start an agent.
 */
export function PortfolioRouterPreview({ projects }: { projects: PortfolioPreviewTask[] }) {
  useUILocale();
  const helpId = useId();
  const session = useRef(createPreviewSession());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [policy, setPolicy] = useState<PreviewDraft["policy"]>("balanced");
  const [priorities, setPriorities] = useState<Record<string, "" | TaskPriority>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ comparison: PortfolioComparison; response: PortfolioPreviewResponse } | null>(null);
  const now = useEvidenceClock(view?.response.previews ?? null);

  const known = projects.map((project) => ({ path: project.path, taskIds: project.tasks.map((task) => task.id) }));
  const chosen = projects.flatMap((project) => project.tasks.filter((task) => selected[`${project.path}\0${task.id}`]).map((task) => ({ path: project.path, taskId: task.id })));

  const knownKey = JSON.stringify(known);
  useEffect(() => {
    const current = session.current;
    current.invalidate();
    setLoading(false);
    setView(null);
    setError(null);
    return () => current.invalidate();
  }, [knownKey]);

  const invalidate = () => {
    session.current.invalidate();
    setLoading(false);
    setView(null);
    setError(null);
  };
  const toggle = (key: string) => {
    invalidate();
    setSelected((current) => ({ ...current, [key]: !current[key] }));
  };

  const compare = () => {
    const run = session.current.begin();
    setLoading(true);
    setView(null);
    setError(null);
    let body: PortfolioPreviewRequest;
    try {
      body = buildPortfolioPreviewBody(chosen, { ...EMPTY_PREVIEW_DRAFT, policy }, priorities, known, { harnessIds: [], accountIds: [] });
    } catch (caught) {
      setLoading(false);
      setError(messageOf(caught));
      return;
    }
    void api.modelRouter.portfolioPreview(body, run.signal).then((response) => {
      if (!run.isCurrent()) return;
      const boundary = previewBoundary({ readOnly: response.readOnly, execution: response.execution, revalidation: { requiredBeforeExecution: true, reservesResources: false, checks: [] } });
      if (!boundary.ok || response.previews.some((preview) => !previewBoundary(preview).ok)) {
        setView(null);
        setError(boundary.ok ? tr("common.a_task_result_was_not_preview_only") : boundary.banner);
        setLoading(false);
        return;
      }
      if (response.previews.length !== body.requests.length || response.previews.some(preview => !body.requests.some(request => request.path === preview.requirements.projectId && request.taskId === preview.requirements.taskId)) || new Set(response.previews.map(preview => preview.requirements.taskId)).size !== body.requests.length) {
        throw new Error(tr("common.the_comparison_does_not_match_the_selected_tasks"));
      }
      setView({
        comparison: portfolioComparison(response.previews, response.planningEstimates),
        response,
      });
      setLoading(false);
    }).catch((caught: unknown) => {
      if (!run.isCurrent()) return;
      setView(null);
      setError(messageOf(caught));
      setLoading(false);
    });
  };

  return (
    <section className="glass-surface flex min-w-0 flex-col gap-2 rounded-xl border p-3" data-testid="portfolio-router" aria-label={tr("resources.resource_comparison")}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold"><I18nText id="resources.resource_comparison" /></h2>
        <p className="text-[11px] text-muted-foreground" data-testid="portfolio-router-banner">{staticLabel(PREVIEW_BANNER)}{" "}<I18nText id="resources.simulated_quota_use_inside_this_comparison_is_not" /></p>
      </div>
      {projects.every((project) => project.tasks.length === 0) ? (
        <p className="text-xs text-muted-foreground" data-testid="portfolio-router-empty"><I18nText id="resources.no_board_tasks_are_in_the_current_snapshot" /></p>
      ) : (
        <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-xs">
          {projects.map((project) => (
            <li key={project.path} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-medium">{project.name || project.path}</span>
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><I18nText id="common.project_priority" />{" "}<Select
                    className="h-7 w-auto min-w-[7rem] text-[11px]"
                    data-testid="portfolio-router-priority"
                    value={priorities[project.path] ?? ""}
                    onChange={(event) => {
                      invalidate();
                      setPriorities((current) => ({ ...current, [project.path]: event.target.value as "" | TaskPriority }));
                    }}
                  >
                    <option value=""><I18nText id="common.unknown" /></option>
                    {PRIORITY_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                  </Select>
                </label>
              </div>
              <ul className="mt-1 flex flex-col gap-1">
                {project.tasks.map((task) => {
                  const key = `${project.path}\0${task.id}`;
                  return (
                    <li key={key}>
                      <label className="flex min-w-0 items-center gap-2">
                        <input type="checkbox" data-testid="portfolio-router-task" data-task-id={task.id} checked={selected[key] === true} onChange={() => toggle(key)} />
                        <span className="min-w-0 break-words">{task.title}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select className="h-8 w-auto min-w-[12rem] text-xs" data-testid="portfolio-router-policy" aria-label={tr("resources.comparison_routing_policy")} aria-describedby={helpId} value={policy} onChange={(event) => { invalidate(); setPolicy(event.target.value as PreviewDraft["policy"]); }}>
          {policies().map((item) => <option key={item} value={item}>{POLICY_COPY[item].label}</option>)}
        </Select>
        <Button type="button" size="sm" data-testid="portfolio-router-compare" disabled={loading || chosen.length === 0} onClick={compare}>
          {loading ? tr("common.comparing") : tr("common.compare_resources")}
        </Button>
      </div>
      <p id={helpId} className="text-[11px] text-muted-foreground">{POLICY_COPY[policy].explanation}</p>
      {loading && <p role="status" className="text-xs"><I18nText id="resources.comparing_the_selected_tasks" /></p>}
      {error && <p role="alert" className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs" data-testid="portfolio-router-error">{error}</p>}
      {view && (
        <div className="flex min-w-0 flex-col gap-2" data-testid="portfolio-router-result">
          {view.comparison.crossProjectAllocationWithheld && (
            <p className="text-xs" data-testid="portfolio-router-priority-withheld"><I18nText id="resources.project_priorities_are_incomplete_so_this_preview_does" /></p>
          )}
          <section data-testid="portfolio-router-shared">
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="resources.shared_resource_notes" /></h3>
            {view.comparison.sharedNotes.length === 0 ? <p className="text-[11px] text-muted-foreground"><I18nText id="resources.no_shared_pool_or_shared_subscription_note_was" /></p> : (
              <ul className="text-[11px]">{view.comparison.sharedNotes.map((note) => <li key={note} className="break-words">{note}</li>)}</ul>
            )}
          </section>
          <section data-testid="portfolio-router-quota">
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="resources.quota_competition" /></h3>
            {view.comparison.quotaCompetition.length === 0 ? <p className="text-[11px] text-muted-foreground"><I18nText id="resources.no_quota_competition_was_returned" /></p> : (
              <ul className="text-[11px]">{view.comparison.quotaCompetition.map((note) => <li key={note} className="break-words">{note}</li>)}</ul>
            )}
            <p className="text-[11px] text-muted-foreground"><I18nText id="resources.subscription_totals_are_not_added_together_nothing_here" /></p>
          </section>
          <ul className="flex flex-col gap-2">
            {view.comparison.tasks.map((task) => {
              const preview = view.response.previews.find((item) => item.requirements.taskId === task.taskId);
              const expired = preview?.recommendedCandidate && hasExpiredQuota(preview.recommendedCandidate, now);
              return (
                <li key={task.taskId} className="min-w-0 rounded-md border px-2 py-2" data-testid="portfolio-router-task-result" data-task-id={task.taskId}>
                  <p className="break-all text-xs font-medium">{task.taskId}</p>
                  <p className="break-all text-[11px]"><I18nText id="common.project" />{" "}{task.projectId}</p>
                  <p className="break-words text-[11px]"><I18nText id="resources.project_priority" />{" "}{task.projectPriority}{" "}<I18nText id="resources.task_priority" />{" "}{task.taskPriority} · {expired ? tr("common.snapshot_recommendation_has_expired_quota_evidence_recalculate") : task.status === "recommended" && task.recommendation ? tr("common.recommended_at_snapshot", { p0: String(task.recommendation) }) : tr("resources.no_verified_candidate")}</p>
                  <p className="text-[11px]"><I18nText id="resources.snapshot" />{" "}{preview ? new Date(preview.capturedAt).toISOString() : tr("common.unknown")}<I18nText id="resources.recalculate_for_new_local_evidence" /></p>
                  <p className="break-words text-[11px]"><I18nText id="common.concurrency" />{" "}{task.concurrency.length ? task.concurrency.join("; ") : tr("common.unknown_numeric_capacity_is_not_reported")}</p>
                  <ul className="space-y-1 break-words text-[11px]">{task.estimate.lines.map(line => <li key={line}>{line}</li>)}</ul>
                  {task.conflicts.length > 0 && <ul aria-label={tr("resources.task_resource_conflicts")} className="break-words text-[11px]">{task.conflicts.map(note => <li key={note}>{note}</li>)}</ul>}
                  {preview && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground"><I18nText id="resources.candidate_details" /></summary>
                      <div className="mt-1">
                        <CandidateGroupsView preview={preview} accounts={[]} />
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
          <section data-testid="portfolio-router-unresolved">
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="resources.unresolved_constraints" /></h3>
            {view.comparison.unresolved.length === 0 ? <p className="text-[11px] text-muted-foreground"><I18nText id="resources.none_returned" /></p> : (
              <ul className="max-h-40 overflow-y-auto text-[11px]">{view.comparison.unresolved.map((item) => <li key={item} className="break-words">{item}</li>)}</ul>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
