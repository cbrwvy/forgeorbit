/** FO-I18N01 targeted offline QA. Never launches the native application or a real AI CLI. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env";

const mode = process.argv[2];
const commands: Record<string, string[]> = {
  unit: ["test", "src/mainview/i18n/core.test.tsx", "src/mainview/i18n/contracts.test.ts", "src/mainview/lib/employee-execution.test.ts", "src/mainview/lib/employees.test.ts", "src/mainview/lib/assignment-proposals.test.ts", "src/mainview/lib/task-assignments.test.ts", "src/mainview/lib/accounts.test.ts", "src/mainview/lib/retention-prefs.test.ts", "src/mainview/lib/settings-dialog-view.test.ts", "src/mainview/lib/pr-proposal.test.ts", "src/mainview/lib/agent-profile-form.test.ts", "src/mainview/lib/agent-profiles.test.ts", "src/mainview/lib/model-router-preview.test.ts", "src/mainview/lib/usage.test.ts", "src/mainview/lib/fx-usage.test.ts", "src/mainview/lib/batches.test.ts", "src/mainview/lib/clusters.test.ts", "src/mainview/lib/portfolio.test.ts", "src/mainview/lib/portfolio-manager.test.ts", "src/mainview/lib/clone-progress.test.ts", "src/mainview/lib/pipelines.test.ts", "src/mainview/lib/task-context-menu.test.ts", "src/mainview/lib/awaiting.test.ts", "src/mainview/lib/bundle.test.ts", "src/mainview/lib/files-sent-notify.test.ts"],
  typecheck: ["run", "typecheck"],
  build: ["run", "--bun", "vite", "build"],
  e2e: ["--bun", "node_modules/@playwright/test/cli.js", "test", "e2e/i18n.spec.ts", "e2e/team-builder.spec.ts", "e2e/professional-runtime.spec.ts", "e2e/professional-turns.spec.ts", "--workers=1", "--output=test-results/fo-i18n01"],
};
const args = commands[mode ?? ""];
if (!args) throw new Error("Usage: bun scripts/qa-i18n.ts unit|typecheck|build|e2e");
// Read-only browser executable location, before replacing HOME; profiles remain temporary.
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
const dataDir = await mkdtemp(path.join(tmpdir(), "fo-i18n01-qa-"));
const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "offline-i18n-qa", fxBin: writeFxStubBin(dataDir), extra: {
  CI: "1",
  FORGEORBIT_E2E_API_PORT_OFFSET: "18000",
  ...(existsSync(browserCache) ? { PLAYWRIGHT_BROWSERS_PATH: browserCache } : {}),
} });
try {
  const child = spawn(process.execPath, args, { cwd: path.resolve(import.meta.dir, ".."), env, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  process.exitCode = code;
} finally { await rm(dataDir, { recursive: true, force: true }); }
