import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { activityConnection, subscribeActivitySignal } from "@/lib/activity-events";
import { mergeActivity } from "@/lib/activity-journal";
import type { ActivityEvent, ActivityQueryFilter } from "../../../../../shared/activity/types.ts";

export interface JournalState {
  events: ActivityEvent[]; loading: boolean; error: boolean; offline: boolean; more: boolean;
}
const initial = (): JournalState => ({ events: [], loading: true, error: false, offline: !navigator.onLine, more: false });

/** Each filter gets an abortable, serial request queue and its own two cursors. */
export function useActivityJournal(filter: ActivityQueryFilter | null) {
  const key = JSON.stringify(filter);
  const [state, setState] = useState<JournalState>(initial);
  const [actions, setActions] = useState({ loadMore: () => {}, refresh: () => {} });
  // Hide previous-scope rows synchronously, before effect cleanup on a filter change.
  const [loadedKey, setLoadedKey] = useState(key);
  useEffect(() => {
    setLoadedKey(key);
    setState(initial());
    if (!filter) { setState(s => ({ ...s, loading: false })); return; }
    const controller = new AbortController();
    const signal = controller.signal;
    let rows: ActivityEvent[] = [];
    let older: string | null = null;
    let high = 0;
    let busy = false;
    let pending = false;
    let initialized = false;
    const update = (patch: Partial<JournalState>) => { if (!signal.aborted) setState(s => ({ ...s, ...patch })); };
    const load = async (mode: "initial" | "live" | "older") => {
      if (signal.aborted) return;
      if (busy) { if (mode !== "older") pending = true; return; }
      busy = true;
      update({ loading: true });
      try {
        if (!initialized) mode = "initial";
        let cursor = mode === "older" ? older : mode === "live" ? String(high) : null;
        // Empty histories refresh backward: cursor=0 is deliberately unsupported.
        if (mode === "live" && high === 0) mode = "initial";
        do {
          const response = await api.listActivity({ ...filter, limit: 50, direction: mode === "live" ? "forward" : "backward", cursor: mode === "initial" ? undefined : cursor }, signal);
          if (signal.aborted) return;
          rows = mergeActivity(rows, response.events, filter.projectPath);
          high = Math.max(high, ...response.events.map(e => e.sequenceId));
          if (mode !== "live") { older = response.nextCursor; update({ more: response.hasMore }); }
          cursor = response.nextCursor;
          update({ events: rows, error: false, offline: !navigator.onLine || activityConnection() === "disconnected" });
        } while (mode === "live" && cursor && !signal.aborted);
        initialized = true;
      } catch {
        if (!signal.aborted) update({ error: true, offline: !navigator.onLine || activityConnection() === "disconnected" });
      } finally {
        busy = false;
        update({ loading: false });
        if (pending && !signal.aborted) { pending = false; void load("live"); }
      }
    };
    setActions({ loadMore: () => { if (older) void load("older"); }, refresh: () => { void load("live"); } });
    const unsubscribe = subscribeActivitySignal(event => {
      if (event === "disconnected") update({ offline: true });
      else void load("live");
    });
    const recover = () => { void load("live"); };
    const offline = () => update({ offline: true });
    const visible = () => { if (document.visibilityState === "visible") recover(); };
    window.addEventListener("online", recover);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", visible);
    void load("initial");
    return () => {
      controller.abort(); unsubscribe();
      window.removeEventListener("online", recover); window.removeEventListener("offline", offline);
      window.removeEventListener("focus", recover); document.removeEventListener("visibilitychange", visible);
    };
    // Filter identity comes from its serialized value, not locale or render identity.
  }, [key]);
  return { ...(loadedKey === key ? state : initial()), ...actions };
}
