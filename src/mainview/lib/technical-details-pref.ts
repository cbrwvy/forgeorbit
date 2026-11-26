/**
 * FO-UX-SIMPLIFY02-M2: the one global "Show technical details" preference.
 *
 * Presentation only. It decides whether diagnostic disclosures start open and whether inline
 * ids are shown; it never gates a security decision and is never sent to the core.
 * localStorage for the same reason as `density.ts` / `panel-collapse.ts`: pure webview chrome
 * that must resolve synchronously in the first render. Default: off.
 */
import { useSyncExternalStore } from "react";

export const TECHNICAL_DETAILS_STORAGE_KEY = "agetor:technical-details";

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PrefStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Only the exact stored "on" reads as enabled; anything else (missing, corrupt) is off. */
export function parseTechnicalDetails(value: unknown): boolean {
  return value === "on";
}

export function readTechnicalDetails(storage: PrefStorage | null = defaultStorage()): boolean {
  try {
    return parseTechnicalDetails(storage?.getItem(TECHNICAL_DETAILS_STORAGE_KEY));
  } catch {
    return false;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

export function getShowTechnicalDetails(): boolean {
  if (current === null) current = readTechnicalDetails();
  return current;
}

/** Best-effort persistence: a throwing or full storage must never break the UI. */
export function setShowTechnicalDetails(next: boolean, storage: PrefStorage | null = defaultStorage()): void {
  current = next;
  try {
    storage?.setItem(TECHNICAL_DETAILS_STORAGE_KEY, next ? "on" : "off");
  } catch {
    /* ignore */
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Live value for React. Server render (tests) reads off. */
export function useShowTechnicalDetails(): boolean {
  return useSyncExternalStore(subscribe, getShowTechnicalDetails, () => false);
}

/** Test seam: forget the cached value so the next read comes from storage. */
export function __resetTechnicalDetailsForTest(): void {
  current = null;
  listeners.clear();
}
