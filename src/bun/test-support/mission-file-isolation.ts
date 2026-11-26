/**
 * Mission suites each set AGETOR_DATA_DIR and then import the process-wide
 * database. Bun runs every test file in one process, so the first import wins
 * and a later suite writes into the earlier file's SQLite. Re-executing the
 * suite file in its own Bun process keeps that production capture unchanged.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runIsolatedMissionSuite(suite: URL, timeoutMs: number): void {
  const file = fileURLToPath(suite);
  const childTimeout = Math.max(1_000, timeoutMs - 5_000);
  const result = spawnSync(process.execPath, ["test", "--timeout", String(childTimeout), file], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    timeout: childTimeout,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Isolated mission suite exited ${result.status}: ${file}`);
  }
}
