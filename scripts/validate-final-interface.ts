import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, isolatedCoreEnv, writeFxStubBin } from "../e2e/isolated-env";

/** Bounded FO-UI01 browser gates. Never runs the full suite or a native app.
 * Refuses to reuse a foreign Vite; preserves every previous run's evidence.
 */
const scopes = {
  matrix: ["e2e/final-interface.spec.ts", "e2e/organization-layout-defect.spec.ts"],
  related: ["e2e/desktop-stabilization.spec.ts", "e2e/employee-run.spec.ts", "e2e/employee-execution.spec.ts", "e2e/i18n.spec.ts", "e2e/activity-journal.spec.ts"],
  workflow: ["e2e/organization-end-to-end-acceptance.spec.ts", "--grep", "FO-012C recovered PM-created Task"],
  files: ["e2e/non-git-file-suggestions.spec.ts", "e2e/at-file-autocomplete.spec.ts", "e2e/at-file-truncated.spec.ts"],
  fileLocale: ["e2e/final-interface.spec.ts", "--grep", "FO012C-P3-01"],
} as const;
const phase = process.argv[2];
if (!phase || !Object.hasOwn(scopes, phase)) throw new Error(`Choose one targeted phase: ${Object.keys(scopes).join(", ")}`);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-ui01-${phase}-`)));
mkdirSync(path.join(root, "tmp"));
writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
writeFileSync(path.join(root, "vite.config.ts"), `import base from ${JSON.stringify(path.join(REPO_ROOT, "vite.config.ts"))};
export default {...base, cacheDir: ${JSON.stringify(path.join(root, "vite-cache"))}};
`);
writeFileSync(path.join(root, "playwright.config.ts"), `import base from ${JSON.stringify(path.join(REPO_ROOT, "playwright.config.ts"))};
export default {...base, testDir: ${JSON.stringify(path.join(REPO_ROOT, "e2e"))}, workers: 1,
  use: {...base.use, proxy: {server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1,[::1]"}},
  reporter: [["list"], ["json", {outputFile: ${JSON.stringify(path.join(root, "results.json"))}}]],
  outputDir: ${JSON.stringify(path.join(root, "screenshots"))},
  webServer: {...base.webServer, cwd: ${JSON.stringify(REPO_ROOT)}, reuseExistingServer: false,
    command: ${JSON.stringify(`bun ${shellQuote(path.join(REPO_ROOT, "node_modules/vite/bin/vite.js"))} --config ${shellQuote(path.join(root, "vite.config.ts"))}`)}}};
`);
// Resolve the installed browser cache before replacing HOME. No download.
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const dataDir = path.join(root, "runner");
const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "fo-ui01-fixture", fxBin: writeFxStubBin(dataDir), extra: {
  TMPDIR: path.join(root, "tmp"), CI: "1", PLAYWRIGHT_BROWSERS_PATH: browserCache, FORGEORBIT_E2E_API_PORT_OFFSET: "18000",
} });
const args = [...scopes[phase as keyof typeof scopes]];
writeFileSync(path.join(root, "scope.json"), JSON.stringify({ phase, specs: args, parentHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(), native: "NOT RUN", provider: "FAKE ONLY", browserNetwork: "loopback bypass; external proxy refused" }, null, 2));
console.log(`FO-UI01 ${phase} evidence: ${root}`);
const log = openSync(path.join(root, "browser.log"), "wx");
const child = Bun.spawn([process.execPath, path.join(REPO_ROOT, "node_modules/@playwright/test/cli.js"), "test", "--config", path.join(root, "playwright.config.ts"), ...args], { cwd: REPO_ROOT, env, stdout: log, stderr: log });
const code = await child.exited;
closeSync(log);
console.log(readFileSync(path.join(root, "browser.log"), "utf8").slice(-3500));
console.log(`Exit ${code}; full log and screenshots: ${root}`);
process.exitCode = code;
