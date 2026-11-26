import { codeLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  Clock,
  Layers,
  Loader2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { RunbookDetail, RunbookSummary } from "../../../../shared/hiring/types.ts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectRunbook?: (runbook: RunbookDetail) => void;
}

export function RunbookScenariosDialog({ open, onOpenChange, onSelectRunbook }: Props) {
  useUILocale();
  const [runbooks, setRunbooks] = useState<RunbookSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunbookDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingList(true);
    void api.listRunbooks().then(
      (res) => {
        setRunbooks(res.runbooks);
        if (res.runbooks.length > 0 && !selectedSlug) {
          setSelectedSlug(res.runbooks[0]!.slug);
        }
        setLoadingList(false);
      },
      () => setLoadingList(false),
    );
  }, [open, selectedSlug]);

  useEffect(() => {
    if (!selectedSlug) return;
    setLoadingDetail(true);
    void api.getRunbook(selectedSlug).then(
      (res) => {
        setDetail(res.runbook);
        setLoadingDetail(false);
      },
      () => setLoadingDetail(false),
    );
  }, [selectedSlug]);

  if (!open) return null;

  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} labelledBy="runbooks-title" className="max-w-4xl p-0">
      <div
        data-testid="runbooks-dialog"
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col p-4 text-xs sm:p-5"
      >
        <header className="flex shrink-0 items-start justify-between gap-2 border-b pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-primary" aria-hidden />
              <h3 id="runbooks-title" className="text-base font-semibold"><I18nText id="employees.local_runbook_scenarios" /></h3>
            </div>
            <p className="text-xs text-muted-foreground"><I18nText id="employees.pre_configured_battle_tested_ai_team_blueprints_from" />{" "}</p>
          </div>
          <button
            type="button"
            aria-label={tr("common.close")}
            onClick={() => onOpenChange(false)}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3 sm:flex-row">
          {/* Runbook selection list */}
          <aside className="max-h-48 shrink-0 space-y-2 overflow-y-auto border-b pb-3 sm:max-h-none sm:w-1/3 sm:min-w-[200px] sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
            {loadingList ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="size-4 animate-spin mr-2" aria-hidden /><I18nText id="employees.loading_blueprints" />{" "}</div>
            ) : (
              runbooks.map((rb) => (
                <button
                  key={rb.slug}
                  type="button"
                  data-testid={`runbook-option-${rb.slug}`}
                  onClick={() => setSelectedSlug(rb.slug)}
                  className={cn(
                    "w-full text-left rounded-lg p-2.5 transition-colors border",
                    selectedSlug === rb.slug
                      ? "border-primary/50 bg-primary/10 shadow-sm"
                      : "border-transparent bg-muted/40 hover:bg-muted hover:border-border",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground truncate">{rb.title}</span>
                    <span className="text-[10px] rounded bg-muted px-1 py-0.5 font-mono text-muted-foreground">
                      {codeLabel(rb.mode)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{rb.summary}</p>
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" aria-hidden />
                      {rb.duration}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3" aria-hidden />
                      {rb.totalAgents}{" "}<I18nText id="employees.roles" />{" "}</span>
                  </div>
                </button>
              ))
            )}
          </aside>

          {/* Runbook roster detail */}
          <div className="min-w-0 flex-1 space-y-4 sm:overflow-y-auto sm:pl-1">
            {loadingDetail || !detail ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin mr-2" aria-hidden /><I18nText id="employees.loading_blueprint_details" />{" "}</div>
            ) : (
              <>
                <div className="rounded-lg border bg-muted/50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-foreground">{detail.title}</h4>
                    <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {codeLabel(detail.mode)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{detail.summary}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
                    <span><I18nText id="employees.duration" />{" "}<strong className="text-foreground">{detail.duration}</strong>
                    </span>
                    <span><I18nText id="employees.total_recommended_roles" />{" "}
                      <strong className="text-foreground">{detail.totalAgents}</strong>
                    </span>
                  </div>
                </div>

                <div className="space-y-3">
                  <h5 className="font-semibold text-foreground flex items-center gap-1.5">
                    <Layers className="size-3.5 text-primary" aria-hidden /><I18nText id="employees.team_composition_by_phase" />{" "}</h5>

                  {detail.roster.map((group) => (
                    <div
                      key={group.group}
                      className="rounded-lg border bg-muted/30 p-2.5 space-y-2"
                    >
                      <div className="flex items-center justify-between border-b pb-1.5 text-[11px]">
                        <span className="font-semibold text-foreground">{group.group}</span>
                        <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"><I18nText id="employees.activation" />{" "}{group.activation}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {group.agents.map((agent) => (
                          <div
                            key={agent.slug}
                            className="flex items-center gap-2 rounded-md border bg-muted/60 p-1.5 text-[11px]"
                          >
                            <span
                              className="flex size-6 shrink-0 items-center justify-center rounded text-xs"
                              style={{
                                backgroundColor: `${agent.color}20`,
                                borderColor: `${agent.color}40`,
                                borderWidth: 1,
                              }}
                            >
                              {agent.emoji}
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground truncate">{agent.name}</p>
                              <p className="text-[10px] text-muted-foreground truncate font-mono">
                                {agent.slug}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-[11px] text-muted-foreground"><I18nText id="employees.runbooks_are_recommendations_no_agents_are_automatically_executed" />{" "}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}><I18nText id="common.close" />{" "}</Button>
            {detail && onSelectRunbook && (
              <Button
                type="button"
                size="sm"
                data-testid="use-runbook-button"
                onClick={() => {
                  onSelectRunbook(detail);
                  onOpenChange(false);
                }}
              >
                <Sparkles className="size-3.5 mr-1" aria-hidden /><I18nText id="employees.use_blueprint_in_pm" />{" "}</Button>
            )}
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
