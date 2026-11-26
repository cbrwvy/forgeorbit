import { closestCenter, pointerWithin, type CollisionDetection } from "@dnd-kit/core";
import { useSyncExternalStore } from "react";
import { COLUMNS } from "../../shared/types.ts";

const COLUMN_IDS = new Set<string>(COLUMNS.map((c) => c.id));

interface CardData { column?: string; urgency?: number }

/**
 * Collision detection for the board. While the pointer is inside the card's own column the only candidates are the
 * cards of the SAME urgency group, so the destination (and the preview that follows it) is always the nearest legal
 * position: dragging toward the top of the column resolves to the first place of the card's own urgency, toward the
 * bottom to the last. Over another column the target is that column (the existing status drop, unchanged).
 */
export const boardCollisionDetection: CollisionDetection = (args) => {
  const active = args.active.data.current as CardData | undefined;
  const columns = args.droppableContainers.filter((c) => COLUMN_IDS.has(String(c.id)));
  const inside = pointerWithin({ ...args, droppableContainers: columns })[0] ?? closestCenter({ ...args, droppableContainers: columns })[0];
  const overColumn = inside ? String(inside.id) : active?.column ?? "";
  if (!active?.column || overColumn !== active.column) return overColumn ? [{ id: overColumn }] : [];
  const siblings = args.droppableContainers.filter((c) => {
    if (COLUMN_IDS.has(String(c.id))) return false;
    const data = c.data.current as CardData | undefined;
    return data?.column === active.column && data?.urgency === active.urgency;
  });
  if (siblings.length === 0) return [{ id: overColumn }];
  return closestCenter({ ...args, droppableContainers: siblings });
};

/** The union rectangle of the cards of one (column, urgency) group, read from the DOM. */
export function groupBounds(column: string, urgency: number): { left: number; right: number; top: number; bottom: number } | null {
  const cards = document.querySelectorAll<HTMLElement>(`[data-testid="task-card"][data-column="${column}"][data-urgency="${urgency}"]`);
  if (cards.length === 0) return null;
  let box: { left: number; right: number; top: number; bottom: number } | null = null;
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    box = box ? { left: Math.min(box.left, r.left), right: Math.max(box.right, r.right), top: Math.min(box.top, r.top), bottom: Math.max(box.bottom, r.bottom) } : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  return box;
}

/** True when a pointer in the card's own column has left the vertical span the group had when the drag began. */
export function pointerOutsideBounds(point: { x: number; y: number }, box: { left: number; right: number; top: number; bottom: number } | null, slack = 10): boolean {
  if (!box) return false;
  const inColumnHorizontally = point.x >= box.left - 24 && point.x <= box.right + 24;
  return inColumnHorizontally && (point.y < box.top - slack || point.y > box.bottom + slack);
}

/* A one-line hint near the pointer, shown only while a drag is outside its urgency group. */
type Hint = { x: number; y: number } | null;
let hint: Hint = null;
const listeners = new Set<() => void>();
export const reorderHint = {
  set(next: Hint) {
    if (next === null && hint === null) return;
    hint = next;
    for (const listener of listeners) listener();
  },
};
export function useReorderHint(): Hint {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => hint, () => null);
}

/** A polite screen-reader announcement for keyboard reordering. */
type Announcement = { text: string; at: number } | null;
let announcement: Announcement = null;
const announcers = new Set<() => void>();
export const announceReorder = (text: string): void => { announcement = { text, at: Date.now() }; for (const l of announcers) l(); };
export function useReorderAnnouncement(): Announcement {
  return useSyncExternalStore((cb) => { announcers.add(cb); return () => { announcers.delete(cb); }; }, () => announcement, () => null);
}
