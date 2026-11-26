import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("mission scale acceptance runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./orchestration-scale.suite.ts", import.meta.url), 180_000);
}, 180_000);
