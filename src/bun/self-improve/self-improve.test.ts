import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("self-improvement acceptance runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./self-improve.suite.ts", import.meta.url), 180_000);
}, 180_000);
