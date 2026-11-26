import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one environment every ForgeOrbit core under e2e test boots with —
 * the worker fixture (`e2e/fixtures.ts`) and any spec that starts its own
 * `headless.ts` (the autonomous-execution restart test). Plain Node imports
 * only, so `bun test` can use it too (`e2e/isolated-env.test.ts`).
 *
 * What it guarantees for the core process:
 * - its own SQLite (`FORGEORBIT_DATA_DIR`/`AGETOR_DATA_DIR`) and its own
 *   `HOME` inside the data dir, so `~/.claude`, `~/.codex`, `~/.cursor`,
 *   `~/.gemini`, `~/.fx`, `~/.claude.json`, skills and the login-shell rc
 *   files of the developer are never read;
 * - every harness binary and tmux is a stub, every agent driver is the fake
 *   one, and the usage poller is offline (`AGETOR_USAGE_OFFLINE`), so no real
 *   CLI runs — not even `--version` — and no real account API or Keychain
 *   entry is touched;
 * - no `FORGEORBIT_*`/`AGETOR_*` variable, API key, token or CLI config-dir
 *   variable is inherited from the shell that started the tests. A
 *   `FORGEORBIT_*` override wins over its `AGETOR_*` twin in the core (e.g.
 *   `FORGEORBIT_TMUX_BIN`), so inheriting one would silently undo a stub.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Stand-in for every real CLI. Always present, does nothing. */
export const STUB_BIN = "/bin/echo";

/** Env names of CLI config dirs and credentials a test core must not see. */
const INHERITED_DENYLIST = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_CLI_HOME",
  "CURSOR_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FNM_DIR",
  "ZDOTDIR",
]);

/** True for a variable the test core must not inherit. */
export function isDeniedInheritedEnv(name: string): boolean {
  if (/^(FORGEORBIT|AGETOR)_/.test(name)) return true;
  if (/(_API_KEY|_TOKEN|_SECRET|_OIDC_TOKEN)$/.test(name)) return true;
  if (/^(XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME)$/.test(name)) return true;
  return INHERITED_DENYLIST.has(name);
}

/** The shell's env minus everything `isDeniedInheritedEnv` names. */
export function sanitizedParentEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || isDeniedInheritedEnv(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * fx's availability probe (`checkHarness` in src/bun/agent-status.ts) is a
 * DUAL probe — `--version` AND `--help`, whose output must contain "coding
 * agent" — because the bare name `fx` collides with an unrelated npm
 * JSON-viewer CLI. That probe runs regardless of `AGETOR_FX_DRIVER=fake`, so
 * `/bin/echo` would fail it and `startTask` would refuse every fx run. This
 * stub mirrors `src/bun/orchestrator-fx.test.ts`'s. It is written inside the
 * data dir, so it is removed with it.
 *
 * Also answers `fx models --json` (`discoverFx`) with a small fixed catalog:
 * two ids that overlap curated rows (`zai/glm-5.3-flash`, `openai/gpt-5.2`)
 * and one discovered-only id, so fx model-picker specs prove the
 * account-scoped merge instead of asserting against an empty list. It
 * deliberately does NOT answer `status --json`, which keeps the pre-flight
 * auth check failing open (`loggedIn: null`).
 */
export function writeFxStubBin(dataDir: string): string {
  const binDir = path.join(dataDir, "fx-stub-bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "fx");
  writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      '  echo "Fast, native coding agent for the terminal"',
      "  exit 0",
      "fi",
      'if [ "$1" = "--version" ]; then',
      '  echo "0.0.4-fake"',
      "  exit 0",
      "fi",
      'if [ "$1" = "models" ] && [ "$2" = "--json" ]; then',
      '  echo \'{"kind":"models","count":3,"shown_count":3,"more_count":0,"private_models_hidden":false,"ids":["zai/glm-5.3-flash","openai/gpt-5.2","e2e/discovered-only"]}\'',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

/** `HOME` for the test core: inside the data dir, with only a git identity
 *  (the core may commit in a test repo; nothing else is configured). */
export function isolatedHome(dataDir: string): string {
  const home = path.join(dataDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, ".gitconfig"),
    "[user]\n\tname = ForgeOrbit E2E\n\temail = e2e@forgeorbit.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  return home;
}

export interface IsolatedCoreOptions {
  dataDir: string;
  apiPort: number;
  apiToken: string;
  /** `writeFxStubBin(dataDir)`. */
  fxBin: string;
  /** Spec-specific variables, applied last (they may override the stubs). */
  extra?: Record<string, string>;
}

/** The complete env for `bun src/bun/headless.ts` under test. */
export function isolatedCoreEnv(opts: IsolatedCoreOptions): Record<string, string> {
  const { dataDir, apiPort, apiToken, fxBin } = opts;
  return {
    ...sanitizedParentEnv(),
    HOME: isolatedHome(dataDir),
    FORGEORBIT_DATA_DIR: dataDir,
    AGETOR_DATA_DIR: dataDir,
    // Metadata discovery must not inspect the Owner's installed DSH app in tests.
    FORGEORBIT_DEEPSEEK_APP_PATH: path.join(dataDir, "DeepSeek Harness.app"),
    FORGEORBIT_API_PORT: String(apiPort),
    AGETOR_API_PORT: String(apiPort),
    FORGEORBIT_API_TOKEN: apiToken,
    AGETOR_API_TOKEN: apiToken,
    // 10 min, not disabled: if a test's teardown ever fails to kill the
    // core, it reaps itself instead of squatting on its port forever.
    AGETOR_DAEMON_IDLE_MS: "600000",
    // Every agent runs through its in-process fake driver. The start-task
    // pre-flight (`checkHarness`) still resolves a binary for each harness
    // (and tmux for claude-code), so each one points at a stub.
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CURSOR_DRIVER: "fake",
    AGETOR_GEMINI_DRIVER: "fake",
    AGETOR_FX_DRIVER: "fake",
    AGETOR_ANTIGRAVITY_DRIVER: "fake",
    AGETOR_CLAUDE_BIN: STUB_BIN,
    AGETOR_CODEX_BIN: STUB_BIN,
    AGETOR_CURSOR_BIN: STUB_BIN,
    AGETOR_GEMINI_BIN: STUB_BIN,
    AGETOR_ANTIGRAVITY_BIN: STUB_BIN,
    AGETOR_FX_BIN: fxBin,
    AGETOR_TMUX_BIN: STUB_BIN,
    AGETOR_NOTIFIER_BIN: STUB_BIN,
    AGETOR_CLAUDE_ARGS: "",
    // No account usage API, no Keychain read, no update feed.
    AGETOR_USAGE_OFFLINE: "1",
    AGETOR_DISABLE_UPDATES: "1",
    // `githubToken()` resolves this literal token from env and never shells
    // out to `gh auth token` on the developer's machine.
    GITHUB_TOKEN: "e2e-github-token",
    // FO-DEPLOY01/02: synthetic staging adapter for isolated backends only.
    FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER: "1",
    FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER: "fake",
    ...(opts.extra ?? {}),
  };
}

/**
 * Migrate the data dir's SQLite before the core boots, then point every
 * harness row's home inside it, so credential/config reads stay isolated as
 * well as task storage. Idempotent: a second boot on the same dir re-runs it.
 */
export function seedIsolatedHarnessHomes(dataDir: string, fxBin: string): { ok: true } | { ok: false; stderr: string } {
  const seed = spawnSync("bun", ["-e", `
    const { db } = await import("./src/bun/db.ts");
    const data = process.env.FORGEORBIT_DATA_DIR;
    for (const { id } of db.query("SELECT id FROM harnesses").all()) {
      db.run("UPDATE harnesses SET home = ? WHERE id = ?", [data + "/test-accounts/" + id, id]);
    }
    db.close();
  `], {
    cwd: REPO_ROOT,
    env: isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: "seed", fxBin }),
    encoding: "utf8",
  });
  return seed.status === 0 ? { ok: true } : { ok: false, stderr: seed.stderr };
}
