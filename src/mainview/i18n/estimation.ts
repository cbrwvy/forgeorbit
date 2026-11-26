export * from "../../shared/estimation/present.ts";
import * as canonical from "../../shared/estimation/present.ts";
import type { Money } from "../../shared/estimation/types.ts";
import { getLocale, intlLocale, formatNumber } from "./core";
import { staticLabel } from "./presentation";
export function formatDurationMs(ms: number): string {
  if (getLocale() === "en") return canonical.formatDurationMs(ms);
  if (!Number.isSafeInteger(ms) || ms < 0) return staticLabel("Unknown");
  const total = Math.round(ms / 60000);
  if (ms > 0 && total === 0) return "< 1 мин";
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), minutes = total % 60;
  return [days ? `${formatNumber(days)} дн.` : "", hours ? `${formatNumber(hours)} ч` : "", minutes || (!days && !hours) ? `${formatNumber(minutes)} мин` : ""].filter(Boolean).join(" ");
}
export function formatMoney(money: Money): string {
  const digits = canonical.currencyFractionDigits(money.currency);
  if (digits === null) return canonical.formatMoney(money);
  return new Intl.NumberFormat(intlLocale(), { style: "currency", currency: money.currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(money.minor / 10 ** digits);
}
const figure = (value: canonical.DisplayFigure): canonical.DisplayFigure => ({ ...value, headline: staticLabel(value.headline) });
export const formatDurationForecast: typeof canonical.formatDurationForecast = forecast => {
  const value = figure(canonical.formatDurationForecast(forecast));
  return forecast.ms != null && (forecast.status === "known" || forecast.status === "estimated") ? { ...value, headline: formatDurationMs(forecast.ms) } : value;
};
export const formatCalendar: typeof canonical.formatCalendar = forecast => {
  const value = figure(canonical.formatCalendar(forecast));
  return forecast.ms != null && forecast.status === "known" ? { ...value, headline: formatDurationMs(forecast.ms) } : value;
};
export const formatCash: typeof canonical.formatCash = cash => {
  const value = figure(canonical.formatCash(cash));
  return cash.money && cash.status !== "incomplete" && cash.basis !== "policy" ? { ...value, headline: formatMoney(cash.money) } : value;
};
