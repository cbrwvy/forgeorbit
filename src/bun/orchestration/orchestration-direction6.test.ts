import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("Direction 6 scheduler cases run in their own database process", () => {
  runIsolatedMissionSuite(new URL("./orchestration-direction6.suite.ts", import.meta.url), 240_000);
}, 240_000);
