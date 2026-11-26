/**
 * How "New task" is presented (FO-UX02-D stage 1): a sheet opened by ⌘N and the
 * "New task" buttons (default), or the pinned side panel the app used to always
 * show. Pure webview chrome, so localStorage like `panel-collapse.ts` and
 * `density.ts`: it must resolve synchronously in the first render, and a
 * throwing storage must never break the shell.
 */
import { useSyncExternalStore } from "react";

export const NEW_TASK_PINNED_KEY = "agetor:newTaskPinned";
const CHANGE_EVENT = "agetor:new-task-pinned-change";

type PinStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PinStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Only an explicit "1" pins the panel; a missing or junk value is the sheet default. */
export function readNewTaskPinned(storage: PinStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(NEW_TASK_PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNewTaskPinned(pinned: boolean, storage: PinStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(NEW_TASK_PINNED_KEY, pinned ? "1" : "0");
  } catch {
    /* best effort */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Live value shared by App (what to render) and Settings (the toggle). */
export function useNewTaskPinned(): boolean {
  return useSyncExternalStore(subscribe, () => readNewTaskPinned(), () => false);
}

/** ⌘N / Ctrl+N, without Shift/Alt (those belong to other chords). */
export function isNewTaskShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n";
}
