import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "fo-custom-cli-test-"));
process.env.AGETOR_DATA_DIR = path.join(tempRoot, "data");

const { harnesses, db } = await import("./db.ts");
const { buildCustomCliCommand, spawnCustomCli } = await import("./custom-cli.ts");
const { discoverInstalledClis } = await import("./cli-discovery.ts");
const { buildCommand, buildHarnessTerminalCommand, harnessEnv } = await import("./agents.ts");
const { checkHarness } = await import("./agent-status.ts");
const { minCliVersionError } = await import("./orchestrator.ts");
const { parseArgString, formatArgString, isValidCustomBin } = await import("../shared/custom-cli.ts");

const binDir = path.join(tempRoot, "bin");
const workDir = path.join(tempRoot, "work");
mkdirSync(binDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

function makeScript(name: string, body: string): string {
  const full = path.join(binDir, name);
  writeFileSync(full, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(full, 0o755);
  return full;
}

let echoCli: string;
let stdinCli: string;
let failCli: string;
let slowCli: string;
let noVersionCli: string;

beforeAll(() => {
  echoCli = makeScript(
    "fixture-echo-cli",
    'echo "STDOUT_ARGS:$*"\necho "CUSTOM_ENV:$FO_TEST_ENV"\necho "STDERR_NOTE" >&2',
  );
  stdinCli = makeScript(
    "fixture-stdin-cli",
    'input=$(cat)\necho "STDIN_GOT:$input"',
  );
  failCli = makeScript(
    "fixture-fail-cli",
    'echo "boom error detail" >&2\nexit 7',
  );
  slowCli = makeScript(
    "fixture-slow-cli",
    'echo "started"\nsleep 30\necho "finished"',
  );
  noVersionCli = makeScript(
    "fixture-noversion-cli",
    'if [ "$1" = "--version" ]; then exit 1; fi\necho "RAN_OK:$*"',
  );
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("FO-PROVIDERS-SIMPLIFY01 custom CLI & discovery", () => {
  test("argument string parser handles quotes without shell eval", () => {
    expect(parseArgString('run --flag "hello world" \'single quoted\'')).toEqual([
      "run",
      "--flag",
      "hello world",
      "single quoted",
    ]);
    expect(formatArgString(["run", "--msg", "hello world"])).toBe('run --msg "hello world"');
    expect(isValidCustomBin("opencode")).toBe(true);
    expect(isValidCustomBin("/opt/homebrew/bin/opencode")).toBe(true);
    expect(isValidCustomBin("bad; rm -rf /")).toBe(false);
    expect(isValidCustomBin("./relative-bin")).toBe(false);
  });

  test("registers custom CLI in SQLite (migration 155) without version/model/quota checks", () => {
    const created = harnesses.insert({
      id: "my-fixture-cli",
      kind: "custom",
      label: "My Fixture CLI",
      home: null,
      bin: noVersionCli,
      env: { FO_TEST_ENV: "hello" },
      cliConfig: {
        args: ["run", "--quiet"],
        promptDelivery: "arg",
        promptFlag: "-p",
        interactionMode: "manual",
        defaultModel: "unlisted-model-99",
        modelFlag: "--model",
        effortFlag: "--effort",
        serviceId: "my-fixture",
      },
    });

    expect(created.kind).toBe("custom");
    expect(created.home).toBeNull();
    expect(created.cliConfig?.args).toEqual(["run", "--quiet"]);
    expect(created.cliConfig?.defaultModel).toBe("unlisted-model-99");
    expect(created.cliConfig?.promptFlag).toBe("-p");

    // Existing built-ins remain intact
    expect(harnesses.get("claude-code")).not.toBeNull();
    expect(harnesses.get("codex")).not.toBeNull();

    // Update round-trip
    const updated = harnesses.update("my-fixture-cli", {
      label: "My Fixture CLI v2",
      cliConfig: {
        ...created.cliConfig!,
        promptDelivery: "stdin",
      },
    });
    expect(updated.label).toBe("My Fixture CLI v2");
    expect(updated.cliConfig?.promptDelivery).toBe("stdin");
  });

  test("DeepSeek can be registered as a custom CLI while non-custom aliasing stays refused", () => {
    expect(() =>
      harnesses.insert({ id: "deepseek-dsh", kind: "claude-code", label: "Fake DeepSeek" }),
    ).toThrow(/cannot alias another harness/);

    const dsh = harnesses.insert({
      id: "deepseek",
      kind: "custom",
      label: "DeepSeek",
      home: null,
      bin: echoCli,
      cliConfig: {
        args: ["--profile", "headless"],
        promptDelivery: "arg",
        interactionMode: "manual",
        serviceId: "deepseek",
        homeEnvVar: "DSH_HOME",
        terminalArgs: ["tui"],
      },
    });
    expect(dsh.kind).toBe("custom");
    expect(dsh.cliConfig?.serviceId).toBe("deepseek");
    const termCmd = buildHarnessTerminalCommand(dsh);
    expect(termCmd).toContain("tui");
  });

  test("executes fixture CLI with arguments, model flag, env, and captures stdout/stderr", async () => {
    const h = harnesses.insert({
      id: "echo-runner",
      kind: "custom",
      label: "Echo Runner",
      home: null,
      bin: echoCli,
      env: { FO_TEST_ENV: "orbit-42" },
      cliConfig: {
        args: ["--mode", "test"],
        promptDelivery: "arg",
        promptFlag: "--prompt",
        interactionMode: "automated",
        defaultModel: "mystery-model-x",
        modelFlag: "--model",
      },
    });

    const built = buildCustomCliCommand(h, "fix the bug", { env: harnessEnv(h) });
    expect(built.argv).toEqual([
      echoCli,
      "--mode",
      "test",
      "--model",
      "mystery-model-x",
      "--prompt",
      "fix the bug",
    ]);

    const chunks: Array<{ kind: string; text: string }> = [];
    const proc = spawnCustomCli({
      harness: h,
      prompt: "fix the bug",
      cwd: workDir,
      env: harnessEnv(h),
      onChunk: (kind, text) => chunks.push({ kind, text }),
    });
    const code = await proc.done;
    expect(code).toBe(0);
    const assistantOut = chunks.filter((c) => c.kind === "assistant").map((c) => c.text).join("");
    const stderrOut = chunks.filter((c) => c.kind === "stderr").map((c) => c.text).join("");
    expect(assistantOut).toContain("STDOUT_ARGS:--mode test --model mystery-model-x --prompt fix the bug");
    expect(assistantOut).toContain("CUSTOM_ENV:orbit-42");
    expect(stderrOut).toContain("STDERR_NOTE");
  });

  test("delivers prompt via stdin when promptDelivery === 'stdin'", async () => {
    const h = harnesses.insert({
      id: "stdin-runner",
      kind: "custom",
      label: "Stdin Runner",
      home: null,
      bin: stdinCli,
      cliConfig: {
        args: [],
        promptDelivery: "stdin",
        interactionMode: "automated",
      },
    });

    const chunks: Array<{ kind: string; text: string }> = [];
    const proc = spawnCustomCli({
      harness: h,
      prompt: "hello from stdin",
      cwd: workDir,
      env: harnessEnv(h),
      onChunk: (kind, text) => chunks.push({ kind, text }),
    });
    const code = await proc.done;
    expect(code).toBe(0);
    const out = chunks.filter((c) => c.kind === "assistant").map((c) => c.text).join("");
    expect(out).toContain("STDIN_GOT:hello from stdin");
  });

  test("handles non-zero exit codes and missing binaries honestly", async () => {
    const failing = harnesses.insert({
      id: "fail-runner",
      kind: "custom",
      label: "Fail Runner",
      home: null,
      bin: failCli,
      cliConfig: { args: [], promptDelivery: "arg", interactionMode: "manual" },
    });
    const chunks: Array<{ kind: string; text: string }> = [];
    const proc = spawnCustomCli({
      harness: failing,
      prompt: "test",
      cwd: workDir,
      env: {},
      onChunk: (kind, text) => chunks.push({ kind, text }),
    });
    expect(await proc.done).toBe(7);
    expect(chunks.some((c) => c.kind === "stderr" && c.text.includes("boom error detail"))).toBe(true);

    const missing = harnesses.insert({
      id: "missing-runner",
      kind: "custom",
      label: "Missing Runner",
      home: null,
      bin: "/nonexistent/path/to/fo-missing-cli",
      cliConfig: { args: [], promptDelivery: "arg", interactionMode: "manual" },
    });
    const st = await checkHarness(missing, { probeVersion: true });
    expect(st.available).toBe(false);
  });

  test("stops a running custom CLI process via kill()", async () => {
    const slow = harnesses.insert({
      id: "slow-runner",
      kind: "custom",
      label: "Slow Runner",
      home: null,
      bin: slowCli,
      cliConfig: { args: [], promptDelivery: "arg", interactionMode: "manual" },
    });
    const chunks: Array<{ kind: string; text: string }> = [];
    const proc = spawnCustomCli({
      harness: slow,
      prompt: "wait",
      cwd: workDir,
      env: {},
      onChunk: (kind, text) => chunks.push({ kind, text }),
    });
    await Bun.sleep(150);
    proc.kill();
    const code = await proc.done;
    expect(code).not.toBe(0);
    expect(chunks.some((c) => c.text.includes("stopped by user"))).toBe(true);
  });

  test("unknown/unreadable version does not block checkHarness or minCliVersionError", async () => {
    const h = harnesses.get("my-fixture-cli")!;
    const st = await checkHarness(h, { probeVersion: true });
    expect(st.available).toBe(true);
    expect(st.version).toBeNull();
    expect(await minCliVersionError(h, "any-unknown-model", st)).toBeNull();

    // Even for codex with an unreadable version, minCliVersionError fails open
    const codex = harnesses.get("codex")!;
    const unknownCodexStatus = { ...st, harnessId: "codex", kind: "codex" as const, version: null };
    expect(await minCliVersionError(codex, "gpt-6.1-sol", unknownCodexStatus)).toBeNull();
  });

  test("custom CLI inherits existing login when home is null and isolates when home + homeEnvVar set", () => {
    const inherited = harnesses.get("echo-runner")!;
    expect(harnessEnv(inherited).HOME).toBeUndefined();

    const isolated = harnesses.insert({
      id: "custom-isolated-acct",
      kind: "custom",
      label: "Isolated CLI",
      home: path.join(tempRoot, "alt-home"),
      bin: echoCli,
      cliConfig: {
        args: [],
        promptDelivery: "arg",
        interactionMode: "manual",
        homeEnvVar: "MY_CLI_CONFIG_DIR",
      },
    });
    const env = harnessEnv(isolated);
    expect(env.MY_CLI_CONFIG_DIR).toBe(path.join(tempRoot, "alt-home"));
    expect(env.HOME).toBeUndefined();
    expect(buildCommand(isolated, "hello", {}).cmd[0]).toBe(echoCli);
  });

  test("local CLI discovery finds binaries on PATH and respects manually disabled harnesses", () => {
    const fakePathDir = path.join(tempRoot, "fake-path");
    mkdirSync(fakePathDir, { recursive: true });
    writeFileSync(path.join(fakePathDir, "opencode"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    chmodSync(path.join(fakePathDir, "opencode"), 0o755);

    const disabledCursor = harnesses.get("cursor")!;
    const list = [{ ...disabledCursor, enabled: false }];
    const discovered = discoverInstalledClis(list, { envPath: fakePathDir, home: tempRoot });
    const opencode = discovered.find((d) => d.serviceId === "opencode")!;
    expect(opencode.installed).toBe(true);
    expect(opencode.resolvedPath).toBe(path.join(fakePathDir, "opencode"));

    const cursor = discovered.find((d) => d.serviceId === "cursor")!;
    expect(cursor.explicitlyDisabled).toBe(true);
    expect(cursor.enabled).toBe(false);
    // Discovery never mutates DB to re-enable disabled harnesses
    harnesses.setEnabled("cursor", false);
    discoverInstalledClis(harnesses.list(), { envPath: fakePathDir, home: tempRoot });
    expect(harnesses.get("cursor")?.enabled).toBe(false);
  });
});

// Ensure db handle stays referenced cleanly
void db;
