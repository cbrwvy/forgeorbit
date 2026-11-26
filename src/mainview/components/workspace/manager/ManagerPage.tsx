import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, BookmarkPlus, Loader2, Square, Trash2, UserPlus } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { subscribePipelineGlobalEvents } from "@/lib/pipeline-events";
import { subscribePortfolioManagerSignals } from "@/lib/portfolio-manager-events";
import { Button } from "@/components/ui/button";
import { BrowserActionCard } from "../browser/BrowserAccessPicker";
import { NativeActionCard } from "../native/NativeAccessPicker";
import { MemoryProposalList } from "../brain/MemoryProposals";
import { cn } from "@/lib/utils";
import { isProjectTask } from "@/lib/workspace";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "../../kanban/md-components";
import { useWorkspaceDraft } from "../WorkspaceDrafts";
import { ManagerAgentPanel, type ManagerAgentStatus } from "./ManagerAgentPanel";
import { ProposalCard } from "./ProposalCard";
import { contextSourceDetail, contextSourceLabel } from "@/lib/manager-source-text";
import { ErrorState, LoadingState } from "@/components/ui/state";
import { AssignmentProposals } from "../company/AssignmentProposals";
import { HiringProposals } from "../company/HiringProposals";
import { ExecutionCard } from "./ExecutionCard";
import { ManagerPlanSection } from "./ManagerPlanSection";
import { ManagerInboxSection } from "./ManagerInboxSection";
import { AutonomousExecution } from "./AutonomousExecution";
import { OrchestratedBatchExecution } from "./OrchestratedBatchExecution";
import { PHASE_TEXT, type ExecutionView } from "../../../../shared/project-execution.ts";
import { pendingProjectInboxProposals } from "../../../../shared/pm-intake.ts";
import {
  MANAGER_LIMITS,
  type ContextSource,
  type ManagerConfig,
  type ManagerMessage,
  type ManagerPlan,
  type ManagerState,
  type TaskProposal,
} from "../../../../shared/project-manager.ts";
import type { Project, Task } from "../../../../shared/types.ts";

const POLL_MS = 700;

interface Props {
  project: Project;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onOpenSettingsAgents: () => void;
  onOpenEmployee?: (employeeId: string) => void;
  /** A request from elsewhere (Head of PM, a deep link) to open a section. `nonce` makes a repeat request count. */
  intent?: { view: "chat" | "inbox" | "plan" | "runs"; nonce: number } | null;
  onOpenHead?: () => void;
  onOpenBrain?: () => void;
  onOpenBrowser?: () => void;
  onOpenNativeComputer?: () => void;
}

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

const SOURCE_TONE: Record<ContextSource["status"], string> = {
  included: "text-success",
  truncated: "text-warning",
  missing: "text-muted-foreground",
  skipped: "text-warning",
};

const SOURCE_LABEL: Record<ContextSource["status"], string> = {
  get included() { return tr("common.included"); },
  get truncated() { return tr("common.excerpt"); },
  get missing() { return tr("common.not_found"); },
  get skipped() { return tr("common.skipped_12698c"); },
};

/** Historical transcript and settlement of previously recorded project workflows. */
export function ManagerPage({ project, tasks, onOpenTask, onOpenSettingsAgents, onOpenEmployee, intent, onOpenHead, onOpenBrain, onOpenBrowser, onOpenNativeComputer }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [state, setState] = useState<ManagerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sources, setSources] = useState<ContextSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<ManagerAgentStatus>({ problem: tr("common.loading_agents"), needsConsent: false, label: null, model: null });
  const [decisionDraft, setDecisionDraft] = useWorkspaceDraft(`manager:${project.path}:decision`, "");
  const [executions, setExecutions] = useState<ExecutionView[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "inbox" | "plan" | "autonomy">(() =>
    intent?.view === "plan" ? "plan" : intent?.view === "runs" ? "autonomy" : intent?.view === "inbox" ? "inbox" : "chat",
  );
  const lastIntent = useRef(intent?.nonce ?? 0);
  useEffect(() => {
    if (!intent || intent.nonce === lastIntent.current) return;
    lastIntent.current = intent.nonce;
    setView(intent.view === "plan" ? "plan" : intent.view === "runs" ? "autonomy" : intent.view === "inbox" ? "inbox" : "chat");
  }, [intent]);
  const [focusBatchId, setFocusBatchId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const next = await api.getManager(project.path);
    setState(next);
    setLoadError(null);
    return next;
  }, [project.path]);

  const reloadExecutions = useCallback(async () => {
    try {
      setExecutions(await api.listExecutions(project.path));
    } catch {
      /* the next board change or event tries again */
    }
  }, [project.path]);

  const upsertExecution = useCallback((view: ExecutionView) => {
    setExecutions((current) => {
      const at = current.findIndex((item) => item.id === view.id);
      if (at < 0) return [view, ...current];
      const next = [...current];
      next[at] = view;
      return next;
    });
  }, []);

  const reloadSources = useCallback(() => {
    void api.managerContext(project.path).then((result) => setSources(result.sources), () => setSources(null));
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    void api.getManager(project.path).then(
      (next) => { if (!cancelled) setState(next); },
      (reason: unknown) => { if (!cancelled) setLoadError(messageOf(reason)); },
    );
    reloadSources();
    void reloadExecutions();
    return () => { cancelled = true; };
  }, [project.path, reloadSources, reloadExecutions]);

  // Live run state comes from the board, not from a poll of our own: the
  // app-wide event stream (column / run-status / pipeline / interaction)
  // and the board's existing task poll both trigger a re-read of the
  // executions, which the core derives from the task and run rows.
  const trackedTaskIds = useMemo(
    () => new Set(executions.filter((item) => item.status !== "dismissed").map((item) => item.taskId)),
    [executions, uiLocale],
  );
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void reloadExecutions();
    }, 250);
  }, [reloadExecutions]);
  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);
  useEffect(() => subscribePipelineGlobalEvents((event) => {
    if (!("taskId" in event)) return;
    const parent = (event as { pipelineParentId?: string }).pipelineParentId;
    if (trackedTaskIds.has(event.taskId) || (parent && trackedTaskIds.has(parent))) scheduleReload();
  }), [trackedTaskIds, scheduleReload]);
  const boardSignature = useMemo(() => tasks
    .filter((task) => trackedTaskIds.has(task.id))
    .map((task) => `${task.id}:${task.column}:${task.runId ?? ""}:${task.pendingInteractionCount}:${task.pipelineRun?.status ?? ""}:${task.title}`)
    .sort()
    .join("|"), [tasks, trackedTaskIds, uiLocale]);
  const firstSignature = useRef(true);
  useEffect(() => {
    if (firstSignature.current) {
      firstSignature.current = false;
      return;
    }
    scheduleReload();
  }, [boardSignature, scheduleReload]);

  // A portfolio-manager request reaching this project (or settling) shows up
  // without a reload: the shared event stream names the project, and the
  // chat is re-read from the core (FO-008D).
  useEffect(() => subscribePortfolioManagerSignals((signal) => {
    if (signal.kind === "reconnect" || signal.event.projectPath === project.path) {
      void reload().catch(() => {});
    }
  }), [project.path, reload]);

  const activeTurn = state?.activeTurn ?? null;

  // Poll the running turn. The core saves the reply itself, so this only
  // decides when to refresh.
  useEffect(() => {
    if (!activeTurn) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const turn = await api.getManagerTurn(activeTurn.id);
        if (stopped) return;
        if (turn.status === "running") {
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        await reload();
        reloadSources();
        void reloadExecutions();
      } catch (caught) {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 404) {
          await reload().catch(() => {});
          return;
        }
        timer = setTimeout(poll, POLL_MS * 2);
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeTurn?.id, reload, reloadSources, reloadExecutions]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state?.messages.length, activeTurn?.id]);

  const cancel = () => {
    if (activeTurn) void api.cancelManagerTurn(activeTurn.id).catch(() => {});
  };

  const updateProposal = (proposal: TaskProposal) => {
    setState((current) => current && ({
      ...current,
      proposals: current.proposals.map((item) => (item.id === proposal.id ? proposal : item)),
    }));
    // Approve/reject append a system line and maybe a decision.
    if (proposal.status !== "pending") void reload().catch(() => {});
  };

  const remember = async (text: string, source: "owner" | "manager") => {
    try {
      await api.addManagerDecision(project.path, text, source);
      await reload();
      reloadSources();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const forget = async (id: string) => {
    try {
      await api.deleteManagerDecision(project.path, id);
      await reload();
      reloadSources();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const prepareRun = async (taskId: string) => {
    if (!taskId || preparing) return;
    setPreparing(true);
    setExecuteError(null);
    try {
      const { execution } = await api.prepareExecution(project.path, taskId);
      upsertExecution(execution);
      await reload();
      requestAnimationFrame(() => {
        document.getElementById(`execution-${execution.id}`)?.scrollIntoView({ block: "nearest" });
      });
    } catch (caught) {
      setExecuteError(messageOf(caught));
    } finally {
      setPreparing(false);
    }
  };

  /** A draft batch from an approved proposal's tasks. Starts nothing. */
  const prepareBatch = async (proposalId: string) => {
    const batch = await api.createBatchFromProposal(project.path, proposalId);
    setFocusBatchId(batch.id);
    setView("autonomy");
  };

  /** Jump to a batch in the Autonomous Execution tab, where it is approved and started. */
  const openBatch = (batchId: string) => {
    setFocusBatchId(batchId);
    setView("autonomy");
  };

  const changedExecution = (view: ExecutionView) => {
    upsertExecution(view);
    // Approve, a failed start and review actions append a chat line.
    void reload().catch(() => {});
  };

  const setConfig = (config: ManagerConfig) => {
    setState((current) => current && { ...current, config });
  };

  if (loadError && !state) {
    return (
      <div className="px-page py-6" data-testid="manager-page">
        <ErrorState message={loadError} testId="manager-load-error" />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="px-page py-6" data-testid="manager-page">
        <LoadingState label={<I18nText id="approvals.loading_the_project_manager" />} />
      </div>
    );
  }

  const executionById = new Map(executions.map((item) => [item.id, item]));
  const recentRuns = executions.filter((item) => item.status !== "dismissed").slice(0, 8);
  const decidedTexts = new Set(state.decisions.map((item) => item.text.toLowerCase()));
  const connection = activeTurn
    ? { label: tr("common.answering"), tone: "text-info" }
    : agent.problem
      ? { label: agent.problem === "Loading agents…" || agent.problem.startsWith("Checking") ? agent.problem : tr("common.unavailable"), tone: "text-danger" }
      : agent.needsConsent
        ? { label: tr("common.confirm_the_agent_to_start"), tone: "text-warning" }
        : { label: tr("common.ready"), tone: "text-success" };

  const inboxTaskCount = tasks.filter(
    (task) => task.column === "inbox" && task.archivedAt == null && isProjectTask(task, project.path) && !task.pipelineParentId,
  ).length;
  const inboxPending = pendingProjectInboxProposals(state.proposals).length;
  const inboxBadge = inboxTaskCount + inboxPending;
  const openPlanSection = () => setView("plan");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size] [container-name:workspace]">
    <div className="manager-page flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-page" data-testid="manager-page">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
        <p className="text-muted-foreground">{tr("headPm.unified.legacyNotice")}</p>
        {onOpenHead && <Button type="button" size="sm" variant="outline" onClick={onOpenHead}>{tr("headPm.unified.openHead")}</Button>}
      </div>
      <div role="tablist" aria-label={tr("headPm.unified.legacy")} className="ds-tabs self-start">
        {(
          [
            ["chat", tr("headPm.unified.history"), 0],
            ["inbox", tr("uxfix.tab.inbox"), inboxBadge],
            ["plan", tr("uxfix.tab.plan"), 0],
            ["autonomy", tr("uxfix.tab.runs"), 0],
          ] as const
        ).map(([id, label, badge]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`manager-tab-${id}`}
            aria-selected={view === id}
            aria-controls={`manager-panel-${id}`}
            onClick={() => setView(id)}
            className={cn("glass-nav-item ds-tab", view === id && "glass-selected")}
            data-testid={`manager-tab-${id}`}
          >
            {label}
            {badge > 0 ? (
              <span className="ml-1.5 inline-flex min-w-[1.1rem] justify-center rounded-full bg-warning/20 px-1 text-[10px] font-semibold text-warning" data-testid="manager-inbox-badge">
                {badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground" data-testid="manager-where-hint">{tr("m5.manager.where")}</p>
      {view === "inbox" ? (
        <div role="tabpanel" id="manager-panel-inbox" aria-labelledby="manager-tab-inbox" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ManagerInboxSection
            projectPath={project.path}
            proposals={state.proposals}
            tasks={tasks}
            onProposalChanged={updateProposal}
            onOpenTask={onOpenTask}
            onExecute={(taskId) => { setView("chat"); void prepareRun(taskId); }}
            onPrepareBatch={prepareBatch}
            onOpenBatch={openBatch}
            onOpenPlanSection={openPlanSection}
            onOpenChat={() => setView("chat")}
          />
        </div>
      ) : view === "plan" ? (
        <div role="tabpanel" id="manager-panel-plan" aria-labelledby="manager-tab-plan" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ManagerPlanSection
            projectPath={project.path}
            proposals={state.proposals}
            tasks={tasks}
            onOpenTask={onOpenTask}
            onExecute={(taskId) => { setView("chat"); void prepareRun(taskId); }}
            onOpenBatch={openBatch}
            onOpenChat={() => setView("chat")}
          />
        </div>
      ) : view === "autonomy" ? (
        <div role="tabpanel" id="manager-panel-autonomy" aria-labelledby="manager-tab-autonomy" className="flex min-w-0 shrink-0 flex-col">
          <AutonomousExecution
            project={project}
            tasks={tasks}
            proposals={state.proposals}
            focusBatchId={focusBatchId}
            onOpenTask={onOpenTask}
            onManageAgents={onOpenSettingsAgents}
          />
          <div className="mt-4 shrink-0 px-1 pb-4">
            <OrchestratedBatchExecution project={project} tasks={tasks} onOpenTask={onOpenTask} />
          </div>
        </div>
      ) : (
      <div role="tabpanel" id="manager-panel-chat" aria-labelledby="manager-tab-chat" className="manager-columns grid min-h-0 min-w-0 flex-1 gap-4">
        <section className="manager-chat surface-solid flex min-h-[28rem] min-w-0 flex-col rounded-xl border" aria-label={tr("headPm.unified.history")}>
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Bot className="size-4" aria-hidden />{tr("headPm.unified.legacy")}</h3>
              <p className="truncate text-xs text-muted-foreground" data-testid="manager-project-name">
                {project.name || project.path}
                {agent.label ? ` · ${agent.label}` : ""}
                {agent.model ? ` · ${agent.model}` : ""}
              </p>
            </div>
            <span className={cn("text-xs font-medium", connection.tone)} role="status" data-testid="manager-connection">
              {connection.label}
            </span>
          </header>

          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label={tr("approvals.manager_messages")}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
            data-testid="manager-log"
          >
            {state.messages.length === 0 && (
              <div className="space-y-1 text-sm text-muted-foreground" data-testid="manager-empty">
                <p>{tr("headPm.unified.historyEmpty")}</p>
              </div>
            )}
            {state.messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                projectPath={project.path}
                proposal={message.proposalId ? state.proposals.find((item) => item.id === message.proposalId) ?? null : null}
                tasks={tasks}
                decided={decidedTexts}
                pending={activeTurn?.messageId === message.id}
                execution={message.executionId ? executionById.get(message.executionId) ?? null : null}
                onProposal={updateProposal}
                onExecution={changedExecution}
                onExecute={(taskId) => void prepareRun(taskId)}
                onPrepareBatch={prepareBatch}
                onOpenBatch={openBatch}
                onOpenPlanSection={() => setView("plan")}
                onOpenTask={onOpenTask}
                onManageAgents={onOpenSettingsAgents}
                onRemember={(text) => void remember(text, "manager")}
                onOpenBrain={onOpenBrain}
                onOpenBrowser={onOpenBrowser}
                onOpenNativeComputer={onOpenNativeComputer}
              />
            ))}
            {activeTurn && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="manager-busy">
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /><I18nText id="approvals.the_manager_is_reading_the_project_and_answering" />{" "}</p>
            )}
          </div>

          {(error || executeError || activeTurn) && (
            <footer className="space-y-2 border-t px-4 py-3">
              {(error || executeError) && <p role="alert" className="text-xs text-danger">{error ?? executeError}</p>}
              {activeTurn && (
                <Button type="button" size="sm" variant="outline" onClick={cancel} data-testid="manager-cancel">
                  <Square className="size-3.5" aria-hidden /><I18nText id="common.cancel_request" />
                </Button>
              )}
            </footer>
          )}
        </section>

        <aside className="manager-context flex min-w-0 flex-col gap-4" aria-label={tr("approvals.manager_settings_and_context")}>
          <HiringProposals
            projectPath={project.path}
            refreshToken={`${state?.messages.length ?? 0}:${activeTurn?.id ?? ""}`}
            onOpenEmployee={onOpenEmployee}
          />
          <AssignmentProposals
            projectPath={project.path}
            refreshToken={`${state?.messages.length ?? 0}:${activeTurn?.id ?? ""}`}
            onOpenTask={(taskId) => {
              const task = tasks.find((item) => item.id === taskId);
              if (task) onOpenTask(task);
            }}
          />
          {recentRuns.length > 0 && (
            <section className="surface-solid rounded-xl border px-4 py-3" data-testid="manager-execute">
              <ul className="mt-3 space-y-1 text-xs" aria-label={tr("approvals.supervised_runs")} data-testid="manager-runs">
                {recentRuns.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2" data-testid="manager-run" data-phase={item.phase}>
                    <button
                      type="button"
                      className="min-w-0 truncate text-left hover:underline"
                      onClick={() => document.getElementById(`execution-${item.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
                      title={item.live.title ?? item.taskTitle}
                    >
                      {item.live.title ?? item.taskTitle}
                    </button>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{PHASE_TEXT[item.phase]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="surface-solid rounded-xl border px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">{tr("headPm.unified.legacySettings")}</summary>
            <p className="my-2 text-xs text-muted-foreground">{tr("headPm.unified.legacySettingsNotice")}</p>
            <ManagerAgentPanel
              key={project.path}
              projectPath={project.path}
              config={state.config}
              busy={activeTurn != null}
              onConfigChange={setConfig}
              onStatus={setAgent}
              onManageAgents={onOpenSettingsAgents}
            />
          </details>

          <section className="surface-solid rounded-xl border px-4 py-3" data-testid="manager-sources">
            <h4 className="mb-2 text-sm font-medium"><I18nText id="approvals.project_context" /></h4>
            {sources == null ? (
              <p className="text-xs text-muted-foreground"><I18nText id="common.reading_what_the_manager_can_see" /></p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {sources.map((source) => (
                  <li key={source.id} data-testid="manager-source" data-source={source.id} data-status={source.status}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium" title={source.path ?? source.label}>
                        {contextSourceLabel(source)}{source.path && source.label !== tr("common.document", { p0: String(source.path) }) ? ` · ${source.path}` : ""}
                      </span>
                      <span className={cn("shrink-0 text-[11px]", SOURCE_TONE[source.status])}>{SOURCE_LABEL[source.status]}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{contextSourceDetail(source)}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground"><I18nText id="approvals.files_are_read_from_inside_this_project_only" />{" "}</p>
          </section>

          <section className="surface-solid rounded-xl border px-4 py-3" data-testid="manager-decisions">
            <h4 className="mb-2 text-sm font-medium"><I18nText id="common.decisions" /></h4>
            {state.decisions.length === 0 ? (
              <p className="text-xs text-muted-foreground"><I18nText id="common.no_decisions_yet_confirmed_ones_are_sent_with" /></p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {state.decisions.map((decision) => (
                  <li key={decision.id} className="flex items-start justify-between gap-2" data-testid="manager-decision">
                    <span className="min-w-0">{decision.text}</span>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => void forget(decision.id)}
                      aria-label={tr("common.forget_decision", { p0: String(decision.text) })}
                      data-testid="manager-decision-remove"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const text = decisionDraft.trim();
                if (!text) return;
                setDecisionDraft("");
                void remember(text, "owner");
              }}
            >
              <input
                value={decisionDraft}
                onChange={(event) => setDecisionDraft(event.target.value)}
                maxLength={MANAGER_LIMITS.decisionChars}
                placeholder={tr("common.add_a_decision")}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
                aria-label={tr("common.add_a_decision")}
                data-testid="manager-decision-input"
              />
              <Button type="submit" size="sm" variant="outline" disabled={!decisionDraft.trim()} data-testid="manager-decision-add"><I18nText id="common.add" />{" "}</Button>
            </form>
          </section>
        </aside>
      </div>
      )}

    </div>
    </div>
  );
}

function MessageRow({
  message,
  projectPath,
  proposal,
  execution,
  tasks,
  decided,
  pending,
  onProposal,
  onExecution,
  onExecute,
  onPrepareBatch,
  onOpenBatch,
  onOpenPlanSection,
  onOpenTask,
  onManageAgents,
  onRemember,
  onOpenBrain,
  onOpenBrowser,
  onOpenNativeComputer,
}: {
  message: ManagerMessage;
  projectPath: string;
  proposal: TaskProposal | null;
  execution: ExecutionView | null;
  tasks: Task[];
  decided: ReadonlySet<string>;
  pending: boolean;
  onProposal: (proposal: TaskProposal) => void;
  onExecution: (execution: ExecutionView) => void;
  onExecute: (taskId: string) => void;
  onPrepareBatch: (proposalId: string) => Promise<void>;
  onOpenBatch: (batchId: string) => void;
  onOpenPlanSection: () => void;
  onOpenTask: (task: Task) => void;
  onManageAgents: () => void;
  onRemember: (text: string) => void;
  onOpenBrain?: () => void;
  onOpenBrowser?: () => void;
  onOpenNativeComputer?: () => void;
}) {
  useUILocale();
  if (message.role === "system") {
    // The first line about an execution carries its card; later lines
    // ("Started …", "couldn't start") are plain notes.
    const ownsCard = execution && execution.messageId === message.id;
    return (
      <div className="space-y-2" data-testid="manager-message" data-role="system">
        <p className="text-center text-[11px] text-muted-foreground">{message.text}</p>
        {ownsCard && (
          <ExecutionCard
            projectPath={projectPath}
            execution={execution}
            tasks={tasks}
            onChanged={onExecution}
            onOpenTask={onOpenTask}
            onManageAgents={onManageAgents}
          />
        )}
      </div>
    );
  }
  if (message.role === "owner") {
    return (
      <div
        className="ml-auto max-w-[85%] rounded-lg border border-border px-3 py-2 text-sm"
        data-testid="manager-message"
        data-role="owner"
        data-status={message.status ?? ""}
        data-delegation={message.delegationId ?? undefined}
      >
        <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {message.delegationId ? "Portfolio manager request, approved by you" : tr("common.you")}{pending ? tr("common.waiting_for_the_answer") : message.status === "failed" ? tr("common.not_answered") : message.status === "cancelled" ? tr("common.cancelled_6d483e") : ""}
        </span>
        <span className="whitespace-pre-wrap">{message.text}</span>
        {message.nativeAction && <div className="mt-2"><NativeActionCard action={message.nativeAction} onOpenNativeComputer={onOpenNativeComputer} /></div>}
      </div>
    );
  }
  const suggestions = message.suggestedDecisions.filter((item) => !decided.has(item.toLowerCase()));
  return (
    <div className="max-w-full space-y-2" data-testid="manager-message" data-role="manager">
      <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
        <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="common.manager" /></span>
        <div className="agetor-md" data-testid="manager-reply">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
            {message.text}
          </ReactMarkdown>
        </div>
        {message.sources.length > 0 && (
          <details className="mt-1 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer"><I18nText id="common.based_on" /></summary>
            <ul className="mt-0.5 list-disc pl-4">
              {message.sources.filter((source) => source.status === "included" || source.status === "truncated").map((source) => (
                <li key={source.id}>{contextSourceLabel(source)}{source.path ? ` (${source.path})` : ""} — {contextSourceDetail(source)}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {message.hiringProposalIds && message.hiringProposalIds.length > 0 && (
        <div
          data-testid="message-hiring-proposals-banner"
          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs"
        >
          <UserPlus className="size-4 text-primary shrink-0" aria-hidden />
          <div>
            <p className="font-semibold text-primary"><I18nText id="approvals.recommended" />{" "}{message.hiringProposalIds.length}{" "}<I18nText id="approvals.team_specialist" />{message.hiringProposalIds.length === 1 ? "" : englishPluralSuffix()}
            </p>
            <p className="text-[11px] text-muted-foreground"><I18nText id="approvals.review_customize_and_approve_hiring_in_the_hiring" />{" "}</p>
          </div>
        </div>
      )}
      {message.plan && <PlanCard plan={message.plan} />}
      <MemoryProposalList messageId={message.id} onOpenBrain={() => onOpenBrain?.()} />
      {message.browserAction && <BrowserActionCard action={message.browserAction} onOpenBrowser={onOpenBrowser} />}
      {message.nativeAction && <NativeActionCard action={message.nativeAction} onOpenNativeComputer={onOpenNativeComputer} />}
      {message.proposalError && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" data-testid="manager-proposal-invalid">
          {message.proposalError}
        </p>
      )}
      {proposal && (
        <ProposalCard
          projectPath={projectPath}
          proposal={proposal}
          tasks={tasks}
          onChanged={onProposal}
          onOpenTask={onOpenTask}
          onExecute={onExecute}
          onPrepareBatch={onPrepareBatch}
          onOpenBatch={onOpenBatch}
          onOpenPlanSection={onOpenPlanSection}
        />
      )}
      {execution && execution.messageId === message.id && (
        <ExecutionCard
          projectPath={projectPath}
          execution={execution}
          tasks={tasks}
          onChanged={onExecution}
          onOpenTask={onOpenTask}
          onManageAgents={onManageAgents}
        />
      )}
      {suggestions.length > 0 && (
        <div className="space-y-1 rounded-md border border-border px-2 py-1.5 text-[11px]" data-testid="manager-suggested-decisions">
          <p className="font-medium text-muted-foreground"><I18nText id="common.decisions_to_remember" /></p>
          {suggestions.map((text) => (
            <div key={text} className="flex items-center justify-between gap-2">
              <span className="min-w-0">{text}</span>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onRemember(text)} data-testid="manager-remember">
                <BookmarkPlus className="size-3" aria-hidden /><I18nText id="common.remember" />{" "}</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan }: { plan: ManagerPlan }) {
  useUILocale();
  return (
    <section className="rounded-xl border border-border px-3 py-2 text-xs" aria-label={tr("common.plan", { p0: String(plan.title) })} data-testid="manager-plan">
      <h4 className="text-sm font-semibold">{plan.title}</h4>
      {plan.summary && <p className="mt-0.5 text-muted-foreground">{plan.summary}</p>}
      <ol className="mt-1.5 list-decimal space-y-1 pl-5">
        {plan.steps.map((step, index) => (
          <li key={`${index}-${step.title}`} data-testid="manager-plan-step">
            <span className="font-medium">{step.title}</span>
            {step.detail && <span className="text-muted-foreground"> — {step.detail}</span>}
          </li>
        ))}
      </ol>
      <p className="mt-1.5 text-[11px] text-muted-foreground"><I18nText id="approvals.a_plan_is_a_draft_ask_the_manager" /></p>
    </section>
  );
}
