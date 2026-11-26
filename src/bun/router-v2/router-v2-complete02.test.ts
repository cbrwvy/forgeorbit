import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-ROUTER-COMPLETE02 company scenario", () => {
  runIsolatedMissionSuite(new URL("./router-v2-complete02.suite.ts", import.meta.url), 120_000);
});
