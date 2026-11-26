import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-FORECAST-ACTUAL01 compares the frozen baseline with recorded actuals", () => {
  runIsolatedMissionSuite(new URL("./forecast-comparison.suite.ts", import.meta.url), 90_000);
}, 90_000);
