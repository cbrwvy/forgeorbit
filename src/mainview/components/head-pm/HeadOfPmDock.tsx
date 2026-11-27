import { requestOpenAccounts } from "@/lib/open-accounts";
import { t as tr } from "@/i18n/core";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Compass, Flame, HelpCircle, ListTodo, Loader2, RotateCcw, Send, Settings2, ShieldPlus, Sparkles, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { setDockClearance } from "../ShellDock";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "../kanban/md-components";
import { api } from "@/lib/api";
import { BrainContextPicker, type ApprovedBrain } from "../workspace/BrainContextPicker";
import { BrowserAccessPicker, BrowserActionCard } from "../workspace/browser/BrowserAccessPicker";
import { NativeAccessPicker, NativeActionCard } from "../workspace/native/NativeAccessPicker";
import { KnowledgeContextPicker, type ApprovedKnowledge } from "../workspace/KnowledgeContextPicker";
import type { KnowledgeOwnerRef } from "../../../shared/knowledge/document.ts";
import { HeadBoardProposalCard } from "./HeadBoardProposalCard";
import { headScopeKey, type HeadScope } from "../../../shared/head-pm-scope.ts";
import { MemoryProposalList, MemoryProposalOptIn, memoryProposalSendFields, type MemoryProposalOptInValue } from "../workspace/brain/MemoryProposals";
import { DelegationCard } from "../workspace/portfolio/DelegationCard";
import { PortfolioPlanCard } from "../workspace/portfolio/PortfolioPlanCard";
import { useWorkspaceDraft } from "../workspace/WorkspaceDrafts";
import {
  agentReadiness,
  canSend,
  deriveOrbStatus,
  lastOwnerFailed,
  type OrbStatus,
} from "@/lib/head-pm";
import { ownerActions, ownerActionsText, type OwnerActions } from "@/lib/owner-actions";
import type { OwnerActionsPayload } from "../../../shared/owner-actions.ts";
import type { AttentionTask } from "@/lib/attention";
import { isProjectTask, projectLabel } from "@/lib/workspace";
import { PlansWaiting } from "../workspace/manager/PlansWaiting";
import type { WorkspaceSelection } from "@/lib/workspace";
import { useHeadPm, type HeadPm } from "./useHeadPm";
import { HeadPmCoordinationSummary } from "./HeadPmCoordinationSummary";
import { HeadPmInitiativesPanel } from "./HeadPmInitiativesPanel";
import { HeadPmInitiativeProposalCard } from "./HeadPmInitiativeProposalCard";
import { MANAGER_LIMITS } from "../../../shared/project-manager.ts";
import type { DelegationView, PortfolioManagerMessage, PortfolioManagerState, PortfolioPlan } from "../../../shared/portfolio-manager.ts";
import type { Project, Task } from "../../../shared/types.ts";

interface Props {
  workspace: WorkspaceSelection;
  openRequest?: { scope: HeadScope } | null;
  projects: readonly Project[];
  tasks: readonly Task[];
  /** Hidden (not unmounted) while a full-width overlay covers the shell. */
  hidden: boolean;
  onOpenProjectManager: (projectPath: string, view?: "chat" | "inbox" | "plan" | "runs") => void;
  onOpenPortfolioManager: () => void;
  onOpenBrowser: () => void;
  onOpenNativeComputer: () => void;
  onOpenProject: (projectPath: string) => void;
  onOpenTask: (task: Task) => void;
  /** A modal sheet (New task) is open: the panel steps aside instead of competing for focus and space. */
  suspended?: boolean;
  /** What the core holds for the Owner beyond the board (approvals, held batches); null until loaded. */
  ownerRows: OwnerActionsPayload | null;
  onOwnerActionsChanged: () => void;
  /** The rail's "Needs you" page — the other half of the same facts the orb shows. */
  onOpenNeedsYou: () => void;
}

const HEAD_BRAIN_TARGET = { kind: "portfolio" } as const;

const STATUS_DOT: Record<OrbStatus, string> = {
  idle: "",
  thinking: "bg-info",
  working: "bg-success",
  "needs-owner": "bg-warning",
  error: "bg-danger",
};

function statusLabel(status: OrbStatus): string {
  switch (status) {
    case "thinking": return tr("headPm.status.thinking");
    case "working": return tr("headPm.status.working");
    case "needs-owner": return tr("headPm.status.needsOwner");
    case "error": return tr("headPm.status.error");
    default: return tr("headPm.status.idle");
  }
}

/** The workspace's one Head conversation; the scope selector controls only the next turn. */
export function HeadOfPmDock({ workspace, openRequest, projects, tasks, hidden, suspended = false, ownerRows, onOwnerActionsChanged, onOpenProjectManager, onOpenPortfolioManager, onOpenBrowser, onOpenNativeComputer, onOpenProject, onOpenTask, onOpenNeedsYou }: Props) {
  useUILocale();
  const [open, setOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [selectedScope, setSelectedScope] = useState<HeadScope | null>(null);
  const [clusters, setClusters] = useState<{ id: string; name: string; slug: string | null }[]>([]);
  const [clusterMembers, setClusterMembers] = useState<{ id: string; paths: string[] } | null>(null);
  const [scopeLoadError, setScopeLoadError] = useState(false);
  useEffect(() => {
    if (!openRequest) return;
    setSelectedScope(openRequest.scope);
    setOpen(true);
  }, [openRequest]);
  const scope: HeadScope = selectedScope ?? (workspace.scope === "project" ? { kind: "project", path: workspace.path }
    : workspace.scope === "cluster" ? { kind: "cluster", id: workspace.id } : { kind: "workspace" });
  const key = headScopeKey(scope);
  const pm = useHeadPm();
  const taskScope = scope.kind === "task" ? tasks.find((task) => task.id === scope.id) : null;
  const projectPath = scope.kind === "project" ? scope.path : taskScope?.ownerProjectPath ?? taskScope?.workdir ?? null;
  const taskOptions = projectPath ? tasks.filter((task) => !task.pipelineParentId && task.archivedAt == null && isProjectTask(task, projectPath)) : [];
  const clusterId = scope.kind === "cluster" ? scope.id : null;
  const allowedPaths = useMemo(() => projectPath ? [projectPath]
    : clusterId && clusterMembers?.id === clusterId ? clusterMembers.paths : [], [projectPath, clusterId, clusterMembers]);
  const scopeOptions: HeadScope[] = [
    { kind: "workspace" },
    ...clusters.map((cluster) => ({ kind: "cluster" as const, id: cluster.id })),
    ...projects.map((project) => ({ kind: "project" as const, path: project.path })),
    ...taskOptions.map((task) => ({ kind: "task" as const, id: task.id })),
  ];
  const knownScope = scopeOptions.some((item) => headScopeKey(item) === key);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void api.listClusters().then(({ clusters }) => {
      if (active) { setClusters(clusters); setScopeLoadError(false); }
    }, () => { if (active) setScopeLoadError(true); });
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    if (!open || !clusterId) return;
    let active = true;
    void api.listClusterProjects(clusterId).then((members) => {
      if (active) setClusterMembers({ id: clusterId, paths: members.map((item) => item.projectPath) });
    }, () => { if (active) setClusterMembers(null); });
    return () => { active = false; };
  }, [open, clusterId]);

  const orbRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Pages that scroll keep their last row clear of the orb.
  useEffect(() => {
    setDockClearance(!hidden);
    return () => setDockClearance(false);
  }, [hidden]);

  const data = pm.data;
  // The same facts as the rail's "Needs you" page: tasks + approvals + batches on hold, scoped to this context.
  const actions = useMemo(
    () => ownerActions(tasks as readonly AttentionTask[], { projectPath: projectPath, rows: ownerRows }),
    [tasks, projectPath, ownerRows],
  );
  // An approval card used in the panel changes the roll-up: re-read it.
  const approvalSignature = data ? [
    ...data.delegations.map((item) => `${item.id}:${item.status}`),
    ...(data.boardProposals ?? []).map((item) => `${item.messageId}:${item.status}`),
  ].join("|") : "";
  useEffect(() => { onOwnerActionsChanged(); }, [approvalSignature, onOwnerActionsChanged]);
  // Pending plans of the projects this conversation covers (the rows behind the Needs-you count).
  const planRows = useMemo(
    () => (ownerRows?.proposals ?? []).filter((row) => scope.kind === "workspace" || allowedPaths.includes(row.projectPath)),
    [ownerRows, scope.kind, allowedPaths],
  );
  const pending = actions.total + (data?.boardProposals ?? []).filter((item) => item.status === "pending").length;
  const failed = pm.loadError != null || (data != null && lastOwnerFailed(data.messages));
  const working = useMemo(() => tasks.some((task) =>
    task.column === "running" && !task.pipelineParentId && task.archivedAt == null
    && (!projectPath || isProjectTask(task, projectPath))), [tasks, projectPath]);
  const status = deriveOrbStatus({ thinking: pm.thinking, failed, pending, working });

  // Refresh what the panel shows each time it opens (GETs only). The Needs-you
  // roll-up (ownerRows) is re-read too: a project-manager turn can create an
  // approval outside this panel without emitting an app event, so without this
  // the orb/rail count stayed stale until the window next gained focus.
  useEffect(() => {
    if (!open) return;
    void pm.reload();
    onOwnerActionsChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Opening moves focus to the composer; a context switch while open does not.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => document.getElementById("head-pm-composer")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // An open panel re-reads when it gains focus (GET only, at most every 3s), so a message
  // sent from the Manager tab meanwhile shows up without closing the panel.
  const lastFocusReload = useRef(0);
  const onPanelFocus = () => {
    const now = Date.now();
    if (now - lastFocusReload.current < 3000) return;
    lastFocusReload.current = now;
    void pm.reload();
  };

  // New task owns the screen and the keyboard while its sheet is open.
  useEffect(() => {
    if (suspended) setOpen(false);
  }, [suspended]);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => orbRef.current?.focus());
  }, []);

  // Escape closes the panel when the key lands inside the dock or on the bare
  // page (focus is dropped to <body> while the composer is disabled mid-turn).
  // A modal dialog, an open popover, or focus elsewhere (e.g. the RunPanel)
  // keeps its own Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Node | null;
      const inside = target != null && rootRef.current?.contains(target);
      if (!inside && target !== document.body) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (rootRef.current?.querySelector("[data-popover-open]")) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div
      ref={rootRef}
      data-testid="head-pm"
      data-context={key}
      data-status={status}
      className={cn("flex flex-col items-end gap-2", hidden && "hidden")}
    >
      {open && (
        <section
          id="head-pm-panel"
          role="region"
          aria-label={tr("headPm.title")}
          onFocusCapture={onPanelFocus}
          className="glass-floating flex max-h-[min(48rem,calc(100dvh-6.5rem))] w-[min(34rem,calc(100vw-2rem))] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/80 shadow-2xl"
          data-testid="head-pm-panel"
        >
          <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-3.5 py-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
                <Sparkles className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold leading-tight">{tr("headPm.title")}</h2>
                  <label className="sr-only" htmlFor="head-pm-scope">{tr("headPm.contextLabel")}</label>
                  <select
                    id="head-pm-scope"
                    data-testid="head-pm-scope"
                    value={key}
                    disabled={pm.thinking}
                    title={tr("headPm.contextLabel")}
                    className="max-w-[11.5rem] truncate rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground/90 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onChange={(event) => setSelectedScope(scopeOptions.find((item) => headScopeKey(item) === event.target.value) ?? null)}
                  >
                    {!knownScope && <option value={key} disabled>{tr("headPm.unified.unavailable")}</option>}
                    <option value="workspace">{tr("headPm.unified.workspace")}</option>
                    {clusters.length > 0 && (
                      <optgroup label={tr("headPm.unified.clusters")}>
                        {clusters.map((cluster) => (
                          <option key={cluster.id} value={`cluster:${cluster.id}`}>
                            {cluster.name}{clusters.filter((item) => item.name === cluster.name).length > 1 ? ` (${cluster.slug || cluster.id.slice(0, 8)})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {projects.length > 0 && (
                      <optgroup label={tr("headPm.unified.projects")}>
                        {projects.map((project) => (
                          <option key={project.path} value={`project:${project.path}`}>
                            {project.name}{projects.filter((item) => item.name === project.name).length > 1 ? ` (${project.path})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {taskOptions.length > 0 && (
                      <optgroup label={tr("headPm.unified.tasks")}>
                        {taskOptions.map((task) => (
                          <option key={task.id} value={`task:${task.id}`}>{task.title} · #{task.id.slice(0, 8)}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                {scopeLoadError && (
                  <p role="status" className="mt-0.5 text-[11px] text-muted-foreground">{tr("headPm.unified.clusterError")}</p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("size-7 text-muted-foreground hover:text-foreground", guideOpen && "bg-accent text-foreground")}
                onClick={() => setGuideOpen((v) => !v)}
                aria-label={tr("headPm.guide.toggle")}
                title={tr("headPm.guide.toggle")}
                aria-expanded={guideOpen}
                data-testid="head-pm-guide-toggle"
              >
                <HelpCircle className="size-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => { close(); onOpenPortfolioManager(); }}
                aria-label={tr("headPm.unified.settings")}
                title={tr("headPm.unified.settings")}
                data-testid="head-pm-open-full"
              >
                <Settings2 className="size-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={close}
                aria-label={tr("headPm.close")}
                data-testid="head-pm-close"
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          </header>

          {guideOpen && (
            <div className="space-y-2.5 border-b border-border/70 bg-muted/30 px-4 py-3 text-xs" data-testid="head-pm-guide-panel">
              <div>
                <p className="font-semibold text-foreground">{tr("headPm.guide.title")}</p>
                <p className="mt-0.5 text-muted-foreground" data-testid="head-pm-safety">{tr("headPm.guide.subtitle")}</p>
              </div>
              <ol className="space-y-1.5 text-foreground/90">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">1</span>
                  <span>{tr("headPm.guide.step1")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">2</span>
                  <span>{tr("headPm.guide.step2")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">3</span>
                  <span>{tr("headPm.guide.step3")}</span>
                </li>
              </ol>
              <details className="pt-0.5 text-[11px] text-muted-foreground" data-testid="head-pm-owner-channel-details">
                <summary className="cursor-pointer select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {tr("runtime.notice.more")}
                </summary>
                <p className="mt-1" data-testid="head-pm-owner-channel">{tr("runtime.owner_channel")}</p>
              </details>
            </div>
          )}

          <HeadPmChat
            pm={pm}
            scope={scope}
            scopeReady={knownScope}
            knowledgeClusterId={clusterId}
            onOpenBrowser={onOpenBrowser}
            onOpenNativeComputer={onOpenNativeComputer}
            allowedPaths={allowedPaths}
            tasks={tasks}
            actions={actions}
            planRows={planRows}
            onOpenNeedsYou={() => { close(); onOpenNeedsYou(); }}
            onOpenFull={() => { close(); onOpenPortfolioManager(); }}
            onOpenProject={(path) => { close(); onOpenProject(path); }}
            onOpenProjectManager={(path, view) => { close(); onOpenProjectManager(path, view); }}
            onOpenTask={onOpenTask}
            coordinationRefresh={`${approvalSignature}|${data?.messages.length ?? 0}|${tasks.map((task) => `${task.id}:${task.column}:${task.qcState?.latestVerdict ?? ""}`).join("|")}`}
            projects={projects}
          />
        </section>
      )}

      <button
        ref={orbRef}
        type="button"
        className="glass-floating relative grid size-11 shrink-0 place-items-center rounded-full border text-foreground shadow-lg transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:hover:scale-105"
        aria-label={open ? tr("headPm.orbClose") : tr("headPm.orbOpen")}
        aria-expanded={open}
        aria-controls={open ? "head-pm-panel" : undefined}
        title={`${tr("headPm.statusLabel", { status: statusLabel(status) })}${actions.total > 0 ? ` — ${ownerActionsText(actions)}` : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="head-pm-orb"
        data-status={status}
      >
        <Sparkles className="size-5" aria-hidden />
        {status === "thinking" && (
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full border-2 border-transparent border-t-info motion-safe:animate-spin" data-testid="head-pm-orb-spinner" />
        )}
        {status !== "idle" && (
          <span
            aria-hidden
            className={cn("absolute -right-0.5 -top-0.5 grid min-w-3 place-items-center rounded-full border-2 border-background px-0.5 text-[9px] font-semibold leading-none text-white", STATUS_DOT[status], status === "needs-owner" ? "h-4" : "size-3")}
            data-testid="head-pm-orb-dot"
          >
            {status === "needs-owner" && pending > 0 ? (pending > 9 ? "9+" : pending) : null}
          </span>
        )}
      </button>
      <span role="status" className="sr-only" data-testid="head-pm-status">{tr("headPm.statusLabel", { status: statusLabel(status) })}</span>
    </div>
  );
}

function HeadPmChat({ pm, scope, scopeReady, knowledgeClusterId, allowedPaths, tasks, projects, actions, planRows, onOpenNeedsYou, onOpenFull, onOpenProject, onOpenProjectManager, onOpenTask, onOpenBrowser, onOpenNativeComputer, coordinationRefresh }: {
  pm: HeadPm;
  scope: HeadScope;
  scopeReady: boolean;
  knowledgeClusterId: string | null;
  allowedPaths: string[];
  tasks: readonly Task[];
  projects: readonly Project[];
  actions: OwnerActions;
  planRows: readonly import("../../../shared/owner-actions.ts").OwnerActionRow[];
  onOpenNeedsYou: () => void;
  onOpenFull: () => void;
  onOpenProject: (path: string) => void;
  onOpenProjectManager: (path: string, view?: "chat" | "inbox" | "plan" | "runs") => void;
  onOpenTask: (task: Task) => void;
  onOpenBrowser: () => void;
  onOpenNativeComputer: () => void;
  coordinationRefresh: string;
}) {
  useUILocale();
  const key = headScopeKey(scope);
  const [composer, setComposer] = useWorkspaceDraft("head-pm:unified:composer", "");
  const [brainState, setBrainState] = useState<{ key: string; grant: ApprovedBrain } | null>(null);
  const brain = brainState?.key === key ? brainState.grant : null;
  const [knowledgeState, setKnowledgeState] = useState<{ key: string; grant: ApprovedKnowledge } | null>(null);
  const knowledge = knowledgeState?.key === key ? knowledgeState.grant : null;
  const allowKnowledgeOwner = useMemo(() => {
    const paths = new Set(allowedPaths);
    return (owner: KnowledgeOwnerRef) => owner.kind === "company"
      || (owner.kind === "project" && paths.has(owner.id))
      || (owner.kind === "cluster" && owner.id === knowledgeClusterId);
  }, [allowedPaths, knowledgeClusterId]);
  const [browserGrantId, setBrowserGrantId] = useState<string | null>(null);
  const [nativeGrantId, setNativeGrantId] = useState<string | null>(null);
  const allowedProjects = projects.filter((project) => allowedPaths.includes(project.path));
  const [memoryOptIn, setMemoryOptIn] = useState<MemoryProposalOptInValue>({ allow: false, company: false, projectPaths: [] });
  const [accessOpen, setAccessOpen] = useState(false);
  const [focusInitiativeId, setFocusInitiativeId] = useState<string | null>(null);
  const [focusInitiativeRequest, setFocusInitiativeRequest] = useState(0);
  const focusInitiative = (id: string) => {
    setFocusInitiativeId(id);
    setFocusInitiativeRequest((request) => request + 1);
  };
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const { data } = pm;
  const readiness = data ? agentReadiness(data.config) : { configured: false, needsConsent: false };
  const busy = pm.thinking;
  const allowed = canSend({ text: composer, busy, readiness, loaded: data != null && scopeReady });

  // The composer is disabled during a turn, which drops focus to <body>: put it back.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && document.activeElement === document.body) composerRef.current?.focus();
    wasBusy.current = busy;
  }, [busy]);
  const latestMessageId = data?.messages.at(-1)?.id;
  const pendingProposal = data?.boardProposals?.find((item) => item.messageId === latestMessageId && item.status === "pending")?.messageId;
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const latest = log.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(latestMessageId ?? "")}"]`);
    const anchor = pendingProposal ? latest?.querySelector<HTMLElement>('[data-testid="head-pm-board-proposal"]') : latest;
    if (anchor && (pendingProposal || anchor.offsetHeight > log.clientHeight)) {
      log.scrollTop += anchor.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }, [latestMessageId, pendingProposal, data?.activeTurn?.id]);

  useEffect(() => {
    setBrainState(null);
    setKnowledgeState(null);
    setBrowserGrantId(null);
    setNativeGrantId(null);
    setMemoryOptIn({ allow: false, company: false, projectPaths: [] });
  }, [key]);

  const submit = async () => {
    const text = composer.trim();
    if (!allowed || !text) return;
    const sent = await pm.send({ text, scope, ...memoryProposalSendFields(memoryOptIn),
      ...(brain ? { brainGrantId: brain.grantId } : {}),
      ...(knowledge ? { knowledgeGrantId: knowledge.grantId } : {}),
      ...(scope.kind === "workspace" && browserGrantId ? { browserGrantId } : {}),
      ...(scope.kind === "workspace" && nativeGrantId ? { nativeGrantId } : {}),
    });
    // A failed send may have already spent its one-turn grant.
    setBrainState(null);
    setKnowledgeState(null);
    setBrowserGrantId(null);
    setNativeGrantId(null);
    if (sent) {
      setComposer("");
      setMemoryOptIn({ allow: false, company: false, projectPaths: [] });
    }
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  if (!data) {
    return (
      <div className="px-3 py-4 text-sm text-muted-foreground" data-testid="head-pm-loading" role={pm.loadError ? "alert" : "status"}>
        {pm.loadError
          ? tr("headPm.loadError", { message: pm.loadError })
          : <span className="flex items-center gap-2"><Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />{tr("headPm.loading")}</span>}
      </div>
    );
  }

  const isProject = scope.kind === "project" || scope.kind === "task";
  const messages = data.messages;
  const lastOwner = [...messages].reverse().find((message) => message.role === "owner");
  const retryable = lastOwner?.headScope && (lastOwner.status === "failed" || lastOwner.status === "cancelled") ? lastOwner : null;
  const activeMessageId = data.activeTurn?.messageId ?? null;

  const updateDelegation = (view: DelegationView) => {
    pm.mutate((current) => ({ ...current, delegations: current.delegations.map((item) => item.id === view.id ? view : item) }));
    void pm.reload();
  };
  const updatePlan = (plan: PortfolioPlan) => {
    pm.mutate((current) => ({ ...current, plans: current.plans.map((item) => item.id === plan.id ? plan : item) }));
    void pm.reload();
  };
  const updateInitiativeProposal = (proposal: import("../../../shared/head-pm-initiative-proposal.ts").HeadPmInitiativeProposal) => {
    pm.mutate((current) => ({ ...current, initiativeProposals: (current.initiativeProposals ?? []).map((item) => item.id === proposal.id ? proposal : item) }));
    if (proposal.status === "approved" && proposal.initiativeId) focusInitiative(proposal.initiativeId);
    void pm.reload();
  };
  const proposals = new Map(data.boardProposals?.map((item) => [item.messageId, item]));
  const activeAccessCount =
    (brain ? 1 : 0) +
    (knowledge ? 1 : 0) +
    (scope.kind === "workspace" && browserGrantId ? 1 : 0) +
    (scope.kind === "workspace" && nativeGrantId ? 1 : 0) +
    (memoryOptIn.allow ? 1 : 0);
  const quickStarters = [
    { id: "status", label: tr("headPm.quick.status"), prompt: tr("headPm.quick.statusPrompt"), icon: Compass },
    { id: "plan", label: tr("headPm.quick.plan"), prompt: tr("headPm.quick.planPrompt"), icon: ListTodo },
    { id: "priorities", label: tr("headPm.quick.priorities"), prompt: tr("headPm.quick.prioritiesPrompt"), icon: Flame },
    { id: "attention", label: tr("headPm.quick.attention"), prompt: tr("headPm.quick.attentionPrompt"), icon: Sparkles },
  ];
  const pickStarter = (promptText: string) => {
    setComposer(promptText);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  return (
    <>
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label={tr("headPm.history")}
        tabIndex={0}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3.5"
        data-testid="head-pm-log"
      >
        {!isProject && (
          <>
            <HeadPmCoordinationSummary refreshToken={coordinationRefresh} onOpenProject={onOpenProject} />
            <HeadPmInitiativesPanel
              refreshToken={coordinationRefresh}
              focusInitiativeId={focusInitiativeId}
              focusRequest={focusInitiativeRequest}
              delegations={data.delegations}
              onDelegationChanged={updateDelegation}
              onOpenProject={onOpenProject}
              onOpenProjectManager={onOpenProjectManager}
              onOpenTask={(taskId, projectPath) => {
                const task = tasks.find((t) => t.id === taskId && t.workdir === projectPath);
                if (task) onOpenTask(task);
              }}
              onOpenNeedsYou={onOpenNeedsYou}
            />
          </>
        )}
        {messages.length === 0 && (
          <div className="space-y-3.5 py-2" data-testid="head-pm-empty">
            <div className="rounded-xl border border-border/60 bg-muted/25 p-3.5 text-xs">
              <p className="text-sm font-semibold text-foreground">{tr("headPm.guide.title")}</p>
              <p className="mt-1 leading-relaxed text-muted-foreground">{tr("headPm.guide.subtitle")}</p>
              <ol className="mt-2.5 space-y-1.5 text-foreground/90">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">1</span>
                  <span>{tr("headPm.guide.step1")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">2</span>
                  <span>{tr("headPm.guide.step2")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">3</span>
                  <span>{tr("headPm.guide.step3")}</span>
                </li>
              </ol>
            </div>
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{tr("headPm.quick.label")}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {quickStarters.map(({ id, label, prompt, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    data-testid="head-pm-example"
                    onClick={() => pickStarter(prompt)}
                    className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-brand/40 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon className="size-3.5 shrink-0 text-brand" aria-hidden />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className="min-w-0" data-message-id={message.id} data-testid="head-pm-message" data-role={message.role}>
            {message.role === "system" ? (
              <p className="text-center text-[11px] text-muted-foreground">{message.text}</p>
            ) : message.role === "owner" ? (
              <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-brand/25 bg-brand/12 px-3.5 py-2 text-sm" data-status={message.status ?? ""}>
                {message.headScope && (
                  <span className="mb-1 inline-block rounded bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" data-testid="head-pm-message-scope">
                    {message.headScope.scope.kind === "workspace" ? tr("headPm.unified.workspace") : message.headScope.label}
                  </span>
                )}
                <p className="whitespace-pre-wrap break-words leading-relaxed">{message.text}</p>
                {message.nativeAction && <div className="mt-2"><NativeActionCard action={message.nativeAction} onOpenNativeComputer={onOpenNativeComputer} /></div>}
              </div>
            ) : (
              <div className="space-y-2">
                {message.text.trim().length > 0 && (
                  <div className="rounded-2xl rounded-bl-sm bg-muted/45 px-3.5 py-2.5 text-sm leading-relaxed">
                    <div className="agetor-md break-words" data-testid="head-pm-reply">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
                        {message.text}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                <MemoryProposalList messageId={message.id} />
                {message.browserAction && <BrowserActionCard action={message.browserAction} onOpenBrowser={onOpenBrowser} />}
                {message.nativeAction && <NativeActionCard action={message.nativeAction} onOpenNativeComputer={onOpenNativeComputer} />}
                {proposals.has(message.id) && <HeadBoardProposalCard
                  proposal={proposals.get(message.id)!}
                  onChange={(next) => {
                    pm.mutate((current) => ({ ...current, boardProposals: current.boardProposals?.map((item) => item.messageId === next.messageId ? next : item) }));
                    void pm.reload();
                  }}
                  onOpenProject={onOpenProject}
                  tasks={tasks}
                  onOpenTaskRecord={onOpenTask}
                  onOpenTask={async (id) => {
                    // A task the Head just created may not be in the polled list yet: read it rather than only
                    // opening the project and leaving the Owner without the task panel.
                    const task = tasks.find((item) => item.id === id) ?? await api.getTask(id).catch(() => null);
                    if (!task) return false;
                    onOpenTask(task);
                    return true;
                  }}
                />}
                {message.headScope && message.sources.length > 0 && (
                  <details className="px-1 text-[11px] text-muted-foreground/75" data-testid="head-pm-sources">
                    <summary className="cursor-pointer select-none hover:text-foreground">{tr("headPm.sources")}</summary>
                    <ul className="mt-1 space-y-0.5 pl-3">{message.sources.map((source) => <li key={source.id}>{source.label}{source.detail && ` · ${source.detail}`}</li>)}</ul>
                  </details>
                )}
                <PortfolioExtras
                  message={message}
                  data={data}
                  onPlan={updatePlan}
                  onDelegation={updateDelegation}
                  onInitiativeProposal={updateInitiativeProposal}
                  onOpenInitiative={focusInitiative}
                  onOpenProject={onOpenProject}
                  onOpenProjectManager={onOpenProjectManager}
                />
              </div>
            )}
            {activeMessageId === message.id && (
              <p className="mt-1 text-right text-[11px] text-muted-foreground">{tr("headPm.answering")}</p>
            )}
          </div>
        ))}
        {pm.thinking && (
          <div role="status" className="inline-flex items-center gap-2 rounded-2xl bg-muted/45 px-3 py-2 text-xs text-muted-foreground" data-testid="head-pm-busy">
            <Loader2 className="size-3.5 motion-safe:animate-spin text-brand" aria-hidden />
            <span>{tr("headPm.answering")}</span>
          </div>
        )}
      </div>

      <footer className="max-h-[48%] shrink-0 space-y-2 overflow-y-auto overscroll-contain border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-3.5 py-2.5">
        <PlansWaiting
          rows={planRows}
          projectName={(path) => { const project = projects.find((item) => item.path === path); return project ? projectLabel(project) : path; }}
          onReview={(path) => onOpenProjectManager(path, "inbox")}
        />
        {actions.total > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px]" data-testid="head-pm-owner-actions">
            <span className="min-w-0 flex-1 font-medium text-warning" data-testid="head-pm-pending">{ownerActionsText(actions)}</span>
            <button type="button" className="glass-nav-item shrink-0 rounded px-1.5 py-0.5 underline decoration-dotted" onClick={onOpenNeedsYou} data-testid="head-pm-open-needs-you">{tr("uxfix.owner.open")}</button>
          </div>
        )}
        {!readiness.configured && (
          <SetupNote text={tr("headPm.setup")} onAction={onOpenFull} testId="head-pm-setup" />
        )}
        {readiness.configured && readiness.needsConsent && (
          <SetupNote text={tr("headPm.consent")} onAction={onOpenFull} testId="head-pm-consent" />
        )}
        {pm.error && (
          <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger" data-testid="head-pm-error">{pm.error}</p>
        )}
        {retryable && !busy && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger" data-testid="head-pm-turn-error">
            <span className="min-w-0 flex-1 break-words">
              {retryable.status !== "cancelled" && retryable.providerRefusal
                ? <ProviderRefusalNotice refusal={retryable.providerRefusal} testId="head-pm-provider-refusal" onOpenAccount={requestOpenAccounts} />
                : retryable.status === "cancelled" ? tr("headPm.cancelled") : retryable.error ?? tr("headPm.noAnswer")}
            </span>
            <Button type="button" size="sm" variant="outline" disabled={!readiness.configured || readiness.needsConsent} onClick={() => void pm.send({ retryMessageId: retryable.id })} data-testid="head-pm-retry">
              <RotateCcw className="size-3.5" aria-hidden />{tr("headPm.retry")}
            </Button>
          </div>
        )}

        {/* Quick-start chips stay handy even when chat history exists */}
        {messages.length > 0 && !composer.trim() && !busy && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" data-testid="head-pm-quick-chips">
            {quickStarters.map(({ id, label, prompt }) => (
              <button
                key={id}
                type="button"
                onClick={() => pickStarter(prompt)}
                className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-brand/40 hover:bg-accent/60 hover:text-foreground"
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Optional one-turn access panel — hidden by default until user clicks "Доступ" */}
        {(accessOpen || activeAccessCount > 0) && (
          <div key={key} className="space-y-2 rounded-xl border border-border/70 bg-muted/25 p-2.5 text-xs" data-testid="head-pm-turn-access-panel">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{tr("headPm.unified.turnAccess")}</span>
              <button
                type="button"
                onClick={() => setAccessOpen(false)}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {tr("headPm.board.hideDetails")}
              </button>
            </div>
            <BrainContextPicker key={JSON.stringify([key, allowedPaths])} target={HEAD_BRAIN_TARGET} grant={brain}
              onGrantChange={(grant) => setBrainState(grant ? { key, grant } : null)}
              allowedProjectPaths={allowedPaths} disabled={busy} testId="head-pm-brain" />
            <MemoryProposalOptIn
              mode="portfolio"
              projects={allowedProjects.map((project) => ({ path: project.path, name: project.name }))}
              value={memoryOptIn}
              onChange={setMemoryOptIn}
              disabled={busy}
              testId="head-pm-memory-proposals"
            />
            <KnowledgeContextPicker target={HEAD_BRAIN_TARGET} grant={knowledge}
              onGrantChange={(grant) => setKnowledgeState(grant ? { key, grant } : null)}
              allowOwner={allowKnowledgeOwner} disabled={busy} testId="head-pm-knowledge" />
            {scope.kind === "workspace" && <>
              <p className="mt-1 text-[11px] text-muted-foreground" data-testid="head-pm-cu-access-note">{tr("access.cu.cu-full-computer-grant-note")}</p>
              <BrowserAccessPicker managerKind="head-of-pm" grantId={browserGrantId} onGrantChange={setBrowserGrantId}
                onOpenBrowser={onOpenBrowser} disabled={busy} testId="head-pm-browser" />
              <NativeAccessPicker managerKind="head-of-pm" grantId={nativeGrantId} onGrantChange={setNativeGrantId}
                onOpenNativeComputer={onOpenNativeComputer} disabled={busy} testId="head-pm-native" />
            </>}
          </div>
        )}

        {/* Unified sleek chat composer */}
        <div className="rounded-2xl border border-border/80 bg-background/85 p-2 transition-colors focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/25">
          <label htmlFor="head-pm-composer" className="sr-only">{tr("headPm.composerLabel")}</label>
          <Textarea
            id="head-pm-composer"
            ref={composerRef}
            value={composer}
            rows={2}
            className="min-h-[2.75rem] resize-none border-0 bg-transparent px-1.5 py-1 text-sm shadow-none focus-visible:ring-0"
            maxLength={MANAGER_LIMITS.messageChars}
            placeholder={tr("headPm.composerPlaceholderSimple")}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={onComposerKey}
            disabled={busy}
            data-testid="head-pm-composer"
          />
          <div className="mt-1 flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setAccessOpen((v) => !v)}
              data-testid="head-pm-turn-access-toggle"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
                accessOpen || activeAccessCount > 0
                  ? "bg-brand/15 text-brand"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <ShieldPlus className="size-3.5" aria-hidden />
              <span>{tr("headPm.accessButton")}</span>
              {activeAccessCount > 0 && (
                <span className="rounded-full bg-brand px-1.5 text-[10px] text-white">{activeAccessCount}</span>
              )}
            </button>
            <div className="flex items-center gap-1.5">
              {data.activeTurn ? (
                <Button type="button" size="sm" variant="outline" className="h-7 rounded-xl px-2.5 text-xs" onClick={pm.cancel} data-testid="head-pm-cancel">
                  <Square className="size-3" aria-hidden />{tr("headPm.cancel")}
                </Button>
              ) : (
                <Button type="button" size="sm" className="h-7 rounded-xl px-3 text-xs" onClick={() => void submit()} disabled={!allowed} data-testid="head-pm-send">
                  <Send className="size-3" aria-hidden />{pm.sending ? tr("headPm.sending") : tr("headPm.send")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}

function SetupNote({ text, onAction, testId }: { text: string; onAction: () => void; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning" data-testid={testId}>
      <span className="min-w-0 flex-1">{text}</span>
      <Button type="button" size="sm" variant="outline" onClick={onAction}>{tr("headPm.setupAction")}</Button>
    </div>
  );
}

function PortfolioExtras({ message, data, onPlan, onDelegation, onInitiativeProposal, onOpenInitiative, onOpenProject, onOpenProjectManager }: {
  message: PortfolioManagerMessage;
  data: PortfolioManagerState;
  onPlan: (plan: PortfolioPlan) => void;
  onDelegation: (view: DelegationView) => void;
  onInitiativeProposal: (proposal: import("../../../shared/head-pm-initiative-proposal.ts").HeadPmInitiativeProposal) => void;
  onOpenInitiative: (initiativeId: string) => void;
  onOpenProject: (path: string) => void;
  onOpenProjectManager: (path: string) => void;
}) {
  const plan = message.planId ? data.plans.find((item) => item.id === message.planId) ?? null : null;
  const delegations = data.delegations.filter((item) => message.delegationIds.includes(item.id));
  const initiativeProposal = message.initiativeProposalId
    ? (data.initiativeProposals ?? []).find((item) => item.id === message.initiativeProposalId) ?? null
    : null;
  return (
    <>
      {message.protocolErrors.length > 0 && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">{message.protocolErrors.join(" ")}</p>
      )}
      {plan && <PortfolioPlanCard plan={plan} onChanged={onPlan} onOpenProject={onOpenProject} />}
      {initiativeProposal && (
        <HeadPmInitiativeProposalCard
          proposal={initiativeProposal}
          onChanged={onInitiativeProposal}
          onOpenInitiative={onOpenInitiative}
          onOpenProject={onOpenProject}
        />
      )}
      {delegations.map((delegation) => (
        <DelegationCard key={delegation.id} delegation={delegation} onChanged={onDelegation} onOpenProjectManager={onOpenProjectManager} />
      ))}
    </>
  );
}
