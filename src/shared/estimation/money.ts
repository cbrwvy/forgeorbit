/**
 * Money arithmetic. Rates convert minor units and only in the direction the
 * caller supplied — this module does not invert a rate and does not know
 * currency exponents.
 */

import type { CashStatus, DataOrigin, ExchangeRate, Money } from "./types.ts";

const ORIGIN_RANK: Record<DataOrigin, number> = {
  known: 4,
  observed: 3,
  "user-provided": 2,
  estimated: 1,
  unknown: 0,
};

export function weakerOrigin(a: DataOrigin, b: DataOrigin): DataOrigin {
  return ORIGIN_RANK[a] <= ORIGIN_RANK[b] ? a : b;
}

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

export function convertMoney(
  money: Money,
  reportCurrency: string,
  rates: readonly ExchangeRate[],
): Money | null {
  if (money.currency === reportCurrency) return { currency: reportCurrency, minor: money.minor };
  const rate = rates.find((entry) => entry.from === money.currency && entry.to === reportCurrency);
  if (!rate) return null;
  const minor = Math.round(money.minor * rate.rate);
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return { currency: reportCurrency, minor };
}

export interface CombinedMoney {
  status: Exclude<CashStatus, "not-requested">;
  money: Money | null;
  knownPortion: Money | null;
  origin: DataOrigin;
  note: string | null;
}

/**
 * Sum parts into `reportCurrency`. A null part is an unpriced component.
 * A failed conversion fails the whole sum: a partial in one currency is not
 * reported as if the other currency had been included.
 */
export function combineMoney(
  parts: readonly Money[],
  unpriced: number,
  origins: readonly DataOrigin[],
  reportCurrency: string,
  rates: readonly ExchangeRate[],
): CombinedMoney {
  const currencies = new Set<string>();
  let portion = 0;
  let priced = 0;
  let origin: DataOrigin = "known";
  for (const part of parts) currencies.add(part.currency);
  for (const part of parts) {
    const converted = convertMoney(part, reportCurrency, rates);
    if (!converted) {
      const list = [...currencies].sort().join(", ");
      return {
        status: "mixed-currency",
        money: null,
        knownPortion: null,
        origin: "unknown",
        note: `No exchange rate into ${reportCurrency} for every amount (${list}). Currencies were not mixed.`,
      };
    }
    if (!Number.isSafeInteger(portion + converted.minor)) {
      return {
        status: "unknown",
        money: null,
        knownPortion: null,
        origin: "unknown",
        note: "The money sum does not fit in a safe integer.",
      };
    }
    portion += converted.minor;
    priced += 1;
  }
  for (const entry of origins) origin = weakerOrigin(origin, entry);
  if (priced === 0 && unpriced > 0) {
    return {
      status: "unknown",
      money: null,
      knownPortion: null,
      origin: "unknown",
      note: "A required price was not provided.",
    };
  }
  if (unpriced > 0) {
    return {
      status: "incomplete",
      money: null,
      knownPortion: { currency: reportCurrency, minor: portion },
      origin,
      note: "Part of the cost has a price and part does not. The priced portion is not the total.",
    };
  }
  return {
    status: "known",
    money: { currency: reportCurrency, minor: portion },
    knownPortion: { currency: reportCurrency, minor: portion },
    origin: parts.length === 0 ? "known" : origin,
    note: null,
  };
}

/** Ceiling division for a charge: never round a billed estimate down. */
export function scaleCharge(minor: number, units: number, per: number): number | null {
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(units) || !Number.isSafeInteger(per) || per <= 0) {
    return null;
  }
  if (units === 0 || minor === 0) return 0;
  if (units > Number.MAX_SAFE_INTEGER / minor) return null;
  const value = Math.ceil((minor * units) / per);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export function zeroMoney(currency: string): Money {
  return { currency, minor: 0 };
}
