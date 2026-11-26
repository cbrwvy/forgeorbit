import { expect, test } from "bun:test";
import { cn } from "./utils";

test("a caller's size override replaces the density token instead of sitting beside it", () => {
  expect(cn("h-control w-control", "h-8 w-8")).toBe("h-8 w-8");
  expect(cn("min-h-control px-4", "min-h-8")).toBe("px-4 min-h-8");
  expect(cn("px-page py-row gap-stack", "px-2 py-1 gap-2")).toBe("px-2 py-1 gap-2");
});

test("token classes do not drop unrelated utilities", () => {
  expect(cn("h-control rounded-md border", "text-sm")).toBe("h-control rounded-md border text-sm");
  expect(cn("text-body", "text-muted-foreground")).toBe("text-body text-muted-foreground");
});
