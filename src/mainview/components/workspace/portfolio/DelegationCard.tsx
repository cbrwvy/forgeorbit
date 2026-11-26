import { I18nText, UsageNotice, useLocale as useUILocale } from "@/i18n/react";
import { t as tr } from "@/i18n/core";

import { useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Send, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { delegationActions, delegationTargetLabel } from "@/lib/portfolio-manager";
import { delegationStatusLabel, type DelegationView } from "../../../../shared/portfolio-manager.ts";

const TONE: Record<ReturnType<typeof delegationActions>["tone"], string> = {
  neutral: "border-border",
  info: "border-info/40",
  success: "border-success/40",
  danger: "border-danger/40",
  muted: "border-border opacity-80",
};

interface Props {
  delegation: DelegationView;
  onChanged: (delegation: DelegationView) => void;
  onOpenProjectManager: (projectPath: string) => void;
}

/**
 * One proposed request from the portfolio manager to a project's own
 * manager (FO-008C). Shows the target, the exact text, the agent that will
 * answer and its warnings. Nothing is sent until the owner approves, and
 * approval runs that project's manager once — no task, batch or run starts.
 */
export function DelegationCard({ delegation, onChanged, onOpenProjectManager }: Props) {
  useUILocale();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const actions = delegationActions(delegation, busy);
  const target = delegation.target;

  const run = async (work: () => Promise<DelegationView>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      onChanged(await work());
    } catch (caught) {
      const body = caught instanceof ApiError ? (caught.body as { delegation?: DelegationView } | null) : null;
      if (body?.delegation) onChanged(body.delegation);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const approve = async () => {
    const ok = await confirm(() => ({
      title: tr("common.send_this_request_to_the_manager_of", { p0: String(delegation.projectName) }),
      description: (
        <span className="block space-y-1 text-sm">
          <span className="block"><I18nText id="portfolio.it_runs" />{" "}{delegationTargetLabel(delegation)}{" "}<I18nText id="portfolio.once_with_that_project_s_own_context_and" /></span>
          <span className="block"><I18nText id="portfolio.no_task_batch_or_run_is_started_the" /></span>
          {target.usageNotice && <span className="block text-warning"><UsageNotice text={target.usageNotice} /></span>}
        </span>
      ),
      confirmLabel: tr("common.send_request"),
    }));
    if (!ok) return;
    await run(async () => (await api.approveDelegation(delegation.id, delegation.revision)).delegation);
  };

  const reject = () => run(() => api.rejectDelegation(delegation.id));
  const headingId = `delegation-${delegation.id}-title`;

  return (
    <section
      className={cn("space-y-2 rounded-xl border px-3 py-2.5 text-xs", TONE[actions.tone])}
      aria-labelledby={headingId}
      data-testid="portfolio-delegation"
      data-status={delegation.status}
      data-project={delegation.projectPath}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={headingId} className="text-sm font-semibold"><I18nText id="portfolio.request_to_the_manager_of" />{" "}{delegation.projectName}</h4>
          <p className="break-words text-muted-foreground">{delegation.objective}</p>
        </div>
        <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px]" data-testid="portfolio-delegation-status">
          {delegationStatusLabel(delegation.status)}
        </span>
      </header>

      <dl className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted-foreground"><I18nText id="portfolio.target" /></dt>
        <dd className="min-w-0 break-words" title={delegation.projectPath}>{delegation.projectName}{" "}<I18nText id="portfolio.project_manager" /></dd>
        <dt className="text-muted-foreground"><I18nText id="common.agent" /></dt>
        <dd className="min-w-0" data-testid="portfolio-delegation-agent">{delegationTargetLabel(delegation)}</dd>
        {delegation.reason && (<><dt className="text-muted-foreground"><I18nText id="common.why" /></dt><dd className="min-w-0 break-words">{delegation.reason}</dd></>)}
        {delegation.contextSummary && (<><dt className="text-muted-foreground"><I18nText id="portfolio.context" /></dt><dd className="min-w-0 break-words">{delegation.contextSummary}</dd></>)}
        {delegation.expectedOutput && (<><dt className="text-muted-foreground"><I18nText id="portfolio.expected" /></dt><dd className="min-w-0 break-words">{delegation.expectedOutput}</dd></>)}
      </dl>

      <div>
        <p className="mb-0.5 font-medium"><I18nText id="portfolio.exact_request" /></p>
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-2 py-1.5 font-sans text-xs"
          data-testid="portfolio-delegation-request"
          tabIndex={0}
          aria-label={tr("portfolio.exact_request_text")}
        >
          {delegation.request}
        </pre>
      </div>

      {(delegation.status === "proposed" || delegation.status === "failed") && (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          <li><I18nText id="portfolio.approving_runs_the_project_manager_s_agent_once" /></li>
          {target.usageNotice && <li className="text-warning" data-testid="portfolio-delegation-usage"><UsageNotice text={target.usageNotice} /></li>}
          {target.problem && <li className="text-danger" role="alert" data-testid="portfolio-delegation-problem">{target.problem}</li>}
        </ul>
      )}
      {delegation.error && delegation.status === "failed" && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger" data-testid="portfolio-delegation-error">{delegation.error}</p>
      )}
      {delegation.result?.status === "answered" && (
        <div className="space-y-1 rounded-md border border-success/40 bg-success/10 px-2 py-1.5" data-testid="portfolio-delegation-result">
          <p className="font-medium"><I18nText id="portfolio.answer_from_the_project_manager_observation" /></p>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{delegation.result.reply || tr("common.the_answer_had_no_text")}</p>
          {delegation.result.planTitle && <p className="text-muted-foreground"><I18nText id="portfolio.proposed_plan" />{delegation.result.planTitle}” ({delegation.result.planSteps}{" "}<I18nText id="portfolio.steps" /></p>}
          {delegation.result.proposalTitle && (
            <p className="text-muted-foreground"><I18nText id="common.proposed" />{" "}{delegation.result.proposalTasks}{" "}<I18nText id="portfolio.task_s_in" />{delegation.result.proposalTitle}<I18nText id="portfolio.nothing_was_created_review_them_in_that_project" /></p>
          )}
          <p className="text-[11px] text-muted-foreground"><I18nText id="portfolio.ask_here_again_to_include_this_answer_in" /></p>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-danger" data-testid="portfolio-delegation-action-error">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {(delegation.status === "proposed" || delegation.status === "failed") && (
          <>
            <Button
              type="button"
              size="sm"
              onClick={() => void approve()}
              disabled={!actions.canApprove}
              title={actions.blockedReason ?? undefined}
              data-testid="portfolio-delegation-approve"
            >
              {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
              {actions.approveLabel}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void reject()} disabled={!actions.canReject} data-testid="portfolio-delegation-reject">
              <X className="size-3.5" aria-hidden /><I18nText id="common.reject" />{" "}</Button>
          </>
        )}
        {delegation.status === "answered" && <Check className="size-4 text-success" aria-hidden />}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => onOpenProjectManager(delegation.projectPath)}
          data-testid="portfolio-delegation-open"
        >
          <ExternalLink className="size-3.5" aria-hidden /><I18nText id="portfolio.open_project_manager" />{" "}</Button>
      </div>
    </section>
  );
}
