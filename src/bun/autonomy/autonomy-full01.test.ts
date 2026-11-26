import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("full autonomy acceptance runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./autonomy-full01.suite.ts", import.meta.url), 180_000);
}, 180_000);
