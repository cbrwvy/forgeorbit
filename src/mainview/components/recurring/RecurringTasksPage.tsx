import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { History, Pause, Pencil, Play, Plus, Repeat, StopCircle, Zap } from "lucide-react";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UrgencyBadge } from "@/components/kanban/UrgencyBadge";
import { api } from "@/lib/api";
import {
  formatRecurrenceSummary,
  type RecurringOccurrenceHistoryItem,
  type RecurringTemplateView,
} from "../../../shared/recurring-tasks.ts";
import { formatLocalTimePreview, formatUtcTimestamp } from "../../../shared/task-availability.ts";
import type { Project } from "../../../shared/types.ts";
import { RecurringTemplateDialog } from "./RecurringTemplateDialog";

interface Props {
  project: Project;
  onOpenTask?: (taskId: string) => void;
  onTasksChanged?: () => void;
}

export function RecurringTasksPage({ project, onOpenTask, onTasksChanged }: Props) {
  const { locale } = useUILocale();
  const uiLocale: "en" | "ru" = locale === "ru" ? "ru" : "en";

  const [templates, setTemplates] = useState<RecurringTemplateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<RecurringTemplateView | null>(null);
  const [historyTemplateId, setHistoryTemplateId] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<RecurringOccurrenceHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await api.listRecurringTemplates(project.path);
      setTemplates(res.templates ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [project.path]);

  useEffect(() => {
    setLoading(true);
    void loadTemplates();
  }, [loadTemplates]);

  const loadHistory = useCallback(async (templateId: string) => {
    setHistoryTemplateId(templateId);
    setHistoryLoading(true);
    try {
      const res = await api.getRecurringTemplateHistory(templateId, 100);
      setHistoryItems(res.history ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const runAction = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
      await loadTemplates();
      if (historyTemplateId === id) {
        await loadHistory(id);
      }
      onTasksChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const selectedHistoryTemplate = historyTemplateId
    ? templates.find((t) => t.id === historyTemplateId) ?? null
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6" data-testid="recurring-tasks-page">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Repeat className="size-4 text-primary" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">{tr("kanban.recurring.page_title")}</h2>
            </div>
            <p className="text-xs text-muted-foreground">{tr("kanban.recurring.page_subtitle")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="recurring-new-template"
            onClick={() => setCreateOpen(true)}
            className="gap-1.5"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {tr("kanban.recurring.new_template")}
          </Button>
        </div>

        {loading ? (
          <div className="rounded-lg border border-border/60 bg-card p-6 text-center text-xs text-muted-foreground">
            {tr("common.loading")}
          </div>
        ) : templates.length === 0 ? (
          <div
            className="rounded-lg border border-dashed border-border/70 bg-card/60 p-8 text-center text-sm text-muted-foreground"
            data-testid="recurring-empty"
          >
            {tr("kanban.recurring.empty")}
          </div>
        ) : (
          <div className="space-y-3" data-testid="recurring-template-list">
            {templates.map((tpl) => {
              const busy = busyId === tpl.id;
              const summary = formatRecurrenceSummary(tpl.schedule, uiLocale);
              const nextLocal = tpl.nextDueUtc ? formatLocalTimePreview(tpl.nextDueUtc, uiLocale) : null;
              const statusVariant =
                tpl.status === "active" ? "success" : tpl.status === "paused" ? "warning" : "secondary";

              return (
                <div
                  key={tpl.id}
                  data-testid="recurring-template-card"
                  data-template-id={tpl.id}
                  data-status={tpl.status}
                  className="rounded-lg border border-border/70 bg-card p-3.5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-[17rem] flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="text-sm font-semibold text-foreground" data-testid="recurring-template-title">
                          {tpl.title}
                        </h3>
                        <Badge variant={statusVariant} data-testid="recurring-template-status">
                          {tr(`kanban.recurring.status.${tpl.status}` as TranslationKey)}
                        </Badge>
                        <UrgencyBadge urgency={tpl.urgency} />
                        <Badge variant="outline" data-testid="recurring-template-submission">
                          {tr(`kanban.recurring.submission.${tpl.submissionMode}` as TranslationKey)}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 font-medium text-foreground/90" data-testid="recurring-template-frequency">
                          <Repeat className="size-3 text-primary" aria-hidden="true" />
                          {summary}
                        </span>
                        <span data-testid="recurring-template-next">
                          {tpl.nextDueUtc
                            ? tr("kanban.recurring.next_occurrence_value", { time: formatUtcTimestamp(tpl.nextDueUtc, uiLocale) })
                            : tpl.recurrenceType === "after_completion" && tpl.stats.activeOccurrence
                              ? tr("kanban.recurring.next_after_done")
                              : tr("kanban.recurring.next_none")}
                          {nextLocal ? ` (${nextLocal.offsetLabel}: ${nextLocal.text})` : ""}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      {tpl.status !== "stopped" && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-2 text-xs"
                            data-testid="recurring-action-edit"
                            disabled={busy}
                            onClick={() => setEditingTemplate(tpl)}
                          >
                            <Pencil className="size-3" aria-hidden="true" />
                            {tr("kanban.recurring.action.edit")}
                          </Button>
                          {tpl.status === "active" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 px-2 text-xs"
                              data-testid="recurring-action-pause"
                              disabled={busy}
                              onClick={() =>
                                void runAction(tpl.id, async () => {
                                  await api.pauseRecurringTemplate(tpl.id);
                                  toast.success(tr("kanban.recurring.template_paused"));
                                })
                              }
                            >
                              <Pause className="size-3" aria-hidden="true" />
                              {tr("kanban.recurring.action.pause")}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 px-2 text-xs"
                              data-testid="recurring-action-resume"
                              disabled={busy}
                              onClick={() =>
                                void runAction(tpl.id, async () => {
                                  await api.resumeRecurringTemplate(tpl.id);
                                  toast.success(tr("kanban.recurring.template_resumed"));
                                })
                              }
                            >
                              <Play className="size-3" aria-hidden="true" />
                              {tr("kanban.recurring.action.resume")}
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-7 gap-1 px-2 text-xs"
                            data-testid="recurring-action-run-now"
                            disabled={busy}
                            onClick={() =>
                              void runAction(tpl.id, async () => {
                                await api.triggerRecurringTemplate(tpl.id);
                                toast.success(tr("kanban.recurring.one_off_created"));
                              })
                            }
                          >
                            <Zap className="size-3" aria-hidden="true" />
                            {tr("kanban.recurring.action.run_now")}
                          </Button>
                        </>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant={historyTemplateId === tpl.id ? "default" : "ghost"}
                        className="h-7 gap-1 px-2 text-xs"
                        data-testid="recurring-action-history"
                        disabled={busy}
                        onClick={() => {
                          if (historyTemplateId === tpl.id) setHistoryTemplateId(null);
                          else void loadHistory(tpl.id);
                        }}
                      >
                        <History className="size-3" aria-hidden="true" />
                        {tr("kanban.recurring.action.history")}
                      </Button>
                      {tpl.status !== "stopped" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 px-2 text-xs text-danger hover:text-danger"
                          data-testid="recurring-action-stop"
                          disabled={busy}
                          onClick={() =>
                            void runAction(tpl.id, async () => {
                              await api.stopRecurringTemplate(tpl.id);
                              toast.success(tr("kanban.recurring.template_stopped"));
                            })
                          }
                        >
                          <StopCircle className="size-3" aria-hidden="true" />
                          {tr("kanban.recurring.action.stop")}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Stats & active/latest occurrence row */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                    <span>{tr("kanban.recurring.stat.generated", { count: String(tpl.stats.totalGenerated) })}</span>
                    <span>{tr("kanban.recurring.stat.completed", { count: String(tpl.stats.completed) })}</span>
                    <span>{tr("kanban.recurring.stat.unresolved", { count: String(tpl.stats.unresolved) })}</span>
                    {tpl.stats.skipped > 0 && (
                      <span>{tr("kanban.recurring.stat.skipped", { count: String(tpl.stats.skipped) })}</span>
                    )}
                    {tpl.stats.activeOccurrence?.taskId && (
                      <button
                        type="button"
                        onClick={() => onOpenTask?.(tpl.stats.activeOccurrence!.taskId!)}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                        data-testid="recurring-active-occurrence-link"
                      >
                        {tr("kanban.recurring.active_occ", {
                          title: tpl.stats.activeOccurrence.taskTitle ?? tpl.stats.activeOccurrence.taskId.slice(0, 8),
                        })}
                      </button>
                    )}
                    {!tpl.stats.activeOccurrence && tpl.stats.latestOccurrence && (
                      <span>
                        {tr("kanban.recurring.latest", {
                          value: formatUtcTimestamp(tpl.stats.latestOccurrence.nominalUtc, uiLocale),
                        })}
                      </span>
                    )}
                  </div>

                  {/* Inline Occurrence History table */}
                  {selectedHistoryTemplate?.id === tpl.id && (
                    <div
                      className="mt-3 rounded-md border border-border/60 bg-muted/20 p-2.5"
                      data-testid="recurring-history-panel"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-foreground">{tr("kanban.recurring.history_title")}</span>
                      </div>
                      {historyLoading ? (
                        <p className="text-xs text-muted-foreground">{tr("common.loading")}</p>
                      ) : historyItems.length === 0 ? (
                        <p className="text-xs text-muted-foreground" data-testid="recurring-history-empty">
                          {tr("kanban.recurring.history_empty")}
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-left text-[11px]">
                            <thead>
                              <tr className="border-b border-border/60 text-muted-foreground">
                                <th className="py-1 pr-3 font-medium">{tr("kanban.recurring.history_nominal")}</th>
                                <th className="py-1 pr-3 font-medium">{tr("kanban.recurring.history_status")}</th>
                                <th className="py-1 pr-3 font-medium">{tr("kanban.recurring.history_created")}</th>
                                <th className="py-1 pr-3 font-medium">{tr("kanban.recurring.history_completed")}</th>
                                <th className="py-1 font-medium">{tr("kanban.recurring.history_reason")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {historyItems.map((item) => (
                                <tr
                                  key={item.id}
                                  data-testid="recurring-history-row"
                                  data-occ-status={item.status}
                                  className="border-b border-border/40 last:border-b-0"
                                >
                                  <td className="py-1.5 pr-3 font-mono text-foreground">
                                    {formatUtcTimestamp(item.nominalUtc, uiLocale)}
                                    {item.kind === "manual_one_off" && (
                                      <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px]">
                                        {tr("kanban.recurring.history_manual_badge")}
                                      </Badge>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    {item.status === "skipped" ? (
                                      <Badge variant="secondary" className="text-[10px]">
                                        {tr("kanban.recurring.history_skipped_badge")}
                                      </Badge>
                                    ) : (
                                      <Badge
                                        variant={item.taskColumn === "done" ? "success" : "outline"}
                                        className="text-[10px]"
                                      >
                                        {item.taskColumn ?? "—"}
                                      </Badge>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                                    {formatUtcTimestamp(new Date(item.createdAt).toISOString(), uiLocale)}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                                    {item.taskCompletedAt
                                      ? formatUtcTimestamp(new Date(item.taskCompletedAt).toISOString(), uiLocale)
                                      : "—"}
                                  </td>
                                  <td className="py-1.5 text-muted-foreground">
                                    {item.status === "skipped" && item.skipReason ? (
                                      <span>{tr(`kanban.recurring.skip.${item.skipReason}` as TranslationKey)}</span>
                                    ) : item.taskId ? (
                                      <button
                                        type="button"
                                        onClick={() => onOpenTask?.(item.taskId!)}
                                        className="text-primary underline-offset-2 hover:underline"
                                        data-testid="recurring-history-open-task"
                                      >
                                        {item.taskTitle ?? tr("kanban.recurring.action.open_task")}
                                      </button>
                                    ) : (
                                      "—"
                                    )}
                                    {item.submissionError && (
                                      <span className="ml-1.5 text-warning">({item.submissionError})</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <RecurringTemplateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectPath={project.path}
        onSaved={() => {
          void loadTemplates();
          onTasksChanged?.();
        }}
      />

      <RecurringTemplateDialog
        open={Boolean(editingTemplate)}
        onClose={() => setEditingTemplate(null)}
        projectPath={project.path}
        template={editingTemplate}
        onSaved={() => {
          void loadTemplates();
          onTasksChanged?.();
        }}
      />
    </div>
  );
}
