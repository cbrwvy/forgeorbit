import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, REPO_ROOT, writeFxStubBin } from "../../e2e/isolated-env.ts";

test("cluster and employee endpoint fixtures coexist in one cached SQLite process", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fo013a-endpoint-pair-"));
  mkdirSync(dataDir, { recursive: true });
  const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "fixture-pair", fxBin: writeFxStubBin(dataDir) });
  // The endpoint suites own their ports; do not shadow their legacy overrides.
  for (const key of ["FORGEORBIT_API_PORT", "AGETOR_API_PORT", "FORGEORBIT_API_TOKEN", "AGETOR_API_TOKEN"]) delete env[key];
  const result = spawnSync(process.execPath, ["test", "src/bun/cluster-endpoint.test.ts", "src/bun/employee-endpoint.test.ts"], {
    cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/6 pass\b/);
  expect(output).toMatch(/0 fail\b/);
});
