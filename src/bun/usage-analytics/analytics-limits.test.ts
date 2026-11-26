import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("Direction 15 period boundaries, result limits and export parity", () => {
  runIsolatedMissionSuite(new URL("./analytics-limits.suite.ts", import.meta.url), 240_000);
}, 240_000);
