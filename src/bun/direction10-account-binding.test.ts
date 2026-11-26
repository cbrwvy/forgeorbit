import { test } from "bun:test";
import { runIsolatedMissionSuite } from "./test-support/mission-file-isolation.ts";

test("Direction 10 account binding suite runs in its own isolated database process", () => {
  runIsolatedMissionSuite(new URL("./direction10-account-binding.suite.ts", import.meta.url), 180_000);
}, 180_000);
