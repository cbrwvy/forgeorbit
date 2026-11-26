import { expect, test } from "bun:test";
import { parseSupervisedRunLimit, stoppedReviewSummary, terminationState, type RunTermination } from "./run-termination.ts";

const base: RunTermination = {
  runId: "r", limitSeconds: null, deadlineAt: null, reason: null, requestedAt: null, attempts: 0, outcome: null,
  processId: null, methods: [], checkedAt: null, exitedAt: null, note: null,
};

test("no limit is the default: unset and blank add nothing", () => {
  expect(parseSupervisedRunLimit(undefined)).toEqual({ ok: true, seconds: null });
  expect(parseSupervisedRunLimit("")).toEqual({ ok: true, seconds: null });
  expect(parseSupervisedRunLimit("   ")).toEqual({ ok: true, seconds: null });
});

test("a limit is a whole number of seconds inside the bounds; anything else is an error, never a guess", () => {
  expect(parseSupervisedRunLimit("90")).toEqual({ ok: true, seconds: 90 });
  expect(parseSupervisedRunLimit(" 1 ")).toEqual({ ok: true, seconds: 1 });
  expect(parseSupervisedRunLimit("86400")).toEqual({ ok: true, seconds: 86400 });
  for (const bad of ["0", "86401", "-5", "1.5", "5m", "soon", "1e3", "0x10"]) {
    const parsed = parseSupervisedRunLimit(bad);
    expect(parsed.ok).toBe(false);
  }
});

test("a stop is only 'exited' when the core observed the exit; a request alone is 'stopping'", () => {
  expect(terminationState(null, "running")).toBeNull();
  expect(terminationState({ ...base, limitSeconds: 30 }, "running")).toBe("armed");
  expect(terminationState({ ...base, limitSeconds: 30 }, "succeeded")).toBeNull();
  const requested = { ...base, reason: "manual" as const, requestedAt: 1 };
  expect(terminationState(requested, "running")).toBe("stopping");
  expect(terminationState({ ...requested, outcome: "exited" }, "running")).toBe("exited");
  expect(terminationState({ ...requested, outcome: "no-process" }, "cancelled")).toBe("exited");
  expect(terminationState({ ...requested, outcome: "unconfirmed" }, "running")).toBe("unconfirmed");
  // Once the run settled, an unconfirmed stop is by definition over: the driver only settles after seeing the exit.
  expect(terminationState({ ...requested, outcome: "unconfirmed" }, "cancelled")).toBe("exited");
  expect(terminationState({ ...requested, outcome: "unverified" }, "cancelled")).toBe("not-reported");
  expect(terminationState({ ...requested, outcome: "recovered-alive" }, "orphaned")).toBe("recovered-alive");
});

test("a stopped review summary names the cause and the evidence, and never contains a verdict", () => {
  expect(stoppedReviewSummary(null, "cancelled")).toBeNull();
  expect(stoppedReviewSummary({ ...base, limitSeconds: 5 }, "cancelled")).toBeNull();
  const manual = stoppedReviewSummary({ ...base, reason: "manual", requestedAt: 1, outcome: "exited" }, "cancelled")!;
  expect(manual).toContain("stopped by the Owner");
  expect(manual).toContain("observed to exit");
  expect(manual).toContain("No verdict was recorded");
  const limit = stoppedReviewSummary({ ...base, reason: "time-limit", limitSeconds: 7, requestedAt: 1, outcome: "exited" }, "cancelled")!;
  expect(limit).toContain("time limit of 7 s");
  const unreported = stoppedReviewSummary({ ...base, reason: "manual", requestedAt: 1, outcome: "unverified" }, "cancelled")!;
  expect(unreported).toContain("exit was not verified");
  expect(unreported).not.toContain("observed to exit");
  const restart = stoppedReviewSummary({ ...base, reason: "manual", requestedAt: 1, outcome: "recovered-alive" }, "orphaned")!;
  expect(restart).toContain("still running");
  for (const text of [manual, limit, unreported, restart]) expect(text).not.toMatch(/\bPASS\b|CHANGES_REQUESTED/);
});
