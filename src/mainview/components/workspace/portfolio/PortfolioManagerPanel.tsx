import { requestOpenAccounts } from "@/lib/open-accounts";
import { t as tr } from "@/i18n/core";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookmarkPlus, Globe2, Loader2, Square, Trash2 } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { BrowserActionCard } from "../browser/BrowserAccessPicker";
import { NativeActionCard } from "../native/NativeAccessPicker";
import { MemoryProposalList } from "../brain/MemoryProposals";
import { cn } from "@/lib/utils";
import { pendingDelegations, portfolioConnection } from "@/lib/portfolio-manager";
import { createLatestLoader, subscribePortfolioManagerSignals } from "@/lib/portfolio-manager-events";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "../../kanban/md-components";
import { useWorkspaceDraft } from "../WorkspaceDrafts";
import { ManagerAgentPanel, type ManagerAgentStatus } from "../manager/ManagerAgentPanel";
import { DelegationCard } from "./DelegationCard";
import { PortfolioPlanCard } from "./PortfolioPlanCard";
import {
  PORTFOLIO_MANAGER_LIMITS,
  type DelegationView,
  type PortfolioManagerMessage,
  type PortfolioManagerState,
  type PortfolioPlan,
} from "../../../../shared/portfolio-manager.ts";
import type { ContextSource, ManagerConfig } from "../../../../shared/project-manager.ts";

const POLL_MS = 700;
/** Events in a burst (approve → sent → answered) collapse into one re-read. */
const SYNC_DEBOUNCE_MS = 120;

const SOURCE_TONE: Record<ContextSource["status"], string> = {
  included: "text-success",
  truncated: "text-warning",
  missing: "text-muted-foreground",
  skipped: "text-warning",
};

const SOURCE_LABEL: Record<ContextSource["status"], string> = {
  get included() { return tr("common.included"); },
  get truncated() { return tr("common.partial_a4d50f"); },
  get missing() { return tr("common.none_dc937b"); },
  get skipped() { return tr("common.skipped_12698c"); },
};

interface Props {
  onOpenHead: () => void;
  onOpenProjectManager: (projectPath: string) => void;
  onOpenProject: (projectPath: string) => void;
  onOpenSettingsAgents: () => void;
  onOpenBrowser?: () => void;
  onOpenNativeComputer?: () => void;
}

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

/** Head settings and historical portfolio workflows; the dock owns new messages. */
export function PortfolioManagerPanel({ onOpenHead, onOpenProjectManager, onOpenProject, onOpenSettingsAgents, onOpenBrowser, onOpenNativeComputer }: Props) {
  useUILocale();
  const [state, setState] = useState<PortfolioManagerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sources, setSources] = useState<ContextSource[] | null>(null);
  const [decisionDraft, setDecisionDraft] = useWorkspaceDraft("portfolio-manager:decision", "");
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<ManagerAgentStatus>({ problem: "Loading agents…", needsConsent: false, label: null, model: null });
  const logRef = useRef<HTMLDivElement>(null);
  // Every re-read goes through one loader: coalesced, and only the newest
  // answer is applied, so a slow stale response can't overwrite a newer one.
  const loaderRef = useRef<ReturnType<typeof createLatestLoader<PortfolioManagerState>> | null>(null);
  const reload = useCallback(async () => {
    await loaderRef.current?.request();
  }, []);

  const reloadSources = useCallback(() => {
    void api.portfolioManagerContext().then((result) => setSources(result.sources), () => setSources(null));
  }, []);

  useEffect(() => {
    const loader = createLatestLoader(
      () => api.getPortfolioManager(),
      (next) => {
        setState(next);
        setLoadError(null);
      },
      (reason) => setLoadError(messageOf(reason)),
    );
    loaderRef.current = loader;
    void loader.request();
    reloadSources();
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [reloadSources]);

  // Delegation updates arrive on the app's shared event stream (ids and
  // status only); the state is then re-read from the core. A reconnect, the
  // window regaining focus or the tab becoming visible re-syncs too, since
  // events sent meanwhile are lost. No timer polls the delegations.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sync = (withSources: boolean) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reload();
        if (withSources) reloadSources();
      }, SYNC_DEBOUNCE_MS);
    };
    const unsubscribe = subscribePortfolioManagerSignals((signal) => sync(signal.kind === "reconnect"));
    const onFocus = () => sync(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, reloadSources]);

  const activeTurn = state?.activeTurn ?? null;

  useEffect(() => {
    if (!activeTurn) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const turn = await api.getPortfolioTurn(activeTurn.id);
        if (stopped) return;
        if (turn.status === "running") {
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        await reload();
        reloadSources();
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
  }, [activeTurn?.id, reload, reloadSources]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state?.messages.length, activeTurn?.id]);

  const cancel = () => {
    if (activeTurn) void api.cancelPortfolioTurn(activeTurn.id).catch(() => {});
  };

  const updateDelegation = (view: DelegationView) => {
    // A re-read already in flight predates this answer: drop it.
    loaderRef.current?.invalidate();
    setState((current) => current && ({ ...current, delegations: current.delegations.map((item) => (item.id === view.id ? view : item)) }));
    void reload();
  };

  const updatePlan = (plan: PortfolioPlan) => {
    loaderRef.current?.invalidate();
    setState((current) => current && ({ ...current, plans: current.plans.map((item) => (item.id === plan.id ? plan : item)) }));
    void reload();
  };

  const remember = async (text: string, source: "owner" | "manager") => {
    try {
      await api.addPortfolioDecision(text, source);
      await reload();
      reloadSources();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const forget = async (id: string) => {
    try {
      await api.deletePortfolioDecision(id);
      await reload();
      reloadSources();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const setConfig = (config: ManagerConfig) => setState((current) => current && { ...current, config });

  if (loadError && !state) {
    return (
      <div className="px-4 py-6" data-testid="portfolio-manager">
        <p role="alert" className="text-sm text-destructive" data-testid="portfolio-manager-load-error">{loadError}</p>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground" data-testid="portfolio-manager" role="status">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /><I18nText id="portfolio.loading_the_portfolio_manager" />{" "}</div>
    );
  }

  const decided = new Set(state.decisions.map((item) => item.text.toLowerCase()));
  const connection = portfolioConnection({ answering: activeTurn != null, problem: agent.problem, needsConsent: agent.needsConsent });
  const waiting = pendingDelegations(state.delegations);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size] [container-name:workspace]">
      <div className="manager-page flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" data-testid="portfolio-manager">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
          <p className="text-muted-foreground">{tr("headPm.unified.portfolioNotice")}</p>
          <Button type="button" size="sm" variant="outline" onClick={onOpenHead}>{tr("headPm.unified.openHead")}</Button>
        </div>
        <div className="manager-columns grid min-h-0 min-w-0 flex-1 gap-4">
          <section className="manager-chat surface-solid flex min-h-[28rem] min-w-0 flex-col rounded-xl border" aria-label={tr("portfolio.portfolio_manager_chat")}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Globe2 className="size-4" aria-hidden />{tr("headPm.unified.history")}</h2>
                <p className="break-words text-xs text-muted-foreground" data-testid="portfolio-manager-head">
                  {state.headBinding?.status === "bound" && state.headBinding.head
                    ? tr("common.head", { p0: String(state.headBinding.head.name), p1: String(state.headBinding.head.employeeId) })
                    : tr("common.head_binding_legacy_manager_mode", { p0: String(state.headBinding?.status === "invalid" ? tr("common.invalid_owner_confirmation_required") : tr("common.unbound")) })}
                </p>
                <p className="truncate text-xs text-muted-foreground" data-testid="portfolio-manager-agent-label"><I18nText id="portfolio.all_registered_projects" />{agent.label ? ` · ${agent.label}` : ""}{agent.model ? ` · ${agent.model}` : ""}
                </p>
              </div>
              <span className={cn("text-xs font-medium", connection.tone)} role="status" data-testid="portfolio-manager-connection">
                {connection.label}
              </span>
            </header>

            <div
              ref={logRef}
              role="log"
              aria-live="polite"
              aria-label={tr("portfolio.portfolio_manager_messages")}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
              data-testid="portfolio-manager-log"
            >
              {state.messages.length === 0 && (
                <div className="space-y-2 text-sm text-muted-foreground" data-testid="portfolio-manager-empty">
                  <p>{tr("headPm.unified.historyEmpty")}</p>
                </div>
              )}
              {state.messages.map((message) => (
                <div key={message.id} className="min-w-0">
                {message.role === "manager" && message.attribution?.head && <p className="break-words text-[11px] text-muted-foreground" data-testid="portfolio-reply-head"><I18nText id="portfolio.head_at_turn" />{" "}{message.attribution.head.name} · {message.attribution.head.employeeId}</p>}
                <MessageRow
                  key={message.id}
                  message={message}
                  pending={activeTurn?.messageId === message.id}
                  plan={message.planId ? state.plans.find((item) => item.id === message.planId) ?? null : null}
                  delegations={state.delegations.filter((item) => message.delegationIds.includes(item.id))}
                  decided={decided}
                  onPlan={updatePlan}
                  onDelegation={updateDelegation}
                  onOpenProject={onOpenProject}
                  onOpenProjectManager={onOpenProjectManager}
                  onRemember={(text) => void remember(text, "manager")}
                  onOpenBrowser={onOpenBrowser}
                  onOpenNativeComputer={onOpenNativeComputer}
                />
                </div>
              ))}
              {activeTurn && (
                <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="portfolio-manager-busy">
                  <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /><I18nText id="portfolio.the_portfolio_manager_is_reading_the_portfolio_and" />{" "}</p>
              )}
            </div>

            {(error || activeTurn) && (
              <footer className="space-y-2 border-t px-4 py-3">
                {error && <p role="alert" className="text-xs text-danger">{error}</p>}
                {activeTurn && (
                  <Button type="button" size="sm" variant="outline" onClick={cancel} data-testid="portfolio-manager-cancel">
                    <Square className="size-3.5" aria-hidden /><I18nText id="common.cancel_request" />
                  </Button>
                )}
              </footer>
            )}
          </section>

          <aside className="manager-context flex min-w-0 flex-col gap-4" aria-label={tr("portfolio.portfolio_manager_settings_and_context")}>
            {waiting.length > 0 && (
              <section className="surface-solid rounded-xl border px-4 py-3" data-testid="portfolio-manager-pending">
                <h3 className="mb-1 text-sm font-medium"><I18nText id="portfolio.waiting_for_your_approval" /></h3>
                <ul className="space-y-1 text-xs">
                  {waiting.map((item) => (
                    <li key={item.id} className="min-w-0">
                      <button
                        type="button"
                        className="block w-full min-w-0 truncate text-left hover:underline"
                        title={`${item.projectName}: ${item.objective}`}
                        onClick={() => document.getElementById(`delegation-${item.id}-title`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
                      >
                        {item.projectName}: {item.objective}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="surface-solid rounded-xl border px-4 py-3">
              <h3 className="mb-2 text-sm font-medium"><I18nText id="common.agent" /></h3>
              <ManagerAgentPanel
                variant="portfolio"
                idPrefix="portfolio-manager"
                onSave={(config) => api.savePortfolioManagerConfig(config)}
                config={state.config}
                busy={activeTurn != null}
                onConfigChange={setConfig}
                onStatus={setAgent}
                onManageAgents={onOpenSettingsAgents}
              />
            </section>

            <section className="surface-solid rounded-xl border px-4 py-3" data-testid="portfolio-manager-sources">
              <h3 className="mb-2 text-sm font-medium"><I18nText id="portfolio.context_sources" /></h3>
              {sources == null ? (
                <p className="text-xs text-muted-foreground"><I18nText id="common.reading_what_the_manager_can_see" /></p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {sources.map((source) => (
                    <li key={source.id} data-testid="portfolio-manager-source" data-source={source.id} data-status={source.status}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{source.label}</span>
                        <span className={cn("shrink-0 text-[11px]", SOURCE_TONE[source.status])}>{SOURCE_LABEL[source.status]}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{source.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground"><I18nText id="portfolio.only_the_prepared_portfolio_summary_is_sent_project" />{" "}</p>
            </section>

            <section className="surface-solid rounded-xl border px-4 py-3" data-testid="portfolio-manager-decisions">
              <h3 className="mb-2 text-sm font-medium"><I18nText id="common.decisions" /></h3>
              {state.decisions.length === 0 ? (
                <p className="text-xs text-muted-foreground"><I18nText id="common.no_decisions_yet_confirmed_ones_are_sent_with" /></p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {state.decisions.map((decision) => (
                    <li key={decision.id} className="flex items-start justify-between gap-2" data-testid="portfolio-manager-decision">
                      <span className="min-w-0 break-words">{decision.text}</span>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => void forget(decision.id)}
                        aria-label={tr("common.forget_decision", { p0: String(decision.text) })}
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
                  maxLength={PORTFOLIO_MANAGER_LIMITS.decisionChars}
                  placeholder={tr("common.add_a_decision")}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
                  aria-label={tr("portfolio.add_a_portfolio_decision")}
                  data-testid="portfolio-manager-decision-input"
                />
                <Button type="submit" size="sm" variant="outline" disabled={!decisionDraft.trim()}><I18nText id="common.add" /></Button>
              </form>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  pending,
  plan,
  delegations,
  decided,
  onPlan,
  onDelegation,
  onOpenProject,
  onOpenProjectManager,
  onRemember,
  onOpenBrowser,
  onOpenNativeComputer,
}: {
  message: PortfolioManagerMessage;
  pending: boolean;
  plan: PortfolioPlan | null;
  delegations: DelegationView[];
  decided: ReadonlySet<string>;
  onPlan: (plan: PortfolioPlan) => void;
  onDelegation: (delegation: DelegationView) => void;
  onOpenProject: (path: string) => void;
  onOpenProjectManager: (path: string) => void;
  onRemember: (text: string) => void;
  onOpenBrowser?: () => void;
  onOpenNativeComputer?: () => void;
}) {
  useUILocale();
  if (message.role === "system") {
    return (
      <p className="text-center text-[11px] text-muted-foreground" data-testid="portfolio-manager-message" data-role="system">
        {message.text}
      </p>
    );
  }
  if (message.role === "owner") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg border border-border px-3 py-2 text-sm" data-testid="portfolio-manager-message" data-role="owner" data-status={message.status ?? ""}>
        <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="common.you" />{pending ? tr("common.waiting_for_the_answer") : message.status === "failed" ? tr("common.not_answered") : message.status === "cancelled" ? tr("common.cancelled_6d483e") : ""}
        </span>
        <span className="whitespace-pre-wrap break-words">{message.text}</span>
        {message.nativeAction && <div className="mt-2"><NativeActionCard action={message.nativeAction} onOpenNativeComputer={onOpenNativeComputer} /></div>}
        {message.status === "failed" && message.providerRefusal && (
          <ProviderRefusalNotice refusal={message.providerRefusal} testId="portfolio-provider-refusal" className="mt-1 space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs" onOpenAccount={requestOpenAccounts} />
        )}
      </div>
    );
  }
  const suggestions = message.suggestedDecisions.filter((item) => !decided.has(item.toLowerCase()));
  return (
    <div className="max-w-full space-y-2" data-testid="portfolio-manager-message" data-role="manager">
      <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
        <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="portfolio.portfolio_manager_3c8b8a" /></span>
        <div className="agetor-md break-words" data-testid="portfolio-manager-reply">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
            {message.text}
          </ReactMarkdown>
        </div>
        {message.sources.length > 0 && (
          <details className="mt-1 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer"><I18nText id="common.based_on" /></summary>
            <ul className="mt-0.5 list-disc pl-4">
              {message.sources.map((source) => <li key={source.id}>{source.label} — {source.detail}</li>)}
            </ul>
          </details>
        )}
      </div>
      <MemoryProposalList messageId={message.id} />
      {message.browserAction && <BrowserActionCard action={message.browserAction} onOpenBrowser={onOpenBrowser} />}
      {message.nativeAction && <NativeActionCard action={message.nativeAction} onOpenNativeComputer={onOpenNativeComputer} />}
      {message.protocolErrors.map((text) => (
        <p key={text} role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" data-testid="portfolio-manager-protocol-error">
          {text}
        </p>
      ))}
      {plan && <PortfolioPlanCard plan={plan} onChanged={onPlan} onOpenProject={onOpenProject} />}
      {delegations.map((item) => (
        <DelegationCard key={item.id} delegation={item} onChanged={onDelegation} onOpenProjectManager={onOpenProjectManager} />
      ))}
      {suggestions.length > 0 && (
        <div className="space-y-1 rounded-md border border-border px-2 py-1.5 text-[11px]" data-testid="portfolio-manager-suggested-decisions">
          <p className="font-medium text-muted-foreground"><I18nText id="common.decisions_to_remember" /></p>
          {suggestions.map((text) => (
            <div key={text} className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-words">{text}</span>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onRemember(text)}>
                <BookmarkPlus className="size-3" aria-hidden /><I18nText id="common.remember" />{" "}</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
