import { openSync, closeSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { discoverCore, type CoreInfo } from "../api-client.ts";
import { isPidAlive, readCoreCreds, removeCoreCreds, resolveDataDir } from "../../bun/core-creds.ts";
import {
  resolveCoreDiscoveryTarget,
} from "../../bun/profile-activation-state.ts";
import { canonicalizeProfilePath } from "../../bun/profile-paths.ts";
import { ProfileActivationError } from "../../bun/profile-activation-errors.ts";
import { ensurePrivateDataDir } from "../../bun/private-storage.ts";

/**
 * Owns the lifecycle of the shared Agetor "core" from the CLI's side. The core
 * is whoever owns the API port — the desktop app, or a headless cli-daemon the
 * CLI spawns when the app is closed. The daemon shares the same
 * `$AGETOR_DATA_DIR` state, so tasks created from the CLI also appear in the app.
 */
export interface EnsureOptions {
  dataDir?: string;
  /** Override the port a freshly-spawned daemon should bind (default 4317). */
  port?: number;
  /** Fail instead of auto-spawning a daemon when nothing is running. */
  noDaemon?: boolean;
}

function discoveryTarget(opts: EnsureOptions): {
  activeDataDir: string;
  expectedProfileIdentity: string;
} {
  try {
    return resolveCoreDiscoveryTarget(opts.dataDir);
  } catch (err) {
    if (err instanceof ProfileActivationError) throw err;
    throw err;
  }
}

/** Return a live core, spawning a headless daemon if none is running. */
export async function ensureCore(opts: EnsureOptions = {}): Promise<CoreInfo> {
  const { activeDataDir, expectedProfileIdentity } = discoveryTarget(opts);
  const existing = await discoverCore(activeDataDir, { expectedProfileIdentity });
  if (existing) return existing;
  if (opts.noDaemon) {
    throw new Error(
      "No ForgeOrbit core is running. Open the app, run `forgeorbit daemon start`, or drop --no-daemon.",
    );
  }
  return spawnDaemon(opts);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await Bun.sleep(50);
  }
}

/** Graceful shutdown, then SIGTERM/SIGKILL — only for a child this spawn owns. */
async function terminateOwnedSpawn(
  proc: Subprocess,
  activeDataDir: string,
): Promise<void> {
  const childPid = proc.pid;
  if (childPid === undefined || !isPidAlive(childPid)) return;

  const creds = readCoreCreds(activeDataDir);
  if (creds?.pid === childPid) {
    try {
      await fetch(`http://127.0.0.1:${creds.port}/daemon/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${creds.token}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      /* expected while the core exits */
    }
    await waitForPidExit(childPid, 5_000);
  }

  if (isPidAlive(childPid)) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      /* already gone */
    }
    await waitForPidExit(childPid, 3_000);
  }
  if (isPidAlive(childPid)) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForPidExit(childPid, 2_000);
  }

  const after = readCoreCreds(activeDataDir);
  if (after?.pid === childPid) removeCoreCreds(activeDataDir);
}

/** Spawn a detached headless daemon and wait until it's serving. */
export async function spawnDaemon(opts: EnsureOptions = {}): Promise<CoreInfo> {
  const { activeDataDir, expectedProfileIdentity } = discoveryTarget(opts);
  const baseDir = canonicalizeProfilePath(opts.dataDir ?? resolveDataDir());
  ensurePrivateDataDir(activeDataDir);
  // Redirect the daemon's stdout/stderr into the same log it writes lifecycle
  // lines to, so a crash on boot leaves a trace the user can read.
  const logFd = openSync(path.join(activeDataDir, "daemon.log"), "a", 0o600);

  const env: Record<string, string> = {
    ...process.env,
    FORGEORBIT_DATA_DIR: baseDir,
    AGETOR_DATA_DIR: baseDir,
  };
  if (opts.port) {
    env.FORGEORBIT_API_PORT = String(opts.port);
    env.AGETOR_API_PORT = String(opts.port);
  }

  const proc = Bun.spawn(daemonCommand(), {
    env,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  // The child dup'd the log fd; release the parent's copy so the CLI doesn't
  // hold a redundant descriptor for the rest of this invocation.
  closeSync(logFd);

  try {
    const core = await waitForCore(activeDataDir, expectedProfileIdentity, 30_000, proc.pid);
    if (!core) {
      await terminateOwnedSpawn(proc, activeDataDir);
      throw new Error(
        `ForgeOrbit daemon did not come up within 30s — see ${path.join(activeDataDir, "daemon.log")}`,
      );
    }
    proc.unref();
    return core;
  } catch (err) {
    await terminateOwnedSpawn(proc, activeDataDir);
    throw err;
  }
}

/**
 * How to launch the daemon. In a source checkout we run `bun …/headless.ts`; in
 * the compiled standalone binary the `headless.ts` file isn't on disk, so we
 * re-exec ourselves with the hidden `__daemon` subcommand (the binary carries
 * the server stack and boots it lazily — see `src/cli/index.ts`).
 */
function daemonCommand(): string[] {
  const headless = path.resolve(
    fileURLToPath(new URL("../../bun/headless.ts", import.meta.url)),
  );
  if (existsSync(headless)) return [process.execPath, headless];
  return [process.execPath, "__daemon"];
}

async function waitForCore(
  activeDataDir: string,
  expectedProfileIdentity: string,
  timeoutMs: number,
  ownedPid?: number,
): Promise<CoreInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ownedPid !== undefined && !isPidAlive(ownedPid)) return null;
    const core = await discoverCore(activeDataDir, { expectedProfileIdentity });
    if (core) {
      if (ownedPid !== undefined && core.pid !== ownedPid) return null;
      return core;
    }
    await Bun.sleep(150);
  }
  return null;
}

/** Ask a running core to shut down. Returns false if nothing was running. */
export async function stopDaemon(explicitBaseDataDir?: string): Promise<boolean> {
  let activeDataDir: string;
  let expectedIdentity: string;
  try {
    ({ activeDataDir, expectedProfileIdentity: expectedIdentity } = resolveCoreDiscoveryTarget(
      explicitBaseDataDir,
    ));
  } catch (err) {
    if (err instanceof ProfileActivationError) throw err;
    throw err;
  }
  const core = await discoverCore(activeDataDir, { expectedProfileIdentity: expectedIdentity });
  if (!core) return false;
  try {
    await fetch(`http://127.0.0.1:${core.port}/daemon/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${core.token}` },
    });
  } catch {
    /* the core drops the connection as it exits — expected */
  }
  return true;
}
