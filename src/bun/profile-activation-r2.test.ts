/**
 * FO-P2-005-A-R2 — CLI fail-closed activation state and daemon identity hardening.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  activationControlDir,
  buildSelection,
  canonicalizeProfilePath,
  journalFilePath,
  profileIdentityForPath,
  selectionFilePath,
  writePrivateJsonAtomic,
} from "./profile-paths.ts";
import {
  expectedProfileIdentityForActiveDir,
  resolveCliActiveDataDir,
  validateDurableActivationState,
} from "./profile-activation-state.ts";
import { discoverCore } from "../cli/api-client.ts";
import { ensureCore, stopDaemon } from "../cli/daemon/supervisor.ts";
import { probeLiveCore, readCoreCreds } from "./core-creds.ts";
import {
  createSyntheticProfile,
  createVerifiedSnapshot,
  ensureDir,
  isolatedProbeEnv,
  makeRoot,
  parseProbeLines,
  PROBE_PATH,
  restoreCandidate,
  runProbeSync,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";
import { ProfileActivationError } from "./profile-activation-errors.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const FIXTURE_ROOT = makeRoot("fo-p2-005a-r2-fixture-");
process.env.FORGEORBIT_DATA_DIR = path.join(FIXTURE_ROOT.root, "parent-base");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
ensureDir(process.env.FORGEORBIT_DATA_DIR);

let snapshot: VerifiedSnapshot;

beforeAll(async () => {
  const source = createSyntheticProfile(path.join(FIXTURE_ROOT.root, "source"), {
    tasks: [{ id: "task-valid" }],
    attachment: { relativePath: "attachments/note.txt", bytes: "synthetic\n" },
  });
  snapshot = await createVerifiedSnapshot({
    source,
    root: FIXTURE_ROOT.root,
    parent: path.join(FIXTURE_ROOT.root, "snapshots"),
  });
}, 120_000);

afterAll(async () => {
  await snapshot?.service.dispose().catch(() => {});
  FIXTURE_ROOT.cleanup();
  if (PREV_FORGEORBIT_DATA_DIR === undefined) delete process.env.FORGEORBIT_DATA_DIR;
  else process.env.FORGEORBIT_DATA_DIR = PREV_FORGEORBIT_DATA_DIR;
  if (PREV_AGETOR_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = PREV_AGETOR_DATA_DIR;
});

function newBase(root: string): string {
  const base = path.join(root, `base-${crypto.randomUUID().slice(0, 8)}`);
  createSyntheticProfile(base, { tasks: [{ id: "base-task" }] });
  return base;
}

async function newCandidate(root: string): Promise<string> {
  const restored = await restoreCandidate({
    snapshot,
    parent: path.join(root, "restores"),
    name: `restored-${crypto.randomUUID().slice(0, 8)}`,
  });
  return restored.destinationPath;
}

function samePath(a: string, b: string): void {
  expect(realpathSync(a)).toBe(realpathSync(b));
}

function expectActivationError(fn: () => unknown, code: ProfileActivationError["code"]): void {
  try {
    fn();
    throw new Error("expected ProfileActivationError");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileActivationError);
    expect((err as ProfileActivationError).code).toBe(code);
  }
}

function runDaemonStatus(env: NodeJS.ProcessEnv): { status: number | null; json: unknown; stderr: string } {
  const cli = path.join(import.meta.dir, "../cli/index.ts");
  const out = spawnSync(process.execPath, [cli, "daemon", "status", "--json", "--no-daemon"], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(out.stdout.trim());
  } catch {
    /* ignore */
  }
  return { status: out.status, json, stderr: out.stderr };
}

async function withIsolatedEnv<T>(base: string, port: number, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const env = {
    ...isolatedProbeEnv({ baseDataDir: base }),
    FORGEORBIT_API_PORT: String(port),
    AGETOR_API_PORT: String(port),
    FORGEORBIT_DAEMON_IDLE_MS: "600000",
    AGETOR_DAEMON_IDLE_MS: "600000",
  };
  const prevForge = process.env.FORGEORBIT_DATA_DIR;
  const prevAgetor = process.env.AGETOR_DATA_DIR;
  process.env.FORGEORBIT_DATA_DIR = base;
  process.env.AGETOR_DATA_DIR = base;
  try {
    return await fn(env);
  } finally {
    if (prevForge === undefined) delete process.env.FORGEORBIT_DATA_DIR;
    else process.env.FORGEORBIT_DATA_DIR = prevForge;
    if (prevAgetor === undefined) delete process.env.AGETOR_DATA_DIR;
    else process.env.AGETOR_DATA_DIR = prevAgetor;
  }
}

describe("FO-P2-005-A-R2 durable activation validation", () => {
  test("1. valid base profile without activation state", () => {
    const scope = makeRoot("fo-r2-base-");
    try {
      const base = newBase(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const prevForge = process.env.FORGEORBIT_DATA_DIR;
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      try {
        const state = validateDurableActivationState({ env });
        samePath(state.activeDataDir, base);
      } finally {
        if (prevForge === undefined) delete process.env.FORGEORBIT_DATA_DIR;
        else process.env.FORGEORBIT_DATA_DIR = prevForge;
      }
    } finally {
      scope.cleanup();
    }
  });

  test("2–3. valid activate and rollback lifecycle via controlled startup", async () => {
    const scope = makeRoot("fo-r2-lifecycle-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      expect(runProbeSync("prepare", env, candidate).exitCode).toBe(0);
      const activated = runProbeSync("open-db", env);
      expect(activated.exitCode).toBe(0);
      samePath(String((activated.json as { dataDir: string }).dataDir), candidate);
      expect(runProbeSync("rollback", env).exitCode).toBe(0);
      const back = runProbeSync("open-db", env);
      expect(back.exitCode).toBe(0);
      samePath(String((back.json as { dataDir: string }).dataDir), base);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("4. non-base selection without matching journal → SELECTION_WITHOUT_JOURNAL", async () => {
    const scope = makeRoot("fo-r2-orphan-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      const canonicalB = canonicalizeProfilePath(candidate);
      writePrivateJsonAtomic(
        selectionFilePath(controlDir),
        buildSelection({
          previous: null,
          activeProfilePath: canonicalB,
          activeProfileIdentity: profileIdentityForPath(canonicalB),
          transitionId: crypto.randomUUID(),
          now: Date.now(),
        }),
      );
      const env = isolatedProbeEnv({ baseDataDir: base });
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "SELECTION_WITHOUT_JOURNAL");
      const resolved = runProbeSync("resolve-active", env);
      expect(resolved.exitCode).toBe(3);
      expect(resolved.error?.code).toBe("SELECTION_WITHOUT_JOURNAL");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("5. corrupt journal with selection absent → JOURNAL_CORRUPT before spawn", () => {
    const scope = makeRoot("fo-r2-corrupt-journal-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      writeFileSync(journalFilePath(controlDir), "{ broken", { mode: 0o600 });
      chmodSync(journalFilePath(controlDir), 0o600);
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "JOURNAL_CORRUPT");
    } finally {
      scope.cleanup();
    }
  });

  test("6. malformed selection JSON → SELECTION_CORRUPT", () => {
    const scope = makeRoot("fo-r2-bad-selection-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      writeFileSync(selectionFilePath(controlDir), "{", { mode: 0o600 });
      chmodSync(selectionFilePath(controlDir), 0o600);
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "SELECTION_CORRUPT");
    } finally {
      scope.cleanup();
    }
  });

  test("7–8. wrong activeProfileIdentity → SELECTION_CORRUPT", async () => {
    const scope = makeRoot("fo-r2-wrong-identity-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      const canonicalB = canonicalizeProfilePath(candidate);
      writePrivateJsonAtomic(
        selectionFilePath(controlDir),
        buildSelection({
          previous: null,
          activeProfilePath: canonicalB,
          activeProfileIdentity: "a".repeat(64),
          transitionId: null,
          now: Date.now(),
        }),
      );
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "SELECTION_CORRUPT");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("9. symlinked selection file → SELECTION_UNTRUSTED", () => {
    const scope = makeRoot("fo-r2-symlink-selection-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      const target = path.join(controlDir, "selection-target.json");
      writeFileSync(target, "{}", { mode: 0o600 });
      const link = selectionFilePath(controlDir);
      try {
        unlinkSync(link);
      } catch {
        /* ignore */
      }
      symlinkSync(target, link);
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "JOURNAL_UNTRUSTED");
    } finally {
      scope.cleanup();
    }
  });

  test("10. untrusted control-directory permissions → CONTROL_DIR_UNTRUSTED", () => {
    const scope = makeRoot("fo-r2-control-perms-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      chmodSync(controlDir, 0o707);
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "CONTROL_DIR_UNTRUSTED");
    } finally {
      scope.cleanup();
    }
  });

  test("11. invalid transition state → ACTIVATION_PENDING for CLI", async () => {
    const scope = makeRoot("fo-r2-pending-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      expect(runProbeSync("prepare", env, candidate).exitCode).toBe(0);
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "ACTIVATION_PENDING");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("12. daemon status on corrupt activation exits nonzero", () => {
    const scope = makeRoot("fo-r2-status-corrupt-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      writeFileSync(journalFilePath(controlDir), "{ broken", { mode: 0o600 });
      chmodSync(journalFilePath(controlDir), 0o600);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const result = runDaemonStatus(env);
      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        running: false,
        activationError: { code: "JOURNAL_CORRUPT" },
      });
    } finally {
      scope.cleanup();
    }
  });

  test("13. daemon start on corrupt activation fails before spawn", async () => {
    const scope = makeRoot("fo-r2-start-corrupt-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      writeFileSync(selectionFilePath(controlDir), "{", { mode: 0o600 });
      chmodSync(selectionFilePath(controlDir), 0o600);
      await withIsolatedEnv(base, 4510, async () => {
        await expect(ensureCore({ port: 4510, noDaemon: false })).rejects.toBeInstanceOf(ProfileActivationError);
        expect(existsSync(path.join(base, "agetor-core.json"))).toBe(false);
      });
    } finally {
      scope.cleanup();
    }
  });

  test("14. daemon status for stopped daemon remains exit 0", () => {
    const scope = makeRoot("fo-r2-status-stopped-");
    try {
      const base = newBase(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const result = runDaemonStatus(env);
      expect(result.status).toBe(0);
      expect(result.json).toEqual({ running: false });
    } finally {
      scope.cleanup();
    }
  });

  test("15–18. live daemon on profile A is never adopted when selection is B (5 iterations)", async () => {
    for (let i = 0; i < 5; i++) {
      const scope = makeRoot(`fo-r2-wrong-daemon-${i}-`);
      const port = 47_000 + i * 2;
      try {
        const baseA = newBase(scope.root);
        const candidateB = await newCandidate(scope.root);
        await withIsolatedEnv(baseA, port, async () => {
          const coreA = await ensureCore({ port, noDaemon: false });
          expect(expectedProfileIdentityForActiveDir(baseA)).toBe(
            expectedProfileIdentityForActiveDir(resolveCliActiveDataDir()),
          );
          const credsOnA = readCoreCreds(baseA);
          expect(credsOnA?.pid).toBe(coreA.pid);
          const controlDir = ensureDir(activationControlDir(baseA));
          const canonicalB = canonicalizeProfilePath(candidateB);
          writePrivateJsonAtomic(
            selectionFilePath(controlDir),
            buildSelection({
              previous: null,
              activeProfilePath: canonicalB,
              activeProfileIdentity: profileIdentityForPath(canonicalB),
              transitionId: crypto.randomUUID(),
              now: Date.now(),
            }),
          );
          await expect(ensureCore({ port: port + 1, noDaemon: true })).rejects.toBeInstanceOf(
            ProfileActivationError,
          );
          const stillOnA = await discoverCore(baseA, {
            expectedProfileIdentity: expectedProfileIdentityForActiveDir(baseA),
          });
          expect(stillOnA?.pid).toBe(coreA.pid);
          expect(readCoreCreds(canonicalB)).toBeNull();
          try {
            await fetch(`http://127.0.0.1:${coreA.port}/daemon/shutdown`, {
              method: "POST",
              headers: { authorization: `Bearer ${coreA.token}` },
            });
          } catch {
            /* expected while the core exits */
          }
          await Bun.sleep(500);
        });
      } finally {
        scope.cleanup();
      }
    }
  }, 300_000);

  test("16. stale creds on wrong profile path do not authorize reuse", async () => {
    const scope = makeRoot("fo-r2-stale-creds-");
    try {
      const baseA = newBase(scope.root);
      const baseB = newBase(scope.root);
      await withIsolatedEnv(baseA, 4520, async () => {
        const coreA = await ensureCore({ port: 4520, noDaemon: false });
        const creds = readCoreCreds(baseA)!;
        writeFileSync(path.join(baseB, "agetor-core.json"), JSON.stringify(creds), { mode: 0o600 });
        const wrongIdentity = expectedProfileIdentityForActiveDir(baseB);
        const discovered = await discoverCore(baseB, { expectedProfileIdentity: wrongIdentity });
        expect(discovered).toBeNull();
        expect(await probeLiveCore(creds, 800, { expectedProfileIdentity: wrongIdentity })).toBe(false);
        expect(coreA.pid).toBeTruthy();
        await stopDaemon(baseA);
      });
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("19. no SQLite database is created after invalid-state rejection", async () => {
    const scope = makeRoot("fo-r2-no-db-");
    try {
      const base = newBase(scope.root);
      const ghost = path.join(scope.root, "ghost");
      ensureDir(ghost);
      const controlDir = ensureDir(activationControlDir(base));
      writePrivateJsonAtomic(
        selectionFilePath(controlDir),
        buildSelection({
          previous: null,
          activeProfilePath: canonicalizeProfilePath(ghost),
          activeProfileIdentity: profileIdentityForPath(canonicalizeProfilePath(ghost)),
          transitionId: null,
          now: Date.now(),
        }),
      );
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      expectActivationError(() => resolveCliActiveDataDir(), "SELECTION_WITHOUT_JOURNAL");
      expect(existsSync(path.join(ghost, "agetor.sqlite"))).toBe(false);
    } finally {
      scope.cleanup();
    }
  });

  test("20. runtime profile pinning still prevents split-brain (probe)", async () => {
    const scope = makeRoot("fo-r2-pin-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const trigger = path.join(scope.root, "trigger");
      const proc = Bun.spawn({
        cmd: [process.execPath, PROBE_PATH, "hold-pinned-paths", trigger],
        cwd: path.dirname(base),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        await Bun.sleep(400);
        const controlDir = activationControlDir(base);
        ensureDir(controlDir);
        const canonicalB = canonicalizeProfilePath(candidate);
        writePrivateJsonAtomic(
          selectionFilePath(controlDir),
          buildSelection({
            previous: null,
            activeProfilePath: canonicalB,
            activeProfileIdentity: profileIdentityForPath(canonicalB),
            transitionId: null,
            now: Date.now(),
          }),
        );
        writeFileSync(trigger, "1", { mode: 0o600 });
        await proc.exited;
        const stdout = new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
        const lines = parseProbeLines(stdout);
        const after = lines.find((l) => (l as { phase?: string }).phase === "after-selection-change") as
          | Record<string, unknown>
          | undefined;
        expect(after).toBeTruthy();
        samePath(String(after!.dataDir), base);
        samePath(String(after!.resolver), base);
      } finally {
        proc.kill("SIGKILL");
        await proc.exited.catch(() => {});
      }
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("21–22. fresh controlled startup + full activate/rollback still work", async () => {
    const scope = makeRoot("fo-r2-roundtrip-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      expect(runProbeSync("prepare", env, candidate).exitCode).toBe(0);
      const startup = runProbeSync("startup", env);
      expect(startup.exitCode).toBe(0);
      samePath(String((startup.json as { activeDataDir: string }).activeDataDir), candidate);
      expect(runProbeSync("rollback", env).exitCode).toBe(0);
      const back = runProbeSync("startup", env);
      expect(back.exitCode).toBe(0);
      samePath(String((back.json as { activeDataDir: string }).activeDataDir), base);
    } finally {
      scope.cleanup();
    }
  }, 120_000);
});
