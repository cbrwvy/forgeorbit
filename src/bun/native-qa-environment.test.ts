import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertNativeQaEnvironment, nativeQaRuntimeEnv, NATIVE_QA_STUB } from "./native-qa-environment.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join("/private/tmp", "fo013a-qa-gate-")));
  const data = path.join(root, "data");
  const home = path.join(data, "home");
  mkdirSync(home, { recursive: true });
  const stub = path.join(root, "stub");
  writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { HOME: home, FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data,
    SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", AGETOR_USAGE_OFFLINE: "1", AGETOR_DISABLE_UPDATES: "1" };
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) env[`AGETOR_${kind}_DRIVER`] = "fake";
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY", "TMUX", "NOTIFIER", "DISCLAIM"]) env[`AGETOR_${kind}_BIN`] = stub;
  env.FORGEORBIT_API_PORT = env.AGETOR_API_PORT = "0";
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "GEMINI_CLI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"]) env[key] = home;
  return { root, data, env };
}

test("a guarded QA build accepts its audited isolated environment", () => {
  const { root, env } = fixture();
  expect(() => assertNativeQaEnvironment(root, env)).not.toThrow();
  expect(() => assertNativeQaEnvironment(root, { ...env, FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE: "1", PLAYWRIGHT_BROWSERS_PATH: root })).not.toThrow();
});

test("browser loopback override and playwright browsers path fail closed on invalid values", () => {
  const { root, env } = fixture();
  expect(() => assertNativeQaEnvironment(root, { ...env, FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE: "0" })).toThrow();
  expect(() => assertNativeQaEnvironment(root, { ...env, PLAYWRIGHT_BROWSERS_PATH: "/nonexistent/path/for/playwright" })).toThrow();
  expect(() => assertNativeQaEnvironment(root, { ...env, PLAYWRIGHT_BROWSERS_PATH: process.cwd() })).toThrow();
});

test("the lexical-only QA pin accepts only the missing model path under its runtime", () => {
  const { root, env } = fixture();
  const pin = path.join(root, "no-models");
  const pinned = { ...env, FORGEORBIT_EMBEDDING_MODEL_ROOT: pin };
  expect(nativeQaRuntimeEnv(root, pinned).FORGEORBIT_EMBEDDING_MODEL_ROOT).toBe(pin);
  expect(() => assertNativeQaEnvironment(root, { ...env, FORGEORBIT_EMBEDDING_MODEL_ROOT: "/tmp/external" })).toThrow();
  mkdirSync(pin);
  expect(() => assertNativeQaEnvironment(root, pinned)).toThrow();
});

test("cold launch, mismatching data roots, live drivers and inherited overrides fail closed", () => {
  const { root, env } = fixture();
  expect(() => assertNativeQaEnvironment(root, {})).toThrow();
  for (const patch of [
    { HOME: "/Users/owner" }, { AGETOR_DATA_DIR: "/tmp/another" },
    { AGETOR_CLAUDE_DRIVER: "real" }, { AGETOR_USAGE_OFFLINE: "0" },
    { AGETOR_DISABLE_UPDATES: "0" }, { SHELL: "/bin/zsh" },
    { FORGEORBIT_TMUX_BIN: "/usr/bin/true" }, { AGETOR_CODEX_BIN: "/usr/bin/true" },
    { CODEX_HOME: "/Users/owner/.codex" },
  ]) expect(() => assertNativeQaEnvironment(root, { ...env, ...patch })).toThrow();
});

test("symlinks and prefix siblings cannot escape the baked QA root", () => {
  const { root, env } = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "fo013a-outside-"));
  const link = path.join(root, "escape");
  symlinkSync(outside, link);
  expect(() => assertNativeQaEnvironment(root, { ...env, HOME: link })).toThrow();
  expect(() => assertNativeQaEnvironment(root, { ...env, HOME: outside })).toThrow();
});

test("a higher-priority offline override cannot enable real usage", () => {
  const { root, env } = fixture();
  expect(() => assertNativeQaEnvironment(root, { ...env, FORGEORBIT_USAGE_OFFLINE: "0" })).toThrow();
});

test("an environment execution grant is refused and a fixture file must stay inside the root", () => {
  const { root, env } = fixture();
  expect(() => assertNativeQaEnvironment(root, { ...env, AGETOR_PROVIDER_LIVE_SPAWN: "authorized" })).toThrow(/environment execution grant/);
  const file = path.join(root, "qc-verdict.txt");
  writeFileSync(file, "PASS");
  expect(nativeQaRuntimeEnv(root, { ...env, AGETOR_FAKE_QC_VERDICT_FILE: file }).AGETOR_FAKE_QC_VERDICT_FILE).toBe(file);
  expect(() => assertNativeQaEnvironment(root, { ...env, AGETOR_PROVIDER_FIXTURE_FILE: "/tmp/outside.json" })).toThrow(/escapes/);
});

test("an arbitrary executable in the root is not an audited stub", () => {
  const { root, env } = fixture();
  writeFileSync(env.AGETOR_CODEX_BIN!, "#!/bin/sh\nexec /usr/bin/curl https://example.invalid\n", { mode: 0o755 });
  expect(() => assertNativeQaEnvironment(root, env)).toThrow();
});

test("nested symlinks in data cannot redirect SQLite before startup", () => {
  const { root, data, env } = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "fo013a-synthetic-outside-"));
  symlinkSync(path.join(outside, "synthetic.sqlite"), path.join(data, "agetor.sqlite"));
  expect(() => assertNativeQaEnvironment(root, env)).toThrow();
});


test("every required value is fail-closed when absent", () => {
  const { root, env } = fixture();
  for (const key of Object.keys(env)) {
    const partial = { ...env }; delete partial[key];
    expect(() => assertNativeQaEnvironment(root, partial)).toThrow();
  }
});

test("startup refuses credentials, shell hooks and SDK overrides before Bun can inherit them", () => {
  const { root, env } = fixture();
  for (const [key, value] of Object.entries({ ENV: "/synthetic/rc", BASH_ENV: "/synthetic/rc", NODE_OPTIONS: "--require=/synthetic/inject", OPENAI_API_KEY: "synthetic-secret-canary", HTTPS_PROXY: "http://synthetic.invalid", PATH: "/external/bin", ELECTROBUN_RPC_PORT: "1", DYLD_INSERT_LIBRARIES: "/synthetic/inject" })) {
    expect(() => nativeQaRuntimeEnv(root, { ...env, [key]: value })).toThrow();
  }
});

test("runtime uses only its positive environment allowlist", () => {
  const { root, env } = fixture();
  const clean = nativeQaRuntimeEnv(root, env);
  expect(clean.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  for (const key of ["ENV", "BASH_ENV", "NODE_OPTIONS", "OPENAI_API_KEY", "HTTPS_PROXY", "ELECTROBUN_RPC_PORT"]) expect(clean[key]).toBeUndefined();
  expect(JSON.stringify(clean)).not.toContain("synthetic-secret-canary");
});
