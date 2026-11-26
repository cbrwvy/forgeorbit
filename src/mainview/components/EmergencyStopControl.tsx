import { useEffect, useSyncExternalStore } from "react";
import { Inbox, OctagonX, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { clearEmergency, emergencyStore, refreshEmergency, requestEmergencyStop, type EmergencyState } from "@/lib/emergency-stop";

const POLL_MS = 15_000;

/** What a screen reader hears and what the tooltip says. Never claims more than the core reported. */
export function emergencyStatusText(state: EmergencyState): string {
  if (state.stopFailed) return tr("estop.failed");
  switch (state.phase) {
    case "stopping": return tr("estop.stopping");
    case "active": {
      const base = state.outstanding.length > 0
        ? tr("estop.activeOutstanding", { count: state.outstanding.length })
        : tr("estop.activeNoneReported");
      // The stop never covers what the Owner started by hand; say so with the live number, not only in general.
      return state.leftRunning > 0 ? `${base} ${tr("d5.estop.leftRunning", { count: state.leftRunning })}` : base;
    }
    case "clear": return tr("estop.ready");
    default: return tr("estop.unknown");
  }
}

/** Shared Owner confirmation for clearing the stop (title bar and Mission Control use the same words). */
export function useClearEmergencyWithConfirm(): () => Promise<boolean> {
  const confirm = useConfirm();
  return async () => {
    const ok = await confirm(() => ({
      title: tr("estop.clearTitle"),
      description: tr("estop.clearBody"),
      confirmLabel: tr("estop.clearConfirm"),
      // Destructive styling keeps the default focus on Cancel: Enter must not lift the stop by accident.
      variant: "destructive",
    }));
    if (!ok) return false;
    return clearEmergency();
  };
}

/**
 * Persistent title-bar control. One click stops (no confirmation); lifting the stop asks first.
 * The state comes from the core's stored flag, re-read on mount, on window focus and on a slow timer.
 */
export function EmergencyStopControl({ runningSignal }: { runningSignal?: number } = {}) {
  useUILocale();
  const state = useSyncExternalStore(emergencyStore.subscribe, emergencyStore.getSnapshot, emergencyStore.getSnapshot);
  const clearWithConfirm = useClearEmergencyWithConfirm();

  useEffect(() => {
    void refreshEmergency();
    const onFocus = () => { if (document.visibilityState === "visible") void refreshEmergency(); };
    const timer = setInterval(onFocus, POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // While the stop is on, a change in how many tasks run changes what it did not stop: read it again.
  useEffect(() => {
    if (runningSignal !== undefined && emergencyStore.getSnapshot().phase === "active") void refreshEmergency();
  }, [runningSignal]);

  return <EmergencyStopView state={state} onStop={() => void requestEmergencyStop(tr("mc.emergencyReason"))} onResume={() => void clearWithConfirm()} />;
}

/** Presentation only (no hooks beyond locale), so it can be rendered in unit tests. */
export function EmergencyStopView({ state, onStop, onResume }: { state: EmergencyState; onStop: () => void; onResume: () => void }) {
  useUILocale();
  const active = state.phase === "active";
  const stopping = state.phase === "stopping";
  const status = emergencyStatusText(state);

  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="emergency-stop" data-phase={state.phase} data-stop-failed={state.stopFailed ? "true" : "false"}>
      {/* Always mounted so the first change is announced, not skipped as initial content. */}
      <span role="status" aria-live="assertive" className="sr-only" data-testid="emergency-stop-status">{state.phase === "unknown" && !state.stopFailed ? "" : status}</span>
      {active ? (
        <>
          <span
            className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-danger/50 bg-danger/10 px-2 text-xs font-medium text-danger"
            title={`${status} ${tr("estop.scope")}`}
            data-testid="emergency-stop-active"
          >
            <OctagonX className="size-3.5 shrink-0" aria-hidden />
            <span>{tr("estop.stoppedLabel")}</span>
            {state.outstanding.length > 0 && <span className="tabular-nums" data-testid="emergency-stop-outstanding">· {state.outstanding.length}</span>}
          </span>
          {state.leftRunning > 0 && (
            <span
              className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-warning/40 bg-warning/10 px-2 text-xs font-medium text-warning"
              title={tr("d5.estop.leftRunning", { count: state.leftRunning })}
              data-testid="emergency-stop-left-running"
              data-count={state.leftRunning}
            >
              <span className="tabular-nums">{state.leftRunning}</span>
              <span className="hidden xl:inline">{tr("d5.estop.chip")}</span>
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 min-h-8 shrink-0 gap-1.5"
            onClick={onResume}
            aria-label={tr("estop.resume")}
            title={tr("estop.resume")}
            data-testid="emergency-stop-resume"
          >
            <Play className="size-3.5 shrink-0" aria-hidden />
            <span className="hidden xl:inline">{tr("estop.resume")}</span>
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("h-8 min-h-8 gap-1.5 border-danger/45 text-danger hover:border-danger/70 hover:bg-danger/10 hover:text-danger", state.stopFailed && "ring-2 ring-warning")}
          disabled={stopping}
          onClick={onStop}
          aria-label={tr("autonomy.emergency")}
          aria-describedby="emergency-stop-hint"
          title={`${state.stopFailed || state.phase === "stopping" ? `${status} ` : ""}${tr("estop.scope")}`}
          data-testid="emergency-stop-button"
        >
          <OctagonX className="size-3.5 shrink-0" aria-hidden />
          <span className="hidden sm:inline">{stopping ? tr("estop.stoppingShort") : tr("autonomy.emergency")}</span>
        </Button>
      )}
      <span id="emergency-stop-hint" className="sr-only">{tr("estop.scope")}</span>
      {state.stopFailed && !active && (
        <span role="alert" className="max-w-[14rem] truncate text-xs font-medium text-danger" title={state.error ?? undefined} data-testid="emergency-stop-failed">
          {tr("estop.failedShort")}
        </span>
      )}
    </div>
  );
}

/** Title-bar "Needs you" indicator. The count is the same number the rail badge and the page use. */
export function AttentionIndicator({ count, current, onOpen }: { count: number; current: boolean; onOpen: () => void }) {
  useUILocale();
  const label = count > 0 ? tr("estop.attentionSome", { count }) : tr("estop.attentionNone");
  return (
    <Button
      type="button"
      size="sm"
      variant={current ? "secondary" : "ghost"}
      className="relative h-8 min-h-8 gap-1.5 px-2"
      onClick={onOpen}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      title={label}
      data-testid="header-attention"
      data-count={count}
    >
      <Inbox className="size-4 shrink-0" aria-hidden />
      {count > 0 && (
        <span className="min-w-5 rounded-full bg-warning/15 px-1.5 text-center text-[11px] font-semibold tabular-nums text-foreground ring-1 ring-warning/60" aria-hidden data-testid="header-attention-badge">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Button>
  );
}
