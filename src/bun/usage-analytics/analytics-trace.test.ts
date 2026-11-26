import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-ANALYTICS-TRACE01 records, reconciliation, attribution and export parity", () => {
  runIsolatedMissionSuite(new URL("./analytics-trace.suite.ts", import.meta.url), 90_000);
}, 90_000);
