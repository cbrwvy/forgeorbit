import { describe, expect, test } from "bun:test";
import {
  buildCompletionOccurrenceKey,
  buildScheduledOccurrenceKey,
  computeCompletionNextDueUtc,
  computeFirstDueUtc,
  computeNextNominalUtc,
  formatOccurrenceTitle,
  formatRecurrenceSummary,
  planDueOccurrences,
  validateRecurringPolicies,
  validateScheduleConfig,
} from "./recurring-tasks.ts";

describe("FO-KANBAN-RECURRING01 shared UTC recurrence engine", () => {
  test("daily recurrence calculates exact UTC timestamps across month/year boundaries", () => {
    const res = validateScheduleConfig({
      recurrenceType: "daily",
      startDateUtc: "2026-12-31",
      startTimeUtc: "06:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const first = computeFirstDueUtc(res.value);
    expect(first).toBe("2026-12-31T06:00:00.000Z");
    const second = computeNextNominalUtc(res.value, Date.parse(first!), { inclusive: false });
    expect(second).toBe("2027-01-01T06:00:00.000Z");
  });

  test("weekdays skips Saturday and Sunday in UTC", () => {
    const res = validateScheduleConfig({
      recurrenceType: "weekdays",
      startDateUtc: "2026-11-27", // Friday
      startTimeUtc: "09:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fri = computeFirstDueUtc(res.value);
    expect(fri).toBe("2026-11-27T09:00:00.000Z");
    const mon = computeNextNominalUtc(res.value, Date.parse(fri!), { inclusive: false });
    expect(mon).toBe("2026-11-30T09:00:00.000Z");
  });

  test("weekly with multiple weekdays (Monday & Friday) picks exact matching days", () => {
    const res = validateScheduleConfig({
      recurrenceType: "weekly",
      weekdays: [5, 1], // unsorted input -> normalized [1, 5]
      startDateUtc: "2026-11-25", // Wednesday
      startTimeUtc: "03:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.weekdays).toEqual([1, 5]);
    const first = computeFirstDueUtc(res.value);
    expect(first).toBe("2026-11-27T03:00:00.000Z"); // Friday
    const second = computeNextNominalUtc(res.value, Date.parse(first!), { inclusive: false });
    expect(second).toBe("2026-11-30T03:00:00.000Z"); // Monday
    const third = computeNextNominalUtc(res.value, Date.parse(second!), { inclusive: false });
    expect(third).toBe("2026-12-04T03:00:00.000Z"); // Friday
  });

  test("biweekly preserves anchor parity across weeks and year boundaries", () => {
    const res = validateScheduleConfig({
      recurrenceType: "biweekly",
      weekdays: [1, 4], // Mon & Thu
      startDateUtc: "2026-12-21", // Monday (anchor ISO week)
      startTimeUtc: "08:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d1 = computeFirstDueUtc(res.value);
    expect(d1).toBe("2026-12-21T08:00:00.000Z"); // Mon week 0
    const d2 = computeNextNominalUtc(res.value, Date.parse(d1!), { inclusive: false });
    expect(d2).toBe("2026-12-24T08:00:00.000Z"); // Thu week 0
    const d3 = computeNextNominalUtc(res.value, Date.parse(d2!), { inclusive: false });
    expect(d3).toBe("2027-01-04T08:00:00.000Z"); // Mon week 2 (skips Dec 28/31!)
  });

  test("monthly day 31 skips nonexistent dates by default (never overflows Feb into March)", () => {
    const res = validateScheduleConfig({
      recurrenceType: "monthly",
      monthlyMode: "day_of_month",
      dayOfMonth: 31,
      missingDayPolicy: "skip",
      startDateUtc: "2026-01-31",
      startTimeUtc: "04:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const jan = computeFirstDueUtc(res.value);
    expect(jan).toBe("2026-01-31T04:00:00.000Z");
    const mar = computeNextNominalUtc(res.value, Date.parse(jan!), { inclusive: false });
    expect(mar).toBe("2026-03-31T04:00:00.000Z"); // February skipped, not Mar 2/3!
    const may = computeNextNominalUtc(res.value, Date.parse(mar!), { inclusive: false });
    expect(may).toBe("2026-05-31T04:00:00.000Z"); // April skipped
  });

  test("monthly last_day and missingDayPolicy=last_day hit Feb 28/29 and Apr 30 accurately", () => {
    const res = validateScheduleConfig({
      recurrenceType: "monthly",
      monthlyMode: "last_day",
      startDateUtc: "2028-01-15", // 2028 is a leap year
      startTimeUtc: "22:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const jan = computeFirstDueUtc(res.value);
    expect(jan).toBe("2028-01-31T22:00:00.000Z");
    const feb = computeNextNominalUtc(res.value, Date.parse(jan!), { inclusive: false });
    expect(feb).toBe("2028-02-29T22:00:00.000Z"); // Leap Feb 29
    const mar = computeNextNominalUtc(res.value, Date.parse(feb!), { inclusive: false });
    expect(mar).toBe("2028-03-31T22:00:00.000Z");
    const apr = computeNextNominalUtc(res.value, Date.parse(mar!), { inclusive: false });
    expect(apr).toBe("2028-04-30T22:00:00.000Z");
  });

  test("yearly Feb 29 respects leap years (skip vs last_day)", () => {
    const skipRes = validateScheduleConfig({
      recurrenceType: "yearly",
      dayOfMonth: 29,
      missingDayPolicy: "skip",
      startDateUtc: "2028-02-29",
      startTimeUtc: "00:00",
    });
    expect(skipRes.ok).toBe(true);
    if (!skipRes.ok) return;
    const y2028 = computeFirstDueUtc(skipRes.value);
    expect(y2028).toBe("2028-02-29T00:00:00.000Z");
    const y2032 = computeNextNominalUtc(skipRes.value, Date.parse(y2028!), { inclusive: false });
    expect(y2032).toBe("2032-02-29T00:00:00.000Z");

    const lastDayRes = validateScheduleConfig({
      recurrenceType: "yearly",
      dayOfMonth: 29,
      missingDayPolicy: "last_day",
      startDateUtc: "2028-02-29",
      startTimeUtc: "00:00",
    });
    expect(lastDayRes.ok).toBe(true);
    if (!lastDayRes.ok) return;
    const y2029 = computeNextNominalUtc(lastDayRes.value, Date.parse("2028-02-29T00:00:00.000Z"), { inclusive: false });
    expect(y2029).toBe("2029-02-28T00:00:00.000Z");
  });

  test("quarterly recurrence advances every 3 months cleanly", () => {
    const res = validateScheduleConfig({
      recurrenceType: "quarterly",
      monthlyMode: "day_of_month",
      dayOfMonth: 15,
      startDateUtc: "2026-01-15",
      startTimeUtc: "05:00",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q1 = computeFirstDueUtc(res.value);
    const q2 = computeNextNominalUtc(res.value, Date.parse(q1!), { inclusive: false });
    const q3 = computeNextNominalUtc(res.value, Date.parse(q2!), { inclusive: false });
    const q4 = computeNextNominalUtc(res.value, Date.parse(q3!), { inclusive: false });
    const nextQ1 = computeNextNominalUtc(res.value, Date.parse(q4!), { inclusive: false });
    expect([q1, q2, q3, q4, nextQ1]).toEqual([
      "2026-01-15T05:00:00.000Z",
      "2026-04-15T05:00:00.000Z",
      "2026-07-15T05:00:00.000Z",
      "2026-10-15T05:00:00.000Z",
      "2027-01-15T05:00:00.000Z",
    ]);
  });

  test("custom interval validates bounds and rejects zero, negative, non-integer, and excessive intervals", () => {
    expect(
      validateScheduleConfig({
        recurrenceType: "custom_interval",
        interval: 0,
        intervalUnit: "hours",
        startDateUtc: "2026-11-26",
        startTimeUtc: "00:00",
      }).ok,
    ).toBe(false);
    expect(
      validateScheduleConfig({
        recurrenceType: "custom_interval",
        interval: -3,
        intervalUnit: "days",
        startDateUtc: "2026-11-26",
        startTimeUtc: "00:00",
      }).ok,
    ).toBe(false);
    expect(
      validateScheduleConfig({
        recurrenceType: "custom_interval",
        interval: 1.5,
        intervalUnit: "hours",
        startDateUtc: "2026-11-26",
        startTimeUtc: "00:00",
      }).ok,
    ).toBe(false);
    expect(
      validateScheduleConfig({
        recurrenceType: "custom_interval",
        interval: 99999,
        intervalUnit: "hours",
        startDateUtc: "2026-11-26",
        startTimeUtc: "00:00",
      }).ok,
    ).toBe(false);
    expect(validateRecurringPolicies({ catchUpLimit: 0 }).ok).toBe(false);
    expect(validateRecurringPolicies({ catchUpLimit: 11 }).ok).toBe(false);

    const ok6h = validateScheduleConfig({
      recurrenceType: "custom_interval",
      interval: 6,
      intervalUnit: "hours",
      startDateUtc: "2026-11-26",
      startTimeUtc: "00:00",
    });
    expect(ok6h.ok).toBe(true);
    if (!ok6h.ok) return;
    expect(computeNextNominalUtc(ok6h.value, Date.parse("2026-11-26T00:00:00.000Z"), { inclusive: false })).toBe(
      "2026-11-26T06:00:00.000Z",
    );
  });

  test("completion-relative recurrence schedules next due from completion timestamp and enforces endDate/maxOccurrences", () => {
    const res = validateScheduleConfig({
      recurrenceType: "after_completion",
      interval: 24,
      intervalUnit: "hours",
      startDateUtc: "2026-11-26",
      startTimeUtc: "06:00",
      endDateUtc: "2026-11-29",
      maxOccurrences: 3,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(computeCompletionNextDueUtc(res.value, Date.parse("2026-11-26T07:30:00.000Z"), 1)).toBe(
      "2026-11-27T07:30:00.000Z",
    );
    expect(computeCompletionNextDueUtc(res.value, Date.parse("2026-11-29T10:00:00.000Z"), 2)).toBeNull(); // past endDateUtc
    expect(computeCompletionNextDueUtc(res.value, Date.parse("2026-11-27T07:30:00.000Z"), 3)).toBeNull(); // hit maxOccurrences
  });

  test("missed occurrence planning: skip, run_once, and bounded catch_up across multi-day downtime", () => {
    const sched = validateScheduleConfig({
      recurrenceType: "daily",
      startDateUtc: "2026-11-01",
      startTimeUtc: "06:00",
    });
    expect(sched.ok).toBe(true);
    if (!sched.ok) return;
    const nowMs = Date.parse("2026-11-06T12:00:00.000Z"); // 6 missed daily slots (Nov 1..6)

    const skipPlan = planDueOccurrences({
      schedule: sched.value,
      nextDueUtc: "2026-11-01T06:00:00.000Z",
      nowMs,
      missedPolicy: "skip",
      catchUpLimit: 3,
      generatedCountSoFar: 0,
    });
    expect(skipPlan.toGenerate).toEqual([]);
    expect(skipPlan.skipped.length).toBe(6);
    expect(skipPlan.nextDueUtc).toBe("2026-11-07T06:00:00.000Z");

    const runOncePlan = planDueOccurrences({
      schedule: sched.value,
      nextDueUtc: "2026-11-01T06:00:00.000Z",
      nowMs,
      missedPolicy: "run_once",
      catchUpLimit: 3,
      generatedCountSoFar: 0,
    });
    expect(runOncePlan.toGenerate).toEqual(["2026-11-06T06:00:00.000Z"]);
    expect(runOncePlan.skipped.length).toBe(5);
    expect(runOncePlan.nextDueUtc).toBe("2026-11-07T06:00:00.000Z");

    const catchUpPlan = planDueOccurrences({
      schedule: sched.value,
      nextDueUtc: "2026-11-01T06:00:00.000Z",
      nowMs,
      missedPolicy: "catch_up",
      catchUpLimit: 2,
      generatedCountSoFar: 0,
    });
    expect(catchUpPlan.toGenerate).toEqual(["2026-11-05T06:00:00.000Z", "2026-11-06T06:00:00.000Z"]);
    expect(catchUpPlan.skipped.length).toBe(4);
    expect(catchUpPlan.nextDueUtc).toBe("2026-11-07T06:00:00.000Z");
  });

  test("human-readable EN/RU recurrence labels, occurrence titles, and deterministic occurrence keys", () => {
    const mon = validateScheduleConfig({
      recurrenceType: "weekly",
      weekdays: [1],
      startDateUtc: "2026-11-16",
      startTimeUtc: "03:00",
    });
    expect(mon.ok).toBe(true);
    if (!mon.ok) return;
    expect(formatRecurrenceSummary(mon.value, "en")).toBe("Every Monday, 03:00 UTC");
    expect(formatRecurrenceSummary(mon.value, "ru")).toBe("Каждый понедельник, 03:00 UTC");
    expect(formatOccurrenceTitle("Security audit", "2026-11-16T03:00:00.000Z", mon.value)).toBe(
      "Security audit — November 16",
    );

    const h6 = validateScheduleConfig({
      recurrenceType: "custom_interval",
      interval: 6,
      intervalUnit: "hours",
      startDateUtc: "2026-11-16",
      startTimeUtc: "00:00",
    });
    expect(h6.ok).toBe(true);
    if (!h6.ok) return;
    expect(formatRecurrenceSummary(h6.value, "en")).toBe("Every 6 hours");
    expect(formatRecurrenceSummary(h6.value, "ru")).toBe("Каждые 6 часов");

    const after = validateScheduleConfig({
      recurrenceType: "after_completion",
      interval: 24,
      intervalUnit: "hours",
      startDateUtc: "2026-11-16",
      startTimeUtc: "06:00",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(formatRecurrenceSummary(after.value, "en")).toBe("24 hours after completion");
    expect(formatRecurrenceSummary(after.value, "ru")).toBe("Через 24 часа после завершения");

    expect(buildScheduledOccurrenceKey("tpl-1", "2026-11-16T03:00:00.000Z")).toBe(
      "sched:tpl-1:2026-11-16T03:00:00.000Z",
    );
    expect(buildCompletionOccurrenceKey("tpl-1", "task-9", 2)).toBe("after:tpl-1:task-9:2");
  });
});
