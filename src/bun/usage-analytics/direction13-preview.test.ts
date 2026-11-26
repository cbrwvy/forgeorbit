import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("FO-DIRECTION13 QA-only preview seam, Unknown capacity and unit separation", () => {
  runIsolatedMissionSuite(new URL("./direction13-preview.suite.ts", import.meta.url), 120_000);
}, 120_000);
