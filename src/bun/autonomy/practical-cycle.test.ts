import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("practical cycle runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./practical-cycle.suite.ts", import.meta.url), 300_000);
}, 300_000);
