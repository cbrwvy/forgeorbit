import { isCodexProfile, selectedCodexAccount, CodexProfiles } from "./codex-profiles.ts";
import { isClaudeProfile, selectedClaudeAccount, ClaudeProfiles } from "./claude-profiles.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path, { isAbsolute } from "node:path";
import { Database } from "bun:sqlite";
import { TMUX_MISSING_REASON, type AgentKind, type ClaudeAccount, type Harness, type HarnessStatus } from "../shared/types.ts";
import { resolveBin, harnessEnv } from "./agents.ts";
import { buildMacSearchPath } from "./cli-discovery.ts";
import { accountUsageSummary } from "./account-usage.ts";
import { harnesses } from "./db.ts";
import { effectiveClaudeConfigDir, readClaudeAccount } from "./harness-discovery.ts";
import { resolveTmuxBin } from "./tmux-resolution.ts";
import { codexHome, readCodexToken } from "./usage/codex-usage.ts";
import { hasDeepSeekLocalCredentials } from "./usage/deepseek-usage.ts";

const VERSION_PROBE_TIMEOUT_MS = 2000;

/**
 * Per-kind install command. Surfaced on an unavailable harness's status
 * (`installHint`), and the fallback of `upgradeHintFor` below (for the npm /
 * curl installers the install command also upgrades an installed CLI).
 */
export const INSTALL_HINTS: Record<AgentKind, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  "codex": "npm i -g @openai/codex",
  "cursor": "curl https://cursor.com/install -fsS | bash",
  "gemini": "npm i -g @google/gemini-cli",
  "fx": "curl -fsSL https://fx.sh/setup.sh | bash",
  "antigravity": "brew install --cask antigravity-cli",
  "custom": "",
};

/**
 * Homebrew formula/cask name per kind, for `upgradeHintFor`. Only kinds that
 * are actually distributed through Homebrew; cursor and fx aren't, so a
 * cursor/fx binary under a Homebrew prefix falls through to the kind's own
 * self-update / reinstall command.
 */
const BREW_PACKAGES: Partial<Record<AgentKind, string>> = {
  "codex": "codex",
  "claude-code": "claude-code",
  "gemini": "gemini-cli",
  "antigravity": "antigravity-cli",
};

/**
 * Whether `binPath` looks like a Homebrew-managed install — it sits under
 * the Apple-silicon prefix (`/opt/homebrew/`) or the Intel Cellar /
 * Caskroom. The path is also resolved through its symlinks (best-effort —
 * a path that doesn't exist is judged on its literal spelling): a real path
 * under `/usr/local/Cellar/` or `/usr/local/Caskroom/` catches an Intel
 * `/usr/local/bin` symlink, and a real path inside a `node_modules`
 * directory is an npm global install that merely lives under Homebrew's
 * node prefix (`/opt/homebrew/bin/codex` → `…/lib/node_modules/@openai/codex/…`),
 * for which `brew upgrade` would fail with "not installed".
 */
function isHomebrewInstall(binPath: string): boolean {
  let real = binPath;
  try {
    real = realpathSync(binPath);
  } catch {
    // Missing / unreadable — judge the literal path.
  }
  if (real.includes("/node_modules/")) return false;
  const underBrew = (p: string) =>
    p.startsWith("/opt/homebrew/") || p.startsWith("/usr/local/Cellar/") || p.startsWith("/usr/local/Caskroom/");
  return underBrew(binPath) || underBrew(real);
}

/**
 * The command that UPGRADES an installed `kind` CLI found at `binPath` (the
 * resolved path `checkHarness` reports as `HarnessStatus.path`, or null when
 * unknown). Used as the "Upgrade with: …" hint of the per-model
 * minimum-CLI-version pre-flight (`minCliVersionError` in orchestrator.ts),
 * where the install command can be the wrong advice:
 *   - a Homebrew-managed codex / claude-code / gemini → `brew upgrade <pkg>`
 *     (`codex`, `claude-code`, `gemini-cli`) — reinstalling via npm would
 *     leave a second, shadowed copy behind;
 *   - claude-code otherwise → `claude update` (its self-updater covers both
 *     the native and the npm install);
 *   - cursor → `cursor-agent update`;
 *   - anything else → the kind's `INSTALL_HINTS` entry (the npm / curl
 *     installers upgrade in place).
 */
export function upgradeHintFor(kind: AgentKind, binPath: string | null): string {
  if (binPath && isHomebrewInstall(binPath)) {
    const pkg = BREW_PACKAGES[kind];
    if (pkg) return `brew upgrade ${pkg}`;
  }
  if (kind === "claude-code") return "claude update";
  if (kind === "cursor") return "cursor-agent update";
  if (kind === "antigravity") return "agy update";
  return INSTALL_HINTS[kind];
}

async function probeVersion(bin: string, env: Record<string, string>): Promise<string | null> {
  const proc = Bun.spawn([bin, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Merge the harness env on top of the process env so e.g. an alias with
    // a custom HOME still finds its node binary on PATH. We don't override
    // PATH here — bin resolution already happened via resolveBinPath().
    env: { ...process.env, ...env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    const code = await proc.exited;
    if (code !== 0) return null;
    const out = await new Response(proc.stdout).text();
    return out.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bare name `fx` collides with a popular npm JSON-viewer CLI. A
 * `--version` exit-status check alone can't tell them apart, so for fx
 * harnesses we additionally probe `--help` and look for a marker string
 * unique to Vercel's fx ("coding agent" — real fx v0.0.4 says "Fast, native
 * coding agent for the terminal"; the JSON viewer's says "Terminal JSON
 * viewer"; re-verified present on v0.0.6 and v0.0.7 — the marker probe is
 * still safe; re-verified 0.0.8 (2026-09-08; `--help` still "Fast, native
 * coding agent for the terminal.", `fx acp --help` still only
 * `--model`/`--log-file`)); re-verified through fx 0.0.10 (binary probes of
 * the 0.0.9 and 0.0.10 release builds, 2026-09-14): the marker line is
 * unchanged on both — only the banner and the `-c`/`--continue` copy
 * shifted ("latest" session → "remembered workspace session"), neither of
 * which this probe reads. Doesn't gate on exit code — some CLIs exit
 * non-zero for --help.
 */
async function probeHelp(bin: string, env: Record<string, string>): Promise<string | null> {
  const proc = Bun.spawn([bin, "--help"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    await proc.exited;
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return `${out}\n${err}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `[bin, ...args]` and return stdout, or `null` on a non-zero exit, a
 * spawn/read error, or the `VERSION_PROBE_TIMEOUT_MS` timeout — the same
 * shape/timeout budget as `probeVersion`/`probeHelp`. Generic (not
 * fx-specific) so a future JSON sub-command probe on another kind can reuse
 * it; today only `probeStatus` calls it.
 */
async function probeJson(bin: string, args: string[], env: Record<string, string>): Promise<string | null> {
  const proc = Bun.spawn([bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    const code = await proc.exited;
    if (code !== 0) return null;
    return await new Response(proc.stdout).text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fx-only login probe: `fx status --json` is spike-verified to run
 * unauthenticated with zero filesystem writes, so it's safe to run on every
 * status check (unlike a probe that might trigger a login flow or write
 * config). Strictly FAIL-OPEN — returns `{ loggedIn: null, authHelp: null }`
 * for anything it can't confidently parse, never a false "logged out":
 *   - the test/e2e stub binaries (`AGETOR_FX_BIN` overrides) don't implement
 *     `status --json` at all and will exit non-zero / print nothing, which
 *     must never be mistaken for "missing" and block a run;
 *   - a future fx renaming or dropping the `auth` field must degrade to
 *     "unknown", not "logged out" — see A1 in the plan doc: the authenticated
 *     value of `auth` is unverified, only `"missing"` is confirmed.
 * Two combinations are treated as a positive "logged out" signal; every other
 * parseable value — including any absent or non-boolean field along the way —
 * is treated as logged in, exactly as before:
 *   - `auth === "missing"` (from a real fx binary that answered the probe);
 *   - `auth !== "missing"` but `auth_expired === true` (strict boolean) AND
 *     `auth_refreshable === false` (strict boolean) — a 0.0.7+ (unchanged
 *     through 0.0.10) expired, non-refreshable login. Real `fx acp` would fail this at
 *     `initialize` with fx's own raw -32600 anyway (see fx-acp.ts's
 *     `RpcError.rawMessage` passthrough for that same code), so a friendly
 *     pre-flight refusal here is strictly better than letting the run fail
 *     unexplained later. An expired login that's still refreshable
 *     (`auth_refreshable` anything but strict `false` — absent, non-boolean,
 *     or `true`) stays fail-open on purpose: fx may silently refresh the
 *     token on real use (`fx acp`), and this passive probe never attempts a
 *     refresh, so it can't prove the login is actually dead — blocking here
 *     would be a false "logged out" for a session fx would happily revive.
 *
 * This expired-login gate is exempt entirely when `auth` is one of the
 * env-key values (`"AI_GATEWAY_API_KEY"` / `"VERCEL_OIDC_TOKEN"`) — those
 * `auth` values mean the ACTIVE auth mechanism is the env key, not a stored
 * login, so a stale *stored* login must never refuse a run that would
 * authenticate via the key. Whether fx even emits `auth_expired` alongside
 * env-key auth is unobserved (these fields were only ever seen on real `fx
 * login` accounts, never on an env-key-authenticated probe), and the gate
 * deliberately exempts them anyway so the long-standing guarantee "a
 * key-authenticated user is never gated out here" stays literally true. The
 * expired-login gate thus applies only to login-style `auth` values (e.g.
 * `"fx login"`, provider subscription logins like `"fx login codex"`).
 *
 * Empirically verified auth values (real fx binary, v0.0.6 and v0.0.7 —
 * `HOME` pointed at an empty dir so no ambient credentials leak in): no
 * credentials at all → `auth:"missing"` + `auth_help`; `AI_GATEWAY_API_KEY`
 * set → `auth:"AI_GATEWAY_API_KEY"`; `VERCEL_OIDC_TOKEN` set → `auth:
 * "VERCEL_OIDC_TOKEN"` — i.e. env-var auth IS reflected in the probe's
 * output, and since this probe runs with the same `harnessEnv(harness)` a
 * real spawn uses, a key-authenticated user is never gated out here. The
 * probe writes no files.
 *
 * 0.0.7 additions (verified 2026-08-31 against a live fx 0.0.7 binary, build
 * cef08aa0f178, real logged-in account): `status --json` gained an
 * always-present `mcp:{connection_check,servers,configuration_issues,
 * inspection_error}` object and `mcp_config_warning` — both purely additive
 * and ignored here by construction (only `auth`, `auth_help`, `auth_expired`,
 * `auth_refreshable` are read, matching every JSON-parsing probe's
 * unknown-fields-are-fine contract) — plus `auth_expired`, `auth_refreshable`,
 * and `team` appearing on real login accounts. Observed live on one such
 * account with an expired session: `auth:"fx login"`, `auth_expired:true`,
 * `auth_refreshable:true`, `team` present — i.e. real accounts do exercise
 * the refreshable branch above, and in that state passive probes (this one
 * included) see the unauthenticated model catalog, which is a separate,
 * already-fail-open concern (`discoverFx`), not this gate's job.
 *
 * Re-verified against fx 0.0.8 (binary probe, 2026-09-08, build_revision
 * 43c11dcc34a9): the `status --json` builder is byte-identical to 0.0.7
 * (`output_contracts.zig`), so nothing above changes. Confirmed facts, not
 * schema changes: `auth_expired` is present in the payload only when `true`
 * (absent — not `false` — on a fresh/non-expired probe) and
 * `mcp_config_warning` only when there's an actual warning, so their absence
 * on a given probe is normal, not evidence of a dropped field. There's a new
 * possible `auth` value, `"host managed"` (a space, not a hyphen), emitted
 * when the fx process runs under `FX_AUTH_MODE=host-managed` (an
 * embedding-host feature) — agetor never sets that var, and if it were ever
 * seen here the existing "every other parseable value ⇒ loggedIn:true"
 * fallthrough already handles it correctly: the embedding host owns
 * credentials in that mode, so there's nothing for this gate to check. The
 * payload carries `build_revision` (0.0.8 measured: `"43c11dcc34a9"`) but no
 * top-level `version` field. The other always-present fields — `kind`,
 * `update_channel`, `build_channel`, `permission_mode`, `workspace`,
 * `history_turns`, `session_permission_grants`, `agent_step_limit`, and the
 * `mcp{connection_check,servers,configuration_issues,inspection_error}`
 * object — are, as before, ignored here by construction.
 *
 * Re-verified through fx 0.0.10 (binary probes of the 0.0.9 and 0.0.10
 * release builds + a full v0.0.8→v0.0.10 source diff, 2026-09-14): the
 * `status --json` builder is still unchanged (the only diff in
 * `output_contracts.zig` across the whole range removed a dead helper) —
 * every field, the `auth` vocabulary, the `auth_help` text, and the
 * fail-open contract above all hold as written. Still no top-level
 * `version` field. `build_revision` reads `"e26e97ec4040"` on 0.0.9 and
 * `"1210c2756ea8"` on 0.0.10 (distinct per build, as expected).
 * `permission_mode` echoes `yolo`/`auto`/`ask` exactly as before,
 * `full-access` still reads back as `yolo`, and an invalid
 * `FX_PERMISSION_MODE` still falls back silently to `auto` (no error) —
 * identical on 0.0.8, 0.0.9, and 0.0.10.
 */
async function probeStatus(bin: string, env: Record<string, string>): Promise<{ loggedIn: boolean | null; authHelp: string | null }> {
  const out = await probeJson(bin, ["status", "--json"], env);
  if (!out) return { loggedIn: null, authHelp: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { loggedIn: null, authHelp: null };
  }

  if (typeof parsed !== "object" || parsed === null) return { loggedIn: null, authHelp: null };
  const record = parsed as Record<string, unknown>;
  const auth = record.auth;
  if (typeof auth !== "string") return { loggedIn: null, authHelp: null };

  if (auth === "missing") {
    const authHelp = record.auth_help;
    return {
      loggedIn: false,
      authHelp: typeof authHelp === "string" ? authHelp : "Run fx login to sign in.",
    };
  }

  // 0.0.7+ (unchanged through 0.0.10): an authenticated-but-expired,
  // non-refreshable login. Strict on both booleans by design — see the doc
  // comment above for why every other combination
  // (absent/non-boolean/`auth_refreshable !== false`) must stay fail-open
  // instead of joining this branch. Env-key auth is exempt from
  // this gate entirely (see the doc comment above) — the active auth
  // mechanism there is the key, not a stored login, so a stale stored login
  // must never refuse a run that would authenticate via the key.
  if (
    auth !== "AI_GATEWAY_API_KEY" &&
    auth !== "VERCEL_OIDC_TOKEN" &&
    record.auth_expired === true &&
    record.auth_refreshable === false
  ) {
    const authHelp = record.auth_help;
    return {
      loggedIn: false,
      authHelp:
        typeof authHelp === "string" ? authHelp : "fx login has expired — run fx login to sign in again.",
    };
  }

  return { loggedIn: true, authHelp: null };
}

async function probeCursorStatus(
  path: string,
  env: Record<string, string>,
): Promise<{ loggedIn: boolean | null; authHelp: string | null }> {
  try {
    const proc = Bun.spawn([path, "status", "--format", "json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...env, NO_COLOR: "1" },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* best effort */
      }
    }, 4000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const parsed = JSON.parse(text) as { isAuthenticated?: boolean; status?: string };
    if (parsed.isAuthenticated === true || parsed.status === "authenticated") {
      return { loggedIn: true, authHelp: null };
    }
    return { loggedIn: false, authHelp: "Run cursor-agent login to sign in." };
  } catch {
    return { loggedIn: null, authHelp: null };
  }
}

type StatusProbeResult = { loggedIn: boolean | null; authHelp: string | null };

const STATUS_CACHE_TTL_MS = 60_000;
const statusCache = new Map<string, { value: StatusProbeResult; expiresAt: number }>();

/**
 * Memoized wrapper around `probeStatus`, keyed by `${harness.id}:${path}` (the
 * resolved binary path, not just the harness id — an alias whose `bin`
 * changes mid-session shouldn't inherit a stale entry keyed only on id).
 * `checkAllHarnesses()` runs every 15s (`App.tsx`'s poll) and, until this
 * cache existed, each tick re-spawned `fx status --json` for every fx
 * harness forever — auth state changes rarely enough that a 60s staleness
 * window is an easy trade for cutting that to one spawn per minute.
 *
 * `freshAuth: true` bypasses the cache read (a user who just ran `fx login`
 * must not be told "still logged out" for up to 60s), but the freshly-probed
 * result is still written back to the cache so the *next* poll tick benefits
 * from it instead of immediately re-probing.
 */
function statusCacheKey(harness: Harness, path: string): string {
  // In-memory only; hash the exact local configuration without exposing it to callers.
  return `${harness.id}:${path}:${Bun.hash(JSON.stringify([harness.home, harness.env]))}`;
}

export function cachedHarnessAuthentication(harness: Harness, now = Date.now()): boolean | null {
  const path = resolveBinPath(resolveBin(harness));
  const row = path ? statusCache.get(statusCacheKey(harness, path)) : undefined;
  return row && row.expiresAt > now ? row.value.loggedIn : null;
}

function readCodexLocalAuth(harness: Harness, env: Record<string, string>): StatusProbeResult {
  if (env.OPENAI_API_KEY?.trim() || (harness.home === null && process.env.OPENAI_API_KEY?.trim())) {
    return { loggedIn: true, authHelp: null };
  }
  const { accessToken } = readCodexToken(harness);
  if (accessToken) return { loggedIn: true, authHelp: null };
  try {
    const authPath = path.join(codexHome(harness), "auth.json");
    if (existsSync(authPath)) {
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) {
        return { loggedIn: true, authHelp: null };
      }
      if (typeof parsed.api_key === "string" && parsed.api_key.trim()) {
        return { loggedIn: true, authHelp: null };
      }
    }
  } catch {
    // ignore malformed auth.json
  }
  if (process.env.AGETOR_CODEX_DRIVER === "fake" && harness.home === null) {
    return { loggedIn: null, authHelp: null };
  }
  return { loggedIn: false, authHelp: "Run codex login to sign in." };
}

function readGeminiLocalAuth(harness: Harness, env: Record<string, string>): StatusProbeResult {
  const effectiveEnv = harness.home === null ? { ...process.env, ...env } : env;
  if (
    effectiveEnv.GEMINI_API_KEY?.trim() ||
    effectiveEnv.GOOGLE_API_KEY?.trim() ||
    effectiveEnv.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  ) {
    return { loggedIn: true, authHelp: null };
  }
  const baseHome = harness.home ?? homedir();
  const oauthPath = path.join(baseHome, ".gemini", "oauth_creds.json");
  try {
    if (existsSync(oauthPath)) {
      const parsed = JSON.parse(readFileSync(oauthPath, "utf8")) as Record<string, unknown>;
      if (
        (typeof parsed.access_token === "string" && parsed.access_token.trim()) ||
        (typeof parsed.refresh_token === "string" && parsed.refresh_token.trim())
      ) {
        return { loggedIn: true, authHelp: null };
      }
    }
  } catch {
    // ignore
  }
  return { loggedIn: null, authHelp: null };
}

function readAntigravityLocalAuth(harness: Harness, env: Record<string, string>): StatusProbeResult {
  const effectiveEnv = harness.home === null ? { ...process.env, ...env } : env;
  if (effectiveEnv.GEMINI_API_KEY?.trim() || effectiveEnv.GOOGLE_API_KEY?.trim()) {
    return { loggedIn: true, authHelp: null };
  }
  const baseHome = harness.home ?? homedir();
  const statePath = path.join(baseHome, ".gemini", "antigravity", "antigravity_state.pbtxt");
  try {
    if (existsSync(statePath)) {
      const text = readFileSync(statePath, "utf8");
      if (
        /agent_onboarding_completed\s*:\s*true/i.test(text) ||
        /\buids\s*:\s*"[^"]+"/.test(text)
      ) {
        return { loggedIn: true, authHelp: null };
      }
    }
  } catch {
    // ignore
  }
  if (harness.home === null) {
    const dbPath = path.join(
      homedir(),
      "Library",
      "Application Support",
      "Antigravity",
      "User",
      "globalStorage",
      "state.vscdb",
    );
    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db
            .query("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")
            .get() as { value?: string } | null;
          if (row?.value && row.value !== "null" && row.value !== "{}" && row.value.trim().length > 2) {
            return { loggedIn: true, authHelp: null };
          }
        } finally {
          db.close();
        }
      } catch {
        // ignore locked/unreadable IDE db
      }
    }
  }
  return { loggedIn: null, authHelp: null };
}

async function probeAntigravityModelsAuth(
  binPath: string,
  env: Record<string, string>,
): Promise<StatusProbeResult> {
  try {
    const proc = Bun.spawn([binPath, "models"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env, NO_COLOR: "1" },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 5000);
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (exitCode === 0 && /\b(?:gemini|claude|gpt)-/i.test(stdout)) {
      return { loggedIn: true, authHelp: null };
    }
    return { loggedIn: null, authHelp: null };
  } catch {
    return { loggedIn: null, authHelp: null };
  }
}

function readCustomLocalAuth(harness: Harness, env: Record<string, string>): StatusProbeResult {
  const sid = (harness.cliConfig?.serviceId ?? "").toLowerCase();
  const idLower = harness.id.toLowerCase();
  const binLower = (harness.bin ?? "").toLowerCase();
  const baseHome = harness.home ?? homedir();
  const effectiveEnv = harness.home === null ? { ...process.env, ...env } : env;

  // DeepSeek (dsh)
  if (sid === "deepseek" || idLower.includes("deepseek") || binLower.endsWith("/dsh") || binLower === "dsh") {
    if (hasDeepSeekLocalCredentials(harness, env)) {
      return { loggedIn: true, authHelp: null };
    }
    return { loggedIn: null, authHelp: null };
  }

  // GitHub Copilot (gh)
  if (sid === "copilot" || idLower.includes("copilot") || binLower === "gh" || binLower.endsWith("/gh")) {
    if (effectiveEnv.GH_TOKEN?.trim() || effectiveEnv.GITHUB_TOKEN?.trim()) {
      return { loggedIn: true, authHelp: null };
    }
    const hostsPath = path.join(baseHome, ".config", "gh", "hosts.yml");
    try {
      if (existsSync(hostsPath)) {
        const raw = readFileSync(hostsPath, "utf8");
        if (/\b(?:oauth_token|user)\s*:\s*[^\s]+/.test(raw)) {
          return { loggedIn: true, authHelp: null };
        }
      }
    } catch {
      // ignore
    }
    return { loggedIn: null, authHelp: null };
  }

  // OpenCode
  if (sid === "opencode" || idLower.includes("opencode") || binLower === "opencode" || binLower.endsWith("/opencode")) {
    const authPath = path.join(baseHome, ".local", "share", "opencode", "auth.json");
    try {
      if (existsSync(authPath)) {
        const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
          return { loggedIn: true, authHelp: null };
        }
      }
    } catch {
      // ignore
    }
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]) {
      if (effectiveEnv[key]?.trim()) return { loggedIn: true, authHelp: null };
    }
    return { loggedIn: null, authHelp: null };
  }

  // Generic custom CLI: if user explicitly supplied an API key/token env var on the harness, mark authenticated.
  for (const [k, v] of Object.entries(harness.env)) {
    if (/(?:API_KEY|_TOKEN)$/i.test(k) && typeof v === "string" && v.trim()) {
      return { loggedIn: true, authHelp: null };
    }
  }
  return { loggedIn: null, authHelp: null };
}

async function getCachedStatus(
  harness: Harness,
  binPath: string,
  env: Record<string, string>,
  opts: { freshAuth?: boolean } | undefined,
): Promise<StatusProbeResult> {
  const key = statusCacheKey(harness, binPath);
  if (!opts?.freshAuth) {
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const value =
    harness.kind === "cursor"
      ? await probeCursorStatus(binPath, env)
      : harness.kind === "antigravity"
        ? await probeAntigravityModelsAuth(binPath, env)
        : await probeStatus(binPath, env);
  statusCache.set(key, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return value;
}

const FX_HELP_MARKER = "coding agent";
const FX_WRONG_BINARY_HINT =
  "found a different 'fx' binary (JSON viewer?) — install Vercel fx: curl -fsSL https://fx.sh/setup.sh | bash or set AGETOR_FX_BIN";

/**
 * Resolve an executable name to an absolute path. Absolute paths bypass `$PATH`
 * and are checked for existence directly — `Bun.which` only searches `$PATH`
 * and returns null for absolute paths, which would falsely report a hand-
 * specified `bin` as missing.
 *
 * **Pass `{ PATH: process.env.PATH }` explicitly.** Without it, `Bun.which`
 * uses the PATH snapshot Bun captured at process startup, which on a packaged
 * macOS .app is launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin` — none of
 * `claude` / `codex` / `tmux` live there. `rehydratePath()` (called at boot)
 * mutates `process.env.PATH` to include the user's login-shell PATH, but
 * `Bun.which`'s internal cache won't see the mutation. The options object
 * forces a fresh lookup against whatever we currently have on `process.env`.
 */
export function resolveBinPath(bin: string): string | null {
  if (!bin) return null;
  if (isAbsolute(bin)) return existsSync(bin) ? bin : null;
  return Bun.which(bin, { PATH: buildMacSearchPath(process.env.PATH) });
}

/**
 * claude-code drives its interactive REPL through a per-task tmux session
 * (see `src/bun/claude-tmux.ts`). Without tmux the claude path can't run at
 * all, so we treat its absence the same way we treat a missing claude binary:
 * `available: false` plus an install hint. Codex is unaffected.
 */
const TMUX_INSTALL_HINT = "brew install tmux (macOS) or apt install tmux (Debian/Ubuntu)";

/**
 * Account identity + local usage rollup for a claude-code harness — attached
 * to every status shape (including the unavailable ones: "claude missing but
 * the account dir is logged in" is still useful in Settings). Other kinds
 * get nulls; their auth files are a separate follow-up. Live quota/limit
 * utilization is a separate concern — this is purely the local, historical,
 * no-network token rollup.
 */
function claudeAccountFields(harness: Harness): { account: ClaudeAccount | null; usage: HarnessStatus["usage"] } {
  if (harness.kind !== "claude-code") return { account: null, usage: null };
  const configDir = effectiveClaudeConfigDir(harness.home);
  return { account: readClaudeAccount(configDir), usage: accountUsageSummary(configDir) };
}

/**
 * The last version a real probe read for a resolved executable (Direction 9). A passive screen
 * (Settings, Accounts) must not start a provider CLI, so it can only report what an earlier,
 * explicit check already read. The record is bound to the executable's path, size and mtime: a
 * replaced or upgraded binary is "not checked" again, never the old version.
 */
const probedVersions = new Map<string, { path: string; signature: string; raw: string | null }>();

function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
}

function rememberProbedVersion(harness: Harness, path: string, raw: string | null): void {
  probedVersions.set(harness.id, { path, signature: fileSignature(path), raw });
}

/** What an earlier probe read for this harness's current executable, or `not-checked`. Starts nothing. */
export function lastProbedVersion(harness: Harness, path: string | null): { raw: string | null; state: "read" | "unreadable" | "not-checked" } {
  if (!path) return { raw: null, state: "not-checked" };
  const saved = probedVersions.get(harness.id);
  if (!saved || saved.path !== path || saved.signature !== fileSignature(path)) return { raw: null, state: "not-checked" };
  return { raw: saved.raw, state: saved.raw !== null && /\d+\.\d+\.\d+/.test(saved.raw) ? "read" : "unreadable" };
}

/**
 * An explicit, Owner-initiated version read of one harness's executable (the "Check" button on an
 * account, a launch review). Remembered for passive screens. Never called by opening a screen.
 */
export async function probeHarnessVersion(harness: Harness): Promise<string | null> {
  const path = resolveBinPath(resolveBin(harness));
  if (!path) return null;
  const version = await probeVersion(path, harnessEnv(harness));
  rememberProbedVersion(harness, path, version);
  return version;
}

/**
 * `opts.freshAuth` bypasses the fx auth-status cache (see `getCachedStatus`
 * above) for this one call. Start (`orchestrator.ts`'s `startTask`) passes
 * `{ freshAuth: true }` — a user who just ran `fx login` must not be refused
 * for up to `STATUS_CACHE_TTL_MS` by a stale cached `false`. The 15s
 * `/harnesses` poll can tolerate that staleness for its own purpose (it's
 * just painting a status dot), so it omits the option and reads from cache
 * — but `loggedIn` now has a second consumer: `mergeModelOptions`'s rule 7
 * (`src/shared/model-options.ts`) uses it to decide whether a picker trusts
 * the harness's discovered catalog. A stale cached `false` therefore also
 * transiently collapses the model list to the non-gated curated rows for up
 * to `STATUS_CACHE_TTL_MS` — self-healing on the next post-expiry poll, and
 * never hit by `startTask` itself since that call always passes
 * `freshAuth: true`.
 */
export async function checkHarness(harness: Harness, opts?: { freshAuth?: boolean; probeVersion?: boolean }): Promise<HarnessStatus> {
  const bin = resolveBin(harness);
  if (isCodexProfile(harness) && opts?.freshAuth) {
    try {
      const account = selectedCodexAccount(harness)!;
      const checked = await new CodexProfiles().check(account.id);
      // The profile launch is gated on the model's minimum CLI version like every other launch. A
      // null version here used to read as "unknown" and let a too-old CLI through (Direction 9).
      const profilePath = resolveBinPath(bin);
      const profileVersion = profilePath && opts?.probeVersion !== false ? await probeVersion(profilePath, harnessEnv(harness)) : null;
      if (profilePath && opts?.probeVersion !== false) rememberProbedVersion(harness, profilePath, profileVersion);
      return { harnessId: harness.id, kind: harness.kind, bin, path: profilePath, version: profileVersion,
        available: checked.availability === "ready", loggedIn: checked.authentication === "authenticated",
        reason: checked.availability === "ready" ? null : "Selected Codex profile is unavailable; no default fallback.",
        authHelp: "Check this profile in Settings → Accounts.", installHint: null, account: null, usage: null };
    } catch {
      return { harnessId: harness.id, kind: harness.kind, bin, path: null, version: null, available: false, loggedIn: false,
        reason: "Selected Codex profile is missing or changed; no default fallback.", authHelp: null, installHint: null, account: null, usage: null };
    }
  }
  if (isClaudeProfile(harness)) {
    if (opts?.freshAuth) {
      try {
        const account = selectedClaudeAccount(harness);
        const checked = await new ClaudeProfiles().check(account.id);
        const profilePath = resolveBinPath(bin);
        const profileVersion = profilePath && opts?.probeVersion !== false ? await probeVersion(profilePath, harnessEnv(harness)) : null;
        if (profilePath && opts?.probeVersion !== false) rememberProbedVersion(harness, profilePath, profileVersion);
        return { harnessId: harness.id, kind: harness.kind, bin, path: profilePath, version: profileVersion,
          available: checked.availability === "ready", loggedIn: checked.authentication === "authenticated",
          reason: checked.availability === "ready" ? null : "Selected Claude profile is unavailable; no default fallback.",
          authHelp: "Check this profile in Settings → Accounts.", installHint: null, account: null, usage: null };
      } catch (err) {
        return { harnessId: harness.id, kind: harness.kind, bin, path: null, version: null, available: false, loggedIn: false,
          reason: err instanceof Error ? err.message : "Selected Claude profile is missing or changed; no default fallback.",
          authHelp: null, installHint: null, account: null, usage: null };
      }
    }
    try {
      selectedClaudeAccount(harness);
    } catch (err) {
      return { harnessId: harness.id, kind: harness.kind, bin, path: resolveBinPath(bin), version: null, available: false, loggedIn: null,
        reason: err instanceof Error ? err.message : "Selected Claude profile is unavailable; no default fallback.",
        authHelp: "Check this profile in Settings → Accounts.", installHint: null, account: null, usage: null };
    }
  }
  const path = resolveBinPath(bin);
  const accountFields = claudeAccountFields(harness);
  if (!path) {
    return {
      harnessId: harness.id,
      kind: harness.kind,
      bin,
      available: false,
      path: null,
      version: null,
      reason: `\`${bin}\` not found on PATH`,
      installHint: INSTALL_HINTS[harness.kind],
      loggedIn: null,
      authHelp: null,
      ...accountFields,
    };
  }

  if (harness.kind === "claude-code") {
    const tmuxPath = resolveBinPath(resolveTmuxBin());
    if (!tmuxPath) {
      return {
        harnessId: harness.id,
        kind: harness.kind,
        bin,
        available: false,
        path,
        version: null,
        reason: TMUX_MISSING_REASON,
        installHint: TMUX_INSTALL_HINT,
        loggedIn: null,
        authHelp: null,
        ...accountFields,
      };
    }

    // Note: claude's native-install integrity check (`$HOME/.local/bin/claude`
    // exists) used to require pre-linking into the harness HOME because we
    // re-homed the spawn. Now that we re-home via CLAUDE_CONFIG_DIR instead
    // (HOME stays at the real user home), the integrity check resolves against
    // the system install and always passes — no per-harness symlink needed.
  }

  const version = opts?.probeVersion === false ? null : await probeVersion(path, harnessEnv(harness));
  if (opts?.probeVersion !== false) rememberProbedVersion(harness, path, version);

  // fx-only pre-flight auth state. `available: true` regardless — the binary
  // IS installed and IS Vercel's fx; being logged out is a separate state
  // that startTask gates on separately (see plan doc §3.3 T5), not something
  // this probe reports as unavailable.
  let loggedIn: boolean | null = null;
  let authHelp: string | null = null;

  if (harness.kind === "fx" && version !== null) {
    const env = harnessEnv(harness);
    // Run concurrently, not sequentially: probeStatus doesn't actually depend
    // on probeHelp's outcome to execute (only on whether we end up trusting
    // its result), so serializing them just to preserve read order was
    // costing an extra ~2s worst-case per fx check (3 sequential 2s-budget
    // probes vs. version's 2s + max(help, status)'s 2s = 4s total).
    const [helpOutput, status] = await Promise.all([
      probeHelp(path, env),
      getCachedStatus(harness, path, env, opts),
    ]);
    const looksLikeFx = helpOutput?.toLowerCase().includes(FX_HELP_MARKER) ?? false;
    if (!looksLikeFx) {
      // `status` was still fetched (and cached) above, but this binary isn't
      // confirmed to be Vercel's fx, so its auth state is meaningless here —
      // discarded in favor of the null/null the wrong-binary path always
      // reported.
      return {
        harnessId: harness.id,
        kind: harness.kind,
        bin,
        available: false,
        path,
        version,
        reason: `\`${bin}\` doesn't look like Vercel fx`,
        installHint: FX_WRONG_BINARY_HINT,
        loggedIn: null,
        authHelp: null,
        ...accountFields,
      };
    }

    ({ loggedIn, authHelp } = status);
  }

  if (harness.kind === "cursor" && version !== null) {
    const env = harnessEnv(harness);
    ({ loggedIn, authHelp } = await getCachedStatus(harness, path, env, opts));
  } else if (harness.kind === "codex") {
    ({ loggedIn, authHelp } = readCodexLocalAuth(harness, harnessEnv(harness)));
  } else if (harness.kind === "gemini") {
    ({ loggedIn, authHelp } = readGeminiLocalAuth(harness, harnessEnv(harness)));
  } else if (harness.kind === "antigravity") {
    const env = harnessEnv(harness);
    ({ loggedIn, authHelp } = readAntigravityLocalAuth(harness, env));
    if (loggedIn === null && opts?.freshAuth) {
      ({ loggedIn, authHelp } = await getCachedStatus(harness, path, env, opts));
    }
  } else if (harness.kind === "custom") {
    ({ loggedIn, authHelp } = readCustomLocalAuth(harness, harnessEnv(harness)));
  }

  return {
    harnessId: harness.id,
    kind: harness.kind,
    bin,
    available: true,
    path,
    version,
    reason: null,
    installHint: null,
    loggedIn,
    authHelp,
    ...accountFields,
  };
}

/**
 * Probe every registered harness — built-ins plus user aliases. Used by the
 * `/agents` (legacy) and `/harnesses` (preferred) endpoints. Concurrent;
 * each probe times out independently after VERSION_PROBE_TIMEOUT_MS.
 */
export function checkAllHarnesses(): Promise<HarnessStatus[]> {
  // Passive dashboard reads must not launch Codex, Claude profiles, or arbitrary custom CLIs.
  // Filesystem binary presence is distinct from auth and execution readiness.
  return Promise.all(
    harnesses.list().map((h) =>
      checkHarness(
        h,
        h.kind === "codex" || h.kind === "custom" || isClaudeProfile(h)
          ? { probeVersion: false }
          : undefined,
      ),
    ),
  );
}

// Exposed for tests: clears the fx auth-status memoization (see
// `getCachedStatus`/`statusCache` above) so a test isn't left racing a TTL
// window set by an earlier test's probe against the same harness id + path.
export const __testing = { clearStatusCache: () => statusCache.clear() };

/**
 * Whether the harness's binary resolves on this machine. A local path lookup
 * only: no process is spawned and nothing is probed (FO-ORCH01 recommendations
 * must stay as read-only as the preflight they build on).
 */
export function harnessBinaryPresent(harness: Harness): boolean {
  return resolveBinPath(resolveBin(harness)) !== null;
}
