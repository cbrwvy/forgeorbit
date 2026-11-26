import { useEffect } from "react";
import { nextTabbable, tabLayerOwnsTab } from "@/lib/tab-order";

function focusControl(el: HTMLElement) {
  try {
    (el.focus as (options?: { preventScroll?: boolean; focusVisible?: boolean }) => void)({
      preventScroll: false,
      focusVisible: true,
    });
  } catch {
    el.focus();
  }
}

/** Page-level Tab order. Runs after the focused control's own key handler,
 *  so a dialog, menu, autocomplete or skill field that already handled Tab
 *  is left alone. A terminal keeps Tab. Everywhere else, Tab moves through
 *  buttons as well as text fields. */
export function KeyboardTabOrder() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.defaultPrevented || tabLayerOwnsTab()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".xterm")) return;
      const next = nextTabbable(document.body, event.shiftKey);
      if (!next || next === document.activeElement) return;
      event.preventDefault();
      focusControl(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
