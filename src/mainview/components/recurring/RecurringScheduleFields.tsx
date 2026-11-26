import { useMemo } from "react";
import { Clock, Repeat } from "lucide-react";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";
import {
  computeFirstDueUtc,
  formatRecurrenceSummary,
  RECURRENCE_LIMITS,
  RECURRENCE_TYPES,
  validateScheduleConfig,
  type IsoWeekday,
  type MissingDayPolicy,
  type MonthlyMode,
  type RecurrenceIntervalUnit,
  type RecurrenceType,
  type RecurringMissedPolicy,
  type RecurringOverlapPolicy,
  type RecurringSubmissionMode,
} from "../../../shared/recurring-tasks.ts";
import {
  buildUtcIsoFromParts,
  formatLocalTimePreview,
  formatUtcTimestamp,
} from "../../../shared/task-availability.ts";

export interface RecurringDraftState {
  recurrenceType: RecurrenceType;
  interval: number;
  intervalUnit: RecurrenceIntervalUnit;
  weekdays: IsoWeekday[];
  monthlyMode: MonthlyMode;
  dayOfMonth: number;
  missingDayPolicy: MissingDayPolicy;
  startDateUtc: string;
  startTimeUtc: string;
  endDateUtc: string | null;
  maxOccurrences: number | null;
  submissionMode: RecurringSubmissionMode;
  overlapPolicy: RecurringOverlapPolicy;
  missedPolicy: RecurringMissedPolicy;
  catchUpLimit: number;
}

interface Props {
  value: RecurringDraftState;
  onChange: (next: RecurringDraftState) => void;
  disabled?: boolean;
  compact?: boolean;
  testIdPrefix?: string;
}

const WEEKDAY_ORDER: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Shared compact UTC+0 recurrence configuration editor used by New Task,
 * Edit Template dialog, and Convert Task dialog.
 */
export function RecurringScheduleFields({
  value,
  onChange,
  disabled = false,
  compact = false,
  testIdPrefix = "recurring",
}: Props) {
  const { locale } = useUILocale();
  const uiLocale: "en" | "ru" = locale === "ru" ? "ru" : "en";

  const validation = useMemo(
    () =>
      validateScheduleConfig({
        recurrenceType: value.recurrenceType,
        interval: value.interval,
        intervalUnit: value.intervalUnit,
        weekdays: value.weekdays,
        monthlyMode: value.monthlyMode,
        dayOfMonth: value.dayOfMonth,
        missingDayPolicy: value.missingDayPolicy,
        startDateUtc: value.startDateUtc,
        startTimeUtc: value.startTimeUtc,
        endDateUtc: value.endDateUtc,
        maxOccurrences: value.maxOccurrences,
      }),
    [value],
  );

  const nextOccurrenceUtc = useMemo(
    () => (validation.ok ? computeFirstDueUtc(validation.value) : null),
    [validation],
  );

  const startIso = useMemo(
    () => buildUtcIsoFromParts(value.startDateUtc, value.startTimeUtc),
    [value.startDateUtc, value.startTimeUtc],
  );

  const startLocalPreview = useMemo(
    () => (startIso ? formatLocalTimePreview(startIso, uiLocale) : null),
    [startIso, uiLocale],
  );

  const nextLocalPreview = useMemo(
    () => (nextOccurrenceUtc ? formatLocalTimePreview(nextOccurrenceUtc, uiLocale) : null),
    [nextOccurrenceUtc, uiLocale],
  );

  const summaryPreview = useMemo(
    () => (validation.ok ? formatRecurrenceSummary(validation.value, uiLocale) : null),
    [validation, uiLocale],
  );

  const patch = (partial: Partial<RecurringDraftState>) => {
    onChange({ ...value, ...partial });
  };

  const toggleWeekday = (day: IsoWeekday) => {
    const exists = value.weekdays.includes(day);
    if (exists && value.weekdays.length === 1) return; // keep at least 1 selected
    const next = exists
      ? value.weekdays.filter((d) => d !== day)
      : [...value.weekdays, day].sort((a, b) => a - b);
    patch({ weekdays: next });
  };

  const needsWeekdays = value.recurrenceType === "weekly" || value.recurrenceType === "biweekly";
  const needsInterval = value.recurrenceType === "custom_interval" || value.recurrenceType === "after_completion";
  const needsMonthlyControls = value.recurrenceType === "monthly" || value.recurrenceType === "quarterly";
  const supportsMissingDay =
    (value.recurrenceType === "monthly" || value.recurrenceType === "quarterly") && value.monthlyMode === "day_of_month"
      || value.recurrenceType === "yearly";

  return (
    <div
      className={cn("space-y-2.5 rounded-md border border-border/70 bg-muted/20 p-2.5", compact ? "text-xs" : "text-sm")}
      data-testid={`${testIdPrefix}-fields`}
    >
      {/* Frequency */}
      <div className="space-y-1">
        <label htmlFor={`${testIdPrefix}-frequency`} className="block text-xs text-muted-foreground">
          {tr("kanban.recurring.frequency")}
        </label>
        <select
          id={`${testIdPrefix}-frequency`}
          data-testid={`${testIdPrefix}-frequency`}
          disabled={disabled}
          value={value.recurrenceType}
          onChange={(e) => {
            const nextType = e.target.value as RecurrenceType;
            const nextPatch: Partial<RecurringDraftState> = { recurrenceType: nextType };
            if (nextType === "after_completion" && value.interval < 1) {
              nextPatch.interval = 24;
              nextPatch.intervalUnit = "hours";
            } else if (nextType === "after_completion" && value.recurrenceType !== "after_completion") {
              nextPatch.interval = 24;
              nextPatch.intervalUnit = "hours";
            } else if (nextType === "custom_interval" && value.recurrenceType !== "custom_interval") {
              nextPatch.interval = 6;
              nextPatch.intervalUnit = "hours";
            }
            patch(nextPatch);
          }}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
        >
          {RECURRENCE_TYPES.map((type) => (
            <option key={type} value={type}>
              {tr(`kanban.recurring.freq.${type}` as TranslationKey)}
            </option>
          ))}
        </select>
      </div>

      {/* Custom interval / Repeat after completion controls */}
      {needsInterval && (
        <div className="space-y-1" data-testid={`${testIdPrefix}-interval-row`}>
          <label htmlFor={`${testIdPrefix}-interval`} className="block text-xs text-muted-foreground">
            {value.recurrenceType === "after_completion"
              ? tr("kanban.recurring.after_completion_delay")
              : tr("kanban.recurring.interval")}
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id={`${testIdPrefix}-interval`}
              data-testid={`${testIdPrefix}-interval`}
              type="number"
              min={RECURRENCE_LIMITS.minInterval}
              max={
                value.intervalUnit === "hours"
                  ? RECURRENCE_LIMITS.maxIntervalHours
                  : value.intervalUnit === "days"
                    ? RECURRENCE_LIMITS.maxIntervalDays
                    : RECURRENCE_LIMITS.maxIntervalWeeks
              }
              disabled={disabled}
              value={Number.isFinite(value.interval) ? value.interval : ""}
              onChange={(e) => patch({ interval: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              className="h-7 w-20 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground"
            />
            <select
              aria-label={tr("kanban.recurring.interval")}
              data-testid={`${testIdPrefix}-interval-unit`}
              disabled={disabled}
              value={value.intervalUnit}
              onChange={(e) => patch({ intervalUnit: e.target.value as RecurrenceIntervalUnit })}
              className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              <option value="hours">{tr("kanban.recurring.unit.hours")}</option>
              <option value="days">{tr("kanban.recurring.unit.days")}</option>
              <option value="weeks">{tr("kanban.recurring.unit.weeks")}</option>
            </select>
          </div>
        </div>
      )}

      {/* Multiple weekday selector */}
      {needsWeekdays && (
        <div className="space-y-1" data-testid={`${testIdPrefix}-weekdays`}>
          <span className="block text-xs text-muted-foreground">{tr("kanban.recurring.weekdays")}</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label={tr("kanban.recurring.weekdays")}>
            {WEEKDAY_ORDER.map((day) => {
              const selected = value.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  data-testid={`${testIdPrefix}-wd-${day}`}
                  onClick={() => toggleWeekday(day)}
                  className={cn(
                    "h-7 min-w-8 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:opacity-50",
                    selected
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tr(`kanban.recurring.wd.${day}` as TranslationKey)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Monthly / Quarterly calendar rule */}
      {needsMonthlyControls && (
        <div className="space-y-1.5" data-testid={`${testIdPrefix}-monthly-controls`}>
          <span className="block text-xs text-muted-foreground">{tr("kanban.recurring.monthly_mode")}</span>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={disabled}
              aria-pressed={value.monthlyMode === "day_of_month"}
              data-testid={`${testIdPrefix}-monthly-day`}
              onClick={() => patch({ monthlyMode: "day_of_month" })}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                value.monthlyMode === "day_of_month"
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {tr("kanban.recurring.monthly_day")}
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={value.monthlyMode === "last_day"}
              data-testid={`${testIdPrefix}-monthly-last-day`}
              onClick={() => patch({ monthlyMode: "last_day" })}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                value.monthlyMode === "last_day"
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {tr("kanban.recurring.monthly_last_day")}
            </button>
          </div>
          {value.monthlyMode === "day_of_month" && (
            <div className="flex items-center gap-2">
              <label htmlFor={`${testIdPrefix}-day-of-month`} className="text-[11px] text-muted-foreground">
                {tr("kanban.recurring.day_of_month")}
              </label>
              <input
                id={`${testIdPrefix}-day-of-month`}
                data-testid={`${testIdPrefix}-day-of-month`}
                type="number"
                min={1}
                max={31}
                disabled={disabled}
                value={value.dayOfMonth}
                onChange={(e) => patch({ dayOfMonth: Math.max(1, Math.min(31, Math.floor(Number(e.target.value) || 1))) })}
                className="h-7 w-16 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground"
              />
            </div>
          )}
        </div>
      )}

      {/* Start date + time in UTC+0 */}
      <div className="space-y-1">
        <span className="block text-xs text-muted-foreground">
          {tr("kanban.recurring.start_date")} / {tr("kanban.recurring.start_time")}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="date"
            aria-label={tr("kanban.recurring.start_date")}
            data-testid={`${testIdPrefix}-start-date`}
            disabled={disabled}
            value={value.startDateUtc}
            onChange={(e) => {
              const nextDate = e.target.value;
              const dayMatch = /^\d{4}-\d{2}-(\d{2})$/.exec(nextDate);
              patch({
                startDateUtc: nextDate,
                ...(dayMatch && value.recurrenceType === "yearly" ? { dayOfMonth: Number(dayMatch[1]) } : {}),
              });
            }}
            className="h-7 min-w-[132px] flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          />
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              aria-label={tr("kanban.recurring.start_time")}
              data-testid={`${testIdPrefix}-start-time`}
              step={60}
              disabled={disabled}
              value={value.startTimeUtc}
              onChange={(e) => patch({ startTimeUtc: e.target.value })}
              className="h-7 min-w-[108px] rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground"
            />
            <span
              data-testid={`${testIdPrefix}-tz-badge`}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-2 font-mono text-[11px] font-medium text-foreground"
            >
              <Clock className="size-3 text-muted-foreground" aria-hidden="true" />
              {tr("kanban.recurring.tz_badge")}
            </span>
          </div>
        </div>
        {startLocalPreview && (
          <p className="text-[11px] text-muted-foreground" data-testid={`${testIdPrefix}-local-preview`}>
            {tr("kanban.recurring.local_preview", {
              tz: `${startLocalPreview.offsetLabel} · ${startLocalPreview.timeZone}`,
              time: startLocalPreview.text,
            })}
          </p>
        )}
      </div>

      {/* Live next-occurrence preview */}
      {!validation.ok ? (
        <p className="text-[11px] text-danger" data-testid={`${testIdPrefix}-invalid`}>
          {validation.error || tr("kanban.recurring.invalid_schedule")}
        </p>
      ) : (
        <div
          className="space-y-0.5 rounded-md border border-border/60 bg-background/80 px-2 py-1.5 text-[11px]"
          data-testid={`${testIdPrefix}-next-preview`}
        >
          {summaryPreview && (
            <div className="flex items-center gap-1 font-medium text-foreground">
              <Repeat className="size-3 shrink-0 text-primary" aria-hidden="true" />
              <span className="truncate">{summaryPreview}</span>
            </div>
          )}
          <div className="text-muted-foreground">
            {nextOccurrenceUtc
              ? tr("kanban.recurring.next_occurrence_value", { time: formatUtcTimestamp(nextOccurrenceUtc, uiLocale) })
              : tr("kanban.recurring.next_none")}
          </div>
          {nextLocalPreview && nextOccurrenceUtc && (
            <div className="text-muted-foreground">
              {tr("kanban.recurring.local_preview", {
                tz: `${nextLocalPreview.offsetLabel} · ${nextLocalPreview.timeZone}`,
                time: nextLocalPreview.text,
              })}
            </div>
          )}
        </div>
      )}

      {/* Core checkboxes: overlap prevention + auto-submit */}
      <div className="space-y-1.5 pt-0.5">
        <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-prevent-overlap`}
            disabled={disabled}
            checked={value.overlapPolicy === "skip_if_unresolved"}
            onChange={(e) => patch({ overlapPolicy: e.target.checked ? "skip_if_unresolved" : "allow_overlap" })}
            className="mt-0.5 size-3.5 rounded border-input accent-primary"
          />
          <span className="leading-snug">{tr("kanban.recurring.prevent_overlap")}</span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-auto-submit`}
            disabled={disabled}
            checked={value.submissionMode === "auto_submit"}
            onChange={(e) => patch({ submissionMode: e.target.checked ? "auto_submit" : "generate_only" })}
            className="mt-0.5 size-3.5 rounded border-input accent-primary"
          />
          <span className="leading-snug">
            <span className="block">{tr("kanban.recurring.auto_submit")}</span>
            <span className="block text-[11px] text-muted-foreground">
              {value.submissionMode === "auto_submit"
                ? tr("kanban.recurring.auto_submit_hint")
                : tr("kanban.recurring.generate_only_hint")}
            </span>
          </span>
        </label>
      </div>

      {/* Compact expandable Advanced options */}
      <details className="rounded-md border border-border/60 bg-background/60 px-2 py-1.5" data-testid={`${testIdPrefix}-advanced`}>
        <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
          {tr("kanban.recurring.advanced")}
        </summary>
        <div className="mt-2 space-y-2 text-xs">
          <div className="space-y-1">
            <label htmlFor={`${testIdPrefix}-end-date`} className="block text-[11px] text-muted-foreground">
              {tr("kanban.recurring.end_date")}
            </label>
            <input
              id={`${testIdPrefix}-end-date`}
              data-testid={`${testIdPrefix}-end-date`}
              type="date"
              disabled={disabled}
              value={value.endDateUtc && /^\d{4}-\d{2}-\d{2}$/.test(value.endDateUtc) ? value.endDateUtc : ""}
              onChange={(e) => patch({ endDateUtc: e.target.value ? e.target.value : null })}
              className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`${testIdPrefix}-max-occ`} className="block text-[11px] text-muted-foreground">
              {tr("kanban.recurring.max_occurrences")}
            </label>
            <input
              id={`${testIdPrefix}-max-occ`}
              data-testid={`${testIdPrefix}-max-occ`}
              type="number"
              min={1}
              max={RECURRENCE_LIMITS.maxOccurrencesCeiling}
              placeholder="—"
              disabled={disabled}
              value={value.maxOccurrences ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                patch({ maxOccurrences: raw ? Math.max(1, Math.floor(Number(raw) || 1)) : null });
              }}
              className="h-7 w-full rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`${testIdPrefix}-missed`} className="block text-[11px] text-muted-foreground">
              {tr("kanban.recurring.missed_policy")}
            </label>
            <select
              id={`${testIdPrefix}-missed`}
              data-testid={`${testIdPrefix}-missed`}
              disabled={disabled}
              value={value.missedPolicy}
              onChange={(e) => patch({ missedPolicy: e.target.value as RecurringMissedPolicy })}
              className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              <option value="run_once">{tr("kanban.recurring.missed.run_once")}</option>
              <option value="skip">{tr("kanban.recurring.missed.skip")}</option>
              <option value="catch_up">{tr("kanban.recurring.missed.catch_up")}</option>
            </select>
          </div>

          {value.missedPolicy === "catch_up" && (
            <div className="flex items-center gap-2">
              <label htmlFor={`${testIdPrefix}-catchup-limit`} className="text-[11px] text-muted-foreground">
                {tr("kanban.recurring.catch_up_limit")}
              </label>
              <input
                id={`${testIdPrefix}-catchup-limit`}
                data-testid={`${testIdPrefix}-catchup-limit`}
                type="number"
                min={RECURRENCE_LIMITS.minCatchUpLimit}
                max={RECURRENCE_LIMITS.maxCatchUpLimit}
                disabled={disabled}
                value={value.catchUpLimit}
                onChange={(e) =>
                  patch({
                    catchUpLimit: Math.max(
                      RECURRENCE_LIMITS.minCatchUpLimit,
                      Math.min(RECURRENCE_LIMITS.maxCatchUpLimit, Math.floor(Number(e.target.value) || 1)),
                    ),
                  })
                }
                className="h-7 w-16 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground"
              />
            </div>
          )}

          {supportsMissingDay && (
            <div className="space-y-1">
              <label htmlFor={`${testIdPrefix}-missing-day`} className="block text-[11px] text-muted-foreground">
                {tr("kanban.recurring.missing_day")}
              </label>
              <select
                id={`${testIdPrefix}-missing-day`}
                data-testid={`${testIdPrefix}-missing-day`}
                disabled={disabled}
                value={value.missingDayPolicy}
                onChange={(e) => patch({ missingDayPolicy: e.target.value as MissingDayPolicy })}
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="skip">{tr("kanban.recurring.missing_day.skip")}</option>
                <option value="last_day">{tr("kanban.recurring.missing_day.last_day")}</option>
              </select>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
