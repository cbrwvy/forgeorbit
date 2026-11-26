import { test } from "bun:test";
import { runIsolatedMissionSuite } from "../test-support/mission-file-isolation.ts";

test("owner trust company suite", () => {
  runIsolatedMissionSuite(new URL("./company.suite.ts", import.meta.url), 120_000);
}, 120_000);
