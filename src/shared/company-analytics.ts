/** Calendar bounds and export helpers for company analytics. Instants stay epoch milliseconds. */

export const COMPARISON_MIN_SAMPLES = 3;
export type RangePreset = "today" | "yesterday" | "last7" | "last30" | "month" | "all" | "custom";
export type TrendGrain = "day" | "week" | "month";
export type ComparisonLabel = "comparable" | "insufficient";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isTimeZone(value: string): boolean {
  if (!value || value.length > 80 || value.includes("\0")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const map: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms))) map[part.type] = part.value;
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour) === 24 ? 0 : Number(map.hour),
    minute: Number(map.minute), second: Number(map.second), weekday: map.weekday ?? "Sun",
  };
}

function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

function zonedInstant(year: number, month: number, day: number, timeZone: string, near: number): number {
  const utc = Date.UTC(year, month - 1, day);
  let guess = utc - offsetMs(near, timeZone);
  for (let i = 0; i < 4; i++) {
    const next = utc - offsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function startOfZonedDay(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return zonedInstant(p.year, p.month, p.day, timeZone, ms);
}

export function addZonedDays(dayStart: number, days: number, timeZone: string): number {
  const p = zonedParts(dayStart, timeZone);
  return zonedInstant(p.year, p.month, p.day + days, timeZone, dayStart);
}

export function rangeBounds(
  preset: RangePreset, now: number, timeZone: string, custom?: { from?: number; until?: number },
): { from?: number; until?: number } {
  if (preset === "all") return {};
  if (preset === "custom") return { from: custom?.from, until: custom?.until };
  const start = startOfZonedDay(now, timeZone);
  if (preset === "today") return { from: start, until: addZonedDays(start, 1, timeZone) };
  if (preset === "yesterday") {
    const from = addZonedDays(start, -1, timeZone);
    return { from, until: start };
  }
  if (preset === "last7") return { from: addZonedDays(start, -6, timeZone), until: addZonedDays(start, 1, timeZone) };
  if (preset === "last30") return { from: addZonedDays(start, -29, timeZone), until: addZonedDays(start, 1, timeZone) };
  const p = zonedParts(now, timeZone);
  return {
    from: zonedInstant(p.year, p.month, 1, timeZone, now),
    until: zonedInstant(p.year, p.month + 1, 1, timeZone, now),
  };
}

export function bucketKey(ms: number, grain: TrendGrain, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  if (grain === "day") return day;
  if (grain === "month") return day.slice(0, 7);
  const weekday = WEEKDAYS.indexOf(p.weekday);
  const iso = weekday <= 0 ? 7 : weekday;
  const thursday = addZonedDays(startOfZonedDay(ms, timeZone), 4 - iso, timeZone);
  const t = zonedParts(thursday, timeZone);
  const jan4 = zonedInstant(t.year, 1, 4, timeZone, thursday);
  const jan4wd = WEEKDAYS.indexOf(zonedParts(jan4, timeZone).weekday);
  const week1 = addZonedDays(startOfZonedDay(jan4, timeZone), 4 - (jan4wd <= 0 ? 7 : jan4wd), timeZone);
  const week = 1 + Math.round((thursday - week1) / 604_800_000);
  return `${t.year}-W${String(week).padStart(2, "0")}`;
}

export function comparisonLabel(samples: number, categories: readonly string[]): ComparisonLabel {
  return samples >= COMPARISON_MIN_SAMPLES && new Set(categories.filter(Boolean)).size <= 1 ? "comparable" : "insufficient";
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\n") + "\n";
}
