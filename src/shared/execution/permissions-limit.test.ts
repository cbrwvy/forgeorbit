import { expect, test } from "bun:test";
import { describePermissions } from "./permissions.ts";

test("the opt-in time limit appears on a review disclosure only when one applies, and changes no permission", () => {
  const base = { kind: "codex", mode: "auto", layout: "non-git" as const, readScope: "broad" as const };
  const plain = describePermissions(base)!;
  expect("timeLimitSeconds" in plain).toBe(false);
  expect(describePermissions({ ...base, timeLimitSeconds: null })).toEqual(plain);
  expect(describePermissions({ ...base, timeLimitSeconds: 0 })).toEqual(plain);
  const limited = describePermissions({ ...base, timeLimitSeconds: 90 })!;
  expect(limited.timeLimitSeconds).toBe(90);
  const { timeLimitSeconds: _limit, ...rest } = limited;
  expect(rest).toEqual(plain);
});
