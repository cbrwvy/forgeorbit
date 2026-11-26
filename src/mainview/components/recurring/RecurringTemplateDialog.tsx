import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UrgencySelect } from "@/components/kanban/UrgencyBadge";
import { api } from "@/lib/api";
import { DEFAULT_URGENCY, normalizeUrgency, type Urgency } from "../../../shared/board-order.ts";
import {
  defaultRecurringDraft,
  validateScheduleConfig,
  type RecurringTemplateView,
} from "../../../shared/recurring-tasks.ts";
import { formatUtcTimestamp } from "../../../shared/task-availability.ts";
import type { Task } from "../../../shared/types.ts";
import { RecurringScheduleFields, type RecurringDraftState } from "./RecurringScheduleFields";

interface EmployeeOption {
  id: string;
  name: string;
  jobTitle: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  /** When set, edits an existing recurring template (future occurrences only). */
  template?: RecurringTemplateView | null;
  /** When set (and `template` is absent), converts an eligible ordinary task into a recurring template. */
  sourceTask?: Task | null;
  onSaved?: (template: RecurringTemplateView) => void;
}

function draftFromTemplate(tpl: RecurringTemplateView): RecurringDraftState {
  return {
    recurrenceType: tpl.schedule.recurrenceType,
    interval: tpl.schedule.interval,
    intervalUnit: tpl.schedule.intervalUnit,
    weekdays: tpl.schedule.weekdays,
    monthlyMode: tpl.schedule.monthlyMode,
    dayOfMonth: tpl.schedule.dayOfMonth,
    missingDayPolicy: tpl.schedule.missingDayPolicy,
    startDateUtc: tpl.schedule.startDateUtc,
    startTimeUtc: tpl.schedule.startTimeUtc,
    endDateUtc: tpl.schedule.endDateUtc,
    maxOccurrences: tpl.schedule.maxOccurrences,
    submissionMode: tpl.submissionMode,
    overlapPolicy: tpl.overlapPolicy,
    missedPolicy: tpl.missedPolicy,
    catchUpLimit: tpl.catchUpLimit,
  };
}

export function RecurringTemplateDialog({ open, onClose, projectPath, template, sourceTask, onSaved }: Props) {
  const { locale } = useUILocale();
  const uiLocale: "en" | "ru" = locale === "ru" ? "ru" : "en";
  const mode: "edit" | "convert" | "create" = template ? "edit" : sourceTask ? "convert" : "create";

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [urgency, setUrgency] = useState<Urgency>(DEFAULT_URGENCY);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [assignedEmployeeId, setAssignedEmployeeId] = useState<string>("");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [draft, setDraft] = useState<RecurringDraftState>(() => defaultRecurringDraft());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (template) {
      setTitle(template.title);
      setPrompt(template.prompt);
      setUrgency(normalizeUrgency(template.urgency));
      setAcceptanceCriteria(template.templateConfig.acceptanceCriteria ?? "");
      setAssignedEmployeeId(template.templateConfig.assignedEmployeeId ?? "");
      setDraft(draftFromTemplate(template));
    } else if (sourceTask) {
      setTitle(sourceTask.title);
      setPrompt(sourceTask.prompt);
      setUrgency(normalizeUrgency(sourceTask.urgency));
      setAcceptanceCriteria("");
      setAssignedEmployeeId("");
      setDraft(defaultRecurringDraft());
    } else {
      setTitle("");
      setPrompt("");
      setUrgency(DEFAULT_URGENCY);
      setAcceptanceCriteria("");
      setAssignedEmployeeId("");
      setDraft(defaultRecurringDraft());
    }
  }, [open, template, sourceTask]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    api
      .listEmployees({ projectPath })
      .then((res) => {
        if (cancelled) return;
        const active = (res.employees ?? [])
          .filter((e) => e.status === "active" && !e.archivedAt && e.kind === "worker")
          .map((e) => ({ id: e.id, name: e.name, jobTitle: e.jobTitle }));
        setEmployees(active);
      })
      .catch(() => {
        if (!cancelled) setEmployees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  const scheduleValid = useMemo(() => validateScheduleConfig(draft).ok, [draft]);
  const canSave = !busy && title.trim().length > 0 && prompt.trim().length > 0 && scheduleValid;

  const handleSave = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const templateConfig = {
        ...(template?.templateConfig ?? {}),
        acceptanceCriteria: acceptanceCriteria.trim() || null,
        assignedEmployeeId: assignedEmployeeId || null,
      };
      if (mode === "edit" && template) {
        const res = await api.updateRecurringTemplate(template.id, {
          title: title.trim(),
          prompt: prompt.trim(),
          urgency,
          templateConfig,
          ...draft,
        });
        toast.success(tr("kanban.recurring.template_updated"));
        onSaved?.(res.template);
        onClose();
      } else if (mode === "convert" && sourceTask) {
        const res = await api.convertTaskToRecurring(sourceTask.id, {
          title: title.trim(),
          prompt: prompt.trim(),
          urgency,
          templateConfig,
          ...draft,
        });
        toast.success(tr("kanban.recurring.task_details_converted"));
        onSaved?.(res.template);
        onClose();
      } else {
        const res = await api.createRecurringTemplate({
          projectPath,
          title: title.trim(),
          prompt: prompt.trim(),
          urgency,
          templateConfig,
          ...draft,
        });
        toast.success(
          res.template.nextDueUtc
            ? tr("kanban.recurring.template_created", { time: formatUtcTimestamp(res.template.nextDueUtc, uiLocale) })
            : tr("kanban.recurring.template_created_no_next"),
        );
        onSaved?.(res.template);
        onClose();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const heading =
    mode === "edit"
      ? tr("kanban.recurring.edit_dialog_title")
      : mode === "convert"
        ? tr("kanban.recurring.task_details_convert_title")
        : tr("kanban.recurring.create_dialog_title");

  return (
    <Dialog open={open} onClose={onClose} labelledBy="recurring-dialog-title" className="max-w-lg overflow-hidden p-0">
      <div className="flex max-h-[min(85vh,42rem)] flex-col" data-testid="recurring-template-dialog">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 id="recurring-dialog-title" className="text-sm font-semibold">
            {heading}
          </h2>
          <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label={tr("common.close")}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
          {mode === "edit" && (
            <p className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              {tr("kanban.recurring.edit_future_note")}
            </p>
          )}
          {mode === "convert" && (
            <p className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              {tr("kanban.recurring.task_details_convert_hint")}
            </p>
          )}

          <div className="space-y-1">
            <label htmlFor="recurring-dlg-title" className="text-xs text-muted-foreground">
              {tr("kanban.recurring.task_title")}
            </label>
            <Input
              id="recurring-dlg-title"
              data-testid="recurring-dialog-title"
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="recurring-dlg-prompt" className="text-xs text-muted-foreground">
              {tr("kanban.recurring.task_prompt")}
            </label>
            <Textarea
              id="recurring-dlg-prompt"
              data-testid="recurring-dialog-prompt"
              rows={3}
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="recurring-dlg-urgency" className="text-xs text-muted-foreground">
                {tr("kanban.recurring.task_urgency")}
              </label>
              <UrgencySelect
                id="recurring-dlg-urgency"
                testId="recurring-dialog-urgency"
                value={urgency}
                disabled={busy}
                onChange={setUrgency}
              />
            </div>

            {employees.length > 0 && (
              <div className="space-y-1">
                <label htmlFor="recurring-dlg-assignee" className="text-xs text-muted-foreground">
                  {tr("kanban.recurring.task_assignee")}
                </label>
                <select
                  id="recurring-dlg-assignee"
                  data-testid="recurring-dialog-assignee"
                  disabled={busy}
                  value={assignedEmployeeId}
                  onChange={(e) => setAssignedEmployeeId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
                >
                  <option value="">{tr("kanban.recurring.task_assignee_auto")}</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.jobTitle})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="recurring-dlg-acceptance" className="text-xs text-muted-foreground">
              {tr("kanban.recurring.task_acceptance")}
            </label>
            <Textarea
              id="recurring-dlg-acceptance"
              data-testid="recurring-dialog-acceptance"
              rows={2}
              value={acceptanceCriteria}
              disabled={busy}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
            />
          </div>

          <RecurringScheduleFields value={draft} onChange={setDraft} disabled={busy} compact testIdPrefix="recurring-dialog" />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {tr("kanban.recurring.action.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="recurring-dialog-save"
            disabled={!canSave}
            onClick={() => void handleSave()}
          >
            {mode === "edit" ? tr("kanban.recurring.action.save") : tr("kanban.recurring.save_template")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
