import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("Direction 16 Smart Router and safe fallback", () => {
  runIsolatedMissionSuite(new URL("./direction16.suite.ts", import.meta.url), 150_000);
});
