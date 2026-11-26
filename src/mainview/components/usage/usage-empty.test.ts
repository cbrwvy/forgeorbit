import { describe, expect, test } from "bun:test";
import { hasRecordedActivity } from "./UsageAnalyticsPage";

type Input = Parameters<typeof hasRecordedActivity>[0];
const make = (counts: Partial<Record<"created" | "started" | "completed" | "running" | "blocked", number>> = {}, usage: Partial<Input["usage"]> = {}): Input =>
  ({
    company: { counts: { created: 0, started: 0, completed: 0, running: 0, blocked: 0, ...counts } },
    usage: { costTotals: [], unknownCostRuns: 0, subscriptionRuns: 0, ...usage },
  }) as unknown as Input;

describe("hasRecordedActivity", () => {
  test("nothing recorded is no activity, never zero usage", () => {
    expect(hasRecordedActivity(make())).toBe(false);
  });
  test("any task count counts as activity", () => {
    for (const key of ["created", "started", "completed", "running", "blocked"] as const) {
      expect(hasRecordedActivity(make({ [key]: 1 }))).toBe(true);
    }
  });
  test("a run with an unknown cost or a subscription is activity", () => {
    expect(hasRecordedActivity(make({}, { unknownCostRuns: 2 }))).toBe(true);
    expect(hasRecordedActivity(make({}, { subscriptionRuns: 1 }))).toBe(true);
  });
});
