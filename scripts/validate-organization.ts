import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env";

/** FO-012 fixed, targeted regression manifest. One Bun process per file so
 * module-level DB/env and spies cannot bleed into a different backend suite.
 * No full-suite discovery, real CLI or production HOME. Retain logs and counters.
 */
const files = [
  "src/bun/employee-core.test.ts",
  "src/bun/employee-endpoint.test.ts",
  "src/bun/cluster-core.test.ts",
  "src/bun/project-ownership.test.ts",
  "src/bun/project-ownership-scopes.test.ts",
  "src/bun/portfolio-adapter.test.ts",
  "src/bun/portfolio-manager.test.ts",
  "src/bun/project-manager.test.ts",
  "src/bun/assignment-core.test.ts",
  "src/bun/assignment-http.test.ts",
  "src/bun/assignment-proposals.test.ts",
  "src/bun/assignment-proposals-manager.test.ts",
  "src/bun/employee-execution.test.ts",
  "src/bun/employee-run.test.ts",
  "src/bun/employee-reconciliation.test.ts",
  "src/bun/knowledge-context.test.ts",
  "src/bun/knowledge-context-managers.test.ts",
  "src/bun/model-router.test.ts",
  "src/bun/model-router-endpoint.test.ts",
  "src/bun/codex-source.test.ts",
  "src/shared/model-router/route.test.ts",
  "src/shared/execution/run.test.ts",
  "src/mainview/lib/employees.test.ts",
  "src/mainview/lib/assignment-proposals.test.ts",
  "src/mainview/lib/employee-execution.test.ts",
  "src/mainview/lib/employee-execution-poll.test.ts",
  "src/mainview/lib/portfolio-manager-events.test.ts",
  "src/mainview/lib/model-router-preview.test.ts",
];
const root = mkdtempSync(path.join(tmpdir(), "fo012-regressions-"));
const results: { file: string; exitCode: number | null; pass: number; fail: number; log: string }[] = [];
console.log(`FO-012 targeted regressions: ${root}`);
for (const [i, file] of files.entries()) {
  const dataDir = path.join(root, `suite-${i}`);
  mkdirSync(dataDir);
  const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "fo012-test-only", fxBin: writeFxStubBin(dataDir), extra: { CI: "1" } });
  // These test files set their own legacy data/port/token before importing DB.
  // A FORGEORBIT twin would take precedence and silently undo their isolation.
  for (const key of ["FORGEORBIT_DATA_DIR", "FORGEORBIT_API_PORT", "FORGEORBIT_API_TOKEN"]) delete env[key];
  delete env.AGETOR_API_PORT;
  delete env.AGETOR_API_TOKEN;
  const result = spawnSync("bun", ["test", file], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  const log = path.join(root, `${i}-${path.basename(file)}.log`);
  writeFileSync(log, output);
  const pass = Number(/(\d+) pass\b/.exec(output)?.[1] ?? 0);
  const fail = Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0);
  results.push({ file, exitCode: result.status, pass, fail, log });
  console.log(`${result.status === 0 && pass > 0 && fail === 0 ? "PASS" : "FAIL"} ${file}: ${pass} pass, ${fail} fail`);
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ root, results }, null, 2));
}
const failed = results.filter((r) => r.exitCode !== 0 || r.fail !== 0 || r.pass === 0);
console.log(`TOTAL: ${results.reduce((n, r) => n + r.pass, 0)} pass, ${results.reduce((n, r) => n + r.fail, 0)} fail; ${failed.length} failed files; manifest ${root}/manifest.json`);
process.exitCode = failed.length ? 1 : 0;
