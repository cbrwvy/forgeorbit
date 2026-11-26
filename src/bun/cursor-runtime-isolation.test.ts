import { describe, expect, test } from "bun:test";
import { classifyCursorSandboxProbe } from "../shared/provider-readiness.ts";
import {
  buildCursorSeatbeltProfile,
  checkCursorReadiness,
  cursorIsolationRefusal,
  cursorProfileGrantsInternalSandbox,
  cursorIpcSocketPath,
  CURSOR_SOCKET_PATH_LIMIT,
  cursorRuntimeEnv,
  cursorRuntimePaths,
  prepareCursorRuntime,
  removeCursorRuntime,
  removeRecordedCursorRuntime,
  resolveCursorInstall,
  wrapCursorArgv,
} from "./cursor-runtime-isolation.ts";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

describe("Cursor Runtime Isolation", () => {
  const home = homedir();
  const testParent = path.join(tmpdir(), "fo-c02-unit-tests");

  function makeTestDir(prefix: string): string {
    mkdirSync(testParent, { recursive: true, mode: 0o700 });
    const dir = path.join(testParent, `${prefix}-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  test("1. Cursor install resolution succeeds for genuine install and fails closed on invalid layouts", () => {
    const realBin = Bun.which("cursor-agent", { PATH: process.env.PATH });
    if (!realBin) throw new Error("cursor-agent must be installed on host");

    const resolved = resolveCursorInstall(realBin);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(existsSync(resolved.value.node)).toBe(true);
    expect(existsSync(resolved.value.script)).toBe(true);
    expect(resolved.value.useSystemCa).toBe(true);

    // Missing binary
    const missing = resolveCursorInstall("/nonexistent/bin/cursor-agent");
    expect(missing.ok).toBe(false);

    // Fake launcher with unexpected content
    const fakeDir = makeTestDir("fake-install");
    const fakeLauncher = path.join(fakeDir, "cursor-agent");
    writeFileSync(fakeLauncher, "#!/bin/bash\necho hijacked\n", { mode: 0o755 });
    writeFileSync(path.join(fakeDir, "node"), "mock", { mode: 0o755 });
    writeFileSync(path.join(fakeDir, "index.js"), "mock");

    const hijacked = resolveCursorInstall(fakeLauncher);
    expect(hijacked.ok).toBe(false);
    if (!hijacked.ok) {
      expect(hijacked.error).toContain("launcher isn't the verified one");
    }

    rmSync(fakeDir, { recursive: true, force: true });
  });

  test("2. Configuration path resolution produces disposable runtime directories", () => {
    const root = "/tmp/fo-turn-xyz";
    const paths = cursorRuntimePaths(root);

    expect(paths.root).toBe(root);
    expect(paths.work).toBe("/tmp/fo-turn-xyz/work");
    expect(paths.config).toBe("/tmp/fo-turn-xyz/config");
    expect(paths.data).toBe("/tmp/fo-turn-xyz/data");
    expect(paths.tmp).toBe("/tmp/fo-turn-xyz/tmp");
    expect(paths.cache).toBe("/tmp/fo-turn-xyz/cache");
    expect(paths.profile).toBe("/tmp/fo-turn-xyz/policy.sb");
  });

  test("3. Seatbelt policy generation denies sensitive access and allows only runtime paths", () => {
    const realBin = Bun.which("cursor-agent", { PATH: process.env.PATH })!;
    const install = resolveCursorInstall(realBin);
    expect(install.ok).toBe(true);
    if (!install.ok) return;

    const paths = cursorRuntimePaths("/tmp/fo-policy-test");
    const policy = buildCursorSeatbeltProfile({
      home: "/Users/testuser",
      paths,
      install: install.value,
      protectedPaths: ["/Users/testuser/Library/Application Support/ForgeOrbit", "/Users/testuser/code/repo"],
      network: false,
    });

    // Write restrictions
    expect(policy).toContain("(deny file-write*)");
    expect(policy).toContain('fo-policy-test/work")');
    expect(policy).toContain('fo-policy-test/config")');
    expect(policy).not.toContain('(allow file-write* (subpath "/Users/testuser/.cursor"))');

    // Read restrictions
    expect(policy).toContain('(deny file-read-data (subpath "/Users") (subpath "/Volumes")');
    expect(policy).toContain('(allow file-read-data (subpath "/Users/testuser/Library/Keychains")');

    // Execution restrictions
    expect(policy).toContain("(deny process-exec*)");
    expect(policy).toContain('(allow process-exec* (literal');
    expect(policy).toContain('(literal "/usr/bin/security")');
    expect(policy).not.toContain('(literal "/bin/bash")');
    expect(policy).not.toContain('(literal "/bin/sh")');

    // Computer Use / Mach restrictions
    expect(policy).toContain('(deny mach-lookup (global-name "com.apple.coreservices.appleevents")');
    expect(policy).toContain('(global-name "com.apple.screencaptureui.agent")');
    expect(policy).toContain('(global-name "com.apple.pasteboard.1")');
  });

  test("4. Runtime environment explicitly overrides sensitive variables", () => {
    const paths = cursorRuntimePaths("/tmp/fo-env-test");
    const env = cursorRuntimeEnv(paths, { home: "/Users/testuser", user: "testuser" });

    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.CURSOR_CONFIG_DIR).toBe("/tmp/fo-env-test/config");
    expect(env.CURSOR_DATA_DIR).toBe("/tmp/fo-env-test/data");
    expect(env.TMPDIR).toBe("/tmp/fo-env-test/tmp/");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.SHELL).toBe("/bin/bash");
  });

  test("fresh runtimes are private and their full IPC paths fit the Darwin budget", () => {
    const first = prepareCursorRuntime({ bin: "cursor-agent", protectedPaths: [], network: false });
    const second = prepareCursorRuntime({ bin: "cursor-agent", protectedPaths: [], network: false });
    try {
      if (!first.ok) throw new Error(first.error);
      if (!second.ok) throw new Error(second.error);
      const { paths, env } = first.value;
      expect(paths.root).not.toBe(second.value.paths.root);
      expect(paths.root).toMatch(/^\/private\/tmp\/fo-c-[\w-]{16}$/);
      for (const dir of [paths.root, paths.work, paths.config, paths.data, paths.tmp, paths.cache, paths.logs]) {
        expect(lstatSync(dir).mode & 0o777).toBe(0o700);
        expect(realpathSync(dir)).toBe(dir);
      }
      expect(env.TMPDIR).toBe(paths.tmp + "/");
      const socket = cursorIpcSocketPath(paths);
      expect(socket.startsWith(path.join(paths.data, "projects") + "/")).toBe(true);
      expect(path.basename(socket)).toBe("worker.sock");
      expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(CURSOR_SOCKET_PATH_LIMIT);

      const longPrefix = cursorRuntimePaths("/private/tmp/" + "ü".repeat(31));
      expect(() => cursorIpcSocketPath(longPrefix)).toThrow("refusing IPC fallback");
      const longSocket = cursorRuntimePaths("/private/tmp/" + "ü".repeat(27));
      expect(() => cursorIpcSocketPath(longSocket)).toThrow("socket path is");
    } finally {
      if (first.ok) expect(removeCursorRuntime(first.value.receipt)).toBe(true);
      if (second.ok) expect(removeCursorRuntime(second.value.receipt)).toBe(true);
    }
  });

  test("collisions, dangling links and noncanonical parents fail closed", () => {
    const parent = realpathSync(mkdtempSync("/private/tmp/fo-c04-test-"));
    try {
      const root = path.join(parent, "collision");
      mkdirSync(root, { mode: 0o700 });
      const sentinel = path.join(root, "sentinel");
      writeFileSync(sentinel, "keep");
      const prepare = (root: string) => prepareCursorRuntime({ root, bin: "cursor-agent", protectedPaths: [] });
      expect(prepare(root)).toMatchObject({ ok: false, error: expect.stringContaining("EEXIST") });
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
      const dangling = path.join(parent, "dangling");
      symlinkSync(path.join(parent, "missing"), dangling);
      expect(prepare(dangling)).toMatchObject({ ok: false, error: expect.stringContaining("EEXIST") });
      expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
      const alias = path.join(parent, "alias");
      symlinkSync(root, alias);
      expect(prepare(path.join(alias, "turn"))).toMatchObject({ ok: false, error: expect.stringContaining("canonical") });
      const overlong = path.join(parent, "ü".repeat(32));
      expect(prepare(overlong)).toMatchObject({ ok: false, error: expect.stringContaining("refusing IPC fallback") });
      expect(existsSync(overlong)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("restart receipts only clean up the original inode and never follow symlinks", () => {
    const prep = prepareCursorRuntime({ bin: "cursor-agent", protectedPaths: [], network: false });
    if (!prep.ok) throw new Error(prep.error);
    const rt = prep.value;
    const scratch = realpathSync(mkdtempSync("/private/tmp/fo-c04-receipt-"));
    const record = path.join(scratch, "cursor-runtime.json");
    const moved = rt.paths.root + "-moved";
    try {
      writeFileSync(record, JSON.stringify(rt.receipt), { mode: 0o600 });
      renameSync(rt.paths.root, moved);
      symlinkSync(scratch, rt.paths.root);
      expect(() => wrapCursorArgv(rt, ["cursor-agent", "--version"])).toThrow("canonical");
      expect(removeRecordedCursorRuntime(scratch)).toBe(false);
      rmSync(rt.paths.root);
      mkdirSync(rt.paths.root, { mode: 0o700 });
      expect(() => wrapCursorArgv(rt, ["cursor-agent", "--version"])).toThrow("replaced");
      expect(removeRecordedCursorRuntime(scratch)).toBe(false);
      rmSync(rt.paths.root, { recursive: true });
      renameSync(moved, rt.paths.root);
      const marker = path.join(rt.paths.root, ".git");
      symlinkSync(path.join(scratch, "missing"), marker);
      expect(() => wrapCursorArgv(rt, ["cursor-agent", "--version"])).toThrow("Git workspace marker");
      rmSync(marker);
      symlinkSync(scratch, path.join(rt.paths.work, "link"));
      expect(removeRecordedCursorRuntime(scratch)).toBe(true);
      expect(existsSync(rt.paths.root)).toBe(false);
      expect(existsSync(record)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
      removeCursorRuntime(rt.receipt);
    }
  });

  test("bounded macOS integration: tmux IPC, sandboxed config writes, denials and offline auth", async () => {
    const { spawnCursorViaTmux } = await import("./cursor-tmux.ts");
    const fixture = realpathSync(mkdtempSync("/private/tmp/fo-c04-fixture-"));
    const protectedFile = path.join(fixture, "protected");
    writeFileSync(protectedFile, "synthetic data");
    const ownerConfig = path.join(home, ".cursor/cli-config.json");
    const before = readFileSync(ownerConfig);
    const beforeMtime = lstatSync(ownerConfig).mtimeMs;
    const prep = prepareCursorRuntime({ bin: "cursor-agent", protectedPaths: [fixture], network: false });
    if (!prep.ok) throw new Error(prep.error);
    const rt = prep.value;
    const socket = cursorIpcSocketPath(rt.paths);
    const otherSocket = path.join(fixture, "other.sock");
    const probe = path.join(rt.paths.work, "probe.cjs");
    const taskId = "iv-" + crypto.randomUUID().slice(0, 8);
    const chunks: string[] = [];
    let handle: Awaited<ReturnType<typeof spawnCursorViaTmux>> | undefined;
    const other = Bun.listen({ unix: otherSocket, socket: { data() {} } });
    try {
      writeFileSync(probe, `
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const net = require("node:net");
        const path = require("node:path");
        const { spawnSync } = require("node:child_process");
        const ep = { code: "EPERM" };
        const config = path.join(process.env.CURSOR_CONFIG_DIR, "cli-config.json");
        const socket = ${JSON.stringify(socket)};
        const protectedFile = ${JSON.stringify(protectedFile)};
        assert.throws(() => fs.readFileSync(protectedFile), ep);
        assert.throws(() => fs.readFileSync(${JSON.stringify(ownerConfig)}), ep);
        assert.throws(() => fs.closeSync(fs.openSync(${JSON.stringify(ownerConfig)}, "r+")), ep);
        assert.throws(() => fs.readdirSync(path.join(process.env.HOME, ".ssh")), ep);
        assert.throws(() => fs.readdirSync(path.join(process.env.HOME, "code")), ep);
        assert.throws(() => fs.readdirSync(path.join(process.env.HOME, "Library/Application Support/ForgeOrbit")), ep);
        assert.throws(() => fs.writeFileSync(protectedFile + ".outside", "x", { flag: "wx" }), ep);
        assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(rt.paths.logs, "forged"))}, "x"), ep);
        assert.equal(spawnSync("/bin/sh", ["-c", "exit 0"]).error?.code, "EPERM");
        const inherited = spawnSync(process.execPath, ["-e", "try { require('node:fs').readFileSync(process.argv[1]); } catch (e) { process.exit(e.code === 'EPERM' ? 42 : 1); }", protectedFile]);
        assert.equal(inherited.status, 42);
        fs.writeFileSync(config + ".tmp", "{}");
        fs.renameSync(config + ".tmp", config);
        assert.equal(fs.readFileSync(config, "utf8"), "{}");
        const listen = (server, pathname) => new Promise((resolve, reject) =>
          server.once("error", reject).listen(pathname, resolve));
        const connect = (pathname) => new Promise((resolve, reject) => {
          net.connect(pathname).once("data", resolve).once("error", reject);
        });
        (async () => {
          await assert.rejects(connect(${JSON.stringify(otherSocket)}), ep);
          await assert.rejects(listen(net.createServer(), path.join(process.env.TMPDIR, "other.sock")), ep);
          fs.mkdirSync(path.dirname(socket), { recursive: true });
          const server = net.createServer(peer => peer.end("ipc ok"));
          await listen(server, socket);
          assert.equal(String(await connect(socket)), "ipc ok");
          await new Promise(resolve => server.close(resolve));
          console.log(JSON.stringify({ type: "result", subtype: "success", result: "fake Cursor probe" }));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `);
      const probeRuntime = { ...rt, install: { ...rt.install, script: probe } };
      handle = await spawnCursorViaTmux({
        taskId, runId: "fo-c04", argv: wrapCursorArgv(probeRuntime, ["cursor-agent"]),
        cwd: rt.paths.work, logDir: rt.paths.logs, env: rt.env, promptText: "local probe",
        onChunk: (stream, data) => chunks.push(`${stream}: ${data}`),
      });
      const timeout = setTimeout(() => handle?.kill(), 4_000);
      try {
        expect(await handle.done, chunks.join("\n")).toBe(0);
      } finally {
        clearTimeout(timeout);
      }
      expect(chunks).toContain("assistant: fake Cursor probe");
      expect(existsSync(path.join(rt.paths.config, "cli-config.json"))).toBe(true);
      const readiness = await checkCursorReadiness();
      expect(readiness).toMatchObject({
        cliInstalled: true, version: "2026.10.22-27dcf5f", accountAuthenticated: true,
        configWritable: true, sandboxReady: true, runtimeCompatible: false,
        realInferenceVerified: false, providerReady: false,
        internalSandbox: { sandboxExecAccess: "EPERM", compatible: false },
      });
      expect(readiness.blockers.join("\n")).toContain("Sandbox mode is enabled but not available");
      const { resolveInterviewIsolation } = await import("./interview-isolation.ts");
      const flags = await resolveInterviewIsolation({
        id: "cursor", kind: "cursor", label: "Cursor", home: null, bin: rt.install.entry, env: {},
        isBuiltin: true, enabled: true,
      }, { noCache: true });
      expect(flags).toMatchObject({ ok: true, isolation: { args: ["--mode", "ask", "--sandbox", "enabled", "--trust"] } });
      expect(readFileSync(ownerConfig).equals(before)).toBe(true);
      expect(lstatSync(ownerConfig).mtimeMs).toBe(beforeMtime);
    } finally {
      handle?.kill();
      other.stop(true);
      expect(removeCursorRuntime(rt.receipt)).toBe(true);
      expect(existsSync(rt.paths.root)).toBe(false);
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 20_000);

  test("8b. Production Seatbelt denies Cursor's sandbox helper, and a nested apply cannot replace it", () => {
    const prep = prepareCursorRuntime({ bin: "cursor-agent", protectedPaths: [], network: false });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    try {
      expect(cursorProfileGrantsInternalSandbox(prep.value.profileText)).toBe(false);
      const probe = path.join(prep.value.paths.work, "access.js");
      const out = path.join(prep.value.paths.work, "access.json");
      writeFileSync(probe, `
        const fs = require("node:fs");
        let access = "ok";
        try { fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK); }
        catch (e) { access = e.code || "error"; }
        fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ access }));
      `);
      const observed = Bun.spawnSync([
        "/usr/bin/sandbox-exec", "-f", prep.value.paths.profile,
        prep.value.install.node, probe,
      ]);
      expect(observed.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).access).toBe("EPERM");
      const widened = prep.value.profileText.replace(
        "(deny process-exec*)",
        `(deny process-exec*)\n(allow process-exec* (literal "/usr/bin/sandbox-exec") (literal "/usr/bin/true"))`,
      );
      const widenedPath = path.join(prep.value.paths.work, "widened.sb");
      writeFileSync(widenedPath, widened);
      const nested = Bun.spawnSync([
        "/usr/bin/sandbox-exec", "-f", widenedPath,
        "/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true",
      ]);
      const nestedErr = `${nested.stderr}\n${nested.stdout}`;
      expect(nested.exitCode).not.toBe(0);
      expect(nestedErr).toContain("sandbox_apply: Operation not permitted");
      expect(classifyCursorSandboxProbe({ sandboxExecAccess: "EPERM", nestedApply: "not-attempted" }).compatible).toBe(false);
      expect(classifyCursorSandboxProbe({ sandboxExecAccess: "ok", nestedApply: "denied" }).compatible).toBe(false);
      expect(classifyCursorSandboxProbe({ sandboxExecAccess: "ok", nestedApply: "applied" }).compatible).toBe(false);
    } finally {
      expect(removeCursorRuntime(prep.value.receipt)).toBe(true);
    }
  });

  test("8. Refusals fail closed on custom profile home or account-selecting env vars", () => {
    // Custom profile home (must be logged in separately; no fallback)
    const customHomeRefusal = cursorIsolationRefusal({
      harnessHome: "/tmp/custom-cursor-home",
    });
    expect(customHomeRefusal).toContain("separate profile home");

    // Account selecting env var
    const envRefusal = cursorIsolationRefusal({
      harnessEnv: { CURSOR_API_KEY: "secret-key" },
    });
    expect(envRefusal).toContain("CURSOR_API_KEY");

    // Linux or other platform
    const platformRefusal = cursorIsolationRefusal({
      platform: "linux",
    });
    expect(platformRefusal).toContain("macOS kernel sandbox");
  });

});
