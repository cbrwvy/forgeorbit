import { expect, test } from "bun:test";

import { canTransition, transitionRefusal } from "./state.ts";

test("start, stop, failure, and recovery transitions follow the table", () => {
  expect(canTransition("stopped", "starting")).toBe(true);
  expect(canTransition("starting", "running")).toBe(true);
  expect(canTransition("starting", "error")).toBe(true);
  expect(canTransition("running", "degraded")).toBe(true);
  expect(canTransition("running", "stopping")).toBe(true);
  expect(canTransition("stopping", "stopped")).toBe(true);
  expect(canTransition("stopping", "error")).toBe(true);
  expect(canTransition("error", "starting")).toBe(true);
  expect(canTransition("running", "unknown")).toBe(true);
  expect(canTransition("unknown", "running")).toBe(true);
  expect(canTransition("unknown", "stopped")).toBe(true);
});

test("a second start is not a transition out of running, and unknown cannot stop without proof", () => {
  expect(canTransition("running", "starting")).toBe(false);
  expect(canTransition("running", "running")).toBe(false);
  expect(canTransition("stopped", "stopped")).toBe(false);
  expect(canTransition("unknown", "stopping")).toBe(false);
  expect(canTransition("unknown", "stopping", { provenOwnership: true })).toBe(true);
  expect(transitionRefusal("unknown", "stopping")).toContain("not proven");
  expect(transitionRefusal("stopped", "error")).toContain("cannot transition");
});
