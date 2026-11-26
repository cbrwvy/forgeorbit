import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("hands-off lifecycle runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./handsoff-lifecycle.suite.ts", import.meta.url), 420_000);
}, 420_000);

test("hands-off project authorization runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./handsoff-authorization.suite.ts", import.meta.url), 420_000);
}, 420_000);
