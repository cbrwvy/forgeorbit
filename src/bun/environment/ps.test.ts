import { expect, test } from "bun:test";

import { extractEnvToken, parseLstart } from "./ps.ts";

test("parses an LC_ALL=C lstart and finds an ownership token only as its own field", () => {
  const parsed = parseLstart("Fri Oct 23 19:04:39 2026");
  expect(parsed).not.toBeNull();
  const date = new Date(parsed ?? 0);
  expect(date.getFullYear()).toBe(2026);
  expect(date.getMonth()).toBe(9);
  expect(date.getDate()).toBe(23);
  expect(parseLstart("not a time")).toBeNull();

  const token = "ab".repeat(16);
  const line = `/bin/sleep 30 FORGEORBIT_ENV_TOKEN=${token} PATH=/usr/bin`;
  expect(extractEnvToken(line, token)).toBe(token);
  expect(extractEnvToken(line, "cd".repeat(16))).toBeNull();
  expect(extractEnvToken(`FORGEORBIT_ENV_TOKEN=${token}extra`, token)).toBeNull();
});
