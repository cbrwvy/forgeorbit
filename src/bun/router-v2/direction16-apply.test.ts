import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("Direction 16 plan-apply boundary", () => {
  runIsolatedMissionSuite(new URL("./direction16-apply.suite.ts", import.meta.url), 120_000);
});
