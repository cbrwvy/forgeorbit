import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAnchoredPosition } from "@/components/ui/floating";
import { cn } from "@/lib/utils";
import { clampPercent, formatResetsIn, formatUpdatedAgo, tierColorVar, warnTier } from "@/lib/usage";
import type { HarnessQuota } from "../../../shared/types.ts";

interface Props {
  /** The harness's latest usage snapshot, or `null` when none exists yet
   *  (unsupported kind, or first poll still pending) — the popover then
   *  renders `placeholder` guidance instead of meters. */
  quota: HarnessQuota | null;
  harnessLabel: string;
  children: ReactNode;
  onRefresh: () => Promise<void>;
  /** Guidance shown when `quota` is null: why there's no data and whether a
   *  manual Refresh could produce some (`canRefresh` gates the button). */
  placeholder?: { message: string; canRefresh: boolean };
}

// Same explicit map as UsageMeter — dynamic `bg-${token}` strings don't
// survive Tailwind's JIT scan.
const FILL_CLASS: Record<"success" | "warning" | "danger", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * Click-toggled popover for a topbar harness chip: lists every meter the
 * provider reported (bar, percent, reset time), the plan type, a
 * "last updated" label, and a manual Refresh button. Open/close/outside-click
 * /Escape mechanics mirror `components/ui/info-tip.tsx`.
 *
 * `bg-popover`/`text-popover-foreground` are NOT defined in either
 * `index.css` or `tailwind.config.js` (checked at implementation time) — this
 * uses `bg-card`/`text-card-foreground` instead, which are.
 */
export function UsagePopover({ quota, harnessLabel, children, onRefresh, placeholder }: Props) {
  useUILocale();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const position = useAnchoredPosition(rootRef, layerRef, open, 256);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The layer is portaled to <body>, so it is outside rootRef.
      if (!rootRef.current?.contains(target) && !layerRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // The layer lives on <body>; hand focus back to the chip that opened it.
        if (layerRef.current?.contains(document.activeElement) || document.activeElement === document.body) triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The layer is portaled, so Tab from the chip would not reach it: move focus in on
  // open, and close (returning to the chip) when Tab would leave it.
  useEffect(() => {
    if (open) layerRef.current?.focus();
  }, [open]);
  const onLayerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = Array.from(layerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
    const active = document.activeElement;
    const leavingForward = !e.shiftKey && (items.length === 0 || active === items[items.length - 1]);
    const leavingBackward = e.shiftKey && (active === layerRef.current || active === items[0]);
    if (leavingForward || leavingBackward) {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // Best-effort — the parent's usage state is otherwise kept current via
      // the `harness_usage` SSE broadcast, so a failed manual refresh here
      // isn't fatal.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div ref={rootRef} className="electrobun-webkit-app-region-no-drag relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        title={tr("common.usage", { p0: String(harnessLabel) })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="m-0 inline-flex cursor-pointer items-center rounded border-0 bg-transparent p-0 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ font: "inherit" }}
      >
        {children}
      </button>

      {open && createPortal(
        <div
          ref={layerRef}
          role="dialog"
          aria-label={tr("common.usage", { p0: String(harnessLabel) })}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          tabIndex={-1}
          onKeyDown={onLayerKeyDown}
          style={position}
          className="electrobun-webkit-app-region-no-drag glass-floating z-popover rounded-xl border p-3 text-xs text-card-foreground shadow-xl outline-none"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{harnessLabel}</span>
            {quota?.planType && <span className="text-muted-foreground">{quota.planType}</span>}
          </div>

          {quota === null ? (
            <div className="mt-2 text-muted-foreground">
              {placeholder?.message ?? tr("common.no_usage_data")}
            </div>
          ) : quota.meters.length === 0 ? (
            <div className="mt-2 text-muted-foreground">{quota.reason ?? tr("common.no_usage_data")}</div>
          ) : (
            <div className="mt-2 space-y-2.5">
              {quota.meters.map((m) => {
                const tier = warnTier(m.usedPercent);
                const fillClass = FILL_CLASS[tierColorVar(tier)];
                const resets = formatResetsIn(m.resetsAtMs, Date.now());
                return (
                  <div key={m.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {m.label}
                        {m.scope && <span className="text-muted-foreground"> · {m.scope}</span>}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{Math.round(m.usedPercent)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", fillClass)}
                        style={{ width: `${clampPercent(m.usedPercent)}%` }}
                      />
                    </div>
                    {resets && <div className="mt-0.5 text-muted-foreground">{resets}</div>}
                  </div>
                );
              })}
            </div>
          )}

          {(quota !== null || placeholder?.canRefresh) && (
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2">
              <span className="text-muted-foreground">
                {quota !== null ? formatUpdatedAgo(quota.fetchedAtMs, Date.now()) : ""}
              </span>
              {(quota !== null || placeholder?.canRefresh) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={refreshing}
                  aria-label={tr("projects.refresh_usage")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleRefresh();
                  }}
                >
                  <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
                </Button>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
