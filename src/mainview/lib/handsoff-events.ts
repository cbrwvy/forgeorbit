/**
 * "Work independently" state for the webview: one overview read (policies + open and recent runs), refreshed on the
 * core's `handsoff` events forwarded from App's single `/app/events` stream, on window focus, and on a light timer
 * only while something is actually running. Listeners never open their own EventSource.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { AppEvent } from "../../shared/types.ts";
import type { HandsoffOverview, HandsoffRun } from "../../shared/handsoff.ts";
import { api } from "./api";

export type HandsoffAppEvent = Extract<AppEvent, { type: "handsoff" }>;

let overview: HandsoffOverview | null = null;
let version = 0;
const listeners = new Set<() => void>();
let loading = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

const emit = () => { version += 1; for (const listener of [...listeners]) listener(); };

async function load(): Promise<void> {
  if (loading) { again = true; return; }
  loading = true;
  try {
    overview = await api.getHandsoffOverview();
    emit();
  } catch { /* keep what was shown; the next event, focus or tick tries again */ }
  finally {
    loading = false;
    if (again) { again = false; void load(); }
  }
}

export function refreshHandsoff(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void load(); }, 120);
}

const refreshListeners = new Set<() => void>();
/** For surfaces that re-read their own endpoint (the Owner-actions roll-up) when the core says something changed. */
export function subscribeHandsoffRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => { refreshListeners.delete(listener); };
}

export function publishHandsoffEvent(_event: HandsoffAppEvent): void {
  refreshHandsoff();
  for (const listener of [...refreshListeners]) { try { listener(); } catch { /* one listener cannot break the others */ } }
}

function busy(): boolean {
  return Boolean(overview?.runs.some((run) => run.finishedAt == null && (run.status === "active" || run.status === "waiting")));
}

function onFocus(): void { refreshHandsoff(); }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("focus", onFocus);
    poll = setInterval(() => { if (busy() && document.visibilityState === "visible") refreshHandsoff(); }, 6000);
    void load();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", onFocus);
      if (poll) clearInterval(poll);
      poll = null;
    }
  };
}

/** The overview, or null before the first answer. */
export function useHandsoffOverview(): HandsoffOverview | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return overview;
}

/** The run to show for a task: its open run, else its newest finished one. */
export function runForTask(source: HandsoffOverview | null, taskId: string): HandsoffRun | null {
  if (!source) return null;
  const mine = source.runs.filter((run) => run.taskId === taskId);
  return mine.find((run) => run.finishedAt == null) ?? mine[0] ?? null;
}

export function useHandsoffRun(taskId: string): HandsoffRun | null {
  return runForTask(useHandsoffOverview(), taskId);
}

export function policyEnabledFor(source: HandsoffOverview | null, projectPath: string): boolean {
  return Boolean(source?.policies.some((policy) => policy.projectPath === projectPath && policy.enabled));
}

/** Test seam: replace the cached overview. */
export function __setHandsoffOverviewForTest(next: HandsoffOverview | null): void { overview = next; emit(); }

/** Ensures a mounted component keeps the store warm even when it only calls `refreshHandsoff`. */
export function useHandsoffRefreshOnMount(): void {
  useEffect(() => { refreshHandsoff(); }, []);
}

/** A link, not an action: ask the app to open this project's settings page (where "Work independently" is set up). */
export const OPEN_PROJECT_SETTINGS_EVENT = "forgeorbit:open-project-settings";
export function requestOpenProjectSettings(projectPath: string): void {
  try { window.dispatchEvent(new CustomEvent(OPEN_PROJECT_SETTINGS_EVENT, { detail: { projectPath } })); } catch { /* no window */ }
}
export function onOpenProjectSettingsRequest(handler: (projectPath: string) => void): () => void {
  const listener = (event: Event) => {
    const path = (event as CustomEvent<{ projectPath?: unknown }>).detail?.projectPath;
    if (typeof path === "string" && path) handler(path);
  };
  window.addEventListener(OPEN_PROJECT_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(OPEN_PROJECT_SETTINGS_EVENT, listener);
}
