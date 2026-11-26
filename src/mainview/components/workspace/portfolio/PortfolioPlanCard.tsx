import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { dependencyNames, planPriorityLabel } from "@/lib/portfolio-manager";
import type { PortfolioPlan } from "../../../../shared/portfolio-manager.ts";

interface Props {
  plan: PortfolioPlan;
  onChanged: (plan: PortfolioPlan) => void;
  onOpenProject: (projectPath: string) => void;
}

function List({ label, items }: { label: string; items: string[] }) {
  useUILocale();
  if (items.length === 0) return null;
  return (
    <div>
      <p className="font-medium text-muted-foreground">{label}</p>
      <ul className="list-disc pl-4">
        {items.map((item) => <li key={item} className="break-words">{item}</li>)}
      </ul>
    </div>
  );
}

/**
 * A portfolio plan from the manager (FO-008C). Read-only: accepting it
 * records a decision and changes no project; every action in it still needs
 * the owner's own approval in that project.
 */
export function PortfolioPlanCard({ plan, onChanged, onOpenProject }: Props) {
  useUILocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setStatus = async (status: "accept" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.setPortfolioPlanStatus(plan.id, status));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-xl border border-border px-3 py-2.5 text-xs" aria-label={tr("common.portfolio_plan", { p0: String(plan.title) })} data-testid="portfolio-plan" data-status={plan.status}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold">{plan.title}</h4>
          {plan.summary && <p className="break-words text-muted-foreground">{plan.summary}</p>}
        </div>
        <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px]">
          {plan.status === "proposed" ? tr("common.proposal") : plan.status === "accepted" ? tr("common.accepted") : tr("common.dismissed")}
        </span>
      </header>
      <ol className="space-y-2">
        {plan.projects.map((entry) => (
          <li key={entry.projectPath} className="space-y-1 rounded-lg border border-border/70 px-2 py-1.5" data-testid="portfolio-plan-project">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="min-w-0 truncate text-left font-medium hover:underline" title={entry.projectPath} onClick={() => onOpenProject(entry.projectPath)}>
                {entry.projectName}
              </button>
              {entry.suggestedHarness && <span className="text-[11px] text-muted-foreground"><I18nText id="portfolio.suggested_harness" />{" "}{entry.suggestedHarness}</span>}
            </div>
            <ul className="space-y-0.5">
              {entry.actions.map((action, index) => (
                <li key={`${index}-${action.title}`} data-testid="portfolio-plan-action">
                  <span className="font-medium">{action.title}</span>
                  <span className="text-muted-foreground"> · {planPriorityLabel(action.priority)}</span>
                  {action.detail && <span className="block break-words text-muted-foreground">{action.detail}</span>}
                </li>
              ))}
            </ul>
            {entry.dependsOn.length > 0 && <p className="text-muted-foreground"><I18nText id="portfolio.after" />{" "}{dependencyNames(plan, entry.dependsOn).join(", ")}</p>}
            {entry.expectedEffect && <p><span className="text-muted-foreground"><I18nText id="portfolio.expected_effect_manager_s_claim" />{" "}</span>{entry.expectedEffect}</p>}
            <List label={tr("portfolio.known_constraints")} items={entry.constraints} />
            <List label={tr("portfolio.risks")} items={entry.risks} />
            <List label={tr("common.missing_data")} items={entry.missingData} />
            <List label={tr("portfolio.needs_your_approval")} items={entry.approvals} />
          </li>
        ))}
      </ol>
      <List label={tr("portfolio.portfolio_risks")} items={plan.risks} />
      <List label={tr("portfolio.portfolio_missing_data")} items={plan.missingData} />
      {plan.notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-warning" data-testid="portfolio-plan-notes">
          {plan.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground"><I18nText id="portfolio.a_plan_changes_nothing_starting_tasks_batches_or" /></p>
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      {plan.status === "proposed" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void setStatus("accept")} disabled={busy} data-testid="portfolio-plan-accept">
            <Check className="size-3.5" aria-hidden /><I18nText id="portfolio.accept_as_decision" />{" "}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void setStatus("dismiss")} disabled={busy} data-testid="portfolio-plan-dismiss">
            <X className="size-3.5" aria-hidden /><I18nText id="common.dismiss" />{" "}</Button>
        </div>
      )}
    </section>
  );
}
