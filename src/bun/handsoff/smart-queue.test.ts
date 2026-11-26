import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("smart execution queue runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./smart-queue.suite.ts", import.meta.url), 180_000);
}, 180_000);
