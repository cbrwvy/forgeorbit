/**
 * Recurring tasks & UTC calendar recurrence engine (FO-KANBAN-RECURRING01).
 *
 * Pure, deterministic UTC-only recurrence validation, schedule calculation,
 * missed-occurrence enumeration, occurrence key generation, and EN/RU human-
 * readable labels shared across backend, scheduler, webview, and tests.
 *
 * All calendar arithmetic uses `Date.UTC` / `getUTC*` exclusively so local
 * timezone changes and DST transitions can never shift a UTC schedule, and
 * nonexistent monthly dates (e.g. Feb 30, Apr 31) never overflow into the next
 * month.
 */
import { normalizeUrgency, type Urgency } from "./board-order.ts";
import { buildUtcIsoFromParts, parseAvailableFromUtc, splitUtcIsoToParts } from "./task-availability.ts";
import type { AccessMode } from "./execution/access-mode.ts";
import type { Isolation, TaskType } from "./types.ts";

export type RecurrenceType =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | "custom_interval"
  | "after_completion";

export type RecurrenceIntervalUnit = "hours" | "days" | "weeks";
export type MonthlyMode = "day_of_month" | "last_day";
export type MissingDayPolicy = "skip" | "last_day";
export type RecurringTemplateStatus = "active" | "paused" | "stopped";
export type RecurringSubmissionMode = "generate_only" | "auto_submit";
export type RecurringOverlapPolicy = "skip_if_unresolved" | "allow_overlap";
export type RecurringMissedPolicy = "skip" | "run_once" | "catch_up";
export type RecurringOccurrenceKind = "scheduled" | "manual_one_off";
export type RecurringOccurrenceStatus = "generated" | "skipped";
export type RecurringSubmissionIntent = "none" | "pending" | "submitted" | "failed";

export type RecurringSkipReason =
  | "overlap_unresolved"
  | "overlap_queue_cap"
  | "missed_policy_skip"
  | "missed_policy_run_once_superseded"
  | "missed_policy_catchup_cap"
  | "project_paused"
  | "emergency_stop"
  | "restore_historical_skip";

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const RECURRENCE_LIMITS = {
  maxTitleChars: 240,
  maxPromptChars: 120_000,
  maxAcceptanceChars: 20_000,
  maxLabels: 12,
  maxLabelChars: 48,
  minInterval: 1,
  maxIntervalHours: 24 * 365, // 8760 hours (1 year)
  maxIntervalDays: 366,
  maxIntervalWeeks: 52,
  minCatchUpLimit: 1,
  maxCatchUpLimit: 10,
  defaultCatchUpLimit: 3,
  maxOccurrencesCeiling: 10_000,
  /** Bounded safety cap even when overlap is explicitly allowed. */
  maxOpenOverlappingOccurrences: 10,
  /** Max calendar years scanned ahead before concluding no valid future date exists. */
  maxSearchYears: 16,
  /** Max skipped records persisted in a single massive downtime catch-up sweep. */
  maxRecordedSkippedPerTick: 50,
} as const;

export const RECURRENCE_TYPES: readonly RecurrenceType[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
  "custom_interval",
  "after_completion",
];

export interface RecurringScheduleConfig {
  recurrenceType: RecurrenceType;
  /** Positive integer interval (meaningful for `custom_interval`, `after_completion`, and fixed presets). */
  interval: number;
  /** Unit for `custom_interval` and `after_completion`. */
  intervalUnit: RecurrenceIntervalUnit;
  /** Selected ISO weekdays (1=Mon..7=Sun) for `weekly` and `biweekly`. */
  weekdays: IsoWeekday[];
  /** For `monthly` / `quarterly` / `yearly`: specific day or last day of month. */
  monthlyMode: MonthlyMode;
  /** 1..31 calendar day of month (used when `monthlyMode === "day_of_month"`). */
  dayOfMonth: number;
  /** How to handle dates that do not exist in a target month (e.g. 31st in Feb/Apr, Feb 29 in non-leap year). Default: `"skip"`. */
  missingDayPolicy: MissingDayPolicy;
  /** Canonical UTC anchor date `YYYY-MM-DD`. */
  startDateUtc: string;
  /** Canonical UTC time `HH:MM`. */
  startTimeUtc: string;
  /** Canonical UTC ISO-8601 anchor instant `YYYY-MM-DDTHH:mm:00.000Z`. */
  startUtc: string;
  /** Optional inclusive UTC end date `YYYY-MM-DD` (end of UTC day) or canonical UTC ISO instant. */
  endDateUtc: string | null;
  /** Optional maximum total scheduled generated occurrences. */
  maxOccurrences: number | null;
}

export interface RecurringTemplateTaskConfig {
  acceptanceCriteria?: string | null;
  labels?: string[];
  agent?: string;
  mode?: string;
  model?: string | null;
  effort?: string | null;
  fast?: boolean;
  maxMode?: boolean;
  isolation?: Isolation;
  accessMode?: AccessMode;
  baseRef?: string | null;
  agentProfileId?: string | null;
  assignedEmployeeId?: string | null;
  requestedAccountId?: string | null;
  initialColumn?: "backlog" | "ready";
  metadata?: Record<string, string>;
}

export interface RecurringTemplate {
  id: string;
  projectPath: string;
  status: RecurringTemplateStatus;
  title: string;
  prompt: string;
  urgency: Urgency;
  taskType: TaskType;
  templateConfig: RecurringTemplateTaskConfig;
  recurrenceType: RecurrenceType;
  schedule: RecurringScheduleConfig;
  submissionMode: RecurringSubmissionMode;
  overlapPolicy: RecurringOverlapPolicy;
  missedPolicy: RecurringMissedPolicy;
  catchUpLimit: number;
  nextDueUtc: string | null;
  nextDueMs: number | null;
  lastNominalUtc: string | null;
  occurrenceSeq: number;
  lastCompletedTaskId: string | null;
  lastCompletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  stoppedAt: number | null;
}

export interface RecurringOccurrence {
  id: string;
  templateId: string;
  projectPath: string;
  occurrenceKey: string;
  sequenceNumber: number;
  kind: RecurringOccurrenceKind;
  nominalUtc: string;
  status: RecurringOccurrenceStatus;
  skipReason: RecurringSkipReason | null;
  taskId: string | null;
  submissionIntent: RecurringSubmissionIntent;
  submissionError: string | null;
  submittedRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecurringOccurrenceHistoryItem extends RecurringOccurrence {
  taskTitle: string | null;
  taskColumn: string | null;
  taskArchivedAt: number | null;
  taskUpdatedAt: number | null;
  taskCompletedAt: number | null;
  handsoffStatus: string | null;
}

export interface RecurringTemplateStats {
  totalGenerated: number;
  completed: number;
  unresolved: number;
  skipped: number;
  latestOccurrence: RecurringOccurrenceHistoryItem | null;
  activeOccurrence: RecurringOccurrenceHistoryItem | null;
}

export interface RecurringTemplateView extends RecurringTemplate {
  stats: RecurringTemplateStats;
}

/** Compact summary attached to Task payloads for Kanban cards and Task Details. */
export interface TaskRecurringInfo {
  templateId: string;
  occurrenceId: string | null;
  nominalUtc: string | null;
  recurrenceType: RecurrenceType;
  schedule: Pick<
    RecurringScheduleConfig,
    "recurrenceType" | "interval" | "intervalUnit" | "weekdays" | "monthlyMode" | "dayOfMonth" | "missingDayPolicy" | "startDateUtc" | "startTimeUtc" | "startUtc"
  >;
  templateStatus: RecurringTemplateStatus;
  templateNextDueUtc: string | null;
  submissionMode: RecurringSubmissionMode;
}

export interface CreateRecurringTemplateInput {
  projectPath: string;
  title: string;
  prompt: string;
  urgency?: number;
  taskType?: TaskType;
  templateConfig?: RecurringTemplateTaskConfig;
  recurrenceType: RecurrenceType;
  interval?: number;
  intervalUnit?: RecurrenceIntervalUnit;
  weekdays?: number[];
  monthlyMode?: MonthlyMode;
  dayOfMonth?: number;
  missingDayPolicy?: MissingDayPolicy;
  startDateUtc: string;
  startTimeUtc: string;
  endDateUtc?: string | null;
  maxOccurrences?: number | null;
  submissionMode?: RecurringSubmissionMode;
  overlapPolicy?: RecurringOverlapPolicy;
  missedPolicy?: RecurringMissedPolicy;
  catchUpLimit?: number;
}

export interface UpdateRecurringTemplateInput {
  title?: string;
  prompt?: string;
  urgency?: number;
  taskType?: TaskType;
  templateConfig?: RecurringTemplateTaskConfig;
  recurrenceType?: RecurrenceType;
  interval?: number;
  intervalUnit?: RecurrenceIntervalUnit;
  weekdays?: number[];
  monthlyMode?: MonthlyMode;
  dayOfMonth?: number;
  missingDayPolicy?: MissingDayPolicy;
  startDateUtc?: string;
  startTimeUtc?: string;
  endDateUtc?: string | null;
  maxOccurrences?: number | null;
  submissionMode?: RecurringSubmissionMode;
  overlapPolicy?: RecurringOverlapPolicy;
  missedPolicy?: RecurringMissedPolicy;
  catchUpLimit?: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function isLeapYearUtc(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Number of days in a 1-indexed UTC month (`month` 1..12). */
export function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO weekday for a UTC date (1 = Monday .. 7 = Sunday). */
export function isoWeekdayUtc(year: number, month: number, day: number): IsoWeekday {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (dow === 0 ? 7 : dow) as IsoWeekday;
}

/** Start of the ISO week (Monday 00:00:00.000Z) in epoch ms for the given UTC date. */
function isoWeekStartMs(year: number, month: number, day: number): number {
  const dow = isoWeekdayUtc(year, month, day);
  return Date.UTC(year, month - 1, day) - (dow - 1) * DAY_MS;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseUtcDateParts(raw: string): { year: number; month: number; day: number } | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (day > daysInMonthUtc(year, month)) return null;
  return { year, month, day };
}

export function parseUtcTimeParts(raw: string): { hour: number; minute: number } | null {
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Parse optional `endDateUtc` into inclusive upper-bound epoch ms (`YYYY-MM-DD` -> 23:59:59.999Z). */
export function endBoundaryMs(endDateUtc: string | null | undefined): number | null {
  if (!endDateUtc) return null;
  const dateParts = parseUtcDateParts(endDateUtc);
  if (dateParts) {
    return Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 23, 59, 59, 999);
  }
  const parsed = parseAvailableFromUtc(endDateUtc);
  if (parsed.ok && parsed.value) return Date.parse(parsed.value);
  return null;
}

export function intervalToMs(interval: number, unit: RecurrenceIntervalUnit): number {
  if (unit === "hours") return interval * HOUR_MS;
  if (unit === "days") return interval * DAY_MS;
  return interval * WEEK_MS;
}

export function isValidRecurrenceType(value: unknown): value is RecurrenceType {
  return typeof value === "string" && (RECURRENCE_TYPES as readonly string[]).includes(value);
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

export function validateScheduleConfig(input: {
  recurrenceType: unknown;
  interval?: unknown;
  intervalUnit?: unknown;
  weekdays?: unknown;
  monthlyMode?: unknown;
  dayOfMonth?: unknown;
  missingDayPolicy?: unknown;
  startDateUtc: unknown;
  startTimeUtc: unknown;
  endDateUtc?: unknown;
  maxOccurrences?: unknown;
}): ValidationResult<RecurringScheduleConfig> {
  if (!isValidRecurrenceType(input.recurrenceType)) {
    return { ok: false, code: "invalid-recurrence-type", error: "Unsupported recurrence type." };
  }
  const recurrenceType = input.recurrenceType;

  if (typeof input.startDateUtc !== "string" || !parseUtcDateParts(input.startDateUtc)) {
    return { ok: false, code: "invalid-start-date", error: "startDateUtc must be a valid UTC calendar date (YYYY-MM-DD)." };
  }
  if (typeof input.startTimeUtc !== "string" || !parseUtcTimeParts(input.startTimeUtc)) {
    return { ok: false, code: "invalid-start-time", error: "startTimeUtc must be a valid UTC time (HH:MM)." };
  }
  const startDate = parseUtcDateParts(input.startDateUtc)!;
  const startUtc = buildUtcIsoFromParts(input.startDateUtc, input.startTimeUtc);
  if (!startUtc) {
    return { ok: false, code: "invalid-start-utc", error: "Start date and time do not form a valid UTC timestamp." };
  }
  const startMs = Date.parse(startUtc);

  let intervalUnit: RecurrenceIntervalUnit = "hours";
  if (recurrenceType === "custom_interval" || recurrenceType === "after_completion") {
    const rawUnit = input.intervalUnit ?? (recurrenceType === "after_completion" ? "hours" : "days");
    if (rawUnit !== "hours" && rawUnit !== "days" && rawUnit !== "weeks") {
      return { ok: false, code: "invalid-interval-unit", error: "intervalUnit must be hours, days, or weeks." };
    }
    intervalUnit = rawUnit;
  } else if (recurrenceType === "hourly") {
    intervalUnit = "hours";
  } else if (recurrenceType === "weekly" || recurrenceType === "biweekly") {
    intervalUnit = "weeks";
  } else {
    intervalUnit = "days";
  }

  let interval = 1;
  if (recurrenceType === "custom_interval" || recurrenceType === "after_completion") {
    const rawInterval = input.interval;
    if (typeof rawInterval !== "number" || !Number.isInteger(rawInterval) || rawInterval < RECURRENCE_LIMITS.minInterval) {
      return { ok: false, code: "invalid-interval", error: "Recurrence interval must be a positive integer (>= 1)." };
    }
    const maxForUnit =
      intervalUnit === "hours"
        ? RECURRENCE_LIMITS.maxIntervalHours
        : intervalUnit === "days"
          ? RECURRENCE_LIMITS.maxIntervalDays
          : RECURRENCE_LIMITS.maxIntervalWeeks;
    if (rawInterval > maxForUnit) {
      return {
        ok: false,
        code: "invalid-interval",
        error: `Recurrence interval exceeds the maximum supported value (${maxForUnit} ${intervalUnit}).`,
      };
    }
    interval = rawInterval;
  } else if (recurrenceType === "biweekly") {
    interval = 2;
  } else if (input.interval !== undefined) {
    if (typeof input.interval !== "number" || !Number.isInteger(input.interval) || input.interval < 1) {
      return { ok: false, code: "invalid-interval", error: "Recurrence interval must be a positive integer (>= 1)." };
    }
    interval = 1;
  }

  let weekdays: IsoWeekday[] = [];
  if (recurrenceType === "weekdays") {
    weekdays = [1, 2, 3, 4, 5];
  } else if (recurrenceType === "weekly" || recurrenceType === "biweekly") {
    if (input.weekdays === undefined || input.weekdays === null) {
      weekdays = [isoWeekdayUtc(startDate.year, startDate.month, startDate.day)];
    } else if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
      return { ok: false, code: "invalid-weekdays", error: "Select at least one weekday (1=Mon .. 7=Sun)." };
    } else {
      const unique = new Set<IsoWeekday>();
      for (const d of input.weekdays) {
        if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7) {
          return { ok: false, code: "invalid-weekdays", error: "Weekdays must be integers between 1 (Mon) and 7 (Sun)." };
        }
        unique.add(d as IsoWeekday);
      }
      weekdays = [...unique].sort((a, b) => a - b);
    }
  }

  let monthlyMode: MonthlyMode = "day_of_month";
  if (input.monthlyMode !== undefined && input.monthlyMode !== null) {
    if (input.monthlyMode !== "day_of_month" && input.monthlyMode !== "last_day") {
      return { ok: false, code: "invalid-monthly-mode", error: "monthlyMode must be day_of_month or last_day." };
    }
    monthlyMode = input.monthlyMode;
  }

  let dayOfMonth = startDate.day;
  if (input.dayOfMonth !== undefined && input.dayOfMonth !== null) {
    if (typeof input.dayOfMonth !== "number" || !Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
      return { ok: false, code: "invalid-day-of-month", error: "dayOfMonth must be an integer between 1 and 31." };
    }
    dayOfMonth = input.dayOfMonth;
  }

  let missingDayPolicy: MissingDayPolicy = "skip";
  if (input.missingDayPolicy !== undefined && input.missingDayPolicy !== null) {
    if (input.missingDayPolicy !== "skip" && input.missingDayPolicy !== "last_day") {
      return { ok: false, code: "invalid-missing-day-policy", error: "missingDayPolicy must be skip or last_day." };
    }
    missingDayPolicy = input.missingDayPolicy;
  }

  let endDateUtc: string | null = null;
  if (input.endDateUtc !== undefined && input.endDateUtc !== null && input.endDateUtc !== "") {
    if (typeof input.endDateUtc !== "string") {
      return { ok: false, code: "invalid-end-date", error: "endDateUtc must be a valid UTC date (YYYY-MM-DD) or ISO-8601 UTC timestamp." };
    }
    const trimmed = input.endDateUtc.trim();
    if (parseUtcDateParts(trimmed)) {
      endDateUtc = trimmed;
    } else {
      const parsedEnd = parseAvailableFromUtc(trimmed);
      if (!parsedEnd.ok || !parsedEnd.value) {
        return { ok: false, code: "invalid-end-date", error: "endDateUtc must be a valid UTC date (YYYY-MM-DD) or ISO-8601 UTC timestamp." };
      }
      endDateUtc = parsedEnd.value;
    }
    const endMs = endBoundaryMs(endDateUtc);
    if (endMs == null || endMs < startMs) {
      return { ok: false, code: "invalid-end-date", error: "endDateUtc cannot be earlier than the start schedule." };
    }
  }

  let maxOccurrences: number | null = null;
  if (input.maxOccurrences !== undefined && input.maxOccurrences !== null) {
    if (
      typeof input.maxOccurrences !== "number" ||
      !Number.isInteger(input.maxOccurrences) ||
      input.maxOccurrences < 1 ||
      input.maxOccurrences > RECURRENCE_LIMITS.maxOccurrencesCeiling
    ) {
      return {
        ok: false,
        code: "invalid-max-occurrences",
        error: `maxOccurrences must be an integer between 1 and ${RECURRENCE_LIMITS.maxOccurrencesCeiling}.`,
      };
    }
    maxOccurrences = input.maxOccurrences;
  }

  return {
    ok: true,
    value: {
      recurrenceType,
      interval,
      intervalUnit,
      weekdays,
      monthlyMode,
      dayOfMonth,
      missingDayPolicy,
      startDateUtc: input.startDateUtc,
      startTimeUtc: input.startTimeUtc,
      startUtc,
      endDateUtc,
      maxOccurrences,
    },
  };
}

export function validateRecurringPolicies(input: {
  submissionMode?: unknown;
  overlapPolicy?: unknown;
  missedPolicy?: unknown;
  catchUpLimit?: unknown;
}): ValidationResult<{
  submissionMode: RecurringSubmissionMode;
  overlapPolicy: RecurringOverlapPolicy;
  missedPolicy: RecurringMissedPolicy;
  catchUpLimit: number;
}> {
  const submissionMode = input.submissionMode ?? "generate_only";
  if (submissionMode !== "generate_only" && submissionMode !== "auto_submit") {
    return { ok: false, code: "invalid-submission-mode", error: "submissionMode must be generate_only or auto_submit." };
  }
  const overlapPolicy = input.overlapPolicy ?? "skip_if_unresolved";
  if (overlapPolicy !== "skip_if_unresolved" && overlapPolicy !== "allow_overlap") {
    return { ok: false, code: "invalid-overlap-policy", error: "overlapPolicy must be skip_if_unresolved or allow_overlap." };
  }
  const missedPolicy = input.missedPolicy ?? "run_once";
  if (missedPolicy !== "skip" && missedPolicy !== "run_once" && missedPolicy !== "catch_up") {
    return { ok: false, code: "invalid-missed-policy", error: "missedPolicy must be skip, run_once, or catch_up." };
  }
  const rawLimit = input.catchUpLimit ?? RECURRENCE_LIMITS.defaultCatchUpLimit;
  if (
    typeof rawLimit !== "number" ||
    !Number.isInteger(rawLimit) ||
    rawLimit < RECURRENCE_LIMITS.minCatchUpLimit ||
    rawLimit > RECURRENCE_LIMITS.maxCatchUpLimit
  ) {
    return {
      ok: false,
      code: "invalid-catch-up-limit",
      error: `catchUpLimit must be an integer between ${RECURRENCE_LIMITS.minCatchUpLimit} and ${RECURRENCE_LIMITS.maxCatchUpLimit}.`,
    };
  }
  return {
    ok: true,
    value: { submissionMode, overlapPolicy, missedPolicy, catchUpLimit: rawLimit },
  };
}

/** Resolve candidate UTC timestamp for a `(year, month)` month-based rule, returning `null` if skipped. */
function resolveMonthlyCandidateMs(
  year: number,
  month: number,
  hour: number,
  minute: number,
  monthlyMode: MonthlyMode,
  dayOfMonth: number,
  missingDayPolicy: MissingDayPolicy,
): number | null {
  const dim = daysInMonthUtc(year, month);
  if (monthlyMode === "last_day") {
    return Date.UTC(year, month - 1, dim, hour, minute, 0, 0);
  }
  if (dayOfMonth <= dim) {
    return Date.UTC(year, month - 1, dayOfMonth, hour, minute, 0, 0);
  }
  if (missingDayPolicy === "last_day") {
    return Date.UTC(year, month - 1, dim, hour, minute, 0, 0);
  }
  return null; // Explicitly skip nonexistent date (never overflow into next month)
}

/**
 * Find the earliest nominal UTC instant matching `schedule` that is `>= minMs`
 * (or strictly `> minMs` when `inclusive === false`), and `>= startUtc`, and
 * `<= endDateUtc` (if configured). Returns canonical ISO string or `null`.
 */
export function computeNextNominalUtc(
  schedule: RecurringScheduleConfig,
  referenceMs: number,
  options: { inclusive?: boolean } = {},
): string | null {
  const inclusive = options.inclusive ?? true;
  const startMs = Date.parse(schedule.startUtc);
  if (!Number.isFinite(startMs)) return null;
  const endMs = endBoundaryMs(schedule.endDateUtc);
  const floorMs = Math.max(startMs, inclusive ? referenceMs : referenceMs + 1);
  if (endMs != null && floorMs > endMs) return null;

  const checkBound = (ms: number | null): string | null => {
    if (ms == null || !Number.isFinite(ms)) return null;
    if (endMs != null && ms > endMs) return null;
    return new Date(ms).toISOString();
  };

  // Fixed-step intervals: hourly, daily, custom_interval
  if (schedule.recurrenceType === "hourly" || schedule.recurrenceType === "daily" || schedule.recurrenceType === "custom_interval") {
    const stepMs =
      schedule.recurrenceType === "hourly"
        ? HOUR_MS
        : schedule.recurrenceType === "daily"
          ? DAY_MS
          : intervalToMs(schedule.interval, schedule.intervalUnit);
    if (stepMs <= 0) return null;
    if (floorMs <= startMs) return checkBound(startMs);
    const steps = Math.ceil((floorMs - startMs) / stepMs);
    return checkBound(startMs + steps * stepMs);
  }

  // Completion-relative: initial occurrence starts at `startUtc`; subsequent occurrences
  // are computed via `computeCompletionNextDueUtc`.
  if (schedule.recurrenceType === "after_completion") {
    if (floorMs <= startMs) return checkBound(startMs);
    return null;
  }

  const timeParts = parseUtcTimeParts(schedule.startTimeUtc);
  const startDate = parseUtcDateParts(schedule.startDateUtc);
  if (!timeParts || !startDate) return null;

  // Weekdays / Weekly / Biweekly
  if (schedule.recurrenceType === "weekdays" || schedule.recurrenceType === "weekly" || schedule.recurrenceType === "biweekly") {
    const allowed = new Set<IsoWeekday>(
      schedule.recurrenceType === "weekdays"
        ? [1, 2, 3, 4, 5]
        : schedule.weekdays.length > 0
          ? schedule.weekdays
          : [isoWeekdayUtc(startDate.year, startDate.month, startDate.day)],
    );
    const anchorWeekStart = isoWeekStartMs(startDate.year, startDate.month, startDate.day);

    // Start scanning from the UTC day of `floorMs`
    const d = new Date(floorMs);
    let cursorDayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const maxDays = 366 * RECURRENCE_LIMITS.maxSearchYears;
    for (let i = 0; i < maxDays; i += 1) {
      const cur = new Date(cursorDayMs);
      const y = cur.getUTCFullYear();
      const m = cur.getUTCMonth() + 1;
      const day = cur.getUTCDate();
      const dow = isoWeekdayUtc(y, m, day);
      if (allowed.has(dow)) {
        const weekOk =
          schedule.recurrenceType !== "biweekly" ||
          Math.floor((isoWeekStartMs(y, m, day) - anchorWeekStart) / WEEK_MS) % 2 === 0;
        if (weekOk) {
          const candidateMs = Date.UTC(y, m - 1, day, timeParts.hour, timeParts.minute, 0, 0);
          if (candidateMs >= floorMs) {
            return checkBound(candidateMs);
          }
        }
      }
      cursorDayMs += DAY_MS;
      if (endMs != null && cursorDayMs > endMs + DAY_MS) return null;
    }
    return null;
  }

  // Monthly / Quarterly / Yearly
  const stepMonths =
    schedule.recurrenceType === "monthly"
      ? 1
      : schedule.recurrenceType === "quarterly"
        ? 3
        : 12;

  const anchorMonthIndex = startDate.year * 12 + (startDate.month - 1);
  const floorDate = new Date(floorMs);
  const floorMonthIndex = floorDate.getUTCFullYear() * 12 + floorDate.getUTCMonth();

  let k = 0;
  if (floorMonthIndex > anchorMonthIndex) {
    k = Math.floor((floorMonthIndex - anchorMonthIndex) / stepMonths);
  }
  const maxSteps = Math.ceil((12 * RECURRENCE_LIMITS.maxSearchYears) / stepMonths);
  for (let i = 0; i < maxSteps; i += 1) {
    const idx = anchorMonthIndex + (k + i) * stepMonths;
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    const candidateMs = resolveMonthlyCandidateMs(
      year,
      month,
      timeParts.hour,
      timeParts.minute,
      schedule.monthlyMode,
      schedule.dayOfMonth,
      schedule.missingDayPolicy,
    );
    if (candidateMs != null && candidateMs >= floorMs) {
      return checkBound(candidateMs);
    }
    if (endMs != null) {
      const monthStartMs = Date.UTC(year, month - 1, 1);
      if (monthStartMs > endMs) return null;
    }
  }
  return null;
}

/** First nominal UTC timestamp for a brand-new or edited schedule (`>= startUtc`). */
export function computeFirstDueUtc(schedule: RecurringScheduleConfig): string | null {
  const startMs = Date.parse(schedule.startUtc);
  if (!Number.isFinite(startMs)) return null;
  return computeNextNominalUtc(schedule, startMs, { inclusive: true });
}

/** Compute next nominal UTC timestamp after a completed occurrence for `after_completion` templates. */
export function computeCompletionNextDueUtc(
  schedule: RecurringScheduleConfig,
  completedAtMs: number,
  generatedCountSoFar: number,
): string | null {
  if (schedule.recurrenceType !== "after_completion") return null;
  if (schedule.maxOccurrences != null && generatedCountSoFar >= schedule.maxOccurrences) return null;
  const nextMs = completedAtMs + intervalToMs(schedule.interval, schedule.intervalUnit);
  const endMs = endBoundaryMs(schedule.endDateUtc);
  if (endMs != null && nextMs > endMs) return null;
  return new Date(nextMs).toISOString();
}

export interface DueEvaluationPlan {
  /** Nominal timestamps to generate (ordered oldest -> newest). */
  toGenerate: string[];
  /** Nominal timestamps skipped due to missed-occurrence policy (ordered oldest -> newest, capped for storage). */
  skipped: Array<{ nominalUtc: string; reason: RecurringSkipReason }>;
  /** Total missed timestamps suppressed beyond `skipped.length` (when downtime spans thousands of ticks). */
  suppressedSkippedCount: number;
  /** The next future nominal UTC timestamp strictly `> nowMs` (or `null` when exhausted/completion-relative). */
  nextDueUtc: string | null;
}

/**
 * Given a template's persisted `nextDueUtc <= nowMs`, determine which occurrences
 * are due to materialize vs skip according to `missedPolicy`, `catchUpLimit`,
 * `maxOccurrences`, and `endDateUtc`, plus the next future `nextDueUtc`.
 */
export function planDueOccurrences(params: {
  schedule: RecurringScheduleConfig;
  nextDueUtc: string;
  nowMs: number;
  missedPolicy: RecurringMissedPolicy;
  catchUpLimit: number;
  generatedCountSoFar: number;
}): DueEvaluationPlan {
  const { schedule, nextDueUtc, nowMs, missedPolicy, catchUpLimit, generatedCountSoFar } = params;
  const firstDueMs = Date.parse(nextDueUtc);
  if (!Number.isFinite(firstDueMs) || firstDueMs > nowMs) {
    return { toGenerate: [], skipped: [], suppressedSkippedCount: 0, nextDueUtc };
  }

  const remainingQuota =
    schedule.maxOccurrences != null
      ? Math.max(0, schedule.maxOccurrences - generatedCountSoFar)
      : Number.POSITIVE_INFINITY;

  if (remainingQuota === 0) {
    return { toGenerate: [], skipped: [], suppressedSkippedCount: 0, nextDueUtc: null };
  }

  // Completion-relative only ever has 1 due slot at a time; the next slot is not known until Done.
  if (schedule.recurrenceType === "after_completion") {
    return {
      toGenerate: [nextDueUtc],
      skipped: [],
      suppressedSkippedCount: 0,
      nextDueUtc: null,
    };
  }

  // Fast-forward enumeration of due occurrences `<= nowMs`.
  // To stay O(1)/bounded even after years of downtime on an hourly schedule,
  // we compute the exact due list when small, or jump close to `nowMs` when huge.
  const dueList: string[] = [];
  let suppressedSkippedCount = 0;
  let cursorUtc: string | null = nextDueUtc;
  const enumLimit = Math.max(RECURRENCE_LIMITS.maxRecordedSkippedPerTick + catchUpLimit + 4, 64);

  if (
    (schedule.recurrenceType === "hourly" || schedule.recurrenceType === "daily" || schedule.recurrenceType === "custom_interval")
  ) {
    const stepMs =
      schedule.recurrenceType === "hourly"
        ? HOUR_MS
        : schedule.recurrenceType === "daily"
          ? DAY_MS
          : intervalToMs(schedule.interval, schedule.intervalUnit);
    const endMs = endBoundaryMs(schedule.endDateUtc);
    const effectiveEndMs = endMs != null ? Math.min(nowMs, endMs) : nowMs;
    const totalCount = Math.floor((effectiveEndMs - firstDueMs) / stepMs) + 1;
    if (totalCount > enumLimit) {
      suppressedSkippedCount = totalCount - enumLimit;
      const startIndex = totalCount - enumLimit;
      cursorUtc = new Date(firstDueMs + startIndex * stepMs).toISOString();
    }
  }

  let safety = 0;
  while (cursorUtc && safety < enumLimit + 4) {
    safety += 1;
    const ms = Date.parse(cursorUtc);
    if (!Number.isFinite(ms) || ms > nowMs) break;
    dueList.push(cursorUtc);
    cursorUtc = computeNextNominalUtc(schedule, ms, { inclusive: false });
  }

  // If a calendar rule (e.g. weekdays over 5 years) still had more slots up to nowMs, jump to > nowMs.
  const nextFutureUtc =
    cursorUtc && Date.parse(cursorUtc) > nowMs
      ? cursorUtc
      : computeNextNominalUtc(schedule, nowMs, { inclusive: false });

  if (dueList.length === 0) {
    return { toGenerate: [], skipped: [], suppressedSkippedCount: 0, nextDueUtc: nextFutureUtc };
  }

  // If we are exactly at or right after a single due timestamp (no backlog of missed slots),
  // even `skip` policy must still materialize a single occurrence that just became due?
  // Wait: carefully check Section 14!
  // "Skip missed occurrences: Do not create historical tasks for every missed timestamp.
  //  Continue from the next future scheduled occurrence."
  // An occurrence whose `nextDueMs === nowMs` (exact due time) or within the normal scheduler tick
  // window (<= 60s) is *on-time*, not a *missed* downtime occurrence!
  // Let's distinguish:
  //   - Exact/on-time due slot: single due occurrence AND `nowMs - firstDueMs <= ON_TIME_GRACE_MS` (60_000 ms).
  //   - Missed downtime slots: either >1 due slots accumulated, OR the single due slot is strictly older
  //     than `ON_TIME_GRACE_MS` (e.g. app was closed for hours/days, or clock jumped far past it).
  const ON_TIME_GRACE_MS = 60_000;
  const lastDueMs = Date.parse(dueList[dueList.length - 1]!);
  const isSingleOnTime = suppressedSkippedCount === 0 && dueList.length === 1 && nowMs - lastDueMs <= ON_TIME_GRACE_MS;

  let toGenerate: string[] = [];
  const skipped: Array<{ nominalUtc: string; reason: RecurringSkipReason }> = [];

  if (isSingleOnTime) {
    toGenerate = [dueList[0]!];
  } else if (missedPolicy === "skip") {
    // If the latest slot happens to be right on time (<= 60s), generate it and skip older missed ones;
    // otherwise skip all missed slots and advance to next future occurrence.
    const latestOnTime = nowMs - lastDueMs <= ON_TIME_GRACE_MS;
    const skipSlice = latestOnTime ? dueList.slice(0, -1) : dueList;
    for (const ts of skipSlice.slice(-RECURRENCE_LIMITS.maxRecordedSkippedPerTick)) {
      skipped.push({ nominalUtc: ts, reason: "missed_policy_skip" });
    }
    if (latestOnTime) {
      toGenerate = [dueList[dueList.length - 1]!];
    }
  } else if (missedPolicy === "run_once") {
    // Generate at most 1 occurrence representing the latest eligible missed scheduled time.
    const older = dueList.slice(0, -1);
    for (const ts of older.slice(-RECURRENCE_LIMITS.maxRecordedSkippedPerTick)) {
      skipped.push({ nominalUtc: ts, reason: "missed_policy_run_once_superseded" });
    }
    toGenerate = [dueList[dueList.length - 1]!];
  } else {
    // `catch_up`: bounded to at most `catchUpLimit` most recent missed occurrences.
    const cap = Math.min(Math.max(1, catchUpLimit), RECURRENCE_LIMITS.maxCatchUpLimit);
    if (dueList.length <= cap) {
      toGenerate = dueList;
    } else {
      const dropped = dueList.slice(0, dueList.length - cap);
      for (const ts of dropped.slice(-RECURRENCE_LIMITS.maxRecordedSkippedPerTick)) {
        skipped.push({ nominalUtc: ts, reason: "missed_policy_catchup_cap" });
      }
      toGenerate = dueList.slice(-cap);
    }
  }

  if (toGenerate.length > remainingQuota) {
    toGenerate = toGenerate.slice(0, remainingQuota);
  }

  const exhaustedAfter =
    schedule.maxOccurrences != null && generatedCountSoFar + toGenerate.length >= schedule.maxOccurrences;

  return {
    toGenerate,
    skipped,
    suppressedSkippedCount,
    nextDueUtc: exhaustedAfter ? null : nextFutureUtc,
  };
}

/** Deterministic idempotency key for scheduled or completion-relative occurrences. */
export function buildScheduledOccurrenceKey(templateId: string, nominalUtc: string): string {
  return `sched:${templateId}:${nominalUtc}`;
}

export function buildCompletionOccurrenceKey(
  templateId: string,
  predecessorTaskId: string | null,
  sequenceNumber: number,
): string {
  return `after:${templateId}:${predecessorTaskId ?? "initial"}:${sequenceNumber}`;
}

export function buildManualOccurrenceKey(templateId: string, uniqueId: string): string {
  return `manual:${templateId}:${uniqueId}`;
}

const EN_MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const EN_MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Format an individual occurrence's title cleanly, e.g.:
 *   `Security audit — November 16`
 * For sub-daily intervals (hourly or custom hours < 24), append HH:MM UTC so
 * multiple same-day occurrences remain clearly distinct.
 */
export function formatOccurrenceTitle(
  baseTitle: string,
  nominalUtc: string,
  schedule: Pick<RecurringScheduleConfig, "recurrenceType" | "interval" | "intervalUnit">,
): string {
  const ms = Date.parse(nominalUtc);
  if (!Number.isFinite(ms)) return baseTitle;
  const d = new Date(ms);
  const month = EN_MONTHS_LONG[d.getUTCMonth()]!;
  const day = d.getUTCDate();
  const subDaily =
    schedule.recurrenceType === "hourly" ||
    ((schedule.recurrenceType === "custom_interval" || schedule.recurrenceType === "after_completion") &&
      schedule.intervalUnit === "hours" &&
      schedule.interval < 24);
  if (subDaily) {
    return `${baseTitle} — ${EN_MONTHS_SHORT[d.getUTCMonth()]} ${day}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  }
  return `${baseTitle} — ${month} ${day}`;
}

const EN_WEEKDAYS_FULL: Record<IsoWeekday, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

const EN_WEEKDAYS_SHORT: Record<IsoWeekday, string> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

const RU_WEEKDAYS_EVERY: Record<IsoWeekday, string> = {
  1: "Каждый понедельник",
  2: "Каждый вторник",
  3: "Каждую среду",
  4: "Каждый четверг",
  5: "Каждую пятницу",
  6: "Каждую субботу",
  7: "Каждое воскресенье",
};

const RU_WEEKDAYS_SHORT: Record<IsoWeekday, string> = {
  1: "Пн",
  2: "Вт",
  3: "Ср",
  4: "Чт",
  5: "Пт",
  6: "Сб",
  7: "Вс",
};

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function enPlural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Compact, human-readable recurrence summary for Kanban cards, Task Details,
 * and Recurring Task Management in EN and RU. Never exposes raw JSON or cron strings.
 */
export function formatRecurrenceSummary(
  schedule: Pick<
    RecurringScheduleConfig,
    "recurrenceType" | "interval" | "intervalUnit" | "weekdays" | "monthlyMode" | "dayOfMonth" | "startDateUtc" | "startTimeUtc"
  >,
  locale: "en" | "ru",
): string {
  const time = `${schedule.startTimeUtc} UTC`;
  if (locale === "ru") {
    switch (schedule.recurrenceType) {
      case "hourly":
        return "Каждый час";
      case "daily":
        return `Ежедневно, ${time}`;
      case "weekdays":
        return `По будням, ${time}`;
      case "weekly": {
        const days = schedule.weekdays;
        if (days.length === 1) return `${RU_WEEKDAYS_EVERY[days[0]!]}, ${time}`;
        return `Еженедельно (${days.map((d) => RU_WEEKDAYS_SHORT[d]).join(", ")}), ${time}`;
      }
      case "biweekly": {
        const days = schedule.weekdays;
        const suffix = days.length > 0 ? ` (${days.map((d) => RU_WEEKDAYS_SHORT[d]).join(", ")})` : "";
        return `Раз в 2 недели${suffix}, ${time}`;
      }
      case "monthly":
        return schedule.monthlyMode === "last_day"
          ? `Последний день месяца, ${time}`
          : `Ежемесячно (${schedule.dayOfMonth}-го), ${time}`;
      case "quarterly":
        return schedule.monthlyMode === "last_day"
          ? `Ежеквартально (последний день), ${time}`
          : `Ежеквартально (${schedule.dayOfMonth}-го), ${time}`;
      case "yearly": {
        const parts = parseUtcDateParts(schedule.startDateUtc);
        const dateText = parts ? `${pad2(schedule.dayOfMonth)}.${pad2(parts.month)}` : `${schedule.dayOfMonth}-го`;
        return `Ежегодно (${dateText}), ${time}`;
      }
      case "custom_interval": {
        const n = schedule.interval;
        if (schedule.intervalUnit === "hours") {
          return n === 1 ? "Каждый час" : `Каждые ${n} ${ruPlural(n, "час", "часа", "часов")}`;
        }
        if (schedule.intervalUnit === "days") {
          return n === 1 ? `Ежедневно, ${time}` : `Каждые ${n} ${ruPlural(n, "день", "дня", "дней")}, ${time}`;
        }
        return n === 1 ? `Еженедельно, ${time}` : `Каждые ${n} ${ruPlural(n, "неделю", "недели", "недель")}, ${time}`;
      }
      case "after_completion": {
        const n = schedule.interval;
        const unit =
          schedule.intervalUnit === "hours"
            ? ruPlural(n, "час", "часа", "часов")
            : schedule.intervalUnit === "days"
              ? ruPlural(n, "день", "дня", "дней")
              : ruPlural(n, "неделю", "недели", "недель");
        return `Через ${n} ${unit} после завершения`;
      }
    }
  }

  switch (schedule.recurrenceType) {
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily, ${time}`;
    case "weekdays":
      return `Weekdays, ${time}`;
    case "weekly": {
      const days = schedule.weekdays;
      if (days.length === 1) return `Every ${EN_WEEKDAYS_FULL[days[0]!]}, ${time}`;
      return `Weekly (${days.map((d) => EN_WEEKDAYS_SHORT[d]).join(", ")}), ${time}`;
    }
    case "biweekly": {
      const days = schedule.weekdays;
      const suffix = days.length > 0 ? ` (${days.map((d) => EN_WEEKDAYS_SHORT[d]).join(", ")})` : "";
      return `Every 2 weeks${suffix}, ${time}`;
    }
    case "monthly":
      return schedule.monthlyMode === "last_day"
        ? `Last day of month, ${time}`
        : `Monthly (day ${schedule.dayOfMonth}), ${time}`;
    case "quarterly":
      return schedule.monthlyMode === "last_day"
        ? `Quarterly (last day), ${time}`
        : `Quarterly (day ${schedule.dayOfMonth}), ${time}`;
    case "yearly": {
      const parts = parseUtcDateParts(schedule.startDateUtc);
      const dateText = parts ? `${EN_MONTHS_SHORT[parts.month - 1]} ${schedule.dayOfMonth}` : `day ${schedule.dayOfMonth}`;
      return `Yearly (${dateText}), ${time}`;
    }
    case "custom_interval": {
      const n = schedule.interval;
      if (schedule.intervalUnit === "hours") {
        return n === 1 ? "Every hour" : `Every ${n} ${enPlural(n, "hour", "hours")}`;
      }
      if (schedule.intervalUnit === "days") {
        return n === 1 ? `Daily, ${time}` : `Every ${n} ${enPlural(n, "day", "days")}, ${time}`;
      }
      return n === 1 ? `Every week, ${time}` : `Every ${n} ${enPlural(n, "week", "weeks")}, ${time}`;
    }
    case "after_completion": {
      const n = schedule.interval;
      const unit =
        schedule.intervalUnit === "hours"
          ? enPlural(n, "hour", "hours")
          : schedule.intervalUnit === "days"
            ? enPlural(n, "day", "days")
            : enPlural(n, "week", "weeks");
      return `${n} ${unit} after completion`;
    }
  }
}

/** Build a sensible default UTC schedule for the New Task form. */
export function defaultRecurringDraft(nowMs: number = Date.now()): {
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
} {
  const nextHourMs = Math.ceil((nowMs + 60_000) / HOUR_MS) * HOUR_MS;
  const parts = splitUtcIsoToParts(new Date(nextHourMs).toISOString()) ?? { date: "2026-11-27", time: "06:00" };
  const dp = parseUtcDateParts(parts.date) ?? { year: 2026, month: 11, day: 27 };
  return {
    recurrenceType: "daily",
    interval: 6,
    intervalUnit: "hours",
    weekdays: [isoWeekdayUtc(dp.year, dp.month, dp.day)],
    monthlyMode: "day_of_month",
    dayOfMonth: dp.day,
    missingDayPolicy: "skip",
    startDateUtc: parts.date,
    startTimeUtc: parts.time,
    endDateUtc: null,
    maxOccurrences: null,
    submissionMode: "generate_only",
    overlapPolicy: "skip_if_unresolved",
    missedPolicy: "run_once",
    catchUpLimit: RECURRENCE_LIMITS.defaultCatchUpLimit,
  };
}

export function normalizeTemplateUrgency(raw: unknown): Urgency {
  return normalizeUrgency(raw);
}
