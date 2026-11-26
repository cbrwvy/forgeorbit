/** Shared tab order for dialogs and the page.
 *  WKWebView follows the macOS text-field Tab preference and skips buttons.
 *  The page walker uses this list so the rail, Emergency Stop and other
 *  controls stay reachable without changing that system setting. Dialogs keep
 *  the original filter: they already trap Tab themselves. */

export const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  // A <details> disclosure's toggle is focusable without a tabindex.
  "details > summary:first-of-type",
].join(",");

/** A form control disabled by an ancestor `<fieldset disabled>` carries no
 *  `disabled` attribute of its own, so the selector alone would trap focus
 *  onto it. `:disabled` is the browser's own answer, and it already exempts
 *  controls in the fieldset's first `<legend>`. */
export function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) =>
    !el.matches(":disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== "hidden",
  );
}

/** A modal or an open popover already decides what Tab does. */
export function tabLayerOwnsTab(root: ParentNode = document): boolean {
  return root.querySelector('[role="dialog"][aria-modal="true"], [data-popover-open]') != null;
}

/** The next visible control in DOM order, wrapping at either end. */
export function nextTabbable(root: ParentNode, backwards: boolean): HTMLElement | null {
  const items = tabbables(root);
  if (items.length === 0) return null;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const index = active ? items.indexOf(active) : -1;
  if (index < 0) return items[backwards ? items.length - 1 : 0] ?? null;
  return items[(index + (backwards ? -1 : 1) + items.length) % items.length] ?? null;
}
