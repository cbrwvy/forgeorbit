import { expect, test } from "bun:test";
import { EMPLOYEE_FIRST_NAMES, generateEmployeeName } from "./names.ts";

test("the name pool has no case-insensitive duplicates and fits the name limit", () => {
  const keys = EMPLOYEE_FIRST_NAMES.map((name) => name.toLowerCase());
  expect(new Set(keys).size).toBe(keys.length);
  expect(EMPLOYEE_FIRST_NAMES.every((name) => name.length >= 2 && name.length <= 80)).toBe(true);
});

test("a draw uses the injected random source and maps its range onto the pool", () => {
  expect(generateEmployeeName([], () => 0)).toBe(EMPLOYEE_FIRST_NAMES[0]);
  expect(generateEmployeeName([], () => 0.999999)).toBe(EMPLOYEE_FIRST_NAMES.at(-1)!);
  expect(generateEmployeeName([], () => 1)).toBe(EMPLOYEE_FIRST_NAMES.at(-1)!);
  expect(generateEmployeeName([], () => -1)).toBe(EMPLOYEE_FIRST_NAMES[0]);
});

test("a draw skips names that are already taken, ignoring case and spaces", () => {
  expect(generateEmployeeName(["  alex "], () => 0)).toBe(EMPLOYEE_FIRST_NAMES[1]);
});

test("when every name is taken a draw still returns a name instead of failing", () => {
  expect(EMPLOYEE_FIRST_NAMES).toContain(generateEmployeeName([...EMPLOYEE_FIRST_NAMES], () => 0.5) as never);
});
