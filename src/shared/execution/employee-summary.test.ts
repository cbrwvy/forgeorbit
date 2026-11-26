import { expect, test } from "bun:test";
import { summarizeEmployeeWork, type SummaryAttemptFact } from "./employee-summary.ts";

const fact = (over: Partial<SummaryAttemptFact> = {}): SummaryAttemptFact => ({
  attemptId: "a", taskId: "t", phase: "completed", startedAt: 1000, finishedAt: 4000,
  execution: "real-provider", cost: { kind: "reported-api", money: { amount: 1.5, currency: "USD" } },
  review: null, ownerAccepted: false, awaitingOwner: false, ...over,
});

test("cost is grouped by evidence category and currency, never summed across either", () => {
  const s = summarizeEmployeeWork("e", [
    fact(),
    fact({ attemptId: "b" }),
    fact({ attemptId: "c", cost: { kind: "reported-api", money: { amount: 2, currency: "EUR" } } }),
    fact({ attemptId: "d", cost: { kind: "calculated-api", money: { amount: 3, currency: "USD" } } }),
    fact({ attemptId: "s", cost: { kind: "subscription", money: null } }),
  ], [], false);
  expect(s.cost.lines).toEqual([
    { kind: "reported-api", currency: "USD", amount: 3, runs: 2 },
    { kind: "reported-api", currency: "EUR", amount: 2, runs: 1 },
    { kind: "calculated-api", currency: "USD", amount: 3, runs: 1 },
    { kind: "subscription", currency: null, amount: null, runs: 1 },
  ]);
  expect(s.cost.unknownRuns).toBe(0);
});

test("a fixture run or a run with no billing evidence is Unknown, not zero", () => {
  const s = summarizeEmployeeWork("e", [
    fact({ execution: "synthetic", cost: { kind: "reported-api", money: { amount: 9, currency: "USD" } } }),
    fact({ attemptId: "u", execution: null, cost: null }),
    fact({ attemptId: "k", cost: { kind: "unknown", money: null } }),
  ], [], false);
  expect(s.cost.lines).toEqual([]);
  expect(s.cost.unknownRuns).toBe(3);
  expect(s.cost.fixtureRuns).toBe(1);
});

test("time sums only runs with a recorded start and end and reports the rest", () => {
  const none = summarizeEmployeeWork("e", [fact({ finishedAt: null })], [], false);
  expect(none.time).toEqual({ totalMs: null, runsWithTime: 0, runsWithoutTime: 1 });
  const some = summarizeEmployeeWork("e", [fact(), fact({ attemptId: "b", finishedAt: null })], [], false);
  expect(some.time).toEqual({ totalMs: 3000, runsWithTime: 1, runsWithoutTime: 1 });
});

test("a QC PASS and the Owner's acceptance are separate counts; attempts that never started are not runs", () => {
  const pass = { status: "complete", verdict: "PASS", latestRound: true } as const;
  const s = summarizeEmployeeWork("e", [
    fact({ review: pass, ownerAccepted: true }),
    fact({ attemptId: "b", review: pass, awaitingOwner: true }),
    fact({ attemptId: "c", review: { status: "complete", verdict: "CHANGES_REQUESTED", latestRound: true } }),
    fact({ attemptId: "d", phase: "not-started", startedAt: null, finishedAt: null, execution: null, cost: null }),
    fact({ attemptId: "e", phase: "expired", startedAt: null, finishedAt: null, execution: null, cost: null }),
  ], [], false);
  expect(s).toMatchObject({ runsStarted: 3, notStarted: 2, ownerAccepted: 1, awaitingOwner: 1, quality: null });
  expect(s.review).toMatchObject({ passed: 2, changesRequested: 1, notReviewed: 0 });
});

test("an employee with no attempts summarizes to empty facts", () => {
  const s = summarizeEmployeeWork("e", [], [], false);
  expect(s).toMatchObject({ runsStarted: 0, time: { totalMs: null }, cost: { lines: [], unknownRuns: 0, fixtureRuns: 0 }, quality: null });
});
