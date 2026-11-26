import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildUtcIsoFromParts,
  defaultUtcPickerParts,
  evaluateTaskAvailability,
  formatLocalTimePreview,
  formatUtcTimestamp,
  splitUtcIsoToParts,
} from "../../../shared/task-availability.ts";

/**
 * Re-renders once right when `availableFromUtc` arrives so cards and details
 * automatically clear the time-blocked presentation without polling or reload.
 */
export function useScheduledNow(availableFromUtc: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
  }, [availableFromUtc]);

  useEffect(() => {
    if (!availableFromUtc) return;
    const evaluation = evaluateTaskAvailability(availableFromUtc, now);
    if (evaluation.available || evaluation.availableFromMs == null) return;
    const remaining = evaluation.availableFromMs - Date.now();
    // Cap timeout below 2^31-1 ms (~24.8 days) and also re-check after sleep/wake.
    const delay = remaining <= 0 ? 0 : Math.min(remaining + 50, 60_000);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [availableFromUtc, now]);

  return now;
}

interface AvailabilityEditorProps {
  /** Current canonical UTC ISO string, or null for immediate availability. */
  value: string | null;
  /** Controlled change handler for New Task form (called immediately when mode or parts change). */
  onChange?: (next: string | null) => void;
  /** Explicit persistence handler for Task Details (persists immediately when switched to immediate or when Save is clicked). */
  onCommit?: (next: string | null) => Promise<void> | void;
  disabled?: boolean;
  /** True when the task currently has an active run; explains that edits apply only to future launches. */
  isRunning?: boolean;
  compact?: boolean;
  testIdPrefix?: string;
}

/**
 * Compact UTC+0 execution availability selector shared by New Task and Task Details.
 * - Mode 1: Available immediately (`null`)
 * - Mode 2: Not before a specified time (UTC+0 date + HH:MM time + live local preview)
 */
export function ScheduledAvailabilityControl({
  value,
  onChange,
  onCommit,
  disabled = false,
  isRunning = false,
  compact = false,
  testIdPrefix = "schedule",
}: AvailabilityEditorProps) {
  const { locale } = useUILocale();
  const uiLocale: "en" | "ru" = locale === "ru" ? "ru" : "en";
  const now = useScheduledNow(value);

  const initialParts = useMemo(
    () => splitUtcIsoToParts(value) ?? defaultUtcPickerParts(),
    // Re-seed from prop only when external value changes
    [value],
  );

  const [mode, setMode] = useState<"immediate" | "scheduled">(value ? "scheduled" : "immediate");
  const [dateStr, setDateStr] = useState(initialParts.date);
  const [timeStr, setTimeStr] = useState(initialParts.time);

  useEffect(() => {
    if (value) {
      const parts = splitUtcIsoToParts(value);
      setMode("scheduled");
      if (parts) {
        setDateStr(parts.date);
        setTimeStr(parts.time);
      }
    } else {
      setMode("immediate");
    }
  }, [value]);

  const draftIso = useMemo(
    () => (mode === "scheduled" ? buildUtcIsoFromParts(dateStr, timeStr) : null),
    [mode, dateStr, timeStr],
  );

  const preview = useMemo(
    () => (draftIso ? formatLocalTimePreview(draftIso, uiLocale) : null),
    [draftIso, uiLocale],
  );

  const evalDraft = useMemo(
    () => (draftIso ? evaluateTaskAvailability(draftIso, now) : null),
    [draftIso, now],
  );

  const commitMode = mode === "scheduled" && Boolean(onCommit);
  const hasUnsavedScheduledChange = commitMode && draftIso !== null && draftIso !== value;

  const selectImmediate = () => {
    setMode("immediate");
    onChange?.(null);
    if (onCommit && value !== null) {
      void onCommit(null);
    }
  };

  const selectScheduled = () => {
    const parts = splitUtcIsoToParts(value) ?? defaultUtcPickerParts();
    setMode("scheduled");
    setDateStr(parts.date);
    setTimeStr(parts.time);
    const nextIso = buildUtcIsoFromParts(parts.date, parts.time);
    if (nextIso) onChange?.(nextIso);
  };

  const updateParts = (nextDate: string, nextTime: string) => {
    setDateStr(nextDate);
    setTimeStr(nextTime);
    if (onChange) {
      onChange(buildUtcIsoFromParts(nextDate, nextTime));
    }
  };

  return (
    <div className={cn("space-y-1.5", compact ? "text-xs" : "text-sm")} data-testid={`${testIdPrefix}-control`}>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={tr("kanban.schedule.field")}>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "immediate"}
          disabled={disabled}
          data-testid={`${testIdPrefix}-mode-immediate`}
          onClick={selectImmediate}
          className={cn(
            "rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            mode === "immediate"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          {tr("kanban.schedule.immediate")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "scheduled"}
          disabled={disabled}
          data-testid={`${testIdPrefix}-mode-scheduled`}
          onClick={selectScheduled}
          className={cn(
            "rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            mode === "scheduled"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          {tr("kanban.schedule.scheduled")}
        </button>
      </div>

      {mode === "scheduled" && (
        <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-2" data-testid={`${testIdPrefix}-inputs`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              aria-label={tr("kanban.schedule.date")}
              data-testid={`${testIdPrefix}-date`}
              value={dateStr}
              disabled={disabled}
              onChange={(e) => updateParts(e.target.value, timeStr)}
              className="h-7 min-w-[136px] flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            />
            <div className="flex min-w-0 items-center gap-1.5">
              <input
                type="time"
                aria-label={tr("kanban.schedule.time")}
                data-testid={`${testIdPrefix}-time`}
                value={timeStr}
                step={60}
                disabled={disabled}
                onChange={(e) => updateParts(dateStr, e.target.value)}
                className="h-7 min-w-[116px] rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground"
              />
              <span
                data-testid={`${testIdPrefix}-tz-badge`}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-2 font-mono text-[11px] font-medium text-foreground"
              >
                <Clock className="size-3 text-muted-foreground" aria-hidden="true" />
                {tr("kanban.schedule.tz_badge")}
              </span>
            </div>
          </div>

          {!draftIso ? (
            <p className="text-[11px] text-danger" data-testid={`${testIdPrefix}-invalid`}>
              {tr("kanban.schedule.invalid")}
            </p>
          ) : (
            <div className="space-y-0.5 text-[11px] text-muted-foreground">
              {preview && (
                <p data-testid={`${testIdPrefix}-local-preview`}>
                  {tr("kanban.schedule.local_preview", {
                    tz: `${preview.offsetLabel} · ${preview.timeZone}`,
                    time: preview.text,
                  })}
                </p>
              )}
              {evalDraft?.available && (
                <p data-testid={`${testIdPrefix}-past-hint`}>
                  {tr("kanban.schedule.available_now_hint", { time: formatUtcTimestamp(draftIso, uiLocale) })}
                </p>
              )}
            </div>
          )}

          {onCommit && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Button
                type="button"
                size="sm"
                className="h-7 px-2.5 text-xs"
                data-testid={`${testIdPrefix}-save`}
                disabled={disabled || !draftIso || (!hasUnsavedScheduledChange && value === draftIso)}
                onClick={() => draftIso && void onCommit(draftIso)}
              >
                {tr("kanban.schedule.save")}
              </Button>
              {value && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  data-testid={`${testIdPrefix}-clear`}
                  disabled={disabled}
                  onClick={selectImmediate}
                >
                  {tr("kanban.schedule.clear")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {isRunning && (
        <p className="text-[11px] text-muted-foreground" data-testid={`${testIdPrefix}-running-note`}>
          {tr("kanban.schedule.running_note")}
        </p>
      )}
    </div>
  );
}

/**
 * Compact Kanban card indicator for scheduled earliest-start availability.
 * Renders nothing when the task has no restriction or when the scheduled UTC
 * timestamp has already arrived (automatically cleared via `useScheduledNow`).
 */
export function ScheduledAvailabilityBadge({
  availableFromUtc,
  isWaitingForTime,
}: {
  availableFromUtc: string | null | undefined;
  /** True when the task is submitted / ready and waiting specifically on its scheduled time. */
  isWaitingForTime: boolean;
}) {
  const { locale } = useUILocale();
  const uiLocale: "en" | "ru" = locale === "ru" ? "ru" : "en";
  const now = useScheduledNow(availableFromUtc);

  if (!availableFromUtc) return null;
  const evaluation = evaluateTaskAvailability(availableFromUtc, now);
  if (evaluation.available || !evaluation.availableFromUtc) return null;

  const formattedUtc = formatUtcTimestamp(evaluation.availableFromUtc, uiLocale);
  const localPreview = formatLocalTimePreview(evaluation.availableFromUtc, uiLocale);
  const tooltip = localPreview
    ? `${tr("kanban.schedule.available_from", { time: formattedUtc })} · ${tr("kanban.schedule.local_preview", { tz: `${localPreview.offsetLabel} · ${localPreview.timeZone}`, time: localPreview.text })}`
    : tr("kanban.schedule.available_from", { time: formattedUtc });

  return (
    <div
      data-testid="task-card-schedule"
      data-available-from-utc={evaluation.availableFromUtc}
      title={tooltip}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[11px] leading-snug text-muted-foreground"
    >
      <span className="flex min-w-0 items-start gap-1 font-medium text-foreground/90">
        <Clock className="mt-0.5 size-3 shrink-0 text-info" aria-hidden="true" />
        <span className="min-w-0 break-words" data-testid="task-card-schedule-time">
          {tr("kanban.schedule.available_from", { time: formattedUtc })}
        </span>
      </span>
      {isWaitingForTime && (
        <span className="min-w-0 break-words pl-4 text-[10px] text-muted-foreground" data-testid="task-card-schedule-waiting">
          {tr("kanban.schedule.waiting")}
        </span>
      )}
    </div>
  );
}
