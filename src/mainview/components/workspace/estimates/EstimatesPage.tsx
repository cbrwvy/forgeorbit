import { codeLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
/**
 * Project estimation dashboard (FO-006B).
 *
 * Every figure comes from `estimate` / `estimateWhatIf`. Missing inputs stay
 * unknown. Nothing on this page starts a harness or a kanban run.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { subscribeDependencyEvents } from "@/lib/dependency-events";
import { cn } from "@/lib/utils";
import { isProjectTask } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { estimate } from "../../../../shared/estimation/estimate.ts";
import {
  adaptProject,
  backlogFingerprint,
  estimateIsStale,
  type ProjectTaskFact,
  type StructuredDependency,
} from "../../../../shared/estimation/project-adapter.ts";
import {
  compareResults,
  currencyFractionDigits,
  formatCalendar,
  formatCash,
  formatDurationForecast,
  formatDurationMs,
  formatMoney,
  majorToMinor,
  minorToMajorInput,
  runWhatIf,
  type DisplayFigure,
} from "@/i18n/estimation";
import {
  emptyEstimationSettings,
  type EstimationSettings,
  type ManualStage,
  type ManualSubscription,
  type ObservedDuration,
} from "../../../../shared/estimation/settings.ts";
import type { ScenarioId, StageKind, WhatIfPatch } from "../../../../shared/estimation/types.ts";
import type { Project, Task } from "../../../../shared/types.ts";

/** Coalesces a burst of dependency events (a proposal links several tasks). */
const DEPENDENCY_REFRESH_DEBOUNCE_MS = 150;

const STAGE_KINDS: StageKind[] = ["planning", "implementation", "testing", "review", "fixes", "validation", "other"];

interface Props {
  project: Project;
  tasks: Task[];
}

interface WhatIfState {
  exclude: string[];
  parallelism: "unchanged" | "unset" | "unbounded" | "number";
  parallelismCount: string;
  budget: "unchanged" | "clear" | "amount";
  budgetAmount: string;
  itemId: string;
  modelId: string;
  optimistic: string;
  expected: string;
  conservative: string;
}

export function EstimatesPage({ project, tasks }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [settings, setSettings] = useState<EstimationSettings>(() => emptyEstimationSettings());
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [observations, setObservations] = useState<ObservedDuration[]>([]);
  const [structured, setStructured] = useState<StructuredDependency[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIfState>(emptyWhatIf);
  const [currencyDraft, setCurrencyDraft] = useState("");
  // Every read of the structured links (page load, save, refresh) takes a
  // ticket; only the newest one may write, so an older response can never
  // overwrite links read after a later change.
  const edgesTicket = useRef(0);
  const applyEdges = useCallback((ticket: number, edges: StructuredDependency[]) => {
    if (ticket !== edgesTicket.current) return;
    setStructured((current) => (sameEdges(current, edges) ? current : edges));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSettings(emptyEstimationSettings());
    setSavedFingerprint(null);
    setObservations([]);
    setStructured([]);
    setSavedAt(null);
    setLoadError(null);
    setSaveError(null);
    setLoaded(false);
    setEditingId(null);
    setWhatIf(emptyWhatIf());
    setCurrencyDraft("");
    const ticket = ++edgesTicket.current;
    void api.getProjectEstimation(project.path).then(
      (record) => {
        if (cancelled) return;
        const next = record.settings ?? emptyEstimationSettings();
        setSettings(next);
        setCurrencyDraft(next.reportCurrency ?? "");
        setSavedFingerprint(record.backlogFingerprint);
        setSavedAt(record.savedAt);
        setObservations(record.observations);
        applyEdges(ticket, record.structuredDependencies ?? []);
        setLoadError(record.settingsError ?? null);
        setLoaded(true);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setLoadError(reason instanceof Error ? reason.message : tr("common.estimates_could_not_be_loaded"));
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project.path, applyEdges]);

  // A link edit does not change the task rows the board polls, so the page
  // re-reads the links when the core says they changed (the `task_dependencies`
  // AppEvent on App's one `/app/events` stream), when that stream reconnects
  // (an event may have been lost), and when the window comes back into view.
  // Opening the page or switching project reads them with the record above.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      timer = null;
      const ticket = ++edgesTicket.current;
      void api.getProjectEstimationDependencies(project.path).then(
        (body) => {
          if (!cancelled) applyEdges(ticket, body.structuredDependencies);
        },
        () => {
          // Keep what is shown; the next event, reconnect, or focus retries.
        },
      );
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DEPENDENCY_REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeDependencyEvents((signal) => {
      if (signal.projectPath === null || signal.projectPath === project.path) schedule();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [project.path, applyEdges]);

  const facts = useMemo(
    () => tasks.filter((task) => isProjectTask(task, project.path)).map((task) => toFact(task, observations)),
    [tasks, project.path, observations, uiLocale],
  );
  const fingerprint = useMemo(() => backlogFingerprint(facts, structured), [facts, structured, uiLocale]);
  const stale = estimateIsStale(savedFingerprint, fingerprint);
  const visible = facts.filter((fact) => fact.pipelineParentId == null && (settings.includeArchived || !fact.archived));
  const adapted = useMemo(
    () => adaptProject({ projectPath: project.path, projectLabel: project.name || project.path, facts, settings, structuredDependencies: structured }),
    [project.path, project.name, facts, settings, structured, uiLocale],
  );
  const result = useMemo(() => estimate(adapted.request), [adapted.request, uiLocale]);
  const expected = result.scenarios?.expected ?? null;
  const patch = useMemo(() => buildWhatIfPatch(whatIf, adapted.request, settings), [whatIf, adapted.request, settings, uiLocale]);
  const comparison = useMemo(() => {
    if (!patch.ok || !patch.patch) return null;
    const ran = runWhatIf(adapted.request, patch.patch);
    return { ...compareResults(ran.base, ran.next, patch.parallelismChanged), nextOk: ran.next.ok };
  }, [patch, adapted.request, uiLocale]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const ticket = ++edgesTicket.current;
    try {
      const record = await api.saveProjectEstimation(project.path, settings);
      setSavedFingerprint(record.backlogFingerprint);
      setSavedAt(record.savedAt);
      setObservations(record.observations);
      applyEdges(ticket, record.structuredDependencies ?? []);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : tr("common.estimates_could_not_be_saved"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 sm:px-page" data-testid="project-estimates">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold"><I18nText id="common.estimates" /></h2>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground"><I18nText id="estimates.planning_figures_only_nothing_here_starts_an_agent" />{" "}</p>
      </div>

      {loadError && <Notice testId="estimates-error" tone="warning">{loadError}</Notice>}
      {stale && (
        <Notice testId="estimates-stale" tone="warning"><I18nText id="estimates.the_backlog_or_its_dependencies_changed_after_this" />{" "}</Notice>
      )}
      {!result.ok && (
        <Notice testId="estimates-invalid" tone="warning">
          {result.issues.map((issue) => issue.message).join(" ")}
        </Notice>
      )}

      <section className="surface-solid min-w-0 rounded-xl border p-4" aria-labelledby="estimates-scope-heading">
        <h3 id="estimates-scope-heading" className="text-sm font-medium"><I18nText id="common.scope" /></h3>
        <fieldset className="mt-3 flex flex-col gap-2">
          <legend className="sr-only"><I18nText id="estimates.estimate_scope" /></legend>
          <ScopeChoice
            name="project"
            testId="estimates-scope-project"
            checked={settings.scope.kind === "project"}
            label={tr("estimates.entire_project")}
            onChange={() => setSettings((current) => ({ ...current, scope: { kind: "project" } }))}
          />
          <ScopeChoice
            name="selected"
            testId="estimates-scope-selected"
            checked={settings.scope.kind === "selected"}
            label={tr("estimates.selected_tasks")}
            onChange={() => setSettings((current) => ({
              ...current,
              scope: { kind: "selected", itemIds: visible.map((fact) => fact.id) },
            }))}
          />
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input type="radio" name="estimates-scope" disabled data-testid="estimates-scope-group" />
            <span><I18nText id="estimates.feature_milestone_no_feature_or_milestone_is_stored" /></span>
          </label>
        </fieldset>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.includeArchived}
            data-testid="estimates-include-archived"
            onChange={(event) => setSettings((current) => ({ ...current, includeArchived: event.target.checked }))}
          /><I18nText id="estimates.include_archived_tasks" />{" "}</label>
        {settings.scope.kind === "selected" && (
          <ul className="mt-3 flex flex-col gap-1">
            {visible.length === 0 && <li className="text-xs text-muted-foreground"><I18nText id="estimates.no_tasks_to_select" /></li>}
            {visible.map((fact) => (
              <li key={fact.id}>
                <label className="flex min-w-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="estimates-task-toggle"
                    data-task-id={fact.id}
                    checked={settings.scope.kind === "selected" && settings.scope.itemIds.includes(fact.id)}
                    onChange={(event) => toggleSelected(setSettings, fact.id, event.target.checked)}
                  />
                  <span className="truncate" title={fact.title}>{fact.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {visible.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="estimates-empty"><I18nText id="estimates.this_project_has_no_tasks_in_the_estimate" />{" "}</p>
      )}

      {expected && (
        <section aria-label={tr("common.summary")} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FigureCard title={tr("estimates.agent_execution_time")} testId="estimates-summary-agent" figure={formatDurationForecast(expected.agent)} />
          <FigureCard title={tr("estimates.calendar_completion_time")} testId="estimates-summary-calendar" figure={formatCalendar(expected.calendar)} />
          <FigureCard title={tr("estimates.additional_cash_required")} testId="estimates-summary-cash" figure={formatCash(expected.additionalCash)} />
          <FigureCard title={tr("estimates.subscription_cost")} testId="estimates-summary-subscription" figure={formatCash(expected.subscriptionFees)} />
          <FigureCard title={tr("estimates.api_equivalent_cost")} testId="estimates-summary-api" figure={formatCash(expected.apiEquivalent)} />
          <section className="surface-solid min-w-0 rounded-xl border p-3" data-testid="estimates-summary-confidence">
            <h3 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="common.confidence" /></h3>
            <p className="mt-1 text-lg font-semibold capitalize">{result.confidence.level}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{result.confidence.summary}</p>
          </section>
        </section>
      )}

      {result.scenarios && (
        <section aria-label={tr("estimates.scenarios")} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {(["optimistic", "expected", "conservative"] as const).map((scenario) => (
              <ScenarioCard key={scenario} scenario={scenario} forecast={result.scenarios![scenario]} />
            ))}
          </div>
          <ScenarioChart scenarios={result.scenarios} />
        </section>
      )}

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label={tr("common.data_quality")}>
        <TextList title={tr("common.missing_data")} testId="estimates-missing" rows={result.missing.map((row) => row.message)} empty="Nothing else is marked missing." />
        <TextList title={tr("common.assumptions")} testId="estimates-assumptions" rows={[...adapted.notes, ...result.assumptions]} empty="No assumptions." />
        <TextList title={tr("common.warnings")} testId="estimates-warnings" rows={result.warnings} empty="No warnings." />
        <TextList
          title={tr("estimates.data_provenance")}
          testId="estimates-provenance"
          rows={[
            ...result.provenance.map((row) => `${row.path}: ${row.origin}. ${row.detail}`),
            ...adapted.observed.map((row) => tr("common.wall_clock_from_run_this_measurement_does_not", { p0: String(row.title), p1: String(formatDurationMs(row.agentMs)), p2: String(row.runId), p3: String(row.status) })),
          ]}
          empty="No caller-supplied numbers yet. Run history will be listed here when a finished run has a start and an end."
        />
      </section>

      <section className="surface-solid min-w-0 rounded-xl border" aria-labelledby="estimates-plan-heading">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
          <h3 id="estimates-plan-heading" className="text-sm font-medium"><I18nText id="estimates.task_breakdown" /></h3>
          <p className="text-xs text-muted-foreground"><I18nText id="estimates.dependencies_come_from_the_board_or_from_edges" /></p>
        </div>
        <div className="overflow-x-auto overflow-y-hidden">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="text-[length:var(--text-caption)] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium"><I18nText id="common.task_4bc74b" /></th>
              <th className="px-3 py-2 font-medium"><I18nText id="common.status" /></th>
              <th className="px-3 py-2 font-medium"><I18nText id="estimates.harness_model" /></th>
              <th className="px-3 py-2 font-medium"><I18nText id="estimates.duration" /></th>
              <th className="px-3 py-2 font-medium"><I18nText id="common.observed" /></th>
              <th className="px-3 py-2 font-medium"><I18nText id="common.depends_on" /></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((fact) => {
              const item = adapted.request.items.find((row) => row.id === fact.id);
              const effort = item?.stages.find((stage) => stage.effort)?.effort ?? null;
              const observedMs = fact.observedRuns.reduce((sum, run) => sum + run.agentMs, 0);
              const boardDeps = new Set(structured.filter((edge) => edge.taskId === fact.id).map((edge) => edge.dependsOn));
              const deps = (item?.dependsOn ?? []).map((id) => {
                const title = visible.find((row) => row.id === id)?.title ?? id;
                return boardDeps.has(id) ? `${title} (board)` : title;
              });
              return (
                <tr key={fact.id} className="border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))]" data-testid="estimates-task-row" data-task-id={fact.id}>
                  <td className="px-3 py-2">
                    <button type="button" className="max-w-[16rem] truncate text-left underline-offset-2 hover:underline" title={fact.title} onClick={() => setEditingId(fact.id)}>
                      {fact.title}
                    </button>
                  </td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{codeLabel(fact.column)}</td>
                  <td className="max-w-[12rem] px-3 py-2">
                    <span className="block truncate" title={item?.stages[0]?.harnessId ?? tr("common.unknown")}>{item?.stages[0]?.harnessId ?? tr("common.unknown")}</span>
                    <span className="block truncate text-xs text-muted-foreground" title={item?.stages[0]?.modelId ?? tr("common.model_unknown_05e536")}>{item?.stages[0]?.modelId ?? tr("common.model_unknown_05e536")}</span>
                  </td>
                  <td className="px-3 py-2" data-origin={effort ? "user-provided" : tr("common.unknown_b23a6a")}>
                    {effort ? tr("common.expected_entered_by_you", { p0: String(formatDurationMs(effort.expectedMs)) }) : tr("common.unknown")}
                  </td>
                  <td className="px-3 py-2">{fact.observedRuns.length > 0 ? tr("common.from_run_history", { p0: String(formatDurationMs(observedMs)) }) : tr("common.no_recorded_run")}</td>
                  <td className="max-w-[12rem] px-3 py-2 truncate" title={deps.join(", ")} data-testid="estimates-task-deps">{deps.length > 0 ? deps.join(", ") : tr("common.none_confirmed")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        {editingId && visible.some((fact) => fact.id === editingId) && (
          <StageEditor
            fact={visible.find((fact) => fact.id === editingId)!}
            others={visible.filter((fact) => fact.id !== editingId)}
            stages={settings.stages[editingId] ?? []}
            dependsOn={settings.dependencies[editingId] ?? []}
            boardDependsOn={structured.filter((edge) => edge.taskId === editingId).map((edge) => edge.dependsOn)}
            onClose={() => setEditingId(null)}
            onSave={(stages, dependsOn) => {
              setSettings((current) => ({
                ...current,
                stages: { ...current.stages, [editingId]: stages },
                dependencies: { ...current.dependencies, [editingId]: dependsOn },
              }));
              setEditingId(null);
            }}
          />
        )}
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label={tr("estimates.planning_inputs")}>
        <div className="surface-solid min-w-0 rounded-xl border p-4" data-testid="estimates-parallelism">
          <h3 className="text-sm font-medium"><I18nText id="estimates.parallelism" /></h3>
          <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.a_higher_cap_is_a_ceiling_dependencies_unknown" />{" "}</p>
          <ConcurrencyControl
            value={settings.parallelism.maxConcurrentItems}
            onChange={(maxConcurrentItems) => setSettings((current) => ({ ...current, parallelism: { maxConcurrentItems } }))}
          />
        </div>
        <div className="surface-solid min-w-0 rounded-xl border p-4" data-testid="estimates-budget">
          <h3 className="text-sm font-medium"><I18nText id="estimates.budget_policy" /></h3>
          <p className="mt-1 break-words text-xs text-muted-foreground">{expected?.budget.reasons.join(" ") ?? tr("common.budget_has_not_been_assessed")}</p>
          <p className="mt-1 text-sm capitalize" data-testid="estimates-budget-verdict">{expected?.budget.verdict ?? tr("common.unknown_b23a6a")}</p>
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <BudgetChoice mode="unset" current={settings.budgetMode} label={tr("estimates.not_set_do_not_turn_unknown_spend_into")} onChange={(budgetMode) => setSettings((current) => ({ ...current, budgetMode }))} />
            <BudgetChoice mode="overage-off" current={settings.budgetMode} label={tr("estimates.extra_spend_is_off_this_is_a_policy")} onChange={(budgetMode) => setSettings((current) => ({ ...current, budgetMode }))} />
            <BudgetChoice mode="overage-on" current={settings.budgetMode} label={tr("estimates.extra_spend_is_allowed_for_providers_i_list")} onChange={(budgetMode) => setSettings((current) => ({ ...current, budgetMode }))} />
          </div>
          <MoneyField
            label={tr("estimates.additional_spending_limit")}
            testId="estimates-spend-limit"
            currency={settings.reportCurrency}
            money={settings.maxAdditionalSpend}
            onChange={(maxAdditionalSpend) => setSettings((current) => ({ ...current, maxAdditionalSpend }))}
          />
          <label className="mt-3 block text-xs text-muted-foreground"><I18nText id="estimates.allowed_providers_comma_separated" />{" "}<Input
              className="mt-1"
              value={settings.allowedPaidServices.join(", ")}
              data-testid="estimates-allowed-providers"
              onChange={(event) => {
                const allowedPaidServices = event.target.value.split(",").map((part) => part.trim()).filter(Boolean);
                setSettings((current) => ({ ...current, allowedPaidServices }));
              }}
            />
          </label>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.subscriptionUpgradeAllowed}
              data-testid="estimates-allow-upgrade"
              onChange={(event) => setSettings((current) => ({ ...current, subscriptionUpgradeAllowed: event.target.checked }))}
            /><I18nText id="estimates.allow_a_proposed_subscription_purchase" />{" "}</label>
        </div>
        <div className="surface-solid min-w-0 rounded-xl border p-4">
          <h3 className="text-sm font-medium"><I18nText id="estimates.calendar_availability" /></h3>
          <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.leave_either_field_blank_if_you_do_not" /></p>
          <DecimalCommit
            label={tr("estimates.duty_cycle_0_1")}
            testId="estimates-duty"
            value={settings.machine.dutyCycle}
            onCommit={(dutyCycle) => setSettings((current) => ({ ...current, machine: { ...current.machine, dutyCycle } }))}
          />
          <label className="mt-3 block text-xs text-muted-foreground"><I18nText id="estimates.planned_pause_minutes_zero_means_you_are_stating" />{" "}<Input
              className="mt-1"
              inputMode="numeric"
              data-testid="estimates-pause"
              value={settings.machine.plannedPauseMs == null ? "" : String(settings.machine.plannedPauseMs / 60_000)}
              onChange={(event) => {
                const parsed = wholeMinutes(event.target.value);
                setSettings((current) => ({
                  ...current,
                  machine: { ...current.machine, plannedPauseMs: parsed.ok ? parsed.ms : current.machine.plannedPauseMs },
                }));
              }}
            />
          </label>
        </div>
        <div className="surface-solid min-w-0 rounded-xl border p-4">
          <h3 className="text-sm font-medium"><I18nText id="estimates.report_currency" /></h3>
          <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.amounts_in_another_currency_stay_unconverted_until_you" /></p>
          <Input
            className="mt-3 max-w-[8rem] uppercase"
            maxLength={3}
            value={currencyDraft}
            data-testid="estimates-currency"
            aria-label={tr("estimates.report_currency")}
            onChange={(event) => {
              const next = event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
              setCurrencyDraft(next);
              setSettings((current) => ({ ...current, reportCurrency: next.length === 3 ? next : null }));
            }}
          />
        </div>
      </section>

      <SubscriptionEditor
        settings={settings}
        onChange={setSettings}
      />
      <RateEditor settings={settings} onChange={setSettings} />

      <section className="surface-solid min-w-0 rounded-xl border p-4" aria-labelledby="estimates-whatif-heading">
        <h3 id="estimates-whatif-heading" className="text-sm font-medium"><I18nText id="estimates.what_if" /></h3>
        <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.these_changes_are_compared_and_not_saved" /></p>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="text-xs text-muted-foreground"><I18nText id="estimates.parallelism_for_this_comparison" />{" "}<select
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              data-testid="estimates-whatif-parallelism"
              value={whatIf.parallelism}
              onChange={(event) => setWhatIf((current) => ({ ...current, parallelism: event.target.value as WhatIfState["parallelism"] }))}
            >
              <option value="unchanged"><I18nText id="estimates.no_change" /></option>
              <option value="unset"><I18nText id="estimates.not_provided" /></option>
              <option value="unbounded"><I18nText id="estimates.unbounded_an_explicit_claim" /></option>
              <option value="number"><I18nText id="estimates.a_specific_cap" /></option>
            </select>
          </label>
          {whatIf.parallelism === "number" && (
            <label className="text-xs text-muted-foreground"><I18nText id="estimates.cap" />{" "}<Input className="mt-1" inputMode="numeric" aria-label={tr("estimates.what_if_concurrency_cap")} data-testid="estimates-whatif-cap" value={whatIf.parallelismCount} onChange={(event) => setWhatIf((current) => ({ ...current, parallelismCount: event.target.value }))} />
            </label>
          )}
          <label className="text-xs text-muted-foreground"><I18nText id="estimates.spending_limit_for_this_comparison" />{" "}<select
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={whatIf.budget}
              data-testid="estimates-whatif-budget"
              onChange={(event) => setWhatIf((current) => ({ ...current, budget: event.target.value as WhatIfState["budget"] }))}
            >
              <option value="unchanged"><I18nText id="estimates.no_change" /></option>
              <option value="clear"><I18nText id="estimates.clear_the_limit" /></option>
              <option value="amount"><I18nText id="estimates.set_a_limit" /></option>
            </select>
          </label>
          {whatIf.budget === "amount" && (
            <label className="text-xs text-muted-foreground"><I18nText id="estimates.limit_in" />{" "}{settings.reportCurrency ?? tr("common.the_report_currency")}
              <Input className="mt-1" inputMode="decimal" value={whatIf.budgetAmount} onChange={(event) => setWhatIf((current) => ({ ...current, budgetAmount: event.target.value }))} />
            </label>
          )}
          <label className="text-xs text-muted-foreground"><I18nText id="estimates.task_whose_model_or_duration_changes" />{" "}<select
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={whatIf.itemId}
              data-testid="estimates-whatif-task"
              onChange={(event) => setWhatIf((current) => ({ ...current, itemId: event.target.value }))}
            >
              <option value=""><I18nText id="estimates.no_task" /></option>
              {visible.map((fact) => <option key={fact.id} value={fact.id}>{fact.title}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground"><I18nText id="estimates.other_model_id" />{" "}<Input className="mt-1" value={whatIf.modelId} data-testid="estimates-whatif-model" onChange={(event) => setWhatIf((current) => ({ ...current, modelId: event.target.value }))} />
          </label>
          <DurationTrio
            optimistic={whatIf.optimistic}
            expected={whatIf.expected}
            conservative={whatIf.conservative}
            onChange={(next) => setWhatIf((current) => ({ ...current, ...next }))}
          />
        </div>
        <ul className="mt-3 flex flex-col gap-1">
          {visible.map((fact) => (
            <li key={fact.id}>
              <label className="flex min-w-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={whatIf.exclude.includes(fact.id)}
                  onChange={(event) => setWhatIf((current) => ({
                    ...current,
                    exclude: event.target.checked ? [...current.exclude, fact.id] : current.exclude.filter((id) => id !== fact.id),
                  }))}
                />
                <span className="truncate"><I18nText id="estimates.leave" />{" "}{fact.title}{" "}<I18nText id="estimates.out_of_this_comparison" /></span>
              </label>
            </li>
          ))}
        </ul>
        {patch.ok === false && <p className="mt-3 text-xs text-warning">{patch.error}</p>}
        {comparison && (
          <div className="mt-3 overflow-x-auto overflow-y-hidden" data-testid="estimates-whatif-delta">
            {comparison.caveat && <p className="mb-2 break-words text-xs text-muted-foreground">{comparison.caveat}</p>}
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="text-[length:var(--text-caption)] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium"><I18nText id="estimates.scenario" /></th>
                  <th className="py-1 pr-3 font-medium"><I18nText id="common.agent" /></th>
                  <th className="py-1 pr-3 font-medium"><I18nText id="common.calendar" /></th>
                  <th className="py-1 font-medium"><I18nText id="common.additional_cash" /></th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row) => (
                  <tr key={row.scenario} data-testid={`estimates-whatif-${row.scenario}`}>
                    <td className="py-1 pr-3 capitalize">{row.scenario}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.agentBase} → {row.agentNext}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.calendarBase} → {row.calendarNext}</td>
                    <td className="py-1 tabular-nums">{row.cashBase} → {row.cashNext}{row.cashDelta ? ` (${row.cashDelta})` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" data-testid="estimates-save" disabled={!loaded || saving || !result.ok} onClick={() => void save()}>
          {saving ? tr("common.saving") : tr("common.save_inputs")}
        </Button>
        {savedAt != null && <p className="text-xs text-muted-foreground" data-testid="estimates-saved"><I18nText id="estimates.saved_inputs_for_this_project" /></p>}
        {saveError && <p className="text-xs text-warning">{saveError}</p>}
      </div>
    </div>
  );
}

function emptyWhatIf(): WhatIfState {
  return {
    exclude: [],
    parallelism: "unchanged",
    parallelismCount: "",
    budget: "unchanged",
    budgetAmount: "",
    itemId: "",
    modelId: "",
    optimistic: "",
    expected: "",
    conservative: "",
  };
}

function sameEdges(a: readonly StructuredDependency[], b: readonly StructuredDependency[]): boolean {
  return a.length === b.length && a.every((edge, i) => edge.taskId === b[i]!.taskId && edge.dependsOn === b[i]!.dependsOn);
}

function toFact(task: Task, observations: ObservedDuration[]): ProjectTaskFact {
  return {
    id: task.id,
    title: task.title,
    column: task.column,
    taskType: task.taskType,
    harnessId: task.agent.trim() ? task.agent : null,
    modelId: task.model?.trim() ? task.model : null,
    updatedAt: task.updatedAt,
    archived: task.archivedAt != null,
    pipelineParentId: task.pipelineParentId ?? null,
    description: task.prompt,
    observedRuns: observations.filter((run) => run.taskId === task.id).map((run) => ({
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      agentMs: run.agentMs,
      status: run.status,
    })),
  };
}

function toggleSelected(setSettings: (fn: (current: EstimationSettings) => EstimationSettings) => void, id: string, checked: boolean) {
  setSettings((current) => {
    if (current.scope.kind !== "selected") return current;
    const itemIds = checked ? [...current.scope.itemIds, id] : current.scope.itemIds.filter((item) => item !== id);
    return { ...current, scope: { kind: "selected", itemIds } };
  });
}

function buildWhatIfPatch(
  draft: WhatIfState,
  request: ReturnType<typeof adaptProject>["request"],
  settings: EstimationSettings,
): { ok: true; patch: WhatIfPatch | null; parallelismChanged: boolean } | { ok: false; error: string } {
  const patch: WhatIfPatch = {};
  let parallelismChanged = false;
  if (draft.exclude.length > 0) patch.dropItemIds = [...draft.exclude];
  if (draft.parallelism === "unset") {
    patch.parallelism = { maxConcurrentItems: null };
    parallelismChanged = true;
  } else if (draft.parallelism === "unbounded") {
    patch.parallelism = { maxConcurrentItems: "unbounded" };
    parallelismChanged = true;
  } else if (draft.parallelism === "number") {
    const count = Number(draft.parallelismCount);
    if (!Number.isSafeInteger(count) || count < 1) return { ok: false, error: tr("common.the_comparison_cap_must_be_a_positive_whole") };
    patch.parallelism = { maxConcurrentItems: count };
    parallelismChanged = true;
  }
  if (draft.budget === "clear") patch.budget = { ...request.budget, maxAdditionalSpend: null };
  if (draft.budget === "amount") {
    if (!settings.reportCurrency) return { ok: false, error: tr("common.set_a_report_currency_before_comparing_a_spending") };
    const minor = majorToMinor(settings.reportCurrency, draft.budgetAmount);
    if (minor == null) return { ok: false, error: tr("common.the_comparison_limit_is_not_a_valid_amount") };
    patch.budget = { ...request.budget, maxAdditionalSpend: { currency: settings.reportCurrency, minor } };
  }
  const item = draft.itemId ? request.items.find((row) => row.id === draft.itemId) : undefined;
  const stageId = item?.stages[0]?.id;
  if (draft.modelId.trim()) {
    if (!item || !stageId) return { ok: false, error: tr("common.choose_a_task_before_changing_its_model") };
    patch.stageAssignments = [{ itemId: item.id, stageId, modelId: draft.modelId.trim() }];
  }
  const duration = rangeFromMinutes(draft.optimistic, draft.expected, draft.conservative);
  if (!duration.ok) return { ok: false, error: tr("common.the_comparison_duration_must_rise_from_optimistic_to") };
  if (duration.value) {
    if (!item || !stageId) return { ok: false, error: tr("common.choose_a_task_before_changing_its_duration") };
    patch.stageEfforts = [{ itemId: item.id, stageId, effort: { ...duration.value, origin: "user-provided" } }];
  }
  const changed = Boolean(patch.dropItemIds || patch.parallelism || patch.budget || patch.stageAssignments || patch.stageEfforts);
  return { ok: true, patch: changed ? patch : null, parallelismChanged };
}

function FigureCard({ title, testId, figure }: { title: string; testId: string; figure: DisplayFigure }) {
  useUILocale();
  return (
    <section className="surface-solid min-w-0 rounded-xl border p-3" data-testid={testId} data-tone={figure.tone}>
      <h3 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <p className="mt-1 break-words text-lg font-semibold tabular-nums" data-testid={`${testId}-value`}>{figure.headline}</p>
      {figure.detail && (
        <p className={cn("mt-1 break-words text-xs text-muted-foreground", figure.tone === "policy" && "text-warning")} data-testid={figure.tone === "policy" ? "estimates-policy-note" : undefined}>
          {figure.detail}
        </p>
      )}
    </section>
  );
}

function ScenarioCard({ scenario, forecast }: { scenario: ScenarioId; forecast: NonNullable<ReturnType<typeof estimate>["scenarios"]>[ScenarioId] }) {
  useUILocale();
  const agent = formatDurationForecast(forecast.agent);
  const calendar = formatCalendar(forecast.calendar);
  const cash = formatCash(forecast.additionalCash);
  return (
    <section className="surface-solid min-w-0 rounded-xl border p-3" data-testid={`estimates-scenario-${scenario}`}>
      <h3 className="text-sm font-medium capitalize">{scenario}</h3>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground"><I18nText id="common.agent" /></dt><dd className="tabular-nums">{agent.headline}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground"><I18nText id="common.calendar" /></dt><dd className="tabular-nums">{calendar.headline}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground"><I18nText id="common.additional_cash" /></dt><dd className="break-all text-right tabular-nums">{cash.headline}</dd></div>
      </dl>
    </section>
  );
}

function ScenarioChart({ scenarios }: { scenarios: NonNullable<ReturnType<typeof estimate>["scenarios"]> }) {
  useUILocale();
  const rows = (["optimistic", "expected", "conservative"] as const).map((scenario) => {
    const agent = scenarios[scenario].agent;
    return { scenario, ms: agent.status === "known" || agent.status === "estimated" ? agent.ms : null };
  });
  const known = rows.flatMap((row) => (row.ms == null ? [] : [row.ms]));
  if (known.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid="estimates-chart"><I18nText id="estimates.no_chart_agent_time_is_unknown_so_nothing" /></p>;
  }
  const max = Math.max(...known);
  return (
    <div className="surface-solid rounded-xl border p-3" data-testid="estimates-chart">
      <h3 className="text-xs font-medium text-muted-foreground"><I18nText id="estimates.agent_time_by_scenario" /></h3>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.scenario} className="grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <span className="truncate capitalize">{row.scenario}</span>
            {row.ms == null ? (
              <span className="text-muted-foreground"><I18nText id="common.unknown" /></span>
            ) : (
              <span className="h-2 rounded-full bg-foreground/70 motion-reduce:transition-none" style={{ width: `${max === 0 ? 0 : Math.max(4, (row.ms / max) * 100)}%` }} />
            )}
            <span className="tabular-nums">{row.ms == null ? tr("common.unknown") : formatDurationMs(row.ms)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TextList({ title, testId, rows, empty }: { title: string; testId: string; rows: string[]; empty: string }) {
  useUILocale();
  return (
    <section className="surface-solid min-w-0 rounded-xl border p-4" data-testid={testId}>
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{empty}</p> : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((row, index) => <li key={`${index}-${row.slice(0, 24)}`} className="break-words text-xs text-muted-foreground">{row}</li>)}
        </ul>
      )}
    </section>
  );
}

function Notice({ children, testId, tone }: { children: React.ReactNode; testId: string; tone: "warning" }) {
  useUILocale();
  return <p className={cn("break-words rounded-lg border px-3 py-2 text-xs", tone === "warning" && "text-warning")} data-testid={testId}>{children}</p>;
}

function ScopeChoice({ name, testId, checked, label, onChange }: { name: string; testId: string; checked: boolean; label: string; onChange: () => void }) {
  useUILocale();
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" name="estimates-scope" value={name} checked={checked} data-testid={testId} onChange={onChange} />
      {label}
    </label>
  );
}

function BudgetChoice({ mode, current, label, onChange }: { mode: EstimationSettings["budgetMode"]; current: EstimationSettings["budgetMode"]; label: string; onChange: (mode: EstimationSettings["budgetMode"]) => void }) {
  useUILocale();
  return (
    <label className="flex items-start gap-2">
      <input type="radio" name="estimates-budget" checked={current === mode} data-testid={`estimates-budget-${mode}`} onChange={() => onChange(mode)} />
      <span>{label}</span>
    </label>
  );
}

function ConcurrencyControl({ value, onChange }: { value: number | "unbounded" | null; onChange: (value: number | "unbounded" | null) => void }) {
  useUILocale();
  const mode = value == null ? "unset" : value === "unbounded" ? "unbounded" : "number";
  return (
    <div className="mt-3 flex flex-col gap-2">
      <select
        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
        data-testid="estimates-parallelism-mode"
        value={mode}
        aria-label={tr("estimates.parallelism")}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "unset") onChange(null);
          else if (next === "unbounded") onChange("unbounded");
          else onChange(1);
        }}
      >
        <option value="unset"><I18nText id="common.not_set" /></option>
        <option value="unbounded"><I18nText id="estimates.unbounded_an_explicit_claim" /></option>
        <option value="number"><I18nText id="estimates.a_specific_cap" /></option>
      </select>
      {mode === "number" && (
        <Input
          inputMode="numeric"
          aria-label={tr("estimates.parallel_task_cap")}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const count = Number(event.target.value);
            if (Number.isSafeInteger(count) && count >= 1) onChange(count);
          }}
        />
      )}
    </div>
  );
}

function MoneyField({ label, testId, currency, money, onChange }: { label: string; testId: string; currency: string | null; money: { currency: string; minor: number } | null; onChange: (money: { currency: string; minor: number } | null) => void }) {
  useUILocale();
  const [draft, setDraft] = useState(money && currency && money.currency === currency ? minorToMajorInput(money) : "");
  useEffect(() => {
    setDraft(money && currency && money.currency === currency ? minorToMajorInput(money) : "");
  }, [money, currency]);
  return (
    <label className="mt-3 block text-xs text-muted-foreground">
      {label}{currency ? ` (${currency})` : tr("common.choose_a_report_currency_first")}
      <Input
        className="mt-1"
        inputMode="decimal"
        data-testid={testId}
        disabled={!currency || currencyFractionDigits(currency) == null}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!currency) return;
          if (!draft.trim()) {
            onChange(null);
            return;
          }
          const minor = majorToMinor(currency, draft);
          if (minor == null) return;
          onChange({ currency, minor });
        }}
      />
    </label>
  );
}

function DurationTrio({ optimistic, expected, conservative, onChange }: { optimistic: string; expected: string; conservative: string; onChange: (next: { optimistic: string; expected: string; conservative: string }) => void }) {
  useUILocale();
  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
      <legend className="col-span-3 text-xs text-muted-foreground"><I18nText id="estimates.duration_minutes_for_the_comparison_leave_blank_for" /></legend>
      <Input aria-label={tr("estimates.comparison_optimistic_minutes")} inputMode="numeric" data-testid="estimates-whatif-optimistic" value={optimistic} onChange={(event) => onChange({ optimistic: event.target.value, expected, conservative })} />
      <Input aria-label={tr("estimates.comparison_expected_minutes")} inputMode="numeric" value={expected} onChange={(event) => onChange({ optimistic, expected: event.target.value, conservative })} />
      <Input aria-label={tr("estimates.comparison_conservative_minutes")} inputMode="numeric" value={conservative} onChange={(event) => onChange({ optimistic, expected, conservative: event.target.value })} />
    </fieldset>
  );
}

function StageEditor({
  fact,
  others,
  stages,
  dependsOn,
  boardDependsOn,
  onClose,
  onSave,
}: {
  fact: ProjectTaskFact;
  others: ProjectTaskFact[];
  stages: ManualStage[];
  dependsOn: string[];
  /** Structured links, shown ticked and locked: they are edited on the board. */
  boardDependsOn: string[];
  onClose: () => void;
  onSave: (stages: ManualStage[], dependsOn: string[]) => void;
}) {
  useUILocale();
  const initial = stages[0] ?? blankStage(fact);
  const [draft, setDraft] = useState(stageToDraft(initial));
  const [deps, setDeps] = useState(dependsOn);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-3"
      data-testid="estimates-stage-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const built = draftToStage(draft);
        if (!built.ok) {
          setError(built.error);
          return;
        }
        onSave([built.stage], deps);
      }}
    >
      <p className="text-sm font-medium">{fact.title}</p>
      <p className="mt-1 break-words text-xs text-muted-foreground"><I18nText id="estimates.the_description_is_not_used_as_an_estimate" />{" "}</p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MinuteField label={tr("estimates.optimistic_minutes")} testId="estimates-duration-optimistic" value={draft.optimistic} onChange={(optimistic) => setDraft({ ...draft, optimistic })} />
        <MinuteField label={tr("estimates.expected_minutes")} testId="estimates-duration-expected" value={draft.expected} onChange={(expected) => setDraft({ ...draft, expected })} />
        <MinuteField label={tr("estimates.conservative_minutes")} testId="estimates-duration-conservative" value={draft.conservative} onChange={(conservative) => setDraft({ ...draft, conservative })} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MinuteField label={tr("estimates.optimistic_repetitions")} testId="estimates-repetitions-optimistic" value={draft.repOptimistic} onChange={(repOptimistic) => setDraft({ ...draft, repOptimistic })} />
        <MinuteField label={tr("estimates.expected_repetitions")} testId="estimates-repetitions-expected" value={draft.repExpected} onChange={(repExpected) => setDraft({ ...draft, repExpected })} />
        <MinuteField label={tr("estimates.conservative_repetitions")} testId="estimates-repetitions-conservative" value={draft.repConservative} onChange={(repConservative) => setDraft({ ...draft, repConservative })} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.blank_repetitions_are_not_a_measurement_the_forecast" /></p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground"><I18nText id="common.harness" />{" "}<Input className="mt-1" value={draft.harnessFromTask ? (fact.harnessId ?? "") : draft.harnessId} disabled={draft.harnessFromTask} onChange={(event) => setDraft({ ...draft, harnessFromTask: false, harnessId: event.target.value })} />
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input type="checkbox" checked={draft.harnessFromTask} onChange={(event) => setDraft({ ...draft, harnessFromTask: event.target.checked })} /><I18nText id="estimates.use_the_task_harness" />{" "}</label>
        <label className="text-xs text-muted-foreground"><I18nText id="common.model" />{" "}<Input className="mt-1" data-testid="estimates-model" value={draft.modelFromTask ? (fact.modelId ?? "") : draft.modelId} disabled={draft.modelFromTask} onChange={(event) => setDraft({ ...draft, modelFromTask: false, modelId: event.target.value })} />
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input type="checkbox" checked={draft.modelFromTask} onChange={(event) => setDraft({ ...draft, modelFromTask: event.target.checked })} /><I18nText id="estimates.use_the_task_model" />{" "}</label>
      </div>
      <label className="mt-3 block text-xs text-muted-foreground"><I18nText id="estimates.stage" />{" "}<select className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as StageKind })}>
          {STAGE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </label>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted-foreground"><I18nText id="estimates.confirmed_dependencies" /></legend>
        <ul className="mt-1 flex flex-col gap-1">
          {others.length === 0 && <li className="text-xs text-muted-foreground"><I18nText id="estimates.no_other_task_to_depend_on" /></li>}
          {others.map((other) => {
            const onBoard = boardDependsOn.includes(other.id);
            return (
              <li key={other.id}>
                <label className="flex items-center gap-2 text-sm" title={onBoard ? tr("common.set_on_the_board_change_it_in_the") : undefined}>
                  <input
                    type="checkbox"
                    data-testid="estimates-dependency-option"
                    data-board={onBoard ? "" : undefined}
                    checked={onBoard || deps.includes(other.id)}
                    disabled={onBoard}
                    onChange={(event) => setDeps((current) => event.target.checked ? [...current, other.id] : current.filter((id) => id !== other.id))}
                  />
                  <span className="truncate">{other.title}</span>
                  {onBoard && <span className="shrink-0 text-xs text-muted-foreground"><I18nText id="estimates.from_the_board" /></span>}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {error && <p className="mt-2 text-xs text-warning">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button type="submit" size="sm" data-testid="estimates-duration-apply"><I18nText id="common.apply" /></Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}><I18nText id="common.close" /></Button>
      </div>
    </form>
  );
}

function SubscriptionEditor({ settings, onChange }: { settings: EstimationSettings; onChange: (fn: (current: EstimationSettings) => EstimationSettings) => void }) {
  useUILocale();
  const [providerName, setProviderName] = useState("");
  const [capacityKind, setCapacityKind] = useState<Record<string, string>>({});
  return (
    <section className="surface-solid min-w-0 rounded-xl border p-4" data-testid="estimates-subscriptions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium"><I18nText id="common.subscriptions" /></h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground"><I18nText id="common.provider" />{" "}<Input className="mt-1" data-testid="estimates-subscription-provider" value={providerName} onChange={(event) => setProviderName(event.target.value)} />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="estimates-add-subscription"
            onClick={() => {
              const provider = providerName.trim();
              if (!provider) return;
              onChange((current) => ({ ...current, subscriptions: [...current.subscriptions, blankSubscription(provider)] }));
              setProviderName("");
            }}
          ><I18nText id="estimates.add_subscription" />{" "}</Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.fees_and_capacity_stay_empty_until_you_enter" /></p>
      <ul className="mt-3 flex flex-col gap-3">
        {settings.subscriptions.map((row) => (
          <li key={row.id} className="rounded-lg border p-3" data-testid="estimates-subscription-row">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground"><I18nText id="common.provider" />{" "}<Input className="mt-1" value={row.provider} onChange={(event) => {
                  const provider = event.target.value.trim();
                  if (provider) updateSubscription(onChange, row.id, { provider });
                }} />
              </label>
              <label className="text-xs text-muted-foreground"><I18nText id="estimates.plan_label" />{" "}<Input className="mt-1" value={row.planLabel ?? ""} onChange={(event) => updateSubscription(onChange, row.id, { planLabel: event.target.value.trim() || null })} />
              </label>
              <label className="text-xs text-muted-foreground"><I18nText id="estimates.commitment" />{" "}<select className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={row.commitment} onChange={(event) => updateSubscription(onChange, row.id, { commitment: event.target.value as ManualSubscription["commitment"] })}>
                  <option value="existing"><I18nText id="estimates.existing" /></option>
                  <option value="proposed"><I18nText id="common.proposed" /></option>
                </select>
              </label>
              <label className="text-xs text-muted-foreground"><I18nText id="estimates.billing_period" />{" "}<select className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={row.billingPeriod} onChange={(event) => updateSubscription(onChange, row.id, { billingPeriod: event.target.value as ManualSubscription["billingPeriod"] })}>
                  <option value="monthly"><I18nText id="estimates.monthly" /></option>
                  <option value="weekly"><I18nText id="estimates.weekly" /></option>
                  <option value="yearly"><I18nText id="estimates.yearly" /></option>
                  <option value="custom"><I18nText id="estimates.custom" /></option>
                  <option value="unknown"><I18nText id="common.unknown" /></option>
                </select>
              </label>
            </div>
            <MoneyField
              label={tr("estimates.recurring_fee")}
              testId="estimates-subscription-fee"
              currency={row.recurringFee?.currency ?? settings.reportCurrency}
              money={row.recurringFee}
              onChange={(recurringFee) => updateSubscription(onChange, row.id, { recurringFee })}
            />
            <label className="mt-3 block text-xs text-muted-foreground"><I18nText id="estimates.capacity_you_actually_know" />{" "}<select
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                data-testid="estimates-capacity-kind"
                value={capacityKind[row.id] ?? capacityKey(row.capacity)}
                onChange={(event) => {
                  const next = event.target.value;
                  setCapacityKind((current) => ({ ...current, [row.id]: next }));
                  if (next === "unknown") updateSubscription(onChange, row.id, { capacity: null });
                  else if (capacityKey(row.capacity) !== next) updateSubscription(onChange, row.id, { capacity: null });
                }}
              >
                <option value="unknown"><I18nText id="estimates.not_known" /></option>
                <option value="count-requests"><I18nText id="estimates.requests_remaining" /></option>
                <option value="count-tokens"><I18nText id="estimates.tokens_remaining" /></option>
                <option value="credits"><I18nText id="estimates.credits_remaining" /></option>
                <option value="percent-used"><I18nText id="estimates.percent_used_not_a_token_balance" /></option>
                <option value="opaque"><I18nText id="estimates.a_note_i_cannot_quantify" /></option>
              </select>
            </label>
            <CapacityFields
              key={capacityKind[row.id] ?? capacityKey(row.capacity)}
              kind={capacityKind[row.id] ?? capacityKey(row.capacity)}
              capacity={row.capacity}
              reportCurrency={settings.reportCurrency}
              onChange={(capacity) => updateSubscription(onChange, row.id, { capacity })}
            />
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="estimates-pin"
                checked={settings.pinnedSubscriptionId === row.id}
                data-testid="estimates-pin-subscription"
                onChange={() => onChange((current) => ({ ...current, pinnedSubscriptionId: row.id }))}
              /><I18nText id="estimates.these_tasks_would_run_on_this_subscription" />{" "}</label>
            <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => onChange((current) => ({
              ...current,
              subscriptions: current.subscriptions.filter((item) => item.id !== row.id),
              pinnedSubscriptionId: current.pinnedSubscriptionId === row.id ? null : current.pinnedSubscriptionId,
            }))}><I18nText id="common.remove" />{" "}</Button>
          </li>
        ))}
      </ul>
      {settings.pinnedSubscriptionId && (
        <label className="mt-3 block text-xs text-muted-foreground"><I18nText id="estimates.account_concurrency_blank_means_unknown" />{" "}<Input
            className="mt-1 max-w-[12rem]"
            data-testid="estimates-account-concurrency"
            value={settings.accountConcurrency == null ? "" : String(settings.accountConcurrency)}
            onChange={(event) => {
              const text = event.target.value.trim();
              if (!text) {
                onChange((current) => ({ ...current, accountConcurrency: null }));
                return;
              }
              if (text === "unbounded") {
                onChange((current) => ({ ...current, accountConcurrency: "unbounded" }));
                return;
              }
              const count = Number(text);
              if (Number.isSafeInteger(count) && count >= 1) onChange((current) => ({ ...current, accountConcurrency: count }));
            }}
          />
        </label>
      )}
    </section>
  );
}

function CapacityFields({ kind, capacity, reportCurrency, onChange }: { kind: string; capacity: ManualSubscription["capacity"]; reportCurrency: string | null; onChange: (capacity: ManualSubscription["capacity"]) => void }) {
  useUILocale();
  const [draft, setDraft] = useState("");
  if (kind === "unknown") return null;
  const label = kind === "count-requests" ? tr("common.remaining_requests") : kind === "count-tokens" ? tr("common.remaining_tokens") : kind === "credits" ? tr("common.remaining_credit_minor_units") : kind === "percent-used" ? tr("common.percent_used") : tr("common.what_you_know_without_a_number");
  return (
    <label className="mt-2 block text-xs text-muted-foreground">
      {label}<I18nText id="estimates.leaving_this_blank_does_not_mean_zero" />{" "}<Input
        className="mt-1"
        data-testid="estimates-capacity-amount"
        value={draft || shownCapacity(capacity)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const text = (draft || shownCapacity(capacity)).trim();
          setDraft("");
          if (!text) {
            onChange(null);
            return;
          }
          onChange(capacityFromText(kind, text, reportCurrency));
        }}
      />
    </label>
  );
}

function RateEditor({ settings, onChange }: { settings: EstimationSettings; onChange: (fn: (current: EstimationSettings) => EstimationSettings) => void }) {
  useUILocale();
  const requested = settings.apiRates != null;
  const [modelId, setModelId] = useState("");
  const [rateCurrency, setRateCurrency] = useState(settings.reportCurrency ?? "");
  const [amount, setAmount] = useState("");
  return (
    <section className="surface-solid min-w-0 rounded-xl border p-4" data-testid="estimates-rates">
      <h3 className="text-sm font-medium"><I18nText id="estimates.api_tariffs_and_exchange_rates" /></h3>
      <p className="mt-1 text-xs text-muted-foreground"><I18nText id="estimates.entered_only_if_you_have_the_numbers_nothing" /></p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="estimates-api-request"
          checked={requested}
          onChange={(event) => onChange((current) => ({ ...current, apiRates: event.target.checked ? current.apiRates ?? [] : null }))}
        /><I18nText id="estimates.estimate_an_api_equivalent_cost" />{" "}</label>
      {requested && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Input aria-label={tr("estimates.tariff_model_id")} data-testid="estimates-rate-model" value={modelId} onChange={(event) => setModelId(event.target.value)} />
          <Input aria-label={tr("estimates.tariff_currency")} className="uppercase" maxLength={3} data-testid="estimates-rate-currency" value={rateCurrency} onChange={(event) => setRateCurrency(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))} />
          <Input aria-label={tr("estimates.tariff_amount_per_minute")} inputMode="decimal" data-testid="estimates-rate-amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <Button type="button" size="sm" variant="outline" data-testid="estimates-add-rate" onClick={() => {
            const minor = majorToMinor(rateCurrency, amount);
            const model = modelId.trim();
            if (!model || minor == null) return;
            onChange((current) => ({
              ...current,
              apiRates: [...(current.apiRates ?? []), { id: `rate-${crypto.randomUUID()}`, modelId: model, harnessId: null, perAgentMs: 60_000, money: { currency: rateCurrency, minor } }],
            }));
            setModelId("");
            setAmount("");
          }}><I18nText id="estimates.add_tariff" />{" "}</Button>
        </div>
      )}
      <ul className="mt-2 flex flex-col gap-2">
        {(settings.apiRates ?? []).map((rate) => (
          <li key={rate.id} className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="estimates-rate-row">
            <label className="text-xs text-muted-foreground"><I18nText id="estimates.model_id" />{" "}<Input className="mt-1" value={rate.modelId} onChange={(event) => updateRate(onChange, rate.id, { modelId: event.target.value })} />
            </label>
            <label className="text-xs text-muted-foreground"><I18nText id="common.currency" />{" "}<Input className="mt-1" value={rate.money.currency} maxLength={3} onChange={(event) => {
                const currency = event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                if (currency.length === 3) updateRate(onChange, rate.id, { money: { ...rate.money, currency } });
              }} />
            </label>
            <MoneyField
              label={tr("estimates.price_per_minute_of_agent_time")}
              testId={`estimates-rate-saved-${rate.id}`}
              currency={rate.money.currency}
              money={rate.money}
              onChange={(money) => { if (money) updateRate(onChange, rate.id, { money, perAgentMs: 60_000 }); }}
            />
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <h4 className="text-xs font-medium"><I18nText id="estimates.exchange_rate_into_the_report_currency" /></h4>
        <ExchangeRow settings={settings} onChange={onChange} />
      </div>
    </section>
  );
}

function ExchangeRow({ settings, onChange }: { settings: EstimationSettings; onChange: (fn: (current: EstimationSettings) => EstimationSettings) => void }) {
  useUILocale();
  const [from, setFrom] = useState("USD");
  const [rate, setRate] = useState("");
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="text-xs text-muted-foreground"><I18nText id="common.from" />{" "}<Input className="mt-1 w-24 uppercase" maxLength={3} value={from} data-testid="estimates-fx-from" onChange={(event) => setFrom(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))} />
      </label>
      <label className="text-xs text-muted-foreground"><I18nText id="estimates.minor_units_of" />{" "}{settings.reportCurrency ?? "report"}{" "}<I18nText id="estimates.per_1_minor" />{" "}<Input className="mt-1 w-32" inputMode="decimal" value={rate} data-testid="estimates-fx-rate" onChange={(event) => setRate(event.target.value)} />
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="estimates-fx-add"
        onClick={() => {
          const parsed = Number(rate);
          if (!settings.reportCurrency || from.length !== 3 || from === settings.reportCurrency || !Number.isFinite(parsed) || parsed <= 0) return;
          onChange((current) => ({
            ...current,
            exchangeRates: [...current.exchangeRates.filter((row) => row.from !== from || row.to !== current.reportCurrency), { from, to: settings.reportCurrency!, rate: parsed }],
          }));
        }}
      ><I18nText id="estimates.add_rate" />{" "}</Button>
      {settings.exchangeRates.length > 0 && (
        <ul className="w-full text-xs text-muted-foreground">
          {settings.exchangeRates.map((row) => <li key={`${row.from}-${row.to}`}>{row.from} → {row.to}{" "}<I18nText id="estimates.at" />{" "}{row.rate}<I18nText id="estimates.entered_by_you" /></li>)}
        </ul>
      )}
    </div>
  );
}

function MinuteField({ label, testId, value, onChange }: { label: string; testId: string; value: string; onChange: (value: string) => void }) {
  useUILocale();
  return (
    <label className="text-xs text-muted-foreground">
      {label}
      <Input className="mt-1" inputMode="numeric" data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

interface StageDraft {
  id: string;
  kind: StageKind;
  optimistic: string;
  expected: string;
  conservative: string;
  repOptimistic: string;
  repExpected: string;
  repConservative: string;
  harnessFromTask: boolean;
  harnessId: string;
  modelFromTask: boolean;
  modelId: string;
}

function blankStage(fact: ProjectTaskFact): ManualStage {
  return {
    id: "implementation",
    kind: "implementation",
    effort: null,
    repetitions: null,
    harnessFromTask: true,
    harnessId: fact.harnessId,
    modelFromTask: true,
    modelId: fact.modelId,
    consumption: null,
  };
}

function stageToDraft(stage: ManualStage): StageDraft {
  return {
    id: stage.id,
    kind: stage.kind,
    optimistic: stage.effort ? String(stage.effort.optimisticMs / 60_000) : "",
    expected: stage.effort ? String(stage.effort.expectedMs / 60_000) : "",
    conservative: stage.effort ? String(stage.effort.conservativeMs / 60_000) : "",
    repOptimistic: stage.repetitions ? String(stage.repetitions.optimistic) : "",
    repExpected: stage.repetitions ? String(stage.repetitions.expected) : "",
    repConservative: stage.repetitions ? String(stage.repetitions.conservative) : "",
    harnessFromTask: stage.harnessFromTask,
    harnessId: stage.harnessId ?? "",
    modelFromTask: stage.modelFromTask,
    modelId: stage.modelId ?? "",
  };
}

function draftToStage(draft: StageDraft): { ok: true; stage: ManualStage } | { ok: false; error: string } {
  const effort = rangeFromMinutes(draft.optimistic, draft.expected, draft.conservative);
  if (!effort.ok) return { ok: false, error: tr("common.duration_must_be_whole_minutes_rising_from_optimistic") };
  const repetitions = countFrom(draft.repOptimistic, draft.repExpected, draft.repConservative);
  if (!repetitions.ok) return { ok: false, error: tr("common.repetitions_must_be_whole_numbers_rising_from_optimistic") };
  return {
    ok: true,
    stage: {
      id: draft.id,
      kind: draft.kind,
      effort: effort.value,
      repetitions: repetitions.value,
      harnessFromTask: draft.harnessFromTask,
      harnessId: draft.harnessFromTask ? null : draft.harnessId.trim() || null,
      modelFromTask: draft.modelFromTask,
      modelId: draft.modelFromTask ? null : draft.modelId.trim() || null,
      consumption: null,
    },
  };
}

function rangeFromMinutes(optimistic: string, expected: string, conservative: string): { ok: true; value: { optimisticMs: number; expectedMs: number; conservativeMs: number } | null } | { ok: false } {
  const values = [wholeMinutes(optimistic), wholeMinutes(expected), wholeMinutes(conservative)];
  if (values.some((value) => !value.ok)) return { ok: false };
  const parsed = values.map((value) => (value.ok ? value.ms : null));
  if (parsed.every((value) => value == null)) return { ok: true, value: null };
  const optimisticMs = parsed[0];
  const expectedMs = parsed[1];
  const conservativeMs = parsed[2];
  if (optimisticMs == null || expectedMs == null || conservativeMs == null) return { ok: false };
  if (optimisticMs > expectedMs || expectedMs > conservativeMs) return { ok: false };
  return { ok: true, value: { optimisticMs, expectedMs, conservativeMs } };
}

function countFrom(optimistic: string, expected: string, conservative: string): { ok: true; value: { optimistic: number; expected: number; conservative: number } | null } | { ok: false } {
  const values = [wholeCount(optimistic), wholeCount(expected), wholeCount(conservative)];
  if (values.some((value) => value === "bad")) return { ok: false };
  if (values.every((value) => value == null)) return { ok: true, value: null };
  const left = values[0];
  const middle = values[1];
  const right = values[2];
  if (typeof left !== "number" || typeof middle !== "number" || typeof right !== "number") return { ok: false };
  if (left > middle || middle > right) return { ok: false };
  return { ok: true, value: { optimistic: left, expected: middle, conservative: right } };
}

function wholeMinutes(text: string): { ok: true; ms: number | null } | { ok: false } {
  const count = wholeCount(text);
  if (count === "bad") return { ok: false };
  if (count == null) return { ok: true, ms: null };
  const ms = count * 60_000;
  return Number.isSafeInteger(ms) ? { ok: true, ms } : { ok: false };
}

function wholeCount(text: string): number | null | "bad" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return "bad";
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : "bad";
}

function blankSubscription(provider: string): ManualSubscription {
  return {
    id: `sub-${crypto.randomUUID()}`,
    provider,
    commitment: "existing",
    planLabel: null,
    recurringFee: null,
    purchasePrice: null,
    billingPeriod: "unknown",
    capacity: null,
    overageEnabled: false,
    overagePrices: null,
  };
}

function capacityKey(capacity: ManualSubscription["capacity"]): string {
  if (!capacity) return "unknown";
  if (capacity.kind === "count") return capacity.unit === "requests" ? "count-requests" : "count-tokens";
  return capacity.kind;
}

function shownCapacity(capacity: ManualSubscription["capacity"]): string {
  if (!capacity) return "";
  if (capacity.kind === "count") return String(capacity.remaining);
  if (capacity.kind === "credits") return String(capacity.remainingMinor);
  if (capacity.kind === "percent-used") return String(capacity.usedPercent);
  return capacity.note;
}

function capacityFromText(kind: string, text: string, reportCurrency: string | null): ManualSubscription["capacity"] {
  if (kind === "opaque") {
    const note = text.trim();
    return note ? { kind: "opaque", label: tr("common.unquantified"), note } : null;
  }
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (kind === "percent-used") return amount <= 100 ? { kind: "percent-used", usedPercent: amount } : null;
  if (!Number.isSafeInteger(amount)) return null;
  if (kind === "count-requests") return { kind: "count", unit: "requests", remaining: amount, limit: null };
  if (kind === "count-tokens") return { kind: "count", unit: "tokens", remaining: amount, limit: null };
  if (kind === "credits" && reportCurrency) return { kind: "credits", remainingMinor: amount, currency: reportCurrency, limitMinor: null };
  return null;
}

function DecimalCommit({ label, testId, value, onCommit }: { label: string; testId: string; value: number | null; onCommit: (value: number | null) => void }) {
  useUILocale();
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  return (
    <label className="mt-3 block text-xs text-muted-foreground">
      {label}
      <Input
        className="mt-1"
        inputMode="decimal"
        data-testid={testId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!draft.trim()) {
            onCommit(null);
            return;
          }
          const parsed = Number(draft);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
      />
    </label>
  );
}

function updateSubscription(onChange: (fn: (current: EstimationSettings) => EstimationSettings) => void, id: string, patch: Partial<ManualSubscription>) {
  onChange((current) => ({
    ...current,
    subscriptions: current.subscriptions.map((row) => row.id === id ? { ...row, ...patch } : row),
  }));
}

function updateRate(onChange: (fn: (current: EstimationSettings) => EstimationSettings) => void, id: string, patch: Partial<NonNullable<EstimationSettings["apiRates"]>[number]>) {
  onChange((current) => ({
    ...current,
    apiRates: (current.apiRates ?? []).map((row) => row.id === id ? { ...row, ...patch } : row),
  }));
}
