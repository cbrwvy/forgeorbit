import { describe, expect, test } from "bun:test";
import { scrollOffsetWithin } from "./scroll-within";

describe("scrollOffsetWithin", () => {
  test("start aligns the element with the top of the root", () => {
    expect(scrollOffsetWithin(100, 500, 340, 400, "start")).toBe(240);
    expect(scrollOffsetWithin(100, 500, 60, 90, "start")).toBe(-40);
  });
  test("nearest does nothing when already visible", () => {
    expect(scrollOffsetWithin(100, 500, 200, 260, "nearest")).toBe(0);
  });
  test("nearest scrolls up or down by the smallest amount", () => {
    expect(scrollOffsetWithin(100, 500, 60, 90, "nearest")).toBe(-40);
    expect(scrollOffsetWithin(100, 500, 480, 540, "nearest")).toBe(40);
  });
  test("an element taller than the root is aligned to its top", () => {
    expect(scrollOffsetWithin(100, 500, 300, 900, "nearest")).toBe(200);
  });
});
