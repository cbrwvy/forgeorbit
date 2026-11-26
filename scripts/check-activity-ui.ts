/** FO-015A.2 targeted checks only. Never launches Native or a real AI CLI. */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "../e2e/isolated-env.ts";

const root = path.resolve(import.meta.dirname, "..");
const commands = {
  unit: ["bun", "test", "src/mainview/lib/activity-journal.test.tsx", "src/mainview/i18n/core.test.tsx", "src/mainview/i18n/contracts.test.ts"],
  browser: ["bun", "--bun", "node_modules/@playwright/test/cli.js", "test", "e2e/activity-journal.spec.ts", "e2e/company-directory.spec.ts", "--grep", "all events,|long history,|confirmed SSE|missing entities|project entry|keyboard, long|filter races|existing approval|an empty organization", "--workers=1", "--reporter=list"],
  typecheck: ["bun", "run", "typecheck"],
  build: ["bun", "node_modules/vite/bin/vite.js", "build"],
} as const;
const mode = process.argv[2] as keyof typeof commands;
if (!Object.hasOwn(commands, mode)) throw new Error("Usage: bun scripts/check-activity-ui.ts unit|browser|typecheck|build");
const dataDir = mkdtempSync(path.join(tmpdir(), "fo015-ui-check-"));
const fxBin = writeFxStubBin(dataDir);
const env = isolatedCoreEnv({ dataDir, fxBin, apiPort: 0, apiToken: "activity-ui-fixture-only" });
env.PATH = path.join(root, "node_modules", ".bin") + path.delimiter + env.PATH;
env.FORGEORBIT_E2E_API_PORT_OFFSET = process.env.FORGEORBIT_E2E_API_PORT_OFFSET ?? "15000";
env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
// Reuse only the stateless canonical Vite server; every test uses freshBackend.
env.CI = "";
try {
  const seed = seedIsolatedHarnessHomes(dataDir, fxBin);
  if (!seed.ok) throw new Error(seed.stderr);
  const child = Bun.spawn([...commands[mode]], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
