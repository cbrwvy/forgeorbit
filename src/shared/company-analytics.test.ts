import { expect, test } from "bun:test";
import { bucketKey, comparisonLabel, csvCell, rangeBounds, startOfZonedDay, toCsv } from "./company-analytics.ts";

test("calendar presets use the owner timezone and leave instants canonical", () => {
  const noonUtc = Date.UTC(2026, 10, 11, 12, 0, 0);
  const utc = rangeBounds("today", noonUtc, "UTC");
  expect(utc).toEqual({ from: Date.UTC(2026, 10, 11), until: Date.UTC(2026, 10, 12) });
  const yek = rangeBounds("today", noonUtc, "Asia/Yekaterinburg");
  expect(yek.from).toBe(Date.UTC(2026, 10, 10, 19));
  expect(yek.until! - yek.from!).toBe(86_400_000);
  expect(startOfZonedDay(Date.UTC(2026, 10, 11, 18, 30), "America/New_York")).toBe(Date.UTC(2026, 10, 11, 5));
  const month = rangeBounds("month", noonUtc, "UTC");
  expect(month).toEqual({ from: Date.UTC(2026, 10, 1), until: Date.UTC(2026, 11, 1) });
  expect(rangeBounds("all", noonUtc, "UTC")).toEqual({});
});

test("day, week and month buckets follow the timezone", () => {
  const instant = Date.UTC(2026, 10, 11, 20);
  expect(bucketKey(instant, "day", "UTC")).toBe("2026-11-11");
  expect(bucketKey(instant, "day", "Asia/Yekaterinburg")).toBe("2026-11-12");
  expect(bucketKey(Date.UTC(2026, 10, 11), "week", "UTC")).toBe("2026-W46");
  expect(bucketKey(instant, "month", "Asia/Yekaterinburg")).toBe("2026-11");
});

test("comparison and csv preserve unknown and small samples", () => {
  expect(comparisonLabel(3, ["bug"])).toBe("comparable");
  expect(comparisonLabel(3, ["bug", "spike"])).toBe("insufficient");
  expect(comparisonLabel(2, ["bug"])).toBe("insufficient");
  expect(csvCell(null)).toBe("Unknown");
  expect(csvCell(0)).toBe("0");
  expect(toCsv(["note"], [["a,b"]])).toBe("note\n\"a,b\"\n");
});
