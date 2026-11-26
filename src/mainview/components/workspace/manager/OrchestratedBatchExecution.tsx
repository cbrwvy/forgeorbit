import { AccountResourceComparison } from "@/components/router/AccountResourceComparison";
import { AllocationPlanReview } from "@/components/router/AllocationPlanReview";
import { RunExecutionDetails } from "../../kanban/RunExecutionDetails";
import { BOUNDED_CLAUDE } from "../../../../shared/bounded-claude.ts";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pause, Play, Square, ListOrdered } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { subscribeBatchEvents } from "@/lib/batch-events";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import { subscribeTaskAssignmentChanged } from "@/lib/task-assignment-events";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AllocationResourcePick } from "../../../../shared/allocation/types.ts";
import { QUEUE_POLICY_SCHEMA_V1, type OrchestratedBatchView } from "../../../../shared/pm-orchestrated-batch.ts";
import { isGatedPolicy } from "../../../../shared/queue-gates.ts";
import type { Employee } from "../../../../shared/employees/types.ts";
import { AGENT_OPTIONS, DEFAULT_MODEL, defaultModeFor, supportedModes, type Harness, type Project, type Task } from "../../../../shared/types.ts";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { TechnicalDetails } from "@/components/ui/technical-details";

const REVIEWER_ROLES = [
  { slug: "engineering-code-reviewer", label: "Code Reviewer" },
] as const;

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

interface Props {
  project: Project;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
}

const DISPOSITION_KEY = {
  running: "auto03.disposition.running",
  waiting: "auto03.disposition.waiting",
  paused: "auto03.disposition.paused",
  blocked: "auto03.disposition.blocked",
  legacy: "auto03.disposition.legacy",
} as const;

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-info/15 text-info",
  running: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
  completed: "bg-muted text-foreground",
  cancelled: "bg-muted text-muted-foreground",
  stopped: "bg-destructive/15 text-destructive",
};

export function OrchestratedBatchExecution({ project, tasks, onOpenTask }: Props) {
  const [resources, setResources] = useState<Harness[]>([]);
  const [taskResources, setTaskResources] = useState<Record<string, string>>({});
  const [reviewerResourceId, setReviewerResourceId] = useState("");
  const [resourceId, setResourceId] = useState("claude-code");
  const [mode, setMode] = useState("auto");
  const [developerModel, setDeveloperModel] = useState("opus-5.5");
  const [reviewerModel, setReviewerModel] = useState("haiku-5.5");
  const [allocationReviewer, setAllocationReviewer] = useState<AllocationResourcePick | null>(null);
  const rememberReviewer = useCallback((pick: AllocationResourcePick | null) => setAllocationReviewer(pick), []);
  const [maxLaunches, setMaxLaunches] = useState(2);
  const [validMinutes, setValidMinutes] = useState(240);
  const [reviewWithoutObservedTest, setReviewWithoutObservedTest] = useState(false);
  const [reviewerRoleSlug, setReviewerRoleSlug] = useState<string>(REVIEWER_ROLES[0].slug);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>({});
  const [assignmentRefresh, setAssignmentRefresh] = useState(0);
  useEffect(() => { void api.listHarnesses().then(r => setResources(r.harnesses.filter(h => (h.kind === "claude-code" || h.kind === "codex") && h.enabled))).catch(() => {}); }, []);
  useEffect(() => {
    void api.listEmployees({ projectPath: project.path }).then((r) => setEmployees(r.employees)).catch(() => setEmployees([]));
  }, [project.path]);
  const [views, setViews] = useState<OrchestratedBatchView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readyTasks = tasks.filter((t) => t.workdir === project.path && t.column === "ready" && !t.archivedAt && !t.pipelineParentId);

  const reload = useCallback(async () => {
    try {
      setViews(await api.listOrchestratedBatches(project.path));
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [project.path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const unsub = subscribeBatchEvents((ev) => {
      if (ev.projectPath === project.path) void reload();
    });
    return unsub;
  }, [project.path, reload]);

  const selected = views?.find((v) => v.batch.id === selectedId) ?? null;
  const reviewerHarnessId = reviewerResourceId || resourceId;
  const reviewerKind = resources.find((h) => h.id === reviewerHarnessId)?.kind;
  const reviewerMode = reviewerKind === "codex" ? "ask" : mode;
  const reviewerDrift = !!allocationReviewer && !!selected?.canApprove && (
    allocationReviewer.modelId !== reviewerModel
    || allocationReviewer.harnessId !== reviewerHarnessId
    || (!!allocationReviewer.modeId && allocationReviewer.modeId !== reviewerMode)
  );

  useEffect(() => {
    if (!selected?.batch.tasks.length) {
      setAssignments({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      selected.batch.tasks.map(async (row) => {
        try {
          const out = await api.getTaskAssignment(row.taskId);
          return [row.taskId, out.assignment?.employeeId ?? null] as const;
        } catch {
          return [row.taskId, null] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setAssignments(Object.fromEntries(pairs));
    });
    return () => { cancelled = true; };
  }, [selected?.batch.id, selected?.batch.revision, selected?.batch.tasks, assignmentRefresh]);

  useEffect(() => {
    const bump = () => setAssignmentRefresh((n) => n + 1);
    const unsubAssign = subscribeTaskAssignmentChanged(() => bump());
    const unsubPortfolio = subscribePortfolioRefresh(() => bump());
    window.addEventListener("focus", bump);
    return () => {
      unsubAssign();
      unsubPortfolio();
      window.removeEventListener("focus", bump);
    };
  }, []);

  const employeeName = (id: string | null | undefined) =>
    (id ? employees.find((e) => e.id === id)?.name : null) ?? tr("auto02.unassigned_developer");

  const missingImplementer = selected?.batch.tasks.some((row) => !(assignments[row.taskId] ?? row.implementerEmployeeId)) ?? false;

  const resourceLabel = resources.find((h) => h.id === resourceId)?.label ?? resourceId;

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const createDraft = () => run("create", async () => {
    const view = await api.createOrchestratedBatch(project.path, picked, tr("auto02.default_batch_title"));
    setSelectedId(view.batch.id);
    setPicked([]);
  });

  const approve = () => {
    if (!selected) return;
    void run("approve", async () => {
      const perTask: Record<string, { implementerEmployeeId: string; implementerHarnessId: string; implementerModel: string; implementerMode: string; implementerEffort?: string | null }> = {};
      for (const row of selected.batch.tasks) {
        const a = await api.getTaskAssignment(row.taskId);
        const implementerEmployeeId = a.assignment?.employeeId ?? "";
        if (!implementerEmployeeId) throw new Error(tr("auto02.assign_implementer_first"));
        const selectedResource = taskResources[row.taskId] ?? resourceId;
        const h = resources.find(h => h.id === selectedResource);
        if (!h) throw new Error(tr("codex_profiles.unavailable"));
        if (h.kind !== resources.find(h => h.id === resourceId)?.kind) throw new Error(tr("codex_profiles.unavailable"));
        perTask[row.taskId] = { implementerEmployeeId, implementerHarnessId: h.id,
          implementerModel: developerModel,
          implementerMode: mode,
          ...(h.kind === "codex" ? { implementerEffort: "low" } : {}) };
      }
      const updated = await api.approveOrchestratedBatch(project.path, selected.batch.id, {
        revision: selected.batch.revision,
        defaults: {
          implementerEmployeeId: perTask[selected.batch.tasks[0]!.taskId]!.implementerEmployeeId,
          implementerHarnessId: resourceId,
          implementerModel: developerModel,
          implementerMode: mode,
          reviewerHarness: reviewerResourceId || resourceId,
          reviewerModel,
          reviewerMode: resources.find(h => h.id === (reviewerResourceId || resourceId))?.kind === "codex" ? "ask" : mode,
          autoReviewAfterImplementation: true,
          autoReworkOnChanges: false,
          maxLaunches,
          maxReworkIterations: 0,
          evidencePolicy: reviewWithoutObservedTest ? "review-without-observed-test" : "observed-test",
          completionGate: "owner-done",
          requireTaskWorkspace: true,
        },
        perTask,
        validMinutes,
      });
      setSelectedId(updated.batch.id);
    });
  };

  return (
    <section className="space-y-3" data-testid="orchestrated-batch-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ListOrdered className="size-4" aria-hidden />
          {tr("auto02.section_title")}
        </h3>

      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-2 rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">{tr("auto02.pick_ready_tasks")}</p>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {readyTasks.map((task) => (
              <li key={task.id}>
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={picked.includes(task.id)}
                    onChange={() => setPicked((c) => (c.includes(task.id) ? c.filter((id) => id !== task.id) : [...c, task.id]))}
                    data-testid={`orchestrated-batch-pick-${task.id}`}
                  />
                  <span>{task.title}</span>
                </label>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" disabled={!!busy || picked.length === 0} data-testid="orchestrated-batch-create" onClick={() => void createDraft()}>
            {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : tr("auto02.prepare_batch")}
          </Button>
          <div className="mt-3 space-y-1 border-t pt-2">
            {!views ? (
              <p className="text-xs text-muted-foreground">{tr("common.loading")}</p>
            ) : views.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tr("auto02.no_batches")}</p>
            ) : (
              views.map((v) => (
                <button
                  key={v.batch.id}
                  type="button"
                  className={cn("w-full rounded-lg border px-2 py-1.5 text-left text-xs", selectedId === v.batch.id && "border-primary bg-primary/5")}
                  data-testid="orchestrated-batch-row"
                  data-batch-id={v.batch.id}
                  onClick={() => setSelectedId(v.batch.id)}
                >
                  <span className="font-medium">{v.batch.title}</span>
                  <span className={cn("ml-2 rounded-full px-1.5 py-0.5 text-[10px]", STATUS_TONE[v.batch.status] ?? STATUS_TONE.draft)}>{v.batch.status}</span>
                </button>
              ))
            )}
          </div>
        </div>
        {selected ? (
          <div className="space-y-2 rounded-xl border p-3" data-testid="orchestrated-batch-detail">
            <p className="text-sm font-medium">{selected.batch.title}</p>
            {selected.usesFakeDriver && (
              <p className="text-xs text-warning" data-testid="orchestrated-batch-fake-badge" role="status">
                {tr("auto02.fake_driver_notice")}
              </p>
            )}
            <p className="text-xs capitalize text-muted-foreground" data-testid="orchestrated-batch-status">{selected.batch.status}</p>
            {selected.batch.status === "draft" && (
              <p className="text-xs text-muted-foreground" data-testid="orchestrated-batch-start-hint">{tr("auto02.start_requires_approve")}</p>
            )}
            {selected.batch.status === "draft" && selected.canApprove && (
              <div className="space-y-0.5 rounded-md border border-border/70 bg-muted/25 p-2 text-xs" data-testid="batch-policy-draft">
                <div data-testid="batch-policy-evidence">
                  <span className="text-muted-foreground">{tr("auto03.plan_evidence_policy")}: </span>
                  {tr(`m0.completionGate.${reviewWithoutObservedTest ? "review-without-observed-test" : "observed-test"}` as TranslationKey)}
                  <TechnicalDetails rows={[{ label: tr("m0.technicalValue"), value: reviewWithoutObservedTest ? "review-without-observed-test" : "observed-test" }]} />
                </div>
                <div data-testid="batch-policy-completion">
                  <span className="text-muted-foreground">{tr("auto03.plan_completion_gate")}: </span>
                  {tr("m0.completionGate.owner-done")}
                  <TechnicalDetails rows={[{ label: tr("m0.technicalValue"), value: "owner-done" }]} />
                </div>
                <div data-testid="batch-policy-workspace">
                  <span className="text-muted-foreground">{tr("auto03.plan_require_workspace")}: </span>
                  {tr("m0.requireWorkspace.true")}
                  <TechnicalDetails rows={[{ label: tr("m0.technicalValue"), value: "true" }]} />
                </div>
              </div>
            )}
            {selected.batch.status !== "draft" && selected.batch.policy?.queuePolicySchemaVersion === QUEUE_POLICY_SCHEMA_V1 && (
              <div className="space-y-0.5 rounded-md border border-border/70 bg-muted/25 p-2 text-xs" data-testid="batch-policy-frozen">
                <p data-testid="batch-policy-evidence">
                  <span className="text-muted-foreground">{tr("auto03.plan_evidence_policy")}: </span>
                  {selected.batch.policy.evidencePolicy ?? "—"}
                </p>
                <p data-testid="batch-policy-completion">
                  <span className="text-muted-foreground">{tr("auto03.plan_completion_gate")}: </span>
                  {selected.batch.policy.completionGate ?? "—"}
                </p>
                <p data-testid="batch-policy-workspace">
                  <span className="text-muted-foreground">{tr("auto03.plan_require_workspace")}: </span>
                  {String(selected.batch.policy.requireTaskWorkspace ?? false)}
                </p>
              </div>
            )}
            {selected.batch.status !== "draft" && selected.batch.policy && selected.batch.policy.queuePolicySchemaVersion !== QUEUE_POLICY_SCHEMA_V1 && !isGatedPolicy(selected.batch.policy) && (
              <p className="text-xs text-muted-foreground" data-testid="batch-policy-legacy" role="status">
                {tr("auto03.batch_policy_legacy")}
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid="orchestrated-batch-progress">
              {tr("auto02.queue_progress", { p0: String(selected.queuePosition), p1: String(selected.queueTotal) })}
              {" · "}
              {tr("auto02.launches_budget", { p0: String(selected.remainingLaunchesPerTask) })}
            </p>
            {selected.batch.policy && <p className="text-xs text-muted-foreground">{tr("auto02.grant_expires", { at: selected.batch.policy.expiresAt == null ? "—" : new Date(selected.batch.policy.expiresAt).toLocaleString() })}</p>}
            {selected.tasks[0]?.execution?.boundedPolicy && <p className="text-xs text-muted-foreground">{tr("run_execution.threshold", { turns: String(selected.tasks[0].execution.boundedPolicy.maxTurns), cost: String(selected.tasks[0].execution.boundedPolicy.maxBudgetUsd) })} {tr("auto02.tools")}</p>}
            {selected.blocker && (
              <p className="text-xs text-warning" data-testid="orchestrated-batch-blocker">{selected.blocker}</p>
            )}
            {selected.queueGate?.mode === "gated" && (
              <div className="space-y-1 rounded-md border border-border bg-muted/30 p-2 text-xs" data-testid="orchestrated-queue-gate">
                <p data-testid="orchestrated-queue-disposition">{tr(DISPOSITION_KEY[selected.queueGate.disposition])}</p>
                <p data-testid="orchestrated-queue-phase">{tr("auto03.phase")}: {selected.queueGate.phase}</p>
                <p data-testid="orchestrated-queue-next">{tr("auto03.next_authorization")}: {selected.queueGate.nextAuthorization ?? "—"}</p>
                <p data-testid="orchestrated-queue-last">{tr("auto03.last_step")}: {selected.queueGate.lastCompletedStep ?? "—"}</p>
                <p data-testid="orchestrated-queue-developer">{tr("auto03.developer")}: {selected.queueGate.developer ?? "—"}</p>
                <p data-testid="orchestrated-queue-reviewer">{tr("auto03.reviewer")}: {selected.queueGate.reviewer ?? "—"}</p>
                <p data-testid="orchestrated-queue-provider">{tr("auto03.provider_failure")}: {selected.queueGate.providerFailure ?? "—"}</p>
                <p data-testid="orchestrated-queue-failure">{tr("auto03.failure")}: {selected.queueGate.failureClass ?? "—"}</p>
                <p data-testid="orchestrated-queue-next-task">{selected.queueGate.nextTaskEligible ? tr("auto03.next_task_ready") : tr("auto03.next_task_waiting")}</p>
                <p data-testid="orchestrated-queue-quota">{tr("auto03.quota")}: {selected.queueGate.quota}</p>
              </div>
            )}
            {(selected.canApprove || selected.batch.policy) && (
              <BatchPlanSummary
                project={project}
                tasks={selected.tasks}
                assignments={assignments}
                employeeName={employeeName}
                taskResourceLabels={Object.fromEntries(selected.tasks.map(row => [row.taskId, row.execution?.implementerAccountProfile?.displayName ?? resources.find(h => h.id === (selected.batch.policy ? row.implementerHarnessId : taskResources[row.taskId] ?? resourceId))?.label ?? row.implementerHarnessId]))}
                resourceLabel={selected.batch.policy ? (selected.tasks[0]?.execution?.implementerAccountProfile?.displayName ?? resources.find(h => h.id === selected.tasks[0]?.implementerHarnessId)?.label ?? selected.tasks[0]?.implementerHarnessId ?? resourceLabel) : resourceLabel}
                developerModel={selected.batch.policy ? selected.tasks[0]?.implementerModel ?? developerModel : developerModel}
                reviewerResourceLabel={selected.tasks[0]?.execution?.reviewerAccountProfile?.displayName ?? resources.find(h => h.id === (selected.batch.policy ? selected.tasks[0]?.reviewerHarness : reviewerResourceId || resourceId))?.label ?? resourceId}
                reviewerMode={selected.tasks[0]?.execution?.reviewerMode ?? reviewerMode}
                reviewerModel={selected.batch.policy ? selected.tasks[0]?.reviewerModel ?? reviewerModel : reviewerModel}
                reviewerEffort={selected.batch.policy ? selected.tasks[0]?.implementerEffort ?? null : reviewerKind === "codex" ? "low" : null}
                reviewerFingerprint={selected.tasks[0]?.execution?.reviewerHarnessKey ?? (reviewerDrift ? null : allocationReviewer?.resourceFingerprint ?? null)}
                reviewerDrift={reviewerDrift ? { proposed: allocationReviewer?.modelId ?? "", selected: reviewerModel } : null}
                reviewerRoleLabel={REVIEWER_ROLES.find((r) => r.slug === reviewerRoleSlug)?.label ?? reviewerRoleSlug}
                mode={selected.tasks[0]?.execution?.implementerMode ?? mode}
                maxLaunches={selected.batch.policy?.maxLaunchesPerTask ?? maxLaunches}
                validMinutes={validMinutes}
                reworkOff={!(selected.batch.policy?.autoReworkOnChanges ?? false)}
                maxRework={selected.batch.policy?.maxReworkIterations ?? 0}
                expiresAt={selected.batch.policy?.expiresAt ?? null}
              />
            )}
            {selected.canApprove && <div className="space-y-2" data-testid="batch-resources">
              <label className="block text-xs">{tr("auto02.resource")}<select className="ml-2 rounded border bg-background" aria-label={tr("auto02.resource")} data-testid="batch-resource" value={resourceId} onChange={e => {
                const h = resources.find(h => h.id === e.target.value); setResourceId(e.target.value); setReviewerResourceId(""); setTaskResources({});
                if (h) { setMode(defaultModeFor(h.kind)); setDeveloperModel(DEFAULT_MODEL[h.kind]); setReviewerModel(DEFAULT_MODEL[h.kind]); }
              }}>
                {resources.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
              </select></label>
              <label className="block text-xs">{tr("auto02.execution_mode")}<select className="ml-2 rounded border bg-background" data-testid="batch-mode" value={mode} onChange={e => setMode(e.target.value)}>
                {supportedModes(resources.find(h => h.id === resourceId)?.kind ?? "claude-code", developerModel).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select></label>
              <label className="block text-xs">{tr("auto02.developer_model")}<input className="ml-2 w-36 rounded border bg-background" list="batch-resource-models" data-testid="batch-developer-model" value={developerModel} onChange={e => setDeveloperModel(e.target.value)} /></label>
              <label className="block text-xs">{tr("auto02.reviewer_model")}<input className="ml-2 w-36 rounded border bg-background" data-testid="batch-reviewer-model" value={reviewerModel} onChange={e => setReviewerModel(e.target.value)} /></label>
              <label className="block text-xs">{tr("auto02.plan_reviewer")}<select data-testid="batch-reviewer-resource" className="ml-2 rounded border bg-background" value={reviewerResourceId || resourceId} onChange={e => setReviewerResourceId(e.target.value)}>{resources.filter(h => h.kind === resources.find(r => r.id === resourceId)?.kind).map(h => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>
              <AccountResourceComparison taskId={selected.tasks[0]!.taskId} role="reviewer" harnessId={reviewerResourceId || resourceId} model={reviewerModel} mode={resources.find(h => h.id === (reviewerResourceId || resourceId))?.kind === "codex" ? "ask" : mode} kind={resources.find(h => h.id === resourceId)?.kind} onChoose={o => setReviewerResourceId(o.harnessId)} />
              <p className="text-xs text-muted-foreground" data-testid="batch-reviewer-role">
                {tr("auto02.reviewer_role_display")}: {REVIEWER_ROLES.find((r) => r.slug === reviewerRoleSlug)?.label ?? reviewerRoleSlug}
              </p>
              <p className="text-[11px] text-muted-foreground" data-testid="batch-reviewer-role-note">{tr("auto02.reviewer_role_note")}</p>
              <label className="block text-xs">{tr("auto02.launch_limit")}<input type="number" min={1} max={20} className="ml-2 w-16 rounded border bg-background" data-testid="batch-launch-limit" value={maxLaunches} onChange={e => setMaxLaunches(Number(e.target.value))} /></label>
              <label className="block text-xs">{tr("auto02.expiry")}<input type="number" min={5} max={1440} className="ml-2 w-20 rounded border bg-background" data-testid="batch-grant-minutes" value={validMinutes} onChange={e => setValidMinutes(Number(e.target.value))} /></label>
              {mode === "bounded-print" && <p className="text-xs text-muted-foreground" data-testid="batch-bounded-policy">{tr("run_execution.threshold", { turns: String(BOUNDED_CLAUDE.maxTurns), cost: String(BOUNDED_CLAUDE.maxBudgetUsd) })} {tr("auto02.tools")} {tr("run_execution.quota")}</p>}
              <p className="text-xs text-muted-foreground" data-testid="batch-quota-unknown">{tr("auto02.plan_quota_unknown")}</p>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={reviewWithoutObservedTest}
                  onChange={(e) => setReviewWithoutObservedTest(e.target.checked)}
                  data-testid="batch-review-without-observed-test"
                />
                <span>{tr("auto03.review_without_test")}</span>
              </label>
              <p className="text-xs text-muted-foreground" data-testid="batch-review-without-test-help">
                {tr("auto03.review_without_test_help")}
              </p>
              <AllocationPlanReview
                projectPath={project.path}
                taskIds={selected.tasks.map((row) => row.taskId)}
                reviewerHarnessId={reviewerResourceId || resourceId}
                reviewerModel={reviewerModel}
                reviewerMode={reviewerMode}
                onReviewerPick={rememberReviewer}
                onApplied={(applied) => {
                  const slice = applied.record.plan.projects[0];
                  if (!slice) return;
                  const next: Record<string, string> = {};
                  for (const row of slice.tasks) if (row.developer?.harnessId) next[row.taskId] = row.developer.harnessId;
                  setTaskResources((current) => ({ ...current, ...next }));
                  if (slice.reviewer.reviewer?.harnessId) setReviewerResourceId(slice.reviewer.reviewer.harnessId);
                }}
              />
            </div>}
            <datalist id="batch-resource-models">{AGENT_OPTIONS[resources.find(h => h.id === resourceId)?.kind ?? "claude-code"].models.map(m => <option key={m.id} value={m.id} />)}</datalist>
            <ol className="space-y-1 text-xs" data-testid="orchestrated-batch-task-list">
              {selected.tasks.map((row, index) => (
                <li key={row.taskId} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 px-2 py-1">
                  <span className="text-muted-foreground">{index + 1}.</span>
                  <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => {
                    const task = tasks.find((t) => t.id === row.taskId);
                    if (task) onOpenTask(task);
                  }}>
                    {row.title}
                  </button>
                  {selected.canApprove && <label>{tr("codex_profiles.per_task")}<select className="ml-2 rounded border bg-background" data-testid={`batch-task-resource-${row.taskId}`} value={taskResources[row.taskId] ?? resourceId} onChange={e => setTaskResources(v => ({ ...v, [row.taskId]: e.target.value }))}>
                    {resources.filter(h => h.kind === resources.find(item => item.id === resourceId)?.kind).map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
                  </select></label>}
                  {selected.canApprove && <AccountResourceComparison taskId={row.taskId} role="developer" harnessId={taskResources[row.taskId] ?? resourceId} model={developerModel} mode={mode} kind={resources.find(h => h.id === resourceId)?.kind} onChoose={o => setTaskResources(v => ({ ...v, [row.taskId]: o.harnessId }))} />}
                  <span data-testid="batch-account-profile">{row.execution?.implementerAccountProfile?.displayName ?? resources.find(h => h.id === (selected.batch.policy ? row.implementerHarnessId : taskResources[row.taskId] ?? resourceId))?.label ?? row.implementerHarnessId}</span>
                  <span className="text-muted-foreground">{row.phase}</span>
                  <span>{row.implementerModel} → {row.reviewerModel} · {row.execution?.implementerMode ?? "—"}</span>
                  <span>{tr("auto02.remaining", { launches: String(row.remainingLaunches ?? "—"), reworks: String(row.remainingRework ?? "—") })}</span>
                  {row.launchedRuns?.length ? row.launchedRuns.map(run => <div key={run.runId} className="w-full border-t pt-1">
                    <span>{run.role === "implementation" ? tr("auto02.developer_model") : tr("auto02.reviewer_model")} · {run.runId}</span>
                    <RunExecutionDetails runId={run.runId} />
                  </div>) : <RunExecutionDetails compact />}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2 pt-1">
              {selected.canApprove && missingImplementer && (
                <p className="w-full text-xs text-warning" data-testid="orchestrated-batch-assign-blocker" role="status">
                  {tr("auto02.assign_implementer_first")}
                </p>
              )}
              {selected.canApprove && (
                <Button type="button" size="sm" disabled={!!busy || missingImplementer || reviewerDrift} data-testid="orchestrated-batch-approve" onClick={() => approve()}>
                  {tr("auto02.approve_plan")}
                </Button>
              )}
              {selected.queueGate?.mode === "gated" && selected.queueGate.nextTaskId && (selected.queueGate.nextAuthorizationPhase === "developer" || selected.queueGate.nextAuthorizationPhase === "reviewer") && (
                <Button type="button" size="sm" disabled={!!busy} data-testid="orchestrated-queue-authorize" onClick={() => {
                  const gate = selected.queueGate;
                  const taskId = gate?.nextTaskId;
                  const phase = gate?.nextAuthorizationPhase;
                  if (!taskId || (phase !== "developer" && phase !== "reviewer")) return;
                  const implementationRunId = phase === "reviewer"
                    ? selected.tasks.find((row) => row.taskId === taskId)?.launchedRuns?.find((run) => run.role === "implementation")?.runId
                    : undefined;
                  void run("authorize", async () => {
                    await api.authorizeOrchestratedPhase(project.path, selected.batch.id, { taskId, phase, ...(implementationRunId ? { implementationRunId } : {}) });
                  });
                }}>
                  {tr("auto03.authorize_step")}
                </Button>
              )}
              {selected.canStart && (
                <Button type="button" size="sm" disabled={!!busy} data-testid="orchestrated-batch-start" onClick={() => void run("start", async () => {
                  await api.orchestratedBatchAction(project.path, selected.batch.id, "start");
                })}>
                  <Play className="size-3.5" /> {tr("auto02.start_batch")}
                </Button>
              )}
              {selected.batch.status === "running" && (
                <Button type="button" size="sm" variant="outline" disabled={!!busy} data-testid="orchestrated-batch-pause" onClick={() => void run("pause", async () => {
                  await api.orchestratedBatchAction(project.path, selected.batch.id, "pause");
                })}>
                  <Pause className="size-3.5" /> {tr("auto02.pause_batch")}
                </Button>
              )}
              {selected.batch.status === "paused" && (
                <Button type="button" size="sm" variant="outline" disabled={!!busy} data-testid="orchestrated-batch-resume" onClick={() => void run("resume", async () => {
                  await api.orchestratedBatchAction(project.path, selected.batch.id, "resume");
                })}>
                  <Play className="size-3.5" /> {tr("auto02.resume_batch")}
                </Button>
              )}
              {selected.batch.status !== "cancelled" && selected.batch.status !== "completed" && (
                <Button type="button" size="sm" variant="ghost" disabled={!!busy} data-testid="orchestrated-batch-cancel" onClick={() => void run("cancel", async () => {
                  await api.orchestratedBatchAction(project.path, selected.batch.id, "cancel");
                })}>
                  <Square className="size-3.5" /> {tr("auto02.cancel_batch")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border px-4 py-6 text-sm text-muted-foreground">{tr("auto02.select_batch")}</div>
        )}
      </div>
    </section>
  );
}

function BatchPlanSummary({
  project,
  tasks,
  assignments,
  employeeName,
  resourceLabel,
  taskResourceLabels,
  reviewerResourceLabel,
  developerModel,
  reviewerModel,
  reviewerMode,
  reviewerEffort,
  reviewerFingerprint,
  reviewerDrift,
  reviewerRoleLabel,
  mode,
  maxLaunches,
  validMinutes,
  reworkOff,
  maxRework,
  expiresAt,
}: {
  project: Project;
  tasks: OrchestratedBatchView["tasks"];
  assignments: Record<string, string | null>;
  employeeName: (id: string | null | undefined) => string;
  resourceLabel: string;
  taskResourceLabels: Record<string, string>;
  reviewerResourceLabel: string;
  developerModel: string;
  reviewerModel: string;
  reviewerMode: string;
  reviewerEffort: string | null;
  reviewerFingerprint: string | null;
  reviewerDrift: { proposed: string; selected: string } | null;
  reviewerRoleLabel: string;
  mode: string;
  maxLaunches: number;
  validMinutes: number;
  reworkOff: boolean;
  maxRework: number;
  expiresAt: number | null;
}) {
  const grantPreview = expiresAt == null ? new Date(Date.now() + validMinutes * 60_000).toLocaleString() : new Date(expiresAt).toLocaleString();
  return (
    <section className="space-y-1 rounded-lg border border-border/80 bg-muted/20 p-2 text-xs" data-testid="batch-plan-summary" aria-label={tr("auto02.plan_summary")}>
      <p className="font-semibold">{tr("auto02.plan_summary")}</p>
      <p><span className="text-muted-foreground">{tr("auto02.plan_project")}: </span>{project.name ?? project.path}</p>
      <p className="text-muted-foreground">{tr("auto02.plan_tasks")}</p>
      <ol className="list-decimal pl-4" data-testid="batch-plan-tasks">
        {tasks.map((row, index) => (
          <li key={row.taskId}>
            {index + 1}. {row.title} — {tr("auto02.plan_developer")}: {employeeName(assignments[row.taskId] ?? row.implementerEmployeeId)} · {taskResourceLabels[row.taskId]} · {row.execution ? row.implementerModel : developerModel} · {row.execution?.implementerMode ?? mode}
          </li>
        ))}
      </ol>
      <p data-testid="batch-plan-reviewer">
        {tr("auto02.plan_reviewer")}: {reviewerRoleLabel} · {reviewerResourceLabel} · {reviewerModel} · {reviewerMode}
        {reviewerEffort ? ` · ${tr("auto02.plan_effort")}: ${reviewerEffort}` : ""}
      </p>
      {reviewerFingerprint ? <p className="break-all font-mono" data-testid="batch-plan-reviewer-fingerprint">{tr("routing02.fingerprint")}: {reviewerFingerprint}</p> : null}
      {reviewerDrift ? <p className="text-warning" data-testid="batch-plan-reviewer-drift">{tr("routing03.reviewer_drift", reviewerDrift)}</p> : null}
      <p data-testid="batch-plan-developer-resource">
        {tr("auto02.plan_developer")}: {resourceLabel} · {developerModel} · {mode}
      </p>
      <p data-testid="batch-plan-limits">{tr("auto02.launches_budget", { p0: String(maxLaunches) })} · {tr("auto02.grant_expires", { at: grantPreview })}</p>
      <p data-testid="batch-plan-rework">{reworkOff ? tr("auto02.plan_rework_off") : tr("auto02.plan_rework_on", { max: String(maxRework) })}</p>
    </section>
  );
}
