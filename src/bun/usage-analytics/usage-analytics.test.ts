import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-USAGE-ANALYTICS01 uses an isolated database and recorded usage", () => {
  runIsolatedMissionSuite(new URL("./usage-analytics.suite.ts", import.meta.url), 60_000);
}, 60_000);
