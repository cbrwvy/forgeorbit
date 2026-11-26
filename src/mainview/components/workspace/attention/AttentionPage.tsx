import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Gauge, HelpCircle, Inbox, PauseCircle, Workflow } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { api } from "@/lib/api";
import { awaitingLabel } from "@/lib/awaiting";
import { attentionLinks, type AttentionLink } from "@/lib/portfolio";
import { ownerActions } from "@/lib/owner-actions";
import { collectAttention, summarizeAttention, type AttentionItem, type AttentionKind, type AttentionTask } from "@/lib/attention";
import { cn } from "@/lib/utils";
import { shortenPath } from "@/lib/path-display";
import { projectLabel } from "@/lib/workspace";
import { PageHeader } from "../PageHeader";
import { ProjectPermissionRequests } from "@/components/permissions/ProjectPermissionRequests";
import { HandsoffAttention } from "@/components/handsoff/HandsoffAttention";
import type { OwnerActionsPayload } from "../../../../shared/owner-actions.ts";
import type { Project, Task } from "../../../../shared/types.ts";

interface Props {
  tasks: readonly Task[];
  projects: readonly Project[];
  homeDir: string;
  onOpenTask: (task: Task) => void;
  /** Portfolio holds what is not a task: batches, quota gaps, missing data. */
  onOpenPortfolio?: () => void;
  /** What the core holds beyond the board: pending approvals and batches on hold. */
  ownerRows?: OwnerActionsPayload | null;
  onOpenProjectManager?: (projectPath: string, view?: "chat" | "inbox" | "plan" | "runs") => void;
  onOpenPortfolioManager?: () => void;
  /** Back to Home, where this list is summarized (M3). */
  onOpenHome?: () => void;
  /** The core's pending list changed after a decision: re-read it. */
  onOwnerActionsChanged?: () => void;
}

const ICON: Record<AttentionKind, ReactNode> = {
  answer: <HelpCircle className="size-4" aria-hidden />,
  "pipeline-blocked": <Workflow className="size-4" aria-hidden />,
  blocked: <AlertTriangle className="size-4" aria-hidden />,
  "fx-paused": <PauseCircle className="size-4" aria-hidden />,
  "qc-owner": <ClipboardCheck className="size-4" aria-hidden />,
  review: <CheckCircle2 className="size-4" aria-hidden />,
};

/** What the Owner is asked to do — said plainly, per kind. A blocked task is a decision,
 *  never an "approval"; only proposals and delegations are approvals (and live in Manager). */
function hintFor(kind: AttentionKind): string {
  switch (kind) {
    case "answer": return tr("uxfix.attn.hint_answer");
    case "pipeline-blocked": return tr("uxfix.attn.hint_pipeline");
    case "blocked": return tr("uxfix.attn.hint_blocked");
    case "fx-paused": return tr("uxfix.attn.hint_paused");
    case "qc-owner": return tr("uxfix.attn.hint_qc_owner");
    default: return tr("uxfix.attn.hint_review");
  }
}

export function attentionActionLabel(kind: AttentionKind): string {
  return kind === "answer" ? tr("uxfix.attn.act_answer") : kind === "qc-owner" ? tr("uxfix.attn.act_accept") : kind === "review" ? tr("uxfix.attn.act_review") : tr("uxfix.attn.act_open");
}

export function attentionKindLabel(item: AttentionItem): string {
  switch (item.kind) {
    case "answer": return awaitingLabel(item.count);
    case "pipeline-blocked": return tr("attention.kind_pipeline");
    case "blocked": return tr("attention.kind_blocked");
    case "fx-paused": return tr("attention.kind_fx_paused");
    case "qc-owner": return tr("attention.kind_qc_owner");
    default: return tr("attention.kind_review");
  }
}

/**
 * "Needs you" (FO-UX02-D, variant A): one list of everything on the board that
 * is waiting for the Owner, most urgent first. It only reads the tasks the app
 * already polls and opens the same panel/run view the board card opens — no
 * approval happens here. Proposals, delegations and batch holds stay on their
 * own pages for now (see the source note under the list).
 */
export function AttentionPage({ tasks, projects, homeDir, onOpenTask, onOpenPortfolio, ownerRows, onOpenProjectManager, onOpenPortfolioManager, onOpenHome, onOwnerActionsChanged }: Props) {
  useUILocale();
  const items = useMemo(() => collectAttention(tasks as readonly AttentionTask[]), [tasks]);
  const summary = summarizeAttention(items);
  const actions = ownerActions(tasks as readonly AttentionTask[], { rows: ownerRows });
  const nameOf = (path: string) => { const project = projects.find((p) => p.path === path); return project ? projectLabel(project) : shortenPath(path, homeDir); };
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const approvalRows = useMemo(() => [
    ...(ownerRows?.proposals ?? []).map((row) => ({ ...row, kind: "proposal" as const })),
    ...(ownerRows?.delegations ?? []).map((row) => ({ ...row, kind: "delegation" as const })),
    ...(ownerRows?.deploymentRequestHolds ?? []).map((row) => ({ ...row, kind: "deployment" as const })),
  ], [ownerRows]);
  const memoryRows = ownerRows?.memoryProposals ?? [];
  const batchRows = ownerRows?.batchHolds ?? [];
  // Resource / quota gaps come from the same read-only portfolio snapshot the Portfolio page uses.
  const [resources, setResources] = useState<AttentionLink[] | "loading" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    void api.getPortfolioAnalysis().then(
      (result) => { if (!cancelled) setResources(attentionLinks(result.analysis).filter((link) => link.page === "portfolio")); },
      () => { if (!cancelled) setResources("failed"); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="attention-page">
      <PageHeader
        eyebrow={onOpenHome && (
          <nav aria-label={tr("nav.location")} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <button type="button" className="glass-nav-item rounded-md px-1.5 py-0.5" data-testid="attention-back-home" onClick={onOpenHome}>{tr("nav.home")}</button>
            <span aria-hidden>/</span>
            <span>{tr("attention.title")}</span>
          </nav>
        )}
        title={<I18nText id="attention.title" />} titleTestId="attention-title" subtitle={<I18nText id="attention.subtitle" />}>
        <p className="text-[length:var(--text-secondary)] text-muted-foreground" role="status" data-testid="attention-count">
          {tr("attention.count", { p0: String(actions.total) })}
        </p>
      </PageHeader>
      <div className="flex flex-col gap-stack px-4 pb-[calc(2rem+var(--shell-dock-clearance))] sm:px-page">
        {actions.total === 0 ? (
          <EmptyState
            className="surface-solid rounded-xl border"
            testId="attention-empty"
            title={<I18nText id="attention.empty" />}
            description={<I18nText id="attention.empty_hint" />}
          />
        ) : null}
        {items.length > 0 && (
          <ul className="surface-solid overflow-hidden rounded-xl border" aria-label={tr("attention.title")}>
            {items.map((item) => {
              const task = byId.get(item.taskId);
              const project = projects.find((p) => p.path === item.projectPath);
              return (
                <li key={item.taskId} className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] last:border-b-0" data-testid="attention-row" data-kind={item.kind} data-task-id={item.taskId}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-row">
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium text-foreground ring-1",
                        item.kind === "review" ? "bg-success/10 ring-success/50" : item.kind === "fx-paused" ? "bg-info/10 ring-info/50" : "bg-warning/10 ring-warning/60",
                      )}
                      data-testid="attention-kind"
                    >
                      {ICON[item.kind]}
                      {attentionKindLabel(item)}
                    </span>
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate text-sm font-medium" title={item.title}>{item.title}</p>
                      <p className="truncate text-[length:var(--text-secondary)] text-muted-foreground" title={item.projectPath}>
                        {project ? projectLabel(project) : shortenPath(item.projectPath, homeDir)}
                      </p>
                      <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="attention-hint">{hintFor(item.kind)}</p>
                    </div>
                    <Button type="button" size="sm" variant="outline" disabled={!task} onClick={() => task && onOpenTask(task)} data-testid="attention-open">
                      {attentionActionLabel(item.kind)}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {approvalRows.length > 0 && (
          <section aria-labelledby="attention-approvals-heading" className="space-y-2" data-testid="attention-approvals">
            <div>
              <h2 id="attention-approvals-heading" className="text-sm font-semibold">{tr("uxfix.attn.sec_approvals")}</h2>
              <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("uxfix.attn.sec_approvals_hint")}</p>
            </div>
            <ul className="surface-solid overflow-hidden rounded-xl border">
              {approvalRows.map((row) => (
                <li key={`${row.kind}:${row.id}`} className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid="attention-approval" data-kind={row.kind}>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-warning/10 px-2 py-0.5 text-xs font-medium ring-1 ring-warning/60">
                    <ClipboardCheck className="size-4" aria-hidden />
                    {row.kind === "proposal" ? tr("uxfix.attn.proposal") : row.kind === "delegation" ? tr("uxfix.attn.delegation") : tr("m0.deployment")}
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium" title={row.title}>{row.title}</p>
                    <p className="truncate text-[length:var(--text-secondary)] text-muted-foreground" title={row.projectPath}>{nameOf(row.projectPath)}</p>
                  </div>
                  <Button
                    type="button" size="sm" variant="outline"
                    onClick={() => (row.kind === "proposal" ? onOpenProjectManager?.(row.projectPath, "chat") : row.kind === "delegation" ? onOpenPortfolioManager?.() : undefined)}
                    data-testid="attention-approval-open"
                    data-kind={row.kind}
                  >{row.kind === "deployment" ? tr("m0.reviewDeployment") : tr("uxfix.attn.act_approve")}</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <HandsoffAttention rows={ownerRows?.handsoffBlockers ?? []} projectName={nameOf} onOpenTask={(taskId) => { const task = byId.get(taskId); if (task) onOpenTask(task as never); }} />

        <ProjectPermissionRequests rows={ownerRows?.projectPermissionRequests ?? []} projectName={nameOf} onChanged={() => onOwnerActionsChanged?.()} />

        {memoryRows.length > 0 && (
          <section aria-labelledby="attention-memory-heading" className="space-y-2" data-testid="attention-memory-proposals">
            <div>
              <h2 id="attention-memory-heading" className="text-sm font-semibold">{tr("brain.proposal.needs_you")}</h2>
              <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("brain.proposal.needs_you_hint")}</p>
            </div>
            <ul className="surface-solid overflow-hidden rounded-xl border">
              {memoryRows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid="attention-memory-proposal" data-kind="memory-proposal" data-scope={row.scopeKind}>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-info/10 px-2 py-0.5 text-xs font-medium ring-1 ring-info/50">
                    {tr("brain.proposal.review")}
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium" title={row.title}>{row.title}</p>
                    <p className="truncate text-[length:var(--text-secondary)] text-muted-foreground">
                      {tr(`brain.proposal.scope.${row.scopeKind}`)}
                      {row.scopeKind === "project" && row.projectPath ? ` · ${nameOf(row.projectPath)}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="attention-memory-open"
                    onClick={() => (row.scopeKind === "project" && row.projectPath ? onOpenProjectManager?.(row.projectPath, "chat") : onOpenPortfolioManager?.())}
                  >
                    {tr("brain.proposal.review")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {batchRows.length > 0 && (
          <section aria-labelledby="attention-batches-heading" className="space-y-2" data-testid="attention-batches">
            <h2 id="attention-batches-heading" className="text-sm font-semibold">{tr("uxfix.attn.sec_batches")}</h2>
            <ul className="surface-solid overflow-hidden rounded-xl border">
              {batchRows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid="attention-batch" data-status={row.status}>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-warning/10 px-2 py-0.5 text-xs font-medium ring-1 ring-warning/60">
                    <PauseCircle className="size-4" aria-hidden />{row.status}
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium" title={row.title}>{row.title}</p>
                    <p className="truncate text-[length:var(--text-secondary)] text-muted-foreground" title={row.projectPath}>{nameOf(row.projectPath)}</p>
                    <p className="text-[length:var(--text-secondary)] text-muted-foreground">{row.status === "paused" ? tr("uxfix.attn.batch_paused") : row.status === "approved" ? tr("uxfix.attn.batch_approved") : tr("uxfix.attn.batch_stopped")}</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpenProjectManager?.(row.projectPath, "runs")} data-testid="attention-batch-open">{tr("uxfix.attn.act_runs")}</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="attention-resources-heading" className="space-y-2" data-testid="attention-resources">
          <div>
            <h2 id="attention-resources-heading" className="text-sm font-semibold">{tr("uxfix.attn.sec_resources")}</h2>
            <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("uxfix.attn.sec_resources_hint")}</p>
          </div>
          {resources === "loading" ? (
            <p role="status" className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("uxfix.attn.resources_loading")}</p>
          ) : resources === "failed" ? (
            <p role="status" className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("uxfix.attn.resources_failed")}</p>
          ) : resources.length === 0 ? (
            <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="attention-resources-none">{tr("uxfix.attn.resources_none")}</p>
          ) : (
            <ul className="surface-solid overflow-hidden rounded-xl border">
              {resources.map((link) => (
                <li key={link.id} className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid="attention-resource">
                  <Gauge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="text-sm font-medium">{link.title}</p>
                    <p className="text-[length:var(--text-secondary)] text-muted-foreground">{link.detail}</p>
                  </div>
                  {onOpenPortfolio && <Button type="button" size="sm" variant="ghost" onClick={onOpenPortfolio}>{tr("uxfix.attn.openPortfolio")}</Button>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-xs text-muted-foreground" data-testid="attention-deps-note">{tr("uxfix.attn.deps_note")}</p>
        <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="attention-sources">
          <Inbox className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span className="min-w-0 flex-1">{tr("uxfix.attn.elsewhere")}</span>
          {onOpenPortfolio && (
            <Button type="button" size="sm" variant="ghost" onClick={onOpenPortfolio} data-testid="attention-open-portfolio">{tr("uxfix.attn.openPortfolio")}</Button>
          )}
        </p>
      </div>
    </div>
  );
}
