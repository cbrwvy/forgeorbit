/**
 * FO-P2-005-A-R3 — canonical profile identity, daemon spawn lifecycle, CLI fail-closed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  resolveCoreDiscoveryTarget,
  validateDurableActivationState,
} from "./profile-activation-state.ts";
import { discoverCore } from "../cli/api-client.ts";
import { ensureCore, spawnDaemon, stopDaemon } from "../cli/daemon/supervisor.ts";
import {
  fetchCoreProfileIdentity,
  isPidAlive,
  readCoreCreds,
  writeCoreCreds,
} from "./core-creds.ts";
import { streamSse } from "../cli/sse.ts";
import { ProfileActivationError } from "./profile-activation-errors.ts";
import {
  createSyntheticProfile,
  createVerifiedSnapshot,
  ensureDir,
  isolatedProbeEnv,
  makeRoot,
  restoreCandidate,
  runProbeSync,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const FIXTURE_ROOT = makeRoot("fo-p2-005a-r3-fixture-");
process.env.FORGEORBIT_DATA_DIR = path.join(FIXTURE_ROOT.root, "parent-base");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
ensureDir(process.env.FORGEORBIT_DATA_DIR);

let snapshot: VerifiedSnapshot;

beforeAll(async () => {
  const source = createSyntheticProfile(path.join(FIXTURE_ROOT.root, "source"), {
    tasks: [{ id: "task-valid" }],
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

function daemonEnv(baseDataDir: string, port: number): Record<string, string> {
  return {
    ...isolatedProbeEnv({ baseDataDir }),
    FORGEORBIT_API_PORT: String(port),
    AGETOR_API_PORT: String(port),
    AGETOR_DAEMON_IDLE_MS: "600000",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CURSOR_DRIVER: "fake",
    AGETOR_GEMINI_DRIVER: "fake",
    AGETOR_FX_DRIVER: "fake",
    AGETOR_ANTIGRAVITY_DRIVER: "fake",
    AGETOR_CLAUDE_BIN: "/usr/bin/true",
    AGETOR_CODEX_BIN: "/usr/bin/true",
    AGETOR_CURSOR_BIN: "/usr/bin/true",
    AGETOR_GEMINI_BIN: "/usr/bin/true",
    AGETOR_FX_BIN: "/usr/bin/true",
    AGETOR_TMUX_BIN: "/usr/bin/true",
  };
}

function freshNestedTmpBase(): string {
  return path.join("/tmp", `fo-r3-${crypto.randomUUID()}`, "nested", "base");
}

async function withProcessEnv(
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  await withProcessEnvSync(env, fn);
}

function withProcessEnvSync<T>(
  env: Record<string, string>,
  fn: () => T,
): T {
  const keys = Object.keys(env);
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
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

describe("FO-P2-005-A-R3", () => {
  test("11–12. identity is stable before/after mkdir and macOS /tmp aliases match (10 checks)", () => {
    for (let i = 0; i < 10; i++) {
      const target = path.join("/tmp", `fo-r3-alias-${Date.now()}-${i}`, "nested");
      const before = canonicalizeProfilePath(target);
      ensureDir(target);
      const after = canonicalizeProfilePath(target);
      expect(profileIdentityForPath(before)).toBe(profileIdentityForPath(after));
      if (process.platform === "darwin") {
        expect(after.startsWith("/private/tmp/")).toBe(true);
        expect(profileIdentityForPath(canonicalizeProfilePath(`/tmp/x-${i}`))).toBe(
          profileIdentityForPath(canonicalizeProfilePath(`/private/tmp/x-${i}`)),
        );
      }
      rmSync(path.dirname(target), { recursive: true, force: true });
    }
  });

  test("1–6. fresh nested /tmp daemon start succeeds five times via real CLI spawn", async () => {
    for (let i = 0; i < 5; i++) {
      const scope = makeRoot(`fo-r3-fresh-${i}-`);
      const port = 48_000 + i;
      const base = freshNestedTmpBase();
      const env = daemonEnv(base, port);
      try {
        await withProcessEnv(env, async () => {
          expect(existsSync(base)).toBe(false);
          const expected = resolveCoreDiscoveryTarget(base);
          const core = await spawnDaemon({ dataDir: base, port });
          expect(isPidAlive(core.pid)).toBe(true);
          const identity = await fetchCoreProfileIdentity(core);
          expect(identity).toBe(expected.expectedProfileIdentity);
          const again = await ensureCore({ dataDir: base, port, noDaemon: true });
          expect(again.pid).toBe(core.pid);
          expect(await stopDaemon(base)).toBe(true);
          for (let w = 0; w < 40 && isPidAlive(core.pid); w++) await Bun.sleep(50);
          expect(isPidAlive(core.pid)).toBe(false);
        });
      } finally {
        scope.cleanup();
        try {
          rmSync(path.dirname(path.dirname(base)), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }, 300_000);

  test("7–10. port conflict fails fast and does not leave an owned orphan headless", async () => {
    const scope = makeRoot("fo-r3-orphan-");
    const port = 48_100;
    const base = freshNestedTmpBase();
    const env = daemonEnv(base, port);
    const blocker = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("not agetor") });
    try {
      await withProcessEnv(env, async () => {
        const beforePids = new Set(
          spawnSync("pgrep", ["-f", "forgeorbit/src/bun/headless.ts"], { encoding: "utf8" }).stdout
            .trim()
            .split("\n")
            .filter(Boolean),
        );
        const started = Date.now();
        await expect(spawnDaemon({ dataDir: base, port })).rejects.toThrow(/did not come up/);
        expect(Date.now() - started).toBeLessThan(10_000);
        const afterOut = spawnSync("pgrep", ["-f", "forgeorbit/src/bun/headless.ts"], { encoding: "utf8" }).stdout
          .trim()
          .split("\n")
          .filter(Boolean);
        const newOnes = afterOut.filter((pid) => !beforePids.has(pid));
        expect(newOnes.length).toBe(0);
      });
    } finally {
      blocker.stop(true);
      scope.cleanup();
      try {
        rmSync(path.dirname(path.dirname(base)), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 30_000);

  test("13–16. missing selected restored profile fails closed; missing initial base is allowed", async () => {
    const scope = makeRoot("fo-r3-missing-");
    try {
      const base = ensureDir(path.join(scope.root, "base"));
      createSyntheticProfile(base);
      const candidate = (
        await restoreCandidate({
          snapshot,
          parent: path.join(scope.root, "restores"),
          name: "missing-selected",
        })
      ).destinationPath;
      const env = isolatedProbeEnv({ baseDataDir: base });
      expect(runProbeSync("prepare", env, candidate).exitCode).toBe(0);
      expect(runProbeSync("startup", env).exitCode).toBe(0);
      rmSync(candidate, { recursive: true, force: true });
      expectActivationError(() => validateDurableActivationState({ env }), "ACTIVE_PROFILE_MISSING");
      expect(existsSync(path.join(candidate, "agetor.sqlite"))).toBe(false);

      const firstRunBase = path.join(scope.root, "never-created-base");
      const firstEnv = isolatedProbeEnv({ baseDataDir: firstRunBase });
      const state = validateDurableActivationState({ env: firstEnv });
      expect(state.activeDataDir).toBe(canonicalizeProfilePath(firstRunBase));
      expect(existsSync(firstRunBase)).toBe(false);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("17–19. readCoreCreds preserves activation errors; daemon status is nonzero", () => {
    const scope = makeRoot("fo-r3-creds-");
    try {
      const base = ensureDir(path.join(scope.root, "base"));
      createSyntheticProfile(base);
      const controlDir = ensureDir(activationControlDir(base));
      writePrivateJsonAtomic(journalFilePath(controlDir), {
        version: 1,
        transitionId: crypto.randomUUID(),
        previousTransitionId: null,
        action: "activate",
        state: "preparing",
        candidate: { path: "/tmp/unused", identity: "0".repeat(64) },
        original: { path: canonicalizeProfilePath(base), identity: profileIdentityForPath(base) },
        updatedAt: Date.now(),
        resolvedAt: null,
        error: null,
      });
      const env = isolatedProbeEnv({ baseDataDir: base });
      const readProbe = spawnSync(
        process.execPath,
        [
          "-e",
          `import { readCoreCreds } from ${JSON.stringify(path.join(import.meta.dir, "core-creds.ts"))};
           try { readCoreCreds(); process.exit(0); } catch (e) { console.log((e && e.code) || "ERR"); process.exit(1); }`,
        ],
        { env, encoding: "utf8", timeout: 10_000 },
      );
      expect(readProbe.status).toBe(1);
      expect(readProbe.stdout.trim()).toBe("JOURNAL_CORRUPT");

      const cli = path.join(import.meta.dir, "../cli/index.ts");
      const status = spawnSync(process.execPath, [cli, "daemon", "status", "--json", "--no-daemon"], {
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(status.status).toBe(1);
      const body = JSON.parse(status.stdout) as { activationError?: { code: string } };
      expect(body.activationError?.code).toBe("JOURNAL_CORRUPT");

      writeCoreCreds(
        {
          port: 49999,
          token: "a".repeat(64),
          pid: process.pid,
          kind: "cli-daemon",
          version: "test",
          startedAt: Date.now(),
        },
        base,
      );
      expect(readCoreCreds(base)).not.toBeNull();
    } finally {
      scope.cleanup();
    }
  });

  test("20–22. discoverCore and SSE reject wrong profileIdentity; correct SSE still connects", async () => {
    const scope = makeRoot("fo-r3-sse-");
    const port = 48_200;
    const baseA = ensureDir(path.join(scope.root, "a"));
    createSyntheticProfile(baseA);
    const baseB = ensureDir(path.join(scope.root, "b"));
    createSyntheticProfile(baseB);
    const env = daemonEnv(baseA, port);
    try {
      await withProcessEnv(env, async () => {
        const coreA = await spawnDaemon({ dataDir: baseA, port });
        const wrong = expectedProfileIdentityForActiveDir(baseB);
        expect(await discoverCore(baseA, { expectedProfileIdentity: wrong })).toBeNull();
        for (let i = 0; i < 5; i++) {
          expect(await discoverCore(baseA, { expectedProfileIdentity: wrong })).toBeNull();
        }

        let sseOpened = false;
        const bad = streamSse(
          "/health",
          () => {},
          {
            dataDir: baseB,
            onOpen: () => {
              sseOpened = true;
            },
          },
        );
        await Bun.sleep(800);
        bad.close();
        expect(sseOpened).toBe(false);

        let sseOk = false;
        const good = streamSse(
          "/events",
          () => {},
          {
            dataDir: baseA,
            onOpen: () => {
              sseOk = true;
            },
          },
        );
        await Bun.sleep(800);
        good.close();
        expect(sseOk).toBe(true);
        expect(coreA.pid).toBeTruthy();
        await stopDaemon(baseA);
      });
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("23–26. R2 wrong-daemon guard + controlled activate/rollback still work", async () => {
    for (let i = 0; i < 5; i++) {
      const scope = makeRoot(`fo-r3-wrong-${i}-`);
      const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserve.port!;
      reserve.stop(true);
      try {
        const baseA = ensureDir(path.join(scope.root, "base"));
        createSyntheticProfile(baseA);
        const restored = await restoreCandidate({
          snapshot,
          parent: path.join(scope.root, "restores"),
          name: `r3-${i}`,
        });
        const env = daemonEnv(baseA, port);
        await withProcessEnv(env, async () => {
          const coreA = await spawnDaemon({ dataDir: baseA, port });
          const canonicalB = canonicalizeProfilePath(restored.destinationPath);
          writePrivateJsonAtomic(
            selectionFilePath(ensureDir(activationControlDir(baseA))),
            buildSelection({
              previous: null,
              activeProfilePath: canonicalB,
              activeProfileIdentity: profileIdentityForPath(canonicalB),
              transitionId: crypto.randomUUID(),
              now: Date.now(),
            }),
          );
          await expect(ensureCore({ dataDir: baseA, port: port + 1, noDaemon: true })).rejects.toBeInstanceOf(
            ProfileActivationError,
          );
          const still = await discoverCore(baseA, {
            expectedProfileIdentity: expectedProfileIdentityForActiveDir(baseA),
          });
          expect(still?.pid).toBe(coreA.pid);
          try {
            await fetch(`http://127.0.0.1:${coreA.port}/daemon/shutdown`, {
              method: "POST",
              headers: { authorization: `Bearer ${coreA.token}` },
            });
          } catch {
            /* expected while the core exits */
          }
          for (let w = 0; w < 40 && isPidAlive(coreA.pid); w++) await Bun.sleep(50);
        });
      } finally {
        scope.cleanup();
      }
    }

    const scope = makeRoot("fo-r3-rollback-");
    try {
      const base = ensureDir(path.join(scope.root, "base"));
      createSyntheticProfile(base);
      const candidate = (
        await restoreCandidate({
          snapshot,
          parent: path.join(scope.root, "restores"),
          name: "rollback",
        })
      ).destinationPath;
      const env = isolatedProbeEnv({ baseDataDir: base });
      expect(runProbeSync("prepare", env, candidate).exitCode).toBe(0);
      expect(runProbeSync("startup", env).exitCode).toBe(0);
      expect(runProbeSync("rollback", env).exitCode).toBe(0);
    } finally {
      scope.cleanup();
    }
  }, 300_000);
});
