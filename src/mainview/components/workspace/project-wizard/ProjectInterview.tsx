import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { ApiError, api, type InterviewTurnInput } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "../../kanban/md-components";
import { HarnessAuthHint } from "../../kanban/HarnessAuthHint";
import { useTaskLaunch } from "../../kanban/TaskLaunchPickers";
import { formatStacks, type DocKind, type ProjectDiscovery } from "../../../../shared/project-discovery.ts";
import type { WizardDraft } from "../../../../shared/project-wizard.ts";
import {
  DOC_FILE_NAMES,
  INTERVIEW_LIMITS,
  appendMessage,
  applyTurnOutcome,
  discoveredFacts,
  interviewProjectInput,
  interviewSupportFor,
  listSections,
  prdContextProblem,
  takeBackLastAnswer,
  validateDocTarget,
  type InterviewIsolation,
  type InterviewPlan,
  type InterviewRequest,
  type InterviewState,
} from "../../../../shared/project-interview.ts";

const POLL_MS = 600;

type Tab = "interview" | DocKind;

interface PendingTurn {
  id: string;
  request: InterviewRequest;
  only?: DocKind;
}

interface Props {
  discovery: ProjectDiscovery;
  draft: WizardDraft;
  plan: InterviewPlan;
  state: InterviewState;
  restored: boolean;
  onChange: (update: (state: InterviewState) => InterviewState) => void;
  onBack: () => void;
  onDiscard: () => void;
  /** Inside the project workspace (FO-002.1): the project already exists and
   *  the owner saves a draft with its own button, so the wizard's "save when
   *  I add the project" switch and wording don't apply. */
  workspace?: boolean;
}

function busyLabel(request: InterviewRequest): string {
  if (request.kind === "question") return tr("common.the_assistant_is_thinking");
  if (request.kind === "drafts") return tr("common.writing_the_drafts");
  return tr("common.revising", { p0: String(request.heading) });
}

/**
 * AI project interview, shown inside the wizard's Docs step (FO-003). Every
 * request to the agent starts from a click here. Replies only change the
 * in-memory draft; nothing is written to the project until the wizard's
 * final confirm.
 */
export function ProjectInterview({ discovery, draft, plan, state, restored, onChange, onBack, onDiscard, workspace = false }: Props) {
  const { locale: uiLocale } = useUILocale();
  const launch = useTaskLaunch(true, { withProfiles: true });
  const [tab, setTab] = useState<Tab>("interview");
  const [composer, setComposer] = useState("");
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailed, setLastFailed] = useState<{ request: InterviewRequest; only?: DocKind } | null>(null);
  const interviewId = useRef(crypto.randomUUID()).current;
  const stateRef = useRef(state);
  stateRef.current = state;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const stack = formatStacks(discovery.stacks);

  // Restore the agent a saved interview used, once the harness list loads.
  useEffect(() => {
    if (seededRef.current || launch.loading || launch.harnesses.length === 0) return;
    seededRef.current = true;
    const saved = state.agent;
    if (!saved) return;
    if (saved.profileId && launch.profiles.some((profile) => profile.id === saved.profileId)) {
      launch.setAgentProfileId(saved.profileId);
      return;
    }
    if (launch.harnesses.some((harness) => harness.id === saved.harness)) {
      launch.seed({ agent: saved.harness, model: saved.model, effort: saved.effort });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.loading, launch.harnesses.length, launch.profiles.length]);

  const profile = launch.selectedProfile;
  const harnessId = profile ? profile.harness : launch.agent;
  const harness = launch.harnesses.find((item) => item.id === harnessId) ?? null;
  const kind = harness?.kind ?? launch.kind;
  const support = interviewSupportFor(kind);
  const status = launch.agents.find((item) => item.harnessId === harnessId);
  const model = profile ? profile.model : launch.model;
  const effort = profile ? profile.effort : launch.effort;
  const baseProblem = launch.loading
    ? tr("common.loading_agents")
    : launch.loadError
      ? tr("common.couldn_t_load_agents", { p0: String(launch.loadError) })
      : !harness
        ? tr("common.choose_an_agent")
        : !harness.enabled
          ? tr("common.is_disabled_enable_it_in_settings", { p0: String(harness.label) })
          : !support.supported
            ? support.reason
            : status && !status.available
              ? tr("common.is_not_available", { p0: String(harness.label), p1: String(status.reason) })
              : status?.loggedIn === false
                ? tr("common.isn_t_logged_in", { p0: String(harness.label) })
                : null;
  // What the selected agent may still do. Local CLI probes only — fetching
  // this never sends anything to a model.
  const [isolation, setIsolation] = useState<InterviewIsolation | null>(null);
  const [isolationError, setIsolationError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState<string | null>(null);
  const [isolationNonce, setIsolationNonce] = useState(0);
  const preflightKey = baseProblem || !harness ? null : `${harness.id}\0${model}\0${effort ?? ""}`;
  useEffect(() => {
    if (!preflightKey || !harness) {
      setIsolation(null);
      setIsolationError(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      api.interviewPreflight({ harness: harness.id, model, effort })
        .then((result) => {
          if (cancelled) return;
          setIsolation(result.isolation);
          setIsolationError(null);
        })
        .catch((caught) => {
          if (cancelled) return;
          setIsolation(null);
          setIsolationError((caught as Error).message);
        })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflightKey, isolationNonce]);
  const consented = isolation != null && consent === isolation.consentKey;
  const agentProblem = baseProblem
    ?? isolationError
    ?? (checking || !isolation ? tr("common.checking_what_this_agent_can_do") : null);
  const consentProblem = agentProblem == null && !consented;

  const interviewProfiles = launch.profiles.filter((item) => {
    const owner = launch.harnesses.find((h) => h.id === item.harness);
    return owner ? interviewSupportFor(owner.kind).supported : false;
  });

  const started = state.messages.length > 0;
  const lastAssistant = [...state.messages].reverse().find((message) => message.role === "assistant");
  const awaitingAnswer = lastAssistant?.kind === "question" && state.messages.at(-1)?.role === "assistant";
  const ready = lastAssistant?.kind === "ready";
  const busy = pending != null || starting;
  const targets = (["idea", "prd"] as const).filter((item) => state.targets[item] != null);
  const hasDrafts = targets.some((item) => state.drafts[item]?.trim());
  const answers = state.messages.filter((message) => message.role === "user" && message.kind === "answer");
  const facts = useMemo(() => discoveredFacts(discovery, plan, stack), [discovery, plan, stack, uiLocale]);
  const prdHint = prdContextProblem(plan, draft.description, state.messages, composer);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.messages.length, pending]);

  // Poll the running turn. Leaving the interview stops it — a reply nobody
  // can see is just spent quota.
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const turn = await api.getInterviewTurn(pending.id);
        if (stopped) return;
        if (turn.status === "running") {
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        setPending(null);
        if (turn.status === "cancelled") {
          setError(tr("common.request_cancelled_nothing_was_changed"));
          setLastFailed({ request: pending.request, only: pending.only });
          return;
        }
        if (turn.status === "failed" || !turn.result) {
          setError(turn.error ?? tr("common.the_agent_didn_t_answer"));
          setLastFailed({ request: pending.request, only: pending.only });
          return;
        }
        const section = pending.request.kind === "section"
          ? { doc: pending.request.doc, heading: pending.request.heading }
          : undefined;
        const { state: next, notice } = applyTurnOutcome(stateRef.current, turn.result, { only: pending.only, section });
        onChange(() => next);
        setError(notice);
        setLastFailed(notice ? { request: pending.request, only: pending.only } : null);
        if (turn.result.kind === "drafts" && turn.result.reply.ok) {
          const first = pending.only ?? targets.find((item) => next.drafts[item]);
          if (first) setTab(first);
        }
        if (turn.result.kind === "question") composerRef.current?.focus();
      } catch (caught) {
        if (stopped) return;
        timer = setTimeout(poll, POLL_MS * 2);
        setError(tr("common.lost_contact_with_the_core_retrying", { p0: String((caught as Error).message) }));
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => {
    const current = pendingRef.current;
    if (current) void api.cancelInterviewTurn(current.id).catch(() => {});
  }, []);

  const runTurn = async (request: InterviewRequest, nextState: InterviewState, only?: DocKind) => {
    if (busy || agentProblem || consentProblem || !harness) return;
    setStarting(true);
    setError(null);
    setLastFailed(null);
    const withAgent: InterviewState = {
      ...nextState,
      agent: { harness: harness.id, model, effort, profileId: profile?.id ?? null },
    };
    onChange(() => withAgent);
    const input: InterviewTurnInput = {
      interviewId,
      harness: harness.id,
      model,
      effort,
      fast: profile ? profile.fast : launch.fast,
      maxMode: profile ? profile.maxMode : launch.maxMode,
      request,
      project: interviewProjectInput(discovery, draft, plan, withAgent.targets, stack),
      messages: withAgent.messages,
      drafts: withAgent.drafts,
      consent,
    };
    try {
      const turn = await api.startInterviewTurn(input);
      setPending({ id: turn.id, request, only });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 428) {
        // The agent's setup changed since it was confirmed: ask again.
        const fresh = (caught.body as { isolation?: InterviewIsolation } | null)?.isolation ?? null;
        setIsolation(fresh);
        setConsent(null);
        if (!fresh) setIsolationNonce((n) => n + 1);
      }
      setError((caught as Error).message);
      setLastFailed({ request, only });
    } finally {
      setStarting(false);
    }
  };

  const sendAnswer = () => {
    const text = composer.trim();
    if (!text || busy) return;
    const next = appendMessage(stateRef.current, "user", "answer", text);
    setComposer("");
    void runTurn({ kind: "question" }, next);
  };

  const skip = () => {
    if (busy) return;
    void runTurn({ kind: "question" }, appendMessage(stateRef.current, "user", "skip", ""));
  };

  const askForHelp = () => {
    if (busy) return;
    const text = composer.trim() || "Suggest a few concrete options for this question.";
    setComposer("");
    void runTurn({ kind: "question" }, appendMessage(stateRef.current, "user", "request", text));
  };

  const finish = () => {
    if (busy) return;
    if (prdHint) {
      setError(prdHint);
      return;
    }
    const text = composer.trim();
    const next = text ? appendMessage(stateRef.current, "user", "answer", text) : stateRef.current;
    setComposer("");
    void runTurn({ kind: "drafts" }, next);
  };

  const editLast = () => {
    if (busy) return;
    const taken = takeBackLastAnswer(stateRef.current);
    if (!taken) return;
    onChange(() => taken.state);
    setComposer(taken.text);
    composerRef.current?.focus();
  };

  const retry = () => {
    if (!lastFailed) return;
    void runTurn(lastFailed.request, stateRef.current, lastFailed.only);
  };

  const cancel = () => {
    if (pending) void api.cancelInterviewTurn(pending.id).catch(() => {});
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendAnswer();
    }
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-3"
      data-testid="interview"
      onKeyDown={(event) => {
        // The wizard is a <form>; Enter in a field here must not submit it.
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" id="interview-title"><I18nText id="projects.create_project_documentation" /></h3>
          <p className="text-[11px] text-muted-foreground"><I18nText id="projects.an_ai_agent_asks_a_few_questions_and" />{" "}{workspace ? "document" : "documents"}<I18nText id="projects.you_review_everything_before_anything_is_saved" />{" "}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onBack} data-testid="interview-back">
          <ArrowLeft className="size-3.5" aria-hidden />
          {workspace ? tr("common.close") : tr("common.docs")}
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs" data-testid="interview-docs">
        {(["idea", "prd"] as const).map((item) => (
          <div key={item} className="rounded-md border border-border px-2 py-1.5" data-testid={`interview-doc-${item}`}>
            <dt className="font-medium">{DOC_FILE_NAMES[item]}</dt>
            <dd className="truncate text-[11px] text-muted-foreground" title={plan[item].existing ?? state.targets[item] ?? ""}>
              {plan[item].existing
                ? tr("common.exists_kept_used_as_context", { p0: String(plan[item].existing) })
                : state.drafts[item]?.trim()
                  ? tr("common.draft_ready_for", { p0: String(state.targets[item]) })
                  : plan[item].skipped
                    ? tr("common.skipped_not_drafted_create_it_later_from_the")
                    : tr("common.missing_will_draft", { p0: String(state.targets[item]) })}
            </dd>
          </div>
        ))}
      </dl>
      {targets.some((item) => plan[item].unselected.length > 0) && (
        <p className="text-[11px] text-warning" data-testid="interview-duplicate-warning">
          {targets
            .filter((item) => plan[item].unselected.length > 0)
            .map((item) => tr("common.also_exists", { p0: String(plan[item].unselected.join(", ")), p1: String(workspace ? tr("common.creating_leaves_two_copies", { p0: String(DOC_FILE_NAMES[item]) }) : tr("common.pick_it_in_the_docs_step_to_use", { p0: String(DOC_FILE_NAMES[item]) })) }))
            .join(" ")}
        </p>
      )}
      {restored && (
        <p className="text-[11px] text-muted-foreground" data-testid="interview-restored"><I18nText id="projects.restored_the_interview_you_saved_for_this_folder" />{" "}</p>
      )}

      <fieldset className="space-y-2 rounded-lg border border-border p-2 text-xs" disabled={busy} data-testid="interview-agent">
        <legend className="px-1 text-xs font-medium"><I18nText id="common.agent" /></legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="min-w-0 space-y-1">
            <span className="text-muted-foreground"><I18nText id="common.agent_profile" /></span>
            <Select
              value={launch.agentProfileId ?? ""}
              onChange={(event) => launch.setAgentProfileId(event.target.value || null)}
              className="h-8"
              data-testid="interview-profile"
            >
              <option value=""><I18nText id="common.none_pick_a_harness" /></option>
              {interviewProfiles.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </Select>
          </label>
          {!profile && (
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground"><I18nText id="common.harness" /></span>
              <Select
                value={launch.agent}
                onChange={(event) => launch.switchAgent(event.target.value)}
                className="h-8"
                data-testid="interview-harness"
              >
                {launch.availableHarnesses.map((item) => {
                  const itemSupport = interviewSupportFor(item.kind);
                  const itemStatus = launch.agents.find((s) => s.harnessId === item.id);
                  const suffix = !itemSupport.supported
                    ? tr("common.not_supported")
                    : itemStatus && !itemStatus.available
                      ? tr("common.not_installed")
                      : itemStatus?.loggedIn === false
                        ? tr("common.logged_out")
                        : "";
                  return <option key={item.id} value={item.id}>{`${item.label}${suffix}`}</option>;
                })}
              </Select>
            </label>
          )}
          {!profile && (
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground"><I18nText id="common.model" /></span>
              <Select value={launch.model} onChange={(event) => launch.setModel(event.target.value)} className="h-8" data-testid="interview-model">
                {launch.models.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </Select>
            </label>
          )}
          {!profile && (
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground"><I18nText id="common.effort" /></span>
              <Select
                value={launch.effort ?? ""}
                onChange={(event) => launch.setEffort(event.target.value)}
                disabled={launch.efforts.length === 0}
                className="h-8"
                data-testid="interview-effort"
              >
                {launch.efforts.length === 0 ? (
                  <option value=""><I18nText id="common.n_a" /></option>
                ) : (
                  launch.efforts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)
                )}
              </Select>
            </label>
          )}
        </div>
        {profile && (
          <p className="text-[11px] text-muted-foreground" data-testid="interview-profile-summary">
            {harness?.label ?? profile.harness} · {model}{effort ? ` · ${effort}` : ""}<I18nText id="projects.the_profile_s_instructions_and_skills_are_not" />{" "}</p>
        )}
        {support.supported && harness && isolation && (
          <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px]" data-testid="interview-isolation">
            <p className="font-medium text-foreground"><I18nText id="projects.before_you_start_what" />{" "}{harness.label}{" "}<I18nText id="common.can_do_here" /></p>
            <p><I18nText id="projects.each_message_runs_the_cli_once_in_an" />{" "}{isolation.writes}
            </p>
            <ul className="list-disc space-y-0.5 pl-4" data-testid="interview-isolation-warnings">
              {isolation.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
            <p><I18nText id="projects.this_is_not_a_guaranteed_sandbox_use_it" /></p>
            <label className="flex items-start gap-2 font-medium text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={consented}
                onChange={(event) => setConsent(event.target.checked ? isolation.consentKey : null)}
                data-testid="interview-consent"
              /><I18nText id="common.i_understand_use" />{" "}{harness.label}{" "}<I18nText id="projects.for_this_interview" />{" "}</label>
          </div>
        )}
        {(baseProblem ?? isolationError) && !launch.loading && (
          <p role="alert" className="text-[11px] text-danger" data-testid="interview-agent-problem">{baseProblem ?? isolationError}</p>
        )}
        {!baseProblem && !isolationError && (checking || !isolation) && (
          <p role="status" className="text-[11px] text-muted-foreground" data-testid="interview-isolation-checking"><I18nText id="common.checking_what_this_agent_can_do" />{" "}</p>
        )}
        {consentProblem && !busy && (
          <p className="text-[11px] text-muted-foreground" data-testid="interview-consent-hint"><I18nText id="projects.confirm_the_points_above_to_start" />{" "}</p>
        )}
        <HarnessAuthHint status={status} />
      </fieldset>

      <div role="tablist" aria-label={tr("projects.interview")} className="flex gap-1">
        <TabButton id="interview" current={tab} onSelect={setTab} label={tr("projects.interview")} />
        {targets.map((item) => (
          <TabButton key={item} id={item} current={tab} onSelect={setTab} label={DOC_FILE_NAMES[item]} disabled={!state.drafts[item]?.trim()} />
        ))}
      </div>

      {tab === "interview" ? (
        <div className="flex min-h-0 flex-col gap-2" role="tabpanel" aria-labelledby="interview-tab-interview">
          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label={tr("projects.interview_messages")}
            className="max-h-64 min-h-24 space-y-2 overflow-y-auto rounded-lg border border-border p-2"
            data-testid="interview-log"
          >
            {!started && (
              <p className="text-xs text-muted-foreground"><I18nText id="projects.nothing_has_been_sent_yet_choose_an_agent" />{" "}</p>
            )}
            {state.messages.map((message, index) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs",
                  message.role === "assistant" ? "bg-muted/60" : "ml-6 border border-border",
                )}
                data-testid="interview-message"
                data-role={message.role}
                data-kind={message.kind}
              >
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {message.role === "assistant" ? (message.kind === "ready" ? tr("common.summary") : tr("common.assistant")) : message.kind === "request" ? tr("common.you_asked") : tr("common.you")}
                </span>
                <span className="whitespace-pre-wrap">{message.kind === "skip" ? "(skipped)" : message.text}</span>
                {message.role === "user" && index === state.messages.length - 1 && !busy && (
                  <button type="button" className="ml-2 text-[10px] underline" onClick={editLast} data-testid="interview-edit-last"><I18nText id="common.edit" />{" "}</button>
                )}
              </div>
            ))}
            {pending && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="interview-busy">
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                {busyLabel(pending.request)}
              </p>
            )}
          </div>

          {(state.notes.assumptions.length > 0 || state.notes.openQuestions.length > 0 || answers.length > 0) && (
            <details className="rounded-lg border border-border px-2 py-1 text-[11px]" data-testid="interview-notes">
              <summary className="cursor-pointer font-medium"><I18nText id="projects.what_the_assistant_knows" /></summary>
              <NoteList title={tr("common.confirmed_by_you")} items={answers.map((message) => message.text)} testId="interview-notes-confirmed" />
              <NoteList title={tr("projects.detected_in_the_folder")} items={facts} testId="interview-notes-detected" />
              <NoteList title={tr("common.assumptions")} items={state.notes.assumptions} testId="interview-notes-assumptions" />
              <NoteList title={tr("projects.open_questions")} items={state.notes.openQuestions} testId="interview-notes-open" />
            </details>
          )}

          {!started ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void runTurn({ kind: "question" }, stateRef.current)} disabled={busy || agentProblem != null || consentProblem} data-testid="interview-start">
                <Sparkles className="size-3.5" aria-hidden />
                {starting ? tr("common.starting") : tr("common.start_interview")}
              </Button>
              <Button type="button" variant="outline" onClick={onBack} data-testid="interview-skip-all"><I18nText id="projects.skip_the_interview" />{" "}</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="interview-answer" className="sr-only"><I18nText id="projects.your_answer" /></label>
              <Textarea
                id="interview-answer"
                ref={composerRef}
                value={composer}
                maxLength={INTERVIEW_LIMITS.answerChars}
                rows={3}
                placeholder={ready ? tr("common.add_anything_else_or_write_the_drafts") : tr("common.type_your_answer_cmd_enter_sends")}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={onComposerKey}
                disabled={busy}
                data-testid="interview-answer"
              />
              {prdHint && (
                <p className="text-[11px] text-warning" data-testid="interview-prd-hint">{prdHint}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={sendAnswer} disabled={busy || !composer.trim() || agentProblem != null || consentProblem} data-testid="interview-send"><I18nText id="common.send" />{" "}</Button>
                {awaitingAnswer && (
                  <Button type="button" size="sm" variant="outline" onClick={skip} disabled={busy || agentProblem != null || consentProblem} data-testid="interview-skip"><I18nText id="projects.skip_question" />{" "}</Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={askForHelp} disabled={busy || agentProblem != null || consentProblem} data-testid="interview-help"><I18nText id="projects.ask_for_suggestions" />{" "}</Button>
                <Button type="button" size="sm" variant={ready ? "default" : "outline"} onClick={finish} disabled={busy || agentProblem != null || consentProblem || prdHint != null} data-testid="interview-finish">
                  {hasDrafts ? tr("common.regenerate_drafts") : ready ? tr("common.write_the_drafts") : tr("common.finish_and_write_drafts")}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <DraftPreview
          key={tab}
          doc={tab}
          state={state}
          busy={busy}
          agentReady={agentProblem == null && !consentProblem}
          projectPath={discovery.path}
          onEdit={(text) => onChange((current) => ({ ...current, drafts: { ...current.drafts, [tab]: text }, accepted: false, updatedAt: Date.now() }))}
          onTarget={(rel) => onChange((current) => ({ ...current, targets: { ...current.targets, [tab]: rel }, accepted: false, updatedAt: Date.now() }))}
          onImprove={(heading, instruction) => void runTurn({ kind: "section", doc: tab, heading, instruction }, stateRef.current)}
          onRegenerate={() => void runTurn({ kind: "drafts" }, stateRef.current, tab)}
        />
      )}

      {pending && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={cancel} data-testid="interview-cancel"><I18nText id="common.cancel_request" />{" "}</Button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-danger" data-testid="interview-error">
          <span className="min-w-0 flex-1">{error}</span>
          {lastFailed && !busy && (
            <Button type="button" size="sm" variant="outline" onClick={retry} disabled={agentProblem != null || consentProblem} data-testid="interview-retry">
              <RotateCcw className="size-3.5" aria-hidden /><I18nText id="projects.try_again" />{" "}</Button>
          )}
        </div>
      )}

      {hasDrafts && !workspace && (
        <div className="space-y-2 rounded-lg border border-border p-2" data-testid="interview-accept">
          <label className="flex items-center justify-between gap-2 text-xs">
            <span>
              <span className="block font-medium"><I18nText id="projects.save_these_drafts_when_i_add_the_project" /></span>
              <span className="block text-[11px] text-muted-foreground"><I18nText id="projects.creates" />{" "}{targets.filter((item) => state.drafts[item]?.trim()).map((item) => state.targets[item]).join(tr("common.and"))}<I18nText id="projects.existing_files_are_never_overwritten_nothing_is_written" />{" "}</span>
            </span>
            <Switch
              checked={state.accepted}
              onCheckedChange={(checked) => onChange((current) => ({ ...current, accepted: checked, updatedAt: Date.now() }))}
              disabled={busy || targets.some((item) => state.drafts[item]?.trim() && validateDocTarget(state.targets[item] ?? "") != null)}
              aria-label={tr("projects.save_drafts_when_adding_the_project")}
              data-testid="interview-accept-toggle"
            />
          </label>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard} disabled={busy} data-testid="interview-discard"><I18nText id="projects.discard_interview" />{" "}</Button>
      </div>
    </div>
  );
}

function TabButton({ id, current, label, disabled, onSelect }: {
  id: Tab;
  current: Tab;
  label: string;
  disabled?: boolean;
  onSelect: (tab: Tab) => void;
}) {
  useUILocale();
  return (
    <button
      type="button"
      role="tab"
      id={`interview-tab-${id}`}
      aria-selected={current === id}
      disabled={disabled}
      onClick={() => onSelect(id)}
      className={cn("glass-nav-item rounded-md px-2 py-1 text-xs", current === id && "glass-selected")}
      data-testid={`interview-tab-${id}`}
    >
      {label}
    </button>
  );
}

function NoteList({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  useUILocale();
  if (items.length === 0) return null;
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="font-medium text-muted-foreground">{title}</p>
      <ul className="list-disc pl-4">
        {items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function DraftPreview({
  doc,
  state,
  busy,
  agentReady,
  projectPath,
  onEdit,
  onTarget,
  onImprove,
  onRegenerate,
}: {
  doc: DocKind;
  state: InterviewState;
  busy: boolean;
  agentReady: boolean;
  projectPath: string;
  onEdit: (text: string) => void;
  onTarget: (rel: string) => void;
  onImprove: (heading: string, instruction: string) => void;
  onRegenerate: () => void;
}) {
  const { locale: uiLocale } = useUILocale();
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const text = state.drafts[doc] ?? "";
  const target = state.targets[doc] ?? "";
  const targetError = validateDocTarget(target);
  const sections = useMemo(() => listSections(text), [text, uiLocale]);
  const [section, setSection] = useState("");
  const [instruction, setInstruction] = useState("");
  const chosen = sections.includes(section) ? section : sections[0] ?? "";

  return (
    <div className="space-y-2" role="tabpanel" aria-labelledby={`interview-tab-${doc}`} data-testid={`interview-preview-${doc}`}>
      <label className="block space-y-1 text-xs">
        <span className="font-medium"><I18nText id="projects.file_path_in_the_project" /></span>
        <Input
          value={target}
          onChange={(event) => onTarget(event.target.value)}
          spellCheck={false}
          disabled={busy}
          className="h-8 font-mono text-xs"
          data-testid="interview-target"
          aria-invalid={targetError != null}
        />
        <span className={cn("block text-[11px]", targetError ? "text-danger" : "text-muted-foreground")} data-testid="interview-target-hint">
          {targetError ?? tr("common.will_be_created_at", { p0: String(projectPath), p1: String(target.trim()) })}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={cn("glass-nav-item rounded-md px-2 py-1 text-xs", mode === "preview" && "glass-selected")}
          aria-pressed={mode === "preview"}
          onClick={() => setMode("preview")}
          data-testid="interview-mode-preview"
        ><I18nText id="common.preview" />{" "}</button>
        <button
          type="button"
          className={cn("glass-nav-item rounded-md px-2 py-1 text-xs", mode === "edit" && "glass-selected")}
          aria-pressed={mode === "edit"}
          onClick={() => setMode("edit")}
          data-testid="interview-mode-edit"
        ><I18nText id="common.edit" />{" "}</button>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onRegenerate} disabled={busy || !agentReady} data-testid="interview-regenerate"><I18nText id="projects.regenerate" />{" "}{DOC_FILE_NAMES[doc]}
        </Button>
      </div>
      {mode === "preview" ? (
        <div className="agetor-md max-h-72 overflow-y-auto rounded-lg border border-border p-3 text-sm" data-testid="interview-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
            {text}
          </ReactMarkdown>
        </div>
      ) : (
        <Textarea
          value={text}
          onChange={(event) => onEdit(event.target.value)}
          rows={14}
          maxLength={INTERVIEW_LIMITS.draftChars}
          spellCheck
          className="font-mono text-xs"
          aria-label={tr("common.draft_30ab4d", { p0: String(DOC_FILE_NAMES[doc]) })}
          disabled={busy}
          data-testid="interview-editor"
        />
      )}
      {sections.length > 0 && (
        <fieldset className="space-y-1 rounded-lg border border-border p-2 text-xs" disabled={busy} data-testid="interview-improve">
          <legend className="px-1 font-medium"><I18nText id="projects.ask_the_ai_to_improve_a_section" /></legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
            <Select value={chosen} onChange={(event) => setSection(event.target.value)} className="h-8" aria-label={tr("projects.section")} data-testid="interview-improve-section">
              {sections.map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
            <Input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              maxLength={INTERVIEW_LIMITS.instructionChars}
              placeholder={tr("projects.what_should_change")}
              className="h-8 text-xs"
              aria-label={tr("projects.instruction")}
              data-testid="interview-improve-instruction"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!chosen) return;
                onImprove(chosen, instruction.trim());
                setInstruction("");
              }}
              disabled={!chosen || !agentReady}
              data-testid="interview-improve-submit"
            ><I18nText id="projects.improve" />{" "}</Button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
