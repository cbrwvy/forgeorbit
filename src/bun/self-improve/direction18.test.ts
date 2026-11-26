import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("direction 18 self-improvement workflow runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./direction18.suite.ts", import.meta.url), 600_000);
}, 600_000);
