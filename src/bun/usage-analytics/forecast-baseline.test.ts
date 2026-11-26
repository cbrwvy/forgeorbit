import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-DIRECTION12 Backlog forecast basis, input changes and baseline binding on the supervised launch path", () => {
  runIsolatedMissionSuite(new URL("./forecast-baseline.suite.ts", import.meta.url), 120_000);
}, 120_000);
