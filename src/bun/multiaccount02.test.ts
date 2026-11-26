import { test } from "bun:test";
import { runIsolatedMissionSuite } from "./test-support/mission-file-isolation.ts";

test("multi-account mission binding runs in its own database process", () => {
  runIsolatedMissionSuite(new URL("./multiaccount02.suite.ts", import.meta.url), 180_000);
}, 180_000);
