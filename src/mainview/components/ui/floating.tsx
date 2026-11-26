import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * Anchored, viewport-fixed position for a floating layer that is portaled to
 * <body> (FO-PM01-UXFIX01).
 *
 * Why a portal: a popover rendered inside the top bar (or any scrolling /
 * clipping / transformed ancestor) is cut off by that ancestor's `overflow` and
 * can only ever stack inside its stacking context. The usage popovers of the top
 * bar lived inside `<header class="overflow-x-auto">`: `overflow-x: auto` turns
 * `overflow-y` into `auto` too, so the 127px popover was clipped to the 40px bar
 * and what remained looked like it was "under" the page. Mounted on <body> with
 * `position: fixed` and `z-popover`, it is above every page, panel and dialog.
 *
 * The position is measured from the anchor, clamped to the viewport, flipped
 * above the anchor when there is no room below, and re-measured on resize and on
 * any scroll (capture, so scrolling containers count).
 */
export const FLOATING_MARGIN = 8;

export interface FloatingBox {
  top: number;
  left: number;
  maxHeight: number;
}

/** Pure placement: below the anchor, left-aligned, flipped/clamped into the viewport. */
export function placeFloating(
  anchor: { left: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 4,
): FloatingBox {
  const room = FLOATING_MARGIN;
  const left = Math.max(room, Math.min(anchor.left, viewport.width - size.width - room));
  const below = viewport.height - anchor.bottom - gap - room;
  const above = anchor.top - gap - room;
  const flip = size.height > below && above > below;
  const maxHeight = Math.max(96, flip ? above : below);
  const height = Math.min(size.height, maxHeight);
  const top = flip ? anchor.top - gap - height : anchor.bottom + gap;
  return { top: Math.max(room, top), left, maxHeight };
}

export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, width, visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = layerRef.current?.offsetHeight ?? 0;
      const box = placeFloating(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight });
      setStyle({ position: "fixed", top: box.top, left: box.left, width, maxHeight: box.maxHeight, overflowY: "auto" });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Content (meters, refresh state) can change the height while open.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (layerRef.current) observer?.observe(layerRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [anchorRef, layerRef, open, width]);
  return style;
}
