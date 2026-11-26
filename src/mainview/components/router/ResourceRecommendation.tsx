import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CandidateGroupsView } from "./CandidateCards";
import { createPreviewSession } from "@/lib/model-router-api";
import {
  COMPLEXITIES,
  EMPTY_PREVIEW_DRAFT,
  POLICY_COPY,
  PREVIEW_BANNER,
  PRIORITY_CHOICES,
  SPENDING_CHOICES,
  TASK_TYPES,
  buildTaskPreviewBody,
  type TaskPreviewRequest,
  complexityLabel,
  effortPresentation,
  ownerRows,
  planningEstimateNote,
  policies,
  presentAssignment,
  previewBoundary,
  requirementRows,
  PreviewDraftError,
  type EmployeeRecommendation,
  type PreviewDraft,
} from "@/lib/model-router-preview";
import type { RoutingPreview } from "../../../shared/model-router/types.ts";
import type { Harness } from "../../../shared/types.ts";
import { RouterResourceContextPanel } from "./RouterResourceContextPanel";
import type { ModelRouterResourceContext } from "../../../shared/model-router/resource-context.ts";
import type { EstimationResult } from "../../../shared/estimation/types.ts";
import type { Task } from "../../../shared/types.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof PreviewDraftError || reason instanceof ApiError || reason instanceof Error) return reason.message;
  return tr("common.the_preview_could_not_be_calculated");
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  useUILocale();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Read-only model-router preview for one task. The form is calculation
 * input only: it is not written onto the task, and Find does not start an
 * agent or switch an account.
 */
export function ResourceRecommendation({ task, harnesses }: { task: Task; harnesses: readonly Harness[] }) {
  useUILocale();
  const ids = useId();
  const session = useRef(createPreviewSession());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PreviewDraft>(EMPTY_PREVIEW_DRAFT);
  const [accounts, setAccounts] = useState<{ id: string; displayName: string }[] | null>(null);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [employee, setEmployee] = useState<EmployeeRecommendation>({ status: "loading", note: tr("common.loading_assignment") });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ preview: RoutingPreview; planningEstimate: EstimationResult | null } | null>(null);
  const [resourceContext, setResourceContext] = useState<ModelRouterResourceContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  const projectPath = task.ownerProjectPath ?? null;
  const blocked = task.pipelineParentId != null || task.archivedAt != null || !projectPath;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContextLoading(true);
    setContextError(null);
    void api.modelRouter.resourceContext().then((body) => {
      if (!cancelled) {
        setResourceContext(body);
        setContextLoading(false);
      }
    }).catch((caught: unknown) => {
      if (!cancelled) {
        setResourceContext(null);
        setContextLoading(false);
        setContextError(messageOf(caught));
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Use the panel's registry snapshot: GET /harnesses performs legacy CLI probes.
    void api.accountCore.accounts().then((rows) => {
      if (!cancelled) setAccounts(rows.map((account) => ({ id: account.id, displayName: account.displayName })));
    }).catch(() => {
      if (!cancelled) {
        setAccounts(null);
        setCatalogNote((current) => current ?? tr("common.account_list_could_not_be_loaded_account_names"));
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEmployee({ status: "loading", note: tr("common.loading_assignment") });
    void api.getTaskAssignment(task.id).then(async (body) => {
      if (cancelled) return;
      if (!body.assignment) {
        setEmployee(presentAssignment(null, null));
        return;
      }
      const assignment = { employeeName: body.assignment.employeeName, revision: body.assignment.revision };
      try {
        const person = await api.getEmployee(body.assignment.employeeId);
        if (cancelled) return;
        setEmployee(presentAssignment(assignment, person));
      } catch {
        if (!cancelled) setEmployee(presentAssignment(assignment, "error"));
      }
    }).catch(() => {
      if (!cancelled) setEmployee(presentAssignment("error", null));
    });
    return () => { cancelled = true; };
  }, [open, task.id]);

  useEffect(() => {
    const current = session.current;
    setResult(null);
    setLoading(false);
    return () => current.invalidate();
  }, [task.id, projectPath, task.pipelineParentId, task.archivedAt]);

  const invalidate = () => {
    session.current.invalidate();
    setLoading(false);
    setResult(null);
    setError(null);
  };
  const patch = (partial: Partial<PreviewDraft>) => {
    invalidate();
    setDraft((current) => ({ ...current, ...partial }));
  };

  const calculate = () => {
    if (blocked || !projectPath) return;
    const run = session.current.begin();
    setLoading(true);
    setResult(null);
    setError(null);
    let body: TaskPreviewRequest;
    try {
      body = buildTaskPreviewBody(projectPath, task.id, draft, { projectPaths: [projectPath] }, {
        harnessIds: harnesses.map((harness) => harness.id),
        accountIds: accounts?.map((account) => account.id) ?? [],
      });
    } catch (caught) {
      setLoading(false);
      setError(messageOf(caught));
      return;
    }
    void api.modelRouter.preview(body, run.signal).then((response) => {
      if (!run.isCurrent()) return;
      if (response.preview.requirements.taskId !== task.id || response.preview.requirements.projectId !== projectPath) {
        throw new Error(tr("common.the_preview_does_not_match_the_selected_task"));
      }
      setResult({ preview: response.preview, planningEstimate: response.planningEstimate });
      setLoading(false);
    }).catch((caught: unknown) => {
      if (!run.isCurrent()) return;
      setResult(null);
      setError(messageOf(caught));
      setLoading(false);
    });
  };

  const boundary = result ? previewBoundary(result.preview) : null;
  const estimate = result ? planningEstimateNote(result.planningEstimate) : null;
  const policyCopy = POLICY_COPY[draft.policy];

  return (
    <details
      className="surface-solid mx-3 my-2 rounded-lg border px-3 py-2 text-xs"
      data-testid="ai-resource-recommendation"
      onToggle={(event) => {
        const expanded = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(expanded);
        if (!expanded) invalidate();
      }}
    >
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.ai_resource_recommendation" /></summary>
      <div className="mt-2 flex min-w-0 flex-col gap-3" data-testid="router-preview-scroll">
        <p className="rounded-md border border-border/70 px-2 py-1.5 text-[11px]" data-testid="router-preview-banner">{staticLabel(PREVIEW_BANNER)}</p>
        <RouterResourceContextPanel context={resourceContext} loading={contextLoading} error={contextError} />
        <p className="text-[11px] text-muted-foreground"><I18nText id="resources.a_registered_account_or_a_declared_subscription_is" /></p>

        <section data-testid="router-employee" className="rounded-md border border-border/70 px-2 py-1.5 text-[11px]">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.assigned_employee" /></h3>
          {employee.status === "loading" && <p><I18nText id="common.loading_assignment" /></p>}
          {employee.status === "unknown" && <p>{employee.note}</p>}
          {employee.status === "unassigned" && <p>{employee.note}</p>}
          {employee.status === "assigned" && (
            <dl className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground"><I18nText id="resources.employee" /></dt><dd className="break-words">{employee.name}</dd>
              <dt className="text-muted-foreground"><I18nText id="common.role" /></dt><dd className="break-words">{employee.role}</dd>
              <dt className="text-muted-foreground"><I18nText id="resources.employee_project" /></dt><dd className="break-words">{employee.project}</dd>
              <dt className="text-muted-foreground"><I18nText id="common.assignment_revision" /></dt><dd>{employee.revision}</dd>
            </dl>
          )}
          {employee.status === "assigned" && <p className="mt-1 text-muted-foreground">{employee.note}</p>}
        </section>

        {task.pipelineParentId != null && <p><I18nText id="resources.pipeline_steps_are_not_routed_on_their_own" /></p>}
        {task.archivedAt != null && <p><I18nText id="resources.archived_tasks_are_not_included_in_a_routing" /></p>}
        {task.pipelineParentId == null && task.archivedAt == null && !projectPath && (
          <p data-testid="router-project-unknown"><I18nText id="resources.project_unknown_this_task_is_not_in_a" /></p>
        )}

        {!blocked && (
          <>
            <details open className="rounded-md border border-border/70 px-2 py-1.5" data-testid="router-requirements">
              <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.task_requirements" /></summary>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <p className="text-[11px] md:col-span-2"><I18nText id="common.task_id" />{" "}<span className="break-all font-mono">{task.id}</span></p>
                <p className="break-all text-[11px] md:col-span-2"><I18nText id="common.project_985959" />{" "}<span className="font-mono">{projectPath}</span></p>
                <p className="text-[11px] text-muted-foreground md:col-span-2"><I18nText id="resources.the_task_title_is_not_used_unspecified_complexity" /></p>
                <Field label={tr("common.task_type")}>
                  <Select id={`${ids}-type`} className="h-8 text-xs" data-testid="router-type" value={draft.type} onChange={(event) => patch({ type: event.target.value as PreviewDraft["type"] })}>
                    {TASK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </Select>
                </Field>
                <Field label={tr("common.complexity")}>
                  <Select id={`${ids}-complexity`} className="h-8 text-xs" data-testid="router-complexity" value={draft.complexity} onChange={(event) => patch({ complexity: event.target.value as PreviewDraft["complexity"] })}>
                    {COMPLEXITIES.map((complexity) => <option key={complexity} value={complexity}>{complexityLabel(complexity)}</option>)}
                  </Select>
                </Field>
                <Field label={tr("common.required_capabilities")}>
                  <Input className="h-8 text-xs" data-testid="router-capabilities" value={draft.capabilities} onChange={(event) => patch({ capabilities: event.target.value })} placeholder={tr("resources.comma_separated")} />
                </Field>
                <Field label={tr("common.required_tools")}>
                  <Input className="h-8 text-xs" data-testid="router-tools" value={draft.tools} onChange={(event) => patch({ tools: event.target.value })} placeholder={tr("resources.comma_separated")} />
                </Field>
                <Field label={tr("common.required_permissions")}>
                  <Input className="h-8 text-xs" data-testid="router-required-permissions" value={draft.requiredPermissions} onChange={(event) => patch({ requiredPermissions: event.target.value })} placeholder={tr("resources.comma_separated")} />
                </Field>
                <Field label={tr("common.context_tokens")}>
                  <Input className="h-8 text-xs" inputMode="numeric" data-testid="router-context-tokens" value={draft.contextTokens} onChange={(event) => patch({ contextTokens: event.target.value })} placeholder={tr("resources.unknown_if_empty")} />
                </Field>
                <fieldset className="min-w-0 space-y-2 md:col-span-2">
                  <legend className="text-[11px] text-muted-foreground"><I18nText id="common.quota_demands" /></legend>
                  <p className="text-[11px] text-muted-foreground"><I18nText id="resources.use_the_exact_quota_id_and_units_from" /></p>
                  {draft.quotaDemands.map((row, index) => (
                    <div key={index} className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_6rem_auto]">
                      <Field label={tr("common.quota_id", { p0: String(index + 1) })}>
                        <Input className="h-8 text-xs" data-testid="router-quota-id" value={row.quotaId} onChange={event => patch({ quotaDemands: draft.quotaDemands.map((item, i) => i === index ? { ...item, quotaId: event.target.value } : item) })} />
                      </Field>
                      <Field label={tr("common.amount", { p0: String(index + 1) })}>
                        <Input className="h-8 text-xs" inputMode="numeric" data-testid="router-quota-amount" value={row.amount} onChange={event => patch({ quotaDemands: draft.quotaDemands.map((item, i) => i === index ? { ...item, amount: event.target.value } : item) })} />
                      </Field>
                      <Button type="button" size="sm" className="self-end" aria-label={tr("common.remove_quota_demand", { p0: String(index + 1) })} onClick={() => patch({ quotaDemands: draft.quotaDemands.filter((_, i) => i !== index) })}><I18nText id="common.remove" /></Button>
                    </div>
                  ))}
                  <Button type="button" size="sm" data-testid="router-add-quota" disabled={draft.quotaDemands.length >= 64} onClick={() => patch({ quotaDemands: [...draft.quotaDemands, { quotaId: "", amount: "" }] })}><I18nText id="resources.add_quota_demand" /></Button>
                </fieldset>
                <label className="flex items-center gap-2 text-[11px] md:col-span-2">
                  <input type="checkbox" checked={draft.limitPermissions} onChange={(event) => patch({ limitPermissions: event.target.checked })} data-testid="router-limit-permissions" /><I18nText id="resources.limit_allowed_permissions_for_this_calculation" />{" "}</label>
                {draft.limitPermissions && (
                  <Field label={tr("common.allowed_permissions")}>
                    <Input className="h-8 text-xs" data-testid="router-allowed-permissions" value={draft.allowedPermissions} onChange={(event) => patch({ allowedPermissions: event.target.value })} />
                  </Field>
                )}
              </div>
            </details>

            <details open className="rounded-md border border-border/70 px-2 py-1.5">
              <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.routing_policy" /></summary>
              <div className="mt-2 flex min-w-0 flex-col gap-1">
                <Select id={`${ids}-policy`} className="h-8 text-xs" data-testid="router-policy" aria-label={tr("resources.routing_policy")} aria-describedby={`${ids}-policy-help`} value={draft.policy} onChange={(event) => patch({ policy: event.target.value as PreviewDraft["policy"] })}>
                  {policies().map((policy) => <option key={policy} value={policy}>{POLICY_COPY[policy].label}</option>)}
                </Select>
                <p id={`${ids}-policy-help`} className="text-[11px] text-muted-foreground" data-testid="router-policy-explanation">{policyCopy.explanation}</p>
              </div>
            </details>

            <details className="rounded-md border border-border/70 px-2 py-1.5" data-testid="router-owner-constraints">
              <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.owner_constraints" /></summary>
              <div className="mt-2 flex min-w-0 flex-col gap-2">
                <p className="text-[11px] text-muted-foreground"><I18nText id="resources.these_limits_apply_only_to_this_calculation_they" /></p>
                {catalogNote && <p className="text-[11px]">{catalogNote}</p>}
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" data-testid="router-limit-harnesses" checked={draft.limitHarnesses} onChange={(event) => patch({ limitHarnesses: event.target.checked, allowedHarnesses: event.target.checked ? draft.allowedHarnesses : [] })} /><I18nText id="resources.limit_harnesses" />{" "}</label>
                {draft.limitHarnesses && (
                  <ul className="flex flex-col gap-1" data-testid="router-allowed-harnesses">
                    {harnesses.map((harness) => (
                      <li key={harness.id}>
                        <label className="flex min-w-0 items-center gap-2 break-all text-[11px]">
                          <input
                            type="checkbox"
                            checked={draft.allowedHarnesses.includes(harness.id)}
                            data-testid={`router-harness-${harness.id}`}
                            onChange={(event) => patch({
                              allowedHarnesses: event.target.checked
                                ? [...draft.allowedHarnesses, harness.id]
                                : draft.allowedHarnesses.filter((id) => id !== harness.id),
                            })}
                          />
                          {harness.label} <span className="text-muted-foreground">{harness.id}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" data-testid="router-limit-accounts" checked={draft.limitAccounts} onChange={(event) => patch({ limitAccounts: event.target.checked, allowedAccounts: event.target.checked ? draft.allowedAccounts : [] })} /><I18nText id="resources.limit_accounts" />{" "}</label>
                {draft.limitAccounts && (
                  <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-testid="router-allowed-accounts">
                    {(accounts ?? []).map((account) => (
                      <li key={account.id}>
                        <label className="flex min-w-0 items-center gap-2 break-all text-[11px]">
                          <input
                            type="checkbox"
                            checked={draft.allowedAccounts.includes(account.id)}
                            data-testid={`router-account-${account.id}`}
                            onChange={(event) => patch({
                              allowedAccounts: event.target.checked
                                ? [...draft.allowedAccounts, account.id]
                                : draft.allowedAccounts.filter((id) => id !== account.id),
                            })}
                          />
                          {account.displayName} <span className="text-muted-foreground">{account.id}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <Field label={tr("common.spending_mode")}>
                    <Select className="h-8 text-xs" data-testid="router-spending" value={draft.spending} onChange={(event) => patch({ spending: event.target.value as PreviewDraft["spending"] })}>
                      <option value=""><I18nText id="resources.no_extra_limit_in_this_preview" /></option>
                      {SPENDING_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                    </Select>
                  </Field>
                  <Field label={tr("common.project_priority")}>
                    <Select className="h-8 text-xs" data-testid="router-project-priority" value={draft.projectPriority} onChange={(event) => patch({ projectPriority: event.target.value as PreviewDraft["projectPriority"] })}>
                      <option value=""><I18nText id="common.unknown" /></option>
                      {PRIORITY_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                    </Select>
                  </Field>
                  <Field label={tr("resources.maximum_cost_currency")}>
                    <Input className="h-8 text-xs uppercase" maxLength={3} data-testid="router-max-cost-currency" value={draft.currency} onChange={(event) => patch({ currency: event.target.value.toUpperCase() })} placeholder={tr("common.usd")} />
                  </Field>
                  <Field label={tr("common.maximum_expected_cost")}>
                    <Input className="h-8 text-xs" data-testid="router-max-cost-amount" value={draft.costAmount} onChange={(event) => patch({ costAmount: event.target.value })} placeholder={tr("resources.amount_in_that_currency")} />
                  </Field>
                  <Field label={tr("common.global_concurrency")}>
                    <Input className="h-8 text-xs" inputMode="numeric" data-testid="router-global-concurrency" value={draft.globalConcurrency} onChange={(event) => patch({ globalConcurrency: event.target.value })} placeholder={tr("resources.unknown_if_empty")} />
                  </Field>
                  <Field label={tr("common.required_approvals")}>
                    <Input className="h-8 text-xs" data-testid="router-required-approvals" value={draft.requiredApprovals} onChange={(event) => patch({ requiredApprovals: event.target.value })} placeholder={tr("resources.comma_separated_added_to_server_approvals")} />
                  </Field>
                </div>
              </div>
            </details>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" data-testid="find-ai-resource" disabled={loading} onClick={calculate}>
                {loading ? tr("common.calculating") : result ? tr("common.recalculate_preview") : tr("common.find_suitable_ai_resource")}
              </Button>
              {loading && <span role="status" className="text-[11px] text-muted-foreground" data-testid="router-loading"><I18nText id="resources.calculating_a_preview" /></span>}
            </div>
          </>
        )}

        {error && <p role="alert" className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px]" data-testid="router-error">{error}</p>}

        {result && boundary && (
          <div className="flex min-w-0 flex-col gap-3" data-testid="router-result">
            <p className="text-[11px]" data-testid="router-preview-status">{boundary.banner}</p>
            <p className="text-[11px] text-muted-foreground"><I18nText id="resources.snapshot" />{" "}{new Date(result.preview.capturedAt).toISOString()} · {POLICY_COPY[result.preview.policy].label}<I18nText id="resources.all_verification_describes_this_snapshot_not_future_availability" /></p>
            {boundary.ok ? (
              <>
                <details className="rounded-md border border-border/70 px-2 py-1.5">
                  <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.requirements_used" /></summary>
                  <dl className="mt-2 grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-[9rem_minmax(0,1fr)]">
                    {requirementRows(result.preview.requirements).map((row) => (
                      <Fragment key={row.label}>
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd className="min-w-0 break-words">{row.value}</dd>
                      </Fragment>
                    ))}
                    {ownerRows(result.preview.ownerConstraints).map((row) => (
                      <Fragment key={row.label}>
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd className="min-w-0 break-words">{row.value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <p className="mt-1 text-[11px] text-muted-foreground"><I18nText id="resources.shown_values_are_what_this_preview_used_including" /></p>
                </details>
                <CandidateGroupsView preview={result.preview} accounts={accounts ?? []} />
                <details className="rounded-md border border-border/70 px-2 py-1.5" data-testid="router-evidence">
                  <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="resources.evidence_and_limitations" /></summary>
                  <ul className="mt-2 space-y-1 text-[11px]">
                    <li><I18nText id="resources.captured" />{" "}{new Date(result.preview.capturedAt).toISOString()}.</li>
                    <li><I18nText id="resources.execution" />{" "}{result.preview.execution}<I18nText id="resources.resources_reserved" />{" "}{result.preview.revalidation.reservesResources ? "yes" : "no"}.</li>
                    {result.preview.revalidation.checks.map((check) => <li key={check}>{check}</li>)}
                    <li><I18nText id="resources.a_preview_is_not_a_guarantee_that_a" /></li>
                    <li><I18nText id="resources.thinking_effort_is_not_sent_to_a_cli" />{" "}{result.preview.recommendedCandidate ? effortPresentation(result.preview.recommendedCandidate.thinkingEffort).label : tr("common.no_verified_effort_was_selected")}</li>
                  </ul>
                </details>
                {estimate && (
                  <section data-testid="router-planning-estimate" className="text-[11px]">
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{estimate.heading}</h3>
                    <ul className="mt-1 space-y-0.5">{estimate.lines.map((line) => <li key={line} className="break-words">{line}</li>)}</ul>
                  </section>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>
    </details>
  );
}
