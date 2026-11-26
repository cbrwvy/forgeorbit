/**
 * Portfolio-manager sync signals (FO-008D) forwarded from App's single
 * `/app/events` stream: a `portfolio_delegation` event (ids and status only)
 * or a reconnect of the stream, after which events may have been missed.
 * Listeners re-read the state from the core; nothing here carries content.
 * The tab never opens its own EventSource (WKWebView's per-host connection
 * cap, see `lib/pipeline-events.ts`).
 */

import type { AppEvent } from "../../shared/types.ts";

export type DelegationAppEvent = Extract<AppEvent, { type: "portfolio_delegation" }>;

export type PortfolioManagerSignal = { kind: "delegation"; event: DelegationAppEvent } | { kind: "reconnect" };

type Listener = (signal: PortfolioManagerSignal) => void;

const listeners = new Set<Listener>();

export function publishPortfolioManagerSignal(signal: PortfolioManagerSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch (err) {
      console.warn("[agetor] portfolio manager listener threw", err);
    }
  }
}

export function subscribePortfolioManagerSignals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Re-reads coalesced into one in-flight request plus at most one trailing
 * one, and answers applied only when they are the newest started — so a
 * burst of events never stacks requests and a slow old answer never
 * overwrites a newer one.
 */
export function createLatestLoader<T>(load: () => Promise<T>, apply: (value: T) => void, onError?: (error: unknown) => void) {
  let seq = 0;
  let inFlight = false;
  let again = false;
  let disposed = false;
  const run = async (): Promise<void> => {
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const mine = ++seq;
    try {
      const value = await load();
      if (!disposed && mine === seq) apply(value);
    } catch (error) {
      if (!disposed && mine === seq) onError?.(error);
    } finally {
      inFlight = false;
      if (again && !disposed) {
        again = false;
        void run();
      }
    }
  };
  return {
    request: run,
    /** Marks every answer still in flight as stale (e.g. after a local write). */
    invalidate(): void {
      seq += 1;
    },
    dispose(): void {
      disposed = true;
    },
  };
}
