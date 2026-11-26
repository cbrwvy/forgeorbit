/**
 * Scroll `el` into view by moving ONLY `root`'s own scroll position.
 * `Element.scrollIntoView` also scrolls every scrollable ancestor, and an
 * `overflow: hidden` dialog panel is still programmatically scrollable — so it
 * used to push the Settings header, search and close button out of view
 * (observed in the packaged WKWebView, FO-UX-SIMPLIFY02-M8).
 */
export function scrollOffsetWithin(
  rootTop: number,
  rootBottom: number,
  elTop: number,
  elBottom: number,
  position: "start" | "nearest",
): number {
  if (position === "start") return elTop - rootTop;
  if (elTop < rootTop) return elTop - rootTop;
  if (elBottom > rootBottom) return Math.min(elBottom - rootBottom, elTop - rootTop);
  return 0;
}

export function scrollWithin(root: HTMLElement, el: HTMLElement, position: "start" | "nearest"): void {
  const r = root.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  const delta = scrollOffsetWithin(r.top, r.bottom, t.top, t.bottom, position);
  if (delta !== 0) root.scrollTo({ top: root.scrollTop + delta });
}
