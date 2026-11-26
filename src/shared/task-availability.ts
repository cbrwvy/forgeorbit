/**
 * Scheduled task availability (FO-KANBAN-SCHEDULE01).
 *
 * Pure, canonical UTC earliest-start parsing, validation, evaluation, and
 * display formatting shared across the backend, schedulers, webview, and tests.
 *
 * Semantics:
 *  - `null` / absent: available immediately.
 *  - A canonical UTC instant (`YYYY-MM-DDTHH:mm:ss.sssZ`): automatic execution
 *    must wait while `nowMs < availableFromMs`. Once `nowMs >= availableFromMs`,
 *    the time restriction is satisfied.
 *
 * Never interprets a timezone-less timestamp as local system time.
 */

export interface TaskAvailabilityEvaluation {
  /** True when the earliest-start restriction is absent or has arrived (`nowMs >= availableFromMs`). */
  available: boolean;
  /** Canonical UTC ISO-8601 instant (`YYYY-MM-DDTHH:mm:ss.sssZ`), or `null` when unrestricted. */
  availableFromUtc: string | null;
  /** Epoch milliseconds of `availableFromUtc`, or `null` when unrestricted (or corrupt). */
  availableFromMs: number | null;
  /** Milliseconds remaining until `availableFromMs` (`0` when available). */
  remainingMs: number;
  /** True only when a non-null stored value failed to parse; treated fail-closed as unavailable. */
  corrupt?: boolean;
}

export type ParseAvailableFromUtcResult =
  | { ok: true; value: string | null }
  | { ok: false; code: "invalid-available-from-utc"; error: string };

/**
 * Strict ISO-8601 timestamp with mandatory uppercase `T` and mandatory explicit
 * timezone (`Z` or `±HH:MM`). Rejects date-only strings, space separators,
 * locale strings, and ambiguous timezone-less timestamps.
 */
const STRICT_ISO_TZ_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Validate and canonicalize an incoming `availableFromUtc` value.
 *  - `null` -> `{ ok: true, value: null }` (explicitly cleared / immediate).
 *  - valid ISO-8601 instant with explicit timezone -> `{ ok: true, value: "<YYYY-MM-DDTHH:mm:ss.sssZ>" }`.
 *  - anything else (missing TZ, malformed string, invalid calendar date like Feb 30, empty string, non-string) -> error.
 */
export function parseAvailableFromUtc(raw: unknown): ParseAvailableFromUtcResult {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return {
      ok: false,
      code: "invalid-available-from-utc",
      error: "availableFromUtc must be null or an ISO-8601 UTC timestamp with timezone (e.g. 2026-11-27T08:00:00.000Z).",
    };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed !== raw) {
    return {
      ok: false,
      code: "invalid-available-from-utc",
      error: "availableFromUtc must be a canonical ISO-8601 timestamp with explicit timezone (Z or ±HH:MM).",
    };
  }
  const match = STRICT_ISO_TZ_RE.exec(raw);
  if (!match) {
    return {
      ok: false,
      code: "invalid-available-from-utc",
      error: "availableFromUtc must be a valid ISO-8601 timestamp with an explicit timezone (Z or ±HH:MM). Timestamps without a timezone are not accepted.",
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  const ms = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
  const tz = match[8]!;
  const tzSign = match[9];
  const tzHour = match[10] ? Number(match[10]) : 0;
  const tzMinute = match[11] ? Number(match[11]) : 0;

  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, code: "invalid-available-from-utc", error: "availableFromUtc contains an out-of-range calendar date." };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, code: "invalid-available-from-utc", error: "availableFromUtc contains an invalid time of day." };
  }
  if (tz !== "Z" && (tzHour > 23 || tzMinute > 59)) {
    return { ok: false, code: "invalid-available-from-utc", error: "availableFromUtc contains an invalid timezone offset." };
  }

  // Verify the calendar date didn't silently roll over (e.g., 2026-02-30 -> March 2).
  const calendarCheck = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return { ok: false, code: "invalid-available-from-utc", error: "availableFromUtc is not a real calendar date." };
  }

  const offsetMinutes = tz === "Z" ? 0 : (tzSign === "+" ? 1 : -1) * (tzHour * 60 + tzMinute);
  const utcMs = calendarCheck.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(utcMs)) {
    return { ok: false, code: "invalid-available-from-utc", error: "availableFromUtc could not be represented as a UTC timestamp." };
  }
  const canonical = new Date(utcMs).toISOString();
  if (!STRICT_ISO_TZ_RE.test(canonical)) {
    return { ok: false, code: "invalid-available-from-utc", error: "availableFromUtc falls outside the supported UTC range." };
  }
  return { ok: true, value: canonical };
}

/**
 * Canonical availability evaluator shared by every scheduler, admission gate, and UI view.
 * Accepts either a task-like object (`{ availableFromUtc }`) or a raw timestamp string/null.
 */
export function evaluateTaskAvailability(
  input: { availableFromUtc?: string | null } | string | null | undefined,
  nowMs: number = Date.now(),
): TaskAvailabilityEvaluation {
  const raw = typeof input === "string" || input == null ? input ?? null : (input.availableFromUtc ?? null);
  if (raw === null) {
    return { available: true, availableFromUtc: null, availableFromMs: null, remainingMs: 0 };
  }
  const parsed = parseAvailableFromUtc(raw);
  if (!parsed.ok || parsed.value === null) {
    // Fail closed if a corrupted non-null timestamp ever exists in storage.
    return { available: false, availableFromUtc: raw, availableFromMs: null, remainingMs: Number.POSITIVE_INFINITY, corrupt: true };
  }
  const availableFromMs = Date.parse(parsed.value);
  if (!Number.isFinite(availableFromMs)) {
    return { available: false, availableFromUtc: parsed.value, availableFromMs: null, remainingMs: Number.POSITIVE_INFINITY, corrupt: true };
  }
  if (nowMs >= availableFromMs) {
    return { available: true, availableFromUtc: parsed.value, availableFromMs, remainingMs: 0 };
  }
  return {
    available: false,
    availableFromUtc: parsed.value,
    availableFromMs,
    remainingMs: availableFromMs - nowMs,
  };
}

/** True when a task has a future earliest-start restriction at `nowMs`. */
export function isTaskScheduledWaiting(
  input: { availableFromUtc?: string | null } | string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return !evaluateTaskAvailability(input, nowMs).available;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const EN_SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Format a canonical UTC instant for display in UTC+0.
 *  - EN: `Nov 27, 2026, 08:00 UTC`
 *  - RU: `27.11.2026, 08:00 UTC`
 */
export function formatUtcTimestamp(isoUtc: string, locale: "en" | "ru"): string {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return isoUtc;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  if (locale === "ru") {
    return `${pad2(day)}.${pad2(month + 1)}.${year}, ${hh}:${mm} UTC`;
  }
  return `${EN_SHORT_MONTHS[month]} ${day}, ${year}, ${hh}:${mm} UTC`;
}

/**
 * Build a canonical UTC ISO string from separate UTC date (`YYYY-MM-DD`) and
 * time (`HH:MM`) picker inputs. Returns `null` if either part is invalid.
 */
export function buildUtcIsoFromParts(dateStr: string, timeStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) return null;
  const parsed = parseAvailableFromUtc(`${dateStr}T${timeStr}:00.000Z`);
  return parsed.ok ? parsed.value : null;
}

/** Split a canonical UTC ISO string into `{ date: "YYYY-MM-DD", time: "HH:MM" }` in UTC. */
export function splitUtcIsoToParts(isoUtc: string | null | undefined): { date: string; time: string } | null {
  if (!isoUtc) return null;
  const parsed = parseAvailableFromUtc(isoUtc);
  if (!parsed.ok || !parsed.value) return null;
  const d = new Date(Date.parse(parsed.value));
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  };
}

/** Default initial UTC date/time parts for the picker: next rounded UTC hour from `nowMs`. */
export function defaultUtcPickerParts(nowMs: number = Date.now()): { date: string; time: string } {
  const nextHourMs = Math.ceil((nowMs + 60_000) / 3_600_000) * 3_600_000;
  const d = new Date(nextHourMs);
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  };
}

/**
 * Format a secondary local-time preview using the system's actual IANA timezone
 * (never hardcoded). Always formats 24-hour `HH:MM` so UTC+5 for 08:00 UTC
 * shows `13:00`.
 */
export function formatLocalTimePreview(
  isoUtc: string,
  locale: "en" | "ru",
  timeZone?: string,
): { text: string; timeZone: string; offsetLabel: string } | null {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return null;
  const resolvedTz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const d = new Date(ms);
  try {
    const parts = new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
      timeZone: resolvedTz,
      year: "numeric",
      month: locale === "ru" ? "2-digit" : "short",
      day: locale === "ru" ? "2-digit" : "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    const datePart = locale === "ru"
      ? `${get("day")}.${get("month")}.${get("year")}`
      : `${get("month")} ${get("day")}, ${get("year")}`;
    const timePart = `${get("hour")}:${get("minute")}`;

    // Compute short UTC offset label (e.g. UTC+5, UTC-4, UTC+05:30, UTC)
    let offsetLabel = resolvedTz;
    try {
      const tzParts = new Intl.DateTimeFormat("en-US", {
        timeZone: resolvedTz,
        timeZoneName: "shortOffset",
      }).formatToParts(d);
      const rawOffset = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "";
      if (rawOffset === "GMT" || rawOffset === "UTC") offsetLabel = "UTC+0";
      else if (rawOffset.startsWith("GMT")) offsetLabel = `UTC${rawOffset.slice(3)}`;
      else if (rawOffset) offsetLabel = rawOffset;
    } catch {
      offsetLabel = resolvedTz;
    }

    return {
      text: `${datePart}, ${timePart}`,
      timeZone: resolvedTz,
      offsetLabel,
    };
  } catch {
    return null;
  }
}
