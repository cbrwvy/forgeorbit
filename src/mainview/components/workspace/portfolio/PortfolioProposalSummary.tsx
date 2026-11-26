import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isCurrentRequest } from "@/lib/employees";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import { proposalErrorText } from "@/lib/assignment-proposals";
import type { ProposalSummary } from "../../../../shared/assignments/proposals.ts";

interface Props {
  /** Opens the project's overview, where its proposals are reviewed. */
  onOpenProject: (path: string) => void;
}

/**
 * Pending assignment proposals per registered project. Reading only: the
 * Portfolio never approves, assigns, or runs anything. Review happens on the
 * project's own page, where the owner sees the task, the worker, and the
 * reason.
 */
export function PortfolioProposalSummary({ onOpenProject }: Props) {
  useUILocale();
  const [summary, setSummary] = useState<ProposalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    void api.getAssignmentProposalSummary().then(
      (result) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setSummary(result);
        setError(null);
      },
      (err: unknown) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setError(proposalErrorText(err));
      },
    );
  }, []);

  useEffect(() => {
    load();
    const unsubscribe = subscribePortfolioRefresh(() => load());
    window.addEventListener("focus", load);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", load);
    };
  }, [load]);

  if (error) {
    return <p role="alert" className="text-xs text-muted-foreground" data-testid="portfolio-proposals-error"><I18nText id="portfolio.assignment_proposals_are_unavailable" />{" "}{error}</p>;
  }
  if (!summary || summary.pendingTotal === 0) return null;
  return (
    <section className="surface-solid min-w-0 rounded-xl border px-4 py-3" aria-label={tr("portfolio.assignment_proposals_waiting_for_review")} data-testid="portfolio-proposals">
      <h2 className="text-sm font-medium"><I18nText id="portfolio.assignment_proposals_waiting_for_your_review" />{" "}<span className="ml-2 text-xs font-normal text-muted-foreground" data-testid="portfolio-proposals-total">
          {summary.pendingTotal}{" "}<I18nText id="common.in" />{" "}{summary.projects.length} {summary.projects.length === 1 ? "project" : "projects"}
        </span>
      </h2>
      <p className="mt-1 text-xs text-muted-foreground"><I18nText id="portfolio.suggestions_only_nothing_is_assigned_or_started_until" />{" "}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {summary.projects.map((project) => (
          <li key={project.projectPath}>
            <button
              type="button"
              className="glass-nav-item rounded-md border px-2 py-1 text-xs"
              data-testid="portfolio-proposals-project"
              data-project-path={project.projectPath}
              onClick={() => onOpenProject(project.projectPath)}
            >
              {project.projectName}
              <span className="ml-1.5 tabular-nums text-muted-foreground">{project.pending}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
