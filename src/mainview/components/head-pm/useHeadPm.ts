import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { createLatestLoader, subscribePortfolioManagerSignals } from "@/lib/portfolio-manager-events";
import type { PortfolioManagerState } from "../../../shared/portfolio-manager.ts";

type SendInput = Parameters<typeof api.sendPortfolioMessage>[0];
const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const POLL_MS = 700;

export interface HeadPm {
  data: PortfolioManagerState | null;
  loadError: string | null;
  sending: boolean;
  thinking: boolean;
  error: string | null;
  send(input: SendInput): Promise<boolean>;
  cancel(): void;
  reload(): Promise<void>;
  mutate(update: (data: PortfolioManagerState) => PortfolioManagerState): void;
}

/** All scopes share the same backend conversation and in-flight turn. */
export function useHeadPm(): HeadPm {
  const [data, setData] = useState<PortfolioManagerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const loaderRef = useRef<ReturnType<typeof createLatestLoader<PortfolioManagerState>> | null>(null);
  const reload = useCallback(async () => { await loaderRef.current?.request(); }, []);

  useEffect(() => {
    const loader = createLatestLoader(api.getPortfolioManager,
      (value) => { setData(value); setLoadError(null); },
      (reason) => setLoadError(messageOf(reason)));
    loaderRef.current = loader;
    void loader.request();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sync = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void reload(); }, 120);
    };
    const unsubscribe = subscribePortfolioManagerSignals(sync);
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const activeId = data?.activeTurn?.id;
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const turn = await api.getPortfolioTurn(activeId);
        if (stopped) return;
        if (turn.status === "running") timer = setTimeout(poll, POLL_MS);
        else await reload();
      } catch (caught) {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 404) await reload();
        else timer = setTimeout(poll, POLL_MS * 2);
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeId, reload]);

  const mutate = useCallback((update: (value: PortfolioManagerState) => PortfolioManagerState) => {
    loaderRef.current?.invalidate();
    setData((current) => current && update(current));
  }, []);
  const send = useCallback(async (input: SendInput) => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await api.sendPortfolioMessage(input);
      await reload();
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 428) {
        mutate((value) => ({ ...value, config: { ...value.config, consentKey: null } }));
      }
      setError(messageOf(caught));
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [reload, mutate]);
  const cancel = useCallback(() => {
    if (activeId) void api.cancelPortfolioTurn(activeId).catch(() => {});
  }, [activeId]);
  return { data, loadError, sending, thinking: sending || !!activeId, error, send, cancel, reload, mutate };
}
