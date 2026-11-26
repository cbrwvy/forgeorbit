import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// Exact inert bytes, not merely an executable somewhere under the QA root.
export const NATIVE_QA_STUB = '#!/bin/sh\n# ForgeOrbit QA inert stub v1\ncase "$1" in\n  --version) echo "0.0.0-qa";;\n  --help) echo "QA coding agent stub";;\nesac\nexit 0\n';
const kinds = ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"];
const homes = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "GEMINI_CLI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"];

export function isInsideNativeQaRoot(root: string, value: string | undefined): boolean {
  if (!value || !path.isAbsolute(value)) return false;
  try {
    const realRoot = realpathSync(root);
    let curr = path.resolve(value);
    const tail: string[] = [];
    while (!existsSync(curr) && curr !== path.dirname(curr)) {
      tail.unshift(path.basename(curr));
      curr = path.dirname(curr);
    }
    const realResolved = path.join(realpathSync(curr), ...tail);
    const relative = path.relative(realRoot, realResolved);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}

const PROFILE_ENV = {
  codex: { prefix: "codex-profile-", key: "CODEX_HOME" },
  "claude-code": { prefix: "claude-profile-", key: "CLAUDE_CONFIG_DIR" },
} as const;

/**
 * A stored harness env is empty, or exactly one AccountCore profile binding.
 * The directory must be a private, user-owned, non-symlink subdirectory of the
 * disposable QA home. Any other key, kind, or path is refused.
 */
export function assertStoredQaHarnessEnv(
  root: string,
  home: string,
  row: { id: string; kind: string; env_json: string },
): "empty" | "profile" {
  let parsed: unknown;
  try { parsed = JSON.parse(row.env_json); }
  catch { throw new Error("QA harness env is not JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("QA harness env overrides are forbidden");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return "empty";
  const spec = PROFILE_ENV[row.kind as keyof typeof PROFILE_ENV];
  const [key, value] = entries[0]!;
  if (!spec || entries.length !== 1 || !row.id.startsWith(spec.prefix) || key !== spec.key) {
    throw new Error("QA harness env overrides are forbidden");
  }
  assertDisposableProfileDirectory(root, home, value);
  return "profile";
}

/** Canonical private directory under the disposable home. Not a manifest allow-list. */
export function assertDisposableProfileDirectory(root: string, home: string, value: unknown): void {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("QA profile path is not a disposable directory");
  }
  if (path.normalize(value) !== value) throw new Error("QA profile path is not canonical");
  if (!isInsideNativeQaRoot(root, value) || !isInsideNativeQaRoot(home, value)) {
    throw new Error("QA profile path escapes the disposable home");
  }
  const realHome = realpathSync(home);
  const relative = path.relative(path.resolve(home), path.resolve(value));
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("QA profile path must be a subdirectory of the disposable home");
  }
  let current = path.resolve(home);
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") throw new Error("QA profile path is not canonical");
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("QA profile path contains a symlink or non-directory");
    if (stat.uid !== process.getuid?.()) throw new Error("QA profile path is not owned by this user");
    if (stat.mode & 0o077) throw new Error("QA profile directory is not private");
    if (realpathSync(current) !== path.resolve(current)) throw new Error("QA profile path is not canonical");
  }
  if (realpathSync(value) !== path.resolve(value) || realpathSync(value) === realHome) {
    throw new Error("QA profile path escapes the disposable home");
  }
}

export function assertNativeQaStub(root: string, value: string | undefined): void {
  if (value === "/bin/echo") return;
  if (!isInsideNativeQaRoot(root, value)) throw new Error("QA binary is outside its root");
  const stat = lstatSync(value!);
  if (!stat.isFile() || stat.nlink !== 1 || !(stat.mode & 0o111) || stat.size !== Buffer.byteLength(NATIVE_QA_STUB)
    || readFileSync(value!, "utf8") !== NATIVE_QA_STUB) throw new Error("QA requires an inert audited stub");
}

/** No DB, SDK, shell, CLI or network imports. Checks existing trees without
 * following links. This is a startup safety gate, not an OS sandbox against
 * a malicious same-user process changing paths after validation.
 */
export function assertNativeQaEnvironment(root: string, env: NodeJS.ProcessEnv): void {
  if (!path.isAbsolute(root) || realpathSync(root) !== path.resolve(root)) throw new Error("QA root must be canonical and absolute");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)
    || rootStat.uid !== process.getuid?.()) throw new Error("QA root must be a private owned directory");
  const inside = (value: string | undefined) => isInsideNativeQaRoot(root, value);
  for (const key of ["HOME", "FORGEORBIT_DATA_DIR", "AGETOR_DATA_DIR", ...homes]) {
    if (!inside(env[key]) || !lstatSync(env[key]!).isDirectory()) throw new Error("QA requires isolated directories");
  }
  if (env.FORGEORBIT_DATA_DIR !== env.AGETOR_DATA_DIR) throw new Error("QA data directories must match");
  if (env.SHELL !== "/bin/sh" || env.AGETOR_USAGE_OFFLINE !== "1" || env.AGETOR_DISABLE_UPDATES !== "1") {
    throw new Error("QA requires controlled shell and offline usage/updates");
  }
  // Bun.spawn without an explicit env can inherit Bun's startup snapshot,
  // rather than a subsequently sanitized process.env. Reject unsafe inputs
  // at the gate as well as constructing the runtime environment below.
  if (env.PATH !== "/usr/bin:/bin:/usr/sbin:/sbin") throw new Error("QA requires a controlled startup PATH");
  const allowed = new Set(["HOME", "PATH", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME", "TERM", "PWD", "_", "SHLVL",
    "LD_LIBRARY_PATH", "FORGEORBIT_DATA_DIR", "AGETOR_DATA_DIR", "FORGEORBIT_API_PORT", "AGETOR_API_PORT",
    "AGETOR_USAGE_OFFLINE", "FORGEORBIT_USAGE_OFFLINE", "AGETOR_DISABLE_UPDATES", "FORGEORBIT_DISABLE_UPDATES",
    "FNM_DIR", "ZDOTDIR", "FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE", "PLAYWRIGHT_BROWSERS_PATH",
    "FORGEORBIT_EMBEDDING_MODEL_ROOT", ...homes]);
  for (const kind of kinds) allowed.add(`AGETOR_${kind}_DRIVER`);
  allowed.add("AGETOR_FAKE_QC_VERDICT_FILE");
  allowed.add("AGETOR_PROVIDER_FIXTURE_FILE");
  for (const kind of [...kinds, "TMUX", "NOTIFIER", "DISCLAIM"]) {
    allowed.add(`AGETOR_${kind}_BIN`); allowed.add(`FORGEORBIT_${kind}_BIN`);
  }
  if (env.AGETOR_PROVIDER_LIVE_SPAWN !== undefined) throw new Error("QA refuses an environment execution grant");
  if (Object.keys(env).some(key => env[key] !== undefined && !allowed.has(key))) throw new Error("QA refuses inherited environment extensions");
  if (env.LD_LIBRARY_PATH !== undefined && env.LD_LIBRARY_PATH !== ".") throw new Error("QA refuses external native loader paths");
  for (const key of ["FORGEORBIT_USAGE_OFFLINE", "FORGEORBIT_DISABLE_UPDATES"]) {
    if (env[key] !== undefined && env[key] !== "1") throw new Error("Conflicting QA offline override");
  }
  if (env.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE !== undefined && env.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE !== "1") {
    throw new Error("Conflicting QA browser loopback override");
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    if (!path.isAbsolute(env.PLAYWRIGHT_BROWSERS_PATH) || !existsSync(env.PLAYWRIGHT_BROWSERS_PATH)) {
      throw new Error("QA requires a valid absolute PLAYWRIGHT_BROWSERS_PATH");
    }
    if (env.PLAYWRIGHT_BROWSERS_PATH !== root && !inside(env.PLAYWRIGHT_BROWSERS_PATH)) {
      throw new Error("QA refuses external PLAYWRIGHT_BROWSERS_PATH");
    }
  }
  const embeddingRoot = env.FORGEORBIT_EMBEDDING_MODEL_ROOT;
  if (embeddingRoot !== undefined && (embeddingRoot !== path.join(root, "no-models") || existsSync(embeddingRoot))) {
    throw new Error("QA lexical-only mode requires a missing model directory inside the runtime");
  }
  const port = env.FORGEORBIT_API_PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) > 65535 || [4317, 5173].includes(Number(port))
    || env.AGETOR_API_PORT !== port) throw new Error("QA requires an explicit isolated API port");
  for (const kind of kinds) {
    if (env[`AGETOR_${kind}_DRIVER`] !== "fake") throw new Error("QA requires every fake driver");
  }
  for (const key of ["AGETOR_FAKE_QC_VERDICT_FILE", "AGETOR_PROVIDER_FIXTURE_FILE"]) {
    const value = env[key];
    if (value === undefined) continue;
    if (!inside(value)) throw new Error("QA fixture file escapes its root");
    const stat = lstatSync(value);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("QA fixture file must be a regular file");
  }
  for (const kind of [...kinds, "TMUX", "NOTIFIER", "DISCLAIM"]) {
    for (const name of [`AGETOR_${kind}_BIN`, `FORGEORBIT_${kind}_BIN`]) {
      if (name.startsWith("AGETOR_") || env[name] !== undefined) assertNativeQaStub(root, env[name]);
    }
  }
  for (const key of ["FNM_DIR", "ZDOTDIR"]) {
    if (env[key] && !inside(env[key])) throw new Error("External shell directory");
  }
  let remaining = 50_000;
  const inspect = (entry: string) => {
    if (--remaining < 0) throw new Error("QA tree too large to audit");
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink() || !inside(entry) || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error("QA tree contains a link or special file");
    }
    if (stat.isDirectory()) for (const name of readdirSync(entry)) inspect(path.join(entry, name));
  };
  for (const entry of new Set([env.HOME!, env.FORGEORBIT_DATA_DIR!, ...homes.map(key => env[key]!)])) inspect(entry);
}

/** Positive allowlist: shell rc hooks, SDK overrides, keys, proxies and
 * provider endpoints from the parent are never propagated to the app.
 */
export function nativeQaRuntimeEnv(root: string, env: NodeJS.ProcessEnv): Record<string, string> {
  assertNativeQaEnvironment(root, env);
  const out: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8" };
  for (const key of ["HOME", "FORGEORBIT_DATA_DIR", "AGETOR_DATA_DIR", "FORGEORBIT_API_PORT", "AGETOR_API_PORT", ...homes]) out[key] = env[key]!;
  for (const kind of kinds) out[`AGETOR_${kind}_DRIVER`] = "fake";
  if (env.AGETOR_FAKE_QC_VERDICT_FILE) out.AGETOR_FAKE_QC_VERDICT_FILE = env.AGETOR_FAKE_QC_VERDICT_FILE;
  if (env.AGETOR_PROVIDER_FIXTURE_FILE) out.AGETOR_PROVIDER_FIXTURE_FILE = env.AGETOR_PROVIDER_FIXTURE_FILE;
  for (const kind of [...kinds, "TMUX", "NOTIFIER", "DISCLAIM"]) out[`AGETOR_${kind}_BIN`] = env[`AGETOR_${kind}_BIN`]!;
  out.AGETOR_USAGE_OFFLINE = out.FORGEORBIT_USAGE_OFFLINE = "1";
  out.AGETOR_DISABLE_UPDATES = out.FORGEORBIT_DISABLE_UPDATES = "1";
  if (env.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE === "1") {
    out.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE = "1";
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    out.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (env.FORGEORBIT_EMBEDDING_MODEL_ROOT) out.FORGEORBIT_EMBEDDING_MODEL_ROOT = env.FORGEORBIT_EMBEDDING_MODEL_ROOT;
  out.AGETOR_CLAUDE_ARGS = "";
  // Prevent the optional gh fallback from acquiring an owner's credential.
  out.GITHUB_TOKEN = "qa-inert-token";
  return out;
}
