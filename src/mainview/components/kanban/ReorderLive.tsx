import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useReorderAnnouncement, useReorderHint } from "@/lib/board-dnd";

/** The floating "same urgency only" hint (only while a drag is outside its group) and the keyboard-move live region. */
export function ReorderLive() {
  useUILocale();
  const hint = useReorderHint();
  const announcement = useReorderAnnouncement();
  return (
    <>
      <div role="status" aria-live="polite" className="sr-only" data-testid="reorder-announcement">{announcement?.text ?? ""}</div>
      {hint && (
        <div
          role="tooltip"
          data-testid="reorder-constraint-hint"
          className="pointer-events-none fixed z-[70] max-w-[16rem] rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-md"
          style={{ left: Math.min(hint.x + 14, window.innerWidth - 270), top: hint.y + 14 }}
        >
          {tr("kanban.order.constrained")}
        </div>
      )}
    </>
  );
}
