/**
 * FO-P2-005-A-R1 — runtime profile pin, CLI fail-closed, activation flock guard.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { activationFlockSupported } from "./backup-core.ts";
import {
  activationControlDir,
  buildSelection,
  canonicalizeProfilePath,
  journalFilePath,
  profileIdentityForPath,
  selectionFilePath,
  writePrivateJsonAtomic,
} from "./profile-paths.ts";
import { ensureCore } from "../cli/daemon/supervisor.ts";
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
  startLockHolder,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const FIXTURE_ROOT = makeRoot("fo-p2-005a-r1-fixture-");
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
  expect(canonicalizeProfilePath(a)).toBe(canonicalizeProfilePath(b));
}

function expectPathUnderProfile(stored: string, profileDir: string, leaf: string): void {
  expect(canonicalizeProfilePath(path.resolve(stored))).toBe(
    canonicalizeProfilePath(path.resolve(profileDir, leaf)),
  );
}

function expectOk(result: ReturnType<typeof runProbeSync>): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.error).toBeNull();
  expect(result.json).toBeTruthy();
  return result.json as Record<string, unknown>;
}

async function readPinnedProbeStdout(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<{ initial: Record<string, unknown>; after: Record<string, unknown> }> {
  const stream = proc.stdout;
  const stdout =
    stream && typeof stream !== "number"
      ? new TextDecoder().decode(await new Response(stream).arrayBuffer())
      : "";
  const lines = parseProbeLines(stdout);
  const initial = lines.find((l) => (l as { phase?: string }).phase === "initial") as
    | Record<string, unknown>
    | undefined;
  const after = lines.find((l) => (l as { phase?: string }).phase === "after-selection-change") as
    | Record<string, unknown>
    | undefined;
  if (!initial || !after) throw new Error(`expected two probe phases, got ${lines.length}`);
  return { initial, after };
}

async function splitBrainOnce(root: string): Promise<void> {
  const scope = path.join(root, crypto.randomUUID().slice(0, 8));
  ensureDir(scope);
  const base = newBase(scope);
  const candidate = await newCandidate(scope);
  const env = isolatedProbeEnv({ baseDataDir: base });
  const trigger = path.join(scope, "trigger");
  const proc = Bun.spawn({
    cmd: [process.execPath, PROBE_PATH, "hold-pinned-paths", trigger],
    cwd: path.dirname(base),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await Bun.sleep(500);
    const controlDir = activationControlDir(base);
    ensureDir(controlDir);
    const canonicalB = canonicalizeProfilePath(candidate);
    const next = buildSelection({
      previous: null,
      activeProfilePath: canonicalB,
      activeProfileIdentity: profileIdentityForPath(canonicalB),
      transitionId: null,
      now: Date.now(),
    });
    writePrivateJsonAtomic(selectionFilePath(controlDir), next);
    writeFileSync(trigger, "1", { mode: 0o600 });
    await proc.exited;
    const { initial, after } = await readPinnedProbeStdout(proc);
    samePath(String(initial.dataDir), base);
    samePath(String(after.dataDir), base);
    samePath(String(after.resolver), base);
    expectPathUnderProfile(String(after.coreCredsPath), base, "agetor-core.json");
    expectPathUnderProfile(String(after.githubTokensPath), base, "github-tokens.json");
    expectPathUnderProfile(String(after.pidFilePath), base, "agetor.pid");
    expectPathUnderProfile(String(after.daemonLogPath), base, "daemon.log");
    expectPathUnderProfile(String(after.sqlitePath), base, "agetor.sqlite");
    expect(existsSync(path.join(candidate, "agetor.sqlite"))).toBe(true);
    expect(existsSync(path.join(candidate, "agetor-core.json"))).toBe(false);
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await proc.exited.catch(() => {});
  }
}

describe("FO-P2-005-A-R1", () => {
  test("1. normal base-only startup", () => {
    const scope = makeRoot("fo-r1-base-");
    try {
      const base = newBase(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const opened = expectOk(runProbeSync("open-db", env));
      samePath(String(opened.dataDir), base);
    } finally {
      scope.cleanup();
    }
  });

  test("2–8. running process pins profile A when selection.json switches to B (10 iterations)", async () => {
    for (let i = 0; i < 10; i++) {
      await splitBrainOnce(FIXTURE_ROOT.root);
    }
  }, 600_000);

  test("9. new process resolves B after valid offline activation", async () => {
    const scope = makeRoot("fo-r1-activate-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      expectOk(runProbeSync("prepare", env, candidate));
      const activated = expectOk(runProbeSync("open-db", env));
      samePath(String(activated.dataDir), candidate);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("10. rollback selects A after restart", async () => {
    const scope = makeRoot("fo-r1-rollback-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      expectOk(runProbeSync("prepare", env, candidate));
      expectOk(runProbeSync("open-db", env));
      expectOk(runProbeSync("rollback", env));
      const back = expectOk(runProbeSync("open-db", env));
      samePath(String(back.dataDir), base);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("11. corrupt selection fails closed on startup", () => {
    const scope = makeRoot("fo-r1-bad-selection-");
    try {
      const base = newBase(scope.root);
      const controlDir = activationControlDir(base);
      ensureDir(controlDir);
      writeFileSync(selectionFilePath(controlDir), "{ not-json", { mode: 0o600 });
      chmodSync(selectionFilePath(controlDir), 0o600);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const startup = runProbeSync("startup", env);
      expect(startup.exitCode).toBe(3);
      expect(startup.error?.code).toBe("SELECTION_CORRUPT");
      const open = runProbeSync("open-db", env);
      expect(open.exitCode).toBe(3);
      expect(existsSync(path.join(base, "agetor.sqlite"))).toBe(true);
    } finally {
      scope.cleanup();
    }
  });

  test("12. corrupt transition journal fails closed on startup", () => {
    const scope = makeRoot("fo-r1-bad-journal-");
    try {
      const base = newBase(scope.root);
      const controlDir = activationControlDir(base);
      ensureDir(controlDir);
      writeFileSync(journalFilePath(controlDir), "{ broken", { mode: 0o600 });
      chmodSync(journalFilePath(controlDir), 0o600);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const startup = runProbeSync("startup", env);
      expect(startup.exitCode).toBe(3);
      expect(startup.error?.code).toBe("JOURNAL_CORRUPT");
    } finally {
      scope.cleanup();
    }
  });

  test("13–14. CLI resolve-active does not fall back to base on corrupt activation", () => {
    const scope = makeRoot("fo-r1-cli-corrupt-");
    try {
      const base = newBase(scope.root);
      const controlDir = activationControlDir(base);
      ensureDir(controlDir);
      writeFileSync(selectionFilePath(controlDir), "{ not-json", { mode: 0o600 });
      chmodSync(selectionFilePath(controlDir), 0o600);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const resolved = runProbeSync("resolve-active", env);
      expect(resolved.exitCode).toBe(3);
      expect(resolved.error?.code).toBe("SELECTION_CORRUPT");
      const missingBase = newBase(scope.root);
      const missingEnv = isolatedProbeEnv({ baseDataDir: missingBase });
      const missing = runProbeSync("resolve-active", missingEnv);
      expect(missing.exitCode).toBe(0);
      samePath(String((missing.json as { activeDataDir: string }).activeDataDir), missingBase);
    } finally {
      scope.cleanup();
    }
  });

  test("15. ensureCore does not spawn against base when activation state is corrupt", async () => {
    const scope = makeRoot("fo-r1-supervisor-corrupt-");
    try {
      const base = newBase(scope.root);
      const controlDir = activationControlDir(base);
      ensureDir(controlDir);
      writeFileSync(selectionFilePath(controlDir), "{ not-json", { mode: 0o600 });
      chmodSync(selectionFilePath(controlDir), 0o600);
      const prevForge = process.env.FORGEORBIT_DATA_DIR;
      const prevAgetor = process.env.AGETOR_DATA_DIR;
      process.env.FORGEORBIT_DATA_DIR = base;
      process.env.AGETOR_DATA_DIR = base;
      try {
        await expect(ensureCore({ port: 4498, noDaemon: true })).rejects.toThrow();
      } finally {
        if (prevForge === undefined) delete process.env.FORGEORBIT_DATA_DIR;
        else process.env.FORGEORBIT_DATA_DIR = prevForge;
        if (prevAgetor === undefined) delete process.env.AGETOR_DATA_DIR;
        else process.env.AGETOR_DATA_DIR = prevAgetor;
      }
    } finally {
      scope.cleanup();
    }
  });

  test("16. macOS activation flock is available in this runtime", () => {
    if (process.platform === "darwin") {
      expect(activationFlockSupported()).toBe(true);
    }
  });

  test("17. concurrent activation respects flock", async () => {
    const scope = makeRoot("fo-r1-flock-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const holder = await startLockHolder(env);
      try {
        const prepare = runProbeSync("prepare", env, candidate);
        expect(prepare.exitCode).toBe(3);
        expect(prepare.error?.code).toBe("TRANSITION_LOCKED");
      } finally {
        holder.stop();
      }
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("18. no implicit database is created when selection validation fails", () => {
    const scope = makeRoot("fo-r1-no-implicit-db-");
    try {
      const base = newBase(scope.root);
      const ghost = path.join(scope.root, "ghost-profile");
      ensureDir(ghost);
      const controlDir = activationControlDir(base);
      ensureDir(controlDir);
      const canonical = canonicalizeProfilePath(ghost);
      writePrivateJsonAtomic(
        selectionFilePath(controlDir),
        buildSelection({
          previous: null,
          activeProfilePath: canonical,
          activeProfileIdentity: profileIdentityForPath(canonical),
          transitionId: null,
          now: Date.now(),
        }),
      );
      const env = isolatedProbeEnv({ baseDataDir: base });
      const open = runProbeSync("open-db", env);
      expect(open.exitCode).toBe(3);
      expect(existsSync(path.join(ghost, "agetor.sqlite"))).toBe(false);
    } finally {
      scope.cleanup();
    }
  });

  test("19–20. full synthetic backup → verify → restore → activate → rollback", async () => {
    const scope = makeRoot("fo-r1-roundtrip-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      expectOk(runProbeSync("prepare", env, candidate));
      const activated = expectOk(runProbeSync("open-db", env));
      samePath(String(activated.dataDir), candidate);
      expectOk(runProbeSync("rollback", env));
      const back = expectOk(runProbeSync("open-db", env));
      samePath(String(back.dataDir), base);
    } finally {
      scope.cleanup();
    }
  }, 180_000);
});
