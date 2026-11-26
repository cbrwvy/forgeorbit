import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env";

/** FO-012C fixed regression scope; one process/SQLite namespace per file.
 * This never discovers or invokes the entire test suite or a native build.
 */
const fix01 = process.argv.includes("--fix01");
const files = fix01 ? [
  "src/bun/project-manager.test.ts",
  "src/bun/project-execution.test.ts",
  "src/bun/employee-execution.test.ts",
  "src/bun/employee-run.test.ts",
  "src/bun/worktree.test.ts",
  "src/bun/professional-runtime.test.ts",
  "src/bun/professional-turn.test.ts",
  "src/bun/activity-journal-integration.test.ts",
  "src/mainview/lib/employee-execution.test.ts",
  "src/mainview/i18n/core.test.tsx",
  "src/mainview/i18n/contracts.test.ts",
] : [
  "src/bun/employee-core.test.ts",
  "src/bun/head-portfolio-binding.test.ts",
  "src/bun/head-portfolio-runtime.test.ts",
  "src/bun/catalog/hiring-proposal-endpoint.test.ts",
  "src/bun/catalog/hiring-proposal-concurrency.test.ts",
  "src/bun/catalog/project-manager-hiring.test.ts",
  "src/bun/assignment-core.test.ts",
  "src/bun/assignment-proposals.test.ts",
  "src/bun/assignment-proposals-manager.test.ts",
  "src/bun/knowledge-context.test.ts",
  "src/bun/knowledge-context-managers.test.ts",
  "src/bun/model-router-endpoint.test.ts",
  "src/bun/employee-run.test.ts",
  "src/bun/employee-reconciliation.test.ts",
  "src/bun/professional-runtime.test.ts",
  "src/bun/professional-runtime-migration.test.ts",
  "src/bun/professional-turn.test.ts",
  "src/bun/professional-turn-migration.test.ts",
  "src/bun/activity-journal-core.test.ts",
  "src/bun/activity-journal-http.test.ts",
  "src/bun/activity-journal-migration.test.ts",
  "src/bun/activity-journal-integration.test.ts",
  "src/mainview/i18n/core.test.tsx",
  "src/mainview/i18n/contracts.test.ts",
  "src/mainview/lib/activity-journal.test.tsx",
  "src/mainview/lib/professional-turn-watch.test.ts",
];
const root = mkdtempSync(path.join(tmpdir(), "fo012c-regressions-"));
const results: { file: string; exitCode: number | null; pass: number; fail: number; log: string }[] = [];
console.log(`FO-012C targeted regression evidence: ${root}`);
for (const [index, file] of files.entries()) {
  const dataDir = path.join(root, `suite-${index}`); mkdirSync(dataDir);
  const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "fo012c-fixture-only", fxBin: writeFxStubBin(dataDir), extra: { CI: "1", TMPDIR: dataDir } });
  // Respect fixtures that select their own disposable legacy data path. A
  // higher-priority FORGEORBIT twin would silently select another singleton DB.
  for (const key of ["FORGEORBIT_DATA_DIR", "FORGEORBIT_API_PORT", "FORGEORBIT_API_TOKEN", "AGETOR_API_PORT", "AGETOR_API_TOKEN"]) delete env[key];
  // The FIX01 worktree contract scope performs read-only probes and proves
  // no fallback. It creates no Git repositories, branches or worktrees and
  // excludes the unrelated legacy remote/teardown tests in that file.
  const args = ["test", file, ...(fix01 && file.endsWith("/worktree.test.ts") ? ["--test-name-pattern", "approval Git capability|prepareWorkdir returns"] : [])];
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  const log = path.join(root, `${index}-${path.basename(file)}.log`); writeFileSync(log, output);
  const pass = Number(/(\d+) pass\b/.exec(output)?.[1] ?? 0), fail = Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0);
  results.push({ file, exitCode: result.status, pass, fail, log });
  console.log(`${result.status === 0 && pass > 0 && fail === 0 ? "PASS" : "FAIL"} ${file}: ${pass} pass, ${fail} fail`);
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ task: fix01 ? "FO-012C-FIX01" : "FO-012C", root, files, results }, null, 2));
}
const failed = results.filter(r => r.exitCode !== 0 || r.fail !== 0 || r.pass === 0);
console.log(`TOTAL: ${results.reduce((n, r) => n + r.pass, 0)} pass, ${results.reduce((n, r) => n + r.fail, 0)} fail; ${failed.length} failed files; manifest ${root}/manifest.json`);
process.exitCode = failed.length ? 1 : 0;
