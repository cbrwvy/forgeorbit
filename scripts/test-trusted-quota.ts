/** FO-009C targeted suites only. Each process gets an isolated HOME, SQLite and fake CLI binaries. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env.ts";
const root = path.resolve(import.meta.dir, "..");
const out = mkdtempSync(path.join(tmpdir(), "fo009c-validation-"));
console.log(`Isolated test logs: ${out}`);
const suites = [
  "src/bun/trusted-quota.test.ts",
  "src/bun/account-core.test.ts",
  "src/bun/account-migration.test.ts",
  "src/bun/account-endpoint.test.ts",
  "src/bun/portfolio-adapter.test.ts",
  "src/shared/portfolio/portfolio.test.ts",
  "src/bun/account-usage.test.ts",
  "src/bun/usage/poller.test.ts",
  "src/mainview/lib/accounts.test.ts",
  "src/mainview/lib/account-api.test.ts",
  "src/mainview/lib/portfolio.test.ts",
];
const results = [];
for (const suite of suites) {
  const dir = mkdtempSync(path.join(tmpdir(), "fo009c-unit-"));
  const env = isolatedCoreEnv({
    dataDir: dir,
    apiPort: 0,
    apiToken: "fo009c-test-only",
    fxBin: writeFxStubBin(dir),
  });
  delete env.FORGEORBIT_DATA_DIR;
  delete env.FORGEORBIT_API_PORT;
  if (suite.endsWith("/poller.test.ts")) delete env.AGETOR_USAGE_OFFLINE;
  const proc = Bun.spawnSync(["bun", "test", suite], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output =
    new TextDecoder().decode(proc.stdout) +
    new TextDecoder().decode(proc.stderr);
  const log = path.join(out, suite.replaceAll("/", "_") + ".log");
  writeFileSync(log, output);
  const passed = Number(output.match(/\n\s*(\d+) pass/)?.[1] ?? 0),
    failed = Number(output.match(/\n\s*(\d+) fail/)?.[1] ?? 0);
  results.push({ suite, passed, failed, exitCode: proc.exitCode, log });
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(path.join(out, "tests.json"), JSON.stringify(results, null, 2));
if (results.some((r) => r.exitCode !== 0)) process.exitCode = 1;
