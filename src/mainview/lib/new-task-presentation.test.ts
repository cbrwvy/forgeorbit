import { expect, test } from "bun:test";
import { isNewTaskShortcut, NEW_TASK_PINNED_KEY, readNewTaskPinned, writeNewTaskPinned } from "./new-task-presentation";

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[NEW_TASK_PINNED_KEY, initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

test("the sheet is the default; only an explicit 1 pins the panel", () => {
  expect(readNewTaskPinned(memory())).toBe(false);
  expect(readNewTaskPinned(memory("0"))).toBe(false);
  expect(readNewTaskPinned(memory("true"))).toBe(false);
  expect(readNewTaskPinned(memory("1"))).toBe(true);
  expect(readNewTaskPinned(null)).toBe(false);
});

test("a throwing storage reads as the default and never throws on write", () => {
  const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  expect(readNewTaskPinned(throwing)).toBe(false);
  expect(() => writeNewTaskPinned(true, throwing)).not.toThrow();
  const m = memory();
  writeNewTaskPinned(true, m);
  expect(m.data.get(NEW_TASK_PINNED_KEY)).toBe("1");
  writeNewTaskPinned(false, m);
  expect(readNewTaskPinned(m)).toBe(false);
});

test("⌘N and Ctrl+N open New task; chords with Shift or Alt do not", () => {
  const k = (over: object) => ({ key: "n", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });
  expect(isNewTaskShortcut(k({ metaKey: true }))).toBe(true);
  expect(isNewTaskShortcut(k({ ctrlKey: true, key: "N" }))).toBe(true);
  expect(isNewTaskShortcut(k({}))).toBe(false);
  expect(isNewTaskShortcut(k({ metaKey: true, shiftKey: true }))).toBe(false);
  expect(isNewTaskShortcut(k({ metaKey: true, altKey: true }))).toBe(false);
  expect(isNewTaskShortcut(k({ metaKey: true, key: "m" }))).toBe(false);
});
