import { describe, expect, test } from "bun:test";
import {
  buildUtcIsoFromParts,
  evaluateTaskAvailability,
  formatLocalTimePreview,
  formatUtcTimestamp,
  isTaskScheduledWaiting,
  parseAvailableFromUtc,
  splitUtcIsoToParts,
} from "./task-availability.ts";

describe("parseAvailableFromUtc", () => {
  test("accepts null (immediate availability)", () => {
    expect(parseAvailableFromUtc(null)).toEqual({ ok: true, value: null });
  });

  test("accepts canonical UTC timestamps and normalizes explicit offsets to UTC", () => {
    expect(parseAvailableFromUtc("2026-11-27T08:00:00.000Z")).toEqual({
      ok: true,
      value: "2026-11-27T08:00:00.000Z",
    });
    expect(parseAvailableFromUtc("2026-11-27T08:00Z")).toEqual({
      ok: true,
      value: "2026-11-27T08:00:00.000Z",
    });
    expect(parseAvailableFromUtc("2026-11-27T13:00:00+05:00")).toEqual({
      ok: true,
      value: "2026-11-27T08:00:00.000Z",
    });
    expect(parseAvailableFromUtc("2026-11-27T03:00:00-05:00")).toEqual({
      ok: true,
      value: "2026-11-27T08:00:00.000Z",
    });
  });

  test("rejects ambiguous, timezone-less, malformed, or impossible calendar dates", () => {
    const invalidInputs: unknown[] = [
      "",
      "   ",
      "2026-11-27",
      "2026-11-27T08:00",
      "2026-11-27T08:00:00",
      "2026-11-27 08:00:00Z",
      "2026-11-27t08:00:00z",
      "Nov 27, 2026 08:00 UTC",
      "2026-02-30T08:00:00Z",
      "2026-13-01T08:00:00Z",
      "2026-11-27T24:00:00Z",
      "2026-11-27T08:60:00Z",
      "2026-11-27T08:00:00+25:00",
      " 2026-11-27T08:00:00Z ",
      1795680000000,
      {},
      true,
    ];
    for (const bad of invalidInputs) {
      const res = parseAvailableFromUtc(bad);
      expect(res.ok, `expected rejection for ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("evaluateTaskAvailability", () => {
  const target = "2026-11-27T08:00:00.000Z";
  const targetMs = Date.parse(target);

  test("null/undefined is immediately available", () => {
    expect(evaluateTaskAvailability(null, targetMs - 10_000).available).toBe(true);
    expect(evaluateTaskAvailability({ availableFromUtc: null }, targetMs - 10_000).available).toBe(true);
    expect(isTaskScheduledWaiting(null, targetMs)).toBe(false);
  });

  test("strictly before the timestamp is unavailable; exact boundary and after are available", () => {
    const before = evaluateTaskAvailability({ availableFromUtc: target }, targetMs - 1);
    expect(before.available).toBe(false);
    expect(before.remainingMs).toBe(1);
    expect(before.availableFromMs).toBe(targetMs);

    const exact = evaluateTaskAvailability({ availableFromUtc: target }, targetMs);
    expect(exact.available).toBe(true);
    expect(exact.remainingMs).toBe(0);

    const after = evaluateTaskAvailability({ availableFromUtc: target }, targetMs + 60_000);
    expect(after.available).toBe(true);
    expect(after.remainingMs).toBe(0);
  });

  test("corrupted stored timestamp fails closed", () => {
    const corrupt = evaluateTaskAvailability({ availableFromUtc: "not-a-timestamp" }, targetMs);
    expect(corrupt.available).toBe(false);
    expect(corrupt.corrupt).toBe(true);
  });
});

describe("formatting and timezone preview", () => {
  test("formats UTC timestamps in EN and RU exactly as specified", () => {
    expect(formatUtcTimestamp("2026-11-27T08:00:00.000Z", "en")).toBe("Nov 27, 2026, 08:00 UTC");
    expect(formatUtcTimestamp("2026-11-27T08:00:00.000Z", "ru")).toBe("27.11.2026, 08:00 UTC");
    expect(formatUtcTimestamp("2026-01-05T00:05:00.000Z", "en")).toBe("Jan 5, 2026, 00:05 UTC");
    expect(formatUtcTimestamp("2026-01-05T00:05:00.000Z", "ru")).toBe("05.01.2026, 00:05 UTC");
  });

  test("local time preview adapts to arbitrary IANA timezones (e.g., UTC+5, UTC-5, DST)", () => {
    // 08:00 UTC in Asia/Almaty (UTC+5) => 13:00
    const almaty = formatLocalTimePreview("2026-11-27T08:00:00.000Z", "en", "Asia/Almaty");
    expect(almaty?.text).toContain("13:00");
    expect(almaty?.timeZone).toBe("Asia/Almaty");

    // 08:00 UTC in America/New_York (EST, UTC-5 in Nov) => 03:00
    const nyWinter = formatLocalTimePreview("2026-11-27T08:00:00.000Z", "en", "America/New_York");
    expect(nyWinter?.text).toContain("03:00");

    // 08:00 UTC in America/New_York (EDT, UTC-4 in Jul) => 04:00 (DST shift handled automatically)
    const nySummer = formatLocalTimePreview("2026-07-15T08:00:00.000Z", "en", "America/New_York");
    expect(nySummer?.text).toContain("04:00");

    // RU locale formatting for Asia/Almaty
    const almatyRu = formatLocalTimePreview("2026-11-27T08:00:00.000Z", "ru", "Asia/Almaty");
    expect(almatyRu?.text).toBe("27.11.2026, 13:00");
  });

  test("picker part round-trip preserves exact UTC date and HH:MM", () => {
    const iso = buildUtcIsoFromParts("2026-11-27", "08:00");
    expect(iso).toBe("2026-11-27T08:00:00.000Z");
    expect(splitUtcIsoToParts(iso)).toEqual({ date: "2026-11-27", time: "08:00" });
    expect(buildUtcIsoFromParts("2026-02-30", "08:00")).toBeNull();
  });
});
