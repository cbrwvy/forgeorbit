import { HeadAutoPanel } from "./HeadAutoPanel";
import { t as tr } from "@/i18n/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { codeLabel } from "@/i18n/presentation";
import type { HeadPmInitiativeView, InitiativeStatus } from "../../../shared/head-pm-initiative.ts";
import type { DelegationView } from "../../../shared/portfolio-manager.ts";
import { DelegationCard } from "../workspace/portfolio/DelegationCard";

interface Props {
  refreshToken: string;
  focusInitiativeId?: string | null;
  focusRequest?: number;
  delegations: readonly DelegationView[];
  onDelegationChanged: (view: DelegationView) => void;
  onOpenProject: (projectPath: string) => void;
  onOpenProjectManager: (projectPath: string, view?: "chat" | "inbox" | "plan" | "runs") => void;
  onOpenTask: (taskId: string, projectPath: string) => void;
  onOpenNeedsYou: () => void;
}

function statusLabel(status: InitiativeStatus): string {
  return tr(`headPm.initiative.status.${status}` as "headPm.initiative.status.draft");
}

export function HeadPmInitiativesPanel({
  refreshToken,
  focusInitiativeId,
  focusRequest,
  delegations,
  onDelegationChanged,
  onOpenProject,
  onOpenProjectManager,
  onOpenTask,
  onOpenNeedsYou,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const [items, setItems] = useState<HeadPmInitiativeView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (items.length === 0) setLoading(true);
    return api.listHeadPmInitiatives().then(
      (list) => {
        setItems(list.filter((i) => i.status !== "cancelled"));
        setError(null);
        setLoading(false);
      },
      () => {
        setError(tr("headPm.initiative.loadFailed"));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => { reload(); }, [reload, refreshToken]);

  useEffect(() => {
    if (!focusInitiativeId) return;
    void reload().then(() => setSelectedId(focusInitiativeId));
  }, [focusInitiativeId, reload]);

  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  useEffect(() => {
    if (!focusInitiativeId || selected?.id !== focusInitiativeId) return;
    // The chat can be scrolled to the proposal below this panel. Selection
    // alone leaves the approved initiative outside the visible log viewport.
    const frame = requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
      panelRef.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusInitiativeId, focusRequest, selected?.id]);

  const linkBatch = async (initiativeId: string, projectPath: string, batchId: string) => {
    if (!batchId.trim()) return;
    await api.linkHeadPmInitiativeBatch(initiativeId, projectPath, batchId.trim());
    reload();
  };

  if (loading && items.length === 0 && !focusInitiativeId) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="head-pm-initiatives-loading" role="status">
        {tr("headPm.initiative.loading")}
      </p>
    );
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="rounded-md border border-border/80 bg-muted/20 px-2 py-1.5 text-[11px]"
      aria-label={tr("headPm.initiative.title")}
      data-testid="head-pm-initiatives"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">{tr("headPm.unified.legacyInitiatives")}</h3>
      </div>
      {error && <p className="mt-1 text-danger" role="alert">{error}</p>}

      {items.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`rounded border px-2 py-0.5 text-[10px] ${selected?.id === item.id ? "border-primary bg-primary/10" : "border-border"}`}
                data-testid="head-pm-initiative-row"
                data-id={item.id}
                data-status={item.status}
                onClick={() => setSelectedId(item.id)}
              >
                {item.title} · {statusLabel(item.status)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="mt-2 space-y-2" data-testid="head-pm-initiative-detail" data-status={selected.status}>
          <p className="text-muted-foreground">{selected.goal || selected.description || tr("headPm.initiative.noGoal")}</p>
          {selected.sourceProposalId && (
            <p className="text-[10px] text-muted-foreground" data-testid="head-pm-initiative-from-chat">{tr("headPm.initiative.fromChat")}</p>
          )}
          {selected.blockers.length > 0 && (
            <p className="text-warning" data-testid="head-pm-initiative-blockers">
              {selected.blockers.slice(0, 4).join(" ")}
              <button type="button" className="ml-1 underline" onClick={onOpenNeedsYou}>{tr("headPm.initiative.openNeedsYou")}</button>
            </p>
          )}
          <HeadAutoPanel key={selected.id} initiative={selected} onOpenManager={onOpenProjectManager} />
          <ul className="space-y-2">
            {selected.contributions.map((c) => {
              const delegation = c.delegationId ? delegations.find((d) => d.id === c.delegationId) : null;
              const tasks = selected.tasks.filter((t) => c.taskIds.includes(t.id));
              return (
                <li key={c.projectPath} className="rounded border border-border/60 p-1.5" data-testid="head-pm-initiative-contribution" data-path={c.projectPath} data-progress={c.progress}>
                  <div className="flex flex-wrap items-center gap-1">
                    <button type="button" className="font-medium underline decoration-dotted" onClick={() => onOpenProject(c.projectPath)}>
                      {c.projectName}
                    </button>
                    {c.clusterName && <span className="text-muted-foreground">({c.clusterName})</span>}
                    {c.pmName && <span className="text-muted-foreground">{tr("m0.pmName", { name: c.pmName })}</span>}
                    <span className="text-muted-foreground">· {tr(`headPm.initiative.contribution.${c.progress}` as "headPm.initiative.contribution.pending_delegation")}</span>
                  </div>
                  {c.delegationId && <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-6 px-1 text-[10px] underline"
                    data-testid="head-pm-initiative-open-pm"
                    data-path={c.projectPath}
                    onClick={() => onOpenProjectManager(c.projectPath, "chat")}
                  >
                    {tr("headPm.unified.legacy")}
                  </Button>}
                  {delegation && (
                    <div className="mt-1">
                      <DelegationCard delegation={delegation} onChanged={onDelegationChanged} onOpenProjectManager={onOpenProjectManager} />
                    </div>
                  )}
                  {tasks.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {tasks.map((t) => (
                        <li key={t.id}>
                          <button
                            type="button"
                            className="underline decoration-dotted"
                            data-testid="head-pm-initiative-task"
                            data-task-id={t.id}
                            onClick={() => onOpenTask(t.id, c.projectPath)}
                          >
                            {t.title} ({codeLabel(t.column)}{t.awaitingOwnerQc ? ` · ${tr("headPm.initiative.qcAwaitingOwner")}` : ""})
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.batches.filter((b) => b.projectPath === c.projectPath).map((b) => (
                    <p key={b.id} className="mt-0.5 text-muted-foreground" data-testid="head-pm-initiative-batch" data-batch-id={b.id} data-status={b.status}>
                      {tr("headPm.initiative.batchLine", { title: b.title, status: b.status })}
                      {b.needsAttention ? ` · ${tr("headPm.initiative.batchAttention")}` : ""}
                    </p>
                  ))}
                  {selected.status !== "cancelled" && (
                    <form
                      className="mt-1 flex flex-wrap gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        void linkBatch(selected.id, c.projectPath, String(fd.get("batchId") ?? ""));
                      }}
                    >
                      <input
                        name="batchId"
                        className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-[10px]"
                        placeholder={tr("headPm.initiative.linkBatch")}
                        data-testid="head-pm-initiative-link-batch-input"
                        data-path={c.projectPath}
                      />
                      <Button type="submit" size="sm" variant="outline" className="h-6 text-[10px]" data-testid="head-pm-initiative-link-batch" data-path={c.projectPath}>
                        {tr("headPm.initiative.linkBatchAction")}
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
