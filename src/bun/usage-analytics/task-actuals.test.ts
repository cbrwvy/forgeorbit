import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-DIRECTION14 task actuals: exact interval arithmetic, incomplete data, attribution and read-only reads", () => {
  runIsolatedMissionSuite(new URL("./task-actuals.suite.ts", import.meta.url), 120_000);
}, 120_000);
