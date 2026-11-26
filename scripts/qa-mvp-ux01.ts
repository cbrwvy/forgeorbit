import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env";

// Establish isolation before importing any application/backend modules.
const [mode, ...args] = process.argv.slice(2);
const commands: Record<string, string[]> = {
  e2e: ["--bun", "node_modules/@playwright/test/cli.js", "test", ...args],
  unit: ["test", ...args],
  typecheck: ["run", "typecheck"],
  build: ["run", "--bun", "vite", "build"],
};
if (!mode || !commands[mode]) throw Error("Usage: bun scripts/qa-mvp-ux01.ts e2e|unit|typecheck|build [args]");
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
const root = await mkdtemp("/private/tmp/fo-mvp-ux01-");
mkdirSync(path.join(root, "tmp"));
const env = isolatedCoreEnv({ dataDir: root, apiPort: 0, apiToken: "offline-ux01", fxBin: writeFxStubBin(root), extra: {
  CI: "1", TMPDIR: path.join(root, "tmp"),
  FORGEORBIT_E2E_API_PORT_OFFSET: "21000",
  ...(existsSync(browserCache) ? { PLAYWRIGHT_BROWSERS_PATH: browserCache } : {}),
} });
console.log(`UX01 isolated ${mode}: ${root}`);
const child = spawn(process.execPath, commands[mode]!, { cwd: path.resolve(import.meta.dir, ".."), env, stdio: "inherit" });
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
});
// Retain disposable logs/evidence; never delete historical campaigns.
