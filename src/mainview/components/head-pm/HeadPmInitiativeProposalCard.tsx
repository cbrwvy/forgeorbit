import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { HeadPmInitiativeProposal } from "../../../shared/head-pm-initiative-proposal.ts";

interface Props {
  proposal: HeadPmInitiativeProposal;
  onChanged: (proposal: HeadPmInitiativeProposal) => void;
  onOpenInitiative?: (initiativeId: string) => void;
  onOpenProject: (projectPath: string) => void;
}

export function HeadPmInitiativeProposalCard({ proposal, onChanged, onOpenInitiative, onOpenProject }: Props) {
  useUILocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(proposal.title);
  const [goal, setGoal] = useState(proposal.goal);

  const run = async (action: "approve" | "reject" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") {
        if (proposal.status === "proposed" && (title !== proposal.title || goal !== proposal.goal)) {
          onChanged(await api.patchHeadPmInitiativeProposal(proposal.id, { title, goal }));
        }
        const result = await api.approveHeadPmInitiativeProposal(proposal.id);
        onChanged(result.proposal);
        onOpenInitiative?.(result.initiativeId);
      } else if (action === "reject") {
        onChanged(await api.rejectHeadPmInitiativeProposal(proposal.id));
      } else {
        onChanged(await api.dismissHeadPmInitiativeProposal(proposal.id));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-2 rounded-xl border border-border px-3 py-2.5 text-xs"
      aria-label={tr("headPm.initiativeProposal.title", { title: proposal.title })}
      data-testid="head-pm-initiative-proposal"
      data-status={proposal.status}
      data-id={proposal.id}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {proposal.status === "proposed" ? (
            <>
              <input
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm font-semibold"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="head-pm-initiative-proposal-title"
              />
              <input
                className="w-full rounded border border-input bg-background px-2 py-1 text-[11px]"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={tr("headPm.initiative.goalPlaceholder")}
                data-testid="head-pm-initiative-proposal-goal"
              />
            </>
          ) : (
            <>
              <h4 className="text-sm font-semibold">{proposal.title}</h4>
              {proposal.goal && <p className="text-muted-foreground">{proposal.goal}</p>}
            </>
          )}
        </div>
        <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px]">
          {tr(`headPm.initiativeProposal.status.${proposal.status}` as "headPm.initiativeProposal.status.proposed")}
        </span>
      </header>
      {proposal.description && <p className="break-words text-muted-foreground">{proposal.description}</p>}
      <ul className="space-y-1.5">
        {proposal.contributions.map((c) => (
          <li key={c.projectPath} className="rounded-lg border border-border/70 px-2 py-1.5" data-testid="head-pm-initiative-proposal-project" data-path={c.projectPath}>
            <button type="button" className="font-medium underline decoration-dotted" onClick={() => onOpenProject(c.projectPath)}>
              {c.projectName}
            </button>
            <p className="mt-0.5 text-muted-foreground">{c.objective}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words">{c.request}</p>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">{tr("headPm.initiativeProposal.disclaimer")}</p>
      {proposal.initiativeId && (
        <Button type="button" size="sm" variant="outline" data-testid="head-pm-initiative-proposal-open" onClick={() => onOpenInitiative?.(proposal.initiativeId!)}>
          {tr("headPm.initiativeProposal.openInitiative")}
        </Button>
      )}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      {proposal.status === "proposed" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || !title.trim()} onClick={() => void run("approve")} data-testid="head-pm-initiative-proposal-approve">
            <Check className="size-3.5" aria-hidden />{tr("headPm.initiativeProposal.approve")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run("reject")} data-testid="head-pm-initiative-proposal-reject">
            <X className="size-3.5" aria-hidden />{tr("headPm.initiativeProposal.reject")}
          </Button>
        </div>
      )}
    </section>
  );
}
