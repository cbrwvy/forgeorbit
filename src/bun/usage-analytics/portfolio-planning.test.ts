import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-FORECAST-PORTFOLIO01 constraints, alternative comparison and the decision boundary", () => {
  runIsolatedMissionSuite(new URL("./portfolio-planning.suite.ts", import.meta.url), 90_000);
}, 90_000);
