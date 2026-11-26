import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STUB_BIN,
  isDeniedInheritedEnv,
  isolatedCoreEnv,
  sanitizedParentEnv,
  seedIsolatedHarnessHomes,
  writeFxStubBin,
} from "../../e2e/isolated-env.ts";

/**
 * FO-007B: the environment every e2e core boots with (`e2e/isolated-env.ts`)
 * must keep it away from the developer's real CLIs, accounts and settings —
 * even when the shell running the tests carries overrides that would point
 * the core at them. The integration test boots a real headless core with a
 * poisoned parent env whose overrides all point at tripwire scripts.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "fo007b-isolation-")));
let core: ChildProcess | null = null;

afterAll(() => {
  core?.kill("SIGKILL");
});

describe("isolatedCoreEnv", () => {
  test("drops every FORGEORBIT_/AGETOR_ override, credential and CLI config dir", () => {
    for (const name of [
      "FORGEORBIT_TMUX_BIN", "FORGEORBIT_TMUX_SOCKET", "FORGEORBIT_NOTIFIER_BIN", "FORGEORBIT_API_HOST",
      "AGETOR_CLAUDE_BIN", "AGETOR_CODEX_ARGS", "AGETOR_FAKE_CLAUDE_TODOS",
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "GH_TOKEN", "VERCEL_OIDC_TOKEN",
      "CLAUDE_CONFIG_DIR", "FORGEORBIT_CLAUDE_QA_CONFIG_DIR", "FORGEORBIT_CLAUDE_QA_AUTH_HOME", "FORGEORBIT_CLAUDE_QA_AUTH_HOME_ACCEPTANCE", "CODEX_HOME", "GEMINI_CLI_HOME", "XDG_CONFIG_HOME",
    ]) {
      expect(isDeniedInheritedEnv(name)).toBe(true);
    }
    for (const name of ["PATH", "SHELL", "TMPDIR", "LANG", "USER"]) {
      expect(isDeniedInheritedEnv(name)).toBe(false);
    }
    const env = sanitizedParentEnv({ PATH: "/bin", FORGEORBIT_TMUX_BIN: "/x", OPENAI_API_KEY: "k", HOME: "/Users/me" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/Users/me" });
  });

  test("gives the core its own data dir and HOME, stubs every binary and keeps usage offline", () => {
    const dataDir = path.join(scratch, "unit");
    mkdirSync(dataDir, { recursive: true });
    const env = isolatedCoreEnv({ dataDir, apiPort: 1, apiToken: "t", fxBin: "/fx-stub", extra: { AGETOR_CURSOR_BIN: "/nonexistent" } });
    expect(env.HOME).toBe(path.join(dataDir, "home"));
    expect(existsSync(path.join(dataDir, "home", ".gitconfig"))).toBe(true);
    expect(env.FORGEORBIT_DATA_DIR).toBe(dataDir);
    expect(env.AGETOR_DATA_DIR).toBe(dataDir);
    for (const kind of ["CLAUDE", "CODEX", "GEMINI", "ANTIGRAVITY", "TMUX", "NOTIFIER"]) {
      expect(env[`AGETOR_${kind}_BIN`]).toBe(STUB_BIN);
    }
    expect(env.AGETOR_FX_BIN).toBe("/fx-stub");
    for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
      expect(env[`AGETOR_${kind}_DRIVER`]).toBe("fake");
    }
    expect(env.AGETOR_USAGE_OFFLINE).toBe("1");
    expect(env.AGETOR_DISABLE_UPDATES).toBe("1");
    // A spec's own override is applied last.
    expect(env.AGETOR_CURSOR_BIN).toBe("/nonexistent");
  });
});

function tripwire(dir: string, name: string, log: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`);
  chmodSync(file, 0o755);
  return file;
}

async function waitForHealth(base: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("headless core didn't start");
}

test("a core booted from a poisoned shell never runs a real CLI or reads a real account", async () => {
  const dataDir = path.join(scratch, "core");
  const trapDir = path.join(scratch, "traps");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(trapDir, { recursive: true });
  const log = path.join(scratch, "tripwire.log");
  writeFileSync(log, "");

  // What a developer's shell might carry: overrides that win over the
  // fixture's AGETOR_* stubs, real-account credentials and config dirs.
  const poisoned: Record<string, string> = {
    FORGEORBIT_TMUX_BIN: tripwire(trapDir, "tmux", log),
    FORGEORBIT_NOTIFIER_BIN: tripwire(trapDir, "terminal-notifier", log),
    AGETOR_CODEX_BIN: tripwire(trapDir, "codex", log),
    AGETOR_CLAUDE_BIN: tripwire(trapDir, "claude", log),
    OPENAI_API_KEY: "sk-real-account-key",
    CODEX_HOME: path.join(trapDir, "codex-home"),
    FORGEORBIT_USAGE_OFFLINE: "0",
  };
  const saved = new Map(Object.keys(poisoned).map((name) => [name, process.env[name]]));
  Object.assign(process.env, poisoned);
  let env: Record<string, string>;
  let fxBin: string;
  try {
    fxBin = writeFxStubBin(dataDir);
    const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
    expect(seeded.ok).toBe(true);
    env = isolatedCoreEnv({ dataDir, apiPort: 4677, apiToken: "fo007b-token", fxBin });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  for (const name of Object.keys(poisoned)) {
    if (name.startsWith("AGETOR_")) continue;
    expect(env[name]).toBeUndefined();
  }

  core = spawn("bun", ["src/bun/headless.ts"], { cwd: path.resolve(import.meta.dir, "../.."), env, stdio: "ignore" });
  const base = "http://127.0.0.1:4677";
  await waitForHealth(base);
  const auth = { authorization: "Bearer fo007b-token" };

  // Enable every harness so each one is probed (availability, version,
  // model discovery), then force a usage refresh on each.
  const list = (await (await fetch(`${base}/harnesses`, { headers: auth })).json()) as { harnesses: { id: string; home: string | null }[] };
  for (const harness of list.harnesses) {
    await fetch(`${base}/harnesses/${harness.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(harness.home?.startsWith(path.join(dataDir, "test-accounts"))).toBe(true);
  }
  const statuses = (await (await fetch(`${base}/agents`, { headers: auth })).json()) as { harnessId: string; bin: string; path: string | null }[];
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of statuses) {
    expect([STUB_BIN, fxBin]).toContain(status.bin);
    if (status.path) expect([STUB_BIN, fxBin]).toContain(status.path);
  }
  await fetch(`${base}/agent-models`, { method: "POST", headers: auth });
  for (const harness of list.harnesses) {
    const res = await fetch(`${base}/harnesses/${harness.id}/usage/refresh`, { method: "POST", headers: auth });
    // Offline: no provider is consulted, so there's nothing to report.
    expect(res.status).not.toBe(500);
  }
  await Bun.sleep(500);

  expect(readFileSync(log, "utf8")).toBe("");
}, 60_000);
