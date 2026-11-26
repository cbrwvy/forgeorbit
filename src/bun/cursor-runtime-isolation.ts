/**
 * Isolated Cursor runtime for read-only manager turns (FO-CURSOR02).
 *
 * FO-CURSOR01's one live request failed because the genuine `cursor-agent`
 * atomically rewrites its runtime config
 * (`<config dir>/cli-config.json.<pid>.<uuid>.tmp` → `cli-config.json`) and the
 * campaign's Seatbelt policy (correctly) denied that write against the Owner's
 * real `~/.cursor`. This module gives every manager turn its own disposable
 * Cursor state instead, and enforces the boundary with the macOS kernel
 * sandbox in the real runtime path (not only in a QA wrapper).
 *
 * Locally verified against cursor-agent 2026.10.22-27dcf5f (bundle source,
 * `../cursor-config/dist/paths.js`):
 *   - `CURSOR_CONFIG_DIR` relocates `cli-config.json` (falls back to
 *     `$XDG_CONFIG_HOME/cursor`, then `~/.cursor`).
 *   - `CURSOR_DATA_DIR` relocates `projects/` (workspace trust, chats).
 *   - On macOS the default credential store is the login keychain
 *     (account `cursor-user`, services `cursor-access-token` /
 *     `cursor-refresh-token`), read by spawning `/usr/bin/security`. It is
 *     NOT under the config dir, so redirecting the config dir neither copies
 *     nor exposes tokens. Re-homing `HOME` makes `security` miss the login
 *     keychain (verified: exit 44), so `HOME` stays the real home and only
 *     the two Cursor dirs are redirected.
 *
 * Layout (one exclusive directory directly under macOS's sticky /private/tmp):
 *
 *   <root>/policy.sb   Seatbelt profile (not writable from inside)
 *   <root>/work/       cwd of the turn (empty)
 *   <root>/config/     CURSOR_CONFIG_DIR — cli-config.json lives here
 *   <root>/data/       CURSOR_DATA_DIR
 *   <root>/tmp/        TMPDIR
 *   <root>/cache/      NODE_COMPILE_CACHE, XDG caches
 *   <root>/logs/       ForgeOrbit transport files, opened by the tmux host
 *
 * The CLI runs as
 *   /usr/bin/env -i <explicit env> /usr/bin/sandbox-exec -f policy.sb <node> index.js …
 * inside the tmux pane. `env -i` drops the tmux server's inherited
 * environment, and because the sandbox is applied inside the pane (not to
 * the long-lived tmux server), every child of the CLI inherits it regardless
 * of which process started the tmux server.
 */

import { classifyCursorSandboxProbe, CURSOR_INTERNAL_SANDBOX_BLOCKER } from "../shared/provider-readiness.ts";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const ENV_BIN = "/usr/bin/env";
const CURSOR_TEMP_PARENT = "/private/tmp";
const CURSOR_ROOT_PREFIX = `${CURSOR_TEMP_PARENT}/fo-c-`;
const CURSOR_ROOT_NAME = /^fo-c-[A-Za-z0-9_-]{16}$/;
const CURSOR_IPC_PREFIX_LIMIT = 83;
const CURSOR_IPC_DIRECTORY_LIMIT = 91;
// Darwin's sockaddr_un.sun_path[104]. The verified bundled Node binds
// 104 bytes exactly and returns EINVAL at 105.
export const CURSOR_SOCKET_PATH_LIMIT = 104;
// The IPC layout and worker.sock suffix were verified in this exact bundle.
const VERIFIED_CURSOR_SCRIPT = "943765eeedb4fe5d4ab6d95fc839c3eaf0c070e734577409badb9dea5b0ed293";

/** Harness env keys that would select a different account, credential
 *  store or state location. A harness carrying any of them is refused for
 *  isolated turns rather than silently dropping (which would fall back to
 *  the keychain's default Cursor account). */
export const CURSOR_ACCOUNT_SELECTING_ENV = [
  "HOME",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "XDG_CONFIG_HOME",
  "AGENT_CLI_CREDENTIAL_STORE",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "CURSOR_API_ENDPOINT",
  "CURSOR_API_BASE_URL",
] as const;

/** System binaries the CLI may execute. The CLI is started as its bundled
 *  `node` directly (see `resolveCursorInstall`), so no shell is needed and
 *  none is allowed: bash/zsh/sh, git, rg, the computer-use sidecar,
 *  osascript, open, curl … are all denied `process-exec` by the kernel.
 *  `/usr/bin/security` reads the login-keychain token. */
export const CURSOR_EXEC_ALLOW = [
  "/usr/bin/security",
] as const;

/** Mach services that would let the CLI drive other apps, read the
 *  clipboard or capture the screen (Computer Use–style authority). */
export const CURSOR_DENIED_MACH = [
  "com.apple.coreservices.appleevents",
  "com.apple.pasteboard.1",
  "com.apple.screencaptureui.agent",
  "com.apple.tccd",
  "com.apple.tccd.system",
  "com.apple.windowserver.active",
] as const;

export interface CursorInstall {
  /** Launcher script, symlink resolved (`…/versions/<v>/cursor-agent`). */
  launcher: string;
  /** Version directory holding `node` and `index.js`. */
  versionDir: string;
  /** `…/cursor-agent` root holding every installed version. */
  installRoot: string;
  /** The path the harness resolved (may be a symlink, e.g. ~/.local/bin). */
  entry: string;
  /** Bundled node runtime. */
  node: string;
  /** CLI entry script. */
  script: string;
  /** Whether the launcher passes `--use-system-ca` (it does when the
   *  bundled node supports it and no file credential store is chosen). */
  useSystemCa: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The launcher contract verified on 2026.10.22: it only sets
 *  `CURSOR_INVOKED_AS` / `NODE_COMPILE_CACHE` and execs bundled node on
 *  `index.js`. A launcher that does anything else isn't replicated. */
const LAUNCHER_MARKERS = [
  'NODE_BIN="$SCRIPT_DIR/node"',
  'exec -a "$0" "$NODE_BIN" --use-system-ca "$SCRIPT_DIR/index.js" "$@"',
  'exec -a "$0" "$NODE_BIN" "$SCRIPT_DIR/index.js" "$@"',
];

/** Resolve the real Cursor install behind `bin`. Fails closed unless the
 *  realpath is the known launcher with its bundled `node` + `index.js`. */
export function resolveCursorInstall(
  bin: string,
  which: (name: string) => string | null = (n) => Bun.which(n, { PATH: process.env.PATH }),
  readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): Result<CursorInstall> {
  const entry = path.isAbsolute(bin) ? bin : which(bin);
  if (!entry || !existsSync(entry)) return { ok: false, error: `The Cursor CLI (\`${bin}\`) isn't installed.` };
  let launcher: string;
  try {
    launcher = realpathSync(entry);
  } catch {
    return { ok: false, error: `The Cursor CLI path \`${entry}\` can't be resolved.` };
  }
  const versionDir = path.dirname(launcher);
  const node = path.join(versionDir, "node");
  const script = path.join(versionDir, "index.js");
  if (!existsSync(node) || !existsSync(script)) {
    return { ok: false, error: "The Cursor CLI install layout isn't recognized (no bundled node/index.js), so it can't be sandboxed." };
  }
  let text: string;
  try {
    text = readText(launcher);
  } catch {
    return { ok: false, error: "The Cursor CLI launcher can't be read, so it can't be sandboxed." };
  }
  if (text.length > 16_384 || !LAUNCHER_MARKERS.every((marker) => text.includes(marker))) {
    return { ok: false, error: "This Cursor CLI version's launcher isn't the verified one, so ForgeOrbit can't sandbox it. No turn was sent." };
  }
  const parent = path.dirname(versionDir);
  const installRoot = path.basename(parent) === "versions" ? path.dirname(parent) : versionDir;
  return { ok: true, value: { launcher, versionDir, installRoot, entry, node, script, useSystemCa: true } };
}

export interface CursorRuntimePaths {
  root: string;
  profile: string;
  work: string;
  config: string;
  data: string;
  tmp: string;
  cache: string;
  logs: string;
}

export function cursorRuntimePaths(root: string): CursorRuntimePaths {
  return {
    root,
    profile: path.join(root, "policy.sb"),
    work: path.join(root, "work"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    tmp: path.join(root, "tmp"),
    cache: path.join(root, "cache"),
    logs: path.join(root, "logs"),
  };
}

/**
 * The verified bundle chooses projects, then data, then TMPDIR/.cursor,
 * then /tmp/.cursor. Require the first choice and model its slug and hash
 * truncation exactly. The CLI checks JS lengths, so also check UTF-8 bytes.
 */
export function cursorIpcSocketPath(paths: CursorRuntimePaths): string {
  const projects = path.join(paths.data, "projects");
  const prefixBytes = Buffer.byteLength(projects);
  if (prefixBytes > CURSOR_IPC_PREFIX_LIMIT) {
    throw new Error(`Cursor IPC projects prefix is ${prefixBytes} bytes (limit ${CURSOR_IPC_PREFIX_LIMIT}); refusing IPC fallback.`);
  }
  const slug = paths.work.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const fullDirectory = path.join(projects, slug);
  const directory = fullDirectory.length > CURSOR_IPC_DIRECTORY_LIMIT
    ? `${fullDirectory.slice(0, CURSOR_IPC_PREFIX_LIMIT)}-${createHash("sha256").update(fullDirectory).digest("hex").slice(0, 7)}`
    : fullDirectory;
  const socket = path.join(directory, "worker.sock");
  const bytes = Buffer.byteLength(socket);
  if (bytes > CURSOR_SOCKET_PATH_LIMIT) {
    throw new Error(`Cursor IPC socket path is ${bytes} bytes (limit ${CURSOR_SOCKET_PATH_LIMIT}).`);
  }
  return socket;
}

export interface CursorPolicyInput {
  home: string;
  paths: CursorRuntimePaths;
  install: CursorInstall;
  /** Extra read+write denials (ForgeOrbit data dir, registered projects). */
  protectedPaths: string[];
  /** Network access for the model call. `false` produces an offline policy
   *  used only by deterministic probes. */
  network: boolean;
}

/** SBPL string literal. Paths are ForgeOrbit-generated, but quote anyway. */
function lit(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) throw new Error("control character in sandbox path");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Not created yet: canonicalize the nearest existing parent.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(canonical(parent), path.basename(p));
  }
}

/**
 * The Seatbelt profile. Later rules win in SBPL (verified locally), so each
 * block is "deny broadly, then re-allow narrowly":
 *
 *  - file-write*: denied everywhere except the turn's work/config/data/tmp/
 *    cache dirs and a few device nodes. The Owner's `~/.cursor`, keychain
 *    files, the Cursor install, the ForgeOrbit data dir and every repo are
 *    unwritable.
 *  - file-read-data: denied for all of `/Users`, `/Volumes`, `/private/tmp`,
 *    `/private/var/folders` and each protected path (data dir, projects),
 *    then re-allowed only for the Cursor version dir, the runtime dirs and the
 *    login keychain files `security` must open. SSH keys, provider
 *    credentials, the real `~/.cursor`, ForgeOrbit's SQLite and Brain files
 *    and all repositories are unreadable. Metadata (stat) stays allowed so
 *    path resolution works — a documented residual.
 *  - process-exec: only the bundled node and `/usr/bin/security` — no
 *    shell, git, ripgrep, sidecars, GUI helpers, `/usr/bin/sandbox-exec`,
 *    or the colocated `cursorsandbox` helper. Cursor's own sandbox
 *    availability check is `access(X_OK)` on sandbox-exec. Allowing that
 *    execute does not make `sandbox_apply` succeed once this profile is
 *    already applied, so the helper stays denied and real launches stay
 *    blocked (`cursorRealExecutionBlock`).
 *  - network: outbound TCP for the model API when `network`; Unix IPC is
 *    limited to DNS and the single in-turn socket. No access to the tmux
 *    server, ssh-agent, Docker or another turn.
 *  - mach-lookup: Apple Events, pasteboard, screen capture, TCC and window
 *    server are denied.
 */
export function buildCursorSeatbeltProfile(input: CursorPolicyInput): string {
  const home = canonical(input.home);
  const p = input.paths;
  // These generated paths were checked at creation. Never resolve a
  // replacement symlink into a new sandbox exception.
  const writable = [p.work, p.config, p.data, p.tmp, p.cache];
  const versionDir = canonical(input.install.versionDir);
  const node = canonical(input.install.node);
  const socket = lit(cursorIpcSocketPath(p));
  const protectedPaths = input.protectedPaths.filter(Boolean).map(canonical);
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "",
    ";; Writes: nowhere but this turn's runtime dirs.",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((w) => `(subpath ${lit(w)})`).join(" ")})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/[0-9]+$"))',
    "",
    ";; Reads: no personal, project or temp data outside the runtime.",
    `(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders")${protectedPaths.map((d) => ` (subpath ${lit(d)})`).join("")})`,
    `(allow file-read-data ${[versionDir, ...writable].map((d) => `(subpath ${lit(d)})`).join(" ")})`,
    `(allow file-read-data (subpath ${lit(path.join(home, "Library", "Keychains"))}) (literal ${lit(path.join(home, "Library", "Preferences", "com.apple.security.plist"))}))`,
    "",
    ";; Processes: only the bundled node and the keychain tool. No shell.",
    "(deny process-exec*)",
    `(allow process-exec* (literal ${lit(node)}) ${CURSOR_EXEC_ALLOW.map((b) => `(literal ${lit(b)})`).join(" ")})`,
    "",
    ";; Local IPC: only DNS and this turn's worker socket.",
    "(deny network-outbound (remote unix-socket))",
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    "(deny network-bind network-inbound)",
    input.network ? ";; Outbound TCP stays open for the Cursor API." : "(deny network-outbound)",
    `(allow network-bind network-inbound network-outbound (literal ${socket}))`,
    "",
    ";; No driving other apps, clipboard, screen capture or privacy prompts.",
    `(deny mach-lookup ${CURSOR_DENIED_MACH.map((m) => `(global-name ${lit(m)})`).join(" ")})`,
    "",
  ];
  // Protected paths are already unwritable (global write deny) and their
  // reads are denied before the narrow re-allows above. The runtime root,
  // policy and tmux transport files stay outside the CLI's writable paths.
  return `${lines.join("\n")}\n`;
}

/** The complete environment the CLI sees — nothing is inherited. */
export function cursorRuntimeEnv(paths: CursorRuntimePaths, opts: { home?: string; user?: string } = {}): Record<string, string> {
  const user = opts.user ?? safeUser();
  return {
    HOME: opts.home ?? homedir(),
    USER: user,
    LOGNAME: user,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/bash",
    TMPDIR: `${paths.tmp}/`,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CURSOR_CONFIG_DIR: paths.config,
    CURSOR_DATA_DIR: paths.data,
    NODE_COMPILE_CACHE: path.join(paths.cache, "node-compile-cache"),
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: path.join(paths.data, "state"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "user";
  }
}

export interface CursorRuntime {
  paths: CursorRuntimePaths;
  receipt: CursorRuntimeReceipt;
  install: CursorInstall;
  env: Record<string, string>;
  profileText: string;
  network: boolean;
}

export interface PrepareCursorRuntimeInput {
  /** Optional exact path for tests. Production always allocates under /private/tmp. */
  root?: string;
  /** `resolveBin(harness)`. */
  bin: string;
  /** `harnessEnv(harness)` — checked, never forwarded. */
  harnessEnv?: Record<string, string>;
  /** `harness.home` — additional profiles are refused (no fallback). */
  harnessHome?: string | null;
  protectedPaths: string[];
  network?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  sandboxExec?: string;
  which?: (name: string) => string | null;
}

/** Refusals shared by the turn runner and the readiness probe. */
export function cursorIsolationRefusal(input: Pick<PrepareCursorRuntimeInput, "harnessEnv" | "harnessHome" | "platform" | "sandboxExec">): string | null {
  if ((input.platform ?? process.platform) !== "darwin") {
    return "Isolated Cursor turns need the macOS kernel sandbox; this platform has none, so no turn is sent.";
  }
  if (!existsSync(input.sandboxExec ?? SANDBOX_EXEC)) {
    return "macOS sandbox-exec is missing, so the Cursor turn can't be sandboxed. No turn was sent.";
  }
  if (input.harnessHome) {
    return "This Cursor harness uses a separate profile home. Isolated manager turns only support the signed-in macOS keychain account; set up that profile separately — ForgeOrbit won't fall back to another Cursor account.";
  }
  const bad = Object.keys(input.harnessEnv ?? {}).filter((key) => (CURSOR_ACCOUNT_SELECTING_ENV as readonly string[]).includes(key));
  if (bad.length > 0) {
    return `This Cursor harness sets ${bad.join(", ")}, which would change the account or state location. Isolated manager turns refuse it rather than fall back to another account.`;
  }
  return null;
}

interface CursorRuntimeReceipt {
  root: string;
  dev: string;
  ino: string;
}

function privateDirectory(dir: string) {
  const st = lstatSync(dir, { bigint: true });
  if (!st.isDirectory() || st.uid !== BigInt(process.getuid!()) || (st.mode & 0o777n) !== 0o700n || realpathSync(dir) !== dir) {
    throw new Error("Cursor runtime directory must be canonical, owned by this user and mode 0700.");
  }
  return st;
}

function assertRuntimeParent(parent: string): void {
  if (parent === CURSOR_TEMP_PARENT) {
    const st = lstatSync(parent);
    if (!st.isDirectory() || st.uid !== 0 || !(st.mode & 0o1000) || realpathSync(parent) !== parent) {
      throw new Error("Cursor runtime needs the canonical root-owned sticky /private/tmp directory.");
    }
  } else {
    privateDirectory(parent);
  }
}

function assertRuntimeRoot(receipt: CursorRuntimeReceipt): void {
  assertRuntimeParent(path.dirname(receipt.root));
  const st = privateDirectory(receipt.root);
  if (String(st.dev) !== receipt.dev || String(st.ino) !== receipt.ino) {
    throw new Error("Cursor runtime directory was replaced.");
  }
}

/** Create a fresh runtime. Existing paths (including dangling symlinks) are refused. */
export function prepareCursorRuntime(input: PrepareCursorRuntimeInput): Result<CursorRuntime> {
  const refusal = cursorIsolationRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  const install = resolveCursorInstall(input.bin, input.which);
  if (!install.ok) return install;
  const root = input.root ?? `${CURSOR_ROOT_PREFIX}${randomBytes(12).toString("base64url")}`;
  let receipt: CursorRuntimeReceipt | undefined;
  try {
    if (!path.isAbsolute(root) || path.normalize(root) !== root || root.endsWith("/")) {
      throw new Error("Cursor runtime root must be an absolute, normalized path.");
    }
    assertRuntimeParent(path.dirname(root));
    const paths = cursorRuntimePaths(root);
    cursorIpcSocketPath(paths);
    if (createHash("sha256").update(readFileSync(install.value.script)).digest("hex") !== VERIFIED_CURSOR_SCRIPT) {
      throw new Error("This Cursor CLI bundle has an unverified IPC path layout. No turn was sent.");
    }
    mkdirSync(root, { mode: 0o700 });
    const st = privateDirectory(root);
    receipt = { root, dev: String(st.dev), ino: String(st.ino) };
    for (const dir of [paths.work, paths.config, paths.data, paths.tmp, paths.cache, paths.logs]) {
      mkdirSync(dir, { mode: 0o700 });
      privateDirectory(dir);
    }
    const home = input.home ?? homedir();
    const network = input.network ?? true;
    const profileText = buildCursorSeatbeltProfile({ home, paths, install: install.value, protectedPaths: input.protectedPaths, network });
    writeFileSync(paths.profile, profileText, { mode: 0o400, flag: "wx" });
    return { ok: true, value: { paths, receipt, install: install.value, env: cursorRuntimeEnv(paths, { home }), profileText, network } };
  } catch (error) {
    if (receipt) removeCursorRuntime(receipt);
    return { ok: false, error: `Couldn't prepare the isolated Cursor runtime: ${(error as Error).message}` };
  }
}

/**
 * Wrap a cursor-agent argv (`[bin, …flags]`) for the sandbox. argv[0] is
 * replaced by the verified bundled node + `index.js` (what the launcher
 * itself would exec), so neither PATH nor a shell is involved.
 */
export function wrapCursorArgv(runtime: CursorRuntime, argv: string[]): string[] {
  if (argv.length === 0) throw new Error("empty cursor argv");
  assertRuntimeRoot(runtime.receipt);
  const { work, config, data, tmp, cache, logs, profile } = runtime.paths;
  for (const dir of [work, config, data, tmp, cache, logs]) privateDirectory(dir);
  if (!lstatSync(profile).isFile() || readFileSync(profile, "utf8") !== runtime.profileText) {
    throw new Error("Cursor Seatbelt profile was replaced.");
  }
  // Cursor walks up from cwd looking for .git before deriving the IPC slug.
  // Refuse even a dangling marker. If one appears after this check, the
  // kernel still only allows the socket for the original private work path.
  for (let dir = work; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })) {
      throw new Error("Cursor runtime has an unexpected Git workspace marker. No turn was sent.");
    }
  }
  cursorIpcSocketPath(runtime.paths);
  const envPairs = Object.entries({ ...runtime.env, CURSOR_INVOKED_AS: "cursor-agent" }).map(([k, v]) => `${k}=${v}`);
  const node = [runtime.install.node, ...(runtime.install.useSystemCa ? ["--use-system-ca"] : []), runtime.install.script];
  return [ENV_BIN, "-i", ...envPairs, SANDBOX_EXEC, "-f", runtime.paths.profile, ...node, ...argv.slice(1)];
}

/**
 * Remove only the directory we created. rmSync unlinks symlinks in the
 * tree without traversing them.
 */
export function removeCursorRuntime(receipt: CursorRuntimeReceipt): boolean {
  try {
    assertRuntimeRoot(receipt);
    rmSync(receipt.root, { recursive: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Boot cleanup only accepts a receipt in this app instance's turn scratch. */
export function removeRecordedCursorRuntime(scratch: string): boolean {
  try {
    if (!lstatSync(scratch).isDirectory() || realpathSync(scratch) !== scratch) return false;
    const record = path.join(scratch, "cursor-runtime.json");
    const st = lstatSync(record);
    privateDirectory(scratch);
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o600 || st.size > 512) return false;
    const receipt = JSON.parse(readFileSync(record, "utf8")) as CursorRuntimeReceipt;
    if (path.dirname(receipt.root) !== CURSOR_TEMP_PARENT || !CURSOR_ROOT_NAME.test(path.basename(receipt.root))) return false;
    if (receipt.root !== path.join(CURSOR_TEMP_PARENT, path.basename(receipt.root))) return false;
    return removeCursorRuntime(receipt);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export interface CursorReadinessReport {
  cliInstalled: boolean;
  version: string | null;
  accountAuthenticated: boolean;
  identity: string | null;
  configWritable: boolean;
  /** Outer ForgeOrbit Seatbelt denied the Owner config. Not Cursor's sandbox. */
  sandboxReady: boolean;
  /** Cursor's own sandbox can initialize inside that Seatbelt. */
  runtimeCompatible: boolean;
  /** Real inference has been accepted. This probe never sets this true. */
  realInferenceVerified: false;
  /** True only when runtime compatibility and a real inference both hold. */
  providerReady: boolean;
  internalSandbox: { sandboxExecAccess: string | null; helperPresent: boolean | null; compatible: false };
  blockers: string[];
}

/** Production profiles must not grant Cursor's nested sandbox helper. */
export function cursorProfileGrantsInternalSandbox(profile: string): boolean {
  return profile.includes("/usr/bin/sandbox-exec") || profile.includes("cursorsandbox");
}

/**
 * Deterministically verify Cursor CLI installation, isolated configuration
 * writability, kernel sandbox enforcement, and account authentication.
 *
 * Distinguishes all 5 stages:
 *  - CLI installed
 *  - Account authenticated
 *  - Configuration writable
 *  - Execution sandbox ready
 *  - Provider ready for inference
 *
 * Never runs inference. `providerReady` stays false until Cursor's own
 * sandbox can initialize under this policy and a real inference is accepted.
 * Outer Seatbelt success and Keychain login do not set it.
 */
export async function checkCursorReadiness(opts: {
  bin?: string;
  harnessHome?: string | null;
  harnessEnv?: Record<string, string>;
  protectedPaths?: string[];
  tmpRoot?: string;
} = {}): Promise<CursorReadinessReport> {
  const bin = opts.bin ?? Bun.which("cursor-agent", { PATH: process.env.PATH }) ?? "cursor-agent";
  const blockers: string[] = [];
  const install = resolveCursorInstall(bin);

  if (!install.ok) {
    blockers.push(install.error);
    return {
      cliInstalled: false,
      version: null,
      accountAuthenticated: false,
      identity: null,
      configWritable: false,
      sandboxReady: false,
      runtimeCompatible: false,
      realInferenceVerified: false,
      providerReady: false,
      internalSandbox: { sandboxExecAccess: null, helperPresent: null, compatible: false },
      blockers,
    };
  }

  let version: string | null = null;
  let accountAuthenticated = false;
  let identity: string | null = null;
  let configWritable = false;
  let sandboxReady = false;
  let sandboxExecAccess: string | null = null;
  let helperPresent: boolean | null = null;

  const prep = prepareCursorRuntime({
    root: opts.tmpRoot,
    bin,
    harnessEnv: opts.harnessEnv,
    harnessHome: opts.harnessHome,
    protectedPaths: opts.protectedPaths ?? [homedir()],
    network: false,
  });

  if (!prep.ok) {
    blockers.push(`Sandbox preparation failed: ${prep.error}`);
  } else {
    try {
      // Test config writable (atomic temporary-file-to-config rename)
      const tmpFile = path.join(prep.value.paths.config, "cli-config.json.test.tmp");
      const destFile = path.join(prep.value.paths.config, "cli-config.json");
      writeFileSync(tmpFile, '{"test":true}');
      renameSync(tmpFile, destFile);
      if (existsSync(destFile) && readFileSync(destFile, "utf8").includes('"test":true')) {
        configWritable = true;
      } else {
        blockers.push("Isolated runtime config directory is not writable.");
      }

      // Test sandbox enforcement under kernel sandbox
      const testJs = path.join(prep.value.paths.work, "probe-sb.js");
      const testOut = path.join(prep.value.paths.work, "probe-sb.out");
      const probeScript = `
        const fs = require('node:fs');
        let ownerReadDenied = false;
        let ownerWriteDenied = false;
        try { fs.readFileSync(process.env.HOME + '/.cursor/cli-config.json'); } catch (e) { if (e.code === 'EPERM') ownerReadDenied = true; }
        try { fs.closeSync(fs.openSync(process.env.HOME + '/.cursor/cli-config.json', 'r+')); } catch (e) { if (e.code === 'EPERM') ownerWriteDenied = true; }
        fs.writeFileSync(${JSON.stringify(testOut)}, JSON.stringify({ ownerReadDenied, ownerWriteDenied }));
      `;
      writeFileSync(testJs, probeScript);
      const sbArgv = [
        ENV_BIN,
        "-i",
        ...Object.entries(prep.value.env).map(([k, v]) => `${k}=${v}`),
        SANDBOX_EXEC,
        "-f",
        prep.value.paths.profile,
        prep.value.install.node,
        testJs,
      ];
      const sbProc = Bun.spawnSync(sbArgv, { cwd: prep.value.paths.work, env: {} });
      if (existsSync(testOut)) {
        try {
          const res = JSON.parse(readFileSync(testOut, "utf8"));
          if (res.ownerReadDenied && res.ownerWriteDenied) {
            sandboxReady = true;
          } else {
            blockers.push("Seatbelt policy did not enforce EPERM on owner configuration.");
          }
        } catch {
          blockers.push("Failed to parse sandbox test results.");
        }
      } else {
        blockers.push(`Sandbox test process failed (exit ${sbProc.exitCode}): ${sbProc.stderr.toString().slice(0, 200)}`);
      }
      if (sandboxReady) {
        const helper = path.join(prep.value.install.versionDir, "cursorsandbox");
        const accessOut = path.join(prep.value.paths.work, "sandbox-access.json");
        const accessJs = path.join(prep.value.paths.work, "sandbox-access.js");
        writeFileSync(accessJs, `
          const fs = require("node:fs");
          let access = "ok";
          try { fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK); }
          catch (e) { access = e && e.code ? e.code : "error"; }
          let helperExists = false;
          try { helperExists = fs.existsSync(${JSON.stringify(helper)}); } catch { helperExists = false; }
          fs.writeFileSync(${JSON.stringify(accessOut)}, JSON.stringify({ access, helperExists }));
        `);
        Bun.spawnSync([
          ENV_BIN, "-i",
          ...Object.entries(prep.value.env).map(([k, v]) => `${k}=${v}`),
          SANDBOX_EXEC, "-f", prep.value.paths.profile,
          prep.value.install.node, accessJs,
        ], { cwd: prep.value.paths.work, env: {} });
        if (existsSync(accessOut)) {
          const observed = JSON.parse(readFileSync(accessOut, "utf8")) as { access?: string; helperExists?: boolean };
          sandboxExecAccess = typeof observed.access === "string" ? observed.access : "error";
          helperPresent = observed.helperExists === true;
        } else {
          blockers.push("Could not observe Cursor's sandbox-exec access check.");
        }
        const classified = classifyCursorSandboxProbe({
          sandboxExecAccess: sandboxExecAccess ?? "error",
          nestedApply: "not-attempted",
        });
        blockers.push(classified.reason);
        blockers.push(CURSOR_INTERNAL_SANDBOX_BLOCKER);
        const probeOptions = { cwd: prep.value.paths.work, stdin: "ignore", timeout: 5_000 } as const;
        const versionProc = Bun.spawnSync(wrapCursorArgv(prep.value, [bin, "--version"]), probeOptions);
        if (versionProc.exitCode === 0) version = versionProc.stdout.toString().trim() || null;
        const statusProc = Bun.spawnSync(wrapCursorArgv(prep.value, [bin, "status", "--format", "json"]), probeOptions);
        if (statusProc.exitCode === 0) {
          const parsed = JSON.parse(statusProc.stdout.toString()) as { isAuthenticated?: boolean; userInfo?: { email?: string } };
          accountAuthenticated = parsed.isAuthenticated === true;
          identity = parsed.userInfo?.email ?? null;
          if (!accountAuthenticated) blockers.push("The isolated Cursor CLI could not resolve a complete Keychain login.");
        } else {
          blockers.push(`Isolated Cursor status probe exited with code ${statusProc.exitCode}.`);
        }
      }
    } catch (e) {
      blockers.push(`Sandbox verification error: ${(e as Error).message}`);
    } finally {
      if (!removeCursorRuntime(prep.value.receipt)) blockers.push("Could not clean up the Cursor readiness runtime.");
    }
  }

  const runtimeCompatible = false;
  const providerReady = false;

  return {
    cliInstalled: true,
    version,
    accountAuthenticated,
    identity,
    configWritable,
    sandboxReady,
    runtimeCompatible,
    realInferenceVerified: false,
    providerReady,
    internalSandbox: { sandboxExecAccess, helperPresent, compatible: false },
    blockers,
  };
}
