import { test } from "bun:test";
import { runIsolatedMissionSuite } from "./test-support/mission-file-isolation.ts";

test("scheduled task availability lifecycle runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./task-availability-lifecycle.suite.ts", import.meta.url), 180_000);
}, 180_000);

test("scheduled task availability under Owner Trust authorization runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./task-availability-auth.suite.ts", import.meta.url), 180_000);
}, 180_000);
