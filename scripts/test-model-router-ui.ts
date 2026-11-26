/** Explicit FO-009E scope. Sequential isolated processes; no full suite or live CLI/provider. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env.ts";

const root = path.resolve(import.meta.dir, "..");
const output = mkdtempSync(path.join(tmpdir(), "fo009e-validation-"));
const suites = [
  "src/mainview/lib/model-router-preview.test.ts",
  "src/shared/model-router/route.test.ts",
  "src/bun/model-router.test.ts",
  "src/bun/model-router-endpoint.test.ts",
  "src/shared/portfolio/portfolio.test.ts",
  "src/bun/portfolio-adapter.test.ts",
  "src/mainview/lib/portfolio.test.ts",
  "src/mainview/lib/workspace.test.ts",
  "src/mainview/lib/task-assignments.test.ts",
  "src/bun/assignment-http.test.ts",
  "src/mainview/lib/accounts.test.ts",
  "src/mainview/lib/account-api.test.ts",
  "src/bun/account-core.test.ts",
  "src/bun/account-endpoint.test.ts",
  "src/shared/estimation/estimate.test.ts",
];
console.log(`Isolated test logs: ${output}`);
const results = [];
for (const suite of suites) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fo009e-unit-"));
  const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "fo009e-test-only", fxBin: writeFxStubBin(dataDir) });
  // Older test files set their own AGETOR locations; do not shadow those overrides.
  delete env.FORGEORBIT_DATA_DIR;
  delete env.FORGEORBIT_API_PORT;
  const run = Bun.spawnSync(["bun", "test", suite], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const log = path.join(output, suite.replaceAll("/", "_") + ".log");
  const text = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
  writeFileSync(log, text);
  const result = { suite, passed: Number(text.match(/\n\s*(\d+) pass/)?.[1] ?? 0), failed: Number(text.match(/\n\s*(\d+) fail/)?.[1] ?? 0), exitCode: run.exitCode, log };
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(path.join(output, "tests.json"), JSON.stringify(results, null, 2));
if (results.some(result => result.exitCode !== 0 || result.failed > 0)) process.exitCode = 1;
