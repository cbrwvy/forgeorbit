import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { subscribeBatchEvents } from "./batch-events";
import { subscribePortfolioManagerSignals } from "./portfolio-manager-events";
import { subscribeProjectPermissionEvents } from "./project-permission-events";
import { subscribeHandsoffRefresh } from "./handsoff-events";
import type { OwnerActionsPayload } from "../../shared/owner-actions.ts";

/**
 * The read-only roll-up behind "Needs you" and the Head of PM (GET /owner-actions).
 * Re-read on mount, window focus, and the app's own batch / delegation events —
 * no timer, no model call. `refresh()` is for local changes (an approval card was used).
 */
export function useOwnerActions(): { rows: OwnerActionsPayload | null; refresh: () => void } {
  const [rows, setRows] = useState<OwnerActionsPayload | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    const mine = ++seq.current;
    void api.getOwnerActions().then(
      (next) => { if (mine === seq.current) setRows(next); },
      () => { /* keep what was shown; the next event or focus tries again */ },
    );
  }, []);
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; load(); }, 150);
  }, [load]);
  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const offBatch = subscribeBatchEvents(refresh);
    const offSignals = subscribePortfolioManagerSignals(refresh);
    const offPermissions = subscribeProjectPermissionEvents(refresh);
    const offHandsoff = subscribeHandsoffRefresh(refresh);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      offBatch();
      offSignals();
      offPermissions();
      offHandsoff();
    };
  }, [load, refresh]);
  return { rows, refresh };
}
